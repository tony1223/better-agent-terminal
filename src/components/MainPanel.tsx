import { useState, memo, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { TerminalInstance } from '../types'
import { TerminalPanel } from './TerminalPanel'
import { ActivityIndicator } from './ActivityIndicator'
import { PromptBox } from './PromptBox'
import { getAgentPreset } from '../types/agent-presets'
import { workspaceStore } from '../stores/workspace-store'

// Lazy load Claude Agent SDK (~240KB chunk) — only needed for claude-code terminals
const ClaudeAgentPanel = lazy(() => import('./ClaudeAgentPanel').then(m => ({ default: m.ClaudeAgentPanel })))

interface MainPanelProps {
  terminal: TerminalInstance
  isActive: boolean
  onClose: (id: string) => void
  onRestart: (id: string) => void
  workspaceId?: string
}

export const MainPanel = memo(function MainPanel({ terminal, isActive, onClose, onRestart, workspaceId }: Readonly<MainPanelProps>) {
  const isAgent = terminal.agentPreset && terminal.agentPreset !== 'none'
  const isClaudeCode = terminal.agentPreset === 'claude-code'
  const agentConfig = isAgent ? getAgentPreset(terminal.agentPreset!) : null
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(terminal.title)
  const [showPromptBox, setShowPromptBox] = useState(false)

  const handleDoubleClick = () => {
    setEditValue(terminal.title)
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
          title={t('terminal.doubleClickToRename')}
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
            <span>{terminal.title}</span>
          )}
        </div>
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
        {isClaudeCode ? (
          <Suspense fallback={<div className="loading-panel" />}>
            <ClaudeAgentPanel
              sessionId={terminal.id}
              cwd={terminal.cwd}
              isActive={isActive}
              workspaceId={workspaceId}
            />
          </Suspense>
        ) : (
          <TerminalPanel terminalId={terminal.id} isActive={isActive} />
        )}
      </div>
      {!isClaudeCode && showPromptBox && (
        <PromptBox terminalId={terminal.id} />
      )}
    </div>
  )
})
