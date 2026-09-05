// Queued/replayed updates still belong in the bell, but should not produce a
// fresh OS toast tens of minutes after a background window resumes.
export const SYSTEM_NOTIFICATION_MAX_AGE_MS = 60_000

export function shouldAnnounceNotification(
  entry: { timestamp: number; nativeNotificationHandled?: boolean },
  isRemote: boolean,
  now = Date.now(),
): boolean {
  // A remote host's native toast was on that host, not this client machine.
  // Its clock is not necessarily synchronized with ours either.
  if (isRemote) return true
  if (entry.nativeNotificationHandled === true) return false
  return Number.isFinite(entry.timestamp) && now - entry.timestamp <= SYSTEM_NOTIFICATION_MAX_AGE_MS
}
