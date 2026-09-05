// claude.* history surgery + archive handlers:
// rewindToPrompt, forkSession, fetchSubagentMessages, archiveMessages,
// loadArchived, clearArchive.

import { readFile, appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { sessions, buildSessionMeta, resetSessionTranscript } from '../lib/state.mjs'
import { __resolveProjectsDir, archiveFilePath, resolveDataDir } from '../lib/data-paths.mjs'
import { loadAnthropicSdk } from '../lib/sdk-loader.mjs'
import { warn as logWarn } from '../lib/logger.mjs'
import { stripTaskNotifications, isHarnessNoiseUserText, isCompactSummaryUserText } from '../lib/harness-noise.mjs'
import { resolveClaudeCliBinaryWithInstall } from './claude-auth.mjs'
import { writeTranscriptSnapshot } from '../lib/transcript-transfer.mjs'

function historyProjectDirCandidates(cwd) {
  const encoded = String(cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
  const dirs = [join(__resolveProjectsDir(), encoded)]
  if (process.platform === 'win32' && encoded.length > 0) {
    const lower = encoded[0].toLowerCase() + encoded.slice(1)
    const upper = encoded[0].toUpperCase() + encoded.slice(1)
    if (lower !== encoded) dirs.push(join(__resolveProjectsDir(), lower))
    if (upper !== encoded) dirs.push(join(__resolveProjectsDir(), upper))
  }
  return dirs
}

async function readHistoryFile(sdkSessionId, cwd, opts = {}) {
  const allowFallback = opts.allowGlobalFallback !== false
  for (const dir of historyProjectDirCandidates(cwd)) {
    try {
      return await readFile(join(dir, `${sdkSessionId}.jsonl`), 'utf-8')
    } catch {
      // Try the next project-dir casing candidate.
    }
  }
  if (!allowFallback) return null
  const fallback = await findHistoryFileBySessionId(sdkSessionId)
  if (fallback) {
    logWarn(`claude.readHistoryFile: cwd lookup missed ${sdkSessionId}; using ${fallback}`)
    return await readFile(fallback, 'utf-8')
  }
  return null
}

async function findHistoryFileBySessionId(sdkSessionId) {
  const filename = `${sdkSessionId}.jsonl`
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isFile() && entry.name === filename) return full
      if (entry.isDirectory()) {
        const found = await walk(full)
        if (found) return found
      }
    }
    return null
  }
  return walk(__resolveProjectsDir())
}

registerHandler('claude.exportTranscript', async (params) => {
  const sessionId = params?.sessionId
  const session = sessions.get(sessionId)
  const sdkSessionId = session?.sdkSessionId
  const cwd = session?.options?.cwd
  if (!session || typeof sdkSessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sdkSessionId) || typeof cwd !== 'string' || !cwd) {
    throw new Error('Claude transcript is unavailable. Resume the source session before handing it off.')
  }
  if (session.streaming) throw new Error('Wait for the Claude turn to stop before handing it off.')
  const raw = await readHistoryFile(sdkSessionId, cwd)
  if (raw === null) throw new Error('Claude transcript was not found on disk. The session has not been handed off.')
  if (sessions.get(sessionId) !== session || session.sdkSessionId !== sdkSessionId || session.streaming) {
    throw new Error('The Claude session changed during export. Wait for it to stop and try again.')
  }
  return writeTranscriptSnapshot(raw, { sourceSessionId: sessionId, sourceSdkSessionId: sdkSessionId, cwd }, resolveDataDir())
})

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

