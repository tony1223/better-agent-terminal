export interface FilePickerSearchEntry {
  name: string
  path: string
  isDirectory: boolean
}

function matchRank(name: string, query: string): number {
  const lowerName = name.toLocaleLowerCase()
  const lowerQuery = query.trim().toLocaleLowerCase()
  if (!lowerQuery) return 4
  if (lowerName === lowerQuery) return 0
  if (lowerName.startsWith(lowerQuery)) return 1
  const stem = lowerName.replace(/\.[^.]+$/, '')
  if (stem === lowerQuery || stem.startsWith(lowerQuery)) return 2
  if (lowerName.includes(lowerQuery)) return 3
  return 4
}

// Ctrl+P is a file picker, not a directory navigator. Older remote hosts do
// not understand the additive `filesOnly` search flag and may still return
// directories, so filter on the client as a compatibility fallback. Ranking
// exact/prefix matches also keeps a large remote workspace deterministic.
export function prepareFilePickerResults(
  entries: readonly FilePickerSearchEntry[] | null | undefined,
  query: string,
  limit = 100,
): FilePickerSearchEntry[] {
  const seen = new Set<string>()
  return (entries || [])
    .filter((entry) => {
      if (entry.isDirectory || !entry.path || seen.has(entry.path)) return false
      seen.add(entry.path)
      return true
    })
    .sort((a, b) => {
      const rank = matchRank(a.name, query) - matchRank(b.name, query)
      if (rank !== 0) return rank
      const length = a.name.length - b.name.length
      if (length !== 0) return length
      const name = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      return name !== 0 ? name : a.path.localeCompare(b.path)
    })
    .slice(0, Math.max(0, limit))
}
