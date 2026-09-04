// Tests for when claude.sendMessage answers.
//
// The RPC used to resolve only when the turn ended, which conflated "the host
// has your prompt" with "the agent is finished". A turn outliving the host's
// 300s request deadline therefore looked like a failed send, and a remote
// client's message stayed ghosted for the whole turn. It now resolves on
// receipt and lets claude:* events carry the outcome.
//
// Resolving early is only safe because everything that can go wrong *before*
// the prompt reaches the SDK still comes back on the reply — a queued send Esc
// cancelled, a missing cwd, a stopped session. Those are pinned here too,
// because losing them is the way this change would break silently: the
// renderer restores the user's typed text from the cancelled reply, and retries
// a send after a runtime restart from the no-cwd one.
//
// Run with: pnpm exec node node-sidecar/tests/claude-send-ack.test.mjs

import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { dispatch } = await import('../src/server.mjs')
const { __setSdkOverrideForTests } = await import('../src/lib/sdk-loader.mjs')
const { sessions, ensureSession } = await import('../src/lib/state.mjs')

let nextRequestId = 1
function send(method, params) {
  return dispatch({ jsonrpc: '2.0', id: nextRequestId++, method, params })
}

// A fake SDK whose turn hangs until the test releases it, so "did the reply
// arrive before the turn ended?" is a question we can actually ask.
function fakeSdk() {
  const state = {
    pushed: [],
    resultYielded: false,
    release: null,
    releasedOnInterrupt: false,
  }
  const sdk = {
    state,
    query({ prompt }) {
      const generator = (async function* run() {
        for await (const userMessage of prompt) {
          state.pushed.push(userMessage)
          await new Promise(resolve => { state.release = resolve })
          state.resultYielded = true
          yield {
            type: 'result',
            subtype: 'success',
            result: 'done',
            session_id: 'fake-sdk-session',
            duration_ms: 1,
            num_turns: 1,
            is_error: false,
          }
        }
      })()
      // The SDK's turn-only interrupt ends the turn; mimic that by letting the
      // held turn produce its result frame.
      generator.interrupt = async () => {
        state.releasedOnInterrupt = true
        state.release?.()
      }
      return generator
    },
  }
  return sdk
}

// A reply that waits for the turn cannot arrive at all here, because the turn
// only ends when the test releases it after reading the reply. Time out instead
// of hanging, so the regression names itself rather than surfacing as node's
// "unsettled top-level await".
// The timer is deliberately left referenced: an unref'd one lets node decide
// there is no pending work and exit with that same opaque warning before the
// deadline can fire. It is cleared as soon as either side settles.
function withinDeadline(promise, what, ms = 5000) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

function seedSession(sessionId, cwd) {
  const s = ensureSession(sessionId)
  s.options = { cwd }
  s.active = true
  return s
}

const cwd = mkdtempSync(join(tmpdir(), 'bat-send-ack-'))
let failures = 0

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch(err => {
      failures += 1
      console.error(`FAIL - ${name}\n  ${err?.message || err}`)
    })
}

