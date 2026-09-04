import re, io
def rw(path, fn):
    s = io.open(path, encoding='utf-8', newline='').read()
    nl = '\r\n' if '\r\n' in s else '\n'
    u = s.replace('\r\n','\n'); s2 = fn(u)
    assert s2 != u, path
    io.open(path,'w',encoding='utf-8',newline='').write(s2.replace('\n', nl)); print('ok', path)

def rep1(s, old, new, tag):
    assert s.count(old)==1, f'{tag}: count={s.count(old)}'
    return s.replace(old,new)

# A. type
rw('renderer/src/types/claude-agent.ts', lambda s: rep1(s,
"  parentToolUseId?: string\n  timestamp: number\n}\n",
"  parentToolUseId?: string\n  timestamp: number\n  // Set by the renderer when the terminal result lands; drives the elapsed chip.\n  completedAt?: number\n}\n", 'type'))

# B. helpers
def helpers(s):
    s = rep1(s, """  showOutRow: boolean
  showErrorRows: boolean
}
""", """  showOutRow: boolean
  showErrorRows: boolean
}

// Elapsed chip for a finished tool row. Null below one second: for the
// Read/Edit/Grep crowd the figure is noise, and the row is denser without it.
export function formatElapsed(startedAt?: number, completedAt?: number): string | null {
  if (!startedAt || !completedAt) return null
  const ms = completedAt - startedAt
  if (!(ms >= 1000)) return null
  const totalSec = Math.round(ms / 1000)
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, '0')}s`
  return `${Math.floor(totalSec / 3600)}h${String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0')}m`
}
""", 'layout type')
    s = rep1(s, """// Errors are the deliberate exception: they stay visible while collapsed. A
// failed tool that reads identically to a successful one is the one thing worth
// spending a line on, and errors are rare enough not to cost density in practice.
export function toolRowLayout(opts: {
  expanded: boolean
  hasInContent: boolean
  outText: string
  errorCount: number
}): ToolRowLayout {
  const { expanded, hasInContent, outText, errorCount } = opts
  return {
    outSize: outText ? formatCompactCount(outText.length) : null,
    showInRow: expanded && hasInContent,
    showOutRow: expanded && !!outText,
    showErrorRows: errorCount > 0,
  }
}
""", """// Errors are the deliberate exception: they stay visible while collapsed. A
// failed tool that reads identically to a successful one is the one thing worth
// spending a line on, and errors are rare enough not to cost density in practice.
// `failed` (a non-zero exit / is_error result) opens the OUT row for the same
// reason: the stderr is what the user needs to read next, so it should not sit
// behind a click.
export function toolRowLayout(opts: {
  expanded: boolean
  hasInContent: boolean
  outText: string
  errorCount: number
  failed?: boolean
}): ToolRowLayout {
  const { expanded, hasInContent, outText, errorCount, failed = false } = opts
  return {
    outSize: outText ? formatCompactCount(outText.length) : null,
    showInRow: expanded && hasInContent,
    showOutRow: (expanded || failed) && !!outText,
    showErrorRows: errorCount > 0,
  }
}
""", 'layout fn')
    return s
rw('renderer/src/components/CodexAgentPanel.helpers.ts', helpers)

# C. AgentToolRow
def row(s):
    s = rep1(s, """  outSizeTitle?: string | null
  expanded: boolean
  onToggle: () => void
}
""", """  outSizeTitle?: string | null
  /** Elapsed chip from formatElapsed, e.g. "3.2s"; omitted below one second. */
  elapsed?: string | null
  /** Non-zero exit / is_error result: header goes red, OUT row stays open. */
  failed?: boolean
  expanded: boolean
  onToggle: () => void
}
""", 'row props')
    s = rep1(s, """  outSizeTitle,
  expanded,
  onToggle,
}: AgentToolRowProps) {
  return (
    <div className="claude-tool-header" onClick={onToggle}>
""", """  outSizeTitle,
  elapsed,
  failed,
  expanded,
  onToggle,
}: AgentToolRowProps) {
  return (
    <div className={`claude-tool-header${failed ? ' failed' : ''}`} onClick={onToggle}>
""", 'row header')
    s = rep1(s, """        {outSize && (
          <span className="claude-tool-outsize" title={outSizeTitle || undefined}>{outSize}</span>
        )}
""", """        {outSize && (
          <span className="claude-tool-outsize" title={outSizeTitle || undefined}>{outSize}</span>
        )}
        {elapsed && <span className="claude-tool-elapsed">{elapsed}</span>}
""", 'row elapsed')
    return s
rw('renderer/src/components/AgentToolRow.tsx', row)

