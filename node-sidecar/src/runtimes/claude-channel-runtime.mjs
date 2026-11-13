import { spawn as spawnChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sendEvent } from '../lib/protocol.mjs'
import { log, warn } from '../lib/logger.mjs'
import { normalizeClaudeEffortMode, runtimeEffortForMode, isUltracodeMode } from '../lib/claude-effort.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'
import { readRequestJson, writeJson } from '../lib/http-json.mjs'
import { isBatDebugEnabled, probeClaudeChannelCapabilities } from './claude-channel-capabilities.mjs'
import { writeClaudeChannelServerScript } from './claude-channel-server.mjs'
import { FRAME_KINDS, normalizeFrame, subEventNameFor } from './claude-channel-frames.mjs'
import { buildClaudeChannelHooksConfig } from './claude-channel-hooks.mjs'

const sessions = new Map()
const endedSessions = new Map()
const POLL_TIMEOUT_MS = 25_000
const STARTUP_SETTLE_MS = 350
const CHANNEL_READY_TIMEOUT_MS = 20_000
const STDERR_TAIL_LIMIT = 4000
const ENDED_SESSION_TTL_MS = 10 * 60 * 1000
const ENDED_SESSION_LIMIT = 100
const PROCESS_EXIT_CLEANUP_TIMEOUT_MS = 2_000

function requireDebug() {
  if (!isBatDebugEnabled()) {
    throw new Error('Claude Channel Agent is available only when BAT_DEBUG is enabled.')
  }
}

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function emit(name, payload) {
  sendEvent(`claude-channel:${name}`, payload)
}

function pruneEndedSessions(now = Date.now()) {
  for (const [sessionId, entry] of endedSessions) {
    if (now - entry.endedAt > ENDED_SESSION_TTL_MS) endedSessions.delete(sessionId)
  }
  while (endedSessions.size > ENDED_SESSION_LIMIT) {
    const oldest = endedSessions.keys().next().value
    if (!oldest) break
    endedSessions.delete(oldest)
  }
}

function rememberEndedSession(sessionId, payload) {
  endedSessions.set(sessionId, {
    ...payload,
    ok: true,
    sessionId,
    channelStatus: payload.channelStatus || 'disconnected',
    endedAt: Date.now(),
  })
  pruneEndedSessions()
}

function clearEndedSession(sessionId) {
  endedSessions.delete(sessionId)
}

function flushOne(session) {
  if (session.waiters.length === 0 || session.queue.length === 0) return false
  const waiter = session.waiters.shift()
  const event = session.queue.shift()
  clearTimeout(waiter.timer)
  writeJson(waiter.res, 200, event)
  return true
}

function enqueueChannelEvent(session, event) {
  session.queue.push(event)
  while (flushOne(session)) {
    // Drain waiters while events are available.
  }
}

function emitFrame(session, frame, inReplyTo) {
  const subEvent = subEventNameFor(frame.kind)
  if (!subEvent) return
  const sessionId = session.sessionId
  const timestamp = Date.now()
  if (frame.kind === FRAME_KINDS.ASSISTANT) {
    // Emit both the legacy :message event (so the existing renderer keeps
    // working unchanged) and the new :assistant event for callers that want
    // to track partial-vs-final separately.
    const message = {
      id: `channel-assistant-${timestamp}`,
      sessionId,
      role: 'assistant',
      text: frame.payload.text || '',
      status: frame.payload.status,
      inReplyTo: inReplyTo || null,
      timestamp,
    }
    emit('message', message)
    emit('assistant', {
      sessionId,
      id: frame.payload.id || message.id,
      text: frame.payload.text || '',
      status: frame.payload.status,
      inReplyTo: inReplyTo || null,
      timestamp,
    })
    return
  }
  emit(subEvent, {
    sessionId,
    payload: frame.payload,
    inReplyTo: inReplyTo || null,
    timestamp,
  })
}

