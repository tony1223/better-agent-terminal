import assert from 'node:assert/strict'
import {
  BAT_CONTEXT_TRANSFER_MARKER,
  buildClaudeToCodexContext,
  redactTransferSecrets,
  buildTranscriptHandoffPrompt,
  codexPermissionsForClaudeHandoff,
  type TranscriptSnapshot,
} from '../renderer/src/utils/agent-context-transfer'

assert.deepEqual(codexPermissionsForClaudeHandoff('bypassPermissions'), {
  sandboxMode: 'danger-full-access', approvalPolicy: 'never',
}, 'handoff preserves the source session\'s unrestricted permissions')
for (const mode of ['default', 'auto', 'acceptEdits', 'dontAsk', 'plan', 'bypassPlan', 'unknown']) {
  assert.deepEqual(codexPermissionsForClaudeHandoff(mode), {
    sandboxMode: 'workspace-write', approvalPolicy: 'on-request',
  }, `${mode} must not grant unrestricted access during handoff`)
}

const redacted = redactTransferSecrets([
  'Authorization: Bearer abcdef123456',
  'api_key=super-secret-value',
  'token sk-ant-abcdefghijklmnop',
].join('\n'))
assert.equal(redacted.count, 3)
assert.doesNotMatch(redacted.text, /abcdef123456|super-secret-value|sk-ant-/)

const result = buildClaudeToCodexContext({
  sourceSessionId: 'bat-source',
  sourceSdkSessionId: 'claude-source',
  cwd: 'C:/repo',
  gitRoot: 'C:/repo',
  gitBranch: 'feature/context-transfer\n```malicious markdown',
  gitStatus: [{ status: 'M', file: 'src/app.ts' }],
  gitDiff: 'diff --git a/src/app.ts b/src/app.ts\n+const changed = true',
  exportedAt: Date.UTC(2026, 7, 28, 4, 0, 0),
  messages: [
    { id: 'u1', sessionId: 'bat-source', role: 'user', content: 'Continue the migration', timestamp: 1 },
    { id: 'thinking', sessionId: 'bat-source', role: 'assistant', content: 'Visible answer', thinking: 'private reasoning', timestamp: 2 },
    { id: 'tool', sessionId: 'bat-source', toolName: 'Bash', input: { command: 'echo secret' }, status: 'completed', result: 'secret tool result', timestamp: 3 },
    { id: 'sys', sessionId: 'bat-source', role: 'system', content: 'private system instruction', timestamp: 4 },
  ],
})

assert.ok(result.markdown.startsWith(BAT_CONTEXT_TRANSFER_MARKER))
assert.match(result.markdown, /Continue the migration/)
assert.match(result.markdown, /Visible answer/)
assert.match(result.markdown, /src\/app\.ts/)
assert.doesNotMatch(result.markdown, /private reasoning|secret tool result|private system instruction|echo secret/)
assert.doesNotMatch(result.markdown, /Git branch:.*\n```malicious/)
assert.equal(result.includedMessages, 2)
assert.equal(result.omittedMessages, 0)

const longResult = buildClaudeToCodexContext({
  sourceSessionId: 'bat-source',
  cwd: '/repo',
  gitDiff: 'x'.repeat(40_000),
  messages: Array.from({ length: 40 }, (_, index) => ({
    id: `u${index}`,
    sessionId: 'bat-source',
    role: 'user' as const,
    content: `message ${index}`,
    timestamp: index,
  })),
})
assert.equal(longResult.includedMessages, 30)
assert.equal(longResult.omittedMessages, 10)
assert.equal(longResult.truncated, true)
assert.ok(longResult.markdown.length <= 64_000)

const conversationBudgetResult = buildClaudeToCodexContext({
  sourceSessionId: 'bat-source',
  cwd: '/repo',
  messages: Array.from({ length: 30 }, (_, index) => ({
    id: `large-${index}`,
    sessionId: 'bat-source',
    role: 'user' as const,
    content: `${index}: ${'z'.repeat(3_990)}`,
    timestamp: index,
  })),
})
assert.ok(conversationBudgetResult.includedMessages < 30)
assert.match(conversationBudgetResult.markdown, /"content": "29: z+/)
assert.doesNotMatch(conversationBudgetResult.markdown, /"content": "0: z+/)

const snapshot: TranscriptSnapshot = {
  sourceSessionId: 'bat-source', sourceSdkSessionId: 'claude-source',
  cwd: 'C:\\workspace with spaces', path: 'C:\\app data\\transcript-handoffs\\snapshot\\transcript.jsonl',
  exportedAt: '2026-09-05T00:00:00.000Z', recordCount: 200, bytes: 1_000_000,
  skippedLines: 1, omittedBlocks: 2, redactionCount: 3,
  latestUserMessage: 'Continue ```\nthis task', latestUserMessageTruncated: false,
}
const prompt = buildTranscriptHandoffPrompt(snapshot)
const metadata = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)![1])
assert.deepEqual(metadata, snapshot, 'paths and user text survive quoting and markdown delimiters')
assert.ok(prompt.length < 10_000, 'handoff embeds an entry point, not the transcript or full diff')
assert.match(prompt, /Do not modify files during this verification turn/)
assert.match(prompt, /If the file cannot be read/)
assert.match(prompt, /last interrupted operation already completed/)

console.log('agent-context-transfer: passed')
