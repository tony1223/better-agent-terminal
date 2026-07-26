// Tests for harness-injected pseudo-user turns:
//   - lib/harness-noise.mjs                (the shared detector)
//   - runtimes/claude-cli-frames.mjs       (CLI transcript classifier)
//
// The Claude harness writes background-task updates into the transcript as
// `role: 'user'` records. They must never reach the timeline as the human's own
// prompt — that is both a wrong-looking "You" bubble of raw XML and a phantom
// prompt that shifts pinned context and rewind targets.
//
// Deterministic + offline. Run with: node node-sidecar/tests/harness-noise.test.mjs

import * as assert from 'node:assert/strict'

import { stripTaskNotifications, isHarnessNoiseUserText, isCompactSummaryUserText } from '../src/lib/harness-noise.mjs'
import { parseTranscriptLine, FRAME_KINDS } from '../src/runtimes/claude-cli-frames.mjs'

let failures = 0
function test(name, fn) {
  try { fn(); console.log('  ok  -', name) } catch (err) {
    failures++; console.error('  FAIL-', name, '\n   ', err.message)
  }
}

// Shaped after the real injection seen in the wild (nested tags, CJK payload).
const NOTIFICATION = [
  '<task-notification>',
  '  <task-id>b4b43fb3i</task-id>',
  '  <summary>Monitor event: "hunter packing progress in drive-progress.log"</summary>',
  '  <event>起始 pid=5390 status=running</event>',
  '</task-notification>',
].join('\n')

// ---- detector ----

test('notification-only text is noise', () => {
  assert.equal(isHarnessNoiseUserText(NOTIFICATION), true)
  assert.equal(stripTaskNotifications(NOTIFICATION), '')
})

test('leading/trailing whitespace does not hide a notification', () => {
  assert.equal(isHarnessNoiseUserText(`\n\n  ${NOTIFICATION}  \n`), true)
})

test('back-to-back notifications are all stripped', () => {
  assert.equal(isHarnessNoiseUserText(`${NOTIFICATION}\n${NOTIFICATION}`), true)
})

test('single-line (whitespace-collapsed) form is still detected', () => {
  // claude-readonly's preview path collapses newlines before filtering.
  const collapsed = NOTIFICATION.replace(/\s+/g, ' ')
  assert.equal(isHarnessNoiseUserText(collapsed), true)
})

test('mixed content keeps the human text and drops the notification', () => {
  const mixed = `please fix the build\n${NOTIFICATION}`
  assert.equal(isHarnessNoiseUserText(mixed), false)
  assert.equal(stripTaskNotifications(mixed), 'please fix the build')
})

test('text on both sides of a notification survives', () => {
  const mixed = `before\n${NOTIFICATION}\nafter`
  assert.equal(stripTaskNotifications(mixed), 'before\n\nafter')
})

test('ordinary prompts are untouched', () => {
  for (const prompt of ['release new tag version', 'why is <div> escaped?', '這個被吃成input好像不太對']) {
    assert.equal(isHarnessNoiseUserText(prompt), false, prompt)
    assert.equal(stripTaskNotifications(prompt), prompt, prompt)
  }
})

test('the other two harness markers stay noise', () => {
  assert.equal(isHarnessNoiseUserText('[Request interrupted by user for tool use]'), true)
  assert.equal(isHarnessNoiseUserText('<local-command-caveat>ran /foo</local-command-caveat>'), true)
  assert.equal(isHarnessNoiseUserText(''), true)
  assert.equal(isHarnessNoiseUserText('   '), true)
})

