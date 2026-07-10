import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { isToolCall, type ClaudeMessage, type ClaudeToolCall } from '../types/claude-agent'

type StreamItem = ClaudeMessage | ClaudeToolCall

export interface MessageFilterFlags {
  showToolMsg: boolean
  showUserMsg: boolean
  showAssistantMsg: boolean
  showThinkingMsg: boolean
}

export type HiddenKind = 'tool' | 'you' | 'message' | 'thinking'

const SKIP_LABEL_KEY: Record<HiddenKind, string> = {
  tool: 'claude.hiddenTools',
  you: 'claude.skippedUser',
  message: 'claude.skippedMessages',
  thinking: 'claude.skippedThinking',
}

// Mirrors the early `return null` filter checks inside each panel's
// renderMessage() and buckets each hidden item by its structural kind.
// MUST stay in sync with ClaudeAgentPanel/CodexAgentPanel renderMessage:
//   - tool calls hidden when !showToolMsg
//   - user messages hidden when !showUserMsg
//   - assistant messages hidden when !showAssistantMsg
//   - thinking-only assistant messages hidden when !showThinkingMsg && !content
// Returns the kind bucket of a hidden item, or null when the item is visible.
export function classifyHiddenKind(item: StreamItem, f: MessageFilterFlags): HiddenKind | null {
  if (isToolCall(item)) return f.showToolMsg ? null : 'tool'
  const msg = item as ClaudeMessage
  if (msg.role === 'user') return f.showUserMsg ? null : 'you'
  if (msg.role === 'assistant') {
    const hidden = !f.showAssistantMsg || (!f.showThinkingMsg && !msg.content)
    if (!hidden) return null
    return msg.thinking && !msg.content ? 'thinking' : 'message'
  }
  return null
}

// Muted timeline row standing in for a contiguous run of filtered-out items of
// a single kind, e.g. "3 tools hidden". The tools still executed; only their
// timeline rows are hidden by the presentation filter.
function SkippedRunRow({ kind, count }: { kind: HiddenKind; count: number }) {
  const { t } = useTranslation()
  return (
    <div className="tl-item claude-skipped-run">
      <div className="tl-dot dot-skipped" />
      <div className="tl-content claude-skipped-run-label">{t(SKIP_LABEL_KEY[kind], { count })}</div>
    </div>
  )
}

// Walks the message list, rendering each visible item via `renderVisible` and
// collapsing every contiguous run of same-kind filtered-out items into one
// SkippedRunRow reporting how many items of that kind were hidden. A run only
// extends while the hidden kind stays the same, so tools / messages / thinking
// each get their own placeholder (matching the mobile client).
export function buildMessageStream(
  items: StreamItem[],
  flags: MessageFilterFlags,
  renderVisible: (item: StreamItem, index: number) => ReactNode,
): ReactNode[] {
  const out: ReactNode[] = []
  let pending: { kind: HiddenKind; count: number; startIndex: number } | null = null
  const flush = () => {
    if (!pending) return
    out.push(
      <SkippedRunRow key={`skipped-${pending.kind}-${pending.startIndex}`} kind={pending.kind} count={pending.count} />,
    )
    pending = null
  }
  items.forEach((item, i) => {
    const kind = classifyHiddenKind(item, flags)
    if (kind) {
      if (pending && pending.kind === kind) {
        pending.count += 1
      } else {
        flush()
        pending = { kind, count: 1, startIndex: i }
      }
      return
    }
    flush()
    out.push(renderVisible(item, i))
  })
  flush()
  return out
}
