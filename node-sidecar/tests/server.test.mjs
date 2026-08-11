// Tests for the Node sidecar JSON-RPC server.
//
// Two layers:
//   - dispatch() is exercised in-process (no spawn) so we can assert on
//     handler logic without paying for a child Node startup per test.
//   - One end-to-end test spawns the server as a real child to verify
//     the line-delimited stdio protocol survives the round trip.
//
// Run with: pnpm exec node node-sidecar/tests/server.test.mjs

import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import runtimeCatalog from '../../runtime-catalog.json' with { type: 'json' }

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = resolve(here, '..', 'src', 'server.mjs')
const CLAUDE_NATIVE_VERSION = runtimeCatalog.claude.version

// claude.sendMessage acks on receipt, so awaiting its reply no longer means the
// turn finished. The tail that clears session.streaming runs behind a
// setImmediate, which is queued *after* the caller's own — so yield repeatedly
// rather than once. Callers still assert on the finished state afterwards, so a
// turn that never lands fails there instead of being papered over here.
async function settleTurn(session, attempts = 20) {
  for (let i = 0; i < attempts && session?.streaming; i += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function inProcess() {
  const mod = await import('../src/server.mjs')
  const { dispatch, handlers, registerHandler } = mod
  function writeClaudeHistory(projectsDir, cwd, sdkSessionId, entries = null) {
    const encoded = String(cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(projectsDir, encoded)
    mkdirSync(dir, { recursive: true })
    const rows = entries || [
      { type: 'user', uuid: `${sdkSessionId}-u`, timestamp: '2026-05-10T00:00:00.000Z', message: { role: 'user', content: 'setup' } },
    ]
    writeFileSync(join(dir, `${sdkSessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  }

  // ping echoes params and returns pid + ok flag.
  const pingReply = await dispatch({ jsonrpc: '2.0', id: 1, method: 'ping', params: { hi: 'there' } })
  assert.equal(pingReply.jsonrpc, '2.0')
  assert.equal(pingReply.id, 1)
  assert.equal(pingReply.result.ok, true)
  assert.deepEqual(pingReply.result.echo, { hi: 'there' })
  assert.equal(typeof pingReply.result.pid, 'number')

  // claude.authStatus shells out to `claude auth status`. Result is either
  // null (CLI missing / not logged in / parse error) or the parsed JSON
  // object — we accept both so the test passes regardless of the dev
  // machine's auth state.
  const auth = await dispatch({ jsonrpc: '2.0', id: 2, method: 'claude.authStatus' })
  assert.ok(auth.result === null || (typeof auth.result === 'object' && auth.result !== null),
    `unexpected authStatus shape: ${JSON.stringify(auth.result)}`)
  // claude.accountList reads the on-disk index. The renderer's
  // SettingsPanel reads `.accounts.length` directly, so the shape must
  // be `{accounts, activeAccountId, switchWarningShown}` — never a bare
  // array — even when the index file is missing.
  const savedDataDir = process.env.BAT_SIDECAR_DATA_DIR
  process.env.BAT_SIDECAR_DATA_DIR = join(tmpdir(), `nonexistent-${Date.now()}`)
  try {
    const accounts = await dispatch({ jsonrpc: '2.0', id: 3, method: 'claude.accountList' })
    assert.deepEqual(accounts.result, { accounts: [], activeAccountId: null, switchWarningShown: false })
  } finally {
    if (savedDataDir === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = savedDataDir
  }

  // Unknown methods produce a -32601 error and preserve the request id.
  const unknown = await dispatch({ jsonrpc: '2.0', id: 7, method: 'no.such.method' })
  assert.equal(unknown.error.code, -32601)
  assert.equal(unknown.id, 7)

  // Notifications (no id) get no response object back.
  const notif = await dispatch({ jsonrpc: '2.0', method: 'ping' })
  assert.equal(notif, null)

  // sidecar logger — mirrors stderr writes to <dataDir>/sidecar.log so
  // mac users can scrape the file post-mortem after a hung send.
  // (a) initLogger creates the file at the override path, mode 0600 on
  // POSIX. (b) log/warn/error append a timestamp+level+message line.
  // (c) sidecar.getLogPath surfaces the path through dispatch so the
  // renderer can show it. (d) rotate kicks in when the file exceeds
  // 5 MB. (e) attachProcessHooks is idempotent.
  {
    const logger = await import('../src/lib/logger.mjs')
    const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const tmpRoot = mkdtempSync(join(tmpdir(), 'bat-sidecar-log-'))
    const logPath = join(tmpRoot, 'sidecar.log')
    logger.__setLogPathOverrideForTests(logPath)
    try {
      logger.initLogger()
      assert.equal(existsSync(logPath), true, 'initLogger must create the log file')
      assert.equal(logger.getLogPath(), logPath)

      // Every level appends a parseable line.
      logger.log('hello', 'world')
      logger.info('numbers:', 42)
      logger.warn('careful')
      logger.error('boom', new Error('kaboom'))
      const contents = readFileSync(logPath, 'utf-8')
      // Count entries by ISO-timestamp prefix at line start (errors with
      // multi-line stacks count as one entry).
      const entryStarts = contents.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z (LOG |INFO|WARN|ERR ) /gm) || []
      assert.equal(entryStarts.length, 4, `expected 4 entries, got ${entryStarts.length}`)
      // Per-line spot-checks via the first line of each entry.
      const firstLineOf = contents.split('\n').filter(Boolean)[0]
      assert.match(firstLineOf, /LOG  hello world$/)
      // The error entry must contain both 'boom' and 'kaboom' (stack or
      // bare message).
      assert.ok(contents.includes('boom') && contents.includes('kaboom'))
      // INFO + WARN entries appear in order before ERR.
      const ts = (regex) => contents.search(regex)
      assert.ok(ts(/INFO numbers: 42/) > 0)
      assert.ok(ts(/WARN careful/) > ts(/INFO numbers: 42/))
      assert.ok(ts(/ERR /) > ts(/WARN careful/))

      // sidecar.getLogPath through dispatch.
      const reply = await dispatch({ jsonrpc: '2.0', id: 'log-1', method: 'sidecar.getLogPath' })
      assert.equal(reply.result.path, logPath)

      // POSIX mode 0600 on the file.
      if (process.platform !== 'win32') {
        const mode = statSync(logPath).mode & 0o777
        assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
      }

      // Rotate: write >5MB, re-init, file gets truncated.
      writeFileSync(logPath, 'X'.repeat(6 * 1024 * 1024), { mode: 0o600 })
      assert.ok(statSync(logPath).size > 5 * 1024 * 1024)
      logger.initLogger()
      assert.equal(statSync(logPath).size, 0, 'oversized log must be rotated to empty')

      // attachProcessHooks is idempotent — second call doesn't re-bind.
      const before = process.listenerCount('uncaughtException')
      logger.attachProcessHooks()
      logger.attachProcessHooks()
      const after = process.listenerCount('uncaughtException')
      assert.ok(after - before <= 1,
        `attachProcessHooks must add at most one listener, added ${after - before}`)

      // Logger silently swallows write failures — point the override at
      // a path inside a deleted dir, log, no throw.
      const ghostDir = join(tmpRoot, 'gone')
      const ghostPath = join(ghostDir, 'log')
      logger.__setLogPathOverrideForTests(ghostPath)
      logger.initLogger()
      // initLogger creates the dir; then we delete it to force append failure.
      rmSync(ghostDir, { recursive: true, force: true })
      // Should not throw.
      logger.warn('this write fails silently')
    } finally {
      logger.__setLogPathOverrideForTests(null)
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

  // Handler that throws produces -32000 with the message verbatim.
  registerHandler('test.boom', async () => { throw new Error('kapow') })
  const boom = await dispatch({ jsonrpc: '2.0', id: 9, method: 'test.boom' })
  assert.equal(boom.error.code, -32000)
  assert.equal(boom.error.message, 'kapow')

  // Duplicate registration throws — protects us against accidental override.
  assert.throws(() => registerHandler('ping', () => 1), /already registered/)
  assert.ok(handlers.has('ping'))

  // Codex history events must use the same payload keys as Claude
  // history events. Remote legacy clients receive args via those keys
  // (`items` / `loading`), while the renderer fallback also accepts the
  // older `{payload}` shape. Do not regress remote profile restore.
  {
    const codexSource = readFileSync(resolve(here, '..', 'src', 'handlers', 'codex.mjs'), 'utf-8')
    assert.ok(
      codexSource.includes("send('claude:history', sessionId, 'items', items)"),
      'Codex history must emit {items} for legacy remote clients',
    )
    assert.ok(
      codexSource.includes("send('claude:resume-loading', sessionId, 'loading', true)"),
      'Codex resume-loading must emit {loading} for legacy remote clients',
    )
    assert.ok(
      !codexSource.includes("send('claude:history', sessionId, 'payload'"),
      'Codex history must not emit payload-only history events',
    )
  }

  {
    const { isCodexThreadNotFoundError } = await import('../src/handlers/codex.mjs')
    assert.equal(
      isCodexThreadNotFoundError('thread not found: 019e1bfc-e8f6-77e1-9886-1833ce991217'),
      true,
    )
    assert.equal(isCodexThreadNotFoundError(new Error('Thread 019e1bfc not found')), true)
    assert.equal(isCodexThreadNotFoundError('rate limit exceeded'), false)
  }

  // Session lifecycle stubs validate sessionId and return ok.
  const start = await dispatch({ jsonrpc: '2.0', id: 100, method: 'claude.startSession', params: { sessionId: 's-1', options: { cwd: '/x' } } })
  assert.equal(start.result.ok, true)
  assert.equal(start.result.sessionId, 's-1')
  const stop = await dispatch({ jsonrpc: '2.0', id: 101, method: 'claude.stopSession', params: { sessionId: 's-1' } })
  assert.equal(stop.result.ok, true)
  assert.equal(stop.result.existed, true)
  // Stopping an unknown session returns existed=false rather than erroring.
  const stop2 = await dispatch({ jsonrpc: '2.0', id: 102, method: 'claude.stopSession', params: { sessionId: 'unknown' } })
  assert.equal(stop2.result.existed, false)
  // Missing sessionId rejects.
  const bad = await dispatch({ jsonrpc: '2.0', id: 103, method: 'claude.sendMessage', params: {} })
  assert.equal(bad.error.code, -32000)
  assert.match(bad.error.message, /missing sessionId/)

  // update version comparison moved to Rust (commands/update.rs).

  // findClaudeCliPath — point PATH at a temp dir containing a fake claude
  // binary and confirm the helper finds it. Cross-platform: on Windows we
  // create claude.cmd, elsewhere a plain `claude` file.
  const { findClaudeCliPath, listSessionsFallback } = mod
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'sidecar-bin-'))
  try {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'claude.cmd' : 'claude'
    const exePath = join(fakeBinDir, exeName)
    writeFileSync(exePath, isWin ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = fakeBinDir
    try {
      const found = findClaudeCliPath()
      assert.equal(found, exePath)
    } finally {
      process.env.PATH = savedPath
    }
    // Empty PATH → returns null rather than throwing.
    const savedPath2 = process.env.PATH
    process.env.PATH = ''
    try {
      const found = findClaudeCliPath()
      assert.equal(found, null)
    } finally {
      process.env.PATH = savedPath2
    }
  } finally {
    rmSync(fakeBinDir, { recursive: true, force: true })
  }

  // listSessionsFallback — fabricate a fake ~/.claude/projects layout
  // by overriding HOME to a temp dir, write a JSONL session, and assert
  // the parsed shape matches the SessionSummary contract.
  const fakeHome = mkdtempSync(join(tmpdir(), 'sidecar-home-'))
  const cwd = '/test/project'
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const projectDir = join(fakeHome, '.claude', 'projects', encoded)
  mkdirSync(projectDir, { recursive: true })
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: 'hello world from test' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } }),
    JSON.stringify({ type: 'summary', summary: 'A useful session name' }),
    'malformed line should be skipped',
    JSON.stringify({ type: 'user', message: { content: 'second user msg' } }),
  ].join('\n') + '\n'
  writeFileSync(join(projectDir, 'sess-abc.jsonl'), jsonl)

  const savedHome = process.env.HOME
  const savedUserProfile = process.env.USERPROFILE
  // Node's os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
  // The helper captured CLAUDE_PROJECTS_DIR at module-load time so we
  // can't override after the fact — instead run the helper with a
  // forced cwd whose encoded form points at our fake home, then put
  // the file under the *real* expected location. We do that by writing
  // to the actual ~/.claude/projects under a unique cwd encoding so we
  // don't collide with real sessions, and clean up afterward.
  process.env.HOME = savedHome
  process.env.USERPROFILE = savedUserProfile
  try {
    // Use a unique cwd that maps to a directory we own, located under
    // the *real* CLAUDE_PROJECTS_DIR, so the helper finds it without
    // needing module re-init.
    const { homedir } = await import('node:os')
    const realProjectsBase = join(homedir(), '.claude', 'projects')
    const uniqueCwd = `/__sidecar_test__/${Date.now()}_${Math.random().toString(36).slice(2)}`
    const uniqueEncoded = uniqueCwd.replace(/[^a-zA-Z0-9]/g, '-')
    const realDir = join(realProjectsBase, uniqueEncoded)
    mkdirSync(realDir, { recursive: true })
    try {
      writeFileSync(join(realDir, 'sess-test.jsonl'), jsonl)
      const sessions = await listSessionsFallback(uniqueCwd)
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].sdkSessionId, 'sess-test')
      assert.equal(sessions[0].preview, 'hello world from test')
      assert.equal(sessions[0].customTitle, 'A useful session name')
      assert.equal(sessions[0].firstPrompt, 'hello world from test')
      assert.equal(sessions[0].summary, 'A useful session name')
      assert.equal(sessions[0].messageCount, 4) // 4 valid lines, 1 skipped
      assert.equal(typeof sessions[0].timestamp, 'number')
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
    // Empty cwd → returns []
    const empty = await listSessionsFallback('')
    assert.deepEqual(empty, [])
    // Non-existent project dir → returns []
    const nonExistent = await listSessionsFallback('/this/does/not/exist/anywhere')
    assert.deepEqual(nonExistent, [])
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }

  // Codex session listing is cwd-scoped. Codex stores sessions under a
  // date tree, so the only reliable filter is session_meta.payload.cwd.
  {
    const { listCodexSessions } = await import('../src/handlers/codex.mjs')
    const codexRoot = mkdtempSync(join(tmpdir(), 'sidecar-codex-sessions-'))
    const nested = join(codexRoot, '2026', '05', '12')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'rollout-a.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-a', cwd: '/repo/app' } }),
      JSON.stringify({ type: 'event_msg', payload: { input: 'ping\nsecond line' } }),
    ].join('\n') + '\n')
    writeFileSync(join(nested, 'rollout-b.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-b', cwd: '/repo/other' } }),
      JSON.stringify({ type: 'event_msg', payload: { input: 'other cwd' } }),
    ].join('\n') + '\n')
    try {
      const sessions = await listCodexSessions('/repo/app/', codexRoot)
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].sdkSessionId, 'codex-a')
      assert.equal(sessions[0].preview, 'ping')
      assert.deepEqual(await listCodexSessions('/repo/missing', codexRoot), [])
    } finally {
      rmSync(codexRoot, { recursive: true, force: true })
    }
  }

  // readAccountIndex — point BAT_SIDECAR_DATA_DIR at a temp dir, drop a
  // claude-accounts.json shaped like the Electron AccountManager writes,
  // confirm only public fields come back. Also covers the missing-file
  // and corrupt-file branches.
  const { resolveDataDir, readAccountIndex } = mod
  const savedDataDir2 = process.env.BAT_SIDECAR_DATA_DIR
  // Branch 1: env not set — resolveDataDir falls back to a platform default.
  delete process.env.BAT_SIDECAR_DATA_DIR
  const fallback = resolveDataDir()
  assert.ok(fallback.includes('better-agent-terminal') || fallback.includes('BetterAgentTerminal'),
    `unexpected fallback data dir: ${fallback}`)

  // Branch 2: env set, file missing → []
  const fakeData = mkdtempSync(join(tmpdir(), 'sidecar-data-'))
  try {
    process.env.BAT_SIDECAR_DATA_DIR = fakeData
    assert.equal(resolveDataDir(), fakeData)
    const empty = await readAccountIndex()
    assert.deepEqual(empty, { accounts: [], activeAccountId: null, switchWarningShown: false })

    // Branch 3: file exists with valid index — returns sanitized accounts.
    writeFileSync(join(fakeData, 'claude-accounts.json'), JSON.stringify({
      accounts: [
        { id: 'a1', email: 'a1@example.com', subscriptionType: 'pro', isDefault: true, createdAt: 1000, credentialSnapshot: 'should-be-stripped' },
        { id: 'a2', email: 'a2@example.com', isDefault: false, createdAt: 2000 },
        { id: '', email: 'no-id@example.com' }, // dropped — invalid
        { id: 'a3' }, // dropped — no email
      ],
      activeAccountId: 'a1',
      switchWarningShown: true,
    }))
    const idx = await readAccountIndex()
    assert.equal(idx.accounts.length, 2)
    assert.equal(idx.accounts[0].id, 'a1')
    assert.equal(idx.accounts[0].email, 'a1@example.com')
    assert.equal(idx.accounts[0].isDefault, true)
    assert.equal(idx.accounts[0].subscriptionType, 'pro')
    assert.equal('credentialSnapshot' in idx.accounts[0], false, 'leaked private field')
    assert.equal(idx.accounts[1].id, 'a2')
    assert.equal(idx.accounts[1].isDefault, false)
    assert.equal(idx.activeAccountId, 'a1')
    assert.equal(idx.switchWarningShown, true)

    // Branch 4: corrupt file → empty wrapper.
    writeFileSync(join(fakeData, 'claude-accounts.json'), '{ this is not json')
    const corrupt = await readAccountIndex()
    assert.deepEqual(corrupt, { accounts: [], activeAccountId: null, switchWarningShown: false })

    // accountMarkWarningShown persists the warning flag even when the
    // previous index was corrupt, matching the renderer's expectation
    // that the one-time warning does not reappear after acknowledgement.
    const marked = await dispatch({ jsonrpc: '2.0', id: 34, method: 'claude.accountMarkWarningShown' })
    assert.equal(marked.result, true)
    const afterMark = await readAccountIndex()
    assert.deepEqual(afterMark, { accounts: [], activeAccountId: null, switchWarningShown: true })
  } finally {
    rmSync(fakeData, { recursive: true, force: true })
    if (savedDataDir2 === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = savedDataDir2
  }

  // openai API key storage moved to Rust (commands/openai.rs).

  // scanSkills — fabricate a project-scoped .claude/skills/ tree and
  // verify both top-level *.md and SKILL.md-in-subdir paths are picked
  // up, frontmatter is parsed, and dedup-by-name kicks in.
  const { scanSkills, parseSkillFrontmatter } = mod
  // parseSkillFrontmatter unit checks: empty input, no frontmatter, valid.
  assert.deepEqual(parseSkillFrontmatter(''), {})
  assert.deepEqual(parseSkillFrontmatter('# heading only'), {})
  assert.deepEqual(parseSkillFrontmatter('---\nname: foo\ndescription: "with quotes"\n---\nbody'),
    { name: 'foo', description: 'with quotes' })

  const fakeProject = mkdtempSync(join(tmpdir(), 'sidecar-skills-'))
  try {
    const skillsDir = join(fakeProject, '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    // Top-level .md skill
    writeFileSync(join(skillsDir, 'flat.md'),
      '---\nname: flat-skill\ndescription: a flat skill\n---\nbody here\n')
    // Subdir with SKILL.md
    const sub = join(skillsDir, 'nested')
    mkdirSync(sub)
    writeFileSync(join(sub, 'SKILL.md'),
      '# Nested\n\nNo frontmatter, fall back to first heading.\n')
    // Empty subdir without SKILL.md — silently skipped
    mkdirSync(join(skillsDir, 'empty'))

    const skills = await scanSkills(fakeProject)
    const byName = new Map(skills.map(s => [s.name, s]))
    assert.ok(byName.has('flat-skill'), 'missing flat-skill')
    assert.equal(byName.get('flat-skill').description, 'a flat skill')
    assert.equal(byName.get('flat-skill').scope, 'project')
    assert.ok(byName.has('nested'), 'missing nested skill')
    assert.equal(byName.get('nested').description, 'Nested')
  } finally {
    rmSync(fakeProject, { recursive: true, force: true })
  }

  // agent preset list moved to Rust (commands/agent.rs).

  // Both sides derive their model lists from a hand-maintained
  // CLAUDE_MODEL_TABLE, so diffing the two tables covers the whole product of
  // models × auto-compact windows in one shot: a renderer-only addition fails
  // here regardless of which derived list it would have shown up in.
  const { CLAUDE_BUILTIN_MODELS } = mod
  const { CLAUDE_MODEL_TABLE } = await import('../src/lib/models.mjs')
  const presetsFile = await readFile(
    new URL('../../renderer/src/utils/claude-model-presets.ts', import.meta.url), 'utf-8',
  )
  const tableMatch = presetsFile.match(/CLAUDE_MODEL_TABLE[^=]*=\s*\[([\s\S]*?)\n\]/m)
  assert.ok(tableMatch, 'could not locate CLAUDE_MODEL_TABLE in source')
  const numeric = raw => Number(raw.replace(/_/g, ''))
  // One object literal per model, and the table has no nested braces, so a
  // brace-to-brace match is enough to split the entries.
  const tsTable = [...tableMatch[1].matchAll(/\{([^{}]*)\}/g)].map(entry => {
    const field = re => entry[1].match(re)?.[1]
    return {
      id: field(/id:\s*'([^']+)'/),
      label: field(/label:\s*'([^']+)'/),
      contextWindow: numeric(field(/contextWindow:\s*([\d_]+)/) ?? '0'),
      windows: (field(/windows:\s*\[([^\]]*)\]/) ?? '')
        .split(',').map(w => w.trim()).filter(Boolean)
        .map(w => (w === 'null' ? null : numeric(w))),
      description: field(/description:\s*'([^']*)'/) ?? null,
    }
  })
  assert.ok(tsTable.length > 0, 'parsed an empty CLAUDE_MODEL_TABLE from source')
  assert.deepStrictEqual(
    CLAUDE_MODEL_TABLE.map(def => ({ ...def, description: def.description ?? null })),
    tsTable,
    'sidecar CLAUDE_MODEL_TABLE drifted from renderer/src/utils/claude-model-presets.ts',
  )

  // The derived lists get their own guards, with the expected side computed
  // from the TS table — so drift in either the table or the sidecar's
  // derivation of it is caught.
  const tsPresetId = (def, window) => (window === null
    ? `${def.id}:${def.contextWindow / 1_000_000}m`
    : `${def.id}:auto-compact-${window / 1000}k`)
  const tsValues = tsTable.flatMap(def =>
    (def.windows.length === 0 ? [def.id] : def.windows.map(window => tsPresetId(def, window))))
  const sidecarValues = CLAUDE_BUILTIN_MODELS.map(m => m.value)
  assert.deepEqual(
    [...sidecarValues].sort(),
    [...tsValues].sort(),
    `sidecar CLAUDE_BUILTIN_MODELS drifted from renderer/src/utils/claude-model-presets.ts (sidecar=${sidecarValues}, ts=${tsValues})`,
  )

  // Dedup set for SDK results: every base id, plus the `[1m]` alias the SDK
  // reports for 1M-capable models. Mismatch means getSupportedModels would
  // either leak duplicate entries from the SDK or hide a legitimate SDK-only
  // model from the picker.
  const { CLAUDE_BUILTIN_DEDUP_KEYS } = mod
  const tsCtxMap = new Map(tsTable.flatMap(def => (def.contextWindow >= 1_000_000
    ? [[def.id, def.contextWindow], [`${def.id}[1m]`, def.contextWindow]]
    : [[def.id, def.contextWindow]])))
  const ctxKeys = [...tsCtxMap.keys()]
  assert.deepEqual(
    [...CLAUDE_BUILTIN_DEDUP_KEYS].sort(),
    [...ctxKeys].sort(),
    `sidecar CLAUDE_BUILTIN_DEDUP_KEYS drifted from the renderer model table (sidecar=${CLAUDE_BUILTIN_DEDUP_KEYS}, ts=${ctxKeys})`,
  )
  // Round-trip the handler. Result may include SDK-discovered entries
  // when @anthropic-ai/claude-agent-sdk is importable (dev), or only
  // builtins when it isn't (release without bundled node_modules).
  // Either way: every builtin must be present + tagged source:'builtin',
  // and every additional entry must be tagged source:'sdk'.
  const { __setSdkOverrideForTests, __resetMetadataCacheForTests } = mod
  // Process-lifetime metadata cache could mask state changes between
  // assertion blocks. Clear before the first round so each block sees
  // a cold rebuild.
  __resetMetadataCacheForTests()
  const modelsReply = await dispatch({
    jsonrpc: '2.0', id: 60, method: 'claude.getSupportedModels',
    params: { sessionId: 'irrelevant' },
  })
  assert.ok(Array.isArray(modelsReply.result))
  assert.ok(modelsReply.result.length >= CLAUDE_BUILTIN_MODELS.length,
    `expected at least ${CLAUDE_BUILTIN_MODELS.length} models, got ${modelsReply.result.length}`)
  const builtinValues = new Set(CLAUDE_BUILTIN_MODELS.map(m => m.value))
  const seenBuiltins = new Set()
  for (const m of modelsReply.result) {
    assert.equal(typeof m.displayName, 'string')
    assert.equal(typeof m.description, 'string')
    if (builtinValues.has(m.value)) {
      assert.equal(m.source, 'builtin', `expected source=builtin for ${m.value}`)
      seenBuiltins.add(m.value)
    } else {
      assert.equal(m.source, 'sdk', `expected source=sdk for non-builtin ${m.value}`)
    }
  }
  assert.equal(seenBuiltins.size, CLAUDE_BUILTIN_MODELS.length,
    'not all builtin models present in result')

  // Explicit fallback contract: when SDK is unavailable (release build
  // without node_modules), getSupportedModels MUST return exactly the
  // builtins. Pin this with the override hook so dev passing can never
  // mask a release regression.
  __setSdkOverrideForTests(null)
  __resetMetadataCacheForTests()
  try {
    const fallbackReply = await dispatch({
      jsonrpc: '2.0', id: 61, method: 'claude.getSupportedModels',
    })
    assert.equal(fallbackReply.result.length, CLAUDE_BUILTIN_MODELS.length,
      'SDK-unavailable path must return exactly builtin count')
    for (const m of fallbackReply.result) {
      assert.equal(m.source, 'builtin')
    }
  } finally {
    __setSdkOverrideForTests(undefined)
    __resetMetadataCacheForTests()
  }

  // Positive augmentation contract with a fake SDK: one model dupes a
  // builtin base id (must be filtered), one is a [1m] variant of a
  // base id (must be filtered — base+[1m] form is in the dedup set),
  // one is genuinely new (must appear tagged 'sdk').
  // Note: dedup operates on CLAUDE_BUILTIN_DEDUP_KEYS (base ids and
  // [1m] variants), not on CLAUDE_BUILTIN_MODELS.value (which contains
  // preset suffixes like :auto-compact-200k that the SDK never emits).
  const fakeSdk = {
    query() {
      return {
        async supportedModels() {
          return [
            { value: 'claude-opus-4-6', displayName: 'dup', description: 'dup' },
            { value: 'claude-sonnet-4-6[1m]', displayName: '1m variant', description: '1m' },
            { value: 'fake-sdk-only-model', displayName: 'fake', description: 'fake-only' },
          ]
        },
      }
    },
  }
  __setSdkOverrideForTests(fakeSdk)
  __resetMetadataCacheForTests()
  try {
    const augReply = await dispatch({
      jsonrpc: '2.0', id: 62, method: 'claude.getSupportedModels',
    })
    assert.equal(augReply.result.length, CLAUDE_BUILTIN_MODELS.length + 1,
      'expected exactly one new SDK-only entry after dedup')
    const fake = augReply.result.find(m => m.value === 'fake-sdk-only-model')
    assert.ok(fake, 'fake SDK-only model missing from result')
    assert.equal(fake.source, 'sdk')
    // Duped builtin still present and tagged 'builtin' (not overwritten).
    const dupBase = augReply.result.find(m => m.value === 'claude-opus-4-6')
    assert.equal(dupBase.source, 'builtin')
    // [1m] variant of a base id should NOT appear at all (no builtin
    // entry uses that value, and SDK entry was filtered).
    assert.ok(
      !augReply.result.some(m => m.value === 'claude-sonnet-4-6[1m]'),
      '[1m] variant of base builtin id leaked through dedup',
    )
  } finally {
    __setSdkOverrideForTests(undefined)
    __resetMetadataCacheForTests()
  }

  // Metadata cache contract. getSupportedModels still spawns a fresh
  // sdk.query() on cache miss (Electron parity); the 5-minute TTL cache
  // ensures only the first call within a window pays the spawn cost.
  //
  // The 3 cheap RPCs (getSupportedCommands / getSupportedAgents /
  // getAccountInfo) read from the live `session.currentQuery` set by
  // claude.sendMessage — no fresh spawn ever, just a method call on
  // an already-initialized Query instance. When the session lacks a
  // currentQuery (panel mounted but user hasn't sent a message yet),
  // they return [] / null inertly instead of paying ~4s of spawn cost.
  //
  // Cache contracts pinned here:
  //   (a) Second call within TTL must NOT invoke the SDK builder.
  //   (b) __resetMetadataCacheForTests forces a rebuild.
  //   (c) Concurrent calls share the in-flight promise — only one
  //       SDK build runs even if 4 callers fire simultaneously.
  //
  // Live-Query contract pinned separately below.
  let modelsBuildCount = 0
  __setSdkOverrideForTests({
    query() {
      return {
        async supportedModels() {
          modelsBuildCount++
          return [{ value: 'cache-test-model', displayName: 'cache', description: 'test' }]
        },
      }
    },
  })
  __resetMetadataCacheForTests()
  try {
    // First call: builder runs.
    await dispatch({ jsonrpc: '2.0', id: 70, method: 'claude.getSupportedModels' })
    assert.equal(modelsBuildCount, 1, 'first call should build')
    // Second + third call within TTL: no extra builder runs.
    await dispatch({ jsonrpc: '2.0', id: 71, method: 'claude.getSupportedModels' })
    await dispatch({ jsonrpc: '2.0', id: 72, method: 'claude.getSupportedModels' })
    assert.equal(modelsBuildCount, 1, 'second/third call must hit cache')
    // Reset → next call rebuilds.
    __resetMetadataCacheForTests()
    await dispatch({ jsonrpc: '2.0', id: 73, method: 'claude.getSupportedModels' })
    assert.equal(modelsBuildCount, 2, 'after reset, builder must run again')

    // Concurrent-call dedup: 4 callers in-flight simultaneously share
    // the same builder run.
    __resetMetadataCacheForTests()
    modelsBuildCount = 0
    const racers = await Promise.all([
      dispatch({ jsonrpc: '2.0', id: 74, method: 'claude.getSupportedModels' }),
      dispatch({ jsonrpc: '2.0', id: 75, method: 'claude.getSupportedModels' }),
      dispatch({ jsonrpc: '2.0', id: 76, method: 'claude.getSupportedModels' }),
      dispatch({ jsonrpc: '2.0', id: 77, method: 'claude.getSupportedModels' }),
    ])
    assert.equal(modelsBuildCount, 1,
      `4 concurrent callers should share one build, ran ${modelsBuildCount} times`)
    // All callers got the same set (builtins + the one fake SDK entry).
    for (const r of racers) {
      assert.ok(r.result.some(m => m.value === 'cache-test-model'),
        'fake SDK model should appear in all racer results')
    }
  } finally {
    __setSdkOverrideForTests(undefined)
    __resetMetadataCacheForTests()
  }

  // Live-Query contract for the 3 cheap RPCs.
  //   (a) No session / no sessionId      → [] / null (inert default).
  //   (b) Session with no currentQuery   → [] / null (no fresh spawn).
  //   (c) Session with currentQuery      → reads from live Query.
  //   (d) Live Query method throws       → []/null (graceful degrade).
  // Mirrors electron/claude-agent-manager.ts:2079-2099 — the renderer
  // panel re-fetches after the first claude:status arrives, by which
  // point the session has a real currentQuery from sendMessage.
  __resetMetadataCacheForTests()
  // (a) No sessionId at all → empty/null without spawning anything.
  const noSessCmds = await dispatch({ jsonrpc: '2.0', id: 80, method: 'claude.getSupportedCommands' })
  assert.deepEqual(noSessCmds.result, [], 'no sessionId should return []')
  const noSessAgents = await dispatch({ jsonrpc: '2.0', id: 81, method: 'claude.getSupportedAgents' })
  assert.deepEqual(noSessAgents.result, [])
  const noSessAccount = await dispatch({ jsonrpc: '2.0', id: 82, method: 'claude.getAccountInfo' })
  assert.equal(noSessAccount.result, null)

  // (b) Unknown sessionId → same inert defaults.
  __resetMetadataCacheForTests()
  const unkCmds = await dispatch({ jsonrpc: '2.0', id: 83, method: 'claude.getSupportedCommands', params: { sessionId: 'never-existed' } })
  assert.deepEqual(unkCmds.result, [])

  // (c) Session with currentQuery → reads from live Query.
  await dispatch({ jsonrpc: '2.0', id: 84, method: 'claude.startSession', params: { sessionId: 'live-meta', options: { cwd: '/x' } } })
  const liveSession = mod.sessions.get('live-meta')
  let cmdsCallCount = 0
  let agentsCallCount = 0
  let accountCallCount = 0
  liveSession.currentQuery = {
    async supportedCommands() {
      cmdsCallCount++
      return [{ name: 'live-cmd', description: 'from live Query' }]
    },
    async supportedAgents() {
      agentsCallCount++
      return [{ name: 'live-agent', description: 'from live Query' }]
    },
    async accountInfo() {
      accountCallCount++
      return { email: 'live@example.com', subscriptionType: 'pro' }
    },
  }
  __resetMetadataCacheForTests()
  const liveCmds = await dispatch({ jsonrpc: '2.0', id: 85, method: 'claude.getSupportedCommands', params: { sessionId: 'live-meta' } })
  assert.equal(liveCmds.result[0].name, 'live-cmd')
  assert.equal(cmdsCallCount, 1)
  // Second call within TTL hits cache, doesn't re-call the live Query.
  await dispatch({ jsonrpc: '2.0', id: 86, method: 'claude.getSupportedCommands', params: { sessionId: 'live-meta' } })
  assert.equal(cmdsCallCount, 1, 'second call must hit cache, not re-call Query')

  const liveAgents = await dispatch({ jsonrpc: '2.0', id: 87, method: 'claude.getSupportedAgents', params: { sessionId: 'live-meta' } })
  assert.equal(liveAgents.result[0].name, 'live-agent')
  assert.equal(agentsCallCount, 1)

  const liveAccount = await dispatch({ jsonrpc: '2.0', id: 88, method: 'claude.getAccountInfo', params: { sessionId: 'live-meta' } })
  assert.equal(liveAccount.result.email, 'live@example.com')
  assert.equal(accountCallCount, 1)

  // (d) Live Query method throws → graceful empty/null.
  __resetMetadataCacheForTests()
  liveSession.currentQuery = {
    async supportedCommands() { throw new Error('query died') },
    async supportedAgents() { throw new Error('query died') },
    async accountInfo() { throw new Error('query died') },
  }
  const throwCmds = await dispatch({ jsonrpc: '2.0', id: 89, method: 'claude.getSupportedCommands', params: { sessionId: 'live-meta' } })
  assert.deepEqual(throwCmds.result, [], 'thrown error must degrade to []')
  const throwAgents = await dispatch({ jsonrpc: '2.0', id: 90, method: 'claude.getSupportedAgents', params: { sessionId: 'live-meta' } })
  assert.deepEqual(throwAgents.result, [])
  const throwAccount = await dispatch({ jsonrpc: '2.0', id: 91, method: 'claude.getAccountInfo', params: { sessionId: 'live-meta' } })
  assert.equal(throwAccount.result, null)

  // (e) An empty answer must not be remembered. This is the whole of GH #123:
  // the panel asks on mount, before any turn has spawned a CLI, so the honest
  // answer is []. Caching that for the full 5-minute TTL meant the query coming
  // up a second later could not dislodge it, and Claude Code's own commands,
  // plugin commands and skills stayed invisible in the slash menu for the rest
  // of the session. The empty answer is still returned — it just goes uncached.
  __resetMetadataCacheForTests()
  liveSession.currentQuery = null
  const tooEarly = await dispatch({ jsonrpc: '2.0', id: 92, method: 'claude.getSupportedCommands', params: { sessionId: 'live-meta' } })
  assert.deepEqual(tooEarly.result, [], 'no live query yet still answers []')

  let lateCallCount = 0
  liveSession.currentQuery = {
    async supportedCommands() {
      lateCallCount++
      return [{ name: 'security-review', description: 'from the CLI' }]
    },
    async supportedAgents() { return [{ name: 'late-agent', description: 'from the CLI' }] },
  }
  const afterQueryLive = await dispatch({ jsonrpc: '2.0', id: 93, method: 'claude.getSupportedCommands', params: { sessionId: 'live-meta' } })
  assert.equal(lateCallCount, 1, 'the cached [] must not short-circuit the retry')
  assert.equal(afterQueryLive.result[0].name, 'security-review')
  // A real answer is still worth caching — the fix must not turn every menu
  // open into a fresh SDK read.
  await dispatch({ jsonrpc: '2.0', id: 94, method: 'claude.getSupportedCommands', params: { sessionId: 'live-meta' } })
  assert.equal(lateCallCount, 1, 'a non-empty answer must still be cached')

  // Same trap, same fix, for the agent list.
  const lateAgents = await dispatch({ jsonrpc: '2.0', id: 95, method: 'claude.getSupportedAgents', params: { sessionId: 'live-meta' } })
  assert.equal(lateAgents.result[0].name, 'late-agent')

  // Cleanup: drop the test session so later assertions don't see it.
  mod.sessions.delete('live-meta')
  __resetMetadataCacheForTests()

  // Workspace-with-2-panels-each-pings smoke. The reported repro is:
  // open a workspace, mount Claude + Codex agent panels, type "ping" in
  // each. The renderer surfaces failures as `[object Object]` unhandled
  // promise rejections because `await window.batAppAPI.claude.sendMessage`
  // (ClaudeAgentPanel:1809, CodexAgentPanel:1829) is bare — if any of
  // the RPCs in this sequence rejects, the panel onClick chain explodes.
  // This test pins the contract: every RPC the renderer fires during
  // panel mount + ping must return `.result`, never `.error`. A new
  // breakage in any of the 7 metadata reads / 1 sendMessage shows up as
  // an immediate red here, with the failing method named.
  const pingFakeSdk = {
    query() {
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-ping-1', cwd: '/x' }
        yield { type: 'result', subtype: 'success', session_id: 'sdk-ping-1', result: 'pong', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1, usage: {} }
      })()
    },
  }
  __setSdkOverrideForTests(pingFakeSdk)
  __resetMetadataCacheForTests()
  try {
    // Two sessions, mirroring the user's two-panel workspace.
    for (const sessionId of ['ws-claude-1', 'ws-codex-1']) {
      // Panel mount RPC fan-out (ClaudeAgentPanel.tsx:1120-1180 effects
      // + CodexAgentPanel.tsx:1120-1180 — same code). All metadata reads
      // are .then().catch() in the renderer, so any reject would be
      // swallowed silently — but we want them to never reject in the
      // first place, since the underlying handlers must be panic-free.
      await dispatch({ jsonrpc: '2.0', id: 700, method: 'claude.startSession',
        params: { sessionId, options: { cwd: '/x', model: 'claude-sonnet-4-6' } } })
      const mountRpcs = [
        { method: 'claude.getSessionMeta', params: { sessionId } },
        { method: 'claude.getSupportedModels', params: { sessionId } },
        { method: 'claude.getAccountInfo', params: { sessionId } },
        { method: 'claude.getSupportedCommands', params: { sessionId } },
        { method: 'claude.getSupportedAgents', params: { sessionId } },
        { method: 'claude.getSessionState', params: { sessionId } },
        { method: 'claude.getContextUsage', params: { sessionId } },
      ]
      for (const [i, rpc] of mountRpcs.entries()) {
        const reply = await dispatch({ jsonrpc: '2.0', id: 710 + i, ...rpc })
        assert.ok(reply.error === undefined,
          `panel mount RPC ${rpc.method} for ${sessionId} returned error: ${JSON.stringify(reply.error)}`)
        assert.ok('result' in reply,
          `panel mount RPC ${rpc.method} for ${sessionId} missing result key`)
      }
      // ping send. ClaudeAgentPanel:1809 is `await sendMessage(...)`
      // with NO try/catch — if this rejects, the user sees an
      // unhandled promise rejection. Pin: it must resolve.
      const sendReply = await dispatch({ jsonrpc: '2.0', id: 720,
        method: 'claude.sendMessage', params: { sessionId, prompt: 'ping' } })
      assert.ok(sendReply.error === undefined,
        `claude.sendMessage('${sessionId}','ping') errored: ${JSON.stringify(sendReply.error)}`)
      assert.ok(sendReply.result?.ok === true,
        `claude.sendMessage('${sessionId}','ping') did not resolve {ok:true}; got ${JSON.stringify(sendReply.result)}`)
    }
    // Cleanup the two synthetic sessions.
    mod.sessions.delete('ws-claude-1')
    mod.sessions.delete('ws-codex-1')
  } finally {
    __setSdkOverrideForTests(undefined)
    __resetMetadataCacheForTests()
  }

  // claude.checkMcpJsonStatus / enableAllProjectMcp.
  //
  // The Claude CLI silently ignores `<cwd>/.mcp.json` unless one of the
  // settings files (user / project / project.local) supplies an
  // approval marker. ClaudeAgentPanel uses these two RPCs on mount to
  // detect unapproved .mcp.json and offer a one-click fix. The check
  // logic is the matrix below — pin every branch so a future settings
  // schema change can't silently break the renderer prompt.
  //
  // We isolate by pointing $HOME at a mkdtemp dir for the duration
  // (since the user-level settings file lives at ~/.claude/settings.json
  // and we don't want a real dev-machine settings.json to mask the test).
  const mcpRoot = mkdtempSync(join(tmpdir(), 'mcp-status-'))
  const mcpHome = join(mcpRoot, 'home'); mkdirSync(mcpHome, { recursive: true })
  const mcpProj = join(mcpRoot, 'proj'); mkdirSync(mcpProj, { recursive: true })
  const mcpSavedHome = process.env.HOME
  const mcpSavedUserProfile = process.env.USERPROFILE
  process.env.HOME = mcpHome
  process.env.USERPROFILE = mcpHome  // os.homedir() reads this on Windows
  try {
    // (a) no .mcp.json present → exists:false, approved:false, servers:[]
    let r = await dispatch({ jsonrpc: '2.0', id: 800,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.deepEqual(r.result, { exists: false, approved: false, servers: [] })

    // (b) .mcp.json present but no settings → exists:true, approved:false
    writeFileSync(join(mcpProj, '.mcp.json'),
      JSON.stringify({ mcpServers: { foo: { command: 'x' }, bar: { command: 'y' } } }))
    r = await dispatch({ jsonrpc: '2.0', id: 801,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.exists, true)
    assert.equal(r.result.approved, false)
    assert.deepEqual(r.result.servers.sort(), ['bar', 'foo'])

    // (c) approved via enableAllProjectMcpServers in PROJECT settings
    mkdirSync(join(mcpProj, '.claude'), { recursive: true })
    writeFileSync(join(mcpProj, '.claude', 'settings.json'),
      JSON.stringify({ enableAllProjectMcpServers: true, otherKey: 'keep' }))
    r = await dispatch({ jsonrpc: '2.0', id: 802,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, true, 'enableAllProjectMcpServers in project settings approves')

    // (d) approved via exhaustive enabledMcpjsonServers list
    writeFileSync(join(mcpProj, '.claude', 'settings.json'),
      JSON.stringify({ enabledMcpjsonServers: ['foo', 'bar', 'extra'] }))
    r = await dispatch({ jsonrpc: '2.0', id: 803,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, true, 'exhaustive enabledMcpjsonServers approves')

    // (e) PARTIAL enabledMcpjsonServers (1/2 covered) → unapproved
    // — the CLI only attaches individually-listed servers, so reporting
    // approved=true here would mislead the user.
    writeFileSync(join(mcpProj, '.claude', 'settings.json'),
      JSON.stringify({ enabledMcpjsonServers: ['foo'] }))
    r = await dispatch({ jsonrpc: '2.0', id: 804,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, false, 'partial enabledMcpjsonServers must NOT count as approved')

    // (f) approved via USER settings (~/.claude/settings.json) — wipe
    // project settings first so the source-precedence is unambiguous.
    rmSync(join(mcpProj, '.claude', 'settings.json'))
    mkdirSync(join(mcpHome, '.claude'), { recursive: true })
    writeFileSync(join(mcpHome, '.claude', 'settings.json'),
      JSON.stringify({ enableAllProjectMcpServers: true }))
    r = await dispatch({ jsonrpc: '2.0', id: 805,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, true, 'enableAllProjectMcpServers in user settings approves')

    // (g) approved via LOCAL settings (settings.local.json overrides project)
    rmSync(join(mcpHome, '.claude', 'settings.json'))
    writeFileSync(join(mcpProj, '.claude', 'settings.local.json'),
      JSON.stringify({ enableAllProjectMcpServers: true }))
    r = await dispatch({ jsonrpc: '2.0', id: 806,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.equal(r.result.approved, true, 'enableAllProjectMcpServers in settings.local.json approves')
    rmSync(join(mcpProj, '.claude', 'settings.local.json'))

    // (h) malformed .mcp.json (invalid JSON) → treated as no .mcp.json
    writeFileSync(join(mcpProj, '.mcp.json'), '{ this is not json')
    r = await dispatch({ jsonrpc: '2.0', id: 807,
      method: 'claude.checkMcpJsonStatus', params: { cwd: mcpProj } })
    assert.deepEqual(r.result, { exists: false, approved: false, servers: [] })

    // (i) missing cwd param → graceful empty default (no throw)
    r = await dispatch({ jsonrpc: '2.0', id: 808, method: 'claude.checkMcpJsonStatus' })
    assert.deepEqual(r.result, { exists: false, approved: false, servers: [] })

    // --- enableAllProjectMcp ---
    // (j) fresh project (no .claude/ dir, no settings.json) → both created
    const freshProj = join(mcpRoot, 'fresh'); mkdirSync(freshProj, { recursive: true })
    writeFileSync(join(freshProj, '.mcp.json'),
      JSON.stringify({ mcpServers: { only: { command: 'x' } } }))
    let w = await dispatch({ jsonrpc: '2.0', id: 810,
      method: 'claude.enableAllProjectMcp', params: { cwd: freshProj } })
    assert.equal(w.result.ok, true)
    assert.equal(w.result.changed, true, 'fresh write reports changed')
    const written = JSON.parse(await readFile(join(freshProj, '.claude', 'settings.json'), 'utf-8'))
    assert.equal(written.enableAllProjectMcpServers, true)

    // (k) existing settings — preserve other keys
    const presProj = join(mcpRoot, 'preserve'); mkdirSync(join(presProj, '.claude'), { recursive: true })
    writeFileSync(join(presProj, '.claude', 'settings.json'),
      JSON.stringify({ existingKey: 'keep', nested: { deep: 1 } }))
    w = await dispatch({ jsonrpc: '2.0', id: 811,
      method: 'claude.enableAllProjectMcp', params: { cwd: presProj } })
    assert.equal(w.result.changed, true)
    const merged = JSON.parse(await readFile(join(presProj, '.claude', 'settings.json'), 'utf-8'))
    assert.equal(merged.enableAllProjectMcpServers, true)
    assert.equal(merged.existingKey, 'keep', 'existing top-level key preserved')
    assert.deepEqual(merged.nested, { deep: 1 }, 'existing nested key preserved')

    // (l) idempotent — second call when flag is already true → changed:false, file unchanged
    const beforeMtime = (await readFile(join(presProj, '.claude', 'settings.json'), 'utf-8'))
    w = await dispatch({ jsonrpc: '2.0', id: 812,
      method: 'claude.enableAllProjectMcp', params: { cwd: presProj } })
    assert.equal(w.result.changed, false, 'idempotent second call reports changed:false')
    const afterMtime = (await readFile(join(presProj, '.claude', 'settings.json'), 'utf-8'))
    assert.equal(beforeMtime, afterMtime, 'idempotent second call does not rewrite the file')

    // (m) missing cwd → throws (write op needs an explicit target)
    const errReply = await dispatch({ jsonrpc: '2.0', id: 813, method: 'claude.enableAllProjectMcp' })
    assert.ok(errReply.error, 'enableAllProjectMcp without cwd must error')
    assert.match(errReply.error.message, /missing cwd/i)
  } finally {
    if (mcpSavedHome === undefined) delete process.env.HOME
    else process.env.HOME = mcpSavedHome
    if (mcpSavedUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = mcpSavedUserProfile
    rmSync(mcpRoot, { recursive: true, force: true })
  }

  // A renderer can retain module-level "started" state after the host or
  // sidecar restarts. sendMessage must reject before user echo/idempotency
  // bookkeeping and remove the default record it just materialized, so the
  // renderer's recovery getSessionState sees null and calls start/resume.
  const noCwdReply = await dispatch({ jsonrpc: '2.0', id: 190, method: 'claude.sendMessage',
    params: { sessionId: 'phantom-no-cwd', prompt: 'continue', clientMessageId: 'phantom-message-1' } })
  assert.equal(noCwdReply.error?.code, -32000)
  assert.match(noCwdReply.error?.message || '', /session has no cwd/i)
  assert.equal(mod.sessions.has('phantom-no-cwd'), false, 'failed send must not leave a phantom session')
  const noCwdState = await dispatch({ jsonrpc: '2.0', id: 191, method: 'claude.getSessionState',
    params: { sessionId: 'phantom-no-cwd' } })
  assert.equal(noCwdState.result, null)

  // Setter calls may also create a default record before startSession. State
  // lookup must discard it rather than telling self-heal that a live session
  // exists.
  await dispatch({ jsonrpc: '2.0', id: 192, method: 'claude.setModel',
    params: { sessionId: 'phantom-from-setter', model: 'claude-sonnet-4-6' } })
  assert.equal(mod.sessions.has('phantom-from-setter'), true)
  const setterPhantomState = await dispatch({ jsonrpc: '2.0', id: 193, method: 'claude.getSessionState',
    params: { sessionId: 'phantom-from-setter' } })
  assert.equal(setterPhantomState.result, null)
  assert.equal(mod.sessions.has('phantom-from-setter'), false)

  // Per-session state round-trip via dispatch. Verifies setters mutate
  // the session map and getters read back exactly what was written.
  // This is the "stub stays consistent" contract — when SDK lands the
  // setters will additionally push into the live query instance.
  await dispatch({ jsonrpc: '2.0', id: 200, method: 'claude.startSession',
    params: { sessionId: 'state-1', options: { cwd: '/x', model: 'claude-sonnet-4-6', permissionMode: 'acceptEdits' } } })
  // Initial state from startSession options.
  const initState = await dispatch({ jsonrpc: '2.0', id: 201, method: 'claude.getSessionState', params: { sessionId: 'state-1' } })
  assert.equal(initState.result.active, true)
  assert.equal(initState.result.permissionMode, 'acceptEdits')
  assert.equal(initState.result.model, 'claude-sonnet-4-6')

  // worktree session rehydration moved to Rust (commands/worktree.rs +
  // commands/claude.rs claude_get_worktree_status / claude_cleanup_worktree).

  // setAutoContinue persists; usage counter resets.
  await dispatch({ jsonrpc: '2.0', id: 202, method: 'claude.setAutoContinue',
    params: { sessionId: 'state-1', opts: { enabled: true, max: 5, prompt: 'continue' } } })
  const ac = await dispatch({ jsonrpc: '2.0', id: 203, method: 'claude.getAutoContinue', params: { sessionId: 'state-1' } })
  assert.deepEqual(ac.result, { enabled: true, max: 5, used: 0, prompt: 'continue' })

  // setPermissionMode emits claude:modeChange — we can't assert that here
  // without wiring an event collector, but we can at least verify the
  // getter picks up the new value.
  await dispatch({ jsonrpc: '2.0', id: 204, method: 'claude.setPermissionMode',
    params: { sessionId: 'state-1', mode: 'plan' } })
  const meta = await dispatch({ jsonrpc: '2.0', id: 205, method: 'claude.getSessionMeta', params: { sessionId: 'state-1' } })
  assert.equal(meta.result.permissionMode, 'plan')

  // setModel + setEffort.
  await dispatch({ jsonrpc: '2.0', id: 206, method: 'claude.setModel',
    params: { sessionId: 'state-1', model: 'claude-haiku-4-5-20251001', autoCompactWindow: 100000 } })
  await dispatch({ jsonrpc: '2.0', id: 207, method: 'claude.setEffort',
    params: { sessionId: 'state-1', effort: 'high' } })
  await dispatch({ jsonrpc: '2.0', id: 2070, method: 'claude.setEffort',
    params: { sessionId: 'state-1', effort: 'ultracode' } })
  const ultracodeMeta = await dispatch({ jsonrpc: '2.0', id: 20701, method: 'claude.getSessionMeta', params: { sessionId: 'state-1' } })
  assert.equal(ultracodeMeta.result.effort, 'ultracode')
  assert.equal(ultracodeMeta.result.ultracode, true)
  await dispatch({ jsonrpc: '2.0', id: 20702, method: 'claude.setEffort',
    params: { sessionId: 'state-1', effort: 'high' } })
  const sandboxSet = await dispatch({ jsonrpc: '2.0', id: 2071, method: 'claude.setCodexSandboxMode',
    params: { sessionId: 'state-1', mode: 'danger-full-access' } })
  assert.equal(sandboxSet.result, true)
  const approvalSet = await dispatch({ jsonrpc: '2.0', id: 2072, method: 'claude.setCodexApprovalPolicy',
    params: { sessionId: 'state-1', policy: 'never' } })
  assert.equal(approvalSet.result, true)
  const badSandboxSet = await dispatch({ jsonrpc: '2.0', id: 2073, method: 'claude.setCodexSandboxMode',
    params: { sessionId: 'state-1', mode: 'root' } })
  assert.equal(badSandboxSet.result, false)
  const missingSandboxSet = await dispatch({ jsonrpc: '2.0', id: 2074, method: 'claude.setCodexSandboxMode',
    params: { sessionId: 'missing-state', mode: 'workspace-write' } })
  assert.equal(missingSandboxSet.result, false)
  const meta2 = await dispatch({ jsonrpc: '2.0', id: 208, method: 'claude.getSessionMeta', params: { sessionId: 'state-1' } })
  assert.equal(meta2.result.model, 'claude-haiku-4-5-20251001')
  assert.equal(meta2.result.effort, 'high')
  assert.equal(meta2.result.autoCompactWindow, 100000)
  const state2 = await dispatch({ jsonrpc: '2.0', id: 2081, method: 'claude.getSessionState', params: { sessionId: 'state-1' } })
  assert.equal(state2.result.codexSandboxMode, 'danger-full-access')
  assert.equal(state2.result.codexApprovalPolicy, 'never')
  // The renderer's status line reads inputTokens/outputTokens/numTurns/
  // contextTokens/durationMs etc. with `.toLocaleString()` directly (no
  // optional chaining), so before-the-first-turn the meta must still
  // surface 0 defaults instead of undefined. Lock the full shape so a
  // missing field crashes this test before crashing ClaudeAgentPanel.
  for (const key of [
    'permissionMode', 'model', 'effort', 'autoCompactWindow',
    'sdkSessionId', 'cwd', 'totalCost',
    'inputTokens', 'outputTokens', 'durationMs', 'numTurns',
    'contextWindow', 'maxOutputTokens', 'contextTokens',
    'cacheReadTokens', 'cacheCreationTokens',
    'callCacheRead', 'callCacheWrite', 'lastQueryCalls',
  ]) {
    assert.ok(key in meta2.result, `getSessionMeta missing field: ${key}`)
  }
  // Numeric fields default to 0 (not undefined).
  for (const numKey of [
    'totalCost', 'inputTokens', 'outputTokens', 'durationMs', 'numTurns',
    'contextWindow', 'maxOutputTokens', 'contextTokens',
    'cacheReadTokens', 'cacheCreationTokens',
    'callCacheRead', 'callCacheWrite', 'lastQueryCalls',
  ]) {
    assert.equal(typeof meta2.result[numKey], 'number',
      `getSessionMeta.${numKey} must be a number`)
  }

  // A preset id alone re-derives the window (remote clients may omit the
  // number) — this is what keeps display == actual across clients.
  await dispatch({ jsonrpc: '2.0', id: 2082, method: 'claude.setModel',
    params: { sessionId: 'state-1', model: 'claude-haiku-4-5-20251001:auto-compact-300k' } })
  const metaDerived = await dispatch({ jsonrpc: '2.0', id: 2083, method: 'claude.getSessionMeta', params: { sessionId: 'state-1' } })
  assert.equal(metaDerived.result.autoCompactWindow, 300000,
    'setModel must derive the window from an auto-compact preset id')
  // Explicit null (context-only presets like `<base>:1m`) clears it — a
  // previously-set window must not keep compacting under the new selection.
  await dispatch({ jsonrpc: '2.0', id: 2084, method: 'claude.setModel',
    params: { sessionId: 'state-1', model: 'claude-haiku-4-5-20251001', autoCompactWindow: null } })
  const metaCleared = await dispatch({ jsonrpc: '2.0', id: 2085, method: 'claude.getSessionMeta', params: { sessionId: 'state-1' } })
  assert.equal(metaCleared.result.autoCompactWindow, null,
    'setModel with autoCompactWindow: null must clear the window')

  // resetSession drops the entry; subsequent getSessionState returns null.
  // Wrap with sendEvent override so we can assert the claude:session-reset
  // notification fires for an existing session but NOT for an unknown id —
  // renderer panels rely on this event to clear UI state.
  const resetCaptured = []
  const restoreResetSend = mod.__setSendEventForTests((name, payload) => resetCaptured.push({ name, payload }))
  const reset = await dispatch({ jsonrpc: '2.0', id: 209, method: 'claude.resetSession', params: { sessionId: 'state-1' } })
  assert.equal(reset.result, true)
  const after = await dispatch({ jsonrpc: '2.0', id: 210, method: 'claude.getSessionState', params: { sessionId: 'state-1' } })
  assert.equal(after.result, null)
  // Reset of unknown session id returns false (not an error).
  const reset2 = await dispatch({ jsonrpc: '2.0', id: 211, method: 'claude.resetSession', params: { sessionId: 'nope' } })
  assert.equal(reset2.result, false)
  restoreResetSend()
  const sessionResetEvents = resetCaptured.filter(e => e.name === 'claude:session-reset')
  assert.equal(sessionResetEvents.length, 1, 'exactly one claude:session-reset emit for the existing session')
  assert.equal(sessionResetEvents[0].payload.sessionId, 'state-1')
  // Unknown-session reset must NOT emit (panel for that id likely doesn't exist).
  const otherResets = resetCaptured.filter(e => e.name === 'claude:session-reset' && e.payload.sessionId === 'nope')
  assert.equal(otherResets.length, 0, 'unknown sessionId reset should not emit')

  // Setters with bad params return false rather than throwing.
  const bad1 = await dispatch({ jsonrpc: '2.0', id: 212, method: 'claude.setAutoContinue', params: { opts: {} } })
  assert.equal(bad1.result, false)
  const bad2 = await dispatch({ jsonrpc: '2.0', id: 213, method: 'claude.setPermissionMode', params: { sessionId: 's', mode: 42 } })
  assert.equal(bad2.result, false)

  // claude.sendMessage event mapping with a fake SDK. We can't observe
  // events emitted via process.stdout from in-process dispatch, so
  // intercept by overriding sendEvent. The fake SDK feeds the handler
  // a canonical sequence — system/init → assistant → result/success —
  // and we assert each maps to the expected renderer event with the
  // right payload key. Captures sdkSessionId for resume on next call.
  const captured = []
  const restoreSendEvent = mod.__setSendEventForTests((name, payload) => captured.push({ name, payload }))
  const fakeSdkForSend = {
    query({ prompt, options }) {
      captured.push({ name: '__queryArgs', payload: { prompt, resume: options?.resume ?? null, cwd: options?.cwd ?? null } })
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'sdk-sess-abc', cwd: '/x', model: 'claude-sonnet-4-6', permissionMode: 'default' },
        { type: 'assistant', session_id: 'sdk-sess-abc', message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] } },
        { type: 'result', subtype: 'success', session_id: 'sdk-sess-abc', result: 'hello back', stop_reason: 'end_turn', total_cost_usd: 0.001, num_turns: 1 },
      ]
      return (async function*() {
        for (const m of messages) yield m
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkForSend)
  try {
    // Fresh session so we don't reuse state-1's mutated map.
    await dispatch({ jsonrpc: '2.0', id: 220, method: 'claude.startSession',
      params: { sessionId: 'send-1', options: { cwd: '/x' } } })
    const sendReply = await dispatch({ jsonrpc: '2.0', id: 221, method: 'claude.sendMessage',
      params: { sessionId: 'send-1', prompt: 'hi' } })
    assert.equal(sendReply.result.ok, true)
    // Event sequence: local/remote user echo, request progress statuses,
    // SDK init status, the responded-clear status (runtimeStatus cleared the
    // moment the first assistant frame arrives), assistant message, result,
    // turn-end (in order).
    const events = captured.filter(c => c.name && c.name.startsWith('claude:'))
    const seq = events.map(e => e.name)
    assert.deepEqual(seq, ['claude:message', 'claude:status', 'claude:status', 'claude:status', 'claude:status', 'claude:message', 'claude:result', 'claude:turn-end'])
    assert.equal(events[0].payload.message.role, 'user')
    assert.equal(events[0].payload.message.content, 'hi')
    assert.equal(events[1].payload.meta.runtimeStatus, 'starting')
    assert.equal(events[2].payload.meta.runtimeStatus, 'waiting_for_api')
    // First assistant frame clears the runtime status so the renderer's
    // "waiting/compacting (Ns)" banner and its elapsed counter stop.
    assert.equal(events[4].payload.meta.runtimeStatus, null)
    // status payload.meta.sdkSessionId
    const sdkStatus = events.find(e => e.name === 'claude:status' && e.payload?.meta?.sdkSessionId === 'sdk-sess-abc')
    assert.ok(sdkStatus, 'expected sdk init claude:status with sdkSessionId')
    // status meta must carry the full SessionMetadata shape, not a
    // sparse subset — the renderer's ClaudeAgentPanel reads
    // `inputTokens.toLocaleString()` etc. without optional chaining.
    // Lock the same 19 keys + 13 numeric typeof asserted on the
    // getSessionMeta RPC reply, so any sparse status emit fails here
    // rather than crashing the panel.
    for (const key of [
      'permissionMode', 'model', 'effort', 'autoCompactWindow',
      'sdkSessionId', 'cwd', 'totalCost',
      'inputTokens', 'outputTokens', 'durationMs', 'numTurns',
      'contextWindow', 'maxOutputTokens', 'contextTokens',
      'cacheReadTokens', 'cacheCreationTokens',
      'callCacheRead', 'callCacheWrite', 'lastQueryCalls',
      'isStreaming',
      'runtimeStatus', 'runtimeMessage', 'runtimeStatusStartedAt',
    ]) {
      assert.ok(key in sdkStatus.payload.meta,
        `claude:status meta missing field: ${key}`)
    }
    for (const numKey of [
      'totalCost', 'inputTokens', 'outputTokens', 'durationMs', 'numTurns',
      'contextWindow', 'maxOutputTokens', 'contextTokens',
      'cacheReadTokens', 'cacheCreationTokens',
      'callCacheRead', 'callCacheWrite', 'lastQueryCalls',
    ]) {
      assert.equal(typeof sdkStatus.payload.meta[numKey], 'number',
        `claude:status meta.${numKey} must be a number`)
    }
    assert.equal(events[1].payload.meta.isStreaming, true,
      'starting status should keep the renderer in its live Thinking state')
    // Renderer-facing assistant messages are normalized to the same
    // ClaudeMessage shape used in session state.
    assert.equal(events[5].payload.message.role, 'assistant')
    assert.equal(events[5].payload.message.content, 'hello back')
    assert.ok(events[5].payload.message.id.startsWith('assistant-'))
    await settleTurn(mod.sessions.get('send-1'))
    const sendState = await dispatch({ jsonrpc: '2.0', id: 2211, method: 'claude.getSessionState', params: { sessionId: 'send-1' } })
    assert.equal(sendState.result.messages[0].role, 'user')
    assert.equal(sendState.result.messages[0].content, 'hi')
    assert.equal(sendState.result.messages.some(m => m.role === 'assistant' && m.content === 'hello back'), true)
    assert.equal(sendState.result.isStreaming, false)
    // turn-end carries reason + sdkSessionId
    assert.equal(events[7].payload.payload.reason, 'completed')
    assert.equal(events[7].payload.payload.sdkSessionId, 'sdk-sess-abc')

    // Second sendMessage must pass `resume: 'sdk-sess-abc'` to the SDK
    // (proving multi-turn context preservation).
    const queryCallsBefore = captured.filter(c => c.name === '__queryArgs').length
    await dispatch({ jsonrpc: '2.0', id: 222, method: 'claude.sendMessage',
      params: { sessionId: 'send-1', prompt: 'follow up' } })
    const queryArgsRound2 = captured.filter(c => c.name === '__queryArgs')
    assert.equal(queryArgsRound2.length, queryCallsBefore + 1)
    assert.equal(queryArgsRound2[queryArgsRound2.length - 1].payload.resume, 'sdk-sess-abc')

    // A stale streaming flag must not reject a later prompt. The
    // sidecar's per-session sendQueue serializes real overlapping sends.
    const s = mod.sessions.get('send-1')
    s.streaming = true
    const staleFlagSend = await dispatch({ jsonrpc: '2.0', id: 223, method: 'claude.sendMessage',
      params: { sessionId: 'send-1', prompt: 'parallel' } })
    assert.equal(staleFlagSend.result.ok, true)
    await settleTurn(s)
    assert.equal(s.streaming, false)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreSendEvent()
  }

  // Status correctness across a MULTI-FRAME turn. As new responses keep
  // streaming in, the runtime status must be written correctly: it is set to
  // 'waiting_for_api' on push, CLEARED the moment the first response frame
  // arrives, re-set to 'compacting' if the SDK compacts mid-turn, then
  // CLEARED again on the next frame. Crucially markRuntimeResponded must be
  // idempotent — extra frames after a clear must NOT re-broadcast claude:status
  // (no per-frame churn). Feed: init → 2 deltas → status/compacting →
  // compact_boundary → 1 delta → assistant → result.
  const multiCaptured = []
  const restoreMultiSend = mod.__setSendEventForTests((name, payload) => multiCaptured.push({ name, payload }))
  const fakeSdkMultiFrame = {
    query() {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'sdk-multi', cwd: '/x', model: 'claude-sonnet-4-6', permissionMode: 'default' },
        { type: 'stream_event', session_id: 'sdk-multi', event: { type: 'content_block_delta', delta: { text: 'one ' } } },
        { type: 'stream_event', session_id: 'sdk-multi', event: { type: 'content_block_delta', delta: { text: 'two ' } } },
        { type: 'system', subtype: 'status', session_id: 'sdk-multi', status: 'compacting' },
        { type: 'system', subtype: 'compact_boundary', session_id: 'sdk-multi', compact_metadata: { trigger: 'auto', pre_tokens: 1000, post_tokens: 200, duration_ms: 1234 } },
        { type: 'stream_event', session_id: 'sdk-multi', event: { type: 'content_block_delta', delta: { text: 'three' } } },
        { type: 'assistant', session_id: 'sdk-multi', message: { role: 'assistant', content: [{ type: 'text', text: 'one two three' }] } },
        { type: 'result', subtype: 'success', session_id: 'sdk-multi', result: 'one two three', stop_reason: 'end_turn' },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkMultiFrame)
  try {
    await dispatch({ jsonrpc: '2.0', id: 2240, method: 'claude.startSession',
      params: { sessionId: 'send-multi', options: { cwd: '/x' } } })
    const multiReply = await dispatch({ jsonrpc: '2.0', id: 2241, method: 'claude.sendMessage',
      params: { sessionId: 'send-multi', prompt: 'hi' } })
    assert.equal(multiReply.result.ok, true)
    await settleTurn(mod.sessions.get('send-multi'))
    const statusRuntime = multiCaptured
      .filter(c => c.name === 'claude:status' && c.payload?.sessionId === 'send-multi')
      .map(e => e.payload.meta.runtimeStatus)
    // starting → waiting_for_api → (init keeps waiting_for_api) → cleared on the
    // first stream frame → compacting → cleared again on the next stream frame.
    // Exactly 6: the 2nd delta and the assistant frame must NOT emit a status.
    assert.deepEqual(statusRuntime,
      ['starting', 'waiting_for_api', 'waiting_for_api', null, 'compacting', null],
      `unexpected runtimeStatus sequence: ${JSON.stringify(statusRuntime)}`)
    // Each text delta produced exactly one claude:stream; status frames did not.
    const streamCount = multiCaptured.filter(c => c.name === 'claude:stream' && c.payload?.sessionId === 'send-multi').length
    assert.equal(streamCount, 3, `expected 3 claude:stream, got ${streamCount}`)
    // Turn ends cleanly; session no longer streaming.
    const multiState = await dispatch({ jsonrpc: '2.0', id: 2242, method: 'claude.getSessionState', params: { sessionId: 'send-multi' } })
    assert.equal(multiState.result.isStreaming, false)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreMultiSend()
  }

  // Non-success SDK results should surface the useful nested error text,
  // not only "query error" / subtype noise.
  const errorCaptured = []
  const restoreErrorSend = mod.__setSendEventForTests((name, payload) => errorCaptured.push({ name, payload }))
  const fakeSdkForResultError = {
    query() {
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-missing-history', cwd: '/x' }
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'sdk-missing-history',
          errors: [{ message: 'No conversation found with session ID: sdk-missing-history' }],
          stop_reason: 'error',
          total_cost_usd: 0,
          num_turns: 1,
        }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkForResultError)
  try {
    await dispatch({ jsonrpc: '2.0', id: 2231, method: 'claude.startSession',
      params: { sessionId: 'send-error-1', options: { cwd: '/x' } } })
    const sendReply = await dispatch({ jsonrpc: '2.0', id: 2232, method: 'claude.sendMessage',
      params: { sessionId: 'send-error-1', prompt: 'hi' } })
    // The reply is the receipt, so a turn that fails *after* the prompt was
    // taken cannot report through it. claude:error is what the renderer listens
    // on, and it has to carry the same useful text the reply used to.
    assert.equal(sendReply.result.ok, true)
    await settleTurn(mod.sessions.get('send-error-1'))
    const errorEvent = errorCaptured.find(e => e.name === 'claude:error')
    assert.ok(errorEvent, 'non-success result must emit claude:error')
    assert.match(errorEvent.payload.error, /No conversation found/)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreErrorSend()
  }

  // The CLI can reject a session's persisted effort level for the account's
  // plan (e.g. "max" needs API billing on some Claude.ai subscriptions).
  // sendMessage must downgrade the session instead of repeating the same
  // failure forever, and tell the caller which level it fell back to.
  const effortCaptured = []
  const restoreEffortSend = mod.__setSendEventForTests((name, payload) => effortCaptured.push({ name, payload }))
  const fakeSdkEffortRejected = {
    query() {
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-effort-1', cwd: '/x' }
        throw new Error(
          'Claude Code process exited with code 1\n' +
          'Error: Effort level "max" is not available for Claude.ai subscribers. ' +
          'Please use "low", "medium", or "high".',
        )
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkEffortRejected)
  try {
    await dispatch({ jsonrpc: '2.0', id: 2250, method: 'claude.startSession',
      params: { sessionId: 'send-effort-1', options: { cwd: '/x' } } })
    await dispatch({ jsonrpc: '2.0', id: 2251, method: 'claude.setEffort',
      params: { sessionId: 'send-effort-1', effort: 'max' } })
    const effortReply = await dispatch({ jsonrpc: '2.0', id: 2252, method: 'claude.sendMessage',
      params: { sessionId: 'send-effort-1', prompt: 'hi' } })
    assert.equal(effortReply.result.ok, true, 'the prompt was taken before the SDK rejected the effort level')
    await settleTurn(mod.sessions.get('send-effort-1'))
    // Which level it fell back to is guidance the user needs to see, so it has
    // to reach them on claude:error now that the reply is only a receipt.
    const effortError = effortCaptured.find(e => e.name === 'claude:error')
    assert.ok(effortError, 'a rejected effort level must emit claude:error')
    assert.match(effortError.payload.error, /switched to "high"/)
    const effortState = await dispatch({ jsonrpc: '2.0', id: 2253, method: 'claude.getSessionState',
      params: { sessionId: 'send-effort-1' } })
    assert.equal(effortState.result.effort, 'high', 'session must downgrade off the rejected level')
    const statusEvent = effortCaptured.find(e => e.name === 'claude:status' && e.payload?.meta?.effort === 'high')
    assert.ok(statusEvent, 'downgrade must emit claude:status with the new effort so clients resync')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreEffortSend()
  }

  // Consecutive sends reuse the same LiveQuery when the SDK keeps the
  // streaming-input generator alive.
  const persistentCaptured = []
  const restorePersistentSend = mod.__setSendEventForTests((name, payload) => persistentCaptured.push({ name, payload }))
  const fakeSdkStreaming = {
    queryCalls: 0,
    query({ prompt, options }) {
      this.queryCalls++
      const userIter = prompt[Symbol.asyncIterator]()
      persistentCaptured.push({ name: '__queryArgs', payload: { resume: options?.resume ?? null } })
      let turn = 0
      return (async function*() {
        while (true) {
          const next = await userIter.next()
          if (next.done) return
          turn++
          yield { type: 'system', subtype: 'init', session_id: 'sdk-stream-1', cwd: '/s' }
          yield { type: 'assistant', session_id: 'sdk-stream-1',
            message: { role: 'assistant', content: [{ type: 'text', text: `reply-${turn}` }] } }
          yield { type: 'result', subtype: 'success', session_id: 'sdk-stream-1',
            result: `reply-${turn}`, stop_reason: 'end_turn',
            total_cost_usd: 0.001, num_turns: turn }
        }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkStreaming)
  try {
    await dispatch({ jsonrpc: '2.0', id: 224, method: 'claude.startSession',
      params: { sessionId: 'stream-1', options: { cwd: '/s' } } })
    // Two consecutive sends — the second must rebuild with resume.
    const r1 = await dispatch({ jsonrpc: '2.0', id: 225, method: 'claude.sendMessage',
      params: { sessionId: 'stream-1', prompt: 'first' } })
    assert.equal(r1.result.ok, true)
    const r2 = await dispatch({ jsonrpc: '2.0', id: 226, method: 'claude.sendMessage',
      params: { sessionId: 'stream-1', prompt: 'second' } })
    assert.equal(r2.result.ok, true)
    await settleTurn(mod.sessions.get('stream-1'))
    assert.equal(fakeSdkStreaming.queryCalls, 1, 'second turn should reuse the live sdk.query')
    const queryArgs = persistentCaptured.filter(c => c.name === '__queryArgs')
    assert.equal(queryArgs[0].payload.resume, null)
    // Both turns still produced result events.
    const results = persistentCaptured.filter(c => c.name === 'claude:result')
    assert.equal(results.length, 2, 'expected 2 result events across rebuilt queries')
    assert.equal(results[0].payload.result.result, 'reply-1')
    assert.equal(results[1].payload.result.result, 'reply-2')
    // Completed turns do not keep a live query. The last currentQuery is
    // retained for SDK metadata reads, matching Electron's queryInstance.
    const ss = mod.sessions.get('stream-1')
    assert.ok(ss.liveQuery)
    assert.ok(ss.currentQuery)
  } finally {
    __setSdkOverrideForTests(undefined)
    restorePersistentSend()
    // Ensure no liveQuery leaks across tests.
    mod.sessions.get('stream-1')?.liveQuery?.close()
  }

  // Overlapping sends on the same session must serialize rather than
  // returning `{ok:false, error:"session already streaming"}`. This
  // mirrors Electron's "accept while busy" contract and protects the UI
  // from showing a user bubble whose prompt was dropped by the sidecar.
  const queuedCaptured = []
  const queuedEvents = []
  const restoreQueuedSend = mod.__setSendEventForTests((name, payload) => queuedEvents.push({ name, payload }))
  let releaseFirstResult
  let firstTurnStartedResolve
  const firstTurnStarted = new Promise(resolve => { firstTurnStartedResolve = resolve })
  const fakeSdkQueued = {
    queryCalls: 0,
    query({ prompt }) {
      this.queryCalls++
      const userIter = prompt[Symbol.asyncIterator]()
      return (async function*() {
        let turn = 0
        while (true) {
          const next = await userIter.next()
          if (next.done) return
          turn++
          queuedCaptured.push(next.value?.message?.content)
          yield { type: 'system', subtype: 'init', session_id: 'sdk-queued-1', cwd: '/q' }
          yield { type: 'assistant', session_id: 'sdk-queued-1',
            message: { role: 'assistant', content: [{ type: 'text', text: `queued-reply-${turn}` }] } }
          if (turn === 1) {
            firstTurnStartedResolve()
            await new Promise(resolve => { releaseFirstResult = resolve })
          }
          yield { type: 'result', subtype: 'success', session_id: 'sdk-queued-1',
            result: `queued-reply-${turn}`, stop_reason: 'end_turn',
            total_cost_usd: 0.001, num_turns: turn }
        }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkQueued)
  try {
    await dispatch({ jsonrpc: '2.0', id: 227, method: 'claude.startSession',
      params: { sessionId: 'queued-1', options: { cwd: '/q' } } })
    const p1 = dispatch({ jsonrpc: '2.0', id: 228, method: 'claude.sendMessage',
      params: { sessionId: 'queued-1', prompt: 'first' } })
    await firstTurnStarted
    const p2 = dispatch({ jsonrpc: '2.0', id: 229, method: 'claude.sendMessage',
      params: { sessionId: 'queued-1', prompt: 'second' } })
    const userEchoesBeforeFirstCompletes = queuedEvents
      .filter(e => e.name === 'claude:message' && e.payload?.message?.role === 'user')
      .map(e => e.payload.message.content)
    assert.deepEqual(
      userEchoesBeforeFirstCompletes,
      ['first', 'second'],
      'queued user prompts should be echoed before the previous turn finishes',
    )
    releaseFirstResult()
    const [q1, q2] = await Promise.all([p1, p2])
    assert.equal(q1.result.ok, true)
    assert.equal(q2.result.ok, true)
    assert.equal(fakeSdkQueued.queryCalls, 1, 'queued sends should reuse the live query when it stays open')
    assert.deepEqual(queuedCaptured, ['first', 'second'])
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreQueuedSend()
    mod.sessions.get('queued-1')?.liveQuery?.close()
  }

  // A host RPC timeout does not cancel the SDK turn. If the renderer/client
  // retries with the same clientMessageId, the sidecar must acknowledge the
  // already accepted request without echoing or pushing the prompt twice.
  const idempotentPrompts = []
  const idempotentEvents = []
  const restoreIdempotentSend = mod.__setSendEventForTests((name, payload) => idempotentEvents.push({ name, payload }))
  let releaseIdempotentResult
  let idempotentTurnStartedResolve
  const idempotentTurnStarted = new Promise(resolve => { idempotentTurnStartedResolve = resolve })
  const fakeSdkIdempotent = {
    query({ prompt }) {
      const userIter = prompt[Symbol.asyncIterator]()
      return (async function*() {
        const next = await userIter.next()
        if (next.done) return
        idempotentPrompts.push(next.value?.message?.content)
        yield { type: 'system', subtype: 'init', session_id: 'sdk-idempotent-1', cwd: '/i' }
        idempotentTurnStartedResolve()
        await new Promise(resolve => { releaseIdempotentResult = resolve })
        yield { type: 'result', subtype: 'success', session_id: 'sdk-idempotent-1',
          result: 'once', stop_reason: 'end_turn', total_cost_usd: 0.001, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkIdempotent)
  try {
    await dispatch({ jsonrpc: '2.0', id: 2291, method: 'claude.startSession',
      params: { sessionId: 'idempotent-1', options: { cwd: '/i' } } })
    const first = dispatch({ jsonrpc: '2.0', id: 2292, method: 'claude.sendMessage',
      params: { sessionId: 'idempotent-1', prompt: 'only once', clientMessageId: 'user-fixed-1' } })
    await idempotentTurnStarted
    const duplicatePending = await dispatch({ jsonrpc: '2.0', id: 2293, method: 'claude.sendMessage',
      params: { sessionId: 'idempotent-1', prompt: 'only once', clientMessageId: 'user-fixed-1' } })
    assert.deepEqual(duplicatePending.result, { ok: true, duplicate: true, pending: true })
    assert.deepEqual(idempotentPrompts, ['only once'])
    assert.equal(
      idempotentEvents.filter(e => e.name === 'claude:message' && e.payload?.message?.role === 'user').length,
      1,
      'a duplicate in-flight RPC must not emit a second user echo',
    )

    releaseIdempotentResult()
    const firstReply = await first
    assert.equal(firstReply.result.ok, true)
    const duplicateCompleted = await dispatch({ jsonrpc: '2.0', id: 2294, method: 'claude.sendMessage',
      params: { sessionId: 'idempotent-1', prompt: 'only once', clientMessageId: 'user-fixed-1' } })
    assert.equal(duplicateCompleted.result.ok, true)
    assert.equal(duplicateCompleted.result.duplicate, true)
    assert.deepEqual(idempotentPrompts, ['only once'])
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreIdempotentSend()
    mod.sessions.get('idempotent-1')?.liveQuery?.close()
  }

  // claude.stopTask: forwards task_id to the active query's stopTask
  // control method. Errors gracefully when no query is active.
  const stopCaptured = []
  let releaseStopResult
  let stopTurnStartedResolve
  const stopTurnStarted = new Promise(resolve => { stopTurnStartedResolve = resolve })
  const restoreStopSend = mod.__setSendEventForTests(() => {})
  const fakeSdkStop = {
    query({ prompt }) {
      const userIter = prompt[Symbol.asyncIterator]()
      const gen = (async function*() {
        const first = await userIter.next()
        if (first.done) return
        yield { type: 'system', subtype: 'init', session_id: 'sdk-stop' }
        // Tracked task bound to a tool_use id, for the stopTask id mapping.
        yield { type: 'system', subtype: 'task_started', task_id: 'task-real', tool_use_id: 'toolu-real', description: 'bound task', session_id: 'sdk-stop' }
        stopTurnStartedResolve()
        await new Promise(resolve => { releaseStopResult = resolve })
        yield { type: 'result', subtype: 'success', session_id: 'sdk-stop', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
      gen.stopTask = async (taskId) => { stopCaptured.push(taskId) }
      gen.close = () => { /* ends the iterator */ }
      return gen
    },
  }
  __setSdkOverrideForTests(fakeSdkStop)
  try {
    // Without a live query, stopTask reports failure rather than throwing.
    await dispatch({ jsonrpc: '2.0', id: 227, method: 'claude.startSession',
      params: { sessionId: 'stop-1', options: { cwd: '/s' } } })
    const earlyStop = await dispatch({ jsonrpc: '2.0', id: 228, method: 'claude.stopTask',
      params: { sessionId: 'stop-1', taskId: 'task-x' } })
    assert.equal(earlyStop.result.ok, false)
    assert.match(earlyStop.result.error, /no active query/)

    // While the session is running a message, stopTask routes through the
    // generator's control method.
    const stopSend = dispatch({ jsonrpc: '2.0', id: 229, method: 'claude.sendMessage',
      params: { sessionId: 'stop-1', prompt: 'hello' } })
    await stopTurnStarted
    const stopReply = await dispatch({ jsonrpc: '2.0', id: 230, method: 'claude.stopTask',
      params: { sessionId: 'stop-1', taskId: 'task-A' } })
    assert.equal(stopReply.result.ok, true)
    assert.deepEqual(stopCaptured, ['task-A'])

    // toolUseId fallback (renderer's older API).
    const stopReply2 = await dispatch({ jsonrpc: '2.0', id: 231, method: 'claude.stopTask',
      params: { sessionId: 'stop-1', toolUseId: 'tool-Z' } })
    assert.equal(stopReply2.result.ok, true)
    assert.deepEqual(stopCaptured, ['task-A', 'tool-Z'])

    // A tool_use id bound to a tracked task maps to its real task_id (the
    // SDK's stopTask only understands task ids).
    const stopReply3 = await dispatch({ jsonrpc: '2.0', id: 234, method: 'claude.stopTask',
      params: { sessionId: 'stop-1', taskId: 'toolu-real' } })
    assert.equal(stopReply3.result.ok, true)
    assert.deepEqual(stopCaptured, ['task-A', 'tool-Z', 'task-real'])
    releaseStopResult()
    await stopSend

    // Missing args reject.
    const noSid = await dispatch({ jsonrpc: '2.0', id: 232, method: 'claude.stopTask',
      params: { taskId: 'x' } })
    assert.match(noSid.error?.message || '', /missing sessionId/)
    const noTask = await dispatch({ jsonrpc: '2.0', id: 233, method: 'claude.stopTask',
      params: { sessionId: 'stop-1' } })
    assert.match(noTask.error?.message || '', /missing taskId/)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreStopSend()
    mod.sessions.get('stop-1')?.liveQuery?.close()
  }

  // claude.interruptTurn: soft interrupt. Forwards to the generator's
  // turn-only interrupt() and emits a 'interrupted' turn-end WITHOUT closing
  // the subprocess, so background workflows survive. Also exercises the
  // task_started -> claude:task surfacing.
  const interruptCalls = { interrupt: 0, close: 0 }
  let releaseInterruptResult
  let interruptTurnStartedResolve
  const interruptTurnStarted = new Promise(resolve => { interruptTurnStartedResolve = resolve })
  const interruptEvents = []
  const restoreInterruptSend = mod.__setSendEventForTests((name, payload) => {
    interruptEvents.push({ name, payload })
  })
  const fakeSdkInterrupt = {
    query({ prompt }) {
      const userIter = prompt[Symbol.asyncIterator]()
      const gen = (async function*() {
        // Streaming-input generator: stays alive across turns, awaiting the
        // next pushed message. A turn-only interrupt must NOT end it.
        while (true) {
          const next = await userIter.next()
          if (next.done) return
          yield { type: 'system', subtype: 'init', session_id: 'sdk-int' }
          yield { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu-spec', task_type: 'local_workflow', workflow_name: 'spec', description: 'run spec', session_id: 'sdk-int' }
          // A plain shell tool: the SDK reports these as tasks too, flagged
          // skip_transcript, and only ever on task_started.
          yield { type: 'system', subtype: 'task_started', task_id: 't-sh', tool_use_id: 'toolu-bash', description: 'git diff --name-only', skip_transcript: true, session_id: 'sdk-int' }
          yield { type: 'system', subtype: 'task_updated', task_id: 't-sh', patch: { description: 'git diff --name-only (running)' }, session_id: 'sdk-int' }
          interruptTurnStartedResolve()
          await new Promise(resolve => { releaseInterruptResult = resolve })
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'sdk-int', stop_reason: 'interrupted' }
        }
      })()
      gen.interrupt = async () => { interruptCalls.interrupt++; releaseInterruptResult?.() }
      gen.close = () => { interruptCalls.close++; releaseInterruptResult?.() }
      return gen
    },
  }
  __setSdkOverrideForTests(fakeSdkInterrupt)
  try {
    await dispatch({ jsonrpc: '2.0', id: 271, method: 'claude.startSession',
      params: { sessionId: 'int-1', options: { cwd: '/i' } } })
    // No active turn → reports failure rather than throwing.
    const earlyInt = await dispatch({ jsonrpc: '2.0', id: 272, method: 'claude.interruptTurn',
      params: { sessionId: 'int-1' } })
    assert.equal(earlyInt.result.ok, false)
    assert.match(earlyInt.result.error, /no active turn/)

    const intSend = dispatch({ jsonrpc: '2.0', id: 273, method: 'claude.sendMessage',
      params: { sessionId: 'int-1', prompt: 'hello' } })
    await interruptTurnStarted

    // task_started must surface as claude:task with workflow metadata.
    const taskEvent = interruptEvents.find(e => e.name === 'claude:task')
    assert.ok(taskEvent, 'task_started must emit claude:task')
    assert.equal(taskEvent.payload.task.isWorkflow, true)
    assert.equal(taskEvent.payload.task.workflowName, 'spec')
    assert.equal(taskEvent.payload.task.status, 'running')
    assert.equal(taskEvent.payload.task.toolUseId, 'toolu-spec', 'tool_use_id must be forwarded for renderer binding')

    // skip_transcript arrives only on task_started, so the task_updated merge
    // has to carry it forward — otherwise the renderer stops recognising a
    // shell task as a shell task after its first update (GH #127).
    const shellTaskEvents = interruptEvents.filter(e => e.name === 'claude:task' && e.payload.task.id === 't-sh')
    assert.equal(shellTaskEvents.length, 2, 'shell task_started + task_updated must both surface')
    assert.equal(shellTaskEvents[0].payload.task.skipTranscript, true, 'task_started must forward skip_transcript')
    assert.equal(shellTaskEvents[1].payload.task.skipTranscript, true, 'task_updated must carry skip_transcript forward')

    const intReply = await dispatch({ jsonrpc: '2.0', id: 274, method: 'claude.interruptTurn',
      params: { sessionId: 'int-1' } })
    assert.equal(intReply.result.ok, true)
    assert.equal(interruptCalls.interrupt, 1, 'interruptTurn must call generator.interrupt()')
    await intSend

    // Turn-only interrupt: 'interrupted' turn-end, no claude:error, subprocess intact.
    const turnEnd = interruptEvents.filter(e => e.name === 'claude:turn-end').pop()
    assert.equal(turnEnd.payload.payload.reason, 'interrupted')
    assert.ok(!interruptEvents.some(e => e.name === 'claude:error'),
      'a turn-only interrupt must not emit claude:error')
    assert.equal(interruptCalls.close, 0, 'interrupt must not close the subprocess')
    assert.ok(mod.sessions.get('int-1').liveQuery, 'liveQuery survives a turn-only interrupt')

    // Missing sessionId rejects.
    const noSid = await dispatch({ jsonrpc: '2.0', id: 275, method: 'claude.interruptTurn',
      params: {} })
    assert.match(noSid.error?.message || '', /missing sessionId/)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreInterruptSend()
    mod.sessions.get('int-1')?.liveQuery?.close()
  }

  // setPermissionMode + setModel forward to the active query's control
  // methods when one is open. autoCompactWindow closes the current query
  // because it is applied through queryOptions.env on the next turn.
  const ctrlCalls = { permissionMode: [], model: [], close: 0 }
  let releaseCtrlResult
  let ctrlTurnStartedResolve
  const ctrlTurnStarted = new Promise(resolve => { ctrlTurnStartedResolve = resolve })
  const restoreCtrlSend = mod.__setSendEventForTests(() => {})
  const fakeSdkCtrl = {
    query({ prompt }) {
      const userIter = prompt[Symbol.asyncIterator]()
      const gen = (async function*() {
        const first = await userIter.next()
        if (first.done) return
        yield { type: 'system', subtype: 'init', session_id: 'sdk-ctrl' }
        ctrlTurnStartedResolve()
        await new Promise(resolve => { releaseCtrlResult = resolve })
        yield { type: 'result', subtype: 'success', session_id: 'sdk-ctrl', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
      gen.setPermissionMode = async (m) => { ctrlCalls.permissionMode.push(m) }
      gen.setModel = async (m) => { ctrlCalls.model.push(m) }
      gen.close = () => { ctrlCalls.close++; releaseCtrlResult?.() }
      return gen
    },
  }
  __setSdkOverrideForTests(fakeSdkCtrl)
  try {
    await dispatch({ jsonrpc: '2.0', id: 234, method: 'claude.startSession',
      params: { sessionId: 'ctrl-1', options: { cwd: '/c' } } })
    const ctrlSend = dispatch({ jsonrpc: '2.0', id: 235, method: 'claude.sendMessage',
      params: { sessionId: 'ctrl-1', prompt: 'hi' } })
    await ctrlTurnStarted
    // Mode change must hit the control method.
    await dispatch({ jsonrpc: '2.0', id: 236, method: 'claude.setPermissionMode',
      params: { sessionId: 'ctrl-1', mode: 'plan' } })
    assert.deepEqual(ctrlCalls.permissionMode, ['plan'])
    // bypassPlan maps to 'plan' (sidecar-only mode the SDK doesn't know).
    await dispatch({ jsonrpc: '2.0', id: 237, method: 'claude.setPermissionMode',
      params: { sessionId: 'ctrl-1', mode: 'bypassPlan' } })
    assert.deepEqual(ctrlCalls.permissionMode, ['plan', 'plan'])
    // Model change forwards too, carrying the `[1m]` that keeps a mid-session
    // switch on the same window a fresh session would have got.
    await dispatch({ jsonrpc: '2.0', id: 238, method: 'claude.setModel',
      params: { sessionId: 'ctrl-1', model: 'claude-opus-4-7' } })
    assert.deepEqual(ctrlCalls.model, ['claude-opus-4-7[1m]'])
    // autoCompactWindow change closes the current query (env var requires rebuild).
    await dispatch({ jsonrpc: '2.0', id: 239, method: 'claude.setModel',
      params: { sessionId: 'ctrl-1', autoCompactWindow: 200000 } })
    assert.equal(mod.sessions.get('ctrl-1').currentQuery, null,
      'autoCompactWindow change must close currentQuery so next send rebuilds with env')
    await ctrlSend
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreCtrlSend()
  }

  // closeLiveQuery cleanup: abortSession / stopSession / restSession /
  // resetSession / resumeSession all close any open currentQuery so the
  // SDK CLI subprocess doesn't outlive its session record. Verifies
  // each handler tears down the query reference.
  const lcCalls = { close: 0 }
  const restoreLcSend = mod.__setSendEventForTests(() => {})
  const lcProjectsDir = mkdtempSync(join(tmpdir(), 'sidecar-lifecycle-history-'))
  mod.__setProjectsDirOverrideForTests(lcProjectsDir)
  function makeSdkLifecycle() {
    return {
      query({ prompt }) {
        const userIter = prompt[Symbol.asyncIterator]()
        const gen = (async function*() {
          const first = await userIter.next()
          if (first.done) return
          yield { type: 'system', subtype: 'init', session_id: 'sdk-lc' }
          yield { type: 'result', subtype: 'success', session_id: 'sdk-lc', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
          while (true) { const n = await userIter.next(); if (n.done) return }
        })()
        gen.close = () => { lcCalls.close++ }
        return gen
      },
    }
  }
  __setSdkOverrideForTests(makeSdkLifecycle())
  try {
    // abortSession closes currentQuery.
    await dispatch({ jsonrpc: '2.0', id: 240, method: 'claude.startSession', params: { sessionId: 'lc-abort', options: { cwd: '/lc' } } })
    await dispatch({ jsonrpc: '2.0', id: 241, method: 'claude.sendMessage', params: { sessionId: 'lc-abort', prompt: 'hi' } })
    assert.ok(mod.sessions.get('lc-abort').currentQuery, 'currentQuery built by sendMessage')
    const closeBeforeAbort = lcCalls.close
    await dispatch({ jsonrpc: '2.0', id: 242, method: 'claude.abortSession', params: { sessionId: 'lc-abort' } })
    assert.equal(mod.sessions.get('lc-abort').currentQuery, null, 'abortSession must null currentQuery')
    assert.ok(lcCalls.close > closeBeforeAbort, 'abortSession must call generator.close()')

    // stopSession closes currentQuery + deletes session.
    await dispatch({ jsonrpc: '2.0', id: 243, method: 'claude.startSession', params: { sessionId: 'lc-stop', options: { cwd: '/lc' } } })
    await dispatch({ jsonrpc: '2.0', id: 244, method: 'claude.sendMessage', params: { sessionId: 'lc-stop', prompt: 'hi' } })
    const stopCloseBefore = lcCalls.close
    await dispatch({ jsonrpc: '2.0', id: 245, method: 'claude.stopSession', params: { sessionId: 'lc-stop' } })
    assert.equal(mod.sessions.get('lc-stop'), undefined, 'stopSession deletes session record')
    assert.ok(lcCalls.close > stopCloseBefore, 'stopSession must close currentQuery')

    // resetSession closes currentQuery + deletes session.
    await dispatch({ jsonrpc: '2.0', id: 246, method: 'claude.startSession', params: { sessionId: 'lc-reset', options: { cwd: '/lc' } } })
    await dispatch({ jsonrpc: '2.0', id: 247, method: 'claude.sendMessage', params: { sessionId: 'lc-reset', prompt: 'hi' } })
    const resetCloseBefore = lcCalls.close
    await dispatch({ jsonrpc: '2.0', id: 248, method: 'claude.resetSession', params: { sessionId: 'lc-reset' } })
    assert.equal(mod.sessions.get('lc-reset'), undefined, 'resetSession deletes session record')
    assert.ok(lcCalls.close > resetCloseBefore, 'resetSession must close currentQuery')

    // resumeSession closes existing currentQuery before swapping the record.
    await dispatch({ jsonrpc: '2.0', id: 249, method: 'claude.startSession', params: { sessionId: 'lc-resume', options: { cwd: '/lc' } } })
    await dispatch({ jsonrpc: '2.0', id: 250, method: 'claude.sendMessage', params: { sessionId: 'lc-resume', prompt: 'hi' } })
    const resumeCloseBefore = lcCalls.close
    writeClaudeHistory(lcProjectsDir, '/lc', 'sdk-lc-resumed')
    await dispatch({ jsonrpc: '2.0', id: 251, method: 'claude.resumeSession',
      params: { sessionId: 'lc-resume', sdkSessionId: 'sdk-lc-resumed', options: { cwd: '/lc' } } })
    assert.ok(lcCalls.close > resumeCloseBefore, 'resumeSession must close prior currentQuery')
    // New record has no currentQuery yet — first sendMessage rebuilds.
    assert.equal(mod.sessions.get('lc-resume').currentQuery, undefined)
  } finally {
    __setSdkOverrideForTests(undefined)
    mod.__setProjectsDirOverrideForTests(null)
    rmSync(lcProjectsDir, { recursive: true, force: true })
    restoreLcSend()
  }

  // LiveQuery — long-lived streaming-input mode SDK Query. Unwired in
  // this slice; the sendMessage rewrite that consumes it lands later.
  // We lock down the API surface here so the consumer slice can rely
  // on push() / stopTask / interrupt / close / FIFO turn deferreds.
  {
    const { LiveQuery } = await import('../src/lib/live-query.mjs')

    // Helper: build a fake SDK whose `query({prompt, options})` returns
    // a generator that drains the prompt iterable, emitting a 3-message
    // turn (system/init + assistant + result) per pushed user message.
    // Control methods (stopTask / interrupt / setPermissionMode /
    // setModel / close) are also stubbed so we can assert call counts.
    function makeStreamingFakeSdk({ failOnFirstTurn = false } = {}) {
      const calls = { query: 0, stopTask: [], interrupt: 0, setPermissionMode: [], setModel: [], close: 0 }
      let turnIdx = 0
      const sdk = {
        query({ prompt, options }) {
          calls.query++
          calls.lastOptions = options
          let userIter = null
          const gen = (async function*() {
            userIter = prompt[Symbol.asyncIterator]()
            while (true) {
              const next = await userIter.next()
              if (next.done) return
              turnIdx++
              if (failOnFirstTurn && turnIdx === 1) {
                throw new Error('simulated stream failure')
              }
              yield { type: 'system', subtype: 'init', session_id: 'sdk-1' }
              yield { type: 'assistant', session_id: 'sdk-1',
                message: { role: 'assistant', content: [{ type: 'text', text: `turn-${turnIdx}` }] } }
              yield { type: 'result', subtype: 'success', session_id: 'sdk-1',
                result: `turn-${turnIdx}`, stop_reason: 'end_turn',
                total_cost_usd: 0.001, num_turns: turnIdx }
            }
          })()
          gen.stopTask = async (taskId) => { calls.stopTask.push(taskId) }
          gen.interrupt = async () => { calls.interrupt++ }
          gen.setPermissionMode = async (m) => { calls.setPermissionMode.push(m) }
          gen.setModel = async (m) => { calls.setModel.push(m) }
          gen.close = () => { calls.close++ }
          return gen
        },
      }
      return { sdk, calls }
    }

    // (a) Construction validates required deps. Missing sdk / onMessage
    // throws synchronously so callers don't get an opaque later failure.
    assert.throws(() => new LiveQuery({}), /sdk\.query is required/)
    assert.throws(() => new LiveQuery({ sdk: { query: () => null } }), /onMessage callback is required/)

    // (b) Single-turn round trip: sdk.query is called exactly once on
    // construction, push() resolves with the result frame, onMessage is
    // invoked for every yielded SDK message in order, isClosed=false
    // throughout. Repeat push() reuses the same query (call count stays).
    {
      const { sdk, calls } = makeStreamingFakeSdk()
      const seen = []
      const lq = new LiveQuery({ sdk, queryOptions: { cwd: '/x' }, onMessage: (m) => seen.push(m) })
      assert.equal(calls.query, 1, 'sdk.query must run exactly once on construction')
      assert.equal(lq.isClosed, false)

      const r1 = await lq.push({ type: 'user', message: { role: 'user', content: 'hi' } })
      assert.equal(r1.type, 'result')
      assert.equal(r1.result, 'turn-1')
      // onMessage saw all three frames in order.
      assert.equal(seen.length, 3)
      assert.equal(seen[0].type, 'system')
      assert.equal(seen[1].type, 'assistant')
      assert.equal(seen[2].type, 'result')

      // Second push: same query, no rebuild.
      const r2 = await lq.push({ type: 'user', message: { role: 'user', content: 'follow up' } })
      assert.equal(calls.query, 1, 'second push must NOT rebuild the query')
      assert.equal(r2.result, 'turn-2')
      assert.equal(seen.length, 6)

      lq.close()
      assert.equal(lq.isClosed, true)
      assert.equal(calls.close, 1, 'close() must propagate to generator.close()')
    }

    // (c) FIFO turn deferreds: two pushes back-to-back resolve in order
    // even though the second is queued before the first finishes. The
    // fake SDK serialises turns through the iterator so order is kept.
    {
      const { sdk } = makeStreamingFakeSdk()
      const lq = new LiveQuery({ sdk, queryOptions: {}, onMessage: () => {} })
      try {
        const p1 = lq.push({ type: 'user', message: { role: 'user', content: 'first' } })
        const p2 = lq.push({ type: 'user', message: { role: 'user', content: 'second' } })
        const [r1, r2] = await Promise.all([p1, p2])
        assert.match(r1.result, /turn-/)
        assert.match(r2.result, /turn-/)
        // The two turns are distinct (turn-1, turn-2 in either order from
        // the *previous* test's reset; this fresh sdk re-counts from 1).
        assert.notEqual(r1.result, r2.result)
      } finally { lq.close() }
    }

    // (d) Control methods route through the generator's methods. Each
    // verifies the value is forwarded verbatim and call counts increment.
    {
      const { sdk, calls } = makeStreamingFakeSdk()
      const lq = new LiveQuery({ sdk, queryOptions: {}, onMessage: () => {} })
      try {
        await lq.stopTask('task-1')
        await lq.stopTask('task-2')
        assert.deepEqual(calls.stopTask, ['task-1', 'task-2'])
        await lq.interrupt()
        assert.equal(calls.interrupt, 1)
        await lq.setPermissionMode('plan')
        assert.deepEqual(calls.setPermissionMode, ['plan'])
        await lq.setModel('claude-opus-4-7')
        assert.deepEqual(calls.setModel, ['claude-opus-4-7'])
      } finally { lq.close() }

      // After close, control methods reject — they'd hit a dead generator
      // otherwise.
      await assert.rejects(lq.stopTask('x'), /closed/)
      await assert.rejects(lq.interrupt(), /closed/)
      await assert.rejects(lq.setPermissionMode('default'), /closed/)
      await assert.rejects(lq.setModel('x'), /closed/)
      await assert.rejects(lq.push({ type: 'user', message: { role: 'user', content: 'late' } }), /closed/)
    }

    // (e) Control method without SDK support throws a clear error rather
    // than silently swallowing. Build a generator that idles forever so
    // the LiveQuery stays open while we probe its control methods.
    {
      let resolveIdle
      const sdkBare = {
        query() {
          const gen = (async function*() {
            await new Promise(r => { resolveIdle = r })
          })()
          gen.close = () => { if (resolveIdle) resolveIdle() }
          // Note: NO stopTask / interrupt / setPermissionMode / setModel.
          return gen
        },
      }
      const lq = new LiveQuery({ sdk: sdkBare, queryOptions: {}, onMessage: () => {} })
      try {
        await assert.rejects(lq.stopTask('x'), /not supported by this SDK build/)
        await assert.rejects(lq.interrupt(), /not supported/)
        await assert.rejects(lq.setPermissionMode('plan'), /not supported/)
        await assert.rejects(lq.setModel('x'), /not supported/)
      } finally { lq.close() }
    }

    // (f) Generator throws → onError fires, all pending pushes reject,
    // isClosed flips true. The simulated SDK throws on first turn.
    {
      const { sdk } = makeStreamingFakeSdk({ failOnFirstTurn: true })
      const errors = []
      const lq = new LiveQuery({ sdk, queryOptions: {}, onMessage: () => {}, onError: (e) => errors.push(e) })
      const p = lq.push({ type: 'user', message: { role: 'user', content: 'doomed' } })
      await assert.rejects(p, /simulated stream failure/)
      // Wait a tick for the drain loop to clean up.
      await new Promise(r => setTimeout(r, 10))
      assert.equal(lq.isClosed, true)
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /simulated stream failure/)
    }

    // (g) onMessage that throws is funnelled through onError but doesn't
    // halt the drain loop. Subsequent messages still arrive.
    {
      const { sdk } = makeStreamingFakeSdk()
      const errors = []
      let count = 0
      const lq = new LiveQuery({
        sdk, queryOptions: {},
        onMessage: () => { count++; if (count === 1) throw new Error('boom in handler') },
        onError: (e) => errors.push(e),
      })
      try {
        const r = await lq.push({ type: 'user', message: { role: 'user', content: 'hi' } })
        assert.equal(r.type, 'result')
        // First message threw, second + third still got processed.
        assert.equal(count, 3)
        assert.equal(errors.length, 1)
        assert.match(errors[0].message, /boom in handler/)
      } finally { lq.close() }
    }

    // (h) Idempotent close: second call is a no-op.
    {
      const { sdk, calls } = makeStreamingFakeSdk()
      const lq = new LiveQuery({ sdk, queryOptions: {}, onMessage: () => {} })
      lq.close()
      lq.close()
      assert.equal(lq.isClosed, true)
      assert.equal(calls.close, 1, 'second close must not re-call generator.close')
    }

    // (i) close() while a push is in-flight rejects the pending deferred
    // with a closed error, never hangs. Use a fake SDK that holds the
    // pump open without ever yielding so the push() never naturally
    // resolves.
    {
      let resolveStream
      const sdkSlow = {
        query({ prompt }) {
          const gen = (async function*() {
            const it = prompt[Symbol.asyncIterator]()
            await it.next() // consume the user message
            // Wait forever (until close fires the abort).
            await new Promise(r => { resolveStream = r })
          })()
          gen.close = () => { if (resolveStream) resolveStream() }
          return gen
        },
      }
      const lq = new LiveQuery({ sdk: sdkSlow, queryOptions: {}, onMessage: () => {} })
      const inflight = lq.push({ type: 'user', message: { role: 'user', content: 'pending' } })
      // Close before any 'result' frame.
      setTimeout(() => lq.close(), 20)
      await assert.rejects(inflight, /closed/i)
    }
  }

  // claude.resumeSession: rehydrates an existing SDK session id so the
  // next sendMessage carries `resume: <id>`. Aborts any in-flight query
  // first; defaults permissionMode to bypassPermissions; respects
  // overrides supplied via options.
  const resumeCaptured = []
  const resumeQueryCaptured = []
  const resumeProjectsDir = mkdtempSync(join(tmpdir(), 'sidecar-resume-history-'))
  const setProjectsDirForResume = mod.__setProjectsDirOverrideForTests
  setProjectsDirForResume(resumeProjectsDir)
  const resumeCwd = '/r'
  const resumeProjectDir = join(resumeProjectsDir, resumeCwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(resumeProjectDir, { recursive: true })
  writeFileSync(join(resumeProjectDir, 'sdk-historic-xyz.jsonl'), [
    JSON.stringify({ type: 'user', uuid: 'hist-u-1', timestamp: '2026-05-10T00:00:00.000Z', message: { role: 'user', content: 'ping' } }),
    JSON.stringify({ type: 'assistant', uuid: 'hist-a-1', timestamp: '2026-05-10T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] } }),
  ].join('\n') + '\n')
  const restoreResumeSend = mod.__setSendEventForTests((name, payload) => resumeCaptured.push({ name, payload }))
  const fakeSdkResume = {
    query({ options }) {
      resumeQueryCaptured.push({ options })
      const messages = [
        { type: 'system', subtype: 'init', session_id: options.resume || 'fresh-sdk' },
        { type: 'result', subtype: 'success', session_id: options.resume || 'fresh-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkResume)
  try {
    // Resume a session that the renderer just restored from history.
    const resumeReply = await dispatch({ jsonrpc: '2.0', id: 295, method: 'claude.resumeSession',
      params: { sessionId: 'resume-1', sdkSessionId: 'sdk-historic-xyz',
        options: { cwd: resumeCwd, model: 'claude-sonnet-4-6' } } })
    assert.equal(resumeReply.result.ok, true)
    assert.equal(resumeReply.result.sdkSessionId, 'sdk-historic-xyz')
    const resumeLoadingEvents = resumeCaptured.filter(e => e.name === 'claude:resume-loading')
    assert.deepEqual(resumeLoadingEvents.map(e => e.payload.loading), [true, false])
    const historyEvent = resumeCaptured.find(e => e.name === 'claude:history')
    assert.ok(historyEvent, 'resumeSession must emit claude:history')
    assert.deepEqual(historyEvent.payload.items.map(i => `${i.role}:${i.content}`), ['user:ping', 'assistant:pong'])
    // Default permissionMode must be bypassPermissions for resumed sessions.
    const resumed = mod.sessions.get('resume-1')
    assert.equal(resumed.permissionMode, 'bypassPermissions')
    assert.equal(resumed.sdkSessionId, 'sdk-historic-xyz')
    assert.equal(resumed.model, 'claude-sonnet-4-6')
    // Next sendMessage must include the resumed sdkSessionId on
    // queryOptions.resume — that's what makes the SDK reconstruct the
    // historical conversation context.
    await dispatch({ jsonrpc: '2.0', id: 296, method: 'claude.sendMessage',
      params: { sessionId: 'resume-1', prompt: 'continue' } })
    assert.equal(resumeQueryCaptured.length, 1)
    assert.equal(resumeQueryCaptured[0].options.resume, 'sdk-historic-xyz')

    // Resume must re-derive the auto-compact window from a preset id even
    // when the renderer didn't send the numeric option — app restarts resume
    // without it, and this is what keeps the 300k cap alive across restarts
    // instead of silently running uncapped to the full model window.
    const resumeCapReply = await dispatch({ jsonrpc: '2.0', id: 29511, method: 'claude.resumeSession',
      params: { sessionId: 'resume-cap', sdkSessionId: 'sdk-historic-xyz',
        options: { cwd: resumeCwd, model: 'claude-sonnet-4-6:auto-compact-300k' } } })
    assert.equal(resumeCapReply.result.ok, true)
    assert.equal(mod.sessions.get('resume-cap').autoCompactWindow, 300000,
      'resume must derive the window from the preset id')
    await dispatch({ jsonrpc: '2.0', id: 29512, method: 'claude.sendMessage',
      params: { sessionId: 'resume-cap', prompt: 'continue capped' } })
    const cappedOpts = resumeQueryCaptured[resumeQueryCaptured.length - 1].options
    assert.equal(cappedOpts.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '300000',
      'resumed session must spawn the CLI with the derived window env')
    assert.equal(cappedOpts.model, 'claude-sonnet-4-6[1m]',
      'preset id must still map to the base SDK model id, with the [1m] that '
      + 'gives the 300k cap a window large enough to sit under')

    // An explicit numeric option on resume wins over the preset suffix.
    await dispatch({ jsonrpc: '2.0', id: 29513, method: 'claude.resumeSession',
      params: { sessionId: 'resume-cap2', sdkSessionId: 'sdk-historic-xyz',
        options: { cwd: resumeCwd, model: 'claude-sonnet-4-6:auto-compact-300k', autoCompactWindow: 250000 } } })
    assert.equal(mod.sessions.get('resume-cap2').autoCompactWindow, 250000,
      'explicit resume option must win over the preset suffix')

    // GH #124: resume must come back in the mode the session was actually in.
    // permissionMode used to be overwritten with bypassPermissions on every
    // resume, so a session deliberately parked in `plan` silently came back
    // able to write — the one transition a plan-mode user is guarding against.
    await dispatch({ jsonrpc: '2.0', id: 29514, method: 'claude.setPermissionMode',
      params: { sessionId: 'resume-mode', mode: 'plan' } })
    await dispatch({ jsonrpc: '2.0', id: 29515, method: 'claude.resumeSession',
      params: { sessionId: 'resume-mode', sdkSessionId: 'sdk-historic-xyz',
        options: { cwd: resumeCwd } } })
    assert.equal(mod.sessions.get('resume-mode').permissionMode, 'plan',
      'resume must restore the remembered permission mode, not force bypassPermissions')

    // An explicit mode in the resume options still wins: the renderer owns the
    // durable copy and sends it, so its value must not be second-guessed by the
    // sidecar's own memory of an older change.
    await dispatch({ jsonrpc: '2.0', id: 29516, method: 'claude.resumeSession',
      params: { sessionId: 'resume-mode', sdkSessionId: 'sdk-historic-xyz',
        options: { cwd: resumeCwd, permissionMode: 'acceptEdits' } } })
    assert.equal(mod.sessions.get('resume-mode').permissionMode, 'acceptEdits',
      'explicit resume option must win over the remembered mode')

    // If the persisted terminal cwd no longer matches Claude's project dir,
    // do not globally borrow a transcript from a different cwd. The UI may
    // otherwise display history that Claude Code cannot resume from the
    // active cwd, and the next send fails with "No conversation found".
    const fallbackProjectDir = join(resumeProjectsDir, 'C--fallback-project')
    mkdirSync(fallbackProjectDir, { recursive: true })
    writeFileSync(join(fallbackProjectDir, 'sdk-global-xyz.jsonl'), [
      JSON.stringify({ type: 'user', uuid: 'hist-global-u', timestamp: '2026-05-10T00:00:02.000Z', message: { role: 'user', content: 'global ping' } }),
      JSON.stringify({ type: 'assistant', uuid: 'hist-global-a', timestamp: '2026-05-10T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'global pong' }] } }),
    ].join('\n') + '\n')
    resumeCaptured.length = 0
    const globalResumeReply = await dispatch({ jsonrpc: '2.0', id: 2961, method: 'claude.resumeSession',
      params: { sessionId: 'resume-global', sdkSessionId: 'sdk-global-xyz',
        options: { cwd: '/wrong/cwd' } } })
    assert.equal(globalResumeReply.result.ok, true)
    assert.equal(globalResumeReply.result.stale, true)
    assert.equal(globalResumeReply.result.requestedSdkSessionId, 'sdk-global-xyz')
    const globalHistoryEvent = resumeCaptured.find(e => e.name === 'claude:history')
    assert.ok(globalHistoryEvent, 'resumeSession must emit empty claude:history for stale resume')
    assert.deepEqual(globalHistoryEvent.payload.items, [])
    assert.equal(mod.sessions.get('resume-global').sdkSessionId, null)

    // Resume must reject missing sdkSessionId or sessionId.
    const noSdkReply = await dispatch({ jsonrpc: '2.0', id: 297, method: 'claude.resumeSession',
      params: { sessionId: 'r2' } })
    assert.match(noSdkReply.error?.message || '', /missing sdkSessionId/)
    const noSidReply = await dispatch({ jsonrpc: '2.0', id: 298, method: 'claude.resumeSession',
      params: { sdkSessionId: 'x' } })
    assert.match(noSidReply.error?.message || '', /missing sessionId/)

    // Override default permissionMode via options.
    writeClaudeHistory(resumeProjectsDir, '/r', 'sdk-2')
    await dispatch({ jsonrpc: '2.0', id: 299, method: 'claude.resumeSession',
      params: { sessionId: 'resume-2', sdkSessionId: 'sdk-2',
        options: { cwd: '/r', permissionMode: 'plan' } } })
    assert.equal(mod.sessions.get('resume-2').permissionMode, 'plan')
  } finally {
    __setSdkOverrideForTests(undefined)
    setProjectsDirForResume(null)
    rmSync(resumeProjectsDir, { recursive: true, force: true })
    restoreResumeSend()
  }

  // claude.clientResume: non-destructive history re-emit for a (re)connecting
  // client. When the session is absent it behaves like resume (emits history,
  // stashes sdkSessionId). When the session already exists it re-emits
  // claude:history WITHOUT tearing down / rebuilding the session record — so a
  // remote client opening a session the host keeps live never goes blank and
  // an in-flight host turn is not disturbed.
  {
    const ccCaptured = []
    const ccProjectsDir = mkdtempSync(join(tmpdir(), 'sidecar-client-resume-'))
    const setCcProjectsDir = mod.__setProjectsDirOverrideForTests
    setCcProjectsDir(ccProjectsDir)
    const ccCwd = '/cc'
    const ccProjectDir = join(ccProjectsDir, ccCwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(ccProjectDir, { recursive: true })
    writeFileSync(join(ccProjectDir, 'sdk-cc-1.jsonl'), [
      JSON.stringify({ type: 'user', uuid: 'cc-u-1', timestamp: '2026-05-11T00:00:00.000Z', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', uuid: 'cc-a-1', timestamp: '2026-05-11T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
    ].join('\n') + '\n')
    const restoreCcSend = mod.__setSendEventForTests((name, payload) => ccCaptured.push({ name, payload }))
    try {
      // Absent session → falls back to a normal resume (history + sdkSessionId).
      const absentReply = await dispatch({ jsonrpc: '2.0', id: 700, method: 'claude.clientResume',
        params: { sessionId: 'cc-1', sdkSessionId: 'sdk-cc-1', options: { cwd: ccCwd } } })
      assert.equal(absentReply.result.ok, true)
      const absentHistory = ccCaptured.find(e => e.name === 'claude:history')
      assert.ok(absentHistory, 'clientResume must emit claude:history when the session is absent')
      assert.deepEqual(absentHistory.payload.items.map(i => `${i.role}:${i.content}`), ['user:hi', 'assistant:hello'])
      assert.equal(mod.sessions.get('cc-1').sdkSessionId, 'sdk-cc-1')

      // Existing session → re-emit history read-only, same record (not rebuilt).
      ccCaptured.length = 0
      const existingRef = mod.sessions.get('cc-1')
      // Model a renderer-LRU remount whose live snapshot no longer carries the
      // transcript. clientResume must repopulate both the event and idle
      // sidecar state without replacing the session object.
      existingRef.messages = []
      const existedReply = await dispatch({ jsonrpc: '2.0', id: 701, method: 'claude.clientResume',
        params: { sessionId: 'cc-1', sdkSessionId: 'sdk-cc-1', options: { cwd: ccCwd } } })
      assert.equal(existedReply.result.existed, true)
      assert.equal(existedReply.result.found, true)
      const existedHistory = ccCaptured.find(e => e.name === 'claude:history')
      assert.ok(existedHistory, 'clientResume must re-emit claude:history for an existing session')
      assert.deepEqual(existedHistory.payload.items.map(i => `${i.role}:${i.content}`), ['user:hi', 'assistant:hello'])
      assert.strictEqual(mod.sessions.get('cc-1'), existingRef, 'clientResume must not rebuild an existing session record')
      assert.equal(mod.sessions.get('cc-1').sdkSessionId, 'sdk-cc-1')
      assert.deepEqual(existingRef.messages.map(i => `${i.role}:${i.content}`), ['user:hi', 'assistant:hello'],
        'clientResume must refill an empty idle session snapshot from its transcript')

      // A second client may have neither the SDK id nor the host's current cwd
      // in its workspace snapshot. The live host session is authoritative.
      ccCaptured.length = 0
      const hostOwnedReply = await dispatch({ jsonrpc: '2.0', id: 702, method: 'claude.clientResume',
        params: { sessionId: 'cc-1', options: { cwd: '/stale-client-cwd' } } })
      assert.equal(hostOwnedReply.result.sdkSessionId, 'sdk-cc-1')
      assert.equal(hostOwnedReply.result.found, true)
      const hostOwnedHistory = ccCaptured.find(e => e.name === 'claude:history')
      assert.deepEqual(hostOwnedHistory.payload.items.map(i => `${i.role}:${i.content}`), ['user:hi', 'assistant:hello'])
      assert.strictEqual(mod.sessions.get('cc-1'), existingRef, 'host-owned clientResume must stay non-destructive')

      // If the sidecar session map was rebuilt, exact-id global lookup still
      // recovers a transcript whose worktree/cwd no longer matches the client.
      writeFileSync(join(ccProjectDir, 'sdk-cc-global.jsonl'), [
        JSON.stringify({ type: 'user', uuid: 'cc-global-u', timestamp: '2026-05-11T00:00:02.000Z', message: { role: 'user', content: 'moved' } }),
        JSON.stringify({ type: 'assistant', uuid: 'cc-global-a', timestamp: '2026-05-11T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'found' }] } }),
      ].join('\n') + '\n')
      ccCaptured.length = 0
      const globalReply = await dispatch({ jsonrpc: '2.0', id: 703, method: 'claude.clientResume',
        params: { sessionId: 'cc-global', sdkSessionId: 'sdk-cc-global', options: { cwd: '/stale-client-cwd' } } })
      assert.equal(globalReply.result.ok, true)
      assert.equal(globalReply.result.sdkSessionId, 'sdk-cc-global')
      const globalHistory = ccCaptured.find(e => e.name === 'claude:history')
      assert.deepEqual(globalHistory.payload.items.map(i => `${i.role}:${i.content}`), ['user:moved', 'assistant:found'])

      // GH #125: a transcript we cannot find is not a transcript we know to be
      // empty. The file lives at a path derived from the cwd, so a moved
      // worktree or a session first run elsewhere reads as "no file" — and
      // treating that as "no history" used to reset the host's own in-memory
      // copy, emptying the conversation on the desktop because a phone opened
      // it. Whatever we still hold is a partial answer but never a wrong one.
      ccCaptured.length = 0
      const strandedRef = mod.sessions.get('cc-1')
      strandedRef.sdkSessionId = 'sdk-cc-vanished'
      strandedRef.messages = [
        { id: 'm-1', sessionId: 'cc-1', role: 'user', content: 'still here', timestamp: 1 },
        { id: 'm-2', sessionId: 'cc-1', role: 'assistant', content: 'and so am I', timestamp: 2 },
      ]
      const strandedReply = await dispatch({ jsonrpc: '2.0', id: 706, method: 'claude.clientResume',
        params: { sessionId: 'cc-1', sdkSessionId: 'sdk-cc-vanished', options: { cwd: ccCwd } } })
      assert.equal(strandedReply.result.ok, true)
      assert.equal(strandedReply.result.found, false, 'the disk read genuinely found nothing')
      assert.deepEqual(
        strandedRef.messages.map(i => `${i.role}:${i.content}`),
        ['user:still here', 'assistant:and so am I'],
        'a missing transcript must not wipe the host transcript',
      )
      const strandedHistory = ccCaptured.find(e => e.name === 'claude:history')
      assert.ok(strandedHistory, 'a missing transcript still emits claude:history')
      assert.deepEqual(
        strandedHistory.payload.items.map(i => `${i.role}:${i.content}`),
        ['user:still here', 'assistant:and so am I'],
        'the client must be sent what we have, not an empty conversation',
      )

      // Validation mirrors resumeSession.
      const noSid = await dispatch({ jsonrpc: '2.0', id: 704, method: 'claude.clientResume', params: { sessionId: 'x' } })
      assert.match(noSid.error?.message || '', /missing sdkSessionId/)
      const noSession = await dispatch({ jsonrpc: '2.0', id: 705, method: 'claude.clientResume', params: { sdkSessionId: 'y' } })
      assert.match(noSession.error?.message || '', /missing sessionId/)
    } finally {
      setCcProjectsDir(null)
      rmSync(ccProjectsDir, { recursive: true, force: true })
      restoreCcSend()
    }
  }

  // claude.rewindToPrompt: cut the SDK transcript at a given user-prompt
  // index and write a fresh transcript under a new SDK session id.
  // Test drives the on-disk projects dir via a tmpdir override, builds
  // a synthetic JSONL transcript with 3 user prompts + assistant
  // responses interleaved, then asserts the cut wrote a new file with
  // only the lines before the index, removedPromptCount is correct,
  // and session.sdkSessionId points at the new id.
  const { __setProjectsDirOverrideForTests } = mod
  const projTmp = mkdtempSync(join(tmpdir(), 'sidecar-rewind-'))
  __setProjectsDirOverrideForTests(projTmp)
  try {
    // The CLI encodes cwd into the project dir name by replacing any
    // non-alphanumeric char with '-'. Use a path with slashes so the
    // encoded name actually exercises the encoding.
    const cwd = '/projects/alpha'
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const projDir = join(projTmp, encoded)
    mkdirSync(projDir, { recursive: true })
    const sdkId = '0000-aaaa-bbbb-historic'
    const txtMsg = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, sessionId: sdkId })
    const asstMsg = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, sessionId: sdkId })
    // Note: the second 'user' line below has tool_result content — it
    // must NOT count toward userPromptCount.
    const transcript = [
      txtMsg('first prompt'),
      asstMsg('first reply'),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] }, sessionId: sdkId },
      txtMsg('second prompt'),
      asstMsg('second reply'),
      txtMsg('third prompt'),
      asstMsg('third reply'),
    ]
    writeFileSync(
      join(projDir, `${sdkId}.jsonl`),
      transcript.map(o => JSON.stringify(o)).join('\n') + '\n',
    )

    // Bring up a session that points at this sdkId.
    await dispatch({ jsonrpc: '2.0', id: 350, method: 'claude.resumeSession',
      params: { sessionId: 'rw-1', sdkSessionId: sdkId, options: { cwd } } })

    // Rewind to prompt index 1 (the second text-bearing user prompt).
    // Cutoff line should be the index-3 line (txtMsg('second prompt')).
    const reply = await dispatch({ jsonrpc: '2.0', id: 351, method: 'claude.rewindToPrompt',
      params: { sessionId: 'rw-1', promptIndex: 1 } })
    assert.ok(reply.result, `expected result, got ${JSON.stringify(reply)}`)
    assert.equal(typeof reply.result.newSdkSessionId, 'string')
    assert.notEqual(reply.result.newSdkSessionId, sdkId)
    // Lines kept = indexes 0..2 = 3 lines. removed = 7 - 3 = 4.
    assert.equal(reply.result.removedPromptCount, 4)
    // The new transcript file exists with the kept lines and the
    // sessionId field rewritten.
    const newFile = join(projDir, `${reply.result.newSdkSessionId}.jsonl`)
    const newRaw = await readFile(newFile, 'utf-8')
    const newLines = newRaw.split('\n').filter(l => l.trim())
    assert.equal(newLines.length, 3)
    for (const line of newLines) {
      const obj = JSON.parse(line)
      assert.equal(obj.sessionId, reply.result.newSdkSessionId,
        'kept lines must have their sessionId rewritten to the new id')
    }
    // Session state was rewired.
    assert.equal(mod.sessions.get('rw-1').sdkSessionId, reply.result.newSdkSessionId)

    // Out-of-range promptIndex returns an error message.
    const oobReply = await dispatch({ jsonrpc: '2.0', id: 352, method: 'claude.rewindToPrompt',
      params: { sessionId: 'rw-1', promptIndex: 99 } })
    assert.ok(oobReply.result.error, `expected error, got ${JSON.stringify(oobReply)}`)
    assert.match(oobReply.result.error, /not found|user prompt/)

    // Streaming session refuses rewind (the renderer must stop the turn first).
    const streamingSession = mod.sessions.get('rw-1')
    streamingSession.streaming = true
    const busyReply = await dispatch({ jsonrpc: '2.0', id: 353, method: 'claude.rewindToPrompt',
      params: { sessionId: 'rw-1', promptIndex: 0 } })
    assert.match(busyReply.result.error || '', /Claude is responding/)
    streamingSession.streaming = false

    // Missing/invalid params surface clear error messages (not throws).
    const missingSidReply = await dispatch({ jsonrpc: '2.0', id: 354, method: 'claude.rewindToPrompt',
      params: { promptIndex: 0 } })
    assert.match(missingSidReply.result.error || '', /missing sessionId/)
    const negIdxReply = await dispatch({ jsonrpc: '2.0', id: 355, method: 'claude.rewindToPrompt',
      params: { sessionId: 'rw-1', promptIndex: -1 } })
    assert.match(negIdxReply.result.error || '', /non-negative number/)

    // Unknown sessionId.
    const unknownReply = await dispatch({ jsonrpc: '2.0', id: 356, method: 'claude.rewindToPrompt',
      params: { sessionId: 'never-started', promptIndex: 0 } })
    assert.equal(unknownReply.result.error, 'Session not found')
  } finally {
    __setProjectsDirOverrideForTests(null)
    rmSync(projTmp, { recursive: true, force: true })
  }

  // claude.forkSession: copy the current SDK transcript into a new SDK
  // session id by running a one-turn `forkSession: true` query. Drive the
  // SDK with a fake that yields a `system:init` carrying a new session_id,
  // then a `result` (the handler must wait for result before returning so
  // the CLI has time to persist the forked transcript). Assert the
  // captured queryOptions include forkSession + resume + maxTurns + cwd
  // + abortController, and that the handler returns { newSdkSessionId }.
  const forkCaptured = []
  const restoreForkSend = mod.__setSendEventForTests(() => {})
  const forkProjectsDir = mkdtempSync(join(tmpdir(), 'sidecar-fork-history-'))
  mod.__setProjectsDirOverrideForTests(forkProjectsDir)
  const fakeSdkFork = {
    query({ prompt, options }) {
      forkCaptured.push({ prompt, options })
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'forked-sdk-id', cwd: options.cwd, model: 'claude-opus-4-7', permissionMode: 'default' },
        { type: 'result', subtype: 'success', session_id: 'forked-sdk-id', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkFork)
  try {
    // Bring up a session with a current sdkSessionId via resumeSession so
    // the fork has something to copy from.
    writeClaudeHistory(forkProjectsDir, '/fork-cwd', 'sdk-original-abc')
    await dispatch({ jsonrpc: '2.0', id: 400, method: 'claude.resumeSession',
      params: { sessionId: 'fork-1', sdkSessionId: 'sdk-original-abc',
        options: { cwd: '/fork-cwd' } } })

    const reply = await dispatch({ jsonrpc: '2.0', id: 401, method: 'claude.forkSession',
      params: { sessionId: 'fork-1' } })
    assert.ok(reply.result, `expected result, got ${JSON.stringify(reply)}`)
    assert.equal(reply.result.newSdkSessionId, 'forked-sdk-id')
    // Original session record is unchanged — fork doesn't mutate the
    // current session's sdkSessionId. The renderer creates a separate
    // session record for the fork.
    assert.equal(mod.sessions.get('fork-1').sdkSessionId, 'sdk-original-abc')

    // Captured query() must carry the SDK fork contract.
    assert.equal(forkCaptured.length, 1)
    const opts = forkCaptured[0].options
    assert.equal(opts.forkSession, true, 'forkSession flag must be set')
    assert.equal(opts.resume, 'sdk-original-abc', 'resume must point at the current sdk id')
    assert.equal(opts.maxTurns, 1, 'maxTurns:1 keeps the fork query short')
    assert.equal(opts.cwd, '/fork-cwd')
    assert.ok(opts.abortController, 'abortController must be supplied for timeout')
    assert.equal(forkCaptured[0].prompt, ' ', 'prompt must be a single space')

    // Missing sessionId → null (no-op).
    const noSidReply = await dispatch({ jsonrpc: '2.0', id: 402, method: 'claude.forkSession',
      params: {} })
    assert.equal(noSidReply.result, null)

    // Unknown session → null.
    const unknownReply = await dispatch({ jsonrpc: '2.0', id: 403, method: 'claude.forkSession',
      params: { sessionId: 'never-started' } })
    assert.equal(unknownReply.result, null)
  } finally {
    __setSdkOverrideForTests(undefined)
    mod.__setProjectsDirOverrideForTests(null)
    rmSync(forkProjectsDir, { recursive: true, force: true })
    restoreForkSend()
  }

  // Session without sdkSessionId yet → null (nothing to fork from).
  await dispatch({ jsonrpc: '2.0', id: 404, method: 'claude.startSession',
    params: { sessionId: 'fork-empty', options: { cwd: '/x' } } })
  // Note: startSession creates session record but sdkSessionId is empty
  // until a query has run. The fake SDK isn't installed here, so even if
  // we did have an id, the SDK loader returns null in test env.
  const noIdReply = await dispatch({ jsonrpc: '2.0', id: 405, method: 'claude.forkSession',
    params: { sessionId: 'fork-empty' } })
  assert.equal(noIdReply.result, null)

  // Fork that never yields a session_id → null. Drive a fake SDK whose
  // generator yields only a `result` with no preceding `system:init`.
  const restoreForkSend2 = mod.__setSendEventForTests(() => {})
  const forkNoInitProjectsDir = mkdtempSync(join(tmpdir(), 'sidecar-fork-no-init-history-'))
  mod.__setProjectsDirOverrideForTests(forkNoInitProjectsDir)
  const fakeSdkForkNoInit = {
    query() {
      return (async function*() {
        yield { type: 'result', subtype: 'success', session_id: 'whatever', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkForkNoInit)
  try {
    writeClaudeHistory(forkNoInitProjectsDir, '/x', 'sdk-no-init')
    await dispatch({ jsonrpc: '2.0', id: 406, method: 'claude.resumeSession',
      params: { sessionId: 'fork-no-init', sdkSessionId: 'sdk-no-init',
        options: { cwd: '/x' } } })
    const noInitReply = await dispatch({ jsonrpc: '2.0', id: 407, method: 'claude.forkSession',
      params: { sessionId: 'fork-no-init' } })
    assert.equal(noInitReply.result, null,
      'no system:init means no new session_id captured → null')
  } finally {
    __setSdkOverrideForTests(undefined)
    mod.__setProjectsDirOverrideForTests(null)
    rmSync(forkNoInitProjectsDir, { recursive: true, force: true })
    restoreForkSend2()
  }

  // claude.fetchSubagentMessages: read the SDK's per-subagent transcript
  // shard and normalise into the renderer's (ClaudeMessage|ClaudeToolCall)[]
  // shape. Drive a fake SDK exporting `getSubagentMessages()` that yields
  // a synthetic 4-message conversation: user kickoff prompt, assistant
  // tool_use, user tool_result (success), assistant final reply. Assert
  // the sidecar collapses the tool_result back into the matching tool
  // entry, drops noise messages, and tags items with parentToolUseId.
  const fetchCaptured = []
  const restoreFetchSend = mod.__setSendEventForTests(() => {})
  const fetchProjectsDir = mkdtempSync(join(tmpdir(), 'sidecar-fetch-history-'))
  mod.__setProjectsDirOverrideForTests(fetchProjectsDir)
  const fakeSdkFetch = {
    getSubagentMessages(sdkSid, agentId, opts) {
      fetchCaptured.push({ sdkSid, agentId, opts })
      return Promise.resolve([
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'sub kickoff' }] },
          timestamp: '2026-05-09T10:00:00Z',
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [
            { type: 'thinking', thinking: 'planning the bash run' },
            { type: 'text', text: 'I will run the command.' },
            { type: 'tool_use', id: 'tu-bash-1', name: 'Bash', input: { command: 'ls' } },
          ] },
          timestamp: '2026-05-09T10:00:01Z',
        },
        {
          type: 'user',
          message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'tu-bash-1', content: 'file1\nfile2', is_error: false },
          ] },
          timestamp: '2026-05-09T10:00:02Z',
        },
        // Noise message — must be dropped.
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
          timestamp: '2026-05-09T10:00:03Z',
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [
            { type: 'text', text: 'Done.' },
          ] },
          timestamp: '2026-05-09T10:00:04Z',
        },
      ])
    },
  }
  __setSdkOverrideForTests(fakeSdkFetch)
  try {
    writeClaudeHistory(fetchProjectsDir, '/sa-cwd', 'sdk-parent-xyz')
    await dispatch({ jsonrpc: '2.0', id: 410, method: 'claude.resumeSession',
      params: { sessionId: 'sa-1', sdkSessionId: 'sdk-parent-xyz',
        options: { cwd: '/sa-cwd' } } })

    const reply = await dispatch({ jsonrpc: '2.0', id: 411, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-1', agentToolUseId: 'agent-tu-1' } })
    assert.ok(Array.isArray(reply.result), `expected array, got ${JSON.stringify(reply)}`)
    assert.equal(reply.result.length, 4, 'kickoff + thinking-bearing assistant + bash tool + final reply (noise dropped)')

    // SDK helper was called with sdkSessionId, agentToolUseId, and {dir:cwd}.
    assert.equal(fetchCaptured.length, 1)
    assert.equal(fetchCaptured[0].sdkSid, 'sdk-parent-xyz')
    assert.equal(fetchCaptured[0].agentId, 'agent-tu-1')
    assert.deepEqual(fetchCaptured[0].opts, { dir: '/sa-cwd' })

    // Item 0: user kickoff text. parentToolUseId pinned to the agent.
    assert.equal(reply.result[0].role, 'user')
    assert.equal(reply.result[0].content, 'sub kickoff')
    assert.equal(reply.result[0].parentToolUseId, 'agent-tu-1')

    // Item 1: assistant text with thinking sidecar.
    assert.equal(reply.result[1].role, 'assistant')
    assert.equal(reply.result[1].content, 'I will run the command.')
    assert.equal(reply.result[1].thinking, 'planning the bash run')

    // Item 2: tool_use entry, status updated to 'completed' by the
    // tool_result fold-in, result text captured.
    assert.equal(reply.result[2].toolName, 'Bash')
    assert.equal(reply.result[2].id, 'tu-bash-1')
    assert.deepEqual(reply.result[2].input, { command: 'ls' })
    assert.equal(reply.result[2].status, 'completed', 'tool_result is_error:false → completed')
    assert.equal(reply.result[2].result, 'file1\nfile2', 'tool_result content folded in')

    // Item 3: final assistant reply.
    assert.equal(reply.result[3].role, 'assistant')
    assert.equal(reply.result[3].content, 'Done.')

    // is_error:true should map status → 'error'.
    const errSdk = {
      getSubagentMessages: () => Promise.resolve([
        { type: 'assistant', message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu-read-1', name: 'Read', input: { file_path: '/missing' } },
        ] } },
        { type: 'user', message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu-read-1', content: 'ENOENT', is_error: true },
        ] } },
      ]),
    }
    __setSdkOverrideForTests(errSdk)
    const errReply = await dispatch({ jsonrpc: '2.0', id: 412, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-1', agentToolUseId: 'agent-tu-2' } })
    assert.equal(errReply.result.length, 1)
    assert.equal(errReply.result[0].status, 'error')
    assert.equal(errReply.result[0].result, 'ENOENT')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreFetchSend()
  }

  // Defensive paths: missing params → []; unknown sessionId → [];
  // session without sdkSessionId → []; SDK throws → []; SDK without
  // getSubagentMessages helper → []. All five must avoid throwing so the
  // renderer just shows "no subagent details" instead of crashing.
  const restoreFetchSend2 = mod.__setSendEventForTests(() => {})
  try {
    const noSidReply = await dispatch({ jsonrpc: '2.0', id: 413, method: 'claude.fetchSubagentMessages',
      params: { agentToolUseId: 'a' } })
    assert.deepEqual(noSidReply.result, [])
    const noAgentReply = await dispatch({ jsonrpc: '2.0', id: 414, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-1' } })
    assert.deepEqual(noAgentReply.result, [])
    const unknownReply = await dispatch({ jsonrpc: '2.0', id: 415, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'never-started', agentToolUseId: 'a' } })
    assert.deepEqual(unknownReply.result, [])

    // Session with no sdkSessionId yet → [] (start without resume).
    await dispatch({ jsonrpc: '2.0', id: 416, method: 'claude.startSession',
      params: { sessionId: 'sa-empty', options: { cwd: '/x' } } })
    const noSdkReply = await dispatch({ jsonrpc: '2.0', id: 417, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-empty', agentToolUseId: 'a' } })
    assert.deepEqual(noSdkReply.result, [])

    // SDK throws → [].
    const throwingSdk = {
      getSubagentMessages: () => Promise.reject(new Error('disk read failed')),
    }
    __setSdkOverrideForTests(throwingSdk)
    writeClaudeHistory(fetchProjectsDir, '/x', 'sdk-t')
    await dispatch({ jsonrpc: '2.0', id: 418, method: 'claude.resumeSession',
      params: { sessionId: 'sa-throw', sdkSessionId: 'sdk-t', options: { cwd: '/x' } } })
    const throwReply = await dispatch({ jsonrpc: '2.0', id: 419, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-throw', agentToolUseId: 'a' } })
    assert.deepEqual(throwReply.result, [], 'sdk throw → graceful []')

    // SDK without getSubagentMessages helper → [].
    __setSdkOverrideForTests({ /* no getSubagentMessages */ })
    const noHelperReply = await dispatch({ jsonrpc: '2.0', id: 420, method: 'claude.fetchSubagentMessages',
      params: { sessionId: 'sa-throw', agentToolUseId: 'a' } })
    assert.deepEqual(noHelperReply.result, [], 'missing helper → []')
  } finally {
    __setSdkOverrideForTests(undefined)
    mod.__setProjectsDirOverrideForTests(null)
    rmSync(fetchProjectsDir, { recursive: true, force: true })
    restoreFetchSend2()
  }

  // claude.restSession / wakeSession / isResting — the renderer's
  // pause/resume UX. rest aborts in-flight + emits a one-line system
  // message so the panel shows "tap to wake"; wake clears the flag;
  // sendMessage also auto-wakes (mirror of claude-agent-manager.ts:581).
  // Drive a fake SDK so we can pre-flag streaming + verify abort signal
  // propagation without depending on real network.
  const restEvents = []
  const restoreRestSend = mod.__setSendEventForTests((method, payload) => {
    restEvents.push({ method, payload })
  })
  const restProjectsDir = mkdtempSync(join(tmpdir(), 'sidecar-rest-history-'))
  mod.__setProjectsDirOverrideForTests(restProjectsDir)
  try {
    // Bring up a session via resumeSession (gives it an sdkSessionId).
    const fakeSdkRest = {
      query() {
        return (async function*() { /* never yields */ })()
      },
    }
    __setSdkOverrideForTests(fakeSdkRest)
    writeClaudeHistory(restProjectsDir, '/r', 'sdk-rest-x')
    await dispatch({ jsonrpc: '2.0', id: 430, method: 'claude.resumeSession',
      params: { sessionId: 'rest-1', sdkSessionId: 'sdk-rest-x',
        options: { cwd: '/r' } } })

    // Initial state: not resting.
    const before = await dispatch({ jsonrpc: '2.0', id: 431, method: 'claude.isResting',
      params: { sessionId: 'rest-1' } })
    assert.equal(before.result, false)

    // Pre-flag streaming + plant an abortController to verify rest aborts.
    const restingSession = mod.sessions.get('rest-1')
    const ac = new AbortController()
    restingSession.streaming = true
    restingSession.abortController = ac

    restEvents.length = 0
    const restReply = await dispatch({ jsonrpc: '2.0', id: 432, method: 'claude.restSession',
      params: { sessionId: 'rest-1' } })
    assert.equal(restReply.result, true)
    assert.equal(restingSession.isResting, true)
    assert.equal(restingSession.streaming, false, 'rest must clear streaming flag')
    // abortController stays referenced (signal kept aborted) so a
    // pending sendMessage's catch can still read .aborted to emit
    // turn-end with reason:'aborted' instead of 'error'. The next
    // ensureLiveQuery overwrites the field on rebuild.
    assert.equal(ac.signal.aborted, true, 'rest must abort the in-flight signal')
    assert.equal(restingSession.liveQuery, null, 'rest must close liveQuery')
    // Emitted exactly one system message hint.
    const sysMsgEvents = restEvents.filter(e => e.method === 'claude:message'
      && e.payload?.message?.role === 'system')
    assert.equal(sysMsgEvents.length, 1, 'rest emits one system hint message')
    assert.match(sysMsgEvents[0].payload.message.content, /resting/i)

    // isResting now true.
    const during = await dispatch({ jsonrpc: '2.0', id: 433, method: 'claude.isResting',
      params: { sessionId: 'rest-1' } })
    assert.equal(during.result, true)

    // wakeSession clears the flag.
    const wakeReply = await dispatch({ jsonrpc: '2.0', id: 434, method: 'claude.wakeSession',
      params: { sessionId: 'rest-1' } })
    assert.equal(wakeReply.result, true)
    assert.equal(restingSession.isResting, false)
    const after = await dispatch({ jsonrpc: '2.0', id: 435, method: 'claude.isResting',
      params: { sessionId: 'rest-1' } })
    assert.equal(after.result, false)

    // sendMessage also auto-wakes a resting session (mirror of Electron
    // line 581-582 — incoming user input always wakes).
    restingSession.isResting = true
    // SDK is still installed; use a fake that yields a complete turn so
    // sendMessage doesn't hang, but we don't care about the response —
    // only the isResting flip is under test.
    __setSdkOverrideForTests({
      query() {
        return (async function*() {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-rest-x', cwd: '/r', model: null, permissionMode: 'default' }
          yield { type: 'result', subtype: 'success', session_id: 'sdk-rest-x', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
        })()
      },
    })
    await dispatch({ jsonrpc: '2.0', id: 436, method: 'claude.sendMessage',
      params: { sessionId: 'rest-1', prompt: 'wake up' } })
    assert.equal(restingSession.isResting, false, 'sendMessage auto-wakes')

    // Defensive: missing/unknown sessionId returns false on all three.
    const noSidRest = await dispatch({ jsonrpc: '2.0', id: 437, method: 'claude.restSession',
      params: {} })
    assert.equal(noSidRest.result, false)
    const noSidWake = await dispatch({ jsonrpc: '2.0', id: 438, method: 'claude.wakeSession',
      params: {} })
    assert.equal(noSidWake.result, false)
    const noSidIsResting = await dispatch({ jsonrpc: '2.0', id: 439, method: 'claude.isResting',
      params: {} })
    assert.equal(noSidIsResting.result, false)
    const unknownRest = await dispatch({ jsonrpc: '2.0', id: 440, method: 'claude.restSession',
      params: { sessionId: 'never-started' } })
    assert.equal(unknownRest.result, false)
    const unknownIsResting = await dispatch({ jsonrpc: '2.0', id: 441, method: 'claude.isResting',
      params: { sessionId: 'never-started' } })
    assert.equal(unknownIsResting.result, false)
  } finally {
    __setSdkOverrideForTests(undefined)
    mod.__setProjectsDirOverrideForTests(null)
    rmSync(restProjectsDir, { recursive: true, force: true })
    restoreRestSend()
  }

  // claude.archiveMessages / loadArchived / clearArchive — pure fs
  // round-trip under a tmpdir BAT_SIDECAR_DATA_DIR override. Drives a
  // 5-message archive, loads with offset/limit pages from the tail
  // (mirror Electron's tail-pagination contract), clears, and verifies
  // the file is gone.
  const archiveDataDir = mkdtempSync(join(tmpdir(), 'sidecar-archive-'))
  const savedDataDirArchive = process.env.BAT_SIDECAR_DATA_DIR
  process.env.BAT_SIDECAR_DATA_DIR = archiveDataDir
  try {
    // Empty archive (no file yet) → empty page.
    const empty = await dispatch({ jsonrpc: '2.0', id: 450, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 0, limit: 10 } })
    assert.deepEqual(empty.result, { messages: [], total: 0, hasMore: false })

    // Archive 5 messages.
    const msgs = [
      { id: 'm1', role: 'user', content: 'first' },
      { id: 'm2', role: 'assistant', content: 'reply 1' },
      { id: 'm3', role: 'user', content: 'second' },
      { id: 'm4', role: 'assistant', content: 'reply 2' },
      { id: 'm5', role: 'user', content: 'third' },
    ]
    const archived = await dispatch({ jsonrpc: '2.0', id: 451, method: 'claude.archiveMessages',
      params: { sessionId: 'arch-1', messages: msgs } })
    assert.equal(archived.result, true)

    // Tail page: offset=0, limit=2 → last 2 messages [m4, m5]; hasMore true.
    const tail2 = await dispatch({ jsonrpc: '2.0', id: 452, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 0, limit: 2 } })
    assert.equal(tail2.result.total, 5)
    assert.equal(tail2.result.hasMore, true)
    assert.equal(tail2.result.messages.length, 2)
    assert.equal(tail2.result.messages[0].id, 'm4')
    assert.equal(tail2.result.messages[1].id, 'm5')

    // Page back: offset=2 (skip last 2), limit=2 → [m2, m3]; hasMore true.
    const tail22 = await dispatch({ jsonrpc: '2.0', id: 453, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 2, limit: 2 } })
    assert.equal(tail22.result.messages.length, 2)
    assert.equal(tail22.result.messages[0].id, 'm2')
    assert.equal(tail22.result.messages[1].id, 'm3')
    assert.equal(tail22.result.hasMore, true)

    // Beyond start: offset=4, limit=10 → [m1] only; hasMore false.
    const tailEnd = await dispatch({ jsonrpc: '2.0', id: 454, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 4, limit: 10 } })
    assert.equal(tailEnd.result.messages.length, 1)
    assert.equal(tailEnd.result.messages[0].id, 'm1')
    assert.equal(tailEnd.result.hasMore, false)

    // Past total: offset=999 → empty + hasMore:false (graceful).
    const past = await dispatch({ jsonrpc: '2.0', id: 455, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 999, limit: 10 } })
    assert.deepEqual(past.result, { messages: [], total: 5, hasMore: false })

    // Append more — archive should grow not overwrite.
    await dispatch({ jsonrpc: '2.0', id: 456, method: 'claude.archiveMessages',
      params: { sessionId: 'arch-1', messages: [{ id: 'm6', role: 'user', content: 'fourth' }] } })
    const grown = await dispatch({ jsonrpc: '2.0', id: 457, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 0, limit: 1 } })
    assert.equal(grown.result.total, 6)
    assert.equal(grown.result.messages[0].id, 'm6')

    // clearArchive removes the file → next load returns empty page.
    const cleared = await dispatch({ jsonrpc: '2.0', id: 458, method: 'claude.clearArchive',
      params: { sessionId: 'arch-1' } })
    assert.equal(cleared.result, true)
    const afterClear = await dispatch({ jsonrpc: '2.0', id: 459, method: 'claude.loadArchived',
      params: { sessionId: 'arch-1', offset: 0, limit: 10 } })
    assert.deepEqual(afterClear.result, { messages: [], total: 0, hasMore: false })
    // clearArchive on a non-existent file is still ok.
    const clearAgain = await dispatch({ jsonrpc: '2.0', id: 460, method: 'claude.clearArchive',
      params: { sessionId: 'arch-never' } })
    assert.equal(clearAgain.result, true)

    // Defensive: missing/invalid params return false / empty page.
    const noSidArch = await dispatch({ jsonrpc: '2.0', id: 461, method: 'claude.archiveMessages',
      params: { messages: [] } })
    assert.equal(noSidArch.result, false)
    const noMsgsArch = await dispatch({ jsonrpc: '2.0', id: 462, method: 'claude.archiveMessages',
      params: { sessionId: 'x' } })
    assert.equal(noMsgsArch.result, false)
    const noSidLoad = await dispatch({ jsonrpc: '2.0', id: 463, method: 'claude.loadArchived',
      params: { offset: 0, limit: 10 } })
    assert.deepEqual(noSidLoad.result, { messages: [], total: 0, hasMore: false })
    const noSidClear = await dispatch({ jsonrpc: '2.0', id: 464, method: 'claude.clearArchive',
      params: {} })
    assert.equal(noSidClear.result, false)

    // sessionId path-escape attempt — sanitised to underscores so the
    // archive file lives inside message-archives/ regardless. We just
    // check it doesn't throw and round-trips under the sanitized name.
    await dispatch({ jsonrpc: '2.0', id: 465, method: 'claude.archiveMessages',
      params: { sessionId: '../../etc/passwd', messages: [{ id: 'evil' }] } })
    const escaped = await dispatch({ jsonrpc: '2.0', id: 466, method: 'claude.loadArchived',
      params: { sessionId: '../../etc/passwd', offset: 0, limit: 10 } })
    assert.equal(escaped.result.total, 1, 'sanitized path round-trips')
  } finally {
    rmSync(archiveDataDir, { recursive: true, force: true })
    if (savedDataDirArchive === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
    else process.env.BAT_SIDECAR_DATA_DIR = savedDataDirArchive
  }

  // Parity test: queryOptions must include the same keys Electron sets.
  // Without these, the sidecar session loses the claude_code system
  // prompt + tool preset → no Bash/Read/Edit etc. Capture the raw
  // options by intercepting query() and assert each parity key is set.
  const parityCaptured = []
  const restoreParitySend = mod.__setSendEventForTests(() => {})
  const fakeSdkParity = {
    query({ prompt, options }) {
      parityCaptured.push({ prompt, options })
      // Yield a minimal valid stream so handler exits cleanly.
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'p-sdk', cwd: '/p', model: 'claude-opus-4-7', permissionMode: 'default' },
        { type: 'result', subtype: 'success', session_id: 'p-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkParity)
  try {
    // Use an Opus 4.7 auto-compact preset so we exercise the
    // sdkModelForClaudeSelection mapping (preset → base id) plus the
    // CLAUDE_CODE_AUTO_COMPACT_WINDOW env hookup.
    await dispatch({ jsonrpc: '2.0', id: 230, method: 'claude.startSession',
      params: { sessionId: 'parity-1', options: {
        cwd: '/p',
        model: 'claude-opus-4-7:auto-compact-200k',
        autoCompactWindow: 200000,
        permissionMode: 'bypassPermissions',
        effort: 'xhigh',
        ultracode: true,
      } } })
    await dispatch({ jsonrpc: '2.0', id: 231, method: 'claude.sendMessage',
      params: { sessionId: 'parity-1', prompt: 'hello' } })
    assert.equal(parityCaptured.length, 1, 'expected exactly one query() call')
    const opts = parityCaptured[0].options
    // claude_code preset (system prompt + tools) — without these the
    // session has no built-in tools.
    assert.deepEqual(opts.systemPrompt, { type: 'preset', preset: 'claude_code' })
    assert.deepEqual(opts.tools, { type: 'preset', preset: 'claude_code' })
    // Streaming + setting + agent UX flags.
    assert.equal(opts.includePartialMessages, true)
    assert.equal(opts.promptSuggestions, true)
    assert.deepEqual(opts.settingSources, ['user', 'project', 'local'])
    assert.equal(opts.agentProgressSummaries, true)
    assert.deepEqual(opts.toolConfig, { askUserQuestion: { previewFormat: 'html' } })
    // Effort + permission + bypass mapping. ultracode runs at the CLI's top
    // effort level 'max' (the legacy 'xhigh' value was dropped in Claude Code
    // CLI >= 2.1.175 and is aliased to 'max').
    assert.equal(opts.effort, 'max')
    assert.deepEqual(opts.settings, { ultracode: true, enableWorkflows: true })
    assert.equal(opts.permissionMode, 'bypassPermissions')
    assert.equal(opts.allowDangerouslySkipPermissions, true)
    // sdkModelForClaudeSelection maps the preset to the base id, keeping the
    // `[1m]` suffix that is what actually buys the 1M window.
    assert.equal(opts.model, 'claude-opus-4-7[1m]')
    // autoCompactWindow → CLAUDE_CODE_AUTO_COMPACT_WINDOW env passthrough.
    assert.ok(opts.env, 'expected env on queryOptions when autoCompactWindow is set')
    assert.equal(opts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000')
    // abortController must be set so abort propagates.
    assert.ok(opts.abortController, 'expected abortController on queryOptions')

    // Second turn with empty prompt must enable continue + carry resume.
    await dispatch({ jsonrpc: '2.0', id: 232, method: 'claude.sendMessage',
      params: { sessionId: 'parity-1', prompt: '' } })
    const opts2 = parityCaptured[1].options
    assert.equal(opts2.resume, 'p-sdk', 'resume should carry sdkSessionId from prior turn')
    assert.equal(opts2.continue, true, 'continue:true expected when resuming with empty prompt')

    // bypassPlan must map to plan (SDK does not understand bypassPlan).
    mod.sessions.get('parity-1').permissionMode = 'bypassPlan'
    await dispatch({ jsonrpc: '2.0', id: 233, method: 'claude.sendMessage',
      params: { sessionId: 'parity-1', prompt: 'plan it' } })
    const opts3 = parityCaptured[2].options
    assert.equal(opts3.permissionMode, 'plan', 'bypassPlan -> plan mapping')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreParitySend()
  }

  // Image attachment must produce a single SDKUserMessage with
  // image+text content blocks, delivered through the streaming-input
  // prompt iterable so the SDK's CLI subprocess sees it. The fake SDK
  // here drains the iterable (mirroring real SDK behaviour) and
  // captures the user message for shape validation.
  const imageCaptured = []
  const restoreImageSend = mod.__setSendEventForTests(() => {})
  const fakeSdkImage = {
    query({ prompt, options }) {
      const cap = { prompt, options, userMessages: [] }
      imageCaptured.push(cap)
      const userIter = prompt[Symbol.asyncIterator]()
      return (async function*() {
        // Pull one user message (matches our single push per send).
        const next = await userIter.next()
        if (!next.done) cap.userMessages.push(next.value)
        yield { type: 'system', subtype: 'init', session_id: 'img-sdk', cwd: '/i', model: 'claude-sonnet-4-6', permissionMode: 'default' }
        yield { type: 'result', subtype: 'success', session_id: 'img-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkImage)
  try {
    await dispatch({ jsonrpc: '2.0', id: 240, method: 'claude.startSession',
      params: { sessionId: 'img-1', options: { cwd: '/i', model: 'claude-sonnet-4-6' } } })
    // 1×1 transparent PNG.
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    await dispatch({ jsonrpc: '2.0', id: 241, method: 'claude.sendMessage',
      params: { sessionId: 'img-1', prompt: 'describe this', images: [tinyPng] } })
    assert.equal(imageCaptured.length, 1, 'sdk.query must run once for the first send')
    const promptArg = imageCaptured[0].prompt
    assert.equal(typeof promptArg, 'object', 'streaming-input mode passes an iterable for prompt')
    assert.equal(typeof promptArg[Symbol.asyncIterator], 'function', 'expected async iterable prompt')
    // The fake SDK drained the first user message — its shape must be
    // image-then-text content blocks.
    assert.equal(imageCaptured[0].userMessages.length, 1)
    const userMsg = imageCaptured[0].userMessages[0]
    assert.equal(userMsg.type, 'user')
    assert.equal(userMsg.message.role, 'user')
    assert.equal(userMsg.message.content.length, 2)
    assert.equal(userMsg.message.content[0].type, 'image')
    assert.equal(userMsg.message.content[0].source.media_type, 'image/png')
    assert.equal(userMsg.message.content[1].type, 'text')
    assert.equal(userMsg.message.content[1].text, 'describe this')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreImageSend()
  }

  // canUseTool round-trip. Fake SDK calls the canUseTool callback with
  // a Bash tool; sidecar must surface a claude:permission-request event
  // and then resolve the SDK's promise when claude.resolvePermission
  // arrives from the renderer. This is the wire that lets the Tauri
  // permission UI actually approve / deny tool calls.
  const permCaptured = []
  const restorePermSend = mod.__setSendEventForTests((name, payload) => permCaptured.push({ name, payload }))
  let canUseToolFn = null
  const fakeSdkPerm = {
    query({ options }) {
      canUseToolFn = options.canUseTool
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'perm-sdk' }
        // We yield, then the test triggers canUseTool out-of-band.
        // We need the message stream to "wait" for the resolution
        // before yielding the result so the test ordering is stable.
        await new Promise(r => setTimeout(r, 50))
        yield { type: 'result', subtype: 'success', session_id: 'perm-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkPerm)
  try {
    await dispatch({ jsonrpc: '2.0', id: 260, method: 'claude.startSession',
      params: { sessionId: 'perm-1', options: { cwd: '/p' } } })
    // Kick off sendMessage but do not await — we'll trigger canUseTool
    // mid-stream via the captured callback ref.
    const sendPromise = dispatch({ jsonrpc: '2.0', id: 261, method: 'claude.sendMessage',
      params: { sessionId: 'perm-1', prompt: 'run a tool' } })
    // Wait for the sendMessage handler to enter the for-await loop and
    // canUseTool to be wired up.
    await new Promise(r => setTimeout(r, 10))
    assert.ok(canUseToolFn, 'expected canUseTool to be set on queryOptions')
    // Drive a Bash request through canUseTool.
    const cuPromise = canUseToolFn('Bash', { command: 'ls' }, { toolUseID: 'tool-bash-1', suggestions: [], decisionReason: 'why?' })
    // Wait long enough for the permission-request event to be emitted.
    await new Promise(r => setTimeout(r, 5))
    const permEvents = permCaptured.filter(e => e.name === 'claude:permission-request')
    assert.equal(permEvents.length, 1)
    assert.equal(permEvents[0].payload.sessionId, 'perm-1')
    assert.equal(permEvents[0].payload.data.toolUseId, 'tool-bash-1')
    assert.equal(permEvents[0].payload.data.toolName, 'Bash')
    assert.deepEqual(permEvents[0].payload.data.input, { command: 'ls' })
    // Renderer answers via claude.resolvePermission.
    const resolveReply = await dispatch({ jsonrpc: '2.0', id: 262, method: 'claude.resolvePermission',
      params: { sessionId: 'perm-1', toolUseId: 'tool-bash-1', result: { behavior: 'allow', updatedInput: { command: 'ls' } } } })
    assert.equal(resolveReply.result, true)
    const decision = await cuPromise
    assert.equal(decision.behavior, 'allow')
    assert.deepEqual(decision.updatedInput, { command: 'ls' })
    // claude:permission-resolved event must have fired.
    const resolvedEvents = permCaptured.filter(e => e.name === 'claude:permission-resolved')
    assert.equal(resolvedEvents.length, 1)
    assert.equal(resolvedEvents[0].payload.toolUseId, 'tool-bash-1')
    // Drain sendMessage.
    await sendPromise
  } finally {
    __setSdkOverrideForTests(undefined)
    restorePermSend()
    canUseToolFn = null
  }

  // bypassPermissions auto-allows without surfacing UI.
  const bypassCaptured = []
  const restoreBypassSend = mod.__setSendEventForTests((name, payload) => bypassCaptured.push({ name, payload }))
  let bypassCanUse = null
  const fakeSdkBypass = {
    query({ options }) {
      bypassCanUse = options.canUseTool
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'bp-sdk' }
        yield { type: 'result', subtype: 'success', session_id: 'bp-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkBypass)
  try {
    await dispatch({ jsonrpc: '2.0', id: 270, method: 'claude.startSession',
      params: { sessionId: 'bp-1', options: { cwd: '/p', permissionMode: 'bypassPermissions' } } })
    await dispatch({ jsonrpc: '2.0', id: 271, method: 'claude.sendMessage',
      params: { sessionId: 'bp-1', prompt: 'go' } })
    assert.ok(bypassCanUse)
    const decision = bypassCanUse('Bash', { command: 'rm -rf /' }, { toolUseID: 'bp-tool' })
    // Synchronous decision — not a Promise (or resolves immediately).
    const result = await Promise.resolve(decision)
    assert.equal(result.behavior, 'allow')
    // No permission-request event fired.
    const permEvents = bypassCaptured.filter(e => e.name === 'claude:permission-request')
    assert.equal(permEvents.length, 0, 'bypassPermissions must not emit permission-request')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreBypassSend()
    bypassCanUse = null
  }

  // GH #124: the two modes BAT did not previously understand.
  //
  // dontAsk means "never prompt, deny anything not pre-approved". Everything
  // reaching canUseTool is by definition not pre-approved — the CLI answers from
  // its own rules first and only calls back for what it could not decide — so the
  // answer is no. Falling through to the prompt would turn "don't ask me" into a
  // stream of questions, which is the one thing the mode exists to prevent.
  //
  // auto is the opposite trap: its classifier runs inside Claude Code, ahead of
  // this callback, and only escalates what it will not decide alone. Those
  // escalations are precisely the prompts a human should see, so auto must keep
  // surfacing UI. Auto-allowing here would delete the safety net that is the
  // whole reason to pick auto over bypassPermissions.
  for (const [mode, sessionId, sdkId, expectPrompt] of [
    ['dontAsk', 'da-1', 'da-sdk', false],
    ['auto', 'au-1', 'au-sdk', true],
  ]) {
    const captured = []
    const restoreSend = mod.__setSendEventForTests((name, payload) => captured.push({ name, payload }))
    let canUse = null
    __setSdkOverrideForTests({
      query({ options }) {
        canUse = options.canUseTool
        // The mode must reach the CLI unmangled; only bypassPlan is rewritten.
        assert.equal(options.permissionMode, mode, `${mode} must be passed through to the SDK`)
        return (async function*() {
          yield { type: 'system', subtype: 'init', session_id: sdkId, permissionMode: mode }
          yield { type: 'result', subtype: 'success', session_id: sdkId, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
        })()
      },
    })
    try {
      await dispatch({ jsonrpc: '2.0', id: 274, method: 'claude.startSession',
        params: { sessionId, options: { cwd: '/p', permissionMode: mode } } })
      await dispatch({ jsonrpc: '2.0', id: 275, method: 'claude.sendMessage',
        params: { sessionId, prompt: 'go' } })
      assert.ok(canUse, `${mode} must still install a canUseTool callback`)
      const pending = canUse('Bash', { command: 'rm -rf /' }, { toolUseID: `${sessionId}-tool` })
      await new Promise(r => setTimeout(r, 5))
      const permEvents = captured.filter(e => e.name === 'claude:permission-request')
      if (expectPrompt) {
        assert.equal(permEvents.length, 1, 'auto must still surface the prompts its classifier escalates')
        await dispatch({ jsonrpc: '2.0', id: 276, method: 'claude.resolvePermission',
          params: { sessionId, toolUseId: `${sessionId}-tool`, result: { behavior: 'deny', message: 'no' } } })
        await pending
      } else {
        assert.equal(permEvents.length, 0, 'dontAsk must not emit permission-request')
        const decision = await Promise.resolve(pending)
        assert.equal(decision.behavior, 'deny')
        // message is required on a deny result, not optional.
        assert.equal(typeof decision.message, 'string')
        assert.ok(decision.message.includes('Bash'), 'the denial should name the tool it refused')
      }
    } finally {
      __setSdkOverrideForTests(undefined)
      restoreSend()
      mod.sessions.delete(sessionId)
    }
  }

  // The CLI's init frame echoes the mode it adopted, and we take its word for
  // it — that is how a mode the installed CLI does not support degrades
  // gracefully instead of lying on the button. But bypassPlan is sidecar-only
  // and goes out as plain 'plan', so the echo comes back different from what we
  // hold every single time. Adopting it verbatim demoted "Plan (auto-approve)"
  // to "Plan mode" on the first turn — and now that the mode is persisted, that
  // demotion would outlive the session instead of dying with it.
  {
    const restoreSend = mod.__setSendEventForTests(() => {})
    let planCanUse = null
    let sentMode = null
    __setSdkOverrideForTests({
      query({ options }) {
        planCanUse = options.canUseTool
        sentMode = options.permissionMode
        return (async function*() {
          // The CLI knows nothing of bypassPlan; it reports the plan it was given.
          yield { type: 'system', subtype: 'init', session_id: 'bpl-sdk', permissionMode: 'plan' }
          yield { type: 'result', subtype: 'success', session_id: 'bpl-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
        })()
      },
    })
    try {
      await dispatch({ jsonrpc: '2.0', id: 277, method: 'claude.startSession',
        params: { sessionId: 'bpl-1', options: { cwd: '/p', permissionMode: 'bypassPlan' } } })
      await dispatch({ jsonrpc: '2.0', id: 278, method: 'claude.sendMessage',
        params: { sessionId: 'bpl-1', prompt: 'go' } })
      await settleTurn(mod.sessions.get('bpl-1'))
      assert.equal(sentMode, 'plan', 'bypassPlan is sidecar-only and must reach the SDK as plain plan')
      assert.equal(mod.sessions.get('bpl-1').permissionMode, 'bypassPlan',
        'the CLI echoing back the mode we sent is agreement, not a downgrade')
      // The behaviour, not just the label: bypassPlan auto-approves everything
      // except ExitPlanMode. Under plain plan this would surface a prompt.
      const decision = await Promise.resolve(planCanUse('Bash', { command: 'ls' }, { toolUseID: 'bpl-tool' }))
      assert.equal(decision.behavior, 'allow', 'bypassPlan must still auto-approve after the init echo')
    } finally {
      __setSdkOverrideForTests(undefined)
      restoreSend()
      mod.sessions.delete('bpl-1')
    }
  }

  // A real disagreement is still adopted — that is the whole point of listening
  // to the echo. Here the CLI refuses dontAsk and runs the session as default.
  {
    const restoreSend = mod.__setSendEventForTests(() => {})
    __setSdkOverrideForTests({
      query() {
        return (async function*() {
          yield { type: 'system', subtype: 'init', session_id: 'dg-sdk', permissionMode: 'default' }
          yield { type: 'result', subtype: 'success', session_id: 'dg-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
        })()
      },
    })
    try {
      await dispatch({ jsonrpc: '2.0', id: 279, method: 'claude.startSession',
        params: { sessionId: 'dg-1', options: { cwd: '/p', permissionMode: 'dontAsk' } } })
      await dispatch({ jsonrpc: '2.0', id: 280, method: 'claude.sendMessage',
        params: { sessionId: 'dg-1', prompt: 'go' } })
      await settleTurn(mod.sessions.get('dg-1'))
      assert.equal(mod.sessions.get('dg-1').permissionMode, 'default',
        'a mode the CLI genuinely would not honour must be adopted, so the button stops '
        + 'claiming something that is not in force')
    } finally {
      __setSdkOverrideForTests(undefined)
      restoreSend()
      mod.sessions.delete('dg-1')
    }
  }

  // acceptEdits auto-allows file/read tools but still prompts for Bash.
  const acceptCaptured = []
  const restoreAcceptSend = mod.__setSendEventForTests((name, payload) => acceptCaptured.push({ name, payload }))
  let acceptCanUse = null
  const fakeSdkAccept = {
    query({ options }) {
      acceptCanUse = options.canUseTool
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'ae-sdk' }
        yield { type: 'result', subtype: 'success', session_id: 'ae-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkAccept)
  try {
    await dispatch({ jsonrpc: '2.0', id: 280, method: 'claude.startSession',
      params: { sessionId: 'ae-1', options: { cwd: '/p', permissionMode: 'acceptEdits' } } })
    await dispatch({ jsonrpc: '2.0', id: 281, method: 'claude.sendMessage',
      params: { sessionId: 'ae-1', prompt: 'go' } })
    assert.ok(acceptCanUse)
    const editDecision = await Promise.resolve(acceptCanUse('Edit', { path: '/x', diff: '...' }, { toolUseID: 'ae-edit' }))
    assert.equal(editDecision.behavior, 'allow', 'Edit must auto-allow in acceptEdits')
    // Bash still prompts.
    const bashPromise = acceptCanUse('Bash', { command: 'ls' }, { toolUseID: 'ae-bash' })
    await new Promise(r => setTimeout(r, 5))
    const permEvents = acceptCaptured.filter(e => e.name === 'claude:permission-request')
    assert.equal(permEvents.length, 1, 'acceptEdits Bash must prompt')
    // Resolve so the promise settles cleanly.
    await dispatch({ jsonrpc: '2.0', id: 282, method: 'claude.resolvePermission',
      params: { sessionId: 'ae-1', toolUseId: 'ae-bash', result: { behavior: 'deny', message: 'no' } } })
    const bashResult = await bashPromise
    assert.equal(bashResult.behavior, 'deny')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreAcceptSend()
    acceptCanUse = null
  }

  // AskUserQuestion: sidecar emits claude:ask-user, renderer answers via
  // claude.resolveAskUser, and the SDK promise resolves to the answers.
  const askCaptured = []
  const restoreAskSend = mod.__setSendEventForTests((name, payload) => askCaptured.push({ name, payload }))
  let askCanUse = null
  const fakeSdkAsk = {
    query({ options }) {
      askCanUse = options.canUseTool
      return (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'ask-sdk' }
        yield { type: 'result', subtype: 'success', session_id: 'ask-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(fakeSdkAsk)
  try {
    await dispatch({ jsonrpc: '2.0', id: 290, method: 'claude.startSession',
      params: { sessionId: 'ask-1', options: { cwd: '/p' } } })
    await dispatch({ jsonrpc: '2.0', id: 291, method: 'claude.sendMessage',
      params: { sessionId: 'ask-1', prompt: 'q' } })
    assert.ok(askCanUse)
    const askPromise = askCanUse('AskUserQuestion', { questions: [{ id: 'q1', text: 'pick' }] }, { toolUseID: 'ask-tool' })
    await new Promise(r => setTimeout(r, 5))
    const askEvents = askCaptured.filter(e => e.name === 'claude:ask-user')
    assert.equal(askEvents.length, 1)
    assert.equal(askEvents[0].payload.data.toolUseId, 'ask-tool')
    assert.deepEqual(askEvents[0].payload.data.questions, [{ id: 'q1', text: 'pick' }])
    await dispatch({ jsonrpc: '2.0', id: 292, method: 'claude.resolveAskUser',
      params: { sessionId: 'ask-1', toolUseId: 'ask-tool', answers: { q1: 'option-A' } } })
    // AskUserQuestion resolves the canUseTool promise with a PermissionResult
    // (behavior 'allow' + updatedInput preserving the questions plus answers),
    // not the bare answers map — the SDK validates this shape.
    const askResult = await askPromise
    assert.deepEqual(askResult, {
      behavior: 'allow',
      updatedInput: { questions: [{ id: 'q1', text: 'pick' }], answers: { q1: 'option-A' } },
    })
    const resolved = askCaptured.filter(e => e.name === 'claude:ask-user-resolved')
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].payload.toolUseId, 'ask-tool')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreAskSend()
    askCanUse = null
  }

  // Plugin loading: when ~/.claude/plugins/installed_plugins.json
  // exists with valid entries, queryOptions.plugins is set to
  // [{ type: 'local', path }] for each installPath.
  const { __setPluginsPathOverrideForTests, loadInstalledPlugins } = mod
  // Empty / missing file -> empty array (graceful).
  const tmpRoot = mkdtempSync(join(tmpdir(), 'sidecar-plugins-'))
  try {
    const missingPath = join(tmpRoot, 'does-not-exist.json')
    __setPluginsPathOverrideForTests(missingPath)
    const empty = await loadInstalledPlugins()
    assert.deepEqual(empty, [], 'missing file -> []')

    // Malformed JSON -> empty.
    const badPath = join(tmpRoot, 'bad.json')
    writeFileSync(badPath, '{ not valid json')
    __setPluginsPathOverrideForTests(badPath)
    const malformed = await loadInstalledPlugins()
    assert.deepEqual(malformed, [], 'malformed json -> []')

    // Real shape: pluginsData.plugins is an object whose values are
    // arrays of {installPath} entries. Mirrors the on-disk format
    // Claude CLI writes when running `/plugin install`.
    const goodPath = join(tmpRoot, 'good.json')
    writeFileSync(goodPath, JSON.stringify({
      plugins: {
        'official': [
          { installPath: '/home/u/.claude/plugins/official/some-plugin' },
          { installPath: '/home/u/.claude/plugins/official/other-plugin' },
        ],
        'community': [
          { installPath: '/home/u/.claude/plugins/community/extra' },
        ],
        'malformed': [
          { /* no installPath */ },
          'string-not-object',
          null,
        ],
      },
    }))
    __setPluginsPathOverrideForTests(goodPath)
    const loaded = await loadInstalledPlugins()
    assert.equal(loaded.length, 3, 'expected 3 plugins (malformed entries skipped)')
    for (const p of loaded) {
      assert.equal(p.type, 'local')
      assert.match(p.path, /^\/home\/u\/\.claude\/plugins\//)
    }

    // Now verify sendMessage actually wires the plugins into queryOptions.
    const pluginCaptured = []
    const restoreSend = mod.__setSendEventForTests(() => {})
    const fakeSdkPlugin = {
      query({ options }) {
        pluginCaptured.push({ options })
        const messages = [
          { type: 'system', subtype: 'init', session_id: 'pl-sdk', cwd: '/p' },
          { type: 'result', subtype: 'success', session_id: 'pl-sdk', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
        ]
        return (async function*() { for (const m of messages) yield m })()
      },
    }
    __setSdkOverrideForTests(fakeSdkPlugin)
    try {
      await dispatch({ jsonrpc: '2.0', id: 250, method: 'claude.startSession',
        params: { sessionId: 'pl-1', options: { cwd: '/p' } } })
      await dispatch({ jsonrpc: '2.0', id: 251, method: 'claude.sendMessage',
        params: { sessionId: 'pl-1', prompt: 'hi' } })
      assert.equal(pluginCaptured.length, 1)
      const opts = pluginCaptured[0].options
      assert.ok(Array.isArray(opts.plugins), 'expected plugins on queryOptions')
      assert.equal(opts.plugins.length, 3)
      assert.equal(opts.plugins[0].type, 'local')

      // No plugins file -> queryOptions.plugins absent (not [] — Electron
      // spreads conditionally).
      __setPluginsPathOverrideForTests(missingPath)
      await dispatch({ jsonrpc: '2.0', id: 252, method: 'claude.sendMessage',
        params: { sessionId: 'pl-1', prompt: 'again' } })
      assert.equal(pluginCaptured.length, 2)
      assert.equal(pluginCaptured[1].options.plugins, undefined,
        'plugins option must be absent when no plugins are installed')
    } finally {
      __setSdkOverrideForTests(undefined)
      restoreSend()
    }
  } finally {
    __setPluginsPathOverrideForTests(null)
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  // Regression: __normalizeMainPath must equate a Windows verbatim-
  // prefixed path with its non-prefixed sibling. Tauri's resource_dir()
  // returns `\\?\C:\...`-style paths on Windows, and a previous version
  // of the isMain check naively compared `file://<argv[1]>` against
  // import.meta.url — that comparison failed for verbatim paths, so
  // main() never ran and the sidecar exited immediately on every spawn,
  // surfacing as Win32 ERROR_NO_DATA (232) on the parent's stdin pipe.
  const { __normalizeMainPath } = mod
  if (process.platform === 'win32') {
    const verbatim = '\\\\?\\C:\\foo\\BAR\\server.mjs'
    const normal = 'C:\\foo\\BAR\\server.mjs'
    assert.equal(__normalizeMainPath(verbatim), __normalizeMainPath(normal),
      'verbatim and non-verbatim Windows paths must normalize equal')
    // Case-insensitive (Windows fs is).
    assert.equal(__normalizeMainPath('C:\\Foo\\Bar.mjs'), __normalizeMainPath('c:\\foo\\bar.mjs'))
  }
  assert.equal(__normalizeMainPath(''), '')
  assert.equal(__normalizeMainPath(null), '')

  // Helpers (sdkModelForClaudeSelection + dataUrlToContentBlock) sanity.
  const { sdkModelForClaudeSelection, dataUrlToContentBlock } = mod
  assert.equal(sdkModelForClaudeSelection(undefined), undefined)
  // Every 1M model has to keep the `[1m]` suffix: Claude Code reads the window
  // off it and strips it before the request goes out, so a bare id runs at
  // 200K and puts a 300K compact target above the window it must fire below.
  assert.equal(sdkModelForClaudeSelection('claude-sonnet-4-6'), 'claude-sonnet-4-6[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-opus-5:auto-compact-200k'), 'claude-opus-5[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-opus-5:auto-compact-300k'), 'claude-opus-5[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-opus-5:1m'), 'claude-opus-5[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-opus-4-8:auto-compact-200k'), 'claude-opus-4-8[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-opus-4-8:auto-compact-300k'), 'claude-opus-4-8[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-opus-4-8:1m'), 'claude-opus-4-8[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-opus-4-7:auto-compact-200k'), 'claude-opus-4-7[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-opus-4-7:auto-compact-300k'), 'claude-opus-4-7[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-opus-4-7:1m'), 'claude-opus-4-7[1m]')
  // A model whose physical window really is 200K must not claim 1M.
  assert.equal(sdkModelForClaudeSelection('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001')
  // Already-suffixed ids (the form the SDK itself emits) must not double up.
  assert.equal(sdkModelForClaudeSelection('claude-opus-5[1m]'), 'claude-opus-5[1m]')
  // Past the table the preset id is the only evidence of the window, so a
  // target above 200K implies a 1M model and 200K or below cannot say.
  assert.equal(sdkModelForClaudeSelection('claude-zeta-1:1m'), 'claude-zeta-1[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-zeta-1:auto-compact-300k'), 'claude-zeta-1[1m]')
  assert.equal(sdkModelForClaudeSelection('claude-zeta-1:auto-compact-200k'), 'claude-zeta-1')
  assert.equal(sdkModelForClaudeSelection('claude-zeta-1'), 'claude-zeta-1')
  assert.equal(dataUrlToContentBlock('not a data url'), null)
  assert.equal(dataUrlToContentBlock(''), null)
  const block = dataUrlToContentBlock('data:image/png;base64,iVBORw0KGgo=')
  assert.equal(block?.type, 'image')
  assert.equal(block?.source.media_type, 'image/png')
  assert.equal(block?.source.data, 'iVBORw0KGgo=')

  // Drift guard: sidecar CLAUDE_MODEL_CONTEXT_WINDOWS must carry every base id
  // (physical window) AND every preset id (auto-compact budget). Note the two
  // don't line up with the renderer's own auto-compact map: `:1m` is null there
  // (no early compaction) but 1M here, because this is what we surface to
  // maxTokens. Reuses tsCtxMap / tsTable / tsPresetId parsed from TS earlier.
  const { CLAUDE_MODEL_CONTEXT_WINDOWS, expectedContextWindowForModel } = mod
  for (const [k, v] of tsCtxMap) {
    assert.equal(
      CLAUDE_MODEL_CONTEXT_WINDOWS.get(k), v,
      `sidecar CLAUDE_MODEL_CONTEXT_WINDOWS[${k}] (${CLAUDE_MODEL_CONTEXT_WINDOWS.get(k)}) drifted from TS (${v})`,
    )
  }
  // Every preset id must map to the budget its session actually runs against:
  // the auto-compact target, or the full window for the `:1m` presets.
  for (const def of tsTable) {
    for (const window of def.windows) {
      const presetId = tsPresetId(def, window)
      assert.equal(
        CLAUDE_MODEL_CONTEXT_WINDOWS.get(presetId), window ?? def.contextWindow,
        `sidecar CLAUDE_MODEL_CONTEXT_WINDOWS[${presetId}] (${CLAUDE_MODEL_CONTEXT_WINDOWS.get(presetId)}) drifted from TS (${window ?? def.contextWindow})`,
      )
    }
  }

  // Spot-check a few well-known values + expectedContextWindowForModel
  // base-id fallback semantics.
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-opus-5'), 1000000)
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-opus-4-8'), 1000000)
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-opus-4-7'), 1000000)
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-haiku-4-5-20251001'), 200000)
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-opus-4-7:auto-compact-200k'), 200000)
  assert.equal(CLAUDE_MODEL_CONTEXT_WINDOWS.get('claude-opus-4-7:1m'), 1000000)
  // expectedContextWindowForModel: hits map; falls back to base id by
  // stripping [1m]; returns null for unknown.
  assert.equal(expectedContextWindowForModel('claude-opus-5[1m]'), 1000000)
  assert.equal(expectedContextWindowForModel('claude-opus-4-8[1m]'), 1000000)
  assert.equal(expectedContextWindowForModel('claude-opus-4-7'), 1000000)
  assert.equal(expectedContextWindowForModel('claude-opus-4-7[1m]'), 1000000)
  assert.equal(expectedContextWindowForModel('claude-opus-4-6[1m]'), 1000000)
  assert.equal(expectedContextWindowForModel(undefined), null)
  assert.equal(expectedContextWindowForModel('totally-unknown-model'), null)

  // claude.getContextUsage: cached usage from the LAST API request.
  // Inject a fake SDK that streams a message_start with usage, then a result
  // whose usage is the query's running total, and verify the handler reports
  // the request footprint — not the lifetime sum.
  __setSdkOverrideForTests({
    query() {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'cu-sdk', cwd: '/x' },
        { type: 'stream_event', session_id: 'cu-sdk', parent_tool_use_id: null, event: { type: 'message_start', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 200, output_tokens: 0 } } } },
        { type: 'assistant', session_id: 'cu-sdk', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', session_id: 'cu-sdk', result: 'hi', stop_reason: 'end_turn',
          total_cost_usd: 0.0042, num_turns: 1,
          usage: { input_tokens: 150, cache_creation_input_tokens: 50, cache_read_input_tokens: 250, output_tokens: 30 } },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  })
  try {
    // Pre-turn: getContextUsage returns null (no usage cached yet).
    await dispatch({ jsonrpc: '2.0', id: 290, method: 'claude.startSession',
      params: { sessionId: 'cu-1', options: { cwd: '/x', model: 'claude-sonnet-4-6' } } })
    const preReply = await dispatch({ jsonrpc: '2.0', id: 291, method: 'claude.getContextUsage', params: { sessionId: 'cu-1' } })
    assert.equal(preReply.result, null)
    // Run a turn. SDKResultMessage.usage sums every API request of the query,
    // so it must NOT override the message_start footprint — a long session
    // otherwise reports millions of context tokens (statusline read "ctx 778%"
    // of a 300K window for a session actually sitting at ~77K).
    await dispatch({ jsonrpc: '2.0', id: 292, method: 'claude.sendMessage', params: { sessionId: 'cu-1', prompt: 'hi' } })
    await settleTurn(mod.sessions.get('cu-1'))
    const postReply = await dispatch({ jsonrpc: '2.0', id: 293, method: 'claude.getContextUsage', params: { sessionId: 'cu-1' } })
    const cu = postReply.result
    assert.ok(cu, 'expected non-null context usage after turn')
    assert.equal(cu.totalTokens, 100 + 50 + 200)  // last request: input + creation + read
    assert.equal(cu.maxTokens, 1000000)  // claude-sonnet-4-6 = 1M
    assert.equal(cu.percentage, Math.round((350 / 1000000) * 100))
    assert.equal(cu.model, 'claude-sonnet-4-6')
    assert.equal(cu.apiUsage.input_tokens, 100)
    assert.equal(cu.apiUsage.output_tokens, 0)
    assert.equal(cu.apiUsage.cache_creation_input_tokens, 50)
    assert.equal(cu.apiUsage.cache_read_input_tokens, 200)
    assert.deepEqual(cu.categories, [{ name: 'Context', tokens: 350, color: '#8B5CF6' }])
    // The same split in session meta: contextTokens/ctx% read the request
    // footprint, while cost / turns / total*Tokens keep the lifetime sums.
    const cuMeta = await dispatch({ jsonrpc: '2.0', id: 2931, method: 'claude.getSessionMeta', params: { sessionId: 'cu-1' } })
    assert.equal(cuMeta.result.contextTokens, 350)
    assert.equal(cuMeta.result.inputTokens, 100)
    assert.equal(cuMeta.result.cacheReadTokens, 200)
    assert.equal(cuMeta.result.cacheCreationTokens, 50)
    assert.equal(cuMeta.result.totalInputTokens, 150 + 50 + 250)
    assert.equal(cuMeta.result.totalOutputTokens, 30)
    assert.equal(cuMeta.result.totalCost, 0.0042)
    assert.equal(cuMeta.result.numTurns, 1)
  } finally {
    __setSdkOverrideForTests(undefined)
  }
  // Unknown sessionId → null (renderer interprets as "no data yet").
  const unknownReply = await dispatch({ jsonrpc: '2.0', id: 294, method: 'claude.getContextUsage', params: { sessionId: 'doesnt-exist' } })
  assert.equal(unknownReply.result, null)

  // Live-Query backed read APIs (getSupportedCommands / getSupportedAgents
  // / getAccountInfo) are pinned in the dedicated Live-Query contract block
  // above (no-session / unknown-session / live / throwing-currentQuery).
  // No SDK fallback here — these RPCs no longer call the SDK builder.

  // stream_event → claude:stream mapping for real-time text/thinking
  // deltas. Only content_block_delta with text or thinking forwards;
  // other stream event variants (message_start, message_delta usage,
  // ping, etc.) are dropped at this layer. Verifies the contract.
  const streamCaptured = []
  const restoreStreamEmit = mod.__setSendEventForTests((n, p) => streamCaptured.push({ name: n, payload: p }))
  const fakeSdkWithStream = {
    query() {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 's-stream', cwd: '/x' },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'message_start', message: { usage: { input_tokens: 10 } } } },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { text: 'Hel' } } },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { text: 'lo' } } },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { thinking: 'pondering' } } },
        { type: 'stream_event', session_id: 's-stream', parent_tool_use_id: null, event: { type: 'ping' } },
        { type: 'assistant', session_id: 's-stream', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
        { type: 'result', subtype: 'success', session_id: 's-stream', result: 'Hello', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkWithStream)
  try {
    await dispatch({ jsonrpc: '2.0', id: 280, method: 'claude.startSession', params: { sessionId: 'stream-1', options: { cwd: '/x' } } })
    await dispatch({ jsonrpc: '2.0', id: 281, method: 'claude.sendMessage', params: { sessionId: 'stream-1', prompt: 'hi' } })
    await settleTurn(mod.sessions.get('stream-1'))
    const streamEvents = streamCaptured.filter(e => e.name === 'claude:stream')
    // 2 text deltas + 1 thinking delta = 3 stream events. message_start
    // and ping must NOT produce a stream event.
    assert.equal(streamEvents.length, 3, `expected 3 stream events, got ${streamEvents.length}`)
    assert.equal(streamEvents[0].payload.data.text, 'Hel')
    assert.equal(streamEvents[1].payload.data.text, 'lo')
    assert.equal(streamEvents[2].payload.data.thinking, 'pondering')
    // parentToolUseId field present (null for top-level stream).
    for (const ev of streamEvents) assert.equal(ev.payload.data.parentToolUseId, null)
    const state = await dispatch({ jsonrpc: '2.0', id: 2811, method: 'claude.getSessionState', params: { sessionId: 'stream-1' } })
    assert.equal(state.result.streamingText, '')
    assert.equal(state.result.messages.some(m => m.role === 'assistant' && m.content === 'Hello'), true)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreStreamEmit()
  }

  // getSessionState must expose in-flight streaming text so a late-mounted
  // ClaudeAgentPanel can render the session body even if another listener
  // (like the thumbnail) saw the stream first.
  const liveStateCaptured = []
  const restoreLiveStateEmit = mod.__setSendEventForTests((n, p) => liveStateCaptured.push({ name: n, payload: p }))
  let releaseLiveStream
  const firstDelta = new Promise(resolve => {
    const fakeSdkLiveState = {
      query() {
        return (async function*() {
          yield { type: 'system', subtype: 'init', session_id: 's-live-state', cwd: '/x' }
          yield { type: 'stream_event', session_id: 's-live-state', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { text: 'partial' } } }
          resolve()
          await new Promise(done => { releaseLiveStream = done })
          yield { type: 'assistant', session_id: 's-live-state', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'partial done' }] } }
          yield { type: 'result', subtype: 'success', session_id: 's-live-state', result: 'partial done', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
        })()
      },
    }
    __setSdkOverrideForTests(fakeSdkLiveState)
  })
  try {
    await dispatch({ jsonrpc: '2.0', id: 282, method: 'claude.startSession', params: { sessionId: 'stream-state-1', options: { cwd: '/x' } } })
    const liveSend = dispatch({ jsonrpc: '2.0', id: 283, method: 'claude.sendMessage', params: { sessionId: 'stream-state-1', prompt: 'hi' } })
    await firstDelta
    const liveState = await dispatch({ jsonrpc: '2.0', id: 284, method: 'claude.getSessionState', params: { sessionId: 'stream-state-1' } })
    assert.equal(liveState.result.isStreaming, true)
    assert.equal(liveState.result.streamingText, 'partial')
    releaseLiveStream()
    // liveSend was already answered when the prompt was taken, back before the
    // first delta — so it is settleTurn, not this await, that gets us past the
    // turn's end here.
    await liveSend
    await settleTurn(mod.sessions.get('stream-state-1'))
    const doneState = await dispatch({ jsonrpc: '2.0', id: 285, method: 'claude.getSessionState', params: { sessionId: 'stream-state-1' } })
    assert.equal(doneState.result.isStreaming, false)
    assert.equal(doneState.result.streamingText, '')
    assert.equal(doneState.result.messages.some(m => m.role === 'assistant' && m.content === 'partial done'), true)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreLiveStateEmit()
  }

  // rate_limit_event mapping. The SDK emits a top-level message of
  // type 'rate_limit_event' when the API throttles us; the sidecar
  // must convert that into a claude:rate-limit notification with
  // resetsAt expanded from seconds to ms (renderer does Date math
  // on it). A second event missing required fields must NOT emit —
  // the SDK occasionally produces partial rate_limit_event during
  // transient slowdowns we don't want to surface.
  const rateLimitCaptured = []
  const restoreRateLimitEmit = mod.__setSendEventForTests((n, p) => rateLimitCaptured.push({ name: n, payload: p }))
  const fakeSdkWithRateLimit = {
    query() {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 's-rl', cwd: '/x' },
        // Full rate-limit event — should emit.
        { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'primary', resetsAt: 1700000000, utilization: 0.92, isUsingOverage: false } },
        // Missing resetsAt — must NOT emit.
        { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'primary', utilization: 0.5 } },
        // utilization optional — emit but utilization=null.
        { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'fallback', resetsAt: 1700001000, isUsingOverage: true } },
        { type: 'result', subtype: 'success', session_id: 's-rl', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkWithRateLimit)
  try {
    await dispatch({ jsonrpc: '2.0', id: 290, method: 'claude.startSession', params: { sessionId: 'rl-1', options: { cwd: '/x' } } })
    await dispatch({ jsonrpc: '2.0', id: 291, method: 'claude.sendMessage', params: { sessionId: 'rl-1', prompt: 'hi' } })
    await settleTurn(mod.sessions.get('rl-1'))
    const rl = rateLimitCaptured.filter(e => e.name === 'claude:rate-limit')
    assert.equal(rl.length, 2, `expected 2 rate-limit emits (one full, one no-utilization), got ${rl.length}`)
    // First emit — full info, resetsAt converted to ms.
    assert.equal(rl[0].payload.sessionId, 'rl-1')
    assert.equal(rl[0].payload.info.rateLimitType, 'primary')
    assert.equal(rl[0].payload.info.resetsAt, 1700000000 * 1000)
    assert.equal(rl[0].payload.info.utilization, 0.92)
    assert.equal(rl[0].payload.info.isUsingOverage, false)
    // Second emit — utilization omitted → null, isUsingOverage=true.
    assert.equal(rl[1].payload.info.rateLimitType, 'fallback')
    assert.equal(rl[1].payload.info.utilization, null)
    assert.equal(rl[1].payload.info.isUsingOverage, true)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreRateLimitEmit()
  }

  // Abort path: while a query is mid-stream (fake SDK yields slowly),
  // claude.abortSession must propagate to the AbortController so the
  // SDK's iterator terminates promptly. Verifies the renderer's stop
  // button actually stops a running turn.
  const abortCaptured = []
  const restoreAbortEmit = mod.__setSendEventForTests((n, p) => abortCaptured.push({ name: n, payload: p }))
  let signalSeenByFakeSdk = null
  const slowFakeSdk = {
    query({ options }) {
      signalSeenByFakeSdk = options?.abortController?.signal ?? null
      return (async function*() {
        // Yield init synchronously so we know the loop entered.
        yield { type: 'system', subtype: 'init', session_id: 'sdk-abort', cwd: '/x' }
        // Then "stream" forever, checking the abort signal each iteration.
        // 50 iterations * 25ms = 1.25s ceiling without abort; abort
        // should cut us off long before that.
        for (let i = 0; i < 50; i++) {
          if (signalSeenByFakeSdk?.aborted) {
            // Mirror real SDK behaviour: throw AbortError when aborted.
            throw new Error('aborted')
          }
          await new Promise(r => setTimeout(r, 25))
          yield { type: 'assistant', session_id: 'sdk-abort', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: `chunk-${i}` }] } }
        }
        yield { type: 'result', subtype: 'success', session_id: 'sdk-abort', result: 'done', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
    },
  }
  __setSdkOverrideForTests(slowFakeSdk)
  try {
    await dispatch({ jsonrpc: '2.0', id: 260, method: 'claude.startSession',
      params: { sessionId: 'abort-1', options: { cwd: '/x' } } })
    // Kick off sendMessage but don't await yet — it'll block on the
    // generator. abortSession needs to execute concurrently.
    const sendPromise = dispatch({ jsonrpc: '2.0', id: 261, method: 'claude.sendMessage',
      params: { sessionId: 'abort-1', prompt: 'tell me a long story' } })
    // Wait long enough for a few chunks to stream so we KNOW the abort
    // happens mid-flight (not before the loop even started).
    await new Promise(r => setTimeout(r, 80))
    const beforeAbort = abortCaptured.length
    assert.ok(beforeAbort >= 2, `expected ≥2 events before abort, got ${beforeAbort}`)
    const abortReply = await dispatch({ jsonrpc: '2.0', id: 262, method: 'claude.abortSession',
      params: { sessionId: 'abort-1' } })
    assert.equal(abortReply.result.ok, true)
    // sendMessage must complete promptly after abort — use a 1s ceiling
    // (much tighter than the 1.25s the fake SDK would otherwise run).
    const settled = await Promise.race([
      sendPromise,
      new Promise(r => setTimeout(() => r({ timedOut: true }), 1000)),
    ])
    assert.ok(!settled.timedOut, 'sendMessage did not settle within 1s of abortSession')
    // signal must have been propagated to the SDK so the fake iterator
    // saw .aborted=true.
    assert.ok(signalSeenByFakeSdk?.aborted, 'abort signal never reached the fake SDK iterator')
    // turn-end with reason:'aborted' must be present.
    const turnEnd = abortCaptured.find(e => e.name === 'claude:turn-end')
    assert.ok(turnEnd, 'expected claude:turn-end after abort')
    assert.equal(turnEnd.payload.payload.reason, 'aborted')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreAbortEmit()
  }

  // Tool-use / tool-result event mapping. The SDK emits assistant
  // messages whose content arrays carry tool_use blocks, and follow-up
  // user messages whose content arrays carry tool_result blocks. We
  // mirror Electron's contract: emit claude:tool-use per tool_use block
  // and claude:tool-result per tool_result block, keyed by tool_use_id
  // so the renderer can pair them up. Verify with a fake SDK that
  // streams a Bash call + its result.
  const tcCaptured = []
  const restoreTcEmit = mod.__setSendEventForTests((n, p) => tcCaptured.push({ name: n, payload: p }))
  const fakeSdkWithTools = {
    query() {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'sdk-tc', cwd: '/x' },
        { type: 'assistant', session_id: 'sdk-tc', parent_tool_use_id: null, message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running command' },
            { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
          ],
        } },
        { type: 'user', session_id: 'sdk-tc', parent_tool_use_id: null, message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'file1\nfile2', is_error: false },
          ],
        } },
        { type: 'assistant', session_id: 'sdk-tc', parent_tool_use_id: null, message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/missing' } }],
        } },
        { type: 'user', session_id: 'sdk-tc', parent_tool_use_id: null, message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'ENOENT', is_error: true }],
        } },
        { type: 'result', subtype: 'success', session_id: 'sdk-tc', result: 'done', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 },
      ]
      return (async function*() { for (const m of messages) yield m })()
    },
  }
  __setSdkOverrideForTests(fakeSdkWithTools)
  try {
    await dispatch({ jsonrpc: '2.0', id: 240, method: 'claude.startSession',
      params: { sessionId: 'tc-1', options: { cwd: '/x' } } })
    await dispatch({ jsonrpc: '2.0', id: 241, method: 'claude.sendMessage',
      params: { sessionId: 'tc-1', prompt: 'list files' } })
    await settleTurn(mod.sessions.get('tc-1'))
    const toolUseEvents = tcCaptured.filter(e => e.name === 'claude:tool-use')
    const toolResultEvents = tcCaptured.filter(e => e.name === 'claude:tool-result')
    assert.equal(toolUseEvents.length, 2, `expected 2 tool-use events, got ${toolUseEvents.length}`)
    assert.equal(toolResultEvents.length, 2, `expected 2 tool-result events, got ${toolResultEvents.length}`)
    const tu1 = toolUseEvents[0].payload
    assert.equal(tu1.sessionId, 'tc-1')
    assert.equal(tu1.toolCall.id, 'toolu_01')
    assert.equal(tu1.toolCall.toolName, 'Bash')
    assert.deepEqual(tu1.toolCall.input, { command: 'ls' })
    assert.equal(tu1.toolCall.status, 'running')
    assert.equal(tu1.toolCall.parentToolUseId, null)
    assert.equal(typeof tu1.toolCall.timestamp, 'number')
    const tr1 = toolResultEvents[0].payload.result
    assert.equal(tr1.id, 'toolu_01')
    assert.equal(tr1.status, 'completed')
    assert.equal(tr1.result, 'file1\nfile2')
    const tr2 = toolResultEvents[1].payload.result
    assert.equal(tr2.id, 'toolu_02')
    assert.equal(tr2.status, 'error')
    assert.equal(tr2.result, 'ENOENT')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreTcEmit()
  }

  // GH #123: Claude Code's own slash commands, plugin commands and skills reach
  // the renderer over claude:commands rather than being polled for.
  //
  // Polling is what broke: the panel asks on mount, which is before any turn has
  // spawned a CLI to ask, and there is no second trigger it can rely on. Pushing
  // at init — the first moment the list exists — removes the timing question.
  const cmdCaptured = []
  const restoreCmdEmit = mod.__setSendEventForTests((n, p) => cmdCaptured.push({ name: n, payload: p }))
  const fakeSdkWithCommands = {
    query() {
      const gen = (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-cmds', cwd: '/x' }
        // Mid-session discovery: the CLI finds skills as the agent moves around
        // the tree and re-pushes the whole list. Its contract is REPLACE.
        yield {
          type: 'system',
          subtype: 'commands_changed',
          session_id: 'sdk-cmds',
          commands: [
            { name: 'security-review', description: 'built in', argumentHint: '' },
            { name: 'acme:deploy', description: 'from a plugin', argumentHint: '' },
            { name: 'my-skill', description: 'a skill', argumentHint: '' },
          ],
        }
        yield { type: 'result', subtype: 'success', session_id: 'sdk-cmds', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
      // The real SDK Query exposes this alongside the async iterator; the init
      // push reads it off the same object.
      gen.supportedCommands = async () => [
        { name: 'security-review', description: 'built in', argumentHint: '' },
      ]
      return gen
    },
  }
  __setSdkOverrideForTests(fakeSdkWithCommands)
  try {
    await dispatch({ jsonrpc: '2.0', id: 244, method: 'claude.startSession',
      params: { sessionId: 'cmds-1', options: { cwd: '/x' } } })
    await dispatch({ jsonrpc: '2.0', id: 245, method: 'claude.sendMessage',
      params: { sessionId: 'cmds-1', prompt: 'hi' } })
    // The init push is fire-and-forget so a slow query cannot stall the frame
    // carrying the turn's first tokens; let its microtask land.
    await new Promise(resolve => setImmediate(resolve))

    const commandEvents = cmdCaptured.filter(e => e.name === 'claude:commands')
    assert.ok(commandEvents.length >= 1, 'expected at least one claude:commands push')
    for (const ev of commandEvents) {
      assert.equal(ev.payload.sessionId, 'cmds-1', 'events are keyed by BAT session, not the SDK session')
      assert.ok(Array.isArray(ev.payload.commands))
    }
    // Only one of the two pushes is synchronous. The init push has to await a
    // read off the Query, and here commands_changed overtakes it — exactly the
    // race the epoch counter exists for. Since the renderer REPLACEs on each
    // push, the last one to arrive is the one the menu ends up showing, so the
    // stale init answer must never be it.
    const last = commandEvents[commandEvents.length - 1].payload.commands
    assert.deepEqual(
      last.map(c => c.name),
      ['security-review', 'acme:deploy', 'my-skill'],
      'a late init read must not overwrite the fuller commands_changed list',
    )
    // Forwarded verbatim rather than re-read: the payload is authoritative and
    // re-reading would race the very change it is announcing.
    assert.equal(last.length, 3)
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreCmdEmit()
    mod.sessions.delete('cmds-1')
  }

  // The init push on its own — the common case, and the one that replaces the
  // mount-time poll that could never work. Nothing overtakes it here, so it must
  // actually reach the renderer.
  const initCaptured = []
  const restoreInitEmit = mod.__setSendEventForTests((n, p) => initCaptured.push({ name: n, payload: p }))
  __setSdkOverrideForTests({
    query() {
      const gen = (async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-init-cmds', cwd: '/x' }
        yield { type: 'result', subtype: 'success', session_id: 'sdk-init-cmds', result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1 }
      })()
      gen.supportedCommands = async () => [
        { name: 'init', description: 'built in', argumentHint: '' },
        { name: 'acme:deploy', description: 'from a plugin', argumentHint: '' },
      ]
      return gen
    },
  })
  try {
    await dispatch({ jsonrpc: '2.0', id: 246, method: 'claude.startSession',
      params: { sessionId: 'cmds-2', options: { cwd: '/x' } } })
    await dispatch({ jsonrpc: '2.0', id: 247, method: 'claude.sendMessage',
      params: { sessionId: 'cmds-2', prompt: 'hi' } })
    await new Promise(resolve => setImmediate(resolve))
    const pushed = initCaptured.filter(e => e.name === 'claude:commands')
    assert.equal(pushed.length, 1, `expected exactly one init push, got ${pushed.length}`)
    assert.deepEqual(pushed[0].payload.commands.map(c => c.name), ['init', 'acme:deploy'])
    // claude:status still goes out; the command push is additive, not a swap.
    assert.ok(initCaptured.some(e => e.name === 'claude:status'), 'init must still emit claude:status')
  } finally {
    __setSdkOverrideForTests(undefined)
    restoreInitEmit()
    mod.sessions.delete('cmds-2')
  }

  // SDK-unavailable fallback: claude.sendMessage stays usable as a stub
  // so renderer doesn't hang. Locks the release-without-bundle contract.
  __setSdkOverrideForTests(null)
  const captured2 = []
  const restore2 = mod.__setSendEventForTests((n, p) => captured2.push({ name: n, payload: p }))
  try {
    await dispatch({ jsonrpc: '2.0', id: 230, method: 'claude.startSession',
      params: { sessionId: 'send-stub', options: { cwd: '/x' } } })
    const stubReply = await dispatch({ jsonrpc: '2.0', id: 231, method: 'claude.sendMessage',
      params: { sessionId: 'send-stub', prompt: 'hi' } })
    assert.equal(stubReply.result.ok, true)
    assert.equal(stubReply.result.stub, true)
    const stubEvents = captured2.filter(c => c.name?.startsWith('claude:')).map(c => c.name)
    assert.deepEqual(stubEvents, ['claude:message', 'claude:status', 'claude:message', 'claude:turn-end'])
    const stubStatus = captured2.find(c => c.name === 'claude:status')?.payload.meta
    assert.equal(stubStatus?.runtimeStatus, 'starting')
    assert.equal(captured2.find(c => c.name === 'claude:message')?.payload.message.role, 'user')
  } finally {
    __setSdkOverrideForTests(undefined)
    restore2()
  }

  // claude.authLogin / authLogout / authStatus all spawn the resolved
  // claude CLI. Verify that the resolver picks up the bundled binary
  // when present (sidecar/node_modules/@anthropic-ai/claude-agent-sdk-<triple>/claude[.exe])
  // and that the env override BAT_SIDECAR_CLAUDE_BIN takes precedence.
  // We use the env override for the actual auth-flow tests so we can
  // point at a deterministic shim (process.execPath running an exit-0
  // script) instead of invoking the real CLI's network flow.
  const { resolveClaudeCliBinary, __resetClaudeCliCacheForTests } = mod
  __resetClaudeCliCacheForTests()
  const savedBin = process.env.BAT_SIDECAR_CLAUDE_BIN
  delete process.env.BAT_SIDECAR_CLAUDE_BIN
  try {
    const bundledPath = resolveClaudeCliBinary()
    const bundledLower = bundledPath?.toLowerCase().replace(/\\/g, '/') || ''
    if (bundledLower.includes('node_modules/@anthropic-ai/claude-agent-sdk-')) {
      // Bundled binary resolved. Sanity check: it points at the SDK
      // package's claude executable.
      assert.ok(
        bundledLower.endsWith('claude.exe') || bundledLower.endsWith('/claude'),
        `expected exe suffix, got ${bundledPath}`,
      )
    } else {
      // No bundled binary — that's OK in fresh checkouts where
      // node-sidecar/node_modules hasn't been installed. The handler
      // falls back to PATH lookup, which may resolve a system `claude`
      // or pnpm's root node_modules/.bin shim.
      console.log(`claude CLI bundle not present — bundled-resolver assertion skipped${bundledPath ? ` (${bundledPath})` : ''}`)
    }
  } finally {
    if (savedBin !== undefined) process.env.BAT_SIDECAR_CLAUDE_BIN = savedBin
  }

  if (process.platform !== 'win32') {
    const savedDataDirForManaged = process.env.BAT_SIDECAR_DATA_DIR
    const managedRoot = mkdtempSync(join(tmpdir(), 'bat-managed-claude-'))
    const managedKey = `${process.platform}-${process.arch}`
    const managedBin = join(
      managedRoot,
      'runtimes',
      'claude-agent-sdk',
      CLAUDE_NATIVE_VERSION,
      managedKey,
      'claude',
    )
    mkdirSync(dirname(managedBin), { recursive: true })
    writeFileSync(managedBin, `#!/bin/sh\necho claude ${CLAUDE_NATIVE_VERSION}\n`)
    chmodSync(managedBin, 0o700)
    process.env.BAT_SIDECAR_DATA_DIR = managedRoot
    delete process.env.BAT_SIDECAR_CLAUDE_BIN
    __resetClaudeCliCacheForTests()
    try {
      assert.equal(resolveClaudeCliBinary(), managedBin)
      rmSync(managedBin, { force: true })
      assert.notEqual(
        resolveClaudeCliBinary(),
        managedBin,
        'a Runtime Manager clear must invalidate the cached managed path',
      )
      writeFileSync(managedBin, `#!/bin/sh\necho claude ${CLAUDE_NATIVE_VERSION}\n`)
      chmodSync(managedBin, 0o700)
      assert.equal(
        resolveClaudeCliBinary(),
        managedBin,
        'a Runtime Manager install must replace a cached fallback without restarting the sidecar',
      )
    } finally {
      rmSync(managedRoot, { recursive: true, force: true })
      if (savedDataDirForManaged === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
      else process.env.BAT_SIDECAR_DATA_DIR = savedDataDirForManaged
      if (savedBin !== undefined) process.env.BAT_SIDECAR_CLAUDE_BIN = savedBin
      __resetClaudeCliCacheForTests()
    }
  }

  // Env override: set BAT_SIDECAR_CLAUDE_BIN to a node shim so authLogout
  // dispatch exercises the real spawn path without hitting the network.
  // There is no authLogin counterpart — that handler is gone; interactive
  // login is the paste-code driver in claude-auth-login.mjs.
  process.env.BAT_SIDECAR_CLAUDE_BIN = process.execPath
  __resetClaudeCliCacheForTests()
  try {
    const logoutReply = await dispatch({ jsonrpc: '2.0', id: 251, method: 'claude.authLogout' })
    assert.ok(logoutReply.result)
    // The removed spawn-and-wait login must stay removed: `claude auth login`
    // redirects to a hosted callback, so a handler that waits for process exit
    // could only ever time out. Unknown methods reply with an error, no result.
    const loginReply = await dispatch({ jsonrpc: '2.0', id: 250, method: 'claude.authLogin' })
    assert.equal(loginReply.result, undefined, 'claude.authLogin should no longer be registered')
    const loginNewReply = await dispatch({ jsonrpc: '2.0', id: 252, method: 'claude.accountLoginNew' })
    assert.equal(
      loginNewReply.result,
      undefined,
      'claude.accountLoginNew should no longer be registered',
    )
  } finally {
    if (savedBin === undefined) delete process.env.BAT_SIDECAR_CLAUDE_BIN
    else process.env.BAT_SIDECAR_CLAUDE_BIN = savedBin
    __resetClaudeCliCacheForTests()
  }


  // path-guard — port of electron/path-guard.ts and src-tauri/path_guard.rs.
  // Same deny list across all three hosts so the sidecar can't be tricked
  // into reading credential stores via image.readAsDataUrl (or a future
  // fs.readFile handler) just because the renderer asks nicely.
  {
    const { isSensitivePath } = await import('../src/lib/path-guard.mjs')
    const { homedir } = await import('os')
    const home = homedir()
    const sep = process.platform === 'win32' ? '\\' : '/'

    // (a) Empty / non-string → sensitive (caller is broken).
    assert.equal(isSensitivePath(''), true)
    assert.equal(isSensitivePath(null), true)
    assert.equal(isSensitivePath(undefined), true)
    assert.equal(isSensitivePath(123), true)

    // (b) Unrelated paths in the user's home / project tree are NOT
    //     sensitive — Claude legitimately reads ~/.bashrc, /etc/hosts,
    //     etc. Stricter scoping would belong at ctx.isRemote.
    assert.equal(isSensitivePath(`${home}${sep}.bashrc`), false)
    assert.equal(isSensitivePath(`${home}${sep}projects${sep}foo${sep}README.md`), false)
    if (process.platform !== 'win32') {
      assert.equal(isSensitivePath('/etc/hosts'), false)
      assert.equal(isSensitivePath('/usr/local/bin/node'), false)
    }

    // (c) ~/.ssh and anything beneath blocked (directory containment).
    assert.equal(isSensitivePath(`${home}${sep}.ssh`), true)
    assert.equal(isSensitivePath(`${home}${sep}.ssh${sep}id_rsa`), true)
    assert.equal(isSensitivePath(`${home}${sep}.ssh${sep}known_hosts`), true)
    // Sibling directory must NOT match (prefix check guards against
    // /home/user/.sshfs being treated as /home/user/.ssh).
    assert.equal(isSensitivePath(`${home}${sep}.sshfs${sep}config`), false)

    // (d) AWS / GCP / kube credential stores blocked.
    assert.equal(isSensitivePath(`${home}${sep}.aws${sep}credentials`), true)
    assert.equal(isSensitivePath(`${home}${sep}.kube${sep}config`), true)
    assert.equal(isSensitivePath(`${home}${sep}.config${sep}gcloud${sep}application_default_credentials.json`), true)
    assert.equal(isSensitivePath(`${home}${sep}.netrc`), true)
    assert.equal(isSensitivePath(`${home}${sep}.claude${sep}.credentials.json`), true)

    // (e) Private-key filename heuristic — id_rsa / id_ed25519 / *.pem
    //     under any .ssh/ or keys/ directory anywhere in the tree.
    assert.equal(isSensitivePath(`${home}${sep}work${sep}.ssh${sep}id_ed25519`), true)
    assert.equal(isSensitivePath(`${home}${sep}.ssh${sep}id_rsa.pub`), true)
    assert.equal(isSensitivePath(`/srv/keys/host.pem`.replaceAll('/', sep)), true)
    // Same filename outside .ssh/keys is fine.
    assert.equal(isSensitivePath(`${home}${sep}docs${sep}id_rsa.txt`), false)

    // (f) System-wide files (POSIX only — Windows path normalisation
    //     mangles forward slashes).
    if (process.platform !== 'win32') {
      assert.equal(isSensitivePath('/etc/shadow'), true)
      assert.equal(isSensitivePath('/etc/sudoers'), true)
      assert.equal(isSensitivePath('/root'), true)
      assert.equal(isSensitivePath('/root/.bashrc'), true)
    }
  }

  // image.readAsDataUrl moved to Rust (commands/image.rs + remote_server.rs).
  // The JS sidecar handler was removed; the renderer routes directly to the
  // Tauri command and the remote bridge dispatches `image:read-as-data-url`
  // natively in Rust, so there's nothing left to exercise from this side.








}

// End-to-end: spawn `node server.mjs`, send a few requests, assert replies.
async function endToEnd() {
  const isolatedDataDir = mkdtempSync(join(tmpdir(), 'bat-sidecar-e2e-data-'))
  try {
    await endToEndInDataDir(isolatedDataDir)
  } finally {
    rmSync(isolatedDataDir, { recursive: true, force: true })
  }
}

async function endToEndInDataDir(isolatedDataDir) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Disable real SDK loading so claude.sendMessage takes the
    // deterministic stub path. The SDK code path is exercised by
    // the cargo end_to_end_bundled_sdk_loads_through_bundled_node
    // integration test instead — which is the right place because
    // that test actually has a bundled SDK available.
    env: {
      ...process.env,
      BAT_SIDECAR_DISABLE_SDK: '1',
      BAT_SIDECAR_DATA_DIR: isolatedDataDir,
    },
  })
  // Capture stderr so a hidden crash surfaces if the test fails.
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })

  const replies = []
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) return
    replies.push(JSON.parse(trimmed))
  })

  function send(req) {
    child.stdin.write(JSON.stringify(req) + '\n')
  }

  send({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 1 } })
  send({ jsonrpc: '2.0', id: 2, method: 'claude.authStatus' })
  send({ jsonrpc: '2.0', id: 3, method: 'no.such' })
  // Lifecycle pair: startSession then sendMessage. sendMessage triggers
  // two event notifications (claude:message + claude:turn-end), so the
  // total emission count from the server is 4 + 2 = 6 lines.
  send({ jsonrpc: '2.0', id: 4, method: 'claude.startSession', params: { sessionId: 'e2e-1', options: { cwd: '/' } } })
  send({ jsonrpc: '2.0', id: 5, method: 'claude.sendMessage', params: { sessionId: 'e2e-1', prompt: 'hi' } })

  // Poll until we see all 5 replies. Events go to a separate accumulator.
  const events = replies // alias for readability — we filter below
  // 5s was not enough and made this leg flaky. Measured across six runs, the
  // last reply in is always claude.authStatus at 3.0-5.0s (it is the only one
  // here that goes looking for credentials); ping/startSession/sendMessage all
  // land inside 3.2s. So the budget was sitting right on top of the slowest
  // reply's normal range, and any load at all pushed it over — failing with
  // "got 4", which reads like sendMessage broke when nothing had.
  const deadline = Date.now() + 20000
  while (replies.filter(r => r.id !== undefined).length < 5 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25))
  }
  // Give events a moment to flush, since the server emits them before the
  // sendMessage reply but they may interleave on Windows pipes.
  await new Promise(r => setTimeout(r, 100))

  child.stdin.end()
  await new Promise(r => child.once('close', r))

  const idReplies = events.filter(r => r.id !== undefined && r.id !== null)
  const eventNotifs = events.filter(r => typeof r.method === 'string' && r.method.startsWith('event:'))
  if (idReplies.length !== 5) {
    throw new Error(`sidecar e2e: expected 5 id-replies, got ${idReplies.length}; stderr=${stderr}`)
  }
  // The server dispatches handlers concurrently (rl.on('line', async ...)),
  // so responses are not guaranteed to arrive in request order. Index
  // by id, which is what a real client (the Rust bridge) does anyway.
  const byId = new Map(idReplies.map(r => [r.id, r]))
  assert.equal(byId.get(1).result.ok, true)
  assert.deepEqual(byId.get(1).result.echo, { x: 1 })
  // authStatus result is null OR a parsed CLI JSON object (depends on
  // whether the dev machine has `claude` on PATH and is logged in).
  const authResult = byId.get(2).result
  assert.ok(authResult === null || typeof authResult === 'object',
    `unexpected authStatus shape: ${JSON.stringify(authResult)}`)
  assert.equal(byId.get(3).error.code, -32601)
  assert.equal(byId.get(4).result.ok, true)
  assert.equal(byId.get(4).result.sessionId, 'e2e-1')
  assert.equal(byId.get(5).result.ok, true)

  // sendMessage must have produced both events.
  const eventNames = new Set(eventNotifs.map(e => e.method))
  assert.ok(eventNames.has('event:claude:message'), `expected event:claude:message, got ${[...eventNames]}`)
  assert.ok(eventNames.has('event:claude:turn-end'), `expected event:claude:turn-end, got ${[...eventNames]}`)

  // The spawned server must never fall back to the developer's real
  // userData directory. Confirm its log landed in the per-run temp dir.
  assert.equal(existsSync(join(isolatedDataDir, 'sidecar.log')), true,
    'sidecar e2e must write logs inside its isolated data directory')
}

async function run() {
  await inProcess()
  await endToEnd()
  console.log('node-sidecar: passed')
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
