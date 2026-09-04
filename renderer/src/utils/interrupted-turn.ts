// Local summary of an interrupted turn: what the user asked, which tools ran
// since, and the last thing the agent said. Built from the messages already
// on screen — no model call, so resuming costs nothing until the user
// actually presses "Continue".
import { describePendingAction, summarizeResult } from './attention'

export interface InterruptedTurnItemLike {
  id: string
  timestamp: number
  role?: 'user' | 'assistant' | 'system'
  content?: string
  kind?: string
  isCompactSummary?: boolean
  toolName?: string
  input?: Record<string, unknown>
  status?: string
}

export interface InterruptedTurnSummary {
  /** The prompt that started the interrupted turn, shortened. Empty if unknown. */
  prompt: string
  toolCount: number
  /** Up to three most recent tool labels ("Bash: pnpm test"), oldest first. */
  lastTools: string[]
  /** Last assistant text before the interruption, shortened. */
  lastReply: string
  /** Tools still marked running when the turn stopped. */
  unfinishedTools: number
}

const MAX_TOOLS = 3

function isUserPrompt(item: InterruptedTurnItemLike): boolean {
  return item.role === 'user' && !item.kind && !item.isCompactSummary && !item.toolName
}

export function summarizeInterruptedTurn(items: readonly InterruptedTurnItemLike[]): InterruptedTurnSummary {
  let start = items.length
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isUserPrompt(items[i])) { start = i; break }
  }
  const prompt = start < items.length ? summarizeResult(items[start].content, 80) : ''
  const turn = items.slice(start < items.length ? start + 1 : 0)
  const tools = turn.filter(item => typeof item.toolName === 'string')
  const lastTools = tools
    .slice(-MAX_TOOLS)
    .map(tool => describePendingAction({ toolName: tool.toolName as string, input: tool.input ?? {} }, null) ?? '')
    .filter(Boolean)
  let lastReply = ''
  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const item = turn[i]
    if (item.role === 'assistant' && item.content && item.content.trim()) {
      lastReply = summarizeResult(item.content, 140)
      break
    }
  }
  return {
    prompt,
    toolCount: tools.length,
    lastTools,
    lastReply,
    unfinishedTools: tools.filter(tool => tool.status === 'running').length,
  }
}
