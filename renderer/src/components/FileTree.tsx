import { host } from '../host-api'
import { useState, useEffect, useCallback, useRef } from 'react'
import { HighlightedCode } from './PathLinker'
import { MarkdownPreview } from './MarkdownPreview'
import { CsvPreview } from './CsvPreview'
import { HtmlPreview } from './HtmlPreview'
import { CopyContentButton } from './CopyContentButton'
import { isProcfileName } from '../utils/procfile-parser'
import { formatErrorMessage } from '../utils/error-message'
import { canPreview, getFileExt, getRichPreviewKind, isScriptFile } from '../utils/file-preview'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface FileTreeProps {
  rootPath: string
  /** True when this workspace is served by a remote host — refreshes are
   *  debounced harder because every readdir is a network round-trip. */
  remoteMode?: boolean
}

/** Procfiles have no extension, so the shared table cannot classify them by
 *  itself — every caller here passes that fact in. */
function previewKindOf(name: string) {
  return canPreview(name, isProcfileName(name))
}

function FileTreeNode({
  entry, depth, selectedPath, onSelect, onContextMenu, refreshKey,
}: {
  entry: FileEntry; depth: number; selectedPath: string | null; onSelect: (entry: FileEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
  refreshKey: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const lastRefreshRef = useRef(refreshKey)

  // On refresh, re-fetch children IN PLACE instead of remounting the node, so
  // the expansion state (and the user's place in the tree) survives. Nodes are
  // keyed by path alone — refreshKey must NOT be part of the React key.
  useEffect(() => {
    if (lastRefreshRef.current === refreshKey) return
    lastRefreshRef.current = refreshKey
    if (!entry.isDirectory || children === null) return
    if (!expanded) {
      // Collapsed with stale cache: drop it so the next expand refetches.
      setChildren(null)
      return
    }
    let cancelled = false
    host.fs.readdir(entry.path)
      .then(next => { if (!cancelled) setChildren(next) })
      .catch(() => { if (!cancelled) setChildren([]) })
    return () => { cancelled = true }
  }, [refreshKey, entry.isDirectory, entry.path, expanded, children])

  const handleClick = useCallback(async () => {
    if (entry.isDirectory) {
      if (expanded) {
        setExpanded(false)
        return
      }
      if (children === null) {
        setLoading(true)
        try {
          const entries = await host.fs.readdir(entry.path)
          setChildren(entries)
        } catch {
          setChildren([])
        }
        setLoading(false)
      }
      setExpanded(true)
    } else {
      onSelect(entry)
    }
  }, [entry, expanded, children, onSelect])

  const icon = entry.isDirectory
    ? (expanded ? '📂' : '📁')
    : getFileIcon(entry.name)

  const isSelected = !entry.isDirectory && entry.path === selectedPath

  return (
    <>
      <div
        className={`file-tree-item ${entry.isDirectory ? 'file-tree-folder' : 'file-tree-file'} ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        <span className="file-tree-icon">{icon}</span>
        <span className="file-tree-name">{entry.name}</span>
        {loading && <span className="file-tree-loading">...</span>}
      </div>
      {expanded && children && children.map(child => (
        <FileTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          refreshKey={refreshKey}
        />
      ))}
    </>
  )
}

function getFileIcon(name: string): string {
  const ext = getFileExt(name)
  if (isProcfileName(name)) return '⚙️'
  switch (ext) {
    case 'ts': case 'tsx': return '🔷'
    case 'js': case 'jsx': return '🟡'
    case 'json': return '📋'
    case 'css': case 'scss': case 'less': return '🎨'
    case 'html': case 'htm': return '🌐'
    case 'md': return '📝'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': return '🖼️'
    case 'sh': case 'bash': case 'zsh': case 'ps1': case 'cmd': return '⚙️'
    case 'yml': case 'yaml': case 'toml': return '⚙️'
    case 'plist': case 'nuspec': return '⚙️'
    case 'lock': return '🔒'
    case 'py': return '🐍'
    case 'go': return '🔵'
    case 'rs': return '🦀'
    default: return '📄'
  }
}

function clearSearchHighlights(container: HTMLElement) {
  const existingMarks = container.querySelectorAll('mark.search-highlight')
  existingMarks.forEach(mark => {
    const parent = mark.parentNode
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
      parent.normalize()
    }
  })
}

function highlightSearchMatches(container: HTMLElement, query: string): number {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0

  const textNodes: Text[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('script, style, mark.search-highlight')) return NodeFilter.FILTER_REJECT
      return node.nodeValue?.toLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
    },
  })

  let currentNode: Text | null
  while ((currentNode = walker.nextNode() as Text | null)) {
    textNodes.push(currentNode)
  }

  let total = 0
  for (const textNode of textNodes) {
    const text = textNode.nodeValue || ''
    const lowerText = text.toLowerCase()
    const fragment = document.createDocumentFragment()
    let lastIndex = 0
    let matchIndex = lowerText.indexOf(normalizedQuery, lastIndex)

    while (matchIndex !== -1) {
      if (matchIndex > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, matchIndex)))
      }
      const mark = document.createElement('mark')
      mark.className = 'search-highlight'
      mark.dataset.matchIndex = String(total)
      mark.textContent = text.slice(matchIndex, matchIndex + normalizedQuery.length)
      fragment.appendChild(mark)
      total += 1
      lastIndex = matchIndex + normalizedQuery.length
      matchIndex = lowerText.indexOf(normalizedQuery, lastIndex)
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
    }
    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  return total
}

function FilePreview({ filePath, fileName, refreshKey }: { filePath: string; fileName: string; refreshKey: number }) {
  const [content, setContent] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'source' | 'rendered'>('rendered')
  const previewContentRef = useRef<HTMLDivElement>(null)
  const previewSearchInputRef = useRef<HTMLInputElement>(null)
  const [previewSearchOpen, setPreviewSearchOpen] = useState(false)
  const [previewSearchQuery, setPreviewSearchQuery] = useState('')
  const [previewMatchCount, setPreviewMatchCount] = useState(0)
  const [previewCurrentMatch, setPreviewCurrentMatch] = useState(0)
  const richKind = getRichPreviewKind(fileName)
  const canCopyScript = isScriptFile(fileName)

  // Which file the current content belongs to. A refreshKey bump for the SAME
  // file is a watch-triggered re-read: keep what is on screen and only swap
  // when the bytes actually changed. Clearing to "Loading..." on every bump
  // made the preview flash and lose its scroll position whenever anything in
  // the watched tree was touched — on remote hosts, where agents write files
  // constantly, that was every few hundred milliseconds even while reading an
  // untouched file.
  const loadedFileRef = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const fileKey = `${filePath}
${fileName}`
    const silentRefresh = loadedFileRef.current === fileKey
    loadedFileRef.current = fileKey
    if (!silentRefresh) {
      setContent(null)
      setImageUrl(null)
      setError(null)
      setLoading(true)
    }

    const type = previewKindOf(fileName)
    if (type === 'text') {
      host.fs.readFile(filePath).then(result => {
        if (cancelled) return
        if (result.error) {
          // A transient read failure mid-refresh should not blank a preview
          // that was fine a moment ago.
          if (!silentRefresh) {
            setError(result.error === 'File too large' ? `File too large (${Math.round((result.size || 0) / 1024)}KB)` : result.error)
          }
        } else {
          const next = result.content || ''
          setContent(prev => (prev === next ? prev : next))
          if (silentRefresh) setError(null)
        }
        setLoading(false)
      })
    } else if (type === 'image') {
      host.image.readAsDataUrl(filePath).then(url => {
        if (cancelled) return
        setImageUrl(prev => (prev === url ? prev : url))
        setLoading(false)
      }).catch(() => {
        if (cancelled) return
        if (!silentRefresh) setError('Failed to load image')
        setLoading(false)
      })
    } else if (type === 'pdf') {
      setLoading(false)
    } else {
      setError('Preview not available for this file type')
      setLoading(false)
    }

    return () => { cancelled = true }
  }, [filePath, fileName, refreshKey])

  useEffect(() => {
    if (previewSearchOpen) {
      setTimeout(() => previewSearchInputRef.current?.focus(), 50)
    }
  }, [previewSearchOpen])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && content !== null) {
        event.preventDefault()
        event.stopPropagation()
        setPreviewSearchOpen(true)
        return
      }
      if (event.key === 'Escape' && previewSearchOpen) {
        event.preventDefault()
        event.stopPropagation()
        setPreviewSearchOpen(false)
        setPreviewSearchQuery('')
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [content, previewSearchOpen])

  useEffect(() => {
    const container = previewContentRef.current
    if (!container) return

    clearSearchHighlights(container)
    const total = highlightSearchMatches(container, previewSearchQuery)
    setPreviewMatchCount(total)
    setPreviewCurrentMatch(total > 0 ? 1 : 0)

    if (total > 0) {
      const firstMatch = container.querySelector('mark.search-highlight[data-match-index="0"]')
      container.querySelectorAll('mark.search-highlight').forEach(mark => mark.classList.remove('current'))
      firstMatch?.classList.add('current')
      firstMatch?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [content, viewMode, previewSearchQuery])

  const navigatePreviewMatch = useCallback((direction: 1 | -1) => {
    const container = previewContentRef.current
    if (!container || previewMatchCount === 0) return

    const nextMatch = direction === 1
      ? (previewCurrentMatch % previewMatchCount) + 1
      : ((previewCurrentMatch - 2 + previewMatchCount) % previewMatchCount) + 1

    setPreviewCurrentMatch(nextMatch)
    container.querySelectorAll('mark.search-highlight').forEach(mark => mark.classList.remove('current'))
    const target = container.querySelector(`mark.search-highlight[data-match-index="${nextMatch - 1}"]`)
    target?.classList.add('current')
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [previewCurrentMatch, previewMatchCount])

  if (loading) {
    return <div className="file-preview-status">Loading...</div>
  }

  if (error) {
    return <div className="file-preview-status">{error}</div>
  }

  if (imageUrl) {
    return (
      <div className="file-preview-image">
        <img src={imageUrl} alt={fileName} />
      </div>
    )
  }

  if (previewKindOf(fileName) === 'pdf') {
    return (
      <div className="file-preview-pdf">
        <iframe
          src={`file://${filePath}`}
          style={{ width: '100%', height: '100%', border: 'none' }}
          title={`PDF Preview: ${fileName}`}
        />
      </div>
    )
  }

  if (content !== null) {
    return (
      <>
        {(richKind || canCopyScript) && (
          <div className="file-preview-mode-bar">
            {richKind && (
              <>
                <button className={`git-diff-mode-btn${viewMode === 'rendered' ? ' active' : ''}`} onClick={() => setViewMode('rendered')}>Preview</button>
                <button className={`git-diff-mode-btn${viewMode === 'source' ? ' active' : ''}`} onClick={() => setViewMode('source')}>Source</button>
              </>
            )}
            {canCopyScript && <CopyContentButton content={content} className="git-diff-mode-btn" />}
          </div>
        )}
        {previewSearchOpen && (
          <div className="file-preview-search">
            <input
              ref={previewSearchInputRef}
              className="file-preview-search-input"
              type="text"
              placeholder="Search in preview..."
              value={previewSearchQuery}
              onChange={(event) => setPreviewSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  navigatePreviewMatch(event.shiftKey ? -1 : 1)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setPreviewSearchOpen(false)
                  setPreviewSearchQuery('')
                }
              }}
            />
            {previewSearchQuery && (
              <span className="file-preview-search-count">
                {previewMatchCount > 0 ? `${previewCurrentMatch}/${previewMatchCount}` : 'No results'}
              </span>
            )}
            <button className="file-preview-search-nav" onClick={() => navigatePreviewMatch(-1)} disabled={previewMatchCount === 0} title="Previous (Shift+Enter)">↑</button>
            <button className="file-preview-search-nav" onClick={() => navigatePreviewMatch(1)} disabled={previewMatchCount === 0} title="Next (Enter)">↓</button>
          </div>
        )}
        <div className="file-preview-scroll" ref={previewContentRef}>
          {richKind && viewMode === 'rendered'
            ? (
              richKind === 'markdown' ? <MarkdownPreview content={content} />
              : richKind === 'csv' ? <CsvPreview text={content} />
              : <HtmlPreview html={content} title={fileName} />
            )
            : <HighlightedCode code={content} ext={getFileExt(fileName)} className="file-preview-text" />
          }
        </div>
      </>
    )
  }

  return null
}

