// claude.sendMessage — persistent streaming-input SDK Query when supported.
//
// Keep one LiveQuery open per session so later turns do not pay the SDK
// CLI subprocess startup cost. Some SDK/CLI builds close the generator
// after a result even in streaming-input mode; when that happens, the
// next sendMessage rebuilds with resume=<sdkSessionId>.
//
// SDKMessage→event mapping (mirror of Electron's processMessage):
//   system/init      → claude:status (full meta + sdkSessionId capture)
//   rate_limit_event → claude:rate-limit
//   stream_event     → claude:stream (text/thinking deltas) + usage tracking
//   assistant        → claude:message + claude:tool-use per block
//   user             → claude:tool-result per tool_result block
//   result/success   → claude:result + claude:turn-end
//   result/!success  → claude:error + claude:turn-end
//   stream throw     → handled by sendMessage's catch → claude:error /
//                      claude:turn-end
//
// SDK-unavailable fallback (releases without bundled node_modules)
// preserves the old stub so the renderer doesn't hang on a never-
// resolving promise.
//
// The RPC resolves on receipt, not on completion: {ok:true, accepted:true}
// once the prompt reaches the SDK. The turn's outcome arrives on the events
// above — claude:turn-end already distinguishes completed / error /
// interrupted / aborted, so nothing needs the reply to carry it. What still
// comes back as a real result is anything that settles before the push:
// {ok:false, cancelled:true} for a queued send Esc killed, a stopped session,
// the SDK stub, and an ensureLiveQuery failure (whose 'session has no cwd'
// the renderer reads to retry after a runtime restart).

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import {
  sessions,
  ensureSession,
  buildSessionMeta,
  saveSessionConfig,
  appendSessionMessage,
  appendSessionStream,
  clearSessionStream,
  updateSessionToolResult,
} from '../lib/state.mjs'
import { hasSdkOverrideForTests, loadAnthropicSdk } from '../lib/sdk-loader.mjs'
import { info as logInfo, warn as logWarn } from '../lib/logger.mjs'
import { runtimeEffortForMode, isUltracodeMode, parseEffortRejection, fallbackEffortFrom } from '../lib/claude-effort.mjs'
import {
  turnLatencySample,
  requestLatencySample,
  compactLatencySample,
  latencySampleIsUseful,
} from '../lib/latency-sample.mjs'
import { existsSync, statSync } from 'node:fs'
import { autoCompactWindowForClaudeSelection, sdkModelForClaudeSelection } from '../lib/models.mjs'
import { loadInstalledPlugins, dataUrlToContentBlock } from '../lib/plugins.mjs'
import { resolveClaudeCliBinaryWithInstall } from './claude-auth.mjs'
import { buildCanUseTool } from './claude-permission.mjs'
import { invalidateSessionCommandCache } from './claude-readonly.mjs'
import { LiveQuery } from '../lib/live-query.mjs'
import { isCodexSession, sendCodexMessage, isCodexAgentPreset } from './codex.mjs'

let userEchoSeq = 0
const MAX_CLIENT_MESSAGE_REQUESTS = 256

function sessionCwd(session) {
  return session?.options && typeof session.options === 'object' && typeof session.options.cwd === 'string'
    ? session.options.cwd.trim()
    : ''
}

function missingSessionCwdError(sessionId) {
  return `claude.sendMessage(${shortSessionId(sessionId)}): session has no cwd; startSession must be called with options.cwd`
}

// The SDK spawns the CLI with `cwd`; when that folder is missing Node fails
// the spawn with ENOENT and the SDK blames the *binary* ("native binary at
// ... exists but failed to launch"). Seen when a workspace list carried over
// from another machine points at folders this host does not have. Check up
// front so the user reads the real cause.
function sessionCwdMissingOnHostError(sessionId, cwd) {
  return `claude.sendMessage(${shortSessionId(sessionId)}): workspace folder not found on this host: ${cwd}. The session's cwd must exist on the machine running the agent.`
}

function isExistingDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function clientMessageId(params) {
  return typeof params?.clientMessageId === 'string' && params.clientMessageId.trim()
    ? params.clientMessageId
    : null
}

function pruneClientMessageRequests(session) {
  if (!(session?.clientMessageRequests instanceof Map)) {
    session.clientMessageRequests = new Map()
  }
  while (session.clientMessageRequests.size >= MAX_CLIENT_MESSAGE_REQUESTS) {
    const completedKey = [...session.clientMessageRequests.entries()]
      .find(([, record]) => record?.status !== 'pending')?.[0]
    if (completedKey === undefined) break
    session.clientMessageRequests.delete(completedKey)
  }
}

function duplicateClientMessageResult(record) {
  if (record?.status === 'pending') {
    return { ok: true, duplicate: true, pending: true }
  }
  if (record?.status === 'rejected') {
    throw new Error(record.error || 'previous send failed')
  }
  const result = record?.result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, duplicate: true }
  }
  return { ok: true, duplicate: true, result }
}

function batDebugEnabled() {
  return process.env.BAT_DEBUG === '1' || process.env.BAT_DEBUG === 'true'
}

function shortSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.slice(0, 8) : 'unknown'
}

function preview(value, max = 160) {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

// --- claude subprocess stderr capture -------------------------------------
//
// The SDK pipes the `claude` process's stderr only when an `options.stderr`
// callback is set (otherwise stdio[2] is 'ignore' and the output is lost).
// We install a callback that keeps a rolling tail so that when the SDK
// surfaces an opaque "Claude Code process exited with code N", we can attach
// the real reason (auth / org-policy / missing-binary messages claude prints
// to stderr) instead of an inscrutable exit code.
const CLAUDE_STDERR_TAIL_MAX = 8192

function appendClaudeStderr(s, chunk) {
  if (!s || chunk == null) return
  const text = typeof chunk === 'string' ? chunk : String(chunk)
  if (!text) return
  const combined = (s.claudeStderrTail || '') + text
  s.claudeStderrTail = combined.length > CLAUDE_STDERR_TAIL_MAX
    ? combined.slice(combined.length - CLAUDE_STDERR_TAIL_MAX)
    : combined
}

function cleanStderrText(text) {
  return String(text || '')
    // strip ANSI escape / CSI sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // drop remaining control chars except \n and \t
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// enrichExitErrorMessage: when the SDK error is an opaque process-exit/spawn
// failure, append the captured stderr tail so the renderer shows the actual
// cause (e.g. "Your organization has disabled Claude subscription access").
function enrichExitErrorMessage(errMsg, s) {
  const base = typeof errMsg === 'string' ? errMsg : String(errMsg ?? '')
  const tail = cleanStderrText(s?.claudeStderrTail)
  if (!tail) return base
  const looksOpaque = /exited with code|terminated by signal|Failed to spawn|exited with error|failed to launch/i.test(base)
  if (!looksOpaque) return base
  if (base.includes(tail)) return base
  return `${base}\n\n${tail}`
}

// downgradeEffortOnRejection: when the CLI rejects the session's current
// effort for the account's actual plan (e.g. 'max' requires API billing),
// persist a supported fallback so the NEXT send succeeds instead of
// repeating the same failure forever, and replace the opaque message with
// one that explains what happened. Returns the original message unchanged
// when it isn't this specific rejection.
function downgradeEffortOnRejection(s, sessionId, message) {
  const rejection = parseEffortRejection(message)
  if (!rejection) return message
  const fallback = fallbackEffortFrom(rejection.allowed)
  s.effort = fallback
  s.ultracode = false
  saveSessionConfig(sessionId, s)
  sendEvent('claude:status', { sessionId, meta: buildSessionMeta(s) })
  logWarn(`claude.sendMessage(${shortSessionId(sessionId)}): effort "${rejection.rejected}" rejected by CLI; session downgraded to "${fallback}"`)
  return `Effort level "${rejection.rejected}" isn't available on your Claude.ai plan. This session has been switched to "${fallback}" — please resend your message.`
}

function contentLength(content) {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (typeof block?.text === 'string') return sum + block.text.length
      if (typeof block?.content === 'string') return sum + block.content.length
      if (Array.isArray(block?.content)) return sum + contentLength(block.content)
      return sum
    }, 0)
  }
  return 0
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return { inputType: typeof input }
  const summary = { inputKeys: Object.keys(input) }
  if (typeof input.command === 'string') {
    summary.commandLen = input.command.length
    summary.commandPreview = preview(input.command)
  }
  if (typeof input.file_path === 'string') summary.filePath = input.file_path
  if (typeof input.path === 'string') summary.path = input.path
  return summary
}

