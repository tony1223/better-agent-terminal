import * as assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { AgentFilePreview } from '../renderer/src/components/AgentFilePreview'
import { WeightedLruCache } from '../renderer/src/utils/weighted-lru-cache'
import { TextLineIndex, countTextLines } from '../renderer/src/utils/text-lines'
import { filePreviewLines, prepareAgentFilePreview, summarizePreviewLines } from '../renderer/src/utils/agent-file-preview'
import { createToolRenderCache, getOrComputeToolRender, pruneToolRenderCache } from '../renderer/src/utils/tool-result-cache'
import { prepareSpecialToolResult } from '../renderer/src/components/CodexAgentPanel.helpers'

// Both keys and values contribute to retention; touching an entry protects it
// from eviction, and an oversized result must not flush the useful cache.
const lru = new WeightedLruCache<string, string>(3, 10, (key, value) => key.length + value.length)
lru.set('a', '123')
lru.set('b', '123')
assert.equal(lru.get('a'), '123')
lru.set('c', '123')
assert.equal(lru.get('b'), undefined)
assert.equal(lru.weight, 8)
lru.set('large', 'x'.repeat(20))
assert.equal(lru.size, 2)
assert.equal(lru.get('large'), undefined)
lru.set('a', '1')
assert.equal(lru.weight, 6, 'replacing an entry must release its old weight')

const countBounded = new WeightedLruCache<number, null>(2, 100, () => 1)
countBounded.set(1, null)
countBounded.set(2, null)
countBounded.set(3, null)
assert.equal(countBounded.get(1), undefined)
assert.equal(countBounded.get(2), null, 'cached path misses are distinct from absent entries')

// Reproduce 500 growing reasoning snapshots with realistic text + HTML keys.
// A count-only cache would allow all of this estimated string storage to stay.
const cacheBudget = 16 * 1024 * 1024
const snapshots = new WeightedLruCache<string, string>(500, cacheBudget, (key, value) => 2 * (key.length + value.length))
let countOnlyWeight = 0
for (let i = 0; i < 500; i++) {
  const key = 'cwd\0' + 'reasoning '.repeat(12_000) + i
  const html = '<p>' + key + '</p>'
  countOnlyWeight += 2 * (key.length + html.length)
  snapshots.set(key, html)
  assert.ok(snapshots.weight <= cacheBudget)
}
assert.ok(countOnlyWeight > 200 * 1024 * 1024)
assert.ok(snapshots.size < 500)

for (const text of ['', 'one', 'a\nb', 'a\r\nb\r\n', '\n\n', 'a\rb', 'a\r', '中文\n🙂']) {
  assert.equal(countTextLines(text), text.split(/\r?\n/).length)
  const summary = summarizePreviewLines(text, 3)
  assert.equal(summary.lineCount, countTextLines(text))
  assert.deepEqual(summary.previewLines, text.split(/\r?\n/).slice(0, 3))
}

const smallEdit = prepareAgentFilePreview({ old_string: 'a\nb\nc\nd', new_string: 'e' }, 'edit')
assert.equal(smallEdit.isLong, false)
assert.deepEqual(filePreviewLines(smallEdit.sections[0], !smallEdit.isLong), ['a', 'b', 'c', 'd'])
assert.deepEqual(prepareAgentFilePreview({ changes: [null, false, []] }, 'edit').sections, [])

const minified = 'x'.repeat(1_000_000)
const minifiedWrite = prepareAgentFilePreview({ content: minified }, 'write')
assert.equal(minifiedWrite.isLong, true, 'a one-line minified file still needs a bounded preview')
assert.ok(filePreviewLines(minifiedWrite.sections[0], false)[0].length <= 2001)
assert.equal(filePreviewLines(minifiedWrite.sections[0], true)[0], minified)
const hiddenLargeLine = prepareAgentFilePreview({ old_string: 'a\nb\nc\n' + minified, new_string: '' }, 'edit')
assert.equal(hiddenLargeLine.isLong, true, 'a large line outside the preview must not force full rendering')

const largePatch = '+const value = "some source code"\n'.repeat(100_000) + '+tail'
const input = { changes: [{ path: 'large.ts', kind: { type: 'update' }, unified_diff: largePatch }] }
const preview = prepareAgentFilePreview(input, 'edit')
assert.equal(preview.totalLines, 100_002)
assert.equal(preview.isLong, true)
const collapsedLines = filePreviewLines(preview.sections[0], false)
assert.equal(collapsedLines.length, 12)
assert.equal(collapsedLines[0], '*** update File: large.ts')
assert.equal(filePreviewLines(preview.sections[0], true).at(-1), '+tail')
assert.equal(filePreviewLines(preview.sections[0], true).length, preview.totalLines)
for (let frame = 0; frame < 600; frame++) {
  assert.strictEqual(filePreviewLines(preview.sections[0], false), collapsedLines,
    'unchanged collapsed updates must reuse the preview, not allocate another full line array')
}

