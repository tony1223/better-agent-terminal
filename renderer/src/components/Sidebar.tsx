import { host, isTauri } from '../host-api'
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workspace } from '../types'
import { WORKSPACE_COLORS } from '../types'
import { workspaceStore } from '../stores/workspace-store'
import { ActivityIndicator } from './ActivityIndicator'
import { NotificationBell } from './NotificationBell'
import { isTauriNativeDropInside, listenTauriNativeDrop } from '../utils/tauri-native-drop'
import {
  WORKSPACE_MOVE_MIME,
  WORKSPACE_MOVE_STORAGE_KEY,
  createWorkspaceMovePayload,
  dataTransferHasType,
  isWorkspaceMoveDropMatch,
  parseWorkspaceMovePayload,
  resolveWorkspaceMoveDrop,
  type WorkspaceMovePayload,
} from '../utils/workspace-move-drag'

function debugLog(...args: unknown[]): void {
  if (host.debug.isDebugMode !== true) return
  void host.debug.log(...args).catch(() => {})
}

function readStoredWorkspaceMove(): WorkspaceMovePayload | null {
  try {
    return parseWorkspaceMovePayload(localStorage.getItem(WORKSPACE_MOVE_STORAGE_KEY))
  } catch {
    return null
  }
}

function writeStoredWorkspaceMove(payload: WorkspaceMovePayload): void {
  try {
    localStorage.setItem(WORKSPACE_MOVE_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // ignore unavailable storage
  }
}

function clearStoredWorkspaceMove(payload?: WorkspaceMovePayload): void {
  try {
    if (payload) {
      const current = readStoredWorkspaceMove()
      if (
        current
        && (current.workspaceId !== payload.workspaceId || current.sourceWindowId !== payload.sourceWindowId)
      ) {
        return
      }
    }
    localStorage.removeItem(WORKSPACE_MOVE_STORAGE_KEY)
  } catch {
    // ignore unavailable storage
  }
}

function dataTransferTypes(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.types ?? [])
}

