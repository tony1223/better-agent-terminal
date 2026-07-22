export function agentSendResultError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const response = result as { ok?: unknown; error?: unknown }
  if (response.ok !== false || typeof response.error !== 'string') return null
  const message = response.error.trim()
  return message || null
}

export function isMissingSessionCwdError(message: string): boolean {
  return /session has no cwd/i.test(message)
}
