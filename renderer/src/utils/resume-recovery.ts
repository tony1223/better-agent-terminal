let remoteHost: string | undefined
export function setRemoteErrorHost(host: string) { remoteHost = host }

// Only selected fields cross the log boundary; never serialize request options.
export function formatError(error: unknown, ctx: { host?: string; sessionId?: string } = {}): string {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const redact = (text: string) => text
    .replace(/((?:Bearer|Basic)\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:token|password|secret|credential|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[redacted]')
    .replace(/\/\/[^/@\s]+@/g, '//[redacted]@')
  return JSON.stringify({
    message: redact(typeof error === 'string' ? error : typeof value.message === 'string' ? value.message : 'Unknown error'),
    code: typeof value.code === 'string' || typeof value.code === 'number' ? redact(String(value.code)) : null,
    stack: typeof value.stack === 'string' ? redact(value.stack) : null,
    host: (ctx.host ?? remoteHost) ? redact((ctx.host ?? remoteHost)!) : null,
    sessionId: ctx.sessionId ?? null,
  })
}

export function createBackoff(random = Math.random, now = Date.now) {
  let attempt = 0
  let connectedAt: number | null = null
  return {
    next() {
      if (connectedAt !== null && now() - connectedAt >= 30_000) attempt = 0
      connectedAt = null
      return Math.floor(random() * Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 16)))
    },
    connected() { connectedAt ??= now() },
    reset() { attempt = 0; connectedAt = null },
  }
}
