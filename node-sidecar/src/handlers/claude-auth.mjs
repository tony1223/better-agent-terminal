// claude.* auth + account handlers. Also exports the Claude CLI binary
// resolver / spawner used by other handlers (sendMessage, forkSession).

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { accessSync, chmodSync, constants as fsConstants, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { arch, platform } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { registerHandler } from '../lib/protocol.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'
import { invalidateAccountMetadataCache } from './claude-readonly.mjs'
import runtimeCatalog from '../../../runtime-catalog.json' with { type: 'json' }

export const AUTH_STATUS_TIMEOUT_MS = 10_000
// auth login is interactive (browser-based OAuth, ~30-60s typical), so
// we give it a generous ceiling. The CLI exits as soon as the OAuth
// callback fires; if the user never completes the flow, we time out.
export const AUTH_LOGIN_TIMEOUT_MS = 180_000
export const CLAUDE_AGENT_SDK_NATIVE_VERSION = runtimeCatalog.claude.version

// Per-platform Claude native package download catalog, derived from the
// shared runtime-catalog.json — the single source of truth regenerated at
// build time from the installed @anthropic-ai/claude-agent-sdk version. The
// Rust side reads the same file via runtime_catalog.rs.
const CLAUDE_NATIVE_CATALOG = Object.fromEntries(
  Object.entries(runtimeCatalog.claude.platforms).map(([key, { packageName, integrity }]) => [
    key,
    {
      packageName,
      integrity,
      version: CLAUDE_AGENT_SDK_NATIVE_VERSION,
      url: `https://registry.npmjs.org/@anthropic-ai/${packageName}/-/${packageName}-${CLAUDE_AGENT_SDK_NATIVE_VERSION}.tgz`,
    },
  ]),
)

// Resolve the path to a `claude` CLI binary. The bundled SDK ships one
// per platform (e.g. node-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe);
// but setup-install builds prefer an app-data managed runtime and then a
// working user-managed PATH runtime before falling back to bundled resources.
//
// Test/fixture override: BAT_SIDECAR_CLAUDE_BIN points at any executable
// (typically a printf-and-exit shim) so tests can verify the spawn path
// without invoking the real CLI's network flow.
let _claudeCliPathCache
let _claudeCliInstallPromise
let _claudeNativeCatalogForTests = null
let _claudeNativeDownloaderForTests = null

function candidateSidecarRoots(fromFile) {
  const roots = []
  let dir = dirname(fromFile)
  for (let i = 0; i < 5; i += 1) {
    roots.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return roots
}

function currentClaudeRuntimeKey() {
  return `${platform()}-${arch()}`
}

function claudeExeName() {
  return platform() === 'win32' ? 'claude.exe' : 'claude'
}

function managedClaudeCliPath(dataDir = resolveDataDir(), key = currentClaudeRuntimeKey()) {
  return join(
    dataDir,
    'runtimes',
    'claude-agent-sdk',
    CLAUDE_AGENT_SDK_NATIVE_VERSION,
    key,
    claudeExeName(),
  )
}

function isExecutableClaudeCli(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function isUsableClaudeCli(candidate) {
  if (!isExecutableClaudeCli(candidate)) return false
  // macOS can invalidate nested signed Mach-O files while copying Tauri
  // resources. The executable bit survives, but launch exits with SIGKILL.
  // Probe once before caching a path so the SDK never receives a dead CLI.
  try {
    execFileSync(candidate, ['--version'], {
      stdio: 'ignore',
      timeout: 5_000,
    })
    return true
  } catch {
    return false
  }
}

function extractCompressedClaudeCli(compressedCandidate, exeName) {
  let info
  try {
    info = statSync(compressedCandidate)
    if (!info.isFile()) return null
  } catch {
    return null
  }

  const key = createHash('sha256')
    .update(compressedCandidate)
    .update(String(info.size))
    .update(String(info.mtimeMs))
    .digest('hex')
    .slice(0, 16)
  const outDir = join(resolveDataDir(), 'bin', 'claude-agent-sdk', key)
  const outPath = join(outDir, exeName)
  if (isUsableClaudeCli(outPath)) return outPath

  try {
    mkdirSync(outDir, { recursive: true, mode: 0o700 })
    writeFileSync(outPath, gunzipSync(readFileSync(compressedCandidate)), { mode: 0o700 })
    chmodSync(outPath, 0o700)
  } catch {
    return null
  }
  return isUsableClaudeCli(outPath) ? outPath : null
}

function resolvePackagedClaudeCli(candidate, exeName) {
  if (isUsableClaudeCli(candidate)) return candidate
  return extractCompressedClaudeCli(`${candidate}.gz`, exeName)
}

function findOnPath(exeName) {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  if (platform() === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  } else if (platform() !== 'win32') {
    dirs.push('/usr/local/bin', '/usr/bin', '/bin')
  }
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, exeName)
    if (isUsableClaudeCli(candidate)) return candidate
  }
  return null
}

export function resolveClaudeCliBinary() {
  if (process.env.BAT_SIDECAR_CLAUDE_BIN) return process.env.BAT_SIDECAR_CLAUDE_BIN
  const managed = managedClaudeCliPath()
  if (typeof _claudeCliPathCache === 'string') {
    // Runtime Manager installs/clears this path in the Rust host while the
    // sidecar process stays alive. Prefer a newly appeared managed binary over
    // a cached bundled/system fallback, and drop a cached path that disappeared.
    if (_claudeCliPathCache !== managed && isExecutableClaudeCli(managed) && isUsableClaudeCli(managed)) {
      _claudeCliPathCache = managed
      return managed
    }
    if (isExecutableClaudeCli(_claudeCliPathCache)) return _claudeCliPathCache
    _claudeCliPathCache = undefined
  }
  // Do not permanently cache `null`: an external Runtime Manager install can
  // make the managed path appear without restarting the sidecar.
  // Probe the SDK-bundled binding directory siblings — there's at most
  // one per install (the package matches host platform/arch via npm
  // optionalDependencies), so the first match wins.
  const tripleDirs = [
    'claude-agent-sdk-win32-x64',
    'claude-agent-sdk-win32-arm64',
    'claude-agent-sdk-darwin-x64',
    'claude-agent-sdk-darwin-arm64',
    'claude-agent-sdk-linux-x64',
    'claude-agent-sdk-linux-arm64',
  ]
  const exeName = claudeExeName()
  if (isUsableClaudeCli(managed)) {
    _claudeCliPathCache = managed
    return managed
  }

  const system = findOnPath(exeName)
  if (system) {
    _claudeCliPathCache = system
    return system
  }

  // Walk up from this module to find node_modules/@anthropic-ai/.
  // import.meta.url is a file URL; resolve up to the sidecar root and
  // probe node_modules/@anthropic-ai/<pkg>/.
  let here
  try {
    here = fileURLToPath(import.meta.url)
  } catch {
    here = null
  }
  if (here) {
    for (const sidecarRoot of candidateSidecarRoots(here)) {
      for (const triple of tripleDirs) {
        const candidate = join(sidecarRoot, 'node_modules', '@anthropic-ai', triple, exeName)
        const resolved = resolvePackagedClaudeCli(candidate, exeName)
        if (resolved) {
          _claudeCliPathCache = resolved
          return resolved
        }
      }
    }
  }
  // Development fallback: Tauri dev runs the sidecar from target/debug
  // resources, while the pristine package copy lives in the repo checkout.
  // If the resource copy is unusable, prefer the repo copy before PATH.
  const cwd = process.cwd()
  for (const root of [
    join(cwd, 'node-sidecar', 'dist-node_modules'),
    join(cwd, 'node-sidecar', 'node_modules'),
  ]) {
    for (const triple of tripleDirs) {
      const candidate = join(root, '@anthropic-ai', triple, exeName)
      const resolved = resolvePackagedClaudeCli(candidate, exeName)
      if (resolved) {
        _claudeCliPathCache = resolved
        return resolved
      }
    }
  }
  _claudeCliPathCache = null
  return null
}

function catalogForCurrentPlatform() {
  const catalog = _claudeNativeCatalogForTests || CLAUDE_NATIVE_CATALOG
  return catalog[currentClaudeRuntimeKey()] || null
}

async function downloadClaudeNativeArchive(entry) {
  if (_claudeNativeDownloaderForTests) return _claudeNativeDownloaderForTests(entry)
  const res = await fetch(entry.url, {
    headers: { 'User-Agent': 'better-agent-terminal-runtime-installer' },
  })
  if (!res.ok) {
    throw new Error(`download failed: ${entry.url} -> HTTP ${res.status}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

function verifyIntegrity(bytes, integrity) {
  const [algorithm, expected] = String(integrity || '').split('-', 2)
  if (!algorithm || !expected) throw new Error('missing Claude native package integrity')
  const actual = createHash(algorithm).update(bytes).digest('base64')
  if (actual !== expected) {
    throw new Error(`Claude native package integrity mismatch: expected ${algorithm}-${expected}`)
  }
}

function tarString(bytes) {
  const nul = bytes.indexOf(0)
  return bytes.subarray(0, nul === -1 ? bytes.length : nul).toString('utf8')
}

function readTarEntry(tarBytes, wantedName) {
  let offset = 0
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) return null
    const name = tarString(header.subarray(0, 100))
    const prefix = tarString(header.subarray(345, 500))
    const fullName = prefix ? `${prefix}/${name}` : name
    const sizeText = tarString(header.subarray(124, 136)).trim()
    const size = parseInt(sizeText || '0', 8)
    offset += 512
    const body = tarBytes.subarray(offset, offset + size)
    if (fullName === wantedName) return Buffer.from(body)
    offset += Math.ceil(size / 512) * 512
  }
  return null
}

async function installManagedClaudeCli() {
  const entry = catalogForCurrentPlatform()
  if (!entry) return null
  const finalPath = managedClaudeCliPath()
  if (isUsableClaudeCli(finalPath)) return finalPath

  const finalDir = dirname(finalPath)
  const tmpDir = join(resolveDataDir(), 'runtimes', '.tmp', `claude-agent-sdk-${randomUUID()}`)
  const tmpPath = join(tmpDir, claudeExeName())
  try {
    const archive = await downloadClaudeNativeArchive(entry)
    verifyIntegrity(archive, entry.integrity)
    const exeBytes = readTarEntry(gunzipSync(archive), `package/${claudeExeName()}`)
    if (!exeBytes) throw new Error(`Claude native package missing package/${claudeExeName()}`)
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true, mode: 0o700 })
    await writeFile(tmpPath, exeBytes, { mode: 0o700 })
    chmodSync(tmpPath, 0o700)
    if (!isUsableClaudeCli(tmpPath)) throw new Error('installed Claude native binary failed --version check')
    await mkdir(dirname(finalDir), { recursive: true, mode: 0o700 })
    await rm(finalDir, { recursive: true, force: true })
    await rename(tmpDir, finalDir)
    _claudeCliPathCache = undefined
    return isUsableClaudeCli(finalPath) ? finalPath : null
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function resolveClaudeCliBinaryWithInstall() {
  const resolved = resolveClaudeCliBinary()
  if (resolved) return resolved
  if (!_claudeCliInstallPromise) {
    _claudeCliInstallPromise = installManagedClaudeCli()
      .finally(() => { _claudeCliInstallPromise = null })
  }
  try {
    await _claudeCliInstallPromise
  } finally {
    _claudeCliPathCache = undefined
  }
  return resolveClaudeCliBinary()
}

// Spawn the resolved claude CLI with the given args. Falls back to
// invoking 'claude' from PATH when no bundled binary is available.
export function spawnClaudeCli(args, opts, callback, options = {}) {
  const bundled = resolveClaudeCliBinary()
  if (bundled) return execFile(bundled, args, opts, callback)
  if (!options.installManaged) return execFile('claude', args, opts, callback)

  let child = null
  resolveClaudeCliBinaryWithInstall()
    .then((installed) => {
      child = execFile(installed || 'claude', args, opts, callback)
    })
    .catch((err) => {
      callback(err, '', '')
    })
  return {
    kill(signal) {
      if (child) child.kill(signal)
    },
  }
}

export function fetchAuthStatus() {
  return new Promise((resolve) => {
    spawnClaudeCli(['auth', 'status'], { timeout: AUTH_STATUS_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

// Return shape mirrors Electron's claude:account-list handler:
// `{accounts, activeAccountId, switchWarningShown}`. The renderer's
// SettingsPanel reads `result.accounts.length` directly, so a bare
// array would crash the panel — keep the wrapper even when empty.
export async function readAccountIndex() {
  const dir = resolveDataDir()
  const path = join(dir, 'claude-accounts.json')
  let raw
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return { accounts: [], activeAccountId: null, switchWarningShown: false }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { accounts: [], activeAccountId: null, switchWarningShown: false }
  }
  const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
  // Strip to documented public shape — AccountManager may have written
  // legacy/credential fields and we never surface those.
  const sanitized = accounts.map(a => ({
    id: String(a?.id ?? ''),
    email: String(a?.email ?? ''),
    subscriptionType: a?.subscriptionType,
    isDefault: Boolean(a?.isDefault),
    createdAt: typeof a?.createdAt === 'number' ? a.createdAt : 0,
  })).filter(a => a.id && a.email)
  return {
    accounts: sanitized,
    activeAccountId: typeof parsed?.activeAccountId === 'string' ? parsed.activeAccountId : null,
    switchWarningShown: Boolean(parsed?.switchWarningShown),
  }
}

async function writeAccountIndex(store) {
  const dir = resolveDataDir()
  const path = join(dir, 'claude-accounts.json')
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

async function markSwitchWarningShown() {
  const store = await readAccountIndex()
  await writeAccountIndex({ ...store, switchWarningShown: true })
  return true
}

// Exported for tests.
export function __resetClaudeCliCacheForTests() { _claudeCliPathCache = undefined }
export function __setClaudeNativeCatalogForTests(value) { _claudeNativeCatalogForTests = value }
export function __setClaudeNativeDownloaderForTests(value) { _claudeNativeDownloaderForTests = value }

// --- handlers --------------------------------------------------------------

const STUB_AUTH_ERR = 'claude account ops not yet wired through Tauri sidecar'

// authStatus shells out to `claude auth status`, parses the JSON output,
// returns null on any failure (CLI missing, not logged in, parse error).
// This matches the Electron-side handler verbatim.
registerHandler('claude.authStatus', async () => fetchAuthStatus())

// accountList reads the unencrypted account index file written by
// the Electron-side AccountManager. The encrypted credentials live in
// a separate file; this handler never touches them. Until the Tauri
// side has a parallel writer, the list will be empty on a fresh
// install — and that's fine: the renderer's auth UI handles empty
// state correctly.
registerHandler('claude.accountList', async () => readAccountIndex())

// authLogin shells out to `claude auth login` (interactive, browser-based
// OAuth). The CLI prints a URL, opens the user's browser, and exits when
// the OAuth callback fires; we just wait for the process to exit. The
// 180s ceiling is generous for a real-user flow but bounded so a stuck
// flow eventually fails. Uses the bundled CLI when available so a fresh
// setup-install release can authenticate without requiring system claude.
registerHandler('claude.authLogin', async () => {
  return new Promise((resolve) => {
    spawnClaudeCli(['auth', 'login'], { timeout: AUTH_LOGIN_TIMEOUT_MS }, (err) => {
      if (err) resolve({ success: false, error: err.message })
      else resolve({ success: true })
    }, { installManaged: true })
  })
})
// authLogout shells out to `claude auth logout` and reports the result.
// 10s timeout — the CLI exits ~immediately on success. Failure usually
// means the CLI isn't installed or auth state is corrupt; surface the
// error message so the renderer can show it.
registerHandler('claude.authLogout', async () => {
  return new Promise((resolve) => {
    spawnClaudeCli(['auth', 'logout'], { timeout: AUTH_STATUS_TIMEOUT_MS }, (err) => {
      // Always flush the per-process metadata cache — the account is
      // gone (or might be), so getAccountInfo / getSupportedModels etc.
      // must be re-fetched on next call.
      invalidateAccountMetadataCache()
      if (err) resolve({ success: false, error: err.message })
      else resolve({ success: true })
    }, { installManaged: true })
  })
})
registerHandler('claude.accountImportCurrent', async () => null)
registerHandler('claude.accountLoginNew', async () => ({ success: false, error: STUB_AUTH_ERR }))
registerHandler('claude.accountSwitch', async (params) => {
  if (typeof params?.accountId !== 'string') {
    throw new Error('claude.accountSwitch: missing accountId')
  }
  // Even when the actual switch op is still a stub, flush so a future
  // real impl doesn't have to remember to invalidate too.
  invalidateAccountMetadataCache()
  return false
})
registerHandler('claude.accountRemove', async (params) => {
  if (typeof params?.accountId !== 'string') {
    throw new Error('claude.accountRemove: missing accountId')
  }
  invalidateAccountMetadataCache()
  return false
})
registerHandler('claude.accountMarkWarningShown', async () => markSwitchWarningShown())
