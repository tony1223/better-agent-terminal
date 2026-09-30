// Pure provider routing for the workspace account chip and account events.
// Host calls live in ./accounts.ts; this file stays import-free of the host so
// it can be unit-tested (tests/provider-accounts.test.ts).

import {
  defaultPresetForRuntime,
  getProvider,
  panelOfPreset,
  providerOfPreset,
  type ProviderId,
  type SdkRuntimeFamily,
} from '../../../shared/providers.mjs'

/**
 * Provider whose account chip a session shows. App-managed agent sessions
 * have one; raw CLIs in a PTY (Claude CLI, Codex CLI) and plain terminals don't.
 */
export function accountChipProviderOf(presetId: string | null | undefined): ProviderId | null {
  const panel = panelOfPreset(presetId)
  if (!panel || panel === 'terminal' || panel === 'claude-cli') return null
  return providerOfPreset(presetId) ?? null
}

/** Window event fired after a provider's active account changes. */
export function accountSwitchedEvent(providerId: ProviderId): string {
  return `${providerId}-account-switched`
}

/**
 * Provider named by a host payload (`claude:account-changed` `agent`,
 * `agent:usage` `provider`). Hosts only ever sent claude/codex, and anything
 * unrecognised has always meant claude.
 */
export function hostProviderOf(value: unknown): ProviderId {
  return typeof value === 'string' && getProvider(value) ? value : 'claude'
}

/** Provider whose host usage snapshot to show, or null when it reports no usage. */
export function usageProviderOf(providerId: ProviderId | null | undefined): ProviderId | null {
  const provider = getProvider(providerId)
  return provider && provider.usage !== 'none' ? provider.id : null
}

/**
 * Provider whose usage a session's statusline shows: the session's own
 * provider, or the runtime's default provider before the preset is known.
 */
export function sessionUsageProvider(presetId: string | null | undefined, runtime: SdkRuntimeFamily): ProviderId | null {
  return usageProviderOf(providerOfPreset(presetId) ?? providerOfPreset(defaultPresetForRuntime(runtime)))
}

/** The agent CLI runtime a provider's sessions run on. */
export function cliRuntimeOf(providerId: ProviderId | null | undefined): SdkRuntimeFamily | undefined {
  return getProvider(providerId)?.runtime
}
