#!/usr/bin/env node
// Prepare the Codex app-server runtime as a Rust-owned Tauri resource.
// The Node sidecar no longer carries @openai/codex-* native packages.
//
// codex-runtime/ mirrors the platform package's vendor/<triple>/ tree:
//
//   codex-runtime/
//   ├── codex-package.json          (package-layout marker codex looks for)
//   ├── bin/codex[.exe]
//   ├── bin/codex-code-mode-host[.exe]
//   ├── codex-path/rg[.exe]
//   └── codex-resources/…           (sandbox helpers etc., platform-dependent)
//
// Codex only recognizes its package layout — and therefore only finds the
// code-mode host, bundled ripgrep and sandbox helper binaries — when the
// executable sits in a bin/ directory whose parent carries codex-package.json.
// The previous flat layout (codex-runtime/codex[.exe] + path/rg) broke all of
// those lookups, e.g. code-mode file reads failed with a missing
// codex-code-mode-host executable.

import { chmod, cp, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const outputRoot = join(repoRoot, 'codex-runtime')
const rootRequire = createRequire(join(repoRoot, 'package.json'))

const codexPlatformPackages = {
  'win32-x64': 'codex-win32-x64',
  'win32-arm64': 'codex-win32-arm64',
  'darwin-x64': 'codex-darwin-x64',
  'darwin-arm64': 'codex-darwin-arm64',
  'linux-x64': 'codex-linux-x64',
  'linux-arm64': 'codex-linux-arm64',
}

const codexTargetTriples = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

// Files the prepared runtime must contain, relative to codex-runtime/.
export function codexRuntimeRequiredFiles(platform = process.platform) {
  const suffix = platform === 'win32' ? '.exe' : ''
  return [
    join('bin', `codex${suffix}`),
    join('bin', `codex-code-mode-host${suffix}`),
    join('codex-path', `rg${suffix}`),
    'codex-package.json',
  ]
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function firstValidCodexSource(candidates, codexTriple, exeName) {
  // A candidate is only usable when it carries the current package layout
  // (vendor/<triple>/bin/<exe>). Stale packages from older installs can shadow
  // the real one (e.g. a leftover root node_modules/@openai/codex-win32-x64
  // with the pre-0.144 vendor/<triple>/codex/<exe> layout) — skip those.
  for (const candidate of candidates) {
    if (await fileExists(join(candidate, 'vendor', codexTriple, 'bin', exeName))) {
      return candidate
    }
  }
  throw new Error(
    `@openai Codex native package with vendor/${codexTriple}/bin/${exeName} not found; tried:\n`
    + candidates.map(path => `  - ${path}`).join('\n'),
  )
}

async function assertFile(path, label) {
  let info
  try {
    info = await stat(path)
  } catch (err) {
    throw new Error(`${label} missing: ${path} (${err.message})`)
  }
  if (!info.isFile()) {
    throw new Error(`${label} is not a file: ${path}`)
  }
}

async function chmodFilesIn(dir, mode) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      await chmod(join(dir, entry.name), mode)
    }
  }
}

export async function prepareTauriCodexRuntime(options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const key = platformKey(platform, arch)
  const codexPackage = codexPlatformPackages[key]
  const codexTriple = codexTargetTriples[key]
  if (!codexPackage || !codexTriple) {
    throw new Error(`unsupported platform/arch for Codex runtime: ${key}`)
  }

  // Prefer the platform package that sits next to the RESOLVED @openai/codex
  // meta package — that one is version-locked to it by pnpm. The bare
  // node_modules paths are fallbacks and may be stale.
  const codexSourceCandidates = []
  try {
    const codexMetaPackage = dirname(rootRequire.resolve('@openai/codex/package.json'))
    const codexMetaRealPath = await realpath(codexMetaPackage)
    codexSourceCandidates.push(join(dirname(codexMetaRealPath), codexPackage))
  } catch { /* @openai/codex is not installed as a direct resolver target */ }
  codexSourceCandidates.push(
    join(repoRoot, 'node_modules', '.pnpm', 'node_modules', '@openai', codexPackage),
    join(repoRoot, 'node_modules', '@openai', codexPackage),
  )

  const exeName = platform === 'win32' ? 'codex.exe' : 'codex'
  const codexSource = await realpath(
    await firstValidCodexSource(codexSourceCandidates, codexTriple, exeName),
  )
  const vendorRoot = join(codexSource, 'vendor', codexTriple)

  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  await cp(vendorRoot, outputRoot, { recursive: true })

  const requiredFiles = codexRuntimeRequiredFiles(platform)
  for (const relativePath of requiredFiles) {
    await assertFile(join(outputRoot, relativePath), `Codex runtime file ${relativePath}`)
  }
  if (platform !== 'win32') {
    await chmodFilesIn(join(outputRoot, 'bin'), 0o755)
    await chmodFilesIn(join(outputRoot, 'codex-path'), 0o755)
  }

  return {
    outputRoot,
    binary: join(outputRoot, requiredFiles[0]),
    ripgrep: join(outputRoot, requiredFiles[2]),
    files: requiredFiles,
    sourcePackage: `@openai/${codexPackage}`,
  }
}

async function main() {
  const result = await prepareTauriCodexRuntime()
  console.log(`[prepare-tauri-codex-runtime] wrote ${result.binary}`)
  console.log(`[prepare-tauri-codex-runtime] wrote ${result.ripgrep}`)
  console.log(`[prepare-tauri-codex-runtime] source ${result.sourcePackage}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[prepare-tauri-codex-runtime] failed:', err.message || err)
    process.exit(1)
  })
}
