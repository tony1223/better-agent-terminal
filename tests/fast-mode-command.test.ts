import * as assert from 'node:assert/strict'

async function main() {
  let debug = false
  let response: unknown = { fastMode: true, fastModeState: 'pending' }
  let hostError: Error | null = null
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const order: string[] = []
  ;(globalThis as any).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === 'debug_is_debug_mode') return false
        if (command === 'claude_set_fast_mode') {
          calls.push({ command, args })
          order.push('setFastMode')
          if (hostError) throw hostError
          return response
        }
        return null
      },
    },
    localStorage: { getItem: (key: string) => key === 'BAT_DEBUG' && debug ? '1' : null },
  }
  const { settingsStore } = await import('../renderer/src/stores/settings-store')
  const { executeBatFastCommand: execute, parseBatFastCommand: parse } = await import('../renderer/src/utils/fast-mode-command')
  const pending = { current: false }
  const options = {
    sessionId: 'session-1', available: true, busy: false, pending,
    ensureSessionStarted: async () => { order.push('start') },
  }

  assert.equal(parse('/bat-fast on'), 'on')
  assert.equal(parse('  /bat-fast\tOFF  '), 'off')
  for (const text of ['/bat-fast', '/bat-fast toggle', '/bat-fast on off', '/bat-fast on\nwrite code']) {
    assert.equal(parse(text), 'usage')
  }
  for (const text of ['write /bat-fast on', '/bat-fastest on', '/fast off', '']) assert.equal(parse(text), null)
  assert.match(await execute('usage', options), /Usage:/)
  assert.match(await execute('on', options), /BAT_DEBUG/)
  debug = true
  assert.match(await execute('on', options), /settings first/)
  assert.deepEqual(order, [], 'invalid syntax or missing opt-in must not start a session or invoke the paid setting')

  await settingsStore.setAllowFastMode(true)
  assert.match(await execute('on', { ...options, available: false }), /unavailable/)
  assert.match(await execute('on', { ...options, busy: true }), /current turn/)
  assert.match(await execute('off', { ...options, busy: true }), /current turn/)
  assert.equal(calls.length, 0)

  const requested = await execute('on', options)
  assert.match(requested, /requested/)
  assert.doesNotMatch(requested, /enabled/, 'a pending host response must not claim confirmed provider activation')
  assert.deepEqual(order, ['start', 'setFastMode'])
  assert.deepEqual(calls[0].args, { sessionId: 'session-1', enabled: true })
  assert.equal(pending.current, false)

  await settingsStore.setAllowFastMode(false)
  response = { fastMode: false }
  assert.match(await execute('off', options), /disabled/)
  assert.deepEqual(calls.at(-1)?.args, { sessionId: 'session-1', enabled: false })
  const callsBeforeDisabled = calls.length
  assert.match(await execute('on', options), /settings first/)
  assert.equal(calls.length, callsBeforeDisabled)

  await settingsStore.setAllowFastMode(true)
  response = { fastMode: true, fastModeState: 'on' }
  assert.match(await execute('on', options), /enabled/)
  response = { fastMode: true, fastModeState: 'cooldown' }
  assert.match(await execute('on', options), /standard speed during cooldown/)
  response = { fastMode: false, fastModeDisabledReason: 'Account does not allow Fast' }
  assert.match(await execute('on', options), /failed: Account does not allow Fast/)
  response = null
  assert.match(await execute('on', options), /unavailable on this host/)
  hostError = new Error('This model does not support Fast mode.')
  assert.match(await execute('on', options), /failed: This model does not support/)
  assert.equal(pending.current, false)
  hostError = null

  const callsBeforeStartupError = calls.length
  assert.match(await execute('on', { ...options, ensureSessionStarted: async () => { throw new Error('Session startup failed') } }), /Session startup failed/)
  assert.equal(calls.length, callsBeforeStartupError)
  assert.equal(pending.current, false)

  let finishStartup!: () => void
  const startup = new Promise<void>(resolve => { finishStartup = resolve })
  response = { fastMode: true, fastModeState: 'pending' }
  const first = execute('on', { ...options, ensureSessionStarted: () => startup })
  const callsBeforeDuplicate = calls.length
  assert.match(await execute('off', options), /already in progress/)
  assert.equal(calls.length, callsBeforeDuplicate, 'overlapping commands must not race session initialization or toggles')
  finishStartup()
  assert.match(await first, /requested/)
  assert.equal(calls.length, callsBeforeDuplicate + 1)
  assert.equal(pending.current, false)

  const callsBeforeRevocation = calls.length
  assert.match(await execute('on', {
    ...options,
    ensureSessionStarted: async () => {
      await settingsStore.setAllowFastMode(false)
      await settingsStore.setAllowFastMode(true)
    },
  }), /settings changed/)
  assert.equal(calls.length, callsBeforeRevocation, 'revoking and reopening the global gate must not revive an older pending opt-in')
  assert.equal(pending.current, false)

  debug = false
  assert.match(await execute('on', options), /BAT_DEBUG/)
  assert.ok(calls.every(call => call.command === 'claude_set_fast_mode'), 'control commands must never invoke sendMessage')
  console.log('Fast mode commands: syntax, opt-in, busy state, host acknowledgement, errors and overlapping commands passed')
}

main().catch(error => { console.error(error); process.exit(1) })
