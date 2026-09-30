// Provider registry shared by the renderer and the node sidecar.
//
// shared/providers.json is the single source of truth for which providers and
// agent presets exist; the Rust host embeds the same file (src-tauri/src/providers.rs).
// Callers look providers and presets up here instead of comparing id literals.
// Kinds (auth / usage / panel) are code: a provider that reuses existing kinds
// is added by editing the JSON alone. See docs/providers.md.

import manifest from './providers.json' with { type: 'json' }

export const PROVIDER_MANIFEST_SCHEMA_VERSION = 1
export const AUTH_KINDS = Object.freeze(['claude-oauth', 'codex-oauth', 'api-key'])
export const USAGE_KINDS = Object.freeze(['anthropic-oauth', 'codex-rate-limits', 'none'])
// Where an `api-key` provider's key lives. codex-env = $CODEX_HOME/.env (Fugu).
export const API_KEY_STORES = Object.freeze(['codex-env'])
// The agent CLI runtime a provider's sessions run on (and whose version its account chip shows).
export const RUNTIME_KINDS = Object.freeze(['claude', 'codex'])
export const PANEL_KINDS = Object.freeze([
  'claude-agent',
  'codex-agent',
  'claude-channel',
  'claude-cli-agent',
  'claude-cli',
  'terminal',
])

const SDK_RUNTIME_FAMILY_BY_PANEL = Object.freeze({
  'claude-agent': 'claude',
  'codex-agent': 'codex',
})

const isNonEmptyString = value => typeof value === 'string' && value.trim() !== ''

function validateProviders(providers, errors) {
  const ids = new Set()
  const usageOwners = new Map()
  if (!Array.isArray(providers)) {
    errors.push('providers must be an array')
    return ids
  }
  for (const provider of providers) {
    const id = provider?.id
    if (!isNonEmptyString(id)) {
      errors.push(`provider ${JSON.stringify(provider)} is missing an id`)
      continue
    }
    if (ids.has(id)) errors.push(`duplicate provider id "${id}"`)
    ids.add(id)
    if (!isNonEmptyString(provider.label)) errors.push(`provider "${id}" is missing a label`)
    if (!RUNTIME_KINDS.includes(provider.runtime)) errors.push(`provider "${id}" has unknown runtime "${provider.runtime}"`)
    if (!AUTH_KINDS.includes(provider.auth)) errors.push(`provider "${id}" has unknown auth kind "${provider.auth}"`)
    if (provider.auth === 'api-key' && !API_KEY_STORES.includes(provider.apiKeyStore)) {
      errors.push(`provider "${id}" has unknown apiKeyStore "${provider.apiKeyStore}"`)
    }
    if (!USAGE_KINDS.includes(provider.usage)) errors.push(`provider "${id}" has unknown usage kind "${provider.usage}"`)
    // Each usage kind reads one host-wide credential, and its snapshots are keyed
    // by the provider that owns it, so two providers cannot share one.
    if (provider.usage !== 'none' && usageOwners.has(provider.usage)) {
      errors.push(`provider "${id}" reuses usage kind "${provider.usage}" already owned by "${usageOwners.get(provider.usage)}"`)
    }
    usageOwners.set(provider.usage, id)
    if (typeof provider.defaultEnabled !== 'boolean') errors.push(`provider "${id}" needs a boolean defaultEnabled`)
  }
  return ids
}

function validatePresets(presets, providerIds, errors) {
  if (!Array.isArray(presets)) {
    errors.push('presets must be an array')
    return
  }
  const ids = new Set()
  for (const preset of presets) {
    const id = preset?.id
    if (!isNonEmptyString(id)) {
      errors.push(`preset ${JSON.stringify(preset)} is missing an id`)
      continue
    }
    if (ids.has(id)) errors.push(`duplicate preset id "${id}"`)
    ids.add(id)
    if (preset.provider !== null && !providerIds.has(preset.provider)) {
      errors.push(`preset "${id}" references unknown provider "${preset.provider}"`)
    }
    if (!PANEL_KINDS.includes(preset.panel)) errors.push(`preset "${id}" has unknown panel "${preset.panel}"`)
    for (const field of ['name', 'icon', 'color']) {
      if (!isNonEmptyString(preset[field])) errors.push(`preset "${id}" is missing ${field}`)
    }
  }
}

function validatePresetLinks(presets, errors) {
  if (!Array.isArray(presets)) return
  const ids = new Set(presets.map(preset => preset?.id))
  const aliases = new Set()
  for (const preset of presets) {
    for (const alias of preset?.aliases ?? []) {
      if (ids.has(alias) || aliases.has(alias)) errors.push(`preset "${preset.id}" alias "${alias}" collides with another id or alias`)
      aliases.add(alias)
    }
    if (preset?.apiVersionSwitch !== undefined && !ids.has(preset.apiVersionSwitch)) {
      errors.push(`preset "${preset.id}" has unknown apiVersionSwitch "${preset.apiVersionSwitch}"`)
    }
    if (preset?.ptyCommand !== undefined) {
      if (!isNonEmptyString(preset.ptyCommand?.default)) errors.push(`preset "${preset.id}" ptyCommand needs a default command`)
      if (preset.ptyCommand?.bypassPermissions !== undefined && !isNonEmptyString(preset.ptyCommand.bypassPermissions)) {
        errors.push(`preset "${preset.id}" ptyCommand.bypassPermissions must be a non-empty command`)
      }
    }
  }
}