function applyResultFrame(session, frame, inReplyTo) {
  const status = frame.payload.status === 'error' ? 'error' : 'ready'
  session.status = status
  emit('status', {
    sessionId: session.sessionId,
    status: session.status,
    channelStatus: 'connected',
    stopReason: frame.payload.stop_reason || null,
    error: frame.payload.error || null,
  })
  emit('turn-end', {
    sessionId: session.sessionId,
    messageId: inReplyTo || null,
    stopReason: frame.payload.stop_reason || null,
    error: frame.payload.error || null,
  })
}

function frameFromHook(eventName, body) {
  if (!body || typeof body !== 'object') return null
  switch (eventName) {
    case 'PreToolUse': {
      const id = typeof body.tool_use_id === 'string' ? body.tool_use_id : ''
      const name = typeof body.tool_name === 'string' ? body.tool_name : ''
      if (!id || !name) return null
      return normalizeFrame({
        kind: FRAME_KINDS.TOOL_USE,
        payload: { id, name, input: body.tool_input ?? null },
      })
    }
    case 'PostToolUse': {
      const toolUseId = typeof body.tool_use_id === 'string' ? body.tool_use_id : ''
      if (!toolUseId) return null
      return normalizeFrame({
        kind: FRAME_KINDS.TOOL_RESULT,
        payload: { tool_use_id: toolUseId, content: body.tool_response, is_error: false },
      })
    }
    case 'PostToolUseFailure': {
      const toolUseId = typeof body.tool_use_id === 'string' ? body.tool_use_id : ''
      if (!toolUseId) return null
      const content = typeof body.error === 'string' ? body.error : (body.error ?? null)
      return normalizeFrame({
        kind: FRAME_KINDS.TOOL_RESULT,
        payload: { tool_use_id: toolUseId, content, is_error: true },
      })
    }
    case 'MessageDisplay': {
      const text = typeof body.delta === 'string' ? body.delta : ''
      if (!text) return null
      return normalizeFrame({
        kind: FRAME_KINDS.ASSISTANT,
        payload: {
          id: typeof body.message_id === 'string' ? body.message_id : undefined,
          text,
          status: body.final === true ? 'final' : 'partial',
        },
      })
    }
    case 'Stop':
      return normalizeFrame({
        kind: FRAME_KINDS.RESULT,
        payload: { status: 'success' },
      })
    case 'StopFailure':
      return normalizeFrame({
        kind: FRAME_KINDS.RESULT,
        payload: {
          status: 'error',
          error: typeof body.error_message === 'string' ? body.error_message : undefined,
          stop_reason: typeof body.error_type === 'string' ? body.error_type : undefined,
        },
      })
    case 'SubagentStart':
      return normalizeFrame({
        kind: FRAME_KINDS.STATUS,
        payload: {
          state: 'subagent_start',
          message: typeof body.agent_type === 'string' ? body.agent_type : undefined,
        },
      })
    case 'SubagentStop':
      return normalizeFrame({
        kind: FRAME_KINDS.STATUS,
        payload: {
          state: 'subagent_stop',
          message: typeof body.agent_type === 'string' ? body.agent_type : undefined,
        },
      })
    case 'SessionStart':
      return normalizeFrame({
        kind: FRAME_KINDS.STATUS,
        payload: {
          state: 'session_start',
          message: typeof body.model === 'string' ? body.model : undefined,
        },
      })
    default:
      return null
  }
}

