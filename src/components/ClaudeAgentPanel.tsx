import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { ClaudeMessage, ClaudeToolCall } from '../types/claude-agent'
import { isToolCall } from '../types/claude-agent'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import { LinkedText, FilePreviewModal } from './PathLinker'

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
  permissionMode?: string
}

interface ModelInfo {
  value: string
  displayName: string
  description: string
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
  options: Array<{ label: string; description: string }>
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
}

interface ClaudeAgentPanelProps {
  sessionId: string
  cwd: string
  isActive: boolean
  workspaceId?: string
}

interface AttachedImage {
  path: string
  dataUrl: string
}

type MessageItem = ClaudeMessage | ClaudeToolCall

// Track sessions that have been started to prevent duplicate calls across StrictMode remounts
const startedSessions = new Set<string>()

export function ClaudeAgentPanel({ sessionId, cwd, isActive, workspaceId }: Readonly<ClaudeAgentPanelProps>) {
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
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)
  const [permissionMode, setPermissionMode] = useState<string>('bypassPermissions')
  const [currentModel, setCurrentModel] = useState<string>('')
  const [effortLevel, setEffortLevel] = useState<string>('high')
  const [enable1MContext, setEnable1MContext] = useState(false)
  const [claudeUsage, setClaudeUsage] = useState(workspaceStore.claudeUsage)
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [permissionFocus, setPermissionFocus] = useState(0) // 0=Yes, 1=Yes always, 2=No, 3=custom text
  const [permissionCustomText, setPermissionCustomText] = useState('')
  const [pendingQuestion, setPendingQuestion] = useState<PendingAskUser | null>(null)
  const [askAnswers, setAskAnswers] = useState<Record<string, string>>({})
  const [askOtherText, setAskOtherText] = useState<Record<string, string>>({})
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [showResumeList, setShowResumeList] = useState(false)
  const [resumeSessions, setResumeSessions] = useState<SessionSummary[]>([])
  const [resumeLoading, setResumeLoading] = useState(false)
  const [showModelList, setShowModelList] = useState(false)
  const [contentModal, setContentModal] = useState<{ title: string; content: string } | null>(null)
  const [showPromptHistory, setShowPromptHistory] = useState(false)
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null)
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
  const initialModeAppliedRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamingThinkingRef = useRef<HTMLPreElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const permissionCardRef = useRef<HTMLDivElement>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const isNearBottomRef = useRef(true)
  const [aboveViewportUserMsgIds, setAboveViewportUserMsgIds] = useState<Set<string>>(new Set())
  const [claudeFontSize, setClaudeFontSize] = useState(settingsStore.getSettings().fontSize)
  const [claudeFontFamily, setClaudeFontFamily] = useState(settingsStore.getFontFamilyString())
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

  // Active tasks (running Task tool calls) for the indicator bar
  const activeTasks = useMemo(() =>
    allMessages.filter(m => isToolCall(m) && m.toolName === 'Task' && m.status === 'running') as ClaudeToolCall[]
  , [allMessages])

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
    console.log(`${tag} subscribing to IPC events`)

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
          setSessionMeta(null)
          return
        }
        // Deduplicate by id; attach streaming thinking if backend didn't provide it
        setStreamingThinking(prevThinking => {
          const finalMsg = (!message.thinking && prevThinking && message.role === 'assistant')
            ? { ...message, thinking: prevThinking }
            : message
          setMessages(prev => {
            if (prev.some(m => m.id === finalMsg.id)) return prev
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
        setMessages(prev => {
          if (prev.some(m => 'toolName' in m && m.id === toolCall.id)) return prev
          return [...prev, toolCall]
        })
      }),

      api.onToolResult((sid: string, result: unknown) => {
        if (sid !== sessionId) return
        workspaceStore.updateTerminalActivity(sessionId)
        const { id, ...updates } = result as { id: string; status: string; result?: string }
        setMessages(prev => prev.map(m => {
          if ('toolName' in m && m.id === id) {
            return { ...m, ...updates } as ClaudeToolCall
          }
          return m
        }))
      }),

      api.onResult((sid: string, resultData: unknown) => {
        if (sid !== sessionId) return
        setIsStreaming(false)
        setIsInterrupted(false)
        setStreamingText('')
        setStreamingThinking('')
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
        const d = data as { text?: string; thinking?: string }
        if (d.text) setStreamingText(prev => prev + d.text)
        if (d.thinking) setStreamingThinking(prev => prev + d.thinking)
      }),

      api.onStatus((sid: string, meta: unknown) => {
        if (sid !== sessionId) {
          console.log(`${tag} SKIP onStatus sid=${sid.slice(0, 8)} (mine=${sessionId.slice(0, 8)})`)
          return
        }
        console.log(`${tag} onStatus sdkSessionId=${((meta as SessionMeta).sdkSessionId || '').slice(0, 8)}`)
        const m = meta as SessionMeta
        setSessionMeta(m)
        if (m.model) setCurrentModel(prev => prev || m.model!)
        // On first status, ensure bypass mode is applied
        if (!initialModeAppliedRef.current) {
          initialModeAppliedRef.current = true
          window.electronAPI.claude.setPermissionMode(sessionId, 'bypassPermissions')
        } else if (m.permissionMode) {
          setPermissionMode(m.permissionMode)
        }
        // Persist SDK session ID per-terminal so /resume and auto-resume can find it
        if (m.sdkSessionId) {
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

      api.onHistory((sid: string, items: unknown[]) => {
        if (sid !== sessionId) {
          console.log(`${tag} SKIP onHistory sid=${sid.slice(0, 8)} items=${(items as unknown[]).length} (mine=${sessionId.slice(0, 8)})`)
          return
        }
        console.log(`${tag} onHistory items=${(items as unknown[]).length}`)
        historyLoadedRef.current = true
        // Replace messages with the full history batch and clear archive state
        setMessages(items as MessageItem[])
        setLoadedArchive([])
        archivedCountRef.current = 0
        loadedFromArchiveRef.current = 0
        setHasMoreArchived(false)
        window.electronAPI.claude.clearArchive(sessionId).catch(() => {})
        setStreamingText('')
        setStreamingThinking('')
        // Reset the flag after a tick so future restarts work normally
        setTimeout(() => { historyLoadedRef.current = false }, 100)
      }),

      api.onModeChange((sid: string, mode: string) => {
        if (sid !== sessionId) return
        // When exiting plan mode, restore to bypass
        if (mode === 'default') {
          setPermissionMode('bypassPermissions')
          window.electronAPI.claude.setPermissionMode(sessionId, 'bypassPermissions')
        } else {
          setPermissionMode(mode)
        }
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
    if (!sessionStartedRef.current && !startedSessions.has(sessionId)) {
      sessionStartedRef.current = true
      startedSessions.add(sessionId)

      const terminal = workspaceStore.getState().terminals.find(t => t.id === sessionId)
      const savedSdkSessionId = terminal?.sdkSessionId

      if (savedSdkSessionId) {
        console.log(`${stag} AUTO-RESUME sdkSessionId=${savedSdkSessionId.slice(0, 8)}`)
        historyLoadedRef.current = true
        window.electronAPI.claude.resumeSession(sessionId, savedSdkSessionId, cwd)
      } else {
        console.log(`${stag} FRESH startSession`)
        window.electronAPI.claude.startSession(sessionId, { cwd, permissionMode: 'bypassPermissions' })
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

  // Fetch supported models, account info, and slash commands once session metadata arrives
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
        if (cmds && cmds.length > 0) setSlashCommands(cmds)
      }).catch(() => {})
    }
  }, [sessionId, sessionMeta?.sdkSessionId, availableModels.length])

  // Fetch git branch on mount and when cwd changes
  useEffect(() => {
    window.electronAPI.git.getBranch(cwd).then(branch => setGitBranch(branch)).catch(() => setGitBranch(null))
  }, [cwd])

  // Subscribe to font size/family changes from settings
  useEffect(() => {
    return settingsStore.subscribe(() => {
      setClaudeFontSize(settingsStore.getSettings().fontSize)
      setClaudeFontFamily(settingsStore.getFontFamilyString())
    })
  }, [])

  // Subscribe to global Claude usage from workspace store
  useEffect(() => {
    workspaceStore.startUsagePolling()
    return workspaceStore.subscribe(() => {
      const u = workspaceStore.claudeUsage
      if (u) setClaudeUsage(u)
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

  const clearInput = useCallback(() => {
    inputValueRef.current = ''
    if (textareaRef.current) textareaRef.current.value = ''
  }, [])

  const setInputValue = useCallback((val: string) => {
    inputValueRef.current = val
    if (textareaRef.current) textareaRef.current.value = val
  }, [])

  const handleSend = useCallback(async () => {
    const trimmed = inputValueRef.current.trim()
    if (!trimmed && attachedImages.length === 0) return

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

    // Intercept /new command — reset session (clear conversation, fresh start)
    if (!isStreaming && trimmed === '/new') {
      clearInput()
      setMessages([])
      setStreamingText('')
      setStreamingThinking('')
      await window.electronAPI.claude.resetSession(sessionId)
      return
    }

    const imageDataUrls = attachedImages.map(i => i.dataUrl)
    clearInput()
    setAttachedImages([])
    setPromptSuggestion(null)
    setShowSlashMenu(false)
    if (!isStreaming || isInterrupted) {
      setIsStreaming(true)
      setIsInterrupted(false)
      setStreamingText('')
      setStreamingThinking('')
    }

    // Add user message locally
    const imageNote = imageDataUrls.length > 0
      ? `\n[${imageDataUrls.length} image${imageDataUrls.length > 1 ? 's' : ''} attached]`
      : ''
    setMessages(prev => [...prev, {
      id: `user-${Date.now()}`,
      sessionId,
      role: 'user' as const,
      content: trimmed + imageNote,
      timestamp: Date.now(),
    }])

    await window.electronAPI.claude.sendMessage(sessionId, trimmed, imageDataUrls.length > 0 ? imageDataUrls : undefined)
  }, [isStreaming, sessionId, attachedImages, clearInput])

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

  const permissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'planBypass', 'plan'] as const
  const permissionModeLabels: Record<string, string> = {
    default: '\u270F Ask before edits',
    acceptEdits: '\u270F Auto-accept edits',
    bypassPermissions: '\u26A0 Bypass permissions',
    planBypass: '\uD83D\uDCCB Plan (auto-approve)',
    plan: '\uD83D\uDCCB Plan mode',
  }

  const handlePermissionModeCycle = useCallback(async () => {
    const idx = permissionModes.indexOf(permissionMode as typeof permissionModes[number])
    const nextMode = permissionModes[(idx + 1) % permissionModes.length]
    if ((nextMode === 'bypassPermissions' || nextMode === 'planBypass') && !settingsStore.getSettings().allowBypassPermissions) {
      if (!window.confirm('Warning: This mode allows tool calls without confirmation. Continue?')) {
        return
      }
    }
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
      { name: 'resume', description: 'Resume a previous session', argumentHint: '' },
      { name: 'model', description: 'Select model', argumentHint: '' },
    ]
    const all = [...builtIn, ...slashCommands]
    return q ? all.filter(c => c.name.toLowerCase().includes(q)) : all
  }, [showSlashMenu, slashFilter, slashCommands])

  const handleInputChange = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const val = (e.target as HTMLTextAreaElement).value
    inputValueRef.current = val
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
  }, [sessionId, currentModel, availableModels])

  const handleEffortChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value
    setEffortLevel(next)
    await window.electronAPI.claude.setEffort(sessionId, next)
  }, [sessionId])

  const handle1MContextToggle = useCallback(async () => {
    const next = !enable1MContext
    setEnable1MContext(next)
    settingsStore.setEnable1MContext(next)
    await window.electronAPI.claude.set1MContext(sessionId, next)
  }, [sessionId, enable1MContext])

  const PERMISSION_OPTION_COUNT = 4 // 0=Yes, 1=Yes always, 2=No, 3=custom text

  const handlePermissionSelect = useCallback((index?: number) => {
    if (!pendingPermission) return
    const choice = index ?? permissionFocus
    if (choice === 0) {
      // Yes — allow once
      window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'allow',
        updatedInput: pendingPermission.input,
      })
      setPendingPermission(null)
    } else if (choice === 1) {
      // Yes, always for this session
      window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'allow',
        updatedInput: pendingPermission.input,
      })
      setPendingPermission(null)
    } else if (choice === 2) {
      // No — use the same message as VS Code CLI
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
    } else if (choice === 3) {
      // Custom text — deny with reason message
      const msg = permissionCustomText.trim()
      if (!msg) return // don't submit empty
      // Update the tool call in messages to show the deny reason
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
  }, [sessionId, pendingPermission, permissionFocus, permissionCustomText])

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
  }, [isActive, isStreaming, handleStop, pendingPermission, permissionFocus, handlePermissionSelect, showResumeList, showModelList, contentModal, showFilePicker, filePickerPreview])

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
    const files = e.dataTransfer.files
    for (const file of files) {
      if (file.type.startsWith('image/') && file.path) {
        await addImageByPath(file.path)
      }
    }
  }, [addImageByPath])

  const handleSelectImages = useCallback(async () => {
    const paths = await window.electronAPI.dialog.selectImages()
    for (const p of paths) {
      await addImageByPath(p)
    }
  }, [addImageByPath])

  const removeImage = useCallback((filePath: string) => {
    setAttachedImages(prev => prev.filter(img => img.path !== filePath))
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
    if (isToolCall(item)) {
      // TodoWrite: render as a visual checklist
      if (item.toolName === 'TodoWrite') {
        return (
          <div key={item.id || index} className="tl-item">
            <div className={`tl-dot ${item.status === 'running' ? 'dot-running' : 'dot-success'}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">Checklist</span>
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
        const planText = item.input.plan ? String(item.input.plan) : ''
        const planLines = planText.split('\n')
        const resultRaw = item.result ? (typeof item.result === 'string' ? item.result : String(item.result)) : ''
        const { content: resultText, errors: resultErrors } = splitSystemReminders(resultRaw)
        return (
          <div key={item.id || index} className="tl-item">
            <div className={`tl-dot ${dotClass}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">{item.toolName === 'ExitPlanMode' ? 'Exit Plan' : 'Enter Plan'}</span>
                {item.timestamp > 0 && <span className="claude-tool-time" title={formatFullTimestamp(item.timestamp)}>{formatTimestamp(item.timestamp)}</span>}
              </div>
              {planText && (
                <div className="claude-plan-block">
                  <pre className="claude-plan-content">{planLines.slice(0, 3).join('\n')}{planLines.length > 3 ? '\n...' : ''}</pre>
                  <div className="claude-plan-open-btn" onClick={() => setContentModal({ title: 'Plan', content: planText })}>
                    View full plan ({planLines.length} lines)
                  </div>
                </div>
              )}
              {resultErrors.length > 0 && resultErrors.map((err, i) => (
                <div key={`err${i}`} className="claude-tool-blocks"><div className="claude-tool-row claude-tool-error-row">
                  <span className="claude-tool-row-label claude-error-label">ERR</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-tool-blocks">
                  <div className="claude-tool-row">
                    <span className="claude-tool-row-label">OUT</span>
                    <span className="claude-tool-row-content"><LinkedText text={resultText} /></span>
                  </div>
                </div>
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

      // Task tool: custom structured renderer
      if (item.toolName === 'Task') {
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
        return (
          <div key={item.id || index} className="tl-item" data-tool-id={item.id}>
            <div className={`tl-dot ${dotClass}`} />
            <div className="tl-content">
              <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
                <span className="claude-tool-name">Task</span>
                {item.input.subagent_type && <span className="claude-tool-badge">{String(item.input.subagent_type)}</span>}
                {desc && <span className="claude-tool-desc">{desc}</span>}
                {item.status === 'running' && item.timestamp > 0 && (
                  <span className="claude-task-tag claude-task-elapsed">{formatElapsed(item.timestamp)}</span>
                )}
                {item.timestamp > 0 && <span className="claude-tool-time" title={formatFullTimestamp(item.timestamp)}>{formatTimestamp(item.timestamp)}</span>}
              </div>
              {(model || maxTurns || runBg) && (
                <div className="claude-task-meta">
                  {model && <span className="claude-task-tag">model: {model}</span>}
                  {maxTurns && <span className="claude-task-tag">max_turns: {maxTurns}</span>}
                  {runBg && <span className="claude-task-tag">background</span>}
                </div>
              )}
              <div className="claude-task-prompt">
                <div className="claude-task-section-header" onClick={() => toggleTool(`task-prompt-${item.id}`)}>
                  <span className="claude-task-section-label">PROMPT</span>
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
                  <span className="claude-tool-row-label claude-error-label">ERR</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-task-result">
                  <div className="claude-task-section-header" onClick={() => toggleTool(`task-result-${item.id}`)}>
                    <span className="claude-task-section-label">RESULT</span>
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
                    <span className="claude-task-section-label claude-reminder-label">SYS</span>
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
                    <div className="claude-tool-label">Full Input</div>
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
                  <span className="claude-tool-row-label claude-error-label">ERR</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-tool-blocks">
                  <div className="claude-tool-row">
                    <span className="claude-tool-row-label">OUT</span>
                    <span className="claude-tool-row-content"><LinkedText text={resultText} /></span>
                  </div>
                </div>
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
                  <span className="claude-tool-row-label claude-error-label">ERR</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-tool-blocks">
                  <div className="claude-tool-row">
                    <span className="claude-tool-row-label">OUT</span>
                    <span className="claude-tool-row-content"><LinkedText text={resultText} /></span>
                  </div>
                </div>
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
                  <span className="claude-tool-row-label claude-error-label">ERR</span>
                  <span className="claude-tool-row-content">{err}</span>
                </div></div>
              ))}
              {resultText && (
                <div className="claude-task-result">
                  <div className="claude-task-section-header" onClick={() => toggleTool(`taskout-result-${item.id}`)}>
                    <span className="claude-task-section-label">RESULT</span>
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
                    <div className="claude-tool-label">Full Input</div>
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
                title="Click to copy"
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
                return (
                  <>
                    {errors.length > 0 && errors.map((err, i) => (
                      <div key={`err${i}`} className="claude-tool-row claude-tool-error-row">
                        <span className="claude-tool-row-label claude-error-label">ERR</span>
                        <span className="claude-tool-row-content">{err}</span>
                      </div>
                    ))}
                    {outText && (
                      <div
                        className="claude-tool-row"
                        onClick={() => handleCopyBlock(outText, outBlockId)}
                        title="Click to copy"
                      >
                        <span className="claude-tool-row-label">OUT</span>
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
                        <span className="claude-tool-row-label claude-reminder-label">SYS</span>
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
              <div className="claude-tool-interrupted">Tool interrupted</div>
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
    // assistant
    return (
      <div key={msg.id || index} className="tl-item">
        <div className="tl-dot dot-assistant" />
        <div className="tl-content claude-message-assistant">
          {msg.thinking && (() => {
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
                  <span className="claude-thinking-label">Thinking</span>
                </div>
                {isExpanded && (
                  <pre className="claude-thinking-content">{msg.thinking}</pre>
                )}
              </div>
            )
          })()}
          {msg.content && <div className="claude-markdown"><LinkedText text={msg.content} /></div>}
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
      style={{ '--claude-font-size': `${claudeFontSize}px`, '--claude-font-family': claudeFontFamily } as React.CSSProperties}
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
            return (
              <div
                key={task.id}
                className="claude-active-task-item"
                onClick={() => {
                  const el = document.querySelector(`[data-tool-id="${task.id}"]`)
                  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }}
              >
                <span className="claude-active-task-dot" />
                <span className="claude-active-task-label">{label}</span>
                <span className="claude-active-task-time">{formatElapsed(task.timestamp)}</span>
                {task.input.run_in_background && <span className="claude-task-tag">bg</span>}
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
              {isLoadingMore ? 'Loading...' : `Load older messages (${archivedCountRef.current - loadedFromArchiveRef.current} archived)`}
            </button>
          </div>
        )}
        {allMessages.map((item, i) => {
          const divider = shouldShowTimeDivider(item, allMessages[i - 1]) ? (
            <div key={`divider-${i}`} className="claude-time-divider">
              <span>{formatTimestamp(item.timestamp || 0)}</span>
            </div>
          ) : null
          return <>{divider}{renderMessage(item, i)}</>
        })}
        {isStreaming && !streamingText && !streamingThinking && (
          <div className="tl-item">
            <div className="tl-dot dot-thinking" />
            <div className="tl-content claude-thinking">
              <span className="claude-thinking-text">Thinking</span>
              <span className="claude-thinking-dots"><span>.</span><span>.</span><span>.</span></span>
            </div>
          </div>
        )}
        {streamingThinking && (
          <div className="tl-item">
            <div className="tl-dot dot-thinking" />
            <div className="tl-content claude-thinking-block">
              <div
                className="claude-thinking-toggle"
                onClick={() => setShowThinking(prev => !prev)}
              >
                <span className={`claude-tool-chevron ${showThinking ? 'expanded' : ''}`}>&#9654;</span>
                <span className="claude-thinking-label">Thinking{isStreaming && streamingThinking && !streamingText ? '...' : ''}</span>
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
          <button className="scroll-to-bottom-btn" onClick={scrollToBottom} title="Scroll to bottom">
            &#x2193;
          </button>
        )}
      </div>

      {/* Permission Request Card — VS Code style vertical list */}
      {pendingPermission && (() => {
        // For ExitPlanMode, find the most recent plan file content from Write tool calls
        const planContent = pendingPermission.toolName === 'ExitPlanMode'
          ? (() => {
              for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i]
                if ('toolName' in m && m.toolName === 'Write' && m.input?.file_path
                  && String(m.input.file_path).includes('plan')
                  && m.input?.content) {
                  return String(m.input.content)
                }
              }
              return null
            })()
          : null
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
          <div className="claude-permission-title">
            Allow this <strong>{pendingPermission.toolName}</strong> call?
          </div>
          <div className="claude-permission-command">
            {toolInputSummary(pendingPermission.toolName, pendingPermission.input)}
          </div>
          {planContent && (
            <div className="claude-plan-block">
              <pre className="claude-plan-content">{planContent.split('\n').slice(0, 3).join('\n')}{planContent.split('\n').length > 3 ? '\n...' : ''}</pre>
              <div className="claude-plan-open-btn" onClick={() => setContentModal({ title: 'Plan', content: planContent })}>
                View full plan ({planContent.split('\n').length} lines)
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
              <span className="claude-permission-option-label">Yes</span>
            </div>
            <div
              className={`claude-permission-option ${permissionFocus === 1 ? 'focused' : ''}`}
              onClick={() => handlePermissionSelect(1)}
              onMouseEnter={() => setPermissionFocus(1)}
            >
              <span className="claude-permission-option-num">2</span>
              <span className="claude-permission-option-label">Yes, don't ask again for this session</span>
            </div>
            <div
              className={`claude-permission-option ${permissionFocus === 2 ? 'focused' : ''}`}
              onClick={() => handlePermissionSelect(2)}
              onMouseEnter={() => setPermissionFocus(2)}
            >
              <span className="claude-permission-option-num">3</span>
              <span className="claude-permission-option-label">No</span>
            </div>
            <div
              className={`claude-permission-option custom ${permissionFocus === 3 ? 'focused' : ''}`}
              onClick={() => { setPermissionFocus(3); permissionCustomRef.current?.focus() }}
              onMouseEnter={() => setPermissionFocus(3)}
            >
              <input
                ref={permissionCustomRef}
                className="claude-permission-custom-input"
                type="text"
                placeholder="Tell Claude what to do instead"
                value={permissionCustomText}
                onChange={e => setPermissionCustomText(e.target.value)}
                onFocus={() => setPermissionFocus(3)}
              />
            </div>
          </div>
          <div className="claude-permission-hint">Esc to cancel</div>
        </div>
        )
      })()}

      {/* AskUserQuestion Card */}
      {pendingQuestion && (
        <div className="claude-ask-card">
          {pendingQuestion.questions.map((q, qi) => (
            <div key={qi} className="claude-ask-question">
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
                  placeholder="Other..."
                  value={askOtherText[String(qi)] || ''}
                  onChange={e => setAskOtherText(prev => ({ ...prev, [String(qi)]: e.target.value }))}
                />
              </div>
            </div>
          ))}
          <div className="claude-ask-actions">
            <button className="claude-permission-btn allow" onClick={handleAskUserSubmit}>Submit</button>
          </div>
        </div>
      )}

      {/* Resume Session List */}
      {showResumeList && (
        <div className="claude-resume-card">
          <div className="claude-permission-title">Resume a previous session</div>
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
                    <span className="claude-resume-item-time">
                      {new Date(s.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="claude-resume-item-preview">{s.preview}</div>
                </div>
              ))}
            </div>
          )}
          <div className="claude-permission-hint">Esc to cancel</div>
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
              {availableModels.map(m => (
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
              ))}
            </div>
          )}
          <div className="claude-permission-hint">Esc to cancel</div>
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
      {!pendingPermission && !pendingQuestion && !showResumeList && !showModelList && (
      <div className={`claude-input-area${isDragOver ? ' drag-over' : ''}`}>
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
        {attachedImages.length > 0 && (
          <div className="claude-attachments">
            {attachedImages.map(img => (
              <div key={img.path} className="claude-attachment">
                <img src={img.dataUrl} className="claude-attachment-thumb" alt="attached" />
                <button
                  className="claude-attachment-remove"
                  onClick={() => removeImage(img.path)}
                  title="Remove image"
                >
                  &times;
                </button>
              </div>
            ))}
            {attachedImages.length < MAX_IMAGES && (
              <button
                className="claude-add-image-btn"
                onClick={handleSelectImages}
                title="Add image"
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
                {'</>'} {currentModel}
              </span>
            )}
            <select
              className="claude-effort-select"
              value={effortLevel}
              onChange={handleEffortChange}
              title="Effort level"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
            <span
              className={`claude-status-btn claude-1m-toggle${enable1MContext ? ' active' : ''}`}
              onClick={handle1MContextToggle}
              title="1M context window (Sonnet only)"
            >
              1M
            </span>
            {accountInfo?.organization && (
              <span className="claude-status-btn claude-account-info" title={`${accountInfo.email || ''} (${accountInfo.subscriptionType || 'unknown'})`}>
                {accountInfo.organization}
              </span>
            )}
          </div>

          <div className="claude-input-actions">
            <span
              className="claude-status-btn"
              onClick={handleSelectImages}
              title="Attach images (max 5)"
            >
              &#128206;
            </span>
            {isStreaming ? (
              <button
                className="claude-send-btn claude-stop-btn"
                onClick={handleStop}
                title="Stop (Esc)"
              >
                ■
              </button>
            ) : (
              <button
                className="claude-send-btn"
                onClick={handleSend}
                disabled={false}
                title="Send message"
              >
                ▶
              </button>
            )}
          </div>
        </div>
      </div>
      )}

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
                  title="Copy all prompts"
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
                        title="Copy this prompt"
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

      {/* Status lines */}
      <div className="claude-statuslines">
        <div className="claude-statusline">
          {gitBranch && <span className="claude-statusline-item claude-statusline-branch">[{gitBranch}]</span>}
          {currentModel && <span className="claude-statusline-item">{currentModel}</span>}
          {sessionMeta && sessionMeta.contextWindow > 0 && (
            <span className="claude-statusline-item" title={`${(sessionMeta.inputTokens + sessionMeta.outputTokens).toLocaleString()} / ${sessionMeta.contextWindow.toLocaleString()} tokens`}>
              ctx {Math.round(((sessionMeta.inputTokens + sessionMeta.outputTokens) / sessionMeta.contextWindow) * 100)}%
            </span>
          )}
          {sessionMeta && sessionMeta.totalCost > 0 && (
            <span className="claude-statusline-item">${sessionMeta.totalCost.toFixed(4)}</span>
          )}
          {claudeUsage && claudeUsage.fiveHour != null && (() => {
            const fmtRemaining = (d: Date) => {
              const ms = d.getTime() - Date.now()
              if (ms <= 0) return '0m'
              const h = Math.floor(ms / 3600000)
              const m = Math.floor((ms % 3600000) / 60000)
              return h > 24 ? `${Math.floor(h / 24)}d${h % 24}h` : h > 0 ? `${h}h${m}m` : `${m}m`
            }
            const fiveReset = claudeUsage.fiveHourReset ? fmtRemaining(new Date(claudeUsage.fiveHourReset)) : null
            const sevenReset = claudeUsage.sevenDayReset ? fmtRemaining(new Date(claudeUsage.sevenDayReset)) : null
            return (
              <span
                className={`claude-statusline-item${claudeUsage.fiveHour > 80 ? ' claude-usage-high' : claudeUsage.fiveHour > 50 ? ' claude-usage-mid' : ''}`}
              >
                5h:{Math.round(claudeUsage.fiveHour)}%{fiveReset ? ` ↻${fiveReset}` : ''} · 7d:{Math.round(claudeUsage.sevenDay ?? 0)}%{sevenReset ? ` ↻${sevenReset}` : ''}
              </span>
            )
          })()}
        </div>
        <div className="claude-statusline">
          <span
            className="claude-statusline-item claude-statusline-clickable"
            onClick={async () => {
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
            }}
            title={sessionMeta?.sdkSessionId
              ? `SDK Session: ${sessionMeta.sdkSessionId}\nPanel: ${sessionId}\nClick to resume a session`
              : `Panel: ${sessionId}\nClick to resume a session`
            }
          >
            {sessionMeta?.sdkSessionId
              ? sessionMeta.sdkSessionId.slice(0, 8)
              : sessionId.slice(0, 8)
            }
          </span>
          {sessionMeta && (
            <span className="claude-statusline-item" title={`in: ${sessionMeta.inputTokens.toLocaleString()} / out: ${sessionMeta.outputTokens.toLocaleString()}`}>
              {(sessionMeta.inputTokens + sessionMeta.outputTokens).toLocaleString()} tok
            </span>
          )}
          {sessionMeta && sessionMeta.numTurns > 0 && (
            <span className="claude-statusline-item">{sessionMeta.numTurns} turns</span>
          )}
          {sessionMeta && sessionMeta.durationMs > 0 && (
            <span className="claude-statusline-item">{(sessionMeta.durationMs / 1000).toFixed(1)}s</span>
          )}
          <span
            className="claude-statusline-item claude-statusline-clickable"
            onClick={() => setShowPromptHistory(true)}
            title="View prompt history"
          >prompts</span>
        </div>
      </div>
    </div>
  )
}
