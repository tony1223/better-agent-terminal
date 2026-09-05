import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { portableTranscript } from '../src/lib/transcript-transfer.mjs'
import { __setProjectsDirOverrideForTests } from '../src/lib/data-paths.mjs'
import { sessions } from '../src/lib/state.mjs'

const temporaryRoot = resolve(tmpdir())
const root = await mkdtemp(join(temporaryRoot, 'bat-transcript-test-'))
const previousDataDir = process.env.BAT_SIDECAR_DATA_DIR
process.env.BAT_SIDECAR_DATA_DIR = root
const projects = join(root, 'projects')
__setProjectsDirOverrideForTests(projects)
const { dispatch } = await import('../src/server.mjs')
let requestId = 0
const send = sessionId => dispatch({ jsonrpc: '2.0', id: ++requestId, method: 'claude.exportTranscript', params: { sessionId } })
const sessionId = 'transcript-source'
const sdkSessionId = 'provider-source'
const cwd = join(root, 'workspace with spaces')
const project = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
const source = join(project, `${sdkSessionId}.jsonl`)
const longResult = 'BEGIN RESULT\n' + 'result detail\n'.repeat(6000) + 'END RESULT'
const rows = [
  ...Array.from({ length: 40 }, (_, index) => ({
    type: 'user', uuid: `user-${index}`, parentUuid: index ? `user-${index - 1}` : null,
    message: { role: 'user', content: `Requirement ${index}` },
  })),
  { type: 'assistant', uuid: 'call', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'private reasoning' },
    { type: 'text', text: 'Checking the implementation' },
    { type: 'tool_use', id: 'test-call', name: 'Bash', input: { command: 'pnpm test', api_key: 'sensitive-key', nested: { password: 'sensitive-password' } } },
  ] } },
  { type: 'user', uuid: 'result', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'test-call', content: longResult },
    { type: 'image', source: { data: 'binary-secret' } },
  ] } },
  { type: 'system', message: { role: 'system', content: 'private system prompt' } },
]

try {
  await mkdir(project, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const raw = rows.map(row => JSON.stringify(row)).join('\n') + '\n{"unfinished":'
  await writeFile(source, raw)
  sessions.set(sessionId, { sdkSessionId, options: { cwd }, streaming: false, messages: [] })

  const response = await send(sessionId)
  assert.equal(response.error, undefined)
  const snapshot = response.result
  assert.equal(snapshot.sourceSdkSessionId, sdkSessionId)
  assert.equal(snapshot.cwd, cwd)
  assert.equal(snapshot.recordCount, 42, 'include history older than the renderer window')
  assert.equal(snapshot.skippedLines, 1, 'disclose a partial final record')
  assert.equal(snapshot.omittedBlocks, 2)
  assert.equal(snapshot.latestUserMessage, 'Requirement 39', 'tool result/attachment must not replace the human request')
  const saved = await readFile(snapshot.path, 'utf8')
  assert.equal(Buffer.byteLength(saved), snapshot.bytes)
  assert.match(saved, /Requirement 0/)
  assert.doesNotMatch(saved, /private reasoning|private system prompt|sensitive-key|sensitive-password|binary-secret/)
  const records = saved.trim().split('\n').map(line => JSON.parse(line))
  const result = records.at(-1).message.content[0]
  assert.equal(result.tool_use_id, 'test-call')
  assert.equal(result.content[0].text, longResult, 'full tool result survives export without a 2,000 character cap')
  assert.equal((await readFile(source, 'utf8')), raw, 'export must not mutate source history')
  assert.deepEqual(JSON.parse(await readFile(join(dirname(snapshot.path), 'manifest.json'), 'utf8')), snapshot)

  await writeFile(source, JSON.stringify(rows[0]) + '\n')
  assert.equal(await readFile(snapshot.path, 'utf8'), saved, 'snapshot does not follow later source edits')
  const second = (await send(sessionId)).result
  assert.notEqual(second.path, snapshot.path)
  assert.equal(second.recordCount, 1)

  sessions.get(sessionId).streaming = true
  assert.match((await send(sessionId)).error.message, /turn to stop/)
  sessions.get(sessionId).streaming = false
  sessions.get(sessionId).sdkSessionId = 'missing-source'
  assert.match((await send(sessionId)).error.message, /not found on disk/)
  sessions.get(sessionId).sdkSessionId = '../provider-source'
  assert.match((await send(sessionId)).error.message, /unavailable/)
  assert.match((await send('unknown')).error.message, /unavailable/)
  assert.equal((await readdir(join(root, 'transcript-handoffs'))).length, 2, 'failed exports leave no snapshots')

  sessions.get(sessionId).sdkSessionId = sdkSessionId
  await writeFile(source, '{"incomplete":')
  assert.match((await send(sessionId)).error.message, /No readable/)
  assert.equal((await readdir(join(root, 'transcript-handoffs'))).length, 2)
  await writeFile(source, raw)
  sessions.get(sessionId).options.cwd = join(root, 'moved-workspace')
  const moved = (await send(sessionId)).result
  assert.equal(moved.sourceSdkSessionId, sdkSessionId, 'cwd fallback must still use the exact provider session ID')
  assert.equal(moved.recordCount, 42)

  const redacted = portableTranscript(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'password="a multi word secret"\n{"api_key": "json-secret"}\nAuthorization: Bearer bearer-secret' },
    { type: 'tool_use', input: { key: '-----BEGIN PRIVATE KEY-----\nvery-secret\n-----END PRIVATE KEY-----' } },
  ] } }))
  assert.doesNotMatch(redacted.jsonl, /multi word|json-secret|bearer-secret|very-secret/)
  assert.equal(redacted.redactionCount, 4)
  const longRequest = portableTranscript(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(9000) } }))
  assert.equal(longRequest.latestUserMessage.length, 4000)
  assert.equal(longRequest.latestUserMessageTruncated, true)
  assert.match(longRequest.jsonl, new RegExp('x'.repeat(9000)), 'only the entry-point preview is bounded')
  assert.equal(portableTranscript('\uFEFF' + JSON.stringify(rows[0])).recordCount, 1)
  const compacted = portableTranscript([
    rows[0],
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Compacted previous work' } },
    { type: 'user', message: { role: 'user', content: '<task-notification>Agent done</task-notification>' } },
  ].map(row => JSON.stringify(row)).join('\n'))
  assert.equal(compacted.latestUserMessage, 'Requirement 0')
  assert.equal(JSON.parse(compacted.jsonl.split('\n')[1]).isCompactSummary, true)
  console.log('claude-transcript-transfer: passed')
} finally {
  sessions.delete(sessionId)
  __setProjectsDirOverrideForTests(null)
  if (previousDataDir === undefined) delete process.env.BAT_SIDECAR_DATA_DIR
  else process.env.BAT_SIDECAR_DATA_DIR = previousDataDir
  assert.equal(dirname(resolve(root)), temporaryRoot)
  assert.ok(root.startsWith(join(temporaryRoot, 'bat-transcript-test-')))
  await rm(root, { recursive: true, force: true })
}