function validateTopLevelRefs(candidate, errors) {
  const presets = Array.isArray(candidate?.presets) ? candidate.presets : []
  const byId = new Map(presets.map(preset => [preset?.id, preset]))
  if (!byId.has(candidate?.defaultPreset)) errors.push(`defaultPreset "${candidate?.defaultPreset}" is not a declared preset`)
  // Every runtime needs a default preset: handoffs open sessions by runtime.
  for (const family of RUNTIME_KINDS) {
    const presetId = candidate?.runtimeDefaultPresets?.[family]
    if (SDK_RUNTIME_FAMILY_BY_PANEL[byId.get(presetId)?.panel] !== family) {
      errors.push(`runtimeDefaultPresets.${family} "${presetId}" is not a ${family} agent preset`)
    }
  }
  for (const presetId of candidate?.menuOrder ?? []) {
    if (!byId.has(presetId)) errors.push(`menuOrder lists unknown preset "${presetId}"`)
  }
}

/** Returns a list of human-readable problems; empty when the manifest is valid. */
export function validateProviderManifest(candidate) {
  const errors = []
  if (candidate?.schemaVersion !== PROVIDER_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PROVIDER_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(candidate?.schemaVersion)}`)
  }
  const providerIds = validateProviders(candidate?.providers, errors)
  validatePresets(candidate?.presets, providerIds, errors)
  validatePresetLinks(candidate?.presets, errors)
  validateTopLevelRefs(candidate, errors)
  return errors
}

const manifestErrors = validateProviderManifest(manifest)
if (manifestErrors.length > 0) {
  throw new Error(`shared/providers.json is invalid:\n- ${manifestErrors.join('\n- ')}`)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

// Every lookup hands out these objects by reference, so a stray mutation
// (e.g. sorting the preset list for display) would corrupt the registry for the
// whole process. Freezing turns that into an immediate TypeError instead.
export const PROVIDER_MANIFEST = deepFreeze(manifest)

const providersById = new Map(manifest.providers.map(provider => [provider.id, provider]))
const presetsById = new Map(manifest.presets.map(preset => [preset.id, preset]))
const presetIdByAlias = new Map(manifest.presets.flatMap(preset => (preset.aliases ?? []).map(alias => [alias, preset.id])))

export function listProviders() {
  return manifest.providers
}

export function getProvider(id) {
  return providersById.get(id)
}

export function listPresets() {
  return manifest.presets
}

export function getPreset(id) {
  return presetsById.get(id)
}

/** Provider id of a preset; null for provider-less presets (plain terminal), undefined when unknown. */
export function providerOfPreset(presetId) {
  const preset = presetsById.get(presetId)
  return preset ? preset.provider : undefined
}

export function panelOfPreset(presetId) {
  return presetsById.get(presetId)?.panel
}

export function presetsOfProvider(providerId) {
  return manifest.presets.filter(preset => preset.provider === providerId)
}

/** Which SDK runtime owns a preset's session: 'claude' (node sidecar), 'codex' (Rust app-server), or null. */
export function sdkRuntimeFamilyOfPreset(presetId) {
  return SDK_RUNTIME_FAMILY_BY_PANEL[panelOfPreset(presetId)] ?? null
}

/** SDK agent sessions (Claude or Codex runtime); they never get a workspace-owned PTY. */
export function isSdkAgentPreset(presetId) {
  return sdkRuntimeFamilyOfPreset(presetId) !== null
}

/**
 * Sessions whose PTY the workspace starts itself: plain terminals and PTY CLIs.
 * Unknown or missing presets are treated as plain terminals.
 */
export function isPtyPreset(presetId) {
  return (panelOfPreset(presetId) ?? 'terminal') === 'terminal'
}

export function isWorktreePreset(presetId) {
  return presetsById.get(presetId)?.needsGitRepo === true
}

export function getDefaultPreset() {
  return presetsById.get(manifest.defaultPreset)
}

/** The preset used when a session is opened on a runtime without a more specific choice (e.g. a handoff). */
export function defaultPresetForRuntime(family) {
  return manifest.runtimeDefaultPresets[family]
}

/** Maps a retired preset id to its current one; other ids are returned unchanged. */
export function resolvePresetAlias(presetId) {
  return presetIdByAlias.get(presetId) ?? presetId
}

export function apiVersionOfPreset(presetId) {
  return presetsById.get(presetId)?.apiVersion ?? 'v1'
}

/** The preset that runs the same agent on the other SDK API version, if any. */
export function apiVersionSwitchOf(presetId) {
  return presetsById.get(presetId)?.apiVersionSwitch
}

/** Command typed into a preset's PTY when agent auto-commands are enabled; null when it has none. */
export function ptyAutoCommand(presetId, { bypassPermissions = false } = {}) {
  const preset = presetsById.get(presetId)
  if (preset?.ptyCommand) {
    return (bypassPermissions && preset.ptyCommand.bypassPermissions) || preset.ptyCommand.default
  }
  return preset?.command || null
}

export function supportsPtyImagePaste(presetId) {
  return presetsById.get(presetId)?.ptyImagePaste === true
}

/** The provider's default model for new sessions of this preset, when it has one. */
export function defaultModelOfPreset(presetId) {
  return providersById.get(providerOfPreset(presetId))?.defaultModel
}

/** "<Provider> Agent", used for generated session titles. */
export function providerAgentName(presetId) {
  const label = providersById.get(providerOfPreset(presetId))?.label
  return label ? `${label} Agent` : presetsById.get(presetId)?.name
}

/** Position of a preset in the new-session menu; unlisted presets sort after listed ones. */
export function presetMenuRank(presetId) {
  const index = manifest.menuOrder.indexOf(presetId)
  return index === -1 ? manifest.menuOrder.length : index
}
