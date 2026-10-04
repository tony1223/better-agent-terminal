#!/usr/bin/env node
// Regenerate runtime-catalog.json — the single source of truth for the
// pinned native runtime versions (Claude agent-sdk CLI, Codex CLI, Node) and
// their per-platform download integrity.
//
// Both the Rust host (src-tauri/crates/bat-runtime/src/runtime_catalog.rs via include_str!) and
// the Node sidecar (node-sidecar/src/handlers/claude-auth.mjs via JSON import)
// read this file, so the managed-runtime installer, the bundled-runtime
// resolver, and the sidecar's native-binary downloader all agree on one set of
// versions instead of drifting across hand-maintained constants.
//
// Versions follow the installed dependencies:
//   - claude  <- installed @anthropic-ai/claude-agent-sdk
//   - codex   <- installed @openai/codex
//   - node    <- scripts/fetch-node-runtime.mjs DEFAULT_VERSION
// Integrity is fetched fresh from the npm registry (dist.integrity) and from
// nodejs.org SHASUMS256.txt, so a dependency bump propagates automatically on
// the next CI build (this runs inside prepare:tauri-bundle:ci:*). Local builds
// reuse the committed catalog; the test:runtime-catalog-sync guard fails if the
// committed versions drift from the installed deps, prompting a manual
// `pnpm run sync:runtime-catalog`.

import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DEFAULT_VERSION as NODE_DEFAULT_VERSION } from './fetch-node-runtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const outFile = join(repoRoot, 'runtime-catalog.json')

// Our internal platform keys (matching std::env::consts on the Rust side and
// `${os.platform()}-${os.arch()}` on the Node side) mapped to the Node.org
// distribution specifics. Claude/Codex tarballs key off the same string.
const PLATFORMS = [
  { key: 'darwin-arm64', nodePlatform: 'darwin', nodeArch: 'arm64', archiveExt: 'tar.gz', exePath: 'bin/node' },
  { key: 'darwin-x64',   nodePlatform: 'darwin', nodeArch: 'x64',   archiveExt: 'tar.gz', exePath: 'bin/node' },
  { key: 'linux-arm64',  nodePlatform: 'linux',  nodeArch: 'arm64', archiveExt: 'tar.xz', exePath: 'bin/node' },
  { key: 'linux-x64',    nodePlatform: 'linux',  nodeArch: 'x64',   archiveExt: 'tar.xz', exePath: 'bin/node' },
  { key: 'win32-arm64',  nodePlatform: 'win',    nodeArch: 'arm64', archiveExt: 'zip',    exePath: 'node.exe' },
  { key: 'win32-x64',    nodePlatform: 'win',    nodeArch: 'x64',   archiveExt: 'zip',    exePath: 'node.exe' },
]

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.json()
}

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.text()
}

// Read the version straight from the installed package's manifest. We avoid
// require.resolve('<pkg>/package.json') because some packages (e.g.
// @anthropic-ai/claude-agent-sdk) hide ./package.json behind their exports
// map; the on-disk path under node_modules is always readable (pnpm symlinks
// the real package into the root store).
function installedVersion(pkg) {
  const manifest = join(repoRoot, 'node_modules', ...pkg.split('/'), 'package.json')
  const meta = JSON.parse(readFileSync(manifest, 'utf8'))
  if (!meta.version) throw new Error(`could not read installed version for ${pkg} at ${manifest}`)
  return meta.version
}

// Offline-derivable pinned versions: Claude/Codex from the installed
// dependency manifests, Node from fetch-node-runtime's DEFAULT_VERSION. The
// guard test reuses this so "expected" is computed in exactly one place.
function expectedVersions() {
  return {
    claude: installedVersion('@anthropic-ai/claude-agent-sdk'),
    codex: installedVersion('@openai/codex'),
    node: NODE_DEFAULT_VERSION.replace(/^v/, ''),
  }
}

async function buildClaudeSection(version) {
  const platforms = {}
  for (const { key } of PLATFORMS) {
    const packageName = `claude-agent-sdk-${key}`
    const meta = await fetchJson(`https://registry.npmjs.org/@anthropic-ai/${packageName}`)
    const entry = meta.versions?.[version]
    if (!entry) {
      throw new Error(`@anthropic-ai/${packageName}@${version} not found on npm`)
    }
    platforms[key] = { packageName, integrity: entry.dist.integrity }
  }
  return { version, platforms }
}

async function buildCodexSection(version) {
  const meta = await fetchJson('https://registry.npmjs.org/@openai/codex')
  const platforms = {}
  for (const { key } of PLATFORMS) {
    const npmVersion = `${version}-${key}`
    const entry = meta.versions?.[npmVersion]
    if (!entry) {
      throw new Error(`@openai/codex@${npmVersion} not found on npm`)
    }
    platforms[key] = { npmVersion, integrity: entry.dist.integrity }
  }
  return { version, platforms }
}

async function buildNodeSection(version) {
  const shasums = await fetchText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)
  const byFile = new Map()
  for (const line of shasums.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/)
    if (m) byFile.set(m[2], m[1])
  }
  const platforms = {}
  for (const { key, nodePlatform, nodeArch, archiveExt, exePath } of PLATFORMS) {
    const archive = `node-v${version}-${nodePlatform}-${nodeArch}.${archiveExt}`
    const sha256 = byFile.get(archive)
    if (!sha256) {
      throw new Error(`${archive} missing from nodejs.org SHASUMS256.txt for v${version}`)
    }
    platforms[key] = { nodePlatform, nodeArch, archiveExt, exePath, sha256 }
  }
  return { version, platforms }
}

async function main() {
  const { claude: claudeVersion, codex: codexVersion, node: nodeVersion } = expectedVersions()

  let previous = null
  try {
    previous = await readFile(outFile, 'utf8')
  } catch { /* first run */ }

  let catalog
  try {
    catalog = {
      _comment: 'GENERATED by scripts/sync-runtime-catalog.mjs — do not edit by hand. Run `pnpm run sync:runtime-catalog`.',
      claude: await buildClaudeSection(claudeVersion),
      codex: await buildCodexSection(codexVersion),
      node: await buildNodeSection(nodeVersion),
    }
  } catch (err) {
    // Integrity fetch needs the network. If we can't reach the registries but
    // a committed catalog already exists, keep building with it rather than
    // breaking offline/lightweight bundles — the guard test still enforces
    // that the committed versions track the installed dependencies.
    if (previous) {
      console.warn(`[sync-runtime-catalog] skipped regeneration (offline?): ${err.message || err}`)
      console.warn(`[sync-runtime-catalog] keeping existing ${outFile}`)
      return
    }
    throw err
  }

  const serialized = `${JSON.stringify(catalog, null, 2)}\n`
  if (previous === serialized) {
    console.log(`[sync-runtime-catalog] up to date (claude ${claudeVersion}, codex ${codexVersion}, node ${nodeVersion})`)
    return
  }
  await writeFile(outFile, serialized)
  console.log(`[sync-runtime-catalog] wrote ${outFile} (claude ${claudeVersion}, codex ${codexVersion}, node ${nodeVersion})`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[sync-runtime-catalog] failed:', err.message || err)
    process.exit(1)
  })
}

export { buildClaudeSection, buildCodexSection, buildNodeSection, expectedVersions, PLATFORMS, outFile }
