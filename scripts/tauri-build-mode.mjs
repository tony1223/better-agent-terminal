#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareTauriBundleMode } from './prepare-tauri-bundle-mode.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
export const defaultTauriConfig = resolve(repoRoot, 'src-tauri', 'tauri.conf.json')
export const allInOneTauriConfig = resolve(repoRoot, 'src-tauri', 'tauri.all-in-one.conf.json')

export const bundleModes = new Set(['all-in-one', 'lightweight'])

export function normalizeBundleMode(value = process.env.BAT_BUNDLE_MODE || 'all-in-one') {
  const mode = String(value || '').trim()
  if (!bundleModes.has(mode)) {
    throw new Error(`unsupported Tauri bundle mode: ${mode}`)
  }
  return mode
}

export function tauriConfigArgsForMode(modeValue) {
  const mode = normalizeBundleMode(modeValue)
  return mode === 'all-in-one' ? ['--config', allInOneTauriConfig] : []
}

function parseArgs(argv) {
  const out = {
    mode: process.env.BAT_BUNDLE_MODE || 'all-in-one',
    passthrough: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--mode') {
      out.mode = argv[++i]
    } else if (arg.startsWith('--mode=')) {
      out.mode = arg.slice('--mode='.length)
    } else {
      out.passthrough.push(arg)
    }
  }
  out.mode = normalizeBundleMode(out.mode)
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await prepareTauriBundleMode(args.mode)
  const tauriArgs = [
    'exec',
    'tauri',
    'build',
    ...args.passthrough,
    ...tauriConfigArgsForMode(args.mode),
  ]
  console.log(`[tauri-build-mode] mode=${args.mode} pnpm ${tauriArgs.join(' ')}`)
  const child = spawn('pnpm', tauriArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[tauri-build-mode] tauri build terminated by ${signal}`)
      process.exit(1)
    }
    process.exit(code || 0)
  })
  child.on('error', (err) => {
    console.error(`[tauri-build-mode] failed to spawn tauri build: ${err.message}`)
    process.exit(1)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
