import * as assert from 'node:assert/strict'

import {
  normalizeRemoteAuthCapabilities,
  supportsRemoteLogin,
} from '../renderer/src/utils/remote-auth.ts'

const current = normalizeRemoteAuthCapabilities({
  connected: true,
  capabilities: {
    remoteAuth: {
      claude: 'paste-code-v1',
      codex: 'device-code-v1',
    },
  },
})
assert.equal(supportsRemoteLogin(current, 'claude'), true)
assert.equal(supportsRemoteLogin(current, 'codex'), true)

const legacy = normalizeRemoteAuthCapabilities({ connected: true })
assert.equal(legacy, null)
assert.equal(supportsRemoteLogin(legacy, 'claude'), false)
assert.equal(supportsRemoteLogin(legacy, 'codex'), false)

const futureOnly = normalizeRemoteAuthCapabilities({
  capabilities: { remoteAuth: { codex: 'device-code-v2' } },
})
assert.equal(supportsRemoteLogin(futureOnly, 'codex'), false)

console.log('remote-auth-capabilities: passed')