try {
  // 1. The reply lands while the turn is still running. This is the whole
  //    point of the split: the assertion is not "it resolved" but "it resolved
  //    before the SDK produced a result frame".
  await check('sendMessage acknowledges receipt while the turn is still running', async () => {
    const sdk = fakeSdk()
    __setSdkOverrideForTests(sdk)
    const sessionId = 'ack-during-turn'
    seedSession(sessionId, cwd)
    try {
      const reply = await withinDeadline(
        send('claude.sendMessage', { sessionId, prompt: 'hello', suppressUserEcho: true }),
        'sendMessage reply',
      )
      assert.equal(reply.error, undefined, `unexpected RPC error: ${JSON.stringify(reply.error)}`)
      assert.deepEqual(reply.result, { ok: true, accepted: true, queued: false })
      assert.equal(sdk.state.pushed.length, 1, 'the prompt should have reached the SDK')
      assert.equal(sdk.state.resultYielded, false, 'reply must not wait for the turn to finish')
      // Let the turn finish so it does not leak into later cases.
      sdk.state.release?.()
    } finally {
      sessions.delete(sessionId)
      __setSdkOverrideForTests(undefined)
    }
  })

  // 2. A send that never reaches the SDK still reports on the reply. Esc marks
  //    the queued send cancelled; the renderer reads that to put the user's
  //    text back in the input box, so it cannot become event-only.
  await check('a queued send cancelled by Esc still reports cancelled on the reply', async () => {
    const sdk = fakeSdk()
    __setSdkOverrideForTests(sdk)
    const sessionId = 'cancel-while-queued'
    seedSession(sessionId, cwd)
    try {
      const first = await withinDeadline(
        send('claude.sendMessage', { sessionId, prompt: 'first', suppressUserEcho: true }),
        'first sendMessage reply',
      )
      assert.equal(first.result?.accepted, true, 'first send should be accepted')

      // Second send arrives mid-turn, so it queues behind the live one.
      const secondReply = send('claude.sendMessage', { sessionId, prompt: 'second', suppressUserEcho: true })
      const interrupted = await send('claude.interruptTurn', { sessionId })
      assert.equal(interrupted.result?.ok, true, `interruptTurn failed: ${JSON.stringify(interrupted.result)}`)
      assert.equal(sdk.state.releasedOnInterrupt, true, 'interrupt should have ended the live turn')

      const second = await withinDeadline(secondReply, 'queued sendMessage reply')
      assert.equal(second.error, undefined, `unexpected RPC error: ${JSON.stringify(second.error)}`)
      assert.deepEqual(second.result, { ok: false, cancelled: true })
      assert.equal(sdk.state.pushed.length, 1, 'the cancelled prompt must never reach the SDK')
    } finally {
      sessions.delete(sessionId)
      __setSdkOverrideForTests(undefined)
    }
  })

  // 3. The no-cwd error is what the renderer matches to re-establish a session
  //    after the runtime restarted underneath it and retry the send once.
  await check('a session with no cwd still fails the reply so the renderer can recover', async () => {
    const sessionId = 'no-cwd'
    ensureSession(sessionId).options = null
    try {
      const reply = await send('claude.sendMessage', { sessionId, prompt: 'hello', suppressUserEcho: true })
      const message = reply.error?.message || reply.result?.error || ''
      assert.match(message, /session has no cwd/i)
    } finally {
      sessions.delete(sessionId)
    }
  })

  // 3b. A cwd that does not exist on this host must name the folder, not the
  //     SDK's "native binary failed to launch" (a spawn ENOENT on the cwd).
  //     Runs against the real SDK loader (no override) because the check only
  //     guards a real spawn and stands down for test-injected SDKs.
  await check('a session whose cwd is missing on this host reports the folder', async () => {
    const sessionId = 'cwd-missing-on-host'
    seedSession(sessionId, join(cwd, 'not-on-this-machine'))
    try {
      const reply = await send('claude.sendMessage', { sessionId, prompt: 'hello', suppressUserEcho: true })
      const message = reply.error?.message || reply.result?.error || ''
      assert.match(message, /workspace folder not found on this host/i)
      assert.match(message, /not-on-this-machine/)
    } finally {
      sessions.delete(sessionId)
    }
  })

  // 4. Without a usable SDK the stub reply is produced before any push, so it
  //    stays on the reply rather than being replaced by an ack.
  await check('the SDK-unavailable stub still answers on the reply', async () => {
    __setSdkOverrideForTests(null)
    const sessionId = 'stub-reply'
    seedSession(sessionId, cwd)
    try {
      const reply = await send('claude.sendMessage', { sessionId, prompt: 'hello', suppressUserEcho: true })
      assert.equal(reply.error, undefined, `unexpected RPC error: ${JSON.stringify(reply.error)}`)
      assert.deepEqual(reply.result, { ok: true, stub: true })
    } finally {
      sessions.delete(sessionId)
      __setSdkOverrideForTests(undefined)
    }
  })
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nclaude-send-ack: all tests passed')
