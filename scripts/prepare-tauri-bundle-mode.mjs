#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
export const bundleModes = new Set(['all-in-one', 'lightweight'])

export function normalizeBundleMode(value) {
  const mode = String(value || '').trim()
  if (!bundleModes.has(mode)) throw new Error(`unsupported Tauri bundle mode: ${mode}`)
  return mode
}

export async function prepareTauriBundleMode(modeValue, { root = repoRoot } = {}) {
  const mode = normalizeBundleMode(modeValue)
  const marker = join(root, 'src-tauri', 'target', 'bundle-mode.txt')
  await mkdir(dirname(marker), { recursive: true })
  await writeFile(marker, `${mode}\n`)
  return marker
}

function parseMode(argv) {
  const value = argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length)
    ?? (argv[0] === '--mode' ? argv[1] : argv[0])
  return normalizeBundleMode(value)
}

async function main() {
  const mode = parseMode(process.argv.slice(2))
  const marker = await prepareTauriBundleMode(mode)
  console.log(`[prepare-tauri-bundle-mode] ${mode} -> ${marker}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[prepare-tauri-bundle-mode] failed:', err.message || err)
    process.exit(1)
  })
}
