import type { TerminalInstance } from '../types'
import { TerminalThumbnail } from './TerminalThumbnail'
import { getAgentPreset } from '../types/agent-presets'

interface ThumbnailBarProps {
  terminals: TerminalInstance[]
  focusedTerminalId: string | null
  onFocus: (id: string) => void
  onAddTerminal?: () => void
  showAddButton: boolean
}

export function ThumbnailBar({
  terminals,
  focusedTerminalId,
  onFocus,
  onAddTerminal,
  showAddButton
}: ThumbnailBarProps) {
  // Check if first terminal is an agent
  const firstTerminal = terminals[0]
  const isAgent = firstTerminal?.agentPreset && firstTerminal.agentPreset !== 'none'
  const label = isAgent ? (getAgentPreset(firstTerminal.agentPreset!)?.name || 'Agent') : 'Terminals'

  return (
    <div className="thumbnail-bar">
      <div className="thumbnail-bar-header">
        <span>{label}</span>
      </div>
      <div className="thumbnail-list">
        {terminals.map(terminal => (
          <TerminalThumbnail
            key={terminal.id}
            terminal={terminal}
            isActive={terminal.id === focusedTerminalId}
            onClick={() => onFocus(terminal.id)}
          />
        ))}
        {showAddButton && onAddTerminal && (
          <button className="add-terminal-btn" onClick={onAddTerminal}>
            +
          </button>
        )}
      </div>
    </div>
  )
}
