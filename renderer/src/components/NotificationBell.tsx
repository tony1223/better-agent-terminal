import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { host } from '../host-api'
import { notificationStore, type NotificationEntry } from '../stores/notification-store'
import { useWorkspace, workspaceStore } from '../stores/workspace-store'
import { shallowEqual } from '../stores/use-store'
import {
  computeBellBadge,
  formatBadgeCount,
  summarizeResult,
  unreadCompletionIds,
  type BellBadgeTone,
} from '../utils/attention'

function formatRelative(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Math.max(0, Date.now() - ts)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return t('notifications.justNow')
  const min = Math.floor(sec / 60)
  if (min < 60) return t('notifications.minutesAgo', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('notifications.hoursAgo', { count: hr })
  const day = Math.floor(hr / 24)
  return t('notifications.daysAgo', { count: day })
}

const BADGE_COLORS: Record<BellBadgeTone, string> = {
  red: '#e04848',
  green: '#10b981',
  gray: '#555',
}

interface LocalAgentRow {
  terminalId: string
  workspaceId: string
  workspaceName: string
  agentKind: string | null
  pending: boolean
  pendingLabel: string | null
  pendingKind: 'permission' | 'question' | null
}

const rowStyle = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-color, #2a2a2a)',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 2,
}

const titleStyle = {
  fontSize: 13,
  color: 'var(--text-primary, #ddd)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  flex: 1,
  minWidth: 0,
}

const metaStyle = {
  fontSize: 11,
  color: 'var(--text-secondary, #888)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
}

const sectionStyle = {
  padding: '6px 12px 2px',
  fontSize: 10,
  letterSpacing: 0.5,
  textTransform: 'uppercase' as const,
  color: 'var(--text-secondary, #777)',
}

