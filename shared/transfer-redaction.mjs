// Shared by the renderer handoff preview and the host transcript exporter.
export function redactTransferSecrets(value) {
  let text = value
  let count = 0
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      count += 1
      return typeof replacement === 'string' ? replacement : replacement(...args)
    })
  }
  replace(
    /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
    '[REDACTED PRIVATE KEY]',
  )
  replace(/\b(?:sk-ant-|sk-|github_pat_|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]')
  replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, (_match, prefix) => `${prefix}[REDACTED]`)
  replace(
    /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;]+)/gi,
    (_match, prefix) => `${prefix}[REDACTED]`,
  )
  return { text, count }
}