function debugLog(label, sessionId, details = {}) {
  if (!batDebugEnabled()) return
  logInfo(`claude.debug(${shortSessionId(sessionId)}): ${label} ${JSON.stringify(details)}`)
}

function debugSdkFrame(sessionId, msg) {
  if (!batDebugEnabled()) return
  const t = msg?.type || 'unknown'
  const details = { type: t }
  if (typeof msg?.session_id === 'string') details.sdkSessionId = shortSessionId(msg.session_id)
  if (typeof msg?.parent_tool_use_id === 'string') details.parentToolUseId = msg.parent_tool_use_id
  if (t === 'system') {
    details.subtype = msg?.subtype
    details.model = msg?.model
    details.cwd = msg?.cwd
  } else if (t === 'stream_event') {
    details.eventType = msg?.event?.type
    details.textLen = typeof msg?.event?.delta?.text === 'string' ? msg.event.delta.text.length : 0
    details.thinkingLen = typeof msg?.event?.delta?.thinking === 'string' ? msg.event.delta.thinking.length : 0
  } else if (t === 'assistant') {
    const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : []
    details.blockTypes = blocks.map(b => b?.type).filter(Boolean)
    details.toolUses = blocks
      .filter(b => b?.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, ...summarizeToolInput(b.input) }))
    details.textLen = contentLength(blocks)
  } else if (t === 'user') {
    const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : []
    details.toolResults = blocks
      .filter(b => b?.type === 'tool_result')
      .map(b => ({
        id: b.tool_use_id,
        isError: b.is_error === true,
        contentLen: contentLength(b.content),
      }))
  } else if (t === 'result') {
    details.subtype = msg?.subtype
    details.stopReason = msg?.stop_reason
    details.resultLen = typeof msg?.result === 'string' ? msg.result.length : 0
  }
  logInfo(`claude.debug(${shortSessionId(sessionId)}): sdk-frame ${JSON.stringify(details)}`)
}

function userDisplayContent(params, prompt, images) {
  if (typeof params?.displayPrompt === 'string') return params.displayPrompt
  const imageCount = Array.isArray(images) ? images.length : 0
  const imageNote = imageCount > 0
    ? `\n[${imageCount} image${imageCount > 1 ? 's' : ''} attached]`
    : ''
  return `${prompt || ''}${imageNote}`.replace(/^\n/, '')
}

function emitUserEcho(params, sessionId, prompt, images) {
  if (params?.suppressUserEcho === true) return
  const content = userDisplayContent(params, prompt, images)
  const now = Date.now()
  const message = {
    id: typeof params?.clientMessageId === 'string' && params.clientMessageId
      ? params.clientMessageId
      : `user-${now}-${++userEchoSeq}`,
    sessionId,
    role: 'user',
    content: content || ' ',
    timestamp: now,
  }
  appendSessionMessage(sessions.get(sessionId), message)
  debugLog('emit-user-echo', sessionId, {
    clientMessageId: params?.clientMessageId || null,
    contentLen: content.length,
  })
  sendEvent('claude:message', {
    sessionId,
    message,
  })
}

function setRuntimeStatus(s, sessionId, status, message) {
  const prev = s.runtimeStatus
  s.runtimeStatus = status
  s.runtimeMessage = message
  s.runtimeStatusStartedAt = Date.now()
  logInfo(`claude.runtimeStatus(${shortSessionId(sessionId)}): set ${prev || 'none'} -> ${status} ctxTokens=${currentContextTokens(s)} compactWindow=${typeof s?.autoCompactWindow === 'number' ? s.autoCompactWindow : 0}`)
  sendEvent('claude:status', { sessionId, meta: buildSessionMeta(s) })
}

function clearRuntimeStatus(s, sessionId) {
  if (!s) return
  const prev = s.runtimeStatus
  s.runtimeStatus = null
  s.runtimeMessage = null
  s.runtimeStatusStartedAt = null
  if (prev) logInfo(`claude.runtimeStatus(${shortSessionId(sessionId)}): clear (was ${prev})`)
}

// The "starting/waiting_for_api/compacting" status is set once when a turn
// is pushed, but the API has clearly responded the moment the first stream /
// assistant / tool frame arrives. Clear it then (and broadcast) so the
// renderer's elapsed counter stops and the banner hides — otherwise it keeps
// counting from the turn start for the whole (possibly multi-minute) turn.
function markRuntimeResponded(s, sessionId) {
  if (!s?.runtimeStatus) return
  const prev = s.runtimeStatus
  s.runtimeStatus = null
  s.runtimeMessage = null
  s.runtimeStatusStartedAt = null
  logInfo(`claude.runtimeStatus(${shortSessionId(sessionId)}): responded, cleared (was ${prev})`)
  sendEvent('claude:status', { sessionId, meta: buildSessionMeta(s) })
}

function currentContextTokens(s) {
  const u = s?.lastUsage
  if (!u) return 0
  return (u.input_tokens || 0)
    + (u.output_tokens || 0)
    + (u.cache_creation_input_tokens || 0)
    + (u.cache_read_input_tokens || 0)
}

function usageNumber(usage, key, fallback) {
  const value = usage?.[key]
  return typeof value === 'number' ? value : fallback
}

// One API request's usage — the live context footprint, never a running sum.
// `base` carries the previous snapshot for the SAME request: message_delta
// only reports the fields it changes (usually output_tokens), so merging keeps
// the input/cache numbers message_start established instead of zeroing them.
// Pass null whenever a new request starts.
function requestUsageSnapshot(base, usage, model) {
  const inputTokens = usageNumber(usage, 'input_tokens', base?.input_tokens ?? 0)
  const outputTokens = usageNumber(usage, 'output_tokens', base?.output_tokens ?? 0)
  const cacheCreationTokens = usageNumber(usage, 'cache_creation_input_tokens', base?.cache_creation_input_tokens ?? 0)
  const cacheReadTokens = usageNumber(usage, 'cache_read_input_tokens', base?.cache_read_input_tokens ?? 0)
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    totalTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
    model: model || base?.model || null,
  }
}

