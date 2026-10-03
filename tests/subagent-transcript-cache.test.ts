import * as assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SubagentTranscriptCache } from '../renderer/src/utils/subagent-transcript-cache'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

async function main() {
  const cache = new SubagentTranscriptCache<string>()
  cache.set('old-agent', ['large old transcript'])
  const pending = deferred<string[]>()
  const read = cache.load('old-agent', () => pending.promise)
  cache.clear()
  assert.equal(cache.size, 0, 'a conversation reset must release every subagent transcript')
  pending.resolve(['late old transcript'])
  assert.equal(await read, null)
  assert.equal(cache.size, 0, 'an old disk read must not refill the cleared conversation')

  const next = deferred<string[]>()
  const previousRead = cache.load('same-agent', () => next.promise)
  cache.replace(new Map([['same-agent', ['canonical new history']]]))
  next.resolve(['previous history'])
  assert.equal(await previousRead, null)
  assert.deepEqual(cache.get('same-agent'), ['canonical new history'])

  const live = deferred<string[]>()
  const liveRead = cache.load('live-agent', () => live.promise)
  cache.set('live-agent', ['new streamed message'])
  live.resolve(['stale disk snapshot'])
  assert.deepEqual(await liveRead, ['new streamed message'])
  assert.deepEqual(cache.get('live-agent'), ['new streamed message'])

  const bucket = ['first']
  cache.set('appending-agent', bucket)
  const append = deferred<string[]>()
  const appendRead = cache.load('appending-agent', () => append.promise)
  bucket.push('new streamed message')
  cache.set('appending-agent', bucket)
  append.resolve(['stale disk snapshot'])
  assert.deepEqual(await appendRead, bucket, 'in-place streaming appends must also win over disk reads')

  // The completed read must win regardless of whether the partial read
  // finishes first or last; it must not be mistaken for a live stream event.
  for (const partialFirst of [true, false]) {
    const partial = deferred<string[]>()
    const complete = deferred<string[]>()
    const partialRead = cache.load('finishing-agent', () => partial.promise)
    const completeRead = cache.load('finishing-agent', () => complete.promise)
    if (partialFirst) {
      partial.resolve(['partial'])
      assert.equal(await partialRead, null)
      complete.resolve(['complete'])
      assert.deepEqual(await completeRead, ['complete'])
    } else {
      complete.resolve(['complete'])
      assert.deepEqual(await completeRead, ['complete'])
      partial.resolve(['partial'])
      assert.equal(await partialRead, null)
    }
    assert.deepEqual(cache.get('finishing-agent'), ['complete'])
  }

  assert.deepEqual(await cache.load('completed-agent', async () => ['complete transcript']), ['complete transcript'])
  assert.deepEqual(cache.get('completed-agent'), ['complete transcript'])
  assert.deepEqual(await cache.load('empty-agent', async () => []), [])
  assert.equal(cache.has('empty-agent'), false)

  const failure = deferred<string[]>()
  const failedRead = cache.load('old-agent', () => failure.promise)
  cache.clear()
  failure.reject(new Error('previous conversation read failed'))
  assert.equal(await failedRead, null, 'a late old failure must not update new loading/error state')
  await assert.rejects(cache.load('current-agent', async () => { throw new Error('current read failed') }), /current read failed/)

  // Exercise the renderer entry points: host reset, local /clear and manual
  // resume must all reach the same cache/stream cleanup in both runtime panels.
  for (const panel of ['ClaudeAgentPanel', 'CodexAgentPanel']) {
    const source = await readFile(`renderer/src/components/${panel}.tsx`, 'utf8')
    assert.match(source, /const resetSubagentState = useCallback\([\s\S]*?subagentMessagesRef\.current\.clear\(\)[\s\S]*?subagentStreams\.clear\(\)/)
    const resetHandler = source.slice(source.indexOf('api.onSessionReset('), source.indexOf('api.onResumeLoading('))
    assert.ok(resetHandler.includes('resetSubagentState()'), `${panel} must clear subagents on a host reset`)
    assert.ok(resetHandler.includes('setLoadedArchive([])'), `${panel} must release loaded old history on a host reset`)
    const clearCommand = source.slice(source.indexOf("trimmed === '/new' || trimmed === '/clear'"), source.indexOf('// Intercept /login command'))
    assert.ok(clearCommand.includes('resetSubagentState()'), `${panel} /clear must release local subagent state`)
    const resume = source.slice(source.indexOf('const handleResumeSelect'), source.indexOf('const handleForkSession'))
    assert.ok(resume.includes('resetSubagentState()'), `${panel} manual resume must release the previous subagents`)
    assert.ok(source.includes('subagentMessagesRef.current.load('), `${panel} disk backfill must reject stale reads`)
    assert.ok(source.includes('subagentMessagesRef.current.replace(subagentBuckets)'), `${panel} history replay must invalidate earlier disk reads`)
  }
  console.log('subagent transcript reset regression: passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
