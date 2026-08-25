/** Single source of truth for "what can we preview, and how".
 *
 * FileTree and PathLinker each used to carry their own copy of these tables,
 * and the copies had already drifted apart: `.sql` previewed fine in the
 * path-link modal but reported "Preview not available" in the file browser
 * sidebar, purely because only PathLinker's list happened to mention it.
 * Anything that decides a preview type now lives here, so the two surfaces
 * cannot disagree again.
 */

/** Strip directories so a bare name and a full path classify identically.
 *  PathLinker used to split the whole path on '.', which mis-reads a path
 *  like `C:\some.dir\README` as extension "dir\README". */
function basename(nameOrPath: string): string {
  return nameOrPath.split(/[\\/]/).pop() || nameOrPath
}

export function getFileExt(nameOrPath: string): string {
  const lower = basename(nameOrPath).toLowerCase()
  // Dotfiles (.gitignore, .env) carry the name itself as the extension.
  if (lower.startsWith('.') && !lower.includes('.', 1)) return lower.slice(1)
  return lower.split('.').pop() || ''
}

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

/** Union of what the two surfaces previously accepted, plus `csv`. */
export const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'jsonl', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'ps1', 'cmd', 'bat', 'plist', 'nuspec',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'gs',
  'pine', 'lua', 'r', 'pl', 'php', 'swift', 'kt', 'scala', 'sql', 'graphql',
  'env', 'gitignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'dockerfile', 'makefile', 'license', 'cfg', 'ini', 'conf', 'log', 'output',
  'csv',
])

/** hljs language per extension. Every value here must be registered in
 *  PathLinker's `hljs.registerLanguage` block, otherwise highlight() throws
 *  and HighlightedCode silently falls back to escaped plain text. */
export const EXT_TO_LANG: Record<string, string> = {
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

export type PreviewKind = 'text' | 'image' | 'pdf'

/** Extensions whose "rendered" mode is something other than highlighted source.
 *  Each of these gets a Preview/Source toggle. */
export type RichPreviewKind = 'markdown' | 'html' | 'csv'

/** `isProcfile` is passed in rather than imported so this module stays free of
 *  component-layer dependencies and remains trivially testable. */
export function canPreview(nameOrPath: string, isProcfile = false): PreviewKind | null {
  if (isProcfile) return 'text'
  const ext = getFileExt(nameOrPath)
  if (TEXT_EXTS.has(ext)) return 'text'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  return null
}

/** Shell/script files, which get a "copy the whole script" button in the
 *  preview. The point is grabbing the body to paste into a terminal, so the
 *  whole shell family is included rather than just .sh/.ps1 — it would be odd
 *  for .bash to lack the button that .sh has. */
const SCRIPT_EXTS = new Set(['sh', 'bash', 'zsh', 'ps1', 'cmd', 'bat'])

export function isScriptFile(nameOrPath: string): boolean {
  return SCRIPT_EXTS.has(getFileExt(nameOrPath))
}

export function getRichPreviewKind(nameOrPath: string): RichPreviewKind | null {
  switch (getFileExt(nameOrPath)) {
    case 'md': return 'markdown'
    case 'html': case 'htm': return 'html'
    case 'csv': return 'csv'
    default: return null
  }
}
