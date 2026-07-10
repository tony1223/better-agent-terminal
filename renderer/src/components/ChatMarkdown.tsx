import { host } from '../host-api'
import { useEffect, useMemo, useState } from 'react'
import {
  cleanPathLinkCandidate,
  extractPathLinkCandidates,
  openChatMarkdownLink,
  PATH_LINK_CANDIDATE_RE,
  pathToFileUrl,
  renderChatMarkdown,
} from '../utils/chat-markdown'

interface ResolvedPathLink {
  rawPath: string
  path: string
  exists: boolean
  line?: number
  column?: number
}

interface ChatMarkdownProps {
  text: string
  cwd: string
  className?: string
  resolvePathLinks?: boolean
}

const resolvedPathCache = new Map<string, ResolvedPathLink | null>()

function cacheKey(cwd: string, rawPath: string): string {
  return `${cwd}\0${rawPath}`
}

function applyResolvedPathLinks(html: string, links: Map<string, ResolvedPathLink>): string {
  if (links.size === 0 || typeof document === 'undefined') return html

  const container = document.createElement('div')
  container.innerHTML = html
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('a, pre, script, style')) return NodeFilter.FILTER_REJECT
      const value = node.nodeValue || ''
      PATH_LINK_CANDIDATE_RE.lastIndex = 0
      return PATH_LINK_CANDIDATE_RE.test(value) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })

  const textNodes: Text[] = []
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    textNodes.push(node)
  }

  for (const textNode of textNodes) {
    const text = textNode.nodeValue || ''
    const fragment = document.createDocumentFragment()
    let lastIndex = 0
    PATH_LINK_CANDIDATE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATH_LINK_CANDIDATE_RE.exec(text)) !== null) {
      const rawPath = cleanPathLinkCandidate(match[0])
      const resolved = links.get(rawPath)
      if (!resolved?.exists) continue
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
      }
      const anchor = document.createElement('a')
      anchor.className = 'path-link url-link'
      anchor.href = pathToFileUrl(resolved.path, resolved.line, resolved.column)
      anchor.title = resolved.path
      anchor.textContent = rawPath
      fragment.appendChild(anchor)
      lastIndex = match.index + match[0].length
    }
    if (lastIndex === 0) continue
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
    }
    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  return container.innerHTML
}

export function ChatMarkdown({ text, cwd, className = 'claude-markdown', resolvePathLinks = true }: ChatMarkdownProps) {
  const [resolvedLinks, setResolvedLinks] = useState<Map<string, ResolvedPathLink>>(new Map())
  const html = useMemo(() => renderChatMarkdown(text, cwd), [text, cwd])

  useEffect(() => {
    let cancelled = false
    if (!resolvePathLinks) {
      setResolvedLinks(new Map())
      return
    }
    const candidates = extractPathLinkCandidates(text)
    if (candidates.length === 0) {
      setResolvedLinks(new Map())
      return
    }

    const cached = new Map<string, ResolvedPathLink>()
    const missing: string[] = []
    for (const candidate of candidates) {
      const cachedValue = resolvedPathCache.get(cacheKey(cwd, candidate))
      if (cachedValue === undefined) {
        missing.push(candidate)
      } else if (cachedValue) {
        cached.set(candidate, cachedValue)
      }
    }
    if (cached.size > 0) setResolvedLinks(cached)
    if (missing.length === 0) {
      if (cached.size === 0) setResolvedLinks(new Map())
      return
    }

    host.fs.resolvePathLinks(cwd, missing).then(results => {
      if (cancelled) return
      const next = new Map(cached)
      const found = new Set<string>()
      for (const result of results) {
        found.add(result.rawPath)
        resolvedPathCache.set(cacheKey(cwd, result.rawPath), result)
        next.set(result.rawPath, result)
      }
      for (const candidate of missing) {
        if (!found.has(candidate)) resolvedPathCache.set(cacheKey(cwd, candidate), null)
      }
      setResolvedLinks(next)
    }).catch(() => {
      if (!cancelled) setResolvedLinks(cached)
    })

    return () => { cancelled = true }
  }, [text, cwd, resolvePathLinks])

  const linkedHtml = useMemo(
    () => resolvePathLinks ? applyResolvedPathLinks(html, resolvedLinks) : html,
    [html, resolvedLinks, resolvePathLinks],
  )

  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: linkedHtml }}
      onClick={(e) => {
        const target = e.target as HTMLElement
        const link = target.closest('a') as HTMLAnchorElement | null
        if (link?.href) {
          e.preventDefault()
          openChatMarkdownLink(link.href)
        }
      }}
    />
  )
}