// Sub-agent (Task) requests carry their own context, so their usage must not
// overwrite the main thread's footprint. A zero request-side total means the
// frame carried no real usage (synthetic/error assistant messages) — keeping
// the previous snapshot beats dropping ctx% to 0.
function noteRequestUsage(s, usage, { parentToolUseId, isNewRequest }) {
  if (!usage || parentToolUseId) return
  const snapshot = requestUsageSnapshot(isNewRequest ? null : s.lastUsage, usage, s.model)
  if (snapshot.totalTokens <= 0) return
  s.lastUsage = snapshot
}

function resultErrorMessage(msg) {
  for (const value of [msg?.message, msg?.error, msg?.result]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object') {
      for (const key of ['message', 'error', 'detail', 'reason']) {
        if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
      }
    }
  }
  if (Array.isArray(msg?.errors)) {
    const parts = msg.errors
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim()
        if (entry && typeof entry === 'object') {
          for (const key of ['message', 'error', 'detail', 'reason']) {
            if (typeof entry[key] === 'string' && entry[key].trim()) return entry[key].trim()
          }
        }
        return ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('; ')
  }
  const subtype = typeof msg?.subtype === 'string' && msg.subtype ? msg.subtype : 'unknown'
  const stopReason = typeof msg?.stop_reason === 'string' && msg.stop_reason ? ` stop_reason=${msg.stop_reason}` : ''
  return `Claude query ended without success: subtype=${subtype}${stopReason}`
}

// Per-request timing, keyed by parent tool use id so parallel subagents cannot
// close each other's records. '' is the main thread.
function pendingRequestKey(parentToolUseId) {
  return typeof parentToolUseId === 'string' ? parentToolUseId : ''
}

// `message_start` opens a request. Any record still open under the same key is
// abandoned rather than emitted: it means we never saw its `message_delta`, so
// its duration would run to whenever the next request happened to begin.
function openPendingRequest(s, ev, parentToolUseId, now = Date.now()) {
  if (!s.pendingRequests) s.pendingRequests = new Map()
  const usage = ev?.message?.usage
  s.pendingRequests.set(pendingRequestKey(parentToolUseId), {
    startedAt: now,
    firstTokenAt: null,
    parentToolUseId: parentToolUseId ?? null,
    inputTokens: usage?.input_tokens ?? null,
    cacheReadTokens: usage?.cache_read_input_tokens ?? null,
    outputTokens: null,
    stopReason: null,
  })
}

// First token of the open request. Thinking counts: it is the model producing
// output, and excluding it would report extended thinking as slow to respond
// when it in fact responded immediately.
function notePendingFirstToken(s, parentToolUseId, now = Date.now()) {
  const pending = s.pendingRequests?.get(pendingRequestKey(parentToolUseId))
  if (pending && pending.firstTokenAt === null) pending.firstTokenAt = now
}

// `message_delta` closes the request and carries its final usage and stop
// reason.
function closePendingRequest(s, sessionId, ev, parentToolUseId) {
  const key = pendingRequestKey(parentToolUseId)
  const pending = s.pendingRequests?.get(key)
  if (!pending) return
  s.pendingRequests.delete(key)
  pending.outputTokens = ev?.usage?.output_tokens ?? null
  pending.stopReason = ev?.delta?.stop_reason ?? null
  const sample = requestLatencySample(sessionId, s, pending)
  // Accumulate for the turn record's cross-check against the SDK's own figure.
  if (typeof sample.apiMs === 'number') {
    s.turnRequestCount = (s.turnRequestCount || 0) + 1
    s.turnRequestApiMsTotal = (s.turnRequestApiMsTotal || 0) + sample.apiMs
  }
  emitLatencySample(sample)
}

// A turn is over: whatever is still open never completed, and the next turn's
// counters start from zero.
function resetTurnRequestTracking(s) {
  s.pendingRequests?.clear()
  s.turnRequestCount = 0
  s.turnRequestApiMsTotal = 0
}

// Publish one latency sample. Dropped when it carries no timing at all: some
// SDK/CLI builds omit the duration fields, and a record with nothing in it would
// still be counted by the UI when it decides whether a bucket has enough data.
function emitLatencySample(sample) {
  if (!latencySampleIsUseful(sample)) return
  sendEvent('agent:latency-sample', sample)
}

// Push the CLI's own slash-command list — built-ins, plugin commands and skills
// alike — at the two moments it is knowable: `init`, and the CLI's own
// `commands_changed` notice.
//
// The renderer used to discover these by polling claude.getSupportedCommands on
// panel mount, which is before any turn has spawned a CLI to ask, so the menu
// only ever showed BAT's own commands. Pushing removes the timing question
// entirely: the list arrives when it exists.
//
// Fire-and-forget on purpose — processMessage is synchronous and a slow or dead
// query must not stall the frame carrying the turn's first tokens. A failure
// leaves the menu showing whatever it already had.
//
// The counter exists because only one of the two pushes is synchronous. The init
// one has to await a read off the Query, and a commands_changed arriving while
// that read is in flight is both newer and authoritative. Since the renderer's
// contract is REPLACE, letting the older answer land second would quietly swap a
// full list for a shorter one — so a push that lost its slot is dropped.
function bumpCommandsEpoch(s) {
  if (!s) return 0
  s.commandsEpoch = (s.commandsEpoch || 0) + 1
  return s.commandsEpoch
}

function emitSupportedCommands(s, sessionId) {
  invalidateSessionCommandCache(sessionId)
  const query = s?.currentQuery || s?.liveQuery?.generator
  if (!query || typeof query.supportedCommands !== 'function') return
  const epoch = bumpCommandsEpoch(s)
  Promise.resolve()
    .then(() => query.supportedCommands())
    .then((commands) => {
      if (s.commandsEpoch !== epoch) return
      if (!Array.isArray(commands) || commands.length === 0) return
      debugLog('emit-commands', sessionId, { count: commands.length })
      sendEvent('claude:commands', { sessionId, commands })
    })
    .catch((err) => {
      logWarn(`claude.supportedCommands(${shortSessionId(sessionId)}) failed: ${err?.message || err}`)
    })
}

