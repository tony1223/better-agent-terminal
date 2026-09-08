import { host } from '../host-api'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const markdownCache = new Map<string, string>()
const MARKDOWN_CACHE_MAX = 500
const PATH_LINK_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'json', 'jsonl', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'mdx', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'csproj', 'sln',
  'slnx', 'fs', 'fsproj', 'vue', 'svelte', 'sql', 'graphql', 'log',
]
const PATH_LINK_DIRS = [
  'src', 'app', 'lib', 'components', 'pages', 'routes', 'frontend', 'backend', 'electron',
  'tests?', 'testplan', 'plan', 'analytics', 'schema', 'docs?', 'scripts?', 'styles?', 'utils?',
  'stores?', 'types?', 'public', 'assets', 'config', 'migrations', 'controllers', 'models',
  'views', 'services', 'hooks', 'api', 'server', 'client', 'packages', 'examples', 'release',
  '\\.github', '\\.codex', '\\.claude',
]
const PATH_LINK_EXT_GROUP = PATH_LINK_EXTS.join('|')
const PATH_LINK_DIR_GROUP = PATH_LINK_DIRS.join('|')

export const PATH_LINK_CANDIDATE_RE = new RegExp(
  String.raw`(?<![\w@.-])(?:[A-Za-z]:[\\/]|/(?:Users|home|tmp|var|opt|etc|usr|mnt|srv|root)/|\.{1,2}/|(?:${PATH_LINK_DIR_GROUP})/)[A-Za-z0-9_.@+\- /\\]*?\.(?:${PATH_LINK_EXT_GROUP})(?::\d+(?::\d+)?)?`,
  'gi',
)

function absPathToFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  const withLeading = /^[A-Za-z]:\//.test(normalized) ? '/' + normalized : normalized
  return 'file://' + encodeURI(withLeading)
}

export function pathToFileUrl(absPath: string, line?: number, column?: number): string {
  const hash = line ? `#line=${line}${column ? `&column=${column}` : ''}` : ''
  return absPathToFileUrl(absPath) + hash
}

