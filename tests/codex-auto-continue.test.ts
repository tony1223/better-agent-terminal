import * as assert from 'assert'
import {
  autoContinueTurnEndKey,
  buildCollapsedOutputPreview,
  isCybersecurityFlagTurnEnd,
  shouldAutoContinueForTrigger,
  shouldAutoContinueAfterTurnEnd,
  stringifyToolResult,
  summarizeShellCommand,
} from '../renderer/src/components/CodexAgentPanel.helpers.ts'

assert.strictEqual(
  shouldAutoContinueAfterTurnEnd({ reason: 'completed' }),
  true,
  'completed turns should auto-continue'
)

assert.strictEqual(
  shouldAutoContinueAfterTurnEnd({
    reason: 'error',
    error: 'Codex: no response from model after 300s. Please try again.',
  }),
  true,
  'Codex idle timeout should auto-continue'
)

assert.strictEqual(
  shouldAutoContinueAfterTurnEnd({
    reason: 'error',
    error: 'Codex error: something else failed',
  }),
  false,
  'generic errors should not auto-continue'
)

assert.strictEqual(
  shouldAutoContinueAfterTurnEnd({ reason: 'aborted' }),
  false,
  'aborted turns should not auto-continue'
)

const cybersecurityFlag = {
  reason: 'completed',
  result: 'Error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.',
}
assert.strictEqual(
  isCybersecurityFlagTurnEnd(cybersecurityFlag),
  true,
  'the known cybersecurity refusal should be detected'
)
assert.strictEqual(
  shouldAutoContinueForTrigger('cybersecurity-flag', cybersecurityFlag),
  true,
  '/sac should retry the known cybersecurity refusal'
)
assert.strictEqual(
  isCybersecurityFlagTurnEnd({
    reason: 'error',
    error: 'This content was flagged for possible cybersecurity risk. To get authorized for security work, join the Trusted Access for Cyber program.',
  }),
  true,
  'the refusal should also be detected when Codex reports it as an error'
)
assert.strictEqual(
  shouldAutoContinueForTrigger('cybersecurity-flag', { reason: 'completed', result: 'Task completed normally.' }),
  false,
  '/sac should not continue normal completed turns'
)
assert.strictEqual(
  isCybersecurityFlagTurnEnd({
    reason: 'completed',
    result: 'I can explain the message "This content was flagged for possible cybersecurity risk" without retrying.',
  }),
  false,
  'mentioning the refusal inside a normal response should not trigger /sac'
)

assert.strictEqual(
  autoContinueTurnEndKey({ reason: 'completed', turnId: 'turn-1', result: 'done' }, 'fallback-1'),
  autoContinueTurnEndKey({ reason: 'completed', turnId: 'turn-1', result: 'done' }, 'fallback-2'),
  'turn ids should make auto-continue dedupe independent of renderer fallback ids'
)

assert.notStrictEqual(
  autoContinueTurnEndKey({ reason: 'completed', result: 'done' }, 'fallback-1'),
  autoContinueTurnEndKey({ reason: 'completed', result: 'done' }, 'fallback-2'),
  'fallback ids should distinguish turn-end events when the runtime provides no turn id'
)

assert.strictEqual(
  summarizeShellCommand('/bin/zsh -lc "sed -n \'1,80p\' renderer/src/components/WorkspaceView.tsx && sed -n \'700,820p\' renderer/src/components/WorkspaceView.tsx"'),
  'read renderer/src/components/WorkspaceView.tsx:1-80 + read renderer/src/components/WorkspaceView.tsx:700-820',
  'shell read commands should get a file-range summary'
)

assert.deepStrictEqual(
  buildCollapsedOutputPreview('\n\nimport a\nconst b = 1\n\nfunction c() {}\nexport default c\nignored\n'),
  ['import a', 'const b = 1', 'function c() {}', 'export default c'],
  'collapsed output preview should show multiple meaningful lines'
)

assert.strictEqual(
  stringifyToolResult({ status: 'ok', count: 2 }),
  '{\n  "status": "ok",\n  "count": 2\n}',
  'object tool results should render as JSON instead of [object Object]'
)

console.log('Codex auto-continue timeout support: passed')
