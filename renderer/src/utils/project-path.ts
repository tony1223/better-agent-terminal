// Paths belong to the host, which can have a different OS from this renderer.
export function projectPathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function projectParentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized || /^[a-z]:$/i.test(normalized)) return normalized ? `${normalized}/` : '/'
  // A UNC share is a root; do not scan its server as if it were a directory.
  if (/^\/\/[^/]+\/[^/]+$/.test(normalized)) return normalized
  const index = normalized.lastIndexOf('/')
  if (index < 0) return ''
  if (index === 0) return '/'
  if (index === 2 && /^[a-z]:/i.test(normalized)) return normalized.slice(0, 3)
  return normalized.slice(0, index)
}
