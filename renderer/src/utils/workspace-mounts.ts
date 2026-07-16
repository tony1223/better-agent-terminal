export function rememberMountedWorkspace(
  previous: ReadonlySet<string>,
  workspaceId: string,
): Set<string> {
  if (previous.has(workspaceId) && previous instanceof Set) return previous
  return new Set(previous).add(workspaceId)
}