async function createBridge(session) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
      if (url.pathname === '/events' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId !== session.sessionId) {
          writeJson(res, 404, { error: 'unknown session' })
          return
        }
        if (session.queue.length > 0) {
          writeJson(res, 200, session.queue.shift())
          return
        }
        const timer = setTimeout(() => {
          session.waiters = session.waiters.filter(waiter => waiter.res !== res)
          res.writeHead(204)
          res.end()
        }, POLL_TIMEOUT_MS)
        session.waiters.push({ res, timer })
        return
      }
      if (url.pathname === '/reply' && req.method === 'POST') {
        const body = await readRequestJson(req)
        if (body.sessionId && body.sessionId !== session.sessionId) {
          writeJson(res, 404, { error: 'unknown session' })
          return
        }
        const message = {
          id: `channel-reply-${Date.now()}`,
          sessionId: session.sessionId,
          role: 'assistant',
          text: String(body.text || ''),
          status: body.status || 'final',
          inReplyTo: body.bat_message_id || null,
          timestamp: Date.now(),
        }
        emit('message', message)
        if (message.status === 'final') {
          session.status = 'ready'
          emit('status', { sessionId: session.sessionId, status: session.status, channelStatus: 'connected' })
          emit('turn-end', { sessionId: session.sessionId, messageId: message.inReplyTo })
        }
        writeJson(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/frame' && req.method === 'POST') {
        const body = await readRequestJson(req)
        if (body.sessionId && body.sessionId !== session.sessionId) {
          writeJson(res, 404, { error: 'unknown session' })
          return
        }
        const frame = normalizeFrame({ kind: body.kind, payload: body.payload, meta: body.meta })
        if (!frame) {
          writeJson(res, 400, { error: 'invalid frame' })
          return
        }
        const inReplyTo = (body.meta && typeof body.meta.bat_message_id === 'string')
          ? body.meta.bat_message_id
          : null
        emitFrame(session, frame, inReplyTo)
        if (frame.kind === FRAME_KINDS.RESULT) {
          applyResultFrame(session, frame, inReplyTo)
        } else if (frame.kind === FRAME_KINDS.ASSISTANT && frame.payload.status === 'final' && !session.deferTurnEndToResult) {
          // Treat a final assistant frame as turn-end when no explicit result
          // frame follows. Keeps the per-message UX working for prompts where
          // Claude only emits bat_assistant final without a result frame.
          session.status = 'ready'
          emit('status', { sessionId: session.sessionId, status: session.status, channelStatus: 'connected' })
          emit('turn-end', { sessionId: session.sessionId, messageId: inReplyTo })
        }
        writeJson(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/ready' && req.method === 'POST') {
        const body = await readRequestJson(req)
        if (body.sessionId && body.sessionId !== session.sessionId) {
          writeJson(res, 404, { error: 'unknown session' })
          return
        }
        markChannelReady(session)
        writeJson(res, 200, { ok: true })
        return
      }
      if (url.pathname.startsWith('/hook/') && req.method === 'POST') {
        const eventName = url.pathname.slice('/hook/'.length)
        const body = await readRequestJson(req)
        const frame = frameFromHook(eventName, body)
        if (frame) {
          emitFrame(session, frame, null)
          if (frame.kind === FRAME_KINDS.RESULT) {
            applyResultFrame(session, frame, null)
          }
        }
        // Return an empty body so the CLI hook treats this as success-with-no-opinion
        // (default permission, no input/output mutation). Phase C will replace this for
        // PreToolUse / PermissionRequest with real BAT permission routing.
        writeJson(res, 200, {})
        return
      }
      writeJson(res, 404, { error: 'not found' })
    } catch (err) {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Claude Channel bridge did not bind to a TCP port.')
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  }
}

function buildSessionSettings(session, bridgeUrl) {
  const settings = { ...buildClaudeChannelHooksConfig(bridgeUrl) }
  if (isUltracodeMode(session.effort) || session.ultracode === true) {
    settings.ultracode = true
    settings.enableWorkflows = true
  }
  return settings
}

