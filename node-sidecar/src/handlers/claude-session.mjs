// claude.* session lifecycle + setters + getters.
// startSession, resumeSession, resetSession, restSession, wakeSession,
// isResting, stopSession, abortSession, setAutoContinue, getAutoContinue,
// setPermissionMode, setModel, setEffort, getSessionState, getSessionMeta,
// getContextUsage.

import { existsSync } from 'node:fs'

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import {
  sessions,
  sessionConfigs,
  ensureSession,
  buildSessionMeta,
  saveSessionConfig,
  appendSessionMessage,
  clearSessionStream,
  resetSessionTranscript,
} from '../lib/state.mjs'
import { normalizeClaudeEffortMode, isUltracodeMode } from '../lib/claude-effort.mjs'
import { autoCompactWindowForClaudeSelection, expectedContextWindowForModel, sdkModelForClaudeSelection } from '../lib/models.mjs'
import { closeLiveQuery } from './claude-send.mjs'

function applyEffortOptions(session, options) {
  const mode = normalizeClaudeEffortMode(options?.effort, options?.ultracode === true)
  if (mode) {
    session.effort = mode
    session.ultracode = isUltracodeMode(mode)
  }
}
import { loadSessionHistory } from './claude-history.mjs'
import { warn as logWarn, info as logInfo } from '../lib/logger.mjs'
import { worktreeRehydrate } from './worktree.mjs'
import {
  abortCodexSession,
  getCodexSessionMeta,
  getCodexSessionState,
  isCodexAgentPreset,
  isCodexResting,
  isCodexSession,
  resetCodexSession,
  restCodexSession,
  resumeCodexSession,
  setCodexApprovalPolicy,
  setCodexEffort,
  setCodexModel,
  setCodexSandboxMode,
  startCodexSession,
  stopCodexSession,
  wakeCodexSession,
} from './codex.mjs'

function applyWorktreeOptions(sessionId, session) {
  const options = session?.options
  if (!options || typeof options !== 'object') return
  if (options.useWorktree !== true) return
  if (typeof options.cwd !== 'string' || !options.cwd) return
  if (typeof options.worktreePath !== 'string' || !options.worktreePath) return
  if (!existsSync(options.worktreePath)) {
    // Refuse to fall back to the original cwd: a worktree session that
    // silently runs in the main checkout writes to the wrong branch. This
    // path used to be hit by remote clients that created the worktree on
    // their own machine — fail loudly so the renderer surfaces it instead.
    throw new Error(
      `worktree session ${sessionId}: worktree folder not found on this machine: ${options.worktreePath}`
    )
  }
  const branchName = typeof options.worktreeBranch === 'string' && options.worktreeBranch
    ? options.worktreeBranch
    : `bat/worktree-${sessionId.slice(0, 8)}`
  const info = worktreeRehydrate(sessionId, options.cwd, options.worktreePath, branchName)
  session.options = {
    ...options,
    originalCwd: options.cwd,
    cwd: options.worktreePath,
    worktreeBranch: info.branchName,
  }
  sendEvent('claude:worktree-info', {
    sessionId,
    payload: {
      branchName: info.branchName,
      worktreePath: info.worktreePath,
      sourceBranch: info.sourceBranch,
      gitRoot: info.gitRoot,
    },
  })
}

