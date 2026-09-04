import * as assert from 'assert'
import { readFileSync } from 'fs'
import {
  computeBellBadge,
  describePendingAction,
  formatBadgeCount,
  summarizeResult,
  unreadCompletionIds,
  workspaceHasUnreadCompletion,
} from '../renderer/src/utils/attention'

function main() {
  // summarizeResult: one short prose line, markdown decoration stripped.
  assert.equal(summarizeResult(undefined), '')
  assert.equal(summarizeResult('## Done\n\n- fixed **3** tests\n- run `pnpm test`'), 'Done fixed 3 tests run pnpm test')
  assert.equal(summarizeResult('```sh\nrm -rf dist\n```\nCleaned build output'), 'Cleaned build output')
  const long = summarizeResult('a'.repeat(100))
  assert.equal(long.length, 41)
  assert.ok(long.endsWith('…'))
  assert.equal(summarizeResult('短句不截斷'), '短句不截斷')

  // describePendingAction: command for Bash, file for edits, header for questions.
  assert.equal(
    describePendingAction({ toolName: 'Bash', input: { command: 'rm -rf dist', description: 'Clean' } }, null),
    'Bash: rm -rf dist',
  )
  assert.equal(
    describePendingAction({ toolName: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x' } }, null),
    'Edit: src/a.ts',
  )
  assert.equal(describePendingAction({ toolName: 'ExitPlanMode', input: {} }, null), 'ExitPlanMode')
  assert.equal(
    describePendingAction(null, { questions: [{ header: 'Auth method', question: 'Which one?' }] }),
    'Auth method',
  )
  assert.equal(describePendingAction(null, { questions: [] }), 'Question')
  assert.equal(describePendingAction(null, null), null)

  // Unread completions per workspace ignore read entries and remote-client rows.
  const entries = [
    { id: 'n1', read: false, workspaceId: 'ws-a' },
    { id: 'n2', read: true, workspaceId: 'ws-a' },
    { id: 'n3', read: false, workspaceId: 'ws-b' },
    { id: 'n4', read: false, kind: 'remote-client' },
  ]
  assert.equal(workspaceHasUnreadCompletion(entries, 'ws-a'), true)
  assert.equal(workspaceHasUnreadCompletion(entries, 'ws-c'), false)
  assert.deepEqual(unreadCompletionIds(entries, 'ws-a'), ['n1'])

  // Bell badge precedence: red (pending) > green (unread) > gray (running) > none.
  assert.deepEqual(computeBellBadge({ pending: 1, unread: 2, running: 3 }), { count: 3, tone: 'red' })
  assert.deepEqual(computeBellBadge({ pending: 0, unread: 2, running: 3 }), { count: 2, tone: 'green' })
  assert.deepEqual(computeBellBadge({ pending: 0, unread: 0, running: 3 }), { count: 3, tone: 'gray' })
  assert.equal(computeBellBadge({ pending: 0, unread: 0, running: 0 }), null)
  assert.equal(formatBadgeCount(120), '99+')
  assert.equal(formatBadgeCount(7), '7')

  // The sidebar dot must know about unread completions and the bell must
  // render the result summary + approve affordance.
  const indicator = readFileSync('renderer/src/components/ActivityIndicator.tsx', 'utf8')
  assert.ok(indicator.includes('workspaceHasUnreadCompletion'), 'ActivityIndicator should derive the unread state from the notification store')
  assert.ok(/unread/.test(indicator), 'ActivityIndicator should expose an unread class')
  const css = readFileSync('renderer/src/styles/notifications.css', 'utf8')
  assert.ok(css.includes('.activity-indicator.unread'), 'notifications.css should style the unread dot')
  const bell = readFileSync('renderer/src/components/NotificationBell.tsx', 'utf8')
  assert.ok(bell.includes('computeBellBadge'), 'NotificationBell should use the shared badge precedence')
  assert.ok(bell.includes('summarizeResult'), 'NotificationBell should show the result summary line')
  assert.ok(bell.includes('bat:approve-pending'), 'NotificationBell should be able to approve a pending permission')
  for (const panel of ['ClaudeAgentPanel', 'CodexAgentPanel']) {
    const src = readFileSync(`renderer/src/components/${panel}.tsx`, 'utf8')
    assert.ok(src.includes('bat:approve-pending'), `${panel} should listen for approve requests from the bell`)
    assert.ok(src.includes('describePendingAction'), `${panel} should publish a pending-action label`)
  }

  console.log('attention-list tests passed')
}

main()
