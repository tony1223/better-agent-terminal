// Deduping the archived + live message merge.
//
// Both panels render `[...loadedArchive, ...messages]`, and neither list is
// guaranteed to be disjoint from the other: the live window is the host's last
// N messages, whose head has usually already been archived. On top of that,
// archives written before the append was made idempotent contain the same row
// several times over, and those files are not migrated — so the merge has to
// tolerate repeats rather than assume they were prevented upstream.
//
// The last occurrence wins. In the overlap case the duplicate pair is
// (archived copy, live copy) of the same row, and the live copy is the host's
// current view — a tool call that has since completed reads as completed rather
// than reverting to running. Ordering is unaffected: keeping the last
// occurrence of an id that spans the archive/live boundary puts it exactly
// where the live block starts, which is where it belongs chronologically.

/** Returns the input array itself when nothing repeats, so memoized callers keep referential equality. */
export function dedupeMessagesById<T extends { id: string }>(items: T[]): T[] {
  let duplicates = false
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) {
      duplicates = true
      break
    }
    seen.add(item.id)
  }
  if (!duplicates) return items

  // Walk backwards keeping the first sighting of each id — that is the last
  // occurrence — then restore the original order.
  const kept: T[] = []
  const keptIds = new Set<string>()
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (keptIds.has(item.id)) continue
    keptIds.add(item.id)
    kept.push(item)
  }
  kept.reverse()
  return kept
}