// processMessage: dispatch a single SDKMessage to the renderer-shaped
// event(s). Pure-ish — only mutates session state (sdkSessionId, model,
// permissionMode, lastUsage) and emits via sendEvent.
function processMessage(s, sessionId, msg) {
  if (msg && typeof msg.session_id === 'string') {
    s.sdkSessionId = msg.session_id
  }
  const t = msg?.type
  if (t === 'system' && msg.subtype === 'init') {
    if (typeof msg.session_id === 'string') s.sdkSessionId = msg.session_id
    if (typeof msg.model === 'string') s.model = msg.model
    if (typeof msg.permissionMode === 'string') {
      // The CLI echoes the mode it actually adopted, which is how a mode this
      // build knows but the installed CLI does not (or the account is not
      // entitled to) degrades gracefully: we take the CLI's word for it, and the
      // claude:status below carries the real mode back to the UI so the button
      // stops claiming something that isn't in force. Worth a log line — silently
      // running in a weaker mode than the one on screen is the bad outcome here.
      //
      // Compare against the mode we actually sent, not the one we hold:
      // bypassPlan is sidecar-only and goes out as plain 'plan', so the CLI
      // echoing 'plan' is agreement, not a downgrade. Adopting it verbatim
      // demoted "Plan (auto-approve)" to "Plan mode" on the first turn, which
      // persisting the mode would now make permanent rather than merely
      // until the next restart.
      const requestedAsSdkMode = s.permissionMode === 'bypassPlan' ? 'plan' : s.permissionMode
      if (msg.permissionMode !== requestedAsSdkMode) {
        if (s.permissionMode) {
          logWarn(`claude.sendMessage(${shortSessionId(sessionId)}): requested permissionMode=${s.permissionMode} but the CLI reports ${msg.permissionMode}`)
        }
        s.permissionMode = msg.permissionMode
      }
    }
    // Persist the freshly-issued sdkSessionId so ensureSession can rebuild
    // a resumable session even after stopSession / resetSession.
    saveSessionConfig(sessionId, s)
    const meta = buildSessionMeta(s)
    if (typeof msg.cwd === 'string' && meta) meta.cwd = msg.cwd
    debugLog('emit-status', sessionId, {
      sdkSessionId: shortSessionId(s.sdkSessionId),
      model: meta?.model || null,
      cwd: meta?.cwd || null,
    })
    sendEvent('claude:status', { sessionId, meta })
    emitSupportedCommands(s, sessionId)
    return
  }
  // The CLI re-pushes the whole list when it discovers more (e.g. skills found
  // while the agent works in a subdirectory). Its contract is REPLACE, not
  // merge, so pass the payload straight through rather than re-reading.
  if (t === 'system' && msg.subtype === 'commands_changed') {
    invalidateSessionCommandCache(sessionId)
    bumpCommandsEpoch(s)
    if (Array.isArray(msg.commands) && msg.commands.length > 0) {
      debugLog('emit-commands', sessionId, { count: msg.commands.length, reason: 'changed' })
      sendEvent('claude:commands', { sessionId, commands: msg.commands })
    }
    return
  }
  if (t === 'system' && msg.subtype === 'status') {
    // Real runtime status from the SDK. We only use it to surface accurate
    // "compacting" (the token-count heuristic produced false positives near
    // the auto-compact threshold). 'requesting'/null are left to
    // markRuntimeResponded so we don't re-show the banner mid-turn.
    if (!msg.parent_tool_use_id && s.streaming && msg.status === 'compacting') {
      setRuntimeStatus(s, sessionId, 'compacting', 'Compacting context; still waiting for Claude API response.')
    }
    if (msg.compact_result === 'failed') {
      logWarn(`claude.compact(${shortSessionId(sessionId)}): compaction failed${msg.compact_error ? `: ${msg.compact_error}` : ''}`)
    }
    return
  }
  if (t === 'system' && msg.subtype === 'compact_boundary') {
    const cm = msg.compact_metadata || {}
    logInfo(`claude.compact(${shortSessionId(sessionId)}): boundary trigger=${cm.trigger || 'unknown'} preTokens=${cm.pre_tokens ?? '?'} postTokens=${cm.post_tokens ?? '?'} durationMs=${cm.duration_ms ?? '?'}`)
    // Compaction is the only place its own duration is ever reported, and it
    // used to end here. Emit it as a sample so the cost of compaction can be
    // read separately from the cost of an API call.
    emitLatencySample(compactLatencySample(sessionId, s, cm))
    return
  }
  if (t === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_updated')) {
    handleTaskMessage(s, sessionId, msg)
    return
  }
  if (t === 'rate_limit_event') {
    const info = msg.rate_limit_info
    if (info && typeof info.rateLimitType === 'string' && typeof info.resetsAt === 'number') {
      sendEvent('claude:rate-limit', {
        sessionId,
        info: {
          rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt * 1000,
          utilization: typeof info.utilization === 'number' ? info.utilization : null,
          isUsingOverage: info.isUsingOverage ?? false,
        },
      })
      debugLog('emit-rate-limit', sessionId, {
        rateLimitType: info.rateLimitType,
        resetsAt: info.resetsAt,
      })
    }
    return
  }
  if (t === 'stream_event') {
    const ev = msg.event
    // Record usage before markRuntimeResponded so the status event it emits
    // already carries this request's context footprint.
    if (ev && (ev.type === 'message_start' || ev.type === 'message_delta')) {
      noteRequestUsage(s, ev.usage || ev.message?.usage, {
        parentToolUseId: msg.parent_tool_use_id,
        isNewRequest: ev.type === 'message_start',
      })
    }
    // The same two frames bound one API request. Unlike noteRequestUsage above,
    // subagent traffic is kept rather than dropped — it is a real request, and
    // requestLatencySample flags it so it can be filtered out downstream.
    if (ev && ev.type === 'message_start') {
      openPendingRequest(s, ev, msg.parent_tool_use_id)
    } else if (ev && ev.type === 'message_delta') {
      closePendingRequest(s, sessionId, ev, msg.parent_tool_use_id)
    }
    markRuntimeResponded(s, sessionId)
    if (ev && ev.type === 'content_block_delta') {
      if (ev.delta?.text || ev.delta?.thinking) {
        notePendingFirstToken(s, msg.parent_tool_use_id)
      }
      const d = ev.delta
      if (d?.text) {
        const data = { text: d.text, parentToolUseId: msg.parent_tool_use_id ?? null }
        appendSessionStream(s, data)
        debugLog('emit-stream', sessionId, {
          kind: 'text',
          len: d.text.length,
          parentToolUseId: msg.parent_tool_use_id ?? null,
        })
        sendEvent('claude:stream', { sessionId, data })
      }
      if (d?.thinking) {
        const data = { thinking: d.thinking, parentToolUseId: msg.parent_tool_use_id ?? null }
        appendSessionStream(s, data)
        debugLog('emit-stream', sessionId, {
          kind: 'thinking',
          len: d.thinking.length,
          parentToolUseId: msg.parent_tool_use_id ?? null,
        })
        sendEvent('claude:stream', { sessionId, data })
      }
    }
    return
  }
  if (t === 'assistant') {
    // The assistant frame carries the completed request's usage. Streaming
    // builds already recorded it from message_start; capture it here too so
    // ctx% still tracks the context window when partial messages are off.
    noteRequestUsage(s, msg.message?.usage, {
      parentToolUseId: msg.parent_tool_use_id,
      isNewRequest: true,
    })
    markRuntimeResponded(s, sessionId)
    // Flatten SDK content blocks so the renderer's ClaudeMessage shape
    // (flat `thinking` field) is populated even when streaming partials
    // were not observed (e.g. SDK builds without includePartialMessages,
    // models without adaptive thinking, history reload paths). Mirrors
    // claude-history.mjs' textFromContent / thinking extraction.
    const blocks = msg.message?.content
    let flatThinking = ''
    if (Array.isArray(blocks)) {
      flatThinking = blocks
        .filter(b => b && b.type === 'thinking' && typeof b.thinking === 'string')
        .map(b => b.thinking)
        .join('\n')
        .trim()
    }
    const text = textFromContent(blocks)
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
      .replace(/Full transcript available at:.*$/gm, '')
      .trim()
    let outboundMessage = null
    if (text || flatThinking) {
      outboundMessage = {
        id: `assistant-${Date.now()}-${s.messages?.length || 0}`,
        sessionId,
        role: 'assistant',
        content: text || '',
        ...(flatThinking ? { thinking: flatThinking } : {}),
        ...(msg.parent_tool_use_id ? { parentToolUseId: msg.parent_tool_use_id } : {}),
        timestamp: Date.now(),
      }
      appendSessionMessage(s, outboundMessage)
      clearSessionStream(s)
    }
    debugLog('emit-assistant-message', sessionId, {
      blockTypes: Array.isArray(blocks) ? blocks.map(b => b?.type).filter(Boolean) : [],
      textLen: contentLength(blocks),
    })
    if (outboundMessage) {
      sendEvent('claude:message', { sessionId, message: outboundMessage })
    }
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') {
          debugLog('emit-tool-use', sessionId, {
            id: block.id,
            toolName: block.name,
            ...summarizeToolInput(block.input),
          })
          const toolCall = {
            id: block.id,
            sessionId,
            toolName: block.name,
            input: block.input || {},
            status: 'running',
            parentToolUseId: msg.parent_tool_use_id ?? null,
            timestamp: Date.now(),
          }
          appendSessionMessage(s, toolCall)
          sendEvent('claude:tool-use', {
            sessionId,
            toolCall,
          })
        }
      }
    }
    return
  }
  if (t === 'user') {
    markRuntimeResponded(s, sessionId)
    const blocks = msg.message?.content
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          debugLog('emit-tool-result', sessionId, {
            id: block.tool_use_id,
            status: block.is_error ? 'error' : 'completed',
            contentLen: contentLength(block.content),
          })
          updateSessionToolResult(s, block.tool_use_id, {
            status: block.is_error ? 'error' : 'completed',
            result: block.content,
          })
          sendEvent('claude:tool-result', {
            sessionId,
            result: {
              id: block.tool_use_id,
              status: block.is_error ? 'error' : 'completed',
              result: block.content,
            },
          })
        }
      }
    }
    return
  }
  if (t === 'result') {
    if (msg.usage) {
      // SDKResultMessage.usage sums every API request of the query (each turn,
      // each tool round-trip), so it is lifetime usage — not the context
      // window. Writing it to lastUsage is what made the status line read
      // "2,334,145 tok / ctx 778%" for a session sitting at ~77K of context.
      const u = msg.usage
      const inputTotal = (u.input_tokens || 0)
        + (u.cache_creation_input_tokens || 0)
        + (u.cache_read_input_tokens || 0)
      s.totalUsage = {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        totalTokens: inputTotal,
        model: s.model || s.totalUsage?.model || null,
        totalCostUsd: msg.total_cost_usd ?? s.totalUsage?.totalCostUsd ?? 0,
        numTurns: msg.num_turns ?? s.totalUsage?.numTurns ?? 0,
      }
    }
    // Before the branches below, so an interrupted or failed turn is recorded
    // too — a turn that errored still consumed real API time, and excluding
    // those would quietly bias the numbers towards the happy path.
    s.lastTurnApiMs = typeof msg.duration_api_ms === 'number' ? msg.duration_api_ms : null
    s.lastTurnTtftMs = typeof msg.ttft_ms === 'number' ? msg.ttft_ms : null
    emitLatencySample(turnLatencySample(sessionId, s, msg))
    // After the turn record — it reports what this turn observed — and before
    // anything below can return early on an interrupt or error, so the next
    // turn cannot inherit these counts.
    resetTurnRequestTracking(s)
    if (s.interruptRequested) {
      // Turn-only interrupt (1× Esc): the SDK ended this turn but the
      // subprocess + any background workflow stay alive. Report it as an
      // 'interrupted' turn-end (not 'error') so the renderer keeps the
      // session and does not mark running tools as failed.
      clearSessionStream(s)
      sendEvent('claude:result', { sessionId, result: msg })
      debugLog('emit-turn-end', sessionId, { reason: 'interrupted' })
      sendEvent('claude:turn-end', { sessionId, payload: { reason: 'interrupted', sdkSessionId: msg.session_id } })
      return
    }
    if (msg.subtype === 'success') {
      clearSessionStream(s)
      if (typeof msg.result === 'string' && msg.result.trim()) {
        const recentAssistant = [...(s.messages || [])].reverse().find(item =>
          item && typeof item === 'object' && item.role === 'assistant'
        )
        if (
          !recentAssistant ||
          (recentAssistant.content !== msg.result &&
            !recentAssistant.content?.includes?.(msg.result) &&
            !msg.result.includes(recentAssistant.content || ''))
        ) {
          appendSessionMessage(s, {
            id: `result-${Date.now()}`,
            sessionId,
            role: 'assistant',
            content: msg.result,
            timestamp: Date.now(),
          })
        }
      }
      debugLog('emit-result', sessionId, {
        subtype: msg.subtype,
        stopReason: msg.stop_reason || null,
        resultLen: typeof msg.result === 'string' ? msg.result.length : 0,
      })
      sendEvent('claude:result', { sessionId, result: msg })
      // A turn cannot complete while foreground tasks still run, but the
      // SDK's terminal task_updated is best-effort and often missing (e.g.
      // shell-tool tasks) — drop the ghosts so they don't tick forever.
      // Background tasks legitimately outlive the turn and stay tracked.
      if (s.activeTasks) {
        for (const [taskId, task] of s.activeTasks) {
          if (task.isBackground !== true) s.activeTasks.delete(taskId)
        }
      }
      debugLog('emit-turn-end', sessionId, { reason: 'completed' })
      sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed', result: msg.result, sdkSessionId: msg.session_id } })
    } else {
      clearSessionStream(s)
      const errMsg = resultErrorMessage(msg)
      if (batDebugEnabled()) {
        logWarn(`claude.result(${shortSessionId(sessionId)}): non-success subtype=${msg?.subtype || 'unknown'} keys=${Object.keys(msg || {}).join(',')}`)
      }
      debugLog('emit-error', sessionId, {
        subtype: msg?.subtype || 'unknown',
        stopReason: msg?.stop_reason || null,
        error: errMsg,
      })
      sendEvent('claude:error', { sessionId, error: errMsg })
      debugLog('emit-turn-end', sessionId, { reason: 'error' })
      sendEvent('claude:turn-end', { sessionId, payload: { reason: 'error' } })
    }
  }
}