function historyItemsFromJsonl(raw, sessionId) {
  const items = []
  const toolIndexMap = new Map()
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
    if (obj.type === 'user' && obj.message?.role === 'user') {
      const content = obj.message.content
      const text = stripTaskNotifications(textFromContent(content))
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const idx = toolIndexMap.get(block.tool_use_id)
            if (idx !== undefined) {
              const tool = items[idx]
              tool.status = block.is_error ? 'error' : 'completed'
              const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
              tool.result = (resultText || '').slice(0, 2000)
            }
          }
        }
      }
      if (!isHarnessNoiseUserText(text)) {
        items.push({
          id: obj.uuid || `hist-user-${items.length}`,
          sessionId,
          role: 'user',
          content: text,
          timestamp: ts,
          // Kept in the timeline (the model really was prompted with it) but
          // tagged, so the UI folds it instead of passing a 15k-character
          // summary off as something the human typed.
          ...(isCompactSummaryUserText(text, obj) ? { isCompactSummary: true } : {}),
        })
      }
      continue
    }
    if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
      const content = obj.message.content
      if (!Array.isArray(content)) continue
      const thinking = content
        .filter(b => b && b.type === 'thinking')
        .map(b => (typeof b.thinking === 'string' ? b.thinking : ''))
        .join('\n')
        .trim()
      const text = textFromContent(content)
        .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
        .replace(/Full transcript available at:.*$/gm, '')
        .trim()
      if ((text || thinking) && text !== 'No response requested.') {
        items.push({
          id: `${obj.uuid || 'hist'}-text-${items.length}`,
          sessionId,
          role: 'assistant',
          content: text || '',
          ...(thinking ? { thinking } : {}),
          ...(obj.parent_tool_use_id ? { parentToolUseId: obj.parent_tool_use_id } : {}),
          timestamp: ts,
        })
      }
      for (const block of content) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') {
          const toolItem = {
            id: block.id,
            sessionId,
            toolName: block.name,
            input: block.input || {},
            status: 'completed',
            ...(obj.parent_tool_use_id ? { parentToolUseId: obj.parent_tool_use_id } : {}),
            timestamp: ts,
          }
          toolIndexMap.set(block.id, items.length)
          items.push(toolItem)
        }
      }
      continue
    }
    if (obj.type === 'system') {
      const text = textFromContent(obj.message?.content)
      if (text && !text.startsWith('{') && text.length > 5) {
        items.push({
          id: obj.uuid || `hist-sys-${items.length}`,
          sessionId,
          role: 'system',
          content: text,
          timestamp: ts,
        })
      }
    }
  }
  return items
}

// What we still hold in memory for a session. Used only when the on-disk
// transcript cannot be read: it is a partial answer (capped, and empty for a
// session this process never ran) but it is never a *wrong* one, and it beats
// telling the client the conversation is empty.
//
// Looked up at the point of use rather than once up front — the disk read is
// awaited in between, and a concurrent resume can replace the session record
// while it is in flight.
function rememberedTranscript(sessionId) {
  const session = sessions.get(sessionId)
  return Array.isArray(session?.messages) ? session.messages : []
}

export async function loadSessionHistory(sessionId, sdkSessionId, cwd, opts = {}) {
  sendEvent('claude:resume-loading', { sessionId, loading: true })
  try {
    const raw = await readHistoryFile(sdkSessionId, cwd, opts)
    const session = sessions.get(sessionId)
    // A transcript we could not find is not a transcript we know to be empty.
    // The file lives at a path derived from the cwd, so a moved worktree, a
    // drive-letter casing difference or a session first run elsewhere all read
    // as "no file". Treating that as "no history" used to reset the host's own
    // in-memory copy — so a phone opening the session emptied it on the desktop
    // too, and the phone got [] with only a `found: false` it had no reason to
    // inspect (GH #125).
    if (raw === null) {
      const remembered = rememberedTranscript(sessionId)
      logWarn(`claude.loadSessionHistory(${sessionId}): no transcript on disk for ${sdkSessionId}; replaying ${remembered.length} in-memory message(s)`)
      sendEvent('claude:history', { sessionId, items: remembered })
      return { ok: true, found: false, itemCount: remembered.length }
    }
    const items = historyItemsFromJsonl(raw, sessionId)
    // `preserveLiveMessages` is set by claude.clientResume when a remote
    // client re-opens a session whose turn is still streaming here: re-emit
    // the persisted history to that client WITHOUT clobbering the running
    // session's in-memory transcript (which would drop live-streamed turns).
    if (session && !opts.preserveLiveMessages) {
      resetSessionTranscript(session)
      session.messages = items.slice(-300)
    }
    sendEvent('claude:history', { sessionId, items })
    return { ok: true, found: true, itemCount: items.length }
  } catch (err) {
    // Same reasoning as the not-found path: a read that blew up says nothing
    // about whether the conversation happened.
    const remembered = rememberedTranscript(sessionId)
    logWarn(`claude.loadSessionHistory: ${err instanceof Error ? err.message : String(err)}`)
    sendEvent('claude:history', { sessionId, items: remembered })
    return { ok: false, found: false, itemCount: remembered.length, error: err instanceof Error ? err.message : String(err) }
  } finally {
    sendEvent('claude:resume-loading', { sessionId, loading: false })
  }
}

