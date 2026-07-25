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

// Muted timeline row standing in for a run of filtered-out items of a single
// kind, e.g. "3 tools hidden". The tools still executed; only their timeline
// rows are hidden by the presentation filter. `merged` marks a row that totals
// several runs at once, so it reads as an accumulated group rather than a
// single stretch.
function SkippedRunRow({ kind, count, merged }: { kind: HiddenKind; count: number; merged?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className={`tl-item claude-skipped-run${merged ? ' claude-skipped-run-merged' : ''}`}>
      <div className="tl-dot dot-skipped" />
      <div className="tl-content claude-skipped-run-label">{t(SKIP_LABEL_KEY[kind], { count })}</div>
    </div>
  )
}

interface HiddenRun {
  kind: HiddenKind
  count: number
  startIndex: number
}

// Trailing runs of a hidden block that keep their own rows. A long filtered
// stretch is usually still growing, so the last few runs stay separate to show
// the stream ticking forward while everything older collapses behind them.
const LIVE_TAIL_RUNS = 2

// Renders one contiguous block of hidden runs. Kinds alternate constantly
// (tool → thinking → tool → …), so a block of 20 runs used to cost 20 rows and
// swallow the viewport. Everything before the live tail is totalled per kind
// into a single row each, capping the block at (kinds + LIVE_TAIL_RUNS) rows.
function renderHiddenBlock(runs: HiddenRun[]): ReactNode[] {
  const rowFor = (run: HiddenRun, merged?: boolean) => (
    <SkippedRunRow key={`skipped-${run.kind}-${run.startIndex}`} kind={run.kind} count={run.count} merged={merged} />
  )
  if (runs.length <= LIVE_TAIL_RUNS) return runs.map(run => rowFor(run))

  // Total the older runs per kind, keyed so each kind keeps the position and
  // key of its first run — stable across re-renders as the block grows.
  const totals = new Map<HiddenKind, HiddenRun & { runCount: number }>()
  for (const run of runs.slice(0, -LIVE_TAIL_RUNS)) {
    const acc = totals.get(run.kind)
    if (acc) {
      acc.count += run.count
      acc.runCount += 1
    } else {
      totals.set(run.kind, { ...run, runCount: 1 })
    }
  }
  return [
    ...Array.from(totals.values(), acc => rowFor(acc, acc.runCount > 1)),
    ...runs.slice(-LIVE_TAIL_RUNS).map(run => rowFor(run)),
  ]
}

// Walks the message list, rendering each visible item via `renderVisible` and
// every contiguous stretch of filtered-out items as placeholder rows. Within a
// stretch, same-kind neighbours group into one run, then renderHiddenBlock
// folds the older runs together so tools / messages / thinking each contribute
// at most one summary row plus the live tail.
export function buildMessageStream(
  items: StreamItem[],
  flags: MessageFilterFlags,
  renderVisible: (item: StreamItem, index: number) => ReactNode,
): ReactNode[] {
  const out: ReactNode[] = []
  let block: HiddenRun[] = []
  const flush = () => {
    if (block.length === 0) return
    out.push(...renderHiddenBlock(block))
    block = []
  }
  items.forEach((item, i) => {
    const kind = classifyHiddenKind(item, flags)
    if (kind) {
      const last = block[block.length - 1]
      if (last && last.kind === kind) last.count += 1
      else block.push({ kind, count: 1, startIndex: i })
      return
    }
    flush()
    out.push(renderVisible(item, i))
  })
  flush()
  return out
}
