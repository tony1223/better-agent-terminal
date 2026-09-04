// Codex Agent sidecar manager.
//
// Renderer panels already consume the Claude-shaped event contract
// (claude:message/tool-use/stream/status/result/turn-end). Electron routes
// codex-agent sessions through a CodexAgentManager behind that same surface.
// This module mirrors that split for Tauri: claude.* handlers delegate here
// when agentPreset is codex-agent / codex-agent-worktree.

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { sendEvent } from '../lib/protocol.mjs'
import { info as logInfo, warn as logWarn, error as logError } from '../lib/logger.mjs'
import { activeWorktrees, worktreeCreate, worktreeRehydrate, worktreeGetBranch, worktreeStatus, worktreeRemove } from './worktree.mjs'

const CODEX_MODELS = [
  { value: 'gpt-6-astra', displayName: 'GPT-6 Astra', description: 'Most capable - complex, demanding work' },
  { value: 'gpt-6-astra:272k', displayName: 'GPT-6 Astra (272K)', description: 'GPT-6 Astra - 272K context window' },
  { value: 'gpt-6-astra:872k', displayName: 'GPT-6 Astra (872K)', description: 'GPT-6 Astra - 872K context window' },
  { value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Flagship - complex, open-ended work' },
  { value: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'Balanced - everyday workhorse' },
  { value: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', description: 'Fast - clear, repeatable work' },
  { value: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark', description: 'Research preview - near-instant coding' },
  { value: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Previous frontier GPT-5.5' },
  { value: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Legacy - API-key authentication only' },
  { value: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', description: 'Legacy - API-key authentication only' },
  { value: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', description: 'Legacy - API-key authentication only' },
  { value: 'codex-mini-latest', displayName: 'Codex Mini', description: 'codex-mini - optimized for code' },
  { value: 'o4-mini', displayName: 'o4-mini', description: 'OpenAI o4-mini - fast reasoning' },
  { value: 'o3', displayName: 'o3', description: 'OpenAI o3 - reasoning model' },
  { value: 'gpt-4.1', displayName: 'GPT-4.1', description: 'OpenAI GPT-4.1' },
]
const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'

// `<model>:<N>k` is a Better Agent Terminal preset (same shape as the Claude
// picker). The Tauri host translates it into the app-server's per-thread
// `model_context_window` override; the sidecar only needs to know how to split
// it so catalogs and tests agree on the convention.
export function splitCodexModelSelection(selection) {
  const match = typeof selection === 'string' ? /^(.+):(\d+)k$/.exec(selection) : null
  const thousands = match ? Number(match[2]) : 0
  if (match && thousands > 0) return { model: match[1], contextWindow: thousands * 1000 }
  return { model: selection, contextWindow: null }
}
const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])
const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const CODEX_APPROVAL_POLICIES = new Set(['untrusted', 'on-request', 'on-failure', 'never'])
const sessions = new Map()
const sdkThreadIds = new Map()

export function isCodexAgentPreset(agentPreset) {
  return agentPreset === 'codex-agent' || agentPreset === 'codex-agent-worktree'
}

export function isCodexSession(sessionId) {
  return sessions.has(sessionId)
}

function send(name, sessionId, key, value) {
  sendEvent(name, { sessionId, [key]: value })
}

function makeMetadata(overrides = {}) {
  return {
    model: DEFAULT_CODEX_MODEL,
    sdkSessionId: null,
    cwd: null,
    effort: null,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    numTurns: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    contextTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    callCacheRead: 0,
    callCacheWrite: 0,
    lastQueryCalls: 0,
    runtimeStatus: null,
    runtimeMessage: null,
    runtimeStatusStartedAt: null,
    ...overrides,
  }
}

function setRuntimeStatus(session, sessionId, status, message) {
  session.metadata.runtimeStatus = status
  session.metadata.runtimeMessage = message
  session.metadata.runtimeStatusStartedAt = Date.now()
  send('claude:status', sessionId, 'meta', { ...session.metadata })
}

function clearRuntimeStatus(session) {
  if (!session) return
  session.metadata.runtimeStatus = null
  session.metadata.runtimeMessage = null
  session.metadata.runtimeStatusStartedAt = null
}

function codexEventTurnId(event) {
  return event?.turnId || event?.turn_id || event?.id || event?.turn?.id || event?.turn?.turnId || event?.turn?.turn_id || null
}

function localTurnId(sessionId) {
  return `local-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizeEffort(effort) {
  return typeof effort === 'string' && CODEX_EFFORTS.has(effort) ? effort : 'high'
}

function normalizeSandbox(mode) {
  return typeof mode === 'string' && CODEX_SANDBOX_MODES.has(mode) ? mode : 'workspace-write'
}

function normalizeApproval(policy) {
  return typeof policy === 'string' && CODEX_APPROVAL_POLICIES.has(policy) ? policy : 'on-request'
}

function threadOptions(session) {
  const opts = {
    workingDirectory: session.cwd,
    sandboxMode: session.sandboxMode,
    approvalPolicy: session.approvalPolicy,
    modelReasoningEffort: session.effort,
    skipGitRepoCheck: true,
  }
  if (session.model) opts.model = session.model
  return opts
}

function rebuildThread(session) {
  if (!session.codexInstance) return
  if (session.threadId && typeof session.codexInstance.resumeThread === 'function') {
    session.thread = session.codexInstance.resumeThread(session.threadId, threadOptions(session))
  } else {
    session.thread = session.codexInstance.startThread(threadOptions(session))
  }
}

function addMessage(sessionId, msg) {
  const s = sessions.get(sessionId)
  if (s) {
    s.state.messages.push(msg)
    if (s.state.messages.length > 300) s.state.messages = s.state.messages.slice(-300)
  }
  send('claude:message', sessionId, 'message', msg)
}

function addToolCall(sessionId, toolCall) {
  const s = sessions.get(sessionId)
  if (s) {
    s.state.messages.push(toolCall)
    if (s.state.messages.length > 300) s.state.messages = s.state.messages.slice(-300)
  }
  send('claude:tool-use', sessionId, 'toolCall', toolCall)
}

function updateToolCall(sessionId, toolId, updates) {
  const s = sessions.get(sessionId)
  if (s) {
    const idx = s.state.messages.findIndex(m => m && 'toolName' in m && m.id === toolId)
    if (idx !== -1) s.state.messages[idx] = { ...s.state.messages[idx], ...updates }
  }
  send('claude:tool-result', sessionId, 'result', { id: toolId, ...updates })
}

function hasToolCall(sessionId, toolId) {
  const s = sessions.get(sessionId)
  return !!s?.state.messages.some(m => m && 'toolName' in m && m.id === toolId)
}

function stringifyCodexError(error, fallback = 'Unknown error') {
  let message = fallback
  if (typeof error === 'string') message = error
  else if (error instanceof Error) message = error.message || fallback
  else if (error && typeof error === 'object') {
    const nested = error.message ?? error.error ?? error.cause
    if (typeof nested === 'string') message = nested
    else {
      try { message = JSON.stringify(error) } catch { message = String(error) }
    }
  }
  if (/The model `[^`]+` does not exist or you do not have access to it/i.test(message)) {
    return `${message}\n\nHint: try upgrading codex CLI (npm i -g @openai/codex) - new models like gpt-5.6-sol need a recent CLI.`
  }
  return message
}

export function isCodexThreadNotFoundError(error) {
  const message = stringifyCodexError(error, '').toLowerCase()
  return message.includes('thread not found') || (message.includes('thread') && message.includes('not found'))
}

function recoverCodexThread(sessionId, session) {
  if (!session?.threadId || typeof session?.codexInstance?.resumeThread !== 'function') {
    return false
  }
  try {
    session.thread = session.codexInstance.resumeThread(session.threadId, threadOptions(session))
    return Boolean(session.thread)
  } catch (err) {
    logWarn(`[codex:${sessionId.slice(0, 8)}] thread resume failed: ${stringifyCodexError(err)}`)
    return false
  }
}

function extractText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n\n')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.message === 'string') return value.message
    return extractText(value.content) || extractText(value.summary)
  }
  return ''
}

function itemText(item) {
  return extractText(item?.text) || extractText(item?.content) || extractText(item?.summary)
}

function normalizeTodoItems(items) {
  return Array.isArray(items)
    ? items.map(item => ({
      content: String(item?.content ?? item?.text ?? '').trim(),
      status: item?.completed === true ? 'completed' : String(item?.status ?? 'pending'),
    })).filter(item => item.content)
    : []
}

function toolIdFor(item, prefix) {
  const raw = String(item?.id || item?.call_id || '')
  return raw ? `${prefix}:${raw}` : `${prefix}:tool-${Date.now()}`
}

function handleItemStarted(sessionId, item, state) {
  const type = item?.type
  if (type === 'agent_message') {
    state.assistantText = ''
    state.assistantId = String(item?.id || `assistant-${Date.now()}`)
    return
  }
  if (type === 'command_execution') {
    const id = toolIdFor(item, state.prefix)
    addToolCall(sessionId, { id, sessionId, toolName: 'Bash', input: { command: String(item.command || item.input || '') }, status: 'running', timestamp: Date.now() })
  } else if (type === 'file_change') {
    const id = toolIdFor(item, state.prefix)
    const path = item?.changes?.[0]?.path || ''
    addToolCall(sessionId, { id, sessionId, toolName: 'Edit', input: { file_path: path }, status: 'running', timestamp: Date.now() })
  } else if (type === 'mcp_tool_call') {
    const id = toolIdFor(item, state.prefix)
    const name = item.server ? `${item.server}/${item.tool || 'MCP'}` : item.tool || 'MCP'
    addToolCall(sessionId, { id, sessionId, toolName: name, input: item.arguments || {}, status: 'running', timestamp: Date.now() })
  } else if (type === 'web_search') {
    const id = toolIdFor(item, state.prefix)
    addToolCall(sessionId, { id, sessionId, toolName: 'WebSearch', input: { query: item.query || item?.action?.query || '' }, status: 'running', timestamp: Date.now() })
  } else if (type === 'todo_list') {
    const id = toolIdFor(item, state.prefix)
    addToolCall(sessionId, { id, sessionId, toolName: 'TodoWrite', input: { todos: normalizeTodoItems(item.items) }, status: 'running', timestamp: Date.now() })
  }
}

function handleItemUpdated(sessionId, item, state) {
  const type = item?.type
  if (type === 'agent_message') {
    const text = itemText(item)
    if (text && text.length > state.assistantText.length) {
      const delta = text.slice(state.assistantText.length)
      state.assistantText = text
      const s = sessions.get(sessionId)
      if (s) s.state.streamingText = (s.state.streamingText || '') + delta
      send('claude:stream', sessionId, 'data', { text: delta })
    }
    return
  }
  if (type === 'reasoning') {
    const thinking = itemText(item)
    if (thinking && thinking.length > state.thinkingText.length) {
      const delta = thinking.slice(state.thinkingText.length)
      state.thinkingText = thinking
      const s = sessions.get(sessionId)
      if (s) s.state.streamingThinking = (s.state.streamingThinking || '') + delta
      send('claude:stream', sessionId, 'data', { thinking: delta })
    }
    return
  }
  const id = toolIdFor(item, state.prefix)
  if (!hasToolCall(sessionId, id)) handleItemStarted(sessionId, item, state)
  if (type === 'command_execution') {
    const status = item.status === 'failed' ? 'error' : item.status === 'completed' ? 'completed' : 'running'
    updateToolCall(sessionId, id, { status, result: item.aggregated_output || item.output || undefined })
  } else if (type === 'file_change') {
    updateToolCall(sessionId, id, { status: item.status === 'failed' ? 'error' : 'running' })
  } else if (type === 'mcp_tool_call') {
    updateToolCall(sessionId, id, { status: item.status === 'failed' ? 'error' : item.status === 'completed' ? 'completed' : 'running', result: item.result ? JSON.stringify(item.result) : undefined })
  } else if (type === 'todo_list') {
    updateToolCall(sessionId, id, { input: { todos: normalizeTodoItems(item.items) }, status: 'running' })
  }
}

function handleItemCompleted(sessionId, item, state) {
  const type = item?.type
  if (type === 'agent_message') {
    const text = itemText(item) || state.assistantText
    if (text.trim()) {
      addMessage(sessionId, {
        id: `assistant-${Date.now()}`,
        sessionId,
        role: 'assistant',
        content: text,
        ...(state.thinkingText ? { thinking: state.thinkingText } : {}),
        timestamp: Date.now(),
      })
    }
    return
  }
  handleItemUpdated(sessionId, item, state)
  const id = toolIdFor(item, state.prefix)
  if (hasToolCall(sessionId, id)) {
    updateToolCall(sessionId, id, { status: item.status === 'failed' ? 'error' : 'completed' })
  }
}

async function dataUrlToTempFile(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i.exec(dataUrl || '')
  if (!match) return null
  const ext = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg'
  const dir = join(tmpdir(), 'bat-codex-images')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  await writeFile(filePath, Buffer.from(match[2], 'base64'))
  return filePath
}

function codexSessionsRoot() {
  return join(homedir(), '.codex', 'sessions')
}

async function* walkJsonlFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) yield* walkJsonlFiles(full)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full
  }
}

