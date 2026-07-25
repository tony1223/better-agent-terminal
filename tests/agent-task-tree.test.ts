import * as assert from 'node:assert/strict'
import {
  buildAgentTaskTree,
  findAgentNode,
  formatAgentNodeElapsed,
  formatTaskClock,
  isTerminalTaskStatus,
  lastStreamLine,
  summarizeAgentTree,
  terminateLifecycleEntries,
  type AgentTaskNode,
  type TaskLifecycle,
} from '../renderer/src/lib/agent-task-tree.ts'
import type { ClaudeMessage, ClaudeToolCall } from '../renderer/src/types/claude-agent.ts'

type MessageItem = ClaudeMessage | ClaudeToolCall

const tool = (overrides: Partial<ClaudeToolCall> & { id: string }): ClaudeToolCall => ({
  sessionId: 's1',
  toolName: 'Task',
  input: {},
  status: 'running',
  timestamp: 1000,
  ...overrides,
})

const msg = (overrides: Partial<ClaudeMessage> & { id: string }): ClaudeMessage => ({
  sessionId: 's1',
  role: 'assistant',
  content: 'hi',
  timestamp: 1000,
  ...overrides,
} as ClaudeMessage)

// --- Roots: top-level Task/Agent/Workflow tool calls, completed ones kept ---
{
  const messages: MessageItem[] = [
    msg({ id: 'm1' }),
    tool({ id: 't1', toolName: 'Task', input: { description: 'store-persistence audit', subagent_type: 'Explore' }, status: 'completed' }),
    tool({ id: 't2', toolName: 'Agent', input: { description: 'routing-renderer audit' }, status: 'running' }),
    tool({ id: 'w1', toolName: 'Workflow', input: {}, status: 'running' }),
    tool({ id: 'b1', toolName: 'Bash', input: { command: 'ls' }, status: 'completed' }),
  ]
  const roots = buildAgentTaskTree(messages, new Map())
  assert.equal(roots.length, 3)
  assert.deepEqual(roots.map(r => r.id), ['t1', 't2', 'w1'])
  assert.equal(roots[0].status, 'completed')
  assert.equal(roots[0].label, 'store-persistence audit')
  assert.equal(roots[0].subagentType, 'Explore')
  assert.equal(roots[1].status, 'running')
  assert.equal(roots[2].kind, 'workflow')
}

// --- Nesting: subagent buckets produce children, recursively ---
{
  const messages: MessageItem[] = [
    tool({ id: 'root', input: { description: 'parent task' } }),
  ]
  const buckets = new Map<string, MessageItem[]>([
    ['root', [
      msg({ id: 'sm1', parentToolUseId: 'root', timestamp: 1100 } as Partial<ClaudeMessage> & { id: string }),
      tool({ id: 'child', parentToolUseId: 'root', input: { description: 'nested task' }, timestamp: 1200 }),
      tool({ id: 'grep', parentToolUseId: 'root', toolName: 'Grep', input: {}, timestamp: 1300 }),
    ]],
    ['child', [
      tool({ id: 'grandchild', parentToolUseId: 'child', input: { description: 'deep task' }, timestamp: 1400 }),
    ]],
  ])
  const roots = buildAgentTaskTree(messages, buckets)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].children.length, 1)
  assert.equal(roots[0].children[0].id, 'child')
  assert.equal(roots[0].children[0].children[0].id, 'grandchild')
}

// --- Finished nodes get an approximate endTimestamp from bucket activity ---
{
  const messages: MessageItem[] = [
    tool({ id: 'done', input: { description: 'finished' }, status: 'completed', timestamp: 1000 }),
  ]
  const buckets = new Map<string, MessageItem[]>([
    ['done', [
      msg({ id: 'a', parentToolUseId: 'done', timestamp: 5000 } as Partial<ClaudeMessage> & { id: string }),
      msg({ id: 'b', parentToolUseId: 'done', timestamp: 9000 } as Partial<ClaudeMessage> & { id: string }),
    ]],
  ])
  const roots = buildAgentTaskTree(messages, buckets)
  assert.equal(roots[0].endTimestamp, 9000)
  // Running nodes do not get one.
  const running = buildAgentTaskTree([tool({ id: 'done', input: {}, status: 'running' })], buckets)
  assert.equal(running[0].endTimestamp, undefined)
}