registerHandler('claude.startSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.startSession: missing sessionId')
  }
  if (isCodexAgentPreset(params?.options?.agentPreset)) {
    const s = ensureSession(sessionId)
    s.agentPreset = params.options.agentPreset
    return startCodexSession(params)
  }
  const optionsCwd = params?.options?.cwd
  if (typeof optionsCwd !== 'string' || !optionsCwd) {
    throw new Error('claude.startSession: missing cwd')
  }
  const s = ensureSession(sessionId)
  s.agentPreset = params?.options?.agentPreset ?? null
  s.active = true
  s.options = params?.options ?? null
  if (!s.sdkSessionId && !params?.options?.sdkSessionId) resetSessionTranscript(s)
  // Some options carry per-session config the renderer expects to read
  // back via getSessionMeta — capture them now.
  if (s.options && typeof s.options === 'object') {
    if (typeof s.options.model === 'string') s.model = s.options.model
    if (typeof s.options.permissionMode === 'string') s.permissionMode = s.options.permissionMode
    applyEffortOptions(s, s.options)
    if (typeof s.options.autoCompactWindow === 'number' || s.options.autoCompactWindow === null) {
      s.autoCompactWindow = s.options.autoCompactWindow
    } else if (typeof s.options.model === 'string') {
      // Renderer restarts resume without re-sending the numeric window (it
      // was only pushed on model selection), so derive it from the preset id
      // — otherwise the cap silently drops to the CLI default (full model
      // window) after every app restart.
      const derived = autoCompactWindowForClaudeSelection(s.options.model)
      if (derived !== undefined) s.autoCompactWindow = derived
    }
    if (typeof s.options.codexSandboxMode === 'string') s.codexSandboxMode = s.options.codexSandboxMode
    if (typeof s.options.codexApprovalPolicy === 'string') s.codexApprovalPolicy = s.options.codexApprovalPolicy
    // startSession can also pre-populate sdkSessionId for the resume
    // path. The renderer's reload-from-history flow goes through
    // claude.resumeSession (below), but the underlying mechanism is
    // identical: stash the SDK id so the next sendMessage uses
    // `resume: <id>` and the SDK reconstructs the conversation.
    if (typeof s.options.sdkSessionId === 'string') s.sdkSessionId = s.options.sdkSessionId
    applyWorktreeOptions(sessionId, s)
  }
  if (s.sdkSessionId) {
    await loadSessionHistory(sessionId, s.sdkSessionId, optionsCwd)
  }
  saveSessionConfig(sessionId, s)
  return { ok: true, sessionId }
})

// claude.resumeSession: rewire a session to an existing SDK session id.
// Mirror of electron/claude-agent-manager.ts:2461. Aborts any in-flight
// query, swaps the session record, and pre-populates sdkSessionId so
// the next sendMessage passes `resume: <id>` — the SDK then rehydrates
// the conversation from its own session store. We default the
// permissionMode to 'bypassPermissions' to match Electron's resume
// contract (resumed sessions don't re-prompt for prior approvals).
async function resumeClaudeSession(params, opts = {}) {
  const sessionId = params?.sessionId
  const sdkSessionIdToResume = params?.sdkSessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.resumeSession: missing sessionId')
  }
  if (typeof sdkSessionIdToResume !== 'string' || !sdkSessionIdToResume) {
    throw new Error('claude.resumeSession: missing sdkSessionId')
  }
  if (isCodexAgentPreset(params?.options?.agentPreset) || isCodexSession(sessionId)) {
    const marker = ensureSession(sessionId)
    if (isCodexAgentPreset(params?.options?.agentPreset)) {
      marker.agentPreset = params.options.agentPreset
    }
    return resumeCodexSession(params)
  }
  const existing = sessions.get(sessionId)
  // Remote clients call resumeSession when (re)opening a session view, so a
  // resume that targets the sdkSessionId the session is already attached to
  // must be read-only while a turn is in flight — the teardown below would
  // abort the running turn just because someone looked at the session.
  const alreadyLive = !!existing
    && existing.sdkSessionId === sdkSessionIdToResume
    && (existing.streaming === true || (existing.liveQuery && !existing.liveQuery.isClosed))
  if (alreadyLive) {
    logInfo(`claude.resumeSession(${sessionId}): already attached to live sdkSessionId=${sdkSessionIdToResume}; skipping rebuild`)
    return { ok: true, sessionId, sdkSessionId: sdkSessionIdToResume, alreadyLive: true }
  }
  if (existing?.abortController) {
    try { existing.abortController.abort() } catch { /* already aborted */ }
  }
  // Tear down any persistent SDK subprocess before swapping the record.
  // The new session's first sendMessage will rebuild a LiveQuery with
  // the freshly stashed sdkSessionId so the SDK rehydrates context.
  closeLiveQuery(existing)
  // Drop the prior record (if any) and rebuild from the resume options.
  sessions.delete(sessionId)
  const s = ensureSession(sessionId)
  s.active = true
  s.options = params?.options ?? null
  s.agentPreset = params?.options?.agentPreset ?? null
  // Prefer the mode this session was last in. ensureSession already rehydrates
  // it from sessionConfigs, but its cold-start baseline is 'default', so "was
  // anything actually remembered?" has to be asked of sessionConfigs rather than
  // of the record we just built. Overwriting unconditionally is what made every
  // resume forget the mode the user had chosen — a session parked in `plan` came
  // back able to write (GH #124). With nothing remembered the historical
  // bypassPermissions default still applies.
  const rememberedMode = sessionConfigs.get(sessionId)?.permissionMode
  s.permissionMode = (typeof rememberedMode === 'string' && rememberedMode) ? rememberedMode : 'bypassPermissions'
  if (s.options && typeof s.options === 'object') {
    if (typeof s.options.cwd === 'string') {
      // Keep cwd in options so sendMessage's queryOptions picks it up.
    }
    if (typeof s.options.model === 'string') s.model = s.options.model
    if (typeof s.options.permissionMode === 'string') s.permissionMode = s.options.permissionMode
    applyEffortOptions(s, s.options)
    if (typeof s.options.autoCompactWindow === 'number' || s.options.autoCompactWindow === null) {
      s.autoCompactWindow = s.options.autoCompactWindow
    } else if (typeof s.options.model === 'string') {
      // Renderer restarts resume without re-sending the numeric window (it
      // was only pushed on model selection), so derive it from the preset id
      // — otherwise the cap silently drops to the CLI default (full model
      // window) after every app restart.
      const derived = autoCompactWindowForClaudeSelection(s.options.model)
      if (derived !== undefined) s.autoCompactWindow = derived
    }
    if (typeof s.options.codexSandboxMode === 'string') s.codexSandboxMode = s.options.codexSandboxMode
    if (typeof s.options.codexApprovalPolicy === 'string') s.codexApprovalPolicy = s.options.codexApprovalPolicy
    applyWorktreeOptions(sessionId, s)
  }
  const historyCwd = (s.options && typeof s.options === 'object' && typeof s.options.cwd === 'string')
    ? s.options.cwd
    : process.cwd()
  const history = await loadSessionHistory(sessionId, sdkSessionIdToResume, historyCwd, {
    allowGlobalFallback: opts.allowGlobalHistoryFallback === true,
  })
  if (!history.found) {
    logWarn(`claude.resumeSession: stale sdkSessionId=${sdkSessionIdToResume} for cwd=${historyCwd}; starting fresh session`)
    return { ok: true, sessionId, stale: true, requestedSdkSessionId: sdkSessionIdToResume }
  }
  s.sdkSessionId = sdkSessionIdToResume
  saveSessionConfig(sessionId, s)
  return { ok: true, sessionId, sdkSessionId: sdkSessionIdToResume }
}