// handleTaskMessage: surface background task / dynamic-workflow lifecycle.
// The SDK emits these as `system` messages with subtype 'task_started' /
// 'task_updated'. They are best-effort (the SDK does not guarantee them),
// but when present they let the renderer show that a workflow / subagent is
// running — which matters for the interrupt UX (a turn-only interrupt keeps
// these alive; only a hard stop kills them). We mirror them into
// s.activeTasks and forward a normalized `claude:task` event.
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed'])

function handleTaskMessage(s, sessionId, msg) {
  if (!s.activeTasks) s.activeTasks = new Map()
  const taskId = typeof msg.task_id === 'string' ? msg.task_id : null
  if (!taskId) return
  let task
  if (msg.subtype === 'task_started') {
    const taskType = typeof msg.task_type === 'string' ? msg.task_type : null
    task = {
      id: taskId,
      // Bind the task to the Agent/Task tool_use that spawned it. The
      // renderer needs this to merge the lifecycle entry into the tool node
      // (task_id and tool_use id live in different namespaces).
      toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : null,
      type: taskType,
      isWorkflow: taskType === 'local_workflow' || taskType === 'workflow',
      workflowName: typeof msg.workflow_name === 'string' ? msg.workflow_name : null,
      subagentType: typeof msg.subagent_type === 'string' ? msg.subagent_type : null,
      description: typeof msg.description === 'string' ? msg.description : '',
      status: 'running',
      startedAt: Date.now(),
    }
    if (msg.skip_transcript === true) task.skipTranscript = true
    s.activeTasks.set(taskId, task)
  } else {
    // task_updated: merge the wire-safe patch into the tracked task.
    const prev = s.activeTasks.get(taskId)
    const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {}
    task = {
      id: taskId,
      toolUseId: prev?.toolUseId ?? null,
      type: prev?.type ?? null,
      isWorkflow: prev?.isWorkflow ?? false,
      workflowName: prev?.workflowName ?? null,
      subagentType: prev?.subagentType ?? null,
      description: typeof patch.description === 'string' ? patch.description : (prev?.description ?? ''),
      status: typeof patch.status === 'string' ? patch.status : (prev?.status ?? 'running'),
      startedAt: prev?.startedAt ?? Date.now(),
      ...(typeof patch.error === 'string' ? { error: patch.error } : {}),
      ...(patch.is_backgrounded === true || prev?.isBackground === true ? { isBackground: true } : {}),
      // skip_transcript only ever arrives on task_started, so it has to be
      // carried forward here or it silently disappears on the first update —
      // the renderer treats it as "not an agent" and would start trusting a
      // task that lost the flag (GH #127).
      ...(msg.skip_transcript === true || prev?.skipTranscript === true ? { skipTranscript: true } : {}),
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      s.activeTasks.delete(taskId)
    } else {
      s.activeTasks.set(taskId, task)
    }
  }
  debugLog('emit-task', sessionId, { id: taskId, subtype: msg.subtype, status: task.status, isWorkflow: task.isWorkflow, toolUseId: task.toolUseId })
  sendEvent('claude:task', { sessionId, task })
}

