// Tests that archiving the same window twice does not store it twice.
//
// The archive is append-only and the renderer flushes whatever is currently
// off-screen — sound only while `messages` grows by new rows. It does not:
// hydrating a panel replaces the list with the host's last N, whose head is
// already archived, and a remote reconnect re-hydrates. So the same window was
// appended once per reconnect, forever, and the duplicates rendered as the same
// reply repeated N times. Observed live: one 3515-row archive held 102 ids three
// times over and 78 twice, all with identical timestamps.
//
// The host is where this has to be settled — every client funnels through this
// handler, so old clients are covered and it survives a renderer that loses its
// own bookkeeping across remounts.
//
// Run with: pnpm exec node node-sidecar/tests/claude-archive-idempotent.test.mjs

import * as assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'bat-archive-'))
process.env.BAT_SIDECAR_DATA_DIR = dataDir

const { dispatch } = await import('../src/server.mjs')

let nextRequestId = 1
function send(method, params) {
  return dispatch({ jsonrpc: '2.0', id: nextRequestId++, method, params })
}

const archivePath = sid => join(dataDir, 'message-archives', `${sid}.jsonl`)
function archivedRows(sid) {
  const p = archivePath(sid)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
}
const msg = (id, content) => ({ id, sessionId: 'x', role: 'assistant', content, timestamp: 1000 })

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    failures += 1
    console.error(`FAIL - ${name}\n  ${err?.message || err}`)
  }
}

try {
  await check('re-archiving the same window does not append a second copy', async () => {
    const sid = 'archive-dup'
    const window = [msg('a', 'first'), msg('b', 'second'), msg('c', 'third')]
    assert.equal((await send('claude.archiveMessages', { sessionId: sid, messages: window })).result, true)
    // Exactly what a re-hydrate produces: the same window flushed again.
    assert.equal((await send('claude.archiveMessages', { sessionId: sid, messages: window })).result, true)
    assert.equal((await send('claude.archiveMessages', { sessionId: sid, messages: window })).result, true)

    const rows = archivedRows(sid)
    assert.equal(rows.length, 3, 'three flushes of one window must still store three rows')
    assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c'])
  })

  await check('an overlapping window still stores the rows that are new', async () => {
    const sid = 'archive-overlap'
    await send('claude.archiveMessages', { sessionId: sid, messages: [msg('a', '1'), msg('b', '2')] })
    // The realistic shape: the next flush re-sends the tail plus new rows.
    await send('claude.archiveMessages', { sessionId: sid, messages: [msg('b', '2'), msg('c', '3'), msg('d', '4')] })
    assert.deepEqual(archivedRows(sid).map(r => r.id), ['a', 'b', 'c', 'd'])
  })

  await check('duplicates within a single flush are collapsed', async () => {
    const sid = 'archive-selfdup'
    await send('claude.archiveMessages', { sessionId: sid, messages: [msg('a', '1'), msg('a', '1'), msg('b', '2')] })
    assert.deepEqual(archivedRows(sid).map(r => r.id), ['a', 'b'])
  })

  await check('clearArchive lets the same ids be written again', async () => {
    const sid = 'archive-clear'
    const window = [msg('a', '1'), msg('b', '2')]
    await send('claude.archiveMessages', { sessionId: sid, messages: window })
    assert.equal((await send('claude.clearArchive', { sessionId: sid })).result, true)
    // The history-reset path clears and immediately re-archives. If the id cache
    // survived the clear, the replacement archive would come back empty.
    await send('claude.archiveMessages', { sessionId: sid, messages: window })
    assert.deepEqual(archivedRows(sid).map(r => r.id), ['a', 'b'])
  })

  await check('a row with no id is written through rather than dropped', async () => {
    const sid = 'archive-noid'
    await send('claude.archiveMessages', {
      sessionId: sid,
      messages: [{ role: 'assistant', content: 'no id here', timestamp: 1 }],
    })
    await send('claude.archiveMessages', {
      sessionId: sid,
      messages: [{ role: 'assistant', content: 'no id here', timestamp: 1 }],
    })
    // Cannot be deduped, so it is stored twice on purpose: losing history is
    // worse than storing it twice.
    assert.equal(archivedRows(sid).length, 2)
  })

  await check('an archive written by a previous process is still deduped against', async () => {
    // Seeded straight onto disk with nothing in memory — the state a restarted
    // host is in. Without reading the file back, every restart would re-poison
    // the archive on the next hydrate.
    const sid = 'archive-seed'
    const window = [msg('a', '1'), msg('b', '2')]
    mkdirSync(join(dataDir, 'message-archives'), { recursive: true })
    writeFileSync(archivePath(sid), window.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8')

    await send('claude.archiveMessages', { sessionId: sid, messages: [...window, msg('c', '3')] })
    assert.deepEqual(archivedRows(sid).map(r => r.id), ['a', 'b', 'c'])
  })

  await check('loadArchived returns what was stored, once each', async () => {
    const sid = 'archive-load'
    const window = [msg('a', '1'), msg('b', '2'), msg('c', '3')]
    await send('claude.archiveMessages', { sessionId: sid, messages: window })
    await send('claude.archiveMessages', { sessionId: sid, messages: window })
    const loaded = await send('claude.loadArchived', { sessionId: sid, offset: 0, limit: 100 })
    assert.equal(loaded.result.total, 3)
    assert.deepEqual(loaded.result.messages.map(m => m.id), ['a', 'b', 'c'])
  })
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nclaude-archive-idempotent: all tests passed')