registerHandler('claude.resumeSession', resumeClaudeSession)

// claude.clientResume: a remote client (re)opening a session view wants the
// transcript back, but must NOT disturb a session the host may have live.
// Unlike resumeSession (which tears down + rebuilds the SDK session), this is
// non-destructive when the session already exists here: it re-emits the
// persisted history read-only (no teardown, no SDK restart). When the session
// is absent, it falls back to a normal resume so the transcript still loads.
// Either way it (re)emits `claude:history`, so the client never goes blank.
registerHandler('claude.clientResume', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.clientResume: missing sessionId')
  }
  const existing = sessions.get(sessionId)
  const requestedSdkSessionId = typeof params?.sdkSessionId === 'string' ? params.sdkSessionId : ''
  // A reconnecting client may not have persisted the SDK id that the live host
  // already knows. Prefer the host-owned id and accept the requested id only as
  // a fallback for an absent/rebuilt session.
  const sdkSessionId = typeof existing?.sdkSessionId === 'string' && existing.sdkSessionId
    ? existing.sdkSessionId
    : requestedSdkSessionId
  if (typeof sdkSessionId !== 'string' || !sdkSessionId) {
    throw new Error('claude.clientResume: missing sdkSessionId')
  }
  // Codex history is owned by the Tauri codex app-server runtime, not the
  // sidecar — defer to the normal codex resume which already returns history.
  if (isCodexAgentPreset(params?.options?.agentPreset) || isCodexSession(sessionId)) {
    return resumeClaudeSession({ ...params, sdkSessionId })
  }
  if (existing) {
    const optCwd = params?.options && typeof params.options.cwd === 'string' ? params.options.cwd : ''
    // The live host session owns its actual cwd/worktree. Client workspace data
    // can be stale, so only use it when the host has no cwd of its own.
    const cwd = (existing.options && typeof existing.options.cwd === 'string' ? existing.options.cwd : '')
      || optCwd
      || process.cwd()
    const live = existing.streaming === true
      || (existing.liveQuery && existing.liveQuery.isClosed === false)
    const history = await loadSessionHistory(sessionId, sdkSessionId, cwd, {
      // sdkSessionId is an exact transcript identity. Falling back across
      // ~/.claude/projects recovers moved worktrees/stale cwd without guessing.
      allowGlobalFallback: true,
      preserveLiveMessages: live,
    })
    return { ok: true, sessionId, sdkSessionId, existed: true, alreadyLive: !!live, found: history.found }
  }
  // The sidecar may have restarted while the host/client retained the session
  // metadata. Permit exact-id global lookup on this read/reattach path; normal
  // resumeSession keeps its stricter cwd validation.
  return resumeClaudeSession(
    { ...params, sdkSessionId },
    { allowGlobalHistoryFallback: true },
  )
})