export function cleanPathLinkCandidate(raw: string): string {
  return raw.replace(/^[`'"(<\[]+|[`'"),.;>\]]+$/g, '')
}

export function extractPathLinkCandidates(text: string): string[] {
  if (!text || text.length > 250_000) return []
  const withoutFenced = text.replace(/(^|\n)(`{3,}|~{3,})[\s\S]*?\n\2/g, '$1')
  const found = new Set<string>()
  PATH_LINK_CANDIDATE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATH_LINK_CANDIDATE_RE.exec(withoutFenced)) !== null) {
    const candidate = cleanPathLinkCandidate(match[0])
    if (candidate) found.add(candidate)
    if (found.size >= 100) break
  }
  return Array.from(found)
}

function resolveRelativePath(cwd: string, rel: string): string {
  const cwdParts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  const relParts = rel.replace(/\\/g, '/').split('/')
  for (const part of relParts) {
    if (part === '' || part === '.') continue
    if (part === '..') { if (cwdParts.length > 1) cwdParts.pop(); continue }
    cwdParts.push(part)
  }
  return cwdParts.join('/')
}

// Models occasionally hard-wrap a table row mid-cell (seen in the wild: the
// header row split inside a CJK word). One broken row makes GFM reject the
// whole table and render it as a run-on paragraph. Repair: inside table-ish
// blocks (the text must contain a delimiter row), a line that STARTS a row
// (`|...`) but doesn't terminate it gets joined with following lines until one
// ends with `|`. Fenced code is left untouched; if no terminator shows up
// within a few lines we leave the text alone.
const TABLE_DELIMITER_ROW_RE = /^\s*\|?[\s:-]*-+[\s:-]*(\|[\s:-]*-*[\s:-]*)+\|?\s*$/m
export function repairBrokenTableRows(text: string): string {
  if (!text.includes('|') || !TABLE_DELIMITER_ROW_RE.test(text)) return text
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (!inFence && /^\s*\|/.test(line) && !/\|\s*$/.test(line)) {
      let joined = line
      let j = i + 1
      let terminated = false
      while (j < lines.length && j - i <= 3) {
        const next = lines[j]
        if (!next.trim() || /^\s*(`{3,}|~{3,})/.test(next)) break
        joined += next
        if (/\|\s*$/.test(next)) { terminated = true; break }
        j++
      }
      if (terminated) {
        out.push(joined)
        i = j
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

export function renderChatMarkdown(text: string, cwd: string): string {
  const cacheKey = cwd + '\0' + text
  const cached = markdownCache.get(cacheKey)
  if (cached !== undefined) return cached
  const processed = repairBrokenTableRows(text).replace(
    /(`{1,3}[\s\S]*?`{1,3})|(file:\/\/\/[^\s<>)\]`'"]+)/g,
    (match, codeBlock, fileUrl, offset, str) => {
      if (codeBlock) return match
      if (!fileUrl) return match
      const before = str.slice(Math.max(0, offset - 2), offset)
      if (before === '](' || before.endsWith('(')) return match
      return `[${fileUrl}](${fileUrl})`
    }
  )
  const parsedHtml = marked.parse(processed) as string
  const rawHtml = cwd
    ? parsedHtml.replace(
        /<a\s+([^>]*?)href="([^"#][^"]*)"/gi,
        (match, attrs, href) => {
          if (/^(?:https?|mailto|tel|file):/i.test(href)) return match
          const isAbs = href.startsWith('/') || /^[A-Za-z]:[\\/]/.test(href)
          // Strip a trailing ":line" or ":line:col" suffix so the file URL is
          // a plain path; preserve the location as the URL fragment instead.
          // Without this, the colon survives into url.pathname downstream and
          // fs.stat rejects the path on Windows (':' is invalid in filenames).
          const suffixMatch = href.match(/^(.+?\.[A-Za-z0-9]{1,10}):(\d+)(?::(\d+))?$/)
          const cleanHref = suffixMatch ? suffixMatch[1] : href
          const line = suffixMatch ? Number(suffixMatch[2]) : undefined
          const column = suffixMatch?.[3] ? Number(suffixMatch[3]) : undefined
          const absPath = isAbs ? cleanHref : resolveRelativePath(cwd, cleanHref)
          return `<a ${attrs}href="${pathToFileUrl(absPath, line, column)}"`
        }
      )
    : parsedHtml
  const masked: string[] = []
  const placeheld = rawHtml.replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, m => {
    masked.push(m)
    return `\x00MD${masked.length - 1}\x00`
  })
  const collapsed = placeheld.replace(/>\s+</g, '><')
  const cleanHtml = collapsed.replace(/\x00MD(\d+)\x00/g, (_, i) => masked[Number(i)])
  const result = DOMPurify.sanitize(cleanHtml, {
    ADD_TAGS: ['input'],
    ADD_ATTR: ['checked', 'disabled', 'type', 'data-external-link'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|file):/i,
  })
  if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
    const oldestKey = markdownCache.keys().next().value
    if (oldestKey !== undefined) markdownCache.delete(oldestKey)
  }
  markdownCache.set(cacheKey, result)
  return result
}

export function openChatMarkdownLink(href: string): void {
  if (href.startsWith('file://')) {
    try {
      const url = new URL(href)
      let filePath = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
      if (url.hostname && url.hostname !== 'localhost') filePath = `//${url.hostname}${filePath}`
      const lineMatch = url.hash.match(/(?:^#|[&#])line=(\d+)(?:[&#]column=(\d+))?/)
      const detail = {
        path: filePath,
        line: lineMatch ? Number(lineMatch[1]) : undefined,
        column: lineMatch?.[2] ? Number(lineMatch[2]) : undefined,
        fragment: !lineMatch && url.hash ? url.hash : undefined,
      }
      const eventName = /\.mdx?$/i.test(filePath) ? 'preview-markdown' : 'preview-file'
      window.dispatchEvent(new CustomEvent(eventName, { detail }))
      return
    } catch {
      // fall through to openExternal
    }
  }
  host.shell.openExternal(href)
}
