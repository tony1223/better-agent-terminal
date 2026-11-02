#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const MB = 1024 * 1024
const args = process.argv.slice(2).filter(arg => arg !== '--')
const releaseDir = path.resolve(args[0] || 'release')

function normalizePlatform(value) {
  if (value === 'darwin') return 'mac'
  if (value === 'win32') return 'win'
  return value
}

const platform = normalizePlatform(process.env.BAT_RELEASE_PLATFORM || process.platform)
const limits = [
  { platform: 'mac', ext: '.dmg', env: 'BAT_MAX_DMG_MB', maxMb: 340 },
  // Claude SDK 0.3.316 + Codex 0.166.0 + Node 24.22.2 produce a measured
  // 361 MB Windows NSIS installer; retain headroom for the upstream binaries.
  { platform: 'win', ext: '.exe', env: 'BAT_MAX_EXE_MB', maxMb: 400 },
  { platform: 'win', ext: '.msi', env: 'BAT_MAX_MSI_MB', maxMb: 400 },
  { platform: 'win', ext: '.zip', env: 'BAT_MAX_WIN_ZIP_MB', maxMb: 430 },
  { platform: 'linux', ext: '.AppImage', env: 'BAT_MAX_APPIMAGE_MB', maxMb: 340 },
].map(limit => ({
  ...limit,
  maxBytes: Number(process.env[limit.env] || limit.maxMb) * MB,
}))
const requestedExts = (process.env.BAT_RELEASE_EXTS || '')
  .split(',')
  .map(ext => ext.trim())
  .filter(Boolean)

function formatMb(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`
}

function isIgnoredReleaseArtifact(filePath) {
  const name = path.basename(filePath)
  return /^rw\.\d+\..+\.dmg$/.test(name)
}

function listFiles(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    throw new Error(`Failed to read release directory ${dir}: ${err.message}`)
  }

  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath))
    } else if (entry.isFile() && !isIgnoredReleaseArtifact(fullPath)) {
      files.push(fullPath)
    }
  }
  return files
}

function main() {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Release directory does not exist: ${releaseDir}`)
  }

  const activeLimits = limits.filter(limit => (
    limit.platform === platform &&
    (requestedExts.length === 0 || requestedExts.includes(limit.ext))
  ))
  if (activeLimits.length === 0) {
    throw new Error(`No release asset size limits configured for platform ${platform}`)
  }

  const files = listFiles(releaseDir)
  const checked = []
  const failures = []

  for (const limit of activeLimits) {
    const matches = files.filter(filePath => path.basename(filePath).endsWith(limit.ext))
    if (matches.length === 0) {
      throw new Error(`No ${limit.ext} release assets found under ${releaseDir}`)
    }

    for (const filePath of matches) {
      const size = fs.statSync(filePath).size
      checked.push(`${path.basename(filePath)}: ${formatMb(size)} <= ${formatMb(limit.maxBytes)}`)
      if (size > limit.maxBytes) {
        failures.push(`${filePath}: ${formatMb(size)} exceeds ${formatMb(limit.maxBytes)}`)
      }
    }
  }

  for (const line of checked) {
    console.log(`Checked release asset size: ${line}`)
  }

  if (failures.length > 0) {
    throw new Error(`Release asset size limit exceeded:\n${failures.map(line => `  - ${line}`).join('\n')}`)
  }
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
