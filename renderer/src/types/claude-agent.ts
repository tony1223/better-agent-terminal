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
}

export interface ClaudeSessionState {
  sessionId: string
  messages: (ClaudeMessage | ClaudeToolCall)[]
  isStreaming: boolean
  streamingText?: string
  streamingThinking?: string
  totalCost?: number
  totalTokens?: number
}

// Discriminator helper
function isRecord(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === 'object'
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
