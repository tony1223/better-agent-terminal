// Project-scoped MCP server detection + approval helpers.
//
// Background: Claude Code CLI (the binary the SDK spawns) reads
// `<cwd>/.mcp.json` for project MCP server declarations. By policy it
// won't auto-attach those servers — it waits for an explicit approval
// marker in one of the settings sources (`enableAllProjectMcpServers:
// true`, or `enabledMcpjsonServers: [...]` exhaustively listing every
// server in `.mcp.json`). In SDK mode there's no interactive
// approval prompt, so an unapproved `.mcp.json` is silently ignored.
//
// We surface that in the renderer:
//   - `claude.checkMcpJsonStatus(cwd)` reports {exists, approved, servers}
//   - `claude.enableAllProjectMcp(cwd)` flips the flag in
//     `<cwd>/.claude/settings.json`, preserving existing keys.
//
// The check reads three settings sources to mirror the SDK's
// settingSources: ['user','project','local'] resolution: user
// `~/.claude/settings.json`, project `<cwd>/.claude/settings.json`,
// local `<cwd>/.claude/settings.local.json`. Approval in ANY of them
// counts (the CLI ORs the merge result).

import { readFile, writeFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { registerHandler } from '../lib/protocol.mjs'

// Override hook for tests — replaces the ~/.claude.json path.
let _claudeJsonPathOverrideForTests = null
export function __setClaudeJsonPathOverrideForTests(p) { _claudeJsonPathOverrideForTests = p }
function claudeJsonPath() {
  return _claudeJsonPathOverrideForTests || join(homedir(), '.claude.json')
}

async function readJsonSafe(path) {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Returns the array of mcpServers keys from `<cwd>/.mcp.json`, or
// null when the file is missing / malformed / has no mcpServers
// object. Callers treat null as "no .mcp.json" — we collapse all
// failure modes since the renderer can't act on the difference.
async function readMcpServerNames(cwd) {
  const parsed = await readJsonSafe(join(cwd, '.mcp.json'))
  if (!parsed || typeof parsed !== 'object') return null
  const servers = parsed.mcpServers
  if (!servers || typeof servers !== 'object') return null
  const names = Object.keys(servers)
  return names.length === 0 ? null : names
}

// True if `settings` (a parsed settings.json from any source) supplies
// approval for ALL of `serverNames`. Two ways to approve:
//   (a) `enableAllProjectMcpServers: true` — blanket approval
//   (b) `enabledMcpjsonServers: [...]` — exhaustive enumeration
// Partial coverage in (b) does NOT count — the CLI only attaches
// servers that are individually approved, so reporting approved=true
// when 1/3 servers are listed would mislead the user.
function isApprovedBy(settings, serverNames) {
  if (!settings || typeof settings !== 'object') return false
  if (settings.enableAllProjectMcpServers === true) return true
  const list = settings.enabledMcpjsonServers
  if (!Array.isArray(list)) return false
  return serverNames.every(name => list.includes(name))
}

registerHandler('claude.checkMcpJsonStatus', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) return { exists: false, approved: false, servers: [] }
  const servers = await readMcpServerNames(cwd)
  if (!servers) return { exists: false, approved: false, servers: [] }
  const sources = [
    join(homedir(), '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ]
  const settingsAll = await Promise.all(sources.map(readJsonSafe))
  const approved = settingsAll.some(s => isApprovedBy(s, servers))
  return { exists: true, approved, servers }
})

// Idempotent: writing an already-true flag is a no-op (changed:false).
// We mkdir the .claude/ dir on first write since a brand-new project
// won't have it yet. JSON.stringify(_, null, 2) matches what the
// Claude CLI writes when it self-initialises settings, so the diff
// stays clean.
registerHandler('claude.enableAllProjectMcp', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) throw new Error('claude.enableAllProjectMcp: missing cwd')
  const dir = join(cwd, '.claude')
  const path = join(dir, 'settings.json')
  await mkdir(dir, { recursive: true })
  const existing = (await readJsonSafe(path)) ?? {}
  if (existing.enableAllProjectMcpServers === true) {
    return { ok: true, changed: false, path }
  }
  existing.enableAllProjectMcpServers = true
  await writeFile(path, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return { ok: true, changed: true, path }
})

// Durable enable/disable of an MCP server for a given cwd, mirroring how the
// Claude CLI persists it under ~/.claude.json -> projects[cwd]:
//   - project `.mcp.json` servers  -> disabledMcpjsonServers / enabledMcpjsonServers
//   - everything else (user/project `mcpServers`, plugin) -> disabledMcpServers
// We write in JS (NOT Rust serde_json, which lacks preserve_order and would
// reorder the whole shared file). JSON.stringify(_, null, 2) round-trips the
// CLI's format byte-for-byte, so only the touched array changes. The write is
// atomic (temp + rename) and a no-op returns early without rewriting the file.
// The CLI rewrites this file too, so if it changes between our read and our
// write, the edit is redone on the fresh content instead of clobbering it.
const SET_ENABLED_ATTEMPTS = 3

function arrayField(obj, key) {
  return Array.isArray(obj[key]) ? obj[key] : []
}

// Mutates `project` in place; returns whether anything changed.
function applyMcpEnabled(project, { name, enabled, source }) {
  const key = source === 'project-file' ? 'disabledMcpjsonServers' : 'disabledMcpServers'
  const disabled = arrayField(project, key)
  const wasDisabled = disabled.includes(name)
  let changed = false

  if (enabled && wasDisabled) {
    project[key] = disabled.filter(n => n !== name)
    changed = true
  } else if (!enabled && !wasDisabled) {
    project[key] = [...disabled, name]
    changed = true
  }

  // For `.mcp.json` servers keep the enabled list consistent so the CLI
  // re-attaches an unapproved server on enable and drops it on disable.
  if (source === 'project-file') {
    const en = arrayField(project, 'enabledMcpjsonServers')
    if (enabled && !en.includes(name)) {
      project.enabledMcpjsonServers = [...en, name]
      changed = true
    } else if (!enabled && en.includes(name)) {
      project.enabledMcpjsonServers = en.filter(n => n !== name)
      changed = true
    }
  }
  return { key, changed }
}

registerHandler('claude.setMcpServerEnabled', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  const name = typeof params?.name === 'string' ? params.name : ''
  const enabled = params?.enabled === true
  const source = typeof params?.source === 'string' ? params.source : ''
  if (!cwd || !name) throw new Error('claude.setMcpServerEnabled: missing cwd/name')

  const path = claudeJsonPath()
  for (let attempt = 1; ; attempt++) {
    let data
    let mtimeMs
    try {
      mtimeMs = (await stat(path)).mtimeMs
      data = JSON.parse(await readFile(path, 'utf-8'))
    } catch {
      throw new Error('claude.setMcpServerEnabled: ~/.claude.json unreadable')
    }
    if (!data || typeof data !== 'object') throw new Error('claude.setMcpServerEnabled: invalid config')
    if (!data.projects || typeof data.projects !== 'object') data.projects = {}
    if (!data.projects[cwd] || typeof data.projects[cwd] !== 'object') data.projects[cwd] = {}

    const { key, changed } = applyMcpEnabled(data.projects[cwd], { name, enabled, source })
    if (!changed) return { ok: true, changed: false, key, disabled: !enabled }

    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    if ((await stat(path)).mtimeMs !== mtimeMs) {
      await unlink(tmp).catch(() => {})
      if (attempt < SET_ENABLED_ATTEMPTS) continue
      throw new Error('claude.setMcpServerEnabled: ~/.claude.json kept changing, try again')
    }
    await rename(tmp, path)
    return { ok: true, changed: true, key, disabled: !enabled }
  }
})