// Trailing debounce for watch-triggered refreshes. Remote workspaces get a
// longer window: every refresh costs a network readdir per expanded folder,
// and host-side agents touch files constantly.
const WATCH_REFRESH_DEBOUNCE_LOCAL_MS = 400
const WATCH_REFRESH_DEBOUNCE_REMOTE_MS = 2000

export function FileTree({ rootPath, remoteMode = false }: Readonly<FileTreeProps>) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null)
  const restoredRef = useRef(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadRoot = useCallback(async () => {
    setLoading(true)
    try {
      const result = await host.fs.readdir(rootPath)
      setEntries(result)
    } catch {
      setEntries([])
    }
    setLoading(false)
  }, [rootPath])

  const handleRefresh = useCallback(() => {
    setRefreshKey(k => k + 1)
    loadRoot()
  }, [loadRoot])

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (selectedFile) return
        e.preventDefault()
        e.stopPropagation()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }
      if (e.key === 'Escape' && document.activeElement === searchInputRef.current && searchQuery) {
        e.preventDefault()
        setSearchQuery('')
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [searchQuery, selectedFile])

  // Restore scroll position ONCE per root, after the first load completes.
  // Restoring on every refresh fights the user's current scroll position —
  // refreshes no longer touch scrollTop at all (rows update in place).
  const scrollRestoredForRef = useRef<string | null>(null)
  useEffect(() => {
    if (loading || !listRef.current) return
    if (scrollRestoredForRef.current === rootPath) return
    scrollRestoredForRef.current = rootPath
    const saved = localStorage.getItem(`file-tree-scroll:${rootPath}`)
    if (saved) listRef.current.scrollTop = Number(saved)
  }, [loading, rootPath])

  // Watch for file system changes and auto-refresh, coalescing event bursts
  // with a trailing debounce (host-side agents touch files constantly, and on
  // remote workspaces each refresh is a network round-trip).
  const watchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    host.fs.watch(rootPath)
    const debounceMs = remoteMode ? WATCH_REFRESH_DEBOUNCE_REMOTE_MS : WATCH_REFRESH_DEBOUNCE_LOCAL_MS
    const unsubscribe = host.fs.onChanged((changedPath: string) => {
      if (changedPath !== rootPath) return
      if (watchDebounceRef.current) clearTimeout(watchDebounceRef.current)
      watchDebounceRef.current = setTimeout(() => {
        watchDebounceRef.current = null
        setRefreshKey(k => k + 1)
        loadRoot()
      }, debounceMs)
    })
    return () => {
      unsubscribe()
      host.fs.unwatch(rootPath)
      if (watchDebounceRef.current) {
        clearTimeout(watchDebounceRef.current)
        watchDebounceRef.current = null
      }
    }
  }, [rootPath, loadRoot, remoteMode])

  // Close context menu on outside click
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

  // Debounced search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await host.fs.search(rootPath, q)
        setSearchResults(results)
      } catch {
        setSearchResults([])
      }
      setSearching(false)
    }, 300)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [searchQuery, rootPath])

  // Restore last selected file on mount
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const storageKey = `file-tree-selected:${rootPath}`
    const saved = localStorage.getItem(storageKey)
    if (!saved) return
    try {
      const { path, name } = JSON.parse(saved)
      // Check if file still exists
      host.fs.readFile(path).then(result => {
        if (!result.error) {
          setSelectedFile({ path, name, isDirectory: false })
        } else {
          localStorage.removeItem(storageKey)
        }
      })
    } catch {
      localStorage.removeItem(storageKey)
    }
  }, [rootPath])

  const handleSelect = useCallback((entry: FileEntry) => {
    setSelectedFile(entry)
    localStorage.setItem(`file-tree-selected:${rootPath}`, JSON.stringify({ path: entry.path, name: entry.name }))
  }, [rootPath])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const getRelativePath = useCallback((filePath: string) => {
    // Normalize separators and compute relative path
    const norm = (p: string) => p.replace(/\\/g, '/')
    const rel = norm(filePath).replace(norm(rootPath), '').replace(/^\//, '')
    return rel
  }, [rootPath])

  const handleCopyRelativePath = useCallback(() => {
    if (!contextMenu) return
    navigator.clipboard.writeText(getRelativePath(contextMenu.entry.path))
    setContextMenu(null)
  }, [contextMenu, getRelativePath])

  const handleCopyAbsolutePath = useCallback(() => {
    if (!contextMenu) return
    navigator.clipboard.writeText(contextMenu.entry.path)
    setContextMenu(null)
  }, [contextMenu])

  const handleOpenInExplorer = useCallback(() => {
    if (!contextMenu) return
    const { path, isDirectory } = contextMenu.entry
    // A directory is opened; a file is revealed. Revealing a directory would
    // select it inside its *parent* rather than opening it, and opening a file's
    // parent (the old behaviour here) dumped the user in the folder without
    // saying which file they came for — no use when the point is to grab one
    // specific delivered file out of a crowded directory.
    if (isDirectory) {
      host.shell.openPath(path)
    } else {
      void host.shell.revealPath(path).catch(revealError => {
        void host.debug.log(
          `[FileTree] revealPath failed: ${formatErrorMessage(revealError, 'unknown error')}`,
        )
      })
    }
    setContextMenu(null)
  }, [contextMenu])

  // Upload: pick client-local files, copy/stream each into the destination
  // directory, then refresh so the new entries show up.
  const [uploading, setUploading] = useState(false)
  const uploadFilesTo = useCallback(async (destDir: string) => {
    let picked: string[] = []
    try {
      picked = await host.dialog.selectFiles()
    } catch {
      return
    }
    if (picked.length === 0) return
    setUploading(true)
    try {
      for (const localPath of picked) {
        try {
          await host.fs.uploadToDir(localPath, destDir)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          window.alert(`Upload failed: ${message}`)
        }
      }
    } finally {
      setUploading(false)
      handleRefresh()
    }
  }, [handleRefresh])

  const handleUploadToRoot = useCallback(() => {
    void uploadFilesTo(rootPath)
  }, [uploadFilesTo, rootPath])

  const handleUploadHere = useCallback(() => {
    if (!contextMenu) return
    const destDir = contextMenu.entry.isDirectory
      ? contextMenu.entry.path
      : contextMenu.entry.path.replace(/[\\/][^\\/]+$/, '') // parent dir
    setContextMenu(null)
    void uploadFilesTo(destDir)
  }, [contextMenu, uploadFilesTo])

  // Download: native save dialog, then local copy or chunked pull from the
  // remote host. Cancel resolves to null — nothing to report.
  const downloadFile = useCallback(async (sourcePath: string) => {
    try {
      await host.fs.downloadFile(sourcePath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      window.alert(`Download failed: ${message}`)
    }
  }, [])

  const handleDownloadFromMenu = useCallback(() => {
    if (!contextMenu) return
    const sourcePath = contextMenu.entry.path
    setContextMenu(null)
    void downloadFile(sourcePath)
  }, [contextMenu, downloadFile])

  // New folder: inline form under the header (same pattern as FolderPicker).
  // newFolderDir is the destination — root via the header button, or the
  // right-clicked folder via the context menu.
  const [newFolderDir, setNewFolderDir] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderError, setNewFolderError] = useState<string | null>(null)
  const newFolderInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (newFolderDir !== null) newFolderInputRef.current?.focus()
  }, [newFolderDir])

  const openNewFolderForm = useCallback((destDir: string) => {
    setNewFolderDir(destDir)
    setNewFolderName('')
    setNewFolderError(null)
  }, [])

  const closeNewFolderForm = useCallback(() => {
    setNewFolderDir(null)
    setNewFolderName('')
    setNewFolderError(null)
  }, [])

  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim()
    if (!name || newFolderDir === null) return
    setNewFolderError(null)
    const result = await host.fs.mkdir(newFolderDir, name)
    if ('error' in result) {
      setNewFolderError(result.error)
      return
    }
    closeNewFolderForm()
    handleRefresh()
  }, [newFolderName, newFolderDir, closeNewFolderForm, handleRefresh])

  const handleNewFolderHere = useCallback(() => {
    if (!contextMenu) return
    const destDir = contextMenu.entry.isDirectory
      ? contextMenu.entry.path
      : contextMenu.entry.path.replace(/[\\/][^\\/]+$/, '') // parent dir
    setContextMenu(null)
    openNewFolderForm(destDir)
  }, [contextMenu, openNewFolderForm])

  // Delete folder: deliberately strict — a modal that requires typing the
  // folder name before the (recursive, irreversible) delete is enabled.
  // The backend refuses non-directories, so this is folders-only by design.
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deleteInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (deleteTarget) deleteInputRef.current?.focus()
  }, [deleteTarget])

  const handleDeleteFolderFromMenu = useCallback(() => {
    if (!contextMenu || !contextMenu.entry.isDirectory) return
    setDeleteTarget(contextMenu.entry)
    setDeleteConfirmText('')
    setDeleteError(null)
    setContextMenu(null)
  }, [contextMenu])

  const closeDeleteDialog = useCallback(() => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteConfirmText('')
    setDeleteError(null)
  }, [deleting])

  const deleteConfirmed = deleteTarget !== null && deleteConfirmText.trim() === deleteTarget.name

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deleteConfirmText.trim() !== deleteTarget.name || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await host.fs.deletePath(deleteTarget.path)
      if ('error' in result) {
        setDeleteError(result.error)
        return
      }
      // Drop the preview if the selected file lived inside the deleted folder
      // (separator-suffixed so /a/foo doesn't also match /a/foobar).
      if (
        selectedFile &&
        (selectedFile.path.startsWith(`${deleteTarget.path}/`) ||
          selectedFile.path.startsWith(`${deleteTarget.path}\\`))
      ) {
        setSelectedFile(null)
        localStorage.removeItem(`file-tree-selected:${rootPath}`)
      }
      setDeleteTarget(null)
      setDeleteConfirmText('')
      handleRefresh()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleteConfirmText, deleting, selectedFile, rootPath, handleRefresh])

  if (loading && entries.length === 0) {
    return <div className="file-tree-empty">Loading...</div>
  }

  const displayEntries = searchResults !== null ? searchResults : entries

  return (
    <div className="file-tree-split">
      <div className="file-tree">
        <div className="file-tree-header">
          <input
            ref={searchInputRef}
            className="file-tree-search"
            type="text"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            className="file-tree-refresh-btn"
            onClick={() => openNewFolderForm(rootPath)}
            title="New folder"
          >📁+</button>
          <button
            className="file-tree-refresh-btn"
            onClick={handleUploadToRoot}
            disabled={uploading}
            title="Upload files"
          >{uploading ? '…' : '⤒'}</button>
          <button className="file-tree-refresh-btn" onClick={handleRefresh} title="Refresh">↻</button>
        </div>
        {newFolderDir !== null && (
          <div className="file-tree-new-folder">
            <input
              ref={newFolderInputRef}
              type="text"
              className="file-tree-search"
              placeholder="New folder name..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateFolder()
                if (e.key === 'Escape') closeNewFolderForm()
              }}
            />
            <button
              className="file-tree-refresh-btn"
              onClick={() => void handleCreateFolder()}
              disabled={!newFolderName.trim()}
              title="Create"
            >✓</button>
            <button className="file-tree-refresh-btn" onClick={closeNewFolderForm} title="Cancel">✕</button>
            {newFolderError && <span className="file-tree-new-folder-error">{newFolderError}</span>}
          </div>
        )}
        <div
          className="file-tree-list"
          ref={listRef}
          onScroll={(e) => {
            const top = (e.currentTarget as HTMLDivElement).scrollTop
            if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current)
            scrollSaveTimerRef.current = setTimeout(() => {
              localStorage.setItem(`file-tree-scroll:${rootPath}`, String(top))
            }, 200)
          }}
        >
          {searching && <div className="file-tree-item file-tree-loading-row">Searching...</div>}
          {searchResults !== null ? (
            // Search results: flat list with relative paths
            displayEntries.map(entry => (
              <div
                key={entry.path}
                className={`file-tree-item file-tree-file ${entry.path === selectedFile?.path ? 'selected' : ''}`}
                style={{ paddingLeft: '12px' }}
                onClick={() => {
                  if (!entry.isDirectory) handleSelect(entry)
                }}
                onContextMenu={(e) => handleContextMenu(e, entry)}
              >
                <span className="file-tree-icon">{entry.isDirectory ? '📁' : getFileIcon(entry.name)}</span>
                <span className="file-tree-name file-tree-search-path">{getRelativePath(entry.path)}</span>
              </div>
            ))
          ) : (
            entries.map(entry => (
              <FileTreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                selectedPath={selectedFile?.path || null}
                onSelect={handleSelect}
                onContextMenu={handleContextMenu}
                refreshKey={refreshKey}
              />
            ))
          )}
          {searchResults !== null && searchResults.length === 0 && !searching && (
            <div className="file-tree-empty">No matches</div>
          )}
          {searchResults === null && !loading && entries.length === 0 && (
            <div className="file-tree-empty">No files found</div>
          )}
        </div>
      </div>
      <div className="file-preview">
        {selectedFile ? (
          <>
            <div className="file-preview-header">
              <span className="file-preview-filename">{selectedFile.name}</span>
              <button
                className="file-tree-refresh-btn"
                onClick={() => void downloadFile(selectedFile.path)}
                title="Download"
              >⤓</button>
              <button className="file-tree-refresh-btn" onClick={handleRefresh} title="Refresh">↻</button>
            </div>
            <div className="file-preview-body">
              <FilePreview filePath={selectedFile.path} fileName={selectedFile.name} refreshKey={refreshKey} />
            </div>
          </>
        ) : (
          <div className="file-preview-status">Select a file to preview</div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="workspace-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="context-menu-item" onClick={handleCopyRelativePath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
            Copy Relative Path
          </div>
          <div className="context-menu-item" onClick={handleCopyAbsolutePath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
              <line x1="8" y1="10" x2="16" y2="10" />
              <line x1="8" y1="14" x2="12" y2="14" />
            </svg>
            Copy Absolute Path
          </div>
          <div className="context-menu-divider" />
          {!contextMenu.entry.isDirectory && (
            <div className="context-menu-item" onClick={handleDownloadFromMenu}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </div>
          )}
          <div className="context-menu-item" onClick={handleUploadHere}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {contextMenu.entry.isDirectory ? 'Upload Files Here' : 'Upload Files to This Folder'}
          </div>
          <div className="context-menu-item" onClick={handleNewFolderHere}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            New Folder Here
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleOpenInExplorer}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Open in Explorer
          </div>
          {contextMenu.entry.isDirectory && (
            <>
              <div className="context-menu-divider" />
              <div className="context-menu-item danger" onClick={handleDeleteFolderFromMenu}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete Folder…
              </div>
            </>
          )}
        </div>
      )}

      {/* Delete folder confirmation — requires typing the folder name */}
      {deleteTarget && (
        <div className="dialog-overlay" onClick={closeDeleteDialog}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>Delete Folder</h3>
            <p>This will permanently delete the folder and everything inside it:</p>
            <p className="file-tree-delete-path">{deleteTarget.path}</p>
            <p>Type <strong>{deleteTarget.name}</strong> to confirm.</p>
            <input
              ref={deleteInputRef}
              type="text"
              className="file-tree-search"
              placeholder={deleteTarget.name}
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && deleteConfirmed) void handleConfirmDelete()
                if (e.key === 'Escape') closeDeleteDialog()
              }}
            />
            {deleteError && <p className="file-tree-delete-error">{deleteError}</p>}
            <div className="dialog-actions">
              <button className="dialog-btn cancel" onClick={closeDeleteDialog} disabled={deleting}>
                Cancel
              </button>
              <button
                className="dialog-btn confirm"
                onClick={() => void handleConfirmDelete()}
                disabled={!deleteConfirmed || deleting}
              >
                {deleting ? 'Deleting…' : 'Delete Folder'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
