#!/usr/bin/env node
// Validate the prepared Tauri preview bundle inputs. This complements
// verify:tauri-preview by checking the release staging artifacts that must
// exist before `tauri build` can produce a self-contained app.

import { access, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const defaultConfigPath = join(repoRoot, 'src-tauri', 'tauri.conf.json')

const coreResourceSources = [
  '../node-sidecar/dist/server.mjs',
  '../node-sidecar/package.json',
]

const allInOneResourceSources = [
  '../node-sidecar/dist-node_modules/',
  '../codex-runtime/',
  '../node-sidecar/runtime/',
]

const runtimeExecutables = {
  'win32-x64': join('windows-x86_64', 'node.exe'),
  'darwin-x64': join('darwin-x86_64', 'bin', 'node'),
  'darwin-arm64': join('darwin-aarch64', 'bin', 'node'),
  'linux-x64': join('linux-x86_64', 'bin', 'node'),
  'linux-arm64': join('linux-aarch64', 'bin', 'node'),
}

const claudeNativePackages = {
  'win32-x64': 'claude-agent-sdk-win32-x64',
  'darwin-x64': 'claude-agent-sdk-darwin-x64',
  'darwin-arm64': 'claude-agent-sdk-darwin-arm64',
  'linux-x64': 'claude-agent-sdk-linux-x64',
  'linux-arm64': 'claude-agent-sdk-linux-arm64',
}

function runtimeKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function fileSize(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

async function dirExists(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function loadResourceSources(configPaths) {
  const sources = new Set()
  for (const configPath of configPaths) {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    for (const source of Object.keys(parsed?.bundle?.resources || {})) {
      sources.add(source)
    }
  }
  return sources
}

export async function collectTauriPreviewReadiness(options = {}) {
  const root = resolve(options.root || repoRoot)
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const mode = options.mode || 'all-in-one'
  const key = runtimeKey(platform, arch)
  const runtimeRel = options.runtimeRel || runtimeExecutables[key]
  const configPath = options.configPath || join(root, 'src-tauri', 'tauri.conf.json')
  const runtimeConfigPath = options.runtimeConfigPath || join(root, 'src-tauri', 'tauri.all-in-one.conf.json')
  const configPaths = mode === 'lightweight'
    ? [configPath]
    : [configPath, runtimeConfigPath]
  const sidecarRoot = join(root, 'node-sidecar')
  const checks = []

  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  const resourceSources = await loadResourceSources(configPaths)
  const requiredResourceSources = mode === 'lightweight'
    ? coreResourceSources
    : [...coreResourceSources, ...allInOneResourceSources]
  for (const source of requiredResourceSources) {
    add(
      `resource:${source}`,
      resourceSources.has(source),
      resourceSources.has(source) ? 'configured' : 'missing from tauri.conf.json',
    )
  }

  const serverPath = join(sidecarRoot, 'dist', 'server.mjs')
  const serverBytes = await fileSize(serverPath)
  add('sidecar:dist-server', serverBytes > 0, `${serverBytes} bytes`)

  const sidecarPackagePath = join(sidecarRoot, 'package.json')
  add('sidecar:package-json', await pathExists(sidecarPackagePath), sidecarPackagePath)

  if (mode !== 'lightweight') {
    const nodeModulesPath = join(sidecarRoot, 'dist-node_modules')
    add('sidecar:dist-node-modules', await dirExists(nodeModulesPath), nodeModulesPath)
    const claudeNativePackage = claudeNativePackages[key]
    if (claudeNativePackage) {
      const exeName = platform === 'win32' ? 'claude.exe' : 'claude'
      const claudeBinary = join(
        nodeModulesPath,
        '@anthropic-ai',
        claudeNativePackage,
        exeName,
      )
      const claudeBinaryBytes = await fileSize(claudeBinary)
      const compressedClaudeBinary = `${claudeBinary}.gz`
      const compressedClaudeBinaryBytes = await fileSize(compressedClaudeBinary)
      const hasClaudeBinary = claudeBinaryBytes > 0 || (platform === 'linux' && compressedClaudeBinaryBytes > 0)
      const detail = claudeBinaryBytes > 0
        ? `${claudeBinary} (${claudeBinaryBytes} bytes)`
        : `${compressedClaudeBinary} (${compressedClaudeBinaryBytes} bytes)`
      add(`sidecar:claude-native:${key}`, hasClaudeBinary, detail)
    } else {
      add(`sidecar:claude-native:${key}`, false, `unsupported platform/arch for Claude native package: ${key}`)
    }
    const codexRuntimeRoot = join(root, 'codex-runtime')
    add('codex-runtime:root', await dirExists(codexRuntimeRoot), codexRuntimeRoot)
    // Package layout (vendor/<triple>/ mirror): codex only finds its helper
    // binaries when the executable sits in bin/ next to codex-package.json.
    const codexExeName = platform === 'win32' ? 'codex.exe' : 'codex'
    const codexBinary = join(codexRuntimeRoot, 'bin', codexExeName)
    const codexBinaryBytes = await fileSize(codexBinary)
    add(`codex-runtime:binary:${key}`, codexBinaryBytes > 0, `${codexBinary} (${codexBinaryBytes} bytes)`)
    const codeModeHostName = platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
    const codexCodeModeHost = join(codexRuntimeRoot, 'bin', codeModeHostName)
    const codexCodeModeHostBytes = await fileSize(codexCodeModeHost)
    add(`codex-runtime:code-mode-host:${key}`, codexCodeModeHostBytes > 0, `${codexCodeModeHost} (${codexCodeModeHostBytes} bytes)`)
    const rgName = platform === 'win32' ? 'rg.exe' : 'rg'
    const codexRipgrep = join(codexRuntimeRoot, 'codex-path', rgName)
    const codexRipgrepBytes = await fileSize(codexRipgrep)
    add(`codex-runtime:ripgrep:${key}`, codexRipgrepBytes > 0, `${codexRipgrep} (${codexRipgrepBytes} bytes)`)
    const codexPackageMarker = join(codexRuntimeRoot, 'codex-package.json')
    const codexPackageMarkerBytes = await fileSize(codexPackageMarker)
    add(`codex-runtime:package-marker:${key}`, codexPackageMarkerBytes > 0, `${codexPackageMarker} (${codexPackageMarkerBytes} bytes)`)

    const runtimeRoot = join(sidecarRoot, 'runtime')
    add('runtime:root', await dirExists(runtimeRoot), runtimeRoot)
    if (runtimeRel) {
      const runtimePath = join(runtimeRoot, runtimeRel)
      const runtimeBytes = await fileSize(runtimePath)
      add(`runtime:${key}`, runtimeBytes > 0, `${runtimePath} (${runtimeBytes} bytes)`)
    } else {
      add(`runtime:${key}`, false, `unsupported platform/arch for preview runtime: ${key}`)
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  }
}

function parseArgs(argv) {
  const out = { root: repoRoot, json: false, mode: 'all-in-one' }
  for (const arg of argv) {
    if (arg === '--json') out.json = true
    else if (arg.startsWith('--root=')) out.root = resolve(arg.slice('--root='.length))
    else if (arg.startsWith('--mode=')) out.mode = arg.slice('--mode='.length)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await collectTauriPreviewReadiness({ root: args.root, mode: args.mode })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const check of result.checks) {
      console.log(`${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}`)
    }
  }
  if (!result.ok) {
    throw new Error('Tauri preview readiness checks failed')
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[check-tauri-preview-readiness] failed:', err.message || err)
    process.exit(1)
  })
}
