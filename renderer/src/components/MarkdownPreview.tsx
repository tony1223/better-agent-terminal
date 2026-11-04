import { useEffect, useRef, useState } from 'react'
import { Marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import { openChatMarkdownLink } from '../utils/chat-markdown'
import { LinkContextMenu, type LinkMenuTarget } from './LinkContextMenu'
import { prepareMarkdownHeadingIds, resolveMarkdownPreviewHref, scrollToMarkdownFragment } from '../utils/markdown-preview-links'
import { renderMermaidBlocks, renderMermaidCodeBlock } from '../utils/markdown-mermaid'

const renderer = new Renderer()

renderer.code = function (token) {
  const mermaid = renderMermaidCodeBlock(token)
  if (mermaid !== false) return mermaid
  const { text, lang } = token
  let highlighted: string
  try {
    highlighted = lang
      ? hljs.highlight(text, { language: lang }).value
      : hljs.highlightAuto(text).value
  } catch {
    highlighted = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  return `<pre><code class="hljs${lang ? ` language-${lang}` : ''}">${highlighted}</code></pre>`
}

renderer.link = function ({ href, text }: { href: string; text: string }) {
  const escapedHref = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<a href="${escapedHref}">${text}</a>`
}

renderer.image = function ({ href, text }: { href: string; text: string }) {
  const src = href.startsWith('/') ? `file://${href}` : href
  return `<img alt="${text || ''}" src="${src}" style="max-width:100%"/>`
}

const markdown = new Marked({ renderer, gfm: true, breaks: false })

function renderMarkdown(text: string): string {
  const rawHtml = markdown.parse(text) as string
  return DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['input'],
    ADD_ATTR: ['checked', 'disabled', 'type', 'data-external-link'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|ftps?|mailto|tel|file):|[A-Za-z]:[\\/]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })
}

export function MarkdownPreview({ content, filePath, fragment }: { content: string; filePath: string; fragment?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [linkMenu, setLinkMenu] = useState<LinkMenuTarget | null>(null)
  const html = renderMarkdown(content)

  useEffect(() => {
    if (containerRef.current) {
      prepareMarkdownHeadingIds(containerRef.current)
      if (fragment) scrollToMarkdownFragment(containerRef.current, fragment)
      return renderMermaidBlocks(containerRef.current)
    }
  }, [html, filePath, fragment])

  return (
    <>
      <div
        ref={containerRef}
        className="file-preview-markdown"
        dangerouslySetInnerHTML={{ __html: html }}
        onContextMenu={event => {
          const link = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
          if (!link) return
          const href = resolveMarkdownPreviewHref(link.getAttribute('href') || '', filePath)
          if (!href || href.startsWith('#')) return
          event.preventDefault()
          event.stopPropagation()
          setLinkMenu({ x: event.clientX, y: event.clientY, href })
        }}
        onClick={(e) => {
          const target = e.target as HTMLElement
          const link = target.closest('a[href]') as HTMLAnchorElement | null
          if (link) {
            e.preventDefault()
            const href = resolveMarkdownPreviewHref(link.getAttribute('href') || '', filePath)
            if (!href) return
            if (href.startsWith('#')) {
              if (containerRef.current) scrollToMarkdownFragment(containerRef.current, href)
            } else {
              openChatMarkdownLink(href)
            }
          }
        }}
      />
      {linkMenu && <LinkContextMenu target={linkMenu} onClose={() => setLinkMenu(null)} />}
    </>
  )
}
