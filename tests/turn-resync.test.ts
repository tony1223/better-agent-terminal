import * as assert from 'assert'
import {
  decideTurnResync,
  hostTurnState,
  mergeMissedHostMessages,
  shouldIgnoreStreamingStatus,
  STALE_STREAMING_STATUS_GRACE_MS,
  TURN_RESYNC_MIN_QUIET_MS,
} from '../renderer/src/utils/turn-resync'
import type { ClaudeMessage, ClaudeToolCall } from '../renderer/src/types/claude-agent'

const msg = (id: string, role: ClaudeMessage['role'], content: string, extra: Partial<ClaudeMessage> = {}): ClaudeMessage =>
  ({ id, sessionId: 's', role, content, timestamp: 0, ...extra })
const tool = (id: string, status: ClaudeToolCall['status'], extra: Partial<ClaudeToolCall> = {}): ClaudeToolCall =>
  ({ id, sessionId: 's', toolName: 'Bash', input: {}, status, timestamp: 0, ...extra })

const stalledPanel = { isStreaming: true, awaitingUser: false, bargeInPending: false, quietMs: TURN_RESYNC_MIN_QUIET_MS }
const idleHost = { isStreaming: false, messages: [], meta: { isStreaming: false, runtimeStatus: null } }

function testHostTurnState() {
  assert.equal(hostTurnState(null), 'unknown')
  assert.equal(hostTurnState({ messages: [] }), 'unknown', 'older host without isStreaming is not idle')
  assert.equal(hostTurnState({ isStreaming: true }), 'streaming')
  assert.equal(hostTurnState({ isStreaming: false }), 'idle', 'older host without meta')
  assert.equal(hostTurnState(idleHost), 'idle')
  // `starting` is set before the host flips its streaming flag.
  assert.equal(hostTurnState({ isStreaming: false, meta: { isStreaming: true, runtimeStatus: 'starting' } }), 'streaming')
  assert.equal(hostTurnState({ isStreaming: false, meta: { runtimeStatus: 'waiting_for_api' } }), 'streaming')
  assert.equal(hostTurnState({ isStreaming: false, pendingPermission: { toolUseId: 't' } }), 'streaming')
  assert.equal(hostTurnState({ isStreaming: false, pendingAskUser: { toolUseId: 'q' } }), 'streaming')
}

function testDecideTurnResync() {
  // GH #136: panel stuck on Thinking, host long idle → clear.
  assert.deepEqual(decideTurnResync(stalledPanel, idleHost), { clearStreaming: true, reason: 'host-idle' })
  assert.equal(decideTurnResync({ ...stalledPanel, quietMs: 6 * 60 * 60 * 1000 }, idleHost).clearStreaming, true)

  // Never clear while the host reports a live turn, or when it cannot tell.
  assert.equal(decideTurnResync(stalledPanel, { isStreaming: true }).clearStreaming, false)
  assert.equal(decideTurnResync(stalledPanel, { isStreaming: false, meta: { runtimeStatus: 'starting' } }).clearStreaming, false)
  assert.equal(decideTurnResync(stalledPanel, { isStreaming: false, pendingPermission: { toolUseId: 't' } }).clearStreaming, false)
  assert.equal(decideTurnResync(stalledPanel, null).clearStreaming, false)
  assert.equal(decideTurnResync(stalledPanel, { messages: [] }).clearStreaming, false)

  // Panel-side guards.
  assert.deepEqual(decideTurnResync({ ...stalledPanel, isStreaming: false }, idleHost), { clearStreaming: false, reason: 'panel-idle' })
  assert.equal(decideTurnResync({ ...stalledPanel, awaitingUser: true }, idleHost).clearStreaming, false)
  assert.equal(decideTurnResync({ ...stalledPanel, bargeInPending: true }, idleHost).clearStreaming, false)
  // Just-sent prompt the host may not have registered yet.
  assert.deepEqual(
    decideTurnResync({ ...stalledPanel, quietMs: TURN_RESYNC_MIN_QUIET_MS - 1 }, idleHost),
    { clearStreaming: false, reason: 'recent-activity' },
  )
}

