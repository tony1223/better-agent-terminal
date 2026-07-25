// claude.* read-only metadata + worktree-related claude.* handlers.
// Houses findClaudeCliPath / listSessionsFallback (the disk-walking
// session lister) since they only feed claude.listSessions / getCliPath.

import { readdir, stat } from 'node:fs/promises'
import { createReadStream, accessSync, constants as fsConstants } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir, platform } from 'node:os'
import { join, basename } from 'node:path'

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { loadAnthropicSdk } from '../lib/sdk-loader.mjs'
import { sessions, buildSessionMeta } from '../lib/state.mjs'
import { CLAUDE_BUILTIN_MODELS, CLAUDE_BUILTIN_DEDUP_KEYS } from '../lib/models.mjs'
import { scanSkills } from '../lib/skills.mjs'
import { stripTaskNotifications, isHarnessNoiseUserText } from '../lib/harness-noise.mjs'
import { activeWorktrees, worktreeStatus, worktreeRemove } from './worktree.mjs'
import {
  cleanupCodexWorktree,
  getCodexSupportedModels,
  getCodexWorktreeStatus,
  isCodexSession,
  listCodexSessions,
} from './codex.mjs'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PREVIEW_LINE_LIMIT = 200
const PREVIEW_CHARS = 120
const SESSION_LIST_LIMIT = 50