async function buildQueryOptions(s, sessionId, prompt) {
  const cwd = sessionCwd(s)
  if (!cwd) {
    throw new Error(missingSessionCwdError(sessionId))
  }
  // Only meaningful for a real spawn; a test-injected SDK never spawns.
  if (!hasSdkOverrideForTests() && !isExistingDirectory(cwd)) {
    logWarn(sessionCwdMissingOnHostError(sessionId, cwd))
    throw new Error(sessionCwdMissingOnHostError(sessionId, cwd))
  }
  const sdkMode = s.permissionMode === 'bypassPlan' ? 'plan' : s.permissionMode
  const sdkModel = sdkModelForClaudeSelection(s.model)
  // Display == actual: a session record can lose its window (older renderer
  // resume paths didn't carry it), but the selected preset id still encodes
  // it — re-derive at send time so the spawned CLI always matches the UI.
  if (s.autoCompactWindow === null || s.autoCompactWindow === undefined) {
    const derived = autoCompactWindowForClaudeSelection(s.model)
    if (typeof derived === 'number') {
      s.autoCompactWindow = derived
      logInfo(`claude.sendMessage(${shortSessionId(sessionId)}): recovered autoCompactWindow=${derived} from model=${s.model}`)
    }
  }
  const claudeCodePath = await resolveClaudeCliBinaryWithInstall()
  const queryOptions = {
    cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    includePartialMessages: true,
    promptSuggestions: true,
    settingSources: ['user', 'project', 'local'],
    agentProgressSummaries: true,
    toolConfig: { askUserQuestion: { previewFormat: 'html' } },
    // Adaptive thinking: let supported models surface reasoning blocks.
    // SDK's default already enables this for Opus 4.6+, but stating it
    // explicitly makes the contract clear and covers builds where the
    // default is off.
    thinking: { type: 'adaptive' },
  }
  if (sdkMode && sdkMode !== 'default') queryOptions.permissionMode = sdkMode
  if (s.permissionMode === 'bypassPermissions') queryOptions.allowDangerouslySkipPermissions = true
  const runtimeEffort = runtimeEffortForMode(s.effort)
  if (runtimeEffort) queryOptions.effort = runtimeEffort
  if (isUltracodeMode(s.effort) || s.ultracode === true) {
    queryOptions.settings = { ultracode: true, enableWorkflows: true }
  }
  if (sdkModel) queryOptions.model = sdkModel
  if (claudeCodePath) queryOptions.pathToClaudeCodeExecutable = claudeCodePath
  // Capture the claude subprocess stderr so an opaque non-zero exit can be
  // explained with the message claude actually printed (see appendClaudeStderr).
  queryOptions.stderr = (chunk) => {
    try { appendClaudeStderr(s, chunk) } catch { /* ignore */ }
  }
  const installedPlugins = await loadInstalledPlugins()
  if (installedPlugins.length > 0) queryOptions.plugins = installedPlugins
  queryOptions.canUseTool = (toolName, input, opts) => buildCanUseTool(s, sessionId, toolName, input, opts)
  if (s.autoCompactWindow) {
    queryOptions.env = { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(s.autoCompactWindow) }
  }
  if (s.sdkSessionId) {
    queryOptions.resume = s.sdkSessionId
    if (typeof prompt === 'string' && (!prompt || prompt.trim() === '' || prompt.trim() === ' ')) {
      queryOptions.continue = true
    }
  }
  return queryOptions
}

// buildUserMessage: shape an SDKUserMessage from the prompt + optional
// image attachments (data URLs). Mirrors the pre-LiveQuery promptArg
// generator: a single content block array carrying images then text.
function buildUserMessage(prompt, images) {
  const text = prompt || ' '
  const imageList = Array.isArray(images) ? images : null
  if (imageList && imageList.length > 0) {
    const imageBlocks = imageList.map(dataUrlToContentBlock).filter(Boolean)
    if (imageBlocks.length > 0) {
      const contentBlocks = [
        ...imageBlocks,
        ...(prompt ? [{ type: 'text', text: prompt }] : []),
      ]
      return { type: 'user', message: { role: 'user', content: contentBlocks } }
    }
  }
  return { type: 'user', message: { role: 'user', content: text } }
}

async function ensureLiveQuery(s, sessionId, sdk, prompt) {
  if (s.liveQuery && !s.liveQuery.isClosed) return s.liveQuery
  const queryOptions = await buildQueryOptions(s, sessionId, prompt)
  s.abortController = new AbortController()
  queryOptions.abortController = s.abortController
  debugLog('live-query-create', sessionId, {
    cwd: queryOptions.cwd || null,
    resume: typeof queryOptions.resume === 'string' ? shortSessionId(queryOptions.resume) : null,
    continue: queryOptions.continue === true,
    model: queryOptions.model || null,
    permissionMode: queryOptions.permissionMode || 'default',
    effort: queryOptions.effort || null,
    effortMode: s.effort || null,
    ultracode: queryOptions.settings?.ultracode === true,
    enableWorkflows: queryOptions.settings?.enableWorkflows === true,
    hasClaudePath: typeof queryOptions.pathToClaudeCodeExecutable === 'string',
    pluginCount: Array.isArray(queryOptions.plugins) ? queryOptions.plugins.length : 0,
  })
  const live = new LiveQuery({
    sdk,
    queryOptions,
    onMessage: (msg) => {
      try {
        debugSdkFrame(sessionId, msg)
        processMessage(s, sessionId, msg)
      }
      catch (err) {
        logWarn(`processMessage threw for ${sessionId}: ${err?.message || err}`)
      }
    },
    onError: (err) => {
      logWarn(`LiveQuery stream error for ${sessionId}: ${err?.message || err}`)
    },
  })
  s.liveQuery = live
  s.currentQuery = live.generator
  debugLog('live-query-ready', sessionId, {})
  return live
}