function testShouldIgnoreStreamingStatus() {
  const now = 1_000_000
  const base = { isStreaming: true, runtimeStatus: null, lastTurnEndAt: now - 100, now }
  assert.equal(shouldIgnoreStreamingStatus(base), true, 'stale tail of the turn that just ended')
  assert.equal(shouldIgnoreStreamingStatus({ ...base, runtimeStatus: 'starting' }), false, 'a new turn announces a phase')
  assert.equal(shouldIgnoreStreamingStatus({ ...base, isStreaming: false }), false)
  assert.equal(shouldIgnoreStreamingStatus({ ...base, lastTurnEndAt: null }), false)
  assert.equal(shouldIgnoreStreamingStatus({ ...base, lastTurnEndAt: now - STALE_STREAMING_STATUS_GRACE_MS }), false)
  assert.equal(shouldIgnoreStreamingStatus({ ...base, lastTurnEndAt: now + 50 }), false, 'clock went backwards')
}

function testMergeMissedHostMessages() {
  const panel = [msg('u1', 'user', 'go'), tool('t1', 'running'), msg('a1', 'assistant', 'working')]
  const known = (items: { id: string }[]) => new Set(items.map(i => i.id))

  // Missed tool result + missed tail rows.
  const host = [
    msg('u1', 'user', 'go'),
    tool('t1', 'completed', { result: 'ok' }),
    msg('a1', 'assistant', 'working'),
    tool('t2', 'completed'),
    msg('a2', 'assistant', 'done'),
  ]
  const merged = mergeMissedHostMessages(panel, known(panel), host)
  assert.equal(merged.appended, 2)
  assert.equal(merged.updated, 1)
  assert.deepEqual(merged.messages.map(m => m.id), ['u1', 't1', 'a1', 't2', 'a2'])
  assert.equal((merged.messages[1] as ClaudeToolCall).status, 'completed')
  assert.equal((merged.messages[1] as ClaudeToolCall).result, 'ok')
  assert.equal((panel[1] as ClaudeToolCall).status, 'running', 'input not mutated')

  // Nothing new → same array (no re-render).
  const same = mergeMissedHostMessages(panel, known(panel), panel)
  assert.equal(same.messages, panel)
  assert.equal(same.appended + same.updated, 0)

  // Panel-only rows (local notices) are kept in place; host rows go after them.
  const withNotice = [...panel, msg('sys-x', 'system', 'local notice')]
  const kept = mergeMissedHostMessages(withNotice, known(withNotice), host)
  assert.deepEqual(kept.messages.map(m => m.id), ['u1', 't1', 'a1', 'sys-x', 't2', 'a2'])

  // No shared row (e.g. resumed transcript with different ids) → append nothing.
  const disjoint = mergeMissedHostMessages(panel, known(panel), [msg('x1', 'user', 'go'), msg('x2', 'assistant', 'done')])
  assert.equal(disjoint.appended, 0)
  assert.equal(disjoint.messages, panel)

  // A locally synthesized result row under another id is not duplicated, but a
  // repeated reply from an earlier turn does not suppress a new one.
  const panelWithResult = [msg('u1', 'user', '/cost'), msg('result-local', 'assistant', 'Total: $1')]
  const hostWithResult = [msg('u1', 'user', '/cost'), msg('result-host', 'assistant', 'Total: $1')]
  assert.equal(mergeMissedHostMessages(panelWithResult, known(panelWithResult), hostWithResult).appended, 0)
  const pingPanel = [msg('u1', 'user', 'ping'), msg('a1', 'assistant', 'pong'), msg('u2', 'user', 'ping')]
  const pingHost = [...pingPanel, msg('a2', 'assistant', 'pong')]
  const ping = mergeMissedHostMessages(pingPanel, known(pingPanel), pingHost)
  assert.deepEqual(ping.messages.map(m => m.id), ['u1', 'a1', 'u2', 'a2'])

  // Rows already archived (known but not in the live window) are not re-added,
  // and subagent rows never land in the main timeline.
  const live = [msg('a1', 'assistant', 'working')]
  const archivedAndLive = new Set(['u0', 'a0', 'a1'])
  const hostLong = [
    msg('u0', 'user', 'old'),
    msg('a0', 'assistant', 'old reply'),
    msg('a1', 'assistant', 'working'),
    msg('sub1', 'assistant', 'inside agent', { parentToolUseId: 'task1' }),
    msg('a2', 'assistant', 'done'),
  ]
  const archived = mergeMissedHostMessages(live, archivedAndLive, hostLong)
  assert.deepEqual(archived.messages.map(m => m.id), ['a1', 'a2'])
}

function main() {
  testHostTurnState()
  testDecideTurnResync()
  testShouldIgnoreStreamingStatus()
  testMergeMissedHostMessages()
  console.log('turn-resync tests passed')
}

main()