export function findClaudeCliPath() {
  // Walk PATH and look for "claude" (or claude.cmd / claude.exe / claude.bat
  // on Windows). Returns the first match or null. We deliberately do not
  // shell out to `which` / `where` — readdir-by-PATHEXT is cheaper and
  // doesn't depend on platform tooling being present.
  const PATH = process.env.PATH ?? ''
  const sep = platform() === 'win32' ? ';' : ':'
  const dirs = PATH.split(sep).filter(Boolean)
  const exts = platform() === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase())
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext}`)
      try {
        accessSync(candidate, fsConstants.F_OK)
        return candidate
      } catch { /* not here, try next */ }
    }
  }
  return null
}

export async function listSessionsFallback(cwd) {
  // Sessions live under ~/.claude/projects/<encoded>/, where <encoded> is
  // the cwd with all non-alphanumeric chars replaced by "-". Windows
  // sometimes case-folds the first letter, so we probe a couple of
  // alt-cased variants to be safe.
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const candidates = [join(CLAUDE_PROJECTS_DIR, encoded)]
  if (platform() === 'win32' && encoded.length > 0) {
    const lower = encoded[0].toLowerCase() + encoded.slice(1)
    const upper = encoded[0].toUpperCase() + encoded.slice(1)
    if (lower !== encoded) candidates.push(join(CLAUDE_PROJECTS_DIR, lower))
    if (upper !== encoded) candidates.push(join(CLAUDE_PROJECTS_DIR, upper))
  }

  const results = []
  for (const dir of candidates) {
    let entries
    try {
      entries = (await readdir(dir)).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of entries) {
      const filePath = join(dir, file)
      const sdkSessionId = basename(file, '.jsonl')
      try {
        const st = await stat(filePath)
        const details = await readSessionPreview(filePath)
        results.push({
          sdkSessionId,
          timestamp: st.mtimeMs,
          preview: details.preview || '(no preview)',
          messageCount: details.messageCount,
          ...(details.customTitle ? { customTitle: details.customTitle } : {}),
          ...(details.firstPrompt ? { firstPrompt: details.firstPrompt } : {}),
          ...(details.gitBranch ? { gitBranch: details.gitBranch } : {}),
          ...(details.summary ? { summary: details.summary } : {}),
        })
      } catch { /* skip unreadable */ }
    }
  }

  const seen = new Set()
  const deduped = results.filter(r => {
    if (seen.has(r.sdkSessionId)) return false
    seen.add(r.sdkSessionId)
    return true
  })
  deduped.sort((a, b) => b.timestamp - a.timestamp)
  return deduped.slice(0, SESSION_LIST_LIMIT)
}

function normalizeSessionHintText(value) {
  // Strip before collapsing whitespace, so removing a block from the middle of a
  // prompt does not leave the double space its surrounding spaces would.
  const text = stripTaskNotifications(value).replace(/\s+/g, ' ').trim()
  if (isHarnessNoiseUserText(text)) return ''
  return text.slice(0, PREVIEW_CHARS)
}

function textFromClaudeContent(content) {
  if (typeof content === 'string') return normalizeSessionHintText(content)
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const text = normalizeSessionHintText(block.text)
      if (text) return text
    }
  }
  return ''
}

function summaryFromClaudeRecord(obj) {
  if (obj?.type !== 'summary') return ''
  return normalizeSessionHintText(
    obj.summary
      ?? obj.title
      ?? obj.message?.summary
      ?? obj.message?.content
      ?? obj.content,
  )
}

async function readSessionPreview(filePath) {
  // Stream up to PREVIEW_LINE_LIMIT lines and stop. We only need the
  // first user message and summary records for hints; any further reading is wasted I/O
  // on JSONL files that can be hundreds of MB.
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let preview = ''
  let firstPrompt = ''
  let summary = ''
  let gitBranch = ''
  let messageCount = 0
  let lineCount = 0
  try {
    for await (const line of rl) {
      lineCount++
      if (lineCount > PREVIEW_LINE_LIMIT) break
      try {
        const obj = JSON.parse(line)
        messageCount++
        if (!gitBranch && typeof obj?.gitBranch === 'string') gitBranch = normalizeSessionHintText(obj.gitBranch)
        if (!gitBranch && typeof obj?.git_branch === 'string') gitBranch = normalizeSessionHintText(obj.git_branch)
        const nextSummary = summaryFromClaudeRecord(obj)
        if (nextSummary) summary = nextSummary
        if (!firstPrompt && obj?.type === 'user') {
          firstPrompt = textFromClaudeContent(obj?.message?.content)
          if (!preview) preview = firstPrompt
        }
      } catch { /* skip malformed */ }
    }
  } finally {
    stream.destroy()
  }
  const customTitle = summary || firstPrompt || preview
  return { preview, messageCount, customTitle, firstPrompt, gitBranch, summary }
}

// --- handlers --------------------------------------------------------------

// Read-only metadata. Two of these are now real implementations:
//   - claude.getCliPath: locate the `claude` binary on PATH (no SDK dep).
//   - claude.listSessions: parse JSONL session files under
//     ~/.claude/projects/<encoded-cwd>/, mirroring the fallback path
//     of the Electron-side claude-agent-manager.listSessionsFallback().
// The rest return inert defaults until @anthropic-ai/claude-agent-sdk
// moves into the sidecar.
registerHandler('claude.getCliPath', async () => findClaudeCliPath() ?? '')
registerHandler('claude.listSessions', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (params?.agentKind === 'codex') return cwd ? listCodexSessions(cwd) : []
  if (!cwd) return []
  return listSessionsFallback(cwd)
})

// Per-process metadata cache.
//
// Each of the 4 handlers below (getSupportedModels / Commands / Agents
// / AccountInfo) used to spin up a fresh `sdk.query({prompt:'',cwd:'/'})`
// on every call. On macOS that's ~4-5s per call because the SDK spawns
// the bundled `claude` binary as a subprocess. ClaudeAgentPanel mount
// fires all four in sequence → ~17s of cold start (verified via
// node-sidecar/scripts/bench-startup.mjs).
//
// Cache strategy: process-lifetime in-memory map with a 5-minute TTL.
// Key insight — these values rarely change within a session:
//   - supportedModels: rebuilt from SDK + builtins; only changes if
//     the SDK ships a new model list (i.e. across SDK upgrades).
//   - supportedCommands / supportedAgents: derived from
//     ~/.claude/{commands,agents} + project .claude/{commands,agents}.
//     Stable within a session; user adding a new file is rare and a
//     5-min TTL bounds the staleness.
//   - accountInfo: pinned to the active account. Invalidated explicitly
//     on accountSwitch / accountRemove via invalidateAccountMetadataCache.
//
// The cache also de-dupes concurrent calls: if two panel mounts hit
// the same key simultaneously, they share the in-flight promise so we
// only spawn the SDK subprocess once.
const META_CACHE_TTL_MS = 5 * 60 * 1000
const metaCache = new Map()  // key → { value, ts, inflight }

async function cachedSdkRead(key, build) {
  const now = Date.now()
  const entry = metaCache.get(key)
  if (entry && entry.value !== undefined && now - entry.ts < META_CACHE_TTL_MS) {
    return entry.value
  }
  if (entry?.inflight) return entry.inflight
  const inflight = (async () => {
    try {
      const value = await build()
      metaCache.set(key, { value, ts: Date.now(), inflight: null })
      return value
    } catch (err) {
      // On error we don't poison the cache — next call retries cold.
      metaCache.set(key, { value: undefined, ts: 0, inflight: null })
      throw err
    }
  })()
  metaCache.set(key, { value: entry?.value, ts: entry?.ts ?? 0, inflight })
  return inflight
}

// Invalidate the parts of the cache that change when the active
// account flips. Called from claude.accountSwitch / accountRemove.
export function invalidateAccountMetadataCache() {
  metaCache.delete('getAccountInfo')
  // Models / commands / agents could in theory differ per-account
  // (different feature flags), so flush them too — a fresh login
  // triggering a brief reload is fine.
  metaCache.delete('getSupportedModels')
  metaCache.delete('getSupportedCommands')
  metaCache.delete('getSupportedAgents')
}
// Test hook: clear the cache so tests can verify cold-path behaviour
// without restarting the module.
export function __resetMetadataCacheForTests() {
  metaCache.clear()
}

// Returns the builtin claude model list, optionally augmented with
// SDK-discovered models when @anthropic-ai/claude-agent-sdk is
// importable. Builtin entries are always present and tagged source:
// 'builtin'; SDK entries are tagged source: 'sdk' and de-duped against
// the builtin values (including [1m] variants). Mirrors the Electron
// claudeAgentManager.getSupportedModels() behaviour, including the
// "SDK fails → builtins-only" fallback.
//
// In release builds without bundled node_modules, the SDK import will
// fail and we silently return builtins. Drift guard test still applies.
registerHandler('claude.getSupportedModels', async (params) => {
  if (isCodexSession(String(params?.sessionId ?? ''))) return getCodexSupportedModels()
  return cachedSdkRead('getSupportedModels', async () => {
    const builtins = CLAUDE_BUILTIN_MODELS.map(m => ({ ...m, source: 'builtin' }))
    try {
      const sdk = await loadAnthropicSdk()
      if (!sdk) return builtins
      const dedupKeys = new Set(CLAUDE_BUILTIN_DEDUP_KEYS)
      const instance = sdk.query({ prompt: '', options: { cwd: '/' } })
      const sdkModels = await instance.supportedModels()
      const sdkFiltered = (Array.isArray(sdkModels) ? sdkModels : [])
        .filter(m => m && typeof m.value === 'string'
          && !dedupKeys.has(m.value)
          && !dedupKeys.has(`${m.value}[1m]`))
        .map(m => ({ ...m, source: 'sdk' }))
      return [...builtins, ...sdkFiltered]
    } catch {
      return builtins
    }
  })
})
// getSupportedCommands / getSupportedAgents / getAccountInfo all read
// from the live `session.currentQuery` instance — the Query that was
// created by claude.sendMessage and has been alive since. The SDK's
// .supportedCommands() / .supportedAgents() / .accountInfo() are all
// `return (await this.initialization).<field>` reads against that
// Query's already-resolved init promise, so the call costs ~0ms.
//
// This mirrors electron/claude-agent-manager.ts:2079-2099 exactly:
// when no session has run a query yet, return the inert default
// ([] / null) instead of spawning a fresh SDK subprocess (which costs
// ~4s on Windows and is wasted work — the renderer panel re-fetches
// after the first claude:status event arrives anyway, by which point
// session.currentQuery exists).
//
// Pre-fix bench (Windows): each handler spawned its own fresh
// sdk.query() → 3.7-5.5s per call → ~16s for the 4-RPC panel-mount
// burst. Post-fix: cheap RPCs return [] / null instantly when the
// session hasn't run a query, getSupportedModels alone keeps the
// fresh-Query path (Electron parity).
function readFromLiveQuery(sessionId, method, fallback) {
  if (typeof sessionId !== 'string' || !sessionId) return fallback
  const session = sessions.get(sessionId)
  const q = session?.currentQuery
  if (!q || typeof q[method] !== 'function') return fallback
  return q[method]().catch(() => fallback)
}

registerHandler('claude.getSupportedCommands', async (params) =>
  isCodexSession(String(params?.sessionId ?? '')) ? [] : cachedSdkRead(`getSupportedCommands:${params?.sessionId ?? ''}`, async () => {
    const result = await readFromLiveQuery(params?.sessionId, 'supportedCommands', [])
    return Array.isArray(result) ? result : []
  })
)
registerHandler('claude.getSupportedAgents', async (params) =>
  isCodexSession(String(params?.sessionId ?? '')) ? [] : cachedSdkRead(`getSupportedAgents:${params?.sessionId ?? ''}`, async () => {
    const result = await readFromLiveQuery(params?.sessionId, 'supportedAgents', [])
    return Array.isArray(result) ? result : []
  })
)
registerHandler('claude.getAccountInfo', async (params) =>
  isCodexSession(String(params?.sessionId ?? '')) ? null : cachedSdkRead(`getAccountInfo:${params?.sessionId ?? ''}`, async () => {
    const result = await readFromLiveQuery(params?.sessionId, 'accountInfo', null)
    return result ?? null
  })
)

registerHandler('claude.getWorktreeStatus', async (params) => {
  const sessionId = String(params?.sessionId ?? '')
  if (!sessionId) return null
  if (isCodexSession(sessionId)) return getCodexWorktreeStatus(params)
  const info = activeWorktrees.get(sessionId)
  if (!info) return null
  return worktreeStatus(sessionId)
})
// claude.scanSkills walks <cwd>/.claude/skills + ~/.claude/skills and
// returns SkillMeta entries. No SDK dep — pure fs walk + YAML
// frontmatter parsing.
function restoreSessionCwdAfterWorktreeCleanup(sessionId, info) {
  const session = sessions.get(sessionId)
  if (!session?.options || typeof session.options !== 'object') return
  const originalCwd = info?.originalCwd || session.options.originalCwd
  if (typeof originalCwd !== 'string' || !originalCwd) return
  const {
    useWorktree: _useWorktree,
    worktreePath: _worktreePath,
    worktreeBranch: _worktreeBranch,
    originalCwd: _originalCwd,
    ...rest
  } = session.options
  session.options = { ...rest, cwd: originalCwd }
  sendEvent('claude:status', { sessionId, meta: buildSessionMeta(session) })
}

// claude.cleanupWorktree drops the worktree associated with a session
// and mirrors Electron's session reset by restoring cwd back to
// originalCwd before notifying the renderer.
registerHandler('claude.cleanupWorktree', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const deleteBranch = params?.deleteBranch !== false
  if (!sessionId) return false
  if (isCodexSession(sessionId)) return cleanupCodexWorktree(params)
  try {
    const info = activeWorktrees.get(sessionId)
    await worktreeRemove(sessionId, deleteBranch)
    restoreSessionCwdAfterWorktreeCleanup(sessionId, info)
    sendEvent('claude:worktree-info', { sessionId, payload: null })
    return true
  } catch {
    return false
  }
})
registerHandler('claude.scanSkills', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) return []
  return scanSkills(cwd)
})
