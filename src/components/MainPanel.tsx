import { useState } from 'react'
import type { TerminalInstance } from '../types'
import { TerminalPanel } from './TerminalPanel'
import { ActivityIndicator } from './ActivityIndicator'
import { getAgentPreset } from '../types/agent-presets'
import { workspaceStore } from '../stores/workspace-store'

interface MainPanelProps {
  terminal: TerminalInstance
  onClose: (id: string) => void
  onRestart: (id: string) => void
}

export function MainPanel({ terminal, onClose, onRestart }: Readonly<MainPanelProps>) {
  const isAgent = terminal.agentPreset && terminal.agentPreset !== 'none'
  const agentConfig = isAgent ? getAgentPreset(terminal.agentPreset!) : null
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(terminal.title)

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
          title="Double-click to rename"
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
          <button
            className="action-btn"
            onClick={() => onRestart(terminal.id)}
            title="Restart terminal"
          >
            ⟳
          </button>
          <button
            className="action-btn danger"
            onClick={() => onClose(terminal.id)}
            title="Close terminal"
          >
            ×
          </button>
        </div>
      </div>
      <div className="main-panel-content">
        <TerminalPanel terminalId={terminal.id} />
      </div>
    </div>
  )
}