// --- Lifecycle merge: workflow metadata + terminal error statuses ---
{
  const messages: MessageItem[] = [
    tool({ id: 'wf-tool', toolName: 'Workflow', input: {}, status: 'running' }),
  ]
  const lifecycle = new Map<string, TaskLifecycle>([
    ['wf-tool', { id: 'wf-tool', isWorkflow: true, workflowName: 'audit-sweep', description: 'Verify phase', status: 'running' }],
    ['bg-1', { id: 'bg-1', isWorkflow: true, workflowName: 'background-run', status: 'failed', error: 'boom', startedAt: 2000 }],
  ])
  const roots = buildAgentTaskTree(messages, new Map(), lifecycle)
  assert.equal(roots.length, 2)
  const wf = roots.find(r => r.id === 'wf-tool')!
  assert.equal(wf.workflowName, 'audit-sweep')
  assert.equal(wf.progressText, 'Verify phase')
  assert.equal(wf.label, 'audit-sweep')
  const bg = roots.find(r => r.id === 'bg-1')!
  assert.equal(bg.status, 'error')
  assert.equal(bg.error, 'boom')
  assert.equal(bg.kind, 'workflow')
  assert.equal(bg.timestamp, 2000)
}

// --- Lifecycle terminal error overrides a stuck-running tool block ---
{
  const messages: MessageItem[] = [
    tool({ id: 'k1', input: { description: 'killed run' }, status: 'running' }),
  ]
  const lifecycle = new Map<string, TaskLifecycle>([
    ['k1', { id: 'k1', status: 'killed' }],
  ])
  const roots = buildAgentTaskTree(messages, new Map(), lifecycle)
  assert.equal(roots[0].status, 'error')
}

// --- Cycle guard: malformed buckets must not loop forever ---
{
  const messages: MessageItem[] = [tool({ id: 'a', input: {} })]
  const buckets = new Map<string, MessageItem[]>([
    ['a', [tool({ id: 'b', parentToolUseId: 'a', input: {} })]],
    ['b', [tool({ id: 'a', parentToolUseId: 'b', input: {} })]],
  ])
  const roots = buildAgentTaskTree(messages, buckets)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].children.length, 1)
  assert.equal(roots[0].children[0].children.length, 0)
}

// --- run_in_background flag surfaces ---
{
  const roots = buildAgentTaskTree([
    tool({ id: 'bg', input: { description: 'bg agent', run_in_background: true } }),
  ], new Map())
  assert.equal(roots[0].isBackground, true)
}

// --- Summary counts ---
{
  const roots = buildAgentTaskTree([
    tool({ id: '1', input: {}, status: 'running' }),
    tool({ id: '2', input: {}, status: 'completed' }),
    tool({ id: '3', input: {}, status: 'error' }),
  ], new Map<string, MessageItem[]>([
    ['1', [tool({ id: '1c', parentToolUseId: '1', input: {}, status: 'running' })]],
  ]))
  const summary = summarizeAgentTree(roots)
  assert.deepEqual(summary, { running: 2, completed: 1, error: 1, total: 4 })
}

// --- toolUseId binding: lifecycle entries decorate their tool node instead
// --- of duplicating it as an orphan root (denied-agent ghost regression) ---
{
  const messages: MessageItem[] = [
    // The denied Agent call: tool_result error arrived, no task event ever will.
    tool({ id: 'toolu_1', toolName: 'Agent', input: { description: 'map sdk integration', subagent_type: 'Explore' }, status: 'error' }),
  ]
  const lifecycle = new Map<string, TaskLifecycle>([
    // SDK task_started bound via tool_use_id, stuck on 'running' forever.
    ['task_a', { id: 'task_a', toolUseId: 'toolu_1', description: 'map sdk integration', subagentType: 'Explore', status: 'running', startedAt: 500 }],
  ])
  const roots = buildAgentTaskTree(messages, new Map(), lifecycle)
  assert.equal(roots.length, 1, 'bound lifecycle entry must not become a second root')
  assert.equal(roots[0].id, 'toolu_1')
  assert.equal(roots[0].status, 'error')
  // Decoration still flows from the bound entry.
  assert.equal(roots[0].progressText, 'map sdk integration')
}

// --- toolUseId binding also suppresses orphan roots for nested agents ---
{
  const messages: MessageItem[] = [tool({ id: 'root', input: { description: 'parent' } })]
  const buckets = new Map<string, MessageItem[]>([
    ['root', [tool({ id: 'toolu_child', parentToolUseId: 'root', input: { description: 'nested' } })]],
  ])
  const lifecycle = new Map<string, TaskLifecycle>([
    ['task_c', { id: 'task_c', toolUseId: 'toolu_child', status: 'running' }],
  ])
  const roots = buildAgentTaskTree(messages, buckets, lifecycle)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].children.length, 1)
}

// --- Lifecycle 'completed' also overrides a stuck-running tool block ---
{
  const messages: MessageItem[] = [
    tool({ id: 'c1', input: { description: 'done run' }, status: 'running' }),
  ]
  const lifecycle = new Map<string, TaskLifecycle>([
    ['c1', { id: 'c1', status: 'completed' }],
  ])
  const roots = buildAgentTaskTree(messages, new Map(), lifecycle)
  assert.equal(roots[0].status, 'completed')
}

