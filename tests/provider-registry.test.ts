import * as assert from 'assert'
import { readFileSync } from 'fs'
import {
  PROVIDER_MANIFEST,
  getPreset,
  getProvider,
  listProviders,
  panelOfPreset,
  presetsOfProvider,
  providerOfPreset,
  sdkRuntimeFamilyOfPreset,
  validateProviderManifest,
} from '../shared/providers.mjs'
import { AGENT_PRESETS, getVisiblePresets } from '../renderer/src/types/agent-presets'

const LEGACY_PRESET_FIELDS = ['id', 'name', 'icon', 'color', 'command', 'debug', 'suggested', 'backend', 'needsGitRepo']

const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-agent-presets.json', import.meta.url), 'utf8'))

function legacyView(preset: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(preset).filter(([key]) => LEGACY_PRESET_FIELDS.includes(key)))
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function testManifestIsValid() {
  assert.deepEqual(validateProviderManifest(PROVIDER_MANIFEST), [], 'shared/providers.json must validate cleanly')
}

function testValidatorRejectsBrokenManifests() {
  const cases: Array<[string, (m: any) => void, RegExp]> = [
    ['duplicate preset id', m => m.presets.push(clone(m.presets[0])), /duplicate preset id "claude-code"/],
    ['duplicate provider id', m => m.providers.push(clone(m.providers[0])), /duplicate provider id "claude"/],
    ['unknown provider ref', m => { m.presets[0].provider = 'nope' }, /preset "claude-code".*unknown provider "nope"/],
    ['unknown panel', m => { m.presets[0].panel = 'nope' }, /preset "claude-code".*unknown panel "nope"/],
    ['unknown auth kind', m => { m.providers[0].auth = 'nope' }, /provider "claude".*unknown auth kind "nope"/],
    ['unknown usage kind', m => { m.providers[0].usage = 'nope' }, /provider "claude".*unknown usage kind "nope"/],
    ['missing name', m => { delete m.presets[0].name }, /preset "claude-code".*name/],
    ['bad schema version', m => { m.schemaVersion = 99 }, /schemaVersion/],
  ]
  for (const [label, mutate, expected] of cases) {
    const manifest = clone(PROVIDER_MANIFEST)
    mutate(manifest)
    const errors = validateProviderManifest(manifest)
    assert.ok(errors.some(error => expected.test(error)), `${label}: expected an error matching ${expected}, got ${JSON.stringify(errors)}`)
  }
}

function testAgentPresetsMatchLegacyList() {
  assert.deepEqual(
    AGENT_PRESETS.map(preset => legacyView(preset as unknown as Record<string, unknown>)),
    fixture.presets,
    'AGENT_PRESETS built from the manifest must equal the pre-registry hard-coded list',
  )
  assert.deepEqual(getVisiblePresets(false).map(p => p.id), fixture.visible)
  assert.deepEqual(getVisiblePresets(true).map(p => p.id), fixture.visibleDebug)
}

function testManifestIsImmutable() {
  assert.ok(Object.isFrozen(PROVIDER_MANIFEST.presets), 'the preset list must be frozen')
  assert.ok(Object.isFrozen(AGENT_PRESETS[0]), 'preset objects must be frozen')
  assert.throws(() => { (AGENT_PRESETS as unknown as unknown[]).sort() }, TypeError)
  // Reflect.set reports the refusal in any mode (a plain assignment only throws in strict mode).
  assert.equal(Reflect.set(getPreset('claude-code')!, 'name', 'x'), false)
  assert.equal(getPreset('claude-code')?.name, 'Claude Agent')
}

function testLookups() {
  assert.deepEqual(listProviders().map(p => p.id), ['claude', 'codex', 'fugu'])
  assert.equal(getProvider('codex')?.auth, 'codex-oauth')
  assert.equal(getProvider('nope'), undefined)
  assert.equal(getPreset('codex-fugu')?.name, 'Codex Fugu Agent')
  assert.equal(getPreset('nope'), undefined)

  assert.equal(providerOfPreset('claude-code-worktree'), 'claude')
  assert.equal(providerOfPreset('codex-cli'), 'codex')
  assert.equal(providerOfPreset('codex-fugu'), 'fugu')
  assert.equal(providerOfPreset('none'), null)
  assert.equal(providerOfPreset('nope'), undefined)
  assert.equal(providerOfPreset(undefined), undefined)

  assert.equal(panelOfPreset('codex-fugu'), 'codex-agent')
  assert.equal(panelOfPreset('claude-cli-worktree'), 'claude-cli')
  assert.equal(panelOfPreset('codex-cli'), 'terminal')

  assert.deepEqual(presetsOfProvider('codex').map(p => p.id), ['codex-agent', 'codex-agent-worktree', 'codex-cli'])
}

function testSdkRuntimeFamilyMatchesLegacyMapping() {
  // Mirrors workspace-store.ts sdkSessionRuntimeFamily() before the registry.
  const legacy: Record<string, 'claude' | 'codex' | null> = {
    'claude-code': 'claude',
    'claude-code-v2': 'claude',
    'claude-code-worktree': 'claude',
    'codex-agent': 'codex',
    'codex-agent-worktree': 'codex',
    'codex-fugu': 'codex',
  }
  for (const preset of PROVIDER_MANIFEST.presets) {
    assert.equal(sdkRuntimeFamilyOfPreset(preset.id), legacy[preset.id] ?? null, `runtime family of ${preset.id}`)
  }
  assert.equal(sdkRuntimeFamilyOfPreset(undefined), null)
}

function main() {
  testManifestIsValid()
  testValidatorRejectsBrokenManifests()
  testAgentPresetsMatchLegacyList()
  testManifestIsImmutable()
  testLookups()
  testSdkRuntimeFamilyMatchesLegacyMapping()
  console.log('provider-registry tests passed')
}

main()
