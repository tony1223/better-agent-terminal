// Per-session in-memory state. The sessions Map is the singleton
// canonical store consumed by every claude.* handler.

import { expectedContextWindowForModel } from './models.mjs'

export const sessions = new Map()

const MAX_SESSION_MESSAGES = 300

// Persistent per-session config that survives sessions.delete() (stopSession,
// resetSession). Captures the minimal state needed to rebuild a usable
// session record on the next ensureSession call — cwd lives here so that
// `sendMessage` after a stop/reset can keep talking to the same project
// instead of falling back to process.cwd() or throwing "session has no cwd".
export const sessionConfigs = new Map()

// sdkSessionId is intentionally NOT persisted here: the renderer's
// workspace store (on disk) is the single durable owner and drives resume
// via ensureSessionStarted -> resumeSession. Persisting it in the sidecar
// too made reset have to clear two places and let a deleted session silently
// resume a just-cleared (possibly poisoned) SDK transcript.
const CONFIG_KEYS = [
  'options',
  'model',
  'permissionMode',
  'effort',
  'ultracode',
  'autoCompactWindow',
  'agentPreset',
  'codexSandboxMode',
  'codexApprovalPolicy',
]

export function saveSessionConfig(sessionId, session) {
  if (!sessionId || !session) return
  const snapshot = {}
  for (const key of CONFIG_KEYS) {
    if (session[key] !== undefined) snapshot[key] = session[key]
  }
  sessionConfigs.set(sessionId, snapshot)
}

export function clearSessionConfig(sessionId) {
  sessionConfigs.delete(sessionId)
}

export function ensureSession(sessionId) {
  let s = sessions.get(sessionId)
  if (!s) {
    s = {
      active: false,
      options: null,
      // Renderer-controlled config; defaults match Electron's session
      // defaults so getters before any setter calls don't surprise the UI.
      model: undefined,
      autoCompactWindow: null,
      effort: undefined,
      ultracode: false,
      permissionMode: 'default',
      codexSandboxMode: undefined,
      codexApprovalPolicy: undefined,
      autoContinue: { enabled: false, max: 0, used: 0, prompt: '' },
      // SDK session id captured from the first SDKResultMessage; used as
      // `resume` on subsequent sendMessage calls so the SDK preserves
      // conversation context.
      sdkSessionId: null,
      // Per-session abort signal; set during sendMessage so abortSession
      // can cancel an in-flight query.
      abortController: null,
      // Guard against concurrent sendMessage calls — same contract as the
      // Electron isStreaming flag.
      streaming: false,
      messages: [],
      streamingText: '',
      streamingThinking: '',
      // FIFO promise chain for claude.sendMessage. Electron accepts a
      // prompt while a turn is still finishing; the sidecar must not drop
      // that prompt just because the previous result frame has not fully
      // unwound yet.
      sendQueue: null,
      // Cached usage stats updated from stream_event message_start /
      // message_delta + the final SDKResultSuccess.usage. Surfaced to
      // the renderer via claude.getContextUsage between turns; null
      // until the first turn completes.
      lastUsage: null,
      // Pending canUseTool / AskUserQuestion resolutions keyed by the
      // tool_use_id the SDK supplies. Populated when the canUseTool
      // callback emits a permission-request / ask-user event; the
      // renderer answers via claude.resolvePermission /
      // claude.resolveAskUser, which calls the stored resolve fn.
      pendingPermissions: new Map(),
      pendingAskUser: new Map(),
      runtimeStatus: null,
      runtimeMessage: null,
      runtimeStatusStartedAt: null,
      // Renderer's "resting" UX: ClaudeAgentPanel toggles this when the
      // user sends the session to background so it doesn't keep
      // streaming. wakeSession and the next sendMessage both clear it.
      isResting: false,
    }
    sessions.set(sessionId, s)
    // Rehydrate from the persistent config so a subsequent sendMessage after
    // stopSession/resetSession still knows the cwd, model, effort, etc.
    // (sdkSessionId is deliberately excluded — see CONFIG_KEYS — so a rebuilt
    // session never silently resumes a deleted SDK conversation.)
    const saved = sessionConfigs.get(sessionId)
    if (saved) {
      for (const key of CONFIG_KEYS) {
        if (saved[key] !== undefined) s[key] = saved[key]
      }
    }
  }
  return s
}

