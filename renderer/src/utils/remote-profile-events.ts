export type ProfileEntryLike = {
  id?: string
  type?: string
  remoteProfileId?: string
}

export type ProfileChangedPayload = {
  profiles?: ProfileEntryLike[]
  activeProfileIds?: string[]
  remoteOrigin?: string
}

export function normalizeProfileChangedPayload(payload: unknown): ProfileChangedPayload | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const profiles = Array.isArray(record.profiles)
    ? record.profiles
      .filter((profile): profile is Record<string, unknown> => !!profile && typeof profile === 'object')
      .map(profile => ({
        id: typeof profile.id === 'string' ? profile.id : undefined,
        type: typeof profile.type === 'string' ? profile.type : undefined,
        remoteProfileId: typeof profile.remoteProfileId === 'string' ? profile.remoteProfileId : undefined,
      }))
    : undefined
  const activeProfileIds = Array.isArray(record.activeProfileIds)
    ? record.activeProfileIds.filter((id): id is string => typeof id === 'string')
    : undefined
  const remoteOrigin = typeof record.remoteOrigin === 'string' && record.remoteOrigin.trim()
    ? record.remoteOrigin
    : undefined
  return { profiles, activeProfileIds, remoteOrigin }
}

// Local profile events have no origin and must remain visible to every window
// (for example, deleting the local alias that owns a remote window). Proxied
// host events are accepted only by windows bound to that exact host. Profile
// ids such as "default" are host-local and are not globally unique.
export function profileChangeMatchesRemoteOrigin(
  payload: ProfileChangedPayload | null,
  viewedRemoteOrigin: string | null,
): boolean {
  if (!payload?.remoteOrigin) return true
  return payload.remoteOrigin === viewedRemoteOrigin
}