// closeLiveQuery: shared cleanup used by the lifecycle handlers in
// claude-session.mjs (abort / reset / stop / rest / resume) and also
// invoked locally when a control method fails. Idempotent.
//
// abortController is intentionally NOT cleared — sendMessage's catch
// reads s.abortController?.signal.aborted to distinguish 'aborted' vs
// 'error' turn-end reasons after a push() rejects. ensureLiveQuery
// installs a fresh AbortController on the next rebuild.
export function closeLiveQuery(s) {
  if (!s) return
  if (s.liveQuery) {
    try { s.liveQuery.close() } catch { /* ignore */ }
  }
  s.liveQuery = null
  s.currentQuery = null
  s.interruptRequested = false
  // The subprocess is gone, so any background workflows / subagents it was
  // running are gone too. Drop the tracked tasks; the renderer clears its
  // mirror on the 'aborted' / 'error' turn-end that accompanies this.
  if (s.activeTasks) s.activeTasks.clear()
}

// `onAccepted` is called once the prompt has been handed to the SDK, which is
// what answers the sendMessage RPC. Everything after that point — success,
// error, interrupt — reaches the renderer as claude:* events instead.
async function performSendMessage(params, onAccepted) {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.sendMessage: missing sessionId')
  }
  if (isCodexSession(sessionId)) {
    return sendCodexMessage(params)
  }
  const prompt = typeof params?.prompt === 'string' ? params.prompt : ''
  const images = Array.isArray(params?.images) ? params.images : null
  const s = ensureSession(sessionId)
  if (isCodexAgentPreset(s.agentPreset)) {
    throw new Error(`claude.sendMessage(${shortSessionId(sessionId)}): codex session not initialized; restart the Codex agent`)
  }
  const sid = shortSessionId(sessionId)
  if (s.isResting) s.isResting = false
  setRuntimeStatus(s, sessionId, 'starting', 'Preparing Claude request.')

  const sdk = await loadAnthropicSdk()
  if (!sdk || typeof sdk.query !== 'function') {
    logWarn(`claude.sendMessage: SDK unavailable, returning stub for session ${sessionId}`)
    clearRuntimeStatus(s, sessionId)
    const message = {
      id: `stub-${Date.now()}`,
      sessionId,
      role: 'assistant',
      content: '(stub reply — SDK unavailable)',
      timestamp: Date.now(),
    }
    appendSessionMessage(s, message)
    sendEvent('claude:message', { sessionId, message })
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed', result: '(stub)' } })
    return { ok: true, stub: true }
  }

  const userMessage = buildUserMessage(prompt, images)
  let live
  try {
    live = await ensureLiveQuery(s, sessionId, sdk, prompt)
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err)
    const errMsg = downgradeEffortOnRejection(s, sessionId, enrichExitErrorMessage(rawMsg, s))
    logWarn(`claude.sendMessage(${sid}): ensureLiveQuery failed: ${errMsg}`)
    clearRuntimeStatus(s, sessionId)
    clearSessionStream(s)
    sendEvent('claude:error', { sessionId, error: errMsg })
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'error' } })
    return { ok: false, error: errMsg }
  }

  const startedAt = Date.now()
  s.streaming = true
  // Start as a generic "waiting for API"; the SDK upgrades this to
  // 'compacting' via a system/status frame only when it actually compacts.
  setRuntimeStatus(s, sessionId, 'waiting_for_api', 'Still waiting for Claude API response.')
  logInfo(`claude.sendMessage(${sid}): start promptLen=${prompt.length} images=${Array.isArray(params?.images) ? params.images.length : 0} liveClosed=${live.isClosed}`)
  debugLog('push-user-message', sessionId, {
    promptLen: prompt.length,
    promptPreview: preview(prompt),
    images: Array.isArray(params?.images) ? params.images.length : 0,
    liveClosed: live.isClosed,
  })
  // Fresh stderr tail per turn so an error is explained by THIS turn's output.
  s.claudeStderrTail = ''
  try {
    // Acknowledge the request here, not after the turn. LiveQuery.push()
    // enqueues synchronously — it appends to the prompt iterable and wakes it
    // before returning — so once it has returned, the host demonstrably has
    // the prompt, which is all the caller asked. Awaiting the turn first
    // conflated "received" with "finished": a turn outliving the host's 300s
    // request deadline looked like a lost send, and a remote client's message
    // stayed ghosted for the whole turn. A push into an already-closed query
    // enqueues nothing, so that one is left for the caller to see as an error.
    const pushed = live.push(userMessage)
    if (!live.isClosed) onAccepted?.()
    const result = await pushed
    // Give SDK builds that end the generator immediately after a result a
    // chance to flip LiveQuery.isClosed before the next queued send starts.
    await new Promise(resolve => setImmediate(resolve))
    const elapsedMs = Date.now() - startedAt
    if (live.isClosed && s.liveQuery === live) {
      s.liveQuery = null
      s.currentQuery = null
    }
    if (s.interruptRequested) {
      // Turn-only interrupt: processMessage already emitted the
      // 'interrupted' turn-end. The subprocess + liveQuery survive.
      s.interruptRequested = false
      clearRuntimeStatus(s, sessionId)
      logInfo(`claude.sendMessage(${sid}): interrupted (turn-only) elapsedMs=${elapsedMs}`)
      return { ok: true, interrupted: true }
    }
    if (result?.subtype === 'success') {
      debugLog('push-resolved', sessionId, {
        elapsedMs,
        subtype: result.subtype,
        stopReason: result.stop_reason || null,
      })
      logInfo(`claude.sendMessage(${sid}): completed ok elapsedMs=${elapsedMs}`)
      clearRuntimeStatus(s, sessionId)
      return { ok: true }
    }
    const errMsg = resultErrorMessage(result)
    logWarn(`claude.sendMessage(${sid}): completed error elapsedMs=${elapsedMs} error=${errMsg}`)
    clearRuntimeStatus(s, sessionId)
    return { ok: false, error: errMsg }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    if (s.interruptRequested) {
      // Turn-only interrupt surfaced as a throw (no result message): emit
      // the interrupted turn-end here. Subprocess + liveQuery stay alive.
      s.interruptRequested = false
      clearRuntimeStatus(s, sessionId)
      logInfo(`claude.sendMessage(${sid}): interrupted (turn-only, via throw)`)
      sendEvent('claude:turn-end', { sessionId, payload: { reason: 'interrupted' } })
      return { ok: true, interrupted: true }
    }
    const aborted = s.abortController?.signal.aborted
      || /aborted/i.test(errMsg)
    let enriched = errMsg
    if (!aborted) {
      enriched = downgradeEffortOnRejection(s, sessionId, enrichExitErrorMessage(errMsg, s))
      logWarn(`claude.sendMessage(${sid}): push failed: ${enriched}`)
      clearSessionStream(s)
      sendEvent('claude:error', { sessionId, error: enriched })
    } else {
      logInfo(`claude.sendMessage(${sid}): aborted`)
    }
    sendEvent('claude:turn-end', { sessionId, payload: { reason: aborted ? 'aborted' : 'error' } })
    if (live.isClosed) {
      s.liveQuery = null
      s.currentQuery = null
    }
    clearRuntimeStatus(s, sessionId)
    return { ok: !aborted, error: aborted ? undefined : enriched }
  } finally {
    s.streaming = false
  }
}

