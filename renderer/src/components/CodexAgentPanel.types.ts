import type { ClaudeMessage, ClaudeToolCall } from '../types/claude-agent'

export interface SessionMeta {
  model?: string
  sdkSessionId?: string
  cwd?: string
  totalCost: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  numTurns: number
  contextWindow: number
  maxOutputTokens?: number
  contextTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  callCacheRead?: number
  callCacheWrite?: number
  lastQueryCalls?: number
  permissionMode?: string
  effort?: string
  codexSandboxMode?: string
  codexApprovalPolicy?: string
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  lastTurnFirstTokenMs?: number
  lastTurnDurationMs?: number
  isStreaming?: boolean
  runtimeStatus?: 'starting' | 'queued' | 'waiting_for_api' | 'compacting' | string | null
  runtimeMessage?: string | null
  runtimeStatusStartedAt?: number | null
}

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  source?: 'builtin' | 'sdk'
}

export interface PendingPermission {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  decisionReason?: string
}

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: Array<{ label: string; description: string; preview?: string }>
  multiSelect: boolean
}

export interface PendingAskUser {
  toolUseId: string
  questions: AskUserQuestion[]
}

export interface SessionSummary {
  sdkSessionId: string
  timestamp: number
  preview: string
  messageCount: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  createdAt?: number
  summary?: string
}

export interface CodexAccountEntry {
  id: string
  label?: string
  email?: string
  codexHome: string
  authenticated?: boolean
  active?: boolean
  unified?: boolean
  needsLogin?: boolean
  lastAuthError?: string
}

export interface CodexAgentPanelProps {
  sessionId: string
  cwd: string
  isActive: boolean
  workspaceId?: string
  onClose?: (id: string) => void
  showUserMsg?: boolean
  showAssistantMsg?: boolean
  showToolMsg?: boolean
  showThinkingMsg?: boolean
  isRemoteConnected?: boolean
  onRequestLogin?: (kind: 'claude' | 'codex') => void
}

export interface AttachedImage {
  path: string
  dataUrl: string
}

export interface AttachedFile {
  path: string
  name: string
}

export type MessageItem = ClaudeMessage | ClaudeToolCall