// claude.rewindToPrompt: cut the SDK session's JSONL transcript at a
// given user-prompt index, write a fresh transcript under a new
// SDK session id, and rewire the in-memory session to the new id so
// the next sendMessage continues from the truncated history. Mirror
// of electron/claude-agent-manager.ts:2647. Pure file-system + JSON
// surgery — no SDK call, no network — so it stays fast and
// deterministic in tests. Cwd-name encoding matches the Claude CLI's
// scheme: replace anything not [a-zA-Z0-9] with '-'.
//
// Override hook for tests: __setProjectsDirOverrideForTests(path)
// swaps `~/.claude/projects` for a tmpdir.
registerHandler('claude.rewindToPrompt', async (params) => {
  const sessionId = params?.sessionId
  const promptIndex = params?.promptIndex
  if (typeof sessionId !== 'string' || !sessionId) {
    return { error: 'rewindToPrompt: missing sessionId' }
  }
  if (typeof promptIndex !== 'number' || promptIndex < 0) {
    return { error: 'rewindToPrompt: promptIndex must be a non-negative number' }
  }
  const session = sessions.get(sessionId)
  if (!session) return { error: 'Session not found' }
  if (session.streaming) {
    return { error: 'Cannot rewind while Claude is responding — stop the current turn first.' }
  }
  const currentSdkId = session.sdkSessionId
  if (!currentSdkId) return { error: 'No SDK session to rewind' }
  const cwd = (session.options && typeof session.options === 'object' && typeof session.options.cwd === 'string')
    ? session.options.cwd
    : null
  if (!cwd) return { error: 'rewindToPrompt: session has no cwd' }
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const projectDir = join(__resolveProjectsDir(), encoded)
  const filePath = join(projectDir, `${currentSdkId}.jsonl`)

  let raw
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return { error: `Session history file not found: ${filePath}` }
  }
  const lines = raw.split('\n').filter(l => l.trim())

  // Find cutoff: the (promptIndex)-th text-bearing user prompt.
  let userPromptCount = 0
  let cutoffIdx = -1
  for (let i = 0; i < lines.length; i++) {
    let obj
    try { obj = JSON.parse(lines[i]) } catch { continue }
    if (obj?.type !== 'user' || obj?.message?.role !== 'user') continue
    const msgContent = obj.message.content
    let hasText = false
    if (typeof msgContent === 'string' && msgContent.length > 0) {
      hasText = true
    } else if (Array.isArray(msgContent)) {
      hasText = msgContent.some(b => b && b.type === 'text')
    }
    if (!hasText) continue
    if (userPromptCount === promptIndex) { cutoffIdx = i; break }
    userPromptCount++
  }
  if (cutoffIdx === -1) {
    return { error: `Prompt index ${promptIndex} not found (only ${userPromptCount} user prompt(s) in history)` }
  }

  const keptLines = lines.slice(0, cutoffIdx)
  const { randomUUID } = await import('node:crypto')
  const { writeFile } = await import('node:fs/promises')
  const newSdkSessionId = randomUUID()

  // Rewrite each line so any embedded sessionId points to the new id.
  // The Claude CLI looks for sessionId fields keyed in the message
  // metadata; rewrite defensively (no-op when the key is absent).
  const rewritten = keptLines.map((line) => {
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj.sessionId === 'string') obj.sessionId = newSdkSessionId
      return JSON.stringify(obj)
    } catch {
      return line
    }
  })
  const newFilePath = join(projectDir, `${newSdkSessionId}.jsonl`)
  await writeFile(
    newFilePath,
    rewritten.join('\n') + (rewritten.length > 0 ? '\n' : ''),
    'utf-8',
  )

  // Wire the in-memory session to the new transcript so the next
  // sendMessage's `resume:` picks it up.
  if (session.abortController) {
    try { session.abortController.abort() } catch { /* already aborted */ }
  }
  session.abortController = null
  session.sdkSessionId = newSdkSessionId
  // Best-effort: notify renderers that the session metadata changed.
  // Use the full shape so ClaudeAgentPanel's status line doesn't crash
  // on .inputTokens.toLocaleString() etc.
  sendEvent('claude:status', { sessionId, meta: buildSessionMeta(session) })
  const removedPromptCount = lines.length - cutoffIdx
  return { newSdkSessionId, removedPromptCount }
})

