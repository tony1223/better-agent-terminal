import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { host } from '../host-api'

type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

type McpSource = 'user' | 'project-local' | 'project-file' | 'plugin'

interface StaticServer {
  name: string
  scope: 'user' | 'project' | 'plugin'
  source: McpSource
  transport: string
  plugin?: string
  disabled?: boolean
}

// Subset of the SDK McpServerStatus we render.
interface LiveStatus {
  name: string
  status: McpStatus
  error?: string
  scope?: string
  serverInfo?: { name: string; version: string }
  tools?: { name: string }[]
}

interface McpRow {
  name: string
  scope: string
  source: McpSource
  transport?: string
  plugin?: string
  status?: McpStatus
  error?: string
  toolCount?: number
  version?: string
  disabled: boolean
}

interface McpPanelProps {
  isVisible: boolean
  activeCwd: string | null
  activeSessionId: string | null
}

const STATUS_REFRESH_MS = 5000

export function McpPanel({ isVisible, activeCwd, activeSessionId }: McpPanelProps) {
  const { t } = useTranslation()
  const [staticServers, setStaticServers] = useState<StaticServer[]>([])
  const [liveStatus, setLiveStatus] = useState<LiveStatus[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Static disk scan (user / project / plugin sources, incl. persisted
  // disabled state) — works without a session.
  const fetchStatic = useCallback(() => {
    if (!activeCwd) {
      setStaticServers([])
      return
    }
    host.claude.scanMcpServers(activeCwd).then((results: StaticServer[]) => {
      setStaticServers(Array.isArray(results) ? results : [])
    }).catch(() => setStaticServers([]))
  }, [activeCwd])

  useEffect(() => { fetchStatic() }, [fetchStatic])

  const fetchStatus = useCallback(() => {
    if (!activeSessionId) {
      setLiveStatus([])
      return
    }
    host.claude.getMcpServerStatus(activeSessionId).then((results: LiveStatus[]) => {
      setLiveStatus(Array.isArray(results) ? results : [])
    }).catch(() => setLiveStatus([]))
  }, [activeSessionId])

  // Live status — fetch on session change, then poll while a session is active
  useEffect(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    fetchStatus()
    if (activeSessionId) {
      intervalRef.current = setInterval(fetchStatus, STATUS_REFRESH_MS)
    }
    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    }
  }, [activeSessionId, fetchStatus])

  // Merge static config (incl. persisted disabled state) with live status.
  const rows = useMemo<McpRow[]>(() => {
    const byName = new Map<string, McpRow>()
    for (const s of staticServers) {
      byName.set(s.name, {
        name: s.name,
        scope: s.scope,
        source: s.source,
        transport: s.transport,
        plugin: s.plugin,
        disabled: !!s.disabled,
      })
    }
    for (const l of liveStatus) {
      const prev = byName.get(l.name) ?? { name: l.name, scope: l.scope ?? 'live', source: 'user' as McpSource, disabled: false }
      byName.set(l.name, {
        ...prev,
        scope: prev.scope ?? l.scope ?? 'live',
        status: l.status,
        error: l.error,
        toolCount: Array.isArray(l.tools) ? l.tools.length : undefined,
        version: l.serverInfo?.version,
        // Persisted config is the source of truth for on/off; live 'disabled'
        // also counts so a runtime toggle reflects immediately.
        disabled: prev.disabled || l.status === 'disabled',
      })
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [staticServers, liveStatus])

  const filtered = useMemo(() => {
    if (!searchQuery) return rows
    const q = searchQuery.toLowerCase()
    return rows.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.scope.toLowerCase().includes(q) ||
      (r.transport?.toLowerCase().includes(q) ?? false) ||
      (r.plugin?.toLowerCase().includes(q) ?? false))
  }, [rows, searchQuery])

  const hasLive = liveStatus.length > 0

  const runAction = useCallback(async (name: string, fn: () => Promise<unknown>) => {
    setBusy(prev => ({ ...prev, [name]: true }))
    try {
      await fn()
    } catch {
      // Surface failures via a refetch; the error text lands in the row tooltip.
    } finally {
      fetchStatic()
      fetchStatus()
      setBusy(prev => ({ ...prev, [name]: false }))
    }
  }, [fetchStatic, fetchStatus])

  const handleReconnect = useCallback((name: string) => {
    if (!activeSessionId) return
    void runAction(name, () => host.claude.reconnectMcpServer(activeSessionId, name))
  }, [activeSessionId, runAction])

  // Toggle = durable persist (config file, always) + runtime effect for the
  // current session when one is live. Persist works without a session, so the
  // change survives restarts.
  const handleToggle = useCallback((name: string, source: McpSource, enable: boolean) => {
    if (!activeCwd) return
    void runAction(name, async () => {
      await host.claude.setMcpServerEnabled(activeCwd, name, enable, source)
      if (activeSessionId) {
        try { await host.claude.toggleMcpServer(activeSessionId, name, enable) } catch { /* runtime best-effort */ }
      }
    })
  }, [activeCwd, activeSessionId, runAction])

  if (!isVisible) return null

  const statusLabel = (status?: McpStatus): string => {
    if (!status) return t('mcp.statusConfigured', 'configured')
    return t(`mcp.status.${status}`, status)
  }

  return (
    <div className="skills-sidebar">
      <div className="skills-sidebar-search">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder={t('mcp.searchServers', 'Search MCP servers')}
        />
      </div>

      <div className="skills-sidebar-body">
        {filtered.length > 0 ? (
          <div className="skills-section">
            <div className="skills-section-list">
              {filtered.map(row => {
                const isBusy = !!busy[row.name]
                const isOff = row.disabled
                // Display status: persisted-off overrides any stale live status.
                const shownStatus: McpStatus | undefined = isOff ? 'disabled' : row.status
                const canToggle = !!activeCwd
                const canReconnect = !!activeSessionId && !isOff && (hasLive || !!row.status)
                const meta = [row.transport, row.plugin ? row.plugin : row.scope, row.version ? `v${row.version}` : null]
                  .filter(Boolean).join(' · ')
                const metaText = [
                  statusLabel(shownStatus),
                  meta,
                  typeof row.toolCount === 'number' ? `${row.toolCount} ${t('mcp.tools', 'tools')}` : null,
                ].filter(Boolean).join(' · ')
                return (
                  <div
                    key={`mcp:${row.name}`}
                    className={`mcp-row${isOff ? ' mcp-row-disabled' : ''}`}
                    title={row.error
                      ? `${row.name} — ${statusLabel(shownStatus)} — ${row.error}`
                      : `${row.name} — ${statusLabel(shownStatus)}${meta ? ` · ${meta}` : ''}`}
                  >
                    <span className={`mcp-dot mcp-dot-${shownStatus ?? 'configured'}`} />
                    <span className="mcp-name">{row.name}</span>
                    {(canToggle || canReconnect) && (
                      <span className="mcp-actions">
                        {canReconnect && (
                          <button
                            className="mcp-action-btn"
                            disabled={isBusy}
                            title={t('mcp.reconnect', 'Reconnect')}
                            onClick={() => handleReconnect(row.name)}
                          >↻</button>
                        )}
                        {canToggle && (
                          <button
                            className="mcp-action-btn"
                            disabled={isBusy}
                            title={isOff ? t('mcp.enable', 'Enable') : t('mcp.disable', 'Disable')}
                            onClick={() => handleToggle(row.name, row.source, isOff)}
                          >{isOff ? '○' : '◉'}</button>
                        )}
                      </span>
                    )}
                    <span className="mcp-meta">
                      {metaText}{row.error ? ` — ${row.error}` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="skills-empty">
            {rows.length === 0
              ? activeCwd
                ? t('mcp.noServers', 'No MCP servers configured')
                : t('mcp.noWorkspace', 'Open a workspace to see MCP servers')
              : t('mcp.noMatching', 'No matching MCP servers')}
          </div>
        )}

        {!activeSessionId && rows.length > 0 && (
          <div className="mcp-hint">{t('mcp.controlHint', 'Enable/disable persists across sessions. Live status & reconnect need an active session.')}</div>
        )}
      </div>
    </div>
  )
}
