// Server-side latency samples: one record per completed turn, one per API
// request inside it, and one per compaction. Emitted as `agent:latency-sample`
// and appended to disk by the Rust host; nothing here talks to the renderer.
//
// Scope is deliberately narrow — SERVER response time only. `duration_ms` is
// carried as `wallMs` but is NOT the metric: it includes time the turn spent
// waiting for a human to approve a tool, which says nothing about the API.
// `apiMs` (the SDK's own duration_api_ms) and `ttftMs` are the real signals.
//
// Every record carries its own dimensions rather than a session reference,
// because a session's model/effort/window can change between turns and the
// sample has to mean what it meant when it was taken.

/** Finite non-negative number, or null. Guards against SDK builds that omit a field. */
function ms(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function tokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

// The dimensions every record is sliced by. `effort` is the raw mode string and
// `ultracode` its own flag: runtimeEffortForMode() maps 'ultracode' onto
// 'xhigh', so recording only the resolved level would hide the mode that spawns
// dozens of agents inside a single xhigh bucket.
function dimensions(session) {
  return {
    model: typeof session?.model === 'string' ? session.model : null,
    effort: typeof session?.effort === 'string' ? session.effort : null,
    ultracode: session?.ultracode === true,
    autoCompactWindow: typeof session?.autoCompactWindow === 'number'
      ? session.autoCompactWindow
      : null,
  }
}

/**
 * A completed turn. `at` prefers the SDK's own request_sent_wall_ms so the
 * hour bucket is when the request actually went out, not when we happened to
 * process the result.
 *
 * `requestCount` / `requestApiMsTotal` are what this process observed while the
 * turn ran, and exist to be disagreed with: comparing their total against the
 * SDK's own `duration_api_ms` is the only way to see how much of a request
 * record is our own overhead rather than the API. They are not a substitute for
 * `numTurns` -- that one is the SDK's count and stays authoritative.
 */
export function turnLatencySample(sessionId, session, msg, now = Date.now()) {
  const requestSentAt = ms(msg?.request_sent_wall_ms)
  return {
    kind: 'turn',
    provider: 'claude',
    sessionId: sessionId || null,
    at: requestSentAt ?? now,
    ...dimensions(session),
    apiMs: ms(msg?.duration_api_ms),
    ttftMs: ms(msg?.ttft_ms),
    wallMs: ms(msg?.duration_ms),
    outputTokens: tokens(msg?.usage?.output_tokens),
    numTurns: tokens(msg?.num_turns),
    subtype: typeof msg?.subtype === 'string' ? msg.subtype : null,
    requestCount: tokens(session?.turnRequestCount),
    requestApiMsTotal: ms(session?.turnRequestApiMsTotal),
  }
}

/**
 * One API request inside a turn, timed here rather than reported by the SDK.
 *
 * The SDK only exposes `duration_api_ms` per *turn* -- the sum across every
 * round-trip it made -- so a turn that ran twelve tool cycles is one number and
 * the distribution behind it is gone. This reconstructs the missing unit from
 * the stream: `message_start` opens a request, the first `content_block_delta`
 * is its first token, and `message_delta` closes it.
 *
 * The honest caveat, and why this is its own `kind` rather than more turn
 * fields: these are wall-clock spans measured in this process, so they carry
 * the SDK subprocess and stdio hop that the SDK's own figure does not. Treat
 * them as the shape of a turn (which call was slow, how TTFT moves as the
 * prompt grows), and the turn record as the authority on absolute API time.
 */
export function requestLatencySample(sessionId, session, pending, now = Date.now()) {
  const startedAt = ms(pending?.startedAt)
  const firstTokenAt = ms(pending?.firstTokenAt)
  return {
    kind: 'request',
    provider: 'claude',
    sessionId: sessionId || null,
    at: startedAt ?? now,
    ...dimensions(session),
    apiMs: startedAt === null ? null : Math.max(0, now - startedAt),
    ttftMs: startedAt === null || firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt),
    inputTokens: tokens(pending?.inputTokens),
    cacheReadTokens: tokens(pending?.cacheReadTokens),
    outputTokens: tokens(pending?.outputTokens),
    // Parallel subagents interleave on this stream, and their requests carry a
    // different prompt entirely. Flagging them keeps a fan-out from being read
    // as the main thread getting slower.
    subagent: Boolean(pending?.parentToolUseId),
    stopReason: typeof pending?.stopReason === 'string' ? pending.stopReason : null,
  }
}

/**
 * One compaction. Kept as its own record rather than a field on the turn: a
 * turn can compact zero or many times, and flattening would tangle "how long
 * an API call takes" with "how long compaction takes".
 */
export function compactLatencySample(sessionId, session, compactMetadata, now = Date.now()) {
  const cm = compactMetadata || {}
  return {
    kind: 'compact',
    provider: 'claude',
    sessionId: sessionId || null,
    at: now,
    ...dimensions(session),
    apiMs: ms(cm.duration_ms),
    trigger: typeof cm.trigger === 'string' ? cm.trigger : null,
    preTokens: tokens(cm.pre_tokens),
    postTokens: tokens(cm.post_tokens),
  }
}

/**
 * Whether a sample carries any timing worth storing. A record with no timing at
 * all is noise: it cannot answer either question and would only dilute the
 * bucket counts the UI uses to decide whether a figure is trustworthy.
 *
 * Tests for a number rather than `!== null` on purpose. A compact record has no
 * ttftMs key at all, and `undefined !== null` is true — so the looser check
 * declared every empty compact_boundary useful.
 */
export function latencySampleIsUseful(sample) {
  return Boolean(sample) && (typeof sample.apiMs === 'number' || typeof sample.ttftMs === 'number')
}
