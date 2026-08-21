import { host } from '../host-api'
import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TerminalInstance } from '../types'
import { TerminalThumbnail } from './TerminalThumbnail'
import type { AgentPreset } from '../types/agent-presets'
import { groupAgentPresetsForMenu, worktreeMenuName } from '../utils/agent-preset-menu'

interface ThumbnailBarProps {
  terminals: TerminalInstance[]
  focusedTerminalId: string | null
  onFocus: (id: string) => void
  onAddTerminal?: () => void
  onAddWorktreeTerminal?: () => void
  onAddAgent?: (presetId: string) => void
  onAddWorker?: (procfilePath?: string) => void
  detectedProcfiles?: string[]
  agentPresets?: AgentPreset[]
  onReorder?: (orderedIds: string[]) => void
  onCloseTerminal?: (id: string) => void
  showAddButton: boolean
  height?: number
  collapsed?: boolean
  onCollapse?: () => void
}

export function ThumbnailBar({
  terminals,
  focusedTerminalId,
  onFocus,
  onAddTerminal,
  onAddWorktreeTerminal,
  onAddAgent,
  onAddWorker,
  detectedProcfiles = [],
  agentPresets = [],
  onReorder,
  onCloseTerminal,
  showAddButton,
  height,
  collapsed = false,
  onCollapse
}: ThumbnailBarProps) {
  const { t } = useTranslation()
  const label = t('terminal.workspaceSessions')
  const switchWindowShortcut = host.platform === 'darwin' ? '⌘+`' : 'Ctrl+`'
  const switchSessionShortcut = host.platform === 'darwin' ? 'Ctrl+`' : 'Alt+`'
  const presetGroups = groupAgentPresetsForMenu(agentPresets)

  // All hooks must be declared before any conditional return (React rules of hooks)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropPosition, setDropPosition] = useState<'before' | 'after'>('before')
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; terminalId: string } | null>(null)
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const addMenuPopupRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const thumbnailListRef = useRef<HTMLDivElement>(null)
  const middlePanRef = useRef<{ startX: number; startScrollLeft: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const pointerDragRef = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
    dragging: boolean
  } | null>(null)
  const suppressClickRef = useRef(false)

  // Close menu on outside click
  useEffect(() => {
    if (!showAddMenu) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        addMenuRef.current && !addMenuRef.current.contains(target) &&
        addMenuPopupRef.current && !addMenuPopupRef.current.contains(target)
      ) {
        setShowAddMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showAddMenu])

  useEffect(() => {
    if (!contextMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) {
      setContextMenuPos(null)
      return
    }
    const rect = contextMenuRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let { x, y } = contextMenu
    if (x + rect.width > vw) x = Math.max(4, vw - rect.width - 4)
    if (y + rect.height > vh) y = Math.max(4, vh - rect.height - 4)
    setContextMenuPos({ x, y })
  }, [contextMenu])

  useEffect(() => {
    const clearMiddlePan = () => {
      middlePanRef.current = null
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!middlePanRef.current) return
      if ((e.buttons & 4) === 0) {
        clearMiddlePan()
        return
      }
      const el = thumbnailListRef.current
      if (!el) return
      e.preventDefault()
      el.scrollLeft = middlePanRef.current.startScrollLeft - (e.clientX - middlePanRef.current.startX)
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 1 || (e.buttons & 4) === 0) clearMiddlePan()
    }

    const handleVisibilityChange = () => {
      if (document.hidden) clearMiddlePan()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', clearMiddlePan)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', clearMiddlePan)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  const resolveDropTarget = useCallback((clientX: number, clientY: number) => {
    const list = thumbnailListRef.current
    if (!list) return null
    const element = document.elementFromPoint(clientX, clientY)
    const wrapper = element?.closest?.<HTMLElement>('[data-thumbnail-id]')
    if (!wrapper || !list.contains(wrapper)) return null
    const id = wrapper.dataset.thumbnailId
    if (!id) return null
    // Thumbnails are laid out horizontally — use the X axis so the
    // before/after indicator (left/right border) matches what the user sees.
    const rect = wrapper.getBoundingClientRect()
    const midX = rect.left + rect.width / 2
    return {
      id,
      position: clientX < midX ? 'before' as const : 'after' as const,
    }
  }, [])

  const applyReorder = useCallback((sourceId: string, targetId: string, position: 'before' | 'after') => {
    if (sourceId === targetId || !onReorder) return

    const currentOrder = terminals.map(t => t.id)
    const draggedIndex = currentOrder.indexOf(sourceId)
    if (draggedIndex === -1) return

    currentOrder.splice(draggedIndex, 1)
    let newIndex = currentOrder.indexOf(targetId)
    if (newIndex === -1) return
    if (position === 'after') newIndex += 1

    currentOrder.splice(newIndex, 0, sourceId)
    onReorder(currentOrder)
  }, [terminals, onReorder])

  const handlePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (!onReorder || e.button !== 0) return
    pointerDragRef.current = {
      id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [onReorder])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return

    const dx = Math.abs(e.clientX - drag.startX)
    const dy = Math.abs(e.clientY - drag.startY)
    if (!drag.dragging) {
      if (dx < 4 && dy < 4) return
      drag.dragging = true
      suppressClickRef.current = true
      setDraggedId(drag.id)
    }

    e.preventDefault()
    const target = resolveDropTarget(e.clientX, e.clientY)
    if (!target || target.id === drag.id) {
      setDropTargetId(null)
      return
    }
    setDropTargetId(target.id)
    setDropPosition(target.position)
  }, [resolveDropTarget])

  const finishPointerDrag = useCallback((e: React.PointerEvent) => {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return

    const target = drag.dragging ? resolveDropTarget(e.clientX, e.clientY) : null
    if (target && target.id !== drag.id) {
      applyReorder(drag.id, target.id, target.position)
    }

    pointerDragRef.current = null
    setDraggedId(null)
    setDropTargetId(null)
    if (drag.dragging) {
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch { /* pointer capture may already be gone */ }
  }, [applyReorder, resolveDropTarget])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the element (not entering a child)
    const related = e.relatedTarget as HTMLElement | null
    if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
      setDropTargetId(null)
    }
  }, [])

  const handleThumbnailContextMenu = useCallback((e: React.MouseEvent, terminalId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, terminalId })
  }, [])

  // Collapsed state - show icon bar
  if (collapsed) {
    return (
      <div
        className="collapsed-bar collapsed-bar-bottom"
        onClick={onCollapse}
        title={t('terminal.expandSessions')}
      >
        <div className="collapsed-bar-icon">🤖</div>
        <span className="collapsed-bar-label">{label}</span>
      </div>
    )
  }

  const style = height ? { height: `${height}px`, flex: 'none' } : undefined

  return (
    <div className="thumbnail-bar" style={style}>
      <div className="thumbnail-bar-header">
        <div className="thumbnail-bar-title">
          <span>{label}</span>
          <span
            className="shortcut-hint"
            title={`Switch BAT window: ${switchWindowShortcut}`}
          >
            Win {switchWindowShortcut}
          </span>
          <span
            className="shortcut-hint"
            title={`Switch session: ${switchSessionShortcut} / Shift+${switchSessionShortcut}`}
          >
            Sess {switchSessionShortcut}
          </span>
        </div>
        <div className="thumbnail-bar-actions">
          {onAddTerminal && (
            <div className="thumbnail-add-wrapper" ref={addMenuRef}>
              <button
                ref={addBtnRef}
                className="thumbnail-add-btn"
                onClick={() => {
                  setShowAddMenu(prev => {
                    if (!prev && addBtnRef.current) {
                      const rect = addBtnRef.current.getBoundingClientRect()
                      const menuHeight = 420
                      const spaceBelow = window.innerHeight - rect.bottom
                      const openUpward = spaceBelow < menuHeight && rect.top > menuHeight
                      setMenuStyle(openUpward
                        ? { bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right }
                        : { top: rect.bottom + 4, right: window.innerWidth - rect.right }
                      )
                    }
                    return !prev
                  })
                }}
                title={t('terminal.addTerminalOrAgent')}
              >
                +
              </button>
              {showAddMenu && createPortal(
                <div className="thumbnail-add-menu" ref={addMenuPopupRef} style={menuStyle}>
                  <div className="thumbnail-add-menu-section">Standard</div>
                  <div
                    className="thumbnail-add-menu-item"
                    onClick={() => { onAddTerminal(); setShowAddMenu(false) }}
                  >
                    <span className="thumbnail-add-menu-icon">⌘</span>
                    {t('terminal.terminalLabel')}
                  </div>
                  {[...presetGroups.standardAgents, ...presetGroups.standardCli].map(preset => (
                    <div
                      key={preset.id}
                      className="thumbnail-add-menu-item"
                      onClick={() => { onAddAgent?.(preset.id); setShowAddMenu(false) }}
                    >
                      <span className="thumbnail-add-menu-icon" style={{ color: preset.color }}>{preset.icon}</span>
                      {preset.name}
                      {preset.suggested && <span className="thumbnail-add-menu-suggested">suggested</span>}
                    </div>
                  ))}
                  {onAddWorktreeTerminal && (
                    <>
                      <div className="thumbnail-add-menu-separator" />
                      <div className="thumbnail-add-menu-section">Worktree</div>
                      <div
                        className="thumbnail-add-menu-item"
                        onClick={() => { onAddWorktreeTerminal(); setShowAddMenu(false) }}
                      >
                        <span className="thumbnail-add-menu-icon" style={{ color: '#22c55e' }}>🌳</span>
                        {worktreeMenuName(t('terminal.worktreeTerminalLabel'))}
                      </div>
                      {[...presetGroups.worktreeAgents, ...presetGroups.worktreeCli].map(preset => (
                        <div
                          key={preset.id}
                          className="thumbnail-add-menu-item"
                          onClick={() => { onAddAgent?.(preset.id); setShowAddMenu(false) }}
                        >
                          <span className="thumbnail-add-menu-icon" style={{ color: '#22c55e' }}>🌳</span>
                          {worktreeMenuName(preset.name)}
                          {preset.suggested && <span className="thumbnail-add-menu-suggested">suggested</span>}
                        </div>
                      ))}
                    </>
                  )}
                  {onAddWorker && (
                    <>
                      <div className="thumbnail-add-menu-separator" />
                      <div className="thumbnail-add-menu-section">Workers</div>
                      {detectedProcfiles.map(fp => (
                        <div
                          key={fp}
                          className="thumbnail-add-menu-item"
                          onClick={() => { onAddWorker(fp); setShowAddMenu(false) }}
                        >
                          <span className="thumbnail-add-menu-icon" style={{ color: '#56b6c2' }}>⚙</span>
                          Worker: {fp.split('/').pop()}
                        </div>
                      ))}
                      <div
                        className="thumbnail-add-menu-item"
                        onClick={() => { onAddWorker(); setShowAddMenu(false) }}
                      >
                        <span className="thumbnail-add-menu-icon" style={{ color: '#888' }}>📂</span>
                        Worker: Open File...
                      </div>
                      <div
                        className="thumbnail-add-menu-hint"
                        onClick={() => host.shell.openExternal('https://github.com/DarthSim/overmind')}
                      >
                        What is a Procfile?
                      </div>
                    </>
                  )}
                </div>,
                document.body
              )}
            </div>
          )}
          {onCollapse && (
            <button className="thumbnail-collapse-btn" onClick={onCollapse} title={t('terminal.collapsePanel')}>
              ▼
            </button>
          )}
        </div>
      </div>
      <div
        className="thumbnail-list"
        ref={thumbnailListRef}
        onWheel={(e) => {
          const el = thumbnailListRef.current
          if (!el || el.scrollWidth <= el.clientWidth) return
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
          if (delta === 0) return
          e.preventDefault()
          el.scrollLeft += delta
        }}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault()
            const el = thumbnailListRef.current
            if (el) middlePanRef.current = { startX: e.clientX, startScrollLeft: el.scrollLeft }
          }
        }}
        onMouseMove={(e) => {
          if (!middlePanRef.current) return
          e.preventDefault()
        }}
        onMouseUp={(e) => { if (e.button === 1) middlePanRef.current = null }}
        onAuxClick={(e) => { if (e.button === 1) e.preventDefault() }}
      >
        {terminals.map(terminal => (
          <div
            key={terminal.id}
            data-thumbnail-id={terminal.id}
            onPointerDown={(e) => handlePointerDown(e, terminal.id)}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointerDrag}
            onPointerCancel={finishPointerDrag}
            onDragLeave={handleDragLeave}
            onClickCapture={(e) => {
              if (!suppressClickRef.current) return
              suppressClickRef.current = false
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={() => onFocus(terminal.id)}
            className={`thumbnail-drag-wrapper${onReorder ? ' sortable' : ''}${
              dropTargetId === terminal.id && draggedId !== terminal.id
                ? ` drop-${dropPosition}`
                : ''
            }${draggedId === terminal.id ? ' dragging' : ''}`}
            onContextMenu={(e) => handleThumbnailContextMenu(e, terminal.id)}
          >
            <TerminalThumbnail
              terminal={terminal}
              isActive={terminal.id === focusedTerminalId}
            />
          </div>
        ))}
      </div>
      {contextMenu && onCloseTerminal && createPortal(
        <div
          ref={contextMenuRef}
          className="workspace-context-menu"
          style={contextMenuPos
            ? { left: contextMenuPos.x, top: contextMenuPos.y }
            : { left: contextMenu.x, top: contextMenu.y, visibility: 'hidden' as const }
          }
        >
          <div
            className="context-menu-item danger"
            onClick={() => {
              onCloseTerminal(contextMenu.terminalId)
              setContextMenu(null)
            }}
          >
            {t('terminal.closeTerminal')}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
