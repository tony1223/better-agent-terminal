import { host } from '../host-api'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownPreview } from './MarkdownPreview'
import { formatErrorMessage } from '../utils/error-message'

interface MarkdownPreviewPanelProps {
  filePath: string
  onClose: () => void
}

export function MarkdownPreviewPanel({ filePath, onClose }: MarkdownPreviewPanelProps) {
  const { t } = useTranslation()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const watchingDir = useRef<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentMatch, setCurrentMatch] = useState(0)

  const fileName = filePath.split(/[/\\]/).pop() || filePath

  const loadContent = useCallback(() => {
    host.fs.readFile(filePath).then(result => {
      if (result.error) {
        setError(result.error)
        setContent(null)
      } else {
        setContent(result.content ?? '')
        setError(null)
      }
    }).catch(err => {
      setError(String(err))
      setContent(null)
    })
  }, [filePath])

  const revealFile = useCallback(async () => {
    try {
      await host.shell.revealPath(filePath)
    } catch (revealError) {
      // The panel already owns an error banner, and it is cleared by the next
      // reload, so borrow it rather than failing silently.
      setError(formatErrorMessage(revealError, 'Unable to open the containing folder'))
    }
  }, [filePath])

  // Load content on mount and when filePath changes
  useEffect(() => {
    loadContent()
  }, [loadContent])

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50)
    }
  }, [searchOpen])

  useEffect(() => {
    const container = contentRef.current
    if (!container) return

    const existingMarks = container.querySelectorAll('mark.search-highlight')
    existingMarks.forEach(mark => {
      const parent = mark.parentNode
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
        parent.normalize()
      }
    })

    const query = searchQuery.trim().toLowerCase()
    if (!query) {
      setMatchCount(0)
      setCurrentMatch(0)
      return
    }

    const textNodes: Text[] = []
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (parent.closest('script, style, mark.search-highlight')) return NodeFilter.FILTER_REJECT
        return node.nodeValue?.toLowerCase().includes(query)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
      },
    })

    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      textNodes.push(node)
    }

    let total = 0
    for (const textNode of textNodes) {
      const text = textNode.nodeValue || ''
      const lowerText = text.toLowerCase()
      const fragment = document.createDocumentFragment()
      let lastIndex = 0
      let index = lowerText.indexOf(query, lastIndex)

      while (index !== -1) {
        if (index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)))
        }
        const mark = document.createElement('mark')
        mark.className = 'search-highlight'
        mark.dataset.matchIndex = String(total)
        mark.textContent = text.slice(index, index + query.length)
        fragment.appendChild(mark)
        total += 1
        lastIndex = index + query.length
        index = lowerText.indexOf(query, lastIndex)
      }

      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
      }
      textNode.parentNode?.replaceChild(fragment, textNode)
    }

    setMatchCount(total)
    setCurrentMatch(total > 0 ? 1 : 0)

    if (total > 0) {
      const first = container.querySelector('mark.search-highlight[data-match-index="0"]')
      container.querySelectorAll('mark.search-highlight').forEach(mark => mark.classList.remove('current'))
      first?.classList.add('current')
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [content, searchQuery])

  const navigateMatch = useCallback((direction: 1 | -1) => {
    const container = contentRef.current
    if (!container || matchCount === 0) return
    const next = direction === 1
      ? (currentMatch % matchCount) + 1
      : ((currentMatch - 2 + matchCount) % matchCount) + 1

    setCurrentMatch(next)
    container.querySelectorAll('mark.search-highlight').forEach(mark => mark.classList.remove('current'))
    const target = container.querySelector(`mark.search-highlight[data-match-index="${next - 1}"]`)
    target?.classList.add('current')
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentMatch, matchCount])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        return
      }
      if (e.key === 'Escape' && searchOpen) {
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen(false)
        setSearchQuery('')
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [searchOpen])

  // Watch for file changes
  useEffect(() => {
    // Get parent directory (JS string manipulation, no path module needed)
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
    const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : filePath

    host.fs.watch(dir)
    watchingDir.current = dir

    const unsub = host.fs.onChanged((changedDir: string) => {
      if (filePath.startsWith(changedDir)) {
        loadContent()
      }
    })

    return () => {
      if (watchingDir.current) {
        host.fs.unwatch(watchingDir.current)
        watchingDir.current = null
      }
      unsub()
    }
  }, [filePath, loadContent])

  return (
    <div className="md-preview-panel" onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }) }}>
      <div className="md-preview-header">
        <span className="md-preview-filename" title={filePath}>{fileName}</span>
        <div className="md-preview-actions">
          <button
            className="md-preview-action-btn"
            onClick={() => navigator.clipboard.writeText(filePath)}
            title={t('sidebar.copyPath')}
          >
            &#x2398;
          </button>
          <button
            className="md-preview-action-btn"
            onClick={() => host.shell.openPath(filePath)}
            title={t('common.openFile')}
          >
            &#x2197;
          </button>
          {/* Opening the file hands it to whatever app owns .md; this hands the
              user the folder instead, which is what they want when the file is
              something to copy elsewhere or open with a specific program. The
              button used to claim "Open in Explorer" while doing neither. */}
          <button
            className="md-preview-action-btn"
            onClick={() => { void revealFile() }}
            title={t('common.openContainingFolder')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </button>
          <button
            className="md-preview-action-btn"
            onClick={() => setSearchOpen(open => !open)}
            title="Search (Ctrl+F)"
          >
            &#128269;
          </button>
          <button className="md-preview-action-btn" onClick={onClose} title={t('common.close')}>
            &times;
          </button>
        </div>
      </div>
      {searchOpen && (
        <div className="md-preview-search">
          <input
            ref={searchInputRef}
            className="md-preview-search-input"
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                navigateMatch(e.shiftKey ? -1 : 1)
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSearchOpen(false)
                setSearchQuery('')
              }
            }}
          />
          {searchQuery && (
            <span className="md-preview-search-count">
              {matchCount > 0 ? `${currentMatch}/${matchCount}` : 'No results'}
            </span>
          )}
          <button className="md-preview-search-nav" onClick={() => navigateMatch(-1)} disabled={matchCount === 0} title="Previous (Shift+Enter)">
            &uarr;
          </button>
          <button className="md-preview-search-nav" onClick={() => navigateMatch(1)} disabled={matchCount === 0} title="Next (Enter)">
            &darr;
          </button>
        </div>
      )}
      <div className="md-preview-content" ref={contentRef}>
        {error && <div className="md-preview-error">{error}</div>}
        {content !== null && <MarkdownPreview content={content} />}
      </div>
      {contextMenu && (
        <div ref={contextMenuRef} className="workspace-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <div className="context-menu-item" onClick={() => { setContextMenu(null); void revealFile() }}>
            {t('common.openContainingFolder')}
          </div>
          <div className="context-menu-item" onClick={() => { setContextMenu(null); onClose() }}>
            {t('common.close')}
          </div>
        </div>
      )}
    </div>
  )
}