async function findSessionLog(threadId) {
  for await (const file of walkJsonlFiles(codexSessionsRoot())) {
    if (file.includes(threadId)) return file
    const id = await readSessionIdFromLog(file)
    if (id === threadId) return file
  }
  return null
}

async function readSessionIdFromLog(file) {
  const content = await readFile(file, 'utf-8').catch(() => '')
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      const id = entry?.type === 'session_meta' ? entry?.payload?.id : undefined
      if (typeof id === 'string' && id) return id
    } catch { /* ignore */ }
  }
  return null
}

function normalizeCodexCwdForMatch(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  let normalized = raw.replace(/\\/g, '/').replace(/\/+/g, '/')
  while (
    normalized.length > 1
    && normalized.endsWith('/')
    && !/^[A-Za-z]:\/$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

async function readSessionLines(threadId) {
  const file = await findSessionLog(threadId)
  if (!file) return []
  const content = await readFile(file, 'utf-8').catch(() => '')
  return content.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

export async function listCodexSessions(cwd = '', root = codexSessionsRoot()) {
  const targetCwd = normalizeCodexCwdForMatch(cwd)
  const results = []
  for await (const file of walkJsonlFiles(root)) {
    try {
      const st = await stat(file)
      const fallbackId = file.replace(/\.jsonl$/, '').split(/[\\/]/).pop() || ''
      const content = await readFile(file, 'utf-8').catch(() => '')
      let id = ''
      let sessionCwd = ''
      let preview = ''
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry?.type === 'session_meta') {
            if (!id && typeof entry?.payload?.id === 'string') {
              id = entry.payload.id
            }
            if (!sessionCwd && typeof entry?.payload?.cwd === 'string') {
              sessionCwd = normalizeCodexCwdForMatch(entry.payload.cwd)
            }
          }
          const input = entry?.payload?.input || entry?.payload?.message || entry?.payload?.op?.content?.find?.(c => c.type === 'input_text')?.text
          if (typeof input === 'string' && input.trim()) {
            preview = input.split('\n')[0].slice(0, 120)
          }
        } catch { /* ignore */ }
        if (id && preview) break
      }
      if (targetCwd && sessionCwd !== targetCwd) continue
      if (!id) id = fallbackId
      results.push({ sdkSessionId: id, timestamp: st.mtimeMs, preview: preview || `(${id.slice(0, 8)}...)`, messageCount: 0 })
    } catch { /* ignore */ }
  }
  return results.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50)
}

