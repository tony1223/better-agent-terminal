import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHistoryPage, boundHistoryItems, HISTORY_MAX_BYTES, HISTORY_MAX_ENTRIES, HISTORY_RESPONSE_MAX_BYTES } from '../src/lib/history-page.mjs'

test('bounded tail replay pages in chronological order with exclusive cursors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bat-history-page-'))
  try {
    const path = join(dir, 'large.jsonl')
    const lines = Array.from({ length: 12000 }, (_, i) => JSON.stringify({ id: i, text: 'x'.repeat(1024) }) + '\n')
    await writeFile(path, lines.join(''))
    const page = await readHistoryPage(path)
    const rows = raw => raw.trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(page.bytesRead <= HISTORY_MAX_BYTES + 1)
    assert.equal(rows(page.raw).length, HISTORY_MAX_ENTRIES)
    assert.equal(rows(page.raw).at(-1).id, 11999)
    const older = await readHistoryPage(path, { before: page.before })
    assert.equal(rows(older.raw).at(-1).id, rows(page.raw)[0].id - 1)
    assert.equal(new Set([...rows(older.raw), ...rows(page.raw)].map(r => r.id)).size, 1000)
    const partial = await readHistoryPage(path, { maxBytes: 2500, maxEntries: 500 })
    assert.equal(rows(partial.raw).length, 2)
    assert.deepEqual(rows(partial.raw).map(r => r.id), [11998, 11999])
    assert.ok(partial.bytesRead <= 2501)
    const boundary = await readHistoryPage(path, { maxBytes: Buffer.byteLength(lines.at(-1)) })
    assert.equal(rows(boundary.raw)[0].id, 11999)
    await writeFile(path, 'x'.repeat(10000) + '\n' + lines[0])
    const skipped = await readHistoryPage(path, { maxBytes: 2000 })
    assert.equal(rows(skipped.raw)[0].id, 0)
    assert.ok(skipped.before > 0)
    const empty = await readHistoryPage(path, { before: 0 })
    assert.equal(empty.before, null)
    assert.equal(empty.raw, '')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('clientResume read failure only rejects that session and leaves other sessions untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bat-resume-isolation-'))
  const oldHome = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  const { dispatch } = await import('../src/server.mjs')
  const { sessions, ensureSession } = await import('../src/lib/state.mjs')
  const { __setSendEventForTests } = await import('../src/lib/protocol.mjs')
  const { __resolveProjectsDir } = await import('../src/lib/data-paths.mjs')
  const events = []
  __setSendEventForTests((name, data) => events.push({ name, data }))
  const a = ensureSession('isolation-a'), b = ensureSession('isolation-b')
  a.sdkSessionId = 'bad'; a.options = { cwd: dir }
  b.sdkSessionId = 'other'; b.messages = [{ id: 'untouched' }]
  const snapshot = JSON.stringify(b)
  const project = join(__resolveProjectsDir(), dir.replace(/[^a-zA-Z0-9]/g, '-'))
  try {
    // A directory in place of a JSONL file produces a real read error.
    await mkdir(join(project, 'bad.jsonl'), { recursive: true })
    const response = await dispatch({ jsonrpc: '2.0', id: 1, method: 'claude.clientResume', params: { sessionId: 'isolation-a' } })
    assert.ok(response.error, JSON.stringify(response))
    assert.equal(sessions.get('isolation-b'), b)
    assert.equal(JSON.stringify(b), snapshot)
    assert.ok(events.every(event => event.data.sessionId === 'isolation-a'))
    assert.equal(events.some(event => event.name === 'claude:history'), false)
    const resume = await dispatch({ jsonrpc: '2.0', id: 3, method: 'claude.resumeSession', params: { sessionId: 'isolation-a', sdkSessionId: 'bad', options: { cwd: dir } } })
    assert.ok(resume.error, JSON.stringify(resume))
    assert.equal(JSON.stringify(b), snapshot)
    assert.ok(events.every(event => event.data.sessionId === 'isolation-a'))
    const ping = await dispatch({ jsonrpc: '2.0', id: 2, method: 'ping' })
    assert.ok(!ping.error, JSON.stringify(ping))
  } finally {
    sessions.delete('isolation-a'); sessions.delete('isolation-b')
    __setSendEventForTests(null)
    if (oldHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldHome
    await rm(dir, { recursive: true, force: true })
  }
})

