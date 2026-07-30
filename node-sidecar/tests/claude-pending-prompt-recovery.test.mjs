// Tests that a prompt the agent is blocked on can be recovered.
//
// claude:ask-user and claude:permission-request are announced exactly once and
// are never re-sent, but the turn stays parked on an unresolved promise until
// someone answers. The renderer subscribes to those events from inside the
// agent panel, and panels are mounted lazily — only the active terminal plus a
// two-entry LRU, starting empty on every launch. So a question asked while its
// panel was not mounted used to be unanswerable forever: the timeline showed it
// (replayed from history) with no card to click, and the turn hung.
//
// getSessionState is the recovery path, so what is pinned here is that a
// pending prompt survives into it *with its payload*, and that answering it
// from there still resolves the real promise.
//
// Run with: pnpm exec node node-sidecar/tests/claude-pending-prompt-recovery.test.mjs

import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { dispatch } = await import('../src/server.mjs')
const { buildCanUseTool } = await import('../src/handlers/claude-permission.mjs')
const { sessions, ensureSession } = await import('../src/lib/state.mjs')

let nextRequestId = 1
function send(method, params) {
  return dispatch({ jsonrpc: '2.0', id: nextRequestId++, method, params })
}

function seedSession(sessionId, cwd, permissionMode = 'default') {
  const s = ensureSession(sessionId)
  s.options = { cwd }
  s.active = true
  s.permissionMode = permissionMode
  return s
}

const cwd = mkdtempSync(join(tmpdir(), 'bat-pending-prompt-'))
let failures = 0

async function check(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    failures += 1
    console.error(`FAIL - ${name}\n  ${err?.message || err}`)
  }
}

const QUESTIONS = [{
  question: 'Where should the internal project group live?',
  header: 'Group level',
  multiSelect: false,
  options: [
    { label: 'Workspace', description: 'Visible to everyone in the workspace' },
    { label: 'Personal', description: 'Only you can see it' },
  ],
}]

try {
  await check('a pending AskUserQuestion is recoverable from session state, options included', async () => {
    const sessionId = 'pending-ask'
    const s = seedSession(sessionId, cwd)
    try {
      // Blocks until answered — exactly the promise the turn is parked on.
      const decision = buildCanUseTool(s, sessionId, 'AskUserQuestion', { questions: QUESTIONS }, { toolUseID: 'ask-tool-1' })

      const state = await send('claude.getSessionState', { sessionId })
      const pending = state.result?.pendingAskUser
      assert.ok(pending, 'session state must report the prompt the turn is blocked on')
      assert.equal(pending.toolUseId, 'ask-tool-1')
      // The options are the whole point: without them the card renders a
      // question nobody can answer.
      assert.deepEqual(pending.questions, QUESTIONS)

      // Answering from the recovered payload has to resolve the real promise.
      const resolved = await send('claude.resolveAskUser', {
        sessionId, toolUseId: 'ask-tool-1', answers: { [QUESTIONS[0].question]: 'Workspace' },
      })
      assert.equal(resolved.result, true)
      const result = await decision
      assert.equal(result.behavior, 'allow')
      // The SDK uses updatedInput as the tool's effective input, so the
      // original questions must still be in there alongside the answers.
      assert.deepEqual(result.updatedInput.questions, QUESTIONS)
      assert.deepEqual(result.updatedInput.answers, { [QUESTIONS[0].question]: 'Workspace' })

      const after = await send('claude.getSessionState', { sessionId })
      assert.equal(after.result?.pendingAskUser, null, 'an answered prompt must stop being reported')
    } finally {
      sessions.delete(sessionId)
    }
  })

  await check('a pending permission request is recoverable with the payload the event carried', async () => {
    const sessionId = 'pending-perm'
    const s = seedSession(sessionId, cwd)
    try {
      const input = { command: 'rm -rf build' }
      const decision = buildCanUseTool(s, sessionId, 'Bash', input, {
        toolUseID: 'perm-tool-1',
        suggestions: ['allow once'],
        decisionReason: 'Deletes a directory',
      })

      const state = await send('claude.getSessionState', { sessionId })
      const pending = state.result?.pendingPermission
      assert.ok(pending, 'session state must report the permission the turn is blocked on')
      assert.equal(pending.toolUseId, 'perm-tool-1')
      assert.equal(pending.toolName, 'Bash')
      assert.deepEqual(pending.input, input)
      assert.deepEqual(pending.suggestions, ['allow once'])
      assert.equal(pending.decisionReason, 'Deletes a directory')

      const resolved = await send('claude.resolvePermission', {
        sessionId, toolUseId: 'perm-tool-1', result: { behavior: 'allow', updatedInput: input },
      })
      assert.equal(resolved.result, true)
      assert.equal((await decision).behavior, 'allow')

      const after = await send('claude.getSessionState', { sessionId })
      assert.equal(after.result?.pendingPermission, null, 'an answered permission must stop being reported')
    } finally {
      sessions.delete(sessionId)
    }
  })

  await check('a session blocked on nothing reports no pending prompt', async () => {
    const sessionId = 'pending-none'
    seedSession(sessionId, cwd)
    try {
      const state = await send('claude.getSessionState', { sessionId })
      assert.equal(state.result?.pendingAskUser, null)
      assert.equal(state.result?.pendingPermission, null)
    } finally {
      sessions.delete(sessionId)
    }
  })

  // bypassPermissions skips the permission UI entirely, but AskUserQuestion is
  // checked ahead of every mode — it is the agent asking a question, not asking
  // for authority — so it must still be recoverable there.
  await check('bypassPermissions still surfaces a recoverable AskUserQuestion', async () => {
    const sessionId = 'pending-bypass'
    const s = seedSession(sessionId, cwd, 'bypassPermissions')
    try {
      buildCanUseTool(s, sessionId, 'AskUserQuestion', { questions: QUESTIONS }, { toolUseID: 'ask-bypass-1' })
      const state = await send('claude.getSessionState', { sessionId })
      assert.equal(state.result?.pendingAskUser?.toolUseId, 'ask-bypass-1')
      assert.deepEqual(state.result?.pendingAskUser?.questions, QUESTIONS)
    } finally {
      sessions.delete(sessionId)
    }
  })
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nclaude-pending-prompt-recovery: all tests passed')
