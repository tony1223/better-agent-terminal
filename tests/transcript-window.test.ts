import * as assert from 'node:assert/strict'
import { fittingTranscriptCount, persistTranscriptArchive, readArchivePage, releaseArchivedSnapshots, resolveTranscriptPrompt, transcriptArchivePrefix, transcriptWeight, TRANSCRIPT_BYTE_BUDGET } from '../renderer/src/utils/transcript-window'

type Row = { id: string; content: string; role?: string; status?: string }
const row = (n: number, content = 'small'): Row => ({ id: String(n), content })
const normalize = (items: unknown[]) => items as Row[]

async function main() {
  const huge = Array.from({ length: 20 }, (_, i) => row(i, 'x'.repeat(500_000)))
  assert.ok(huge.length < 160)
  const prefix = transcriptArchivePrefix(huge)
  assert.ok(prefix.length > 0, 'bytes must trigger archiving before the row limit')
  assert.ok(huge.slice(prefix.length).reduce((sum, item) => sum + transcriptWeight(item), 0) <= TRANSCRIPT_BYTE_BUDGET)
  const ordinary = Array.from({ length: 170 }, (_, i) => row(i))
  assert.equal(transcriptArchivePrefix(ordinary).length, 50)
  ordinary[10] = { ...ordinary[10], status: 'running' }
  assert.equal(transcriptArchivePrefix(ordinary).length, 10, 'do not archive unfinished tools or reorder the archive')
  const oversize = row(100, 'x'.repeat(5_000_000))
  assert.equal(fittingTranscriptCount([row(0), oversize]), 1, 'one oversized message stays intact and accessible')

  const saved = row(0)
  const updated = { ...saved, content: 'final result' }
  assert.deepEqual(releaseArchivedSnapshots([saved, row(1)], [saved]).map(item => item.id), ['1'])
  assert.deepEqual(releaseArchivedSnapshots([updated, row(1)], [saved]), [updated, row(1)])
  const batches: Row[][] = []
  assert.equal(await persistTranscriptArchive(huge, async batch => { batches.push(batch); return true }), true)
  assert.deepEqual(batches.flat().map(item => item.id), huge.map(item => item.id))
  assert.ok(batches.every(batch => batch.reduce((sum, item) => sum + transcriptWeight(item), 0) <= TRANSCRIPT_BYTE_BUDGET))
  let writes = 0
  assert.equal(await persistTranscriptArchive(huge, async () => ++writes < 2), false)
  assert.equal(writes, 2, 'stop on a rejected batch and keep original snapshots for retry')

  let rows = Array.from({ length: 500 }, (_, i) => row(i, i % 4 === 0 ? 'x'.repeat(3_000_000) : 'small'))
  const load = async (offset: number, limit: number) => {
    const end = Math.max(0, rows.length - offset)
    const start = Math.max(0, end - limit)
    return { messages: rows.slice(start, end), total: rows.length, hasMore: start > 0 }
  }
  let page = await readArchivePage(load, normalize, { total: 0, limit: 120 })
  assert.ok(page.items.reduce((sum, item) => sum + transcriptWeight(item), 0) <= TRANSCRIPT_BYTE_BUDGET)
  const seen: string[] = []
  // Traversing backwards must visit every row, even when byte limits reduce a page.
  while (true) {
    seen.unshift(...page.items.map(item => item.id))
    if (page.start === 0) break
    page = await readArchivePage(load, normalize, { total: page.total, end: page.start, limit: 40 })
  }
  assert.deepEqual(seen, rows.map(item => item.id))
  // And forward must not skip the beginning of a reduced page or overlap the last partial page.
  seen.length = 0
  while (page.end < rows.length) {
    seen.push(...page.items.map(item => item.id))
    page = await readArchivePage(load, normalize, { total: page.total, start: page.end, limit: 40 })
  }
  seen.push(...page.items.map(item => item.id))
  assert.deepEqual(seen, rows.map(item => item.id))

  const anchor = await readArchivePage(load, normalize, { total: rows.length, end: 80, limit: 20 })
  rows.push(row(500), row(501))
  const older = await readArchivePage(load, normalize, { total: anchor.total, end: anchor.start, limit: 20 })
  assert.equal(older.end, anchor.start, 'new archive writes must not shift historical navigation')
  // Malformed stored rows advance the raw cursor rather than making a page repeat forever.
  const malformedLoad = async (offset: number, limit: number) => ({ messages: [], total: 5, hasMore: 5 - offset - limit > 0 })
  const malformed = await readArchivePage(malformedLoad, normalize, { total: 5, end: 3, limit: 2 })
  assert.equal(malformed.start, 1)

  rows = Array.from({ length: 10 }, (_, i) => ({ ...row(i), role: i % 2 === 0 ? 'user' : 'assistant' }))
  const live = [rows[8], rows[9], { ...row(10), role: 'user' }, { ...row(11), role: 'assistant' }, { ...row(12), role: 'user' }]
  assert.deepEqual(await resolveTranscriptPrompt('4', live, load, normalize), { index: 2, count: 7 })
  assert.deepEqual(await resolveTranscriptPrompt('10', live, load, normalize), { index: 5, count: 7 })
  let metadataReads = 0
  const metadataLoad = async (offset: number, limit: number) => {
    metadataReads++
    assert.equal(limit, 0, 'new hosts should not load any message bodies to resolve rewind')
    return { messages: [], total: 10, hasMore: true, promptIds: ['0', '2', '4', '6', '8'] }
  }
  assert.deepEqual(await resolveTranscriptPrompt('10', live, metadataLoad, normalize), { index: 5, count: 7 })
  assert.equal(metadataReads, 1)
  await assert.rejects(resolveTranscriptPrompt('missing', live, load, normalize), /no longer/)
  console.log('transcript window regression: passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
