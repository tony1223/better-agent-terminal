import * as assert from 'node:assert/strict'

const calls: { command: string; params: unknown }[] = []
let reply: unknown = { ok: true, sessionId: 's', sdkSessionId: 'kept', deferred: true }
let failure: Error | null = null
;(globalThis as any).window = { __TAURI_INTERNALS__: { invoke: async (command: string, params: unknown) => {
  calls.push({ command, params })
  if (command === 'claude_reload_session') {
    if (failure) throw failure
    return reply
  }
  return false
} } }
async function run() {
const { requestSessionReload } = await import('../renderer/src/utils/session-reload')
assert.deepEqual(await requestSessionReload('s'), reply)
assert.deepEqual(calls.filter(call => call.command.startsWith('claude_')), [
  { command: 'claude_reload_session', params: { sessionId: 's' } },
])
assert.ok(!calls.some(call => /send_message|reset_session|start_session/.test(call.command)))
for (const invalid of [null, true, { ok: false }, { ok: true, sessionId: 'other', deferred: false }, { ok: true, sessionId: 's' }]) {
  reply = invalid
  await assert.rejects(requestSessionReload('s'), /did not confirm/)
}
failure = new Error('Session is already reloading')
await assert.rejects(requestSessionReload('s'), /already reloading/)
failure = new Error('method not found')
await assert.rejects(requestSessionReload('s'), /method not found/)
console.log('session reload adapter: canonical IPC, acknowledgement validation and host errors passed')

}
run().catch(error => { console.error(error); process.exitCode = 1 })
