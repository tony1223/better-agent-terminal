// Queued/replayed updates still belong in the bell, but should not produce a
// fresh OS toast tens of minutes after a background window resumes.
export const SYSTEM_NOTIFICATION_MAX_AGE_MS = 60_000
// A remote host's clock is not necessarily synchronized with ours, so its
// entries get a much looser client-clock bound. It only has to reject replays
// of entries that are days old, which is what a reconnect or a fresh remote
// window otherwise re-toasts from the host's still-unread list.
export const REMOTE_NOTIFICATION_MAX_AGE_MS = 60 * 60_000

export function shouldAnnounceNotification(
  entry: { timestamp: number; nativeNotificationHandled?: boolean },
  isRemote: boolean,
  now = Date.now(),
  // Newest timestamp in the same host update. Same clock as the entry, so
  // "how far behind the host's latest completion" needs no skew allowance.
  hostLatest?: number,
): boolean {
  if (!Number.isFinite(entry.timestamp)) return false
  if (isRemote) {
    // The host's native toast was on that host, not this client machine, so
    // nativeNotificationHandled does not apply here.
    if (now - entry.timestamp > REMOTE_NOTIFICATION_MAX_AGE_MS) return false
    if (Number.isFinite(hostLatest) && (hostLatest as number) - entry.timestamp > SYSTEM_NOTIFICATION_MAX_AGE_MS) return false
    return true
  }
  if (entry.nativeNotificationHandled === true) return false
  return now - entry.timestamp <= SYSTEM_NOTIFICATION_MAX_AGE_MS
}
