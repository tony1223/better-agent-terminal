import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { BoundedSeenIds, mergeHistoryMessages } from '../renderer/src/utils/message-dedupe'
import { normalizeMessageItems } from '../renderer/src/types/claude-agent'

// Execute the production callback with an isolated host and renderer state.
// No substitute paging implementation: changes to the panel run here directly.
const source = ts.createSourceFile('ClaudeAgentPanel.tsx', readFileSync('renderer/src/components/ClaudeAgentPanel.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let callback: ts.Expression | undefined
function find(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'navigateHistory'
    && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]
  ts.forEachChild(node, find)
}
find(source)
assert.ok(callback)
const executable = ts.transpileModule(`globalThis.navigate = ${callback.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
const row = (id: string) => ({ id, sessionId: 'session-a', role: 'assistant', content: id, timestamp: 1 })

function fixture(resume: (...args: unknown[]) => Promise<unknown>) {
  const state: Record<string, any> = {
    sessionId: 'session-a', cwd: '/repo', historyBefore: 1000, historyPageCursors: [], historyPageItems: [], historyPageError: null,
    historyPageRequestRef: { current: null }, archiveRevisionRef: { current: 0 }, followOutputRef: { current: true }, messagesContainerRef: { current: { scrollTop: 90 } },
    seenMessageIds: new BoundedSeenIds(), normalizeMessageItems, mergeHistoryMessages, formatUnknownError: String, formatError: String,
    workspaceStore: { getState: () => ({ terminals: [{ id: 'session-a', sdkSessionId: 'sdk-a' }] }) },
    host: { claude: { clientResume: resume }, debug: { log() {} } }, requestAnimationFrame: (fn: () => void) => fn(),
    scrolls: 0,
  }
  for (const key of ['HistoryBefore', 'HistoryPageCursors', 'HistoryPageItems', 'HistoryPageError', 'IsLoadingHistoryPage']) {
    const field = key[0].toLowerCase() + key.slice(1)
    state[`set${key}`] = (value: any) => { state[field] = typeof value === 'function' ? value(state[field]) : value }
  }
  state.scrollToBottomAfterRender = () => { state.scrolls++ }
  vm.runInNewContext(executable, state)
  return state as typeof state & { navigate: (direction: 'older' | 'newer' | 'latest') => Promise<void> }
}

test('older/newer/latest navigation keeps one readable page without writing to live history', async () => {
  const calls: unknown[][] = []
  const state = fixture(async (...args) => {
    calls.push(args)
    return args[14] === 1000 ? { items: [row('older')], before: 500 } : { items: [row('oldest')], before: null }
  })
  await state.navigate('older')
  assert.equal(state.historyPageItems[0].id, 'older')
  assert.equal(state.historyBefore, 500)
  assert.equal(calls[0][0], 'session-a')
  assert.equal(calls[0][1], 'sdk-a')
  assert.equal(calls[0][14], 1000)
  assert.equal(state.followOutputRef.current, false)
  await state.navigate('older')
  assert.equal(state.historyPageItems.length, 1)
  assert.equal(state.historyPageItems[0].id, 'oldest')
  assert.equal(state.historyBefore, null)
  await state.navigate('newer')
  assert.equal(state.historyPageItems[0].id, 'older')
  assert.equal(state.historyBefore, 500)
  await state.navigate('latest')
  assert.equal(state.historyPageItems.length, 0)
  assert.equal(state.historyBefore, 1000)
  assert.equal(state.historyPageCursors.length, 0)
  assert.equal(state.followOutputRef.current, true)
  assert.equal(state.scrolls, 1)
})

test('a reset cancels stale page results and overlapping clicks share one request', async () => {
  let complete!: (value: unknown) => void
  let calls = 0
  const state = fixture(() => { calls++; return new Promise(resolve => { complete = resolve }) })
  const pending = state.navigate('older')
  await state.navigate('older')
  assert.equal(calls, 1)
  state.archiveRevisionRef.current++
  state.historyPageRequestRef.current = null
  complete({ items: [row('stale')], before: 500 })
  await pending
  assert.equal(state.historyPageItems.length, 0)
  assert.equal(state.historyBefore, 1000)
})

test('a page failure retains its cursor for retry and stays scoped to the session', async () => {
  let calls = 0
  const state = fixture(async () => {
    if (++calls === 1) throw new Error('history unavailable')
    return { items: [row('recovered')], before: null }
  })
  await state.navigate('older')
  assert.match(state.historyPageError, /history unavailable/)
  assert.equal(state.historyBefore, 1000)
  assert.equal(state.historyPageRequestRef.current, null)
  await state.navigate('older')
  assert.equal(state.historyPageItems[0].id, 'recovered')
  assert.equal(state.historyPageError, null)
})
