import { codexChangeDiffText } from '../components/CodexFileDiff.helpers'

const PREVIEW_LINE_CHAR_LIMIT = 2000

export interface FilePreviewSection {
  text: string
  previewLines: string[]
  lineCount: number
  truncated: boolean
  charTruncated: boolean
  kind: 'delete' | 'add' | 'unified'
}

// Count all lines, but allocate strings only for the collapsed preview. In
// particular, do not split a multi-megabyte patch into 100,000 retained rows.
export function summarizePreviewLines(text: string, previewLimit: number) {
  const previewLines: string[] = []
  let lineCount = 0
  let truncated = false
  let charTruncated = false
  let start = 0
  while (true) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline
    const contentEnd = newline >= 0 && end > start && text[end - 1] === '\r' ? end - 1 : end
    const lineTruncated = contentEnd - start > PREVIEW_LINE_CHAR_LIMIT
    charTruncated ||= lineTruncated
    lineCount++
    if (previewLines.length < previewLimit) {
      const previewEnd = Math.min(contentEnd, start + PREVIEW_LINE_CHAR_LIMIT)
      previewLines.push(text.slice(start, previewEnd) + (lineTruncated ? '…' : ''))
      truncated ||= lineTruncated
    } else {
      truncated = true
    }
    if (newline < 0) break
    start = newline + 1
  }
  return { previewLines, lineCount, truncated, charTruncated }
}

function section(text: string, previewLimit: number, kind: FilePreviewSection['kind']): FilePreviewSection {
  return { text, kind, ...summarizePreviewLines(text, previewLimit) }
}

export function prepareAgentFilePreview(input: Record<string, unknown>, variant: 'edit' | 'write') {
  let sections: FilePreviewSection[]
  if (variant === 'write') {
    sections = [section(String(input.content || ''), 8, 'add')]
  } else if (input.old_string !== undefined) {
    sections = [
      section(String(input.old_string || ''), 3, 'delete'),
      section(String(input.new_string || ''), 3, 'add'),
    ]
  } else {
    const changes = Array.isArray(input.changes)
      ? input.changes.filter((value): value is Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value))
      : []
    const text = codexChangeDiffText(changes)
    sections = text ? [section(text, 12, 'unified')] : []
  }
  const totalLines = sections.reduce((sum, current) => sum + current.lineCount, 0)
  const lineLimit = variant === 'write' ? 8 : 12
  // Small edits historically show every line, even when one side has >3.
  // A very long single line also needs a bounded, expandable preview.
  const isLong = totalLines > lineLimit || sections.some(current => current.charTruncated)
  return { sections, totalLines, isLong }
}

export function filePreviewLines(section: FilePreviewSection, showAll: boolean): string[] {
  return showAll ? section.text.split(/\r?\n/) : section.previewLines
}