async function codexThreadExists(threadId) {
  return !!(await findSessionLog(threadId))
}

async function loadHistory(sessionId, threadId) {
  send('claude:resume-loading', sessionId, 'loading', true)
  try {
    const lines = await readSessionLines(threadId)
    const items = []
    for (const entry of lines) {
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : Date.now()
      if (entry.type !== 'event_msg') continue
      const payload = entry.payload || {}
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        items.push({ id: `hist-user-${items.length}`, sessionId, role: 'user', content: payload.message, timestamp: Number.isFinite(ts) ? ts : Date.now() })
      } else if (payload.type === 'agent_message' && typeof payload.message === 'string') {
        items.push({ id: `hist-assistant-${items.length}`, sessionId, role: 'assistant', content: payload.message, timestamp: Number.isFinite(ts) ? ts : Date.now() })
      }
    }
    const s = sessions.get(sessionId)
    if (s) s.state.messages = items.slice(-300)
    send('claude:history', sessionId, 'items', items)
  } finally {
    send('claude:resume-loading', sessionId, 'loading', false)
  }
}

async function createCodexInstance() {
  throw new Error('Codex sessions are handled by the Tauri Codex app-server runtime; the node-sidecar Codex SDK fallback has been removed.')
}

async function resolveEffectiveCwd(sessionId, options) {
  if (!options?.useWorktree) return { cwd: options.cwd }
  try {
    if (options.worktreePath && existsSync(options.worktreePath)) {
      const branchName = options.worktreeBranch || await worktreeGetBranch(options.worktreePath)
      const info = worktreeRehydrate(sessionId, options.cwd, options.worktreePath, branchName)
      return { cwd: options.worktreePath, worktreeInfo: info }
    }
    const info = await worktreeCreate(sessionId, options.cwd)
    return { cwd: info.worktreePath, worktreeInfo: info }
  } catch (err) {
    return { cwd: options.cwd, warning: `Failed to create worktree. Running in normal mode.\n${stringifyCodexError(err)}` }
  }
}

