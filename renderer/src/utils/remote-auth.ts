export type RemoteLoginKind = 'claude' | 'codex'

export type RemoteAuthCapabilities = {
  claude?: string
  codex?: string
}

export function normalizeRemoteAuthCapabilities(status: unknown): RemoteAuthCapabilities | null {
  if (!status || typeof status !== 'object') return null
  const capabilities = (status as Record<string, unknown>).capabilities
  if (!capabilities || typeof capabilities !== 'object') return null
  const remoteAuth = (capabilities as Record<string, unknown>).remoteAuth
  if (!remoteAuth || typeof remoteAuth !== 'object') return null
  const record = remoteAuth as Record<string, unknown>
  const claude = typeof record.claude === 'string' && record.claude.trim()
    ? record.claude
    : undefined
  const codex = typeof record.codex === 'string' && record.codex.trim()
    ? record.codex
    : undefined
  return claude || codex ? { claude, codex } : null
}

export function supportsRemoteLogin(
  capabilities: RemoteAuthCapabilities | null | undefined,
  kind: RemoteLoginKind,
): boolean {
  const expected = kind === 'codex' ? 'device-code-v1' : 'paste-code-v1'
  return capabilities?.[kind] === expected
}
