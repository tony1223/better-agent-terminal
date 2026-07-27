// canUseTool implementation + permission/ask-user resolution handlers.
// Called from claude.sendMessage (queryOptions.canUseTool); the renderer
// answers the surfaced events via claude.resolvePermission /
// claude.resolveAskUser.

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { sessions } from '../lib/state.mjs'

// Tools that acceptEdits mode auto-approves without surfacing a UI prompt.
// Mirror of electron/claude-agent-manager.ts:793.
export const ACCEPT_EDITS_AUTO_APPROVED_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep'])

// canUseTool implementation. Returns either an immediate decision
// (`{behavior:'allow'|'deny', ...}`) or a Promise that resolves when the
// renderer answers the permission-request / ask-user event. The
// per-mode auto-approval logic mirrors Electron exactly so users see
// the same prompts/auto-approvals across hosts.
export function buildCanUseTool(session, sessionId, toolName, input, opts) {
  const toolUseId = opts?.toolUseID
  // AskUserQuestion is a special pseudo-tool the SDK uses to ask the
  // user follow-up questions during a turn. Always surface UI for it.
  if (toolName === 'AskUserQuestion') {
    return new Promise((resolve) => {
      if (toolUseId) session.pendingAskUser.set(toolUseId, { resolve, input })
      sendEvent('claude:ask-user', {
        sessionId,
        data: { toolUseId, questions: input?.questions },
      })
    })
  }
  // bypassPlan: auto-approve everything except ExitPlanMode (which
  // requires explicit confirmation to switch to bypass execution).
  if (session.permissionMode === 'bypassPlan') {
    if (toolName === 'ExitPlanMode') {
      return new Promise((resolve) => {
        if (toolUseId) {
          session.pendingPermissions.set(toolUseId, {
            resolve: (result) => {
              if (result?.behavior === 'allow') {
                session.permissionMode = 'bypassPermissions'
                sendEvent('claude:modeChange', { sessionId, mode: 'bypassPermissions' })
              }
              resolve(result)
            },
          })
        }
        sendEvent('claude:permission-request', {
          sessionId,
          data: {
            toolUseId, toolName, input,
            suggestions: opts?.suggestions,
            decisionReason: 'Exit plan mode and switch to bypass execution?',
          },
        })
      })
    }
    return { behavior: 'allow', updatedInput: input || {} }
  }
  // bypassPermissions auto-allows everything. UI is bypassed entirely.
  if (session.permissionMode === 'bypassPermissions') {
    return { behavior: 'allow', updatedInput: input || {} }
  }
  // dontAsk is bypassPermissions' mirror image: never prompt, and deny anything
  // not already pre-approved. Anything reaching us here was not pre-approved by
  // definition — the CLI answers from its own rules first and only calls back for
  // what it could not decide — so the answer is no. Falling through to the prompt
  // below would turn "don't ask me" into a stream of questions.
  if (session.permissionMode === 'dontAsk') {
    return {
      behavior: 'deny',
      message: `${toolName} is not pre-approved and permission mode is dontAsk.`,
    }
  }
  // acceptEdits auto-allows safe file/read tools; everything else still
  // prompts.
  if (session.permissionMode === 'acceptEdits' && ACCEPT_EDITS_AUTO_APPROVED_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: input || {} }
  }
  // default / acceptEdits-not-listed / plan / auto: surface UI and await user.
  //
  // auto belongs here rather than in a branch of its own. Its classifier runs
  // inside Claude Code, ahead of this callback, and only escalates what it will
  // not decide on its own; those escalations are exactly the prompts a human
  // should see. Adding an auto-allow here would delete the safety net that is the
  // entire reason to pick auto over bypassPermissions.
  return new Promise((resolve) => {
    const wrappedResolve = toolName === 'ExitPlanMode'
      ? (result) => {
          if (result?.behavior === 'allow') {
            // dontAskAgain → acceptEdits, otherwise default. Matches
            // Electron's exit-plan UX.
            session.permissionMode = result.dontAskAgain ? 'acceptEdits' : 'default'
            sendEvent('claude:modeChange', { sessionId, mode: session.permissionMode })
          }
          resolve(result)
        }
      : resolve
    if (toolUseId) session.pendingPermissions.set(toolUseId, { resolve: wrappedResolve })
    sendEvent('claude:permission-request', {
      sessionId,
      data: {
        toolUseId, toolName, input,
        suggestions: opts?.suggestions,
        decisionReason: opts?.decisionReason,
      },
    })
  })
}

// Renderer-side resolution for an outstanding permission request. Looks
// up the pending entry by toolUseId, calls its resolve fn, and emits a
// `claude:permission-resolved` notification so panels can clear their UI.
registerHandler('claude.resolvePermission', async (params) => {
  const sessionId = params?.sessionId
  const toolUseId = params?.toolUseId
  const result = params?.result
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof toolUseId !== 'string' || !toolUseId) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  const pending = session.pendingPermissions.get(toolUseId)
  // Re-broadcast the dismiss even when the entry is already gone: another
  // window (host or remote client) may have answered first, and this lets the
  // still-open prompt on every other window close. Idempotent — the renderer
  // scopes the dismiss to the matching toolUseId.
  if (!pending) {
    sendEvent('claude:permission-resolved', { sessionId, toolUseId })
    return false
  }
  session.pendingPermissions.delete(toolUseId)
  try { pending.resolve(result) } catch { /* swallow — caller already gave up */ }
  sendEvent('claude:permission-resolved', { sessionId, toolUseId })
  return true
})

registerHandler('claude.resolveAskUser', async (params) => {
  const sessionId = params?.sessionId
  const toolUseId = params?.toolUseId
  const answers = params?.answers
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof toolUseId !== 'string' || !toolUseId) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  const pending = session.pendingAskUser.get(toolUseId)
  // Re-broadcast the dismiss even when the entry is already gone: another
  // window (host or remote client) may have answered first, and this lets the
  // still-open prompt on every other window close. Idempotent — the renderer
  // scopes the dismiss to the matching toolUseId.
  if (!pending) {
    sendEvent('claude:ask-user-resolved', { sessionId, toolUseId })
    return false
  }
  session.pendingAskUser.delete(toolUseId)
  // AskUserQuestion expects a PermissionResult with behavior 'allow' and
  // updatedInput containing the original questions plus answers. The SDK
  // uses updatedInput as the tool's effective input, so dropping `questions`
  // makes the built-in tool implementation crash, and resolving with the bare
  // answers map fails the SDK's PermissionResult schema validation.
  try {
    pending.resolve({
      behavior: 'allow',
      updatedInput: { ...(pending.input ?? {}), answers },
    })
  } catch { /* swallow */ }
  sendEvent('claude:ask-user-resolved', { sessionId, toolUseId })
  return true
})
