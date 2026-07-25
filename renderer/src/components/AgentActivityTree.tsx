// Agent activity tree — replaces the old running-only active-tasks bar with a
// two-mode view of subagent / workflow activity:
//   - bar (collapsed): visually the old bar — running chips with progress,
//     elapsed, bg tag, Stop — plus done/failed summary chips, so finished
//     agents no longer vanish from sight.
//   - tree (expanded): nested Task/Agent/Workflow nodes (parentToolUseId
//     edges), keeping completed/error nodes, with per-node live detail:
//     lifecycle progress text and the subagent's last streaming line.
// Pure presentational component; the panel owns tree building and state.
import { useState } from 'react'
import type { TFunction } from 'i18next'
import {
  formatAgentNodeElapsed,
  lastStreamLine,
  type AgentTaskNode,
  type AgentTreeSummary,
} from '../lib/agent-task-tree'

export interface AgentActivityTreeProps {
  roots: AgentTaskNode[]
  summary: AgentTreeSummary
  expanded: boolean
  onToggleExpanded: () => void
  onHide: () => void
  streamingText: ReadonlyMap<string, string>
  onOpenTask: (node: AgentTaskNode) => void
  onStopTask: (id: string) => void
  t: TFunction
}

function statusGlyph(status: AgentTaskNode['status']): JSX.Element {
  if (status === 'running') return <span className="claude-active-task-dot" />
  if (status === 'error') return <span className="claude-agent-tree-status is-error">✗</span>
  return <span className="claude-agent-tree-status is-done">✓</span>
}