export async function startCodexSession(params) {
  const sessionId = params?.sessionId
  const options = params?.options || {}
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('codex.startSession: missing sessionId')
  if (sessions.has(sessionId)) return { ok: true, sessionId }
  if (typeof options.cwd !== 'string' || !options.cwd) throw new Error('codex.startSession: missing cwd')

  const model = typeof options.model === 'string' && options.model ? options.model : DEFAULT_CODEX_MODEL
  const { cwd, worktreeInfo, warning } = await resolveEffectiveCwd(sessionId, options)
  const session = {
    abortController: new AbortController(),
    state: { sessionId, messages: [], isStreaming: false },
    cwd,
    originalCwd: options.cwd,
    worktreeInfo,
    sandboxMode: normalizeSandbox(options.codexSandboxMode),
    approvalPolicy: normalizeApproval(options.codexApprovalPolicy),
    model,
    effort: normalizeEffort(options.effort),
    metadata: makeMetadata({ model, cwd, effort: normalizeEffort(options.effort) }),
    startTime: Date.now(),
    isRunning: false,
    currentTurnId: null,
    messageQueue: [],
  }
  sessions.set(sessionId, session)

  addMessage(sessionId, {
    id: `sys-init-${sessionId}`,
    sessionId,
    role: 'system',
    content: `Codex session started (sandbox: ${session.sandboxMode}, approval: ${session.approvalPolicy})${worktreeInfo ? ` [worktree: ${worktreeInfo.branchName}]` : ''}`,
    timestamp: Date.now(),
  })
  if (worktreeInfo) {
    send('claude:worktree-info', sessionId, 'payload', {
      branchName: worktreeInfo.branchName,
      worktreePath: worktreeInfo.worktreePath,
      sourceBranch: worktreeInfo.sourceBranch,
      gitRoot: worktreeInfo.gitRoot,
    })
  }
  if (warning) {
    addMessage(sessionId, { id: `sys-worktree-warn-${sessionId}`, sessionId, role: 'system', content: warning, timestamp: Date.now() })
  }

  try {
    session.codexInstance = await createCodexInstance()
    const savedThreadId = sdkThreadIds.get(sessionId)
    const canResume = savedThreadId ? await codexThreadExists(savedThreadId) : false
    if (savedThreadId && !canResume) {
      sdkThreadIds.delete(sessionId)
      logWarn(`[codex:${sessionId.slice(0, 8)}] resume skipped: missing rollout for thread ${savedThreadId}`)
      send('claude:status', sessionId, 'meta', { ...session.metadata, sdkSessionId: null })
    }
    session.thread = canResume
      ? session.codexInstance.resumeThread(savedThreadId, threadOptions(session))
      : session.codexInstance.startThread(threadOptions(session))
    const threadId = session.thread?.id
    if (threadId) {
      session.threadId = threadId
      session.metadata.sdkSessionId = threadId
      sdkThreadIds.set(sessionId, threadId)
    }
    send('claude:status', sessionId, 'meta', { ...session.metadata })
    if (options.prompt) await sendCodexMessage({ sessionId, prompt: options.prompt })
    return { ok: true, sessionId }
  } catch (err) {
    sessions.delete(sessionId)
    const message = `Failed to start Codex: ${stringifyCodexError(err)}`
    logError(`[codex:${sessionId.slice(0, 8)}] ${message}`)
    send('claude:error', sessionId, 'error', message)
    return { ok: false, error: message }
  }
}

