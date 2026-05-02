import { useState, memo, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { TerminalInstance } from '../types'
import { TerminalPanel } from './TerminalPanel'
import { ActivityIndicator } from './ActivityIndicator'
import { PromptBox } from './PromptBox'
import { getAgentPreset } from '../types/agent-presets'
import { workspaceStore } from '../stores/workspace-store'

// Lazy load heavy components
const ClaudeAgentPanel = lazy(() => import('./ClaudeAgentPanel').then(m => ({ default: m.ClaudeAgentPanel })))
const CodexAgentPanel = lazy(() => import('./CodexAgentPanel').then(m => ({ default: m.CodexAgentPanel })))
const OpenAIAgentPanel = lazy(() => import('./OpenAIAgentPanel').then(m => ({ default: m.OpenAIAgentPanel })))
const WorkerPanel = lazy(() => import('./WorkerPanel').then(m => ({ default: m.WorkerPanel })))

interface MainPanelProps {
  terminal: TerminalInstance
  isActive: boolean
  onClose: (id: string) => void
  onRestart: (id: string) => void
  onSwitchApiVersion?: (id: string) => void
  workspaceId?: string
  isRemoteConnected?: boolean
}

export const MainPanel = memo(function MainPanel({ terminal, isActive, onClose, onRestart, onSwitchApiVersion, workspaceId, isRemoteConnected = false }: Readonly<MainPanelProps>) {
  const isWorker = !!terminal.procfilePath
  const isAgent = terminal.agentPreset && terminal.agentPreset !== 'none'
  const isSdkManaged = terminal.agentPreset === 'claude-code' || terminal.agentPreset === 'claude-code-v2' || terminal.agentPreset === 'claude-code-worktree' || terminal.agentPreset === 'codex-agent' || terminal.agentPreset === 'codex-agent-worktree' || terminal.agentPreset === 'openai-agent'
  const isCodexAgent = terminal.agentPreset === 'codex-agent' || terminal.agentPreset === 'codex-agent-worktree'
  const isOpenAIAgent = terminal.agentPreset === 'openai-agent'
  const isClaudeCode = isSdkManaged
  const agentConfig = isAgent ? getAgentPreset(terminal.agentPreset!) : null
  const displayTitle = terminal.alias || terminal.title
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(displayTitle)
  const [showPromptBox, setShowPromptBox] = useState(false)
  const [showUserMsg, setShowUserMsg] = useState(true)
  const [showAssistantMsg, setShowAssistantMsg] = useState(true)
  const [showToolMsg, setShowToolMsg] = useState(true)
  const [showThinkingMsg, setShowThinkingMsg] = useState(true)

  const handleDoubleClick = () => {
    setEditValue(displayTitle)
    setIsEditing(true)
  }

  const handleSave = () => {
    if (editValue.trim()) {
      workspaceStore.renameTerminal(terminal.id, editValue.trim())
    }
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
    }
  }

  return (
    <div className="main-panel">
      <div className="main-panel-header">
        <div
          className={`main-panel-title ${isAgent ? 'agent-terminal' : ''}`}
          style={agentConfig ? { '--agent-color': agentConfig.color } as React.CSSProperties : undefined}
          onDoubleClick={handleDoubleClick}
          title={terminal.alias ? terminal.title : t('terminal.doubleClickToRename')}
        >
          {isAgent && <span>{agentConfig?.icon}</span>}
          {isEditing ? (
            <input
              type="text"
              className="terminal-name-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          ) : (
            <span>{displayTitle}</span>
          )}
          {terminal.worktreeBranch && (
            <span className="main-panel-worktree-label">🌳 {terminal.worktreeBranch}</span>
          )}
        </div>
        {isClaudeCode && !isWorker && (
          <div className="msg-filter-bar">
            <button
              className={`msg-filter-btn${showUserMsg ? ' active' : ''}`}
              onClick={() => setShowUserMsg(v => !v)}
              title={showUserMsg ? t('claude.hideUserMessages') : t('claude.showUserMessages')}
            >
              <span className="msg-filter-dot" style={{ background: 'var(--accent-color)' }} />
              You
            </button>
            <button
              className={`msg-filter-btn${showAssistantMsg ? ' active' : ''}`}
              onClick={() => setShowAssistantMsg(v => !v)}
              title={showAssistantMsg ? t('claude.hideAssistantMessages') : t('claude.showAssistantMessages')}
            >
              <span className="msg-filter-dot" style={{ background: 'var(--text-secondary)' }} />
              Message
            </button>
            <button
              className={`msg-filter-btn${showToolMsg ? ' active' : ''}`}
              onClick={() => setShowToolMsg(v => !v)}
              title={showToolMsg ? t('claude.hideToolMessages') : t('claude.showToolMessages')}
            >
              <span className="msg-filter-dot" style={{ background: '#10b981' }} />
              Tool
            </button>
            <button
              className={`msg-filter-btn${showThinkingMsg ? ' active' : ''}`}
              onClick={() => setShowThinkingMsg(v => !v)}
              title={showThinkingMsg ? t('claude.hideThinkingMessages') : t('claude.showThinkingMessages')}
            >
              <span className="msg-filter-dot" style={{ background: 'var(--claude-accent)' }} />
              Thinking
            </button>
          </div>
        )}
        <div className="main-panel-actions">
          <ActivityIndicator
            terminalId={terminal.id}
            size="small"
          />
          {isAgent && !isClaudeCode && (
            <button
              className={`action-btn ${showPromptBox ? 'active' : ''}`}
              onClick={() => setShowPromptBox(!showPromptBox)}
              title={showPromptBox ? t('terminal.hidePromptBox') : t('terminal.showPromptBox')}
            >
              💬
            </button>
          )}
          {/* V1/V2 switch buttons hidden — logic preserved in WorkspaceView.handleSwitchApiVersion */}
          <button
            className="action-btn"
            onClick={() => onRestart(terminal.id)}
            title={t('terminal.restartTerminal')}
          >
            ⟳
          </button>
          <button
            className="action-btn danger"
            onClick={() => onClose(terminal.id)}
            title={t('terminal.closeTerminal')}
          >
            ×
          </button>
        </div>
      </div>
      <div className="main-panel-content">
        {isWorker ? (
          <Suspense fallback={<div className="loading-panel" />}>
            <WorkerPanel
              terminalId={terminal.id}
              procfilePath={terminal.procfilePath!}
              cwd={terminal.cwd}
              isActive={isActive}
            />
          </Suspense>
        ) : isClaudeCode ? (
          <Suspense fallback={<div className="loading-panel" />}>
            {isOpenAIAgent ? (
              <OpenAIAgentPanel
                sessionId={terminal.id}
                cwd={terminal.cwd}
                isActive={isActive}
                workspaceId={workspaceId}
                onClose={onClose}
                showUserMsg={showUserMsg}
                showAssistantMsg={showAssistantMsg}
                showToolMsg={showToolMsg}
                showThinkingMsg={showThinkingMsg}
                isRemoteConnected={isRemoteConnected}
              />
            ) : isCodexAgent ? (
              <CodexAgentPanel
                sessionId={terminal.id}
                cwd={terminal.cwd}
                isActive={isActive}
                workspaceId={workspaceId}
                onClose={onClose}
                showUserMsg={showUserMsg}
                showAssistantMsg={showAssistantMsg}
                showToolMsg={showToolMsg}
                showThinkingMsg={showThinkingMsg}
                isRemoteConnected={isRemoteConnected}
              />
            ) : (
              <ClaudeAgentPanel
                sessionId={terminal.id}
                cwd={terminal.cwd}
                isActive={isActive}
                workspaceId={workspaceId}
                onClose={onClose}
                showUserMsg={showUserMsg}
                showAssistantMsg={showAssistantMsg}
                showToolMsg={showToolMsg}
                showThinkingMsg={showThinkingMsg}
                isRemoteConnected={isRemoteConnected}
              />
            )}
          </Suspense>
        ) : (
          <TerminalPanel
            terminalId={terminal.id}
            isActive={isActive}
            onClose={onClose}
            agentPreset={terminal.agentPreset}
          />
        )}
      </div>
      {!isClaudeCode && showPromptBox && (
        <PromptBox terminalId={terminal.id} />
      )}
    </div>
  )
})
