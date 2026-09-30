import * as assert from 'node:assert/strict'

import {
  accountChipProviderOf,
  accountSwitchedEvent,
  cliRuntimeOf,
  hostProviderOf,
  sessionUsageProvider,
  usageProviderOf,
} from '../renderer/src/providers/account-routing.ts'
import { usageSnapshotFromPayload } from '../renderer/src/utils/claude-usage-cache.ts'
import { normalizeRemoteAuthCapabilities, supportsRemoteLogin } from '../renderer/src/utils/remote-auth.ts'
import { PROVIDER_MANIFEST } from '../shared/providers.mjs'

function testAccountChipProvider() {
  // Before the registry the chip covered exactly these presets (WorkspaceView
  // refreshAccountChip); Fugu had none and now gets its own provider's chip.
  const expected: Record<string, string | null> = {
    'claude-code': 'claude',
    'claude-code-v2': 'claude',
    'claude-code-worktree': 'claude',
    'claude-channel': 'claude',
    'claude-cli-agent': 'claude',
    'claude-cli': null,
    'claude-cli-worktree': null,
    'codex-agent': 'codex',
    'codex-agent-worktree': 'codex',
    'codex-fugu': 'fugu',
    'codex-cli': null,
    none: null,
  }
  for (const preset of PROVIDER_MANIFEST.presets) {
    assert.equal(accountChipProviderOf(preset.id), expected[preset.id], `chip provider of ${preset.id}`)
  }
  assert.equal(accountChipProviderOf(undefined), null)
  assert.equal(accountChipProviderOf('unknown-preset'), null)
}

function testAccountEvents() {
  assert.equal(accountSwitchedEvent('claude'), 'claude-account-switched')
  assert.equal(accountSwitchedEvent('codex'), 'codex-account-switched')
  assert.equal(accountSwitchedEvent('fugu'), 'fugu-account-switched')
  // Host broadcasts claude:account-changed {agent}; older hosts only send
  // claude/codex, and anything unrecognised was always treated as claude.
  assert.equal(hostProviderOf('codex'), 'codex')
  assert.equal(hostProviderOf('fugu'), 'fugu')
  assert.equal(hostProviderOf('claude'), 'claude')
  assert.equal(hostProviderOf(undefined), 'claude')
  assert.equal(hostProviderOf('something-else'), 'claude')
}

function testUsageAndRuntime() {
  assert.equal(usageProviderOf('claude'), 'claude')
  assert.equal(usageProviderOf('codex'), 'codex')
  assert.equal(usageProviderOf('fugu'), null)
  assert.equal(usageProviderOf(undefined), null)
  assert.equal(cliRuntimeOf('claude'), 'claude')
  assert.equal(cliRuntimeOf('codex'), 'codex')
  assert.equal(cliRuntimeOf('fugu'), 'codex')
  assert.equal(cliRuntimeOf('nope'), undefined)
}

function testSessionUsageProvider() {
  // Statusline usage follows the session's provider.
  assert.equal(sessionUsageProvider('claude-code', 'claude'), 'claude')
  assert.equal(sessionUsageProvider('codex-agent-worktree', 'codex'), 'codex')
  // Fugu reports no usage (it used to show the Codex account's windows).
  assert.equal(sessionUsageProvider('codex-fugu', 'codex'), null)
  // No preset yet: the runtime's default provider.
  assert.equal(sessionUsageProvider(undefined, 'codex'), 'codex')
  assert.equal(sessionUsageProvider(undefined, 'claude'), 'claude')
}

function testUsageSnapshotParsing() {
  const claude = usageSnapshotFromPayload({
    provider: 'claude',
    fiveHour: { utilization: 0.25, resetsAt: '2026-09-30T12:00:00Z' },
    sevenDay: null,
    fetchedAt: 1,
  })
  assert.equal(claude?.provider, 'claude')
  assert.equal(claude?.fiveHour?.utilization, 0.25)
  assert.equal(claude?.fiveHour?.resetsAt, Date.parse('2026-09-30T12:00:00Z'))

  // Codex rate-limit reads may carry only explicit nulls; they clear the windows.
  const codexCleared = usageSnapshotFromPayload({ provider: 'codex', fiveHour: null, sevenDay: null })
  assert.equal(codexCleared?.provider, 'codex')
  assert.equal(codexCleared?.fiveHour, null)
  // ...but a Claude payload without windows is unusable, as before.
  assert.equal(usageSnapshotFromPayload({ provider: 'claude', fiveHour: null, sevenDay: null }), null)

  // Hosts only ever tagged claude/codex; anything unrecognised meant claude.
  assert.equal(usageSnapshotFromPayload({ fiveHour: { utilization: 0.1, resetsAt: 5 } })?.provider, 'claude')
  assert.equal(usageSnapshotFromPayload(null), null)
}

function testRemoteLoginIsKeyedByAuthKind() {
  const current = normalizeRemoteAuthCapabilities({
    capabilities: { remoteAuth: { claude: 'paste-code-v1', codex: 'device-code-v1', fugu: 'paste-code-v1' } },
  })
  assert.deepEqual(current, { claude: 'paste-code-v1', codex: 'device-code-v1' },
    'only providers with a remote sign-in ceremony are kept')
  assert.equal(supportsRemoteLogin(current, 'claude'), true)
  assert.equal(supportsRemoteLogin(current, 'codex'), true)
  // API-key providers have no remote sign-in ceremony.
  assert.equal(supportsRemoteLogin({ fugu: 'paste-code-v1' }, 'fugu'), false)
  assert.equal(supportsRemoteLogin(current, 'nope'), false)
}

testAccountChipProvider()
testAccountEvents()
testUsageAndRuntime()
testSessionUsageProvider()
testUsageSnapshotParsing()
testRemoteLoginIsKeyedByAuthKind()
console.log('provider-accounts: passed')
