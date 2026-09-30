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
    if (!AUTH_KINDS.includes(provider.auth)) errors.push(`provider "${id}" has unknown auth kind "${provider.auth}"`)
    if (!USAGE_KINDS.includes(provider.usage)) errors.push(`provider "${id}" has unknown usage kind "${provider.usage}"`)
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

/** Returns a list of human-readable problems; empty when the manifest is valid. */
export function validateProviderManifest(candidate) {
  const errors = []
  if (candidate?.schemaVersion !== PROVIDER_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PROVIDER_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(candidate?.schemaVersion)}`)
  }
  const providerIds = validateProviders(candidate?.providers, errors)
  validatePresets(candidate?.presets, providerIds, errors)
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
