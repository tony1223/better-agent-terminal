import assert from 'node:assert/strict'

import {
  isTrustedClaudeLoginUrl,
  loginIdMatches,
  sanitizeLoginError,
} from '../src/handlers/claude-auth-login.mjs'

assert.equal(
  sanitizeLoginError(
    '\u001b[31mOAuth failed at https://claude.ai/oauth/authorize?secret=value for ABCD-1234\u001b[0m',
  ),
  'OAuth failed at <redacted-url> for <redacted-code>',
)

assert.equal(loginIdMatches({ loginId: 'owned-login' }, 'owned-login'), true)
assert.equal(loginIdMatches({ loginId: 'owned-login' }, 'other-login'), false)
assert.equal(loginIdMatches({ loginId: 'legacy-login' }, ''), true)
assert.equal(isTrustedClaudeLoginUrl('https://claude.ai/oauth/authorize?x=1'), true)
assert.equal(isTrustedClaudeLoginUrl('https://platform.claude.com/oauth/authorize'), true)
assert.equal(isTrustedClaudeLoginUrl('https://example.com/oauth/authorize'), false)
assert.equal(isTrustedClaudeLoginUrl('http://claude.ai/oauth/authorize'), false)

assert.equal(
  sanitizeLoginError('ordinary authentication failure'),
  'ordinary authentication failure',
)

console.log('claude-auth-login: passed')
