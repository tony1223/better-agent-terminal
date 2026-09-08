/** Resolve document links against the host file, never the WebView's origin. */
export function resolveMarkdownPreviewHref(href: string, filePath: string): string | null {
  const raw = href.trim()
  if (!raw) return null
  if (raw.startsWith('#')) return raw
  if (/^(?:https?|mailto|tel|ftps?):/i.test(raw)) return raw
  if (raw.startsWith('//')) return `https:${raw}`

  const windowsPath = /^[A-Za-z]:[\\/]/.test(raw)
  if (!windowsPath && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) && !/^file:/i.test(raw)) return null

  try {
    const normalizedSource = filePath.replace(/\\/g, '/')
    if (!/^(?:[A-Za-z]:\/|\/)/.test(normalizedSource)) return null
    const sourceUrl = new URL((normalizedSource.startsWith('//') ? 'file:' : 'file://')
      + (/^[A-Za-z]:\//.test(normalizedSource) ? '/' : '')
      + encodeURI(normalizedSource).replace(/#/g, '%23').replace(/\?/g, '%3F'))
    const normalized = raw.replace(/\\/g, '/').replace(/%(?![A-Fa-f0-9]{2})/g, '%25')
    const url = new URL(
      windowsPath ? `file:///${normalized}` : raw.startsWith('\\\\') ? `file:${normalized}` : normalized,
      sourceUrl,
    )
    if (url.protocol !== 'file:') return null

    // Agent-authored links can carry editor-style :line[:column] locations.
    const suffix = url.pathname.match(/(\.[A-Za-z0-9]{1,10}):(\d+)(?::(\d+))?$/)
    if (suffix) {
      url.pathname = url.pathname.slice(0, -suffix[0].length) + suffix[1]
      url.hash = `line=${suffix[2]}${suffix[3] ? `&column=${suffix[3]}` : ''}`
    }
    if (url.host === sourceUrl.host && url.pathname === sourceUrl.pathname) return url.hash || '#'
    return url.href
  } catch {
    return null
  }
}

export function markdownHeadingId(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-')
}

export function prepareMarkdownHeadingIds(container: HTMLElement): void {
  const used = new Set(Array.from(container.querySelectorAll('[id]'), node => node.id))
  for (const heading of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (heading.id) continue
    const base = markdownHeadingId(heading.textContent || '')
    let id = base
    let index = 0
    while (used.has(id)) id = `${base}-${++index}`
    heading.id = id
    used.add(id)
  }
}

export function scrollToMarkdownFragment(container: HTMLElement, fragment: string): void {
  let id = fragment.replace(/^#/, '')
  try { id = decodeURIComponent(id) } catch { /* Keep malformed escapes literal. */ }
  if (!id) {
    container.scrollIntoView({ block: 'start' })
    return
  }
  const target = Array.from(container.querySelectorAll<HTMLElement>('[id], a[name]'))
    .find(node => node.id === id || node.getAttribute('name') === id)
  target?.scrollIntoView({ block: 'start' })
}
