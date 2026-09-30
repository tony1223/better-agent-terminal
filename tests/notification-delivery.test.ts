import assert from 'node:assert/strict'
import { shouldAnnounceNotification, SYSTEM_NOTIFICATION_MAX_AGE_MS, REMOTE_NOTIFICATION_MAX_AGE_MS } from '../renderer/src/utils/notification-delivery'

const completedAt = Date.parse('2026-09-05T07:03:27.886Z')
const resumedAt = Date.parse('2026-09-05T07:38:12.179Z')
const entry = { timestamp: completedAt }

assert.equal(shouldAnnounceNotification(entry, false, completedAt + 100), true)
assert.equal(shouldAnnounceNotification(entry, false, resumedAt), false,
  '15:03 completions queued until 15:38 must not appear as new OS toasts')
assert.equal(shouldAnnounceNotification(entry, false, completedAt + SYSTEM_NOTIFICATION_MAX_AGE_MS), true)
assert.equal(shouldAnnounceNotification(entry, false, completedAt + SYSTEM_NOTIFICATION_MAX_AGE_MS + 1), false)
assert.equal(shouldAnnounceNotification({ ...entry, nativeNotificationHandled: true }, false, completedAt), false,
  'native delivery or intentional suppression must not be repeated by the renderer')
assert.equal(shouldAnnounceNotification({ ...entry, nativeNotificationHandled: false }, false, completedAt), true,
  'older host payloads retain renderer delivery')
assert.equal(shouldAnnounceNotification({ timestamp: NaN }, false, completedAt), false)
assert.equal(shouldAnnounceNotification({ ...entry, nativeNotificationHandled: true }, true, completedAt), true,
  'remote clients still receive their own OS notification')
assert.equal(shouldAnnounceNotification(entry, true, resumedAt), true,
  'a remote host clock may be behind the client clock')

// Remote replays: a client window that opened (or reconnected) after the host
// kept days-old unread entries must not toast them again. The host's own
// newest entry is the reference for "how old", so host clock skew is moot.
const daysAgo = completedAt - 3 * 24 * 60 * 60_000
assert.equal(shouldAnnounceNotification({ timestamp: daysAgo }, true, completedAt), false,
  'a remote entry from three days ago is never a fresh toast')
assert.equal(shouldAnnounceNotification({ timestamp: completedAt - REMOTE_NOTIFICATION_MAX_AGE_MS }, true, completedAt), true)
assert.equal(shouldAnnounceNotification({ timestamp: completedAt - REMOTE_NOTIFICATION_MAX_AGE_MS - 1 }, true, completedAt), false)
assert.equal(shouldAnnounceNotification({ timestamp: completedAt - 10 * 60_000 }, true, completedAt, completedAt), false,
  'an entry ten minutes behind the host\'s latest completion is a replay, not news')
assert.equal(shouldAnnounceNotification({ timestamp: completedAt }, true, completedAt + 5_000, completedAt), true,
  'the host\'s latest completion is announced')
assert.equal(shouldAnnounceNotification({ timestamp: completedAt - 30_000 }, true, completedAt + 5_000, completedAt), true,
  'a burst of completions within a minute of the latest is announced')
assert.equal(shouldAnnounceNotification({ timestamp: NaN }, true, completedAt), false)

console.log('notification-delivery: passed')
