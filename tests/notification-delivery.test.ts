import assert from 'node:assert/strict'
import { shouldAnnounceNotification, SYSTEM_NOTIFICATION_MAX_AGE_MS } from '../renderer/src/utils/notification-delivery'

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

console.log('notification-delivery: passed')
