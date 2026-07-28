// Permission modes and the rules for restoring one from disk.
//
// Extracted from ClaudeAgentPanel so the restore rule is testable without
// mounting the panel. The panel keeps the store lookup; everything decided
// purely from a stored value lives here.

export const PERMISSION_MODES = [
  'default',
  'auto',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
  'bypassPlan',
  'plan',
] as const

export type PermissionMode = typeof PERMISSION_MODES[number]

// What a session falls back to when nothing was remembered. Kept as
// bypassPermissions to match the behaviour every existing session already has —
// persistence should restore what users chose, not quietly re-default them.
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions'

export const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: '✏ Ask before edits',
  auto: '🤖 Auto (AI-reviewed)',
  acceptEdits: '✏ Auto-accept edits',
  dontAsk: '🚫 Never ask (deny)',
  bypassPermissions: '⚠ Bypass permissions',
  bypassPlan: '📋 Plan (auto-approve)',
  plan: '📋 Plan mode',
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

// Validate rather than trust. A mode retired in a later version would otherwise
// resurrect itself from a workspace file written by an older build and sit there
// matching no branch in the sidecar — every tool call would fall through to the
// prompt path with a label nothing renders.
export function normalizePermissionMode(stored: unknown): PermissionMode {
  return isPermissionMode(stored) ? stored : DEFAULT_PERMISSION_MODE
}
