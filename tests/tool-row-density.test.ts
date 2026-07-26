// Locks the one-line tool row.
//
// A long session is mostly tool calls. Before this, a single *collapsed* tool
// could spend up to nine lines — a 3-line IN row plus a 4-line output preview
// plus labels — which pushed the assistant's actual replies off screen. The rule
// is now: collapsed means one line, and the only thing allowed to break it is an
// error, because a failed tool that reads identically to a successful one is
// worth the line.
//
// Both ClaudeAgentPanel and CodexAgentPanel render through this, so a regression
// here silently doubles the height of every timeline in the app.

import * as assert from 'assert'
import { formatCompactCount, toolRowLayout } from '../renderer/src/components/CodexAgentPanel.helpers.ts'

const OUT = 'line one\nline two\nline three\nline four\nline five'

// ---- collapsed: one line, nothing else ----

const collapsed = toolRowLayout({ expanded: false, hasInContent: true, outText: OUT, errorCount: 0 })
assert.equal(collapsed.showInRow, false, 'collapsed row must not render the IN row')
assert.equal(collapsed.showOutRow, false, 'collapsed row must not render the OUT row')
assert.equal(collapsed.showErrorRows, false, 'no errors, nothing to show')
assert.equal(collapsed.outSize, formatCompactCount(OUT.length), 'magnitude moves onto the header line')

// ---- expanded: the detail comes back ----

const expanded = toolRowLayout({ expanded: true, hasInContent: true, outText: OUT, errorCount: 0 })
assert.equal(expanded.showInRow, true)
assert.equal(expanded.showOutRow, true)
assert.equal(expanded.outSize, collapsed.outSize, 'the header keeps its chip when expanded')

// ---- errors are the one exception ----

const failedCollapsed = toolRowLayout({ expanded: false, hasInContent: true, outText: '', errorCount: 2 })
assert.equal(failedCollapsed.showErrorRows, true, 'a failure must be visible without expanding')
assert.equal(failedCollapsed.showInRow, false, 'an error does not bring the IN row back')
assert.equal(failedCollapsed.showOutRow, false)

// ---- running / empty output ----

const running = toolRowLayout({ expanded: false, hasInContent: false, outText: '', errorCount: 0 })
assert.equal(running.outSize, null, 'no chip before there is any output')
assert.equal(running.showOutRow, false)

// An expanded row with no input worth showing still must not render an IN row.
const noInput = toolRowLayout({ expanded: true, hasInContent: false, outText: OUT, errorCount: 0 })
assert.equal(noInput.showInRow, false)
assert.equal(noInput.showOutRow, true)

// ---- compact magnitude formatting ----

assert.equal(formatCompactCount(0), '0')
assert.equal(formatCompactCount(312), '312')
assert.equal(formatCompactCount(999), '999')
assert.equal(formatCompactCount(1000), '1.0K')
assert.equal(formatCompactCount(1126), '1.1K')
assert.equal(formatCompactCount(9949), '9.9K')
// At/above 10K the decimal stops buying anything and costs row width.
assert.equal(formatCompactCount(10_000), '10K')
assert.equal(formatCompactCount(18_204), '18K')
assert.equal(formatCompactCount(999_999), '1000K')
assert.equal(formatCompactCount(1_000_000), '1.0M')
assert.equal(formatCompactCount(2_400_000), '2.4M')
assert.equal(formatCompactCount(15_000_000), '15M')
// Never wider than 6 characters, or it starts squeezing the argument column.
for (const n of [0, 999, 1000, 9949, 10_000, 999_999, 1_000_000, 15_000_000, 999_000_000]) {
  assert.ok(formatCompactCount(n).length <= 6, `${n} -> ${formatCompactCount(n)} is too wide`)
}

console.log('tool row density: passed')
