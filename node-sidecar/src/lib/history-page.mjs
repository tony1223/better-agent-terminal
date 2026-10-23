import { open } from 'node:fs/promises'

export const HISTORY_MAX_BYTES = 2 * 1024 * 1024
export const HISTORY_MAX_ENTRIES = 500
// Includes room for the remote/event envelope. Keep in sync with Rust.
export const HISTORY_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
// Legacy frames duplicate history in params and args. Reserve envelope space.
export const HISTORY_PAGE_MAX_BYTES = HISTORY_RESPONSE_MAX_BYTES / 2 - 64 * 1024

export function historyGap(id, sizeBytes, sessionId) {
  id = String(id ?? 'unknown').slice(0, 256)
  return { id, sessionId, role: 'system', content: `[History gap: oversized record/range omitted (${sizeBytes} bytes; ${id})]`, timestamp: 0, historyGap: { id, sizeBytes } }
}

export function boundHistoryItems(items, sessionId) {
  const limit = HISTORY_PAGE_MAX_BYTES
  return items.map(item => {
    const size = Buffer.byteLength(JSON.stringify(item))
    return size >= limit / 2 ? historyGap(item.id, size, sessionId) : item
  })
}

// Exclusive byte-offset cursors remain stable as the file grows.
// Callers may override either cap through maxBytes/maxEntries.
export async function readHistoryPage(path, { before, maxBytes = HISTORY_MAX_BYTES, maxEntries = HISTORY_MAX_ENTRIES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid history limits')
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0 || before > size)) throw new Error('Invalid history cursor')
    const end = before ?? size
    const start = Math.max(0, end - maxBytes)
    const buffer = Buffer.alloc(end - start)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    const data = buffer.subarray(0, bytesRead)
    // Probe one byte to distinguish a line boundary from a partial first line.
    let offset = 0
    let partialFirstLine = false
    if (start > 0) {
      const previous = Buffer.alloc(1)
      await file.read(previous, 0, 1, start - 1)
      if (previous[0] !== 10) {
        partialFirstLine = true
        const newline = data.indexOf(10)
        offset = newline < 0 ? data.length : newline + 1
      }
    }
    const lines = []
    while (offset < data.length) {
      const newline = data.indexOf(10, offset)
      const next = newline < 0 ? data.length : newline + 1
      if (data.subarray(offset, next).toString('utf8').trim()) lines.push({ offset, next })
      offset = next
    }
    const selected = lines.slice(-maxEntries)
    const first = selected[0]?.offset ?? data.length
    // A record longer than the read window is represented by byte-range gap
    // markers. No unbounded scan is needed to find its beginning; each marker
    // has a stable id and exact omitted range size, even across older pages.
    const cursor = selected.length ? start + first : start
    return { gap: !selected.length && partialFirstLine ? { id: `hist-gap-${start}-${end}`, sizeBytes: end - start } : null, start: start + first, raw: data.subarray(first).toString('utf8'), before: cursor > 0 ? cursor : null, hasMore: cursor > 0, bytesRead: bytesRead + (start > 0 ? 1 : 0) }
  } finally { await file.close() }
}