// claude.forkSession: ask the SDK to fork the current SDK session id —
// produces a new sdkSessionId whose transcript starts identical to the
// original at the time of the fork. Mirror of
// electron/claude-agent-manager.ts:2733. Underlying contract is the
// SDK's `forkSession: true` query option: spawn a one-turn query with
// `resume: currentSdkId, forkSession: true, maxTurns: 1, prompt: ' '`,
// capture the new session_id off `system:init`, but **wait until the
// result message** before bailing — the CLI only persists the forked
// transcript file (`<newId>.jsonl`) after at least one turn completes.
// Aborting on init leaves an unresumable id.
//
// 60s safety timeout aborts a runaway fork so we don't hang the
// session forever.
const FORK_TIMEOUT_MS = 60_000
registerHandler('claude.forkSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return null
  const session = sessions.get(sessionId)
  const currentSdkId = session?.sdkSessionId
  if (!currentSdkId) return null
  const sdk = await loadAnthropicSdk()
  if (!sdk || typeof sdk.query !== 'function') return null
  const cwd = (session?.options && typeof session.options === 'object' && typeof session.options.cwd === 'string')
    ? session.options.cwd
    : process.cwd()
  const claudeCodePath = await resolveClaudeCliBinaryWithInstall()
  const abortController = new AbortController()
  const timeoutHandle = setTimeout(() => {
    if (!abortController.signal.aborted) {
      try { abortController.abort() } catch { /* already aborted */ }
    }
  }, FORK_TIMEOUT_MS)
  let newSdkSessionId = null
  try {
    const generator = sdk.query({
      prompt: ' ',
      options: {
        abortController,
        cwd,
        resume: currentSdkId,
        forkSession: true,
        maxTurns: 1,
        ...(claudeCodePath ? { pathToClaudeCodeExecutable: claudeCodePath } : {}),
      },
    })
    for await (const msg of generator) {
      if (msg?.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
        newSdkSessionId = msg.session_id
      } else if (msg?.type === 'result') {
        // Wait for result before breaking — that's the signal the CLI
        // has finished writing the new transcript file.
        break
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const isAbort = abortController.signal.aborted || /aborted/i.test(errMsg)
    if (!isAbort) {
      logWarn(`claude.forkSession: ${errMsg}`)
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
  if (!newSdkSessionId) return null
  return { newSdkSessionId }
})

// claude.fetchSubagentMessages: load the messages a subagent (Agent/Task
// tool) produced during its turn so the renderer can expand the active-
// task panel into a per-message view. Mirror of
// electron/claude-agent-manager.ts:2558. The SDK exports
// `getSubagentMessages(sdkSessionId, agentToolUseId, {dir})` which reads
// the on-disk transcript shard the CLI wrote during the parent run; we
// then normalise raw user/assistant messages into the renderer's
// (ClaudeMessage | ClaudeToolCall)[] shape so it can render them with
// the same components as the parent thread.
//
// Tool-result content is folded back into the matching tool-use entry
// (status: 'completed' | 'error', result truncated to 2000 chars) so the
// UI keeps the "tool ran → result" pairing instead of showing a bare
// user-role message with embedded tool_result blocks.
//
// Returns [] for any failure (no SDK, no sdkSessionId, SDK throws,
// missing helper) — same contract as Electron.
registerHandler('claude.fetchSubagentMessages', async (params) => {
  const sessionId = params?.sessionId
  const agentToolUseId = params?.agentToolUseId
  if (typeof sessionId !== 'string' || !sessionId) return []
  if (typeof agentToolUseId !== 'string' || !agentToolUseId) return []
  const session = sessions.get(sessionId)
  const sdkSid = session?.sdkSessionId
  if (!sdkSid) return []
  const sdk = await loadAnthropicSdk()
  if (!sdk || typeof sdk.getSubagentMessages !== 'function') return []
  const cwd = (session?.options && typeof session.options === 'object' && typeof session.options.cwd === 'string')
    ? session.options.cwd
    : undefined
  let messages
  try {
    messages = await sdk.getSubagentMessages(sdkSid, agentToolUseId, cwd ? { dir: cwd } : undefined)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logWarn(`claude.fetchSubagentMessages: ${errMsg}`)
    return []
  }
  if (!Array.isArray(messages)) return []
  const items = []
  const toolIndexMap = new Map()
  for (const msg of messages) {
    const ts = msg?.timestamp ? new Date(msg.timestamp).getTime() : Date.now()
    if (msg?.type === 'user') {
      const content = msg?.message?.content
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        const textBlock = content.find(b => b && b.type === 'text')
        if (textBlock && typeof textBlock.text === 'string') text = textBlock.text
        for (const block of content) {
          if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const idx = toolIndexMap.get(block.tool_use_id)
            if (idx !== undefined) {
              const tool = items[idx]
              tool.status = block.is_error ? 'error' : 'completed'
              const resultText = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content)
              tool.result = (resultText || '').slice(0, 2000)
            }
          }
        }
      }
      const userText = stripTaskNotifications(text)
      if (!isHarnessNoiseUserText(userText)) {
        items.push({
          id: `sa-user-${items.length}`,
          sessionId, role: 'user', content: userText,
          parentToolUseId: agentToolUseId, timestamp: ts,
          ...(isCompactSummaryUserText(userText, msg) ? { isCompactSummary: true } : {}),
        })
      }
    } else if (msg?.type === 'assistant') {
      const content = msg?.message?.content
      if (Array.isArray(content)) {
        const thinkingText = content
          .filter(b => b && b.type === 'thinking')
          .map(b => (typeof b.thinking === 'string' ? b.thinking : ''))
          .join('\n').trim()
        const assistantText = content
          .filter(b => b && b.type === 'text')
          .map(b => (typeof b.text === 'string' ? b.text : ''))
          .join('\n').trim()
        if (assistantText || thinkingText) {
          items.push({
            id: `sa-asst-${items.length}`,
            sessionId, role: 'assistant',
            content: assistantText || '',
            ...(thinkingText ? { thinking: thinkingText } : {}),
            parentToolUseId: agentToolUseId, timestamp: ts,
          })
        }
        for (const block of content) {
          if (block && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            const toolItem = {
              id: block.id, sessionId, toolName: block.name,
              input: block.input || {}, status: 'completed',
              parentToolUseId: agentToolUseId, timestamp: ts,
            }
            toolIndexMap.set(block.id, items.length)
            items.push(toolItem)
          }
        }
      }
    }
  }
  return items
})

