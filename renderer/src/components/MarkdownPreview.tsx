import { useEffect, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import { openChatMarkdownLink } from '../utils/chat-markdown'
import { prepareMarkdownHeadingIds, resolveMarkdownPreviewHref, scrollToMarkdownFragment } from '../utils/markdown-preview-links'

marked.setOptions({
  gfm: true,
  breaks: false,
})

const renderer = new marked.Renderer()

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  if (lang === 'mermaid') {
    return `<div class="mermaid">${text}</div>`
  }
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

marked.use({ renderer })

function renderMarkdown(text: string): string {
  const rawHtml = marked.parse(text) as string
  return DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['input'],
    ADD_ATTR: ['checked', 'disabled', 'type', 'data-external-link'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|ftps?|mailto|tel|file):|[A-Za-z]:[\\/]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })
}

let mermaidInstance: typeof import('mermaid')['default'] | null = null

async function getMermaid() {
  if (!mermaidInstance) {
    mermaidInstance = (await import('mermaid')).default
    mermaidInstance.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#1e1e1e',
        primaryColor: '#3498db',
        primaryTextColor: '#e0e0e0',
        lineColor: '#666',
      },
    })
  }
  return mermaidInstance
}

async function renderMermaidBlocks(container: HTMLElement) {
  const mermaidDivs = container.querySelectorAll('.mermaid')
  if (mermaidDivs.length === 0) return

  const mermaid = await getMermaid()
  mermaidDivs.forEach((div, i) => {
    div.id = `mermaid-${Date.now()}-${i}`
  })
  try {
    await mermaid.run({ nodes: mermaidDivs as unknown as ArrayLike<HTMLElement> })
  } catch {
    mermaidDivs.forEach(div => {
      if (!div.querySelector('svg')) {
        div.classList.add('mermaid-error')
      }
    })
  }
}

export function MarkdownPreview({ content, filePath, fragment }: { content: string; filePath: string; fragment?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const html = renderMarkdown(content)

  useEffect(() => {
    if (containerRef.current) {
      prepareMarkdownHeadingIds(containerRef.current)
      if (fragment) scrollToMarkdownFragment(containerRef.current, fragment)
      renderMermaidBlocks(containerRef.current)
    }
  }, [html, filePath, fragment])

  return (
    <div
      ref={containerRef}
      className="file-preview-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
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
  )
}
