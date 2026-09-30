// Account chip adapters, keyed by a provider's auth kind (shared/providers.json).
// WorkspaceView asks the adapter of the focused session's provider for the chip
// contents and delegates switching / login to it, instead of branching on
// provider ids. Routing helpers without host calls live in ./account-routing.ts.

import { host } from '../host-api'
import { getProvider, type ApiKeyStore, type AuthKind, type ProviderDefinition, type ProviderId } from '../../../shared/providers.mjs'

export type AccountMenuEntry = {
  id: string          // selector passed to the switch command
  label: string       // primary line (email)
  sublabel?: string   // secondary line (subscription tier / CODEX_HOME path)
  active?: boolean
  needsLogin?: boolean
  lastAuthError?: string
}

export type AccountChip = {
  kind: ProviderId
  label: string
  title: string
  plan?: string       // active account's subscription tier (Claude only)
  accounts?: AccountMenuEntry[]
  loggedIn?: boolean
  unified?: boolean
  hint?: string       // i18n key shown in the menu instead of a login action
}

type CodexAccountEntry = {
  id: string
  label?: string
  email?: string
  codexHome: string
  authenticated?: boolean
  active?: boolean
  unified?: boolean
  accountId?: string
  needsLogin?: boolean
  lastAuthError?: string
}

type ClaudeAccountEntry = {
  id: string
  email?: string
  subscriptionType?: string
  isDefault?: boolean
}

/**
 * How a local sign-in starts:
 * - `dialog`: the LoginDialog drives it (Claude's paste-back code flow).
 * - `inline`: the chip menu awaits `login()` with a pending state (Codex browser OAuth).
 * - `none`: no sign-in from the chip (API-key providers are configured in Settings).
 */
export type LocalLoginFlow = 'dialog' | 'inline' | 'none'

export interface AccountAdapter {
  /** Chip contents for the provider; `terminalId` is the session the chip follows. */
  load(provider: ProviderDefinition, terminalId: string): Promise<AccountChip>
  /** Chip shown when `load` fails. */
  fallback(provider: ProviderDefinition): AccountChip
  /** Switch the active account; resolves false when the host refused. */
  switchAccount(accountId: string): Promise<boolean>
  localLogin: LocalLoginFlow
  login?(): Promise<void>
  cancelLogin?(): Promise<void>
  /** Whether usage of non-active accounts can be peeked from the menu. */
  peeksInactiveUsage: boolean
}

const claudeOAuthAdapter: AccountAdapter = {
  async load(provider, terminalId) {
    const [info, list] = await Promise.all([
      (host.claude.getAccountInfo(terminalId) as Promise<{ email?: string; organization?: string; subscriptionType?: string } | null>).catch(() => null),
      (host.claude.accountList() as Promise<{ accounts?: ClaudeAccountEntry[]; activeAccountId?: string } | null>).catch(() => null),
    ])
    const accounts = list?.accounts || []
    const activeId = list?.activeAccountId
    const entries: AccountMenuEntry[] = accounts.map(account => ({
      id: account.id,
      label: account.email || account.id,
      sublabel: account.subscriptionType || undefined,
      active: account.id === activeId,
    }))
    const activeAccount = accounts.find(account => account.id === activeId)
    const activeEmail = activeAccount?.email
    return {
      kind: provider.id,
      label: info?.email || activeEmail || info?.organization || provider.label,
      title: info?.email ? `${info.email} (${info.subscriptionType || 'unknown'})` : `${provider.label} account`,
      plan: info?.subscriptionType || activeAccount?.subscriptionType || undefined,
      accounts: entries,
      loggedIn: Boolean(info?.email || activeEmail || entries.length > 0),
    }
  },
  fallback: provider => ({ kind: provider.id, label: provider.label, title: `${provider.label} account` }),
  async switchAccount(accountId) {
    const ok = await host.claude.accountSwitch(accountId) as boolean
    return ok !== false
  },
  localLogin: 'dialog',
  peeksInactiveUsage: true,
}

