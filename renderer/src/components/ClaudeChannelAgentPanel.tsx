import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import { CLAUDE_EFFORT_MODES, effortLevelForClaudeMode, isUltracodeEffortMode } from '../types'
import {
  CLAUDE_BUILTIN_MODELS,
  autoCompactWindowForClaudeSelection,
  claudeModelValueForRow,
  displayNameForClaudeSelection,
  groupClaudeModelRows,
  normalizeClaudeModelSelection,
  sdkModelForClaudeSelection,
  type ClaudeCompactWindow,
} from '../utils/claude-model-presets'
import {
  type ClaudeChannelCapabilities,
  type ClaudeChannelEntry,
  type ClaudeChannelStatus,
  type ClaudeChannelUsage,
  claudeChannelMessageClass,
  isRecord,
  normalizeAssistantFrame,
  normalizeClaudeChannelMessage,
  normalizeThinkingFrame,
  normalizeToolResultFrame,
  normalizeToolUseFrame,
  normalizeUsageFrame,
} from '../utils/claude-channel-events'

interface ClaudeChannelAgentPanelProps {
  sessionId: string
  cwd: string
  isActive: boolean
  workspaceId?: string
  onClose: (id: string) => void
  showUserMsg?: boolean
  showAssistantMsg?: boolean
}

type ClaudeChannelControls = {
  model: string
  permissionMode: string
  effort: string
}

const PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'bypassPlan', 'plan'] as const
const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: 'Default',
  auto: 'Auto (AI-reviewed)',
  acceptEdits: 'Accept edits',
  dontAsk: 'Never ask (deny)',
  bypassPermissions: 'Bypass permissions',
  bypassPlan: 'Bypass plan',
  plan: 'Plan mode',
}

function formatChannelTimestamp(timestamp: number): string {
  if (!timestamp) return ''
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function includeCurrentOption(options: readonly string[], current: string): string[] {
  return current && !options.includes(current) ? [current, ...options] : [...options]
}

function extractErrorMessage(value: unknown, fallback = 'Unknown error'): string {
  if (value == null) return fallback
  if (value instanceof Error) return value.message || fallback
  if (typeof value === 'string') return value || fallback
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.message === 'string' && obj.message) return obj.message
    if (typeof obj.error === 'string' && obj.error) return obj.error
    try {
      const json = JSON.stringify(value)
      if (json && json !== '{}') return json
    } catch {
      // fall through
    }
  }
  return String(value) || fallback
}

function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/\r/g, '')
    .trim()
}

