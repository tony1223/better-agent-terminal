import { host, isTauri } from '../host-api'
import { useState, useEffect, useRef, useCallback, useMemo, Fragment, cloneElement, isValidElement, memo } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ClaudeMessage, ClaudeToolCall } from '../types/claude-agent'
import { isMessageItem, isToolCall } from '../types/claude-agent'
import type { CodexApprovalPolicy, CodexSandboxMode } from '../types'
import { CLAUDE_EFFORT_MODES, CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES, EFFORT_LEVELS, effortLevelForClaudeMode, isUltracodeEffortMode } from '../types'
import { normalizeAgentParams } from '../types/agent-profiles'
import { settingsStore, useSettings } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import { shallowEqual } from '../stores/use-store'
import { getAgentPreset, type AgentPresetId } from '../types/agent-presets'
import { LinkedText, FilePreviewModal } from './PathLinker'
import { ChatMarkdown } from './ChatMarkdown'
import { WorktreeMergedChip } from './WorktreeMergedChip'
import { buildMessageStream } from './messageSkip'
import { filenameForPastedImage, maybeResizeImageDataUrl, readFileAsDataUrl } from '../utils/file-data-url'
import { extractInterruptedContinuation } from '../utils/interrupted-prompt'
import { isTauriNativeDropInside, listenTauriNativeDrop } from '../utils/tauri-native-drop'
import { useRemoteDropUpload } from '../utils/remote-drop-upload'
import { RemoteUploadConfirmDialog } from './RemoteUploadConfirmDialog'
import { getHostUsageSnapshot, rateLimitsFromHostUsage, subscribeHostUsage } from '../utils/claude-usage-cache'
import { autoCompactWindowForClaudeSelection, claudeModelValueForRow, displayNameForClaudeSelection, groupClaudeModelRows, normalizeClaudeModelSelection, pickClaudeModelOption, sdkModelForClaudeSelection, type ClaudeCompactWindow } from '../utils/claude-model-presets'
import { shouldNavigateInputHistoryFromTextarea } from '../utils/input-history-navigation'
import { buildSnippetContextPrompt, parseSnippetSlashCommand, type SnippetForContext } from '../utils/snippet-command'
import { filterSlashCommands, flattenSlashGroups, groupSlashCommands, mergeSlashCommands, type SlashCommandInfo } from '../utils/slash-commands'
import { PERMISSION_MODES, PERMISSION_MODE_LABELS, normalizePermissionMode } from '../utils/permission-modes'
import { createToolRenderCache, getOrComputeToolRender, pruneToolRenderCache } from '../utils/tool-result-cache'
import { useRafBatchedString } from '../utils/use-raf-batched-string'
import { translateRuntimeMessage } from '../utils/runtime-status-message'
import { agentSendResultError, isMissingSessionCwdError } from '../utils/agent-send-recovery'
import { dispatchWorkerCommand, parseWorkerSlashCommand } from '../utils/worker-command'
import { buildCollapsedOutputPreview, formatContentSize, parseShellInvocation, stringifyToolResult, summarizeToolCommandInput, summarizeToolSearchResult, toolRowLayout, truncateMiddle } from './CodexAgentPanel.helpers'
import { AgentToolRow } from './AgentToolRow'
import { buildAskUserQnA, formatAskUserPrompt, normalizePendingAskUser, summarizeAskUserInput, wrapPreviewHtml } from './AskUserQuestion.helpers'
import { AgentAskUserQnA } from './AgentAskUserQnA'
import { AgentActivityTree } from './AgentActivityTree'
import { buildAgentTaskTree, findAgentNode, formatAgentNodeElapsed, summarizeAgentTree, terminateLifecycleEntries, type TaskLifecycle } from '../lib/agent-task-tree'
import { usePanelActivation, usePanelActiveEffect, type PanelActivation } from '../utils/panel-activation'
import { prepareFilePickerResults, type FilePickerSearchEntry } from '../utils/file-picker-search'

interface SessionMeta {
  model?: string
  sdkSessionId?: string
  cwd?: string
  totalCost: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  numTurns: number
  contextWindow: number
  autoCompactWindow?: number
  maxOutputTokens?: number
  contextTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  callCacheRead?: number
  callCacheWrite?: number
  lastQueryCalls?: number
  // Lifetime sums over every API request of the session. inputTokens /
  // outputTokens above describe only the last request (the context window).
  totalInputTokens?: number
  totalOutputTokens?: number
  permissionMode?: string
  effort?: string
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  lastTurnFirstTokenMs?: number
  lastTurnDurationMs?: number
  isStreaming?: boolean
  runtimeStatus?: 'starting' | 'queued' | 'waiting_for_api' | 'reconnecting' | 'compacting' | string | null
  runtimeMessage?: string | null
  runtimeStatusStartedAt?: number | null
}

interface ModelInfo {
  value: string
  displayName: string
  description: string
  source?: 'builtin' | 'sdk'
}

const getAutoCompactWindowForModel = (model: string | undefined, fallback?: number | null): number | null =>
  autoCompactWindowForClaudeSelection(model, fallback)

function clearRuntimeStatusMeta(meta: SessionMeta | null): SessionMeta | null {
  if (!meta?.runtimeStatus && !meta?.runtimeMessage && !meta?.runtimeStatusStartedAt) return meta
  host.debug.log(`[Claude] clearRuntimeStatusMeta: clearing runtimeStatus=${meta?.runtimeStatus ?? 'null'} startedAt=${meta?.runtimeStatusStartedAt ?? 'null'}`)
  return { ...meta, runtimeStatus: null, runtimeMessage: null, runtimeStatusStartedAt: null }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isAgentSessionCollision(message: string): boolean {
  return message.includes('BAT_AGENT_SESSION_COLLISION')
}

// The host caps the claude.sendMessage RPC at SESSION_TIMEOUT (~5 min). Hosts
// that ack on receipt no longer hit that for a long turn, but two cases still
// can: a host older than that split (which replies only at turn end), and a
// send sitting in the queue behind a turn that itself runs past the deadline.
// Either way the timeout does NOT mean the send failed — the turn is alive on
// the host and streaming over claude:* events, completing on claude:turn-end.
// Treat it as non-fatal so we don't stop the UI mid-turn. The remote path
// surfaces the same situation as "Remote invoke timeout: agent:send-message"
// (the remote client's per-invoke deadline), so treat that the same way.
function isSendMessageTimeout(message: string): boolean {
  return /timeout waiting for claude\.sendMessage/i.test(message)
    || /Remote invoke timeout:\s*(agent|claude):send-message/i.test(message)
}

// The remote client dropped (idle socket reaped) before this invoke reached the
// host. The message never left this machine, so we restore the user's text and
// let the app's background auto-reconnect re-establish the session rather than
// surfacing the raw "remote.invoke: not connected to remote server" string.
function isRemoteDisconnectedError(message: string): boolean {
  return /not connected to remote server|remote\.invoke: connection closed/i.test(message)
}

function runtimeWaitingMessage(t: TFunction, meta: SessionMeta | null, isStreaming: boolean, now: number): string | null {
  if (!isStreaming || !meta?.runtimeStatus) return null
  const startedAt = typeof meta.runtimeStatusStartedAt === 'number' ? meta.runtimeStatusStartedAt : now
  const elapsedMs = Math.max(0, now - startedAt)
  const elapsed = elapsedMs >= 1000 ? ` (${Math.floor(elapsedMs / 1000)}s)` : ''
  const translated = translateRuntimeMessage(t, meta.runtimeMessage)
  if (meta.runtimeStatus === 'compacting') {
    return `${translated || t('claude.runtimeStatus.compacting')}${elapsed}`
  }
  if (meta.runtimeStatus === 'waiting_for_api' && elapsedMs >= 8000) {
    return `${translated || t('claude.runtimeStatus.waiting')}${elapsed}`
  }
  if (meta.runtimeStatus === 'starting' && elapsedMs >= 8000) {
    return `${translated || t('claude.runtimeStatus.preparing')}${elapsed}`
  }
  if (meta.runtimeStatus === 'queued') {
    return `${translated || t('claude.runtimeStatus.queued')}${elapsed}`
  }
  if (meta.runtimeStatus === 'reconnecting') {
    return `${translated || t('claude.runtimeStatus.reconnecting')}${elapsed}`
  }
  return null
}

interface PendingPermission {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  decisionReason?: string
}

interface AskUserQuestion {
  question: string
  header: string
  options: Array<{ label: string; description: string; preview?: string }>
  multiSelect: boolean
}

interface PendingAskUser {
  toolUseId: string
  questions: AskUserQuestion[]
}

interface SessionSummary {
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

type ResumeSessionResult = {
  ok?: boolean
  stale?: boolean
  sdkSessionId?: string
  requestedSdkSessionId?: string
}

export interface ClaudeAgentPanelProps {
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
  targetAgent?: 'claude' | 'codex'
  onRequestLogin?: (kind: 'claude' | 'codex') => void
}

interface AttachedImage {
  path: string
  dataUrl: string
}

interface AttachedFile {
  path: string
  name: string
}

type MessageItem = ClaudeMessage | ClaudeToolCall

// Track sessions that have been started to prevent duplicate calls across
// StrictMode remounts. Real window/profile remounts must be allowed to resume
// again, so unmounts schedule a delayed cleanup that StrictMode's immediate
// remount can cancel.
const startedSessions = new Set<string>()
const startedSessionCleanupTimers = new Map<string, number>()
const startedSessionPromises = new Map<string, Promise<void>>()

function clearStartedSessionTracking(sessionId: string): void {
  startedSessions.delete(sessionId)
  startedSessionPromises.delete(sessionId)
}

function cancelStartedSessionCleanup(sessionId: string): void {
  const timer = startedSessionCleanupTimers.get(sessionId)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    startedSessionCleanupTimers.delete(sessionId)
  }
}

function scheduleStartedSessionCleanup(sessionId: string): void {
  cancelStartedSessionCleanup(sessionId)
  const timer = window.setTimeout(() => {
    clearStartedSessionTracking(sessionId)
    startedSessionCleanupTimers.delete(sessionId)
  }, 1000)
  startedSessionCleanupTimers.set(sessionId, timer)
}

function scheduleAgentMetadataRefresh(callback: () => void): () => void {
  if (!isTauri()) {
    callback()
    return () => {}
  }
  const timer = window.setTimeout(callback, 1500)
  return () => window.clearTimeout(timer)
}

function waitForTauriAgentListeners(): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  return new Promise(resolve => window.setTimeout(resolve, 75))
}

function includeCurrentOption(values: readonly string[], current: string): string[] {
  const filtered = values.filter(value => typeof value === 'string' && value.length > 0)
  return current && !filtered.includes(current) ? [current, ...filtered] : filtered
}

// The mode a session should come back in. It used to live only in panel state,
// so every resume silently restarted at bypassPermissions no matter what the
// user had picked — a session parked in `plan` came back able to write (GH #124).
function restoredPermissionMode(sessionId: string): string {
  return normalizePermissionMode(
    workspaceStore.getState().terminals.find(t => t.id === sessionId)?.permissionMode
  )
}

// Mode changes arrive from three directions: the user cycling the button, the
// sidecar echoing what Claude Code actually adopted, and ExitPlanMode
// transitions. All three write through, or the persisted value drifts from the
// live one and resume restores a mode the session was never in.
function rememberPermissionMode(sessionId: string, mode: string): void {
  if (typeof mode !== 'string' || !mode) return
  workspaceStore.updateTerminalPermissionMode(sessionId, mode)
}

type ClaudeAgentPanelContentProps = Omit<ClaudeAgentPanelProps, 'isActive'> & {
  activation: PanelActivation
}

export function ClaudeAgentPanel({ isActive, ...props }: Readonly<ClaudeAgentPanelProps>) {
  const activation = usePanelActivation(isActive)
  return <ClaudeAgentPanelContent {...props} activation={activation} />
}

