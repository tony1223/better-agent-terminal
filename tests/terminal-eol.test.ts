import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Terminal } from '@xterm/xterm'

// Claude Code's fullscreen TUI repaints a scrolled viewport row by row: it
// positions the cursor, clears the row, then sends a bare LF and expects the
// cursor to keep its column. Captured from ConPTY while wheel-scrolling.
const repaint = '\x1b[26;3H\x1b[K\nhealthlead.tw'

function rowAfterRepaint(convertEol: boolean): Promise<string> {
  const terminal = new Terminal({ cols: 40, rows: 30, convertEol, allowProposedApi: true })
  return new Promise(resolve => terminal.write(repaint, () => {
    resolve(terminal.buffer.active.getLine(26)!.translateToString(true))
  }))
}

async function main() {
  assert.equal(await rowAfterRepaint(false), '  healthlead.tw',
    'a bare LF from the PTY must only move down a line')
  assert.equal(await rowAfterRepaint(true), 'healthlead.tw',
    'convertEol turns that LF into CRLF and shifts the row to column 1')

  const source = readFileSync('renderer/src/components/TerminalPanel.tsx', 'utf8')
  const option = source.match(/convertEol:\s*([^,\n]+)/)?.[1]
  assert.equal(option, 'false',
    'TerminalPanel renders PTY output, which already ends lines with CRLF; convertEol garbles fullscreen TUIs on scroll')

  console.info('terminal eol tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