const codexOAuthAdapter: AccountAdapter = {
  async load(provider) {
    const result = await host.codex.accountList() as { accounts?: CodexAccountEntry[]; activeCodexHome?: string }
    // Only real, signed-in accounts count: drop entries with no resolvable
    // email (e.g. an empty ~/.codex home that would otherwise show as ".codex").
    const raw = (result.accounts || []).filter(account => Boolean(account.email && account.email.trim()))
    // In unified mode every account shares one runtime CODEX_HOME, so a
    // `codexHome === activeCodexHome` check would mark EVERY entry active and
    // make clicking a no-op (handleAccountSwitch early-returns on active rows).
    // Trust the backend per-account `active` flag; only use the codexHome
    // fallback for the legacy (non-unified) model where homes are distinct.
    const active = raw.find(account => account.active)
      || raw.find(account => !account.unified && account.codexHome === result.activeCodexHome)
    const entries: AccountMenuEntry[] = raw.map(account => ({
      id: account.id,
      label: account.email || account.label || account.codexHome,
      sublabel: account.needsLogin
        ? 'Needs login'
        : account.unified ? undefined : account.codexHome,
      active: Boolean(account.active) || (!account.unified && account.codexHome === result.activeCodexHome),
      needsLogin: Boolean(account.needsLogin),
      lastAuthError: account.lastAuthError,
    }))
    return {
      kind: provider.id,
      label: active?.email || active?.label || provider.label,
      title: active?.unified
        ? `${provider.label} account`
        : active?.codexHome ? `CODEX_HOME: ${active.codexHome}` : `${provider.label} account`,
      accounts: entries,
      loggedIn: Boolean(active?.authenticated ?? entries.length > 0),
      unified: Boolean(active?.unified || raw.some(a => a.unified)),
    }
  },
  fallback: provider => ({ kind: provider.id, label: provider.label, title: `${provider.label} account` }),
  async switchAccount(accountId) {
    const result = await host.codex.accountSwitch(accountId) as { success?: boolean }
    return result?.success !== false
  },
  localLogin: 'inline',
  async login() {
    // Real Codex login (ChatGPT browser OAuth); registers + activates it.
    await host.codex.accountLogin()
  },
  async cancelLogin() {
    // Kills the pending `codex login` child, which rejects the awaited login().
    await host.codex.accountLoginCancel()
  },
  peeksInactiveUsage: false,
}

// Whether an API key is configured, per key store (provider `apiKeyStore`).
const API_KEY_CONFIGURED: Record<ApiKeyStore, () => Promise<boolean>> = {
  'codex-env': async () => Boolean((await host.codex.fuguStatus())?.keyConfigured),
}

// API-key providers have no account list: the chip reports whether a key is
// configured and points to Settings.
const apiKeyAdapter: AccountAdapter = {
  async load(provider) {
    const keyConfigured = provider.apiKeyStore ? await API_KEY_CONFIGURED[provider.apiKeyStore]() : false
    return {
      kind: provider.id,
      label: provider.label,
      title: `${provider.label} API key`,
      accounts: [],
      loggedIn: keyConfigured,
      hint: 'workspace.accountApiKeyHint',
    }
  },
  fallback: provider => ({
    kind: provider.id,
    label: provider.label,
    title: `${provider.label} API key`,
    hint: 'workspace.accountApiKeyHint',
  }),
  async switchAccount() {
    return false
  },
  localLogin: 'none',
  peeksInactiveUsage: false,
}

const ADAPTERS: Record<AuthKind, AccountAdapter> = {
  'claude-oauth': claudeOAuthAdapter,
  'codex-oauth': codexOAuthAdapter,
  'api-key': apiKeyAdapter,
}

export function accountAdapterFor(providerId: ProviderId | null | undefined): AccountAdapter | undefined {
  const provider = getProvider(providerId)
  return provider ? ADAPTERS[provider.auth] : undefined
}
