/**
 * Unit tests for file-drag-to-chat feature logic.
 * Tests pure functions extracted from ClaudeAgentPanel.tsx.
 *
 * Run: npm test -- --dir tests/unit
 */

import { describe, it, expect } from 'vitest'

// ============================================================
// Replicate the pure logic from ClaudeAgentPanel.tsx
// ============================================================

interface AttachedFile {
  path: string
  name: string
}

const MAX_FILES = 10

function addFileToList(prev: AttachedFile[], filePath: string): AttachedFile[] {
  if (prev.length >= MAX_FILES) return prev
  if (prev.some(f => f.path === filePath)) return prev
  const name = filePath.split('/').pop() || filePath
  return [...prev, { path: filePath, name }]
}

function buildPrompt(filePaths: string[], trimmed: string): string {
  let promptToSend = trimmed
  if (filePaths.length > 0) {
    const filePrefix = filePaths.map(p => `@${p}`).join('\n')
    promptToSend = filePrefix + (trimmed ? '\n\n' + trimmed : '')
  }
  return promptToSend
}

function buildFileNote(filePaths: string[]): string {
  if (filePaths.length === 0) return ''
  return `\n[${filePaths.length} file${filePaths.length > 1 ? 's' : ''} attached: ${filePaths.map(p => p.split('/').pop()).join(', ')}]`
}

function buildDisplayContent(trimmed: string, imageCount: number, filePaths: string[]): string {
  const imageNote = imageCount > 0
    ? `\n[${imageCount} image${imageCount > 1 ? 's' : ''} attached]`
    : ''
  const fileNote = buildFileNote(filePaths)
  return (trimmed + imageNote + fileNote).replace(/^\n/, '')
}

function shouldSend(trimmed: string, imageCount: number, fileCount: number): boolean {
  return !(!trimmed && imageCount === 0 && fileCount === 0)
}

function routeDrop(file: { type: string; path: string }): 'image' | 'file' | 'skip' {
  if (!file.path) return 'skip'
  if (file.type.startsWith('image/')) return 'image'
  return 'file'
}

// ============================================================
// Tests
// ============================================================

describe('addFileToList', () => {
  it('adds a single file', () => {
    const result = addFileToList([], '/tmp/a.log')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ path: '/tmp/a.log', name: 'a.log' })
  })

  it('extracts filename from deep path', () => {
    const result = addFileToList([], '/Users/foo/bar/data.csv')
    expect(result[0].name).toBe('data.csv')
  })

  it('deduplicates by path', () => {
    let list = addFileToList([], '/tmp/a.log')
    list = addFileToList(list, '/tmp/a.log')
    expect(list).toHaveLength(1)
  })

  it('enforces max limit of 10', () => {
    let list: AttachedFile[] = []
    for (let i = 0; i < 11; i++) {
      list = addFileToList(list, `/tmp/file${i}.txt`)
    }
    expect(list).toHaveLength(10)
  })

  it('allows different paths with same filename', () => {
    let list = addFileToList([], '/a/test.log')
    list = addFileToList(list, '/b/test.log')
    expect(list).toHaveLength(2)
  })

  it('handles files without extension', () => {
    const result = addFileToList([], '/tmp/Makefile')
    expect(result[0].name).toBe('Makefile')
  })

  it('handles paths with spaces', () => {
    const result = addFileToList([], '/tmp/my file.txt')
    expect(result[0].name).toBe('my file.txt')
  })

  it('handles empty path', () => {
    const result = addFileToList([], '')
    expect(result[0].name).toBe('')
  })
})

describe('buildPrompt', () => {
  it('prepends file paths to text', () => {
    expect(buildPrompt(['/a.log', '/b.csv'], 'analyze'))
      .toBe('@/a.log\n@/b.csv\n\nanalyze')
  })

  it('handles files only (no text)', () => {
    expect(buildPrompt(['/a.log'], '')).toBe('@/a.log')
  })

  it('returns text unchanged when no files', () => {
    expect(buildPrompt([], 'hello')).toBe('hello')
  })

  it('returns empty string when both empty', () => {
    expect(buildPrompt([], '')).toBe('')
  })
})

describe('buildFileNote', () => {
  it('generates singular note for 1 file', () => {
    expect(buildFileNote(['/tmp/error.log']))
      .toBe('\n[1 file attached: error.log]')
  })

  it('generates plural note for multiple files', () => {
    expect(buildFileNote(['/a.log', '/b.csv', '/c.md']))
      .toBe('\n[3 files attached: a.log, b.csv, c.md]')
  })

  it('returns empty string for no files', () => {
    expect(buildFileNote([])).toBe('')
  })
})

describe('buildDisplayContent', () => {
  it('combines text + file note', () => {
    expect(buildDisplayContent('hello', 0, ['/tmp/error.log']))
      .toBe('hello\n[1 file attached: error.log]')
  })

  it('combines text + image + file', () => {
    expect(buildDisplayContent('hi', 1, ['/tmp/error.log']))
      .toBe('hi\n[1 image attached]\n[1 file attached: error.log]')
  })

  it('strips leading newline when no text (files only)', () => {
    expect(buildDisplayContent('', 0, ['/tmp/error.log']))
      .toBe('[1 file attached: error.log]')
  })

  it('strips leading newline when no text (images only)', () => {
    expect(buildDisplayContent('', 1, []))
      .toBe('[1 image attached]')
  })
})

describe('shouldSend (guard condition)', () => {
  it('blocks send when all empty', () => {
    expect(shouldSend('', 0, 0)).toBe(false)
  })

  it('allows send with files only', () => {
    expect(shouldSend('', 0, 1)).toBe(true)
  })

  it('allows send with images only', () => {
    expect(shouldSend('', 1, 0)).toBe(true)
  })

  it('allows send with text only', () => {
    expect(shouldSend('hello', 0, 0)).toBe(true)
  })
})

describe('routeDrop (handleDrop routing)', () => {
  it('routes image/png to image', () => {
    expect(routeDrop({ type: 'image/png', path: '/a.png' })).toBe('image')
  })

  it('routes text/plain to file', () => {
    expect(routeDrop({ type: 'text/plain', path: '/a.txt' })).toBe('file')
  })

  it('routes empty type to file', () => {
    expect(routeDrop({ type: '', path: '/Makefile' })).toBe('file')
  })

  it('skips when no path', () => {
    expect(routeDrop({ type: 'text/plain', path: '' })).toBe('skip')
  })

  it('routes image/jpeg to image', () => {
    expect(routeDrop({ type: 'image/jpeg', path: '/photo.jpg' })).toBe('image')
  })

  it('routes application/pdf to file', () => {
    expect(routeDrop({ type: 'application/pdf', path: '/doc.pdf' })).toBe('file')
  })
})
