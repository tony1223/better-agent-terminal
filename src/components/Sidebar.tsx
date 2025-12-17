import { useState, useRef, useEffect } from 'react'
import type { Workspace } from '../types'
import { ActivityIndicator } from './ActivityIndicator'

interface SidebarProps {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
  onRenameWorkspace: (id: string, alias: string) => void
  onOpenSettings: () => void
  onOpenAbout: () => void
}

export function Sidebar({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameWorkspace,
  onOpenSettings,
  onOpenAbout
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  const handleDoubleClick = (workspace: Workspace, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(workspace.id)
    setEditValue(workspace.alias || workspace.name)
  }

  const handleRenameSubmit = (id: string) => {
    onRenameWorkspace(id, editValue)
    setEditingId(null)
  }

  const handleKeyDown = (id: string, e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit(id)
    } else if (e.key === 'Escape') {
      setEditingId(null)
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">Workspaces</div>
      <div className="workspace-list">
        {workspaces.map(workspace => (
          <div
            key={workspace.id}
            className={`workspace-item ${workspace.id === activeWorkspaceId ? 'active' : ''}`}
            onClick={() => onSelectWorkspace(workspace.id)}
          >
            <div className="workspace-item-content">
              <div
                className="workspace-item-info"
                onDoubleClick={(e) => handleDoubleClick(workspace, e)}
              >
                {editingId === workspace.id ? (
                  <input
                    ref={inputRef}
                    type="text"
                    className="workspace-rename-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => handleRenameSubmit(workspace.id)}
                    onKeyDown={(e) => handleKeyDown(workspace.id, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="workspace-alias">{workspace.alias || workspace.name}</span>
                    <span className="workspace-folder">{workspace.name}</span>
                  </>
                )}
              </div>
              <div className="workspace-item-actions">
                <ActivityIndicator
                  workspaceId={workspace.id}
                  size="small"
                />
                <button
                    className="remove-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemoveWorkspace(workspace.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          )
        )}
      </div>
      <div className="sidebar-footer">
        <button className="add-workspace-btn" onClick={onAddWorkspace}>
          + Add Workspace
        </button>
        <div className="sidebar-footer-buttons">
          <button className="settings-btn" onClick={onOpenSettings}>
            Settings
          </button>
          <button className="settings-btn" onClick={onOpenAbout}>
            About
          </button>
        </div>
      </div>
    </aside>
  )
}
