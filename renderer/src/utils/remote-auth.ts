import { getProvider, listProviders, type AuthKind, type ProviderId } from '../../../shared/providers.mjs'

export type RemoteLoginKind = ProviderId

/** Remote sign-in ceremony per provider id, as advertised by the host. */
export type RemoteAuthCapabilities = Record<ProviderId, string | undefined>

// The ceremony a host must advertise for a provider's remote sign-in, by the
// provider's auth kind. API-key providers have no remote sign-in.
const REMOTE_LOGIN_CEREMONY: Partial<Record<AuthKind, string>> = {
  'claude-oauth': 'paste-code-v1',
  'codex-oauth': 'device-code-v1',
}

function remoteCeremonyOf(providerId: ProviderId): string | undefined {
  const auth = getProvider(providerId)?.auth
  return auth ? REMOTE_LOGIN_CEREMONY[auth] : undefined
}

export function normalizeRemoteAuthCapabilities(status: unknown): RemoteAuthCapabilities | null {
  if (!status || typeof status !== 'object') return null
  const capabilities = (status as Record<string, unknown>).capabilities
  if (!capabilities || typeof capabilities !== 'object') return null
  const remoteAuth = (capabilities as Record<string, unknown>).remoteAuth
  if (!remoteAuth || typeof remoteAuth !== 'object') return null
  const record = remoteAuth as Record<string, unknown>
  const normalized: RemoteAuthCapabilities = {}
  for (const provider of listProviders()) {
    const value = record[provider.id]
    if (remoteCeremonyOf(provider.id) && typeof value === 'string' && value.trim()) normalized[provider.id] = value
  }
  return Object.keys(normalized).length > 0 ? normalized : null
}

export function supportsRemoteLogin(
  capabilities: RemoteAuthCapabilities | null | undefined,
  kind: RemoteLoginKind,
): boolean {
  const expected = remoteCeremonyOf(kind)
  return expected !== undefined && capabilities?.[kind] === expected
}
