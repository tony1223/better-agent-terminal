import { host } from '../host-api'
import { v4 as uuidv4 } from 'uuid'
import { useEffect, useCallback, useState, lazy, memo, Suspense, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workspace, TerminalInstance, EnvVariable, CreatePtyOptions } from '../types'
import { workspaceStore } from '../stores/workspace-store'
import { settingsStore } from '../stores/settings-store'
import { ThumbnailBar } from './ThumbnailBar'
import { CloseConfirmDialog } from './CloseConfirmDialog'
import { RemoteLoginDialog } from './RemoteLoginDialog'
import { ResizeHandle } from './ResizeHandle'
import { FolderPicker } from './FolderPicker'
import { NewTerminalQuickPick, type QuickPickChoice } from './NewTerminalQuickPick'
import { AgentPresetId, getAgentPreset, getVisiblePresets } from '../types/agent-presets'
import { isProcfileName } from '../utils/procfile-parser'
import { getHostUsageSnapshot, subscribeHostUsage, type HostUsageSnapshot } from '../utils/claude-usage-cache'

// Lazy load heavy components (xterm.js, Claude SDK, etc.)
const MainPanel = lazy(() => import('./MainPanel').then(m => ({ default: m.MainPanel })))
const FileTree = lazy(() => import('./FileTree').then(m => ({ default: m.FileTree })))
const GitPanel = lazy(() => import('./GitPanel').then(m => ({ default: m.GitPanel })))
const GitHubPanel = lazy(() => import('./GitHubPanel').then(m => ({ default: m.GitHubPanel })))

type WorkspaceTab = 'terminal' | 'files' | 'git' | 'github'
const TAB_KEY = 'better-terminal-workspace-tab'

type AccountMenuEntry = {
  id: string          // selector passed to the switch command
  label: string       // primary line (email)
  sublabel?: string   // secondary line (subscription tier / CODEX_HOME path)
  active?: boolean
  needsLogin?: boolean
  lastAuthError?: string
}

type WorkspaceAccountChip = {
  kind: 'claude' | 'codex'
  label: string
  title: string
  plan?: string       // active account's subscription tier (Claude only)
  accounts?: AccountMenuEntry[]
  loggedIn?: boolean
  unified?: boolean
}

type CodexAccountEntry = {
  id: string
  label?: string
  email?: string
  codexHome: string
  authenticated?: boolean
  active?: boolean
  unified?: boolean
  accountId?: string
  needsLogin?: boolean
  lastAuthError?: string
}

type ClaudeAccountEntry = {
  id: string
  email?: string
  subscriptionType?: string
  isDefault?: boolean
}

type CliVersions = { claude?: string; codex?: string }

function loadWorkspaceTab(): WorkspaceTab {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    if (saved === 'terminal' || saved === 'files' || saved === 'git' || saved === 'github') return saved
  } catch { /* ignore */ }
  return 'terminal'
}

// ThumbnailBar panel settings
const THUMBNAIL_SETTINGS_KEY = 'better-terminal-thumbnail-settings'
const LEGACY_DEFAULT_THUMBNAIL_HEIGHT = 180
const DEFAULT_THUMBNAIL_HEIGHT = 220
// Header + thumbnail header eats ~55px; below 180 the preview region is
// only a line or two tall and visibly clipped (#thumbnail-preview).
const MIN_THUMBNAIL_HEIGHT = 180
const MAX_THUMBNAIL_HEIGHT = 400

interface ThumbnailSettings {
  height: number
  collapsed: boolean
}

function loadThumbnailSettings(): ThumbnailSettings {
  try {
    const saved = localStorage.getItem(THUMBNAIL_SETTINGS_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as ThumbnailSettings
      const savedHeight = parsed.height ?? DEFAULT_THUMBNAIL_HEIGHT
      const migratedHeight = savedHeight <= LEGACY_DEFAULT_THUMBNAIL_HEIGHT
        ? DEFAULT_THUMBNAIL_HEIGHT
        : savedHeight
      const height = Math.min(MAX_THUMBNAIL_HEIGHT, Math.max(MIN_THUMBNAIL_HEIGHT, migratedHeight))
      return { ...parsed, height }
    }
  } catch (e) {
    console.error('Failed to load thumbnail settings:', e)
  }
  return { height: DEFAULT_THUMBNAIL_HEIGHT, collapsed: false }
}

function saveThumbnailSettings(settings: ThumbnailSettings): void {
  try {
    localStorage.setItem(THUMBNAIL_SETTINGS_KEY, JSON.stringify(settings))
  } catch (e) {
    console.error('Failed to save thumbnail settings:', e)
  }
}

interface WorkspaceViewProps {
  workspace: Workspace
  terminals: TerminalInstance[]
  focusedTerminalId: string | null
  isActive: boolean
  isRemoteConnected?: boolean
}

// Helper to get shell path from settings
async function getShellFromSettings(): Promise<string | undefined> {
  const settings = settingsStore.getSettings()
  if (settings.shell === 'custom' && settings.customShellPath) {
    return settings.customShellPath
  }
  return host.settings.getShellPath(settings.shell)
}

// Helper to merge environment variables
function mergeEnvVars(global: EnvVariable[] = [], workspace: EnvVariable[] = []): Record<string, string> {
  const result: Record<string, string> = {}
  // Add global vars first
  for (const env of global) {
    if (env.enabled && env.key) {
      result[env.key] = env.value
    }
  }
  // Workspace vars override global
  for (const env of workspace) {
    if (env.enabled && env.key) {
      result[env.key] = env.value
    }
  }
  return result
}

