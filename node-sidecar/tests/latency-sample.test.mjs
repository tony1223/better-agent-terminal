// Tests for lib/latency-sample.mjs — the record shape behind the response-time
// statistics page.
//
// These records are append-only and kept for 60 days, so the shape is effectively
// a storage format: a field that silently changes meaning invalidates two months
// of history that cannot be recomputed. The tests below pin the parts that are
// easy to "tidy up" into something wrong.
//
// Deterministic + offline. Run with: node node-sidecar/tests/latency-sample.test.mjs

import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  turnLatencySample,
  compactLatencySample,
  latencySampleIsUseful,
} from '../src/lib/latency-sample.mjs'

let failures = 0
function test(name, fn) {
  try { fn(); console.log('  ok  -', name) } catch (err) {
    failures++; console.error('  FAIL-', name, '\n   ', err.message)
  }
}

const NOW = 1_700_000_000_000

// A session as ensureSession() leaves it once the renderer has configured it.
const session = {
  model: 'claude-opus-4-8',
  effort: 'ultracode',
  ultracode: true,
  autoCompactWindow: 160_000,
  permissionMode: 'acceptEdits',
}

// Shaped after a real SDKResultMessage (sdk.d.ts: duration_ms, duration_api_ms,
// ttft_ms, request_sent_wall_ms are all top-level on the result frame).
const result = {
  type: 'result',
  subtype: 'success',
  duration_ms: 91_000,
  duration_api_ms: 42_000,
  ttft_ms: 1_800,
  request_sent_wall_ms: NOW - 91_000,
  num_turns: 7,
  usage: { output_tokens: 3_210 },
}

test('a turn sample carries the API timings, not just wall time', () => {
  const s = turnLatencySample('sess-1', session, result, NOW)
  assert.equal(s.kind, 'turn')
  assert.equal(s.apiMs, 42_000)
  assert.equal(s.ttftMs, 1_800)
  assert.equal(s.wallMs, 91_000)
  assert.equal(s.outputTokens, 3_210)
  assert.equal(s.numTurns, 7)
  assert.equal(s.sessionId, 'sess-1')
})

// The hour bucket is the whole point of the feature. Stamping the sample when we
// process the result puts a long turn in the wrong hour — up to an hour late.
test('the timestamp is when the request went out, not when we saw the result', () => {
  const s = turnLatencySample('sess-1', session, result, NOW)
  assert.equal(s.at, NOW - 91_000)
})

test('a result with no request_sent_wall_ms falls back to now', () => {
  const { request_sent_wall_ms: _omitted, ...noWallClock } = result
  const s = turnLatencySample('sess-1', session, noWallClock, NOW)
  assert.equal(s.at, NOW)
})

// runtimeEffortForMode() resolves 'ultracode' to 'xhigh' before it reaches the
// CLI. If the sample recorded only the resolved level, every ultracode turn —
// which fans out to dozens of agents — would hide inside the plain xhigh bucket
// and drag its average up with no way to separate them again.
test('ultracode stays its own dimension instead of collapsing into an effort level', () => {
  const s = turnLatencySample('sess-1', session, result, NOW)
  assert.equal(s.effort, 'ultracode')
  assert.equal(s.ultracode, true)

  const plain = turnLatencySample('sess-2', { ...session, effort: 'xhigh', ultracode: false }, result, NOW)
  assert.equal(plain.effort, 'xhigh')
  assert.equal(plain.ultracode, false)
})

test('model and compact window are recorded per sample, not looked up later', () => {
  const s = turnLatencySample('sess-1', session, result, NOW)
  assert.equal(s.model, 'claude-opus-4-8')
  assert.equal(s.autoCompactWindow, 160_000)

  // The same session after the user switches model mid-conversation: the next
  // sample must describe the new model, and the earlier one must not change.
  const later = turnLatencySample('sess-1', { ...session, model: 'claude-sonnet-4-6' }, result, NOW)
  assert.equal(later.model, 'claude-sonnet-4-6')
  assert.equal(s.model, 'claude-opus-4-8')
})

// A turn that errored still consumed real API time. Excluding those would bias
// every average towards the happy path, which is the opposite of what someone
// looking at a latency page wants to know.
test('a failed turn is still a sample', () => {
  const s = turnLatencySample('sess-1', session, { ...result, subtype: 'error_during_execution' }, NOW)
  assert.equal(s.subtype, 'error_during_execution')
  assert.equal(s.apiMs, 42_000)
  assert.equal(latencySampleIsUseful(s), true)
})

