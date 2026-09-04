export interface ClaudeMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  kind?: 'auto-continue' | 'stale-turn-warning'
  autoContinue?: {
    used: number
    max: number
    prompt: string
    trigger?: 'always' | 'cybersecurity-flag'
  }
  thinking?: string
  parentToolUseId?: string
  timestamp: number
  // Optimistic-send lifecycle for locally-echoed user messages over the remote
  // protocol: 'sending' (ghosted) until the host acks via invoke-result or
  // echoes the message back, then 'sent' (solid); 'failed' on a real send
  // error. Absent = confirmed / host-originated / local-mode message.
  status?: 'sending' | 'sent' | 'failed'
  // The SDK's context-compaction summary, replayed as a user turn. A real
  // prompt, but nothing the human wrote, so the timeline folds it shut.
  isCompactSummary?: boolean
}

export interface ClaudeToolCall {
  id: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'error'
  result?: string
  description?: string
  denyReason?: string
  denied?: boolean
  isDeferred?: boolean
  parentToolUseId?: string
  timestamp: number
  // Set by the renderer when the terminal result lands; drives the elapsed chip.
  completedAt?: number
}

export interface ClaudeSessionState {
  sessionId: string
  messages: (ClaudeMessage | ClaudeToolCall)[]
  isStreaming: boolean
  streamingText?: string
  streamingThinking?: string
  totalCost?: number
  totalTokens?: number
  // A prompt the agent is currently blocked on, echoing the payload of the
  // claude:ask-user / claude:permission-request event that announced it. Those
  // events fire once, so this is the only way a panel that was not listening at
  // the time can find out it owes the agent an answer.
  pendingAskUser?: unknown
  pendingPermission?: unknown
}

// Discriminator helper
function isRecord(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === 'object' && !Array.isArray(item)
}

export function isToolCall(item: unknown): item is ClaudeToolCall {
  return isRecord(item) && typeof item.toolName === 'string'
}

export function isClaudeMessage(item: unknown): item is ClaudeMessage {
  return isRecord(item) && !isToolCall(item) && typeof item.role === 'string' && 'content' in item
}

export function isMessageItem(item: unknown): item is ClaudeMessage | ClaudeToolCall {
  return isToolCall(item) || isClaudeMessage(item)
}

/**
 * Runtime payloads can come from an older remote host or a persisted archive,
 * so their shape is not guaranteed by the renderer's TypeScript interfaces.
 * Keep otherwise usable tool rows, but make their input safe for consumers
 * that read fields such as `description`, `command`, or `file_path`.
 */
export function normalizeMessageItem(item: unknown): ClaudeMessage | ClaudeToolCall | null {
  if (isToolCall(item)) {
    const input = isRecord(item.input) ? item.input : {}
    return input === item.input ? item : { ...item, input }
  }
  return isClaudeMessage(item) ? item : null
}

export function normalizeMessageItems(items: unknown): (ClaudeMessage | ClaudeToolCall)[] {
  if (!Array.isArray(items)) return []
  const normalized: (ClaudeMessage | ClaudeToolCall)[] = []
  for (const item of items) {
    const message = normalizeMessageItem(item)
    if (message) normalized.push(message)
  }
  return normalized
}
