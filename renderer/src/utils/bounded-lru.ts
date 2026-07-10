export function touchBoundedLru(
  previous: ReadonlySet<string>,
  activeId: string,
  limit: number,
  pinned: ReadonlySet<string> = new Set(),
): Set<string> {
  const previousIds = [...previous]
  const next = previousIds.filter(id => id !== activeId)
  next.push(activeId)

  while (next.length > Math.max(1, limit)) {
    const removable = next.findIndex(id => id !== activeId && !pinned.has(id))
    if (removable < 0) break
    next.splice(removable, 1)
  }

  const unchanged = next.length === previous.size
    && next.every((id, index) => id === previousIds[index])
  return unchanged && previous instanceof Set ? previous : new Set(next)
}
