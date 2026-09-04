import * as assert from 'assert'
import { summarizeInterruptedTurn } from '../renderer/src/utils/interrupted-turn'

function main() {
  const items = [
    { id: 'u0', timestamp: 1, role: 'user' as const, content: 'earlier prompt' },
    { id: 'a0', timestamp: 2, role: 'assistant' as const, content: 'earlier reply' },
    { id: 'u1', timestamp: 3, role: 'user' as const, content: '## Fix the **build** please' },
    { id: 't1', timestamp: 4, toolName: 'Read', input: { file_path: 'src/a.ts' }, status: 'completed' },
    { id: 'a1', timestamp: 5, role: 'assistant' as const, content: 'Found the bug in a.ts.' },
    { id: 't2', timestamp: 6, toolName: 'Edit', input: { file_path: 'src/a.ts' }, status: 'completed' },
    { id: 't3', timestamp: 7, toolName: 'Bash', input: { command: 'pnpm test' }, status: 'completed' },
    { id: 't4', timestamp: 8, toolName: 'Bash', input: { command: 'pnpm run compile' }, status: 'running' },
  ]
  const summary = summarizeInterruptedTurn(items)
  assert.equal(summary.prompt, 'Fix the build please')
  assert.equal(summary.toolCount, 4)
  assert.deepEqual(summary.lastTools, ['Edit: src/a.ts', 'Bash: pnpm test', 'Bash: pnpm run compile'])
  assert.equal(summary.lastReply, 'Found the bug in a.ts.')
  assert.equal(summary.unfinishedTools, 1)

  // Compaction summaries and auto-continue messages are not the user's prompt.
  const withCompact = [
    { id: 'u1', timestamp: 1, role: 'user' as const, content: 'real prompt' },
    { id: 'c1', timestamp: 2, role: 'user' as const, content: 'compact summary', isCompactSummary: true },
    { id: 'ac', timestamp: 3, role: 'user' as const, content: 'continue', kind: 'auto-continue' },
    { id: 't1', timestamp: 4, toolName: 'Grep', input: { pattern: 'foo' }, status: 'completed' },
  ]
  const s2 = summarizeInterruptedTurn(withCompact)
  assert.equal(s2.prompt, 'real prompt')
  assert.equal(s2.toolCount, 1)
  assert.deepEqual(s2.lastTools, ['Grep: foo'])
  assert.equal(s2.lastReply, '')

  // No user message at all: everything counts as the turn.
  const s3 = summarizeInterruptedTurn([{ id: 'a', timestamp: 1, role: 'assistant' as const, content: 'hi' }])
  assert.equal(s3.prompt, '')
  assert.equal(s3.lastReply, 'hi')
  assert.equal(summarizeInterruptedTurn([]).toolCount, 0)

  console.log('interrupted-turn tests passed')
}

main()
