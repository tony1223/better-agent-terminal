import { forwardRef, useMemo } from 'react'
import { normalizeReasoningSummary } from '../utils/reasoning-summary'
import { ChatMarkdown } from './ChatMarkdown'

interface ReasoningSummaryProps {
  text: string
  cwd: string
  className?: string
}

// Reasoning summaries are model progress descriptions, not tool calls. Render
// their Markdown safely while keeping them inside the existing collapsible
// thinking surface. Path probing is disabled: summaries update while streaming
// and should not trigger filesystem RPCs on every partial delta.
export const ReasoningSummary = forwardRef<HTMLDivElement, ReasoningSummaryProps>(
  function ReasoningSummary({ text, cwd, className = 'claude-thinking-content' }, ref) {
    const normalized = useMemo(() => normalizeReasoningSummary(text), [text])
    if (!normalized) return null
    return (
      <div ref={ref} className={className}>
        <ChatMarkdown
          text={normalized}
          cwd={cwd}
          className="claude-markdown claude-thinking-markdown"
          resolvePathLinks={false}
        />
      </div>
    )
  },
)
