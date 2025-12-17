import type { TerminalInstance } from '../types'
import { TerminalThumbnail } from './TerminalThumbnail'

interface ThumbnailBarProps {
  terminals: TerminalInstance[]
  focusedTerminalId: string | null
  onFocus: (id: string) => void
  onAddTerminal?: () => void
  showAddButton: boolean
  collapsed: boolean
  onToggleCollapse: () => void
}

export function ThumbnailBar({
  terminals,
  focusedTerminalId,
  onFocus,
  onAddTerminal,
  showAddButton,
  collapsed,
  onToggleCollapse
}: ThumbnailBarProps) {
  const label = terminals.length > 0 && terminals[0].type === 'claude-code'
    ? 'Claude Code'
    : 'Terminals'

  return (
    <div className={`thumbnail-bar ${collapsed ? 'collapsed' : ''}`}>
      <div className="thumbnail-bar-header">
        <span>{label}</span>
        <button
          className="thumbnail-bar-toggle-btn"
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand terminals' : 'Collapse terminals'}
        >
          {collapsed ? '▲' : '▼'}
        </button>
      </div>
      {!collapsed && (
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
      )}
    </div>
  )
}
