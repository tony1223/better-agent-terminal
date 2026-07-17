#!/usr/bin/env node
// Download a portable Node binary into node-sidecar/runtime/<plat>-<arch>/
// so the Tauri release bundle ships a self-contained Node interpreter.
//
// Defaults to Node v24.18.0 (current LTS) and the current host platform/arch.
// Pass --version=v24.18.0 or --target=darwin-aarch64 to override; --all fetches
// every supported triple in one go. By default the script prunes other known
// runtime triples so stale cross-platform runtimes are not bundled by Tauri;
// pass --keep-other-targets to preserve them.
//
// Layout it produces, matching Node.org portable archives:
//   windows-x86_64/node.exe
//   darwin-aarch64/bin/node
//   darwin-x86_64/bin/node
//   linux-x86_64/bin/node
//
// The Rust resolver (src-tauri/src/sidecar.rs::find_bundled_node) probes
// these locations in order. Re-running this script is idempotent — if the
// target binary already exists it short-circuits.

import { mkdir, rm, writeFile, access, readFile, readdir, stat, cp } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const runtimeRoot = join(repoRoot, 'node-sidecar', 'runtime')

export const DEFAULT_VERSION = 'v24.18.0'

// Map our internal triple (platform-arch, using Rust-style arch names that
// match std::env::consts::ARCH on the Rust side) to Node.org distribution
// triples. We use Rust arch names so the Rust resolver and this script
// agree on directory naming without translation.
const TARGETS = {
  'windows-x86_64':  { nodePlat: 'win',    nodeArch: 'x64',    ext: 'zip',    exePath: 'node.exe' },
  'darwin-x86_64':   { nodePlat: 'darwin', nodeArch: 'x64',    ext: 'tar.gz', exePath: 'bin/node' },
  'darwin-aarch64':  { nodePlat: 'darwin', nodeArch: 'arm64',  ext: 'tar.gz', exePath: 'bin/node' },
  'linux-x86_64':    { nodePlat: 'linux',  nodeArch: 'x64',    ext: 'tar.xz', exePath: 'bin/node' },
  'linux-aarch64':   { nodePlat: 'linux',  nodeArch: 'arm64',  ext: 'tar.xz', exePath: 'bin/node' },
}

function detectHostTarget() {
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch] ?? process.arch
  const plat = process.platform === 'win32' ? 'windows' : process.platform
  return `${plat}-${arch}`
}

function parseArgs(argv) {
  const out = { version: DEFAULT_VERSION, targets: null, force: false, keepOtherTargets: false }
  for (const a of argv) {
    if (a === '--all') out.targets = Object.keys(TARGETS)
    else if (a === '--force') out.force = true
    else if (a === '--keep-other-targets') out.keepOtherTargets = true
    else if (a.startsWith('--version=')) out.version = a.slice('--version='.length)
    else if (a.startsWith('--target=')) out.targets = [a.slice('--target='.length)]
  }
  if (!out.targets) out.targets = [detectHostTarget()]
  return out
}

async function pathExists(p) {
  try { await access(p); return true } catch { return false }
}

async function runtimeIsCurrent(targetExe, meta, version) {
  if (!await pathExists(targetExe)) return false
  try {
    return (await readFile(meta, 'utf8')).trim() === version
  } catch {
    return false
  }
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`)
  await mkdir(dirname(dest), { recursive: true })
  await pipeline(res.body, createWriteStream(dest))
}

async function extract(archivePath, destDir, ext) {
  await mkdir(destDir, { recursive: true })
  // Windows 10+ ships bsdtar at System32\tar.exe which handles .zip natively;
  // we prefer that over PowerShell Expand-Archive (which has flaky path
  // parsing on some Node.org zip layouts). On unix `tar` handles .tar.gz
  // and .tar.xz transparently.
  const tarBin = process.platform === 'win32'
    ? 'C:\\Windows\\System32\\tar.exe'
    : 'tar'
  const r = spawnSync(tarBin, ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${tarBin} -xf failed for ${ext}`)
}

