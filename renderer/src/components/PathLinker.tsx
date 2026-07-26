import { host } from '../host-api'
import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import hljs from 'highlight.js/lib/core'
import 'highlight.js/styles/vs2015.css'
// Register only the languages we actually use (saves ~800KB vs full highlight.js)
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import less from 'highlight.js/lib/languages/less'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import ini from 'highlight.js/lib/languages/ini'
import bash from 'highlight.js/lib/languages/bash'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import lua from 'highlight.js/lib/languages/lua'
import r from 'highlight.js/lib/languages/r'
import perl from 'highlight.js/lib/languages/perl'
import php from 'highlight.js/lib/languages/php'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import scala from 'highlight.js/lib/languages/scala'
import sql from 'highlight.js/lib/languages/sql'
import graphql from 'highlight.js/lib/languages/graphql'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import makefile from 'highlight.js/lib/languages/makefile'
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('scss', scss)
hljs.registerLanguage('less', less)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('python', python)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('java', java)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('lua', lua)
hljs.registerLanguage('r', r)
hljs.registerLanguage('perl', perl)
hljs.registerLanguage('php', php)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('scala', scala)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('graphql', graphql)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('makefile', makefile)

const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'jsonl', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'gs',
  'pine', 'lua', 'r', 'pl', 'php', 'swift', 'kt', 'scala', 'sql', 'graphql',
  'env', 'gitignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'dockerfile', 'makefile', 'cfg', 'ini', 'conf', 'log', 'output',
])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', gs: 'javascript',
  pine: 'javascript', lua: 'lua', r: 'r', pl: 'perl', php: 'php',
  swift: 'swift', kt: 'kotlin', scala: 'scala', sql: 'sql', graphql: 'graphql',
  dockerfile: 'dockerfile', makefile: 'makefile',
  ini: 'ini', conf: 'ini', cfg: 'ini',
}

function getExt(p: string): string {
  return p.split('.').pop()?.toLowerCase() || ''
}

function canPreview(p: string): boolean {
  const ext = getExt(p)
  return TEXT_EXTS.has(ext) || IMAGE_EXTS.has(ext)
}

// Regex: absolute file paths — Windows (C:\...) and Unix (/Users/..., /home/..., /tmp/...)
const PATH_RE = /(?:[A-Za-z]:[\\\/]|\/(?:Users|home|tmp|var|opt|etc|usr|mnt|srv|root)\/)[\w\-. \\\/]+\.\w{1,10}/g

type TokenType = 'text' | 'path' | 'url' | 'mdlink'
interface Token { type: TokenType; text: string; href?: string }

// Markdown link: [text](url)  |  Bare URL: https://..., http://..., or file:///...
const MD_LINK_RE = /\[([^\]]+)\]\(((?:https?|file):\/\/[^\s)]+)\)/g
const URL_RE = /(?:https?|file):\/\/[^\s<>)\]]+/g