// claude.restSession / wakeSession / isResting: mirror the resting-UX
// flag from electron/claude-agent-manager.ts:2481+. The renderer flips
// a session into "resting" when the user wants to pause it without
// destroying the SDK session id — abort any in-flight query, clear the
// streaming guard, and emit a single system-message hint so the panel
// shows "tap to wake". Wake clears the flag; the next sendMessage also
// clears it (see claude.sendMessage below).
registerHandler('claude.restSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (isCodexSession(sessionId)) return restCodexSession(params)
  const session = sessions.get(sessionId)
  if (!session) return false
  if (session.abortController) {
    try { session.abortController.abort() } catch { /* already aborted */ }
  }
  // Resting kills the persistent SDK subprocess so the user pays no
  // CPU/tokens while paused. wake / next sendMessage will rebuild.
  closeLiveQuery(session)
  session.streaming = false
  clearSessionStream(session)
  session.isResting = true
  const message = {
    id: `sys-rest-${Date.now()}`,
    sessionId,
    role: 'system',
    content: 'Session is resting. Send a message to wake it up.',
    timestamp: Date.now(),
  }
  appendSessionMessage(session, message)
  sendEvent('claude:message', {
    sessionId,
    message,
  })
  return true
})
registerHandler('claude.wakeSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (isCodexSession(sessionId)) return wakeCodexSession(params)
  const session = sessions.get(sessionId)
  if (!session) return false
  session.isResting = false
  return true
})
registerHandler('claude.isResting', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (isCodexSession(sessionId)) return isCodexResting(params)
  const session = sessions.get(sessionId)
  return session?.isResting === true
})

registerHandler('claude.stopSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.stopSession: missing sessionId')
  }
  if (isCodexSession(sessionId)) return stopCodexSession(params)
  const s = sessions.get(sessionId)
  if (s?.abortController) {
    try { s.abortController.abort() } catch { /* already aborted */ }
  }
  closeLiveQuery(s)
  const existed = sessions.delete(sessionId)
  return { ok: true, existed }
})

registerHandler('claude.abortSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.abortSession: missing sessionId')
  }
  if (isCodexSession(sessionId)) return abortCodexSession(params)
  const session = sessions.get(sessionId)
  // Esc always cancels whatever is still waiting in the send queue — see
  // claude.interruptTurn (claude-send.mjs) for why.
  if (session?.pendingSendCancel) session.pendingSendCancel.cancelled = true
  if (session?.abortController) {
    try { session.abortController.abort() } catch { /* already aborted */ }
  }
  if (session) {
    // Abort fires error → drain loop closes liveQuery, but close
    // explicitly to wake any pending push() promise straight away
    // (otherwise renderer's spinner waits for the SDK throw to
    // propagate through the iterator).
    closeLiveQuery(session)
    session.active = false
    session.streaming = false
    clearSessionStream(session)
    // claude:turn-end is also emitted by sendMessage's catch, but we
    // emit here too in case abort is called after streaming finished
    // (the renderer expects an explicit signal).
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'aborted' } })
  }
  return { ok: true }
})

// Per-session state setters. These persist values into the session map
// so getters return what the renderer last set. When the SDK lands,
// these hooks will additionally push the change into the live query
// instance (e.g. set the model on a streaming session). For now they
// just maintain the visible state contract.

