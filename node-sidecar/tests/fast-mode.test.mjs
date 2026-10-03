import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { dispatch } = await import('../src/server.mjs')
const { __setSdkOverrideForTests } = await import('../src/lib/sdk-loader.mjs')
const { __setSendEventForTests } = await import('../src/lib/protocol.mjs')
const { ensureSession, sessions, buildSessionMeta } = await import('../src/lib/state.mjs')
const { closeLiveQuery } = await import('../src/handlers/claude-send.mjs')
const { isFastModeDebugEnabled, readFastModePolicy, supportsClaudeFastMode } = await import('../src/lib/fast-mode.mjs')

const root = mkdtempSync(join(tmpdir(), 'bat-fast-mode-'))
const savedEnv = { BAT_DEBUG: process.env.BAT_DEBUG, BAT_SIDECAR_DATA_DIR: process.env.BAT_SIDECAR_DATA_DIR }
process.env.BAT_SIDECAR_DATA_DIR = root
let requestId = 1
const events = []
const options = []
let sdkFastState = null
__setSendEventForTests((name, data) => events.push({ name, data }))
__setSdkOverrideForTests({
  query({ prompt, options: opts }) {
    options.push(opts)
    return (async function* () {
      for await (const _message of prompt) {
        yield { type: 'system', subtype: 'init', session_id: 'fake-fast-sdk', model: opts.model,
          fast_mode_state: sdkFastState || (opts.settings.fastMode ? 'on' : 'off'),
          fast_mode_disabled_reason: sdkFastState === 'off' ? 'extra_usage_disabled' : undefined }
        yield { type: 'result', subtype: 'success', session_id: 'fake-fast-sdk', result: 'done', num_turns: 1 }
      }
    })()
  },
})
const call = (method, params) => dispatch({ jsonrpc: '2.0', id: requestId++, method, params })
const policy = (allowed, epoch = 0) => writeFileSync(join(root, 'settings.json'), JSON.stringify({ allowFastMode: allowed, fastModeEpoch: epoch }))
const s = ensureSession('fast-test')
s.options = { cwd: root }
s.active = true
s.model = 'claude-opus-5-5'
async function turn() {
  const reply = await call('claude.sendMessage', { sessionId: 'fast-test', prompt: 'fake test only' })
  assert.equal(reply.error, undefined)
  assert.equal(reply.result.ok, true)
  for (let i = 0; i < 100 && s.streaming; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(s.streaming, false)
}
async function setFast(enabled) { return call('claude.setFastMode', { sessionId: 'fast-test', enabled }) }

try {
  for (const value of [undefined, '0', 'false', 'yes']) assert.equal(isFastModeDebugEnabled({ BAT_DEBUG: value }), false)
  for (const value of ['1', 'true', 'TRUE']) assert.equal(isFastModeDebugEnabled({ BAT_DEBUG: value }), true)
  assert.equal(supportsClaudeFastMode('claude-opus-5-5[1m]'), true)
  for (const model of ['claude-opus-4-7', 'claude-sonnet-4-6', 'opus', 'custom']) assert.equal(supportsClaudeFastMode(model), false)

  policy(true)
  delete process.env.BAT_DEBUG
  assert.equal(readFastModePolicy().allowed, false, 'saved opt-in cannot bypass the debug gate')
  assert.match((await setFast(true)).error.message, /BAT_DEBUG/)
  s.fastMode = true
  s.fastModeEpoch = 0
  await turn()
  assert.equal(options.at(-1).settings.fastMode, false, 'no-debug startup must override inherited CLI Fast')
  assert.equal(buildSessionMeta(s).fastMode, false)

  process.env.BAT_DEBUG = '1'
  policy(false)
  assert.match((await setFast(true)).error.message, /settings/)
  policy(true)
  await turn()
  assert.equal(options.at(-1).settings.fastMode, false, 'global opt-in must not enable a conversation')

  const enabled = await setFast(true)
  assert.equal(enabled.result.fastMode, true)
  assert.equal(enabled.result.fastModeState, 'pending')
  await turn()
  assert.equal(options.at(-1).settings.fastMode, true)
  assert.equal(options.at(-1).resume, 'fake-fast-sdk', 'changing Fast retains the conversation')
  assert.equal(buildSessionMeta(s).fastModeState, 'on', 'CLI status confirms actual speed')
  sdkFastState = 'cooldown'
  await turn()
  assert.equal(buildSessionMeta(s).fastMode, true, 'temporary cooldown retains the explicit opt-in')
  assert.equal(buildSessionMeta(s).fastModeState, 'cooldown')
  sdkFastState = 'off'
  await turn()
  assert.equal(buildSessionMeta(s).fastMode, false, 'runtime rejection must not display Fast as enabled')
  assert.equal(buildSessionMeta(s).fastModeDisabledReason, 'extra_usage_disabled')
  sdkFastState = null
  await setFast(true)
  await turn()
  const beforeRevocation = options.length
  policy(false, 1)
  policy(true, 1)
  assert.equal(buildSessionMeta(s).fastMode, false, 're-enabling the gate cannot restore a revoked opt-in')
  await turn()
  assert.equal(options.length, beforeRevocation + 1, 'revocation rebuilds a persistent Fast query')
  assert.equal(options.at(-1).settings.fastMode, false)

  await setFast(true)
  s.streaming = true
  assert.match((await setFast(false)).error.message, /current turn/)
  s.streaming = false
  await setFast(false)
  s.model = 'claude-sonnet-4-6'
  assert.match((await setFast(true)).error.message, /model/)
  assert.equal(buildSessionMeta(s).fastMode, false)
  s.model = 'claude-opus-5-5'
  await setFast(true)
  await call('claude.setModel', { sessionId: 'fast-test', model: 'claude-sonnet-4-6' })
  assert.equal(buildSessionMeta(s).fastMode, false, 'changing to an unsupported model clears Fast')
  assert.equal(events.at(-1).data.meta.fastMode, false, 'model changes broadcast canonical Fast state')
  s.model = 'claude-opus-5-5'
  await setFast(true)
  delete process.env.BAT_DEBUG
  assert.equal(buildSessionMeta(s).fastMode, false, 'debug revocation is checked on metadata and sends')
  await turn()
  assert.equal(options.at(-1).settings.fastMode, false)
  assert.equal((await setFast(false)).result.fastMode, false, 'disabling remains available without debug')
  assert.ok(events.some(e => e.name === 'claude:status' && e.data.meta.fastMode === true))
  assert.equal((await call('claude.setFastMode', { sessionId: 'fast-test', enabled: 'true' })).error !== undefined, true)
  console.log('fast mode: debug gate, global gate, session opt-in, revocation, query resume and status passed')
} finally {
  closeLiveQuery(s)
  sessions.delete('fast-test')
  __setSdkOverrideForTests(undefined)
  __setSendEventForTests(undefined)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
}