function tokenize(text: string): Token[] {
  // Pass 1: extract markdown links and bare URLs
  const specials: { start: number; end: number; token: Token }[] = []

  MD_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    specials.push({ start: m.index, end: m.index + m[0].length, token: { type: 'mdlink', text: m[1], href: m[2] } })
  }

  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    // Skip if overlapping with an already-found markdown link
    const overlaps = specials.some(s => m!.index >= s.start && m!.index < s.end)
    if (overlaps) continue
    // Strip trailing punctuation that's likely not part of the URL (e.g. backtick from markdown `url`)
    let url = m[0]
    const end = m.index + m[0].length
    while (url.length > 0 && /[`'",;:!.*_~]/.test(url[url.length - 1])) {
      url = url.slice(0, -1)
    }
    const trimmed = m[0].length - url.length
    specials.push({ start: m.index, end: end - trimmed, token: { type: 'url', text: url, href: url } })
  }

  PATH_RE.lastIndex = 0
  while ((m = PATH_RE.exec(text)) !== null) {
    const overlaps = specials.some(s => m!.index >= s.start && m!.index < s.end)
    if (overlaps) continue
    specials.push({ start: m.index, end: m.index + m[0].length, token: { type: 'path', text: m[0] } })
  }

  if (specials.length === 0) return [{ type: 'text', text }]

  // Sort by start position
  specials.sort((a, b) => a.start - b.start)

  const tokens: Token[] = []
  let lastIndex = 0
  for (const s of specials) {
    if (s.start > lastIndex) tokens.push({ type: 'text', text: text.slice(lastIndex, s.start) })
    tokens.push(s.token)
    lastIndex = s.end
  }
  if (lastIndex < text.length) tokens.push({ type: 'text', text: text.slice(lastIndex) })
  return tokens
}

export function HighlightedCode({ code, ext, className }: { code: string; ext: string; className?: string }) {
  const [highlightedLines, setHighlightedLines] = useState<string[]>([])

  useEffect(() => {
    let html = ''
    const lang = EXT_TO_LANG[ext]
    try {
      html = lang
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value
    } catch {
      // Escape HTML for plain text fallback
      html = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
    // Split highlighted HTML by newlines — preserving spans across lines
    setHighlightedLines(html.split('\n'))
  }, [code, ext])

  return (
    <div className={`hlcode-wrapper ${className || 'path-preview-text'}`}>
      <table className="hlcode-table">
        <tbody>
          {highlightedLines.map((lineHtml, i) => (
            <tr key={i}>
              <td className="hlcode-ln">{i + 1}</td>
              <td className="hlcode-line" dangerouslySetInnerHTML={{ __html: lineHtml || ' ' }} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface FilePreviewModalProps {
  filePath: string
  onClose: () => void
}

// Strip a trailing ":line" or ":line:col" hint from a path. Handles Windows
// drive letters (e.g. "C:\foo\bar.cs:50") by only stripping after a non-drive
// colon. Some callers (chat citations, stdout pastes) include the line suffix;
// fs.stat / fs.readFile would reject it on Windows because ':' is invalid in
// file names.
// Tauri rejects commands with a plain object, a bare string, or an Error
// depending on where the failure happened, so every call site needs the same
// unwrapping before it can show the user anything useful.
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return fallback
}

function stripLineSuffix(p: string): { path: string; line?: number; column?: number } {
  if (!p) return { path: p }
  const m = p.match(/^(.+?\.[A-Za-z0-9]{1,10}):(\d+)(?::(\d+))?$/)
  if (!m) return { path: p }
  return { path: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined }
}

export function FilePreviewModal({ filePath: rawFilePath, onClose }: FilePreviewModalProps) {
  const { path: filePath } = stripLineSuffix(rawFilePath)
  const [content, setContent] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentMatch, setCurrentMatch] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setImageUrl(null)
    setError(null)
    setOpenError(null)
    setLoading(true)
    const ext = getExt(filePath)
    if (IMAGE_EXTS.has(ext)) {
      host.image.readAsDataUrl(filePath).then(url => {
        if (!cancelled) { setImageUrl(url); setLoading(false) }
      }).catch(() => {
        if (!cancelled) { setError('Failed to load image'); setLoading(false) }
      })
    } else {
      // Read as text — works for known and unknown text extensions
      host.fs.readFile(filePath).then(result => {
        if (cancelled) return
        if (result.error) {
          setError(result.error === 'File too large' ? `File too large (${Math.round((result.size || 0) / 1024)}KB)` : result.error)
        } else {
          setContent(result.content || '')
        }
        setLoading(false)
      })
    }
    return () => { cancelled = true }
  }, [filePath])

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(filePath).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [filePath])

  const handleOpenPath = useCallback(async () => {
    setOpenError(null)
    try {
      await host.shell.openPath(filePath)
    } catch (openPathError) {
      const message = errorMessage(openPathError, 'Unable to open file')
      setOpenError(message)
      void host.debug.log(`[FilePreview] openPath failed: ${message}`)
    }
  }, [filePath])

  // Search: highlight matches and navigate
  useEffect(() => {
    if (!searchQuery || !bodyRef.current) { setMatchCount(0); setCurrentMatch(0); return }
    // Remove previous highlights
    const body = bodyRef.current
    const marks = body.querySelectorAll('mark.search-highlight')
    marks.forEach(m => {
      const parent = m.parentNode
      if (parent) { parent.replaceChild(document.createTextNode(m.textContent || ''), m); parent.normalize() }
    })
    if (!searchQuery.trim()) { setMatchCount(0); setCurrentMatch(0); return }
    // Walk text nodes and wrap matches
    const query = searchQuery.toLowerCase()
    const textNodes: Text[] = []
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null)
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      if (node.nodeValue && node.nodeValue.toLowerCase().includes(query)) textNodes.push(node)
    }
    let total = 0
    for (const tn of textNodes) {
      const text = tn.nodeValue || ''
      const frag = document.createDocumentFragment()
      let lastIdx = 0
      const lowerText = text.toLowerCase()
      let idx = lowerText.indexOf(query, lastIdx)
      while (idx !== -1) {
        if (idx > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)))
        const mark = document.createElement('mark')
        mark.className = 'search-highlight'
        mark.dataset.matchIndex = String(total)
        mark.textContent = text.slice(idx, idx + query.length)
        frag.appendChild(mark)
        total++
        lastIdx = idx + query.length
        idx = lowerText.indexOf(query, lastIdx)
      }
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)))
      tn.parentNode?.replaceChild(frag, tn)
    }
    setMatchCount(total)
    setCurrentMatch(total > 0 ? 1 : 0)
    // Scroll to first match
    if (total > 0) {
      const first = body.querySelector('mark.search-highlight[data-match-index="0"]')
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      body.querySelectorAll('mark.search-highlight').forEach(m => m.classList.remove('current'))
      first?.classList.add('current')
    }
  }, [searchQuery])

  const navigateMatch = useCallback((direction: 1 | -1) => {
    if (matchCount === 0 || !bodyRef.current) return
    const next = direction === 1
      ? (currentMatch % matchCount) + 1
      : ((currentMatch - 2 + matchCount) % matchCount) + 1
    setCurrentMatch(next)
    const marks = bodyRef.current.querySelectorAll('mark.search-highlight')
    marks.forEach(m => m.classList.remove('current'))
    const target = bodyRef.current.querySelector(`mark.search-highlight[data-match-index="${next - 1}"]`)
    target?.classList.add('current')
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentMatch, matchCount])

  // Ctrl+F to open search, Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 50)
      }
      if (e.key === 'Escape' && searchOpen) {
        e.stopPropagation()
        setSearchOpen(false)
        setSearchQuery('')
      }
    }
    const modal = bodyRef.current?.closest('.path-preview-modal')
    modal?.addEventListener('keydown', handleKeyDown as EventListener)
    return () => modal?.removeEventListener('keydown', handleKeyDown as EventListener)
  }, [searchOpen])

  const fileName = filePath.split(/[\\\/]/).pop() || filePath

  return (
    <div className="path-preview-overlay" onClick={onClose}>
      <div className="path-preview-modal" onClick={e => e.stopPropagation()}>
        <div className="path-preview-header">
          <span className="path-preview-title" title={filePath}>{fileName}</span>
          <span className="path-preview-path" onClick={handleCopyPath} title="Click to copy path">
            {copied ? 'Copied!' : filePath}
          </span>
          <button
            className="path-preview-btn"
            onClick={handleCopyPath}
            title="Copy file path"
          >
            {copied ? '\u2713' : '\u2398'}
          </button>
          <button
            className="path-preview-btn"
            onClick={() => { void handleOpenPath() }}
            title="Open with this computer's default app"
          >
            &#8599;
          </button>
          <button
            className="path-preview-btn"
            onClick={() => { setSearchOpen(o => !o); setTimeout(() => searchInputRef.current?.focus(), 50) }}
            title="Search (Ctrl+F)"
          >
            &#128269;
          </button>
          <button className="path-preview-close" onClick={onClose}>×</button>
        </div>
        {searchOpen && (
          <div className="path-preview-search">
            <input
              ref={searchInputRef}
              className="path-preview-search-input"
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); navigateMatch(e.shiftKey ? -1 : 1) }
                if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); setSearchQuery('') }
              }}
            />
            {searchQuery && <span className="path-preview-search-count">{matchCount > 0 ? `${currentMatch}/${matchCount}` : 'No results'}</span>}
            <button className="path-preview-search-nav" onClick={() => navigateMatch(-1)} disabled={matchCount === 0} title="Previous (Shift+Enter)">&uarr;</button>
            <button className="path-preview-search-nav" onClick={() => navigateMatch(1)} disabled={matchCount === 0} title="Next (Enter)">&darr;</button>
          </div>
        )}
        <div className="path-preview-body" ref={bodyRef}>
          {loading && <div className="path-preview-status">Loading...</div>}
          {openError && <div className="path-preview-status">{openError}</div>}
          {error && <div className="path-preview-status">{error}</div>}
          {imageUrl && (
            <div className="path-preview-image">
              <img src={imageUrl} alt={fileName} />
            </div>
          )}
          {content !== null && (
            <HighlightedCode code={content} ext={getExt(filePath)} />
          )}
        </div>
      </div>
    </div>
  )
}

interface LinkedTextProps {
  text: string
}

export function LinkedText({ text }: LinkedTextProps) {
  const { t } = useTranslation()
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  // Right-click target for "open containing folder". A single menu lives here
  // rather than one per link: a long agent reply can cite hundreds of paths.
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [menuError, setMenuError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menu])

  const handleClick = useCallback((path: string) => {
    if (path.endsWith('.md')) {
      window.dispatchEvent(new CustomEvent('preview-markdown', { detail: { path } }))
    } else {
      setPreviewPath(path)
    }
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuError(null)
    setMenu({ x: e.clientX, y: e.clientY, path })
  }, [])

  const handleReveal = useCallback(async () => {
    if (!menu) return
    // A cited path often carries "file.ts:42"; ':' is not legal in a Windows
    // file name, so the host would reject it outright.
    const { path } = stripLineSuffix(menu.path)
    try {
      await host.shell.revealPath(path)
      setMenu(null)
    } catch (revealError) {
      // No app-wide toast exists, and inline chat text has nowhere to put one, so
      // the menu stays open and reports the failure itself. The host already
      // walks up to the nearest surviving folder, so getting here means nothing
      // on the path exists — worth saying rather than silently doing nothing.
      const message = errorMessage(revealError, 'Unable to open the containing folder')
      setMenuError(message)
      void host.debug.log(`[PathLinker] revealPath failed: ${message}`)
    }
  }, [menu])

  const handleUrl = useCallback((url: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    host.shell.openExternal(url)
  }, [])

  if (typeof text !== 'string') return <>{text}</>

  const tokens = tokenize(text)
  if (tokens.length === 1 && tokens[0].type === 'text') return <>{text}</>

  return (
    <>
      {tokens.map((token, i) => {
        if (token.type === 'path') {
          return (
            <span
              key={i}
              className="path-link"
              onClick={(e) => { e.stopPropagation(); handleClick(token.text) }}
              onContextMenu={(e) => handleContextMenu(e, token.text)}
              title={`Click to preview: ${token.text}`}
            >
              {token.text}
            </span>
          )
        }
        if (token.type === 'url') {
          return (
            <a key={i} className="path-link url-link" href={token.href} onClick={(e) => handleUrl(token.href!, e)} title={token.href}>
              {token.text}
            </a>
          )
        }
        if (token.type === 'mdlink') {
          return (
            <a key={i} className="path-link url-link" href={token.href} onClick={(e) => handleUrl(token.href!, e)} title={token.href}>
              {token.text}
            </a>
          )
        }
        return <Fragment key={i}>{token.text}</Fragment>
      })}
      {menu && (
        <div
          ref={menuRef}
          className="floating-context-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <div className="context-menu-item" onClick={() => { void handleReveal() }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            {t('common.openContainingFolder')}
          </div>
          {menuError && <div className="context-menu-error">{menuError}</div>}
        </div>
      )}
      {previewPath && (
        <FilePreviewModal
          filePath={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </>
  )
}