// claude.archiveMessages / loadArchived / clearArchive: per-session
// JSONL archive at `<dataDir>/message-archives/<sessionId>.jsonl`.
// Mirror of electron/server-core/register-handlers.ts:505+. The
// renderer uses these to compact long conversations: archive flushes
// off-screen messages to disk, loadArchived pages them back from the
// tail, clear removes the file when the session is reset.
//
// Pure fs ops — no SDK involvement. Path validation is per-session-id
// only (alpha-numeric segment) so a malicious sessionId can't escape
// the archive dir; sessionId is a UUID-or-similar string anyway.
// Ids already on disk, per session. The archive is append-only, and the
// renderer flushes whatever is currently off-screen — an assumption that holds
// only while `messages` grows by new rows. It does not: hydrating a panel
// replaces `messages` with the host's last 300, which already includes archived
// rows, so every hydrate used to append a second copy of that window. A remote
// reconnect re-hydrates, so the file grew by a window per reconnect, forever,
// and the same message rendered N times.
//
// Deduping here rather than only in the renderer is deliberate: this is the one
// place every client funnels through, so old clients are covered too, and the
// guarantee survives a renderer that loses its own bookkeeping across remounts.
// First write wins — a re-archived row is by definition already stored.
const archivedIdsBySession = new Map()

