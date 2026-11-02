#!/usr/bin/env node
// A release asset can be saved by GitHub even when its upload response fails.
// Retrying with --clobber replaces that partial/previous upload safely.
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function uploadReleaseAsset(tag, asset, {
  run = args => spawnSync('gh', args, { stdio: 'inherit', windowsHide: true }),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  attempts = 3,
} = {}) {
  if (!tag || !asset) throw new Error('Usage: upload-release-asset.mjs <tag> <asset>')
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = run(['release', 'upload', tag, asset, '--clobber'])
    if (result.error) throw result.error
    if (result.status === 0) return
    if (attempt === attempts) {
      throw new Error(`Upload of ${basename(asset)} failed after ${attempts} attempts (exit ${result.status}, signal ${result.signal ?? 'none'})`)
    }
    const delay = attempt * 2000
    console.warn(`[release-upload] ${basename(asset)}: attempt ${attempt} failed; retrying in ${delay / 1000}s`)
    await wait(delay)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  uploadReleaseAsset(process.argv[2], process.argv[3]).catch(error => {
    console.error(`[release-upload] ${error.message}`)
    process.exitCode = 1
  })
}
