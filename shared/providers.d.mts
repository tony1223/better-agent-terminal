// Types for shared/providers.mjs. Provider and preset ids are data (see
// shared/providers.json), so they are plain strings; only the kinds are closed.

export type ProviderId = string
export type PresetId = string
export type AuthKind = 'claude-oauth' | 'codex-oauth' | 'api-key'
export type UsageKind = 'anthropic-oauth' | 'codex-rate-limits' | 'none'
export type PanelKind = 'claude-agent' | 'codex-agent' | 'claude-channel' | 'claude-cli-agent' | 'claude-cli' | 'terminal'
export type SdkRuntimeFamily = 'claude' | 'codex'

export interface ProviderDefinition {
  id: ProviderId
  label: string
  auth: AuthKind
  usage: UsageKind
  defaultEnabled: boolean
  debugOnly?: boolean
}

export interface PresetDefinition {
  id: PresetId
  provider: ProviderId | null
  panel: PanelKind
  hidden?: boolean
  name: string
  icon: string
  color: string
  command?: string
  debug?: boolean
  suggested?: boolean
  backend?: 'sdk' | 'channel' | 'cli' | 'pty'
  needsGitRepo?: boolean
}

export interface ProviderManifest {
  schemaVersion: number
  providers: ProviderDefinition[]
  presets: PresetDefinition[]
}

export const PROVIDER_MANIFEST_SCHEMA_VERSION: number
export const AUTH_KINDS: readonly AuthKind[]
export const USAGE_KINDS: readonly UsageKind[]
export const PANEL_KINDS: readonly PanelKind[]
export const PROVIDER_MANIFEST: ProviderManifest

export function validateProviderManifest(candidate: unknown): string[]
export function listProviders(): ProviderDefinition[]
export function getProvider(id: string | null | undefined): ProviderDefinition | undefined
export function listPresets(): PresetDefinition[]
export function getPreset(id: string | null | undefined): PresetDefinition | undefined
export function providerOfPreset(presetId: string | null | undefined): ProviderId | null | undefined
export function panelOfPreset(presetId: string | null | undefined): PanelKind | undefined
export function presetsOfProvider(providerId: ProviderId): PresetDefinition[]
export function sdkRuntimeFamilyOfPreset(presetId: string | null | undefined): SdkRuntimeFamily | null
