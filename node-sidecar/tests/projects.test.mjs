import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { discoverProjects, encodeProjectSlug, parseRemoteUrl, parseWorktreeList } from '../src/handlers/projects.mjs'
import { resolveProjectsDir } from '../src/runtimes/claude-cli-transcript.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'bat-projects-test-'))
const codeRoot = join(scratch, 'code')
const wtHome = join(scratch, 'worktrees')
const projectsDir = join(scratch, 'sessions')
const repoA = join(codeRoot, 'repoA')
const repoB = join(codeRoot, 'repoB')
const worktree = join(wtHome, 'feat 中文')
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(scratch, 'empty-gitconfig') }
function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', windowsHide: true }).toString()
}

after(() => {
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + sep))
  rmSync(scratch, { recursive: true, force: true })
})
before(() => {
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '')
  for (const dir of [repoA, repoB, wtHome, projectsDir, join(codeRoot, 'notes')]) mkdirSync(dir, { recursive: true })
  for (const repo of [repoA, repoB]) {
    git(['init', '-b', 'main'], repo)
    git(['commit', '--allow-empty', '-m', 'initial'], repo)
  }
  git(['remote', 'add', 'origin', 'https://github.com/acme/repoA.git'], repoA)
  git(['worktree', 'add', '-b', 'feat', worktree], repoA)
  symlinkSync(repoA, join(codeRoot, 'aliasA'), process.platform === 'win32' ? 'junction' : 'dir')
  const primary = join(projectsDir, encodeProjectSlug(realpathSync(repoA)))
  const linked = join(projectsDir, encodeProjectSlug(realpathSync(worktree)))
  mkdirSync(primary, { recursive: true }); mkdirSync(linked, { recursive: true })
  writeFileSync(join(primary, 's1.jsonl'), '{}\n')
  writeFileSync(join(primary, 's2.jsonl'), '{}\n')
  mkdirSync(join(primary, 'not-a-file.jsonl'))
  writeFileSync(join(linked, 's2.jsonl'), '{}\n')
  writeFileSync(join(linked, 's3.jsonl'), '{}\n')
})

test('session slugs cover Windows drives, spaces and Unicode consistently with history lookup', () => {
  assert.equal(encodeProjectSlug('/Users/alice/code/my-app'), '-Users-alice-code-my-app')
  assert.equal(encodeProjectSlug('C:\\code\\my repo'), 'C--code-my-repo')
  assert.equal(encodeProjectSlug('/tmp/中文.dir'), '-tmp----dir')
})

test('remote metadata excludes credentials and URL query strings', () => {
  assert.deepEqual(parseRemoteUrl('https://user:secret@github.com/acme/repo.git?token=private'), { host: 'github.com', owner: 'acme', name: 'repo' })
  assert.deepEqual(parseRemoteUrl('git@github.com:acme/repo.git'), { host: 'github.com', owner: 'acme', name: 'repo' })
  assert.equal(parseRemoteUrl(''), undefined)
  assert.equal(resolveProjectsDir({ CLAUDE_CONFIG_DIR: '/tmp/config' }), join('/tmp/config', 'projects'))
})

test('NUL-separated worktree paths preserve non-ASCII characters', () => {
  const result = parseWorktreeList(`worktree ${worktree}\0HEAD abc\0branch refs/heads/feat\0\0`)
  assert.equal(result[0].path, worktree)
  assert.equal(result[0].branch, 'feat')
})

test('discovers Windows/native paths, zero-session repos and aliases exactly once', async () => {
  const projects = await discoverProjects({ codeRoots: [codeRoot, codeRoot, null, 42], projectsDir })
  assert.deepEqual(projects.map(project => project.name), ['repoA', 'repoB'])
  const [a, b] = projects
  assert.equal(a.root, realpathSync(repoA))
  assert.equal(a.sessionCount, 3, 'count worktree sessions once, excluding directories and repeated UUIDs')
  assert.equal(a.hasSessions, true)
  assert.ok(a.lastSessionAt > 0)
  assert.equal(a.worktrees.length, 2)
  assert.deepEqual(a.worktrees.map(tree => tree.branch).sort(), ['feat', 'main'])
  assert.equal(a.worktrees.filter(tree => tree.isMain).length, 1)
  assert.deepEqual(a.repo, { host: 'github.com', owner: 'acme', name: 'repoA' })
  assert.equal(b.sessionCount, 0)
  assert.equal(b.hasSessions, false)
})

test('a root containing only linked worktrees still discovers their primary repository', async () => {
  const projects = await discoverProjects({ codeRoots: [wtHome], projectsDir })
  assert.equal(projects.length, 1)
  assert.equal(projects[0].root, realpathSync(repoA))
  assert.equal(projects[0].sessionCount, 3)
})

test('missing roots and non-repository directories are harmless', async () => {
  assert.deepEqual(await discoverProjects({ codeRoots: [join(scratch, 'missing'), join(codeRoot, 'notes')], projectsDir }), [])
})

test('the registered JSON-RPC handler scans host paths', async () => {
  const previousData = process.env.BAT_SIDECAR_DATA_DIR
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.BAT_SIDECAR_DATA_DIR = join(scratch, 'sidecar')
  process.env.CLAUDE_CONFIG_DIR = join(scratch, 'config')
  try {
    const { dispatch } = await import('../src/server.mjs')
    const result = await dispatch({ jsonrpc: '2.0', id: 141, method: 'projects.list', params: { codeRoots: [codeRoot] } })
    assert.equal(result.error, undefined)
    assert.deepEqual(result.result.projects.map(project => project.name).sort(), ['repoA', 'repoB'])
  } finally {
    if (previousData === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = previousData
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
  }
})