function buildAgentAutoCommand(presetId: string, settings: ReturnType<typeof settingsStore.getSettings>): string | null {
  if (presetId === 'codex-cli') {
    return settings.allowBypassPermissions
      ? 'codex --yolo'
      : 'codex'
  }
  const preset = getAgentPreset(presetId)
  return preset?.command || null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isPtyAlreadyExistsError(error: unknown): boolean {
  const message = errorMessage(error)
  return message.includes('pty session') && message.includes('already exists')
}

async function createWorkspacePty(options: CreatePtyOptions, context: string): Promise<boolean> {
  try {
    await host.pty.create(options)
    workspaceStore.setTerminalRuntimeError(options.id, undefined)
    return true
  } catch (error) {
    const message = errorMessage(error)
    if (isPtyAlreadyExistsError(error)) {
      if (host.debug.isDebugMode === true) {
        void host.debug.log(`[WorkspaceView] PTY already exists during ${context}; reusing existing session`)
      }
      workspaceStore.setTerminalRuntimeError(options.id, undefined)
      return false
    }
    workspaceStore.setTerminalRuntimeError(options.id, message)
    void host.debug.log(`[WorkspaceView] PTY create failed during ${context}: ${message}`)
    return false
  }
}

// Track which workspaces have been initialized (outside component to persist across renders)
const initializedWorkspaces = new Set<string>()

// Allow clearing on profile switch so terminals re-initialize
export function clearInitializedWorkspaces(): void {
  initializedWorkspaces.clear()
}

export const WorkspaceView = memo(function WorkspaceView({ workspace, terminals, focusedTerminalId, isActive, isRemoteConnected = false }: Readonly<WorkspaceViewProps>) {
  const { t, i18n } = useTranslation()
  const [showCloseConfirm, setShowCloseConfirm] = useState<string | null>(null)
  const [thumbnailSettings, setThumbnailSettings] = useState<ThumbnailSettings>(loadThumbnailSettings)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(loadWorkspaceTab)
  const [hasGithubRemote, setHasGithubRemote] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [detectedProcfiles, setDetectedProcfiles] = useState<string[]>([])
  const [showProcfilePicker, setShowProcfilePicker] = useState(false)
  const [showQuickPick, setShowQuickPick] = useState(false)
  const [accountChip, setAccountChip] = useState<WorkspaceAccountChip | null>(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  // Host-wide usage snapshot for the account dropdown — provider follows the
  // chip kind (claude vs codex). Fed by the Rust per-host poller; no polling
  // from this component.
  const [hostUsage, setHostUsage] = useState<HostUsageSnapshot | null>(null)
  const [, setUsageTick] = useState(0)
  useEffect(() => {
    const provider = accountChip?.kind === 'codex' ? 'codex' : 'claude'
    const apply = () => setHostUsage(getHostUsageSnapshot(provider))
    apply()
    return subscribeHostUsage(apply)
  }, [accountChip?.kind])
  // Keep the countdown text fresh while the menu is open.
  useEffect(() => {
    if (!accountMenuOpen) return
    const timer = window.setInterval(() => setUsageTick(n => n + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [accountMenuOpen])
  // Lazy usage peek for NON-active Claude accounts: queried only when the
  // menu opens (one request per account per open; the host caches briefly).
  // null = peeked but unavailable (expired token) — row just shows no usage.
  const [peekedUsage, setPeekedUsage] = useState<Record<string, Record<string, unknown> | null>>({})
  useEffect(() => {
    if (!accountMenuOpen || accountChip?.kind === 'codex') return
    const targets = (accountChip?.accounts || []).filter(account => !account.active && account.id)
    if (targets.length === 0) return
    let cancelled = false
    for (const account of targets) {
      void host.agent.peekUsage(account.id!).then((snap: Record<string, unknown> | null) => {
        if (cancelled) return
        setPeekedUsage(prev => ({
          ...prev,
          [account.id!]: (snap && typeof snap === 'object') ? snap : null,
        }))
      }).catch(() => {})
    }
    return () => { cancelled = true }
  }, [accountMenuOpen, accountChip])
  // Extract one window (pct + resetsAt ms) from either a HostUsageSnapshot
  // (resetsAt already ms) or a raw peek payload (resetsAt may be an ISO
  // string straight from the endpoint).
  const usageWindowOf = (
    snap: Record<string, unknown> | HostUsageSnapshot | null | undefined,
    key: 'fiveHour' | 'sevenDay',
  ): { pct: number; resetsAt: number | null } | null => {
    if (!snap) return null
    const window = (snap as Record<string, unknown>)[key]
    if (!window || typeof window !== 'object') return null
    const w = window as Record<string, unknown>
    if (typeof w.utilization !== 'number') return null
    let resetsAt: number | null = null
    if (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)) resetsAt = w.resetsAt
    else if (typeof w.resetsAt === 'string') {
      const parsed = Date.parse(w.resetsAt)
      if (Number.isFinite(parsed)) resetsAt = parsed
    }
    return { pct: Math.round(w.utilization * 100), resetsAt }
  }
  // Per-account usage lines rendered inside each menu row:
  //   5h 0%  ↻ in 4h 56m
  //   7d 19% ↻ in 2d 12h · Mon 10:59
  const renderAccountUsage = (snap: Record<string, unknown> | HostUsageSnapshot | null | undefined) => {
    const fiveHour = usageWindowOf(snap, 'fiveHour')
    const sevenDay = usageWindowOf(snap, 'sevenDay')
    if (!fiveHour && !sevenDay) return null
    return (
      <span className="workspace-account-menu-usage-lines">
        {fiveHour && (
          <span className="workspace-account-menu-usage-row" title={fiveHour.resetsAt ? new Date(fiveHour.resetsAt).toLocaleString() : undefined}>
            <span>5h</span>
            <span className="workspace-account-menu-usage-pct" style={{ color: usagePctColor(fiveHour.pct) }}>{fiveHour.pct}%</span>
            {fiveHour.resetsAt != null && <span>↻ {formatUsageRemaining(fiveHour.resetsAt - Date.now())}</span>}
          </span>
        )}
        {sevenDay && (
          <span className="workspace-account-menu-usage-row" title={sevenDay.resetsAt ? new Date(sevenDay.resetsAt).toLocaleString() : undefined}>
            <span>7d</span>
            <span className="workspace-account-menu-usage-pct" style={{ color: usagePctColor(sevenDay.pct) }}>{sevenDay.pct}%</span>
            {sevenDay.resetsAt != null && (
              <span>↻ {formatUsageRemaining(sevenDay.resetsAt - Date.now())} · {formatUsageResetAt(sevenDay.resetsAt)}</span>
            )}
          </span>
        )}
      </span>
    )
  }
  const formatUsageRemaining = (ms: number): string => {
    const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
    const days = Math.floor(totalMinutes / 1440)
    const hours = Math.floor((totalMinutes % 1440) / 60)
    const minutes = totalMinutes % 60
    if (days > 0) return t('workspace.usageRemainDays', { days, hours })
    if (hours > 0) return t('workspace.usageRemainHours', { hours, minutes })
    return t('workspace.usageRemainMinutes', { minutes })
  }
  const formatUsageResetAt = (resetsAt: number): string =>
    new Date(resetsAt).toLocaleString(i18n.language, {
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    })
  const usagePctColor = (pct: number): string =>
    pct >= 80 ? '#e05252' : pct >= 50 ? '#e6a700' : '#89ca78'
  const [cliVersions, setCliVersions] = useState<CliVersions | null>(null)
  const [loginPending, setLoginPending] = useState(false)
  // Non-null while the remote URL ("paste code") login dialog is open.
  const [remoteLoginKind, setRemoteLoginKind] = useState<'claude' | 'codex' | null>(null)
  const [accountMenuError, setAccountMenuError] = useState<string | null>(null)
  // Id of the account row currently being switched to, so the menu can show a
  // spinner immediately (the backend switch is fast, but the agent then respawns).
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const lastRenderSummaryRef = useRef<string>('')
  // Preset IDs the host knows how to start. `null` until fetched — fall back
  // to the local list so menus aren't empty during the brief load window.
  const [supportedPresetIds, setSupportedPresetIds] = useState<string[] | null>(null)

  // Fetch the host-supported preset list once. Refreshes on profile switch
  // because workspaces re-mount when the active profile changes.
  useEffect(() => {
    let cancelled = false
    const listSupportedSessionTypes = host.agent.getSupportedSessionTypes || host.agent.listPresets
    listSupportedSessionTypes()
      .then(ids => { if (!cancelled) setSupportedPresetIds(ids) })
      .catch(() => { if (!cancelled) setSupportedPresetIds(null) })
    return () => { cancelled = true }
  }, [])

  // Detect git repo, GitHub remote, and Procfiles
  useEffect(() => {
    host.git.getGithubUrl(workspace.folderPath).then(url => {
      setHasGithubRemote(!!url)
    }).catch(() => setHasGithubRemote(false))
    host.git.getRoot(workspace.folderPath).then(root => {
      setIsGitRepo(!!root)
    }).catch(() => setIsGitRepo(false))
    // Detect Procfiles in workspace folder
    host.fs.readdir(workspace.folderPath).then(entries => {
      const found = entries
        .filter(entry => !entry.isDirectory && isProcfileName(entry.name))
        .map(entry => entry.path)
        .sort((a, b) => a.localeCompare(b))
      setDetectedProcfiles(found)
    }).catch(() => setDetectedProcfiles([]))
  }, [workspace.folderPath])

  // Fallback if saved tab is 'github' but no GitHub remote
  useEffect(() => {
    if (activeTab === 'github' && !hasGithubRemote) {
      setActiveTab('terminal')
      try { localStorage.setItem(TAB_KEY, 'terminal') } catch { /* ignore */ }
    }
  }, [hasGithubRemote, activeTab])

  // Refresh worktree merged-status for the focused terminal when:
  //   - focus moves to a different terminal
  //   - the OS window regains focus (user comes back from the host repo)
  // The status call is cheap (just a few rev-parse/merge-base reads) and
  // the Rust side caches by sha so repeat calls without git activity are
  // free. We only call it when the workspace is active and the focused
  // terminal actually has a worktree.
  useEffect(() => {
    if (!isActive) return
    const terminal = terminals.find(t => t.id === focusedTerminalId)
    if (!terminal?.worktreePath) return

    let cancelled = false
    const refresh = () => {
      host.worktree.status(terminal.id)
        .then((res: unknown) => {
          if (cancelled) return
          const kind = (res as { mergedKind?: string } | null)?.mergedKind
          if (kind === 'ancestor' || kind === 'patch-equivalent' || kind === 'ahead' || kind === 'diverged' || kind === 'unknown') {
            workspaceStore.setTerminalWorktreeMergedKind(terminal.id, kind)
          }
        })
        .catch(() => { /* best-effort */ })
    }

    refresh()
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [isActive, focusedTerminalId, terminals])

  const handleTabChange = useCallback((tab: WorkspaceTab) => {
    setActiveTab(tab)
    try { localStorage.setItem(TAB_KEY, tab) } catch { /* ignore */ }
  }, [])

  // Listen for keyboard shortcut events to cycle/switch tabs
  useEffect(() => {
    if (!isActive) return

    const TABS: WorkspaceTab[] = hasGithubRemote ? ['terminal', 'files', 'git', 'github'] : ['terminal', 'files', 'git']

    const handleCycleTab = (e: Event) => {
      const { direction } = (e as CustomEvent).detail as { direction: number }
      setActiveTab(prev => {
        const idx = TABS.indexOf(prev)
        const next = TABS[(idx + direction + TABS.length) % TABS.length]
        try { localStorage.setItem(TAB_KEY, next) } catch { /* ignore */ }
        return next
      })
    }

    const handleSwitchTab = (e: Event) => {
      const { tab } = (e as CustomEvent).detail as { tab: WorkspaceTab }
      setActiveTab(tab)
      try { localStorage.setItem(TAB_KEY, tab) } catch { /* ignore */ }
    }

    window.addEventListener('workspace-cycle-tab', handleCycleTab)
    window.addEventListener('workspace-switch-tab', handleSwitchTab)
    return () => {
      window.removeEventListener('workspace-cycle-tab', handleCycleTab)
      window.removeEventListener('workspace-switch-tab', handleSwitchTab)
    }
  }, [isActive, hasGithubRemote])

  // Handle thumbnail bar resize
  const handleThumbnailResize = useCallback((delta: number) => {
    setThumbnailSettings(prev => {
      // Note: delta is negative when dragging up (making bar taller)
      const newHeight = Math.min(MAX_THUMBNAIL_HEIGHT, Math.max(MIN_THUMBNAIL_HEIGHT, prev.height - delta))
      const updated = { ...prev, height: newHeight }
      saveThumbnailSettings(updated)
      return updated
    })
  }, [])

  // Toggle thumbnail bar collapse
  const handleThumbnailCollapse = useCallback(() => {
    setThumbnailSettings(prev => {
      const updated = { ...prev, collapsed: !prev.collapsed }
      saveThumbnailSettings(updated)
      return updated
    })
    // Trigger resize so terminals/xterm can refit after layout change
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'))
    })
  }, [])

  // Reset thumbnail bar to default height
  const handleThumbnailResetHeight = useCallback(() => {
    setThumbnailSettings(prev => {
      const updated = { ...prev, height: DEFAULT_THUMBNAIL_HEIGHT }
      saveThumbnailSettings(updated)
      return updated
    })
  }, [])

  // Categorize terminals
  const agentTerminal = terminals.find(t => t.agentPreset && t.agentPreset !== 'none')
  const regularTerminals = terminals.filter(t => !t.agentPreset || t.agentPreset === 'none')
  const focusedTerminal = terminals.find(t => t.id === focusedTerminalId)
  const isAgentFocused = focusedTerminal?.agentPreset && focusedTerminal.agentPreset !== 'none'
  const accountTerminal = focusedTerminal || agentTerminal || null

  const refreshAccountChip = useCallback(async () => {
    const preset = accountTerminal?.agentPreset
    setAccountMenuError(null)
    if (host.debug.isDebugMode) {
      void host.debug.log(
        `[WorkspaceView] account chip resolve preset=${preset ?? 'none'} ` +
        `terminal=${accountTerminal?.id?.slice(0, 8) ?? 'none'} ` +
        `focused=${focusedTerminalId?.slice(0, 8) ?? 'none'}`,
      )
    }
    if (!preset) {
      setAccountChip(null)
      return
    }
    if (preset === 'codex-agent' || preset === 'codex-agent-worktree') {
      try {
        const result = await host.codex.accountList() as { accounts?: CodexAccountEntry[]; activeCodexHome?: string }
        // Only real, signed-in accounts count: drop entries with no resolvable
        // email (e.g. an empty ~/.codex home that would otherwise show as ".codex").
        const raw = (result.accounts || []).filter(account => Boolean(account.email && account.email.trim()))
        // In unified mode every account shares one runtime CODEX_HOME, so a
        // `codexHome === activeCodexHome` check would mark EVERY entry active and
        // make clicking a no-op (handleAccountSwitch early-returns on active rows).
        // Trust the backend per-account `active` flag; only use the codexHome
        // fallback for the legacy (non-unified) model where homes are distinct.
        const active = raw.find(account => account.active)
          || raw.find(account => !account.unified && account.codexHome === result.activeCodexHome)
        const entries: AccountMenuEntry[] = raw.map(account => ({
          id: account.id,
          label: account.email || account.label || account.codexHome,
          sublabel: account.needsLogin
            ? 'Needs login'
            : account.unified ? undefined : account.codexHome,
          active: Boolean(account.active) || (!account.unified && account.codexHome === result.activeCodexHome),
          needsLogin: Boolean(account.needsLogin),
          lastAuthError: account.lastAuthError,
        }))
        setAccountChip({
          kind: 'codex',
          label: active?.email || active?.label || 'Codex',
          title: active?.unified
            ? 'Codex account'
            : active?.codexHome ? `CODEX_HOME: ${active.codexHome}` : 'Codex account',
          accounts: entries,
          loggedIn: Boolean(active?.authenticated ?? entries.length > 0),
          unified: Boolean(active?.unified || raw.some(a => a.unified)),
        })
      } catch (error) {
        void host.debug.log(`[WorkspaceView] failed to load Codex account info: ${errorMessage(error)}`)
        setAccountChip({ kind: 'codex', label: 'Codex', title: 'Codex account' })
      }
      return
    }
    if (preset === 'claude-code' || preset === 'claude-code-v2' || preset === 'claude-code-worktree' || preset === 'claude-channel' || preset === 'claude-cli-agent') {
      try {
        const [info, list] = await Promise.all([
          (host.claude.getAccountInfo(accountTerminal.id) as Promise<{ email?: string; organization?: string; subscriptionType?: string } | null>).catch(() => null),
          (host.claude.accountList() as Promise<{ accounts?: ClaudeAccountEntry[]; activeAccountId?: string } | null>).catch(() => null),
        ])
        const accounts = list?.accounts || []
        const activeId = list?.activeAccountId
        const entries: AccountMenuEntry[] = accounts.map(account => ({
          id: account.id,
          label: account.email || account.id,
          sublabel: account.subscriptionType || undefined,
          active: account.id === activeId,
        }))
        const activeAccount = accounts.find(account => account.id === activeId)
        const activeEmail = activeAccount?.email
        const label = info?.email || activeEmail || info?.organization || 'Claude'
        const plan = info?.subscriptionType || activeAccount?.subscriptionType || undefined
        setAccountChip({
          kind: 'claude',
          label,
          title: info?.email ? `${info.email} (${info.subscriptionType || 'unknown'})` : 'Claude account',
          plan,
          accounts: entries,
          loggedIn: Boolean(info?.email || activeEmail || entries.length > 0),
        })
      } catch (error) {
        void host.debug.log(`[WorkspaceView] failed to load Claude account info: ${errorMessage(error)}`)
        setAccountChip({ kind: 'claude', label: 'Claude', title: 'Claude account' })
      }
      return
    }
    setAccountChip(null)
  }, [accountTerminal?.id, accountTerminal?.agentPreset, focusedTerminalId])

  useEffect(() => {
    if (!isActive) return
    void refreshAccountChip()
    const refresh = () => { void refreshAccountChip() }
    window.addEventListener('claude-account-switched', refresh)
    window.addEventListener('codex-account-switched', refresh)
    return () => {
      window.removeEventListener('claude-account-switched', refresh)
      window.removeEventListener('codex-account-switched', refresh)
    }
  }, [isActive, refreshAccountChip])

  const loadCliVersions = useCallback(async () => {
    try {
      const status = await host.runtime.getStatus() as {
        claude?: { version?: string | null }
        codex?: { version?: string | null }
      }
      setCliVersions({
        claude: status?.claude?.version || undefined,
        codex: status?.codex?.version || undefined,
      })
    } catch (error) {
      void host.debug.log(`[WorkspaceView] failed to load CLI versions: ${errorMessage(error)}`)
      setCliVersions({})
    }
  }, [])

  // Load CLI versions once a Claude/Codex chip is shown so the version can be
  // displayed inline (always visible, not only inside the dropdown).
  useEffect(() => {
    if (accountChip && !cliVersions) void loadCliVersions()
  }, [accountChip, cliVersions, loadCliVersions])

  // Start a login flow from the chip. Claude has a real CLI login; for Codex
  // (unified mode) we register the account currently authenticated in ~/.codex.
  const handleLogin = useCallback(async (kind: 'claude' | 'codex') => {
    // Remote client: the CLI login runs on the host, surfaced through a sign-in
    // dialog. Claude uses a URL ("paste code") flow; codex uses a device-code
    // flow (display URL + one-time code, poll for approval). Both authenticate
    // the host with no browser on the host.
    if (isRemoteConnected) {
      setAccountMenuOpen(false)
      setRemoteLoginKind(kind)
      return
    }
    if (loginPending) return
    // Keep the menu open and show a pending state — the CLI takes a few seconds
    // to spin up before the browser opens, so give the user a transition cue.
    setAccountMenuOpen(true)
    setAccountMenuError(null)
    setLoginPending(true)
    let loginError: string | null = null
    try {
      if (kind === 'claude') {
        const result = await host.claude.authLogin() as { success?: boolean; error?: string }
        if (result?.success) {
          try { await host.claude.accountImportCurrent() } catch { /* ignore if unavailable */ }
        }
        window.dispatchEvent(new CustomEvent('claude-account-switched', { detail: {} }))
      } else {
        // Real Codex login (ChatGPT browser OAuth); registers + activates it.
        await host.codex.accountLogin()
        window.dispatchEvent(new CustomEvent('codex-account-switched', { detail: {} }))
      }
    } catch (error) {
      loginError = errorMessage(error)
      void host.debug.log(`[WorkspaceView] ${kind} login failed: ${loginError}`)
    }
    setLoginPending(false)
    await refreshAccountChip()
    if (loginError) {
      setAccountMenuError(loginError)
      setAccountMenuOpen(true)
    } else {
      setAccountMenuOpen(false)
    }
  }, [refreshAccountChip, isRemoteConnected, loginPending])

  // Cancel an in-flight Codex login (the browser OAuth hasn't completed yet).
  // The backend kills the pending `codex login` child, which makes the awaited
  // accountLogin() in handleLogin reject and reset loginPending.
  const handleLoginCancel = useCallback(async (kind: 'claude' | 'codex') => {
    if (kind !== 'codex') return
    try {
      await host.codex.accountLoginCancel()
    } catch (error) {
      void host.debug.log(`[WorkspaceView] codex login cancel failed: ${errorMessage(error)}`)
    }
  }, [])

  // Switch Claude/Codex account directly from the chip menu. The id is the
  // correct selector for both agents and both Codex modes (legacy id == path).
  const handleAccountSwitch = useCallback(async (entry: AccountMenuEntry, kind: 'claude' | 'codex') => {
    if (entry.active || !entry.id || switchingId) {
      if (!entry.active) setAccountMenuOpen(false)
      return
    }
    if (entry.needsLogin) {
      setAccountMenuError(`${entry.label} needs login before it can be used again.`)
      setAccountMenuOpen(true)
      return
    }
    // Show an immediate spinner on the clicked row — the backend switch itself is
    // quick, but the agent then respawns with the new auth, so without this
    // the menu just sits on the old state and the switch feels unresponsive.
    setSwitchingId(entry.id)
    setAccountMenuError(null)
    try {
      if (kind === 'codex') {
        const result = await host.codex.accountSwitch(entry.id) as { success?: boolean }
        if (result?.success === false) { setSwitchingId(null); return }
        window.dispatchEvent(new CustomEvent('codex-account-switched', { detail: { accountId: entry.id } }))
      } else {
        const ok = await host.claude.accountSwitch(entry.id) as boolean
        if (ok === false) { setSwitchingId(null); return }
        window.dispatchEvent(new CustomEvent('claude-account-switched', { detail: { accountId: entry.id } }))
      }
    } catch (error) {
      // Surfaces e.g. the unified-mode "turn is running" denial.
      await refreshAccountChip()
      const message = errorMessage(error)
      void host.debug.log(`[WorkspaceView] ${kind} account switch failed: ${message}`)
      setAccountMenuError(message)
      setAccountMenuOpen(true)
      setSwitchingId(null)
      return
    }
    // refreshAccountChip re-reads the updated active account and closes
    // the menu; the agent respawn it triggered keeps running in the background.
    await refreshAccountChip()
    setSwitchingId(null)
    setAccountMenuOpen(false)
  }, [refreshAccountChip, switchingId])

  // Initialize terminals when workspace becomes active
  // If terminals were restored from a saved profile, start their PTY/agent processes
  // If no terminals exist, create default ones from settings
  useEffect(() => {
    if (!isActive || initializedWorkspaces.has(workspace.id)) return
    initializedWorkspaces.add(workspace.id)

    const initTerminals = async () => {
      const dlog = (...args: unknown[]) => host.debug.log(...args)
      const htmlT0 = (window as unknown as { __t0?: number }).__t0 || Date.now()
      dlog(`[startup] initTerminals start: +${Date.now() - htmlT0}ms from HTML`)
      const t0 = performance.now()
      const settings = settingsStore.getSettings()
      const shell = await getShellFromSettings()
      dlog(`[init] getShellFromSettings: ${(performance.now() - t0).toFixed(0)}ms`)
      const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)

      if (terminals.length > 0) {
        // Restored terminals: start PTY processes for non-Claude terminals
        // Claude agent terminals will be started by ClaudeAgentPanel on mount
        for (const terminal of terminals) {
          // Worker terminals manage their own PTYs internally via WorkerPanel
          if (terminal.procfilePath) continue
          if (terminal.agentPreset === 'claude-code' || terminal.agentPreset === 'claude-channel' || terminal.agentPreset === 'claude-cli-agent' || terminal.agentPreset === 'claude-code-v2' || terminal.agentPreset === 'claude-code-worktree' || terminal.agentPreset === 'codex-agent' || terminal.agentPreset === 'codex-agent-worktree') continue
          // Claude CLI presets are started by ClaudeCliPanel so it can own session restore.
          if (terminal.agentPreset === 'claude-cli' || terminal.agentPreset === 'claude-cli-worktree') continue
          const created = await createWorkspacePty({
            id: terminal.id,
            cwd: terminal.cwd || workspace.folderPath,
            type: 'terminal',
            agentPreset: terminal.agentPreset,
            shell,
            customEnv,
            perTerminalHistory: settings.perTerminalHistory,
            historyKey: terminal.historyKey,
          }, `restore terminal ${terminal.id}`)
          // Auto-run agent command for non-Claude agents
          if (created && terminal.agentPreset && terminal.agentPreset !== 'none' && settings.agentAutoCommand) {
            const command = buildAgentAutoCommand(terminal.agentPreset, settings)
            if (command) {
              setTimeout(() => {
                host.pty.write(terminal.id, command + '\r')
              }, 500)
            }
          }
        }
      } else {
        // No terminals: create defaults from settings
        const terminalCount = settings.defaultTerminalCount || 1
        const createAgentTerminal = settings.createDefaultAgentTerminal === true
        const defaultAgent = createAgentTerminal
          ? (workspace.defaultAgent || settings.defaultAgent || 'claude-code')
          : 'none'

        if (createAgentTerminal) {
          // Worktree agents: build the worktree folder in Rust first, then add
          // the terminal already pointing at it, so the SDK session starts
          // through the normal path with cwd = worktree folder.
          let agentTerminal: TerminalInstance
          if (defaultAgent === 'claude-code-worktree' || defaultAgent === 'codex-agent-worktree') {
            const id = uuidv4()
            const wtResult = await host.worktree.create(id, workspace.folderPath, settings.worktreePnpmInstallEnabled === true)
            if (wtResult.success && wtResult.worktreePath) {
              agentTerminal = workspaceStore.addTerminal(workspace.id, defaultAgent as AgentPresetId, {
                id,
                cwd: wtResult.worktreePath,
                worktreePath: wtResult.worktreePath,
                worktreeBranch: wtResult.branchName,
              })
              workspaceStore.setTerminalGeneratedTitle(agentTerminal.id, defaultAgent === 'codex-agent-worktree' ? 'Codex Agent (worktree)' : 'Claude Agent (worktree)')
            } else {
              // Worktree creation failed — fall back to a normal agent terminal.
              agentTerminal = workspaceStore.addTerminal(workspace.id, defaultAgent as AgentPresetId, { id })
            }
          } else {
            agentTerminal = workspaceStore.addTerminal(workspace.id, defaultAgent as AgentPresetId)
          }
          if (defaultAgent !== 'claude-cli' && defaultAgent !== 'claude-cli-worktree' && defaultAgent !== 'claude-cli-agent' && defaultAgent !== 'claude-code' && defaultAgent !== 'claude-channel' && defaultAgent !== 'claude-code-v2' && defaultAgent !== 'claude-code-worktree' && defaultAgent !== 'codex-agent' && defaultAgent !== 'codex-agent-worktree') {
            const created = await createWorkspacePty({
              id: agentTerminal.id,
              cwd: workspace.folderPath,
              type: 'terminal',
              agentPreset: defaultAgent as AgentPresetId,
              shell,
              customEnv,
              perTerminalHistory: settings.perTerminalHistory,
              historyKey: agentTerminal.historyKey,
            }, `create default agent terminal ${agentTerminal.id}`)
            if (created && settings.agentAutoCommand) {
              const command = buildAgentAutoCommand(defaultAgent, settings)
              if (command) {
                setTimeout(() => {
                  host.pty.write(agentTerminal.id, command + '\r')
                }, 500)
              }
            }
          }
        }

        for (let i = 0; i < terminalCount; i++) {
          const terminal = workspaceStore.addTerminal(workspace.id)
          await createWorkspacePty({
            id: terminal.id,
            cwd: workspace.folderPath,
            type: 'terminal',
            shell,
            customEnv,
            perTerminalHistory: settings.perTerminalHistory,
            historyKey: terminal.historyKey,
          }, `create default terminal ${terminal.id}`)
        }
        // Persist newly created default terminals
        workspaceStore.save()
      }
      dlog(`[init] initTerminals total: ${(performance.now() - t0).toFixed(0)}ms, terminals=${terminals.length}`)
      dlog(`[startup] initTerminals done: +${Date.now() - htmlT0}ms from HTML`)
    }
    void initTerminals().catch(error => {
      initializedWorkspaces.delete(workspace.id)
      void host.debug.log(`[WorkspaceView] initTerminals failed workspace=${workspace.id}: ${errorMessage(error)}`)
    })
  }, [isActive, workspace.id, terminals.length, workspace.defaultAgent, workspace.folderPath, workspace.envVars])

  // Set default focus - only for active workspace
  useEffect(() => {
    if (isActive && !focusedTerminalId && terminals.length > 0) {
      // Focus the first terminal (agent or regular)
      const firstTerminal = agentTerminal || terminals[0]
      if (firstTerminal) {
        workspaceStore.setFocusedTerminal(firstTerminal.id)
      }
    }
  }, [isActive, focusedTerminalId, terminals, agentTerminal])

  const handleAddTerminal = useCallback(async () => {
    const terminal = workspaceStore.addTerminal(workspace.id)
    const shell = await getShellFromSettings()
    const settings = settingsStore.getSettings()
    const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)
    await createWorkspacePty({
      id: terminal.id,
      cwd: workspace.folderPath,
      type: 'terminal',
      shell,
      customEnv,
      perTerminalHistory: settings.perTerminalHistory,
      historyKey: terminal.historyKey,
    }, `add terminal ${terminal.id}`)
    // Focus the new terminal
    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
  }, [workspace.id, workspace.folderPath, workspace.envVars])

  const handleAddWorktreeTerminal = useCallback(async () => {
    const terminal = workspaceStore.addTerminal(workspace.id)
    const settings = settingsStore.getSettings()
    const wtResult = await host.worktree.create(terminal.id, workspace.folderPath, settings.worktreePnpmInstallEnabled === true)

    if (!wtResult.success || !wtResult.worktreePath) {
      workspaceStore.removeTerminal(terminal.id)
      workspaceStore.save()
      alert(wtResult.error || 'Failed to create worktree terminal.')
      return
    }

    const shell = await getShellFromSettings()
    const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)

    workspaceStore.updateTerminalCwd(terminal.id, wtResult.worktreePath)
    workspaceStore.setTerminalWorktreeInfo(terminal.id, wtResult.worktreePath, wtResult.branchName)
    workspaceStore.setTerminalGeneratedTitle(terminal.id, 'Terminal (worktree)')

    await createWorkspacePty({
      id: terminal.id,
      cwd: wtResult.worktreePath,
      type: 'terminal',
      shell,
      customEnv,
      perTerminalHistory: settings.perTerminalHistory,
      historyKey: terminal.historyKey,
    }, `add worktree terminal ${terminal.id}`)

    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
  }, [workspace.id, workspace.folderPath, workspace.envVars])

  const handleAddAgent = useCallback(async (presetId: string) => {
    const preset = getAgentPreset(presetId)
    if (!preset) return

    if (preset.backend === 'sdk' || preset.backend === 'channel') {
      if (presetId === 'claude-code-worktree' || presetId === 'codex-agent-worktree') {
        // Build the worktree folder first, then add the terminal already
        // pointing at it — the SDK session starts normally in the worktree.
        const settings = settingsStore.getSettings()
        const id = uuidv4()
        const wtResult = await host.worktree.create(id, workspace.folderPath, settings.worktreePnpmInstallEnabled === true)
        if (!wtResult.success || !wtResult.worktreePath) {
          workspaceStore.save()
          alert(wtResult.error || `Failed to create ${preset.name} worktree.`)
          return
        }
        const terminal = workspaceStore.addTerminal(workspace.id, presetId as AgentPresetId, {
          id,
          cwd: wtResult.worktreePath,
          worktreePath: wtResult.worktreePath,
          worktreeBranch: wtResult.branchName,
        })
        workspaceStore.setTerminalGeneratedTitle(terminal.id, presetId === 'codex-agent-worktree' ? 'Codex Agent (worktree)' : 'Claude Agent (worktree)')
        workspaceStore.setFocusedTerminal(terminal.id)
        workspaceStore.save()
      } else {
        const terminal = workspaceStore.addTerminal(workspace.id, presetId as AgentPresetId)
        workspaceStore.setFocusedTerminal(terminal.id)
        workspaceStore.save()
      }
    } else if (preset.backend === 'cli') {
      const terminal = workspaceStore.addTerminal(workspace.id, presetId as AgentPresetId)
      workspaceStore.setFocusedTerminal(terminal.id)
      workspaceStore.save()
    } else {
      // pty: generic PTY with auto-run command
      const terminal = workspaceStore.addTerminal(workspace.id, presetId as AgentPresetId)
      const shell = await getShellFromSettings()
      const settings = settingsStore.getSettings()
      const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)
      const created = await createWorkspacePty({
        id: terminal.id,
        cwd: workspace.folderPath,
        type: 'terminal',
        agentPreset: presetId as AgentPresetId,
        shell,
        customEnv,
        perTerminalHistory: settings.perTerminalHistory,
        historyKey: terminal.historyKey,
      }, `add agent terminal ${terminal.id}`)
      const command = buildAgentAutoCommand(presetId, settings)
      if (created && command && settings.agentAutoCommand) {
        setTimeout(() => {
          host.pty.write(terminal.id, command + '\r')
        }, 500)
      }
      workspaceStore.setFocusedTerminal(terminal.id)
      workspaceStore.save()
    }
  }, [workspace.id, workspace.folderPath, workspace.envVars])

  const handleAddWorker = useCallback(async (selectedPath?: string) => {
    let procfilePath = selectedPath
    // If no path provided, open the remote-aware file picker
    if (!procfilePath) {
      setShowProcfilePicker(true)
      return
    }

    const terminal = workspaceStore.addTerminal(workspace.id)
    workspaceStore.setTerminalProcfile(terminal.id, procfilePath)
    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
  }, [workspace.id])

  const handleProcfilePickerSelect = useCallback((paths: string[]) => {
    const procfilePath = paths[0]
    if (!procfilePath) return
    const terminal = workspaceStore.addTerminal(workspace.id)
    workspaceStore.setTerminalProcfile(terminal.id, procfilePath)
    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
    setShowProcfilePicker(false)
  }, [workspace.id])

  const handleQuickPickSelect = useCallback((choice: QuickPickChoice) => {
    if (choice.kind === 'terminal') {
      void handleAddTerminal()
    } else if (choice.kind === 'worktree') {
      void handleAddWorktreeTerminal()
    } else {
      void handleAddAgent(choice.presetId)
    }
  }, [handleAddTerminal, handleAddWorktreeTerminal, handleAddAgent])

  const isDebugMode = host.debug.isDebugMode

  const handleCloseTerminal = useCallback((id: string) => {
    const terminal = terminals.find(t => t.id === id)
    // Worker terminals: sub-PTYs are cleaned up by WorkerPanel unmount
    if (terminal?.procfilePath) {
      workspaceStore.removeTerminal(id)
      workspaceStore.save()
      return
    }
    // Show confirm for agent terminals and worktree-backed terminals
    if ((terminal?.agentPreset && terminal.agentPreset !== 'none') || terminal?.worktreePath) {
      setShowCloseConfirm(id)
    } else {
      // Regular terminals always use PTY
      host.pty.kill(id)
      workspaceStore.removeTerminal(id)
      workspaceStore.save()
    }
  }, [terminals])

  // Keyboard shortcut bridges: Cmd+T / Ctrl+Shift+T opens the quick-pick;
  // Cmd+Shift+W / Ctrl+Shift+W closes the focused terminal. App.tsx dispatches
  // the events; only the active workspace responds.
  useEffect(() => {
    if (!isActive) return
    const handleQuickPickEvent = () => setShowQuickPick(true)
    const handleCloseEvent = (e: Event) => {
      const { terminalId } = (e as CustomEvent).detail as { terminalId: string }
      if (terminalId) handleCloseTerminal(terminalId)
    }
    window.addEventListener('workspace-add-terminal-quick-pick', handleQuickPickEvent)
    window.addEventListener('workspace-close-terminal', handleCloseEvent as EventListener)
    return () => {
      window.removeEventListener('workspace-add-terminal-quick-pick', handleQuickPickEvent)
      window.removeEventListener('workspace-close-terminal', handleCloseEvent as EventListener)
    }
  }, [isActive, handleCloseTerminal])

  const handleConfirmClose = useCallback((cleanWorktree = false) => {
    if (showCloseConfirm) {
      const terminal = terminals.find(t => t.id === showCloseConfirm)
      if (terminal?.agentPreset === 'claude-code' || terminal?.agentPreset === 'claude-code-v2' || terminal?.agentPreset === 'claude-code-worktree' || terminal?.agentPreset === 'codex-agent' || terminal?.agentPreset === 'codex-agent-worktree') {
        host.claude.stopSession(showCloseConfirm)
        if (cleanWorktree && terminal?.agentPreset === 'claude-code-worktree') {
          host.claude.cleanupWorktree(showCloseConfirm, true)
        } else if (cleanWorktree && terminal?.agentPreset === 'codex-agent-worktree') {
          host.worktree.remove(showCloseConfirm, true)
        }
      } else {
        host.pty.kill(showCloseConfirm)
        // Clean up worktree for PTY-based worktree terminals
        if (cleanWorktree && terminal?.worktreePath) {
          host.worktree.remove(showCloseConfirm, true)
        }
      }
      workspaceStore.removeTerminal(showCloseConfirm)
      workspaceStore.save()
      setShowCloseConfirm(null)
    }
  }, [showCloseConfirm, terminals])

  const handleRestart = useCallback(async (id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (!terminal) return
    workspaceStore.setTerminalRuntimeError(id, undefined)
    try {
      if (terminal.agentPreset === 'claude-code' || terminal.agentPreset === 'claude-code-v2' || terminal.agentPreset === 'claude-code-worktree' || terminal.agentPreset === 'codex-agent' || terminal.agentPreset === 'codex-agent-worktree') {
        // Stop and restart Claude session
        await host.claude.stopSession(id)
        await host.claude.startSession(id, {
          cwd: terminal.cwd,
          agentPreset: terminal.agentPreset,
          ...(terminal.agentPreset === 'claude-code-worktree' || terminal.agentPreset === 'codex-agent-worktree' ? { useWorktree: true, worktreePath: terminal.worktreePath, worktreeBranch: terminal.worktreeBranch } : {}),
        })
      } else if (terminal.agentPreset === 'claude-cli' || terminal.agentPreset === 'claude-cli-worktree' || terminal.agentPreset === 'claude-cli-agent') {
        await host.pty.kill(id)
        workspaceStore.bumpTerminalClaudeCliRestart(id)
      } else {
        const cwd = await host.pty.getCwd(id) || terminal.cwd
        const shell = await getShellFromSettings()
        // pty_restart returns false when no live session exists for `id`,
        // which is exactly the state the user lands in after the startup
        // restore failure. Fall back to a clean create so Restart actually
        // brings the terminal back instead of silently no-oping.
        const restarted = await host.pty.restart(id, cwd, shell)
        if (!restarted) {
          const settings = settingsStore.getSettings()
          const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)
          await createWorkspacePty({
            id,
            cwd,
            type: 'terminal',
            agentPreset: terminal.agentPreset,
            shell,
            customEnv,
            perTerminalHistory: settings.perTerminalHistory,
            historyKey: terminal.historyKey,
          }, 'manual-restart')
        }
        workspaceStore.updateTerminalCwd(id, cwd)
      }
    } catch (error) {
      workspaceStore.setTerminalRuntimeError(id, errorMessage(error))
    }
  }, [terminals])

  const handleSwitchApiVersion = useCallback(async (id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (!terminal || (terminal.agentPreset !== 'claude-code' && terminal.agentPreset !== 'claude-code-v2')) return
    // Stop current session
    await host.claude.stopSession(id)
    // Switch agentPreset in store
    const newPreset = workspaceStore.switchTerminalApiVersion(id)
    if (!newPreset) return
    const newApiVersion = newPreset === 'claude-code-v2' ? 'v2' as const : 'v1' as const
    // Resume with the same sdkSessionId but new API version
    const sdkSessionId = terminal.sdkSessionId
    if (sdkSessionId) {
      await host.claude.resumeSession(id, sdkSessionId, terminal.cwd, terminal.model, newApiVersion, undefined, undefined, undefined, newPreset)
    } else {
      await host.claude.startSession(id, { cwd: terminal.cwd, apiVersion: newApiVersion })
    }
    workspaceStore.save()
  }, [terminals])

  const handleFocus = useCallback((id: string) => {
    workspaceStore.setFocusedTerminal(id)
    // Switch back to terminal tab when clicking a terminal thumbnail
    if (activeTab !== 'terminal') {
      handleTabChange('terminal')
    }
  }, [activeTab, handleTabChange])

  const handleReorderTerminals = useCallback((orderedIds: string[]) => {
    workspaceStore.reorderTerminals(orderedIds)
  }, [])

  // Determine what to show
  // mainTerminal: the currently focused or first available terminal
  const mainTerminal = focusedTerminal || agentTerminal || terminals[0]

  useEffect(() => {
    if (host.debug.isDebugMode !== true) return
    const summary = [
      `workspace=${workspace.id}`,
      `active=${isActive ? 'yes' : 'no'}`,
      `tab=${activeTab}`,
      `focused=${focusedTerminalId || 'none'}`,
      `main=${mainTerminal ? `${mainTerminal.id.slice(0, 8)}:${mainTerminal.title || mainTerminal.agentPreset || 'terminal'}` : 'none'}`,
      `terminals=[${terminals.map(term => `${term.id.slice(0, 8)}:${term.title || term.agentPreset || 'terminal'}`).join(',')}]`,
    ].join(' ')
    if (summary === lastRenderSummaryRef.current) return
    lastRenderSummaryRef.current = summary
    void host.debug.log(`[WorkspaceView] render ${summary}`)
  }, [workspace.id, isActive, activeTab, focusedTerminalId, mainTerminal, terminals])

  // Send content to the active Claude agent session
  const handleSendToClaude = useCallback(async (content: string) => {
    if (!agentTerminal) return false
    if (agentTerminal.agentPreset === 'claude-channel') {
      await host.claudeChannel.sendMessage(agentTerminal.id, content)
    } else {
      await host.claude.sendMessage(agentTerminal.id, content)
    }
    handleTabChange('terminal')
    workspaceStore.setFocusedTerminal(agentTerminal.id)
    return true
  }, [agentTerminal, handleTabChange])

  // Show all terminals in thumbnail bar (clicking switches focus)
  const thumbnailTerminals = terminals

  return (
    <div className="workspace-view">
      {/* Top tab bar: Terminal | Files | Git | GitHub */}
      <div className="workspace-tab-bar">
        <button
          className={`workspace-tab-btn ${activeTab === 'terminal' ? 'active' : ''}`}
          onClick={() => handleTabChange('terminal')}
        >
          {t('workspace.terminal')}
        </button>
        <button
          className={`workspace-tab-btn ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => handleTabChange('files')}
        >
          {t('workspace.files')}
        </button>
        <button
          className={`workspace-tab-btn ${activeTab === 'git' ? 'active' : ''}`}
          onClick={() => handleTabChange('git')}
        >
          {t('workspace.git')}
        </button>
        {hasGithubRemote && (
          <button
            className={`workspace-tab-btn ${activeTab === 'github' ? 'active' : ''}`}
            onClick={() => handleTabChange('github')}
          >
            {t('workspace.github')}
          </button>
        )}
        <div className="workspace-tab-spacer" />
        {accountChip && (
          <div className="workspace-account-chip-wrap">
            <button
              className={`workspace-account-chip workspace-account-chip-${accountChip.kind}`}
              title={accountChip.title}
              onClick={() => {
                // Not logged in → go straight to login (both Claude and Codex
                // have real CLI login flows). In remote mode, open the menu so
                // the "log in from a terminal" hint is shown instead.
                if (!accountChip.loggedIn && !isRemoteConnected) {
                  void handleLogin(accountChip.kind)
                  return
                }
                setAccountMenuOpen(open => {
                  const next = !open
                  if (next && !cliVersions) void loadCliVersions()
                  return next
                })
              }}
            >
              <span className="workspace-account-kind">{accountChip.kind}</span>
              {(() => {
                if (!accountChip.loggedIn) return null
                const raw = accountChip.kind === 'claude' ? cliVersions?.claude : cliVersions?.codex
                if (!raw) return null
                const short = raw.match(/\d+\.\d+\.\d+/)?.[0] || raw
                return <span className="workspace-account-version">v{short}</span>
              })()}
              <span className="workspace-account-label">
                {accountChip.loggedIn ? accountChip.label : t('workspace.accountLogin')}
              </span>
              {accountChip.loggedIn && accountChip.plan && (
                <span className="workspace-account-plan">{accountChip.plan}</span>
              )}
            </button>
            {accountMenuOpen && (
              <div className="workspace-account-menu">
                {accountMenuError && (
                  <div className="workspace-account-menu-error">
                    {accountMenuError}
                  </div>
                )}
                {/* Single-account setups never populated the multi-account
                    index; still show the active account so the menu isn't
                    just "Add account…" with no context. */}
                {(accountChip.accounts || []).length === 0 && accountChip.loggedIn && (
                  <div className="workspace-account-menu-item active" style={{ cursor: 'default' }}>
                    <span className="workspace-account-menu-item-main">
                      <span className="workspace-account-menu-label">{accountChip.label}</span>
                    </span>
                    {accountChip.plan && (
                      <span className="workspace-account-menu-path">{accountChip.plan}</span>
                    )}
                    {renderAccountUsage(hostUsage)}
                  </div>
                )}
                {(accountChip.accounts || []).map(account => (
                  <button
                    key={account.id || account.label}
                    className={`workspace-account-menu-item${account.active ? ' active' : ''}${account.needsLogin ? ' needs-login' : ''}${switchingId === account.id ? ' switching' : ''}`}
                    onClick={() => { void handleAccountSwitch(account, accountChip.kind) }}
                    title={account.lastAuthError || account.sublabel || account.label}
                    disabled={Boolean(switchingId)}
                  >
                    <span className="workspace-account-menu-item-main">
                      <span className="workspace-account-menu-label">{account.label}</span>
                      {account.needsLogin && <span className="workspace-account-menu-badge">Login required</span>}
                      {switchingId === account.id && <span className="workspace-account-spinner" />}
                    </span>
                    {account.sublabel && (
                      <span className="workspace-account-menu-path">{account.sublabel}</span>
                    )}
                    {account.active
                      ? renderAccountUsage(hostUsage)
                      : (account.id ? renderAccountUsage(peekedUsage[account.id]) : null)}
                  </button>
                ))}
                {loginPending ? (
                  <div className="workspace-account-menu-pending">
                    <span className="workspace-account-spinner" />
                    <span className="workspace-account-menu-pending-label">{t('workspace.accountLoggingIn')}</span>
                    {accountChip.kind === 'codex' && (
                      <button
                        type="button"
                        className="workspace-account-menu-cancel"
                        onClick={() => { void handleLoginCancel(accountChip.kind) }}
                      >
                        {t('workspace.accountCancelLogin')}
                      </button>
                    )}
                  </div>
                ) : isRemoteConnected ? (
                  <div className="workspace-account-menu-hint">
                    {t('workspace.accountRemoteLoginHint')}
                  </div>
                ) : (
                  <button
                    className="workspace-account-menu-item workspace-account-menu-action"
                    onClick={() => { void handleLogin(accountChip.kind) }}
                  >
                    <span className="workspace-account-menu-label">
                      {accountChip.loggedIn ? t('workspace.accountAdd') : t('workspace.accountLogin')}
                    </span>
                  </button>
                )}
                <div className="workspace-account-menu-versions">
                  <span>Claude Code: {cliVersions ? (cliVersions.claude || '—') : '…'}</span>
                  <span>Codex: {cliVersions ? (cliVersions.codex || '—') : '…'}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main content area - terminals always rendered (keep processes alive) */}
      <Suspense fallback={<div className="loading-panel" />}>
        <div className={`terminals-container ${activeTab !== 'terminal' ? 'hidden' : ''}`}>
          {terminals.map(terminal => (
            <div
              key={terminal.id}
              className={`terminal-wrapper ${terminal.id === mainTerminal?.id ? 'active' : 'hidden'}`}
            >
              <MainPanel
                terminal={terminal}
                isActive={isActive && activeTab === 'terminal' && terminal.id === mainTerminal?.id}
                onClose={handleCloseTerminal}
                onRestart={handleRestart}
                onSwitchApiVersion={handleSwitchApiVersion}
                workspaceId={workspace.id}
                isRemoteConnected={isRemoteConnected}
                onRequestLogin={handleLogin}
              />
            </div>
          ))}
        </div>
      </Suspense>

      {activeTab === 'files' && (
        <Suspense fallback={<div className="loading-panel" />}>
          <div className="workspace-tab-content">
            <FileTree rootPath={workspace.folderPath} remoteMode={isRemoteConnected} />
          </div>
        </Suspense>
      )}

      {activeTab === 'git' && (
        <Suspense fallback={<div className="loading-panel" />}>
          <div className="workspace-tab-content">
            <GitPanel
              workspaceFolderPath={workspace.folderPath}
              worktreePaths={terminals
                .filter(t => t.worktreePath)
                .map(t => ({ path: t.worktreePath!, branch: t.worktreeBranch || 'worktree' }))
              }
            />
          </div>
        </Suspense>
      )}

      {activeTab === 'github' && hasGithubRemote && (
        <Suspense fallback={<div className="loading-panel" />}>
          <div className="workspace-tab-content">
            <GitHubPanel workspaceFolderPath={workspace.folderPath} onSendToClaude={handleSendToClaude} />
          </div>
        </Suspense>
      )}

      {/* Resize handle for thumbnail bar */}
      {!thumbnailSettings.collapsed && (
        <ResizeHandle
          direction="vertical"
          onResize={handleThumbnailResize}
          onDoubleClick={handleThumbnailResetHeight}
        />
      )}

      <ThumbnailBar
        terminals={thumbnailTerminals}
        focusedTerminalId={focusedTerminalId}
        onFocus={handleFocus}
        onAddTerminal={handleAddTerminal}
        onAddWorktreeTerminal={isGitRepo ? handleAddWorktreeTerminal : undefined}
        onAddAgent={handleAddAgent}
        onAddWorker={handleAddWorker}
        detectedProcfiles={detectedProcfiles}
        agentPresets={getVisiblePresets().filter(p =>
          p.id !== 'none'
          && (!p.needsGitRepo || isGitRepo)
          && (supportedPresetIds === null || supportedPresetIds.includes(p.id))
        )}
        onReorder={handleReorderTerminals}
        onCloseTerminal={handleCloseTerminal}
        showAddButton={true}
        height={thumbnailSettings.height}
        collapsed={thumbnailSettings.collapsed}
        onCollapse={handleThumbnailCollapse}
      />

      {showCloseConfirm && (() => {
        const target = terminals.find(t => t.id === showCloseConfirm)
        const isWorktree = !!target?.worktreePath
        const mergedKind = target?.worktreeMergedKind
        const worktreeMerged = mergedKind === 'ancestor' || mergedKind === 'patch-equivalent'
        return (
          <CloseConfirmDialog
            onConfirm={() => handleConfirmClose(false)}
            onCancel={() => setShowCloseConfirm(null)}
            isWorktree={isWorktree}
            worktreeMerged={worktreeMerged}
            onConfirmAndClean={() => handleConfirmClose(true)}
          />
        )
      })()}
      {showProcfilePicker && (
        <FolderPicker
          initialPath={workspace.folderPath}
          multiSelect={false}
          mode="files"
          title="Select Procfile"
          emptyMessage="No Procfile found in this folder."
          confirmLabel="Use selected Procfile"
          onSelect={handleProcfilePickerSelect}
          onClose={() => setShowProcfilePicker(false)}
        />
      )}
      {showQuickPick && (
        <NewTerminalQuickPick
          isGitRepo={isGitRepo}
          supportedPresetIds={supportedPresetIds}
          onSelect={handleQuickPickSelect}
          onClose={() => setShowQuickPick(false)}
        />
      )}
      {remoteLoginKind && (
        <RemoteLoginDialog
          kind={remoteLoginKind}
          onClose={() => setRemoteLoginKind(null)}
          onSuccess={() => {
            setRemoteLoginKind(null)
            void refreshAccountChip()
            window.dispatchEvent(new CustomEvent(
              remoteLoginKind === 'codex' ? 'codex-account-switched' : 'claude-account-switched',
              { detail: {} },
            ))
          }}
        />
      )}
    </div>
  )
})