test('malformed / unclosed tags do not throw and do not leak markup', () => {
  const unclosed = '<task-notification>\n  <summary>truncated write'
  assert.equal(isHarnessNoiseUserText(unclosed), true)
  assert.equal(stripTaskNotifications(unclosed), '')
  // A real prompt ahead of a truncated block is preserved.
  assert.equal(stripTaskNotifications(`keep me\n${unclosed}`), 'keep me')
  // A stray closing tag is not an opener, so nothing is removed.
  assert.equal(stripTaskNotifications('</task-notification> tail'), '</task-notification> tail')
  // Non-string input coerces instead of throwing.
  assert.equal(isHarnessNoiseUserText(null), true)
  assert.equal(isHarnessNoiseUserText(undefined), true)
  assert.equal(stripTaskNotifications(null), '')
  assert.equal(stripTaskNotifications(42), '42')
})

// ---- compaction summary ----

const COMPACT_SUMMARY = [
  'This session is being continued from a previous conversation that ran out of context.',
  'The summary below covers the earlier portion of the conversation.',
  '',
  'Summary:',
  '1. Primary Request and Intent: ...',
].join('\n')

test('the compaction summary is tagged, not filtered away', () => {
  // It is a real prompt — the model was continued with it — so it stays in the
  // timeline. Only the tag tells the UI to fold it.
  assert.equal(isCompactSummaryUserText(COMPACT_SUMMARY), true)
  assert.equal(isHarnessNoiseUserText(COMPACT_SUMMARY), false)
})

test('the record flag beats the text', () => {
  assert.equal(isCompactSummaryUserText('anything at all', { isCompactSummary: true }), true)
  // A record without the flag falls back to the preamble, so old transcripts
  // written before the flag existed are still recognised.
  assert.equal(isCompactSummaryUserText(COMPACT_SUMMARY, { uuid: 'u1' }), true)
})

test('real prompts are not mistaken for a summary', () => {
  assert.equal(isCompactSummaryUserText('continue from where you left off'), false)
  // Asking *about* compaction is not being compacted.
  assert.equal(isCompactSummaryUserText(`why did it print "${COMPACT_SUMMARY}"?`), false)
  assert.equal(isCompactSummaryUserText(''), false)
  assert.equal(isCompactSummaryUserText(null), false)
  assert.equal(isCompactSummaryUserText(undefined, null), false)
})

// ---- CLI transcript classifier ----

const line = (content) => JSON.stringify({
  type: 'user', sessionId: 's1', uuid: 'u1', timestamp: 't',
  message: { role: 'user', content },
})

test('frames: notification-only user line yields no frame (string content)', () => {
  assert.deepEqual(parseTranscriptLine(line(NOTIFICATION)), [])
})

test('frames: notification-only user line yields no frame (block content)', () => {
  assert.deepEqual(parseTranscriptLine(line([{ type: 'text', text: NOTIFICATION }])), [])
})

test('frames: mixed user line keeps only the human text', () => {
  const f = parseTranscriptLine(line([{ type: 'text', text: `ship it\n${NOTIFICATION}` }]))
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, FRAME_KINDS.USER)
  assert.equal(f[0].payload.text, 'ship it')
})

test('frames: a normal user line is unaffected', () => {
  const f = parseTranscriptLine(line('hello world'))
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, FRAME_KINDS.USER)
  assert.equal(f[0].payload.text, 'hello world')
})

test('frames: assistant text is never stripped by the user-only filter', () => {
  // The assistant path has its own strip; this guard is only about role=user.
  const raw = JSON.stringify({
    type: 'assistant', sessionId: 's1', uuid: 'a1', timestamp: 't',
    message: { role: 'assistant', content: [{ type: 'text', text: NOTIFICATION }] },
  })
  const f = parseTranscriptLine(raw)
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, FRAME_KINDS.ASSISTANT)
  assert.equal(f[0].payload.text, NOTIFICATION)
})

test('frames: image-only user block still emits a you frame', () => {
  const f = parseTranscriptLine(line([{ type: 'image', source: {} }]))
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, FRAME_KINDS.USER)
  assert.equal(f[0].payload.image, true)
})

console.log(failures === 0 ? '\nharness-noise: OK' : `\nharness-noise: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