// --- Unbound lifecycle entries still become roots (background workflows) ---
{
  const lifecycle = new Map<string, TaskLifecycle>([
    ['bg_wf', { id: 'bg_wf', isWorkflow: true, workflowName: 'sweep', status: 'running', isBackground: true }],
  ])
  const roots = buildAgentTaskTree([], new Map(), lifecycle)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].isBackground, true)
}

// --- terminateLifecycleEntries: flips matching non-terminal entries only ---
{
  const entries = new Map<string, TaskLifecycle>([
    ['a', { id: 'a', toolUseId: 'toolu_a', status: 'running' }],
    ['b', { id: 'b', status: 'completed' }],
    ['c', { id: 'c', status: 'running' }],
  ])
  const swept = terminateLifecycleEntries(entries, () => true, 'killed')
  assert.notEqual(swept, entries)
  assert.equal(swept.get('a')!.status, 'killed')
  assert.equal(swept.get('b')!.status, 'completed', 'terminal entries are preserved')
  assert.equal(swept.get('c')!.status, 'killed')

  const byToolUse = terminateLifecycleEntries(entries, life => life.toolUseId === 'toolu_a', 'failed')
  assert.equal(byToolUse.get('a')!.status, 'failed')
  assert.equal(byToolUse.get('c')!.status, 'running', 'non-matching entries untouched')

  // No matches → same reference so React state setters skip the re-render.
  const untouched = terminateLifecycleEntries(entries, life => life.id === 'missing', 'killed')
  assert.equal(untouched, entries)
}

// --- isTerminalTaskStatus ---
{
  for (const s of ['completed', 'failed', 'killed', 'error']) assert.equal(isTerminalTaskStatus(s), true, s)
  for (const s of ['running', 'pending', 'paused', undefined, null]) assert.equal(isTerminalTaskStatus(s), false, String(s))
}

// --- lastStreamLine ---
{
  assert.equal(lastStreamLine(undefined), '')
  assert.equal(lastStreamLine('one\ntwo\n\n  '), 'two')
  assert.equal(lastStreamLine('x'.repeat(200), 10), `…${'x'.repeat(10)}`)
}

// --- findAgentNode: the detail view resolves nodes at any depth, because a
// --- nested agent's tool block never reaches the main message list ---
{
  const messages: MessageItem[] = [tool({ id: 'root', input: { description: 'parent' } })]
  const buckets = new Map<string, MessageItem[]>([
    ['root', [tool({ id: 'child', parentToolUseId: 'root', input: { description: 'nested' } })]],
    ['child', [tool({ id: 'grandchild', parentToolUseId: 'child', input: { description: 'deep' } })]],
  ])
  const roots = buildAgentTaskTree(messages, buckets)
  assert.equal(findAgentNode(roots, 'root')!.label, 'parent')
  assert.equal(findAgentNode(roots, 'child')!.label, 'nested')
  assert.equal(findAgentNode(roots, 'grandchild')!.label, 'deep')
  assert.equal(findAgentNode(roots, 'missing'), null)
  assert.equal(findAgentNode([], 'root'), null)
}

// --- formatAgentNodeElapsed: live clock while running, measured span once done ---
{
  const node = (over: Partial<AgentTaskNode>): AgentTaskNode => ({
    id: 'n', kind: 'task', label: 'n', status: 'running', timestamp: 0, children: [], ...over,
  })
  const now = 100_000
  assert.equal(formatAgentNodeElapsed(node({ timestamp: now - 95_000 }), now), '1:35')
  assert.equal(
    formatAgentNodeElapsed(node({ status: 'completed', timestamp: 1000, endTimestamp: 175_000 }), now),
    '2:54',
  )
  // Unknown span (lifecycle-only node, or an end that predates the start).
  assert.equal(formatAgentNodeElapsed(node({ status: 'completed', timestamp: 0 }), now), '')
  assert.equal(formatAgentNodeElapsed(node({ status: 'completed', timestamp: 5000 }), now), '')
  assert.equal(formatAgentNodeElapsed(node({ status: 'error', timestamp: 5000, endTimestamp: 4000 }), now), '')
  // A clock never runs backwards even if the tree is a tick ahead of `now`.
  assert.equal(formatAgentNodeElapsed(node({ timestamp: now + 5000 }), now), '0:00')
  assert.equal(formatTaskClock(0), '0:00')
  assert.equal(formatTaskClock(3_599_000), '59:59')
}

console.log('agent task tree regression: passed')