export async function resumeCodexSession(params) {
  const sessionId = params?.sessionId
  const threadId = params?.sdkSessionId
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('codex.resumeSession: missing sessionId')
  if (typeof threadId !== 'string' || !threadId) throw new Error('codex.resumeSession: missing thread id')
  const canResume = await codexThreadExists(threadId)
  if (!canResume) {
    const existing = sessions.get(sessionId)
    if (existing) {
      existing.abortController.abort()
      sessions.delete(sessionId)
    }
    sdkThreadIds.delete(sessionId)
    logWarn(`[codex:${sessionId.slice(0, 8)}] resume skipped: missing rollout for thread ${threadId}`)
    send('claude:resume-loading', sessionId, 'loading', false)
    send('claude:status', sessionId, 'meta', { ...makeMetadata({ cwd: params?.options?.cwd || null }), sdkSessionId: null })
    return startCodexSession({ sessionId, options: params?.options || {} })
  }
  sdkThreadIds.set(sessionId, threadId)
  send('claude:resume-loading', sessionId, 'loading', true)
  const result = await startCodexSession({ sessionId, options: params?.options || {} })
  if (result?.ok) {
    const s = sessions.get(sessionId)
    if (s) {
      s.threadId = threadId
      s.metadata.sdkSessionId = threadId
    }
    await loadHistory(sessionId, threadId).catch(err => {
      logWarn(`[codex:${sessionId.slice(0, 8)}] load history failed: ${stringifyCodexError(err)}`)
    })
  } else {
    send('claude:resume-loading', sessionId, 'loading', false)
  }
  return result
}