export const ClaudeChannelAgentPanel = memo(function ClaudeChannelAgentPanel({
  sessionId,
  cwd,
  isActive,
  workspaceId,
  onClose,
  showUserMsg = true,
  showAssistantMsg = true,
}: Readonly<ClaudeChannelAgentPanelProps>) {
  const [status, setStatus] = useState<ClaudeChannelStatus>('starting')
  const [channelStatus, setChannelStatus] = useState('unknown')
  const [capabilities, setCapabilities] = useState<ClaudeChannelCapabilities | null>(null)
  const [messages, setMessages] = useState<ClaudeChannelEntry[]>([])
  const [usage, setUsage] = useState<ClaudeChannelUsage | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [restartToken, setRestartToken] = useState(0)
  const [showModelList, setShowModelList] = useState(false)
  const [controls, setControls] = useState<ClaudeChannelControls>({
    model: (() => {
      const terminal = workspaceStore.getState().terminals.find(item => item.id === sessionId)
      return normalizeClaudeModelSelection(terminal?.model || settingsStore.getSettings().defaultClaudeModel) || ''
    })(),
    permissionMode: 'bypassPermissions',
    effort: settingsStore.getSettings().defaultEffort || 'high',
  })
  const listRef = useRef<HTMLDivElement | null>(null)
  const controlsRef = useRef(controls)

  const isDebug = host.debug.isDebugMode === true

  useEffect(() => {
    controlsRef.current = controls
  }, [controls])

  useEffect(() => {
    if (!isDebug) {
      setStatus('error')
      setError('Claude Channel Agent is available only when BAT_DEBUG is enabled.')
      return
    }
    let cancelled = false
    const appendEntry = (entry: ClaudeChannelEntry | null) => {
      if (!entry || entry.sessionId !== sessionId) return
      setMessages(prev => {
        if (prev.some(existing => existing.id === entry.id)) return prev
        return [...prev, entry]
      })
    }
    const unsubs = [
      host.claudeChannel.onMessage((payload: unknown) => {
        const message = normalizeClaudeChannelMessage(payload)
        if (!message || message.sessionId !== sessionId) return
        setMessages(prev => {
          if (prev.some(existing => existing.id === message.id)) return prev
          return [...prev, { ...message, role: message.role }]
        })
      }),
      host.claudeChannel.onAssistant((payload: unknown) => {
        appendEntry(normalizeAssistantFrame(payload))
      }),
      host.claudeChannel.onToolUse((payload: unknown) => {
        appendEntry(normalizeToolUseFrame(payload))
      }),
      host.claudeChannel.onToolResult((payload: unknown) => {
        appendEntry(normalizeToolResultFrame(payload))
      }),
      host.claudeChannel.onThinking((payload: unknown) => {
        appendEntry(normalizeThinkingFrame(payload))
      }),
      host.claudeChannel.onUsage((payload: unknown) => {
        const next = normalizeUsageFrame(payload)
        if (next) setUsage(next)
      }),
      host.claudeChannel.onStatus((payload: unknown) => {
        if (!isRecord(payload) || payload.sessionId !== sessionId) return
        if (typeof payload.status === 'string') setStatus(payload.status as ClaudeChannelStatus)
        if (typeof payload.channelStatus === 'string') setChannelStatus(payload.channelStatus)
        if (payload.status === 'error' && typeof payload.error === 'string') setError(sanitizeTerminalText(payload.error))
      }),
    ]

    ;(async () => {
      try {
        setStatus('starting')
        setError(null)
        const detected = await host.claudeChannel.getCapabilities()
        if (cancelled || !isRecord(detected)) return
        const detectedCaps = detected as unknown as ClaudeChannelCapabilities
        setCapabilities(detectedCaps)
        const selected = controlsRef.current
        const options: Record<string, unknown> = { cwd, workspaceId }
        const sdkModel = sdkModelForClaudeSelection(selected.model)
        if (detectedCaps.supportsModel && sdkModel) options.model = sdkModel
        if (detectedCaps.supportsPermissionMode && selected.permissionMode) options.permissionMode = selected.permissionMode
        const runtimeEffort = effortLevelForClaudeMode(selected.effort)
        if (detectedCaps.supportsThinkingEffort && runtimeEffort) options.effort = runtimeEffort
        if (isUltracodeEffortMode(selected.effort)) options.ultracode = true
        const compactWindow = autoCompactWindowForClaudeSelection(selected.model, settingsStore.getSettings().autoCompactWindow)
        if (detectedCaps.supportsCompactWindow && compactWindow) {
          options.autoCompactWindow = compactWindow
        }
        const result = await host.claudeChannel.startSession(sessionId, options)
        if (cancelled || !isRecord(result)) return
        const caps = isRecord(result.capabilities) ? result.capabilities as unknown as ClaudeChannelCapabilities : null
        if (caps) setCapabilities(caps)
        if (result.ok === false) {
          setStatus('error')
          setError(sanitizeTerminalText(typeof result.error === 'string' ? result.error : caps?.error || 'Claude Channel Agent failed to start.'))
          return
        }
        setStatus(typeof result.status === 'string' ? result.status as ClaudeChannelStatus : 'ready')
        setChannelStatus(typeof result.channelStatus === 'string' ? result.channelStatus : 'connected')
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        const message = extractErrorMessage(err, 'Claude Channel Agent failed to start.')
        host.debug.log(`[claude-channel] startSession failed: ${message} (raw: ${(() => { try { return JSON.stringify(err) } catch { return String(err) } })()})`)
        setError(sanitizeTerminalText(message))
      }
    })()

    return () => {
      cancelled = true
      for (const unsub of unsubs) unsub?.()
      void host.claudeChannel.stopSession(sessionId).catch(() => {})
    }
  }, [cwd, isDebug, restartToken, sessionId, workspaceId])

  useEffect(() => {
    if (!isActive) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [isActive, messages.length])

  const visibleMessages = useMemo(() => messages.filter(message => {
    if (message.role === 'user') return showUserMsg
    if (message.role === 'assistant') return showAssistantMsg
    return true
  }), [messages, showAssistantMsg, showUserMsg])

  const send = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || isSending || status === 'error') return
    setInput('')
    setIsSending(true)
    setError(null)
    try {
      await host.claudeChannel.sendMessage(sessionId, prompt, `channel-user-${Date.now()}`)
    } catch (err) {
      const message = extractErrorMessage(err, 'Send failed.')
      host.debug.log(`[claude-channel] sendMessage failed: ${message} (raw: ${(() => { try { return JSON.stringify(err) } catch { return String(err) } })()})`)
      setError(sanitizeTerminalText(message))
    } finally {
      setIsSending(false)
    }
  }, [input, isSending, sessionId, status])

  const stop = useCallback(async () => {
    await host.claudeChannel.stopSession(sessionId)
    setStatus('stopped')
    setChannelStatus('disconnected')
  }, [sessionId])

  const restart = useCallback(async () => {
    await host.claudeChannel.stopSession(sessionId).catch(() => {})
    setMessages([])
    setStatus('starting')
    setChannelStatus('connecting')
    setRestartToken(value => value + 1)
  }, [sessionId])

  const setControl = useCallback((key: keyof ClaudeChannelControls, value: string) => {
    setControls(prev => ({ ...prev, [key]: value }))
  }, [])

  const effortOptions = useMemo(() => includeCurrentOption(CLAUDE_EFFORT_MODES, controls.effort), [controls.effort])
  const currentModelLabel = useMemo(() => displayNameForClaudeSelection(controls.model), [controls.model])
  const currentSdkModel = useMemo(() => sdkModelForClaudeSelection(controls.model) || controls.model, [controls.model])
  const modelRows = useMemo(() => {
    const seen = new Set<string>()
    return groupClaudeModelRows(CLAUDE_BUILTIN_MODELS.filter(model => {
      if (!model.value || seen.has(model.value)) return false
      seen.add(model.value)
      return true
    }))
  }, [])
  // Compact window of the current selection, carried over when switching models.
  const activeCompactWindow = useMemo<ClaudeCompactWindow | undefined>(() => {
    for (const row of modelRows) {
      const option = row.options.find(candidate => candidate.value === controls.model)
      if (option) return option.window
    }
    return undefined
  }, [modelRows, controls.model])

  const selectModel = useCallback((model: string) => {
    const normalized = normalizeClaudeModelSelection(model) || model
    setControl('model', normalized)
    workspaceStore.updateTerminalModel(sessionId, normalized)
    setShowModelList(false)
  }, [sessionId, setControl])

  const cyclePermissionMode = useCallback(() => {
    const idx = PERMISSION_MODES.indexOf(controls.permissionMode as typeof PERMISSION_MODES[number])
    const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]
    setControl('permissionMode', next)
  }, [controls.permissionMode, setControl])

  const canSend = isDebug && status !== 'error' && status !== 'stopped' && channelStatus === 'connected'
  const statusTitle = [
    `Channel: ${channelStatus}`,
    `Status: ${status}`,
    capabilities?.cliPath ? `Claude CLI: ${capabilities.cliPath}` : null,
    capabilities?.cliVersion ? `Claude ${capabilities.cliVersion}` : null,
  ].filter(Boolean).join('\n')

  return (
    <div
      className="claude-agent-panel claude-channel-panel"
      style={{ '--agent-color': '#f97316' } as CSSProperties}
    >
      <div className="claude-messages-shell">
        <div ref={listRef} className="claude-messages claude-timeline claude-channel-messages">
          {visibleMessages.length === 0 ? (
            <div className="tl-item">
              <div className="tl-dot dot-system" />
              <div className="tl-content claude-message-system">
                Channel messages will appear here after the Claude Code session starts.
              </div>
            </div>
          ) : visibleMessages.map(message => {
            const dotClass = (() => {
              switch (message.role) {
                case 'user': return 'dot-user'
                case 'assistant': return 'dot-assistant'
                case 'tool_use': return 'dot-tool-use'
                case 'tool_result': return message.isError ? 'dot-error' : 'dot-tool-result'
                case 'thinking': return 'dot-thinking'
                default: return 'dot-system'
              }
            })()
            const contentClass = (() => {
              switch (message.role) {
                case 'user': return 'claude-message-user'
                case 'assistant': return 'claude-message-assistant'
                case 'tool_use': return 'claude-message-tool-use'
                case 'tool_result': return `claude-message-tool-result${message.isError ? ' claude-message-tool-result-error' : ''}`
                case 'thinking': return 'claude-message-thinking'
                default: return 'claude-message-system'
              }
            })()
            let body: JSX.Element | string
            if (message.role === 'tool_use') {
              let inputPreview = ''
              if (message.toolInput != null) {
                try {
                  const text = typeof message.toolInput === 'string'
                    ? message.toolInput
                    : JSON.stringify(message.toolInput)
                  inputPreview = text.length > 160 ? `${text.slice(0, 160)}…` : text
                } catch {
                  inputPreview = String(message.toolInput)
                }
              }
              body = (
                <>
                  <span className="claude-tool-name">⚙ {message.toolName || 'tool'}</span>
                  {inputPreview && <span className="claude-tool-input"> {inputPreview}</span>}
                </>
              )
            } else if (message.role === 'tool_result') {
              const preview = message.text.length > 240 ? `${message.text.slice(0, 240)}…` : message.text
              body = (
                <>
                  <span className="claude-tool-result-label">{message.isError ? '✗ tool error' : '✓ tool result'}</span>
                  {preview && <span className="claude-tool-result-preview"> {preview}</span>}
                </>
              )
            } else if (message.role === 'thinking') {
              body = (
                <>
                  <span className="claude-thinking-label">thinking</span>
                  <span className="claude-thinking-preview"> {message.text}</span>
                </>
              )
            } else {
              body = message.text
            }
            return (
              <div key={message.id} className={`tl-item claude-channel-message ${claudeChannelMessageClass(message.role)}`}>
                <div className={`tl-dot ${dotClass}`} />
                <div className={`tl-content ${contentClass}`}>
                  {body}
                  <span className="claude-msg-time">{formatChannelTimestamp(message.timestamp)}</span>
                </div>
              </div>
            )
          })}
          {error && (
            <div className="tl-item tl-item-system">
              <div className="tl-dot dot-error" />
              <div className="tl-content claude-message-system claude-channel-error-message">
                {error}
                <span className="claude-msg-time">{formatChannelTimestamp(Date.now())}</span>
              </div>
            </div>
          )}
          {status === 'running' && (
            <div className="tl-item">
              <div className="tl-dot dot-thinking" />
              <div className="tl-content claude-thinking">
                <span className="claude-thinking-text">Waiting for channel reply</span>
                <span className="claude-thinking-dots"><span>.</span><span>.</span><span>.</span></span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="claude-input-area claude-channel-input-area">
        <textarea
          className="claude-input claude-channel-input"
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          disabled={!canSend}
          placeholder="Type a message... (Enter to send, Shift+Tab to switch mode)"
        />
        <div className="claude-input-footer">
          <div className="claude-input-controls">
            <span
              className={`claude-status-btn claude-mode-${controls.permissionMode}`}
              onClick={cyclePermissionMode}
              title={`Permission: ${controls.permissionMode} (click to cycle; restart applies to the channel session)`}
            >
              {PERMISSION_MODE_LABELS[controls.permissionMode] || controls.permissionMode}
            </span>
            {controls.model && (
              <span
                className="claude-status-btn"
                onClick={() => setShowModelList(true)}
                title={`Model: ${currentModelLabel}${currentSdkModel !== controls.model ? ` (${currentSdkModel})` : ''} (restart applies to the channel session)`}
              >
                {'</>'} {currentModelLabel}
              </span>
            )}
            <select
              className="claude-effort-select"
              value={controls.effort}
              onChange={event => setControl('effort', event.target.value)}
              title="Thinking effort (restart applies to the channel session)"
            >
              {effortOptions.map(level => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
            <span className="claude-status-btn claude-channel-status-btn" title={statusTitle}>
              channel {channelStatus}
            </span>
          </div>
          <div className="claude-input-actions">
            {status === 'running' ? (
              <button
                className="claude-send-btn claude-stop-btn"
                onClick={() => void stop()}
                title="Stop channel session"
              >
                ■
              </button>
            ) : (
            <button
              className="claude-send-btn"
              onClick={() => void send()}
              disabled={!input.trim() || isSending || !canSend}
              title={canSend ? 'Send' : 'Channel is not connected'}
            >
              ▶
            </button>
            )}
          </div>
        </div>
      </div>

      {showModelList && (
        <div className="claude-resume-card">
          <div className="claude-permission-title">Select a model</div>
          <div className="claude-resume-list">
            {modelRows.map(row => {
              const selected = row.key === controls.model || row.options.some(option => option.value === controls.model)
              return (
                <div
                  key={row.key}
                  className={`claude-model-row${selected ? ' active' : ''}`}
                  onClick={() => selectModel(claudeModelValueForRow(row, activeCompactWindow))}
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
                          className={`claude-model-window${option.value === controls.model ? ' active' : ''}`}
                          title={option.window === null
                            ? `${row.key} · no early auto-compact`
                            : `${row.key} · auto-compact at ${option.window.toLocaleString()} tokens`}
                          onClick={event => {
                            event.stopPropagation()
                            selectModel(option.value)
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="claude-permission-hint">Restart applies model changes to the channel session. Esc to cancel.</div>
        </div>
      )}

      <div className="claude-statusline-bar attached">
        <div className="claude-statusline">
          <div className="claude-statusline-left">
            <span className="claude-statusline-item" title={`Panel: ${sessionId}`}>{sessionId.slice(0, 8)}</span>
            {controls.effort && <span className="claude-statusline-item" title={`effort: ${controls.effort}`}>{controls.effort}</span>}
            <span className="claude-statusline-item" title={statusTitle}>{channelStatus}</span>
            <span className="claude-statusline-item claude-statusline-clickable" onClick={restart} title="Restart channel session">restart</span>
          </div>
          <div className="claude-statusline-right">
            <span className="claude-statusline-item">channel</span>
            {usage && (usage.inputTokens != null || usage.outputTokens != null) && (
              <span
                className="claude-statusline-item"
                title={[
                  usage.model ? `model: ${usage.model}` : null,
                  usage.inputTokens != null ? `in: ${usage.inputTokens}` : null,
                  usage.outputTokens != null ? `out: ${usage.outputTokens}` : null,
                  usage.cacheReadInputTokens != null ? `cache read: ${usage.cacheReadInputTokens}` : null,
                  usage.cacheCreationInputTokens != null ? `cache write: ${usage.cacheCreationInputTokens}` : null,
                  usage.costUsd != null ? `$${usage.costUsd.toFixed(4)}` : null,
                ].filter(Boolean).join('\n')}
              >
                {`${usage.inputTokens ?? 0}↑/${usage.outputTokens ?? 0}↓`}
              </span>
            )}
            {capabilities?.cliVersion && <span className="claude-statusline-item">Claude {capabilities.cliVersion}</span>}
          </div>
        </div>
      </div>
    </div>
  )
})