registerHandler('claude.setAutoContinue', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const opts = params?.opts || params?.options || {}
  const s = ensureSession(sessionId)
  if (typeof opts.enabled === 'boolean') s.autoContinue.enabled = opts.enabled
  if (typeof opts.max === 'number') s.autoContinue.max = opts.max
  if (typeof opts.prompt === 'string') s.autoContinue.prompt = opts.prompt
  // Reset usage counter when toggling, matches Electron behaviour.
  s.autoContinue.used = 0
  return true
})

registerHandler('claude.getAutoContinue', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return null
  const s = sessions.get(sessionId)
  return s ? { ...s.autoContinue } : null
})

registerHandler('claude.setPermissionMode', async (params) => {
  const sessionId = params?.sessionId
  const mode = params?.mode
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof mode !== 'string') return false
  const s = ensureSession(sessionId)
  s.permissionMode = mode
  // Snapshot immediately rather than waiting for the next sendMessage to do it.
  // A session whose mode is changed and is then stopped before anyone speaks
  // would otherwise come back in whatever mode it was in two changes ago.
  saveSessionConfig(sessionId, s)
  // Mode change: forward to the open LiveQuery / active SDK query when
  // available. SDK's permissionMode
  // enum doesn't include 'bypassPlan' — that's a sidecar-only mode
  // mapped to 'plan' inside buildQueryOptions. If the control method
  // fails, close the query so the next sendMessage rebuilds with the
  // new mode in queryOptions.
  const controlTarget = (s.liveQuery && !s.liveQuery.isClosed)
    ? s.liveQuery
    : (s.streaming ? s.currentQuery : null)
  if (controlTarget && typeof controlTarget.setPermissionMode === 'function') {
    const sdkMode = mode === 'bypassPlan' ? 'plan' : mode
    try { await controlTarget.setPermissionMode(sdkMode) }
    catch (err) {
      logWarn(`setPermissionMode control failed for ${sessionId}: ${err?.message || err}`)
      closeLiveQuery(s)
    }
  }
  // Mirror Electron's claude:modeChange event so listeners refresh.
  sendEvent('claude:modeChange', { sessionId, mode })
  return true
})

const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const CODEX_APPROVAL_POLICIES = new Set(['untrusted', 'on-request', 'never'])

registerHandler('claude.setCodexSandboxMode', async (params) => {
  const sessionId = params?.sessionId
  const mode = params?.mode
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof mode !== 'string' || !CODEX_SANDBOX_MODES.has(mode)) return false
  if (isCodexSession(sessionId)) return setCodexSandboxMode(params)
  const s = sessions.get(sessionId)
  if (!s) return false
  s.codexSandboxMode = mode
  return true
})

registerHandler('claude.setCodexApprovalPolicy', async (params) => {
  const sessionId = params?.sessionId
  const policy = params?.policy
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof policy !== 'string' || !CODEX_APPROVAL_POLICIES.has(policy)) return false
  if (isCodexSession(sessionId)) return setCodexApprovalPolicy(params)
  const s = sessions.get(sessionId)
  if (!s) return false
  s.codexApprovalPolicy = policy
  return true
})

registerHandler('claude.setModel', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (isCodexSession(sessionId)) return setCodexModel(params)
  const s = ensureSession(sessionId)
  if (typeof params?.model === 'string') s.model = params.model
  let windowChanged = false
  if (typeof params?.autoCompactWindow === 'number') {
    s.autoCompactWindow = params.autoCompactWindow
    windowChanged = true
  } else if (params?.autoCompactWindow === null) {
    // Explicit clear: context-only presets (`<base>:<N>m`) send null so a
    // previously-set window doesn't keep compacting under the new selection.
    if ((s.autoCompactWindow ?? null) !== null) {
      s.autoCompactWindow = null
      windowChanged = true
    }
  } else if (typeof params?.model === 'string') {
    // Remote clients may send a bare preset id without the window it
    // encodes — derive it so the preset behaves like an explicit window.
    const derived = autoCompactWindowForClaudeSelection(params.model)
    if (derived !== undefined && (s.autoCompactWindow ?? null) !== derived) {
      s.autoCompactWindow = derived
      windowChanged = true
    }
  }
  // autoCompactWindow is read by the SDK-spawned CLI from env at boot,
  // so changing it requires a rebuild — close the live query.
  // Model swap goes through the control method first; only rebuild on
  // failure. The control method takes a real SDK model id, so preset
  // selections must be mapped before the swap.
  const controlTarget = (s.liveQuery && !s.liveQuery.isClosed)
    ? s.liveQuery
    : (s.streaming ? s.currentQuery : null)
  if (controlTarget) {
    if (windowChanged) {
      closeLiveQuery(s)
    } else if (typeof params?.model === 'string' && typeof controlTarget.setModel === 'function') {
      try { await controlTarget.setModel(sdkModelForClaudeSelection(s.model)) }
      catch (err) {
        logWarn(`setModel control failed for ${sessionId}: ${err?.message || err}`)
        closeLiveQuery(s)
      }
    }
  }
  return true
})

