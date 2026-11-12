import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { sendEvent } from '../lib/protocol.mjs'
import { log, warn } from '../lib/logger.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'
import { readRequestJson, writeJson } from '../lib/http-json.mjs'
import { normalizeClaudeEffortMode, runtimeEffortForMode, isUltracodeMode } from '../lib/claude-effort.mjs'
import { probeClaudeCliCapabilities } from './claude-cli-capabilities.mjs'
import { createTranscriptTailer, locateTranscriptBySessionId, resolveProjectsDir } from './claude-cli-transcript.mjs'

const sessions = new Map()
const endedSessions = new Map()
const ENDED_SESSION_TTL_MS = 10 * 60 * 1000
const ENDED_SESSION_LIMIT = 100
const TRANSCRIPT_LOCATE_MS = 250
const TRANSCRIPT_WARN_AFTER_MS = 30_000

function isBatDebugEnabled(env = process.env) {
  const value = env.BAT_DEBUG ?? env.VITE_BAT_DEBUG
  return value === '1' || value === 'true' || value === 'TRUE'
}

function requireDebug() {
  if (!isBatDebugEnabled()) {
    throw new Error('Claude CLI Agent is available only when BAT_DEBUG is enabled.')
  }
}

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'session'
}

function emit(name, payload) {
  sendEvent(`claude-cli:${name}`, payload)
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
    endedAt: Date.now(),
  })
  pruneEndedSessions()
}

function frameKey(frame) {
  const meta = frame?.meta || {}
  const stableId = meta.uuid || meta.parentUuid || frame?.payload?.id || frame?.payload?.tool_use_id || ''
  let payload = ''
  try { payload = JSON.stringify(frame?.payload ?? null) } catch { payload = String(frame?.payload ?? '') }
  return `${frame?.kind || 'unknown'}:${stableId}:${payload}`
}

