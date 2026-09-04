import i18next from 'i18next'
import type { TFunction } from 'i18next'
import type { MessageItem } from './CodexAgentPanel.types'
import { summarizeAskUserInput } from './AskUserQuestion.helpers'

// ToolSearch returns a JSON array of { tool_name, type } references. Render a
// readable one-line summary instead of dumping the raw JSON; return null (fall
// back to raw output) when the result is not in the expected shape.
export function summarizeToolSearchResult(rawOutText: string, t: TFunction): string | null {
  const trimmed = rawOutText.trim()
  if (!trimmed.startsWith('[')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const names = parsed
    .map(entry =>
      entry && typeof entry === 'object' && typeof (entry as { tool_name?: unknown }).tool_name === 'string'
        ? (entry as { tool_name: string }).tool_name
        : null,
    )
    .filter((name): name is string => Boolean(name))
  if (names.length === 0) return null
  return t('claude.toolSearchSummary', { count: names.length, names: names.join(', ') })
}

export type AutoContinueTurnEndPayload = {
  reason?: string
  error?: string
  result?: unknown
  turnId?: string
  turn_id?: string
  sdkSessionId?: string
}

export type AutoContinueTrigger = 'always' | 'cybersecurity-flag'

export function shouldAutoContinueAfterTurnEnd(payload: AutoContinueTurnEndPayload | null | undefined): boolean {
  if (!payload) return false
  if (payload.reason === 'completed') return true
  if (payload.reason !== 'error') return false
  const error = payload.error || ''
  return /codex:\s*no response from model after \d+s\.\s*please try again\./i.test(error)
}

export function isCybersecurityFlagTurnEnd(payload: AutoContinueTurnEndPayload | null | undefined): boolean {
  if (!payload) return false
  const result = typeof payload.result === 'string' ? payload.result : ''
  const error = typeof payload.error === 'string' ? payload.error : ''
  const text = `${error}\n${result}`.trimStart()
  return /^(?:(?:error|codex error):\s*)*this content was flagged for possible cybersecurity risk(?:\.|\b)/i.test(text)
}

export function shouldAutoContinueForTrigger(
  trigger: AutoContinueTrigger,
  payload: AutoContinueTurnEndPayload | null | undefined,
): boolean {
  return trigger === 'cybersecurity-flag'
    ? isCybersecurityFlagTurnEnd(payload)
    : shouldAutoContinueAfterTurnEnd(payload)
}

export function autoContinueTurnEndKey(
  payload: AutoContinueTurnEndPayload | null | undefined,
  fallbackTurnId: string | null | undefined
): string {
  const turnId = payload?.turnId || payload?.turn_id || fallbackTurnId || ''
  const result = typeof payload?.result === 'string' ? payload.result : ''
  const error = typeof payload?.error === 'string' ? payload.error : ''
  return [turnId, payload?.reason || '', result, error].join('\u001f')
}

export function toolInputSummary(_toolName: string, input: Record<string, unknown>): string {
  const askUserSummary = summarizeAskUserInput(input)
  if (askUserSummary) return askUserSummary
  if (input.command) return summarizeToolCommandInput(String(input.command))
  if (input.file_path) return String(input.file_path)
  if (input.pattern) return String(input.pattern)
  if (input.query) return String(input.query).slice(0, 80)
  if (input.url) return String(input.url).slice(0, 80)
  if (input.prompt) return String(input.prompt).slice(0, 80)
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  return keys.slice(0, 2).map(k => `${k}: ${String(input[k]).slice(0, 40)}`).join(', ')
}

export function truncateMiddle(text: string, max = 220): string {
  if (text.length <= max) return text
  const head = Math.max(20, Math.floor(max * 0.65))
  const tail = Math.max(10, max - head - 3)
  return `${text.slice(0, head)}...${text.slice(-tail)}`
}

export function firstMeaningfulLine(text: string): string {
  return text.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() || ''
}

function stripShellQuotes(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function cleanShellArg(value: string): string {
  return stripShellQuotes(value.trim()).replace(/\\(["' ])/g, '$1')
}

function compactShellPath(path: string): string {
  return truncateMiddle(path.replace(/^\.\//, ''), 72)
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim()
  const match = /^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/.exec(trimmed)
  return match ? stripShellQuotes(match[1]) : trimmed
}

export function parseShellInvocation(command: string): { shell: string; command: string } | null {
  const trimmed = command.trim()
  const match = /^(?:\/[^\s]+\/)?(zsh|bash|sh)\s+-lc\s+([\s\S]+)$/.exec(trimmed)
  if (!match) return null
  return {
    shell: match[1],
    command: stripShellQuotes(match[2]),
  }
}

export function summarizeToolCommandInput(command: string): string {
  const invocation = parseShellInvocation(command)
  const displayCommand = invocation?.command || command
  return summarizeShellCommand(command) || truncateMiddle(displayCommand, 120)
}

function summarizeSingleShellReadCommand(command: string): string | null {
  const trimmed = command.trim()
  const numberedSed = /^nl\s+-ba\s+(.+?)\s*\|\s*sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?$/.exec(trimmed)
  if (numberedSed) {
    const [, path, start, end] = numberedSed
    return `read ${compactShellPath(cleanShellArg(path))}:${start}${end ? `-${end}` : ''}`
  }
  const sed = /^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+(.+)$/.exec(trimmed)
  if (sed) {
    const [, start, end, path] = sed
    return `read ${compactShellPath(cleanShellArg(path))}:${start}${end ? `-${end}` : ''}`
  }
  const cat = /^cat\s+(.+)$/.exec(trimmed)
  if (cat) return `read ${compactShellPath(cleanShellArg(cat[1]))}`
  const rg = /^rg(?:\s+-[^\s]+)*\s+(.+?)\s+(.+)$/.exec(trimmed)
  if (rg) return `search ${truncateMiddle(cleanShellArg(rg[1]), 32)} in ${compactShellPath(cleanShellArg(rg[2]))}`
  return null
}

export function summarizeShellCommand(command: string): string | null {
  const unwrapped = unwrapShellCommand(command)
  const parts = unwrapped.split(/\s+&&\s+/).map(part => part.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const summaries = parts.map(summarizeSingleShellReadCommand)
  if (summaries.some(summary => !summary)) return null
  const visible = summaries.slice(0, 2).join(' + ')
  return summaries.length > 2 ? `${visible} + ${summaries.length - 2} more` : visible
}

export function formatContentSize(text: string): string {
  const lines = text ? text.split(/\r?\n/).length : 0
  const chars = text.length
  if (lines <= 1) return `${chars.toLocaleString()} ${i18next.t('claude.chars')}`
  return `${lines.toLocaleString()} ${i18next.t('claude.lines')} · ${chars.toLocaleString()} ${i18next.t('claude.chars')}`
}

// Compact output magnitude for the one-line tool row: 312, 1.1K, 2.4M.
// Counts characters like formatContentSize, but without its
// "312 lines · 18,204 chars" width — the row still has to fit the tool name, its
// argument and a timestamp. The full figure stays in the row's tooltip.
export function formatCompactCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) {
    const k = count / 1000
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`
  }
  const m = count / 1_000_000
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`
}

export interface ToolRowLayout {
  /** Right-aligned magnitude chip, or null when there is no output yet. */
  outSize: string | null
  showInRow: boolean
  showOutRow: boolean
  showErrorRows: boolean
}

// Elapsed chip for a finished tool row. Null below one second: for the
// Read/Edit/Grep crowd the figure is noise, and the row is denser without it.
export function formatToolElapsed(startedAt?: number, completedAt?: number): string | null {
  if (!startedAt || !completedAt) return null
  const ms = completedAt - startedAt
  if (!(ms >= 1000)) return null
  const totalSec = Math.round(ms / 1000)
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, '0')}s`
  return `${Math.floor(totalSec / 3600)}h${String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0')}m`
}

// What a generic tool row shows while collapsed.
//
// A long session is mostly tool calls, so each collapsed one gets exactly one
// line: name, primary argument, output magnitude, timestamp. The IN row and the
// output body appear only once the row is expanded. Previously a single collapsed
// tool could spend up to nine lines — a 3-line IN row plus a 4-line output
// preview — which pushed the assistant's actual replies off screen.
//
// Errors are the deliberate exception: they stay visible while collapsed. A
// failed tool that reads identically to a successful one is the one thing worth
// spending a line on, and errors are rare enough not to cost density in practice.
// `failed` (a non-zero exit / is_error result) opens the OUT row for the same
// reason: the stderr is what the user needs to read next, so it should not sit
// behind a click.
export function toolRowLayout(opts: {
  expanded: boolean
  hasInContent: boolean
  outText: string
  errorCount: number
  failed?: boolean
}): ToolRowLayout {
  const { expanded, hasInContent, outText, errorCount, failed = false } = opts
  return {
    outSize: outText ? formatCompactCount(outText.length) : null,
    showInRow: expanded && hasInContent,
    showOutRow: (expanded || failed) && !!outText,
    showErrorRows: errorCount > 0,
  }
}

export function buildCollapsedOutputPreview(text: string, maxLines = 4): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(0, maxLines)
    .map(line => truncateMiddle(line.trim(), 180))
}

export function toolInputContent(input: Record<string, unknown>): string {
  if (input.command) return String(input.command)
  if (input.file_path) return String(input.file_path)
  if (input.pattern) return String(input.pattern)
  if (input.query) return String(input.query)
  if (input.url) return String(input.url)
  if (input.prompt) return String(input.prompt)
  return JSON.stringify(input, null, 2)
}

export function toolDescription(input: Record<string, unknown>): string | null {
  if (input.description) return String(input.description)
  return null
}

export function splitSystemReminders(text: string): { content: string; reminders: string[]; errors: string[] } {
  const reminders: string[] = []
  const errors: string[] = []
  let content = text.replace(/<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>/g, (_match, inner) => {
    reminders.push(inner.trim())
    return ''
  })
  content = content.replace(/<tool_use_error>\s*([\s\S]*?)\s*<\/tool_use_error>/g, (_match, inner) => {
    errors.push(inner.trim())
    return ''
  }).trim()
  return { content, reminders, errors }
}

export function parseContentBlocks(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return text
  try {
    const parsed = JSON.parse(trimmed)
    const extractTextBlocks = (value: unknown): string | null => {
      if (Array.isArray(value)) {
        const texts = value
          .filter((b: { type?: string; text?: string }) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b: { text: string }) => b.text)
        return texts.length > 0 ? texts.join('\n\n') : null
      }
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (record.content !== undefined) return extractTextBlocks(record.content)
        if (typeof record.text === 'string') return record.text
        const entries = Object.entries(record)
        if (entries.length > 0 && entries.every(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null)) {
          return entries.map(([key, v]) => `${key}:\n${String(v ?? '')}`).join('\n\n')
        }
      }
      return null
    }
    const extracted = extractTextBlocks(parsed)
    if (!extracted) return text
    return extracted.trim().startsWith('{') || extracted.trim().startsWith('[')
      ? parseContentBlocks(extracted)
      : extracted
  } catch {
    return text
  }
}

export function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result == null) return ''
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time
  return d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatElapsed(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function shouldShowTimeDivider(current: MessageItem, prevItem: MessageItem | undefined): boolean {
  if (!prevItem) return false
  const curTs = current.timestamp || 0
  const prevTs = prevItem.timestamp || 0
  if (!curTs || !prevTs) return false
  return (curTs - prevTs) > 30 * 60 * 1000
}