export function AgentActivityTree({
  roots, summary, expanded, onToggleExpanded, onHide,
  streamingText, onOpenTask, onStopTask, t,
}: AgentActivityTreeProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  const toggleNode = (id: string) => setCollapsedIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const summaryChips = (
    <>
      {summary.completed > 0 && (
        <span className="claude-agent-tree-chip is-done" onClick={onToggleExpanded} title={t('claude.agentTreeToggle')}>
          ✓ {summary.completed}
        </span>
      )}
      {summary.error > 0 && (
        <span className="claude-agent-tree-chip is-error" onClick={onToggleExpanded} title={t('claude.agentTreeToggle')}>
          ✗ {summary.error}
        </span>
      )}
    </>
  )

  // The header/bar row itself toggles, so the buttons stop propagation to
  // avoid double-firing the toggle.
  const controls = (
    <span className="claude-agent-tree-controls">
      <button
        className="claude-agent-tree-btn"
        onClick={(e) => { e.stopPropagation(); onToggleExpanded() }}
        title={t('claude.agentTreeToggle')}
      >{expanded ? '▾' : '▸'}</button>
      <button
        className="claude-agent-tree-btn"
        onClick={(e) => { e.stopPropagation(); onHide() }}
        title={t('claude.agentTreeHide')}
      >&times;</button>
    </span>
  )

  if (!expanded) {
    // Collapsed bar: same chip layout as the old active-tasks bar, with
    // running chips first and the finished summary appended.
    return (
      <div
        className="claude-active-tasks claude-agent-tree-bar"
        // Empty space in the bar expands too; task chips keep their own click.
        onClick={(e) => { if (e.target === e.currentTarget) onToggleExpanded() }}
      >
        {roots.filter(node => node.status === 'running').map(node => {
          const rawProgress = node.progressText || ''
          const isStalled = rawProgress.startsWith('[stalled]')
          // Skip the progress line when it merely repeats the label — it
          // doubles each chip's width without adding information.
          const progressDesc = rawProgress.trim() === node.label.trim() ? '' : rawProgress
          const rawLive = !rawProgress ? lastStreamLine(streamingText.get(node.id)) : ''
          const liveLine = rawLive.trim() === node.label.trim() ? '' : rawLive
          return (
            <div key={node.id} className="claude-active-task-item" onClick={() => onOpenTask(node)}>
              <span className="claude-active-task-dot" />
              <span className="claude-active-task-label">{node.label.slice(0, 60)}</span>
              {node.kind === 'workflow' && <span className="claude-task-tag">{t('claude.workflowTag')}</span>}
              {progressDesc && !isStalled && <span className="claude-active-task-progress">{progressDesc}</span>}
              {!progressDesc && liveLine && <span className="claude-active-task-progress">{liveLine}</span>}
              {isStalled && <span className="claude-active-task-stalled">{t('claude.stalled')}</span>}
              {node.timestamp > 0 && <span className="claude-active-task-time">{formatAgentNodeElapsed(node, Date.now())}</span>}
              {node.isBackground && <span className="claude-task-tag">{t('claude.bg')}</span>}
              <button className="claude-task-stop-btn" onClick={(e) => { e.stopPropagation(); onStopTask(node.id) }}>Stop</button>
            </div>
          )
        })}
        {summaryChips}
        {controls}
      </div>
    )
  }

  const renderNode = (node: AgentTaskNode, depth: number): JSX.Element => {
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsedIds.has(node.id)
    const rawProgress = node.progressText || ''
    const isStalled = rawProgress.startsWith('[stalled]')
    const progressDesc = rawProgress.trim() === node.label.trim() ? '' : rawProgress
    const liveLine = node.status === 'running' ? lastStreamLine(streamingText.get(node.id)) : ''
    const elapsed = formatAgentNodeElapsed(node, Date.now())
    return (
      <div key={node.id} className="claude-agent-tree-node">
        <div
          className={`claude-agent-tree-row is-${node.status}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => onOpenTask(node)}
        >
          <button
            className={`claude-agent-tree-chevron${hasChildren ? '' : ' is-leaf'}`}
            onClick={(e) => { e.stopPropagation(); if (hasChildren) toggleNode(node.id) }}
          >{hasChildren ? (isCollapsed ? '▸' : '▾') : '·'}</button>
          {statusGlyph(node.status)}
          <span className="claude-active-task-label">{node.label}</span>
          {node.kind === 'workflow' && (
            <span className="claude-task-tag">{node.workflowName || t('claude.workflowTag')}</span>
          )}
          {node.subagentType && node.subagentType !== node.label && (
            <span className="claude-agent-tree-type">{node.subagentType}</span>
          )}
          {progressDesc && !isStalled && <span className="claude-active-task-progress">{progressDesc}</span>}
          {isStalled && <span className="claude-active-task-stalled">{t('claude.stalled')}</span>}
          {node.error && <span className="claude-agent-tree-error">{node.error}</span>}
          {elapsed && <span className="claude-active-task-time">{elapsed}</span>}
          {node.isBackground && <span className="claude-task-tag">{t('claude.bg')}</span>}
          {node.status === 'running' && (
            <button className="claude-task-stop-btn" onClick={(e) => { e.stopPropagation(); onStopTask(node.id) }}>Stop</button>
          )}
        </div>
        {node.status === 'running' && liveLine && (
          <div className="claude-agent-tree-live" style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
            {liveLine}
          </div>
        )}
        {hasChildren && !isCollapsed && node.children.map(child => renderNode(child, depth + 1))}
      </div>
    )
  }

  return (
    <div className="claude-agent-tree">
      <div
        className="claude-agent-tree-header"
        onClick={onToggleExpanded}
        title={t('claude.agentTreeToggle')}
      >
        <span className="claude-agent-tree-title">{t('claude.agentTreeTitle')}</span>
        {summary.running > 0 && (
          <span className="claude-agent-tree-chip is-running">{t('claude.agentsRunning', { count: summary.running })}</span>
        )}
        {summary.completed > 0 && (
          <span className="claude-agent-tree-chip is-done">{t('claude.agentsDone', { count: summary.completed })}</span>
        )}
        {summary.error > 0 && (
          <span className="claude-agent-tree-chip is-error">{t('claude.agentsFailed', { count: summary.error })}</span>
        )}
        {controls}
      </div>
      <div className="claude-agent-tree-body">
        {roots.map(node => renderNode(node, 0))}
      </div>
    </div>
  )
}
