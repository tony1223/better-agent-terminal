// The sidecar runs its sources unbundled in dev, so the shared provider
// registry (and its JSON import attribute) must load in plain Node.
import assert from 'node:assert/strict'
import { providerOfPreset, sdkRuntimeFamilyOfPreset, validateProviderManifest, PROVIDER_MANIFEST } from '../../shared/providers.mjs'

assert.deepEqual(validateProviderManifest(PROVIDER_MANIFEST), [])
assert.equal(providerOfPreset('codex-fugu'), 'fugu')
assert.equal(sdkRuntimeFamilyOfPreset('codex-agent-worktree'), 'codex')
assert.equal(sdkRuntimeFamilyOfPreset('claude-cli'), null)
console.log('sidecar providers tests passed')
