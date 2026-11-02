// projects.list — project discovery for the sidebar's Projects section.
//
// Read-only host service: scans the given code roots for git repositories
// (and their worktrees) and merges in Claude Code session history from
// <configDir>/projects. Returns an ephemeral Project[] model and persists
// nothing; a "project" is just a derived view over the repos on disk, which the
// renderer maps onto existing workspaces.

import { readdir, stat, realpath } from 'node:fs/promises'
import { basename, join, normalize } from 'node:path'

import { registerHandler } from '../lib/protocol.mjs'
import { execFileP } from './worktree.mjs'
import { resolveProjectsDir } from '../runtimes/claude-cli-transcript.mjs'

// Claude Code encodes a project path into its <configDir>/projects/<slug> dir
// by replacing every non-alphanumeric character with '-'. This includes drive
// colons, spaces and Unicode, matching the existing history reader. Real dirs
// (e.g. /Users/x/code/foo -> -Users-x-code-foo; a /.claude-worktrees/ segment
// -> --claude-worktrees-). This encoding is a Claude Code implementation
// detail that may change between versions, so it lives in this single function.
export function encodeProjectSlug(absPath) {
  return String(absPath || '').replace(/[^a-zA-Z0-9]/g, '-')
}

function pathKey(path) {
  const value = normalize(path).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function git(args, cwd) {
  return execFileP('git', args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
}

// parseRemoteUrl(url) -> { host, owner, name } | undefined
export function parseRemoteUrl(url) {
  const value = String(url || '').trim().split(/[?#]/, 1)[0]
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
    const { stdout } = await git(['rev-parse', '--show-toplevel'], cwd)
    return stdout.trim() || null
  } catch { return null }
}

export function parseWorktreeList(stdout) {
  const worktrees = []
  let current = null
  const records = String(stdout).split(String(stdout).includes('\0') ? '\0' : '\n')
  for (const line of records) {
    if (line.startsWith('worktree ')) {
      current = { path: normalize(line.slice('worktree '.length)), branch: null, isMain: worktrees.length === 0 }
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
    const { stdout } = await git(['worktree', 'list', '--porcelain', '-z'], root)
    const list = parseWorktreeList(stdout)
    return list.length ? list : [{ path: root, branch: null, isMain: true }]
  } catch {
    return [{ path: root, branch: null, isMain: true }]
  }
}

async function repoRemote(root) {
  try {
    const { stdout } = await git(['remote', 'get-url', 'origin'], root)
    return parseRemoteUrl(stdout)
  } catch { return undefined }
}

async function countSessions(projectsDir, paths) {
  let sessionCount = 0
  let lastSessionAt = 0
  const seenDirs = new Set()
  const seenSessions = new Set()
  for (const path of paths) {
    const slug = encodeProjectSlug(path)
    const slugs = process.platform === 'win32'
      ? [slug, slug[0]?.toLowerCase() + slug.slice(1), slug[0]?.toUpperCase() + slug.slice(1)] : [slug]
    for (const candidate of new Set(slugs)) {
      const dir = join(projectsDir, candidate)
      let entries
      try {
        const key = pathKey(await realpath(dir))
        if (seenDirs.has(key)) continue
        seenDirs.add(key)
        entries = await readdir(dir, { withFileTypes: true })
      } catch { continue }
      for (const entry of entries) {
        const name = entry.name
        if (!entry.isFile() || !name.endsWith('.jsonl') || seenSessions.has(name)) continue
        seenSessions.add(name)
        sessionCount += 1
        try {
          const mtime = (await stat(join(dir, name))).mtimeMs
          if (mtime > lastSessionAt) lastSessionAt = mtime
        } catch { /* ignore unreadable transcript */ }
      }
    }
  }
  return { sessionCount, lastSessionAt }
}

// discoverProjects scans each code root's immediate children for git repos.
// Linked worktrees are grouped under their main repository and aliases are
// deduplicated by real path, with Windows separator/case normalization.
export async function discoverProjects({
  codeRoots = [],
  projectsDir = resolveProjectsDir(process.env),
} = {}) {
  const seen = new Map() // realToplevel -> Project
  const roots = Array.isArray(codeRoots) ? codeRoots : []

  for (const codeRoot of new Set(roots.filter(root => typeof root === 'string' && root.length > 0))) {
    if (!(await isDirectory(codeRoot))) continue
    let children
    try { children = await readdir(codeRoot, { withFileTypes: true }) } catch { continue }
    for (const entry of children) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const childPath = join(codeRoot, entry.name)
      // Avoid spawning git for every unrelated folder under a large code root.
      try { await stat(join(childPath, '.git')) } catch { continue }
      const top = await gitToplevel(childPath)
      if (!top) continue
      const realChild = await realpath(childPath).catch(() => childPath)
      if (pathKey(top) !== pathKey(realChild)) continue
      const worktrees = await listWorktrees(top)
      // A discovered folder can itself be a linked worktree. Group by its main
      // repository, so worktree-only workspace roots still find the project.
      const root = await realpath(worktrees[0].path).catch(() => normalize(worktrees[0].path))
      const key = pathKey(root)
      if (seen.has(key)) continue
      const sessionPaths = [...new Set([root, ...worktrees.map(w => w.path)])]
      const { sessionCount, lastSessionAt } = await countSessions(projectsDir, sessionPaths)
      seen.set(key, {
        id: root,
        name: basename(root),
        root,
        repo: await repoRemote(root),
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