interface SidebarProps {
  width: number
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  windowId: string | null
  groups: string[]
  activeGroup: string | null
  activeProfileName?: string
  isRemoteConnected?: boolean
  onSetActiveGroup: (group: string | null) => void
  onSetWorkspaceGroup: (id: string, group: string | undefined) => void
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
  onRenameWorkspace: (id: string, alias: string) => void
  onReorderWorkspaces: (workspaceIds: string[]) => void
  onOpenEnvVars: (workspaceId: string) => void
  onDetachWorkspace: (workspaceId: string) => void
  onOpenProfiles: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  width,
  workspaces,
  activeWorkspaceId,
  windowId,
  groups,
  activeGroup,
  activeProfileName,
  isRemoteConnected,
  onSetActiveGroup,
  onSetWorkspaceGroup,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameWorkspace,
  onReorderWorkspaces,
  onOpenEnvVars,
  onDetachWorkspace,
  onOpenProfiles,
  onOpenSettings,
}: Readonly<SidebarProps>) {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragPosition, setDragPosition] = useState<'before' | 'after' | null>(null)
  const [externalDragOver, setExternalDragOver] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; workspaceId: string } | null>(null)
  const [githubUrl, setGithubUrl] = useState<string | null>(null)
  const [groupEditTarget, setGroupEditTarget] = useState<string | null>(null)
  const [groupEditValue, setGroupEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const groupInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const workspaceListRef = useRef<HTMLDivElement>(null)
  // Latest workspaces / reorder callback kept in refs so the native Tauri drop
  // listener can reorder without re-subscribing on every render.
  const workspacesRef = useRef(workspaces)
  workspacesRef.current = workspaces
  // Workspaces whose folder does not exist on the host (e.g. a list carried
  // over from another machine). fs.isDirectory is host-routed, so a remote
  // window asks the host. Re-checked when the list changes and on focus.
  const [missingFolderIds, setMissingFolderIds] = useState<Set<string>>(() => new Set())
  const folderPathKey = workspaces.map(w => `${w.id}|${w.folderPath}`).join(';')
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const targets = workspacesRef.current.filter(w => !!w.folderPath)
      const results = await Promise.all(targets.map(async w => {
        try {
          return [w.id, await host.fs.isDirectory(w.folderPath)] as const
        } catch {
          return [w.id, true] as const // unknown: do not flag
        }
      }))
      if (cancelled) return
      const missing = new Set(results.filter(([, ok]) => !ok).map(([id]) => id))
      setMissingFolderIds(prev => {
        if (prev.size === missing.size && [...prev].every(id => missing.has(id))) return prev
        return missing
      })
    }
    void check()
    const onFocus = () => { void check() }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [folderPathKey])
  const onReorderRef = useRef(onReorderWorkspaces)
  onReorderRef.current = onReorderWorkspaces
  // Windows WebView2 aborts in-page HTML5 drags immediately (dragstart→dragend
  // with no dragover/drop) while Tauri's native drag-drop handler is active, so
  // workspace reordering there must be driven by pointer events instead.
  const usePointerReorder = isTauri() && host.platform === 'win32'
  const pointerDragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null)
  const didPointerDragRef = useRef(false)

  // Filter workspaces by active group
  const filteredWorkspaces = activeGroup
    ? workspaces.filter(w => w.group === activeGroup)
    : workspaces

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  useEffect(() => {
    if (groupEditTarget && groupInputRef.current) {
      groupInputRef.current.focus()
      groupInputRef.current.select()
    }
  }, [groupEditTarget])

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    if (contextMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [contextMenu])

  const [agentResting, setAgentResting] = useState(false)

  // Fetch GitHub URL and agent resting state when context menu opens
  useEffect(() => {
    if (!contextMenu) { setGithubUrl(null); setAgentResting(false); return }
    const ws = workspaces.find(w => w.id === contextMenu.workspaceId)
    if (!ws) return
    host.git.getGithubUrl(ws.folderPath).then(url => setGithubUrl(url))
    // Check if agent session is resting
    const agent = workspaceStore.getAgentTerminal(contextMenu.workspaceId)
    if (agent) {
      host.claude.isResting(agent.id).then(r => setAgentResting(r)).catch(() => {})
    }
  }, [contextMenu, workspaces])

  // Adjust context menu position to stay within viewport
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) { setMenuPos(null); return }
    const rect = contextMenuRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let { x, y } = contextMenu
    if (y + rect.height > vh) y = Math.max(0, vh - rect.height - 4)
    if (x + rect.width > vw) x = Math.max(0, vw - rect.width - 4)
    setMenuPos({ x, y })
  }, [contextMenu])

  const moveWorkspaceToWindow = useCallback(async (sourceWindowId: string, targetWindowId: string, workspaceId: string, insertIndex: number) => {
    try {
      await workspaceStore.save()
    } catch (error) {
      debugLog('[Sidebar] target save before moveToWindow failed', {
        sourceWindowId,
        targetWindowId,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    debugLog('[Sidebar] moveToWindow requested', { sourceWindowId, targetWindowId, workspaceId, insertIndex })
    const ok = await host.workspace.moveToWindow(sourceWindowId, targetWindowId, workspaceId, insertIndex)
    debugLog('[Sidebar] moveToWindow result', { sourceWindowId, targetWindowId, workspaceId, ok })
    if (!ok) window.alert('Workspace move failed. Try saving both windows, then drag again.')
  }, [])

  const addDroppedWorkspaceFolders = useCallback(async (paths: string[]): Promise<number> => {
    let added = 0
    for (const filePath of paths) {
      const isDirectory = await host.fs.isDirectory(filePath).catch(() => false)
      if (!isDirectory) continue
      const name = filePath.split(/[/\\]/).filter(Boolean).pop() || 'Workspace'
      workspaceStore.addWorkspace(name, filePath)
      added++
    }
    if (added > 0) await workspaceStore.save()
    return added
  }, [])

  // Shared reorder applied by both the HTML5 drop handler (web/remote) and the
  // pointer-driven reorder (Windows, where the in-page HTML5 `drop` event never
  // fires while Tauri's native drag-drop handler is active).
  const applyWorkspaceReorder = useCallback((sourceId: string, targetId: string, position: 'before' | 'after') => {
    if (!sourceId || sourceId === targetId) return
    const currentOrder = workspacesRef.current.map(w => w.id)
    const draggedIndex = currentOrder.indexOf(sourceId)
    if (draggedIndex === -1 || !currentOrder.includes(targetId)) return
    currentOrder.splice(draggedIndex, 1)
    let newIndex = currentOrder.indexOf(targetId)
    if (position === 'after') newIndex += 1
    currentOrder.splice(newIndex, 0, sourceId)
    onReorderRef.current(currentOrder)
  }, [])

  // Hit-test a client Y coordinate against the rendered workspace rows to find
  // the drop target id and whether to insert before/after it.
  const findReorderTarget = useCallback((y: number | null): { id: string; position: 'before' | 'after' } | null => {
    const listEl = workspaceListRef.current
    if (!listEl || y === null) return null
    const items = Array.from(listEl.querySelectorAll<HTMLElement>('[data-workspace-id]'))
    if (items.length === 0) return null
    for (const item of items) {
      const rect = item.getBoundingClientRect()
      if (y < rect.bottom) {
        const midY = rect.top + rect.height / 2
        return { id: item.dataset.workspaceId!, position: y < midY ? 'before' : 'after' }
      }
    }
    return { id: items[items.length - 1].dataset.workspaceId!, position: 'after' }
  }, [])

  // Pointer-driven reorder (used where HTML5 DnD is unreliable, i.e. Windows
  // WebView2). Movement past a small threshold starts the drag; the row under
  // the cursor drives the before/after indicator; release applies the reorder.
  const handleReorderPointerDown = useCallback((e: React.PointerEvent, workspaceId: string) => {
    if (e.button !== 0 || editingId === workspaceId) return
    pointerDragRef.current = { id: workspaceId, startX: e.clientX, startY: e.clientY, active: false }
    didPointerDragRef.current = false
  }, [editingId])

  const handleReorderPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = pointerDragRef.current
    if (!drag) return
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return
      drag.active = true
      didPointerDragRef.current = true
      setDraggedId(drag.id)
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* capture unsupported */ }
    }
    e.preventDefault()
    const target = findReorderTarget(e.clientY)
    if (target && target.id !== drag.id) {
      setDragOverId(target.id)
      setDragPosition(target.position)
    } else {
      setDragOverId(null)
      setDragPosition(null)
    }
  }, [findReorderTarget])

  const handleReorderPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = pointerDragRef.current
    pointerDragRef.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* capture unsupported */ }
    if (drag?.active) {
      const rect = workspaceListRef.current?.getBoundingClientRect()
      const inside = rect
        && e.clientX >= rect.left && e.clientX <= rect.right
        && e.clientY >= rect.top - 24 && e.clientY <= rect.bottom + 24
      const target = inside ? findReorderTarget(e.clientY) : null
      debugLog('[Sidebar] pointer reorder drop', {
        workspaceId: drag.id,
        inside: Boolean(inside),
        targetId: target?.id ?? null,
        position: target?.position ?? null,
      })
      if (target && target.id !== drag.id) applyWorkspaceReorder(drag.id, target.id, target.position)
    }
    setDraggedId(null)
    setDragOverId(null)
    setDragPosition(null)
  }, [findReorderTarget, applyWorkspaceReorder])

  const handleReorderPointerCancel = useCallback((e: React.PointerEvent) => {
    pointerDragRef.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* capture unsupported */ }
    setDraggedId(null)
    setDragOverId(null)
    setDragPosition(null)
  }, [])

  useEffect(() => {
    return listenTauriNativeDrop((detail) => {
      const storedMove = readStoredWorkspaceMove()
      const nativeWorkspaceMove = resolveWorkspaceMoveDrop(
        { getData: () => '' },
        windowId,
        storedMove,
      )
      if (detail.type === 'drop' && detail.paths.length === 0 && isWorkspaceMoveDropMatch(nativeWorkspaceMove)) {
        const inside = isTauriNativeDropInside(detail, workspaceListRef.current)
        debugLog('[Sidebar] native workspace drop parsed', {
          targetWindowId: windowId,
          sourceWindowId: nativeWorkspaceMove.payload.sourceWindowId,
          workspaceId: nativeWorkspaceMove.payload.workspaceId,
          insideWorkspaceList: inside,
          x: detail.x,
          y: detail.y,
        })
        void moveWorkspaceToWindow(
          nativeWorkspaceMove.payload.sourceWindowId,
          windowId!,
          nativeWorkspaceMove.payload.workspaceId,
          workspaces.length,
        )
        setExternalDragOver(false)
        setDragOverId(null)
        setDragPosition(null)
        return
      }

      if (!isTauriNativeDropInside(detail, workspaceListRef.current)) {
        if (detail.type === 'drop' && detail.paths.length === 0 && storedMove) {
          debugLog('[Sidebar] native workspace drop ignored', {
            targetWindowId: windowId,
            reason: isWorkspaceMoveDropMatch(nativeWorkspaceMove) ? 'unexpected-match' : nativeWorkspaceMove.reason,
            storedSourceWindowId: storedMove.sourceWindowId,
            storedWorkspaceId: storedMove.workspaceId,
            x: detail.x,
            y: detail.y,
          })
        }
        if (detail.type === 'drop' || detail.type === 'leave') setExternalDragOver(false)
        return
      }
      if (draggedId) return
      if (detail.type === 'enter' || detail.type === 'over') {
        setExternalDragOver(!isRemoteConnected)
        return
      }
      setExternalDragOver(false)
      if (detail.type !== 'drop') return
      if (isRemoteConnected) {
        window.alert('Remote sessions can only add folders that exist on the host.')
        return
      }
      void addDroppedWorkspaceFolders(detail.paths)
    })
  }, [addDroppedWorkspaceFolders, draggedId, isRemoteConnected, moveWorkspaceToWindow, windowId, workspaces.length])

  // Context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent, workspaceId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, workspaceId })
  }, [])

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

  // Set Group via inline edit
  const handleSetGroup = useCallback((workspaceId: string) => {
    const workspace = workspaces.find(w => w.id === workspaceId)
    setGroupEditTarget(workspaceId)
    setGroupEditValue(workspace?.group || '')
    setContextMenu(null)
  }, [workspaces])

  const handleGroupEditSubmit = useCallback(() => {
    if (groupEditTarget) {
      const trimmed = groupEditValue.trim()
      onSetWorkspaceGroup(groupEditTarget, trimmed || undefined)
      setGroupEditTarget(null)
      setGroupEditValue('')
    }
  }, [groupEditTarget, groupEditValue, onSetWorkspaceGroup])

  const handleGroupEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleGroupEditSubmit()
    } else if (e.key === 'Escape') {
      setGroupEditTarget(null)
      setGroupEditValue('')
    }
  }, [handleGroupEditSubmit])

  const parseCrossWindowDrop = useCallback((dataTransfer: DataTransfer, context: string, logMiss = false): { workspaceId: string; sourceWindowId: string } | null => {
    const stored = readStoredWorkspaceMove()
    const result = resolveWorkspaceMoveDrop(dataTransfer, windowId, stored)
    if (isWorkspaceMoveDropMatch(result)) {
      debugLog('[Sidebar] cross-window workspace drop parsed', {
        context,
        targetWindowId: windowId,
        sourceWindowId: result.payload.sourceWindowId,
        workspaceId: result.payload.workspaceId,
        source: result.source,
        dataTransferTypes: dataTransferTypes(dataTransfer),
        hasStoredPayload: Boolean(stored),
      })
      return result.payload
    }
    if (logMiss) {
      debugLog('[Sidebar] cross-window workspace drop ignored', {
        context,
        targetWindowId: windowId,
        reason: result.reason,
        dataTransferTypes: dataTransferTypes(dataTransfer),
        hasStoredPayload: Boolean(stored),
        storedSourceWindowId: stored?.sourceWindowId,
        storedWorkspaceId: stored?.workspaceId,
      })
    }
    return null
  }, [windowId])

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, workspaceId: string) => {
    setDraggedId(workspaceId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', workspaceId)
    // Custom MIME for cross-window workspace moves
    if (windowId) {
      const payload = createWorkspaceMovePayload(workspaceId, windowId)
      e.dataTransfer.setData(WORKSPACE_MOVE_MIME, JSON.stringify(payload))
      // macOS/Tauri cross-window drags may preserve text/plain while dropping
      // custom MIME data, so keep the same payload in the plain fallback too.
      e.dataTransfer.setData('text/plain', JSON.stringify(payload))
      writeStoredWorkspaceMove(payload)
      debugLog('[Sidebar] workspace dragStart cross-window payload', {
        sourceWindowId: windowId,
        workspaceId,
        dataTransferTypes: dataTransferTypes(e.dataTransfer),
      })
      void workspaceStore.save().catch((error) => {
        debugLog('[Sidebar] source save on dragStart failed', {
          sourceWindowId: windowId,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    } else {
      debugLog('[Sidebar] workspace dragStart missing windowId; cross-window move disabled', {
        workspaceId,
        dataTransferTypes: dataTransferTypes(e.dataTransfer),
      })
    }
    requestAnimationFrame(() => {
      const target = e.target as HTMLElement
      target.classList.add('dragging')
    })
  }, [windowId])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    const target = e.target as HTMLElement
    target.classList.remove('dragging')
    const payload = windowId && draggedId
      ? { workspaceId: draggedId, sourceWindowId: windowId }
      : undefined
    debugLog('[Sidebar] workspace dragEnd', {
      sourceWindowId: windowId,
      workspaceId: draggedId,
      clearStoredPayload: Boolean(payload),
    })
    window.setTimeout(() => clearStoredWorkspaceMove(payload), 1000)
    setDraggedId(null)
    setDragOverId(null)
    setDragPosition(null)
  }, [draggedId, windowId])

  const handleDragOver = useCallback((e: React.DragEvent, workspaceId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    if (draggedId === workspaceId) return
    // For cross-window drags (no local draggedId), check MIME type
    if (
      !draggedId
      && !dataTransferHasType(e.dataTransfer, WORKSPACE_MOVE_MIME)
      && !dataTransferHasType(e.dataTransfer, 'text/plain')
      && !readStoredWorkspaceMove()
    ) return

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    const position = e.clientY < midY ? 'before' : 'after'

    setDragOverId(workspaceId)
    setDragPosition(position)
  }, [draggedId])

  const handleDragLeave = useCallback(() => {
    setDragOverId(null)
    setDragPosition(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault()

    // Check for cross-window drop
    const crossWindow = parseCrossWindowDrop(e.dataTransfer, 'workspace-item-drop', true)
    if (crossWindow) {
      e.stopPropagation() // prevent container onDrop from firing a second moveToWindow
      const targetIndex = workspaces.findIndex(w => w.id === targetId)
      const insertIndex = dragPosition === 'after' ? targetIndex + 1 : targetIndex
      void moveWorkspaceToWindow(
        crossWindow.sourceWindowId, windowId!, crossWindow.workspaceId, Math.max(0, insertIndex)
      )
      setDraggedId(null)
      setDragOverId(null)
      setDragPosition(null)
      return
    }

    if (!draggedId || draggedId === targetId) {
      setDraggedId(null)
      setDragOverId(null)
      setDragPosition(null)
      return
    }

    applyWorkspaceReorder(draggedId, targetId, dragPosition ?? 'before')

    setDraggedId(null)
    setDragOverId(null)
    setDragPosition(null)
  }, [draggedId, dragPosition, workspaces, applyWorkspaceReorder, windowId, parseCrossWindowDrop, moveWorkspaceToWindow])

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <span>{t('sidebar.workspaces')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {isRemoteConnected && (
            <span
              title={t('sidebar.connectedToRemote')}
              style={{ color: '#58a6ff', fontSize: 12, lineHeight: 1 }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 1l4 4m14 14l4 4M8.5 2.5a13 13 0 0 1 7 0M2.5 8.5a13 13 0 0 0 0 7M15.5 21.5a13 13 0 0 1-7 0M21.5 15.5a13 13 0 0 0 0-7" />
              </svg>
            </span>
          )}
          {activeProfileName && (
            <span
              className="sidebar-profile-badge"
              onClick={onOpenProfiles}
              title={t('sidebar.clickToManageProfiles')}
            >
              {activeProfileName}
            </span>
          )}
        </div>
      </div>
      {/* Group Filter */}
      {groups.length > 0 && (
        <div className="sidebar-group-filter">
          <select
            value={activeGroup || ''}
            onChange={(e) => onSetActiveGroup(e.target.value || null)}
          >
            <option value="">{t('sidebar.all')}</option>
            {groups.map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>
      )}
      <div
        ref={workspaceListRef}
        className={`workspace-list${externalDragOver ? ' external-drag-over' : ''}`}
        onDragOver={(e) => {
          // Only react to external file drops or cross-window workspace drags (not internal workspace reorder)
          if (draggedId) return
          if (
            dataTransferHasType(e.dataTransfer, WORKSPACE_MOVE_MIME)
            || dataTransferHasType(e.dataTransfer, 'text/plain')
            || readStoredWorkspaceMove()
          ) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            return
          }
          if (dataTransferHasType(e.dataTransfer, 'Files')) {
            e.preventDefault()
            if (isRemoteConnected) {
              e.dataTransfer.dropEffect = 'none'
              setExternalDragOver(false)
              return
            }
            e.dataTransfer.dropEffect = 'copy'
            setExternalDragOver(true)
          }
        }}
        onDragLeave={(e) => {
          // Only reset if leaving the workspace-list entirely
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
            setExternalDragOver(false)
            setDragOverId(null)
            setDragPosition(null)
          }
        }}
        onDrop={(e) => {
          setExternalDragOver(false)
          if (draggedId) return
          const dataTransfer = e.dataTransfer
          // Cross-window drop on container (append at end)
          const crossWindow = parseCrossWindowDrop(dataTransfer, 'workspace-list-drop', true)
          if (crossWindow) {
            e.preventDefault()
            void moveWorkspaceToWindow(
              crossWindow.sourceWindowId, windowId!, crossWindow.workspaceId, workspaces.length
            )
            setDragOverId(null)
            setDragPosition(null)
            return
          }
          e.preventDefault()
          if (isRemoteConnected && dataTransferHasType(dataTransfer, 'Files')) {
            window.alert('Remote sessions can only add folders that exist on the host.')
            setDragOverId(null)
            setDragPosition(null)
            return
          }
          // Under Tauri, native onDragDropEvent already added workspaces in
          // the useEffect listener above. The DOM drop event fires too, but
          // File.path is undefined so getPathForFile would basename-match
          // against an already-claimed cache entry and surface a spurious
          // "needs the host to expose paths" alert. Skip the DOM-path
          // workspace addition entirely under Tauri.
          if (isTauri() && dataTransferHasType(dataTransfer, 'Files')) {
            setDragOverId(null)
            setDragPosition(null)
            return
          }
          const files = Array.from(dataTransfer.files)
          const paths: string[] = []
          let pathlessSeen = false
          for (const file of files) {
            const filePath = host.shell.getPathForFile(file)
            if (filePath) {
              paths.push(filePath)
            } else {
              pathlessSeen = true
            }
          }
          void addDroppedWorkspaceFolders(paths).then((added) => {
            if (added === 0 && pathlessSeen) {
              window.alert('Drag-drop of folders to add as workspaces needs the host to expose paths; use the "Add workspace" button instead.')
            }
          })
        }}
      >
        {filteredWorkspaces.map(workspace => (
          <div
            key={workspace.id}
            data-workspace-id={workspace.id}
            className={`workspace-item ${workspace.id === activeWorkspaceId ? 'active' : ''} ${draggedId === workspace.id ? 'dragging' : ''} ${dragOverId === workspace.id ? `drag-over-${dragPosition}` : ''} ${missingFolderIds.has(workspace.id) ? 'folder-missing' : ''}`}
            onClick={() => {
              if (didPointerDragRef.current) { didPointerDragRef.current = false; return }
              onSelectWorkspace(workspace.id)
            }}
            onContextMenu={(e) => handleContextMenu(e, workspace.id)}
            draggable={!usePointerReorder}
            onDragStart={usePointerReorder ? undefined : (e) => handleDragStart(e, workspace.id)}
            onDragEnd={usePointerReorder ? undefined : handleDragEnd}
            onDragOver={usePointerReorder ? undefined : (e) => handleDragOver(e, workspace.id)}
            onDragLeave={usePointerReorder ? undefined : handleDragLeave}
            onDrop={usePointerReorder ? undefined : (e) => handleDrop(e, workspace.id)}
            onPointerDown={usePointerReorder ? (e) => handleReorderPointerDown(e, workspace.id) : undefined}
            onPointerMove={usePointerReorder ? handleReorderPointerMove : undefined}
            onPointerUp={usePointerReorder ? handleReorderPointerUp : undefined}
            onPointerCancel={usePointerReorder ? handleReorderPointerCancel : undefined}
          >
            {workspace.color && (
              <div className="workspace-color-bar" style={{ backgroundColor: workspace.color }} />
            )}
            <div className="workspace-item-content">
              <div className="drag-handle" title={t('sidebar.dragToReorder')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="9" cy="6" r="2"/>
                  <circle cx="15" cy="6" r="2"/>
                  <circle cx="9" cy="12" r="2"/>
                  <circle cx="15" cy="12" r="2"/>
                  <circle cx="9" cy="18" r="2"/>
                  <circle cx="15" cy="18" r="2"/>
                </svg>
              </div>
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
                    <span className="workspace-alias">
                      {missingFolderIds.has(workspace.id) && (
                        <span className="workspace-missing-badge" title={t('sidebar.folderMissing', { path: workspace.folderPath })}>⚠</span>
                      )}
                      {workspace.alias || workspace.name}
                    </span>
                    {groupEditTarget === workspace.id ? (
                      <input
                        ref={groupInputRef}
                        type="text"
                        className="workspace-rename-input"
                        value={groupEditValue}
                        onChange={(e) => setGroupEditValue(e.target.value)}
                        onBlur={handleGroupEditSubmit}
                        onKeyDown={handleGroupEditKeyDown}
                        onClick={(e) => e.stopPropagation()}
                        placeholder={t('sidebar.groupNamePlaceholder')}
                        style={{ fontSize: '11px' }}
                      />
                    ) : (
                      <span className="workspace-folder">
                        {workspace.group ? `[${workspace.group}] ` : ''}{workspace.name}
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="workspace-item-actions">
                <ActivityIndicator
                  workspaceId={workspace.id}
                  size="small"
                />
              </div>
            </div>
          </div>
        )
        )}
      </div>
      <div className="sidebar-footer">
        <NotificationBell />
        <button className="add-workspace-btn" onClick={onAddWorkspace}>
          {t('sidebar.addWorkspace')}
        </button>
        <div className="sidebar-footer-buttons">
          <button className="settings-btn" onClick={onOpenProfiles}>
            {t('sidebar.profiles')}
          </button>
          <button className="settings-btn" onClick={onOpenSettings}>
            {t('sidebar.settings')}
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="workspace-context-menu"
          style={menuPos
            ? { left: menuPos.x, top: menuPos.y }
            : { left: contextMenu.x, top: contextMenu.y, visibility: 'hidden' as const }
          }
        >
          <div
            className="context-menu-item"
            onClick={() => {
              const ws = workspaces.find(w => w.id === contextMenu.workspaceId)
              if (ws) host.shell.openPath(ws.folderPath)
              setContextMenu(null)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <polyline points="10 13 14 9 10 5" />
            </svg>
            {t('sidebar.openInExplorer')}
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              const ws = workspaces.find(w => w.id === contextMenu.workspaceId)
              if (ws) navigator.clipboard.writeText(ws.folderPath)
              setContextMenu(null)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {t('sidebar.copyPath')}
          </div>
          {githubUrl && (
            <div
              className="context-menu-item"
              onClick={() => {
                host.shell.openExternal(githubUrl)
                setContextMenu(null)
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
              </svg>
              {t('sidebar.openOnGithub')}
            </div>
          )}
          <div
            className="context-menu-item"
            onClick={() => handleSetGroup(contextMenu.workspaceId)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {t('sidebar.setGroup')}
          </div>
          {(() => {
            const ws = workspaces.find(w => w.id === contextMenu.workspaceId)
            return (
              <div className="context-menu-item context-menu-color-picker">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="13.5" cy="6.5" r="2.5" />
                  <circle cx="17.5" cy="10.5" r="2.5" />
                  <circle cx="8.5" cy="7.5" r="2.5" />
                  <circle cx="6.5" cy="12" r="2.5" />
                  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.3-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-5.5-4.5-9-10-9z" />
                </svg>
                {t('sidebar.setColor')}
                <div className="color-palette">
                  {WORKSPACE_COLORS.map(c => (
                    <div
                      key={c.id}
                      className={`color-dot ${ws?.color === c.value ? 'active' : ''}`}
                      style={{ backgroundColor: c.value }}
                      title={c.label}
                      onClick={(e) => {
                        e.stopPropagation()
                        workspaceStore.setWorkspaceColor(contextMenu.workspaceId, c.value)
                        setContextMenu(null)
                      }}
                    />
                  ))}
                  {ws?.color && (
                    <div
                      className="color-dot clear"
                      onClick={(e) => {
                        e.stopPropagation()
                        workspaceStore.setWorkspaceColor(contextMenu.workspaceId, undefined)
                        setContextMenu(null)
                      }}
                      title={t('sidebar.clearColor')}
                    >&#x2715;</div>
                  )}
                </div>
              </div>
            )
          })()}
          <div
            className="context-menu-item"
            onClick={() => {
              onOpenEnvVars(contextMenu.workspaceId)
              setContextMenu(null)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {t('sidebar.environmentVariables')}
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onDetachWorkspace(contextMenu.workspaceId)
              setContextMenu(null)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            {t('sidebar.detachToWindow')}
          </div>
          {(() => {
            const agent = workspaceStore.getAgentTerminal(contextMenu.workspaceId)
            if (!agent) return null
            return (
              <div
                className="context-menu-item"
                onClick={async () => {
                  if (agentResting) {
                    await host.claude.wakeSession(agent.id)
                  } else {
                    await host.claude.restSession(agent.id)
                  }
                  setContextMenu(null)
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {agentResting ? (
                    <>
                      <circle cx="12" cy="12" r="10" />
                      <polygon points="10 8 16 12 10 16 10 8" />
                    </>
                  ) : (
                    <>
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </>
                  )}
                </svg>
                {agentResting ? t('sidebar.wakeAgent') : t('sidebar.restAgent')}
              </div>
            )
          })()}
          <div className="context-menu-divider" />
          <div
            className="context-menu-item danger"
            onClick={() => {
              onRemoveWorkspace(contextMenu.workspaceId)
              setContextMenu(null)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            {t('sidebar.closeWorkspace')}
          </div>
        </div>
      )}
    </aside>
  )
}