const ClaudeAgentPanelContent = memo(function ClaudeAgentPanelContent({ sessionId, cwd, activation, workspaceId, onClose, showUserMsg = true, showAssistantMsg = true, showToolMsg = true, showThinkingMsg = true, isRemoteConnected = false, targetAgent, onRequestLogin }: Readonly<ClaudeAgentPanelContentProps>) {
  const { t, i18n } = useTranslation()
  // Determine backend/session flavor from agentPreset
  const terminal = workspaceStore.getState().terminals.find(t => t.id === sessionId)
  const isCodexSession = targetAgent === 'codex' || terminal?.agentPreset === 'codex-agent'
  const isV2Session = terminal?.agentPreset === 'claude-code-v2'
  const isWorktreeSession = terminal?.agentPreset === 'claude-code-worktree'
  const normalizedAgentParams = normalizeAgentParams(terminal?.agentPreset, terminal?.agentParams)
  const [messages, setMessages] = useState<MessageItem[]>([])
  // Per-tool render-helper cache. Avoids rerunning regex/split over large
  // tool outputs on every streaming token re-render. Pruned on session
  // change / message clear so it never holds stale entries.
  const toolRenderCacheRef = useRef(createToolRenderCache<{
    outText: string
    isLongOutput: boolean
    outPreviewLines: string[]
    reminders: string[]
    errors: string[]
  }>())
  const inputValueRef = useRef('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [runtimeWaitNow, setRuntimeWaitNow] = useState(() => Date.now())
  const [isInterrupted, setIsInterrupted] = useState(false)
  // Turn liveness: when the turn started, when the LAST event (message, tool,
  // stream delta, status) arrived, and a 1s ticker that drives the elapsed /
  // quiet-time display. Answers "is the agent actually still doing anything?"
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  const lastAgentEventAtRef = useRef<number>(Date.now())
  const [turnNow, setTurnNow] = useState(() => Date.now())
  const noteAgentEvent = useCallback(() => {
    lastAgentEventAtRef.current = Date.now()
  }, [])
  const lastEscRef = useRef(0)
  const streamingTextStore = useRafBatchedString('', { activation })
  const streamingThinkingStore = useRafBatchedString('', { activation })
  const streamingText = streamingTextStore.value
  const streamingThinking = streamingThinkingStore.value
  const setStreamingText = streamingTextStore.reset
  const setStreamingThinking = streamingThinkingStore.reset
  const [showThinking, setShowThinking] = useState(false)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const [autoExpandThinking, setAutoExpandThinking] = useState(false)
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(() => {
    // Restore persisted session metadata for status line on resume
    const t = workspaceStore.getState().terminals.find(t => t.id === sessionId)
    if (t?.sessionMeta) {
      return {
        ...t.sessionMeta,
        model: t.model,
        sdkSessionId: t.sdkSessionId,
      }
    }
    return null
  })
  const [hasSdkSession, setHasSdkSession] = useState(() => {
    const t = workspaceStore.getState().terminals.find(t => t.id === sessionId)
    return !!t?.sdkSessionId
  })
  const [permissionMode, setPermissionMode] = useState<string>(() => restoredPermissionMode(sessionId))
  const [currentModel, setCurrentModel] = useState<string>(() => {
    const t = workspaceStore.getState().terminals.find(t => t.id === sessionId)
    return normalizeClaudeModelSelection(t?.model || settingsStore.getSettings().defaultClaudeModel) || ''
  })
  const [codexSandboxMode, setCodexSandboxMode] = useState<CodexSandboxMode>(() => {
    const value = normalizedAgentParams?.sandboxMode
    return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
      ? value
      : 'workspace-write'
  })
  const [codexApprovalPolicy, setCodexApprovalPolicy] = useState<CodexApprovalPolicy>(() => {
    const value = normalizedAgentParams?.approvalPolicy
    return value === 'untrusted' || value === 'on-request' || value === 'never'
      ? value
      : 'on-request'
  })
  const [effortLevel, setEffortLevel] = useState<string>(() => {
    // Per-terminal effort/ultracode persists across restarts (stored in agentParams).
    // Falls back to the global default only when this terminal has no saved choice.
    const persisted = normalizedAgentParams?.effort
    if (typeof persisted === 'string' && (CLAUDE_EFFORT_MODES as readonly string[]).includes(persisted)) {
      return persisted
    }
    return settingsStore.getSettings().defaultEffort || 'high'
  })
  const [claudeUsage, setClaudeUsage] = useState(workspaceStore.claudeUsage)
  const [usageAccount, setUsageAccount] = useState(workspaceStore.usageAccount)
  const [rateLimits, setRateLimits] = useState<Record<string, { resetsAt: number; utilization: number | null; isUsingOverage: boolean }>>({})
  // Host-wide usage poll (one poller per host, active account) keeps the 5h/7d
  // statusline items fresh while idle; mid-turn rate_limit_events still
  // overwrite with the latest API-reported numbers. Provider follows the
  // session: codex sessions show the codex account's windows, not Claude's.
  useEffect(() => {
    const apply = () => {
      const snap = getHostUsageSnapshot(isCodexSession ? 'codex' : 'claude')
      if (!snap) return
      setRateLimits(prev => rateLimitsFromHostUsage(snap, prev))
    }
    apply()
    return subscribeHostUsage(apply)
  }, [isCodexSession])
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [availableEfforts, setAvailableEfforts] = useState<string[]>(() => [...EFFORT_LEVELS])
  const [availableCodexSandboxModes, setAvailableCodexSandboxModes] = useState<string[]>(() => [...CODEX_SANDBOX_MODES])
  const [availableCodexApprovalPolicies, setAvailableCodexApprovalPolicies] = useState<string[]>(() => [...CODEX_APPROVAL_POLICIES])
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [planFileContent, setPlanFileContent] = useState<string | null>(null)
  const [permissionFocus, setPermissionFocus] = useState(0) // 0=Yes, 1=Yes always, 2=No, 3=custom text
  const [permissionCustomText, setPermissionCustomText] = useState('')
  const [pendingQuestion, setPendingQuestion] = useState<PendingAskUser | null>(null)
  // Single-select questions store one label (string); multi-select questions
  // store an array of selected labels. Keyed by question text.
  const [askAnswers, setAskAnswers] = useState<Record<string, string | string[]>>({})
  const [askOtherText, setAskOtherText] = useState<Record<string, string>>({})
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [showResumeList, setShowResumeList] = useState(false)
  const [resumeSessions, setResumeSessions] = useState<SessionSummary[]>([])
  const [resumeLoading, setResumeLoading] = useState(false)
  const [showModelList, setShowModelList] = useState(false)
  const [contentModal, setContentModal] = useState<{ title: string; content: string; markdown?: boolean } | null>(null)
  const refreshResumeSessions = useCallback(async () => {
    setResumeLoading(true)
    try {
      setResumeSessions(await host.claude.listSessions(cwd) || [])
    } catch {
      setResumeSessions([])
    } finally {
      setResumeLoading(false)
    }
  }, [cwd])
  useEffect(() => {
    if (showResumeList) void refreshResumeSessions()
  }, [showResumeList, refreshResumeSessions])
  const effortOptions = useMemo(
    () => includeCurrentOption(isCodexSession ? availableEfforts : CLAUDE_EFFORT_MODES, effortLevel),
    [availableEfforts, effortLevel, isCodexSession],
  )
  const codexSandboxModeOptions = useMemo(
    () => includeCurrentOption(availableCodexSandboxModes, codexSandboxMode),
    [availableCodexSandboxModes, codexSandboxMode],
  )
  const codexApprovalPolicyOptions = useMemo(
    () => includeCurrentOption(availableCodexApprovalPolicies, codexApprovalPolicy),
    [availableCodexApprovalPolicies, codexApprovalPolicy],
  )
  const currentModelLabel = useMemo(() => {
    return availableModels.find(model => model.value === currentModel)?.displayName || displayNameForClaudeSelection(currentModel)
  }, [availableModels, currentModel])
  const currentSdkModel = useMemo(() => sdkModelForClaudeSelection(currentModel) || currentModel, [currentModel])
  const currentModelContextSuffix = useMemo(() => {
    const contextWindow = sessionMeta?.contextWindow
    if (!contextWindow || contextWindow <= 0) return ''
    const label = contextWindow >= 1000000
      ? `${Math.round(contextWindow / 1000000)}M`
      : `${Math.round(contextWindow / 1000)}k`
    return currentModelLabel.toLowerCase().includes(label.toLowerCase()) ? '' : ` (${label})`
  }, [currentModelLabel, sessionMeta?.contextWindow])
  // Tripwire for the display==actual invariant: the selected preset implies
  // an auto-compact window; if the live session reports a different one
  // (e.g. a resume path dropped it), surface it instead of silently running
  // uncapped to the full model window.
  const compactWindowMismatch = useMemo(() => {
    if (isCodexSession) return null
    if (!sessionMeta || !sessionMeta.contextWindow || sessionMeta.contextWindow <= 0) return null
    const expected = getAutoCompactWindowForModel(currentModel, settingsStore.getSettings().autoCompactWindow)
    if (typeof expected !== 'number' || expected <= 0) return null
    const actual = typeof sessionMeta.autoCompactWindow === 'number' && sessionMeta.autoCompactWindow > 0
      ? sessionMeta.autoCompactWindow
      : null
    return actual === expected ? null : { expected, actual }
  }, [isCodexSession, sessionMeta, currentModel])
  // Subagent message storage (keyed by parent Task tool_use_id)
  const subagentMessagesRef = useRef<Map<string, MessageItem[]>>(new Map())
  const [subagentStreamingText, setSubagentStreamingText] = useState<Map<string, string>>(new Map())
  const [subagentStreamingThinking, setSubagentStreamingThinking] = useState<Map<string, string>>(new Map())
  const [taskModal, setTaskModal] = useState<{ taskId: string; label: string; subagentType?: string } | null>(null)
  const [taskModalTick, setTaskModalTick] = useState(0)
  // Task id whose stored transcript is currently being read back from the SDK.
  const [taskTranscriptLoading, setTaskTranscriptLoading] = useState<string | null>(null)
  // Best-effort `claude:task` lifecycle entries (workflow name / terminal
  // status), merged into the agent activity tree. Keyed by task id.
  const [taskLifecycle, setTaskLifecycle] = useState<Map<string, TaskLifecycle>>(new Map())
  const [agentTreeView, setAgentTreeView] = useState<'bar' | 'tree' | 'hidden'>('bar')
  const [showPromptHistory, setShowPromptHistory] = useState(false)
  const [worktreeInfo, setWorktreeInfo] = useState<{ branchName: string; worktreePath: string; sourceBranch: string; gitRoot?: string } | null>(() => {
    // Restore from persisted terminal state
    if (terminal?.worktreePath && terminal?.worktreeBranch) {
      return { branchName: terminal.worktreeBranch, worktreePath: terminal.worktreePath, sourceBranch: '' }
    }
    return null
  })
  useEffect(() => {
    if (!isWorktreeSession || !terminal?.worktreePath || !terminal?.worktreeBranch) return
    setWorktreeInfo(prev => {
      if (prev?.worktreePath === terminal.worktreePath && prev?.branchName === terminal.worktreeBranch) return prev
      return {
        branchName: terminal.worktreeBranch!,
        worktreePath: terminal.worktreePath!,
        sourceBranch: prev?.sourceBranch || '',
        gitRoot: prev?.gitRoot,
      }
    })
  }, [isWorktreeSession, terminal?.worktreePath, terminal?.worktreeBranch])
  const markdownCwd = worktreeInfo?.worktreePath || terminal?.worktreePath || cwd
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null)
  const [isResumingHistory, setIsResumingHistory] = useState(false)
  const [activePlanFile, setActivePlanFile] = useState<string | null>(null)
  const [planFileTitle, setPlanFileTitle] = useState<string | null>(null)
  const [planFileTrigger, setPlanFileTrigger] = useState(0)
  const [planFileShownAt, setPlanFileShownAt] = useState<number | null>(null)
  const dismissedPlanFileRef = useRef<string | null>(null)
  const PLAN_BADGE_TTL_MS = 10 * 60 * 1000
  useEffect(() => {
    if (!activePlanFile || !planFileShownAt) return
    const remaining = PLAN_BADGE_TTL_MS - (Date.now() - planFileShownAt)
    if (remaining <= 0) { setActivePlanFile(null); setPlanFileShownAt(null); return }
    const timer = setTimeout(() => { setActivePlanFile(null); setPlanFileShownAt(null) }, remaining)
    return () => clearTimeout(timer)
  }, [activePlanFile, planFileShownAt])
  useEffect(() => {
    if (!activePlanFile) { setPlanFileTitle(null); return }
    host.fs.readFile(activePlanFile).then(r => {
      if (!r.content) return
      const firstLine = r.content.split('\n').find((l: string) => l.trim().length > 0)
      if (firstLine) setPlanFileTitle(firstLine.replace(/^#+\s*/, '').trim())
    }).catch(() => setPlanFileTitle(null))
  }, [activePlanFile, planFileTrigger])
  // Cache efficiency history — last 20 readings for smoothed display
  const cacheHistoryRef = useRef<{ pct: number; cacheRead: number; cacheCreate: number; totalInput: number; contextSize: number; callCacheRead: number; callCacheWrite: number; calls: number; isResult?: boolean; modelUsage?: SessionMeta['modelUsage']; model?: string; outputTokens?: number; cacheWrite5mTokens?: number; cacheWrite1hTokens?: number; timestamp?: number; messageCount?: number; turnStartMsgId?: string | null; apiTotalCost?: number; firstTokenMs?: number; durationMs?: number }[]>([])
  // Track last result for cache expiry warning (timestamp + total input tokens)
  const lastResultRef = useRef<{ timestamp: number; totalInput: number } | null>(null)
  const [showCacheHistory, setShowCacheHistory] = useState(false)
  const [cacheEntryModal, setCacheEntryModal] = useState<number | null>(null)
  const [cacheCountdown, setCacheCountdown] = useState<{ m5: number; h1: number } | null>(null)
  const cacheAlarmEnabled = useSettings(s => s.cacheAlarmTimer === true)
  const statuslineConfig = useSettings(() => settingsStore.getStatuslineItems(), shallowEqual)
  const [contextUsagePopup, setContextUsagePopup] = useState<{
    categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
    totalTokens: number
    maxTokens: number
    percentage: number
    model: string
    memoryFiles?: { path: string; type: string; tokens: number }[]
    mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[]
    apiUsage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } | null
  } | null>(null)
  const [accountInfo, setAccountInfo] = useState<{ email?: string; organization?: string; subscriptionType?: string } | null>(null)
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([])
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const showSlashMenuRef = useRef(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const selectedSlashItemRef = useRef<HTMLDivElement | null>(null)
  // Ctrl+P file picker
  const [showFilePicker, setShowFilePicker] = useState(false)
  const [filePickerMode, setFilePickerMode] = useState<'preview' | 'attach'>('preview')
  const [filePickerQuery, setFilePickerQuery] = useState('')
  const [filePickerResults, setFilePickerResults] = useState<FilePickerSearchEntry[]>([])
  const [filePickerIndex, setFilePickerIndex] = useState(0)
  const [filePickerLoading, setFilePickerLoading] = useState(false)
  const [filePickerError, setFilePickerError] = useState<string | null>(null)
  const filePickerSearchRequestRef = useRef(0)
  const runtimeWaitMessage = useMemo(
    () => runtimeWaitingMessage(t, sessionMeta, isStreaming, runtimeWaitNow),
    [t, sessionMeta, isStreaming, runtimeWaitNow],
  )
  const runRuntimeWaitTicker = useCallback(() => {
    if (!isStreaming || !sessionMeta?.runtimeStatus) return
    setRuntimeWaitNow(Date.now())
    const timer = window.setInterval(() => setRuntimeWaitNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isStreaming, sessionMeta?.runtimeStatus, sessionMeta?.runtimeStatusStartedAt])
  usePanelActiveEffect(activation, runRuntimeWaitTicker)
  // Track turn start + tick once a second while a turn is in flight so the
  // elapsed / quiet-time readouts stay current.
  useEffect(() => {
    if (isStreaming) {
      setTurnStartedAt(Date.now())
      lastAgentEventAtRef.current = Date.now()
      setTurnNow(Date.now())
      return
    }
    setTurnStartedAt(null)
  }, [isStreaming])
  const runTurnTicker = useCallback(() => {
    if (!isStreaming) return
    setTurnNow(Date.now())
    const timer = window.setInterval(() => setTurnNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isStreaming])
  usePanelActiveEffect(activation, runTurnTicker)
  const TURN_QUIET_WARN_SEC = 30
  // While a permission prompt or ask-user question is pending, the agent is
  // legitimately blocked waiting on the user — not stalled. Freeze the quiet
  // timer (so it doesn't keep counting "no new events" while we wait) and
  // suppress the stall warning until the user answers.
  const awaitingUser = !!(pendingPermission || pendingQuestion)
  const turnElapsedSec = isStreaming && turnStartedAt
    ? Math.max(0, Math.floor((turnNow - turnStartedAt) / 1000))
    : 0
  const turnQuietSec = isStreaming && !awaitingUser
    ? Math.max(0, Math.floor((turnNow - lastAgentEventAtRef.current) / 1000))
    : 0
  const turnStalled = isStreaming && !awaitingUser && turnQuietSec >= TURN_QUIET_WARN_SEC
  // Reset the quiet clock when the user finishes answering so the next turn
  // segment isn't instantly flagged as stalled by the time spent waiting.
  useEffect(() => {
    if (!awaitingUser) noteAgentEvent()
  }, [awaitingUser, noteAgentEvent])
  const [filePickerPreview, setFilePickerPreview] = useState<string | null>(null)
  const filePickerInputRef = useRef<HTMLInputElement>(null)
  // Message archiving — keep renderer memory bounded
  const [loadedArchive, setLoadedArchive] = useState<MessageItem[]>([])
  const [hasMoreArchived, setHasMoreArchived] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const archivedCountRef = useRef(0)
  const loadedFromArchiveRef = useRef(0)
  const archivingRef = useRef(false)
  const VISIBLE_LIMIT = 120
  const ARCHIVE_TRIGGER = 160 // archive when exceeding this
  const INITIAL_ARCHIVE_LOAD = 120
  const LOAD_BATCH = 40
  const historyLoadedRef = useRef(false)
  // A remote host owns the live session and its transcript. Reset this latch
  // whenever the connection/session changes so reconnecting asks the host to
  // replay history once, without replaying it before every sendMessage call.
  const remoteHistoryAttachedRef = useRef(false)
  // Local panels can also be unmounted by the bounded terminal LRU. Their
  // renderer-only history disappears with the component, so a newly mounted
  // panel must inspect/replay an empty host snapshot once before taking the
  // fast path used by subsequent sends.
  const localHistoryAttachedRef = useRef(false)
  const inputHistoryRef = useRef<string[]>([])
  const inputHistoryIndexRef = useRef(-1)
  const inputDraftRef = useRef('')
  const pendingPromptSentRef = useRef(false)
  const messageCountRef = useRef(0)
  const autoLoadedArchiveSessionRef = useRef<string | null>(null)

  useEffect(() => {
    remoteHistoryAttachedRef.current = false
    localHistoryAttachedRef.current = false
  }, [sessionId, isRemoteConnected])

  useEffect(() => {
    const sandboxMode = normalizedAgentParams?.sandboxMode
    if (sandboxMode === 'read-only' || sandboxMode === 'workspace-write' || sandboxMode === 'danger-full-access') {
      setCodexSandboxMode(sandboxMode)
    }
    const approvalPolicy = normalizedAgentParams?.approvalPolicy
    if (approvalPolicy === 'untrusted' || approvalPolicy === 'on-request' || approvalPolicy === 'never') {
      setCodexApprovalPolicy(approvalPolicy)
    }
  }, [normalizedAgentParams?.approvalPolicy, normalizedAgentParams?.sandboxMode])
  const currentTurnMsgIdRef = useRef<string | null>(null)
  // Display text of the in-flight turn's prompt. A barge-in send reads this to
  // fold the interrupted (possibly unfinished) request into the new message so
  // the model does not silently forget it.
  const inFlightPromptRef = useRef<string>('')
  // True while a barge-in send is replacing the current turn, so the cancelled
  // turn's 'interrupted' turn-end does not flip the UI back to a stopped state.
  const bargeInPendingRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamingThinkingRef = useRef<HTMLPreElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // True while an IME composition is active. Cleared in a microtask after
  // compositionend so the trailing keydown that some IMEs (notably macOS
  // Chinese input methods) fire with `isComposing: false, keyCode: 229`
  // is still recognised as part of the composition and does not submit.
  const isComposingRef = useRef(false)
  const permissionCardRef = useRef<HTMLDivElement>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const isNearBottomRef = useRef(true)
  const followOutputRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const userScrollIntentUntilRef = useRef(0)
  const scrollSettleRafRef = useRef<number | null>(null)
  const middleMessageScrollRef = useRef<{ startX: number; startY: number; startScrollTop: number; startScrollLeft: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; kind: 'messages' } | null>(null)
  const [aboveViewportUserMsgIds, setAboveViewportUserMsgIds] = useState<Set<string>>(new Set())
  const claudeFontSize = useSettings(s => s.fontSize)
  const userMsgRefsMap = useRef<Map<string, HTMLDivElement>>(new Map())
  const observerRef = useRef<IntersectionObserver | null>(null)

  // Check if scrolled near bottom (within 80px)
  const checkIfNearBottom = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96
  }, [])

  // Auto-scroll to bottom — use instant scroll to avoid layout thrashing with rapid updates
  const scrollToBottomNow = useCallback(() => {
    userScrollIntentUntilRef.current = 0
    const el = messagesContainerRef.current
    if (el) {
      const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
      el.scrollTop = bottom
      el.scrollTo({ top: bottom, behavior: 'auto' })
      lastScrollTopRef.current = el.scrollTop
    }
    setUserScrolledUp(false)
    isNearBottomRef.current = true
    followOutputRef.current = true
  }, [])

  // A row's height is not final at the frame React commits it: markdown
  // reflows, code blocks and tool output expand, and images and web fonts land
  // later still. Reading scrollHeight once and scrolling there lands short of
  // the real bottom, and the growth that follows pushes the tail further away
  // again — the panel reads as frozen on older output while the turn is still
  // streaming. Keep re-scrolling until the measurement stops moving instead.
  const scrollToBottomAfterRender = useCallback(() => {
    if (scrollSettleRafRef.current !== null) cancelAnimationFrame(scrollSettleRafRef.current)
    let frames = 0
    let stableFrames = 0
    let lastHeight = -1
    const settle = () => {
      scrollSettleRafRef.current = null
      const el = messagesContainerRef.current
      // followOutput drops the moment the user scrolls up, which is what keeps
      // this from fighting them for the rest of the budget.
      if (!el || !followOutputRef.current) return
      scrollToBottomNow()
      stableFrames = el.scrollHeight === lastHeight ? stableFrames + 1 : 0
      lastHeight = el.scrollHeight
      if (stableFrames >= 2 || ++frames >= 12) return
      scrollSettleRafRef.current = requestAnimationFrame(settle)
    }
    scrollSettleRafRef.current = requestAnimationFrame(settle)
  }, [scrollToBottomNow])

  // The jump-to-bottom button has the furthest to travel — every row between
  // here and the tail is unmeasured — so it needs the same convergence.
  const forceScrollToBottom = useCallback(() => {
    scrollToBottomNow()
    scrollToBottomAfterRender()
  }, [scrollToBottomNow, scrollToBottomAfterRender])

  const handleScrollToBottomPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    forceScrollToBottom()
  }, [forceScrollToBottom])

  const handleScrollToBottomClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    forceScrollToBottom()
  }, [forceScrollToBottom])

  // Handle user scroll events on messages container
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const nearBottom = checkIfNearBottom()
    const delta = el.scrollTop - lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    isNearBottomRef.current = nearBottom
    if (nearBottom) {
      followOutputRef.current = true
      setUserScrolledUp(false)
      return
    }
    if (performance.now() < userScrollIntentUntilRef.current && delta < -1) {
      followOutputRef.current = false
      setUserScrolledUp(true)
      return
    }
    if (!followOutputRef.current) setUserScrolledUp(true)
  }, [checkIfNearBottom])

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + 1500
  }, [])

  const clearMiddleMessageScroll = useCallback(() => {
    middleMessageScrollRef.current = null
  }, [])

  const handleMessagesWheel = useCallback((e: { deltaY: number }) => {
    markUserScrollIntent()
    if (e.deltaY < 0) {
      followOutputRef.current = false
      isNearBottomRef.current = false
      setUserScrolledUp(true)
    }
  }, [markUserScrollIntent])

  const handleMessagesMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      markUserScrollIntent()
      const el = messagesContainerRef.current
      if (el) {
        middleMessageScrollRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          startScrollTop: el.scrollTop,
          startScrollLeft: el.scrollLeft,
        }
      }
      return
    }
    if (e.button === 0) markUserScrollIntent()
  }, [markUserScrollIntent])

  const handleMessagesMouseUp = useCallback(() => {
    clearMiddleMessageScroll()
    userScrollIntentUntilRef.current = performance.now() + 300
  }, [clearMiddleMessageScroll])

  const handleMessagesAuxClick = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault()
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const active = middleMessageScrollRef.current
      if (!active) return
      if ((e.buttons & 4) === 0) {
        clearMiddleMessageScroll()
        return
      }
      const el = messagesContainerRef.current
      if (!el) return
      e.preventDefault()
      markUserScrollIntent()
      el.scrollTop = active.startScrollTop - (e.clientY - active.startY)
      el.scrollLeft = active.startScrollLeft - (e.clientX - active.startX)
      lastScrollTopRef.current = el.scrollTop
      const nearBottom = checkIfNearBottom()
      isNearBottomRef.current = nearBottom
      followOutputRef.current = nearBottom
      setUserScrolledUp(!nearBottom)
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 1 || (e.buttons & 4) === 0) clearMiddleMessageScroll()
    }

    const handleVisibilityChange = () => {
      if (document.hidden) clearMiddleMessageScroll()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', clearMiddleMessageScroll)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', clearMiddleMessageScroll)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [checkIfNearBottom, clearMiddleMessageScroll, markUserScrollIntent])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close, true)
    return () => window.removeEventListener('click', close, true)
  }, [contextMenu])

  useEffect(() => {
    const handler = (e: Event) => {
      const { path } = (e as CustomEvent).detail as { path: string }
      setFilePickerPreview(path)
    }
    window.addEventListener('preview-file', handler)
    return () => window.removeEventListener('preview-file', handler)
  }, [])


  // Only auto-scroll if user hasn't scrolled up
  useEffect(() => {
    if (followOutputRef.current) {
      scrollToBottomAfterRender()
    }
  }, [messages, scrollToBottomAfterRender, streamingText, streamingThinking])

  // Auto-scroll streaming thinking <pre> to bottom so latest content is visible
  useEffect(() => {
    const el = streamingThinkingRef.current
    if (el && showThinking) {
      el.scrollTop = el.scrollHeight
    }
  }, [streamingThinking, showThinking])

  // Combine archived + live messages for rendering and scanning
  const allMessages = useMemo(() => [...loadedArchive, ...messages], [loadedArchive, messages])
  messageCountRef.current = allMessages.length
  // Mirror for event handlers (subscribed once per session) that need the
  // current message list without re-subscribing on every message.
  const allMessagesRef = useRef<MessageItem[]>(allMessages)
  allMessagesRef.current = allMessages
  const lastRenderDlogRef = useRef<{ at: number; summary: string }>({ at: 0, summary: '' })
  const archiveDlog = useCallback((message: string) => {
    if (host.debug.isDebugMode === true) host.debug.log(message)
  }, [])

  useEffect(() => {
    if (host.debug.isDebugMode !== true) return
    const summary = `live=${messages.length} archived=${loadedArchive.length} all=${allMessages.length} hasMore=${hasMoreArchived} loadingMore=${isLoadingMore}`
    const now = Date.now()
    if (summary === lastRenderDlogRef.current.summary) return
    if (now - lastRenderDlogRef.current.at < 5000) return
    lastRenderDlogRef.current = { at: now, summary }
    host.debug.log(`[Claude:${sessionId.slice(0, 8)}] render messages ${summary}`)
  }, [allMessages.length, hasMoreArchived, isLoadingMore, loadedArchive.length, messages.length, sessionId])

  // Show enough recent archived context by default while still keeping older
  // archive pages opt-in through the load-more button.
  useEffect(() => {
    if (autoLoadedArchiveSessionRef.current === sessionId) return
    autoLoadedArchiveSessionRef.current = sessionId
    let cancelled = false
    archiveDlog(
      `[Claude:${sessionId.slice(0, 8)}] auto-load archived start limit=${INITIAL_ARCHIVE_LOAD} live=${messages.length} loaded=${loadedArchive.length}`
    )
    setIsLoadingMore(true)
    host.claude.loadArchived(sessionId, 0, INITIAL_ARCHIVE_LOAD)
      .then((result: { messages: unknown[]; total: number; hasMore: boolean }) => {
        if (cancelled) return
        const rawMessages = result.messages || []
        const archived = rawMessages.filter(isMessageItem)
        archiveDlog(
          `[Claude:${sessionId.slice(0, 8)}] auto-load archived result messages=${archived.length}/${rawMessages.length} total=${result.total || 0} hasMore=${result.hasMore} live=${messages.length}`
        )
        archivedCountRef.current = result.total || archived.length
        loadedFromArchiveRef.current = rawMessages.length
        setLoadedArchive(archived)
        setHasMoreArchived(result.hasMore)
      })
      .catch((err) => {
        archiveDlog(
          `[Claude:${sessionId.slice(0, 8)}] auto-load archived failed: ${err instanceof Error ? err.message : String(err)}`
        )
        if (!cancelled) setHasMoreArchived(false)
      })
      .finally(() => {
        if (!cancelled) setIsLoadingMore(false)
      })
    return () => {
      cancelled = true
      if (autoLoadedArchiveSessionRef.current === sessionId) {
        autoLoadedArchiveSessionRef.current = null
      }
    }
  }, [archiveDlog, sessionId])

  // Agent activity tree: Task/Agent/Workflow tool calls (running AND
  // finished) nested via the subagent buckets, merged with `claude:task`
  // lifecycle metadata. Replaces the old running-only activeTasks filter.
  const agentTree = useMemo(() => {
    const roots = buildAgentTaskTree(allMessages, subagentMessagesRef.current, taskLifecycle)
    if (host.debug.isDebugMode === true && roots.length > 0) {
      host.debug.log(`[renderer] agentTree: ${roots.length} roots (${roots.map(r => `${r.id.slice(0, 8)}=${r.status}`).join(', ')})`)
    }
    return roots
    // subagentStreamingText is a dep so freshly bucketed children (which live
    // in a ref and don't re-render on their own) show up promptly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMessages, taskLifecycle, subagentStreamingText])
  const agentTreeSummary = useMemo(() => summarizeAgentTree(agentTree), [agentTree])

  // Stop a subagent/workflow by task id or tool_use id. Always terminates
  // matching lifecycle entries locally afterwards: a ghost entry (its task is
  // already gone) gets no terminal task event from the SDK, and for a live
  // task the local flip is idempotent with the kill event that follows.
  const stopAgentTask = useCallback(async (id: string) => {
    try {
      await host.claude.stopTask(sessionId, id)
    } catch {
      // Sidecar unreachable — still clear the local entry below.
    }
    setTaskLifecycle(prev => terminateLifecycleEntries(
      prev, life => life.id === id || life.toolUseId === id, 'killed'))
  }, [sessionId])

  // Tick counter to force re-render for elapsed time display
  const [, setElapsedTick] = useState(0)
  const runAgentTreeTicker = useCallback(() => {
    if (agentTreeSummary.running === 0) return
    const interval = setInterval(() => setElapsedTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [agentTreeSummary.running])
  usePanelActiveEffect(activation, runAgentTreeTicker)

  // A hidden tree resurfaces (as the collapsed bar) when new agents start.
  useEffect(() => {
    if (agentTreeSummary.running > 0) setAgentTreeView(v => (v === 'hidden' ? 'bar' : v))
  }, [agentTreeSummary.running])

  // Compute pinned user messages (last 3 user messages that scrolled above viewport)
  // Show regardless of scroll position — the point is to always show context
  const pinnedMessages = useMemo(() => {
    if (aboveViewportUserMsgIds.size === 0) return []
    const userMsgs = allMessages.filter(m => !isToolCall(m) && (m as ClaudeMessage).role === 'user') as ClaudeMessage[]
    return userMsgs.filter(m => aboveViewportUserMsgIds.has(m.id)).slice(-3)
  }, [allMessages, aboveViewportUserMsgIds])

  // IntersectionObserver to detect user messages scrolled above viewport
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    observerRef.current?.disconnect()
    const obs = new IntersectionObserver(
      (entries) => {
        setAboveViewportUserMsgIds(prev => {
          const next = new Set(prev)
          let changed = false
          for (const entry of entries) {
            const msgId = (entry.target as HTMLElement).dataset.userMsgId
            if (!msgId) continue
            if (!entry.isIntersecting && entry.boundingClientRect.bottom < (entry.rootBounds?.top ?? 0)) {
              if (!next.has(msgId)) { next.add(msgId); changed = true }
            } else if (entry.isIntersecting) {
              if (next.has(msgId)) { next.delete(msgId); changed = true }
            }
          }
          return changed ? next : prev
        })
      },
      { root: container, threshold: 0 }
    )
    observerRef.current = obs

    // Observe all user message elements
    userMsgRefsMap.current.forEach((el) => obs.observe(el))

    return () => obs.disconnect()
  }, [allMessages])

  // Callback ref to register user message elements for IntersectionObserver
  const setUserMsgRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      userMsgRefsMap.current.set(id, el)
      observerRef.current?.observe(el)
    } else {
      const prev = userMsgRefsMap.current.get(id)
      if (prev) observerRef.current?.unobserve(prev)
      userMsgRefsMap.current.delete(id)
    }
  }, [])

  // Scroll to a specific user message when clicking a pinned item
  const scrollToUserMsg = useCallback((msgId: string) => {
    const el = userMsgRefsMap.current.get(msgId)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  // Archive excess messages to disk when threshold is exceeded.
  // Trim in-memory immediately to release memory; the archive IPC writes
  // the snapshot to disk in parallel. If the archive write fails, we keep
  // the count (best-effort) — losing the ability to load-back those
  // messages is preferable to letting memory grow unbounded.
  useEffect(() => {
    if (archivingRef.current || messages.length <= ARCHIVE_TRIGGER) return
    archivingRef.current = true
    const excess = messages.length - VISIBLE_LIMIT
    const toArchive = messages.slice(0, excess)
    setMessages(prev => prev.slice(excess))
    archivedCountRef.current += excess
    setHasMoreArchived(true)
    host.claude.archiveMessages(sessionId, toArchive)
      .catch((err) => {
        host.debug.log?.('[ClaudeAgentPanel] archiveMessages failed:', String(err))
      })
      .finally(() => { archivingRef.current = false })
  }, [messages.length, sessionId])

  // Drop tool-render cache entries whose tool ids are no longer in messages.
  useEffect(() => {
    const liveIds = new Set<string>()
    for (const m of messages) {
      if ('toolName' in m) liveIds.add(m.id)
    }
    pruneToolRenderCache(toolRenderCacheRef.current, liveIds)
  }, [messages])

  // Load more archived messages when scrolling to top
  const loadMoreArchived = useCallback(async () => {
    if (isLoadingMore || !hasMoreArchived) return
    setIsLoadingMore(true)
    const container = messagesContainerRef.current
    const prevScrollHeight = container?.scrollHeight ?? 0
    // Anchor on the item that is currently at the top rather than on a
    // scrollHeight delta. Items off screen are size-estimated until they
    // scroll in, so the total height is not a stable reference across the
    // await — but a node that is already on screen has a real height, and
    // holding it still is what the user actually perceives as "kept my place".
    const anchor = container?.querySelector<HTMLElement>('.tl-item') ?? null
    const anchorTop = anchor?.getBoundingClientRect().top ?? 0
    try {
      const result = await host.claude.loadArchived(sessionId, loadedFromArchiveRef.current, LOAD_BATCH)
      if (result.messages.length > 0) {
        const archived = result.messages.filter(isMessageItem)
        loadedFromArchiveRef.current += result.messages.length
        setLoadedArchive(prev => [...archived, ...prev])
        setHasMoreArchived(result.hasMore)
        // Preserve scroll position after prepending
        requestAnimationFrame(() => {
          if (!container) return
          if (anchor?.isConnected) {
            container.scrollTop += anchor.getBoundingClientRect().top - anchorTop
          } else {
            // React dropped the anchor (index-keyed rows remount on prepend);
            // fall back to the height delta.
            container.scrollTop += container.scrollHeight - prevScrollHeight
          }
        })
      } else {
        setHasMoreArchived(false)
      }
    } catch {
      setHasMoreArchived(false)
    }
    setIsLoadingMore(false)
  }, [sessionId, isLoadingMore, hasMoreArchived])

  // Sync pending action state to workspace store for breathing light indicator
  useEffect(() => {
    const hasPending = !!(pendingPermission || pendingQuestion)
    workspaceStore.setTerminalPendingAction(sessionId, hasPending)
  }, [sessionId, pendingPermission, pendingQuestion])

  useEffect(() => {
    workspaceStore.setTerminalAgentRunning(sessionId, isStreaming)
  }, [sessionId, isStreaming])

  // Keep breathing light active (yellow) while streaming/thinking/executing tools
  useEffect(() => {
    if (!isStreaming) return
    workspaceStore.updateTerminalActivity(sessionId)
    const interval = setInterval(() => {
      workspaceStore.updateTerminalActivity(sessionId)
    }, 5000)
    return () => clearInterval(interval)
  }, [isStreaming, sessionId])

  // Subscribe to IPC events
  useEffect(() => {
    const api = host.claude
    const tag = `[Claude:${sessionId.slice(0, 8)}]`
    host.debug.log(`${tag} subscribing to IPC events`)

    const unsubs = [
      api.onMessage((sid: string, msg: unknown) => {
        if (sid !== sessionId) return
        noteAgentEvent()
        if (host.debug.isDebugMode === true) host.debug.log(`${tag} onMessage`, (msg as ClaudeMessage).id)
        workspaceStore.updateTerminalActivity(sessionId)
        const message = msg as ClaudeMessage
        if (message.role !== 'user' && message.kind !== 'stale-turn-warning') {
          setSessionMeta(prev => clearRuntimeStatusMeta(prev))
        }
        // On restart, sys-init message arrives again — reset messages
        // But skip reset if history will be loaded (resume flow)
        if (message.id === `sys-init-${sessionId}`) {
          host.debug.log(`${tag} sys-init historyLoaded=${historyLoadedRef.current}`)
          if (!historyLoadedRef.current) {
            setMessages([message])
            // Clear archive on fresh session start
            setLoadedArchive([])
            archivedCountRef.current = 0
            loadedFromArchiveRef.current = 0
            setHasMoreArchived(false)
            host.claude.clearArchive(sessionId).catch(() => {})
          }
          setStreamingText('')
          setStreamingThinking('')
          setIsStreaming(false)
          setTaskLifecycle(new Map())
          // Restore persisted metadata instead of resetting to null (preserves status line on resume)
          const savedTerminal = workspaceStore.getState().terminals.find(t => t.id === sessionId)
          if (savedTerminal?.sessionMeta) {
            setSessionMeta({
              ...savedTerminal.sessionMeta,
              model: savedTerminal.model,
              sdkSessionId: savedTerminal.sdkSessionId,
            })
          } else {
            setSessionMeta(null)
          }
          return
        }
        // Route subagent messages to separate bucket
        if (message.parentToolUseId) {
          const bucket = subagentMessagesRef.current.get(message.parentToolUseId) || []
          if (!bucket.some(m => m.id === message.id)) {
            bucket.push(message)
            subagentMessagesRef.current.set(message.parentToolUseId, bucket)
            if (taskModal?.taskId === message.parentToolUseId) setTaskModalTick(t => t + 1)
          }
          setSubagentStreamingText(prev => { const n = new Map(prev); n.delete(message.parentToolUseId!); return n })
          setSubagentStreamingThinking(prev => { const n = new Map(prev); n.delete(message.parentToolUseId!); return n })
          return
        }
        // Deduplicate by id; for user messages also dedup by content+timestamp proximity
        // (the sender already adds the message locally, backend broadcasts it for other windows)
        const prevThinking = streamingThinkingStore.peek()
        const finalMsg = (!message.thinking && prevThinking && message.role === 'assistant')
          ? { ...message, thinking: prevThinking }
          : message
        setMessages(prev => {
          const interruptedContinuation = finalMsg.role === 'user'
            ? extractInterruptedContinuation(finalMsg.content)
            : null
          const nextPrev = interruptedContinuation
            ? prev.filter(m => !(
              !isToolCall(m) &&
              (m as ClaudeMessage).role === 'user' &&
              (m as ClaudeMessage).content === interruptedContinuation &&
              Math.abs((m as ClaudeMessage).timestamp - finalMsg.timestamp) < 10000
            ))
            : prev
          const existingMessageIndex = nextPrev.findIndex(m => m.id === finalMsg.id)
          if (existingMessageIndex >= 0) {
            if (finalMsg.kind === 'stale-turn-warning') {
              const copy = [...nextPrev]
              copy[existingMessageIndex] = finalMsg
              return copy
            }
            // The host echoes a user message back under the client's own id
            // (emitUserEcho reuses clientMessageId), so this branch — not the
            // content match below — is what a remote send actually lands in.
            // Returning early here left the optimistic message ghosted until
            // claude.sendMessage resolved, which on hosts that reply at turn
            // end rather than on receipt meant the message the agent was
            // visibly answering stayed greyed out for the whole turn. The echo
            // is emitted before the prompt is even queued, so it remains the
            // earliest proof of receipt even against a host that acks promptly.
            const existing = nextPrev[existingMessageIndex]
            if (!isToolCall(existing) && (existing as ClaudeMessage).status) {
              const copy = [...nextPrev]
              copy[existingMessageIndex] = { ...(existing as ClaudeMessage), status: undefined }
              return copy
            }
            return nextPrev
          }
          // Dedup user messages: a matching local user message within 5s is the
          // optimistic echo. When the host echoes the message back (proof it was
          // received) solidify it by clearing its 'sending'/'failed' status,
          // instead of appending a duplicate. A plain skip (no status) preserves
          // the original local/multi-window behavior.
          if (finalMsg.role === 'user') {
            const dupIdx = nextPrev.findIndex(m =>
              !isToolCall(m) && (m as ClaudeMessage).role === 'user' &&
              (m as ClaudeMessage).content === finalMsg.content &&
              Math.abs((m as ClaudeMessage).timestamp - finalMsg.timestamp) < 5000
            )
            if (dupIdx >= 0) {
              const dup = nextPrev[dupIdx] as ClaudeMessage
              if (dup.status) {
                const copy = [...nextPrev]
                copy[dupIdx] = { ...dup, status: undefined }
                return copy
              }
              return nextPrev
            }
          }
          if (finalMsg.role === 'assistant') {
            const lastNonTool = [...nextPrev].reverse().find(m => !isToolCall(m)) as ClaudeMessage | undefined
            if (
              lastNonTool?.role === 'assistant' &&
              lastNonTool.content === finalMsg.content &&
              Math.abs(lastNonTool.timestamp - finalMsg.timestamp) < 10000
            ) {
              return nextPrev
            }
          }
          return [...nextPrev, finalMsg]
        })
        streamingThinkingStore.reset('')
        streamingTextStore.reset('')
      }),

      api.onToolUse((sid: string, tool: unknown) => {
        if (sid !== sessionId) return
        noteAgentEvent()
        workspaceStore.updateTerminalActivity(sessionId)
        setSessionMeta(prev => clearRuntimeStatusMeta(prev))
        const toolCall = tool as ClaudeToolCall
        if (host.debug.isDebugMode === true) {
          host.debug.log(`[renderer] onToolUse name=${toolCall.toolName} id=${toolCall.id?.slice(0, 12)} status=${toolCall.status} parentToolUseId=${toolCall.parentToolUseId || 'none'}`)
        }
        // Route subagent tool calls to separate bucket
        if (toolCall.parentToolUseId) {
          const bucket = subagentMessagesRef.current.get(toolCall.parentToolUseId) || []
          if (!bucket.some(m => 'toolName' in m && m.id === toolCall.id)) {
            bucket.push(toolCall)
            subagentMessagesRef.current.set(toolCall.parentToolUseId, bucket)
            if (taskModal?.taskId === toolCall.parentToolUseId) setTaskModalTick(t => t + 1)
          }
          return
        }
        // Track plan file path: show bar only after ExitPlanMode (plan is written);
        // EnterPlanMode means we're entering plan mode (writing a new plan) — hide the bar.
        if (toolCall.toolName === 'EnterPlanMode') {
          setActivePlanFile(null)
          setPlanFileShownAt(null)
        } else if (toolCall.toolName === 'ExitPlanMode' && toolCall.input.planFilePath) {
          setActivePlanFile(String(toolCall.input.planFilePath))
          setPlanFileTrigger(n => n + 1)
          setPlanFileShownAt(Date.now())
          dismissedPlanFileRef.current = null
        }
        // Use flushSync for Agent/Task tools to ensure the active tasks bar renders immediately
        const isAgentTool = toolCall.toolName === 'Agent' || toolCall.toolName === 'Task'
        const doUpdate = () => setMessages(prev => {
          if (prev.some(m => 'toolName' in m && m.id === toolCall.id)) return prev
          return [...prev, toolCall]
        })
        if (isAgentTool) { flushSync(doUpdate) } else { doUpdate() }
      }),

      api.onToolResult((sid: string, result: unknown) => {
        if (sid !== sessionId) return
        noteAgentEvent()
        workspaceStore.updateTerminalActivity(sessionId)
        const { id, ...updates } = result as { id: string; status: string; result?: string; description?: string }
        if (host.debug.isDebugMode === true && (updates as { description?: string }).description) {
          host.debug.log(`[renderer] onToolResult description update id=${id} desc=${(updates as { description?: string }).description}`)
        }
        // Check if tool exists in any subagent bucket
        let foundInSubagent = false
        for (const [parentId, bucket] of subagentMessagesRef.current.entries()) {
          const idx = bucket.findIndex(m => 'toolName' in m && m.id === id)
          if (idx !== -1) {
            bucket[idx] = { ...bucket[idx], ...updates } as ClaudeToolCall
            foundInSubagent = true
            // Buckets live in a ref, so the modal only redraws when told to:
            // for the parent whose transcript gained a row, and for the tool
            // itself when it is a nested agent whose own detail view is open
            // (that update carries its result).
            if (taskModal?.taskId === parentId || taskModal?.taskId === id) setTaskModalTick(t => t + 1)
            break
          }
        }
        if (foundInSubagent) return
        // Check if this is an Agent/Task status change (needs immediate render for active tasks bar)
        const isAgentStatusChange = updates.status && updates.status !== 'running'
        const doResultUpdate = () => setMessages(prev => prev.map(m => {
          if ('toolName' in m && m.id === id) {
            // When a Task tool completes, clear its subagent streaming state
            if (m.toolName === 'Task') {
              setSubagentStreamingText(p => { const n = new Map(p); n.delete(id); return n })
              setSubagentStreamingThinking(p => { const n = new Map(p); n.delete(id); return n })
            }
            // A terminal tool result also ends the bound `claude:task`
            // lifecycle entry — the SDK never emits task_updated for denied
            // tool calls, which otherwise leaves a ghost running entry. Any
            // tool name qualifies: the SDK emits task_started for plain shell
            // tools too (Bash/PowerShell), bound via tool_use_id.
            // Exception: a successful run_in_background result only means
            // "launched"; the background task keeps running past it.
            if (isAgentStatusChange
              && !((m as ClaudeToolCall).input.run_in_background === true && updates.status !== 'error')) {
              const terminal = updates.status === 'error' ? 'failed' : 'completed'
              setTaskLifecycle(lifePrev => terminateLifecycleEntries(
                lifePrev, life => life.id === id || life.toolUseId === id, terminal))
            }
            return { ...m, ...updates } as ClaudeToolCall
          }
          return m
        }))
        if (isAgentStatusChange) { flushSync(doResultUpdate) } else { doResultUpdate() }
      }),

      // Best-effort `claude:task` lifecycle (workflow name, phase description,
      // terminal failed/killed status the tool blocks never carry). Affects
      // agent-tree visibility, so flush like Agent/Task tool updates.
      api.onTask((sid: string, payload: unknown) => {
        if (sid !== sessionId) return
        noteAgentEvent()
        const task = payload as TaskLifecycle | null | undefined
        if (!task || typeof task.id !== 'string') return
        if (host.debug.isDebugMode === true) {
          host.debug.log(`[renderer] onTask id=${task.id.slice(0, 12)} status=${task.status} workflow=${task.workflowName || 'none'}`)
        }
        flushSync(() => setTaskLifecycle(prev => {
          const next = new Map(prev)
          next.set(task.id, { ...prev.get(task.id), ...task })
          return next
        }))
      }),

      api.onTurnEnd((sid: string, payload: { reason?: string } | null | undefined) => {
        if (sid !== sessionId) return
        const reason = payload?.reason
        // Barge-in hand-off: when the user sent a new message that cancelled
        // this turn, a replacement turn is already starting. Consume the flag
        // and skip the stop/interrupt UI flip so streaming carries over to it.
        const wasBargeIn = bargeInPendingRef.current
        bargeInPendingRef.current = false
        if (reason === 'interrupted' && wasBargeIn) {
          setStreamingText('')
          setStreamingThinking('')
          return
        }
        setIsStreaming(false)
        setSessionMeta(prev => clearRuntimeStatusMeta(prev))
        setStreamingText('')
        setStreamingThinking('')
        if (reason === 'interrupted') {
          // Soft interrupt: the turn ended but the subprocess + any
          // background workflow stay alive. Keep the interrupted state
          // (so the next Esc hard-stops) and leave running tools as-is.
          setIsInterrupted(true)
          return
        }
        setIsInterrupted(false)
        if (reason === 'aborted' || reason === 'error') {
          // Hard stop / failure: the subprocess is gone.
          setPendingPermission(null)
          setPendingQuestion(null)
          setMessages(prev => prev.map(m => {
            if ('toolName' in m && (m as ClaudeToolCall).status === 'running') {
              return { ...m, status: 'error', denied: true } as ClaudeToolCall
            }
            return m
          }))
          // The sidecar drops its activeTasks map when the subprocess dies
          // (closeLiveQuery) without emitting terminal task events — mirror
          // that here or still-running lifecycle entries tick forever.
          setTaskLifecycle(prev => terminateLifecycleEntries(prev, () => true, 'killed'))
        } else {
          // Normal completion: a turn cannot end while foreground tasks are
          // still running, so any leftover running lifecycle entry is a
          // ghost (the SDK's terminal task_updated is best-effort and often
          // missing, e.g. for shell-tool tasks). Only background tasks
          // legitimately outlive the turn — leave those alone.
          const bgToolIds = new Set(allMessagesRef.current
            .filter(m => isToolCall(m) && m.input?.run_in_background === true)
            .map(m => m.id))
          setTaskLifecycle(prev => terminateLifecycleEntries(
            prev,
            life => life.isBackground !== true && !(life.toolUseId && bgToolIds.has(life.toolUseId)),
            'completed'))
        }
      }),

      api.onResult((sid: string, resultData: unknown) => {
        if (sid !== sessionId) return
        setIsStreaming(false)
        setIsInterrupted(false)
        setSessionMeta(prev => clearRuntimeStatusMeta(prev))
        setStreamingText('')
        setStreamingThinking('')
        // Refresh usage after agent activity (usage likely changed)
        workspaceStore.refreshUsageNow()
        // Show result text only for slash commands that don't produce assistant messages
        const rd = resultData as { result?: string; subtype?: string } | undefined
        if (rd?.result && rd.subtype === 'success') {
          setMessages(prev => {
            // Skip only when this turn already produced the same assistant
            // text via onMessage. Repeated legitimate replies like
            // "ping" -> "pong" must still append one result per turn.
            const resultText = rd.result!
            const currentTurnIdx = currentTurnMsgIdRef.current
              ? prev.findIndex(m => m.id === currentTurnMsgIdRef.current)
              : -1
            const candidates = currentTurnIdx >= 0
              ? prev.slice(currentTurnIdx + 1)
              : prev.filter(m => 'timestamp' in m && Date.now() - (m as ClaudeMessage).timestamp < 3000)
            const alreadyShown = candidates.some(m =>
              'role' in m && m.role === 'assistant' && typeof m.content === 'string' &&
              (m.content === resultText || m.content.includes(resultText) || resultText.includes(m.content))
            )
            if (alreadyShown) return prev
            return [...prev, {
              id: `result-${Date.now()}`,
              sessionId,
              role: 'assistant' as const,
              content: resultText,
              timestamp: Date.now(),
            }]
          })
        }
      }),

      api.onError((sid: string, error: string) => {
        if (sid !== sessionId) return
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}`,
          sessionId: sid,
          role: 'system' as const,
          content: `Error: ${error}`,
          timestamp: Date.now(),
        }])
        setIsStreaming(false)
        setIsInterrupted(false)
        setSessionMeta(prev => clearRuntimeStatusMeta(prev))
      }),

      api.onStream((sid: string, data: unknown) => {
        if (sid !== sessionId) return
        const d = data as { text?: string; thinking?: string; parentToolUseId?: string }
        // Extended-thinking heartbeats arrive as empty-content stream events
        // every ~1-1.5s even when the model is producing nothing visible for
        // minutes at a stretch. Only count real text/thinking content as
        // "activity" so the quiet-turn timer (turnQuietSec/turnStalled below)
        // can actually detect a long silent-thinking stretch instead of being
        // reset by heartbeat noise.
        if (d.text || d.thinking) noteAgentEvent()
        workspaceStore.updateTerminalActivity(sessionId)
        setSessionMeta(prev => clearRuntimeStatusMeta(prev))
        if (d.parentToolUseId) {
          // Route to per-subagent streaming state
          if (d.text) {
            setSubagentStreamingText(prev => {
              const n = new Map(prev)
              n.set(d.parentToolUseId!, (prev.get(d.parentToolUseId!) || '') + d.text)
              return n
            })
          }
          if (d.thinking) {
            setSubagentStreamingThinking(prev => {
              const n = new Map(prev)
              n.set(d.parentToolUseId!, (prev.get(d.parentToolUseId!) || '') + d.thinking)
              return n
            })
          }
        } else {
          if (d.text) streamingTextStore.append(d.text)
          if (d.thinking) streamingThinkingStore.append(d.thinking)
        }
      }),

      api.onStatus((sid: string, meta: unknown) => {
        if (sid !== sessionId) return
        noteAgentEvent()
        const m = meta as unknown as SessionMeta
        if (m.runtimeStatus) {
          host.debug.log(`${tag} onStatus runtimeStatus=${m.runtimeStatus} startedAt=${m.runtimeStatusStartedAt ?? 'null'} sdkSessionId=${(m.sdkSessionId || '').slice(0, 8)}`)
        } else if (host.debug.isDebugMode === true) {
          host.debug.log(`${tag} onStatus sdkSessionId=${(m.sdkSessionId || '').slice(0, 8)}`)
        }
        if (typeof m.isStreaming === 'boolean') {
          setIsStreaming(m.isStreaming)
        } else if (m.runtimeStatus) {
          setIsStreaming(true)
        }
        setSessionMeta(m)
        // Track cache efficiency history (only push when values change)
        if (m.cacheReadTokens !== undefined && (m.inputTokens > 0 || m.cacheReadTokens > 0)) {
          const hist = cacheHistoryRef.current
          const lastEntry = hist[hist.length - 1]
          const hasModelUsage = m.modelUsage && Object.keys(m.modelUsage).length > 0
          const isResult = !!hasModelUsage
          // Full input total = uncached input + cache read + cache write. The API's
          // input_tokens is only the uncached delta (a few tokens under heavy caching),
          // so cache efficiency must divide by this total, not by input_tokens alone.
          const totalInput = m.inputTokens + m.cacheReadTokens + (m.cacheCreationTokens || 0)
          if (!lastEntry || lastEntry.cacheRead !== m.cacheReadTokens || lastEntry.totalInput !== totalInput || (isResult !== lastEntry.isResult)) {
            const pct = totalInput > 0 ? Math.round((m.cacheReadTokens / totalInput) * 100) : 0
            const entry = { pct, cacheRead: m.cacheReadTokens, cacheCreate: m.cacheCreationTokens || 0, totalInput, contextSize: m.contextTokens || 0, callCacheRead: m.callCacheRead || 0, callCacheWrite: m.callCacheWrite || 0, calls: isResult ? (m.lastQueryCalls || 0) : 1, isResult, modelUsage: m.modelUsage ? { ...m.modelUsage } : undefined, model: m.model, outputTokens: m.outputTokens || 0, cacheWrite5mTokens: m.cacheWrite5mTokens, cacheWrite1hTokens: m.cacheWrite1hTokens, timestamp: Date.now(), messageCount: messageCountRef.current, turnStartMsgId: currentTurnMsgIdRef.current, apiTotalCost: m.totalCost || 0, firstTokenMs: m.lastTurnFirstTokenMs, durationMs: m.lastTurnDurationMs }
            hist.push(entry)
            // Update last result ref for cache expiry warning
            if (isResult) {
              lastResultRef.current = { timestamp: Date.now(), totalInput }
            }
            // Trim: keep max 20 non-result entries; result entries are extra
            while (hist.filter(h => !h.isResult).length > 20) {
              const idx = hist.findIndex(h => !h.isResult)
              if (idx >= 0) hist.splice(idx, 1); else break
            }
          }
        }
        if (m.model) setCurrentModel(prev => prev || m.model!)
        // The sidecar downgrades effort server-side when the CLI rejects the
        // current level for the account's plan (e.g. 'max' needs API billing).
        // Reflect that here so the dropdown does not keep showing a level the
        // session no longer uses.
        if (typeof m.effort === 'string' && (CLAUDE_EFFORT_MODES as readonly string[]).includes(m.effort)) {
          setEffortLevel(prev => (prev === m.effort ? prev : m.effort!))
        }
        // Persist session metadata for status line restoration on next app launch
        if (m.contextWindow > 0 || m.totalCost > 0 || m.inputTokens > 0) {
          workspaceStore.setTerminalSessionMeta(sessionId, {
            totalCost: m.totalCost,
            inputTokens: m.inputTokens,
            outputTokens: m.outputTokens,
            durationMs: m.durationMs,
            numTurns: m.numTurns,
            contextWindow: m.contextWindow,
          })
        }
        // Sync UI with backend's current permission mode
        if (m.permissionMode) {
          setPermissionMode(m.permissionMode)
          rememberPermissionMode(sessionId, m.permissionMode)
        }
        // Persist SDK session ID per-terminal so /resume and auto-resume can find it
        if (m.sdkSessionId) {
          setHasSdkSession(true)
          workspaceStore.setTerminalSdkSessionId(sessionId, m.sdkSessionId)
        }
      }),

      api.onPermissionRequest((sid: string, data: unknown) => {
        if (sid !== sessionId) return
        setPendingPermission(data as PendingPermission)
        setPermissionFocus(0)
        setPermissionCustomText('')
      }),

      api.onAskUser((sid: string, data: unknown) => {
        if (sid !== sessionId) return
        setPendingQuestion(normalizePendingAskUser(data) as PendingAskUser)
        setAskAnswers({})
        setAskOtherText({})
      }),

      api.onAskUserResolved((sid: string, toolUseId: string) => {
        if (sid !== sessionId) return
        // Scope the dismiss to the matching toolUseId so an idempotent
        // re-broadcast (from a second window answering an already-resolved
        // question) can't close a newer prompt that has since opened.
        setPendingQuestion(prev => {
          if (!prev) return null
          if (toolUseId && prev.toolUseId && prev.toolUseId !== toolUseId) return prev
          return null
        })
      }),

      api.onPermissionResolved((sid: string, toolUseId: string) => {
        if (sid !== sessionId) return
        setPendingPermission(prev => {
          if (!prev) return null
          if (toolUseId && prev.toolUseId && prev.toolUseId !== toolUseId) return prev
          return null
        })
      }),

      api.onSessionReset((sid: string) => {
        if (sid !== sessionId) return
        setMessages([])
        setStreamingText('')
        setStreamingThinking('')
        setTaskLifecycle(new Map())
        setPendingPermission(null)
        setPendingQuestion(null)
        setAskAnswers({})
        setAskOtherText({})
        setSessionMeta(null)
        setHasSdkSession(false)
        // Do not clear worktreeInfo — resetSession preserves the worktree
        // and startSession re-emits claude:worktree-info before this event fires.
        setActivePlanFile(null)
        dismissedPlanFileRef.current = null
        workspaceStore.setTerminalSdkSessionId(sessionId, undefined)
      }),

      api.onResumeLoading((sid: string, loading: boolean) => {
        if (sid !== sessionId) return
        setIsResumingHistory(loading)
      }),

      api.onHistory((sid: string, items: unknown[]) => {
        if (sid !== sessionId) return
        archiveDlog(`${tag} onHistory items=${(items as unknown[]).length} pendingPromptSent=${pendingPromptSentRef.current}`)
        historyLoadedRef.current = true
        setIsResumingHistory(false)
        // Partition history items: main timeline vs subagent buckets
        const mainItems: MessageItem[] = []
        const subagentBuckets = new Map<string, MessageItem[]>()
        for (const item of items as MessageItem[]) {
          const parentId = (item as { parentToolUseId?: string }).parentToolUseId
          if (parentId) {
            const bucket = subagentBuckets.get(parentId) || []
            bucket.push(item)
            subagentBuckets.set(parentId, bucket)
          } else {
            mainItems.push(item)
          }
        }
        subagentMessagesRef.current = subagentBuckets
        // Restore activePlanFile from history: only show bar if last plan tool is
        // ExitPlanMode and it fired within the 10-minute badge window.
        for (let i = mainItems.length - 1; i >= 0; i--) {
          const it = mainItems[i]
          if ('toolName' in it && (it.toolName === 'EnterPlanMode' || it.toolName === 'ExitPlanMode')) {
            if (it.toolName === 'ExitPlanMode' && it.input?.planFilePath) {
              const pf = String(it.input.planFilePath)
              const shownAt = typeof it.timestamp === 'number' ? it.timestamp : Date.now()
              if (dismissedPlanFileRef.current !== pf && Date.now() - shownAt < PLAN_BADGE_TTL_MS) {
                setActivePlanFile(pf)
                setPlanFileShownAt(shownAt)
              }
            }
            break
          }
        }
        const historyItems = mainItems
        const archiveHistoryItems = historyItems.length > ARCHIVE_TRIGGER
          ? historyItems.slice(0, -VISIBLE_LIMIT)
          : []
        const liveHistoryItems = archiveHistoryItems.length > 0
          ? historyItems.slice(-VISIBLE_LIMIT)
          : historyItems
        archiveDlog(
          `${tag} onHistory reset archive items=${historyItems.length} live=${liveHistoryItems.length} archive=${archiveHistoryItems.length} loadedArchive=${loadedArchive.length} archivedCount=${archivedCountRef.current} loadedFromArchive=${loadedFromArchiveRef.current}`
        )
        if (historyItems.length > 0 || loadedFromArchiveRef.current === 0) {
          setLoadedArchive([])
          archivedCountRef.current = archiveHistoryItems.length
          loadedFromArchiveRef.current = 0
          setHasMoreArchived(false)
          window.setTimeout(() => {
            const resetArchive = host.claude.clearArchive(sessionId)
            if (archiveHistoryItems.length === 0) {
              resetArchive.catch(() => {})
              return
            }
            resetArchive
              .then(() => host.claude.archiveMessages(sessionId, archiveHistoryItems))
              .then((ok) => {
                if (ok) {
                  setHasMoreArchived(true)
                } else {
                  archivedCountRef.current = 0
                  archiveDlog(`${tag} onHistory archive history failed`)
                }
              })
              .catch((err) => {
                archivedCountRef.current = 0
                host.debug.log?.('[ClaudeAgentPanel] archive history failed:', String(err))
              })
          }, 0)
        } else {
          archiveDlog(`${tag} onHistory empty; keeping auto-loaded archive`)
        }
        setStreamingText('')
        setStreamingThinking('')

        // Auto-send pending prompt from fork AFTER history is loaded
        const t = workspaceStore.getState().terminals.find(t => t.id === sessionId)
        if (!pendingPromptSentRef.current && (t?.pendingPrompt || t?.pendingImages?.length)) {
          pendingPromptSentRef.current = true
          const prompt = t.pendingPrompt || ''
          const images = t.pendingImages
          workspaceStore.setTerminalPendingPrompt(sessionId, '')
          host.debug.log(`${tag} onHistory AUTO-SENDING pending prompt: "${prompt}" images=${images?.length ?? 0}`)
          // Set history + user message together so it doesn't get overwritten
          const userMsgId = `user-fork-${Date.now()}`
          setMessages([...liveHistoryItems, {
            id: userMsgId,
            sessionId,
            role: 'user' as const,
            content: prompt,
            timestamp: Date.now(),
          }])
          setIsStreaming(true)
          void sendClaudeMessage(
            prompt,
            images,
            getAutoCompactWindowForModel(currentModel, settingsStore.getSettings().autoCompactWindow),
            { id: userMsgId, displayContent: prompt },
          )
        } else {
          archiveDlog(`${tag} onHistory setting messages (history only, no pending prompt)`)
          setMessages(liveHistoryItems)
        }
      }),

      api.onModeChange((sid: string, mode: string) => {
        if (sid !== sessionId) return
        setPermissionMode(mode)
        rememberPermissionMode(sessionId, mode)
      }),

      // Claude Code's own command list, pushed when the CLI first knows it and
      // again whenever it discovers more (skills found while working in a
      // subdirectory, plugins reloaded). Its contract is REPLACE, not merge.
      api.onCommands((sid: string, commands: SlashCommandInfo[]) => {
        if (sid !== sessionId) return
        if (!Array.isArray(commands) || commands.length === 0) return
        setSlashCommands(commands)
        window.dispatchEvent(new CustomEvent('claude-skills-updated', { detail: { sessionId, commands } }))
      }),

      api.onPromptSuggestion((sid: string, suggestion: string) => {
        if (sid !== sessionId) return
        setPromptSuggestion(suggestion)
      }),

      api.onWorktreeInfo((sid: string, info: { branchName: string; worktreePath: string; sourceBranch: string; gitRoot?: string } | null) => {
        if (sid !== sessionId) return
        setWorktreeInfo(info)
        // Persist to terminal state for workspace save/load
        workspaceStore.setTerminalWorktreeInfo(sessionId, info?.worktreePath, info?.branchName)
      }),

      api.onRateLimit((sid: string, info: { rateLimitType: string; resetsAt: number; utilization: number | null; isUsingOverage: boolean }) => {
        if (sid !== sessionId) return
        setRateLimits(prev => ({ ...prev, [info.rateLimitType]: { resetsAt: info.resetsAt, utilization: info.utilization, isUsingOverage: info.isUsingOverage } }))
      }),
    ]

    return () => {
      host.debug.log(`${tag} unsubscribing IPC events`)
      unsubs.forEach(unsub => unsub())
    }
  }, [sessionId, archiveDlog])

  // Stable per session so a retry replaces the notice rather than stacking one.
  const remoteDisconnectNoticeId = `sys-remote-disconnected-${sessionId}`

  const previousRemoteConnectedRef = useRef(isRemoteConnected)
  useEffect(() => {
    const wasConnected = previousRemoteConnectedRef.current
    previousRemoteConnectedRef.current = isRemoteConnected
    if (wasConnected && !isRemoteConnected) {
      clearStartedSessionTracking(sessionId)
      host.debug.log(`[Claude:${sessionId.slice(0, 8)}] remote disconnected; cleared cached session startup state`)
      return
    }
    // The disconnect notice tells the user to resend once the connection is
    // back, and then nothing ever told them it was — the app re-dials within
    // half a minute while that row sits there unchanged, so a working link
    // still reads as broken. Answer the notice in place.
    if (!wasConnected && isRemoteConnected) {
      setMessages(prev => prev.map(m => (!isToolCall(m) && m.id === remoteDisconnectNoticeId)
        ? { ...m, content: 'Remote connection restored — your message is still in the input box, ready to resend.', timestamp: Date.now() }
        : m))
    }
  }, [isRemoteConnected, sessionId, remoteDisconnectNoticeId])

  // Start session on mount (guarded against StrictMode double-mount)
  // If a saved sdkSessionId exists (from a previous /resume), auto-resume that session
  useEffect(() => {
    const stag = `[Claude:${sessionId.slice(0, 8)}]`
    const dlog = (...args: unknown[]) => host.debug.log(...args)
    let cancelled = false
    cancelStartedSessionCleanup(sessionId)
    dlog(`${stag} mount effect: inSet=${startedSessions.has(sessionId)} promise=${startedSessionPromises.has(sessionId)}`)
    ;(async () => {
      try {
        await ensureSessionStarted()
        if (cancelled) return
        const existingState = await host.claude.getSessionState(sessionId).catch(() => null)
        if (cancelled || !existingState) return
        const existingMessages = (existingState.messages || []) as MessageItem[]
        historyLoadedRef.current = true
        setIsResumingHistory(false)
        // clientResume can emit claude:history while getSessionState remains
        // empty (for example when an idle persistent SDK query is still live).
        // Never apply that empty snapshot: depending on event scheduling it can
        // land just after onHistory and erase the recovered local/remote view.
        // Fresh sessions already initialize with an empty messages array.
        if (existingMessages.length > 0) {
          setMessages(existingMessages)
        } else if (host.debug.isDebugMode === true) {
          dlog(`${stag} skip empty getSessionState messages; preserving rendered history count=${messageCountRef.current} remote=${isRemoteConnected}`)
        }
        setIsStreaming(!!existingState.isStreaming)
        setStreamingText(existingState.streamingText || '')
        setStreamingThinking(existingState.streamingThinking || '')
        const meta = await host.claude.getSessionMeta(sessionId).catch(() => null)
        if (cancelled || !meta) return
        setSessionMeta(meta as unknown as SessionMeta)
        const mountHostModel = (meta as unknown as SessionMeta).model
        if (mountHostModel) {
          const normalizedMountModel = normalizeClaudeModelSelection(mountHostModel) || mountHostModel
          // Remote mode is host-owned: the picker chip must mirror the host
          // session's live model. Adopt it even when our local value is already
          // set, otherwise a stale cached terminal.model (e.g. clobbered by a
          // host workspace reload) sticks and the chip shows the wrong model.
          // Locally we keep our own value to avoid racing an in-flight change.
          setCurrentModel(prev => isRemoteConnected ? normalizedMountModel : (prev || normalizedMountModel))
        }
        if (!(meta as unknown as SessionMeta).sdkSessionId) {
          setHasSdkSession(false)
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setIsResumingHistory(false)
          const message = formatUnknownError(err)
          if (isAgentSessionCollision(message)) {
            const replacementId = workspaceStore.repairTerminalIdentityCollision(sessionId)
            dlog(`${stag} repaired duplicate profile session identity replacement=${replacementId?.slice(0, 8) || 'failed'} detail=${message}`)
            return
          }
          dlog(`${stag} mount effect init failed: ${message}`)
        }
      }
    })()
    return () => {
      cancelled = true
      scheduleStartedSessionCleanup(sessionId)
    }
  }, [sessionId, cwd, isCodexSession, codexSandboxMode, codexApprovalPolicy, isRemoteConnected])

  // Refresh session metadata when panel becomes active (fixes stale display after window switch)
  const refreshActiveSessionMeta = useCallback(() => {
    host.claude.getSessionMeta(sessionId).then(meta => {
      if (meta) {
        const nextMeta = meta as unknown as SessionMeta
        setSessionMeta(previous => JSON.stringify(previous) === JSON.stringify(nextMeta) ? previous : nextMeta)
        const hostModel = nextMeta.model
        if (hostModel) {
          const normalizedHostModel = normalizeClaudeModelSelection(hostModel) || hostModel
          // Remote mode is host-owned: on a window switch the chip must reflect
          // the host session's live model, overwriting any stale local value.
          // Locally we keep our own value to avoid racing an in-flight change
          // the host hasn't applied yet.
          setCurrentModel(prev => isRemoteConnected ? normalizedHostModel : (prev || normalizedHostModel))
        }
      }
    }).catch(() => {})
  }, [sessionId, isRemoteConnected])
  usePanelActiveEffect(activation, refreshActiveSessionMeta)

  const ensureSessionStarted = useCallback(async () => {
    const existingStart = startedSessionPromises.get(sessionId)
    if (existingStart) {
      await existingStart
      // A reconnect or a bounded-LRU remount can keep the module-level start
      // promise while creating a new panel with no renderer history. Continue
      // once per mounted panel so it can inspect/replay the transcript;
      // ordinary sends still take the fast return.
      const historyAttached = isRemoteConnected
        ? remoteHistoryAttachedRef.current
        : localHistoryAttachedRef.current
      if (historyAttached) return
    }

    const startPromise = (async () => {
      const stag = `[Claude:${sessionId.slice(0, 8)}]`
      const dlog = (...args: unknown[]) => host.debug.log(...args)
      await waitForTauriAgentListeners()
      const terminalState = workspaceStore.getState().terminals.find(t => t.id === sessionId)
      const savedSdkSessionId = terminalState?.sdkSessionId
      const savedModel = normalizeClaudeModelSelection(terminalState?.model)
      const apiVersion = terminalState?.agentPreset === 'claude-code-v2' ? 'v2' as const : 'v1' as const
      const useWorktree = terminalState?.agentPreset === 'claude-code-worktree' || !!terminalState?.worktreePath
      const globalSettings = settingsStore.getSettings()
      const effectiveModel = normalizeClaudeModelSelection(currentModel || savedModel || globalSettings.defaultClaudeModel)
      const effectiveEffortMode = effortLevel || globalSettings.defaultEffort || 'high'
      const effectiveEffort = effortLevelForClaudeMode(effectiveEffortMode) || 'high'
      const effectiveUltracode = isUltracodeEffortMode(effectiveEffortMode)

      const existingState = await host.claude.getSessionState(sessionId).catch(() => null)
      const existingMessages = existingState && Array.isArray(existingState.messages)
        ? existingState.messages
        : []
      // Remote clients always reattach through clientResume. It is
      // non-destructive (it never tears down a turn the host still has in
      // flight) and resolves the transcript by exact SDK id, so it also works
      // when the host sidecar holds no in-memory record — precisely the case
      // where resumeSession would instead rebuild the session, skip the global
      // history lookup, and leave the panel blank while the host keeps
      // streaming.
      // Local clients normally hydrate from getSessionState, but an idle panel
      // may have been evicted by the bounded terminal LRU while its sidecar
      // only retains the SDK identity. In that empty-snapshot case, replay the
      // persisted transcript non-destructively instead of rendering blank.
      // Either way there has to be something to replay — a host record or a
      // saved SDK id. With neither this is a brand-new session, so fall
      // through to startSession.
      const shouldReplayHistory = (!!existingState || !!savedSdkSessionId)
        && (isRemoteConnected || (!!existingState && !isCodexSession && existingMessages.length === 0))
      if (shouldReplayHistory) {
        // The host's live metadata is authoritative. Another client (or an
        // earlier renderer mount) may know an SDK id that was never written
        // into this workspace snapshot.
        const hostMeta = await host.claude.getSessionMeta(sessionId).catch(() => null) as SessionMeta | null
        const historySdkSessionId = hostMeta?.sdkSessionId || savedSdkSessionId || ''
        const historyCwd = hostMeta?.cwd || cwd
        // A remote live session can derive its SDK id host-side. A local
        // brand-new session with no id has no transcript to replay.
        if (!isRemoteConnected && !historySdkSessionId) {
          localHistoryAttachedRef.current = true
          dlog(`${stag} ensureSessionStarted: existing empty local session has no transcript id`)
          return
        }
        const attachKind = isRemoteConnected
          ? (existingState ? 'remote attach' : 'remote attach (no host record)')
          : 'local remount'
        dlog(`${stag} ensureSessionStarted: ${attachKind}; clientResume for history sdkSessionId=${historySdkSessionId ? historySdkSessionId.slice(0, 8) : 'host-owned'}`)
        try {
          await host.claude.clientResume(
            sessionId,
            historySdkSessionId,
            historyCwd,
            hostMeta?.model || effectiveModel || savedModel,
            apiVersion,
            useWorktree ? true : undefined,
            terminalState?.worktreePath,
            terminalState?.worktreeBranch,
            terminalState?.agentPreset,
            undefined,
            undefined,
            permissionMode,
            effectiveEffort,
            effectiveUltracode ? true : undefined,
          )
          if (isRemoteConnected) {
            remoteHistoryAttachedRef.current = true
          } else {
            localHistoryAttachedRef.current = true
          }
          if (historySdkSessionId && historySdkSessionId !== savedSdkSessionId) {
            workspaceStore.setTerminalSdkSessionId(sessionId, historySdkSessionId)
          }
          return
        } catch (err: unknown) {
          dlog(`${stag} clientResume failed: ${err instanceof Error ? err.message : String(err)}`)
          // Stop rather than "recover" into a worse state. A host record means
          // the session lives there, and a remote host may be mid-turn even
          // when it reports no record (its read-only probes answer from a map
          // that only local startSession populates). resumeSession would tear
          // that turn down, and it is redundant besides: the sidecar's
          // clientResume already falls back to a resume internally.
          if (existingState || isRemoteConnected) return
          // Local session with no host record — fall through to
          // resumeSession / startSession.
        }
      }
      if (existingState) {
        localHistoryAttachedRef.current = true
        dlog(`${stag} ensureSessionStarted: existing session`)
        return
      }

      if (savedSdkSessionId) {
        const owner = workspaceStore.findSdkSessionOwner(savedSdkSessionId, terminalState?.agentPreset, sessionId)
        if (owner) {
          dlog(`${stag} ensureSessionStarted: sdkSessionId already owned by ${owner.id}; focusing existing session and starting fresh here`)
          workspaceStore.setTerminalSdkSessionId(sessionId, undefined)
          workspaceStore.setFocusedTerminal(owner.id)
        } else {
          dlog(`${stag} ensureSessionStarted: resume sdkSessionId=${savedSdkSessionId.slice(0, 8)}`)
          const resumeResult = await host.claude.resumeSession(
            sessionId,
            savedSdkSessionId,
            cwd,
            effectiveModel || savedModel,
            apiVersion,
            useWorktree ? true : undefined,
            terminalState?.worktreePath,
            terminalState?.worktreeBranch,
            terminalState?.agentPreset,
            undefined,
            undefined,
            permissionMode,
            effectiveEffort,
            effectiveUltracode ? true : undefined,
            getAutoCompactWindowForModel(effectiveModel || savedModel, settingsStore.getSettings().autoCompactWindow),
          ) as ResumeSessionResult | null
          if (!resumeResult?.stale) {
            if (isRemoteConnected) {
              remoteHistoryAttachedRef.current = true
            } else {
              localHistoryAttachedRef.current = true
            }
            return
          }
          dlog(`${stag} ensureSessionStarted: stale sdkSessionId=${savedSdkSessionId.slice(0, 8)}; starting fresh session`)
          workspaceStore.setTerminalSdkSessionId(sessionId, undefined)
        }
      }

      dlog(`${stag} ensureSessionStarted: startSession`)
      await host.claude.startSession(sessionId, {
        cwd,
        permissionMode,
        model: effectiveModel,
        effort: effectiveEffort,
        ...(effectiveUltracode ? { ultracode: true } : {}),
        apiVersion,
        agentPreset: terminalState?.agentPreset,
        ...(isCodexSession ? { codexSandboxMode, codexApprovalPolicy } : {}),
        ...(useWorktree ? { useWorktree: true, worktreePath: terminalState?.worktreePath, worktreeBranch: terminalState?.worktreeBranch } : {}),
        ...(getAutoCompactWindowForModel(effectiveModel, globalSettings.autoCompactWindow) ? { autoCompactWindow: getAutoCompactWindowForModel(effectiveModel, globalSettings.autoCompactWindow)! } : {}),
      })
      if (isRemoteConnected) {
        remoteHistoryAttachedRef.current = true
      } else {
        localHistoryAttachedRef.current = true
      }
    })().catch((err: unknown) => {
      clearStartedSessionTracking(sessionId)
      throw err
    })

    startedSessions.add(sessionId)
    startedSessionPromises.set(sessionId, startPromise)
    await startPromise
  }, [sessionId, cwd, currentModel, effortLevel, permissionMode, isCodexSession, codexSandboxMode, codexApprovalPolicy, isRemoteConnected])

  const sendClaudeMessage = useCallback(async (
    prompt: string,
    images?: string[],
    autoCompactWindow?: number | null,
    clientMessage?: { id?: string; displayContent?: string; suppressUserEcho?: boolean },
  ) => {
    // Remember this turn's display prompt so a later barge-in can recap it.
    inFlightPromptRef.current = clientMessage?.displayContent ?? prompt
    await ensureSessionStarted()
    const recoverMissingSession = async (message: string) => {
      host.debug.log(`[Claude:${sessionId.slice(0, 8)}] sendMessage hit no-cwd (runtime restarted) — dropping phantom session, re-establishing, and retrying`)
      await host.claude.stopSession(sessionId).catch((stopErr: unknown) => {
        host.debug.log(`[Claude:${sessionId.slice(0, 8)}] no-cwd phantom cleanup failed: ${formatUnknownError(stopErr)}`)
      })
      clearStartedSessionTracking(sessionId)
      await ensureSessionStarted()
      host.debug.log(`[Claude:${sessionId.slice(0, 8)}] no-cwd recovery ready; retrying original message detail=${message}`)
      return host.claude.sendMessage(sessionId, prompt, images, autoCompactWindow, clientMessage)
    }
    try {
      const result = await host.claude.sendMessage(sessionId, prompt, images, autoCompactWindow, clientMessage)
      const resultError = agentSendResultError(result)
      if (resultError && isMissingSessionCwdError(resultError)) {
        return await recoverMissingSession(resultError)
      }
      return result
    } catch (err: unknown) {
      const message = formatUnknownError(err)
      // "session has no cwd" means the sidecar restarted underneath us: its
      // session map is empty but our module-level started-session tracking is
      // stale, so ensureSessionStarted skipped the (re)start. Clear the stale
      // tracking, re-establish (the resume path keeps the transcript), and
      // retry once with the same clientMessage so the user echo dedupes.
      if (!isMissingSessionCwdError(message)) throw err
      return await recoverMissingSession(message)
    }
  }, [ensureSessionStarted, sessionId])

  // Project .mcp.json detection. The Claude SDK silently ignores
  // <cwd>/.mcp.json unless settings.json supplies an approval marker
  // (`enableAllProjectMcpServers: true` or an exhaustive
  // `enabledMcpjsonServers: [...]`) — and SDK mode can't show the
  // CLI's interactive approval prompt. We detect the unapproved-but-
  // present case on mount and offer a one-click fix that writes
  // `enableAllProjectMcpServers: true` into project settings. Codex
  // sessions are skipped — they don't talk to the Claude CLI.
  useEffect(() => {
    if (isCodexSession) return
    if (!cwd) return
    let cancelled = false
    ;(async () => {
      try {
        const status = await host.claude.checkMcpJsonStatus(cwd) as
          { exists: boolean; approved: boolean; servers: string[] } | undefined
        if (cancelled || !status?.exists || status.approved) return
        const servers = Array.isArray(status.servers) && status.servers.length > 0
          ? status.servers.join(', ')
          : '(server list empty)'
        const ok = await host.dialog.confirm(
          `Project ${cwd} declares MCP servers in .mcp.json:\n\n  ${servers}\n\nThe Claude SDK silently skips them until they're approved. Enable them now?\n\n(Writes "enableAllProjectMcpServers": true into ${cwd}/.claude/settings.json — revoke later by editing that file.)`,
          'Approve project MCP servers?'
        )
        if (!ok || cancelled) return
        await host.claude.enableAllProjectMcp(cwd)
        setMessages(prev => [...prev, {
          id: `sys-mcp-approve-${Date.now()}`,
          sessionId,
          role: 'system' as const,
          content: `Project MCP servers (${servers}) approved. Start a new session for them to attach.`,
          timestamp: Date.now(),
        }])
      } catch { /* silent — detection is best-effort UX */ }
    })()
    return () => { cancelled = true }
  }, [sessionId, cwd, isCodexSession])

  // Fetch supported models on demand when model list is opened (no session required)
  useEffect(() => {
    if (showModelList && availableModels.length === 0) {
      host.claude.getSupportedModels(sessionId).then((models: ModelInfo[]) => {
        if (models && models.length > 0) setAvailableModels(models)
      }).catch(() => {})
    }
  }, [showModelList])  // eslint-disable-line react-hooks/exhaustive-deps

  // The runtime speaks one flat preset id per model × compact-window pair; the
  // picker splits that product back into a row per model with the windows as
  // pills. Codex models carry no preset suffix, so they keep the flat rows.
  const modelRows = useMemo(() => groupClaudeModelRows(availableModels), [availableModels])
  const activeModelRow = useMemo(() => {
    const idx = modelRows.findIndex(row =>
      row.key === currentModel || row.options.some(option => option.value === currentModel))
    return idx >= 0 ? idx : 0
  }, [modelRows, currentModel])
  // Compact window of the current selection, or undefined when the model has
  // no presets. Carried over when the user switches models.
  const activeCompactWindow = useMemo<ClaudeCompactWindow | undefined>(() => {
    for (const row of modelRows) {
      const option = row.options.find(candidate => candidate.value === currentModel)
      if (option) return option.window
    }
    return undefined
  }, [modelRows, currentModel])
  // Keyboard focus inside the picker: a row plus a pending compact window that
  // survives moving between rows. Arrows only move it — Enter or a click
  // applies, so navigating never fires a session-recreating model change.
  const [modelFocusRow, setModelFocusRow] = useState(0)
  const [modelFocusWindow, setModelFocusWindow] = useState<ClaudeCompactWindow | undefined>(undefined)
  const modelFocusSyncedRef = useRef(false)
  const modelFocusScrollRef = useRef(false)
  useEffect(() => {
    if (!showModelList) {
      modelFocusSyncedRef.current = false
      return
    }
    // The model list is fetched after the picker opens, so the first render
    // usually has no rows yet — snap focus onto the current model once they
    // land, then leave it alone so arrows keep their position.
    if (modelFocusSyncedRef.current || modelRows.length === 0) return
    modelFocusSyncedRef.current = true
    modelFocusScrollRef.current = true
    setModelFocusRow(activeModelRow)
    setModelFocusWindow(activeCompactWindow)
  }, [showModelList, modelRows, activeModelRow, activeCompactWindow])
  // Keeps the focused row visible, but only when focus moved by keyboard:
  // scrolling on hover would slide the list out from under the cursor and
  // re-trigger onMouseEnter. React re-runs the ref only when focus actually
  // moves, so a row that is already visible is never yanked either way.
  const scrollModelRowIntoView = useCallback((el: HTMLDivElement | null) => {
    if (el && modelFocusScrollRef.current) el.scrollIntoView({ block: 'nearest' })
  }, [])

  // Fetch account info and slash commands once session metadata arrives
  // Refresh account info when the account changes. The CustomEvent is window-
  // local, but App.tsx re-dispatches it from the host's claude:account-changed
  // broadcast, so this also fires for a switch made in another window or by
  // another remote client. getAccountInfo is proxied per window's profile, so
  // remote windows refetch from remote, local from local.
  useEffect(() => {
    if (isCodexSession) return
    const handler = () => {
      host.claude.getAccountInfo(sessionId).then(info => {
        if (info) setAccountInfo(info)
      }).catch(() => {})
    }
    window.addEventListener('claude-account-switched', handler)
    return () => window.removeEventListener('claude-account-switched', handler)
  }, [sessionId, isCodexSession])

  useEffect(() => {
    if (!sessionMeta?.sdkSessionId) return
    let cancelled = false
    const cancelRefresh = scheduleAgentMetadataRefresh(() => {
      if (availableModels.length === 0) {
        host.claude.getSupportedModels(sessionId).then((models: ModelInfo[]) => {
          if (cancelled) return
          if (models && models.length > 0) {
            setAvailableModels(models)
          }
        }).catch(() => {})
      }
      host.claude.getSupportedEfforts(sessionId).then((levels: string[]) => {
        if (cancelled) return
        if (levels && levels.length > 0) setAvailableEfforts(levels)
      }).catch(() => {})
      if (isCodexSession) {
        host.claude.getSupportedCodexSandboxModes(sessionId).then((modes: string[]) => {
          if (cancelled) return
          if (modes && modes.length > 0) setAvailableCodexSandboxModes(modes)
        }).catch(() => {})
        host.claude.getSupportedCodexApprovalPolicies(sessionId).then((policies: string[]) => {
          if (cancelled) return
          if (policies && policies.length > 0) setAvailableCodexApprovalPolicies(policies)
        }).catch(() => {})
      }
      if (!isCodexSession) {
        host.claude.getAccountInfo(sessionId).then(info => {
          if (cancelled) return
          if (info) setAccountInfo(info)
        }).catch(() => {})
        host.claude.getSupportedCommands(sessionId).then((cmds: SlashCommandInfo[]) => {
          if (cancelled) return
          if (cmds && cmds.length > 0) {
            setSlashCommands(cmds)
            window.dispatchEvent(new CustomEvent('claude-skills-updated', { detail: { sessionId, commands: cmds } }))
          }
        }).catch(() => {})
        host.claude.getSupportedAgents(sessionId).then((agentList) => {
          if (cancelled) return
          if (agentList && agentList.length > 0) {
            window.dispatchEvent(new CustomEvent('claude-agents-updated', { detail: { sessionId, agents: agentList } }))
          }
        }).catch(() => {})
      }
    })
    return () => {
      cancelled = true
      cancelRefresh()
    }
  }, [sessionId, sessionMeta?.sdkSessionId, availableModels.length, isCodexSession])

  // Fetch git branch while active and keep it fresh when the branch changes
  // outside the running renderer session.
  const watchActiveGitBranch = useCallback(() => {
    let disposed = false
    const refreshGitBranch = () => {
      host.git.getBranch(cwd)
        .then(branch => { if (!disposed) setGitBranch(branch) })
        .catch(() => { if (!disposed) setGitBranch(null) })
    }
    refreshGitBranch()
    const interval = window.setInterval(refreshGitBranch, 5000)
    const handleFocus = () => refreshGitBranch()
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshGitBranch()
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      disposed = true
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [cwd])
  usePanelActiveEffect(activation, watchActiveGitBranch)

  // Resolve the Task/Agent tool_use block behind a task detail view. Nested
  // subagents never reach `allMessages` — they live in their parent's bucket —
  // so the lookup has to walk the buckets too, or the modal loses the prompt,
  // the result and the elapsed time for every child agent.
  const findTaskToolCall = useCallback((taskId: string): ClaudeToolCall | undefined => {
    const inMain = allMessages.find(m => isToolCall(m) && m.id === taskId)
    if (inMain) return inMain as ClaudeToolCall
    for (const bucket of subagentMessagesRef.current.values()) {
      const inBucket = bucket.find(m => isToolCall(m) && m.id === taskId)
      if (inBucket) return inBucket as ClaudeToolCall
    }
    return undefined
  }, [allMessages])

  // The activity-tree node behind the open modal: its status/timing already
  // merge the tool block with `claude:task` lifecycle metadata, and it is the
  // only source that covers nested and lifecycle-only nodes.
  const taskModalNode = useMemo(
    () => (taskModal ? findAgentNode(agentTree, taskModal.taskId) : null),
    [agentTree, taskModal?.taskId], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Fetch subagent messages from SDK when task modal opens (for completed tasks with no streamed messages)
  useEffect(() => {
    if (!taskModal) return
    const existing = subagentMessagesRef.current.get(taskModal.taskId)
    if (existing && existing.length > 0) return // already have streamed messages
    if (taskModalNode?.status === 'running') return // still streaming, don't fetch
    const taskId = taskModal.taskId
    // Tracked so the transcript area can say "loading" instead of claiming
    // nothing was captured while the read is still in flight.
    setTaskTranscriptLoading(taskId)
    host.claude.fetchSubagentMessages(sessionId, taskId).then((msgs: unknown[]) => {
      if (msgs && msgs.length > 0) {
        subagentMessagesRef.current.set(taskId, msgs as MessageItem[])
        setTaskModalTick(t => t + 1)
      }
    }).catch(() => {}).finally(() => {
      setTaskTranscriptLoading(prev => (prev === taskId ? null : prev))
    })
    // Status is a dep so a task that finishes while its modal is open gets its
    // transcript pulled once streaming can no longer deliver it.
  }, [taskModal?.taskId, taskModalNode?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cache alarm timer — update every 30s, only show after 1min idle
  useEffect(() => {
    if (!cacheAlarmEnabled) {
      setCacheCountdown(null)
      return
    }
    const tick = () => {
      if (!lastResultRef.current) { setCacheCountdown(null); return }
      const elapsed = Date.now() - lastResultRef.current.timestamp
      if (elapsed < 60_000) { setCacheCountdown(null); return } // hide until 1min idle
      const h1 = 60 * 60 * 1000 - elapsed
      if (h1 <= 0) { setCacheCountdown(null); return }
      const m5 = 5 * 60 * 1000 - elapsed
      setCacheCountdown({ m5: Math.max(0, m5), h1 })
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [cacheAlarmEnabled])

  // Subscribe to global Claude usage from workspace store
  useEffect(() => {
    workspaceStore.startUsagePolling()
    return workspaceStore.subscribe(() => {
      const u = workspaceStore.claudeUsage
      if (u) setClaudeUsage(u)
      const a = workspaceStore.usageAccount
      if (a) setUsageAccount(a)
    })
  }, [])

  // File picker: debounced search
  useEffect(() => {
    const requestId = ++filePickerSearchRequestRef.current
    const query = filePickerQuery.trim()
    if (!showFilePicker || !query) {
      setFilePickerResults([])
      setFilePickerIndex(0)
      setFilePickerLoading(false)
      setFilePickerError(null)
      return
    }
    setFilePickerResults([])
    setFilePickerIndex(0)
    setFilePickerLoading(true)
    setFilePickerError(null)
    const timer = setTimeout(() => {
      const startedAt = performance.now()
      host.fs.search(cwd, query, true).then((results: FilePickerSearchEntry[]) => {
        if (filePickerSearchRequestRef.current !== requestId) return
        const prepared = prepareFilePickerResults(results, query)
        setFilePickerResults(prepared)
        setFilePickerIndex(0)
        if (host.debug.isDebugMode === true) {
          void host.debug.log(`[Claude:${sessionId.slice(0, 8)}] Ctrl+P search ok remote=${isRemoteConnected} results=${prepared.length} elapsedMs=${Math.round(performance.now() - startedAt)}`)
        }
      }).catch((error) => {
        if (filePickerSearchRequestRef.current !== requestId) return
        const message = formatUnknownError(error)
        setFilePickerResults([])
        const label = isRemoteConnected ? 'Remote file search failed' : 'File search failed'
        setFilePickerError(`${label}: ${message}`)
        void host.debug.log(`[Claude:${sessionId.slice(0, 8)}] Ctrl+P search failed remote=${isRemoteConnected} error=${message}`)
      }).finally(() => {
        if (filePickerSearchRequestRef.current === requestId) setFilePickerLoading(false)
      })
    }, isRemoteConnected ? 250 : 150)
    return () => {
      clearTimeout(timer)
      if (filePickerSearchRequestRef.current === requestId) filePickerSearchRequestRef.current += 1
    }
  }, [filePickerQuery, showFilePicker, cwd, isRemoteConnected, sessionId])

  // Focus textarea when active without reconciling the full message timeline.
  const focusActiveTextarea = useCallback(() => {
    textareaRef.current?.focus()
  }, [])
  usePanelActiveEffect(activation, focusActiveTextarea)

  const handleModelSelect = useCallback(async (modelValue: string) => {
    const selectedModel = normalizeClaudeModelSelection(modelValue) || modelValue
    // Codex needs no warning or teardown: turn/start carries `model` as a
    // sticky per-turn override, so the new model picks up the same thread
    // with its history intact.
    // V2: warn that model change will recreate session and re-apply context
    if (!isCodexSession && isV2Session && selectedModel !== currentModel) {
      const ok = await host.dialog.confirm(t('claude.v2ModelChangeWarning'))
      if (!ok) return
    }
    // V1: warn about 1M model cache inefficiency
    if (!isCodexSession && !isV2Session && selectedModel.includes('[1m]') && selectedModel !== currentModel) {
      const ok = await host.dialog.confirm(t('claude.v1Model1mWarning'))
      if (!ok) return
    }
    setShowModelList(false)
    setCurrentModel(selectedModel)
    setTimeout(() => textareaRef.current?.focus(), 0)
    await host.claude.setModel(sessionId, selectedModel, getAutoCompactWindowForModel(selectedModel, settingsStore.getSettings().autoCompactWindow) || undefined)
    workspaceStore.updateTerminalModel(sessionId, selectedModel)
  }, [sessionId, isCodexSession, isV2Session, currentModel, t])

  const handleResumeSelect = useCallback(async (sdkSessionId: string) => {
    host.debug.log(`[Claude:${sessionId.slice(0, 8)}] handleResumeSelect sdkSessionId=${sdkSessionId.slice(0, 8)}`)
    const owner = workspaceStore.findSdkSessionOwner(sdkSessionId, terminal?.agentPreset, sessionId)
    if (owner) {
      workspaceStore.setFocusedTerminal(owner.id)
      setShowResumeList(false)
      setResumeSessions([])
      setResumeLoading(false)
      window.alert(`This Claude session is already open in "${owner.alias || owner.title}". Switched to that session instead.`)
      return
    }
    setResumeLoading(true)
    try {
      const latest = await host.claude.listSessions(cwd) || []
      if (!latest.some(s => s.sdkSessionId === sdkSessionId)) {
        setResumeSessions(latest)
        setShowResumeList(true)
        return
      }
    } catch {
      setResumeSessions([])
      setShowResumeList(true)
      return
    } finally {
      setResumeLoading(false)
    }
    setShowResumeList(false)
    setResumeSessions([])
    // Clear UI immediately so user sees the switch
    setMessages([])
    setLoadedArchive([])
    archivedCountRef.current = 0
    loadedFromArchiveRef.current = 0
    setHasMoreArchived(false)
    setStreamingText('')
    setStreamingThinking('')
    setIsStreaming(false)
    setSessionMeta(null)
    // Reset the started guard so the new session can start
    clearStartedSessionTracking(sessionId)
    // Mark that history will be loaded — prevents sys-init from wiping messages
    historyLoadedRef.current = true
    const apiVersion = isV2Session ? 'v2' as const : 'v1' as const
    const resumeModel = currentModel || settingsStore.getSettings().defaultClaudeModel || undefined
    const resumeEffort = effortLevelForClaudeMode(effortLevel) || 'high'
    const result = await host.claude.resumeSession(
      sessionId,
      sdkSessionId,
      cwd,
      resumeModel,
      apiVersion,
      undefined,
      undefined,
      undefined,
      terminal?.agentPreset,
      undefined,
      undefined,
      permissionMode,
      resumeEffort,
      isUltracodeEffortMode(effortLevel) ? true : undefined,
      getAutoCompactWindowForModel(resumeModel, settingsStore.getSettings().autoCompactWindow),
    ) as ResumeSessionResult | null
    if (result?.stale) {
      workspaceStore.setTerminalSdkSessionId(sessionId, undefined)
      setHasSdkSession(false)
      return
    }
    workspaceStore.setTerminalSdkSessionId(sessionId, sdkSessionId)
  }, [sessionId, cwd, isV2Session, terminal?.agentPreset, currentModel, permissionMode, effortLevel])

  const handleForkSession = useCallback(async () => {
    const dlog = (...args: unknown[]) => host.debug.log(...args)
    const tag = `[Fork:${sessionId.slice(0, 8)}]`
    dlog(`${tag} start hasSdkSession=${hasSdkSession} workspaceId=${workspaceId}`)
    if (!hasSdkSession || !workspaceId) return
    let result: { newSdkSessionId: string } | null = null
    try {
      result = await host.claude.forkSession(sessionId)
    } catch (e) {
      dlog(`${tag} forkSession threw:`, e)
      alert('Fork failed: ' + (e instanceof Error ? e.message : String(e)))
      return
    }
    dlog(`${tag} forkSession result=`, result)
    if (!result?.newSdkSessionId) {
      dlog(`${tag} fork returned null — check main process logs`)
      alert('Fork failed: backend returned no session ID. Check that Claude session is active.')
      return
    }

    const prompt = inputValueRef.current.trim()
    const images = attachedImages.map(img => img.dataUrl)
    dlog(`${tag} prompt="${prompt}" images=${images.length}`)
    if (prompt || images.length > 0) {
      inputValueRef.current = ''
      if (textareaRef.current) textareaRef.current.value = ''
      setAttachedImages([])
    }

    const newTerminal = workspaceStore.addTerminal(workspaceId, 'claude-code' as AgentPresetId)
    dlog(`${tag} newTerminal=${newTerminal.id.slice(0, 8)}`)
    workspaceStore.setTerminalSdkSessionId(newTerminal.id, result.newSdkSessionId)
    if (currentModel) {
      workspaceStore.updateTerminalModel(newTerminal.id, currentModel)
    }
    if (prompt || images.length > 0) {
      workspaceStore.setTerminalPendingPrompt(newTerminal.id, prompt, images.length > 0 ? images : undefined)
      dlog(`${tag} set pendingPrompt on ${newTerminal.id.slice(0, 8)}: "${prompt}" images=${images.length}`)
    }
    workspaceStore.setFocusedTerminal(newTerminal.id)
    workspaceStore.save()

    // Verify store state
    const stored = workspaceStore.getState().terminals.find(t => t.id === newTerminal.id)
    dlog(`${tag} stored terminal: sdkSessionId=${stored?.sdkSessionId?.slice(0, 8)} pendingPrompt="${stored?.pendingPrompt}" pendingImages=${stored?.pendingImages?.length ?? 0}`)
  }, [sessionId, workspaceId, hasSdkSession, currentModel, attachedImages])

  const handleRewindToPrompt = useCallback(async (promptIndex: number, promptCount: number) => {
    const removed = promptCount - promptIndex
    const confirmMsg = `Rewind to before prompt #${promptIndex + 1}?\n\nThis will remove the last ${removed} prompt(s) and their responses from conversation history. The original session history is preserved on disk.`
    if (!window.confirm(confirmMsg)) return

    let result: { newSdkSessionId: string; removedPromptCount: number } | { error: string }
    try {
      result = await host.claude.rewindToPrompt(sessionId, promptIndex)
    } catch (e) {
      alert('Rewind failed: ' + (e instanceof Error ? e.message : String(e)))
      return
    }
    if ('error' in result) {
      alert('Rewind failed: ' + result.error)
      return
    }

    // Trim local message state: keep messages BEFORE the Nth user prompt.
    // Splice allMessages (loadedArchive + messages) at the cutoff and redistribute.
    const combined = [...loadedArchive, ...messages]
    let userPromptCount = 0
    let cutoffIdx = combined.length
    for (let i = 0; i < combined.length; i++) {
      const m = combined[i]
      if (!isToolCall(m) && (m as ClaudeMessage).role === 'user') {
        if (userPromptCount === promptIndex) {
          cutoffIdx = i
          break
        }
        userPromptCount++
      }
    }
    const kept = combined.slice(0, cutoffIdx)
    // Put everything into loadedArchive so later streaming appends to messages cleanly
    setLoadedArchive(kept)
    setMessages([])

    workspaceStore.setTerminalSdkSessionId(sessionId, result.newSdkSessionId)
    setShowPromptHistory(false)
  }, [sessionId, loadedArchive, messages])

  const clearInput = useCallback(() => {
    inputValueRef.current = ''
    if (textareaRef.current) {
      textareaRef.current.value = ''
      textareaRef.current.style.height = 'auto'
    }
  }, [])

  const setInputValue = useCallback((val: string) => {
    inputValueRef.current = val
    if (textareaRef.current) {
      textareaRef.current.value = val
      // Auto-resize after setting value
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [])

  // Listen for skill insertion from SkillsPanel only while this panel is active.
  const bindActiveSkillInsertion = useCallback(() => {
    const handler = (e: Event) => {
      const { name } = (e as CustomEvent).detail as { name: string }
      setInputValue('/' + name + ' ')
      textareaRef.current?.focus()
    }
    window.addEventListener('claude-insert-command', handler)
    return () => window.removeEventListener('claude-insert-command', handler)
  }, [setInputValue])
  usePanelActiveEffect(activation, bindActiveSkillInsertion)

  const handleSend = useCallback(async () => {
    const __sendT0 = performance.now()
    const trimmed = inputValueRef.current.trim()
    if (!trimmed && attachedImages.length === 0 && attachedFiles.length === 0) return

    // Save to input history
    if (trimmed) {
      inputHistoryRef.current.push(trimmed)
    }
    inputHistoryIndexRef.current = -1
    inputDraftRef.current = ''

    // Intercept /auto-continue and /ac — toggle host-side auto-continue.
    // Syntax:
    //   /auto-continue                   enable, default max=3, prompt="繼續"
    //   /auto-continue 5                 enable, max=5, prompt="繼續"
    //   /auto-continue 5 請繼續未完成的    enable, max=5, custom prompt
    //   /auto-continue 請繼續              enable, max=3, custom prompt
    //   /auto-continue off | stop         disable
    if (trimmed === '/auto-continue' || trimmed === '/ac' ||
        trimmed.startsWith('/auto-continue ') || trimmed.startsWith('/ac ')) {
      clearInput()
      const cmd = trimmed.startsWith('/auto-continue') ? '/auto-continue' : '/ac'
      const rest = trimmed.slice(cmd.length).trim()
      let content: string
      if (rest === 'off' || rest === 'stop') {
        await host.claude.setAutoContinue(sessionId, { enabled: false })
        content = 'Auto-continue disabled.'
      } else {
        let max = 3
        let prompt = '繼續'
        const m = rest.match(/^(\d+)(?:\s+([\s\S]+))?$/)
        if (m) {
          max = parseInt(m[1], 10)
          if (m[2]) prompt = m[2].trim()
        } else if (rest) {
          prompt = rest
        }
        await host.claude.setAutoContinue(sessionId, { enabled: true, max, prompt })
        content = `Auto-continue enabled (max ${max}). Prompt: "${prompt}"`
      }
      setMessages(prev => [...prev, {
        id: `sys-ac-${Date.now()}`, sessionId, role: 'system' as const,
        content, timestamp: Date.now(),
      }])
      return
    }

    const workerCommand = parseWorkerSlashCommand(trimmed)
    if (workerCommand) {
      clearInput()
      const content = await dispatchWorkerCommand(workerCommand, workspaceId)
      setMessages(prev => [...prev, {
        id: `sys-worker-${Date.now()}`,
        sessionId,
        role: 'system' as const,
        content,
        timestamp: Date.now(),
      }])
      return
    }

    // Intercept /resume command (only when not streaming)
    if (!isStreaming && trimmed === '/resume') {
      clearInput()
      setShowResumeList(true)
      return
    }

    // Intercept /model command
    if (trimmed === '/model') {
      clearInput()
      setShowModelList(true)
      return
    }

    // Intercept /abort command — force stop current operation
    if (trimmed === '/abort') {
      clearInput()
      host.claude.abortSession(sessionId)
      setIsStreaming(false)
      setIsInterrupted(false)
      setStreamingText('')
      setStreamingThinking('')
      setPendingPermission(null)
      setMessages(prev => {
        const updated = prev.map(m => {
          if ('toolName' in m && (m as ClaudeToolCall).status === 'running') {
            return { ...m, status: 'error', denied: true } as ClaudeToolCall
          }
          return m
        })
        return [...updated, {
          id: `sys-abort-${Date.now()}`,
          sessionId,
          role: 'system' as const,
          content: 'Session aborted.',
          timestamp: Date.now(),
        }]
      })
      return
    }

    // Intercept /new or /clear command — reset session (clear conversation, fresh start)
    if (!isStreaming && (trimmed === '/new' || trimmed === '/clear')) {
      clearInput()
      setMessages([])
      setLoadedArchive([])
      archivedCountRef.current = 0
      loadedFromArchiveRef.current = 0
      setHasMoreArchived(false)
      setStreamingText('')
      setStreamingThinking('')
      cacheHistoryRef.current = []
      lastResultRef.current = null
      setCacheCountdown(null)
      // Forget the resumed SDK session so the next message starts fresh.
      // Otherwise ensureSessionStarted would re-resume the just-cleared
      // conversation from the persisted sdkSessionId.
      workspaceStore.setTerminalSdkSessionId(sessionId, undefined)
      await host.claude.resetSession(sessionId)
      return
    }

    // Intercept /login command — open the Claude auth login flow. Delegates to
    // the same handler as the account chip in both local and remote mode: the
    // CLI redirects to a hosted callback, so the code has to be pasted into the
    // sign-in dialog. Awaiting `authLogin()` here could only ever time out.
    if (!isCodexSession && trimmed === '/login') {
      clearInput()
      if (onRequestLogin) {
        setMessages(prev => [...prev, {
          id: `sys-login-${Date.now()}`, sessionId, role: 'system' as const,
          content: 'Opening Claude login...', timestamp: Date.now(),
        }])
        onRequestLogin('claude')
      } else {
        setMessages(prev => [...prev, {
          id: `sys-login-err-${Date.now()}`, sessionId, role: 'system' as const,
          content: 'Login is not available from this view — use the account chip in the top bar.',
          timestamp: Date.now(),
        }])
      }
      return
    }

    // Intercept /logout command
    if (!isCodexSession && trimmed === '/logout') {
      clearInput()
      const result = await host.claude.authLogout()
      setMessages(prev => [...prev, {
        id: `sys-logout-${Date.now()}`, sessionId, role: 'system' as const,
        content: result.success ? 'Logged out.' : `Logout failed: ${result.error || 'unknown error'}`,
        timestamp: Date.now(),
      }])
      return
    }

    // Intercept /whoami command — show current auth status
    if (!isCodexSession && trimmed === '/whoami') {
      clearInput()
      const status = await host.claude.authStatus()
      setMessages(prev => [...prev, {
        id: `sys-whoami-${Date.now()}`, sessionId, role: 'system' as const,
        content: status?.loggedIn
          ? `${status.email || 'unknown'} (${status.authMethod || ''}, ${status.subscriptionType || ''})`
          : 'Not logged in.',
        timestamp: Date.now(),
      }])
      return
    }

    // Intercept /switch command — list accounts or switch to a specific one
    if (!isCodexSession && (trimmed === '/switch' || trimmed.startsWith('/switch '))) {
      const arg = trimmed.slice('/switch'.length).trim()
      clearInput()
      try {
        const { accounts, activeAccountId } = await host.claude.accountList()
        if (accounts.length === 0) {
          setMessages(prev => [...prev, {
            id: `sys-switch-${Date.now()}`, sessionId, role: 'system' as const,
            content: 'No accounts registered. Use /login to add accounts.',
            timestamp: Date.now(),
          }])
          return
        }
        if (!arg) {
          const lines = accounts.map((a, i) => {
            const active = a.id === activeAccountId ? ' ← active' : ''
            const sub = a.subscriptionType ? ` (${a.subscriptionType})` : ''
            return `  ${i + 1}. ${a.email}${sub}${active}`
          })
          setMessages(prev => [...prev, {
            id: `sys-switch-list-${Date.now()}`, sessionId, role: 'system' as const,
            content: `Accounts:\n${lines.join('\n')}\n\nUse /switch <number> or /switch <email> to switch.`,
            timestamp: Date.now(),
          }])
          return
        }
        const idx = parseInt(arg, 10)
        const target = !isNaN(idx) && idx >= 1 && idx <= accounts.length
          ? accounts[idx - 1]
          : accounts.find(a => a.email.toLowerCase().includes(arg.toLowerCase()))
        if (!target) {
          setMessages(prev => [...prev, {
            id: `sys-switch-notfound-${Date.now()}`, sessionId, role: 'system' as const,
            content: `Account not found: "${arg}". Use /switch to list accounts.`,
            timestamp: Date.now(),
          }])
          return
        }
        if (target.id === activeAccountId) {
          setMessages(prev => [...prev, {
            id: `sys-switch-already-${Date.now()}`, sessionId, role: 'system' as const,
            content: `Already using ${target.email}.`,
            timestamp: Date.now(),
          }])
          return
        }
        const success = await host.claude.accountSwitch(target.id)
        if (success) {
          window.dispatchEvent(new CustomEvent('claude-account-switched'))
          setMessages(prev => [...prev, {
            id: `sys-switch-ok-${Date.now()}`, sessionId, role: 'system' as const,
            content: `Switched to ${target.email}. New sessions will use this account.`,
            timestamp: Date.now(),
          }])
        } else {
          setMessages(prev => [...prev, {
            id: `sys-switch-err-${Date.now()}`, sessionId, role: 'system' as const,
            content: `Failed to switch to ${target.email}.`,
            timestamp: Date.now(),
          }])
        }
      } catch (err: unknown) {
        setMessages(prev => [...prev, {
          id: `sys-switch-err-${Date.now()}`, sessionId, role: 'system' as const,
          content: `Switch error: ${err instanceof Error ? err.message : 'unknown error'}`,
          timestamp: Date.now(),
        }])
      }
      return
    }

    // Intercept /snippet command and inject snippet contents into Claude.
    const snippetCommand = !isCodexSession ? parseSnippetSlashCommand(trimmed) : null
    if (snippetCommand) {
      clearInput()
      try {
        const snippets = snippetCommand.searchQuery
          ? await host.snippet.search(snippetCommand.searchQuery)
          : await host.snippet.getByWorkspace(workspaceId)
        const contextPrompt = buildSnippetContextPrompt(snippets as SnippetForContext[], snippetCommand, workspaceId)
        // Show clean user message
        const userMsgId = `user-${Date.now()}`
        setMessages(prev => [...prev, {
          id: userMsgId,
          sessionId,
          role: 'user' as const,
          content: trimmed,
          timestamp: Date.now(),
        }])
        setIsStreaming(true)
        setIsInterrupted(false)
        setStreamingText('')
        setStreamingThinking('')
        await sendClaudeMessage(
          contextPrompt,
          undefined,
          getAutoCompactWindowForModel(currentModel, settingsStore.getSettings().autoCompactWindow),
          { id: userMsgId, displayContent: trimmed },
        )
      } catch (err) {
        if (isSendMessageTimeout(formatUnknownError(err))) {
          host.debug.log(`[Claude:${sessionId.slice(0, 8)}] snippet sendMessage RPC timed out; turn still active, letting claude:* events drive completion.`)
          return
        }
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}`,
          sessionId,
          role: 'system' as const,
          content: 'Failed to load snippets.',
          timestamp: Date.now(),
        }])
      }
      return
    }

    // Cache expiry warning: if enabled, last result had >150k tokens, and >1h has passed
    if (settingsStore.getSettings().cacheExpiryWarning && lastResultRef.current) {
      const { timestamp, totalInput } = lastResultRef.current
      const elapsed = Date.now() - timestamp
      if (totalInput > 150_000 && elapsed > 60 * 60 * 1000) {
        const mins = Math.floor(elapsed / 60000)
        const ok = await host.dialog.confirm(
          `⚠️ Cache expired\n\nLast turn had ${(totalInput / 1000).toFixed(0)}k input tokens, but ${mins} minutes have passed (cache TTL: 60 min).\n\nThis request will re-process all tokens at full price, which may incur significant costs.\n\nContinue?`
        )
        if (!ok) return
      }
    }

    const imageDataUrls = attachedImages.map(i => i.dataUrl)
    const filePaths = attachedFiles.map(f => f.path)
    clearInput()
    setAttachedImages([])
    setAttachedFiles([])
    setPromptSuggestion(null)
    setShowSlashMenu(false)
    // Barge-in: sending while a turn is genuinely mid-flight (streaming and not
    // already soft-interrupted) ends that turn and lets this message take over —
    // the old "type to steer" behaviour. The interrupted request is folded into
    // the prompt below so it is not forgotten. Otherwise (idle / already
    // interrupted) just (re)start the streaming UI optimistically.
    const isBargeIn = isStreaming && !isInterrupted
    const interruptedPrompt = isBargeIn ? inFlightPromptRef.current : ''
    if (isBargeIn) {
      bargeInPendingRef.current = true
      setStreamingText('')
      setStreamingThinking('')
      setPendingPermission(null)
      try {
        await host.claude.interruptTurn(sessionId)
      } catch {
        // Interrupt failed — fall through; the send still queues behind the
        // current turn (degrades to the prior wait-for-turn behaviour).
        bargeInPendingRef.current = false
      }
    } else {
      setIsStreaming(true)
      setIsInterrupted(false)
      setStreamingText('')
      setStreamingThinking('')
    }

    // Build prompt with file paths prepended
    let promptToSend = trimmed
    if (filePaths.length > 0) {
      const filePrefix = filePaths.map(p => `@${p}`).join('\n')
      promptToSend = filePrefix + (trimmed ? '\n\n' + trimmed : '')
    }
    // Fold the interrupted request into the model prompt (not the displayed
    // text) so a barge-in does not drop it from context. Kept to a short recap
    // line — the model only needs the reminder, not a full re-issue.
    if (isBargeIn && interruptedPrompt.trim()) {
      promptToSend = `[Interrupted request] ${interruptedPrompt.trim()}\n\n${promptToSend}`
    }

    // Echo the user message locally so it appears immediately. Remote clients
    // tag it 'sending' (ghosted) until the host acks via invoke-result / echoes
    // it back; running turns still wait for the host so wrapping/queueing stays
    // consistent.
    const shouldEchoUserMessageLocally = !isStreaming || isInterrupted
    const imageNote = imageDataUrls.length > 0
      ? `\n[${imageDataUrls.length} image${imageDataUrls.length > 1 ? 's' : ''} attached]`
      : ''
    const fileNames = filePaths.map(p => p.split('/').pop()).join(', ')
    const fileNote = filePaths.length > 0
      ? `\n[${filePaths.length} file${filePaths.length > 1 ? 's' : ''} attached: ${fileNames}]`
      : ''
    const displayContent = (trimmed + imageNote + fileNote).replace(/^\n/, '')
    const userMsgId = `user-${Date.now()}`
    currentTurnMsgIdRef.current = userMsgId
    if (shouldEchoUserMessageLocally) {
      setMessages(prev => [...prev, {
        id: userMsgId,
        sessionId,
        role: 'user' as const,
        content: displayContent,
        timestamp: Date.now(),
        status: isRemoteConnected ? ('sending' as const) : undefined,
      }])
    }

    const __sendT1 = performance.now()
    try {
      const sendResult = await sendClaudeMessage(
        promptToSend,
        imageDataUrls.length > 0 ? imageDataUrls : undefined,
        getAutoCompactWindowForModel(currentModel, settingsStore.getSettings().autoCompactWindow),
        { id: userMsgId, displayContent },
      ) as { cancelled?: boolean } | undefined
      if (sendResult?.cancelled) {
        // Queued behind a turn that got interrupted/stopped before this
        // message's turn came up — Esc cancels it too instead of letting it
        // silently fire once the stopped turn clears. Restore the text so
        // it isn't lost.
        if (trimmed && !inputValueRef.current.trim()) setInputValue(trimmed)
        setIsStreaming(false)
        setIsInterrupted(false)
        setMessages(prev => [...prev, {
          id: `sys-cancelled-${Date.now()}`,
          sessionId,
          role: 'system' as const,
          content: 'Message cancelled — the turn it was waiting behind was stopped. Your text has been restored to the input box.',
          timestamp: Date.now(),
        }])
        return
      }
      if (isRemoteConnected) {
        // The host acks on receipt now, so this lands promptly and is a real
        // de-ghosting path rather than a backstop. Hosts older than the split
        // still reply at turn end; the user echo clears the ghost for those.
        setMessages(prev => prev.map(m => (!isToolCall(m) && m.id === userMsgId) ? { ...m, status: 'sent' as const } : m))
      }
    } catch (err) {
      const message = formatUnknownError(err)
      if (isSendMessageTimeout(message)) {
        host.debug.log(`[Claude:${sessionId.slice(0, 8)}] sendMessage RPC timed out; turn still active, letting claude:* events drive completion. detail=${message}`)
        // Say so in the timeline. The request deadline is not the turn's
        // deadline, but until now this was a debug-log-only event: the UI went
        // silent at the 5-minute mark and a long turn looked exactly like a
        // hung one, with nothing to tell the user which they were watching.
        setMessages(prev => {
          const noticeId = `sys-send-timeout-${userMsgId}`
          if (prev.some(m => m.id === noticeId)) return prev
          // The host took the prompt — it is the acknowledgement that was lost,
          // so stop showing the message as still being sent.
          const settled = prev.map(m => (!isToolCall(m) && m.id === userMsgId)
            ? { ...m, status: 'sent' as const }
            : m)
          return [...settled, {
            id: noticeId,
            sessionId,
            role: 'system' as const,
            content: 'This turn outran the 5-minute request deadline. It is still running — only the acknowledgement timed out, and output will keep arriving.',
            timestamp: Date.now(),
          }]
        })
        return
      }
      setIsStreaming(false)
      setIsInterrupted(false)
      setStreamingText('')
      setStreamingThinking('')
      setPendingPermission(null)
      setSessionMeta(prev => clearRuntimeStatusMeta(prev))
      if (isRemoteDisconnectedError(message)) {
        // The remote dropped before the message left this machine. Restore the
        // user's text so nothing is lost, drop the optimistic echo, and tell
        // them it's reconnecting — the app re-dials automatically in the
        // background, after which they can resend.
        setMessages(prev => {
          const withoutEcho = prev.filter(m => isToolCall(m) || m.id !== userMsgId)
          const notice = {
            id: remoteDisconnectNoticeId,
            sessionId,
            role: 'system' as const,
            content: 'Remote connection lost — your message was not sent and has been restored to the input box. Reconnecting automatically; please resend once the connection is back.',
            timestamp: Date.now(),
          }
          // Reuse one row instead of appending. Every retry while the link is
          // down otherwise stacks an identical notice, which reads as the
          // failure getting worse when it is the same failure each time.
          const existing = withoutEcho.findIndex(m => m.id === remoteDisconnectNoticeId)
          if (existing < 0) return [...withoutEcho, notice]
          const copy = [...withoutEcho]
          copy[existing] = notice
          return copy
        })
        if (trimmed && !inputValueRef.current.trim()) setInputValue(trimmed)
        return
      }
      if (isRemoteConnected) {
        // Real send error (not a timeout — those return early and let claude:*
        // events drive the turn) → mark the ghosted message failed.
        setMessages(prev => prev.map(m => (!isToolCall(m) && m.id === userMsgId) ? { ...m, status: 'failed' as const } : m))
      }
      setMessages(prev => [...prev, {
        id: `err-send-${Date.now()}`,
        sessionId,
        role: 'system' as const,
        content: `Error: ${message}`,
        timestamp: Date.now(),
      }])
    } finally {
      const __sendT2 = performance.now()
      const sync = __sendT1 - __sendT0
      const invoke = __sendT2 - __sendT1
      const total = __sendT2 - __sendT0
      if (total > 50) {
        host.debug.log(`[handleSend] sync=${sync.toFixed(1)}ms invoke=${invoke.toFixed(1)}ms total=${total.toFixed(1)}ms sessionId=${sessionId} promptLen=${trimmed.length}`)
      }
    }
  }, [isRemoteConnected, isStreaming, isInterrupted, sessionId, attachedImages, attachedFiles, clearInput, setInputValue, sendClaudeMessage, onRequestLogin])

  const handleInterrupt = useCallback(() => {
    if (!isStreaming) return
    // Soft interrupt (1× Esc): turn-only interrupt that keeps the subprocess
    // + LiveQuery alive, so background dynamic workflows / subagents are NOT
    // killed and the user can keep typing to continue. The hard stop (2× Esc)
    // still goes through abortSession.
    host.claude.interruptTurn(sessionId)
    setIsInterrupted(true)
    setStreamingText('')
    setStreamingThinking('')
    setPendingPermission(null)
    textareaRef.current?.focus()
  }, [sessionId, isStreaming])

  const handleStop = useCallback(() => {
    if (!isStreaming && !isInterrupted) return
    // Hard abort — immediately kill the query loop
    host.claude.abortSession(sessionId)
    setIsStreaming(false)
    setIsInterrupted(false)
    setStreamingText('')
    setStreamingThinking('')
    setPendingPermission(null)
    setMessages(prev => {
      // Mark any running tool calls as interrupted (red dot)
      const updated = prev.map(m => {
        if ('toolName' in m && (m as ClaudeToolCall).status === 'running') {
          return { ...m, status: 'error', denied: true } as ClaudeToolCall
        }
        return m
      })
      return [...updated, {
        id: `sys-stop-${Date.now()}`,
        sessionId,
        role: 'system' as const,
        content: 'Interrupted by user. You can continue typing.',
        timestamp: Date.now(),
      }]
    })
    // Focus textarea so user can type immediately
    textareaRef.current?.focus()
  }, [sessionId, isStreaming, isInterrupted])

  // auto and dontAsk are deliberately outside the allowBypassPermissions gate
  // below: neither hands out a blank cheque. auto has Claude Code's classifier
  // vet each action and still escalates what it won't decide, and dontAsk denies
  // anything not pre-approved. Gating them behind the bypass opt-in would hide
  // the two modes a cautious user most wants.
  const permissionModes = PERMISSION_MODES
  const permissionModeLabels = PERMISSION_MODE_LABELS

  const handlePermissionModeCycle = useCallback(async () => {
    const allowBypass = settingsStore.getSettings().allowBypassPermissions
    const availableModes: readonly (typeof permissionModes[number])[] = allowBypass
      ? permissionModes
      : permissionModes.filter(m => m !== 'bypassPermissions' && m !== 'bypassPlan')
    const idx = availableModes.indexOf(permissionMode as typeof permissionModes[number])
    const nextMode = availableModes[(idx + 1) % availableModes.length]
    setPermissionMode(nextMode)
    rememberPermissionMode(sessionId, nextMode)
    await host.claude.setPermissionMode(sessionId, nextMode)
  }, [sessionId, permissionMode])

  useEffect(() => { showSlashMenuRef.current = showSlashMenu }, [showSlashMenu])

  // Filtered slash commands based on current input
  const slashGroups = useMemo(() => {
    if (!showSlashMenu) return []
    const builtIn: SlashCommandInfo[] = isCodexSession
      ? [
          { name: 'new', description: 'Reset session (clear conversation)', argumentHint: '' },
          { name: 'clear', description: 'Reset session (same as /new)', argumentHint: '' },
          { name: 'model', description: 'Select model', argumentHint: '' },
          { name: 'abort', description: 'Force stop current operation immediately', argumentHint: '' },
          { name: 'worker', description: 'Inspect or control worker processes', argumentHint: '<name|all> [status|start|stop|restart|reload|clear]' },
        ]
      : [
          { name: 'new', description: 'Reset session (clear conversation)', argumentHint: '' },
          { name: 'clear', description: 'Reset session (same as /new)', argumentHint: '' },
          { name: 'snippet', description: 'Show snippets to Claude for management', argumentHint: '' },
          { name: 'worker', description: 'Inspect or control worker processes', argumentHint: '<name|all> [status|start|stop|restart|reload|clear]' },
          { name: 'resume', description: 'Resume a previous session', argumentHint: '' },
          { name: 'model', description: 'Select model', argumentHint: '' },
          { name: 'compact', description: 'Manually compact conversation context', argumentHint: '[instructions]' },
          { name: 'login', description: 'Sign in to Claude (switch account)', argumentHint: '' },
          { name: 'abort', description: 'Force stop current operation immediately', argumentHint: '' },
          { name: 'logout', description: 'Sign out of Claude', argumentHint: '' },
          { name: 'whoami', description: 'Show current account info', argumentHint: '' },
          { name: 'switch', description: 'Switch between registered accounts', argumentHint: '<number|email>' },
        ]
    // slashCommands is Claude Code's own list — its built-ins, plugin commands
    // and skills. Merged rather than concatenated because the two sides share
    // half a dozen names (/model, /compact, /login …) that BAT intercepts before
    // the prompt is ever sent, so the CLI's copy would be a row that does nothing.
    return groupSlashCommands(
      filterSlashCommands(mergeSlashCommands(builtIn, slashCommands), slashFilter),
    )
  }, [showSlashMenu, slashFilter, slashCommands, isCodexSession])

  // Arrow keys index this flat list while the menu renders headed sections.
  // Deriving it from the groups (instead of building both from the same source)
  // is what guarantees the highlighted row is the row Enter runs.
  const filteredSlashCommands = useMemo(() => flattenSlashGroups(slashGroups), [slashGroups])
  const slashIndexByName = useMemo(() => {
    const map = new Map<string, number>()
    filteredSlashCommands.forEach((cmd, i) => map.set(cmd.name, i))
    return map
  }, [filteredSlashCommands])

  // Typing narrows the list under the cursor; without this the highlight can sit
  // past the end and Enter sends a literal "/" instead of a command.
  useEffect(() => {
    setSlashMenuIndex(prev => (prev < filteredSlashCommands.length ? prev : 0))
  }, [filteredSlashCommands.length])

  // The list is no longer capped at ten rows, so the highlight can walk out of
  // the scroll viewport. Keep it visible.
  useEffect(() => {
    if (!showSlashMenu) return
    selectedSlashItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [showSlashMenu, slashMenuIndex])

  // Auto-resize textarea to fit content
  const autoResizeTextarea = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [])

  const handleInputChange = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const val = (e.target as HTMLTextAreaElement).value
    inputValueRef.current = val
    autoResizeTextarea()
    // Show slash command menu when typing / at the start
    if (val.startsWith('/') && !val.includes(' ')) {
      setShowSlashMenu(true)
      setSlashFilter(val.slice(1))
      setSlashMenuIndex(0)
    } else if (showSlashMenuRef.current) {
      setShowSlashMenu(false)
    }
  }, [])

  const handleSlashSelect = useCallback((cmd: SlashCommandInfo) => {
    setInputValue('/' + cmd.name)
    setShowSlashMenu(false)
    textareaRef.current?.focus()
  }, [setInputValue])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Slash command menu navigation
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashMenuIndex(prev => Math.min(prev + 1, filteredSlashCommands.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashMenuIndex(prev => Math.max(prev - 1, 0))
        return
      }
      const enterDuringIME =
        e.key === 'Enter' && (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229)
      if (!enterDuringIME && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
        e.preventDefault()
        handleSlashSelect(filteredSlashCommands[slashMenuIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowSlashMenu(false)
        return
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      handlePermissionModeCycle()
      return
    }
    // Tab with empty input + prompt suggestion → auto-fill suggestion
    if (e.key === 'Tab' && !e.shiftKey && promptSuggestion && !inputValueRef.current.trim()) {
      e.preventDefault()
      setInputValue(promptSuggestion)
      setPromptSuggestion(null)
      return
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.nativeEvent.isComposing) {
      const history = inputHistoryRef.current
      if (history.length === 0) return
      if (!shouldNavigateInputHistoryFromTextarea('previous', textareaRef.current, inputValueRef.current)) return
      e.preventDefault()
      if (inputHistoryIndexRef.current === -1) {
        inputDraftRef.current = inputValueRef.current
        inputHistoryIndexRef.current = history.length - 1
      } else if (inputHistoryIndexRef.current > 0) {
        inputHistoryIndexRef.current--
      }
      setInputValue(history[inputHistoryIndexRef.current])
      return
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (inputHistoryIndexRef.current === -1) return
      if (!shouldNavigateInputHistoryFromTextarea('next', textareaRef.current, inputValueRef.current)) return
      e.preventDefault()
      const history = inputHistoryRef.current
      if (inputHistoryIndexRef.current < history.length - 1) {
        inputHistoryIndexRef.current++
        setInputValue(history[inputHistoryIndexRef.current])
      } else {
        inputHistoryIndexRef.current = -1
        setInputValue(inputDraftRef.current)
      }
      return
    }
    // Cmd/Ctrl+PageUp: scroll messages up by 85% viewport height
    if ((e.metaKey || e.ctrlKey) && e.key === 'PageUp') {
      e.preventDefault()
      const container = messagesContainerRef.current
      if (container) container.scrollTop -= container.clientHeight * 0.85
      return
    }
    // Cmd/Ctrl+PageDown: scroll messages down by 85% viewport height
    if ((e.metaKey || e.ctrlKey) && e.key === 'PageDown') {
      e.preventDefault()
      const container = messagesContainerRef.current
      if (container) container.scrollTop += container.clientHeight * 0.85
      return
    }
    // Cmd/Ctrl+Home: scroll to top of messages
    if ((e.metaKey || e.ctrlKey) && e.key === 'Home') {
      e.preventDefault()
      const container = messagesContainerRef.current
      if (container) container.scrollTop = 0
      return
    }
    // Cmd/Ctrl+End: scroll to bottom of messages
    if ((e.metaKey || e.ctrlKey) && e.key === 'End') {
      e.preventDefault()
      const container = messagesContainerRef.current
      if (container) container.scrollTop = container.scrollHeight
      return
    }
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      !isComposingRef.current &&
      e.keyCode !== 229
    ) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend, handlePermissionModeCycle, setInputValue, showSlashMenu, filteredSlashCommands, slashMenuIndex, handleSlashSelect, promptSuggestion])

  const handleModelCycle = useCallback(async () => {
    if (availableModels.length === 0) return
    const idx = availableModels.findIndex(m => m.value === currentModel)
    const next = availableModels[(idx + 1) % availableModels.length]
    const selectedModel = normalizeClaudeModelSelection(next.value) || next.value
    setCurrentModel(selectedModel)
    await host.claude.setModel(sessionId, selectedModel, getAutoCompactWindowForModel(selectedModel, settingsStore.getSettings().autoCompactWindow) || undefined)
    workspaceStore.updateTerminalModel(sessionId, selectedModel)
  }, [sessionId, currentModel, availableModels])

  const handleEffortChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value
    setEffortLevel(next)
    workspaceStore.updateTerminalAgentParams(sessionId, { effort: next })
    await host.claude.setEffort(sessionId, next)
  }, [sessionId])

  const handleCodexSandboxModeChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as CodexSandboxMode
    setCodexSandboxMode(next)
    workspaceStore.updateTerminalAgentParams(sessionId, { sandboxMode: next })
    await host.claude.setCodexSandboxMode(sessionId, next)
  }, [sessionId])

  const handleCodexApprovalPolicyChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as CodexApprovalPolicy
    setCodexApprovalPolicy(next)
    workspaceStore.updateTerminalAgentParams(sessionId, { approvalPolicy: next })
    await host.claude.setCodexApprovalPolicy(sessionId, next)
  }, [sessionId])

  const showDontAskAgain = (pendingPermission?.suggestions?.length ?? 0) > 0
    || pendingPermission?.toolName === 'ExitPlanMode'

  const dontAskAgainLabel = useMemo(() => {
    if (!pendingPermission?.suggestions?.length) return t('claude.yesDontAskAgain')
    const suggestion = pendingPermission.suggestions[0] as { type?: string; rules?: { toolName?: string; ruleContent?: string }[] }
    if (suggestion.type === 'addRules' && suggestion.rules?.length) {
      const descriptions = suggestion.rules.map(r => {
        const cmd = r.ruleContent?.split(':')[0] ?? r.ruleContent
        return cmd
      })
      return t('claude.yesDontAskAgainForCommands', { commands: descriptions.join(' and ') })
    }
    return t('claude.yesDontAskAgain')
  }, [pendingPermission, t])

  const PERMISSION_OPTION_COUNT = showDontAskAgain ? 4 : 3

  const handlePermissionSelect = useCallback((index?: number) => {
    if (!pendingPermission) return
    const choice = index ?? permissionFocus
    // Map index to action based on whether "don't ask again" is shown
    // With don't-ask-again:    0=Yes, 1=Don't ask again, 2=No, 3=Custom
    // Without don't-ask-again: 0=Yes, 1=No, 2=Custom
    const action = showDontAskAgain
      ? (['yes', 'dontAskAgain', 'no', 'custom'] as const)[choice]
      : (['yes', 'no', 'custom'] as const)[choice]

    if (action === 'yes') {
      host.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'allow',
        updatedInput: pendingPermission.input,
      })
      setPendingPermission(null)
    } else if (action === 'dontAskAgain') {
      if (pendingPermission.toolName === 'ExitPlanMode') {
        host.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
          behavior: 'allow',
          updatedInput: pendingPermission.input,
          dontAskAgain: true,
        })
      } else {
        host.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
          behavior: 'allow',
          updatedInput: pendingPermission.input,
          updatedPermissions: pendingPermission.suggestions,
        })
      }
      setPendingPermission(null)
    } else if (action === 'no') {
      const toolId = pendingPermission.toolUseId
      setMessages(prev => prev.map(m => {
        if ('toolName' in m && m.id === toolId) {
          return { ...m, denied: true } as ClaudeToolCall
        }
        return m
      }))
      host.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'deny',
        message: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
      })
      setPendingPermission(null)
    } else if (action === 'custom') {
      const msg = permissionCustomText.trim()
      if (!msg) return // don't submit empty
      const toolId = pendingPermission.toolUseId
      setMessages(prev => prev.map(m => {
        if ('toolName' in m && m.id === toolId) {
          return { ...m, denyReason: msg, denied: true } as ClaudeToolCall
        }
        return m
      }))
      host.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'deny',
        message: msg,
      })
      setPendingPermission(null)
      setPermissionCustomText('')
    }
  }, [sessionId, pendingPermission, permissionFocus, permissionCustomText, showDontAskAgain])

  // Read plan file content when ExitPlanMode permission appears
  useEffect(() => {
    if (pendingPermission?.toolName === 'ExitPlanMode' && pendingPermission.input.planFilePath) {
      host.fs.readFile(String(pendingPermission.input.planFilePath)).then(r => {
        if (r.content) setPlanFileContent(r.content)
      }).catch(() => {})
    } else {
      setPlanFileContent(null)
    }
  }, [pendingPermission])

  // Auto-focus permission card when it appears or when panel becomes active again.
  const focusActivePermission = useCallback(() => {
    if (pendingPermission && permissionCardRef.current) {
      permissionCardRef.current.focus()
    }
  }, [pendingPermission])
  usePanelActiveEffect(activation, focusActivePermission)

  const permissionCustomRef = useRef<HTMLInputElement>(null)

  // Auto-focus custom text input when option 3 is selected
  useEffect(() => {
    if (permissionFocus === 3 && permissionCustomRef.current) {
      permissionCustomRef.current.focus()
    }
  }, [permissionFocus])

  // Global keyboard listener. Activation is handled by the lightweight
  // controller so workspace switches do not re-render the message history.
  const bindActiveKeyboard = useCallback(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Ctrl+P: open file picker
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault()
        setFilePickerMode('preview')
        setShowFilePicker(true)
        setFilePickerQuery('')
        setFilePickerResults([])
        setFilePickerIndex(0)
        setFilePickerLoading(false)
        setFilePickerError(null)
        setTimeout(() => filePickerInputRef.current?.focus(), 50)
        return
      }
      if (e.key === 'Escape') {
        if (filePickerPreview) {
          e.preventDefault()
          setFilePickerPreview(null)
          return
        }
        if (showFilePicker) {
          e.preventDefault()
          setShowFilePicker(false)
          return
        }
        if (showPromptHistory) {
          e.preventDefault()
          setShowPromptHistory(false)
          return
        }
        if (taskModal) {
          e.preventDefault()
          setTaskModal(null)
          return
        }
        if (contentModal) {
          e.preventDefault()
          setContentModal(null)
          return
        }
        if (showModelList) {
          e.preventDefault()
          setShowModelList(false)
          setTimeout(() => textareaRef.current?.focus(), 0)
          return
        }
        if (showResumeList) {
          e.preventDefault()
          setShowResumeList(false)
          setResumeSessions([])
          return
        }
        if (pendingPermission) {
          e.preventDefault()
          handlePermissionSelect(2) // Deny
          return
        }
        if (isStreaming || isInterrupted) {
          e.preventDefault()
          const now = Date.now()
          if (isInterrupted || now - lastEscRef.current < 500) {
            // Second Esc (or already interrupted) → full stop
            handleStop()
          } else {
            // First Esc → interrupt (pause), user can type to continue
            handleInterrupt()
          }
          lastEscRef.current = now
          return
        }
      }
      // Codex sessions keep the flat rows, which have no focus affordance —
      // driving them from modelRows would move an invisible cursor.
      if (showModelList && !isCodexSession && modelRows.length > 0) {
        const row = modelRows[Math.min(modelFocusRow, modelRows.length - 1)]
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const step = e.key === 'ArrowDown' ? 1 : -1
          modelFocusScrollRef.current = true
          setModelFocusRow(prev => Math.min(modelRows.length - 1, Math.max(0, prev + step)))
          return
        }
        if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && row.options.length > 0) {
          e.preventDefault()
          const step = e.key === 'ArrowRight' ? 1 : -1
          const current = pickClaudeModelOption(row, modelFocusWindow)
          const index = current ? row.options.indexOf(current) : 0
          const next = Math.min(row.options.length - 1, Math.max(0, index + step))
          setModelFocusWindow(row.options[next].window)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          void handleModelSelect(claudeModelValueForRow(row, modelFocusWindow))
          return
        }
      }
      if (pendingPermission) {
        // If typing in custom text input, only handle Enter/Escape/ArrowUp
        if (permissionFocus === 3) {
          if (e.key === 'Enter') {
            e.preventDefault()
            handlePermissionSelect(3)
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setPermissionFocus(2)
            return
          }
          return // let other keys go to the input
        }
        // Number key shortcuts
        if (e.key === '1') { e.preventDefault(); handlePermissionSelect(0); return }
        if (e.key === '2') { e.preventDefault(); handlePermissionSelect(1); return }
        if (e.key === '3') { e.preventDefault(); handlePermissionSelect(2); return }
        // Arrow up/down navigation
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setPermissionFocus(prev => Math.max(0, prev - 1))
          return
        }
        if (e.key === 'ArrowDown' || e.key === 'Tab') {
          e.preventDefault()
          setPermissionFocus(prev => Math.min(PERMISSION_OPTION_COUNT - 1, prev + 1))
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          handlePermissionSelect()
          return
        }
        // Legacy shortcuts
        if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); handlePermissionSelect(0); return }
        if (e.key === 'n' || e.key === 'N') { e.preventDefault(); handlePermissionSelect(2); return }
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [isStreaming, handleStop, pendingPermission, permissionFocus, handlePermissionSelect, showResumeList, showModelList, taskModal, contentModal, showFilePicker, filePickerPreview, modelRows, modelFocusRow, modelFocusWindow, handleModelSelect])
  usePanelActiveEffect(activation, bindActiveKeyboard)

  const handleAskUserSubmit = useCallback(() => {
    if (!pendingQuestion) return
    // The resolve protocol expects string values per question, so multi-select
    // arrays are joined into one comma-separated string.
    const finalAnswers: Record<string, string> = {}
    for (const [key, val] of Object.entries(askAnswers)) {
      if (Array.isArray(val)) {
        if (val.length) finalAnswers[key] = val.join(', ')
      } else if (val) {
        finalAnswers[key] = val
      }
    }
    // Merge "Other" text: append for multi-select (coexists with picks),
    // replace for single-select (where picking and typing are exclusive).
    for (const [key, text] of Object.entries(askOtherText)) {
      const trimmed = text.trim()
      if (!trimmed) continue
      finalAnswers[key] = finalAnswers[key] ? `${finalAnswers[key]}, ${trimmed}` : trimmed
    }
    host.claude.resolveAskUser(sessionId, pendingQuestion.toolUseId, finalAnswers)
    setPendingQuestion(null)
    setAskAnswers({})
    setAskOtherText({})
  }, [sessionId, pendingQuestion, askAnswers, askOtherText])

  const MAX_IMAGES = 5
  const MAX_FILES = 10

  const addImageByPath = useCallback(async (filePath: string) => {
    setAttachedImages(prev => {
      if (prev.length >= MAX_IMAGES) return prev
      if (prev.some(img => img.path === filePath)) return prev
      return prev // will be updated after async
    })
    // Check limit and dedup before reading
    const current = attachedImages
    if (current.length >= MAX_IMAGES || current.some(img => img.path === filePath)) return
    try {
      const dataUrl = await host.image.readAsDataUrl(filePath)
      const resized = await maybeResizeImageDataUrl(dataUrl)
      setAttachedImages(prev => {
        if (prev.length >= MAX_IMAGES) return prev
        if (prev.some(img => img.path === filePath)) return prev
        return [...prev, { path: filePath, dataUrl: resized }]
      })
    } catch (err) {
      console.error('Failed to read image:', err)
    }
  }, [attachedImages])

  const addImageDataUrl = useCallback((path: string, dataUrl: string) => {
    setAttachedImages(prev => {
      if (prev.length >= MAX_IMAGES) return prev
      if (prev.some(img => img.path === path)) return prev
      return [...prev, { path, dataUrl }]
    })
  }, [])

  const addFileByPath = useCallback((filePath: string) => {
    setAttachedFiles(prev => {
      if (prev.length >= MAX_FILES) return prev
      if (prev.some(f => f.path === filePath)) return prev
      const name = filePath.split('/').pop() || filePath
      return [...prev, { path: filePath, name }]
    })
  }, [])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const clipboard = e.clipboardData
    if (!clipboard) return
    const files = Array.from(clipboard.files || [])
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        e.preventDefault()
        const dataUrl = await readFileAsDataUrl(file)
        const resized = await maybeResizeImageDataUrl(dataUrl)
        addImageDataUrl(filenameForPastedImage(file), resized)
        return
      }
    }

    const items = Array.from(clipboard.items || [])
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          const dataUrl = await readFileAsDataUrl(file)
          const resized = await maybeResizeImageDataUrl(dataUrl)
          addImageDataUrl(filenameForPastedImage(file), resized)
          return
        }
        if (!isRemoteConnected) {
          const filePath = await host.clipboard.saveImage()
          if (filePath) {
            await addImageByPath(filePath)
          }
        } else {
          window.alert('Remote sessions can only attach pasted images when the clipboard exposes image data.')
        }
        return
      }
    }

    // Tauri/WebKit sometimes does not expose native clipboard images through
    // the DOM paste event. If there is no text to paste, ask the host clipboard
    // bridge to materialize the native image as a temp PNG and attach it.
    if (!isRemoteConnected && !clipboard.getData('text/plain')) {
      e.preventDefault()
      try {
        const filePath = await host.clipboard.saveImage()
        if (filePath) await addImageByPath(filePath)
      } catch (err) {
        void host.debug.log(
          '[clipboard] failed to attach native pasted image',
          err instanceof Error ? err.message : String(err),
        )
      }
    }
  }, [addImageByPath, addImageDataUrl, isRemoteConnected])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    // Under Tauri, OS file drops are already handled by the
    // listenTauriNativeDrop effect below (which has the absolute paths).
    // The DOM drop event also fires but File.path is undefined, so
    // getPathForFile would basename-match against an already-claimed
    // cache entry and surface a spurious "needs the host to expose
    // paths" alert. Skip OS-file drops here; the dataTransfer.files
    // branch only matters for browser-internal image drags (no 'Files').
    if (isTauri() && e.dataTransfer.types.includes('Files')) return
    for (const file of e.dataTransfer.files) {
      const filePath = isRemoteConnected ? null : host.shell.getPathForFile(file)
      if (!filePath) {
        if (file.type.startsWith('image/')) {
          const dataUrl = await readFileAsDataUrl(file)
          const resized = await maybeResizeImageDataUrl(dataUrl)
          addImageDataUrl(file.name || filenameForPastedImage(file), resized)
        } else if (isRemoteConnected) {
          window.alert('Remote sessions can only attach local dropped images. File paths must exist on the host.')
        } else {
          window.alert('Drag-drop of non-image files needs the host to expose paths; not yet wired in this build.')
        }
        continue
      }
      if (file.type.startsWith('image/')) {
        await addImageByPath(filePath)
      } else {
        addFileByPath(filePath)
      }
    }
  }, [addImageByPath, addImageDataUrl, addFileByPath, isRemoteConnected])

  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'])

  const attachByPath = useCallback(async (filePath: string) => {
    const extensionIndex = filePath.lastIndexOf('.')
    const ext = extensionIndex >= 0 ? filePath.slice(extensionIndex).toLowerCase() : ''
    if (IMAGE_EXTENSIONS.has(ext)) {
      await addImageByPath(filePath)
    } else {
      addFileByPath(filePath)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addImageByPath, addFileByPath])

  // Remote drop → upload to host tmp (confirm-gated), then attach the
  // HOST-side path so image preview / file refs resolve on the host.
  const remoteDropUpload = useRemoteDropUpload(attachByPath)

  const handleNativeDropPaths = useCallback(async (paths: string[]) => {
    if (isRemoteConnected) {
      remoteDropUpload.requestUpload(paths)
      return
    }
    for (const filePath of paths) {
      await attachByPath(filePath)
    }
  }, [attachByPath, isRemoteConnected, remoteDropUpload])

  useEffect(() => {
    return listenTauriNativeDrop((detail) => {
      if (!isTauriNativeDropInside(detail, panelRef.current)) {
        if (detail.type === 'drop' || detail.type === 'leave') setIsDragOver(false)
        return
      }
      if (detail.type === 'enter' || detail.type === 'over') {
        setIsDragOver(true)
        return
      }
      setIsDragOver(false)
      if (detail.type === 'drop') void handleNativeDropPaths(detail.paths)
    })
  }, [handleNativeDropPaths])

  const handleSelectAttachments = useCallback(() => {
    setFilePickerMode('attach')
    setShowFilePicker(true)
    setFilePickerQuery('')
    setFilePickerResults([])
    setFilePickerIndex(0)
    setFilePickerLoading(false)
    setFilePickerError(null)
    setTimeout(() => filePickerInputRef.current?.focus(), 50)
  }, [])

  const handleFilePickerSelect = useCallback(async (item: { path: string; isDirectory: boolean }) => {
    if (item.isDirectory) return
    setShowFilePicker(false)
    if (filePickerMode === 'attach') {
      const extensionIndex = item.path.lastIndexOf('.')
      const ext = extensionIndex >= 0 ? item.path.slice(extensionIndex).toLowerCase() : ''
      if (IMAGE_EXTENSIONS.has(ext)) {
        await addImageByPath(item.path)
      } else {
        addFileByPath(item.path)
      }
      return
    }
    setFilePickerPreview(item.path)
  }, [filePickerMode, addImageByPath, addFileByPath])

  const removeImage = useCallback((filePath: string) => {
    setAttachedImages(prev => prev.filter(img => img.path !== filePath))
  }, [])

  const removeFile = useCallback((filePath: string) => {
    setAttachedFiles(prev => prev.filter(f => f.path !== filePath))
  }, [])

  const toggleTool = useCallback((id: string, isThinking?: boolean) => {
    setExpandedTools(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        // Once the user expands any thinking block, auto-expand all future ones
        if (isThinking) setAutoExpandThinking(true)
      }
      return next
    })
  }, [])

  const toolInputSummary = (_toolName: string, input: Record<string, unknown>): string => {
    // Show a compact one-line summary of tool input
    const askUserSummary = summarizeAskUserInput(input)
    if (askUserSummary) return askUserSummary
    if (input.command) return summarizeToolCommandInput(String(input.command))
    if (input.file_path) return String(input.file_path)
    if (input.pattern) return String(input.pattern)
    if (input.query) return String(input.query).slice(0, 80)
    if (input.url) return String(input.url).slice(0, 80)
    if (input.prompt) return String(input.prompt).slice(0, 80)
    const keys = Object.keys(input)
    if (keys.length === 0) return ''
    return keys.slice(0, 2).map(k => `${k}: ${String(input[k]).slice(0, 40)}`).join(', ')
  }

  // Extract main content string for the IN block display
  const toolInputContent = (input: Record<string, unknown>): string => {
    if (input.command) return String(input.command)
    if (input.file_path) return String(input.file_path)
    if (input.pattern) return String(input.pattern)
    if (input.query) return String(input.query)
    if (input.url) return String(input.url)
    if (input.prompt) return String(input.prompt)
    return JSON.stringify(input, null, 2)
  }

  const toolDescription = (input: Record<string, unknown>): string | null => {
    if (input.description) return String(input.description)
    return null
  }

  const [copiedId, setCopiedId] = useState<string | null>(null)
  const handleCopyBlock = useCallback((text: string, blockId: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(blockId)
      setTimeout(() => setCopiedId(null), 1500)
    })
  }, [])

  // Extract <system-reminder> and <tool_use_error> blocks from text
  const splitSystemReminders = (text: string): { content: string; reminders: string[]; errors: string[] } => {
    const reminders: string[] = []
    const errors: string[] = []
    let content = text.replace(/<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>/g, (_match, inner) => {
      reminders.push(inner.trim())
      return ''
    })
    content = content.replace(/<tool_use_error>\s*([\s\S]*?)\s*<\/tool_use_error>/g, (_match, inner) => {
      errors.push(inner.trim())
      return ''
    }).trim()
    return { content, reminders, errors }
  }

  const parseContentBlocks = (text: string): string => {
    const trimmed = text.trim()
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return text
    try {
      const parsed = JSON.parse(trimmed)
      const extractTextBlocks = (value: unknown): string | null => {
        if (Array.isArray(value)) {
          const texts = value
            .filter((b: { type?: string; text?: string }) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b: { text: string }) => b.text)
          return texts.length > 0 ? texts.join('\n\n') : null
        }
        if (value && typeof value === 'object') {
          const record = value as Record<string, unknown>
          if (record.result !== undefined) return extractTextBlocks(record.result)
          if (record.content !== undefined) return extractTextBlocks(record.content)
          if (typeof record.text === 'string') return record.text
          if (typeof record.output === 'string') return record.output
          if (typeof record.stdout === 'string') return record.stdout
        }
        if (typeof value === 'string') return value
        return null
      }
      const extracted = extractTextBlocks(parsed)
      if (!extracted) return text
      return extracted.trim().startsWith('{') || extracted.trim().startsWith('[')
        ? parseContentBlocks(extracted)
        : extracted
    } catch {
      return text
    }
  }

  const renderTodoChecklist = (input: Record<string, unknown>) => {
    const todos = input.todos as Array<{ content: string; status: string; activeForm?: string }> | undefined
    if (!todos || !Array.isArray(todos)) return null
    return (
      <div className="claude-todo-checklist">
        {todos.map((todo, i) => (
          <div key={i} className={`claude-todo-item claude-todo-${todo.status}`}>
            <span className="claude-todo-check">
              {todo.status === 'completed' ? '\u2611' : todo.status === 'in_progress' ? '\u25B6' : '\u2610'}
            </span>
            <span className="claude-todo-text">{todo.content}</span>
          </div>
        ))}
      </div>
    )
  }

  const formatTimestamp = (ts: number): string => {
    const d = new Date(ts)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (isToday) return time
    // Not today — show full date + time
    return d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  const formatFullTimestamp = (ts: number): string => {
    return new Date(ts).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const formatElapsed = (ts: number): string => {
    const secs = Math.floor((Date.now() - ts) / 1000)
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  const shouldShowTimeDivider = (current: MessageItem, prevItem: MessageItem | undefined): boolean => {
    if (!prevItem) return false
    const curTs = current.timestamp || 0
    const prevTs = prevItem.timestamp || 0
    if (!curTs || !prevTs) return false
    // Show divider if gap > 30 minutes
    return (curTs - prevTs) > 30 * 60 * 1000
  }

  const renderMessage = (item: MessageItem, index: number) => {
    if (isToolCall(item) && !showToolMsg) return null
    if (!isToolCall(item)) {
      const msg = item as ClaudeMessage
      if (msg.role === 'user' && !showUserMsg) return null
      if (msg.role === 'assistant' && !showAssistantMsg) return null
    }
    if (isToolCall(item)) {
      // TodoWrite: render as a visual checklist
      if (item.toolName === 'TodoWrite') {
        return (
          <div key={item.id || index} className="tl-item">
            <div className={`tl-dot ${item.status === 'running' ? 'dot-running' : 'dot-success'}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">{t('claude.checklist')}</span>
              </div>
              {renderTodoChecklist(item.input)}
            </div>
          </div>
        )
      }

      const dotClass = item.denied ? 'dot-denied' : item.isDeferred ? 'dot-deferred' : item.status === 'running' ? 'dot-running' : item.status === 'completed' ? 'dot-success' : 'dot-error'
      const desc = toolDescription(item.input)

      // AskUserQuestion: render the exchange as Q&A. What the user picked is
      // part of the conversation, not tool plumbing, so it should not have to be
      // reconstructed from a JSON input next to the SDK's acknowledgement.
      if (item.toolName === 'AskUserQuestion') {
        const resultRaw = item.result ? stringifyToolResult(item.result) : ''
        const { content: resultText, errors: resultErrors } = splitSystemReminders(parseContentBlocks(resultRaw))
        const qna = buildAskUserQnA(item.input, resultText)
        const rowExpanded = expandedTools.has(item.id)
        // A payload we cannot read falls through to the generic row, which at
        // least still shows the raw input and output.
        if (qna.length > 0) {
          return (
            <div key={item.id || index} className="tl-item" data-tool-id={item.id}>
              <div className={`tl-dot ${dotClass}`} />
              <div className="tl-content">
                <AgentToolRow
                  toolName={item.toolName}
                  isDeferred={item.isDeferred}
                  desc={desc}
                  summary={toolInputSummary(item.toolName, item.input)}
                  timestamp={item.timestamp}
                  expanded={rowExpanded}
                  onToggle={() => toggleTool(item.id)}
                />
                <AgentAskUserQnA
                  entries={qna}
                  expanded={rowExpanded}
                  onCopy={handleCopyBlock}
                  copiedId={copiedId}
                  idPrefix={`qna-${item.id}`}
                />
                {resultErrors.length > 0 && (
                  <div className="claude-tool-blocks">
                    {resultErrors.map((err, i) => (
                      <div key={`err${i}`} className="claude-tool-row claude-tool-error-row">
                        <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                        <span className="claude-tool-row-content">{err}</span>
                      </div>
                    ))}
                  </div>
                )}
                {item.denied && (
                  <div className="claude-tool-interrupted">{t('claude.toolInterrupted')}</div>
                )}
              </div>
            </div>
          )
        }
      }

      // ExitPlanMode / EnterPlanMode: show plan content in readable view
      if (item.toolName === 'ExitPlanMode' || item.toolName === 'EnterPlanMode') {
        const resultRaw = item.result ? (stringifyToolResult(item.result)) : ''
        const { content: resultText, errors: resultErrors } = splitSystemReminders(resultRaw)
        const planPath = item.input.planFilePath ? String(item.input.planFilePath) : ''
        return (
          <div key={item.id || index} className="tl-item">
            <div className={`tl-dot ${dotClass}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">{item.toolName === 'ExitPlanMode' ? 'Exit Plan' : 'Enter Plan'}</span>
                {item.timestamp > 0 && <span className="claude-tool-time" title={formatFullTimestamp(item.timestamp)}>{formatTimestamp(item.timestamp)}</span>}
              </div>
              {planPath && (
                <div className="claude-plan-block">
                  <div className="claude-plan-open-btn" onClick={() => {
                    host.fs.readFile(planPath).then(r => {
                      if (r.content) setContentModal({ title: 'Plan', content: r.content, markdown: true })
                    }).catch(() => {})
                  }}>
                    View plan
                  </div>
                </div>
              )}
              {resultErrors.length > 0 && resultErrors.map((err, i) => (
                <div key={`err${i}`} className="claude-tool-blocks"><div className="claude-tool-row claude-tool-error-row">
                  <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-tool-blocks">
                  <div className="claude-tool-row">
                    <span className="claude-tool-row-label">{t('claude.out')}</span>
                    <span className="claude-tool-row-content"><LinkedText text={resultText} /></span>
                  </div>
                </div>
              )}
              {expandedTools.has(item.id) && (
                <div className="claude-tool-body">
                  <div className="claude-tool-input">
                    <div className="claude-tool-label">{t('claude.fullInput')}</div>
                    <pre>{JSON.stringify(item.input, null, 2)}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      }

      // Task / Agent tool: custom structured renderer
      if (item.toolName === 'Task' || item.toolName === 'Agent') {
        const prompt = String(item.input.prompt || '')
        const isPromptExpanded = expandedTools.has(`task-prompt-${item.id}`)
        const isResultExpanded = expandedTools.has(`task-result-${item.id}`)
        const promptLines = prompt.split('\n')
        const isLongPrompt = promptLines.length > 3 || prompt.length > 200
        const truncatedPrompt = isLongPrompt
          ? promptLines.slice(0, 3).join('\n').slice(0, 200) + '...'
          : prompt
        const model = item.input.model ? String(item.input.model) : null
        const maxTurns = item.input.max_turns ? String(item.input.max_turns) : null
        const runBg = item.input.run_in_background ? true : false
        const resultRaw = item.result ? (stringifyToolResult(item.result)) : ''
        const { content: resultTextRaw, reminders: resultReminders, errors: resultErrors } = splitSystemReminders(resultRaw)
        const resultText = parseContentBlocks(resultTextRaw)
        const resultLines = resultText.split('\n')
        const isLongResult = resultLines.length > 6 || resultText.length > 400
        const progressDesc = item.description || ''
        const isStalled = progressDesc.startsWith('[stalled]')
        const isStopped = progressDesc.startsWith('[stopped')
        const progressLabel = isStalled ? progressDesc.slice(10) : isStopped ? progressDesc : progressDesc.startsWith('[completed]') || progressDesc.startsWith('[failed]') ? progressDesc : progressDesc
        return (
          <div key={item.id || index} className="tl-item" data-tool-id={item.id}>
            <div className={`tl-dot ${dotClass}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">{item.toolName === 'Agent' ? 'Agent' : 'Task'}</span>
                {Boolean(item.input.subagent_type) && <span className="claude-tool-badge">{String(item.input.subagent_type)}</span>}
                {desc && <span className="claude-tool-desc">{desc}</span>}
                {item.status === 'running' && item.timestamp > 0 && (
                  <span className="claude-task-tag claude-task-elapsed">{formatElapsed(item.timestamp)}</span>
                )}
                <button className="claude-subagent-log-btn" onClick={(e) => {
                  e.stopPropagation()
                  const taskLabel = item.input.description
                    ? String(item.input.description).slice(0, 60)
                    : item.input.subagent_type ? String(item.input.subagent_type) : 'Task'
                  setTaskModal({ taskId: item.id, label: taskLabel, subagentType: item.input.subagent_type ? String(item.input.subagent_type) : undefined })
                }}>{t('claude.log')}</button>
                {item.timestamp > 0 && <span className="claude-tool-time" title={formatFullTimestamp(item.timestamp)}>{formatTimestamp(item.timestamp)}</span>}
              </div>
              {item.status === 'running' && progressDesc && (
                <div className={`claude-task-progress ${isStalled ? 'stalled' : ''}`}>
                  <span className="claude-task-progress-text">{progressLabel}</span>
                  {isStalled && <span className="claude-task-stall-warn">{t('claude.agentMayBeStalled')}</span>}
                </div>
              )}
              {item.status === 'running' && (
                <div className="claude-task-actions">
                  <button className="claude-task-stop-btn" onClick={(e) => {
                    e.stopPropagation()
                    void stopAgentTask(item.id)
                  }}>{t('claude.stop')}</button>
                </div>
              )}
              {(model || maxTurns || runBg) && (
                <div className="claude-task-meta">
                  {model && <span className="claude-task-tag">model: {model}</span>}
                  {maxTurns && <span className="claude-task-tag">max_turns: {maxTurns}</span>}
                  {runBg && <span className="claude-task-tag">{t('claude.background')}</span>}
                </div>
              )}
              <div className="claude-task-prompt">
                <div className="claude-task-section-header" onClick={() => toggleTool(`task-prompt-${item.id}`)}>
                  <span className="claude-task-section-label">{t('claude.prompt')}</span>
                  <span className={`claude-tool-chevron ${isPromptExpanded ? 'expanded' : ''}`}>&#9654;</span>
                </div>
                <pre className="claude-task-prompt-text">{isPromptExpanded || !isLongPrompt ? prompt : truncatedPrompt}</pre>
                {isLongPrompt && !isPromptExpanded && (
                  <div className="claude-plan-open-btn" onClick={() => setContentModal({ title: 'Task Prompt', content: prompt })}>
                    View prompt ({promptLines.length} lines)
                  </div>
                )}
              </div>
              {resultErrors.length > 0 && resultErrors.map((err, i) => (
                <div key={`err${i}`} className="claude-tool-blocks"><div className="claude-tool-row claude-tool-error-row">
                  <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-task-result">
                  <div className="claude-task-section-header" onClick={() => toggleTool(`task-result-${item.id}`)}>
                    <span className="claude-task-section-label">{t('claude.result')}</span>
                    <span className={`claude-tool-chevron ${isResultExpanded ? 'expanded' : ''}`}>&#9654;</span>
                  </div>
                  {isResultExpanded && (
                    <div className="claude-task-result-text"><LinkedText text={resultText} /></div>
                  )}
                  {!isResultExpanded && isLongResult && (
                    <div className="claude-plan-open-btn" onClick={() => setContentModal({ title: 'Task Result', content: resultText, markdown: true })}>
                      View result ({resultLines.length} lines)
                    </div>
                  )}
                </div>
              )}
              {resultReminders.length > 0 && (
                <div className="claude-task-result">
                  <div className="claude-task-section-header claude-system-reminder-row" onClick={() => toggleTool(`reminder-${item.id}`)}>
                    <span className="claude-task-section-label claude-reminder-label">{t('claude.sys')}</span>
                    <span className={`claude-tool-chevron ${expandedTools.has(`reminder-${item.id}`) ? 'expanded' : ''}`}>&#9654;</span>
                  </div>
                  {expandedTools.has(`reminder-${item.id}`) && (
                    <div className="claude-task-result-text" style={{ opacity: 0.6 }}>{resultReminders.join('\n\n')}</div>
                  )}
                </div>
              )}
              {expandedTools.has(item.id) && (
                <div className="claude-tool-body">
                  <div className="claude-tool-input">
                    <div className="claude-tool-label">{t('claude.fullInput')}</div>
                    <pre>{JSON.stringify(item.input, null, 2)}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      }

      // Edit tool: show diff view
      if (item.toolName === 'Edit' && item.input.old_string !== undefined) {
        const filePath = String(item.input.file_path || '')
        const oldStr = String(item.input.old_string || '')
        const newStr = String(item.input.new_string || '')
        const isDiffExpanded = expandedTools.has(`diff-${item.id}`)
        const oldLines = oldStr.split('\n')
        const newLines = newStr.split('\n')
        const totalLines = oldLines.length + newLines.length
        const isLongDiff = totalLines > 12
        const resultRaw = item.result ? (stringifyToolResult(item.result)) : ''
        const { content: resultText, errors: resultErrors } = splitSystemReminders(resultRaw)
        return (
          <div key={item.id || index} className="tl-item">
            <div className={`tl-dot ${dotClass}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">Edit</span>
                <span className="claude-tool-desc"><LinkedText text={filePath} /></span>
                {item.timestamp > 0 && <span className="claude-tool-time" title={formatFullTimestamp(item.timestamp)}>{formatTimestamp(item.timestamp)}</span>}
              </div>
              <div className="claude-diff-block">
                {(isDiffExpanded || !isLongDiff ? oldLines : oldLines.slice(0, 3)).map((line, i) => (
                  <div key={`o${i}`} className="claude-diff-line claude-diff-del">
                    <span className="claude-diff-sign">-</span>
                    <span className="claude-diff-text">{line}</span>
                  </div>
                ))}
                {(isDiffExpanded || !isLongDiff ? newLines : newLines.slice(0, 3)).map((line, i) => (
                  <div key={`n${i}`} className="claude-diff-line claude-diff-add">
                    <span className="claude-diff-sign">+</span>
                    <span className="claude-diff-text">{line}</span>
                  </div>
                ))}
                {isLongDiff && (
                  <div className="claude-diff-toggle" onClick={() => toggleTool(`diff-${item.id}`)}>
                    {isDiffExpanded ? 'Collapse' : `Show all ${totalLines} lines...`}
                  </div>
                )}
              </div>
              {resultErrors.length > 0 && resultErrors.map((err, i) => (
                <div key={`err${i}`} className="claude-tool-blocks"><div className="claude-tool-row claude-tool-error-row">
                  <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-tool-blocks">
                  <div className="claude-tool-row">
                    <span className="claude-tool-row-label">{t('claude.out')}</span>
                    <span className="claude-tool-row-content"><LinkedText text={resultText} /></span>
                  </div>
                </div>
              )}
              {expandedTools.has(item.id) && (
                <div className="claude-tool-body">
                  <div className="claude-tool-input">
                    <div className="claude-tool-label">{t('claude.fullInput')}</div>
                    <pre>{JSON.stringify(item.input, null, 2)}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      }

      // Write tool: show content preview
      if (item.toolName === 'Write' && item.input.content !== undefined) {
        const filePath = String(item.input.file_path || '')
        const content = String(item.input.content || '')
        const isContentExpanded = expandedTools.has(`write-${item.id}`)
        const contentLines = content.split('\n')
        const isLong = contentLines.length > 8
        const resultRaw = item.result ? (stringifyToolResult(item.result)) : ''
        const { content: resultText, errors: resultErrors } = splitSystemReminders(resultRaw)
        return (
          <div key={item.id || index} className="tl-item">
            <div className={`tl-dot ${dotClass}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">Write</span>
                <span className="claude-tool-desc"><LinkedText text={filePath} /></span>
                {item.timestamp > 0 && <span className="claude-tool-time" title={formatFullTimestamp(item.timestamp)}>{formatTimestamp(item.timestamp)}</span>}
              </div>
              <div className="claude-diff-block">
                {(isContentExpanded || !isLong ? contentLines : contentLines.slice(0, 8)).map((line, i) => (
                  <div key={i} className="claude-diff-line claude-diff-add">
                    <span className="claude-diff-sign">+</span>
                    <span className="claude-diff-text">{line}</span>
                  </div>
                ))}
                {isLong && (
                  <div className="claude-diff-toggle" onClick={() => toggleTool(`write-${item.id}`)}>
                    {isContentExpanded ? 'Collapse' : `Show all ${contentLines.length} lines...`}
                  </div>
                )}
              </div>
              {resultErrors.length > 0 && resultErrors.map((err, i) => (
                <div key={`err${i}`} className="claude-tool-blocks"><div className="claude-tool-row claude-tool-error-row">
                  <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-tool-blocks">
                  <div className="claude-tool-row">
                    <span className="claude-tool-row-label">{t('claude.out')}</span>
                    <span className="claude-tool-row-content"><LinkedText text={resultText} /></span>
                  </div>
                </div>
              )}
              {expandedTools.has(item.id) && (
                <div className="claude-tool-body">
                  <div className="claude-tool-input">
                    <div className="claude-tool-label">{t('claude.fullInput')}</div>
                    <pre>{JSON.stringify(item.input, null, 2)}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      }

      // TaskOutput: link back to parent Task
      if (item.toolName === 'TaskOutput') {
        const taskId = item.input.task_id ? String(item.input.task_id) : null
        const parentTask = taskId
          ? allMessages.find(m => isToolCall(m) && m.toolName === 'Task' && m.id === taskId) as ClaudeToolCall | undefined
          : null
        const resultRaw = item.result ? (stringifyToolResult(item.result)) : ''
        const { content: resultTextRaw, errors: resultErrors } = splitSystemReminders(resultRaw)
        const resultText = parseContentBlocks(resultTextRaw)
        const resultLines = resultText.split('\n')
        const isLongResult = resultLines.length > 6 || resultText.length > 400
        const isResultExpanded = expandedTools.has(`taskout-result-${item.id}`)
        return (
          <div key={item.id || index} className="tl-item" data-tool-id={item.id}>
            <div className={`tl-dot ${dotClass}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">TaskOutput</span>
                {Boolean(parentTask?.input.subagent_type) && (
                  <span className="claude-tool-badge">{String(parentTask?.input.subagent_type)}</span>
                )}
                {parentTask && (
                  <span
                    className="claude-taskout-link"
                    onClick={(e) => {
                      e.stopPropagation()
                      const el = document.querySelector(`[data-tool-id="${parentTask.id}"]`)
                      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }}
                  >
                    from Task
                  </span>
                )}
                {item.timestamp > 0 && <span className="claude-tool-time" title={formatFullTimestamp(item.timestamp)}>{formatTimestamp(item.timestamp)}</span>}
              </div>
              {resultErrors.length > 0 && resultErrors.map((err, i) => (
                <div key={`err${i}`} className="claude-tool-blocks"><div className="claude-tool-row claude-tool-error-row">
                  <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-task-result">
                  <div className="claude-task-section-header" onClick={() => toggleTool(`taskout-result-${item.id}`)}>
                    <span className="claude-task-section-label">{t('claude.result')}</span>
                    <span className={`claude-tool-chevron ${isResultExpanded ? 'expanded' : ''}`}>&#9654;</span>
                  </div>
                  {(isResultExpanded || !isLongResult) && (
                    <div className="claude-task-result-text"><LinkedText text={resultText} /></div>
                  )}
                  {!isResultExpanded && isLongResult && (
                    <div className="claude-plan-open-btn" onClick={() => setContentModal({ title: 'TaskOutput Result', content: resultText, markdown: true })}>
                      View result ({resultLines.length} lines)
                    </div>
                  )}
                </div>
              )}
              {expandedTools.has(item.id) && (
                <div className="claude-tool-body">
                  <div className="claude-tool-input">
                    <div className="claude-tool-label">{t('claude.fullInput')}</div>
                    <pre>{JSON.stringify(item.input, null, 2)}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      }

      const inContent = toolInputContent(item.input)
      const shellInvocation = item.toolName === 'Bash' && item.input.command
        ? parseShellInvocation(String(item.input.command))
        : null
      const inBlockId = `in-${item.id}`
      const outBlockId = `out-${item.id}`
      const inLines = inContent.split('\n')
      const isInLong = inLines.length > 3
      const isInExpanded = expandedTools.has(`in-expand-${item.id}`)
      // The header already prints the summary, and for single-field inputs
      // (file_path / pattern / url / short commands) toolInputContent returns
      // that exact same string — an IN row there costs a line and says nothing.
      // The full input stays one click away via the header's expand toggle.
      const headerSummary = desc ? '' : toolInputSummary(item.toolName, item.input)
      const hasInContent = !!inContent.trim() && inContent !== headerSummary
      const rowExpanded = expandedTools.has(item.id)
      // Computed before the header so the row can print the output magnitude on
      // its one line. The cache is keyed by (id, result), so the blocks below
      // reuse this exact object rather than recomputing.
      const toolRender = item.result
        ? getOrComputeToolRender(
            toolRenderCacheRef.current,
            item.id,
            item.result,
            () => {
              const raw = stringifyToolResult(item.result)
              const normalizedRaw = parseContentBlocks(raw)
              const split = splitSystemReminders(normalizedRaw)
              return {
                outText: split.content,
                isLongOutput: split.content.split(/\r?\n/).length > 8 || split.content.length > 900,
                outPreviewLines: buildCollapsedOutputPreview(split.content),
                reminders: split.reminders,
                errors: split.errors,
              }
            },
          )
        : null
      const toolSearchSummary = item.toolName === 'ToolSearch' && toolRender
        ? summarizeToolSearchResult(toolRender.outText, t)
        : null
      const displayOutText = toolSearchSummary ?? toolRender?.outText ?? ''
      const layout = toolRowLayout({
        expanded: rowExpanded,
        hasInContent,
        outText: displayOutText,
        errorCount: toolRender?.errors.length ?? 0,
      })
      const reminders = toolRender?.reminders ?? []
      return (
        <div key={item.id || index} className="tl-item" data-tool-id={item.id}>
          <div className={`tl-dot ${dotClass}`} />
          <div className="tl-content">
            <AgentToolRow
              toolName={item.toolName}
              shell={shellInvocation?.shell}
              isDeferred={item.isDeferred}
              desc={desc}
              summary={headerSummary}
              timestamp={item.timestamp}
              outSize={layout.outSize}
              outSizeTitle={displayOutText ? formatContentSize(displayOutText) : null}
              expanded={rowExpanded}
              onToggle={() => toggleTool(item.id)}
            />
            {item.denyReason && (
              <div className="claude-tool-reason">Reason: {item.denyReason}</div>
            )}
            {(layout.showInRow || layout.showOutRow || layout.showErrorRows) && (
            <div className="claude-tool-blocks">
              {layout.showInRow && (
              <div
                className="claude-tool-row"
                onClick={() => handleCopyBlock(inContent, inBlockId)}
                title={t('claude.clickToCopy')}
              >
                <span className="claude-tool-row-label">{t('claude.in')}</span>
                <span className="claude-tool-row-content">
                  <LinkedText text={isInLong && !isInExpanded ? inLines.slice(0, 3).join('\n') : inContent} />
                  {isInLong && (
                    <span
                      className="claude-in-toggle"
                      onClick={(e) => { e.stopPropagation(); toggleTool(`in-expand-${item.id}`) }}
                    >
                      {isInExpanded ? ' [collapse]' : ` ... [+${inLines.length - 3} lines]`}
                    </span>
                  )}
                </span>
                <span className={`claude-tool-row-copy ${copiedId === inBlockId ? 'copied' : ''}`}>
                  {copiedId === inBlockId ? '✓' : '⧉'}
                </span>
              </div>
              )}
              {toolRender && (() => {
                const { outText, isLongOutput, outPreviewLines, errors } = toolRender
                // The timeline is tidy by construction now — a collapsed tool is
                // one line — so inside an expanded row only length still argues
                // for hiding the body. The old read-only/MCP/setting checks existed
                // to keep the *timeline* short and are redundant here.
                const shouldCollapse = !toolSearchSummary && isLongOutput
                const isOutExpanded = expandedTools.has(outBlockId)
                return (
                  <>
                    {layout.showErrorRows && errors.map((err, i) => (
                      <div key={`err${i}`} className="claude-tool-row claude-tool-error-row">
                        <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                        <span className="claude-tool-row-content">{err}</span>
                      </div>
                    ))}
                    {layout.showOutRow && outText && shouldCollapse && (
                      <div
                        className="claude-tool-row"
                        onClick={() => toggleTool(outBlockId)}
                      >
                        <span className="claude-tool-row-label">{t('claude.out')}</span>
                        <span className="claude-tool-row-content">
                          {isOutExpanded
                            ? <LinkedText text={outText} />
                            : (
                              <span className="claude-tool-collapsed-hint">
                                <span className="claude-tool-collapsed-meta">{formatContentSize(outText)}</span>
                                {outPreviewLines.length > 0 && (
                                  <span className="claude-tool-collapsed-preview-lines">
                                    {outPreviewLines.map((line, i) => (
                                      <span key={i} className="claude-tool-collapsed-preview">
                                        <LinkedText text={line} />
                                      </span>
                                    ))}
                                  </span>
                                )}
                                <button
                                  className="claude-tool-mini-action"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setContentModal({ title: `${item.toolName} output`, content: outText })
                                  }}
                                >
                                  open
                                </button>
                              </span>
                            )
                          }
                        </span>
                        <span className={`claude-tool-chevron ${isOutExpanded ? 'expanded' : ''}`}>&#9654;</span>
                      </div>
                    )}
                    {layout.showOutRow && displayOutText && !shouldCollapse && (
                      <div
                        className="claude-tool-row"
                        onClick={() => handleCopyBlock(displayOutText, outBlockId)}
                        title={t('claude.clickToCopy')}
                      >
                        <span className="claude-tool-row-label">{t('claude.out')}</span>
                        <span className="claude-tool-row-content"><LinkedText text={displayOutText} /></span>
                        <span className={`claude-tool-row-copy ${copiedId === outBlockId ? 'copied' : ''}`}>
                          {copiedId === outBlockId ? '✓' : '⧉'}
                        </span>
                      </div>
                    )}
                    {layout.showOutRow && reminders.length > 0 && (
                      <div
                        className="claude-tool-row claude-system-reminder-row"
                        onClick={() => toggleTool(`reminder-${item.id}`)}
                      >
                        <span className="claude-tool-row-label claude-reminder-label">{t('claude.sys')}</span>
                        <span className="claude-tool-row-content">
                          {expandedTools.has(`reminder-${item.id}`)
                            ? reminders.join('\n\n')
                            : `system-reminder (${reminders.length})`
                          }
                        </span>
                        <span className={`claude-tool-chevron ${expandedTools.has(`reminder-${item.id}`) ? 'expanded' : ''}`}>&#9654;</span>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
            )}
            {item.denied && (
              <div className="claude-tool-interrupted">{t('claude.toolInterrupted')}</div>
            )}
            {expandedTools.has(item.id) && (
              <div className="claude-tool-body">
                <div className="claude-tool-input">
                  <div className="claude-tool-label">Full Input</div>
                  <pre>{JSON.stringify(item.input, null, 2)}</pre>
                </div>
              </div>
            )}
          </div>
        </div>
      )
    }

    const msg = item as ClaudeMessage
    if (msg.role === 'system') {
      if (msg.kind === 'stale-turn-warning') {
        return (
          <div key={msg.id || index} className="tl-item tl-item-system tl-item-warning">
            <div className="tl-dot dot-warning" />
            <div className="tl-content claude-message-system claude-message-warning">
              {t('claude.runtimeStatus.staleTurnWarning')}
              {msg.timestamp > 0 && (
                <span className="claude-msg-time" title={formatFullTimestamp(msg.timestamp)}>{formatTimestamp(msg.timestamp)}</span>
              )}
            </div>
          </div>
        )
      }
      if (msg.kind === 'auto-continue') {
        const auto = msg.autoContinue
        const prompt = auto?.prompt ?? msg.content
        return (
          <div key={msg.id || index} className="tl-item tl-item-system tl-item-auto-continue">
            <div className="tl-dot dot-auto-continue" />
            <div className="tl-content claude-message-auto-continue">
              <span className="claude-auto-continue-label">
                Auto-continue{auto ? ` ${auto.used}/${auto.max}` : ''}
              </span>
              <span className="claude-auto-continue-prompt" title={prompt}>{prompt}</span>
              {msg.timestamp > 0 && (
                <span className="claude-msg-time" title={formatFullTimestamp(msg.timestamp)}>{formatTimestamp(msg.timestamp)}</span>
              )}
            </div>
          </div>
        )
      }
      return (
        <div key={msg.id || index} className="tl-item tl-item-system">
          <div className="tl-dot dot-system" />
          <div className="tl-content claude-message-system">
            {msg.content}
            {msg.timestamp > 0 && (
              <span className="claude-msg-time" title={formatFullTimestamp(msg.timestamp)}>{formatTimestamp(msg.timestamp)}</span>
            )}
          </div>
        </div>
      )
    }
    // Auto-compaction replays a summary of the whole conversation as a user
    // turn. Folded shut by default: it belongs in the timeline (the model was
    // prompted with it) but shown raw it buries the session under itself.
    if (msg.role === 'user' && msg.isCompactSummary) {
      return (
        <div
          key={msg.id || index}
          className="tl-item tl-item-user"
          data-user-msg-id={msg.id}
          ref={(el) => setUserMsgRef(msg.id, el)}
        >
          <div className="tl-dot dot-user" />
          <div className="tl-content">
            <details className="claude-compact-summary">
              <summary>Context summary (auto-compacted)</summary>
              <div className="claude-compact-summary-body">{msg.content}</div>
            </details>
          </div>
        </div>
      )
    }
    if (msg.role === 'user') {
      return (
        <div
          key={msg.id || index}
          className={`tl-item tl-item-user${msg.status === 'sending' ? ' msg-sending' : ''}${msg.status === 'failed' ? ' msg-failed' : ''}`}
          data-user-msg-id={msg.id}
          ref={(el) => setUserMsgRef(msg.id, el)}
        >
          <div className="tl-dot dot-user" />
          <div className="tl-content claude-message-user">
            {msg.content}
            {msg.timestamp > 0 && (
              <span className="claude-msg-time" title={formatFullTimestamp(msg.timestamp)}>{formatTimestamp(msg.timestamp)}</span>
            )}
          </div>
        </div>
      )
    }
    // assistant — if only thinking and thinking is hidden, skip entirely
    if (!showThinkingMsg && !msg.content) return null
    return (
      <div key={msg.id || index} className="tl-item">
        <div className="tl-dot dot-assistant" />
        <div className="tl-content claude-message-assistant">
          {msg.thinking && showThinkingMsg && (() => {
            const collapsedId = `${msg.id}-collapsed`
            const isExplicitlyCollapsed = expandedTools.has(collapsedId)
            const isExpanded = !isExplicitlyCollapsed && (expandedTools.has(msg.id) || autoExpandThinking)
            return (
              <div className="claude-thinking-block">
                <div
                  className="claude-thinking-toggle"
                  onClick={() => {
                    if (isExpanded) {
                      setExpandedTools(prev => {
                        const next = new Set(prev)
                        next.delete(msg.id)
                        next.add(collapsedId)
                        return next
                      })
                    } else {
                      setExpandedTools(prev => {
                        const next = new Set(prev)
                        next.delete(collapsedId)
                        next.add(msg.id)
                        return next
                      })
                      setAutoExpandThinking(true)
                    }
                  }}
                >
                  <span className={`claude-tool-chevron ${isExpanded ? 'expanded' : ''}`}>&#9654;</span>
                  <span className="claude-thinking-label">{t('claude.thinking')}</span>
                </div>
                {isExpanded && (
                  <pre className="claude-thinking-content">{msg.thinking}</pre>
                )}
              </div>
            )
          })()}
          {msg.content && (
            <ChatMarkdown text={msg.content} cwd={markdownCwd} />
          )}
          {msg.timestamp > 0 && (
            <span className="claude-msg-time" title={formatFullTimestamp(msg.timestamp)}>{formatTimestamp(msg.timestamp)}</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={panelRef}
      className="claude-agent-panel"
      style={{
        '--claude-font-size': `${claudeFontSize}px`,
        ...(getAgentPreset(terminal?.agentPreset ?? '')?.color ? { '--agent-color': getAgentPreset(terminal?.agentPreset ?? '')!.color } : {}),
      } as React.CSSProperties}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {cacheCountdown && (() => {
        const fmtMin = (ms: number) => {
          if (ms <= 0) return t('settings.cacheAlarmExpired')
          const m = Math.ceil(ms / 60_000)
          return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`
        }
        const m5Color = cacheCountdown.m5 <= 0 ? '#e05252' : cacheCountdown.m5 <= 60_000 ? '#e6a700' : '#89ca78'
        const h1Color = cacheCountdown.h1 <= 5 * 60_000 ? '#e05252' : cacheCountdown.h1 <= 20 * 60_000 ? '#e6a700' : '#89ca78'
        return (
          <div className="claude-cache-alarm">
            <span style={{ color: m5Color }}>5m: {fmtMin(cacheCountdown.m5)}</span>
            <span style={{ color: h1Color }}>1h: {fmtMin(cacheCountdown.h1)}</span>
          </div>
        )
      })()}
      {pinnedMessages.length > 0 && (
        <div className="claude-pinned-messages">
          {pinnedMessages.map(msg => (
            <div key={msg.id} className="claude-pinned-item" onClick={() => scrollToUserMsg(msg.id)}>
              <span className="claude-pinned-dot" />
              <span className="claude-pinned-text">{msg.content}</span>
            </div>
          ))}
        </div>
      )}
      {agentTreeSummary.total > 0 && agentTreeView !== 'hidden' && (
        <AgentActivityTree
          roots={agentTree}
          summary={agentTreeSummary}
          expanded={agentTreeView === 'tree'}
          onToggleExpanded={() => setAgentTreeView(v => (v === 'tree' ? 'bar' : 'tree'))}
          onHide={() => setAgentTreeView('hidden')}
          streamingText={subagentStreamingText}
          onOpenTask={(node) => setTaskModal({ taskId: node.id, label: node.label, subagentType: node.subagentType })}
          onStopTask={(id) => { void stopAgentTask(id) }}
          t={t}
        />
      )}
      <div className="claude-messages-shell">
        <div
          className="claude-messages claude-timeline"
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
          onWheel={handleMessagesWheel}
          onMouseDown={handleMessagesMouseDown}
          onMouseUp={handleMessagesMouseUp}
          onAuxClick={handleMessagesAuxClick}
          onContextMenu={(e) => {
            e.preventDefault()
            setContextMenu({ x: e.clientX, y: e.clientY, kind: 'messages' })
          }}
        >
          {(hasMoreArchived || isLoadingMore) && (
            <div className="claude-load-more">
              <button
                className="claude-load-more-btn"
                onClick={loadMoreArchived}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? t('common.loading') : t('claude.loadOlderMessages', { count: archivedCountRef.current - loadedFromArchiveRef.current })}
              </button>
            </div>
          )}
          {isResumingHistory && (
            <div className="claude-resume-skeleton">
              <span className="claude-resume-skeleton-spinner" />
              <span>{t('claude.resumingHistory')}</span>
            </div>
          )}
          {buildMessageStream(
            allMessages,
            { showToolMsg, showUserMsg, showAssistantMsg, showThinkingMsg },
            (item, i) => {
              const divider = shouldShowTimeDivider(item, allMessages[i - 1]) ? (
                <div key={`divider-${i}`} className="claude-time-divider">
                  <span>{formatTimestamp(item.timestamp || 0)}</span>
                </div>
              ) : null
              return <Fragment key={item.id || `msg-${i}`}>{divider}{renderMessage(item, i)}</Fragment>
            },
          )}
          {isStreaming && !streamingText && (!streamingThinking || !showThinkingMsg) && (
            <div className="tl-item">
              <div className="tl-dot dot-thinking" />
              <div className={`tl-content claude-thinking${turnStalled ? ' claude-thinking-stalled' : ''}`}>
                <span className="claude-thinking-text">
                  {turnStalled
                    ? t('claude.turnQuiet', { quiet: turnQuietSec, elapsed: turnElapsedSec })
                    : (runtimeWaitMessage || t('claude.thinking'))}
                </span>
                {!turnStalled && <span className="claude-thinking-dots"><span>.</span><span>.</span><span>.</span></span>}
                {!turnStalled && turnElapsedSec >= 3 && (
                  <span className="claude-thinking-elapsed">{turnElapsedSec}s</span>
                )}
              </div>
            </div>
          )}
          {streamingThinking && showThinkingMsg && (
            <div className="tl-item">
              <div className="tl-dot dot-thinking" />
              <div className="tl-content claude-thinking-block">
                <div
                  className="claude-thinking-toggle"
                  onClick={() => setShowThinking(prev => !prev)}
                >
                  <span className={`claude-tool-chevron ${showThinking ? 'expanded' : ''}`}>&#9654;</span>
                  <span className="claude-thinking-label">{t('claude.thinking')}{isStreaming && streamingThinking && !streamingText ? '...' : ''}</span>
                </div>
                {showThinking && (
                  <pre ref={streamingThinkingRef} className="claude-thinking-content">{streamingThinking}</pre>
                )}
              </div>
            </div>
          )}
          {streamingText && (
            <div className="tl-item">
              <div className="tl-dot dot-assistant" />
              <div className="tl-content claude-message-assistant">
                <div className="claude-markdown"><LinkedText text={streamingText} /><span className="claude-cursor">|</span></div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        {userScrolledUp && (
          <button
            className="scroll-to-bottom-btn"
            onPointerDown={handleScrollToBottomPointerDown}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onMouseUp={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={handleScrollToBottomClick}
            title={t('claude.scrollToBottom')}
          >
            &#x2193;
          </button>
        )}
      </div>

      {/* Permission Request Card — vertical list */}
      {pendingPermission && (() => {
        const planContent = planFileContent
        return (
        <div
          ref={permissionCardRef}
          tabIndex={-1}
          className={`claude-permission-card ${
            ['Bash', 'Write', 'NotebookEdit'].includes(pendingPermission.toolName) ? 'danger'
            : ['Edit', 'TaskCreate', 'TaskUpdate'].includes(pendingPermission.toolName) ? 'warning'
            : 'safe'
          }`}
        >
          <div className="claude-permission-title" dangerouslySetInnerHTML={{ __html: t('claude.allowThisCall', { toolName: pendingPermission.toolName }) }} />
          <div className="claude-permission-command">
            {toolInputSummary(pendingPermission.toolName, pendingPermission.input)}
          </div>
          {planContent && (
            <div className="claude-plan-block">
              <pre className="claude-plan-content">{planContent.split('\n').slice(0, 3).join('\n')}{planContent.split('\n').length > 3 ? '\n...' : ''}</pre>
              <div className="claude-plan-open-btn" onClick={() => setContentModal({ title: 'Plan', content: planContent, markdown: true })}>
                {t('claude.viewFullPlan', { count: planContent.split('\n').length })}
              </div>
            </div>
          )}
          {pendingPermission.decisionReason && !planContent && (
            <div className="claude-permission-reason">
              {pendingPermission.decisionReason}
            </div>
          )}
          {Boolean(pendingPermission.input.description) && (
            <div className="claude-permission-desc">
              {String(pendingPermission.input.description)}
            </div>
          )}
          <div className="claude-permission-options">
            <div
              className={`claude-permission-option ${permissionFocus === 0 ? 'focused' : ''}`}
              onClick={() => handlePermissionSelect(0)}
              onMouseEnter={() => setPermissionFocus(0)}
            >
              <span className="claude-permission-option-num">1</span>
              <span className="claude-permission-option-label">{t('claude.yes')}</span>
            </div>
            {showDontAskAgain && (
              <div
                className={`claude-permission-option ${permissionFocus === 1 ? 'focused' : ''}`}
                onClick={() => handlePermissionSelect(1)}
                onMouseEnter={() => setPermissionFocus(1)}
              >
                <span className="claude-permission-option-num">2</span>
                <span className="claude-permission-option-label">{dontAskAgainLabel}</span>
              </div>
            )}
            <div
              className={`claude-permission-option ${permissionFocus === (showDontAskAgain ? 2 : 1) ? 'focused' : ''}`}
              onClick={() => handlePermissionSelect(showDontAskAgain ? 2 : 1)}
              onMouseEnter={() => setPermissionFocus(showDontAskAgain ? 2 : 1)}
            >
              <span className="claude-permission-option-num">{showDontAskAgain ? 3 : 2}</span>
              <span className="claude-permission-option-label">{t('claude.no')}</span>
            </div>
            <div
              className={`claude-permission-option custom ${permissionFocus === (showDontAskAgain ? 3 : 2) ? 'focused' : ''}`}
              onClick={() => { setPermissionFocus(showDontAskAgain ? 3 : 2); permissionCustomRef.current?.focus() }}
              onMouseEnter={() => setPermissionFocus(showDontAskAgain ? 3 : 2)}
            >
              <input
                ref={permissionCustomRef}
                className="claude-permission-custom-input"
                type="text"
                placeholder={t('claude.tellClaudeInstead')}
                value={permissionCustomText}
                onChange={e => setPermissionCustomText(e.target.value)}
                onFocus={() => setPermissionFocus(3)}
              />
            </div>
          </div>
          <div className="claude-permission-hint">{t('claude.escToCancel')}</div>
        </div>
        )
      })()}

      {/* AskUserQuestion Card */}
      {pendingQuestion && (
        <div className="claude-ask-card">
          {pendingQuestion.questions.map((q, qi) => {
            const qKey = q.question || String(qi)
            const hasPreview = q.options.some(opt => opt.preview)
            const answer = askAnswers[qKey]
            const isSelected = (label: string) =>
              Array.isArray(answer) ? answer.includes(label) : answer === label
            // Preview tracks the current single pick, or the most-recently-toggled option for multi-select.
            const selectedLabel = q.multiSelect
              ? (Array.isArray(answer) && answer.length ? answer[answer.length - 1] : undefined)
              : (typeof answer === 'string' ? answer : undefined)
            const selectedPreview = selectedLabel
              ? q.options.find(opt => opt.label === selectedLabel)?.preview
              : undefined
            return (
              <div key={qi} className={`claude-ask-question ${hasPreview ? 'claude-ask-with-preview' : ''}`}>
                <div className="claude-ask-main">
                  <div className="claude-ask-header">{q.header}</div>
                  <div className="claude-ask-text">{q.question}</div>
                  {q.multiSelect && <div className="claude-ask-multi-hint">{t('claude.multiSelectHint')}</div>}
                  <div className="claude-ask-options">
                    {q.options.map((opt, oi) => (
                      <button
                        key={oi}
                        className={`claude-ask-option ${isSelected(opt.label) ? 'selected' : ''}`}
                        onClick={() => {
                          if (q.multiSelect) {
                            // Toggle this label in/out of the selection array; "Other" text coexists.
                            setAskAnswers(prev => {
                              const cur = prev[qKey]
                              const arr = Array.isArray(cur) ? cur : (typeof cur === 'string' && cur ? [cur] : [])
                              const next = arr.includes(opt.label) ? arr.filter(l => l !== opt.label) : [...arr, opt.label]
                              return { ...prev, [qKey]: next }
                            })
                          } else {
                            setAskAnswers(prev => ({ ...prev, [qKey]: opt.label }))
                            setAskOtherText(prev => { const next = { ...prev }; delete next[qKey]; return next })
                          }
                        }}
                        title={opt.description}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="claude-ask-other">
                    <input
                      type="text"
                      placeholder={t('claude.other')}
                      value={askOtherText[qKey] || ''}
                      onChange={e => { setAskOtherText(prev => ({ ...prev, [qKey]: e.target.value })); if (e.target.value && !q.multiSelect) setAskAnswers(prev => { const next = { ...prev }; delete next[qKey]; return next }) }}
                    />
                  </div>
                </div>
                {hasPreview && selectedPreview && (
                  <div className="claude-ask-preview">
                    <iframe
                      sandbox="allow-same-origin"
                      srcDoc={wrapPreviewHtml(selectedPreview)}
                      style={{ width: '100%', border: 'none', minHeight: 120, background: 'var(--bg-primary)' }}
                      title={t('claude.optionPreview')}
                    />
                  </div>
                )}
              </div>
            )
          })}
          <div className="claude-ask-actions">
            <button className="claude-permission-btn allow" onClick={handleAskUserSubmit}>{t('claude.submit')}</button>
          </div>
        </div>
      )}

      {/* Resume Session List */}
      {!isCodexSession && showResumeList && (
        <div className="claude-resume-card">
          <div className="claude-permission-title">{t('claude.resumeSession')}</div>
          {resumeLoading ? (
            <div className="claude-resume-empty">Loading sessions...</div>
          ) : resumeSessions.length === 0 ? (
            <div className="claude-resume-empty">No sessions found</div>
          ) : (
            <div className="claude-resume-list">
              {resumeSessions.map(s => {
                const fallbackPreview = s.preview && s.preview !== '(no preview)' ? s.preview : ''
                const resumeTitle = s.customTitle || s.firstPrompt || fallbackPreview
                const resumePreview = s.summary && s.summary !== resumeTitle
                  ? s.summary
                  : s.firstPrompt && s.firstPrompt !== resumeTitle
                    ? s.firstPrompt
                    : fallbackPreview && fallbackPreview !== resumeTitle
                      ? fallbackPreview
                      : ''
                return (
                  <div
                    key={s.sdkSessionId}
                    className="claude-resume-item"
                    title={resumeTitle || s.sdkSessionId}
                    onClick={() => handleResumeSelect(s.sdkSessionId)}
                  >
                    <div className="claude-resume-item-header">
                      <span className="claude-resume-item-id">{s.sdkSessionId.slice(0, 8)}</span>
                      {s.gitBranch && <span className="claude-resume-item-branch">{s.gitBranch}</span>}
                      <span className="claude-resume-item-time">
                        {new Date(s.createdAt || s.timestamp).toLocaleString()}
                      </span>
                    </div>
                    {resumeTitle && <div className="claude-resume-item-title">{resumeTitle}</div>}
                    {resumePreview && <div className="claude-resume-item-preview">{resumePreview}</div>}
                  </div>
                )
              })}
            </div>
          )}
          <div className="claude-permission-hint">{t('claude.escToCancel')}</div>
        </div>
      )}

      {/* Model Selection List */}
      {showModelList && (
        <div className="claude-resume-card">
          <div className="claude-permission-title">{isCodexSession ? 'Select a Codex model' : 'Select a model'}</div>
          {availableModels.length === 0 ? (
            <div className="claude-resume-empty">No models available</div>
          ) : (
            <div className="claude-resume-list">
              {(() => {
                const builtins = availableModels.filter(m => m.source !== 'sdk')
                const sdkModels = availableModels.filter(m => m.source === 'sdk')
                const renderItem = (m: ModelInfo) => (
                  <div
                    key={m.value}
                    className={`claude-resume-item${m.value === currentModel ? ' active' : ''}`}
                    onClick={() => handleModelSelect(m.value)}
                  >
                    <div className="claude-resume-item-header">
                      <span className="claude-resume-item-id">{m.displayName}</span>
                    </div>
                    <div className="claude-resume-item-preview">{m.description}</div>
                  </div>
                )
                // One row per model, its auto-compact windows as pills — keeps
                // the list short as models keep gaining windows.
                const renderRow = (row: typeof modelRows[number]) => {
                  const index = modelRows.indexOf(row)
                  const focused = index === modelFocusRow
                  const pending = focused ? pickClaudeModelOption(row, modelFocusWindow) : undefined
                  return (
                    <div
                      key={row.key}
                      ref={focused ? scrollModelRowIntoView : undefined}
                      className={`claude-model-row${index === activeModelRow ? ' active' : ''}${focused ? ' focused' : ''}`}
                      onClick={() => handleModelSelect(claudeModelValueForRow(row, modelFocusWindow))}
                      onMouseEnter={() => {
                        modelFocusScrollRef.current = false
                        setModelFocusRow(index)
                      }}
                    >
                      <div className="claude-model-row-main">
                        <span className="claude-model-row-label">{row.label}</span>
                        <span className="claude-model-row-desc">{row.description}</span>
                      </div>
                      {row.options.length > 0 && (
                        <div className="claude-model-row-windows">
                          {row.options.map(option => (
                            <button
                              key={option.value}
                              type="button"
                              className={`claude-model-window${option.value === currentModel ? ' active' : ''}${option === pending ? ' pending' : ''}`}
                              title={option.window === null
                                ? `${row.key} · no early auto-compact`
                                : `${row.key} · auto-compact at ${option.window.toLocaleString()} tokens`}
                              onClick={event => {
                                event.stopPropagation()
                                setModelFocusWindow(option.window)
                                void handleModelSelect(option.value)
                              }}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                }
                // Grouping already carries each row's origin, and a row that
                // merged a builtin with its SDK-reported alias belongs to the
                // builtin group only — filtering by value would emit it twice.
                const builtinRows = modelRows.filter(row => row.source !== 'sdk')
                const sdkRows = modelRows.filter(row => row.source === 'sdk')
                return (
                  <>
                    {builtins.length > 0 && (
                      <>
                        <div className="claude-model-group-label">Better Agent Terminal</div>
                        {/* Codex models have no context-window variants — keep the flat rows. */}
                        {isCodexSession ? builtins.map(renderItem) : builtinRows.map(renderRow)}
                      </>
                    )}
                    {sdkModels.length > 0 && (
                      <>
                        <div className="claude-model-group-label">{isCodexSession ? 'Codex Agent' : 'Claude Agent'}</div>
                        {isCodexSession ? sdkModels.map(renderItem) : sdkRows.map(renderRow)}
                      </>
                    )}
                  </>
                )
              })()}
            </div>
          )}
          {!isCodexSession && isV2Session && (
            <div className="claude-model-1m-hint">{t('claude.v2ModelListHint')}</div>
          )}
          {!isCodexSession && !isV2Session && (
            <div className="claude-model-1m-hint">{t('claude.v1Model1mHint')}</div>
          )}
          <div className="claude-permission-hint">
            {!isCodexSession && <>{t('claude.modelPickerHint')} · </>}
            {t('claude.escToCancel')}
          </div>
        </div>
      )}

      {remoteDropUpload.pendingFileNames && (
        <RemoteUploadConfirmDialog
          fileNames={remoteDropUpload.pendingFileNames}
          onConfirm={remoteDropUpload.confirmUpload}
          onCancel={remoteDropUpload.cancelUpload}
        />
      )}

      {/* Ctrl+P File Picker */}
      {showFilePicker && (
        <div className="claude-file-picker" onClick={() => setShowFilePicker(false)}>
          <div className="claude-file-picker-box" onClick={e => e.stopPropagation()}>
            <input
              ref={filePickerInputRef}
              className="claude-file-picker-input"
              type="text"
              placeholder={filePickerMode === 'attach' ? 'Search host files to attach...' : t('claude.searchFilesByName')}
              value={filePickerQuery}
              onChange={e => setFilePickerQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setFilePickerIndex(prev => filePickerResults.length > 0 ? Math.min(prev + 1, filePickerResults.length - 1) : 0)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setFilePickerIndex(prev => Math.max(prev - 1, 0))
                } else if (e.key === 'Enter' && filePickerResults.length > 0) {
                  e.preventDefault()
                  const selected = filePickerResults[filePickerIndex]
                  if (selected && !selected.isDirectory) {
                    void handleFilePickerSelect(selected)
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setShowFilePicker(false)
                }
              }}
            />
            <div className="claude-file-picker-list">
              {!filePickerQuery.trim() && (
                <div className="claude-file-picker-empty">{filePickerMode === 'attach' ? 'Type to search host files...' : t('claude.typeToSearchFiles')}</div>
              )}
              {filePickerQuery.trim() && filePickerLoading && (
                <div className="claude-file-picker-empty">{t('common.loading')}</div>
              )}
              {filePickerQuery.trim() && filePickerError && (
                <div className="claude-file-picker-empty">{filePickerError}</div>
              )}
              {filePickerQuery.trim() && !filePickerLoading && !filePickerError && filePickerResults.length === 0 && (
                <div className="claude-file-picker-empty">{t('claude.noFilesFound')}</div>
              )}
              {filePickerResults.slice(0, 20).map((item, i) => {
                const relPath = item.path.startsWith(cwd)
                  ? item.path.slice(cwd.length).replace(/^[\\/]/, '')
                  : item.path
                return (
                  <div
                    key={item.path}
                    className={`claude-file-picker-item${i === filePickerIndex ? ' selected' : ''}${item.isDirectory ? ' is-dir' : ''}`}
                    onClick={() => {
                      if (!item.isDirectory) {
                        void handleFilePickerSelect(item)
                      }
                    }}
                    onMouseEnter={() => setFilePickerIndex(i)}
                  >
                    <span className="claude-file-picker-name">{item.isDirectory ? '\uD83D\uDCC1' : '\uD83D\uDCC4'} {item.name}</span>
                    <span className="claude-file-picker-path">{relPath}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* File Preview from Picker */}
      {filePickerPreview && (
        <FilePreviewModal
          filePath={filePickerPreview}
          onClose={() => setFilePickerPreview(null)}
        />
      )}

      {/* Plan file bar — debug only */}
      {host.debug.isDebugMode && activePlanFile && dismissedPlanFileRef.current !== activePlanFile && (
        <div className="claude-plan-file-bar">
          <span className="claude-plan-file-label" style={{ cursor: 'pointer' }} onClick={() => {
            host.fs.readFile(activePlanFile).then(r => {
              if (r.content) setContentModal({ title: 'Plan', content: r.content, markdown: true })
            }).catch(() => {})
          }} title={activePlanFile}>
            <span>📋 {activePlanFile.split('/').pop()}</span>
            {planFileTitle && <span className="claude-plan-file-subtitle">{planFileTitle}</span>}
          </span>
          <div className="claude-plan-file-actions">
            <button
              className="claude-plan-file-btn"
              onClick={() => { dismissedPlanFileRef.current = activePlanFile; setActivePlanFile(null); setPlanFileShownAt(null) }}
            >Dismiss</button>
          </div>
        </div>
      )}

      {/* Worktree action bar — always visible when worktree is active, buttons hidden during streaming */}
      {isWorktreeSession && worktreeInfo && (
        <div className="claude-worktree-bar">
          <div className="claude-worktree-identity">
            <span className="claude-worktree-label">🌳 {worktreeInfo.branchName}</span>
            {terminal?.worktreeMergedKind && terminal.worktreeMergedKind !== 'unknown' && (
              <WorktreeMergedChip kind={terminal.worktreeMergedKind} />
            )}
          </div>
          {!isStreaming && <div className="claude-worktree-actions">
            <button
              className="claude-worktree-btn"
              onClick={async () => {
                const status = await host.claude.getWorktreeStatus(sessionId)
                if (status?.diff) {
                  // Show diff as a system message
                  setMessages(prev => [...prev, {
                    id: `sys-diff-${Date.now()}`,
                    sessionId,
                    role: 'system' as const,
                    content: `\`\`\`diff\n${status.diff}\n\`\`\``,
                    timestamp: Date.now(),
                  }])
                } else {
                  setMessages(prev => [...prev, {
                    id: `sys-diff-${Date.now()}`,
                    sessionId,
                    role: 'system' as const,
                    content: 'No changes detected in worktree.',
                    timestamp: Date.now(),
                  }])
                }
              }}
              title="View diff between worktree and source branch"
            >Diff</button>
            <button
              className="claude-worktree-btn"
              onClick={async () => {
                if (!await host.dialog.confirm(`Merge ${worktreeInfo.branchName} into ${worktreeInfo.sourceBranch}?`)) return
                const cmd = `Commit all current changes with a descriptive message, then use host folder (${worktreeInfo.gitRoot}) to merge worktree folder (${worktreeInfo.worktreePath}). Steps:\n1. Stage and commit all changes in the worktree folder with a meaningful commit message\n2. Switch to host folder (${worktreeInfo.gitRoot}) and merge the worktree branch (${worktreeInfo.branchName}) into ${worktreeInfo.sourceBranch}\nDo not push to remote. Do not create a PR.`
                await sendClaudeMessage(cmd, undefined, getAutoCompactWindowForModel(currentModel, settingsStore.getSettings().autoCompactWindow))
              }}
              title={`Commit and merge ${worktreeInfo.branchName} into ${worktreeInfo.sourceBranch}`}
            >Merge to Host</button>
            <button
              className="claude-worktree-btn"
              onClick={async () => {
                if (!await host.dialog.confirm(`Push ${worktreeInfo.branchName} directly to origin/main?`)) return
                const cmd = `Commit all current changes with a descriptive message, then push directly to origin/main. Steps:\n1. Stage and commit all changes with a meaningful commit message\n2. Pull origin/main and resolve any conflicts if needed\n3. Push to origin/main\nDo not create a PR. Do not ask for confirmation.`
                await sendClaudeMessage(cmd, undefined, getAutoCompactWindowForModel(currentModel, settingsStore.getSettings().autoCompactWindow))
              }}
              title="Commit, pull, resolve conflicts, and push to origin/main"
            >Push to Main</button>
            <button
              className="claude-worktree-btn"
              onClick={async () => {
                const cmd = `Commit all current changes and create or update a pull request to origin/main. Steps:\n1. Stage and commit all changes with a meaningful commit message\n2. Push this branch to origin\n3. Check if a PR from this branch to main already exists (gh pr list --head ${worktreeInfo.branchName})\n4. If a PR exists: update it with the latest changes summary (gh pr edit)\n5. If no PR exists: create one with gh pr create, include a summary of all changes in the description\nDo not merge the PR.`
                await sendClaudeMessage(cmd, undefined, getAutoCompactWindowForModel(currentModel, settingsStore.getSettings().autoCompactWindow))
              }}
              title="Commit, push branch, and create or update PR to main"
            >Create PR</button>
            <button
              className="claude-worktree-btn claude-worktree-btn-danger"
              onClick={() => onClose?.(sessionId)}
              title="Close this worktree tab"
            >Close</button>
          </div>}
        </div>
      )}

      {/* Input area — hidden when permission card, ask-user card, or resume/model list is visible */}
      <div
        className={`claude-input-area${isDragOver ? ' drag-over' : ''}`}
        style={pendingPermission || pendingQuestion || showResumeList || showModelList ? { display: 'none' } : undefined}
      >
        {/* Always-visible turn status: the in-list "Thinking" row scrolls away
            and disappears once content streams; this strip answers "is the
            agent still doing anything?" from anywhere in the conversation. */}
        {isStreaming && (
          <div className={`claude-turn-status${turnStalled ? ' stalled' : ''}`}>
            <span className="claude-turn-status-dot" />
            <span className="claude-turn-status-text">
              {turnStalled
                ? t('claude.turnQuiet', { quiet: turnQuietSec, elapsed: turnElapsedSec })
                : `${runtimeWaitMessage
                  || (streamingText
                    ? t('claude.turnResponding')
                    : streamingThinking
                      ? t('claude.thinking')
                      : t('claude.turnWorking'))} · ${turnElapsedSec}s`}
            </span>
            <span className="claude-turn-status-hint">{t('claude.turnStopHint')}</span>
          </div>
        )}
        {/* Prompt suggestion chip */}
        {promptSuggestion && !isStreaming && (
          <div className="claude-prompt-suggestion" onClick={() => {
            setInputValue(promptSuggestion)
            setPromptSuggestion(null)
            textareaRef.current?.focus()
          }}>
            <span className="claude-prompt-suggestion-label">Suggested <kbd>Tab</kbd>:</span>
            <span className="claude-prompt-suggestion-text">{promptSuggestion}</span>
          </div>
        )}
        {/* Slash command autocomplete menu */}
        {showSlashMenu && filteredSlashCommands.length > 0 && (
          <div className="claude-slash-menu">
            {slashGroups.map(group => (
              <Fragment key={group.source}>
                {/* Headings only earn their space once there is more than one
                    group — with Claude Code unreachable the menu is BAT's list
                    alone, and a lone "BAT" header over it says nothing. */}
                {slashGroups.length > 1 && (
                  <div className="claude-slash-group">{group.label}</div>
                )}
                {group.items.map(cmd => {
                  const i = slashIndexByName.get(cmd.name) ?? -1
                  const selected = i === slashMenuIndex
                  return (
                    <div
                      key={cmd.name}
                      ref={selected ? selectedSlashItemRef : undefined}
                      className={`claude-slash-item${selected ? ' selected' : ''}`}
                      onClick={() => handleSlashSelect(cmd)}
                      onMouseEnter={() => setSlashMenuIndex(i)}
                    >
                      <span className="claude-slash-name">/{cmd.name}</span>
                      {cmd.argumentHint && (
                        <span className="claude-slash-hint">{cmd.argumentHint}</span>
                      )}
                      <span className="claude-slash-desc">{cmd.description}</span>
                    </div>
                  )
                })}
              </Fragment>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="claude-input"
          defaultValue=""
          onInput={handleInputChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposingRef.current = true }}
          onCompositionEnd={() => {
            setTimeout(() => { isComposingRef.current = false }, 0)
          }}
          onPaste={handlePaste}
          placeholder={isInterrupted
            ? 'Type to continue, Esc to stop...'
            : isStreaming
              ? 'Press Esc to pause, double-Esc to stop...'
              : isCodexSession
                ? 'Type a message to Codex...'
                : 'Type a message... (Enter to send, Shift+Tab to switch mode)'}
          disabled={false}
          rows={2}
        />
        {(attachedImages.length > 0 || attachedFiles.length > 0) && (
          <div className="claude-attachments">
            {attachedImages.map(img => (
              <div key={img.path} className="claude-attachment">
                <img src={img.dataUrl} className="claude-attachment-thumb" alt="attached" />
                <button
                  className="claude-attachment-remove"
                  onClick={() => removeImage(img.path)}
                  title={t('claude.removeImage')}
                >
                  &times;
                </button>
              </div>
            ))}
            {attachedFiles.map(file => (
              <div key={file.path} className="claude-attachment-file" title={file.path}>
                <span className="claude-attachment-file-icon">&#128196;</span>
                <span className="claude-attachment-file-name">{file.name}</span>
                <button
                  className="claude-attachment-remove"
                  onClick={() => removeFile(file.path)}
                  title={t('claude.removeFile')}
                >
                  &times;
                </button>
              </div>
            ))}
            {(attachedImages.length < MAX_IMAGES || attachedFiles.length < MAX_FILES) && (
              <button
                className="claude-add-image-btn"
                onClick={handleSelectAttachments}
                title={t('claude.addImage')}
              >
                +
              </button>
            )}
          </div>
        )}
        <div className="claude-input-footer">
          <div className="claude-input-controls">
            {isCodexSession && (
              <>
                <select
                  className="claude-effort-select"
                  value={codexSandboxMode}
                  onChange={handleCodexSandboxModeChange}
                  title="Codex sandbox mode"
                >
                  {codexSandboxModeOptions.map(mode => (
                    <option key={mode} value={mode}>sandbox: {mode}</option>
                  ))}
                </select>
                <select
                  className="claude-effort-select"
                  value={codexApprovalPolicy}
                  onChange={handleCodexApprovalPolicyChange}
                  title="Codex approval policy"
                >
                  {codexApprovalPolicyOptions.map(policy => (
                    <option key={policy} value={policy}>approval: {policy}</option>
                  ))}
                </select>
              </>
            )}
            {!isCodexSession && (
              <span
                className={`claude-status-btn claude-mode-${permissionMode}`}
                onClick={handlePermissionModeCycle}
                title={`Permission: ${permissionMode} (click to cycle)`}
              >
                {permissionModeLabels[permissionMode] || permissionMode}
              </span>
            )}

            {currentModel && (
              <span
                className="claude-status-btn"
                onClick={() => setShowModelList(true)}
                title={`Model: ${currentModelLabel}${currentSdkModel !== currentModel ? ` (${currentSdkModel})` : ''} (click to select)`}
              >
                {'</>'} {currentModelLabel}{currentModelContextSuffix}
                {compactWindowMismatch && (
                  <span
                    style={{ color: 'var(--warning, #e5c07b)', marginLeft: 4 }}
                    title={`Auto-compact mismatch: selection expects ${Math.round(compactWindowMismatch.expected / 1000)}k, session is ${compactWindowMismatch.actual ? `${Math.round(compactWindowMismatch.actual / 1000)}k` : 'uncapped'} — reselect the model to reapply`}
                  >
                    {'⚠'}
                  </span>
                )}
              </span>
            )}
            {!isCodexSession && !isV2Session && (
              <select
                className="claude-effort-select"
                value={effortLevel}
                onChange={handleEffortChange}
                title={t('claude.effortLevel')}
              >
                {effortOptions.map(level => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            )}
            {!isCodexSession && accountInfo?.organization && (
              <span className="claude-status-btn claude-account-info" title={`${accountInfo.email || ''} (${accountInfo.subscriptionType || 'unknown'})`}>
                {accountInfo.organization}
              </span>
            )}
          </div>

          <div className="claude-input-actions">
            {hasSdkSession && !isCodexSession && (
              <button
                className="claude-fork-btn"
                onClick={handleForkSession}
                title={t('claude.forkSession')}
              >
                {t('claude.forkButton')} <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{verticalAlign: '-1px', marginLeft: '2px'}}><circle cx="5" cy="3" r="1.5"/><circle cx="11" cy="3" r="1.5"/><circle cx="5" cy="13" r="1.5"/><path d="M5 4.5V11.5M5 7C5 7 5 5 8 5S11 4.5 11 4.5" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
              </button>
            )}
            <span
              className="claude-status-btn"
              onClick={handleSelectAttachments}
              title={t('claude.attachImages')}
            >
              &#128206;
            </span>
            {isStreaming ? (
              <button
                className="claude-send-btn claude-stop-btn"
                onClick={handleStop}
                title={t('claude.stopEsc')}
              >
                ■
              </button>
            ) : (
              <button
                className="claude-send-btn"
                onClick={handleSend}
                disabled={false}
                title={t('claude.sendMessage')}
              >
                ▶
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Plan Modal */}
      {contentModal && (
        <div className="claude-plan-overlay" onClick={() => setContentModal(null)}>
          <div className="claude-plan-modal" onClick={e => e.stopPropagation()}>
            <div className="claude-plan-modal-header">
              <span className="claude-plan-modal-title">{contentModal.title}</span>
              <button className="claude-plan-modal-close" onClick={() => setContentModal(null)}>&times;</button>
            </div>
            {contentModal.markdown ? (
              <ChatMarkdown
                text={contentModal.content}
                cwd={markdownCwd}
                className="claude-plan-modal-body claude-plan-modal-markdown claude-markdown"
              />
            ) : (
              <pre className="claude-plan-modal-body">{contentModal.content}</pre>
            )}
          </div>
        </div>
      )}

      {/* Context Usage Popup */}
      {contextUsagePopup && (
        <div className="claude-plan-overlay" onClick={() => setContextUsagePopup(null)}>
          <div className="claude-plan-modal claude-context-usage-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="claude-plan-modal-header">
              <span className="claude-plan-modal-title">Context Usage — {contextUsagePopup.model}</span>
              <button className="claude-plan-modal-close" onClick={() => setContextUsagePopup(null)}>&times;</button>
            </div>
            <div className="claude-plan-modal-body" style={{ padding: '12px 16px', whiteSpace: 'normal', fontFamily: 'inherit' }}>
              <div style={{ marginBottom: 12 }}>
                {(() => {
                  const api = contextUsagePopup.apiUsage
                  const apiContext = api ? api.input_tokens + api.cache_read_input_tokens + api.cache_creation_input_tokens : 0
                  const apiPct = apiContext > 0 ? Math.round((apiContext / contextUsagePopup.maxTokens) * 100) : 0
                  const showApi = apiContext > 0 && Math.abs(apiContext - contextUsagePopup.totalTokens) > 1000
                  const primaryTokens = showApi ? apiContext : contextUsagePopup.totalTokens
                  const primaryPct = showApi ? apiPct : contextUsagePopup.percentage
                  return (<>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
                      <span>{primaryTokens.toLocaleString()} / {contextUsagePopup.maxTokens.toLocaleString()} tokens</span>
                      <span style={{ color: primaryPct >= 80 ? '#e05252' : primaryPct >= 50 ? '#e6a700' : '#89ca78' }}>
                        {primaryPct}%
                      </span>
                    </div>
                    {showApi && (
                      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
                        SDK estimate: {contextUsagePopup.totalTokens.toLocaleString()} ({contextUsagePopup.percentage}%)
                      </div>
                    )}
                  </>)
                })()}
                <div style={{ height: 8, background: '#333', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
                  {contextUsagePopup.categories.filter(c => c.tokens > 0).map((cat, i) => (
                    <div key={i} style={{ width: `${(cat.tokens / contextUsagePopup!.maxTokens) * 100}%`, background: cat.color, height: '100%' }} title={`${cat.name}: ${cat.tokens.toLocaleString()}`} />
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 12 }}>
                {contextUsagePopup.categories.filter(c => c.tokens > 0).map((cat, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', opacity: cat.isDeferred ? 0.5 : 1 }}>
                    <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: cat.color, marginRight: 6, verticalAlign: 'middle' }} />{cat.name}{cat.isDeferred && !cat.name.includes('(deferred)') ? ' (deferred)' : ''}</span>
                    <span style={{ color: '#999' }}>{cat.tokens.toLocaleString()}</span>
                  </div>
                ))}
              </div>
              {contextUsagePopup.memoryFiles && contextUsagePopup.memoryFiles.length > 0 && (
                <div style={{ marginTop: 10, borderTop: '1px solid #333', paddingTop: 8, fontSize: 11 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: '#bbb' }}>Memory Files</div>
                  {contextUsagePopup.memoryFiles.map((f, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
                      <span style={{ color: '#999', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.path.split('/').pop()}</span>
                      <span style={{ color: '#666' }}>{f.tokens.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
              {contextUsagePopup.mcpTools && contextUsagePopup.mcpTools.length > 0 && (
                <div style={{ marginTop: 10, borderTop: '1px solid #333', paddingTop: 8, fontSize: 11 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: '#bbb' }}>MCP Tools</div>
                  {contextUsagePopup.mcpTools.filter(t => t.tokens > 0).slice(0, 20).map((t, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
                      <span style={{ color: '#999' }}>{t.serverName}:{t.name}{t.isLoaded === false ? ' (deferred)' : ''}</span>
                      <span style={{ color: '#666' }}>{t.tokens.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Cache History Modal */}
      {showCacheHistory && (() => {
        const hist = cacheHistoryRef.current
        const significant = hist.filter(h => h.totalInput >= 50000)
        const belowCount = significant.filter(h => h.pct < 50).length
        // Per-MTok pricing — exact model match only, no fallback
        // Ref: https://platform.claude.com/docs/en/about-claude/pricing
        const P = (input: number, output: number) => ({ input, output, cacheRead: input * 0.1, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 })
        const MODEL_PRICING: Record<string, ReturnType<typeof P>> = {
          'fable-5':   P(10, 50),
          'opus-5':    P(5, 25),    'opus-4-8':  P(5, 25),    'opus-4-7':  P(5, 25),    'opus-4-6':  P(5, 25),    'opus-4-5':  P(5, 25),
          'opus-4-1':  P(15, 75),   'opus-4':    P(15, 75),   'opus-3': P(15, 75),
          'sonnet-5':  P(3, 15),
          'sonnet-4-6': P(3, 15),   'sonnet-4-5': P(3, 15),   'sonnet-4': P(3, 15),
          'sonnet-3-7': P(3, 15),   'sonnet-3-5': P(3, 15),
          'haiku-4-5': P(1, 5),     'haiku-3-5': P(0.80, 4),  'haiku-3': P(0.25, 1.25),
        }
        const getModelPricing = (model: string) => {
          if (model.includes('fable-5')) return MODEL_PRICING['fable-5']
          if (model.includes('opus-5')) return MODEL_PRICING['opus-5']
          if (model.includes('opus-4-8')) return MODEL_PRICING['opus-4-8']
          if (model.includes('opus-4-7')) return MODEL_PRICING['opus-4-7']
          if (model.includes('opus-4-6')) return MODEL_PRICING['opus-4-6']
          if (model.includes('opus-4-5')) return MODEL_PRICING['opus-4-5']
          if (model.includes('opus-4-1')) return MODEL_PRICING['opus-4-1']
          if (model.includes('opus-4-0') || model.match(/opus-4(?!-)\b/) || model.match(/opus-4-2\d{7}/)) return MODEL_PRICING['opus-4']
          if (model.includes('opus-3') || model.includes('3-opus')) return MODEL_PRICING['opus-3']
          if (model.includes('sonnet-5')) return MODEL_PRICING['sonnet-5']
          if (model.includes('sonnet-4-6')) return MODEL_PRICING['sonnet-4-6']
          if (model.includes('sonnet-4-5')) return MODEL_PRICING['sonnet-4-5']
          if (model.includes('sonnet-4-0') || model.match(/sonnet-4(?!-)\b/) || model.match(/sonnet-4-2\d{7}/)) return MODEL_PRICING['sonnet-4']
          if (model.includes('sonnet-3-7') || model.includes('3-7-sonnet')) return MODEL_PRICING['sonnet-3-7']
          if (model.includes('sonnet-3-5') || model.includes('3-5-sonnet')) return MODEL_PRICING['sonnet-3-5']
          if (model.includes('haiku-4') || model.includes('4-5-haiku')) return MODEL_PRICING['haiku-4-5']
          if (model.includes('haiku-3-5') || model.includes('3-5-haiku')) return MODEL_PRICING['haiku-3-5']
          if (model.includes('haiku-3') || model.includes('3-haiku')) return MODEL_PRICING['haiku-3']
          return null
        }
        const fmtCost = (v: number | null) => v === null ? '—' : `$${v.toFixed(4)}`
        // Calculate per-model cost for a history entry using pricing lookup
        const calcModelCosts = (h: typeof hist[0]) => {
          const hasModelUsage = h.modelUsage && Object.keys(h.modelUsage).length > 0
          if (hasModelUsage) {
            const models: { model: string; cacheRead: number; cacheWrite: number; input: number; output: number; readCost: number | null; writeCost: number | null; totalCost: number | null; pricing: ReturnType<typeof P> | null }[] = []
            for (const [model, stats] of Object.entries(h.modelUsage!)) {
              const p = getModelPricing(model)
              const totalIn = stats.inputTokens + stats.cacheReadInputTokens + stats.cacheCreationInputTokens
              if (!p) {
                models.push({ model, cacheRead: stats.cacheReadInputTokens, cacheWrite: stats.cacheCreationInputTokens, input: totalIn, output: stats.outputTokens, readCost: null, writeCost: null, totalCost: null, pricing: null })
                continue
              }
              let writePrice = p.cacheWrite5m
              if (h.cacheWrite5mTokens !== undefined && h.cacheWrite1hTokens !== undefined) {
                const total5m1h = h.cacheWrite5mTokens + h.cacheWrite1hTokens
                if (total5m1h > 0) {
                  writePrice = (h.cacheWrite5mTokens * p.cacheWrite5m + h.cacheWrite1hTokens * p.cacheWrite1h) / total5m1h
                }
              }
              const readCost = (stats.cacheReadInputTokens / 1_000_000) * p.cacheRead
              const writeCost = (stats.cacheCreationInputTokens / 1_000_000) * writePrice
              const inputCost = (stats.inputTokens / 1_000_000) * p.input
              const outputCost = (stats.outputTokens / 1_000_000) * p.output
              models.push({ model, cacheRead: stats.cacheReadInputTokens, cacheWrite: stats.cacheCreationInputTokens, input: totalIn, output: stats.outputTokens, readCost, writeCost, totalCost: readCost + writeCost + inputCost + outputCost, pricing: p })
            }
            return models
          }
          // Fallback: estimate from entry-level model + turn tokens when modelUsage is unavailable (streaming)
          if (h.model) {
            const p = getModelPricing(h.model)
            const output = h.outputTokens || 0
            if (!p) return [{ model: h.model, cacheRead: h.cacheRead, cacheWrite: h.cacheCreate, input: h.totalInput, output, readCost: null, writeCost: null, totalCost: null, pricing: null }]
            let writePrice = p.cacheWrite5m
            if (h.cacheWrite5mTokens !== undefined && h.cacheWrite1hTokens !== undefined) {
              const total5m1h = h.cacheWrite5mTokens + h.cacheWrite1hTokens
              if (total5m1h > 0) {
                writePrice = (h.cacheWrite5mTokens * p.cacheWrite5m + h.cacheWrite1hTokens * p.cacheWrite1h) / total5m1h
              }
            }
            const readCost = (h.cacheRead / 1_000_000) * p.cacheRead
            const writeCost = (h.cacheCreate / 1_000_000) * writePrice
            const uncachedInput = Math.max(0, h.totalInput - h.cacheRead - h.cacheCreate)
            const inputCost = (uncachedInput / 1_000_000) * p.input
            const outputCost = (output / 1_000_000) * p.output
            return [{ model: h.model, cacheRead: h.cacheRead, cacheWrite: h.cacheCreate, input: h.totalInput, output, readCost, writeCost, totalCost: readCost + writeCost + inputCost + outputCost, pricing: p }]
          }
          return null
        }
        // Grand total: skip streaming entries that have a subsequent result entry (same turn)
        let grandTotal = 0
        let hasAnyCost = false
        for (let i = 0; i < hist.length; i++) {
          if (!hist[i].isResult && i + 1 < hist.length && hist[i + 1].isResult) continue
          const models = calcModelCosts(hist[i])
          if (models) {
            for (const m of models) {
              if (m.totalCost !== null) { grandTotal += m.totalCost; hasAnyCost = true }
            }
          }
        }
        return (
          <div className="claude-plan-overlay" onClick={() => setShowCacheHistory(false)}>
            <div className="claude-plan-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 1060 }}>
              <div className="claude-plan-modal-header">
                <span className="claude-plan-modal-title">Cache Efficiency History (last {hist.length})</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="claude-plan-modal-close" title="Clear history" style={{ fontSize: 14, opacity: 0.6 }} onClick={() => { cacheHistoryRef.current = []; setShowCacheHistory(false) }}>Clear</button>
                  <button className="claude-plan-modal-close" onClick={() => setShowCacheHistory(false)}>&times;</button>
                </div>
              </div>
              <div className="claude-plan-modal-body" style={{ padding: '12px 16px', fontFamily: 'inherit' }}>
                {significant.length > 0 && (
                  <div style={{ fontSize: 12, marginBottom: 10, color: '#999' }}>
                    &lt;50%: {belowCount}/{significant.length} significant readings ({'>'}=50k input)
                  </div>
                )}
                <div style={{ fontSize: 12 }}>
                  {/* Token header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #333', fontWeight: 600, color: '#bbb' }}>
                    <span style={{ width: 24 }}>#</span>
                    <span style={{ width: 36, textAlign: 'right' }} title="Turn cache efficiency: turn c.read / turn total">%</span>
                    <span style={{ width: 36, textAlign: 'right' }} title="Number of API calls in this turn">calls</span>
                    <span style={{ width: 76, textAlign: 'right' }} title="Last API call's cache read tokens">call c.read</span>
                    <span style={{ width: 76, textAlign: 'right' }} title="Last API call's cache write tokens">call c.write</span>
                    <span style={{ width: 76, textAlign: 'right' }} title="Sum of cache read tokens across all API calls in this turn">turn c.read</span>
                    <span style={{ width: 76, textAlign: 'right' }} title="Sum of cache write tokens across all API calls in this turn">turn c.write</span>
                    <span style={{ width: 76, textAlign: 'right' }} title="Total input tokens consumed in this turn">turn total</span>
                    <span style={{ width: 56, textAlign: 'right' }} title="Output tokens (result rows only)">output</span>
                    <span style={{ width: 64, textAlign: 'right' }} title="Estimated cache read cost">c.read $</span>
                    <span style={{ width: 64, textAlign: 'right' }} title="Estimated cache write cost (weighted 5m/1h)">c.write $</span>
                    <span style={{ width: 64, textAlign: 'right' }} title="Estimated total cost (cache read + write + uncached input + output)">est. $</span>
                    <span style={{ width: 64, textAlign: 'right' }} title="Actual turn cost from API (result rows only)">real $</span>
                    <span style={{ width: 110, textAlign: 'right' }}>time</span>
                  </div>
                  {(() => { let callNum = 0; return hist.map((h, i) => {
                    if (!h.isResult) callNum++
                    const isSkip = h.totalInput < 50000
                    const pctColor = h.pct >= 70 ? '#89ca78' : h.pct >= 40 ? '#e6a700' : '#e05252'
                    const realTurnCost = h.isResult && h.modelUsage ? Object.values(h.modelUsage).reduce((s, m) => s + (m.costUSD || 0), 0) : null
                    const models = calcModelCosts(h)
                    const turnReadCost = models?.reduce((s, m) => m.readCost !== null ? s + m.readCost : s, 0) ?? null
                    const turnWriteCost = models?.reduce((s, m) => m.writeCost !== null ? s + m.writeCost : s, 0) ?? null
                    const turnTotalCost = models?.reduce((s, m) => m.totalCost !== null ? s + m.totalCost : s, 0) ?? null
                    const hasMultiModel = models && models.length > 1
                    return (
                      <div key={i}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: hasMultiModel ? 'none' : '1px solid #222', ...(h.isResult ? { borderTop: '1px solid #444', background: '#1a1a2e' } : {}) }}>
                          <span style={{ width: 24, color: h.isResult ? '#c678dd' : isSkip ? '#666' : '#eee', cursor: h.isResult ? 'pointer' : 'default', textDecoration: h.isResult ? 'underline' : 'none' }} onClick={() => h.isResult && setCacheEntryModal(i)} title={h.isResult ? 'View turn conversation' : undefined}>{h.isResult ? 'R' : callNum}</span>
                          <span style={{ width: 36, textAlign: 'right', color: isSkip ? '#eee' : pctColor }}>{h.pct}%</span>
                          <span style={{ width: 36, textAlign: 'right', color: isSkip ? '#666' : '#d19a66' }}>{h.isResult ? h.calls : 1}</span>
                          <span style={{ width: 76, textAlign: 'right', color: isSkip ? '#666' : '#8be9fd' }}>{h.callCacheRead ? h.callCacheRead.toLocaleString() : '—'}</span>
                          <span style={{ width: 76, textAlign: 'right', color: isSkip ? '#666' : '#8be9fd' }}>{h.callCacheWrite ? h.callCacheWrite.toLocaleString() : '—'}</span>
                          <span style={{ width: 76, textAlign: 'right', color: isSkip ? '#666' : '#eee' }}>{h.cacheRead.toLocaleString()}</span>
                          <span style={{ width: 76, textAlign: 'right', color: isSkip ? '#666' : '#eee' }}>{h.cacheCreate.toLocaleString()}</span>
                          <span style={{ width: 76, textAlign: 'right', color: isSkip ? '#666' : '#888' }}>{h.totalInput.toLocaleString()}</span>
                          <span style={{ width: 56, textAlign: 'right', color: isSkip ? '#666' : '#d19a66' }}>{h.isResult && h.outputTokens ? h.outputTokens.toLocaleString() : ''}</span>
                          <span style={{ width: 64, textAlign: 'right', color: isSkip ? '#666' : '#89ca78' }}>{fmtCost(turnReadCost)}</span>
                          <span style={{ width: 64, textAlign: 'right', color: isSkip ? '#666' : '#e6a700' }}>{fmtCost(turnWriteCost)}</span>
                          <span style={{ width: 64, textAlign: 'right', color: isSkip ? '#666' : '#eee' }}>{fmtCost(turnTotalCost)}</span>
                          <span style={{ width: 64, textAlign: 'right', color: realTurnCost !== null ? '#50fa7b' : '#333' }}>{realTurnCost !== null ? fmtCost(realTurnCost) : ''}</span>
                          <span style={{ width: 110, textAlign: 'right', color: '#555', fontSize: 11 }}>{h.timestamp ? new Date(h.timestamp).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</span>
                        </div>
                        {/* Per-model sub-rows — same column widths as header */}
                        {models && models.map(m => (
                          <div key={m.model} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', fontSize: 11, borderBottom: '1px solid #1a1a1a' }}>
                            <span style={{ width: 24 }} />
                            <span style={{ width: 36 }} />
                            <span style={{ width: 36 }} />
                            <span style={{ width: 156, color: '#666', whiteSpace: 'nowrap', paddingLeft: 4 }}>{m.model}</span>
                            <span style={{ width: 76, textAlign: 'right', color: '#555' }}>{m.cacheRead.toLocaleString()}</span>
                            <span style={{ width: 76, textAlign: 'right', color: '#555' }}>{m.cacheWrite.toLocaleString()}</span>
                            <span style={{ width: 76 }} />
                            <span style={{ width: 56, textAlign: 'right', color: '#555' }}>{m.output.toLocaleString()}</span>
                            <span style={{ width: 64, textAlign: 'right', color: m.readCost !== null ? '#557a56' : '#555' }}>{fmtCost(m.readCost)}</span>
                            <span style={{ width: 64, textAlign: 'right', color: m.writeCost !== null ? '#8a7030' : '#555' }}>{fmtCost(m.writeCost)}</span>
                            <span style={{ width: 64, textAlign: 'right', color: m.totalCost !== null ? '#999' : '#555' }}>{fmtCost(m.totalCost)}</span>
                            <span style={{ width: 64 }} />
                            <span style={{ width: 110 }} />
                          </div>
                        ))}
                      </div>
                    )
                  }) })()}
                  {/* Grand total */}
                  {hist.length > 0 && (() => {
                    let apiTotal = 0
                    let hasApiCost = false
                    for (const h of hist) {
                      if (h.isResult && h.modelUsage) {
                        for (const m of Object.values(h.modelUsage)) {
                          if (m.costUSD) { apiTotal += m.costUSD; hasApiCost = true }
                        }
                      }
                    }
                    return (
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: '1px solid #444', fontWeight: 600 }}>
                        <span style={{ flex: 1, color: '#bbb' }}>Total</span>
                        <span style={{ width: 64, textAlign: 'right', color: hasAnyCost ? '#eee' : '#666' }}>{hasAnyCost ? `$${grandTotal.toFixed(4)}` : '—'}</span>
                        <span style={{ width: 64, textAlign: 'right', color: hasApiCost ? '#50fa7b' : '#666' }}>{hasApiCost ? `$${apiTotal.toFixed(4)}` : '—'}</span>
                        <span style={{ width: 110 }} />
                      </div>
                    )
                  })()}
                  {hist.length === 0 && <div style={{ color: '#666', padding: '8px 0' }}>No readings yet.</div>}
                </div>
                <div style={{ fontSize: 12, color: '#e05252', marginTop: 8, lineHeight: 1.5 }}>
                  ⚠ Experimental: cost is estimated from built-in pricing table. Result (R) rows include sub-agent costs and per-model token breakdown — use these as more accurate estimates. The real $ column shows exact API billing (costUSD). Verify independently.
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Cache Entry Turn Detail Modal */}
      {cacheEntryModal !== null && (() => {
        const hist = cacheHistoryRef.current
        const entry = hist[cacheEntryModal]
        if (!entry) return null
        // Find message range by turnStartMsgId (precise) or fall back to messageCount-based range
        let startIdx = 0
        let endIdx = allMessages.length
        if (entry.turnStartMsgId) {
          const turnStart = allMessages.findIndex(m => m.id === entry.turnStartMsgId)
          if (turnStart >= 0) {
            startIdx = turnStart
            // End at the next user message (start of next turn)
            for (let k = turnStart + 1; k < allMessages.length; k++) {
              const msg = allMessages[k]
              if (!isToolCall(msg) && msg.role === 'user') { endIdx = k; break }
            }
          }
        } else if (entry.messageCount !== undefined) {
          endIdx = entry.messageCount
          for (let j = cacheEntryModal - 1; j >= 0; j--) {
            if (hist[j].isResult && hist[j].messageCount !== undefined) {
              startIdx = hist[j].messageCount!
              break
            }
          }
        }
        const turnMsgs = allMessages.slice(startIdx, endIdx).filter(m => !('parentToolUseId' in m && m.parentToolUseId))
        const callNum = hist.slice(0, cacheEntryModal + 1).filter(h => !h.isResult).length
        const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
        return (
          <div className="claude-plan-overlay" onClick={() => setCacheEntryModal(null)}>
            <div className="claude-plan-modal claude-subagent-modal" onClick={e => e.stopPropagation()}>
              <div className="claude-plan-modal-header">
                <span className="claude-tool-name" style={{ marginRight: 4 }}>Turn {callNum}</span>
                <span className="claude-tool-badge" style={{ marginRight: 6 }}>{entry.calls} calls</span>
                <span className="claude-plan-modal-title" style={{ fontSize: 12, color: '#999' }}>
                  {entry.pct}% cache · {fmtTokens(entry.totalInput)} input · {fmtTokens(entry.outputTokens || 0)} output
                  {entry.firstTokenMs !== undefined ? ` · TTFT ${(entry.firstTokenMs / 1000).toFixed(2)}s` : ''}
                  {entry.durationMs !== undefined ? ` · turn ${(entry.durationMs / 1000).toFixed(2)}s` : ''}
                </span>
                <span className="claude-subagent-meta">
                  {turnMsgs.length} messages
                  {entry.timestamp ? ` · ${new Date(entry.timestamp).toLocaleTimeString()}` : ''}
                </span>
                <button className="claude-plan-modal-close" onClick={() => setCacheEntryModal(null)}>&times;</button>
              </div>
              <div className="claude-subagent-body">
                <div className="claude-messages claude-timeline">
                  {turnMsgs.length === 0 ? (
                    <div style={{ color: '#666', padding: '16px', textAlign: 'center' }}>
                      No messages captured for this turn (messages may have been archived).
                    </div>
                  ) : turnMsgs.map((item, i) => renderMessage(item, i))}
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Subagent Modal — the agent activity tree's detail view. Shows the whole
          record of one agent run: what it was asked (prompt), what it reported
          back (result) and what it did in between (inner message stream). The
          inner stream is the one part that can go missing (transcript shard
          gone, history reload, remote client), so prompt/result are rendered
          straight off the tool block and the stream area degrades to an
          explicit empty state instead of leaving the modal blank. */}
      {taskModal && (() => {
        const taskMsgs = subagentMessagesRef.current.get(taskModal.taskId) || []
        const streamText = subagentStreamingText.get(taskModal.taskId) || ''
        const streamThink = subagentStreamingThinking.get(taskModal.taskId) || ''
        const taskTool = findTaskToolCall(taskModal.taskId)
        const node = taskModalNode
        const isRunning = node ? node.status === 'running' : taskTool?.status === 'running'
        const subagentType = taskModal.subagentType || node?.subagentType
        const elapsed = node
          ? formatAgentNodeElapsed(node, Date.now())
          : taskTool && taskTool.timestamp > 0 ? formatElapsed(taskTool.timestamp) : ''
        const prompt = taskTool ? String(taskTool.input.prompt || '') : ''
        const promptLines = prompt.split('\n')
        const isLongPrompt = promptLines.length > 3 || prompt.length > 200
        const promptKey = `task-modal-prompt-${taskModal.taskId}`
        const resultKey = `task-modal-result-${taskModal.taskId}`
        const isPromptExpanded = expandedTools.has(promptKey)
        const resultRaw = taskTool?.result ? stringifyToolResult(taskTool.result) : ''
        const { content: resultTextRaw, errors: resultErrors } = splitSystemReminders(resultRaw)
        const resultText = parseContentBlocks(resultTextRaw)
        const hasDetail = Boolean(prompt || resultText || resultErrors.length > 0)
        // Force re-render dependency
        void taskModalTick

        return (
          <div className="claude-plan-overlay" onClick={() => setTaskModal(null)}>
            <div className="claude-plan-modal claude-subagent-modal" onClick={e => e.stopPropagation()}>
              <div className="claude-plan-modal-header">
                {isRunning && <span className="claude-active-task-dot" />}
                <span className="claude-tool-name" style={{ marginRight: 4 }}>Task</span>
                {subagentType && <span className="claude-tool-badge" style={{ marginRight: 6 }}>{subagentType}</span>}
                <span className="claude-plan-modal-title">{taskModal.label}</span>
                <span className="claude-subagent-meta">
                  {t('claude.messages', { count: taskMsgs.length })}
                  {elapsed ? ` · ${elapsed}` : ''}
                </span>
                <button className="claude-plan-modal-close" onClick={() => setTaskModal(null)}>&times;</button>
              </div>
              <div className="claude-subagent-body" ref={el => {
                if (!el) return
                const body = el
                // Auto-scroll to bottom when content updates
                const isNearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80
                if (isNearBottom) {
                  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight })
                }
              }}>
                {hasDetail && (
                  <div className="claude-subagent-detail">
                    {prompt && (
                      <div className="claude-task-prompt">
                        <div className="claude-task-section-header" onClick={() => toggleTool(promptKey)}>
                          <span className="claude-task-section-label">{t('claude.prompt')}</span>
                          <button
                            className={`claude-subagent-section-copy ${copiedId === promptKey ? 'copied' : ''}`}
                            title={t('common.copy')}
                            onClick={(e) => { e.stopPropagation(); handleCopyBlock(prompt, promptKey) }}
                          >{copiedId === promptKey ? '✓' : '⧉'}</button>
                          <span className={`claude-tool-chevron ${isPromptExpanded ? 'expanded' : ''}`}>&#9654;</span>
                        </div>
                        <pre className="claude-task-prompt-text">
                          {isPromptExpanded || !isLongPrompt
                            ? prompt
                            : promptLines.slice(0, 3).join('\n').slice(0, 200) + '...'}
                        </pre>
                      </div>
                    )}
                    {resultErrors.map((err, i) => (
                      <div key={`task-modal-err-${i}`} className="claude-tool-blocks"><div className="claude-tool-row claude-tool-error-row">
                        <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                        <span className="claude-tool-row-content">{err}</span>
                      </div></div>
                    ))}
                    {node?.error && (
                      <div className="claude-tool-blocks"><div className="claude-tool-row claude-tool-error-row">
                        <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                        <span className="claude-tool-row-content">{node.error}</span>
                      </div></div>
                    )}
                    {/* The result is what this view exists for — never collapsed. */}
                    {resultText && (
                      <div className="claude-task-result">
                        <div className="claude-task-section-header">
                          <span className="claude-task-section-label">{t('claude.result')}</span>
                          <button
                            className={`claude-subagent-section-copy ${copiedId === resultKey ? 'copied' : ''}`}
                            title={t('common.copy')}
                            onClick={() => handleCopyBlock(resultText, resultKey)}
                          >{copiedId === resultKey ? '✓' : '⧉'}</button>
                        </div>
                        <div className="claude-task-result-text"><LinkedText text={resultText} /></div>
                      </div>
                    )}
                    <div className="claude-subagent-divider">{t('claude.subagentTranscript')}</div>
                  </div>
                )}
                <div className="claude-messages claude-timeline">
                  {taskMsgs.map((item, i) => renderMessage(item, i))}
                  {!isRunning && taskMsgs.length === 0 && (
                    <div className="claude-subagent-empty">
                      {taskTranscriptLoading === taskModal.taskId
                        ? t('common.loading')
                        : t('claude.subagentNoTranscript')}
                    </div>
                  )}
                  {isRunning && streamThink && (
                    <div className="tl-item">
                      <div className="tl-dot dot-thinking" />
                      <div className="tl-content">
                        <pre className="claude-thinking-block">{streamThink}</pre>
                      </div>
                    </div>
                  )}
                  {isRunning && streamText && (
                    <div className="tl-item">
                      <div className="tl-dot dot-running" />
                      <div className="tl-content">
                        <div className="claude-assistant-text"><LinkedText text={streamText} /></div>
                      </div>
                    </div>
                  )}
                  {isRunning && !streamText && !streamThink && taskMsgs.length === 0 && (
                    <div className="tl-item">
                      <div className="tl-dot dot-thinking" />
                      <div className="tl-content claude-thinking">
                        <span className="claude-thinking-text">{t('claude.thinking')}</span>
                        <span className="claude-thinking-dots"><span>.</span><span>.</span><span>.</span></span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Prompt History Modal */}
      {showPromptHistory && (() => {
        // Answered AskUserQuestion picks steer the turn the same way a typed
        // prompt does, so they are listed here too. Only real user turns carry
        // a rewindIndex: the host's rewindToPrompt counts role==='user'
        // messages, so numbering answers into that sequence would rewind to
        // the wrong turn.
        const entries: { id: string; content: string; timestamp: number; rewindIndex: number | null }[] = []
        let promptIndex = 0
        for (const m of allMessages) {
          if (isToolCall(m)) {
            if (m.toolName !== 'AskUserQuestion' || !m.result) continue
            const content = formatAskUserPrompt(m.input, m.result)
            if (content) entries.push({ id: m.id, content, timestamp: m.timestamp, rewindIndex: null })
            continue
          }
          const msg = m as ClaudeMessage
          if (msg.role !== 'user') continue
          entries.push({ id: msg.id, content: msg.content, timestamp: msg.timestamp, rewindIndex: promptIndex })
          promptIndex += 1
        }
        const userPrompts = entries
        const promptTurns = promptIndex
        return (
          <div className="claude-plan-overlay" onClick={() => setShowPromptHistory(false)}>
            <div className="claude-plan-modal claude-prompt-history-modal" onClick={e => e.stopPropagation()}>
              <div className="claude-plan-modal-header">
                <span className="claude-plan-modal-title">Prompt History ({userPrompts.length})</span>
                <button
                  className="claude-prompt-history-copy"
                  onClick={() => {
                    const text = userPrompts.map((m, i) => `--- Prompt ${i + 1} ---\n${m.content}`).join('\n\n')
                    navigator.clipboard.writeText(text)
                  }}
                  title={t('claude.copyAllPrompts')}
                >copy all</button>
                <button className="claude-plan-modal-close" onClick={() => setShowPromptHistory(false)}>&times;</button>
              </div>
              <div className="claude-prompt-history-list">
                {userPrompts.length === 0 ? (
                  <div className="claude-prompt-history-empty">No prompts yet</div>
                ) : userPrompts.map((m, i) => (
                  <div key={m.id} className="claude-prompt-history-item">
                    <div className="claude-prompt-history-header">
                      <span className="claude-prompt-history-index">#{i + 1}</span>
                      {m.rewindIndex === null && <span className="claude-prompt-history-kind">ask</span>}
                      {m.timestamp > 0 && <span className="claude-prompt-history-time">{formatFullTimestamp(m.timestamp)}</span>}
                      <button
                        className="claude-prompt-history-copy-one"
                        onClick={() => navigator.clipboard.writeText(m.content)}
                        title={t('claude.copyThisPrompt')}
                      >copy</button>
                      {m.rewindIndex !== null && (
                        <button
                          className="claude-prompt-history-rewind-one"
                          onClick={() => handleRewindToPrompt(m.rewindIndex!, promptTurns)}
                          title={`Rewind to before this prompt (removes ${promptTurns - m.rewindIndex} prompt(s) and responses)`}
                          disabled={isStreaming}
                        >↶ rewind</button>
                      )}
                    </div>
                    <pre className="claude-prompt-history-content">{m.content}</pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Status line — always visible, visually attached to input-area when present */}
      {(() => {
        const fmtRemaining = (d: Date) => {
          const ms = d.getTime() - Date.now()
          if (ms <= 0) return '0m'
          const h = Math.floor(ms / 3600000)
          const m = Math.floor((ms % 3600000) / 60000)
          return h > 24 ? `${Math.floor(h / 24)}d${h % 24}h` : h > 0 ? `${h}h${m}m` : `${m}m`
        }

        const renderers: Record<string, () => React.ReactNode | null> = {
          sessionId: () => isCodexSession ? (
            <span
              key="sessionId"
              className="claude-statusline-item"
              title={sessionMeta?.sdkSessionId
                ? `Codex Session: ${sessionMeta.sdkSessionId}\nPanel: ${sessionId}`
                : `Panel: ${sessionId}`}
            >
              {sessionMeta?.sdkSessionId ? sessionMeta.sdkSessionId.slice(0, 8) : sessionId.slice(0, 8)}
            </span>
          ) : (
            <span key="sessionId" className="claude-statusline-item claude-statusline-clickable"
              onClick={() => {
                setShowResumeList(true)
              }}
              title={sessionMeta?.sdkSessionId
                ? `SDK Session: ${sessionMeta.sdkSessionId}\nPanel: ${sessionId}\nClick to resume`
                : `Panel: ${sessionId}\nClick to resume`}
            >
              {sessionMeta?.sdkSessionId ? sessionMeta.sdkSessionId.slice(0, 8) : sessionId.slice(0, 8)}
            </span>
          ),
          gitBranch: () => !gitBranch ? null : (
            <span key="gitBranch" className="claude-statusline-item">[{gitBranch}]</span>
          ),
          model: () => {
            const model = sessionMeta?.model || currentModel
            if (!model) return null
            return (
              <span key="model" className="claude-statusline-item" title={`model: ${model}`}>
                {displayNameForClaudeSelection(model)}
              </span>
            )
          },
          effort: () => {
            const effort = sessionMeta?.effort || effortLevel
            if (!effort) return null
            return <span key="effort" className="claude-statusline-item" title={`effort: ${effort}`}>{effort}</span>
          },
          sandbox: () => null,
          approval: () => null,
          tokens: () => !sessionMeta ? null : (
            <span key="tokens" className="claude-statusline-item claude-statusline-clickable" title={`context: ${(sessionMeta.contextTokens || 0).toLocaleString()} tok\nlast request in: ${sessionMeta.inputTokens.toLocaleString()} / out: ${sessionMeta.outputTokens.toLocaleString()}\nsession total in: ${(sessionMeta.totalInputTokens ?? 0).toLocaleString()} / out: ${(sessionMeta.totalOutputTokens ?? 0).toLocaleString()}\nclick to show context breakdown`}
              onClick={() => { host.claude.getContextUsage(sessionId).then(u => { if (u) setContextUsagePopup(u) }).catch(() => {}) }}>
              {(sessionMeta.contextTokens || (sessionMeta.inputTokens + sessionMeta.outputTokens)).toLocaleString()} tok
            </span>
          ),
          turns: () => !sessionMeta || sessionMeta.numTurns <= 0 ? null : (
            <span key="turns" className="claude-statusline-item">{sessionMeta.numTurns} turns</span>
          ),
          duration: () => !sessionMeta || sessionMeta.durationMs <= 0 ? null : (
            <span key="duration" className="claude-statusline-item">{(sessionMeta.durationMs / 1000).toFixed(1)}s</span>
          ),
          contextPct: () => {
            if (!sessionMeta || sessionMeta.contextWindow <= 0) return null
            const ctxTokens = sessionMeta.contextTokens || (sessionMeta.inputTokens + sessionMeta.outputTokens)
            const compactWindow = sessionMeta.autoCompactWindow && sessionMeta.autoCompactWindow > 0
              ? Math.min(sessionMeta.autoCompactWindow, sessionMeta.contextWindow)
              : undefined
            const effectiveWindow = compactWindow || sessionMeta.contextWindow
            const pct = Math.round((ctxTokens / effectiveWindow) * 100)
            const ctxColor = pct >= 80 ? '#e05252' : pct >= 50 ? '#e6a700' : '#89ca78'
            const denominatorLabel = compactWindow
              ? `auto-compact threshold: ${compactWindow.toLocaleString()} tokens\nmodel context window: ${sessionMeta.contextWindow.toLocaleString()} tokens\npercentage uses the auto-compact threshold`
              : `model context window: ${sessionMeta.contextWindow.toLocaleString()} tokens`
            return (
              <span key="contextPct" className="claude-statusline-item claude-statusline-clickable" style={{ color: ctxColor }} title={`context: ${ctxTokens.toLocaleString()} / ${effectiveWindow.toLocaleString()} tokens\n${denominatorLabel}\nsession total: ${((sessionMeta.totalInputTokens ?? 0) + (sessionMeta.totalOutputTokens ?? 0)).toLocaleString()} tok\nclick to show context breakdown`}
                onClick={() => { host.claude.getContextUsage(sessionId).then(u => { if (u) setContextUsagePopup(u) }).catch(() => {}) }}>
                ctx {pct}%
              </span>
            )
          },
          cost: () => !sessionMeta || sessionMeta.totalCost <= 0 ? null : (
            <span key="cost" className="claude-statusline-item">${sessionMeta.totalCost.toFixed(4)}</span>
          ),
          workspace: () => {
            const ws = workspaceId ? workspaceStore.getState().workspaces.find(w => w.id === workspaceId) : null
            return ws ? <span key="workspace" className="claude-statusline-item">{ws.alias || ws.name}</span> : null
          },
          usage5h: () => {
            const rl = rateLimits['five_hour']
            if (!rl || rl.utilization == null) return null
            const pct = Math.round(rl.utilization * 100)
            const color = pct >= 80 ? '#e05252' : pct >= 50 ? '#e6a700' : '#89ca78'
            return <span key="usage5h" className="claude-statusline-item" style={{ color }} title={`5h usage: ${pct}%`}>5h:{pct}%</span>
          },
          usage5hReset: () => {
            const rl = rateLimits['five_hour']
            if (!rl) return null
            const resetLabel = new Date(rl.resetsAt).toLocaleString(i18n.language, {
              weekday: 'long', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
            })
            return <span key="usage5hReset" className="claude-statusline-item" title={`5h reset: ${resetLabel}`}>↻{fmtRemaining(new Date(rl.resetsAt))}</span>
          },
          usage7d: () => {
            const rl = rateLimits['seven_day']
            if (!rl || rl.utilization == null) return null
            const pct = Math.round(rl.utilization * 100)
            const color = pct >= 80 ? '#e05252' : pct >= 50 ? '#e6a700' : '#89ca78'
            return <span key="usage7d" className="claude-statusline-item" style={{ color }} title={`7d usage: ${pct}%`}>7d:{pct}%</span>
          },
          usage7dReset: () => {
            const rl = rateLimits['seven_day']
            if (!rl) return null
            const resetLabel = new Date(rl.resetsAt).toLocaleString(i18n.language, {
              weekday: 'long', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
            })
            return <span key="usage7dReset" className="claude-statusline-item" title={`7d reset: ${resetLabel}`}>↻{fmtRemaining(new Date(rl.resetsAt))}</span>
          },
          maxOut: () => !sessionMeta || !sessionMeta.maxOutputTokens ? null : (
            <span key="maxOut" className="claude-statusline-item" title={`Max output: ${sessionMeta.maxOutputTokens.toLocaleString()} tokens`}>
              maxOut:{(sessionMeta.maxOutputTokens / 1000).toFixed(0)}k
            </span>
          ),
          cacheEff: () => {
            if (!sessionMeta) return null
            const cacheRead = sessionMeta.cacheReadTokens || 0
            const totalInput = (sessionMeta.inputTokens || 0) + cacheRead + (sessionMeta.cacheCreationTokens || 0)
            if (totalInput <= 0) return null
            const currentPct = Math.round((cacheRead / totalInput) * 100)
            // Color is determined by the lowest reading >= 50k in last 20
            const hist = cacheHistoryRef.current
            const significant = hist.filter(h => h.totalInput >= 50000)
            const lowest = significant.length > 0
              ? significant.reduce((min, h) => h.pct < min.pct ? h : min, significant[0])
              : null
            const colorPct = lowest ? lowest.pct : currentPct
            const color = colorPct >= 70 ? '#89ca78' : colorPct >= 40 ? '#e6a700' : '#e05252'
            const belowCount = significant.filter(h => h.pct < 50).length
            const lowestTip = lowest ? `\nlowest: ${lowest.pct}% (read:${lowest.cacheRead.toLocaleString()} write:${lowest.cacheCreate.toLocaleString()})` : ''
            const belowTip = significant.length > 0 ? `\n<50%: ${belowCount}/${significant.length}` : ''
            return (
              <span key="cacheEff" className="claude-statusline-item claude-statusline-clickable" style={{ color }}
                title={`current: ${currentPct}% (read:${cacheRead.toLocaleString()} write:${(sessionMeta.cacheCreationTokens || 0).toLocaleString()})${lowestTip}${belowTip}\nclick for history`}
                onClick={() => setShowCacheHistory(true)}>
                cache:{currentPct}%
              </span>
            )
          },
          prompts: () => (
            <span key="prompts" className="claude-statusline-item claude-statusline-clickable"
              onClick={() => setShowPromptHistory(true)} title={t('claude.viewPromptHistory')}>{t('claude.prompts')}</span>
          ),
        }

        const renderZone = (align: 'left' | 'center' | 'right') => {
          const items = statuslineConfig.filter(c => c.visible && (c.align || 'left') === align)
          const nodes: React.ReactNode[] = []
          for (const item of items) {
            let node = renderers[item.id]?.()
            if (!node) continue
            // Apply color directly on the element via cloneElement to override class-based colors
            if (item.color && isValidElement(node)) {
              node = cloneElement(node, { style: { ...(node.props.style || {}), color: item.color } })
            }
            nodes.push(node)
            if (item.separatorAfter) nodes.push(<span key={`sep-${item.id}`} className="claude-statusline-sep">&middot;</span>)
          }
          return nodes
        }

        const hasCenter = statuslineConfig.some(c => c.visible && c.align === 'center')
        const hasRight = statuslineConfig.some(c => c.visible && c.align === 'right')

        return (
          <div className={`claude-statusline-bar${!pendingPermission && !pendingQuestion && !showResumeList && !showModelList ? ' attached' : ''}`}>
            <div className="claude-statusline">
              <div className="claude-statusline-left">{renderZone('left')}</div>
              {hasCenter && <div className="claude-statusline-center">{renderZone('center')}</div>}
              {hasRight && <div className="claude-statusline-right">{renderZone('right')}</div>}
            </div>
          </div>
        )
      })()}
      {contextMenu && (
        <div
          className="claude-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="claude-context-menu-item"
            onClick={() => { setContextMenu(null); forceScrollToBottom() }}
          >
            {t('claude.scrollToBottom')}
          </button>
        </div>
      )}
    </div>
  )
})
