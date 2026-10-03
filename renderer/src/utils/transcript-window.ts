export const TRANSCRIPT_BYTE_BUDGET = 8 * 1024 * 1024
export const TRANSCRIPT_VISIBLE_LIMIT = 120
const weights = new WeakMap<object, number>()

// Estimate retained UTF-16 payload without serializing/copying large results.
// Message objects are replaced on updates, so the weak cache releases old rows.
export function transcriptWeight(item: unknown): number {
  if (typeof item === 'string') return item.length * 2
  if (item === null || typeof item !== 'object') return 8
  const cached = weights.get(item)
  if (cached !== undefined) return cached
  const seen = new Set<object>()
  const visit = (value: unknown): number => {
    if (typeof value === 'string') return value.length * 2
    if (value === null || typeof value !== 'object') return 8
    if (seen.has(value)) return 0
    seen.add(value)
    let size = 64
    for (const [key, child] of Object.entries(value)) size += key.length * 2 + visit(child)
    return size
  }
  const size = visit(item)
  weights.set(item, size)
  return size
}

export function fittingTranscriptCount(items: readonly unknown[], fromStart = false, budget = TRANSCRIPT_BYTE_BUDGET): number {
  let count = 0
  let size = 0
  for (let i = 0; i < items.length; i++) {
    const weight = transcriptWeight(items[fromStart ? i : items.length - 1 - i])
    // One oversized row remains readable; never silently truncate its content.
    if (count > 0 && size + weight > budget) break
    size += weight
    count++
    if (size > budget) break
  }
  return count
}

export function transcriptArchivePrefix<T extends { status?: string }>(items: readonly T[]): T[] {
  const overCount = items.length > 160
  const fitting = fittingTranscriptCount(items)
  if (!overCount && fitting === items.length) return []
  let excess = items.length - Math.min(TRANSCRIPT_VISIBLE_LIMIT, fitting)
  // The archive is append-only. Keep a contiguous suffix beginning at any
  // unfinished tool or unacknowledged user prompt so its final state is saved.
  const unfinished = items.findIndex(item => item.status === 'running' || item.status === 'sending' || item.status === 'failed')
  if (unfinished >= 0) excess = Math.min(excess, unfinished)
  return items.slice(0, excess)
}

export interface ArchiveResult { messages: unknown[]; total: number; hasMore: boolean; promptIds?: string[] }
export interface ArchivePage<T> { items: T[]; start: number; end: number; total: number }
type ArchiveLoader = (offset: number, limit: number) => Promise<ArchiveResult>

// Page positions are absolute row indices, so newly appended archive rows do
// not move the page the reader is viewing. Older hosts keep the same IPC.
export async function readArchivePage<T>(load: ArchiveLoader, normalize: (items: unknown[]) => T[],
  request: { total: number; end?: number; start?: number; limit: number }): Promise<ArchivePage<T>> {
  let total = request.total
  let limit = request.limit
  for (let attempt = 0; attempt < 12; attempt++) {
    if (request.start !== undefined) limit = Math.min(limit, Math.max(0, total - request.start))
    const wantedEnd = request.start !== undefined ? request.start + limit : request.end
    const offset = wantedEnd === undefined ? 0 : Math.max(0, total - wantedEnd)
    const result = await load(offset, limit)
    const nextTotal = Math.max(0, result.total)
    if (wantedEnd !== undefined && nextTotal !== total) { total = nextTotal; continue }
    total = nextTotal
    const end = Math.max(0, total - offset)
    const start = Math.max(0, end - limit)
    const items = normalize(result.messages || [])
    const fitting = fittingTranscriptCount(items, request.start !== undefined)
    if (fitting < items.length) { limit = Math.max(1, fitting); continue }
    return { items, start, end, total }
  }
  throw new Error('Archive changed while reading; retry the page')
}

// A write acknowledgement may arrive after a result updated a tool row. Only
// release the exact snapshots that were saved, preserving the newer version.
export function releaseArchivedSnapshots<T extends { id: string }>(items: T[], snapshots: readonly T[]): T[] {
  const saved = new Map(snapshots.map(item => [item.id, item]))
  return items.filter(item => saved.get(item.id) !== item)
}

// Bound serialization/IPC copies too, rather than submitting one huge history
// snapshot. An oversized single row is sent intact. Failure keeps the originals.
export async function persistTranscriptArchive<T>(items: readonly T[], write: (batch: T[]) => Promise<boolean>): Promise<boolean> {
  let start = 0
  while (start < items.length) {
    let end = start
    let size = 0
    while (end < items.length && end - start < 40) {
      const weight = transcriptWeight(items[end])
      if (end > start && size + weight > TRANSCRIPT_BYTE_BUDGET) break
      size += weight
      end++
      if (size > TRANSCRIPT_BYTE_BUDGET) break
    }
    if (!await write(items.slice(start, end))) return false
    start = end
  }
  return true
}

// Paging changes visible prompt numbering. Resolve an explicit rewind by ID
// against disk, retaining only one archive page and the small live suffix.
export async function resolveTranscriptPrompt<T extends { id: string; role?: string }>(
  targetId: string, live: readonly T[], load: ArchiveLoader, normalize: (items: unknown[]) => T[],
): Promise<{ index: number; count: number }> {
  const liveUsers = live.filter(item => item.role === 'user')
  const metadata = await load(0, 0)
  if (Array.isArray(metadata.promptIds)) {
    const archivedIds = new Set(metadata.promptIds)
    const remaining = liveUsers.filter(item => !archivedIds.has(item.id))
    const archivedIndex = metadata.promptIds.indexOf(targetId)
    const liveIndex = remaining.findIndex(item => item.id === targetId)
    if (archivedIndex < 0 && liveIndex < 0) throw new Error('Prompt is no longer in the current transcript')
    return { index: archivedIndex >= 0 ? archivedIndex : metadata.promptIds.length + liveIndex,
      count: metadata.promptIds.length + remaining.length }
  }
  const duplicated = new Set<string>()
  const liveIds = new Set(liveUsers.map(item => item.id))
  let archivedUsers = 0
  let targetReverseIndex: number | undefined
  let end: number | undefined
  let total = 0
  do {
    const page = await readArchivePage(load, normalize, { total, end, limit: 120 })
    total = page.total
    for (let i = page.items.length - 1; i >= 0; i--) {
      const item = page.items[i]
      if (item.role !== 'user') continue
      if (liveIds.has(item.id)) duplicated.add(item.id)
      if (item.id === targetId) targetReverseIndex = archivedUsers
      archivedUsers++
    }
    end = page.start
  } while (end > 0)
  const remaining = liveUsers.filter(item => !duplicated.has(item.id))
  const liveIndex = remaining.findIndex(item => item.id === targetId)
  if (targetReverseIndex === undefined && liveIndex < 0) throw new Error('Prompt is no longer in the current transcript')
  return {
    index: targetReverseIndex !== undefined ? archivedUsers - 1 - targetReverseIndex : archivedUsers + liveIndex,
    count: archivedUsers + remaining.length,
  }
}
