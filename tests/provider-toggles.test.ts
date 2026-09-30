import * as assert from 'node:assert/strict'

import { toolsToAutoInstall } from '../renderer/src/lib/runtime-auto-install.ts'
import {
  canDisableProvider,
  enabledProviderIds,
  isPresetEnabled,
  isProviderEnabled,
  requiredRuntimes,
  resolveDefaultAgentPreset,
} from '../shared/providers.mjs'

const release = { debug: false }
const debug = { debug: true }

function testDefaults() {
  // No setting: every provider's defaultEnabled applies; debug-only providers
  // (Fugu) only count in debug mode.
  assert.deepEqual(enabledProviderIds(undefined, release), ['claude', 'codex'])
  assert.deepEqual(enabledProviderIds(undefined, debug), ['claude', 'codex', 'fugu'])
  assert.deepEqual(enabledProviderIds({}, release), ['claude', 'codex'])
}

function testToggles() {
  const noCodex = { codex: { enabled: false } }
  assert.deepEqual(enabledProviderIds(noCodex, release), ['claude'])
  assert.equal(isProviderEnabled('codex', noCodex, release), false)
  assert.equal(isProviderEnabled('claude', noCodex, release), true)
  assert.equal(isProviderEnabled('nope', noCodex, release), false)

  assert.equal(isPresetEnabled('codex-agent', noCodex, release), false)
  assert.equal(isPresetEnabled('codex-cli', noCodex, release), false)
  assert.equal(isPresetEnabled('claude-code', noCodex, release), true)
  // Provider-less presets (plain terminal) and unknown ids are never filtered.
  assert.equal(isPresetEnabled('none', noCodex, release), true)
  assert.equal(isPresetEnabled('unknown-preset', noCodex, release), true)
  // Fugu stays available in debug mode even with Codex off: it is its own provider.
  assert.equal(isPresetEnabled('codex-fugu', noCodex, debug), true)

  // Malformed entries are ignored rather than treated as "disabled".
  assert.deepEqual(enabledProviderIds({ codex: { enabled: 'no' } } as never, release), ['claude', 'codex'])
}

function testAtLeastOneProvider() {
  // A setting that disables every provider falls back to the defaults, so the
  // app can never end up with no agent at all.
  const allOff = { claude: { enabled: false }, codex: { enabled: false }, fugu: { enabled: false } }
  assert.deepEqual(enabledProviderIds(allOff, release), ['claude', 'codex'])
  // In release mode Fugu does not count, so claude+codex off is also "none left".
  assert.deepEqual(enabledProviderIds({ claude: { enabled: false }, codex: { enabled: false } }, release), ['claude', 'codex'])
}

function testRequiredRuntimes() {
  assert.deepEqual([...requiredRuntimes(undefined, release)].sort(), ['claude', 'codex'])
  assert.deepEqual([...requiredRuntimes({ codex: { enabled: false } }, release)], ['claude'])
  assert.deepEqual([...requiredRuntimes({ claude: { enabled: false } }, release)], ['codex'])
  // Fugu runs on the Codex runtime.
  assert.deepEqual([...requiredRuntimes({ codex: { enabled: false } }, debug)].sort(), ['claude', 'codex'])
}

function testCanDisable() {
  assert.equal(canDisableProvider('codex', undefined, release), true)
  // The last enabled provider cannot be switched off.
  assert.equal(canDisableProvider('claude', { codex: { enabled: false } }, release), false)
  // Debug-only providers do not count as "another enabled provider" in release mode.
  assert.equal(canDisableProvider('claude', { codex: { enabled: false } }, debug), true)
  // Already disabled: nothing to guard.
  assert.equal(canDisableProvider('codex', { codex: { enabled: false } }, release), true)
}

function testAutoInstallTools() {
  assert.deepEqual(toolsToAutoInstall(new Set(['claude', 'codex'])), ['node', 'codex', 'claude'])
  // A disabled provider's runtime is never auto-installed; Node always is.
  assert.deepEqual(toolsToAutoInstall(new Set(['claude'])), ['node', 'claude'])
  assert.deepEqual(toolsToAutoInstall(new Set(['codex'])), ['node', 'codex'])
}

function testDefaultAgent() {
  assert.equal(resolveDefaultAgentPreset('codex-agent', undefined, release), 'codex-agent')
  assert.equal(resolveDefaultAgentPreset(undefined, undefined, release), 'claude-code')
  // The preferred default's provider is off: fall back to an enabled agent.
  assert.equal(resolveDefaultAgentPreset('codex-agent', { codex: { enabled: false } }, release), 'claude-code')
  assert.equal(resolveDefaultAgentPreset('claude-code', { claude: { enabled: false } }, release), 'codex-agent')
  // A debug-only preset is not a default outside debug mode.
  assert.equal(resolveDefaultAgentPreset('codex-fugu', undefined, release), 'claude-code')
  // Provider-less presets (plain terminal) stay as chosen.
  assert.equal(resolveDefaultAgentPreset('none', { codex: { enabled: false } }, release), 'none')
}

testDefaults()
testToggles()
testDefaultAgent()
testCanDisable()
testAutoInstallTools()
testAtLeastOneProvider()
testRequiredRuntimes()
console.log('provider-toggles: passed')