// Seeded once per session from the file, then maintained in memory. Returns a
// promise (not a Set) so concurrent flushes share one read instead of racing to
// seed and each concluding the file was empty.
function archivedIds(sessionId) {
  let pending = archivedIdsBySession.get(sessionId)
  if (!pending) {
    pending = readFile(archiveFilePath(sessionId), 'utf-8').then(raw => {
      const ids = new Set()
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const id = JSON.parse(line)?.id
          if (typeof id === 'string') ids.add(id)
        } catch { /* malformed line — nothing to dedupe against */ }
      }
      return ids
      // ENOENT simply means nothing has been archived yet.
    }).catch(() => new Set())
    archivedIdsBySession.set(sessionId, pending)
  }
  return pending
}

registerHandler('claude.archiveMessages', async (params) => {
  const sessionId = params?.sessionId
  const messages = params?.messages
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (!Array.isArray(messages)) return false
  const dir = join(resolveDataDir(), 'message-archives')
  try {
    await mkdir(dir, { recursive: true })
    const seen = await archivedIds(sessionId)
    // Ids staged separately and only committed once the write lands. Marking
    // them seen up front would make a failed append permanent: the retry would
    // filter out the very rows that never reached disk.
    const staged = new Set()
    // A row with no id cannot be deduped, so it is written through rather than
    // dropped: losing history is worse than storing it twice.
    const fresh = messages.filter(m => {
      const id = m?.id
      if (typeof id !== 'string') return true
      if (seen.has(id) || staged.has(id)) return false
      staged.add(id)
      return true
    })
    if (fresh.length === 0) return true
    const lines = fresh.map(m => JSON.stringify(m)).join('\n') + '\n'
    await appendFile(archiveFilePath(sessionId), lines, 'utf-8')
    for (const id of staged) seen.add(id)
    return true
  } catch (err) {
    logWarn(`claude.archiveMessages: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
})

registerHandler('claude.loadArchived', async (params) => {
  const sessionId = params?.sessionId
  const offset = Number.isFinite(params?.offset) ? Math.max(0, Math.floor(params.offset)) : 0
  const limit = Number.isFinite(params?.limit) ? Math.max(0, Math.floor(params.limit)) : 0
  if (typeof sessionId !== 'string' || !sessionId) return { messages: [], total: 0, hasMore: false }
  let raw
  try {
    raw = await readFile(archiveFilePath(sessionId), 'utf-8')
  } catch {
    return { messages: [], total: 0, hasMore: false }
  }
  const lines = raw.split('\n').filter(l => l.trim())
  const total = lines.length
  // Mirror Electron's tail-paging: load N items ending at (total - offset).
  // Caller uses offset to skip already-loaded entries from the bottom.
  const end = total - offset
  const start = Math.max(0, end - limit)
  if (end <= 0) return { messages: [], total, hasMore: false }
  const slice = lines.slice(start, end)
  const messages = []
  for (const line of slice) {
    try { messages.push(JSON.parse(line)) } catch { /* drop malformed */ }
  }
  return { messages, total, hasMore: start > 0 }
})

registerHandler('claude.clearArchive', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  // Drop the id cache first. Leaving it behind would make the dedupe above
  // reject the rows of the fresh archive that replaces this one — clearArchive
  // is immediately followed by a re-archive on the history-reset path.
  archivedIdsBySession.delete(sessionId)
  try {
    await unlink(archiveFilePath(sessionId))
  } catch {
    // ENOENT is fine — already cleared.
  }
  return true
})
