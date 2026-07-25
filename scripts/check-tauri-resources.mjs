#!/usr/bin/env node
// Report file count and byte size for resources listed in tauri.conf.json.
// Use after `pnpm run prepare:tauri-bundle` to verify the packaged sidecar
// resource surface is staying small enough for cold-start work.
//
// The all-in-one cap (--max-mb in package.json) measures UNCOMPRESSED resources
// and is dominated by three vendored single-file binaries, each embedding its
// own runtime: codex.exe (~343 MB), claude.exe (~253 MB), node.exe (~88 MB).
// Those come verbatim from upstream npm platform packages, so the total tracks
// upstream growth and must be raised when they legitimately grow — it is not a
// budget we can trim from our own code. Size is also platform-dependent (the
// win32-arm64 codex binary is ~49 MB smaller than win32-x64), so the cap has to
// clear the largest platform. Keep enough headroom for upstream drift while
// staying under ~1 GB, which is where a second platform's binaries leaking into
// the bundle would land. User-facing installer limits are enforced separately
// on the COMPRESSED artifacts by scripts/verify-release-asset-sizes.js.

import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const defaultConfigPath = resolve(repoRoot, 'src-tauri', 'tauri.conf.json')
const allInOneConfigPath = resolve(repoRoot, 'src-tauri', 'tauri.all-in-one.conf.json')

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function mergeConfig(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay
  const out = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = key in out ? mergeConfig(out[key], value) : value
  }
  return out
}

async function loadMergedConfig(configPaths) {
  let merged = {}
  for (const configPath of configPaths) {
    const raw = await readFile(configPath, 'utf8')
    merged = mergeConfig(merged, JSON.parse(raw))
  }
  return merged
}

async function countPath(path) {
  let info
  try {
    info = await lstat(path)
  } catch (err) {
    if (err?.code === 'ENOENT') return { files: 0, bytes: 0, missing: true }
    throw err
  }

  if (!info.isDirectory()) {
    return { files: 1, bytes: info.size, missing: false }
  }

  let files = 0
  let bytes = 0
  let missing = false
  for (const entry of await readdir(path)) {
    const child = await countPath(resolve(path, entry))
    files += child.files
    bytes += child.bytes
    missing = missing || child.missing
  }
  return { files, bytes, missing }
}

export async function collectTauriResourceStats(configPath = defaultConfigPath, extraConfigPaths = []) {
  const parsed = await loadMergedConfig([configPath, ...extraConfigPaths])
  const resources = parsed?.bundle?.resources
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return { configPath, entries: [], totalFiles: 0, totalBytes: 0, missing: [] }
  }

  const configDir = dirname(configPath)
  const entries = []
  for (const [source, target] of Object.entries(resources)) {
    const sourcePath = resolve(configDir, source)
    const stats = await countPath(sourcePath)
    entries.push({ source, target, sourcePath, ...stats })
  }

  return {
    configPath,
    entries,
    totalFiles: entries.reduce((sum, entry) => sum + entry.files, 0),
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    missing: entries.filter((entry) => entry.missing).map((entry) => entry.source),
  }
}

function parseArgs(argv) {
  const out = {
    configPath: defaultConfigPath,
    extraConfigPaths: [],
    json: false,
    strictMissing: false,
    maxFiles: null,
    maxBytes: null,
  }
  for (const arg of argv) {
    if (arg === '--json') out.json = true
    else if (arg === '--strict-missing') out.strictMissing = true
    else if (arg.startsWith('--config=')) out.configPath = resolve(arg.slice('--config='.length))
    else if (arg.startsWith('--extra-config=')) out.extraConfigPaths.push(resolve(arg.slice('--extra-config='.length)))
    else if (arg === '--mode=all-in-one') out.extraConfigPaths.push(allInOneConfigPath)
    else if (arg === '--mode=lightweight') {
      // Base config is the lightweight resource surface.
    }
    else if (arg.startsWith('--max-files=')) out.maxFiles = Number(arg.slice('--max-files='.length))
    else if (arg.startsWith('--max-mb=')) out.maxBytes = Number(arg.slice('--max-mb='.length)) * 1024 * 1024
  }
  return out
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const stats = await collectTauriResourceStats(args.configPath, args.extraConfigPaths)
  if (args.json) {
    console.log(JSON.stringify(stats, null, 2))
  } else {
    for (const entry of stats.entries) {
      const suffix = entry.missing ? ' missing' : ''
      console.log(`${entry.source} -> ${entry.target}: ${entry.files} files, ${formatMb(entry.bytes)}${suffix}`)
    }
    console.log(`total: ${stats.totalFiles} files, ${formatMb(stats.totalBytes)}`)
  }

  const failures = []
  if (args.strictMissing && stats.missing.length > 0) {
    failures.push(`missing resources: ${stats.missing.join(', ')}`)
  }
  if (args.maxFiles !== null && stats.totalFiles > args.maxFiles) {
    failures.push(`resource file count ${stats.totalFiles} exceeds ${args.maxFiles}`)
  }
  if (args.maxBytes !== null && stats.totalBytes > args.maxBytes) {
    failures.push(`resource size ${formatMb(stats.totalBytes)} exceeds ${formatMb(args.maxBytes)}`)
  }
  if (failures.length > 0) {
    throw new Error(failures.join('; '))
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[check-tauri-resources] failed:', err.message || err)
    process.exit(1)
  })
}