registerHandler('claude.sendMessage', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.sendMessage: missing sessionId')
  }
  const s = ensureSession(sessionId)
  // A host/runtime restart loses the in-memory session map while the renderer
  // may still cache this id as started. Do this preflight before user echo and
  // clientMessageId bookkeeping: otherwise the failed request creates a
  // phantom session whose duplicate record blocks the renderer's recovery
  // retry, and getSessionState incorrectly reports that the session exists.
  if (!isCodexSession(sessionId) && !sessionCwd(s)) {
    sessions.delete(sessionId)
    throw new Error(missingSessionCwdError(sessionId))
  }
  const sid = shortSessionId(sessionId)
  const prompt = typeof params?.prompt === 'string' ? params.prompt : ''
  const images = Array.isArray(params?.images) ? params.images : null
  debugLog('receive-send-message', sessionId, {
    promptLen: prompt.length,
    promptPreview: preview(prompt),
    images: images ? images.length : 0,
    hasClientMessageId: typeof params?.clientMessageId === 'string' && params.clientMessageId.length > 0,
    suppressUserEcho: params?.suppressUserEcho === true,
    hasExistingQueue: Boolean(s.sendQueue),
  })
  const requestId = clientMessageId(params)
  if (requestId) {
    if (!(s.clientMessageRequests instanceof Map)) s.clientMessageRequests = new Map()
    const existing = s.clientMessageRequests.get(requestId)
    if (existing) {
      logWarn(`claude.sendMessage(${sid}): duplicate clientMessageId ignored status=${existing.status}`)
      return duplicateClientMessageResult(existing)
    }
    pruneClientMessageRequests(s)
    s.clientMessageRequests.set(requestId, {
      status: 'pending',
      acceptedAt: Date.now(),
    })
  }
  if (!isCodexSession(sessionId)) {
    emitUserEcho(params, sessionId, prompt, images)
  }
  const wasQueued = Boolean(s.sendQueue)
  if (wasQueued) {
    logInfo(`claude.sendMessage(${sid}): queued behind active turn`)
  }
  // Esc (interruptTurn/abortSession) marks this token cancelled so a send
  // still waiting in line here — not yet the live turn — is skipped instead
  // of silently firing once the interrupted/aborted turn it was queued
  // behind clears. Only ever read by THIS call's own .then() below, so a
  // later sendMessage overwriting s.pendingSendCancel with its own fresh
  // token can't affect an already-queued one.
  const cancelToken = { cancelled: false }
  s.pendingSendCancel = cancelToken
  // Two settle points, deliberately: `accepted` answers the RPC as soon as the
  // prompt is in the SDK's hands, while `queued` stays the turn-long promise
  // that the next send chains behind. Splitting them fixes the acknowledgement
  // without touching the queueing — a send still waits its turn, Esc can still
  // cancel one that is only queued, and that cancellation is still reported to
  // the caller (it happens before the push, so the ack has not fired yet).
  let markAccepted
  let acked = false
  const accepted = new Promise(resolve => { markAccepted = resolve })
  const onAccepted = () => {
    acked = true
    markAccepted()
  }
  const previous = s.sendQueue || Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    if (sessions.get(sessionId) !== s) {
      return { ok: false, error: 'session stopped' }
    }
    if (cancelToken.cancelled) {
      logInfo(`claude.sendMessage(${sid}): cancelled before it became the active turn`)
      return { ok: false, cancelled: true }
    }
    return performSendMessage(params, onAccepted)
  })
  const queued = run.finally(() => {
    if (s.sendQueue === queued) s.sendQueue = null
  })
  s.sendQueue = queued
  if (requestId) {
    const record = s.clientMessageRequests.get(requestId)
    queued.then(
      result => {
        if (s.clientMessageRequests.get(requestId) !== record) return
        record.status = 'fulfilled'
        record.result = result
        record.completedAt = Date.now()
      },
      error => {
        if (s.clientMessageRequests.get(requestId) !== record) return
        record.status = 'rejected'
        record.error = error instanceof Error ? error.message : String(error)
        record.completedAt = Date.now()
      },
    )
  }
  // Once the ack has won this race nobody is left awaiting `queued`, so a
  // rejection from it would be an unhandled one — and invisible to the user.
  // performSendMessage already converts every post-push failure into
  // claude:error + claude:turn-end and returns normally, so reaching here
  // means it threw somewhere it did not expect to; report it the same way
  // rather than letting the UI stream forever.
  queued.catch(err => {
    if (!acked) return
    const errMsg = err instanceof Error ? err.message : String(err)
    logWarn(`claude.sendMessage(${sid}): failed after acknowledgement: ${errMsg}`)
    sendEvent('claude:error', { sessionId, error: errMsg })
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'error' } })
  })
  // Whichever comes first: the prompt being accepted (the normal path) or the
  // work settling without a push ever happening — a cancelled queue entry, a
  // stopped session, an SDK stub reply, or ensureLiveQuery failing. Those all
  // still resolve to their real result, which is what keeps the renderer's
  // no-cwd recovery retry working.
  return Promise.race([
    accepted.then(() => ({ ok: true, accepted: true, queued: wasQueued })),
    queued,
  ])
})

// claude.interruptTurn: soft interrupt (1× Esc). Ends the current turn via
// the SDK's turn-only interrupt() but keeps the subprocess + LiveQuery
// alive, so background dynamic workflows / subagents are NOT killed and the
// user can keep typing to continue. Contrast with claude.abortSession
// (2× Esc / hard stop), which closes the subprocess.
registerHandler('claude.interruptTurn', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.interruptTurn: missing sessionId')
  }
  // Codex sessions never reach here — the Rust router maps them to the
  // codex app-server's turn interrupt before calling the sidecar.
  const s = sessions.get(sessionId)
  // Esc always cancels whatever is still waiting in the send queue, even if
  // there's no live turn to interrupt below (it may have just finished) —
  // otherwise a message queued behind it fires right after despite the stop.
  if (s?.pendingSendCancel) s.pendingSendCancel.cancelled = true
  if (!s || !s.liveQuery || !s.streaming) {
    return { ok: false, error: 'no active turn to interrupt' }
  }
  s.interruptRequested = true
  try {
    await s.liveQuery.interrupt()
    return { ok: true }
  } catch (err) {
    s.interruptRequested = false
    const msg = err instanceof Error ? err.message : String(err)
    logWarn(`claude.interruptTurn(${shortSessionId(sessionId)}): ${msg}`)
    return { ok: false, error: msg }
  }
})

// claude.stopTask: cancel a running sub-agent / Agent tool by its
// task_id (or tool_use_id as fallback when no task mapping exists).
registerHandler('claude.stopTask', async (params) => {
  const sessionId = params?.sessionId
  const taskId = params?.taskId ?? params?.toolUseId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.stopTask: missing sessionId')
  }
  if (typeof taskId !== 'string' || !taskId) {
    throw new Error('claude.stopTask: missing taskId / toolUseId')
  }
  const s = sessions.get(sessionId)
  const query = s?.currentQuery
  if (!s || !s.streaming || !query || typeof query.stopTask !== 'function') {
    return { ok: false, error: 'no active query for session' }
  }
  // The renderer often only knows the tool_use id; the SDK's stopTask wants
  // the task_id. Map through the tracked tasks when possible, otherwise pass
  // the id through unchanged (legacy fallback).
  let targetId = taskId
  if (s.activeTasks && !s.activeTasks.has(taskId)) {
    for (const tracked of s.activeTasks.values()) {
      if (tracked.toolUseId === taskId) { targetId = tracked.id; break }
    }
  }
  try {
    await query.stopTask(targetId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})
