import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBackoff, formatError } from '../renderer/src/utils/resume-recovery.ts'
import { BoundedSeenIds, dedupeMessagesById } from '../renderer/src/utils/message-dedupe.ts'

test('formatError selects structured fields for Error, objects, strings and unusual inputs', () => {
  const error = Object.assign(new Error('offline'), { code: 'DISCONNECTED', token: 'never-log' })
  const result = JSON.parse(formatError(error, { host: 'remote.example', sessionId: 's' }))
  assert.equal(result.message, 'offline')
  assert.equal(result.code, 'DISCONNECTED')
  assert.match(result.stack, /offline/)
  assert.equal(result.host, 'remote.example')
  assert.equal(result.sessionId, 's')
  assert.equal(JSON.parse(formatError({ message: 'retry', code: 42 })).code, '42')
  assert.equal(JSON.parse(formatError('offline')).message, 'offline')
  const circular: Record<string, unknown> = {}; circular.self = circular
  for (const value of [null, undefined, circular, {}, 42]) {
    assert.doesNotMatch(formatError(value), /\[object Object\]/)
  }
  assert.doesNotMatch(formatError(error), /never-log/)
  assert.doesNotMatch(formatError('Authorization: Basic dXNlcjpwYXNz api_key=private'), /dXNlcjpwYXNz|private/)
  assert.doesNotMatch(formatError('token=abc Bearer xyz password=hunter2 https://user:pass@host'), /abc|xyz|hunter2|user:pass/)
})

test('full jitter grows from one second to sixty, resets on resume and stable connection', () => {
  let now = 0
  const backoff = createBackoff(() => 0.5, () => now)
  assert.deepEqual(Array.from({ length: 9 }, () => backoff.next()), [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  backoff.connected(); now += 29_999
  assert.equal(backoff.next(), 30000, 'short connections must not reset the attempt count')
  backoff.connected(); now += 30_000
  assert.equal(backoff.next(), 500)
  backoff.next(); backoff.reset()
  assert.equal(backoff.next(), 500)
  assert.equal(createBackoff(() => 0).next(), 0)
  assert.equal(createBackoff(() => 0.999).next(), 999)
})

test('replay snapshots and archive/live overlap contain one current row per id', () => {
  const old = { id: 'a', status: 'running' }
  const current = { id: 'a', status: 'completed' }
  const replay = dedupeMessagesById([old, current, { id: 'b', status: 'completed' }, current])
  assert.deepEqual(replay.map(row => row.id), ['b', 'a'])
  assert.equal(replay[1], current)
  assert.deepEqual(dedupeMessagesById([...replay, ...replay]), replay)
})

test('seen IDs are session isolated, bounded, and survive live window removal', () => {
  const sessionA = new BoundedSeenIds(3)
  const sessionB = new BoundedSeenIds(3)
  sessionA.add('a').add('b').add('c')
  assert.ok(sessionA.has('a'))
  assert.equal(sessionB.has('a'), false)
  sessionA.add('d')
  assert.equal(sessionA.size, 3)
  assert.equal(sessionA.has('a'), false)
  assert.ok(sessionA.has('b'))
  sessionA.clear()
  assert.equal(sessionA.size, 0)
})


test('one failed session advances only its own jittered retry gate', () => {
  const sessionA = createBackoff(() => 0.5)
  const sessionB = createBackoff(() => 0.5)
  assert.equal(sessionA.next(), 500)
  assert.equal(sessionA.next(), 1000)
  assert.equal(sessionB.next(), 500)
  sessionB.reset()
  assert.equal(sessionA.next(), 2000)
})