test('resume returns cursor and older page without broadcasting or replacing live history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bat-replay-pages-'))
  const { dispatch } = await import('../src/server.mjs')
  const { sessions, ensureSession } = await import('../src/lib/state.mjs')
  const { __setSendEventForTests } = await import('../src/lib/protocol.mjs')
  const { __resolveProjectsDir } = await import('../src/lib/data-paths.mjs')
  const events = []
  __setSendEventForTests((name, data) => events.push({ name, data }))
  const s = ensureSession('page-session')
  s.sdkSessionId = 'page-sdk'; s.options = { cwd: dir }
  const project = join(__resolveProjectsDir(), dir.replace(/[^a-zA-Z0-9]/g, '-'))
  try {
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'page-sdk.jsonl'), Array.from({ length: 1100 }, (_, i) => JSON.stringify({
      type: i % 2 ? 'assistant' : 'user',
      message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `row ${i}` }] },
    })).join('\n') + '\n')
    const call = options => dispatch({ jsonrpc: '2.0', id: 1, method: 'claude.clientResume', params: { sessionId: 'page-session', options } })
    const latest = (await call({})).result
    assert.equal(latest.items.length, 500)
    assert.equal(latest.items[0].content, 'row 600')
    assert.equal(latest.items.at(-1).content, 'row 1099')
    const snapshot = s.messages
    events.length = 0
    const older = (await call({ historyBefore: latest.before })).result
    assert.equal(older.items[0].content, 'row 100')
    assert.equal(older.items.at(-1).content, 'row 599')
    assert.equal(new Set([...older.items, ...latest.items].map(item => item.id)).size, 1000)
    assert.equal(s.messages, snapshot)
    assert.equal(events.some(event => event.name === 'claude:history'), false)
    const first = (await call({ historyBefore: older.before })).result
    assert.equal(first.items.length, 100)
    assert.equal(first.before, null)
  } finally {
    sessions.delete('page-session'); __setSendEventForTests(null)
    await rm(project, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})