export async function sendCodexMessage(params) {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('codex.sendMessage: missing sessionId')
  const session = sessions.get(sessionId)
  if (!session?.thread) return { ok: false, error: 'Codex session not started' }
  let prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : ''
  const images = Array.isArray(params?.images) ? params.images : []
  if (!prompt && images.length > 0) prompt = 'Please analyze the attached image.'
  if (!prompt) return { ok: false, error: 'empty prompt' }

  if (session.isRunning) {
    session.abortController.abort()
    session.messageQueue = []
  }
  session.abortController = new AbortController()
  session.isRunning = true
  session.currentTurnId = localTurnId(sessionId)
  session.state.isStreaming = true
  session.state.streamingText = ''
  session.state.streamingThinking = ''
  const ctrl = session.abortController
  setRuntimeStatus(session, sessionId, 'waiting_for_api', 'Still waiting for Codex API response.')

  if (!params?._suppressUserEcho) {
    addMessage(sessionId, {
      id: `user-${Date.now()}`,
      sessionId,
      role: 'user',
      content: prompt + (images.length ? `\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : ''),
      timestamp: Date.now(),
    })
  }

  const tempImages = []
  try {
    for (const image of images) {
      const file = await dataUrlToTempFile(image)
      if (file) tempImages.push(file)
    }

    const input = tempImages.length > 0
      ? [...tempImages.map(path => ({ type: 'local_image', path })), { type: 'text', text: prompt }]
      : prompt
    const startedAt = Date.now()
    const state = { prefix: `turn-${startedAt.toString(36)}`, assistantText: '', thinkingText: '' }
    const { events } = await session.thread.runStreamed(input, { signal: ctrl.signal })
    let completed = false
    logInfo(`[codex:${sessionId.slice(0, 8)}] send start promptLen=${prompt.length} images=${tempImages.length}`)

    for await (const event of events) {
      if (ctrl.signal.aborted || session.abortController !== ctrl) break
      const type = event?.type
      if (type === 'thread.started') {
        const threadId = event.thread_id || event.threadId
        if (threadId) {
          session.threadId = threadId
          session.metadata.sdkSessionId = threadId
          sdkThreadIds.set(sessionId, threadId)
          send('claude:status', sessionId, 'meta', { ...session.metadata })
        }
      } else if (type === 'turn.started') {
        session.currentTurnId = codexEventTurnId(event) || session.currentTurnId
        session.metadata.numTurns += 1
      } else if (type === 'item.started') {
        clearRuntimeStatus(session)
        handleItemStarted(sessionId, event.item || {}, state)
      } else if (type === 'item.updated') {
        clearRuntimeStatus(session)
        handleItemUpdated(sessionId, event.item || {}, state)
      } else if (type === 'item.completed') {
        handleItemCompleted(sessionId, event.item || {}, state)
      } else if (type === 'turn.completed') {
        completed = true
        const turnId = codexEventTurnId(event) || session.currentTurnId
        const usage = event.usage || {}
        const turnInputTokens = usage.input_tokens || 0
        const turnOutputTokens = usage.output_tokens || 0
        session.metadata.inputTokens += turnInputTokens
        session.metadata.outputTokens += turnOutputTokens
        session.metadata.cacheReadTokens += usage.cached_input_tokens || 0
        // contextTokens is the latest turn's footprint, not the lifetime sum —
        // ctx% divides it by one context window. Cached input is a subset of
        // input_tokens in the Codex protocol, so adding it again double-counts.
        // Mirrors CodexSession::metadata in src-tauri/src/codex_app_server.rs.
        session.metadata.contextTokens = turnInputTokens + turnOutputTokens
        session.metadata.lastQueryCalls = 1
        session.metadata.durationMs = Date.now() - (session.startTime || startedAt)
        session.metadata.lastTurnDurationMs = Date.now() - startedAt
        clearRuntimeStatus(session)
        send('claude:status', sessionId, 'meta', { ...session.metadata })
        send('claude:result', sessionId, 'result', { subtype: 'success', result: state.assistantText || undefined, totalCost: session.metadata.totalCost })
        send('claude:turn-end', sessionId, 'payload', { reason: 'completed', result: state.assistantText || undefined, sdkSessionId: session.threadId, turnId })
        session.currentTurnId = null
      } else if (type === 'turn.failed') {
        const turnId = codexEventTurnId(event) || session.currentTurnId
        const message = stringifyCodexError(event.error, 'Turn failed')
        send('claude:error', sessionId, 'error', message)
        send('claude:turn-end', sessionId, 'payload', { reason: 'error', error: message, turnId, sdkSessionId: session.threadId })
        session.currentTurnId = null
      } else if (type === 'error') {
        send('claude:error', sessionId, 'error', stringifyCodexError(event.message ?? event.error))
      }
    }
    if (!completed && !ctrl.signal.aborted) {
      send('claude:error', sessionId, 'error', 'Codex turn ended unexpectedly.')
      send('claude:turn-end', sessionId, 'payload', { reason: 'error', turnId: session.currentTurnId, sdkSessionId: session.threadId })
      session.currentTurnId = null
    }
    logInfo(`[codex:${sessionId.slice(0, 8)}] send end completed=${completed}`)
    return { ok: true }
  } catch (err) {
    if (!ctrl.signal.aborted) {
      if (!params?._retriedAfterThreadResume && isCodexThreadNotFoundError(err) && recoverCodexThread(sessionId, session)) {
        logWarn(`[codex:${sessionId.slice(0, 8)}] thread not found; resumed ${session.threadId} and retrying turn`)
        setRuntimeStatus(session, sessionId, 'starting', 'Resuming Codex thread before retrying the API request.')
        return sendCodexMessage({
          ...params,
          _retriedAfterThreadResume: true,
          _suppressUserEcho: true,
        })
      }
      const message = `Codex error: ${stringifyCodexError(err)}`
      logError(`[codex:${sessionId.slice(0, 8)}] ${message}`)
      send('claude:error', sessionId, 'error', message)
      send('claude:turn-end', sessionId, 'payload', { reason: 'error', error: message, turnId: session.currentTurnId, sdkSessionId: session.threadId })
      session.currentTurnId = null
      return { ok: false, error: message }
    }
    send('claude:turn-end', sessionId, 'payload', { reason: 'aborted', turnId: session.currentTurnId, sdkSessionId: session.threadId })
    session.currentTurnId = null
    return { ok: true, aborted: true }
  } finally {
    for (const file of tempImages) unlink(file).catch(() => {})
    if (session.abortController === ctrl) {
      clearRuntimeStatus(session)
      session.isRunning = false
      session.state.isStreaming = false
      session.state.streamingText = ''
      session.state.streamingThinking = ''
    }
  }
}

export function stopCodexSession(params) {
  const sessionId = params?.sessionId
  const session = sessions.get(sessionId)
  if (!session) return { ok: true, existed: false }
  session.abortController.abort()
  sessions.delete(sessionId)
  return { ok: true, existed: true }
}

export function abortCodexSession(params) {
  const sessionId = params?.sessionId
  const session = sessions.get(sessionId)
  if (!session) return { ok: true }
  session.abortController.abort()
  session.isRunning = false
  session.state.isStreaming = false
  send('claude:turn-end', sessionId, 'payload', { reason: 'aborted', turnId: session.currentTurnId, sdkSessionId: session.threadId })
  session.currentTurnId = null
  return { ok: true }
}

export function resetCodexSession(params) {
  const sessionId = params?.sessionId
  const session = sessions.get(sessionId)
  if (!session) return false
  session.abortController.abort()
  session.abortController = new AbortController()
  session.state = { sessionId, messages: [], isStreaming: false }
  session.metadata = makeMetadata({ model: session.model, cwd: session.cwd, effort: session.effort })
  session.threadId = undefined
  session.currentTurnId = null
  session.metadata.sdkSessionId = null
  sdkThreadIds.delete(sessionId)
  rebuildThread(session)
  sendEvent('claude:session-reset', { sessionId })
  send('claude:status', sessionId, 'meta', { ...session.metadata })
  return true
}

export function getCodexSessionState(params) {
  const sessionId = String(params?.sessionId ?? '')
  const session = sessions.get(sessionId)
  if (!session) return null
  return {
    ...session.state,
    model: session.model ?? null,
    effort: session.effort ?? null,
    codexSandboxMode: session.sandboxMode ?? null,
    codexApprovalPolicy: session.approvalPolicy ?? null,
  }
}

export function getCodexSessionMeta(params) {
  const sessionId = String(params?.sessionId ?? '')
  const session = sessions.get(sessionId)
  return session ? { ...session.metadata } : null
}

export function getCodexSupportedModels() {
  return CODEX_MODELS.map(model => ({ ...model, source: 'builtin' }))
}

export function setCodexModel(params) {
  const session = sessions.get(params?.sessionId)
  if (!session || typeof params?.model !== 'string') return false
  session.model = params.model
  session.metadata.model = params.model
  rebuildThread(session)
  send('claude:status', params.sessionId, 'meta', { ...session.metadata })
  return true
}

export function setCodexEffort(params) {
  const session = sessions.get(params?.sessionId)
  if (!session) return false
  session.effort = normalizeEffort(params?.effort)
  session.metadata.effort = session.effort
  rebuildThread(session)
  send('claude:status', params.sessionId, 'meta', { ...session.metadata })
  return true
}

export function setCodexSandboxMode(params) {
  const session = sessions.get(params?.sessionId)
  if (!session) return false
  session.sandboxMode = normalizeSandbox(params?.mode)
  rebuildThread(session)
  return true
}

export function setCodexApprovalPolicy(params) {
  const session = sessions.get(params?.sessionId)
  if (!session) return false
  session.approvalPolicy = normalizeApproval(params?.policy)
  rebuildThread(session)
  return true
}

export function restCodexSession(params) {
  const session = sessions.get(params?.sessionId)
  if (!session) return false
  session.abortController.abort()
  session.isResting = true
  session.thread = null
  session.codexInstance = null
  return true
}

export async function wakeCodexSession(params) {
  const session = sessions.get(params?.sessionId)
  if (!session) return false
  session.isResting = false
  if (!session.codexInstance) session.codexInstance = await createCodexInstance()
  rebuildThread(session)
  return true
}

export function isCodexResting(params) {
  return sessions.get(params?.sessionId)?.isResting === true
}

export async function cleanupCodexWorktree(params) {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string') return false
  await worktreeRemove(sessionId, params?.deleteBranch !== false)
  const session = sessions.get(sessionId)
  if (session) session.worktreeInfo = undefined
  send('claude:worktree-info', sessionId, 'payload', null)
  return true
}

export function getCodexWorktreeStatus(params) {
  const sessionId = params?.sessionId
  if (!activeWorktrees.has(sessionId)) return null
  return worktreeStatus(sessionId)
}
