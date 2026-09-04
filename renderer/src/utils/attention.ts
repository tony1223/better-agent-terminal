// "Needs me" helpers shared by the sidebar activity dot and the notification
// bell. Pure functions so they can be unit-tested without React.

export interface AttentionNotification {
  read: boolean
  workspaceId?: string
  kind?: string
}

export interface AttentionCounts {
  pending: number
  unread: number
  running: number
}

export type BellBadgeTone = 'red' | 'green' | 'gray'

export interface BellBadge {
  count: number
  tone: BellBadgeTone
}

const SUMMARY_MAX = 40

// Collapse a markdown-ish assistant reply into one short line. Strips the
// most common decoration (headings, emphasis, code fences, list bullets) so
// the summary reads like prose instead of a lump of symbols.
export function summarizeResult(text: string | undefined | null, max = SUMMARY_MAX): string {
  if (!text) return ''
  const line = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (line.length <= max) return line
  return `${Array.from(line).slice(0, max).join('').trimEnd()}…`
}

export interface PendingPermissionLike {
  toolName: string
  input: Record<string, unknown>
}

export interface PendingQuestionLike {
  questions: Array<{ header?: string; question?: string }>
}

// One-line label for what the agent is waiting on. Prefers the field a
// human would recognise: the shell command for Bash, the file for edits,
// the question header for AskUserQuestion.
export function describePendingAction(
  permission: PendingPermissionLike | null | undefined,
  question: PendingQuestionLike | null | undefined,
): string | null {
  if (permission) {
    const input = permission.input ?? {}
    const detail = firstString(input, ['command', 'file_path', 'path', 'notebook_path', 'url', 'pattern', 'description'])
    const summary = detail ? summarizeResult(detail, SUMMARY_MAX) : ''
    return summary ? `${permission.toolName}: ${summary}` : permission.toolName
  }
  if (question) {
    const first = question.questions?.[0]
    const label = first?.header || first?.question
    return label ? summarizeResult(label, SUMMARY_MAX) : 'Question'
  }
  return null
}

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

export function workspaceHasUnreadCompletion(
  entries: readonly AttentionNotification[],
  workspaceId: string,
): boolean {
  return entries.some(e => !e.read && e.kind !== 'remote-client' && e.workspaceId === workspaceId)
}

export function unreadCompletionIds<T extends AttentionNotification & { id: string }>(
  entries: readonly T[],
  workspaceId: string,
): string[] {
  return entries
    .filter(e => !e.read && e.kind !== 'remote-client' && e.workspaceId === workspaceId)
    .map(e => e.id)
}

// Badge on the sidebar bell. Red wins (something is blocked on the user),
// then green (finished work nobody has looked at), then a quiet gray count
// of agents still running. Nothing at all when there is nothing to say.
export function computeBellBadge(counts: AttentionCounts): BellBadge | null {
  const attention = counts.pending + counts.unread
  if (counts.pending > 0) return { count: attention, tone: 'red' }
  if (counts.unread > 0) return { count: attention, tone: 'green' }
  if (counts.running > 0) return { count: counts.running, tone: 'gray' }
  return null
}

export function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}
