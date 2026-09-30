// Types for shared/providers.mjs. Provider and preset ids are data (see
// shared/providers.json), so they are plain strings; only the kinds are closed.

export type ProviderId = string
export type PresetId = string
export type AuthKind = 'claude-oauth' | 'codex-oauth' | 'api-key'
export type UsageKind = 'anthropic-oauth' | 'codex-rate-limits' | 'none'
export type ApiKeyStore = 'codex-env'
export type PanelKind = 'claude-agent' | 'codex-agent' | 'claude-channel' | 'claude-cli-agent' | 'claude-cli' | 'terminal'
export type SdkRuntimeFamily = 'claude' | 'codex'

export interface ProviderDefinition {
  id: ProviderId
  label: string
  runtime: SdkRuntimeFamily
  auth: AuthKind
  apiKeyStore?: ApiKeyStore
  usage: UsageKind
  defaultEnabled: boolean
  debugOnly?: boolean
  defaultModel?: string
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
  aliases?: string[]
  apiVersion?: 'v1' | 'v2'
  apiVersionSwitch?: PresetId
  ptyCommand?: { default: string; bypassPermissions?: string }
  ptyImagePaste?: boolean
}

export interface ProviderManifest {
  schemaVersion: number
  defaultPreset: PresetId
  runtimeDefaultPresets: Record<SdkRuntimeFamily, PresetId>
  menuOrder: PresetId[]
  providers: ProviderDefinition[]
  presets: PresetDefinition[]
}

export const PROVIDER_MANIFEST_SCHEMA_VERSION: number
export const AUTH_KINDS: readonly AuthKind[]
export const USAGE_KINDS: readonly UsageKind[]
export const API_KEY_STORES: readonly ApiKeyStore[]
export const RUNTIME_KINDS: readonly SdkRuntimeFamily[]
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
export function isSdkAgentPreset(presetId: string | null | undefined): boolean
export function isPtyPreset(presetId: string | null | undefined): boolean
export function isWorktreePreset(presetId: string | null | undefined): boolean
export function getDefaultPreset(): PresetDefinition
export function defaultPresetForRuntime(family: SdkRuntimeFamily): PresetId
export function resolvePresetAlias(presetId: string): PresetId
export function apiVersionOfPreset(presetId: string | null | undefined): 'v1' | 'v2'
export function apiVersionSwitchOf(presetId: string | null | undefined): PresetId | undefined
export function ptyAutoCommand(presetId: string | null | undefined, options?: { bypassPermissions?: boolean }): string | null
export function supportsPtyImagePaste(presetId: string | null | undefined): boolean
export function defaultModelOfPreset(presetId: string | null | undefined): string | undefined
export function providerAgentName(presetId: string | null | undefined): string | undefined
export function presetMenuRank(presetId: string): number

/** The `providers` setting: per-provider enable toggles. */
export type ProviderToggles = Record<ProviderId, { enabled?: boolean } | undefined>
export interface ProviderToggleOptions { debug?: boolean }
export function enabledProviderIds(toggles: ProviderToggles | null | undefined, options?: ProviderToggleOptions): ProviderId[]
export function isProviderEnabled(providerId: ProviderId, toggles: ProviderToggles | null | undefined, options?: ProviderToggleOptions): boolean
export function isPresetEnabled(presetId: string | null | undefined, toggles: ProviderToggles | null | undefined, options?: ProviderToggleOptions): boolean
export function requiredRuntimes(toggles: ProviderToggles | null | undefined, options?: ProviderToggleOptions): Set<SdkRuntimeFamily>
export function canDisableProvider(providerId: ProviderId, toggles: ProviderToggles | null | undefined, options?: ProviderToggleOptions): boolean
export function resolveDefaultAgentPreset(preferred: string | null | undefined, toggles: ProviderToggles | null | undefined, options?: ProviderToggleOptions): PresetId
