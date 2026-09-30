// projects.list — project discovery for the sidebar's Projects section.
//
// Read-only host service: scans the given code roots for git repositories
// (and their worktrees) and merges in Claude Code session history from
// <configDir>/projects. Returns an ephemeral Project[] model and persists
// nothing; a "project" is just a derived view over the repos on disk, which the
// renderer maps onto existing workspaces.

import { readdir, stat, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { registerHandler } from '../lib/protocol.mjs'
import { execFileP } from './worktree.mjs'
import { resolveProjectsDir } from '../runtimes/claude-cli-transcript.mjs'

// Claude Code encodes a project path into its <configDir>/projects/<slug> dir
// by replacing path separators and dots with '-'. Verified against real dirs
// (e.g. /Users/x/code/foo -> -Users-x-code-foo; a /.claude-worktrees/ segment
// -> --claude-worktrees-). This encoding is a Claude Code implementation
// detail that may change between versions, so it lives in this single function.
export function encodeProjectSlug(absPath) {
  return String(absPath || '').replace(/[/\\.]/g, '-')
}

// parseRemoteUrl(url) -> { host, owner, name } | undefined
export function parseRemoteUrl(url) {
  const value = String(url || '').trim()
  if (!value) return undefined
  let m = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(value)
  if (!m) m = /^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/i.exec(value)
  if (!m) return undefined
  return { host: m[1], owner: m[2], name: m[3] }
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

async function gitToplevel(cwd) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd })
    return stdout.trim() || null
  } catch { return null }
}

export function parseWorktreeList(stdout) {
  const worktrees = []
  let current = null
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: null, isMain: worktrees.length === 0 }
      worktrees.push(current)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (current && line.startsWith('detached')) {
      current.branch = 'HEAD'
    }
  }
  return worktrees
}

async function listWorktrees(root) {
  try {
    const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], {
      cwd: root, maxBuffer: 4 * 1024 * 1024,
    })
    const list = parseWorktreeList(stdout)
    return list.length ? list : [{ path: root, branch: null, isMain: true }]
  } catch {
    return [{ path: root, branch: null, isMain: true }]
  }
}

async function repoRemote(root) {
  try {
    const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], { cwd: root })
    return parseRemoteUrl(stdout)
  } catch { return undefined }
}

async function countSessions(projectsDir, paths) {
  let sessionCount = 0
  let lastSessionAt = 0
  for (const path of paths) {
    const dir = join(projectsDir, encodeProjectSlug(path))
    let entries
    try { entries = await readdir(dir) } catch { continue }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      sessionCount += 1
      try {
        const mtime = (await stat(join(dir, name))).mtimeMs
        if (mtime > lastSessionAt) lastSessionAt = mtime
      } catch { /* ignore unreadable transcript */ }
    }
  }
  return { sessionCount, lastSessionAt }
}

// discoverProjects scans each code root's immediate children for git repos.
// Linked worktrees and nested subdirs (whose toplevel resolves elsewhere) are
// skipped so each repo appears once, keyed by its real toplevel path.
export async function discoverProjects({
  codeRoots = [],
  projectsDir = resolveProjectsDir(process.env),
} = {}) {
  const seen = new Map() // realToplevel -> Project
  const roots = Array.isArray(codeRoots) ? codeRoots : []

  for (const codeRoot of roots) {
    if (!(await isDirectory(codeRoot))) continue
    let children
    try { children = await readdir(codeRoot, { withFileTypes: true }) } catch { continue }
    for (const entry of children) {
      if (!entry.isDirectory()) continue
      const childPath = join(codeRoot, entry.name)
      const top = await gitToplevel(childPath)
      if (!top || seen.has(top)) continue
      const realChild = await realpath(childPath).catch(() => childPath)
      if (top !== realChild) continue // skip nested dirs / linked worktrees
      const worktrees = await listWorktrees(top)
      const sessionPaths = [...new Set([top, ...worktrees.map(w => w.path)])]
      const { sessionCount, lastSessionAt } = await countSessions(projectsDir, sessionPaths)
      seen.set(top, {
        id: top,
        name: basename(top),
        root: top,
        repo: await repoRemote(top),
        worktrees,
        sessionCount,
        hasSessions: sessionCount > 0,
        lastSessionAt: lastSessionAt || undefined,
      })
    }
  }

  return [...seen.values()].sort((a, b) => {
    const byRecency = (b.lastSessionAt || 0) - (a.lastSessionAt || 0)
    return byRecency !== 0 ? byRecency : a.name.localeCompare(b.name)
  })
}

registerHandler('projects.list', async (params = {}) => {
  const codeRoots = Array.isArray(params?.codeRoots) ? params.codeRoots : []
  const projects = await discoverProjects({ codeRoots })
  return { projects }
})
