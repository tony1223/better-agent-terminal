import * as assert from 'assert'
import { readFileSync } from 'fs'
import {
  PROVIDER_MANIFEST,
  apiVersionOfPreset,
  apiVersionSwitchOf,
  defaultModelOfPreset,
  defaultPresetForRuntime,
  getDefaultPreset,
  getPreset,
  isPtyPreset,
  isSdkAgentPreset,
  isWorktreePreset,
  presetMenuRank,
  providerAgentName,
  ptyAutoCommand,
  resolvePresetAlias,
  supportsPtyImagePaste,
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
    ['shared usage kind', m => { m.providers[2].usage = 'anthropic-oauth' }, /provider "fugu" reuses usage kind "anthropic-oauth"/],
    ['unknown runtime', m => { m.providers[0].runtime = 'nope' }, /provider "claude".*unknown runtime "nope"/],
    ['api-key provider without a key store', m => { delete m.providers[2].apiKeyStore }, /provider "fugu".*apiKeyStore/],
    ['missing name', m => { delete m.presets[0].name }, /preset "claude-code".*name/],
    ['bad schema version', m => { m.schemaVersion = 99 }, /schemaVersion/],
    ['unknown default preset', m => { m.defaultPreset = 'nope' }, /defaultPreset "nope"/],
    ['runtime default on the wrong runtime', m => { m.runtimeDefaultPresets.codex = 'claude-code' }, /runtimeDefaultPresets\.codex "claude-code"/],
    ['missing runtime default', m => { delete m.runtimeDefaultPresets.codex }, /runtimeDefaultPresets\.codex "undefined"/],
    ['empty bypass command', m => { m.presets[0].ptyCommand = { default: 'x', bypassPermissions: '' } }, /preset "claude-code".*bypassPermissions/],
    ['unknown menu entry', m => { m.menuOrder.push('nope') }, /menuOrder.*"nope"/],
    ['alias shadowing a preset id', m => { m.presets[0].aliases = ['codex-agent'] }, /alias "codex-agent"/],
    ['unknown api version switch', m => { m.presets[0].apiVersionSwitch = 'nope' }, /preset "claude-code".*apiVersionSwitch "nope"/],
    ['pty command without default', m => { m.presets[0].ptyCommand = { bypassPermissions: 'x' } }, /preset "claude-code".*ptyCommand/],
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

function testPresetBehaviourLookups() {
  assert.equal(getDefaultPreset().id, 'claude-code')
  assert.equal(defaultPresetForRuntime('claude'), 'claude-code')
  assert.equal(defaultPresetForRuntime('codex'), 'codex-agent')

  assert.equal(resolvePresetAlias('openai-agent'), 'codex-agent')
  assert.equal(resolvePresetAlias('claude-code'), 'claude-code')
  assert.equal(resolvePresetAlias('nope'), 'nope')

  const worktrees = PROVIDER_MANIFEST.presets.filter(p => isWorktreePreset(p.id)).map(p => p.id)
  assert.deepEqual(worktrees, ['claude-code-worktree', 'claude-cli-worktree', 'codex-agent-worktree'])

  // Sessions owned by an agent SDK runtime (never get a workspace PTY).
  const sdk = PROVIDER_MANIFEST.presets.filter(p => isSdkAgentPreset(p.id)).map(p => p.id)
  assert.deepEqual(sdk, ['claude-code', 'claude-code-v2', 'claude-code-worktree', 'codex-agent', 'codex-agent-worktree', 'codex-fugu'])
  // Sessions whose PTY the workspace starts itself.
  const pty = PROVIDER_MANIFEST.presets.filter(p => isPtyPreset(p.id)).map(p => p.id)
  assert.deepEqual(pty, ['codex-cli', 'none'])
  assert.equal(isPtyPreset(undefined), true)
  assert.equal(isPtyPreset('unknown-preset'), true)

  assert.equal(apiVersionOfPreset('claude-code'), 'v1')
  assert.equal(apiVersionOfPreset('claude-code-v2'), 'v2')
  assert.equal(apiVersionSwitchOf('claude-code'), 'claude-code-v2')
  assert.equal(apiVersionSwitchOf('claude-code-v2'), 'claude-code')
  assert.equal(apiVersionSwitchOf('claude-code-worktree'), undefined)

  assert.equal(ptyAutoCommand('codex-cli', { bypassPermissions: false }), 'codex')
  assert.equal(ptyAutoCommand('codex-cli', { bypassPermissions: true }), 'codex --yolo')
  assert.equal(ptyAutoCommand('claude-code', { bypassPermissions: true }), 'claude --continue')
  assert.equal(ptyAutoCommand('none', { bypassPermissions: false }), null)

  assert.deepEqual(
    PROVIDER_MANIFEST.presets.filter(p => supportsPtyImagePaste(p.id)).map(p => p.id),
    ['claude-cli-agent', 'claude-cli', 'claude-cli-worktree', 'codex-cli'],
  )

  assert.equal(defaultModelOfPreset('codex-fugu'), 'fugu')
  assert.equal(defaultModelOfPreset('codex-agent'), undefined)

  assert.equal(providerAgentName('codex-agent-worktree'), 'Codex Agent')
  assert.equal(providerAgentName('claude-code-v2'), 'Claude Agent')

  // The new-session menu order that agent-preset-menu.ts used to hard-code.
  const legacyMenuOrder = ['claude-code', 'claude-channel', 'codex-agent', 'claude-cli', 'codex-cli', 'claude-code-worktree', 'codex-agent-worktree', 'claude-cli-worktree']
  legacyMenuOrder.forEach((id, index) => assert.equal(presetMenuRank(id), index, `menu rank of ${id}`))
  assert.equal(presetMenuRank('codex-fugu'), legacyMenuOrder.length)
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
  testPresetBehaviourLookups()
  testSdkRuntimeFamilyMatchesLegacyMapping()
  console.log('provider-registry tests passed')
}

main()
