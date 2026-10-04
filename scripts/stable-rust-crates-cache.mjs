#!/usr/bin/env node
// Keep infrequently changed workspace libraries reusable on a fresh CI checkout.
// Cargo compares source mtimes to dep-info, so restoring rlibs alone is insufficient.
// Only normalize timestamps after the restored source key has been verified; clean
// the libraries first on a mismatch, including rollbacks and interrupted builds.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const STABLE_CRATES = Object.freeze([
  'bat-accounts',
  'bat-agent-bridge',
  'bat-app-storage',
  'bat-filesystem',
  'bat-git',
  'bat-host-support',
  'bat-remote-protocol',
  'bat-runtime',
])
const SOURCE_TIME = new Date('2000-01-01T00:00:00Z')
const METADATA_SECTION = 'package.metadata.bat-stable-crates-cache'

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name !== 'target') {
      files.push(...await sourceFiles(path))
    } else if (entry.isFile() && (entry.name === 'Cargo.toml' || entry.name.endsWith('.rs'))) {
      files.push(path)
    }
  }
  return files
}

export async function stableCratesKey(root = repoRoot) {
  const metadata = JSON.parse(execFileSync('cargo', [
    'metadata', '--no-deps', '--format-version=1',
    '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'),
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const packages = new Map(metadata.packages.map(pkg => [pkg.name, pkg]))
  const sources = new Map()
  const dependencies = new Map()
  const files = []
  for (const name of STABLE_CRATES) {
    const pkg = packages.get(name)
    if (!pkg) throw new Error(`Stable Rust crate missing from workspace: ${name}`)
    const inputs = await sourceFiles(dirname(pkg.manifest_path))
    if (name === 'bat-runtime') inputs.push(join(root, 'runtime-catalog.json'))
    inputs.sort()
    files.push(...inputs)
    const hash = createHash('sha256').update('bat-stable-crate-v2\n')
    for (const file of inputs) {
      hash.update(relative(root, file).replaceAll('\\', '/'))
      hash.update('\0')
      hash.update(await readFile(file))
      hash.update('\0')
    }
    sources.set(name, hash.digest('hex'))
    // Include optional, target-specific, build, and dev path dependencies.
    // This conservative graph works for every CI platform and feature set.
    dependencies.set(name, [...new Set(pkg.dependencies
      .filter(dep => dep.path && STABLE_CRATES.includes(dep.name))
      .map(dep => dep.name))].sort())
    for (const dep of pkg.dependencies) {
      if (dep.path && !STABLE_CRATES.includes(dep.name)) {
        throw new Error(`Untracked path dependency of ${name}: ${dep.name}`)
      }
    }
  }
  const crates = {}
  // Hash each reachable source once. Traversal also handles dev-dependency
  // cycles without treating a legitimate Cargo workspace as an invalid DAG.
  for (const name of STABLE_CRATES) {
    const closure = new Set()
    const visit = dependency => {
      if (closure.has(dependency)) return
      closure.add(dependency)
      dependencies.get(dependency).forEach(visit)
    }
    visit(name)
    const hash = createHash('sha256').update('bat-stable-dependency-closure-v2\n')
    for (const dependency of [...closure].sort()) {
      hash.update(`${dependency}:${sources.get(dependency)}\n`)
    }
    crates[name] = hash.digest('hex')
  }
  const key = createHash('sha256').update(JSON.stringify(crates)).digest('hex')
  return { key, files: files.sort(), crates, targetDir: metadata.target_directory }
}

function statePath(root) {
  return join(root, '.bat-rust-cache', 'stable-crates.json')
}

export async function prepareStableCratesCache(root = repoRoot) {
  const { key } = await stableCratesKey(root)
  const manifest = join(root, 'src-tauri', 'Cargo.toml')
  const raw = await readFile(manifest, 'utf8')
  // rust-cache hashes parsed Cargo metadata into its lock/manifest key, whose
  // restore prefix still lets an updated library reuse registry dependencies.
  // The generated field belongs only to the CI checkout, never the committed file.
  const section = `\n[${METADATA_SECTION}]\nsource-key = "${key}"\n`
  const existing = /\n\[package\.metadata\.bat-stable-crates-cache\]\nsource-key = "[a-f0-9]+"\n/
  const updated = existing.test(raw) ? raw.replace(existing, section) : raw.trimEnd() + '\n' + section
  if (updated !== raw) await writeFile(manifest, updated)
  return key
}

export async function restoreStableCratesCache(root = repoRoot, clean = cleanStableCrates, options = {}) {
  const { key, files, crates, targetDir } = await stableCratesKey(root)
  let previous
  try {
    previous = JSON.parse(await readFile(statePath(root), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  const valid = previous?.version === 2 && previous?.sourceTime === SOURCE_TIME.toISOString()
    && STABLE_CRATES.every(name => /^[a-f0-9]{64}$/.test(previous?.crates?.[name] ?? ''))
  const invalidated = STABLE_CRATES.filter(name => !valid || previous.crates[name] !== crates[name])
  if (invalidated.length) await clean(root, invalidated, resolve(options.targetDir ?? targetDir))
  for (const file of files) await utimes(file, SOURCE_TIME, SOURCE_TIME)
  return { key, matched: invalidated.length === 0, invalidated }
}

function cleanStableCrates(root, names, targetDir) {
  execFileSync('cargo', [
    'clean', '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'),
    '--target-dir', targetDir,
    ...names.flatMap(name => ['-p', name]),
  ], { cwd: root, stdio: 'inherit' })
}

export async function recordStableCratesCache(root = repoRoot) {
  const { key, crates } = await stableCratesKey(root)
  const file = statePath(root)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 2, key, crates, sourceTime: SOURCE_TIME.toISOString() }) + '\n')
  return key
}

async function main() {
  const command = process.argv[2]
  if (command === 'prepare') {
    console.log(`Stable Rust source key: ${await prepareStableCratesCache()}`)
  } else if (command === 'restore') {
    const result = await restoreStableCratesCache()
    console.log(`Stable Rust libraries: ${result.matched ? 'verified cache' : `rebuild ${result.invalidated.join(', ')}`}`)
  } else if (command === 'record') {
    // Run only after a successful cargo build. On failure, retain the previous
    // key so a partial build cannot bless artifacts from an older source tree.
    console.log(`Recorded built Rust source key: ${await recordStableCratesCache()}`)
  } else {
    throw new Error('Usage: stable-rust-crates-cache.mjs prepare|restore|record')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[stable-rust-crates-cache]', error.message)
    process.exitCode = 1
  })
}
