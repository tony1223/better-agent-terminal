// Match split(/\r?\n/).length without allocating an array for the whole text.
export function countTextLines(text: string): number {
  let count = 1
  let offset = -1
  while ((offset = text.indexOf('\n', offset + 1)) >= 0) count++
  return count
}

// A compact offset table lets expanded files read only the visible page.
// Unlike split(), it retains no per-line strings for the rest of the file.
export class TextLineIndex {
  private readonly starts: Uint32Array
  constructor(readonly text: string, readonly lineCount = countTextLines(text)) {
    this.starts = new Uint32Array(lineCount)
    let offset = -1
    let line = 1
    while ((offset = text.indexOf('\n', offset + 1)) >= 0) this.starts[line++] = offset + 1
  }

  page(start: number, limit: number): string[] {
    const lines: string[] = []
    for (let i = Math.max(0, start); i < Math.min(this.lineCount, start + limit); i++) {
      const from = this.starts[i]
      const hasNewline = i + 1 < this.lineCount
      let end = hasNewline ? this.starts[i + 1] - 1 : this.text.length
      if (hasNewline && end > from && this.text[end - 1] === '\r') end--
      lines.push(this.text.slice(from, end))
    }
    return lines
  }
}
