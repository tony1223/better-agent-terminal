// Covers the archived+live merge dedupe.
//
// Both panels render [...loadedArchive, ...messages]. Those lists overlap: the
// live window is the host's last N messages, whose head has usually already
// been archived. Archives written before the host append became idempotent also
// hold the same row several times over, and those files are not migrated — so
// the merge has to tolerate repeats rather than assume they were prevented.
//
// Run with: pnpm run test:message-dedupe

import assert from 'node:assert/strict'
import { dedupeMessagesById } from '../renderer/src/utils/message-dedupe'

type Row = { id: string; content: string }
const row = (id: string, content = id): Row => ({ id, content })

export async function run(): Promise<void> {
  // The realistic shape: the archive tail and the live head are the same rows.
  {
    const archived = [row('a'), row('b'), row('c')]
    const live = [row('b'), row('c'), row('d')]
    const merged = dedupeMessagesById([...archived, ...live])
    assert.deepEqual(merged.map(m => m.id), ['a', 'b', 'c', 'd'],
      'an overlapping archive/live boundary must render each row once, in order')
  }

  // The live copy is the host's current view, so it wins — a tool call that has
  // since completed must not revert to the status frozen into the archive.
  {
    const merged = dedupeMessagesById([
      { id: 'a', content: 'running' },
      { id: 'a', content: 'completed' },
    ])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].content, 'completed', 'the later copy is the fresher one')
  }

  // An archive poisoned before the host dedupe shipped: the same row three
  // times over, which is what rendered as the same reply repeated on screen.
  {
    const merged = dedupeMessagesById([row('a'), row('x'), row('x'), row('x'), row('b')])
    assert.deepEqual(merged.map(m => m.id), ['a', 'x', 'b'])
  }

  // Referential equality matters: this runs in a useMemo feeding further memos
  // and a ref, so the common no-duplicates case must not allocate a new array.
  {
    const input = [row('a'), row('b'), row('c')]
    assert.equal(dedupeMessagesById(input), input, 'a clean list must be returned as-is')
  }

  {
    const empty: Row[] = []
    assert.equal(dedupeMessagesById(empty), empty)
  }

  // Order is defined by the last occurrence, so a row repeated far apart lands
  // at its later position rather than silently splitting the difference.
  {
    const merged = dedupeMessagesById([row('a'), row('b'), row('c'), row('a')])
    assert.deepEqual(merged.map(m => m.id), ['b', 'c', 'a'])
  }

  console.log('message dedupe: passed')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