test('missing and nonsense timings become null rather than NaN or a negative', () => {
  const s = turnLatencySample('sess-1', session, {
    subtype: 'success',
    duration_api_ms: null,
    ttft_ms: 'fast',
    duration_ms: -1,
  }, NOW)
  assert.equal(s.apiMs, null)
  assert.equal(s.ttftMs, null)
  assert.equal(s.wallMs, null)
})

test('a session with nothing configured yields nulls, not undefined', () => {
  const s = turnLatencySample(null, undefined, result, NOW)
  assert.equal(s.model, null)
  assert.equal(s.effort, null)
  assert.equal(s.autoCompactWindow, null)
  assert.equal(s.ultracode, false)
  assert.equal(s.sessionId, null)
  // Undefined would vanish through JSON.stringify and produce records with a
  // different key set than the rest of the file.
  for (const [key, value] of Object.entries(s)) {
    assert.notEqual(value, undefined, `${key} is undefined`)
  }
})

test('a compaction is its own record, with its own duration', () => {
  const s = compactLatencySample('sess-1', session, {
    trigger: 'auto',
    pre_tokens: 150_000,
    post_tokens: 42_000,
    duration_ms: 12_500,
  }, NOW)
  assert.equal(s.kind, 'compact')
  assert.equal(s.apiMs, 12_500)
  assert.equal(s.trigger, 'auto')
  assert.equal(s.preTokens, 150_000)
  assert.equal(s.postTokens, 42_000)
  assert.equal(s.at, NOW)
  // Sliced by the same dimensions as a turn, so both tabs can be filtered the
  // same way.
  assert.equal(s.model, 'claude-opus-4-8')
  assert.equal(s.ultracode, true)
})

test('a compact_boundary with no metadata does not throw', () => {
  const s = compactLatencySample('sess-1', session, undefined, NOW)
  assert.equal(s.apiMs, null)
  assert.equal(s.trigger, null)
  assert.equal(latencySampleIsUseful(s), false)
})

// The UI annotates buckets with too few samples. A record carrying no timing at
// all would still be counted there, making a bucket look better-supported than
// it is, so it must be dropped before it is written.
test('a sample with no timing at all is not worth storing', () => {
  assert.equal(latencySampleIsUseful(null), false)
  assert.equal(latencySampleIsUseful({ apiMs: null, ttftMs: null, wallMs: 91_000 }), false)
  assert.equal(latencySampleIsUseful({ apiMs: null, ttftMs: 1_800 }), true)
  assert.equal(latencySampleIsUseful({ apiMs: 42_000, ttftMs: null }), true)
})

// One line per record on disk; a newline inside one would split it in two and
// break every later line of that day's file.
test('a sample survives a JSONL round trip on one line', () => {
  const s = turnLatencySample('sess-1', session, result, NOW)
  const line = JSON.stringify(s)
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(JSON.parse(line), s)
})

// Where the emit sits in the result handler is a behavioural promise, not a
// style choice: below the `interruptRequested` / subtype branches it would only
// ever record turns that ended cleanly, and every average would drift towards
// the happy path with nothing on screen to say so.
//
// Checked against the source because processMessage is module-private and driving
// it needs a live SDK query. Weak — it proves placement, not execution — so if a
// rename breaks this, keep the invariant and fix the pattern rather than deleting
// the test.
test('a turn sample is emitted before the branches that can return early', () => {
  const source = readFileSync(new URL('../src/handlers/claude-send.mjs', import.meta.url), 'utf8')
  const emit = source.indexOf('emitLatencySample(turnLatencySample(')
  const interrupted = source.indexOf('if (s.interruptRequested) {')
  assert.ok(emit > 0, 'the result handler still emits a turn sample')
  assert.ok(interrupted > 0, 'the interrupted branch is still there to be ordered against')
  assert.ok(emit < interrupted, 'the sample must be emitted before the early returns')

  // Compaction reports its duration exactly once, in compact_boundary, and that
  // arm used to end in a bare `return`.
  assert.ok(
    source.includes('emitLatencySample(compactLatencySample('),
    'compact_boundary still records the compaction',
  )
})

console.log(failures === 0 ? '\nlatency-sample: OK' : `\nlatency-sample: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
