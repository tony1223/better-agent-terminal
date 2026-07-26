// The one-line collapsed tool row, shared by the Claude and Codex timelines.
//
// Both panels rendered this header byte-for-byte identically in their own 6k-line
// files; this is the single copy. Density is the point: a long session is mostly
// tool calls, so a collapsed one gets exactly one line — name, primary argument,
// output magnitude, timestamp — and everything else lives behind the chevron.
// See toolRowLayout in CodexAgentPanel.helpers for what that hides.
//
// Layout note: the right-hand group (size · time · chevron) is one flex child so
// the pieces stay together against the right edge. `.claude-tool-time` carries
// `margin-left: auto` for the older headers that still position it themselves, so
// the group's CSS neutralises it.

import { formatFullTimestamp, formatTimestamp } from './CodexAgentPanel.helpers'

export interface AgentToolRowProps {
  toolName: string
  /** Shell name for Bash-style invocations, e.g. "pwsh". */
  shell?: string | null
  isDeferred?: boolean
  /** The tool's own human-readable intent; wins over `summary` when present. */
  desc?: string | null
  /** Fallback one-liner derived from the tool input. */
  summary?: string
  timestamp?: number
  /** Compact output magnitude from toolRowLayout, e.g. "1.1K". */
  outSize?: string | null
  /** Full "N lines · M chars" figure, shown as the size chip's tooltip. */
  outSizeTitle?: string | null
  expanded: boolean
  onToggle: () => void
}

export function AgentToolRow({
  toolName,
  shell,
  isDeferred,
  desc,
  summary,
  timestamp,
  outSize,
  outSizeTitle,
  expanded,
  onToggle,
}: AgentToolRowProps) {
  return (
    <div className="claude-tool-header" onClick={onToggle}>
      <span className="claude-tool-name">{toolName}</span>
      {shell && <span className="claude-tool-shell">| {shell} |</span>}
      {isDeferred && <span className="claude-tool-badge claude-deferred-badge">deferred</span>}
      {desc
        ? <span className="claude-tool-desc">{desc}</span>
        : <span className="claude-tool-summary">{summary}</span>}
      <span className="claude-tool-meta">
        {outSize && (
          <span className="claude-tool-outsize" title={outSizeTitle || undefined}>{outSize}</span>
        )}
        {timestamp !== undefined && timestamp > 0 && (
          <span className="claude-tool-time" title={formatFullTimestamp(timestamp)}>
            {formatTimestamp(timestamp)}
          </span>
        )}
        <span className={`claude-tool-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
      </span>
    </div>
  )
}