export function NotificationBell() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<NotificationEntry[]>(notificationStore.getEntries())
  const [open, setOpen] = useState(false)
  const [profileNames, setProfileNames] = useState<Record<string, string>>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const latestUnreadShortcut = 'Ctrl+Tab'

  // Local agents that are blocked on the user or still running. Cross-window
  // state for these does not exist on the host, so this section is scoped to
  // the current window; completions (below) are host-global.
  const localRows = useWorkspace(
    (state): LocalAgentRow[] => {
      const rows: LocalAgentRow[] = []
      for (const terminal of state.terminals) {
        if (!terminal.hasPendingAction && !terminal.isAgentRunning) continue
        const workspace = state.workspaces.find(w => w.id === terminal.workspaceId)
        rows.push({
          terminalId: terminal.id,
          workspaceId: terminal.workspaceId,
          workspaceName: workspace?.alias || workspace?.name || terminal.cwd,
          agentKind: terminal.agentPreset ?? null,
          pending: terminal.hasPendingAction === true,
          pendingLabel: terminal.pendingActionLabel ?? null,
          pendingKind: terminal.pendingActionKind ?? null,
        })
      }
      return rows
    },
    (a, b) => a.length === b.length && a.every((row, i) => shallowEqual(row, b[i])),
  )
  const activeWorkspaceId = useWorkspace(state => state.activeWorkspaceId)

  useEffect(() => {
    notificationStore.init()
    const unsub = notificationStore.subscribe(() => {
      setEntries(notificationStore.getEntries().slice())
    })
    return unsub
  }, [])

  // Viewing a workspace counts as having seen its completions. Only while the
  // window actually has focus — an active tab in a background window has not
  // been looked at, and the bright-green dot should survive until it is.
  useEffect(() => {
    if (!activeWorkspaceId) return
    const markSeen = () => {
      if (typeof document !== 'undefined' && !document.hasFocus()) return
      for (const id of unreadCompletionIds(notificationStore.getEntries(), activeWorkspaceId)) {
        void notificationStore.markRead(id)
      }
    }
    markSeen()
    window.addEventListener('focus', markSeen)
    return () => window.removeEventListener('focus', markSeen)
  }, [activeWorkspaceId, entries])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  // Profile names label entries that belong to another window. Fetched when
  // the list opens; cheap and only needed for the label.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.resolve(host.profile.list())
      .then(result => {
        if (cancelled) return
        const profiles = (result as { profiles?: Array<{ id?: string; name?: string }> } | null)?.profiles
        if (!Array.isArray(profiles)) return
        const next: Record<string, string> = {}
        for (const p of profiles) {
          if (p?.id && p.name) next[p.id] = p.name
        }
        setProfileNames(next)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open])

  const pendingRows = useMemo(() => localRows.filter(r => r.pending), [localRows])
  const runningRows = useMemo(() => localRows.filter(r => !r.pending), [localRows])
  const unread = entries.reduce((n, e) => (e.read ? n : n + 1), 0)
  const badge = computeBellBadge({ pending: pendingRows.length, unread, running: runningRows.length })
  const currentWindowId = workspaceStore.getWindowId()

  const onEntryClick = (entry: NotificationEntry) => {
    // Remote-client entries have no window/workspace to focus — just
    // mark them read. Agent entries focus their owning window/workspace.
    if (entry.kind === 'remote-client') {
      notificationStore.markRead(entry.id)
    } else {
      notificationStore.focusEntry(entry.id)
    }
    setOpen(false)
  }

  const onLocalRowClick = (row: LocalAgentRow) => {
    workspaceStore.setActiveWorkspace(row.workspaceId)
    setOpen(false)
  }

  const approvePending = useCallback((row: LocalAgentRow, event: React.MouseEvent) => {
    event.stopPropagation()
    window.dispatchEvent(new CustomEvent('bat:approve-pending', { detail: { sessionId: row.terminalId } }))
  }, [])

  const viewedRemoteProfileId = workspaceStore.getViewedRemoteProfileId()
  const windowLabel = (entry: NotificationEntry): string | null => {
    if (viewedRemoteProfileId) {
      // Host list in a remote window: "elsewhere" means another host profile.
      if (!entry.profileId || entry.profileId === viewedRemoteProfileId) return null
      return t('notifications.otherWindow', { name: profileNames[entry.profileId] || entry.profileId })
    }
    if (!entry.windowId || !currentWindowId || entry.windowId === currentWindowId) return null
    const name = (entry.profileId && profileNames[entry.profileId]) || entry.windowId
    return t('notifications.otherWindow', { name })
  }

  const hover = {
    onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'var(--bg-hover, #2a2a2a)' },
  }
  const unhover = (background: string) => ({
    onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = background },
  })

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        className="settings-btn"
        onClick={() => setOpen(o => !o)}
        title={`${t('notifications.title')} (${latestUnreadShortcut})`}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}
      >
        <span style={{ fontSize: 14 }}>🔔</span>
        <span>{t('notifications.title')}</span>
        <span
          className="shortcut-hint notification-shortcut-hint"
          style={{ marginRight: badge ? 18 : 0 }}
        >
          {latestUnreadShortcut}
        </span>
        {badge && (
          <span
            data-tone={badge.tone}
            style={{
              position: 'absolute',
              top: 2,
              right: 6,
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 9,
              background: BADGE_COLORS[badge.tone],
              color: '#fff',
              fontSize: 11,
              lineHeight: '18px',
              textAlign: 'center',
              fontWeight: 600,
            }}
          >
            {formatBadgeCount(badge.count)}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            maxHeight: 400,
            overflowY: 'auto',
            background: 'var(--bg-elevated, #1e1e1e)',
            border: '1px solid var(--border-color, #333)',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 10px',
              borderBottom: '1px solid var(--border-color, #333)',
              fontSize: 12,
              color: 'var(--text-secondary, #aaa)',
            }}
          >
            <span>{t('notifications.title')}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => notificationStore.markAllRead()}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary, #aaa)', cursor: 'pointer', fontSize: 11 }}
              >
                {t('notifications.markAllRead')}
              </button>
              <button
                onClick={() => notificationStore.clear()}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary, #aaa)', cursor: 'pointer', fontSize: 11 }}
              >
                {t('notifications.clear')}
              </button>
            </div>
          </div>

          {pendingRows.length > 0 && (
            <>
              <div style={sectionStyle}>{t('notifications.sectionNeedsYou')}</div>
              {pendingRows.map(row => (
                <div
                  key={row.terminalId}
                  onClick={() => onLocalRowClick(row)}
                  style={{ ...rowStyle, background: 'rgba(239, 68, 68, 0.06)' }}
                  {...hover}
                  {...unhover('rgba(239, 68, 68, 0.06)')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
                    <span style={{ ...titleStyle, fontWeight: 600 }}>{row.workspaceName}</span>
                    {row.pendingKind === 'permission' && (
                      <button
                        onClick={(e) => approvePending(row, e)}
                        style={{
                          background: 'rgba(16, 185, 129, 0.12)',
                          border: '1px solid rgba(16, 185, 129, 0.5)',
                          color: '#7ee787',
                          borderRadius: 4,
                          padding: '1px 8px',
                          fontSize: 11,
                          cursor: 'pointer',
                          flexShrink: 0,
                        }}
                      >
                        {t('notifications.approve')}
                      </button>
                    )}
                  </div>
                  <div style={metaStyle}>
                    {row.pendingKind === 'question' ? t('notifications.needsAnswer') : t('notifications.needsApproval')}
                    {row.agentKind ? ` · ${row.agentKind}` : ''}
                    {row.pendingLabel ? ` · ${row.pendingLabel}` : ''}
                  </div>
                </div>
              ))}
            </>
          )}

          {entries.length === 0 && localRows.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary, #888)', fontSize: 12 }}>
              {t('notifications.empty')}
            </div>
          ) : (
            entries.map((entry) => {
              const background = entry.read ? 'transparent' : 'rgba(76, 175, 80, 0.06)'
              const summary = entry.kind === 'remote-client' ? '' : summarizeResult(entry.result)
              const other = entry.kind === 'remote-client' ? null : windowLabel(entry)
              return (
                <div
                  key={entry.id}
                  onClick={() => onEntryClick(entry)}
                  style={{ ...rowStyle, background }}
                  {...hover}
                  {...unhover(background)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!entry.read && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4caf50', flexShrink: 0 }} />}
                    <span style={{ ...titleStyle, fontWeight: entry.read ? 'normal' : 600 }}>
                      {entry.kind === 'remote-client'
                        ? t('notifications.clientConnected', { name: entry.title })
                        : `${entry.workspaceName} ${t('notifications.ends')}`}
                    </span>
                    {other && (
                      <span style={{ fontSize: 10, color: 'var(--text-secondary, #777)', flexShrink: 0 }}>{other}</span>
                    )}
                  </div>
                  {summary && <div style={metaStyle} title={entry.result}>{summary}</div>}
                  <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>
                    {formatRelative(entry.timestamp, t)}
                    {entry.kind === 'remote-client' ? '' : entry.agentKind ? ` · ${entry.agentKind}` : ''}
                  </div>
                </div>
              )
            })
          )}

          {runningRows.length > 0 && (
            <>
              <div style={sectionStyle}>{t('notifications.sectionRunning')}</div>
              {runningRows.map(row => (
                <div
                  key={row.terminalId}
                  onClick={() => onLocalRowClick(row)}
                  style={{ ...rowStyle, opacity: 0.6, background: 'transparent' }}
                  {...hover}
                  {...unhover('transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fbbf24', flexShrink: 0 }} />
                    <span style={titleStyle}>{row.workspaceName}</span>
                  </div>
                  <div style={metaStyle}>
                    {t('notifications.running')}
                    {row.agentKind ? ` · ${row.agentKind}` : ''}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
