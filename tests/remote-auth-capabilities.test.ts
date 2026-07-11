import * as assert from 'node:assert/strict'

import {
  normalizeRemoteAuthCapabilities,
  supportsRemoteLogin,
} from '../renderer/src/utils/remote-auth.ts'
import { formatAuthErrorMessage, formatErrorMessage } from '../renderer/src/utils/error-message.ts'

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

assert.equal(formatErrorMessage(new Error('native failure'), 'fallback'), 'native failure')
assert.equal(formatErrorMessage({ message: 'remote invoke failed' }, 'fallback'), 'remote invoke failed')
assert.equal(formatErrorMessage({ error: { message: 'nested failure' } }, 'fallback'), 'nested failure')
assert.equal(formatErrorMessage({ unexpected: 'do not stringify me' }, 'fallback'), 'fallback')
assert.equal(formatAuthErrorMessage({ message: 'codex app-server exited' }, 'fallback'), 'codex app-server exited')
assert.equal(
  formatAuthErrorMessage({ message: 'failed at https://auth.openai.com/codex/device for G0GT-244PL' }, 'fallback'),
  'failed at <redacted-url> for <redacted-code>',
)

console.log('remote-auth-capabilities: passed')