function timestampFromMeta(meta) {
  if (typeof meta?.timestamp === 'string') {
    const parsed = Date.parse(meta.timestamp)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

// Build a renderer entry id that is unique per (kind, transcript line, block)
// yet stable across re-reads. NEVER reuse message.id raw: all blocks of one
// API message share message.id (thinking + text + tool_use lines reuse the
// same msg id on real transcripts), and the panel dedupes entries by id — a
// raw msg id would make the thinking entry swallow the assistant text.
function entryId(kind, frame, timestamp) {
  const meta = frame.meta || {}
  const payload = frame.payload || {}
  const base = meta.uuid || payload.id || timestamp
  const blockIndex = typeof meta.blockIndex === 'number' ? meta.blockIndex : 0
  return `cli-${kind}-${base}-${blockIndex}`
}

function emitFrame(session, frame) {
  if (!frame || typeof frame !== 'object') return
  const key = frameKey(frame)
  if (session.seenFrameKeys.has(key)) return
  session.seenFrameKeys.add(key)
  const sessionId = session.sessionId
  const timestamp = timestampFromMeta(frame.meta)
  const payload = frame.payload || {}
  switch (frame.kind) {
    case 'user': {
      emit('message', {
        id: entryId('user', frame, timestamp),
        sessionId,
        role: 'user',
        text: payload.text || '',
        image: payload.image === true,
        timestamp,
      })
      break
    }
    case 'assistant': {
      emit('assistant', {
        sessionId,
        id: entryId('assistant', frame, timestamp),
        text: payload.text || '',
        status: 'final',
        timestamp,
      })
      break
    }
    case 'thinking':
      emit('thinking', {
        sessionId,
        payload: { ...payload, id: entryId('thinking', frame, timestamp) },
        timestamp,
      })
      break
    case 'tool_use':
      emit('tool-use', { sessionId, payload, timestamp })
      break
    case 'tool_result':
      emit('tool-result', { sessionId, payload, timestamp })
      break
    case 'usage':
      session.lastUsage = payload
      emit('usage', { sessionId, payload, timestamp })
      break
    default:
      break
  }
}

function hookToolUseFrame(body) {
  const id = typeof body?.tool_use_id === 'string' ? body.tool_use_id : ''
  const name = typeof body?.tool_name === 'string' ? body.tool_name : ''
  if (!id || !name) return null
  return {
    kind: 'tool_use',
    payload: { id, name, input: body.tool_input ?? null },
    meta: { timestamp: new Date().toISOString() },
  }
}

async function createBridge(session) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
      if (url.pathname.startsWith('/hook/') && req.method === 'POST') {
        const eventName = url.pathname.slice('/hook/'.length)
        const body = await readRequestJson(req)
        if (eventName === 'SessionStart') {
          session.status = 'ready'
          emit('status', {
            sessionId: session.sessionId,
            status: session.status,
            cliSessionId: session.cliSessionId,
            model: typeof body?.model === 'string' ? body.model : session.model || null,
          })
        } else if (eventName === 'UserPromptSubmit') {
          session.status = 'running'
          emit('status', { sessionId: session.sessionId, status: session.status })
        } else if (eventName === 'PreToolUse') {
          const frame = hookToolUseFrame(body)
          if (frame) emitFrame(session, frame)
        } else if (eventName === 'Stop') {
          session.status = 'ready'
          emit('status', { sessionId: session.sessionId, status: session.status })
          emit('turn-end', { sessionId: session.sessionId, reason: 'completed', timestamp: Date.now() })
        } else if (eventName === 'StopFailure') {
          session.status = 'error'
          emit('status', {
            sessionId: session.sessionId,
            status: session.status,
            error: typeof body?.error_message === 'string' ? body.error_message : undefined,
          })
          emit('turn-end', { sessionId: session.sessionId, reason: 'error', timestamp: Date.now() })
        }
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
    throw new Error('Claude CLI bridge did not bind to a TCP port.')
  }
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function buildHooksConfig(bridgeUrl) {
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'StopFailure']
  const hooks = {}
  for (const eventName of events) {
    hooks[eventName] = [{
      matcher: '*',
      hooks: [{ type: 'http', url: `${bridgeUrl}/hook/${eventName}` }],
    }]
  }
  return { hooks }
}

async function writeSessionSettings(session, bridgeUrl) {
  const root = join(resolveDataDir(), 'claude-cli-agent', safeId(session.sessionId))
  await mkdir(root, { recursive: true, mode: 0o700 })
  const settingsPath = join(root, 'settings.json')
  const settings = buildHooksConfig(bridgeUrl)
  if (isUltracodeMode(session.effort) || session.ultracode === true) {
    settings.ultracode = true
    settings.enableWorkflows = true
  }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
  return { root, settingsPath }
}

function startTranscriptLocator(session) {
  const startedAt = Date.now()
  const projectsDir = session.projectsDir || resolveProjectsDir()
  const locate = () => {
    if (session.stopped || session.transcriptPath) return
    const found = locateTranscriptBySessionId(session.cliSessionId, { projectsDir })
    if (!found) {
      if (!session.transcriptWarned && Date.now() - startedAt > TRANSCRIPT_WARN_AFTER_MS) {
        session.transcriptWarned = true
        emit('status', {
          sessionId: session.sessionId,
          status: session.status,
          warning: 'Transcript file has not appeared yet.',
        })
      }
      return
    }
    session.transcriptPath = found
    session.tailer = createTranscriptTailer({
      filePath: found,
      pollMs: 150,
      startAtEnd: session.startAtEnd === true,
      onFrames: frames => {
        for (const frame of frames) emitFrame(session, frame)
      },
      onError: err => {
        warn('[claude-cli] transcript tailer error', err instanceof Error ? err.message : String(err))
        emit('status', {
          sessionId: session.sessionId,
          status: session.status,
          warning: err instanceof Error ? err.message : String(err),
        })
      },
    })
    emit('status', {
      sessionId: session.sessionId,
      status: session.status,
      transcriptPath: found,
    })
  }
  session.locateTimer = setInterval(locate, TRANSCRIPT_LOCATE_MS)
  if (typeof session.locateTimer.unref === 'function') session.locateTimer.unref()
  locate()
}

async function cleanupSession(session) {
  if (!session || session.cleaning) return
  session.cleaning = true
  session.stopped = true
  if (session.locateTimer) clearInterval(session.locateTimer)
  session.locateTimer = null
  try { session.tailer?.stop?.() } catch {}
  session.tailer = null
  if (session.bridgeServer) {
    await new Promise(resolve => {
      try { session.bridgeServer.close(resolve) } catch { resolve() }
    }).catch(() => {})
  }
  session.bridgeServer = null
  if (session.root) await rm(session.root, { recursive: true, force: true }).catch(() => {})
}

export async function getClaudeCliCapabilities(params = {}) {
  requireDebug()
  return probeClaudeCliCapabilities({ cliPath: params.cliPath, projectsDir: params.projectsDir })
}

export async function startClaudeCliSession(params = {}) {
  requireDebug()
  const sessionId = String(params.sessionId || '')
  if (!sessionId) throw new Error('claudeCli.startSession: missing sessionId')
  if (sessions.has(sessionId)) return getClaudeCliStatus({ sessionId })
  endedSessions.delete(sessionId)

  const cliPath = String(params.cliPath || '')
  const projectsDir = typeof params.projectsDir === 'string' ? params.projectsDir : resolveProjectsDir()
  const capabilities = await probeClaudeCliCapabilities({ cliPath, projectsDir })
  // Hard-fail only when the CLI itself is unusable (missing / not runnable /
  // too old). A failed transcript-schema probe is NOT fatal: on a fresh
  // machine there are no transcripts yet, so we proceed and surface drift
  // through status warnings instead.
  if (!capabilities.versionOk) {
    return {
      ok: false,
      sessionId,
      status: 'error',
      capabilities,
      cliPath,
      cliVersion: capabilities.cliVersion,
      error: capabilities.error || 'Claude CLI is not available.',
    }
  }
  const cliSessionId = String(params.cliSessionId || params.currentCliSessionId || randomUUID())
  const effortMode = normalizeClaudeEffortMode(params.effort, params.ultracode === true)
  const session = {
    sessionId,
    cliSessionId,
    cwd: String(params.cwd || process.cwd()),
    workspaceId: params.workspaceId || null,
    cliPath,
    model: params.model || null,
    permissionMode: params.permissionMode || null,
    effort: effortMode,
    ultracode: isUltracodeMode(effortMode) || params.ultracode === true,
    projectsDir,
    startAtEnd: params.startAtEnd === true,
    status: 'starting',
    capabilities,
    seenFrameKeys: new Set(),
    transcriptPath: null,
    transcriptWarned: false,
    tailer: null,
    locateTimer: null,
    bridgeServer: null,
    root: null,
    settingsPath: null,
    lastUsage: null,
  }
  sessions.set(sessionId, session)

  try {
    const bridge = await createBridge(session)
    session.bridgeServer = bridge.server
    session.bridgeUrl = bridge.url
    const files = await writeSessionSettings(session, bridge.url)
    session.root = files.root
    session.settingsPath = files.settingsPath
    startTranscriptLocator(session)
    emit('status', { sessionId, status: 'starting', cliSessionId })
    const runtimeEffort = runtimeEffortForMode(effortMode)
    log('[claude-cli] start', sessionId, JSON.stringify({
      cliSessionId,
      cwd: session.cwd,
      model: session.model || null,
      permissionMode: session.permissionMode || null,
      effort: runtimeEffort || null,
      supportsTranscript: capabilities.supportsTranscript === true,
    }))
    return {
      ok: true,
      sessionId,
      cliSessionId,
      launchMode: params.resume === true ? 'resume' : 'session',
      settingsPath: session.settingsPath,
      cliPath,
      cliVersion: capabilities.cliVersion,
      capabilities,
      bridgeUrl: isBatDebugEnabled() ? bridge.url : undefined,
    }
  } catch (err) {
    sessions.delete(sessionId)
    await cleanupSession(session)
    throw err
  }
}

export async function stopClaudeCliSession(params = {}) {
  requireDebug()
  const sessionId = String(params.sessionId || '')
  if (!sessionId) throw new Error('claudeCli.stopSession: missing sessionId')
  const session = sessions.get(sessionId)
  if (!session) return { ok: true, sessionId, existed: false }
  sessions.delete(sessionId)
  await cleanupSession(session)
  const result = { ok: true, sessionId, existed: true, status: 'stopped', cliSessionId: session.cliSessionId }
  rememberEndedSession(sessionId, result)
  emit('status', { sessionId, status: 'stopped' })
  return result
}

export async function getClaudeCliStatus(params = {}) {
  requireDebug()
  const sessionId = String(params.sessionId || '')
  const session = sessions.get(sessionId)
  if (!session) {
    pruneEndedSessions()
    const ended = endedSessions.get(sessionId)
    if (ended) return { ...ended }
    return { ok: true, sessionId, status: 'stopped' }
  }
  return {
    ok: true,
    sessionId,
    status: session.status,
    cliSessionId: session.cliSessionId,
    cliPath: session.cliPath,
    cliVersion: session.capabilities?.cliVersion || null,
    settingsPath: session.settingsPath,
    transcriptPath: session.transcriptPath,
    capabilities: session.capabilities,
    lastUsage: session.lastUsage,
  }
}

export function __resetClaudeCliSessionsForTests() {
  const current = [...sessions.values()]
  sessions.clear()
  endedSessions.clear()
  return Promise.all(current.map(cleanupSession))
}