async function prepareSessionFiles(session, bridgeUrl) {
  const root = join(resolveDataDir(), 'claude-channel', safeId(session.sessionId))
  await mkdir(root, { recursive: true, mode: 0o700 })
  const serverPath = join(root, 'bat-channel-server.mjs')
  const mcpConfigPath = join(root, 'mcp-config.json')
  const settingsPath = join(root, 'settings.json')
  await writeClaudeChannelServerScript(serverPath)
  await writeFile(mcpConfigPath, JSON.stringify({
    mcpServers: {
      bat: {
        command: process.execPath,
        args: [serverPath],
        env: {
          BAT_CHANNEL_BRIDGE_URL: bridgeUrl,
          BAT_CHANNEL_SESSION_ID: session.sessionId,
        },
      },
    },
  }, null, 2), { mode: 0o600 })
  await writeFile(settingsPath, JSON.stringify(buildSessionSettings(session, bridgeUrl), null, 2), { mode: 0o600 })
  return { root, serverPath, mcpConfigPath, settingsPath }
}

function buildClaudeArgs(session, files) {
  const args = [
    '--dangerously-load-development-channels',
    'server:bat',
    '--mcp-config',
    files.mcpConfigPath,
    '--strict-mcp-config',
    '--settings',
    files.settingsPath,
    '--name',
    `BAT Channel ${session.sessionId.slice(0, 8)}`,
  ]
  if (session.model) args.push('--model', session.model)
  const runtimeEffort = runtimeEffortForMode(session.effort)
  if (runtimeEffort) args.push('--effort', runtimeEffort)
  if (session.permissionMode) args.push('--permission-mode', session.permissionMode)
  log('[claude-channel:create]', session.sessionId, JSON.stringify({
    model: session.model || null,
    permissionMode: session.permissionMode || null,
    effort: runtimeEffort || null,
    effortMode: session.effort || null,
    ultracode: isUltracodeMode(session.effort) || session.ultracode === true,
  }))
  return args
}

function appendOutputTail(current, chunk) {
  const next = `${current || ''}${cleanProcessOutput(chunk)}`
  return next.length > STDERR_TAIL_LIMIT ? next.slice(next.length - STDERR_TAIL_LIMIT) : next
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
}

