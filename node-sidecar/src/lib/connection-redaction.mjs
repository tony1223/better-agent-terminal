// Diagnostic output only. Authentication payloads and saved profiles retain
// their original credentials.
export function redactConnectionCredentials(message) {
  return message
    .replace(/("(?:remote)?token"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/(token=)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^&#\s"'<>},]*)/gi, '$1[REDACTED]')
}
