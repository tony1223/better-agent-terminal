/**
 * Unit tests for electron/node-resolver.ts
 *
 * Run: npm test -- --dir tests/unit
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  compareVersions,
  findLatestInVersionedDir,
  resolveNodePath,
  getNodeExecutable,
  getExtraNodePaths,
  _resetCache,
} from '../../electron/node-resolver'

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('v1.0.0', 'v1.0.0')).toBe(0)
  })

  it('handles major version difference', () => {
    expect(compareVersions('v20.0.0', 'v18.0.0')).toBeGreaterThan(0)
    expect(compareVersions('v18.0.0', 'v20.0.0')).toBeLessThan(0)
  })

  it('handles minor version difference', () => {
    expect(compareVersions('v20.19.0', 'v20.1.0')).toBeGreaterThan(0)
    expect(compareVersions('v20.1.0', 'v20.19.0')).toBeLessThan(0)
  })

  it('handles patch version difference', () => {
    expect(compareVersions('v20.19.3', 'v20.19.1')).toBeGreaterThan(0)
  })

  it('handles v9 vs v20 (numeric, not string sort)', () => {
    expect(compareVersions('v20.0.0', 'v9.0.0')).toBeGreaterThan(0)
  })

  it('works without v prefix', () => {
    expect(compareVersions('20.0.0', '18.0.0')).toBeGreaterThan(0)
  })

  it('works with mixed v prefix', () => {
    expect(compareVersions('v20.0.0', '18.0.0')).toBeGreaterThan(0)
  })

  it('sorts an array of versions correctly', () => {
    const versions = ['v9.0.0', 'v20.19.3', 'v18.17.0', 'v20.1.0', 'v14.21.3']
    versions.sort(compareVersions)
    expect(versions).toEqual(['v9.0.0', 'v14.21.3', 'v18.17.0', 'v20.1.0', 'v20.19.3'])
  })
})

describe('findLatestInVersionedDir', () => {
  it('returns null for non-existent directory', () => {
    expect(findLatestInVersionedDir('/nonexistent/path', 'bin/node')).toBeNull()
  })

  it('finds node in nvm directory (if installed)', () => {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    const result = findLatestInVersionedDir(nvmDir, 'bin/node')
    if (fs.existsSync(nvmDir)) {
      expect(result).not.toBeNull()
      expect(result!).toMatch(/\/bin\/node$/)
      expect(fs.existsSync(result!)).toBe(true)
    } else {
      expect(result).toBeNull()
    }
  })

  it('returns null for empty directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-resolver-test-'))
    try {
      expect(findLatestInVersionedDir(tmpDir, 'bin/node')).toBeNull()
    } finally {
      fs.rmdirSync(tmpDir)
    }
  })

  it('picks latest version from multiple', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-resolver-test-'))
    try {
      for (const v of ['v14.0.0', 'v20.19.3', 'v18.17.0', 'v9.0.0']) {
        const binDir = path.join(tmpDir, v, 'bin')
        fs.mkdirSync(binDir, { recursive: true })
        fs.writeFileSync(path.join(binDir, 'node'), '')
      }
      const result = findLatestInVersionedDir(tmpDir, 'bin/node')
      expect(result).not.toBeNull()
      expect(result!).toContain('v20.19.3')
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  it('ignores non-version directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-resolver-test-'))
    try {
      fs.mkdirSync(path.join(tmpDir, '.cache'), { recursive: true })
      fs.mkdirSync(path.join(tmpDir, 'something'), { recursive: true })
      const binDir = path.join(tmpDir, 'v18.0.0', 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      fs.writeFileSync(path.join(binDir, 'node'), '')
      const result = findLatestInVersionedDir(tmpDir, 'bin/node')
      expect(result).not.toBeNull()
      expect(result!).toContain('v18.0.0')
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })
})

describe('resolveNodePath', () => {
  it('returns a valid path', () => {
    const result = resolveNodePath()
    expect(result.length).toBeGreaterThan(0)
    if (result !== 'node') {
      expect(fs.existsSync(result)).toBe(true)
    }
  })

  it('resolved path is actually node', () => {
    const result = resolveNodePath()
    if (result !== 'node') {
      expect(result).toMatch(/\/node$|\\node\.exe$/)
    }
  })
})

describe('getNodeExecutable (lazy cache)', () => {
  beforeEach(() => {
    _resetCache()
  })

  it('returns same result on multiple calls', () => {
    const first = getNodeExecutable()
    const second = getNodeExecutable()
    expect(first).toBe(second)
  })

  it('reset cache allows re-resolution', () => {
    const first = getNodeExecutable()
    _resetCache()
    const second = getNodeExecutable()
    expect(first).toBe(second)
  })
})

describe('getExtraNodePaths', () => {
  it('returns an array', () => {
    expect(Array.isArray(getExtraNodePaths())).toBe(true)
  })

  it('all returned paths are existing directories', () => {
    for (const p of getExtraNodePaths()) {
      expect(fs.existsSync(p)).toBe(true)
      expect(fs.statSync(p).isDirectory()).toBe(true)
    }
  })
})
