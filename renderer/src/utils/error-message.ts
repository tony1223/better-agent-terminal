const ERROR_MESSAGE_KEYS = ['message', 'error', 'reason'] as const

function extractErrorMessage(value: unknown, depth: number): string | null {
  if (depth > 3 || value == null) return null
  if (value instanceof Error) return value.message.trim() || null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  for (const key of ERROR_MESSAGE_KEYS) {
    const message = extractErrorMessage(record[key], depth + 1)
    if (message) return message
  }
  return null
}

// Tauri command rejections are serialized values (commonly `{ message }`),
// not necessarily real JavaScript Error instances. Keep this deliberately
// selective instead of JSON-stringifying arbitrary objects, which could leak
// credentials or other structured request data into the UI/logs.
export function formatErrorMessage(error: unknown, fallback: string): string {
  return extractErrorMessage(error, 0) || fallback
}

export function formatAuthErrorMessage(error: unknown, fallback: string): string {
  return formatErrorMessage(error, fallback)
    .replace(/https?:\/\/\S+/gi, '<redacted-url>')
    .replace(/\b[A-Z0-9]{3,8}-[A-Z0-9]{3,8}\b/g, '<redacted-code>')
}