# D. panels
def panel(s):
    s = rep1(s, """        const { id, ...updates } = result as { id: string; status: string; result?: string; description?: string }
""", """        const { id, ...updates } = result as { id: string; status: string; result?: string; description?: string; completedAt?: number }
        // Terminal status: stamp the finish time so the row can show elapsed.
        if (updates.status && updates.status !== 'running') updates.completedAt = Date.now()
""", 'stamp')
    s = rep1(s, """      const layout = toolRowLayout({
        expanded: rowExpanded,
        hasInContent,
        outText: displayOutText,
        errorCount: toolRender?.errors.length ?? 0,
      })
""", """      // Denied tools already print their reason; "failed" is the tool itself
      // reporting a non-zero exit or is_error result.
      const toolFailed = item.status === 'error' && !item.denied
      const elapsed = formatElapsed(item.timestamp, item.completedAt)
      const layout = toolRowLayout({
        expanded: rowExpanded,
        hasInContent,
        outText: displayOutText,
        errorCount: toolRender?.errors.length ?? 0,
        failed: toolFailed,
      })
""", 'layout call')
    s = rep1(s, """              outSizeTitle={displayOutText ? formatContentSize(displayOutText) : null}
              expanded={rowExpanded}
              onToggle={() => toggleTool(item.id)}
            />
""", """              outSizeTitle={displayOutText ? formatContentSize(displayOutText) : null}
              elapsed={elapsed}
              failed={toolFailed}
              expanded={rowExpanded}
              onToggle={() => toggleTool(item.id)}
            />
""", 'row props')
    s = rep1(s, """                        className="claude-tool-row"
                        onClick={() => toggleTool(outBlockId)}
""", """                        className={`claude-tool-row${toolFailed ? ' claude-tool-failed-row' : ''}`}
                        onClick={() => toggleTool(outBlockId)}
""", 'out row long')
    s = rep1(s, """                        className="claude-tool-row"
                        onClick={() => handleCopyBlock(displayOutText, outBlockId)}
""", """                        className={`claude-tool-row${toolFailed ? ' claude-tool-failed-row' : ''}`}
                        onClick={() => handleCopyBlock(displayOutText, outBlockId)}
""", 'out row short')
    s = rep1(s, "formatContentSize, parseShellInvocation,", "formatContentSize, formatElapsed, parseShellInvocation,", 'import')
    return s
rw('renderer/src/components/ClaudeAgentPanel.tsx', panel)
rw('renderer/src/components/CodexAgentPanel.tsx', panel)

# E. css
rw('renderer/src/styles/claude-agent.css', lambda s: rep1(s, """.claude-tool-outsize {
  font-size: calc(var(--claude-font-size) - 3px);
  color: var(--text-secondary);
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}
""", """.claude-tool-outsize {
  font-size: calc(var(--claude-font-size) - 3px);
  color: var(--text-secondary);
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}

/* Elapsed chip: same weight as the size chip, only present from 1s up. */
.claude-tool-elapsed {
  font-size: calc(var(--claude-font-size) - 3px);
  color: var(--text-secondary);
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}

/* A failed tool (non-zero exit / is_error) reads red on its one line and keeps
   its OUT row open — see toolRowLayout's `failed`. */
.claude-tool-header.failed .claude-tool-name,
.claude-tool-header.failed .claude-tool-summary,
.claude-tool-header.failed .claude-tool-desc {
  color: var(--danger-color);
}

.claude-tool-header.failed .claude-tool-elapsed {
  color: var(--danger-color);
  opacity: 0.8;
}

.claude-tool-failed-row {
  background: rgba(239, 68, 68, 0.06);
}
""", 'css'))

# F. tests
def tests(s):
    s = rep1(s, """import { formatCompactCount, toolRowLayout } from '../renderer/src/components/CodexAgentPanel.helpers.ts'
""", """import { formatCompactCount, formatElapsed, toolRowLayout } from '../renderer/src/components/CodexAgentPanel.helpers.ts'
""", 'test import')
    s = rep1(s, """// ---- running / empty output ----
""", """// ---- failed (non-zero exit / is_error): the OUT row opens by itself ----

const failedRun = toolRowLayout({ expanded: false, hasInContent: true, outText: OUT, errorCount: 0, failed: true })
assert.equal(failedRun.showOutRow, true, 'a failed tool must show its output without a click')
assert.equal(failedRun.showInRow, false, 'failure does not bring the IN row back')
assert.equal(failedRun.outSize, formatCompactCount(OUT.length))
const failedNoOut = toolRowLayout({ expanded: false, hasInContent: true, outText: '', errorCount: 0, failed: true })
assert.equal(failedNoOut.showOutRow, false, 'nothing to open when there is no output')
const okRun = toolRowLayout({ expanded: false, hasInContent: true, outText: OUT, errorCount: 0, failed: false })
assert.equal(okRun.showOutRow, false, 'success stays one line')

// ---- elapsed chip ----

assert.equal(formatElapsed(undefined, 5000), null)
assert.equal(formatElapsed(1000, undefined), null)
assert.equal(formatElapsed(1000, 1900), null, 'sub-second durations are noise')
assert.equal(formatElapsed(1000, 2000), '1.0s')
assert.equal(formatElapsed(0, 3240), '3.2s')
assert.equal(formatElapsed(0, 72_000), '1m12s')
assert.equal(formatElapsed(0, 3_725_000), '1h02m')

// ---- running / empty output ----
""", 'test body')
    return s
rw('tests/tool-row-density.test.ts', tests)
