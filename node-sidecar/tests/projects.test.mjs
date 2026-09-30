// Tests for project discovery (node-sidecar/src/handlers/projects.mjs).
//
// Run with: node node-sidecar/tests/projects.test.mjs
// Uses real tmp git repos + worktrees and a fake <configDir>/projects dir.

import * as assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverProjects, encodeProjectSlug, parseRemoteUrl } from '../src/handlers/projects.mjs'
import { resolveProjectsDir } from '../src/runtimes/claude-cli-transcript.mjs'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString()
}

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed += 1 } catch (err) {
    failed += 1
    console.error(`✗ ${name}\n  ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --- pure helpers (sync) ---------------------------------------------------
test('encodeProjectSlug replaces / and . with -', () => {
  assert.equal(encodeProjectSlug('/Users/alice/code/my-app'), '-Users-alice-code-my-app')
  assert.equal(
    encodeProjectSlug('/Users/alice/code/shop/.claude-worktrees/x'),
    '-Users-alice-code-shop--claude-worktrees-x',
  )
})

test('parseRemoteUrl handles https and ssh remotes', () => {
  assert.deepEqual(parseRemoteUrl('https://github.com/acme/repo.git'), { host: 'github.com', owner: 'acme', name: 'repo' })
  assert.deepEqual(parseRemoteUrl('git@github.com:acme/repo.git'), { host: 'github.com', owner: 'acme', name: 'repo' })
  assert.equal(parseRemoteUrl(''), undefined)
})

test('resolveProjectsDir honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(resolveProjectsDir({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }), join('/tmp/cfg', 'projects'))
})

// --- discovery against real git repos -------------------------------------
async function main() {
  const codeRoot = mkdtempSync(join(tmpdir(), 'bat-projects-code-'))
  const wtHome = mkdtempSync(join(tmpdir(), 'bat-projects-wt-'))
  const projectsDir = mkdtempSync(join(tmpdir(), 'bat-projects-sessions-'))

  // repoA: has origin remote, one extra worktree, and 2 session transcripts.
  const repoA = join(codeRoot, 'repoA'); mkdirSync(repoA)
  git(['init', '-b', 'main'], repoA)
  git(['commit', '--allow-empty', '-m', 'init'], repoA)
  git(['remote', 'add', 'origin', 'https://github.com/acme/repoA.git'], repoA)
  git(['worktree', 'add', '-b', 'feat', join(wtHome, 'feat-a')], repoA)

  // repoB: a repo with no extra worktrees and no sessions (must still appear).
  const repoB = join(codeRoot, 'repoB'); mkdirSync(repoB)
  git(['init', '-b', 'main'], repoB)
  git(['commit', '--allow-empty', '-m', 'init'], repoB)

  // a non-repo directory that must be ignored.
  mkdirSync(join(codeRoot, 'notes'))
  writeFileSync(join(codeRoot, 'notes', 'x.txt'), 'hi')

  // session history for repoA only (keyed by the realpath slug).
  const realRepoA = realpathSync(repoA)
  const sessionDir = join(projectsDir, encodeProjectSlug(realRepoA))
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 's1.jsonl'), '{}\n')
  writeFileSync(join(sessionDir, 's2.jsonl'), '{}\n')

  const projects = await discoverProjects({ codeRoots: [codeRoot], projectsDir })
  const names = projects.map(p => p.name)

  test('discovers git repos and ignores non-repos', () => {
    assert.ok(names.includes('repoA'), `expected repoA, got ${names.join(',')}`)
    assert.ok(names.includes('repoB'), `expected repoB (zero sessions still listed), got ${names.join(',')}`)
    assert.ok(!names.includes('notes'), 'non-repo dir must be excluded')
  })

  const A = projects.find(p => p.name === 'repoA')
  const B = projects.find(p => p.name === 'repoB')

  test('repoA: sessions counted from history', () => {
    assert.equal(A?.sessionCount, 2)
    assert.equal(A?.hasSessions, true)
    assert.ok((A?.lastSessionAt || 0) > 0)
  })

  test('repoB: repo with zero sessions is still listed', () => {
    assert.equal(B?.sessionCount, 0)
    assert.equal(B?.hasSessions, false)
  })

  test('repoA: worktrees include main + feat', () => {
    assert.equal(A?.worktrees.length, 2)
    assert.deepEqual(A?.worktrees.map(w => w.branch).sort(), ['feat', 'main'])
    assert.equal(A?.worktrees.filter(w => w.isMain).length, 1)
  })

  test('repoB: single (main) worktree', () => {
    assert.equal(B?.worktrees.length, 1)
    assert.equal(B?.worktrees[0].isMain, true)
  })

  test('repoA: origin remote parsed', () => {
    assert.deepEqual(A?.repo, { host: 'github.com', owner: 'acme', name: 'repoA' })
  })

  if (failed > 0) {
    console.error(`\nprojects: ${passed} passed, ${failed} failed`)
    process.exit(1)
  }
  console.log(`projects: ${passed} passed`)
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