async function findExtractedRoot(parent) {
  // Node archives extract to a single root dir like node-v24.18.0-win-x64/.
  // Find it (the one non-archive entry under parent).
  const entries = await readdir(parent)
  for (const e of entries) {
    const p = join(parent, e)
    if ((await stat(p)).isDirectory()) return p
  }
  throw new Error(`no extracted directory found under ${parent}`)
}

async function fetchOne(triple, version) {
  const spec = TARGETS[triple]
  if (!spec) throw new Error(`unknown target: ${triple} (known: ${Object.keys(TARGETS).join(', ')})`)
  const archiveName = `node-${version}-${spec.nodePlat}-${spec.nodeArch}.${spec.ext}`
  const url = `https://nodejs.org/dist/${version}/${archiveName}`
  const targetDir = join(runtimeRoot, triple)
  const targetExe = join(targetDir, spec.exePath)
  const meta = join(targetDir, '.node-version')

  console.log(`[fetch-node-runtime] ${triple}: ${url}`)
  await rm(targetDir, { recursive: true, force: true })
  const work = await mkdir(join(tmpdir(), `bat-node-fetch-${triple}-${process.pid}`), { recursive: true })
  const archivePath = join(work, archiveName)
  try {
    await download(url, archivePath)
    await extract(archivePath, work, spec.ext)
    const root = await findExtractedRoot(work)
    await mkdir(targetDir, { recursive: true })
    // We only need the node binary itself plus the LICENSE for redistribution.
    // npm, corepack, docs, and headers blow the bundle up to ~150MB; pruning
    // keeps the Tauri bundle around the 70MB mark per platform.
    if (spec.exePath.includes('/')) {
      // unix layout: <root>/bin/node — recreate the bin/ directory
      const binSrc = join(root, 'bin', 'node')
      const binDst = join(targetDir, 'bin', 'node')
      await mkdir(dirname(binDst), { recursive: true })
      await cp(binSrc, binDst)
    } else {
      // windows layout: <root>/node.exe at top level
      await cp(join(root, 'node.exe'), join(targetDir, 'node.exe'))
    }
    // LICENSE for redistribution compliance.
    const licenseCandidates = ['LICENSE', 'LICENSE.txt']
    for (const name of licenseCandidates) {
      const src = join(root, name)
      if (await pathExists(src)) {
        await cp(src, join(targetDir, 'LICENSE'))
        break
      }
    }
    if (!await pathExists(targetExe)) {
      throw new Error(`extracted but expected exe missing: ${targetExe}`)
    }
    await writeFile(meta, `${version}\n`)
    console.log(`[fetch-node-runtime] ${triple}: ok -> ${targetExe}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function pruneUnselectedTargets(selectedTargets) {
  const selected = new Set(selectedTargets)
  for (const triple of Object.keys(TARGETS)) {
    if (selected.has(triple)) continue
    const staleDir = join(runtimeRoot, triple)
    if (await pathExists(staleDir)) {
      await rm(staleDir, { recursive: true, force: true })
      console.log(`[fetch-node-runtime] ${triple}: pruned stale runtime`)
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await mkdir(runtimeRoot, { recursive: true })
  if (!args.keepOtherTargets) {
    await pruneUnselectedTargets(args.targets)
  }
  for (const t of args.targets) {
    const expected = join(runtimeRoot, t, TARGETS[t]?.exePath ?? '')
    const meta = join(runtimeRoot, t, '.node-version')
    if (!args.force && TARGETS[t] && await runtimeIsCurrent(expected, meta, args.version)) {
      console.log(`[fetch-node-runtime] ${t}: already present at ${expected} (use --force to refetch)`)
      continue
    }
    await fetchOne(t, args.version)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch(err => {
    console.error('[fetch-node-runtime] failed:', err)
    process.exit(1)
  })
}
