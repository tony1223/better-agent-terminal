// Reconciling a Claude panel's turn state with the host (GH #136).
//
// The panel learns that a turn finished from exactly one event
// (`claude:turn-end` / `claude:result`). If that event is lost — the WebView
// was stalled for hours while the window sat occluded, a listener was briefly
// detached — the panel keeps showing "Thinking…" forever while the host has
// long since gone idle. These helpers decide, from the panel's local flags and
// a `getSessionState` snapshot, whether that "Thinking" is stale and which
// transcript rows the panel missed. Pure, so the rules are unit-testable.
import type { ClaudeMessage, ClaudeToolCall } from '../types/claude-agent'

type Item = ClaudeMessage | ClaudeToolCall

/** The panel must have seen no agent event for this long before an idle host
 *  snapshot is trusted over its own streaming flag. Matches the "stalled"
 *  indicator threshold, and keeps a just-sent prompt (whose turn the host may
 *  not have registered yet) from being cleared. */
export const TURN_RESYNC_MIN_QUIET_MS = 30_000
/** Minimum spacing between two non-forced resync requests. */
export const TURN_RESYNC_MIN_INTERVAL_MS = 5_000
/** First stall poll delay while a turn is quiet; doubles up to the max while
 *  the host keeps reporting a live turn (long tool runs are legitimately silent). */
export const TURN_RESYNC_POLL_MS = 30_000
export const TURN_RESYNC_POLL_MAX_MS = 5 * 60_000
/** A `claude:status` saying "streaming" without a runtime phase, arriving this
 *  soon after the panel processed a turn end, is the tail of the turn that just
 *  ended (the host's streaming flag drops only after the result is emitted). */
export const STALE_STREAMING_STATUS_GRACE_MS = 2_000

export type HostTurnState = 'streaming' | 'idle' | 'unknown'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * What the host says about the turn in flight. `unknown` when the snapshot
 * does not carry `isStreaming` at all (missing session, older remote host) —
 * never treat that as idle. A pending permission / question, or a runtime
 * phase such as `starting` (set before the host flips its streaming flag),
 * counts as a live turn.
 */
export function hostTurnState(state: unknown): HostTurnState {
  if (!isRecord(state) || typeof state.isStreaming !== 'boolean') return 'unknown'
  if (state.isStreaming) return 'streaming'
  if (state.pendingAskUser || state.pendingPermission) return 'streaming'
  const meta = state.meta
  if (isRecord(meta) && (meta.isStreaming === true || Boolean(meta.runtimeStatus))) return 'streaming'
  return 'idle'
}

export interface PanelTurnSnapshot {
  /** The panel currently shows a turn in flight ("Thinking…"). */
  isStreaming: boolean
  /** A permission prompt / question card is open — the turn is waiting on the user. */
  awaitingUser: boolean
  /** A barge-in send is replacing the turn; the host may be briefly idle in between. */
  bargeInPending: boolean
  /** Milliseconds since the panel last saw agent activity. */
  quietMs: number
}

export interface TurnResyncDecision {
  clearStreaming: boolean
  reason: string
}

/** Should the panel drop its "Thinking" state because the host is idle? */
export function decideTurnResync(panel: PanelTurnSnapshot, hostState: unknown): TurnResyncDecision {
  if (!panel.isStreaming) return { clearStreaming: false, reason: 'panel-idle' }
  if (panel.awaitingUser) return { clearStreaming: false, reason: 'awaiting-user' }
  if (panel.bargeInPending) return { clearStreaming: false, reason: 'barge-in' }
  if (panel.quietMs < TURN_RESYNC_MIN_QUIET_MS) return { clearStreaming: false, reason: 'recent-activity' }
  const host = hostTurnState(hostState)
  if (host !== 'idle') return { clearStreaming: false, reason: `host-${host}` }
  return { clearStreaming: true, reason: 'host-idle' }
}

/**
 * Whether a `claude:status` should NOT flip the panel back to streaming: it
 * says streaming but names no runtime phase, and the panel processed a turn end
 * moments ago. A genuinely new turn announces itself with a runtime phase
 * (`starting` / `waiting_for_api`) first, so it is never ignored here.
 */
export function shouldIgnoreStreamingStatus(input: {
  isStreaming: unknown
  runtimeStatus: unknown
  lastTurnEndAt: number | null
  now: number
}): boolean {
  if (input.isStreaming !== true || input.runtimeStatus) return false
  if (input.lastTurnEndAt == null) return false
  const sinceEnd = input.now - input.lastTurnEndAt
  return sinceEnd >= 0 && sinceEnd < STALE_STREAMING_STATUS_GRACE_MS
}

function isTool(item: Item): item is ClaudeToolCall {
  return typeof (item as ClaudeToolCall).toolName === 'string'
}

export interface MissedMessageMerge {
  messages: Item[]
  appended: number
  updated: number
}

/**
 * Additive merge of the host transcript into the panel's live window. Never
 * removes or reorders panel rows (the panel may hold archived/local-only rows
 * the host snapshot does not):
 * - appends host rows that come after the last row both sides share and that
 *   the panel does not know, skipping text rows the panel already shows under
 *   another id (locally synthesized result rows);
 * - completes tool rows the panel still shows as running but the host has
 *   finished (their tool-result event was missed too).
 * If the two lists share no row at all (e.g. a resumed transcript with
 * different ids) nothing is appended — guessing there would duplicate history.
 * Subagent rows (parentToolUseId) are ignored; they live in separate buckets.
 * Returns the same `panelLive` array when nothing changes.
 */
export function mergeMissedHostMessages(
  panelLive: readonly Item[],
  knownIds: ReadonlySet<string>,
  hostItems: readonly Item[],
): MissedMessageMerge {
  const hostMain = hostItems.filter(item => !item.parentToolUseId)
  const hostById = new Map(hostMain.map(item => [item.id, item]))

  let updated = 0
  let next: Item[] = panelLive.map(item => {
    if (!isTool(item) || item.status !== 'running') return item
    const hostItem = hostById.get(item.id)
    if (!hostItem || !isTool(hostItem) || hostItem.status === 'running') return item
    updated++
    return { ...item, ...hostItem }
  })

  let anchor = -1
  for (let i = hostMain.length - 1; i >= 0; i--) {
    if (knownIds.has(hostMain[i].id)) { anchor = i; break }
  }
  const tail = anchor >= 0 ? hostMain.slice(anchor + 1) : []
  // Only rows the panel shows after the shared anchor can be the same message
  // under another id; an identical reply from an earlier turn is not.
  const anchorInPanel = anchor >= 0 ? next.findIndex(item => item.id === hostMain[anchor].id) : -1
  const shownText = new Set(
    next
      .slice(anchorInPanel + 1)
      .filter(item => !isTool(item))
      .map(item => `${(item as ClaudeMessage).role}\u0000${(item as ClaudeMessage).content}`),
  )
  const missing = tail.filter(item => {
    if (knownIds.has(item.id)) return false
    if (isTool(item)) return true
    return !shownText.has(`${item.role}\u0000${item.content}`)
  })
  if (missing.length > 0) next = [...next, ...missing]

  if (updated === 0 && missing.length === 0) {
    return { messages: panelLive as Item[], appended: 0, updated: 0 }
  }
  return { messages: next, appended: missing.length, updated }
}
