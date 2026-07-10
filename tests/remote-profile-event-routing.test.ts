import * as assert from 'node:assert/strict'
import {
  normalizeProfileChangedPayload,
  profileChangeMatchesRemoteOrigin,
} from '../renderer/src/utils/remote-profile-events.ts'

const hostADefault = normalizeProfileChangedPayload({
  remoteOrigin: 'host-a:9876',
  profiles: [{ id: 'default', name: 'Default', type: 'local' }],
  activeProfileIds: ['default'],
})
const hostBDefault = normalizeProfileChangedPayload({
  remoteOrigin: 'host-b:9876',
  profiles: [{ id: 'default', name: 'Default', type: 'local' }],
  activeProfileIds: ['default'],
})

assert.equal(profileChangeMatchesRemoteOrigin(hostADefault, 'host-a:9876'), true)
assert.equal(profileChangeMatchesRemoteOrigin(hostADefault, 'host-b:9876'), false)
assert.equal(profileChangeMatchesRemoteOrigin(hostBDefault, 'host-a:9876'), false)
assert.equal(profileChangeMatchesRemoteOrigin(hostBDefault, 'host-b:9876'), true)

const localAliasChange = normalizeProfileChangedPayload({
  profiles: [{ id: 'remote-host-a', name: 'Host A', type: 'remote' }],
  activeProfileIds: ['remote-host-a'],
})
assert.equal(
  profileChangeMatchesRemoteOrigin(localAliasChange, 'host-a:9876'),
  true,
  'local alias changes have no remote origin and must remain visible',
)

console.log('remote profile event routing regression: passed')