function cleanProcessOutput(value) {
  return stripAnsi(value)
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

// Match against the accumulated output (stderrTail), not a single chunk: the
// PTY delivers the prompt in pieces, so the "mentions" and "asks" signals can
// land in different chunks.
function shouldAutoConfirmDevelopmentChannel(session) {
  if (session.developmentChannelConfirmed) return false
  const text = stripAnsi(session.stderrTail || '').toLowerCase()
  const mentionsDevelopmentChannel =
    text.includes('development channel')
    || text.includes('dangerously-load-development-channels')
    || (text.includes('allowlist') && text.includes('channel'))
  if (!mentionsDevelopmentChannel) return false
  const asksForConfirmation =
    text.includes('enter to confirm')
    || text.includes('i am using this for local development')
    || text.includes('y/n')
    || text.includes('yes/no')
    || text.includes('[y')
    || text.includes('continue')
    || text.includes('proceed')
  return asksForConfirmation
}

function shouldAutoConfirmWorkspaceTrust(session) {
  if (session.workspaceTrustConfirmed) return false
  const text = stripAnsi(session.stderrTail || '').toLowerCase()
  const mentionsTrustPrompt =
    text.includes('do you trust this folder')
    || text.includes('trust this folder')
    || (text.includes('safety check') && text.includes('created or gone you trust'))
  const hasTrustChoice =
    text.includes('yes, i trust this folder')
    || (text.includes('1.') && text.includes('yes') && text.includes('2.') && text.includes('no'))
  return mentionsTrustPrompt && hasTrustChoice
}

// Send a confirmation keystroke, retrying a couple times: the Ink select may not
// be mounted the instant its prompt text reaches us, so a single write can be
// dropped.
function confirmPromptWithRetries(child, keys) {
  const send = () => {
    try {
      child.write(keys)
    } catch {
      // The child may have already exited; ignore.
    }
  }
  send()
  setTimeout(send, 300)
  setTimeout(send, 900)
}

function startupFailureMessage(result) {
  if (result?.type === 'error') {
    return `Claude Channel Agent failed to start: ${result.error || 'unknown spawn error'}`
  }
  const detail = result?.stderr ? ` ${cleanProcessOutput(result.stderr).trim()}` : ''
  const code = result?.code === null || result?.code === undefined ? 'unknown' : result.code
  const signal = result?.signal ? ` signal=${result.signal}` : ''
  return `Claude Channel Agent exited during startup (code=${code}${signal}).${detail}`
}

function exitStatusPayload(session, code, signal) {
  const status = code === 0 ? 'stopped' : 'error'
  const payload = {
    sessionId: session.sessionId,
    status,
    channelStatus: 'disconnected',
    exitCode: code,
  }
  if (signal) payload.signal = signal
  if (status === 'error') {
    const detail = session.stderrTail ? ` ${cleanProcessOutput(session.stderrTail).trim()}` : ''
    const displayCode = code === null || code === undefined ? 'unknown' : code
    payload.error = `Claude Channel Agent exited (code=${displayCode}${signal ? ` signal=${signal}` : ''}).${detail}`
  }
  return payload
}

function notifyProcessExit(session, code, signal) {
  if (session.processExited) return
  session.processExited = true
  session.processExitResult = { type: 'exit', code, signal, stderr: session.stderrTail || '' }
  for (const listener of session.exitListeners.splice(0)) listener(code, signal)
}

function notifyProcessError(session, err) {
  if (session.processErrored) return
  session.processErrored = true
  session.processErrorResult = {
    type: 'error',
    error: err instanceof Error ? err.message : String(err),
  }
  for (const listener of session.errorListeners.splice(0)) listener(err)
}

function onProcessExit(session, listener) {
  if (session.processExited && session.processExitResult) {
    listener(session.processExitResult.code, session.processExitResult.signal)
    return () => {}
  }
  session.exitListeners.push(listener)
  return () => {
    session.exitListeners = session.exitListeners.filter(item => item !== listener)
  }
}

function onProcessError(session, listener) {
  if (session.processErrored && session.processErrorResult) {
    listener(new Error(session.processErrorResult.error))
    return () => {}
  }
  session.errorListeners.push(listener)
  return () => {
    session.errorListeners = session.errorListeners.filter(item => item !== listener)
  }
}

function waitForProcessExit(session, timeoutMs = PROCESS_EXIT_CLEANUP_TIMEOUT_MS) {
  if (!session.child || session.processExited || session.processErrored) return Promise.resolve()
  return new Promise(resolve => {
    let offExit = () => {}
    let offError = () => {}
    const timer = setTimeout(() => {
      offExit()
      offError()
      resolve()
    }, timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      offExit()
      offError()
      resolve()
    }
    offExit = onProcessExit(session, finish)
    offError = onProcessError(session, finish)
  })
}

async function loadNodePty() {
  if (process.env.BAT_CLAUDE_CHANNEL_DISABLE_PTY === '1') return null
  try {
    const mod = await import('@lydell/node-pty')
    return mod.spawn ? mod : mod.default
  } catch (err) {
    warn('[claude-channel] node-pty unavailable; falling back to child_process', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function spawnClaudeProcess(session, cliPath, args, bridgeUrl) {
  const env = { ...process.env, BAT_CHANNEL_BRIDGE_URL: bridgeUrl, TERM: process.env.TERM || 'xterm-256color' }
  const pty = await loadNodePty()
  if (pty?.spawn) {
    try {
      const child = pty.spawn(cliPath, args, {
        cwd: session.cwd,
        env,
        name: 'xterm-256color',
        cols: 100,
        rows: 32,
      })
      const processHandle = {
        kind: 'pty',
        killed: false,
        kill(signal = 'SIGTERM') {
          processHandle.killed = true
          if (process.platform === 'win32') child.kill()
          else child.kill(signal)
        },
      }
      child.onData(chunk => {
        session.stderrTail = appendOutputTail(session.stderrTail, chunk)
        log('[claude-channel:pty]', session.sessionId, String(chunk).trimEnd())
        if (shouldAutoConfirmDevelopmentChannel(session)) {
          session.developmentChannelConfirmed = true
          log('[claude-channel:pty]', session.sessionId, 'auto-confirming development channel prompt')
          // Option 1 ("I am using this for local development") is pre-selected;
          // the prompt says "Enter to confirm", so a carriage return accepts it.
          // Retry a couple times in case the Ink select isn't mounted yet.
          confirmPromptWithRetries(child, '\r')
        } else if (shouldAutoConfirmWorkspaceTrust(session)) {
          session.workspaceTrustConfirmed = true
          log('[claude-channel:pty]', session.sessionId, 'auto-confirming workspace trust prompt')
          confirmPromptWithRetries(child, '1\r')
        }
      })
      child.onExit(event => {
        notifyProcessExit(session, event.exitCode, event.signal || null)
      })
      return processHandle
    } catch (err) {
      // node-pty can load but still fail to spawn (e.g. bundled/native mismatch,
      // missing conpty helper). Don't crash the session — fall back to child_process.
      warn('[claude-channel] node-pty spawn failed; falling back to child_process', err instanceof Error ? err.message : String(err))
    }
  }

  const child = spawnChildProcess(cliPath, args, {
    cwd: session.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  const processHandle = {
    kind: 'child_process',
    get killed() {
      return child.killed
    },
    kill(signal = 'SIGTERM') {
      child.kill(signal)
    },
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => {
    log('[claude-channel:stdout]', session.sessionId, String(chunk).trimEnd())
  })
  child.stderr?.on('data', chunk => {
    session.stderrTail = appendOutputTail(session.stderrTail, chunk)
    warn('[claude-channel:stderr]', session.sessionId, String(chunk).trimEnd())
  })
  child.on('error', err => notifyProcessError(session, err))
  child.on('exit', (code, signal) => notifyProcessExit(session, code, signal))
  return processHandle
}

function markChannelReady(session) {
  if (session.channelReady) return
  session.channelReady = true
  session.channelStatus = 'connected'
  if (session.status === 'starting') session.status = 'ready'
  emit('status', {
    sessionId: session.sessionId,
    status: session.status,
    channelStatus: session.channelStatus,
  })
  for (const resolve of session.readyWaiters.splice(0)) resolve(true)
}

function waitForChannelReady(session, timeoutMs = CHANNEL_READY_TIMEOUT_MS) {
  if (session.channelReady) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      session.readyWaiters = session.readyWaiters.filter(waiter => waiter !== complete)
      resolve(false)
    }, timeoutMs)
    const complete = value => {
      clearTimeout(timer)
      resolve(value)
    }
    session.readyWaiters.push(complete)
  })
}

function channelReadyTimeoutMessage(session) {
  const detail = session.stderrTail ? ` ${cleanProcessOutput(session.stderrTail).trim()}` : ''
  return [
    'Claude Channel Agent started, but the BAT channel server did not connect.',
    'Check Claude login, workspace trust, organization channelsEnabled policy, and the development channel confirmation prompt.',
    detail,
  ].join(' ').trim()
}

function waitForStartupSettle(session) {
  return new Promise(resolve => {
    if (!session.child) {
      resolve({ type: 'error', error: 'Claude process was not created.' })
      return
    }
    let settled = false
    let timer
    let offExit = () => {}
    let offError = () => {}
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      offExit()
      offError()
      resolve(result)
    }
    const onExit = (code, signal) => {
      finish({ type: 'exit', code, signal, stderr: session.stderrTail || '' })
    }
    const onError = err => {
      finish({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    timer = setTimeout(() => finish(null), STARTUP_SETTLE_MS)
    offExit = onProcessExit(session, onExit)
    offError = onProcessError(session, onError)
  })
}

async function cleanupSession(session) {
  if (session.cleaning) return
  session.cleaning = true
  for (const waiter of session.waiters) {
    clearTimeout(waiter.timer)
    try {
      waiter.res.writeHead(204)
      waiter.res.end()
    } catch { /* ignore */ }
  }
  session.waiters = []
  for (const resolve of session.readyWaiters || []) resolve(false)
  session.readyWaiters = []
  if (session.child && !session.child.killed) {
    try { session.child.kill('SIGTERM') } catch { /* ignore */ }
  }
  await waitForProcessExit(session)
  if (session.bridgeServer) {
    await new Promise(resolve => {
      try { session.bridgeServer.close(resolve) } catch { resolve() }
    }).catch(() => {})
  }
  if (session.root) {
    await rm(session.root, { recursive: true, force: true }).catch(() => {})
  }
}

export async function getClaudeChannelCapabilities(params = {}) {
  requireDebug()
  return probeClaudeChannelCapabilities({ cliPath: params.cliPath })
}

export async function startClaudeChannelSession(params = {}) {
  requireDebug()
  const sessionId = String(params.sessionId || '')
  if (!sessionId) throw new Error('claudeChannel.startSession: missing sessionId')
  if (sessions.has(sessionId)) return getClaudeChannelStatus({ sessionId })
  clearEndedSession(sessionId)

  const cliPath = String(params.cliPath || '')
  const capabilities = await probeClaudeChannelCapabilities({ cliPath })
  if (!capabilities.supported) {
    return {
      ok: false,
      sessionId,
      status: 'error',
      capabilities,
      error: capabilities.error || 'Claude Channel Agent is not supported by this Claude CLI.',
    }
  }

  const effortMode = normalizeClaudeEffortMode(params.effort, params.ultracode === true)
  const session = {
    sessionId,
    cwd: String(params.cwd || process.cwd()),
    workspaceId: params.workspaceId || null,
    cliPath,
    model: params.model || null,
    effort: effortMode,
    ultracode: isUltracodeMode(effortMode),
    permissionMode: params.permissionMode || null,
    status: 'starting',
    capabilities,
    stderrTail: '',
    queue: [],
    waiters: [],
    readyWaiters: [],
    channelReady: false,
    channelStatus: 'connecting',
    developmentChannelConfirmed: false,
    workspaceTrustConfirmed: false,
    processExited: false,
    processErrored: false,
    processExitResult: null,
    processErrorResult: null,
    exitListeners: [],
    errorListeners: [],
    child: null,
    bridgeServer: null,
    root: null,
  }
  sessions.set(sessionId, session)

  try {
    const bridge = await createBridge(session)
    session.bridgeServer = bridge.server
    const files = await prepareSessionFiles(session, bridge.url)
    session.root = files.root
    const args = buildClaudeArgs(session, files)
    session.child = await spawnClaudeProcess(session, cliPath, args, bridge.url)
    onProcessError(session, err => {
      if (session.cleaning) return
      session.status = 'error'
      emit('status', {
        sessionId,
        status: 'error',
        channelStatus: 'disconnected',
        error: err instanceof Error ? err.message : String(err),
      })
    })
    onProcessExit(session, (code, signal) => {
      if (session.cleaning) return
      session.status = code === 0 ? 'stopped' : 'error'
      const payload = exitStatusPayload(session, code, signal)
      rememberEndedSession(sessionId, {
        ...payload,
        cliPath: session.cliPath,
        cliVersion: session.capabilities?.cliVersion || null,
        capabilities: session.capabilities,
      })
      emit('status', payload)
      sessions.delete(sessionId)
      void cleanupSession(session)
    })
    const startupFailure = await waitForStartupSettle(session)
    if (startupFailure) {
      sessions.delete(sessionId)
      const error = startupFailureMessage(startupFailure)
      session.status = 'error'
      await cleanupSession(session)
      const result = {
        ok: false,
        sessionId,
        status: 'error',
        capabilities,
        cliPath,
        cliVersion: capabilities.cliVersion,
        error,
      }
      rememberEndedSession(sessionId, result)
      return result
    }
    emit('status', { sessionId, status: 'starting', channelStatus: 'connecting' })
    const channelReady = await waitForChannelReady(session)
    if (!channelReady) {
      sessions.delete(sessionId)
      const error = channelReadyTimeoutMessage(session)
      session.status = 'error'
      session.channelStatus = 'disconnected'
      await cleanupSession(session)
      const result = {
        ok: false,
        sessionId,
        status: 'error',
        channelStatus: 'disconnected',
        capabilities,
        cliPath,
        cliVersion: capabilities.cliVersion,
        error,
      }
      rememberEndedSession(sessionId, result)
      return result
    }
    session.status = 'ready'
    return {
      ok: true,
      sessionId,
      status: session.status,
      channelStatus: session.channelStatus,
      capabilities,
      cliPath,
      cliVersion: capabilities.cliVersion,
    }
  } catch (err) {
    sessions.delete(sessionId)
    await cleanupSession(session)
    throw err
  }
}

export async function sendClaudeChannelMessage(params = {}) {
  requireDebug()
  const sessionId = String(params.sessionId || '')
  const prompt = String(params.prompt || '')
  if (!sessionId) throw new Error('claudeChannel.sendMessage: missing sessionId')
  if (!prompt.trim()) throw new Error('claudeChannel.sendMessage: missing prompt')
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`claudeChannel.sendMessage: session not found: ${sessionId}`)
  if (!session.channelReady) {
    throw new Error('claudeChannel.sendMessage: channel is still connecting')
  }
  const messageId = params.messageId || `channel-user-${Date.now()}`
  session.status = 'running'
  emit('message', {
    id: messageId,
    sessionId,
    role: 'user',
    text: prompt,
    timestamp: Date.now(),
  })
  emit('status', { sessionId, status: 'running', channelStatus: session.channelStatus })
  enqueueChannelEvent(session, {
    content: prompt,
    meta: {
      bat_session_id: sessionId,
      bat_message_id: messageId,
      workspace_id: String(session.workspaceId || ''),
    },
  })
  return { ok: true, sessionId, messageId }
}

export async function stopClaudeChannelSession(params = {}) {
  requireDebug()
  const sessionId = String(params.sessionId || '')
  if (!sessionId) throw new Error('claudeChannel.stopSession: missing sessionId')
  clearEndedSession(sessionId)
  const session = sessions.get(sessionId)
  if (!session) return { ok: true, sessionId, existed: false }
  sessions.delete(sessionId)
  await cleanupSession(session)
  emit('status', { sessionId, status: 'stopped', channelStatus: 'disconnected' })
  return { ok: true, sessionId, existed: true }
}

export async function getClaudeChannelStatus(params = {}) {
  requireDebug()
  const sessionId = String(params.sessionId || '')
  const session = sessions.get(sessionId)
  if (!session) {
    pruneEndedSessions()
    const ended = endedSessions.get(sessionId)
    if (ended) return { ...ended }
    return { ok: true, sessionId, status: 'stopped', channelStatus: 'disconnected' }
  }
  return {
    ok: true,
    sessionId,
    status: session.status,
    channelStatus: session.channelStatus || (session.bridgeServer ? 'connecting' : 'unknown'),
    cliPath: session.cliPath,
    cliVersion: session.capabilities?.cliVersion || null,
    capabilities: session.capabilities,
  }
}

export function __resetClaudeChannelSessionsForTests() {
  const current = [...sessions.values()]
  sessions.clear()
  endedSessions.clear()
  return Promise.all(current.map(cleanupSession))
}