export function resetSessionTranscript(session) {
  if (!session) return
  session.messages = []
  session.streamingText = ''
  session.streamingThinking = ''
}

export function appendSessionMessage(session, message) {
  if (!session || !message || typeof message !== 'object') return
  if (!Array.isArray(session.messages)) session.messages = []
  session.messages.push(message)
  if (session.messages.length > MAX_SESSION_MESSAGES) {
    session.messages = session.messages.slice(-MAX_SESSION_MESSAGES)
  }
}

export function appendSessionStream(session, data) {
  if (!session || !data || typeof data !== 'object') return
  if (data.parentToolUseId) return
  if (typeof data.text === 'string' && data.text) {
    session.streamingText = (session.streamingText || '') + data.text
  }
  if (typeof data.thinking === 'string' && data.thinking) {
    session.streamingThinking = (session.streamingThinking || '') + data.thinking
  }
}

export function clearSessionStream(session) {
  if (!session) return
  session.streamingText = ''
  session.streamingThinking = ''
}

export function updateSessionToolResult(session, toolId, updates) {
  if (!session || typeof toolId !== 'string' || !Array.isArray(session.messages)) return
  const idx = session.messages.findIndex(m => m && typeof m === 'object' && m.toolName && m.id === toolId)
  if (idx !== -1) session.messages[idx] = { ...session.messages[idx], ...updates }
}

// buildSessionMeta(session): shared between the getSessionMeta RPC and
// every claude:status emit so the renderer's ClaudeAgentPanel always
// gets the full 19-field shape. The renderer reads
// `inputTokens.toLocaleString()` (no optional chaining), so a sparse
// meta payload from a status event would crash the status line — we
// must always emit the full shape with 0 / null defaults.
//
// lastUsage is captured snake_case from SDK message_start/message_delta
// /result events; translate to the camelCase shape the renderer expects.
export function buildSessionMeta(s) {
  if (!s) return null
  const u = s.lastUsage
  const inputTokens = u?.input_tokens ?? 0
  const outputTokens = u?.output_tokens ?? 0
  const cacheReadTokens = u?.cache_read_input_tokens ?? 0
  const cacheCreationTokens = u?.cache_creation_input_tokens ?? 0
  const contextTokens = inputTokens + cacheReadTokens + cacheCreationTokens
  const contextWindow = expectedContextWindowForModel(u?.model || s.model) || 0
  return {
    permissionMode: s.permissionMode ?? 'default',
    model: s.model ?? null,
    effort: s.effort ?? null,
    ultracode: s.ultracode === true,
    autoCompactWindow: s.autoCompactWindow ?? null,
    sdkSessionId: s.sdkSessionId ?? null,
    cwd: (s.options && typeof s.options === 'object' && typeof s.options.cwd === 'string') ? s.options.cwd : null,
    totalCost: u?.totalCostUsd ?? 0,
    inputTokens,
    outputTokens,
    durationMs: 0,
    numTurns: u?.numTurns ?? 0,
    contextWindow,
    maxOutputTokens: 0,
    contextTokens,
    cacheReadTokens,
    cacheCreationTokens,
    callCacheRead: 0,
    callCacheWrite: 0,
    lastQueryCalls: 0,
    // `starting` is emitted before the live SDK query flips `streaming` on;
    // runtimeStatus still means this session is in-flight and must keep the
    // renderer's Thinking state visible during that startup window.
    isStreaming: s.streaming === true || Boolean(s.runtimeStatus),
    runtimeStatus: s.runtimeStatus ?? null,
    runtimeMessage: s.runtimeMessage ?? null,
    runtimeStatusStartedAt: s.runtimeStatusStartedAt ?? null,
  }
}