registerHandler('claude.setEffort', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (isCodexSession(sessionId)) return setCodexEffort(params)
  const s = ensureSession(sessionId)
  applyEffortOptions(s, params)
  return true
})

registerHandler('claude.resetSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (isCodexSession(sessionId)) return resetCodexSession(params)
  const prior = sessions.get(sessionId)
  if (prior?.abortController) {
    try { prior.abortController.abort() } catch { /* already aborted */ }
  }
  closeLiveQuery(prior)
  // Drop the session record entirely. Next startSession recreates it.
  // sdkSessionId is not persisted in sessionConfigs (see state.mjs CONFIG_KEYS),
  // so the rebuilt session starts a fresh SDK conversation; the renderer's
  // disk store is cleared on /new /clear and owns cross-restart resume.
  const existed = sessions.delete(sessionId)
  // Mirror Electron's claude:session-reset notification so renderer
  // panels can clear messages / status without polling.
  if (existed) sendEvent('claude:session-reset', { sessionId })
  return existed
})

// Session state lookups read from the per-session map populated by
// startSession + the various setters above. When no session exists for
// the given id we return null to match Electron's behaviour.
registerHandler('claude.getSessionState', async (params) => {
  if (isCodexSession(String(params?.sessionId ?? ''))) return getCodexSessionState(params)
  const sessionId = String(params?.sessionId ?? '')
  const s = sessions.get(sessionId)
  if (!s) return null
  const cwd = s.options && typeof s.options === 'object' && typeof s.options.cwd === 'string'
    ? s.options.cwd.trim()
    : ''
  if (!cwd) {
    // Setter/send paths can materialize a default record before startSession.
    // It is not a resumable session and must not make renderer self-healing
    // skip the required startSession/resumeSession call after a host restart.
    sessions.delete(sessionId)
    return null
  }
  return {
    active: s.active,
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    ultracode: s.ultracode === true,
    autoCompactWindow: s.autoCompactWindow,
    codexSandboxMode: s.codexSandboxMode,
    codexApprovalPolicy: s.codexApprovalPolicy,
    messages: Array.isArray(s.messages) ? s.messages : [],
    isStreaming: s.streaming === true,
    streamingText: s.streamingText || '',
    streamingThinking: s.streamingThinking || '',
  }
})

registerHandler('claude.getSessionMeta', async (params) => {
  if (isCodexSession(String(params?.sessionId ?? ''))) return getCodexSessionMeta(params)
  const s = sessions.get(String(params?.sessionId ?? ''))
  return buildSessionMeta(s)
})

// claude.getContextUsage: surface the cached usage from the last API request
// (lastUsage, never the result frame's lifetime sum) in a shape the renderer's
// ContextUsagePopup understands (subset of SDKControlGetContextUsageResponse:
// categories[], totalTokens, maxTokens, percentage, model, plus
// optional apiUsage). We return null if no turn has completed yet —
// renderer interprets that as "no data yet" and hides the popup.
//
// Live mid-turn data via the SDK control method (instance.getContextUsage())
// would require streaming-input mode, which we don't implement yet.
// Cached values cover the common case where the user opens the popup
// between turns.
registerHandler('claude.getContextUsage', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string') return null
  if (isCodexSession(sessionId)) return null
  const s = sessions.get(sessionId)
  if (!s || !s.lastUsage) return null
  const u = s.lastUsage
  const model = u.model || s.model || null
  const maxTokens = expectedContextWindowForModel(model) || 200000
  const totalTokens = u.totalTokens || 0
  const percentage = maxTokens > 0 ? Math.round((totalTokens / maxTokens) * 100) : 0
  return {
    categories: [{ name: 'Context', tokens: totalTokens, color: '#8B5CF6' }],
    totalTokens,
    maxTokens,
    percentage,
    model: model || 'unknown',
    apiUsage: {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
    },
  }
})