// Preserve each special row's reminder/content-block ordering and full result.
const blockResult = [{ type: 'text', text: 'answer\n<system-reminder>note</system-reminder>\n<tool_use_error>failure</tool_use_error>' }]
const ask = prepareSpecialToolResult(blockResult, 'AskUserQuestion')
assert.equal(ask.content, 'answer')
assert.deepEqual(ask.reminders, ['note'])
assert.deepEqual(ask.errors, ['failure'])
const task = prepareSpecialToolResult({ content: [{ type: 'text', text: 'first\nsecond' }] }, 'TaskOutput')
assert.equal(task.content, 'first\nsecond')
assert.equal(task.lineCount, 2)
assert.equal(prepareSpecialToolResult(largePatch, 'Edit').content, largePatch)

const specialCache = createToolRenderCache<ReturnType<typeof prepareSpecialToolResult>>()
let computations = 0
const readResult = (result: unknown) => getOrComputeToolRender(specialCache, 'archived-tool', result, () => {
  computations++
  return prepareSpecialToolResult(result, 'TaskOutput')
})
const prepared = readResult(blockResult)
for (let frame = 0; frame < 600; frame++) assert.strictEqual(readResult(blockResult), prepared)
assert.equal(computations, 1)
pruneToolRenderCache(specialCache, new Set(['live-tool', 'archived-tool']))
assert.strictEqual(readResult(blockResult), prepared)
readResult('updated result')
assert.equal(computations, 2, 'a changed result must invalidate cached preparation')
pruneToolRenderCache(specialCache, new Set())
assert.equal(specialCache.size, 0, 'clearing a transcript must release computed results')

console.log('renderer transcript performance regression: passed')

if (process.argv.includes('--benchmark')) {
  const iterations = 100
  const oldStart = performance.now()
  let oldLines = 0
  for (let frame = 0; frame < iterations; frame++) oldLines += preview.sections[0].text.split(/\r?\n/).length
  const oldMs = performance.now() - oldStart
  const newStart = performance.now()
  const preparedOnce = prepareAgentFilePreview(input, 'edit')
  let previewLines = 0
  for (let frame = 0; frame < iterations; frame++) previewLines += filePreviewLines(preparedOnce.sections[0], false).length
  const newMs = performance.now() - newStart
  console.log(JSON.stringify({
    scenario: '100 updates of a collapsed 100,000-line patch (preparation only)',
    oldMs: Math.round(oldMs), newMs: Math.round(newMs),
    oldAllocatedLines: oldLines, newPreviewLines: preparedOnce.sections[0].previewLines.length,
    countOnlySnapshotMiB: Math.round(countOnlyWeight / 1024 / 1024),
    boundedSnapshotMiB: Math.round(snapshots.weight / 1024 / 1024),
  }))
  assert.equal(previewLines, iterations * 12)
}

// Expanded pages preserve CRLF/trailing empty lines and allocate only the page.
const indexedText = Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n'
const lineIndex = new TextLineIndex(indexedText)
assert.equal(lineIndex.lineCount, 100_001)
assert.deepEqual(lineIndex.page(99_995, 200), ['line 99995', 'line 99996', 'line 99997', 'line 99998', 'line 99999', ''])
assert.equal(lineIndex.page(0, 200).length, 200)
assert.deepEqual(new TextLineIndex('a\r').page(0, 200), ['a\r'])
assert.deepEqual(new TextLineIndex('').page(0, 200), [''])

// Exercise the actual component as well as the index: expanding a 100k-line
// write must not accidentally map the entire input into React/DOM rows.
const previewI18n = createInstance()
previewI18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: {} } } })
const renderPreview = (expanded: boolean) => renderToStaticMarkup(createElement(I18nextProvider, { i18n: previewI18n },
  createElement(AgentFilePreview, { input: { content: indexedText }, variant: 'write', expanded, toggleId: 'large-write', onToggle: () => {} })))
const expandedMarkup = renderPreview(true)
assert.equal((expandedMarkup.match(/class="claude-diff-line /g) || []).length, 200)
assert.ok(expandedMarkup.includes('line 199'))
assert.ok(!expandedMarkup.includes('line 200<'))
assert.ok(expandedMarkup.includes('type="number"'), 'every file page remains directly reachable')
assert.equal((renderPreview(false).match(/class="claude-diff-line /g) || []).length, 8)
