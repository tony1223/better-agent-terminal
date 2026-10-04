import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { dispatch } = await import('../src/server.mjs')
const { __setSdkOverrideForTests } = await import('../src/lib/sdk-loader.mjs')
const { __setSendEventForTests } = await import('../src/lib/protocol.mjs')
const { sessions, ensureSession } = await import('../src/lib/state.mjs')
const { closeLiveQuery } = await import('../src/handlers/claude-send.mjs')
const { invalidateSessionCommandCache } = await import('../src/handlers/claude-readonly.mjs')
const cwd = mkdtempSync(join(tmpdir(), 'bat-session-reload-'))
const events = []
const queries = []
const prompts = []
let initialization = () => Promise.resolve({})
let id = 0
let holdTurns = false
let releaseOldTurn
let lateFrameIgnored = false
const call = (method, params = { sessionId: 'reload-test' }) => dispatch({ jsonrpc: '2.0', id: ++id, method, params })
__setSendEventForTests((name, data) => events.push({ name, data }))
__setSdkOverrideForTests({ query(args) {
  queries.push(args)
  const generator = (async function* () {
    for await (const prompt of args.prompt) {
      prompts.push(prompt)
      if (holdTurns) {
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial reply' } } }
        await new Promise(resolve => { releaseOldTurn = resolve })
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'stale old reply' }] } }
        lateFrameIgnored = true
      }
      yield { type: 'result', subtype: 'success' }
    }
  })()
  generator.close = () => { args.closed = true; releaseOldTurn?.() }
  generator.initializationResult = () => initialization()
  generator.mcpServerStatus = async () => []
  generator.supportedCommands = async () => [{ name: 'new-command', description: 'new catalog' }]
  generator.supportedAgents = async () => [{ name: 'new-agent' }]
  return generator
} })
const s = ensureSession('reload-test')
s.options = { cwd, useWorktree: true, worktreePath: cwd }
s.sdkSessionId = 'persisted-conversation'
s.model = 'claude-opus-5-5'
s.permissionMode = 'bypassPermissions'
s.effort = 'high'
s.lastUsage = { input_tokens: 123 }
s.messages = [{ id: 'kept', role: 'user', content: 'existing conversation' }]
const messages = s.messages
let closed = 0
s.liveQuery = { close() { closed++ } }
s.currentQuery = {
  supportedCommands: async () => [{ name: 'old-command' }],
  supportedAgents: async () => [{ name: 'old-agent' }],
}
try {
  assert.equal((await call('claude.getSupportedCommands')).result[0].name, 'old-command')
  assert.equal((await call('claude.getSupportedAgents')).result[0].name, 'old-agent')
  const reply = await call('claude.reloadSession')
  assert.equal(reply.error, undefined)
  assert.equal(reply.result.ok, true)
  assert.equal(reply.result.deferred, false)
  assert.equal(reply.result.sdkSessionId, 'persisted-conversation')
  assert.equal(reply.result.meta.runtimeStatus, null)
  assert.equal(closed, 1)
  assert.equal(s.messages, messages)
  assert.equal(s.lastUsage.input_tokens, 123)
  assert.equal(s.permissionMode, 'bypassPermissions')
  assert.equal(s.options.worktreePath, cwd)
  assert.equal(queries.at(-1).options.resume, 'persisted-conversation')
  assert.equal(queries.at(-1).options.cwd, cwd)
  assert.deepEqual(queries.at(-1).options.settingSources, ['user', 'project', 'local'])
  assert.equal(queries.at(-1).options.continue, undefined)
  assert.equal(prompts.length, 0, 'reload must not trigger a model turn')
  assert.equal((await call('claude.getSupportedCommands')).result[0].name, 'new-command')
  assert.equal((await call('claude.getSupportedAgents')).result[0].name, 'new-agent')
  assert.equal(events.find(e => e.name === 'claude:commands').data.commands[0].name, 'new-command')
  assert.ok(!events.some(event => event.name === 'claude:session-reset' || event.name === 'claude:history'))
  assert.deepEqual(events.filter(e => e.name === 'claude:resume-loading').map(e => e.data.loading), [true, false])

  // Reload force-cancels the live turn, every queued send, tool approvals and
  // background work. No old catch/finally may clear the replacement runtime.
  holdTurns = true
  const activeReply = await call('claude.sendMessage', { sessionId: 'reload-test', prompt: 'active turn' })
  assert.equal(activeReply.result.accepted, true)
  while (!releaseOldTurn) await new Promise(resolve => setImmediate(resolve))
  const oldLive = s.liveQuery
  const oldController = s.abortController
  const oldArgs = queries.at(-1)
  const queuedOne = call('claude.sendMessage', { sessionId: 'reload-test', prompt: 'queued one' })
  const queuedTwo = call('claude.sendMessage', { sessionId: 'reload-test', prompt: 'queued two' })
  let permissionDecision, answerDecision
  s.pendingPermissions.set('permission', { resolve(value) { permissionDecision = value } })
  s.pendingAskUser.set('question', { resolve(value) { answerDecision = value } })
  s.activeTasks = new Map([['background', {}]])
  s.messages.push({ id: 'pending-tool', toolName: 'Bash', status: 'running', input: { command: 'background work' } })
  const restarted = await call('claude.reloadSession')
  assert.equal(restarted.result.ok, true)
  assert.equal(oldController.signal.aborted, true)
  assert.equal(oldLive.isClosed, true)
  assert.equal(oldArgs.closed, true)
  const beforeStalePermissions = events.length
  for (const tool of ['Bash', 'AskUserQuestion']) {
    assert.equal((await oldArgs.options.canUseTool(tool, {}, { toolUseID: 'stale-tool' })).behavior, 'deny')
  }
  assert.equal(events.length, beforeStalePermissions, 'a stopped agent cannot recreate stale permission prompts')
  assert.notEqual(s.liveQuery, oldLive)
  assert.equal(s.liveQuery.isClosed, false)
  assert.equal(s.streaming, false)
  assert.equal(s.activeTasks.size, 0)
  assert.equal(s.pendingPermissions.size, 0)
  assert.equal(s.pendingAskUser.size, 0)
  assert.equal(s.messages.find(message => message.id === 'pending-tool').status, 'error')
  assert.ok(events.some(event => event.name === 'claude:tool-result' && event.data.result.id === 'pending-tool'))
  assert.equal(permissionDecision.behavior, 'deny')
  assert.equal(answerDecision.behavior, 'deny')
  assert.equal((await queuedOne).result.cancelled, true)
  assert.equal((await queuedTwo).result.cancelled, true)
  assert.equal(prompts.length, 1, 'queued user prompts must never reach either agent')
  assert.equal(queries.at(-1).options.resume, 'persisted-conversation')
  assert.equal(s.messages.at(-1).content, 'partial reply', 'keep the partial reply in canonical history')
  assert.ok(!s.messages.some(message => message.content === 'stale old reply'))
  assert.ok(events.some(event => event.name === 'claude:turn-end' && event.data.payload.reason === 'aborted'))
  assert.ok(events.some(event => event.name === 'claude:permission-resolved' && event.data.toolUseId === 'permission'))
  assert.ok(events.some(event => event.name === 'claude:ask-user-resolved' && event.data.toolUseId === 'question'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lateFrameIgnored, false, 'closed LiveQuery stops dispatching old frames')
  holdTurns = false
  assert.equal((await call('claude.sendMessage', { sessionId: 'reload-test', prompt: 'new user turn' })).result.accepted, true)
  await s.sendQueue
  assert.equal(prompts.length, 2, 'a new explicit message can use the replacement agent')

  let lateCommands
  const oldQuery = s.currentQuery
  oldQuery.supportedCommands = () => new Promise(resolve => { lateCommands = resolve })
  invalidateSessionCommandCache('reload-test')
  const oldRead = call('claude.getSupportedCommands')
  while (!lateCommands) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await call('claude.reloadSession')).result.ok, true)
  lateCommands([{ name: 'stale-command' }])
  assert.deepEqual((await oldRead).result, [], 'old query metadata must not override the refreshed catalog')
  assert.equal((await call('claude.getSupportedCommands')).result[0].name, 'new-command')

  let finish
  initialization = () => new Promise(resolve => { finish = resolve })
  const pending = call('claude.reloadSession')
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  assert.match((await call('claude.reloadSession')).error.message, /already reloading/)
  const eventCount = events.length
  assert.match((await call('claude.sendMessage', { sessionId: 'reload-test', prompt: 'do not send', clientMessageId: 'not-accepted' })).error.message, /reloading/)
  assert.equal(events.length, eventCount, 'rejected send must not echo a user message')
  assert.equal(s.clientMessageRequests.has('not-accepted'), false)
  finish({})
  assert.equal((await pending).result.ok, true)

  initialization = () => Promise.reject(new Error('MCP initialization failed'))
  assert.match((await call('claude.reloadSession')).error.message, /MCP initialization failed/)
  assert.equal(s.sdkSessionId, 'persisted-conversation')
  assert.equal(s.messages, messages)
  assert.equal(s.liveQuery, null)
  assert.equal(s.reloading, false)
  assert.equal(s.runtimeStatus, null)
  initialization = () => Promise.resolve({})
  assert.equal((await call('claude.reloadSession')).result.ok, true, 'reload can be retried after failure')

  finish = undefined
  initialization = () => new Promise(resolve => { finish = resolve })
  const stopped = call('claude.reloadSession')
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  await call('claude.stopSession')
  finish({})
  assert.match((await stopped).error.message, /changed during reload/)
  assert.equal(sessions.has('reload-test'), false, 'late initialization cannot revive a stopped session')
  assert.match((await call('claude.reloadSession')).error.message, /not started/)
  assert.equal(prompts.length, 2)
  console.log('session reload: preserved transcript, no reload inference, force cancellation, stale-frame isolation and failure/stop recovery passed')
} finally {
  closeLiveQuery(s)
  sessions.delete('reload-test')
  __setSdkOverrideForTests(null)
  __setSendEventForTests(null)
  rmSync(cwd, { recursive: true, force: true })
}
