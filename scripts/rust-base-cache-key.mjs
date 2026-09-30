#!/usr/bin/env node
// Compute a controlled Rust dependency cache key for stable Tauri base crates.
// Keep RUST_BASE_CACHE_ROOTS explicit: changing which crates belong to the
// long-lived base cache should be an intentional reviewable diff.

import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

export const RUST_BASE_CACHE_ROOTS = Object.freeze([
  'tauri',
  'tauri-build',
  'tauri-plugin-clipboard-manager',
  'tauri-plugin-dialog',
  'tauri-plugin-opener',
  'serde',
  'serde_json',
  'thiserror@1.0.69',
  'base64@0.22.1',
  'aes',
  'aes-gcm',
  'cbc',
  'pbkdf2',
  'sha1',
  'sha2',
  'image',
  'keyring-core',
  'windows-native-keyring-store',
  'apple-native-keyring-store',
  'linux-keyutils-keyring-store',
  'notify',
  'get_if_addrs',
  'portable-pty',
  'reqwest@0.12.28',
  'tungstenite',
  'rcgen',
  'rand@0.10.1',
  'rustls',
  'rustls-pki-types',
  'windows-sys@0.61.2',
])

function parseStringValue(line, field) {
  const match = line.match(new RegExp(`^${field}\\s*=\\s*"([^"]+)"\\s*$`))
  return match?.[1] ?? null
}

function parseDependencyName(raw) {
  const quoted = raw.match(/"([^"]+)"/)?.[1] ?? raw.trim()
  return quoted.split(/\s+/)[0]
}

export function parseCargoLock(raw) {
  const packages = new Map()
  for (const block of raw.split(/\r?\n\[\[package\]\]\r?\n/)) {
    if (!block.includes('name = ')) continue
    const lines = block.split(/\r?\n/)
    const name = lines.map((line) => parseStringValue(line, 'name')).find(Boolean)
    const version = lines.map((line) => parseStringValue(line, 'version')).find(Boolean)
    if (!name || !version) continue

    const dependencies = []
    let inDependencies = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === 'dependencies = [') {
        inDependencies = true
        continue
      }
      if (inDependencies && trimmed === ']') {
        inDependencies = false
        continue
      }
      if (inDependencies) dependencies.push(parseDependencyName(trimmed))
    }

    if (!packages.has(name)) packages.set(name, [])
    packages.get(name).push({ name, version, raw: block.trim(), dependencies })
  }
  return packages
}

function parseRootSpec(spec) {
  const [name, version] = spec.split('@')
  return { name, version }
}

function selectPackage(packages, spec) {
  const { name, version } = parseRootSpec(spec)
  const matches = packages.get(name) ?? []
  if (matches.length === 0) {
    throw new Error(`Rust base cache root missing from Cargo.lock: ${name}`)
  }
  if (version) {
    const match = matches.find((pkg) => pkg.version === version)
    if (!match) {
      throw new Error(`Rust base cache root missing from Cargo.lock: ${name}@${version}`)
    }
    return match
  }
  if (matches.length > 1) {
    const versions = matches.map((pkg) => pkg.version).join(', ')
    throw new Error(`Rust base cache root is ambiguous in Cargo.lock: ${name} (${versions})`)
  }
  return matches[0]
}

export function collectBaseClosure(packages, roots = RUST_BASE_CACHE_ROOTS) {
  const queue = roots.map((spec) => selectPackage(packages, spec))
  const selected = new Map()
  for (let index = 0; index < queue.length; index += 1) {
    const pkg = queue[index]
    const key = `${pkg.name} ${pkg.version}`
    if (selected.has(key)) continue
    selected.set(key, pkg)
    for (const depName of pkg.dependencies) {
      const matches = packages.get(depName)
      if (!matches) continue
      queue.push(...matches)
    }
  }
  return [...selected.values()].sort((a, b) => (
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  ))
}

export async function computeRustBaseCacheKey({ root = repoRoot } = {}) {
  const cargoLock = await readFile(join(root, 'src-tauri', 'Cargo.lock'), 'utf8')
  const packages = parseCargoLock(cargoLock)
  const closure = collectBaseClosure(packages)
  const hash = createHash('sha256')
  hash.update('rust-base-cache-v1\n')
  hash.update(`roots:${RUST_BASE_CACHE_ROOTS.join(',')}\n`)
  for (const pkg of closure) {
    hash.update(`\n[[package]]\n${pkg.raw}\n`)
  }
  return {
    key: hash.digest('hex').slice(0, 24),
    roots: RUST_BASE_CACHE_ROOTS,
    packageCount: closure.length,
  }
}

async function main() {
  const result = await computeRustBaseCacheKey()
  console.log(`base=${result.key}`)
  console.log(`roots=${result.roots.join(',')}`)
  console.log(`packages=${result.packageCount}`)

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `base=${result.key}\nroots=${result.roots.join(',')}\npackages=${result.packageCount}\n`,
    )
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[rust-base-cache-key] failed:', err.message || err)
    process.exit(1)
  })
}
