import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { handlers } from '../src/lib/protocol.mjs'

import {
  isTrustedClaudeLoginUrl,
  loginIdMatches,
  sanitizeLoginError,
} from '../src/handlers/claude-auth-login.mjs'

assert.equal(
  sanitizeLoginError(
    '\u001b[31mOAuth failed at https://claude.ai/oauth/authorize?secret=value for ABCD-1234\u001b[0m',
  ),
  'OAuth failed at <redacted-url> for <redacted-code>',
)

assert.equal(loginIdMatches({ loginId: 'owned-login' }, 'owned-login'), true)
assert.equal(loginIdMatches({ loginId: 'owned-login' }, 'other-login'), false)
assert.equal(loginIdMatches({ loginId: 'legacy-login' }, ''), true)
assert.equal(isTrustedClaudeLoginUrl('https://claude.ai/oauth/authorize?x=1'), true)
assert.equal(isTrustedClaudeLoginUrl('https://platform.claude.com/oauth/authorize'), true)
assert.equal(isTrustedClaudeLoginUrl('https://example.com/oauth/authorize'), false)
assert.equal(isTrustedClaudeLoginUrl('http://claude.ai/oauth/authorize'), false)

assert.equal(
  sanitizeLoginError('ordinary authentication failure'),
  'ordinary authentication failure',
)

// Exercise the registered handlers with a fake CLI process, including the
// browser-callback path that exits before SubmitCode is called. No real OAuth
// or developer credentials are touched.
const originalSpawn = childProcess.spawn
const originalBin = process.env.BAT_SIDECAR_CLAUDE_BIN
process.env.BAT_SIDECAR_CLAUDE_BIN = process.execPath
let child
let stdinWrites
childProcess.spawn = () => {
  stdinWrites = []
  child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: value => { stdinWrites.push(value) } }
  child.kill = () => { child.emit('close', null) }
  queueMicrotask(() => child.stdout.emit('data', 'https://claude.ai/oauth/authorize?state=test\n'))
  return child
}
syncBuiltinESMExports()
const start = handlers.get('claude.authLoginStart')
const submit = handlers.get('claude.authLoginSubmitCode')
const release = handlers.get('claude.authLoginRelease')
const cancel = handlers.get('claude.authLoginCancel')
try {
  for (const scenario of [
    { exitCode: 0, output: 'Logged in successfully', success: true },
    { exitCode: 0, output: '\u001b[31mError: authorization denied\u001b[0m', success: false },
    { exitCode: 1, output: '', success: false },
    { exitCode: null, output: '', success: false },
  ]) {
    const login = await start()
    assert.equal(login.ok, true)
    child.stdout.emit('data', scenario.output)
    child.emit('close', scenario.exitCode)
    // A different loginId must not consume even a finished login.
    const invalid = await submit({ code: 'code', loginId: 'someone-else' })
    assert.equal(invalid.terminal, false)
    assert.equal(invalid.error, 'invalid login session')
    const result = await submit({ code: 'pasted-after-browser-callback', loginId: login.loginId, deferRelease: true })
    assert.equal(result.success, scenario.success)
    assert.equal(result.loginId, login.loginId)
    assert.equal(result.terminal, true)
    assert.deepEqual(stdinWrites, [])
    assert.equal((await start()).error, 'auth_in_progress', 'host finalization keeps the slot reserved')
    await release({ loginId: login.loginId })
  }
  // Normal paste-code login still succeeds and releases its slot.
  const login = await start()
  assert.equal((await submit({ code: '', loginId: login.loginId })).terminal, false)
  const pending = submit({ code: ' pasted-code ', loginId: login.loginId })
  assert.deepEqual(stdinWrites, ['pasted-code\n'])
  child.stdout.emit('data', 'Logged in successfully')
  child.emit('close', 0)
  assert.equal((await pending).success, true)
  assert.equal((await submit({ code: 'again' })).error, 'no active login session')

  // Cancel waits for process close before the host is allowed to roll back.
  const cancelled = await start()
  let closed = false
  child.kill = () => {
    setImmediate(() => { closed = true; child.emit('close', null) })
  }
  assert.equal((await cancel({ loginId: cancelled.loginId, deferRelease: true })).cancelled, true)
  assert.equal(closed, true)
  assert.equal((await start()).error, 'auth_in_progress')
  await release({ loginId: cancelled.loginId })
} finally {
  await release({})
  childProcess.spawn = originalSpawn
  syncBuiltinESMExports()
  if (originalBin === undefined) delete process.env.BAT_SIDECAR_CLAUDE_BIN
  else process.env.BAT_SIDECAR_CLAUDE_BIN = originalBin
}

console.log('claude-auth-login: passed')
