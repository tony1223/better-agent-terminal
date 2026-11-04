import DOMPurify from 'dompurify'
import type { Tokens } from 'marked'

const MAX_DIAGRAM_LENGTH = 50_000
let nextDiagramId = 0
let mermaidPromise: Promise<typeof import('mermaid')['default']> | undefined

// Keep the source as escaped, whitespace-preserving code until rendering succeeds.
// In particular, a quoted <br/> in a label must survive the HTML sanitizer.
export function renderMermaidCodeBlock({ text, lang, raw }: Tokens.Code): string | false {
  if (lang?.trim().split(/\s+/)[0].toLowerCase() !== 'mermaid') return false
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const fence = raw.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
  const closed = fence && new RegExp(`\\n {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n)?$`).test(raw)
  // marked accepts unfinished fences while streaming. Wait for their closing
  // fence rather than repeatedly parsing half a diagram.
  return `<pre${closed ? ' class="mermaid"' : ''}><code class="language-mermaid">${escaped}</code></pre>\n`
}

function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: MAX_DIAGRAM_LENGTH,
        htmlLabels: false,
        theme: 'dark',
        themeVariables: {
          darkMode: true,
          background: '#1e1e1e',
          primaryColor: '#3498db',
          primaryTextColor: '#e0e0e0',
          lineColor: '#888',
        },
      })
      return mermaid
    }).catch(error => {
      mermaidPromise = undefined
      throw error
    })
  }
  return mermaidPromise
}

// Called after React installs sanitized Markdown HTML. Cancellation prevents an
// older asynchronous render from changing a new message or a different file.
export function renderMermaidBlocks(container: HTMLElement): () => void {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre.mermaid:not(.mermaid-rendered):not(.mermaid-error)'))
  if (blocks.length === 0) return () => {}
  let cancelled = false
  const timer = setTimeout(() => { void render() }, 150)

  async function render() {
    for (const block of blocks) {
      if (cancelled || !container.contains(block)) return
      const source = block.textContent || ''
      if (!source.trim()) continue
      let staging: HTMLDivElement | undefined
      try {
        if (source.length > MAX_DIAGRAM_LENGTH) throw new Error('diagram too large')
        const mermaid = await getMermaid()
        if (cancelled || !container.contains(block)) return
        // Mermaid measures in a temporary DOM tree. Keep it out of the visible
        // transcript, including when the parser rejects a diagram.
        staging = document.createElement('div')
        staging.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none'
        document.body.appendChild(staging)
        const { svg } = await mermaid.render(`bat-mermaid-${++nextDiagramId}`, source, staging)
        if (cancelled || !container.contains(block)) return
        block.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
        block.classList.add('mermaid-rendered')
      } catch {
        // Leave the original escaped code readable. One invalid diagram must
        // not stop later diagrams (or append Mermaid's error SVG to the page).
        if (!cancelled && container.contains(block)) block.classList.add('mermaid-error')
      } finally {
        staging?.remove()
      }
    }
  }

  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}
