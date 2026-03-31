import { useState, useEffect, useRef, useCallback, useMemo, Fragment, cloneElement, isValidElement } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ClaudeMessage, ClaudeToolCall } from '../types/claude-agent'
import { isToolCall } from '../types/claude-agent'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import type { AgentPresetId } from '../types/agent-presets'
import { LinkedText, FilePreviewModal } from './PathLinker'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Markdown rendering for completed assistant messages
// Note: marked.use() modifies the global marked instance (shared with FileTree).
// Both use the same settings (gfm, breaks, highlight.js, link interception),
// so sharing is intentional and avoids configuration drift.
function renderChatMarkdown(text: string): string {
  // Pre-process: convert bare file:// URLs to markdown links so marked renders them as <a>
  // marked only auto-links http/https by default
  // Skip URLs inside code blocks/inline code and existing markdown links
  const processed = text.replace(
    /(`{1,3}[\s\S]*?`{1,3})|(file:\/\/\/[^\s<>)\]`'"]+)/g,
    (match, codeBlock, fileUrl, offset, str) => {
      if (codeBlock) return match  // preserve code blocks as-is
      if (!fileUrl) return match
      const before = str.slice(Math.max(0, offset - 2), offset)
      if (before === '](' || before.endsWith('(')) return match
      return `[${fileUrl}](${fileUrl})`
    }
  )
  const rawHtml = marked.parse(processed) as string
  // Remove whitespace between block-level HTML tags to prevent anonymous line boxes
  const cleanHtml = rawHtml.replace(/>\s+</g, '><')
  return DOMPurify.sanitize(cleanHtml, {
    ADD_TAGS: ['input'],
    ADD_ATTR: ['checked', 'disabled', 'type', 'data-external-link'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|file):/i,
  })
}

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
  maxOutputTokens: number
  contextTokens: number
  permissionMode?: string
}

interface ModelInfo {
  value: string
  displayName: string
  description: string
  source?: 'builtin' | 'sdk'
}

interface PendingPermission {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  decisionReason?: string
}

interface SlashCommandInfo {
  name: string
  description: string
  argumentHint: string
}

interface AskUserQuestion {
  question: string
  header: string
  options: Array<{ label: string; description: string; markdown?: string }>
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

interface ClaudeAgentPanelProps {
  sessionId: string
  cwd: string
  isActive: boolean
  workspaceId?: string
  showUserMsg?: boolean
  showAssistantMsg?: boolean
  showToolMsg?: boolean
  showThinkingMsg?: boolean
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

// Track sessions that have been started to prevent duplicate calls across StrictMode remounts
const startedSessions = new Set<string>()

export function ClaudeAgentPanel({ sessionId, cwd, isActive, workspaceId, showUserMsg = true, showAssistantMsg = true, showToolMsg = true, showThinkingMsg = true }: Readonly<ClaudeAgentPanelProps>) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<MessageItem[]>([])
  const inputValueRef = useRef('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isInterrupted, setIsInterrupted] = useState(false)
  const lastEscRef = useRef(0)
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
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
  const [permissionMode, setPermissionMode] = useState<string>('bypassPermissions')
  const [currentModel, setCurrentModel] = useState<string>('')
  const [effortLevel, setEffortLevel] = useState<string>('medium')
  const [claudeUsage, setClaudeUsage] = useState(workspaceStore.claudeUsage)
  const [usageAccount, setUsageAccount] = useState(workspaceStore.usageAccount)
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [planFileContent, setPlanFileContent] = useState<string | null>(null)
  const [permissionFocus, setPermissionFocus] = useState(0) // 0=Yes, 1=Yes always, 2=No, 3=custom text
  const [permissionCustomText, setPermissionCustomText] = useState('')
  const [pendingQuestion, setPendingQuestion] = useState<PendingAskUser | null>(null)
  const [askAnswers, setAskAnswers] = useState<Record<string, string>>({})
  const [askOtherText, setAskOtherText] = useState<Record<string, string>>({})
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [showResumeList, setShowResumeList] = useState(false)
  const [resumeSessions, setResumeSessions] = useState<SessionSummary[]>([])
  const [resumeLoading, setResumeLoading] = useState(false)
  const [showModelList, setShowModelList] = useState(false)
  const [contentModal, setContentModal] = useState<{ title: string; content: string } | null>(null)
  // Subagent message storage (keyed by parent Task tool_use_id)
  const subagentMessagesRef = useRef<Map<string, MessageItem[]>>(new Map())
  const [subagentStreamingText, setSubagentStreamingText] = useState<Map<string, string>>(new Map())
  const [subagentStreamingThinking, setSubagentStreamingThinking] = useState<Map<string, string>>(new Map())
  const [taskModal, setTaskModal] = useState<{ taskId: string; label: string; subagentType?: string } | null>(null)
  const [taskModalTick, setTaskModalTick] = useState(0)
  const [showPromptHistory, setShowPromptHistory] = useState(false)
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null)
  const [statuslineConfig, setStatuslineConfig] = useState(settingsStore.getStatuslineItems())
  const [accountInfo, setAccountInfo] = useState<{ email?: string; organization?: string; subscriptionType?: string } | null>(null)
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([])
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const showSlashMenuRef = useRef(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  // Ctrl+P file picker
  const [showFilePicker, setShowFilePicker] = useState(false)
  const [filePickerQuery, setFilePickerQuery] = useState('')
  const [filePickerResults, setFilePickerResults] = useState<{ name: string; path: string; isDirectory: boolean }[]>([])
  const [filePickerIndex, setFilePickerIndex] = useState(0)
  const [filePickerPreview, setFilePickerPreview] = useState<string | null>(null)
  const filePickerInputRef = useRef<HTMLInputElement>(null)
  // Message archiving — keep renderer memory bounded
  const [loadedArchive, setLoadedArchive] = useState<MessageItem[]>([])
  const [hasMoreArchived, setHasMoreArchived] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const archivedCountRef = useRef(0)
  const loadedFromArchiveRef = useRef(0)
  const archivingRef = useRef(false)
  const VISIBLE_LIMIT = 200
  const ARCHIVE_TRIGGER = 300 // archive when exceeding this
  const LOAD_BATCH = 50
  const historyLoadedRef = useRef(false)
  const sessionStartedRef = useRef(false)
  const inputHistoryRef = useRef<string[]>([])
  const inputHistoryIndexRef = useRef(-1)
  const inputDraftRef = useRef('')
  const pendingPromptSentRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamingThinkingRef = useRef<HTMLPreElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const permissionCardRef = useRef<HTMLDivElement>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const isNearBottomRef = useRef(true)
  const [aboveViewportUserMsgIds, setAboveViewportUserMsgIds] = useState<Set<string>>(new Set())
  const [claudeFontSize, setClaudeFontSize] = useState(settingsStore.getSettings().fontSize)
  const userMsgRefsMap = useRef<Map<string, HTMLDivElement>>(new Map())
  const observerRef = useRef<IntersectionObserver | null>(null)

  // Check if scrolled near bottom (within 80px)
  const checkIfNearBottom = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // Auto-scroll to bottom — use instant scroll to avoid layout thrashing with rapid updates
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior })
    setUserScrolledUp(false)
    isNearBottomRef.current = true
  }, [])

  // Handle user scroll events on messages container
  const handleMessagesScroll = useCallback(() => {
    const nearBottom = checkIfNearBottom()
    isNearBottomRef.current = nearBottom
    setUserScrolledUp(!nearBottom)
  }, [checkIfNearBottom])

  // Only auto-scroll if user hasn't scrolled up
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior })
    }
  }, [messages, streamingText, streamingThinking])

  // Auto-scroll streaming thinking <pre> to bottom so latest content is visible
  useEffect(() => {
    const el = streamingThinkingRef.current
    if (el && showThinking) {
      el.scrollTop = el.scrollHeight
    }
  }, [streamingThinking, showThinking])

  // Combine archived + live messages for rendering and scanning
  const allMessages = useMemo(() => [...loadedArchive, ...messages], [loadedArchive, messages])

  // Active tasks (running Task/Agent tool calls) for the indicator bar
  const activeTasks = useMemo(() => {
    const tasks = allMessages.filter(m => isToolCall(m) && (m.toolName === 'Task' || m.toolName === 'Agent') && m.status === 'running') as ClaudeToolCall[]
    const allTaskTools = allMessages.filter(m => isToolCall(m) && (m.toolName === 'Task' || m.toolName === 'Agent')) as ClaudeToolCall[]
    if (allTaskTools.length > 0) {
      window.electronAPI.debug.log(`[renderer] activeTasks: ${tasks.length} running / ${allTaskTools.length} total Task/Agent tools (statuses: ${allTaskTools.map(t => `${t.id?.slice(0,8)}=${t.status}`).join(', ')})`)
    }
    return tasks
  }, [allMessages])

  // Tick counter to force re-render for elapsed time display
  const [, setElapsedTick] = useState(0)
  useEffect(() => {
    if (activeTasks.length === 0) return
    const interval = setInterval(() => setElapsedTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [activeTasks.length])

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

  // Archive excess messages to disk when threshold is exceeded
  useEffect(() => {
    if (archivingRef.current || messages.length <= ARCHIVE_TRIGGER) return
    archivingRef.current = true
    const excess = messages.length - VISIBLE_LIMIT
    const toArchive = messages.slice(0, excess)
    window.electronAPI.claude.archiveMessages(sessionId, toArchive).then(() => {
      archivedCountRef.current += excess
      setHasMoreArchived(true)
      setMessages(prev => prev.slice(excess))
      archivingRef.current = false
    }).catch(() => { archivingRef.current = false })
  }, [messages.length, sessionId])

  // Load more archived messages when scrolling to top
  const loadMoreArchived = useCallback(async () => {
    if (isLoadingMore || !hasMoreArchived) return
    setIsLoadingMore(true)
    const container = messagesContainerRef.current
    const prevScrollHeight = container?.scrollHeight ?? 0
    try {
      const result = await window.electronAPI.claude.loadArchived(sessionId, loadedFromArchiveRef.current, LOAD_BATCH)
      if (result.messages.length > 0) {
        loadedFromArchiveRef.current += result.messages.length
        setLoadedArchive(prev => [...(result.messages as MessageItem[]), ...prev])
        setHasMoreArchived(result.hasMore)
        // Preserve scroll position after prepending
        requestAnimationFrame(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight
            container.scrollTop += newScrollHeight - prevScrollHeight
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
    const api = window.electronAPI.claude
    const tag = `[Claude:${sessionId.slice(0, 8)}]`
    window.electronAPI?.debug?.log(`${tag} subscribing to IPC events`)

    const unsubs = [
      api.onMessage((sid: string, msg: unknown) => {
        if (sid !== sessionId) {
          console.log(`${tag} SKIP onMessage sid=${sid.slice(0, 8)} (mine=${sessionId.slice(0, 8)})`)
          return
        }
        console.log(`${tag} onMessage`, (msg as ClaudeMessage).id)
        workspaceStore.updateTerminalActivity(sessionId)
        const message = msg as ClaudeMessage
        // On restart, sys-init message arrives again — reset messages
        // But skip reset if history will be loaded (resume flow)
        if (message.id === `sys-init-${sessionId}`) {
          window.electronAPI?.debug?.log(`${tag} sys-init historyLoaded=${historyLoadedRef.current}`)
          if (!historyLoadedRef.current) {
            setMessages([message])
            // Clear archive on fresh session start
            setLoadedArchive([])
            archivedCountRef.current = 0
            loadedFromArchiveRef.current = 0
            setHasMoreArchived(false)
            window.electronAPI.claude.clearArchive(sessionId).catch(() => {})
          }
          setStreamingText('')
          setStreamingThinking('')
          setIsStreaming(false)
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
        setStreamingThinking(prevThinking => {
          const finalMsg = (!message.thinking && prevThinking && message.role === 'assistant')
            ? { ...message, thinking: prevThinking }
            : message
          setMessages(prev => {
            if (prev.some(m => m.id === finalMsg.id)) return prev
            // Dedup user messages: if a local user message with same content exists within 5s, skip
            if (finalMsg.role === 'user' && prev.some(m =>
              !isToolCall(m) && (m as ClaudeMessage).role === 'user' &&
              (m as ClaudeMessage).content === finalMsg.content &&
              Math.abs((m as ClaudeMessage).timestamp - finalMsg.timestamp) < 5000
            )) return prev
            return [...prev, finalMsg]
          })
          return ''
        })
        setStreamingText('')
      }),

      api.onToolUse((sid: string, tool: unknown) => {
        if (sid !== sessionId) return
        workspaceStore.updateTerminalActivity(sessionId)
        const toolCall = tool as ClaudeToolCall
        window.electronAPI.debug.log(`[renderer] onToolUse name=${toolCall.toolName} id=${toolCall.id?.slice(0, 12)} status=${toolCall.status} parentToolUseId=${toolCall.parentToolUseId || 'none'}`)
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
        workspaceStore.updateTerminalActivity(sessionId)
        const { id, ...updates } = result as { id: string; status: string; result?: string; description?: string }
        if ((updates as { description?: string }).description) {
          window.electronAPI.debug.log(`[renderer] onToolResult description update id=${id} desc=${(updates as { description?: string }).description}`)
        }
        // Check if tool exists in any subagent bucket
        let foundInSubagent = false
        for (const [parentId, bucket] of subagentMessagesRef.current.entries()) {
          const idx = bucket.findIndex(m => 'toolName' in m && m.id === id)
          if (idx !== -1) {
            bucket[idx] = { ...bucket[idx], ...updates } as ClaudeToolCall
            foundInSubagent = true
            if (taskModal?.taskId === parentId) setTaskModalTick(t => t + 1)
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
            return { ...m, ...updates } as ClaudeToolCall
          }
          return m
        }))
        if (isAgentStatusChange) { flushSync(doResultUpdate) } else { doResultUpdate() }
      }),

      api.onResult((sid: string, resultData: unknown) => {
        if (sid !== sessionId) return
        setIsStreaming(false)
        setIsInterrupted(false)
        setStreamingText('')
        setStreamingThinking('')
        // Refresh usage after agent activity (usage likely changed)
        workspaceStore.refreshUsageNow()
        // Show result text only for slash commands that don't produce assistant messages
        const rd = resultData as { result?: string; subtype?: string } | undefined
        if (rd?.result && rd.subtype === 'success') {
          setMessages(prev => {
            // Skip if any assistant message contains the result text (already shown via onMessage)
            const resultText = rd.result!
            const alreadyShown = prev.some(m =>
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
      }),

      api.onStream((sid: string, data: unknown) => {
        if (sid !== sessionId) return
        workspaceStore.updateTerminalActivity(sessionId)
        const d = data as { text?: string; thinking?: string; parentToolUseId?: string }
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
          if (d.text) setStreamingText(prev => prev + d.text)
          if (d.thinking) setStreamingThinking(prev => prev + d.thinking)
        }
      }),

      api.onStatus((sid: string, meta: unknown) => {
        const dlog = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)
        if (sid !== sessionId) {
          dlog(`${tag} SKIP onStatus sid=${sid.slice(0, 8)} (mine=${sessionId.slice(0, 8)})`)
          return
        }
        dlog(`${tag} onStatus sdkSessionId=${((meta as SessionMeta).sdkSessionId || '').slice(0, 8)}`)
        const m = meta as SessionMeta
        setSessionMeta(m)
        if (m.model) setCurrentModel(prev => prev || m.model!)
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
        setPendingQuestion(data as PendingAskUser)
        setAskAnswers({})
        setAskOtherText({})
      }),

      api.onAskUserResolved((sid: string, _toolUseId: string) => {
        if (sid !== sessionId) return
        setPendingQuestion(null)
        setAskAnswers({})
        setAskOtherText({})
      }),

      api.onPermissionResolved((sid: string, _toolUseId: string) => {
        if (sid !== sessionId) return
        setPendingPermission(null)
      }),

      api.onSessionReset((sid: string) => {
        if (sid !== sessionId) return
        setMessages([])
        setStreamingText('')
        setStreamingThinking('')
        setPendingPermission(null)
        setPendingQuestion(null)
        setAskAnswers({})
        setAskOtherText({})
        setSessionMeta(null)
        setHasSdkSession(false)
        workspaceStore.setTerminalSdkSessionId(sessionId, undefined)
      }),

      api.onHistory((sid: string, items: unknown[]) => {
        if (sid !== sessionId) {
          console.log(`${tag} SKIP onHistory sid=${sid.slice(0, 8)} items=${(items as unknown[]).length} (mine=${sessionId.slice(0, 8)})`)
          return
        }
        const dlog2 = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)
        dlog2(`${tag} onHistory items=${(items as unknown[]).length} pendingPromptSent=${pendingPromptSentRef.current}`)
        historyLoadedRef.current = true
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
        const historyItems = mainItems
        setLoadedArchive([])
        archivedCountRef.current = 0
        loadedFromArchiveRef.current = 0
        setHasMoreArchived(false)
        window.electronAPI.claude.clearArchive(sessionId).catch(() => {})
        setStreamingText('')
        setStreamingThinking('')

        // Auto-send pending prompt from fork AFTER history is loaded
        const t = workspaceStore.getState().terminals.find(t => t.id === sessionId)
        if (!pendingPromptSentRef.current && (t?.pendingPrompt || t?.pendingImages?.length)) {
          pendingPromptSentRef.current = true
          const prompt = t.pendingPrompt || ''
          const images = t.pendingImages
          workspaceStore.setTerminalPendingPrompt(sessionId, '')
          window.electronAPI?.debug?.log(`${tag} onHistory AUTO-SENDING pending prompt: "${prompt}" images=${images?.length ?? 0}`)
          // Set history + user message together so it doesn't get overwritten
          setMessages([...historyItems, {
            id: `user-fork-${Date.now()}`,
            sessionId,
            role: 'user' as const,
            content: prompt,
            timestamp: Date.now(),
          }])
          setIsStreaming(true)
          window.electronAPI.claude.sendMessage(sessionId, prompt, images)
        } else {
          dlog2(`${tag} onHistory setting messages (history only, no pending prompt)`)
          setMessages(historyItems)
        }
      }),

      api.onModeChange((sid: string, mode: string) => {
        if (sid !== sessionId) return
        setPermissionMode(mode)
      }),

      api.onPromptSuggestion((sid: string, suggestion: string) => {
        if (sid !== sessionId) return
        setPromptSuggestion(suggestion)
      }),
    ]

    return () => {
      console.log(`${tag} unsubscribing IPC events`)
      unsubs.forEach(unsub => unsub())
    }
  }, [sessionId])

  // Start session on mount (guarded against StrictMode double-mount)
  // If a saved sdkSessionId exists (from a previous /resume), auto-resume that session
  useEffect(() => {
    const stag = `[Claude:${sessionId.slice(0, 8)}]`
    const dlog = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)
    dlog(`${stag} mount effect: startedRef=${sessionStartedRef.current} inSet=${startedSessions.has(sessionId)}`)
    if (!sessionStartedRef.current && !startedSessions.has(sessionId)) {
      sessionStartedRef.current = true
      startedSessions.add(sessionId)

      const terminal = workspaceStore.getState().terminals.find(t => t.id === sessionId)
      const savedSdkSessionId = terminal?.sdkSessionId
      const savedModel = terminal?.model
      const globalSettings = settingsStore.getSettings()
      dlog(`${stag} sdkSessionId=${savedSdkSessionId?.slice(0, 8)} pendingPrompt="${terminal?.pendingPrompt || ''}"`)

      // Restore saved model to UI, or use global default
      const effectiveModel = savedModel || globalSettings.defaultModel
      if (effectiveModel) setCurrentModel(effectiveModel)

      // Use global default effort
      const effectiveEffort = globalSettings.defaultEffort || 'medium'
      setEffortLevel(effectiveEffort)

      if (savedSdkSessionId) {
        dlog(`${stag} AUTO-RESUME sdkSessionId=${savedSdkSessionId.slice(0, 8)}`)
        historyLoadedRef.current = true
        window.electronAPI.claude.resumeSession(sessionId, savedSdkSessionId, cwd, savedModel)
      } else {
        dlog(`${stag} FRESH startSession`)
        window.electronAPI.claude.startSession(sessionId, { cwd, permissionMode, model: effectiveModel, effort: effectiveEffort as 'low' | 'medium' | 'high' | 'max' })
      }
    }
    return () => {
      // Don't remove from startedSessions on unmount — StrictMode will remount
    }
  }, [sessionId, cwd])

  // Refresh session metadata when panel becomes active (fixes stale display after window switch)
  useEffect(() => {
    if (isActive) {
      window.electronAPI.claude.getSessionMeta(sessionId).then(meta => {
        if (meta) {
          setSessionMeta(meta as SessionMeta)
          if ((meta as SessionMeta).model) setCurrentModel(prev => prev || (meta as SessionMeta).model!)
        }
      }).catch(() => {})
    }
  }, [isActive, sessionId])

  // Fetch supported models on demand when model list is opened (no session required)
  useEffect(() => {
    if (showModelList && availableModels.length === 0) {
      window.electronAPI.claude.getSupportedModels(sessionId).then((models: ModelInfo[]) => {
        if (models && models.length > 0) setAvailableModels(models)
      }).catch(() => {})
    }
  }, [showModelList])  // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch account info and slash commands once session metadata arrives
  useEffect(() => {
    if (sessionMeta?.sdkSessionId && availableModels.length === 0) {
      window.electronAPI.claude.getSupportedModels(sessionId).then((models: ModelInfo[]) => {
        if (models && models.length > 0) {
          setAvailableModels(models)
        }
      }).catch(() => {})
      window.electronAPI.claude.getAccountInfo(sessionId).then(info => {
        if (info) setAccountInfo(info)
      }).catch(() => {})
      window.electronAPI.claude.getSupportedCommands(sessionId).then((cmds: SlashCommandInfo[]) => {
        if (cmds && cmds.length > 0) {
          setSlashCommands(cmds)
          // Broadcast for SkillsPanel (in case it mounted before commands were fetched)
          window.dispatchEvent(new CustomEvent('claude-skills-updated', { detail: { sessionId, commands: cmds } }))
        }
      }).catch(() => {})
      window.electronAPI.claude.getSupportedAgents(sessionId).then((agentList) => {
        if (agentList && agentList.length > 0) {
          // Broadcast for AgentsPanel (in case it mounted before agents were fetched)
          window.dispatchEvent(new CustomEvent('claude-agents-updated', { detail: { sessionId, agents: agentList } }))
        }
      }).catch(() => {})
    }
  }, [sessionId, sessionMeta?.sdkSessionId, availableModels.length])

  // Fetch git branch on mount and when cwd changes
  useEffect(() => {
    window.electronAPI.git.getBranch(cwd).then(branch => setGitBranch(branch)).catch(() => setGitBranch(null))
  }, [cwd])

  // Subscribe to settings changes (font size, statusline config)
  useEffect(() => {
    return settingsStore.subscribe(() => {
      setClaudeFontSize(settingsStore.getSettings().fontSize)
      setStatuslineConfig(settingsStore.getStatuslineItems())
    })
  }, [])

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
    if (!showFilePicker) return
    if (!filePickerQuery.trim()) {
      setFilePickerResults([])
      setFilePickerIndex(0)
      return
    }
    const timer = setTimeout(() => {
      window.electronAPI.fs.search(cwd, filePickerQuery.trim()).then((results: { name: string; path: string; isDirectory: boolean }[]) => {
        setFilePickerResults(results || [])
        setFilePickerIndex(0)
      }).catch(() => {
        setFilePickerResults([])
      })
    }, 150)
    return () => clearTimeout(timer)
  }, [filePickerQuery, showFilePicker, cwd])

  // Focus textarea when active
  useEffect(() => {
    if (isActive) {
      textareaRef.current?.focus()
    }
  }, [isActive])

  const handleModelSelect = useCallback(async (modelValue: string) => {
    setShowModelList(false)
    setCurrentModel(modelValue)
    await window.electronAPI.claude.setModel(sessionId, modelValue)
    workspaceStore.updateTerminalModel(sessionId, modelValue)
  }, [sessionId])

  const handleResumeSelect = useCallback(async (sdkSessionId: string) => {
    console.log(`[Claude:${sessionId.slice(0, 8)}] handleResumeSelect sdkSessionId=${sdkSessionId.slice(0, 8)}`)
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
    startedSessions.delete(sessionId)
    sessionStartedRef.current = false
    // Mark that history will be loaded — prevents sys-init from wiping messages
    historyLoadedRef.current = true
    await window.electronAPI.claude.resumeSession(sessionId, sdkSessionId, cwd)
    workspaceStore.setTerminalSdkSessionId(sessionId, sdkSessionId)
  }, [sessionId, cwd])

  const handleForkSession = useCallback(async () => {
    const dlog = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)
    const tag = `[Fork:${sessionId.slice(0, 8)}]`
    dlog(`${tag} start hasSdkSession=${hasSdkSession} workspaceId=${workspaceId}`)
    if (!hasSdkSession || !workspaceId) return
    let result: { newSdkSessionId: string } | null = null
    try {
      result = await window.electronAPI.claude.forkSession(sessionId)
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

  // Listen for skill insertion from SkillsPanel
  useEffect(() => {
    const handler = (e: Event) => {
      if (!isActive) return
      const { name } = (e as CustomEvent).detail as { name: string }
      setInputValue('/' + name + ' ')
      textareaRef.current?.focus()
    }
    window.addEventListener('claude-insert-command', handler)
    return () => window.removeEventListener('claude-insert-command', handler)
  }, [isActive, setInputValue])

  const handleSend = useCallback(async () => {
    const trimmed = inputValueRef.current.trim()
    if (!trimmed && attachedImages.length === 0 && attachedFiles.length === 0) return

    // Save to input history
    if (trimmed) {
      inputHistoryRef.current.push(trimmed)
    }
    inputHistoryIndexRef.current = -1
    inputDraftRef.current = ''

    // Intercept /resume command (only when not streaming)
    if (!isStreaming && trimmed === '/resume') {
      clearInput()
      setResumeLoading(true)
      setShowResumeList(true)
      try {
        const sessions = await window.electronAPI.claude.listSessions(cwd)
        setResumeSessions(sessions || [])
      } catch {
        setResumeSessions([])
      } finally {
        setResumeLoading(false)
      }
      return
    }

    // Intercept /model command
    if (trimmed === '/model') {
      clearInput()
      setShowModelList(true)
      return
    }

    // Intercept /new or /clear command — reset session (clear conversation, fresh start)
    if (!isStreaming && (trimmed === '/new' || trimmed === '/clear')) {
      clearInput()
      setMessages([])
      setStreamingText('')
      setStreamingThinking('')
      await window.electronAPI.claude.resetSession(sessionId)
      return
    }

    // Intercept /snippet command — inject snippet context into Claude session
    if (trimmed === '/snippet' || trimmed.startsWith('/snippet ')) {
      const query = trimmed.slice('/snippet'.length).trim()
      clearInput()
      try {
        const snippets = query
          ? await window.electronAPI.snippet.search(query)
          : await window.electronAPI.snippet.getByWorkspace(workspaceId)
        const snippetsJsonPath = '~/Library/Application Support/better-agent-terminal/snippets.json'
        const snippetList = snippets.length === 0
          ? 'No snippets exist yet.'
          : snippets.map((s: { id: number; title: string; workspaceId?: string }) => `- [${s.id}] ${s.title}${s.workspaceId ? ' (workspace)' : ''}`).join('\n')
        const contextPrompt = [
          `[BAT Snippets Context]`,
          `Snippets file: ${snippetsJsonPath}`,
          `JSON structure: { "snippets": [{ id, title, content, format ("plaintext"|"markdown"), category?, tags?, workspaceId?, isFavorite, createdAt, updatedAt }], "nextId": N }`,
          workspaceId ? `Current workspaceId: "${workspaceId}"` : '',
          ``,
          `${snippets.length} snippet(s)${query ? ` matching "${query}"` : ''}:`,
          snippetList,
          ``,
          `Use Read tool to see full content. Use Write/Edit tool to create/update/delete snippets in the JSON file.`,
          `Set workspaceId on a snippet to scope it to a specific workspace, or omit for global visibility.`,
          query ? '' : `How would you like to work with your snippets?`,
        ].filter(Boolean).join('\n')
        // Show clean user message
        setMessages(prev => [...prev, {
          id: `user-${Date.now()}`,
          sessionId,
          role: 'user' as const,
          content: trimmed,
          timestamp: Date.now(),
        }])
        setIsStreaming(true)
        setIsInterrupted(false)
        setStreamingText('')
        setStreamingThinking('')
        await window.electronAPI.claude.sendMessage(sessionId, contextPrompt)
      } catch {
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

    const imageDataUrls = attachedImages.map(i => i.dataUrl)
    const filePaths = attachedFiles.map(f => f.path)
    clearInput()
    setAttachedImages([])
    setAttachedFiles([])
    setPromptSuggestion(null)
    setShowSlashMenu(false)
    if (!isStreaming || isInterrupted) {
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

    // Add user message locally
    const imageNote = imageDataUrls.length > 0
      ? `\n[${imageDataUrls.length} image${imageDataUrls.length > 1 ? 's' : ''} attached]`
      : ''
    const fileNames = filePaths.map(p => p.split('/').pop()).join(', ')
    const fileNote = filePaths.length > 0
      ? `\n[${filePaths.length} file${filePaths.length > 1 ? 's' : ''} attached: ${fileNames}]`
      : ''
    const displayContent = (trimmed + imageNote + fileNote).replace(/^\n/, '')
    setMessages(prev => [...prev, {
      id: `user-${Date.now()}`,
      sessionId,
      role: 'user' as const,
      content: displayContent,
      timestamp: Date.now(),
    }])

    await window.electronAPI.claude.sendMessage(sessionId, promptToSend, imageDataUrls.length > 0 ? imageDataUrls : undefined)
  }, [isStreaming, sessionId, attachedImages, attachedFiles, clearInput])

  const handleInterrupt = useCallback(() => {
    if (!isStreaming) return
    window.electronAPI.claude.stopSession(sessionId)
    setIsInterrupted(true)
    setStreamingText('')
    setStreamingThinking('')
    setPendingPermission(null)
    textareaRef.current?.focus()
  }, [sessionId, isStreaming])

  const handleStop = useCallback(() => {
    if (!isStreaming && !isInterrupted) return
    if (!isInterrupted) {
      window.electronAPI.claude.stopSession(sessionId)
    }
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

  const permissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'bypassPlan', 'plan'] as const
  const permissionModeLabels: Record<string, string> = {
    default: '\u270F Ask before edits',
    acceptEdits: '\u270F Auto-accept edits',
    bypassPermissions: '\u26A0 Bypass permissions',
    bypassPlan: '\uD83D\uDCCB Plan (auto-approve)',
    plan: '\uD83D\uDCCB Plan mode',
  }

  const handlePermissionModeCycle = useCallback(async () => {
    const allowBypass = settingsStore.getSettings().allowBypassPermissions
    const availableModes = allowBypass
      ? permissionModes
      : permissionModes.filter(m => m !== 'bypassPermissions' && m !== 'bypassPlan')
    const idx = availableModes.indexOf(permissionMode as typeof availableModes[number])
    const nextMode = availableModes[(idx + 1) % availableModes.length]
    setPermissionMode(nextMode)
    await window.electronAPI.claude.setPermissionMode(sessionId, nextMode)
  }, [sessionId, permissionMode])

  useEffect(() => { showSlashMenuRef.current = showSlashMenu }, [showSlashMenu])

  // Filtered slash commands based on current input
  const filteredSlashCommands = useMemo(() => {
    if (!showSlashMenu) return []
    const q = slashFilter.toLowerCase()
    // Include our custom commands plus SDK commands
    const builtIn: SlashCommandInfo[] = [
      { name: 'new', description: 'Reset session (clear conversation)', argumentHint: '' },
      { name: 'clear', description: 'Reset session (same as /new)', argumentHint: '' },
      { name: 'snippet', description: 'Show snippets to Claude for management', argumentHint: '' },
      { name: 'resume', description: 'Resume a previous session', argumentHint: '' },
      { name: 'model', description: 'Select model', argumentHint: '' },
    ]
    const all = [...builtIn, ...slashCommands]
    return q ? all.filter(c => c.name.toLowerCase().includes(q)) : all
  }, [showSlashMenu, slashFilter, slashCommands])

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
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend, handlePermissionModeCycle, setInputValue, showSlashMenu, filteredSlashCommands, slashMenuIndex, handleSlashSelect, promptSuggestion])

  const handleModelCycle = useCallback(async () => {
    if (availableModels.length === 0) return
    const idx = availableModels.findIndex(m => m.value === currentModel)
    const next = availableModels[(idx + 1) % availableModels.length]
    setCurrentModel(next.value)
    await window.electronAPI.claude.setModel(sessionId, next.value)
    workspaceStore.updateTerminalModel(sessionId, next.value)
  }, [sessionId, currentModel, availableModels])

  const handleEffortChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value
    setEffortLevel(next)
    await window.electronAPI.claude.setEffort(sessionId, next)
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
      window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'allow',
        updatedInput: pendingPermission.input,
      })
      setPendingPermission(null)
    } else if (action === 'dontAskAgain') {
      if (pendingPermission.toolName === 'ExitPlanMode') {
        window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
          behavior: 'allow',
          updatedInput: pendingPermission.input,
          dontAskAgain: true,
        })
      } else {
        window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
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
      window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
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
      window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
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
      window.electronAPI.fs.readFile(String(pendingPermission.input.planFilePath)).then(r => {
        if (r.content) setPlanFileContent(r.content)
      }).catch(() => {})
    } else {
      setPlanFileContent(null)
    }
  }, [pendingPermission])

  // Auto-focus permission card when it appears or when panel becomes active again
  useEffect(() => {
    if (isActive && pendingPermission && permissionCardRef.current) {
      permissionCardRef.current.focus()
    }
  }, [isActive, pendingPermission])

  const permissionCustomRef = useRef<HTMLInputElement>(null)

  // Auto-focus custom text input when option 3 is selected
  useEffect(() => {
    if (permissionFocus === 3 && permissionCustomRef.current) {
      permissionCustomRef.current.focus()
    }
  }, [permissionFocus])

  // Global keyboard listener
  useEffect(() => {
    if (!isActive) return
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Ctrl+P: open file picker
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault()
        setShowFilePicker(true)
        setFilePickerQuery('')
        setFilePickerResults([])
        setFilePickerIndex(0)
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
  }, [isActive, isStreaming, handleStop, pendingPermission, permissionFocus, handlePermissionSelect, showResumeList, showModelList, taskModal, contentModal, showFilePicker, filePickerPreview])

  const handleAskUserSubmit = useCallback(() => {
    if (!pendingQuestion) return
    // Merge selected answers with "Other" text inputs
    const finalAnswers = { ...askAnswers }
    for (const [key, text] of Object.entries(askOtherText)) {
      if (text.trim()) {
        finalAnswers[key] = text.trim()
      }
    }
    window.electronAPI.claude.resolveAskUser(sessionId, pendingQuestion.toolUseId, finalAnswers)
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
      const dataUrl = await window.electronAPI.image.readAsDataUrl(filePath)
      setAttachedImages(prev => {
        if (prev.length >= MAX_IMAGES) return prev
        if (prev.some(img => img.path === filePath)) return prev
        return [...prev, { path: filePath, dataUrl }]
      })
    } catch (err) {
      console.error('Failed to read image:', err)
    }
  }, [attachedImages])

  const addFileByPath = useCallback((filePath: string) => {
    setAttachedFiles(prev => {
      if (prev.length >= MAX_FILES) return prev
      if (prev.some(f => f.path === filePath)) return prev
      const name = filePath.split('/').pop() || filePath
      return [...prev, { path: filePath, name }]
    })
  }, [])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const filePath = await window.electronAPI.clipboard.saveImage()
        if (filePath) {
          await addImageByPath(filePath)
        }
        return
      }
    }
  }, [addImageByPath])

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
    for (const file of e.dataTransfer.files) {
      if (!file.path) continue
      if (file.type.startsWith('image/')) {
        await addImageByPath(file.path)
      } else {
        addFileByPath(file.path)
      }
    }
  }, [addImageByPath, addFileByPath])

  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'])

  const handleSelectAttachments = useCallback(async () => {
    const paths = await window.electronAPI.dialog.selectFiles()
    for (const p of paths) {
      const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
      if (IMAGE_EXTENSIONS.has(ext)) {
        await addImageByPath(p)
      } else {
        addFileByPath(p)
      }
    }
  }, [addImageByPath, addFileByPath])

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
    if (input.command) return String(input.command).slice(0, 80)
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

      const dotClass = item.denied ? 'dot-denied' : item.status === 'running' ? 'dot-running' : item.status === 'completed' ? 'dot-success' : 'dot-error'
      const desc = toolDescription(item.input)

      // ExitPlanMode / EnterPlanMode: show plan content in readable view
      if (item.toolName === 'ExitPlanMode' || item.toolName === 'EnterPlanMode') {
        const resultRaw = item.result ? (typeof item.result === 'string' ? item.result : String(item.result)) : ''
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
                    window.electronAPI.fs.readFile(planPath).then(r => {
                      if (r.content) setContentModal({ title: 'Plan', content: r.content })
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
        const resultRaw = item.result ? (typeof item.result === 'string' ? item.result : String(item.result)) : ''
        const { content: resultText, reminders: resultReminders, errors: resultErrors } = splitSystemReminders(resultRaw)
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
                {item.input.subagent_type && <span className="claude-tool-badge">{String(item.input.subagent_type)}</span>}
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
                    window.electronAPI.claude.stopTask(sessionId, item.id)
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
                    <div className="claude-plan-open-btn" onClick={() => setContentModal({ title: 'Task Result', content: resultText })}>
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
        const resultRaw = item.result ? (typeof item.result === 'string' ? item.result : String(item.result)) : ''
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
        const resultRaw = item.result ? (typeof item.result === 'string' ? item.result : String(item.result)) : ''
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
        const resultRaw = item.result ? (typeof item.result === 'string' ? item.result : String(item.result)) : ''
        const { content: resultText, errors: resultErrors } = splitSystemReminders(resultRaw)
        const resultLines = resultText.split('\n')
        const isLongResult = resultLines.length > 6 || resultText.length > 400
        const isResultExpanded = expandedTools.has(`taskout-result-${item.id}`)
        return (
          <div key={item.id || index} className="tl-item" data-tool-id={item.id}>
            <div className={`tl-dot ${dotClass}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">TaskOutput</span>
                {parentTask?.input.subagent_type && (
                  <span className="claude-tool-badge">{String(parentTask.input.subagent_type)}</span>
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
                    <div className="claude-plan-open-btn" onClick={() => setContentModal({ title: 'TaskOutput Result', content: resultText })}>
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
      const inBlockId = `in-${item.id}`
      const outBlockId = `out-${item.id}`
      const inLines = inContent.split('\n')
      const isInLong = inLines.length > 3
      const isInExpanded = expandedTools.has(`in-expand-${item.id}`)
      return (
        <div key={item.id || index} className="tl-item" data-tool-id={item.id}>
          <div className={`tl-dot ${dotClass}`} />
          <div className="tl-content">
            <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
              <span className="claude-tool-name">{item.toolName}</span>
              {desc && <span className="claude-tool-desc">{desc}</span>}
              {!desc && <span className="claude-tool-summary">{toolInputSummary(item.toolName, item.input)}</span>}
              {item.timestamp > 0 && <span className="claude-tool-time" title={formatFullTimestamp(item.timestamp)}>{formatTimestamp(item.timestamp)}</span>}
            </div>
            {item.denyReason && (
              <div className="claude-tool-reason">Reason: {item.denyReason}</div>
            )}
            <div className="claude-tool-blocks">
              <div
                className="claude-tool-row"
                onClick={() => handleCopyBlock(inContent, inBlockId)}
                title={t('claude.clickToCopy')}
              >
                <span className="claude-tool-row-label">IN</span>
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
              {item.result && (() => {
                const raw = typeof item.result === 'string' ? item.result : String(item.result)
                const { content: outText, reminders, errors } = splitSystemReminders(raw)
                // Collapse by default for read-only tools; collapse all if setting enabled
                const isReadOnlyTool = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(item.toolName)
                const shouldCollapse = isReadOnlyTool || settingsStore.getSettings().collapseToolOutputs
                const isOutExpanded = expandedTools.has(outBlockId)
                return (
                  <>
                    {errors.length > 0 && errors.map((err, i) => (
                      <div key={`err${i}`} className="claude-tool-row claude-tool-error-row">
                        <span className="claude-tool-row-label claude-error-label">{t('claude.err')}</span>
                        <span className="claude-tool-row-content">{err}</span>
                      </div>
                    ))}
                    {outText && shouldCollapse && (
                      <div
                        className="claude-tool-row"
                        onClick={() => toggleTool(outBlockId)}
                      >
                        <span className="claude-tool-row-label">{t('claude.out')}</span>
                        <span className="claude-tool-row-content">
                          {isOutExpanded
                            ? <LinkedText text={outText} />
                            : <span className="claude-tool-collapsed-hint">{outText.split('\n').length} lines</span>
                          }
                        </span>
                        <span className={`claude-tool-chevron ${isOutExpanded ? 'expanded' : ''}`}>&#9654;</span>
                      </div>
                    )}
                    {outText && !shouldCollapse && (
                      <div
                        className="claude-tool-row"
                        onClick={() => handleCopyBlock(outText, outBlockId)}
                        title={t('claude.clickToCopy')}
                      >
                        <span className="claude-tool-row-label">{t('claude.out')}</span>
                        <span className="claude-tool-row-content"><LinkedText text={outText} /></span>
                        <span className={`claude-tool-row-copy ${copiedId === outBlockId ? 'copied' : ''}`}>
                          {copiedId === outBlockId ? '✓' : '⧉'}
                        </span>
                      </div>
                    )}
                    {reminders.length > 0 && (
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
    if (msg.role === 'user') {
      return (
        <div
          key={msg.id || index}
          className="tl-item tl-item-user"
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
            const isExpanded = expandedTools.has(msg.id) || (autoExpandThinking && !expandedTools.has(`${msg.id}-collapsed`))
            return (
              <div className="claude-thinking-block">
                <div
                  className="claude-thinking-toggle"
                  onClick={() => {
                    if (isExpanded && autoExpandThinking) {
                      // If auto-expanded, clicking collapses by marking it explicitly collapsed
                      setExpandedTools(prev => { const next = new Set(prev); next.add(`${msg.id}-collapsed`); return next })
                    } else {
                      toggleTool(msg.id, true)
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
            <div
              className="claude-markdown"
              dangerouslySetInnerHTML={{ __html: renderChatMarkdown(msg.content) }}
              onClick={(e) => {
                const target = e.target as HTMLElement
                const link = target.closest('a') as HTMLAnchorElement | null
                if (link?.href) {
                  e.preventDefault()
                  window.electronAPI.shell.openExternal(link.href)
                }
              }}
            />
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
      className="claude-agent-panel"
      style={{ '--claude-font-size': `${claudeFontSize}px` } as React.CSSProperties}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
      {activeTasks.length > 0 && (
        <div className="claude-active-tasks">
          {activeTasks.map(task => {
            const label = task.input.description
              ? String(task.input.description).slice(0, 60)
              : task.input.subagent_type
                ? String(task.input.subagent_type)
                : 'Task'
            const progressDesc = task.description || ''
            const isStalled = progressDesc.startsWith('[stalled]')
            return (
              <div
                key={task.id}
                className="claude-active-task-item"
                onClick={() => setTaskModal({ taskId: task.id, label, subagentType: task.input.subagent_type ? String(task.input.subagent_type) : undefined })}
              >
                <span className="claude-active-task-dot" />
                <span className="claude-active-task-label">{label}</span>
                {progressDesc && !isStalled && <span className="claude-active-task-progress">{progressDesc}</span>}
                {isStalled && <span className="claude-active-task-stalled">{t('claude.stalled')}</span>}
                <span className="claude-active-task-time">{formatElapsed(task.timestamp)}</span>
                {task.input.run_in_background && <span className="claude-task-tag">{t('claude.bg')}</span>}
                <button className="claude-task-stop-btn" onClick={(e) => {
                  e.stopPropagation()
                  window.electronAPI.claude.stopTask(sessionId, task.id)
                }}>Stop</button>
              </div>
            )
          })}
        </div>
      )}
      <div className="claude-messages claude-timeline" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
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
        {allMessages.map((item, i) => {
          const divider = shouldShowTimeDivider(item, allMessages[i - 1]) ? (
            <div key={`divider-${i}`} className="claude-time-divider">
              <span>{formatTimestamp(item.timestamp || 0)}</span>
            </div>
          ) : null
          return <Fragment key={item.id || `msg-${i}`}>{divider}{renderMessage(item, i)}</Fragment>
        })}
        {isStreaming && !streamingText && !streamingThinking && showThinkingMsg && (
          <div className="tl-item">
            <div className="tl-dot dot-thinking" />
            <div className="tl-content claude-thinking">
              <span className="claude-thinking-text">{t('claude.thinking')}</span>
              <span className="claude-thinking-dots"><span>.</span><span>.</span><span>.</span></span>
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
        {userScrolledUp && (
          <button className="scroll-to-bottom-btn" onClick={scrollToBottom} title={t('claude.scrollToBottom')}>
            &#x2193;
          </button>
        )}
      </div>

      {/* Permission Request Card — VS Code style vertical list */}
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
              <div className="claude-plan-open-btn" onClick={() => setContentModal({ title: 'Plan', content: planContent })}>
                {t('claude.viewFullPlan', { count: planContent.split('\n').length })}
              </div>
            </div>
          )}
          {pendingPermission.decisionReason && !planContent && (
            <div className="claude-permission-reason">
              {pendingPermission.decisionReason}
            </div>
          )}
          {pendingPermission.input.description && (
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
            const hasPreview = q.options.some(opt => opt.markdown)
            const selectedLabel = askAnswers[String(qi)]
            const selectedPreview = selectedLabel
              ? q.options.find(opt => opt.label === selectedLabel)?.markdown
              : undefined
            return (
              <div key={qi} className={`claude-ask-question ${hasPreview ? 'claude-ask-with-preview' : ''}`}>
                <div className="claude-ask-main">
                  <div className="claude-ask-header">{q.header}</div>
                  <div className="claude-ask-text">{q.question}</div>
                  <div className="claude-ask-options">
                    {q.options.map((opt, oi) => (
                      <button
                        key={oi}
                        className={`claude-ask-option ${askAnswers[String(qi)] === opt.label ? 'selected' : ''}`}
                        onClick={() => setAskAnswers(prev => ({ ...prev, [String(qi)]: opt.label }))}
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
                      value={askOtherText[String(qi)] || ''}
                      onChange={e => setAskOtherText(prev => ({ ...prev, [String(qi)]: e.target.value }))}
                    />
                  </div>
                </div>
                {hasPreview && selectedPreview && (
                  <div className="claude-ask-preview">
                    <iframe
                      sandbox="allow-same-origin"
                      srcDoc={selectedPreview}
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
      {showResumeList && (
        <div className="claude-resume-card">
          <div className="claude-permission-title">{t('claude.resumeSession')}</div>
          {resumeLoading ? (
            <div className="claude-resume-empty">Loading sessions...</div>
          ) : resumeSessions.length === 0 ? (
            <div className="claude-resume-empty">No sessions found</div>
          ) : (
            <div className="claude-resume-list">
              {resumeSessions.map(s => (
                <div
                  key={s.sdkSessionId}
                  className="claude-resume-item"
                  onClick={() => handleResumeSelect(s.sdkSessionId)}
                >
                  <div className="claude-resume-item-header">
                    <span className="claude-resume-item-id">{s.sdkSessionId.slice(0, 8)}</span>
                    {s.gitBranch && <span className="claude-resume-item-branch">{s.gitBranch}</span>}
                    <span className="claude-resume-item-time">
                      {new Date(s.createdAt || s.timestamp).toLocaleString()}
                    </span>
                  </div>
                  {s.customTitle && <div className="claude-resume-item-title">{s.customTitle}</div>}
                  {s.summary && s.summary !== s.customTitle && <div className="claude-resume-item-preview">{s.summary}</div>}
                </div>
              ))}
            </div>
          )}
          <div className="claude-permission-hint">{t('claude.escToCancel')}</div>
        </div>
      )}

      {/* Model Selection List */}
      {showModelList && (
        <div className="claude-resume-card">
          <div className="claude-permission-title">Select a model</div>
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
                return (
                  <>
                    {builtins.length > 0 && (
                      <>
                        <div className="claude-model-group-label">Better Agent Terminal</div>
                        {builtins.map(renderItem)}
                      </>
                    )}
                    {sdkModels.length > 0 && (
                      <>
                        <div className="claude-model-group-label">Claude Code</div>
                        {sdkModels.map(renderItem)}
                      </>
                    )}
                  </>
                )
              })()}
            </div>
          )}
          <div className="claude-permission-hint">{t('claude.escToCancel')}</div>
        </div>
      )}

      {/* Ctrl+P File Picker */}
      {showFilePicker && (
        <div className="claude-file-picker" onClick={() => setShowFilePicker(false)}>
          <div className="claude-file-picker-box" onClick={e => e.stopPropagation()}>
            <input
              ref={filePickerInputRef}
              className="claude-file-picker-input"
              type="text"
              placeholder="Search files by name..."
              value={filePickerQuery}
              onChange={e => setFilePickerQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setFilePickerIndex(prev => Math.min(prev + 1, filePickerResults.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setFilePickerIndex(prev => Math.max(prev - 1, 0))
                } else if (e.key === 'Enter' && filePickerResults.length > 0) {
                  e.preventDefault()
                  const selected = filePickerResults[filePickerIndex]
                  if (selected && !selected.isDirectory) {
                    setShowFilePicker(false)
                    setFilePickerPreview(selected.path)
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setShowFilePicker(false)
                }
              }}
            />
            <div className="claude-file-picker-list">
              {!filePickerQuery.trim() && (
                <div className="claude-file-picker-empty">Type to search files...</div>
              )}
              {filePickerQuery.trim() && filePickerResults.length === 0 && (
                <div className="claude-file-picker-empty">No files found</div>
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
                        setShowFilePicker(false)
                        setFilePickerPreview(item.path)
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

      {/* Input area — hidden when permission card, ask-user card, or resume/model list is visible */}
      <div
        className={`claude-input-area${isDragOver ? ' drag-over' : ''}`}
        style={pendingPermission || pendingQuestion || showResumeList || showModelList ? { display: 'none' } : undefined}
      >
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
            {filteredSlashCommands.slice(0, 10).map((cmd, i) => (
              <div
                key={cmd.name}
                className={`claude-slash-item${i === slashMenuIndex ? ' selected' : ''}`}
                onClick={() => handleSlashSelect(cmd)}
                onMouseEnter={() => setSlashMenuIndex(i)}
              >
                <span className="claude-slash-name">/{cmd.name}</span>
                <span className="claude-slash-desc">{cmd.description}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="claude-input"
          defaultValue=""
          onInput={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isInterrupted ? 'Type to continue, Esc to stop...' : isStreaming ? 'Press Esc to pause, double-Esc to stop...' : 'Type a message... (Enter to send, Shift+Tab to switch mode)'}
          disabled={false}
          rows={1}
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
            <span
              className={`claude-status-btn claude-mode-${permissionMode}`}
              onClick={handlePermissionModeCycle}
              title={`Permission: ${permissionMode} (click to cycle)`}
            >
              {permissionModeLabels[permissionMode] || permissionMode}
            </span>

            {currentModel && (
              <span
                className="claude-status-btn"
                onClick={() => setShowModelList(true)}
                title={`Model: ${currentModel} (click to select)`}
              >
                {'</>'} {currentModel}{sessionMeta && sessionMeta.contextWindow > 0 ? ` (${sessionMeta.contextWindow >= 1000000 ? `${Math.round(sessionMeta.contextWindow / 1000000)}M` : `${Math.round(sessionMeta.contextWindow / 1000)}k`})` : ''}
              </span>
            )}
            <select
              className="claude-effort-select"
              value={effortLevel}
              onChange={handleEffortChange}
              title={t('claude.effortLevel')}
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            {accountInfo?.organization && (
              <span className="claude-status-btn claude-account-info" title={`${accountInfo.email || ''} (${accountInfo.subscriptionType || 'unknown'})`}>
                {accountInfo.organization}
              </span>
            )}
          </div>

          <div className="claude-input-actions">
            {hasSdkSession && (
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
            <pre className="claude-plan-modal-body">{contentModal.content}</pre>
          </div>
        </div>
      )}

      {/* Subagent Modal */}
      {taskModal && (() => {
        const taskMsgs = subagentMessagesRef.current.get(taskModal.taskId) || []
        const streamText = subagentStreamingText.get(taskModal.taskId) || ''
        const streamThink = subagentStreamingThinking.get(taskModal.taskId) || ''
        const parentTask = allMessages.find(m => isToolCall(m) && m.id === taskModal.taskId) as ClaudeToolCall | undefined
        const isRunning = parentTask?.status === 'running'
        // Force re-render dependency
        void taskModalTick

        return (
          <div className="claude-plan-overlay" onClick={() => setTaskModal(null)}>
            <div className="claude-plan-modal claude-subagent-modal" onClick={e => e.stopPropagation()}>
              <div className="claude-plan-modal-header">
                {isRunning && <span className="claude-active-task-dot" />}
                <span className="claude-tool-name" style={{ marginRight: 4 }}>Task</span>
                {taskModal.subagentType && <span className="claude-tool-badge" style={{ marginRight: 6 }}>{taskModal.subagentType}</span>}
                <span className="claude-plan-modal-title">{taskModal.label}</span>
                <span className="claude-subagent-meta">
                  {taskMsgs.length} messages
                  {parentTask && parentTask.timestamp > 0 ? ` · ${formatElapsed(parentTask.timestamp)}` : ''}
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
                <div className="claude-messages claude-timeline">
                  {taskMsgs.map((item, i) => renderMessage(item, i))}
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
        const userPrompts = allMessages
          .filter(m => !isToolCall(m) && (m as ClaudeMessage).role === 'user') as ClaudeMessage[]
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
                      {m.timestamp > 0 && <span className="claude-prompt-history-time">{formatFullTimestamp(m.timestamp)}</span>}
                      <button
                        className="claude-prompt-history-copy-one"
                        onClick={() => navigator.clipboard.writeText(m.content)}
                        title={t('claude.copyThisPrompt')}
                      >copy</button>
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
          sessionId: () => (
            <span key="sessionId" className="claude-statusline-item claude-statusline-clickable"
              onClick={async () => {
                setResumeLoading(true); setShowResumeList(true)
                try { setResumeSessions(await window.electronAPI.claude.listSessions(cwd) || []) }
                catch { setResumeSessions([]) }
                finally { setResumeLoading(false) }
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
          tokens: () => !sessionMeta ? null : (
            <span key="tokens" className="claude-statusline-item claude-statusline-clickable" title={`in: ${sessionMeta.inputTokens.toLocaleString()} / out: ${sessionMeta.outputTokens.toLocaleString()}\nclick to show /context`}
              onClick={() => { if (!inputValueRef.current.trim()) { setInputValue('/context'); setTimeout(() => handleSend(), 0) } }}>
              {(sessionMeta.inputTokens + sessionMeta.outputTokens).toLocaleString()} tok
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
            const pct = Math.round((ctxTokens / sessionMeta.contextWindow) * 100)
            const ctxColor = pct >= 80 ? '#e05252' : pct >= 50 ? '#e6a700' : '#89ca78'
            return (
              <span key="contextPct" className="claude-statusline-item claude-statusline-clickable" style={{ color: ctxColor }} title={`context: ${ctxTokens.toLocaleString()} / ${sessionMeta.contextWindow.toLocaleString()} tokens\ntotal: ${(sessionMeta.inputTokens + sessionMeta.outputTokens).toLocaleString()} tok\nclick to show /context`}
                onClick={() => { if (!inputValueRef.current.trim()) { setInputValue('/context'); setTimeout(() => handleSend(), 0) } }}>
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
            if (claudeUsage?.fiveHour == null) return null
            const pacing = workspaceStore.getUsagePacing()
            const pacingIcon = pacing ? (pacing.onPace ? ' ▼' : ' ▲') : ''
            const stale = (claudeUsage as any).fiveHourStale
            const accountLine = usageAccount ? `${usageAccount.email} · ${usageAccount.orgName} · ${usageAccount.tier}` : ''
            const pacingLine = pacing ? `Time elapsed: ${Math.round(pacing.timeElapsedPct)}%${pacing.estimatedMinutesToLimit != null ? ` · ETA: ~${pacing.estimatedMinutesToLimit}min` : ''}` : ''
            const titleParts = [accountLine, pacingLine].filter(Boolean)
            return (
              <span key="usage5h"
                className={`claude-statusline-item${claudeUsage.fiveHour > 80 ? ' claude-usage-high' : claudeUsage.fiveHour > 50 ? ' claude-usage-mid' : ''}${stale ? ' claude-usage-stale' : ''}`}
                title={titleParts.join('\n') || undefined}
                style={!pacing?.onPace && pacing ? { fontWeight: 600 } : undefined}>
                5h:{Math.round(claudeUsage.fiveHour)}%{pacingIcon}
              </span>
            )
          },
          usage5hReset: () => {
            if (!claudeUsage?.fiveHourReset) return null
            return <span key="usage5hReset" className="claude-statusline-item">↻{fmtRemaining(new Date(claudeUsage.fiveHourReset))}</span>
          },
          usage7d: () => {
            if (claudeUsage?.sevenDay == null) return null
            const accountLine = usageAccount ? `${usageAccount.email} · ${usageAccount.orgName} · ${usageAccount.tier}` : ''
            return (
              <span key="usage7d"
                className={`claude-statusline-item${(claudeUsage.sevenDay ?? 0) > 80 ? ' claude-usage-high' : (claudeUsage.sevenDay ?? 0) > 50 ? ' claude-usage-mid' : ''}`}
                title={accountLine || undefined}>
                7d:{Math.round(claudeUsage.sevenDay ?? 0)}%
              </span>
            )
          },
          usage7dReset: () => {
            if (!claudeUsage?.sevenDayReset) return null
            return <span key="usage7dReset" className="claude-statusline-item">↻{fmtRemaining(new Date(claudeUsage.sevenDayReset))}</span>
          },
          maxOut: () => !sessionMeta || !sessionMeta.maxOutputTokens ? null : (
            <span key="maxOut" className="claude-statusline-item" title={`Max output: ${sessionMeta.maxOutputTokens.toLocaleString()} tokens`}>
              maxOut:{(sessionMeta.maxOutputTokens / 1000).toFixed(0)}k
            </span>
          ),
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
    </div>
  )
}