test('stream-written >64MiB resume has bounded serialized pages and visible oversized-record gaps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bat-large-resume-'))
  const { dispatch } = await import('../src/server.mjs')
  const { sessions, ensureSession } = await import('../src/lib/state.mjs')
  const { __setSendEventForTests } = await import('../src/lib/protocol.mjs')
  const { __resolveProjectsDir } = await import('../src/lib/data-paths.mjs')
  const sessionId = 'large-budget-session'
  const session = ensureSession(sessionId)
  session.sdkSessionId = 'large-budget-sdk'; session.options = { cwd: dir }
  const project = join(__resolveProjectsDir(), dir.replace(/[^a-zA-Z0-9]/g, '-'))
  const path = join(project, 'large-budget-sdk.jsonl')
  const events = []
  __setSendEventForTests((name, data) => {
    if (name === 'claude:history') events.push(data)
  })
  try {
    await mkdir(project, { recursive: true })
    const file = await open(path, 'w')
    try {
      // Stream-write: never construct the whole transcript in memory.
      for (let i = 0; i < 560; i++) {
        await file.write(JSON.stringify({ uuid: `row-${i}`, type: 'user', message: { role: 'user', content: 'x'.repeat(128 * 1024) } }) + '\n')
        if (i === 280) {
          await file.write('{"uuid":"huge-record","type":"user","message":{"role":"user","content":"')
          for (let n = 0; n < 18; n++) await file.write('z'.repeat(1024 * 1024))
          await file.write('"}}\n')
        }
      }
    } finally { await file.close() }
    assert.ok((await stat(path)).size > 64 * 1024 * 1024)
    const ids = new Set()
    let before
    let gaps = 0
    let gapBytes = 0
    do {
      const read = await readHistoryPage(path, { before })
      assert.ok(read.bytesRead <= HISTORY_MAX_BYTES + 1)
      const response = await dispatch({ jsonrpc: '2.0', id: 1, method: 'claude.clientResume', params: { sessionId, options: before === undefined ? {} : { historyBefore: before } } })
      assert.ok(!response.error, JSON.stringify(response.error))
      assert.ok(Buffer.byteLength(JSON.stringify(response)) < HISTORY_RESPONSE_MAX_BYTES)
      assert.ok(Buffer.byteLength(JSON.stringify(response)) < 16 * 1024 * 1024)
      const page = response.result
      for (const item of page.items) {
        assert.ok(!ids.has(item.id), `duplicate ${item.id}`)
        ids.add(item.id)
        if (item.historyGap) {
          gaps++
          gapBytes += item.historyGap.sizeBytes
          assert.match(item.content, /History gap/)
          assert.equal(item.historyGap.id, item.id)
        }
      }
      if (page.before !== null) assert.ok(page.before < (before ?? Infinity))
      before = page.before
    } while (before !== null)
    for (let i = 0; i < 560; i++) assert.ok(ids.has(`row-${i}`), `missing row ${i}`)
    assert.ok(gaps > 0)
    assert.ok(gapBytes > 16 * 1024 * 1024)
    for (const event of events) {
      // Legacy remote frames carry both params and args.
      assert.ok(Buffer.byteLength(JSON.stringify({ type: 'event', channel: 'claude:history', params: event, args: [event] })) < HISTORY_RESPONSE_MAX_BYTES)
    }
    assert.equal(events.length, 1)
  } finally {
    sessions.delete(sessionId)
    __setSendEventForTests(null)
    await rm(project, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})


test('oversized remembered record is a bounded placeholder carrying its id and size', () => {
  const original = { id: 'oversized-memory-record', role: 'user', content: 'x'.repeat(17 * 1024 * 1024) }
  const [item] = boundHistoryItems([original], 'memory-session')
  assert.equal(item.id, original.id)
  assert.equal(item.historyGap.sizeBytes, Buffer.byteLength(JSON.stringify(original)))
  assert.match(item.content, /History gap/)
  assert.ok(Buffer.byteLength(JSON.stringify(item)) < HISTORY_RESPONSE_MAX_BYTES)
})

test('serialized expansion of one record is replaced rather than emitting an oversized history event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bat-expanded-history-'))
  const { loadSessionHistory } = await import('../src/handlers/claude-history.mjs')
  const { __setProjectsDirOverrideForTests } = await import('../src/lib/data-paths.mjs')
  const { __setSendEventForTests } = await import('../src/lib/protocol.mjs')
  const events = []
  __setProjectsDirOverrideForTests(dir)
  __setSendEventForTests((name, data) => { if (name === 'claude:history') events.push(data) })
  try {
    const project = join(dir, dir.replace(/[^a-zA-Z0-9]/g, '-'))
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'expanded.jsonl'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: Array.from({ length: 22000 }, (_, i) => ({ type: 'tool_use', id: `t-${i}`, name: 'x', input: {} })) } }) + '\n')
    const response = await loadSessionHistory('expansion-session', 'expanded', dir)
    assert.ok(response.ok)
    assert.ok(response.items.some(item => item.historyGap))
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < HISTORY_RESPONSE_MAX_BYTES)
    assert.ok(Buffer.byteLength(JSON.stringify(events)) < HISTORY_RESPONSE_MAX_BYTES)
  } finally {
    __setProjectsDirOverrideForTests(null)
    __setSendEventForTests(null)
    await rm(dir, { recursive: true, force: true })
  }
})
