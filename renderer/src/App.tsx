import { host, isTauri } from './host-api'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { workspaceStore } from './stores/workspace-store'
import { settingsStore } from './stores/settings-store'
import { Sidebar } from './components/Sidebar'
import { UpdateBanner } from './components/UpdateBanner'
import { startAutoUpdate } from './lib/auto-update'
import { startRuntimeAutoInstall } from './lib/runtime-auto-install'
import { WorkspaceView, clearInitializedWorkspaces } from './components/WorkspaceView'
import { SettingsPanel } from './components/SettingsPanel'
import { SnippetSidebar } from './components/SnippetPanel'
import { SkillsPanel } from './components/SkillsPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { MarkdownPreviewPanel } from './components/MarkdownPreviewPanel'
import { WorkspaceEnvDialog } from './components/WorkspaceEnvDialog'
import { ResizeHandle } from './components/ResizeHandle'
import { ProfilePanel } from './components/ProfilePanel'
import { ProfileWindowCloseDialog } from './components/ProfileWindowCloseDialog'
import { FolderPicker } from './components/FolderPicker'
import { consumeKeyboardShortcut, isBackquoteShortcutEvent } from './utils/keyboard-shortcuts'
import {
  normalizeProfileChangedPayload,
  profileChangeMatchesRemoteOrigin,
  type ProfileEntryLike,
} from './utils/remote-profile-events'
import type { AppState, EnvVariable, TerminalInstance } from './types'

// Panel settings interface
interface PanelSettings {
  sidebar: {
    width: number
  }
  snippetSidebar: {
    width: number
    collapsed: boolean
  }
}

const PANEL_SETTINGS_KEY = 'better-terminal-panel-settings'
const DEFAULT_SIDEBAR_WIDTH = 220
const MIN_SIDEBAR_WIDTH = 160
const MAX_SIDEBAR_WIDTH = 400
const DEFAULT_SNIPPET_WIDTH = 280
const MIN_SNIPPET_WIDTH = 180
const MAX_SNIPPET_WIDTH = 500

// Auto-reconnect backoff bounds (ms). The status poll runs every 3s; on a
// failed re-dial we grow the gate up to the max so a long outage doesn't hammer
// the host, and reset to the min on success or on resume from sleep.
const RECONNECT_BACKOFF_MIN = 3000
const RECONNECT_BACKOFF_MAX = 30000
const EMPTY_TERMINALS: TerminalInstance[] = []

type ProfileWindowCloseAction = 'temporary' | 'removeFromProfile' | 'cancel'
type ProfileWindowCloseRequest = {
  windowId: string
  profileId: string
  windowIndex: number
  windowCount: number
}

// Compute parent of a path, supporting both POSIX and Windows separators.
// Returns the input unchanged if at filesystem root.
function parentPath(p: string): string {
  if (!p) return p
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx < 0) return trimmed
  // Windows drive root e.g. "C:\foo" → "C:\"
  if (idx === 2 && trimmed[1] === ':') return trimmed.slice(0, 3)
  // POSIX root e.g. "/foo" → "/"
  if (idx === 0) return '/'
  return trimmed.slice(0, idx)
}

function loadPanelSettings(): PanelSettings {
  try {
    const saved = localStorage.getItem(PANEL_SETTINGS_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      // Ensure sidebar settings exist (migration from old format)
      return {
        sidebar: parsed.sidebar || { width: DEFAULT_SIDEBAR_WIDTH },
        snippetSidebar: parsed.snippetSidebar || { width: DEFAULT_SNIPPET_WIDTH, collapsed: true }
      }
    }
  } catch (e) {
    console.error('Failed to load panel settings:', e)
  }
  return {
    sidebar: { width: DEFAULT_SIDEBAR_WIDTH },
    snippetSidebar: { width: DEFAULT_SNIPPET_WIDTH, collapsed: true }
  }
}

function savePanelSettings(settings: PanelSettings): void {
  try {
    localStorage.setItem(PANEL_SETTINGS_KEY, JSON.stringify(settings))
  } catch (e) {
    console.error('Failed to save panel settings:', e)
  }
}

function afterFirstPaint(callback: () => void, delayMs = 0): () => void {
  let cancelled = false
  let firstFrame = 0
  let secondFrame = 0
  let timeout: ReturnType<typeof setTimeout> | null = null
  firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() => {
      timeout = setTimeout(() => {
        if (!cancelled) callback()
      }, delayMs)
    })
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(firstFrame)
    cancelAnimationFrame(secondFrame)
    if (timeout) clearTimeout(timeout)
  }
}

function scheduleTauriStartupBackgroundWork(callback: () => void): () => void {
  if (!isTauri()) {
    callback()
    return () => {}
  }
  return afterFirstPaint(callback, 1000)
}

export default function App() {
  const { t } = useTranslation()
  const [state, setState] = useState<AppState>(workspaceStore.getState())
  const [showSettings, setShowSettings] = useState(false)
  const [showProfiles, setShowProfiles] = useState(false)
  const [folderPickerInitialPath, setFolderPickerInitialPath] = useState<string | undefined>(undefined)
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [activeProfileName, setActiveProfileName] = useState<string>('Default')
  const [activeProfileIsRemote, setActiveProfileIsRemote] = useState(false)
  const [remoteClientConnected, setRemoteClientConnected] = useState(false)
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [activeRemoteProfileId, setActiveRemoteProfileId] = useState<string | null>(null)
  // "host:port" of the remote connection this window is viewing (null for
  // local profiles). Mirrored into the workspace store so reload broadcasts
  // can be scoped to the right host connection.
  const [activeRemoteOrigin, setActiveRemoteOrigin] = useState<string | null>(null)
  const isRemoteConnected = activeProfileIsRemote && remoteClientConnected
  const [appNotification, setAppNotification] = useState<string | null>(null)
  const [profileWindowCloseRequest, setProfileWindowCloseRequest] = useState<ProfileWindowCloseRequest | null>(null)
  const [envDialogWorkspaceId, setEnvDialogWorkspaceId] = useState<string | null>(null)
  // Right sidebar tabs
  const [showSnippetSidebar] = useState(true)
  const [rightPanelTab, setRightPanelTab] = useState<'snippets' | 'skills' | 'agents'>(() => {
    return (localStorage.getItem('bat-right-panel-tab') as 'snippets' | 'skills' | 'agents') || 'snippets'
  })
  // Markdown preview in right panel
  const [previewMarkdownPath, setPreviewMarkdownPath] = useState<string | null>(null)
  // Track collapsed state before markdown preview opened, to restore on close
  const previewPrevCollapsed = useRef<boolean | null>(null)
  // Panel settings for resizable panels
  const [panelSettings, setPanelSettings] = useState<PanelSettings>(loadPanelSettings)
  // Detached workspace support
  const [detachedWorkspaceId] = useState(() => host.workspace.getDetachedId())
  const [detachedIds, setDetachedIds] = useState<Set<string>>(new Set())
  // Track workspaces that have been visited (for lazy mounting)
  const [mountedWorkspaces, setMountedWorkspaces] = useState<Set<string>>(new Set())
  const lastRenderSummaryRef = useRef<string>('')
  const [currentWindowId, setCurrentWindowId] = useState<string | null>(null)
  const currentWindowIdRef = useRef<string | null>(null)
  const activeProfileIdRef = useRef<string | null>(null)
  const activeRemoteProfileIdRef = useRef<string | null>(null)
  const activeRemoteOriginRef = useRef<string | null>(null)
  const activeProfileIsRemoteRef = useRef(false)
  const remoteUnavailableRef = useRef(false)
  // Connection params captured on the initial remote connect so the status
  // poll can silently re-dial after an idle drop without re-reading the
  // profile. Null for local profiles / before the first remote connect.
  const remoteConnParamsRef = useRef<{ host: string; port: number; token: string; fingerprint: string } | null>(null)
  // Auto-reconnect backoff state. `inFlight` prevents overlapping dials;
  // `nextAt` gates retries (epoch ms); `backoff` grows on failure.
  const reconnectRef = useRef<{ inFlight: boolean; backoff: number; nextAt: number }>({ inFlight: false, backoff: RECONNECT_BACKOFF_MIN, nextAt: 0 })

  useEffect(() => { activeProfileIdRef.current = activeProfileId }, [activeProfileId])
  useEffect(() => { activeRemoteProfileIdRef.current = activeRemoteProfileId }, [activeRemoteProfileId])
  useEffect(() => { activeRemoteOriginRef.current = activeRemoteOrigin }, [activeRemoteOrigin])
  useEffect(() => {
    activeProfileIsRemoteRef.current = activeProfileIsRemote
    if (!activeProfileIsRemote) remoteUnavailableRef.current = false
  }, [activeProfileIsRemote])
  useEffect(() => {
    if (remoteClientConnected) remoteUnavailableRef.current = false
  }, [remoteClientConnected])
  // Keep the workspace store's reload scope in sync with the active profile.
  // Remote windows gate host workspace:reload broadcasts by the host profile id
  // they're viewing; local windows clear it and fall back to windowId targeting.
  useEffect(() => {
    workspaceStore.setViewedRemoteProfileId(
      activeProfileIsRemote ? (activeRemoteProfileId || null) : null,
    )
    workspaceStore.setViewedRemoteOrigin(
      activeProfileIsRemote ? activeRemoteOrigin : null,
    )
  }, [activeProfileIsRemote, activeRemoteProfileId, activeRemoteOrigin])

  // Background auto-update + first-run runtime auto-install: run only in the
  // main window so multiple windows never install concurrently.
  useEffect(() => {
    if (!isTauri) return
    let cancelled = false
    host.app.getWindowId()
      .then((id: string | null) => {
        if (cancelled || id !== 'main') return
        startAutoUpdate()
        startRuntimeAutoInstall()
      })
      .catch(() => { /* not the main window or no window id — skip */ })
    return () => { cancelled = true }
  }, [])

  // Sync window title with active profile and window index. The account email
  // and plan are intentionally not shown here — the per-workspace account chip
  // (top-right) already surfaces the active account and its plan.
  const [windowIndex, setWindowIndex] = useState<number>(1)
  useEffect(() => {
    host.app.getWindowIndex().then(setWindowIndex)
  }, [])

  useEffect(() => {
    let disposed = false
    const rememberWindowId = async (): Promise<string | null> => {
      const cached = currentWindowIdRef.current
      if (cached) return cached
      const windowId = await host.app.getWindowId().catch(() => null)
      if (!disposed && windowId) {
        currentWindowIdRef.current = windowId
        setCurrentWindowId(windowId)
        workspaceStore.setWindowId(windowId)
      }
      return windowId
    }
    void rememberWindowId()
    const unsubscribe = host.app.onProfileWindowCloseRequested?.((request: ProfileWindowCloseRequest) => {
      void rememberWindowId().then(windowId => {
        if (!windowId || request.windowId !== windowId) return
        if (disposed) return
        setProfileWindowCloseRequest(request)
      })
    })
    return () => {
      disposed = true
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])
  useEffect(() => {
    if (!profileWindowCloseRequest) return
    const windowId = currentWindowIdRef.current
    if (windowId && profileWindowCloseRequest.windowId !== windowId) {
      setProfileWindowCloseRequest(null)
    }
  }, [profileWindowCloseRequest])
  useEffect(() => {
    const profileTitle = /:\d+$/.test(activeProfileName)
      ? activeProfileName
      : `${activeProfileName}:${windowIndex}`
    const profilePart = `${profileTitle}${activeProfileIsRemote ? ' (Remote)' : ''}`
    const title = `${profilePart} | Better Agent Terminal`
    document.title = title
    host.app.setTitle(title).catch(() => {})
  }, [activeProfileName, windowIndex, activeProfileIsRemote])

  // Lazy mount: only render a workspace's terminals once it has been activated
  useEffect(() => {
    if (state.activeWorkspaceId && !mountedWorkspaces.has(state.activeWorkspaceId)) {
      setMountedWorkspaces(prev => new Set(prev).add(state.activeWorkspaceId!))
    }
  }, [state.activeWorkspaceId, mountedWorkspaces])

  // Handle sidebar resize
  const handleSidebarResize = useCallback((delta: number) => {
    setPanelSettings(prev => {
      // Note: delta is positive when dragging right (making sidebar wider)
      const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, prev.sidebar.width + delta))
      const updated = { ...prev, sidebar: { ...prev.sidebar, width: newWidth } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  // Reset sidebar to default width
  const handleSidebarResetWidth = useCallback(() => {
    setPanelSettings(prev => {
      const updated = { ...prev, sidebar: { ...prev.sidebar, width: DEFAULT_SIDEBAR_WIDTH } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  // Handle snippet sidebar resize
  const handleSnippetResize = useCallback((delta: number) => {
    setPanelSettings(prev => {
      // Note: delta is negative when dragging left (making sidebar wider)
      const newWidth = Math.min(MAX_SNIPPET_WIDTH, Math.max(MIN_SNIPPET_WIDTH, prev.snippetSidebar.width - delta))
      const updated = { ...prev, snippetSidebar: { ...prev.snippetSidebar, width: newWidth } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  const handleRightPanelTabChange = useCallback((tab: 'snippets' | 'skills' | 'agents') => {
    setRightPanelTab(tab)
    localStorage.setItem('bat-right-panel-tab', tab)
    // If collapsed, expand when switching tabs
    setPanelSettings(prev => {
      if (prev.snippetSidebar.collapsed) {
        const updated = { ...prev, snippetSidebar: { ...prev.snippetSidebar, collapsed: false } }
        savePanelSettings(updated)
        return updated
      }
      return prev
    })
  }, [])

  // Toggle snippet sidebar collapse
  const handleSnippetCollapse = useCallback(() => {
    setPanelSettings(prev => {
      const updated = { ...prev, snippetSidebar: { ...prev.snippetSidebar, collapsed: !prev.snippetSidebar.collapsed } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  // Reset snippet sidebar to default width
  const handleSnippetResetWidth = useCallback(() => {
    setPanelSettings(prev => {
      const updated = { ...prev, snippetSidebar: { ...prev.snippetSidebar, width: DEFAULT_SNIPPET_WIDTH } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  // Listen for markdown preview requests from PathLinker
  useEffect(() => {
    const handler = (e: Event) => {
      const { path } = (e as CustomEvent).detail as { path: string }
      setPreviewMarkdownPath(path)
      // Save current collapsed state so we can restore it on close, then expand panel
      setPanelSettings(prev => {
        previewPrevCollapsed.current = prev.snippetSidebar.collapsed
        if (prev.snippetSidebar.collapsed) {
          const updated = { ...prev, snippetSidebar: { ...prev.snippetSidebar, collapsed: false } }
          savePanelSettings(updated)
          return updated
        }
        return prev
      })
    }
    window.addEventListener('preview-markdown', handler)
    return () => window.removeEventListener('preview-markdown', handler)
  }, [])

  // Cmd+N / Ctrl+N: open new empty window
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        host.app.newWindow()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Keyboard shortcuts: Cmd+` on mac / Ctrl+` elsewhere (cycle BAT windows),
  // Ctrl+` on mac / Alt+` elsewhere (cycle sessions in the current workspace),
  // Cmd/Ctrl+Left/Right (cycle tabs), Cmd/Ctrl+Up/Down (switch workspace)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isBackquote = isBackquoteShortcutEvent(e)
      const isSessionCycleShortcut = host.platform === 'darwin'
        ? e.ctrlKey && !e.metaKey && !e.altKey
        : e.altKey && !e.metaKey && !e.ctrlKey

      if (isBackquote && isSessionCycleShortcut) {
        const currentState = workspaceStore.getState()
        if (!currentState.activeWorkspaceId) return
        const terminals = workspaceStore.getWorkspaceTerminals(currentState.activeWorkspaceId)
        if (terminals.length <= 1) return
        const currentIndex = terminals.findIndex(t => t.id === currentState.focusedTerminalId)
        const direction = e.shiftKey ? -1 : 1
        const nextIndex = currentIndex >= 0
          ? (currentIndex + direction + terminals.length) % terminals.length
          : (direction > 0 ? 0 : terminals.length - 1)
        workspaceStore.setFocusedTerminal(terminals[nextIndex].id)
        window.dispatchEvent(new CustomEvent('workspace-switch-tab', { detail: { tab: 'terminal' } }))
        consumeKeyboardShortcut(e)
        return
      }

      if (!(e.metaKey || e.ctrlKey) || e.altKey) return

      const isWindowCycleShortcut = host.platform === 'darwin'
        ? e.metaKey && !e.ctrlKey
        : e.ctrlKey && !e.metaKey

      if (isBackquote && isWindowCycleShortcut && !e.shiftKey) {
        host.app.focusNextWindow()
        consumeKeyboardShortcut(e)
        return
      }

      // Ctrl+Tab (Win + Mac): jump to window with most recent unread notification.
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'Tab' || e.code === 'Tab')) {
        host.notification.focusLatestUnread()
        consumeKeyboardShortcut(e)
        return
      }

      // Cmd+Up / Cmd+Down: Switch workspaces
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey) {
        const currentState = workspaceStore.getState()
        const workspaces = currentState.workspaces
        if (workspaces.length <= 1) return
        const currentIndex = workspaces.findIndex(w => w.id === currentState.activeWorkspaceId)
        const direction = e.key === 'ArrowDown' ? 1 : -1
        const nextIndex = (currentIndex + direction + workspaces.length) % workspaces.length
        workspaceStore.setActiveWorkspace(workspaces[nextIndex].id)
        consumeKeyboardShortcut(e)
        return
      }

      // Cmd+T (mac) / Ctrl+Shift+T (win/linux): open new-terminal quick-pick.
      // We intentionally do NOT use Ctrl+T on Windows/Linux because most
      // terminals/browsers reserve it; Ctrl+Shift+T mirrors Konsole.
      const isOpenTerminal =
        (e.metaKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') ||
        (e.ctrlKey && !e.metaKey && e.shiftKey && e.key.toLowerCase() === 't')
      if (isOpenTerminal) {
        const currentState = workspaceStore.getState()
        if (!currentState.activeWorkspaceId) return
        // Make sure the terminal tab is visible so the new terminal is in view.
        window.dispatchEvent(new CustomEvent('workspace-switch-tab', { detail: { tab: 'terminal' } }))
        window.dispatchEvent(new CustomEvent('workspace-add-terminal-quick-pick'))
        consumeKeyboardShortcut(e)
        return
      }

      // Cmd+Shift+W (mac) / Ctrl+Shift+W (win/linux): close focused terminal.
      // Plain Cmd+W is intentionally NOT used — it collides with the OS-level
      // window-close, which would close the BAT window AND drop the terminal
      // from the preserved workspace state.
      const isCloseTerminal =
        e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w'
      if (isCloseTerminal) {
        const currentState = workspaceStore.getState()
        if (!currentState.focusedTerminalId) return
        window.dispatchEvent(new CustomEvent('workspace-close-terminal', {
          detail: { terminalId: currentState.focusedTerminalId },
        }))
        consumeKeyboardShortcut(e)
        return
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  useEffect(() => {
    const unsubscribe = workspaceStore.subscribe(() => {
      setState(workspaceStore.getState())
    })

    // Global listener for all terminal output - updates activity for ALL terminals
    // This is needed because WorkspaceView only renders terminals for the active workspace
    const unsubscribeOutput = host.pty.onOutput((id) => {
      workspaceStore.updateTerminalActivity(id)
    })

    // Load saved workspaces and settings on startup
    // If launched with --profile, use that profile instead of the stored active one
    const dlog = (...args: unknown[]) => host.debug.log(...args)
    const htmlT0 = (window as unknown as { __t0?: number }).__t0 || Date.now()
    dlog(`[startup] App useEffect fired: +${Date.now() - htmlT0}ms from HTML`)
    const initProfile = async () => {
      const t0 = performance.now()
      try {
        const initWindowId = currentWindowIdRef.current || await host.app.getWindowId().catch(() => null)
        if (initWindowId) {
          currentWindowIdRef.current = initWindowId
          setCurrentWindowId(initWindowId)
          workspaceStore.setWindowId(initWindowId)
        }

        const launchProfileId = await host.app.getLaunchProfile()
        dlog(`[init] getLaunchProfile: ${(performance.now() - t0).toFixed(0)}ms`)

        const t1 = performance.now()
        const result = await host.profile.list()
        dlog(`[init] profile.list: ${(performance.now() - t1).toFixed(0)}ms`)

        const windowProfileId = await host.app.getWindowProfile()
        const freshEmptyWindow = typeof host.app.takeFreshWindowFlag === 'function'
          ? await host.app.takeFreshWindowFlag().catch(() => false)
          : false
        const windowProfileTakesPriority = Boolean(
          windowProfileId && initWindowId && initWindowId !== 'main',
        )
        const effectiveLaunchProfileId = (freshEmptyWindow || windowProfileTakesPriority)
          ? null
          : launchProfileId

        // Determine which profile this window should use:
        // 1. Launch profile (--profile= argument) takes priority for the initial process window.
        // 2. Fresh Ctrl+N windows ignore the process launch profile and use their registry binding.
        // 3. Profile windows created by Tauri use their registry binding over the process launch profile.
        // 4. First active profile as fallback
        const profileId = windowProfileTakesPriority
          ? windowProfileId
          : effectiveLaunchProfileId || windowProfileId || result.activeProfileIds[0]
        let active = result.profiles.find(p => p.id === profileId)

        // If the id doesn't match anything in `result` (which is the REMOTE
        // host's profile list when a remote connection is already active),
        // fall back to the local profile list. This happens when the window
        // is bound to a LOCAL profile that acts as an alias for a remote
        // connection (e.g. launched with --profile=<local-remote-alias>).
        if (!active && profileId) {
          try {
            const localResult = await host.profile.listLocal()
            active = localResult.profiles.find(p => p.id === profileId)
          } catch {
            // listLocal may not exist on older builds — fall through
          }
        }

        if (host.debug.isDebugMode === true) {
          dlog(`[init] profile selection windowId=${initWindowId || 'none'} launch=${launchProfileId || 'none'} effectiveLaunch=${effectiveLaunchProfileId || 'none'} window=${windowProfileId || 'none'} windowPriority=${windowProfileTakesPriority} freshEmpty=${freshEmptyWindow} firstActive=${result.activeProfileIds[0] || 'none'} selected=${profileId || 'none'} active=${active ? `${active.id}/${active.name}/${active.type}` : 'none'}`)
        }

        // Startup guarantees for the main/startup window. Run BEFORE this window
        // attempts its own remote connect, so they still take effect even if this
        // window closes on a connect failure (see the remote branches below).
        if (initWindowId === 'main') {
          // Ensure at least one local (non-remote) window exists. Only needed when
          // every window that will open is remote — otherwise a local window is
          // already covered (this window, or one restored below).
          try {
            const startupProfiles = Array.isArray(result.profiles) ? result.profiles : []
            const isRemoteAlias = (id: string) =>
              startupProfiles.find((p: { id: string; type?: string }) => p.id === id)?.type === 'remote'
            const plannedWindowProfileIds: string[] = effectiveLaunchProfileId
              ? [effectiveLaunchProfileId]
              : (Array.isArray(result.activeProfileIds) ? result.activeProfileIds : [])
            if (plannedWindowProfileIds.length > 0 && plannedWindowProfileIds.every(isRemoteAlias)) {
              const firstLocal = startupProfiles.find((p: { type?: string }) => p.type !== 'remote')
              if (firstLocal) {
                dlog(`[init] startup set is all-remote; opening local anchor window profile=${firstLocal.id}`)
                await host.app.openNewInstance(firstLocal.id).catch(() => { /* best effort */ })
              }
            }
          } catch { /* best effort — never block startup */ }

          // Restore the other active profiles' windows now (globally once), early
          // enough that they still come up even if THIS window closes on a remote
          // connect failure below.
          if (isTauri() && !effectiveLaunchProfileId) {
            const currentProfileId = (await host.app.getWindowProfile()) || active?.id || profileId || null
            const tRestore = performance.now()
            const restored = await host.app.restoreActiveProfiles(currentProfileId)
            if (restored.length > 0) {
              dlog(`[init] app.restoreActiveProfiles: ${(performance.now() - tRestore).toFixed(0)}ms (${restored.length} windows)`)
            }
          }
        }

        if (active?.type === 'remote' && active.remoteHost && active.remoteToken && active.remoteFingerprint) {
          // Try connecting to remote
          const tRemote = performance.now()
          const connectResult = await host.remote.connect(
            active.remoteHost,
            active.remotePort || 9876,
            active.remoteToken,
            active.remoteFingerprint
          )
          dlog(`[init] remote.connect: ${(performance.now() - tRemote).toFixed(0)}ms`)
          if ('error' in connectResult) {
            // Surface WHY the dial failed — otherwise a remote window just goes
            // blank (the reason was previously swallowed on the restore path,
            // leaving only an unrelated "not connected" unhandledrejection in
            // the log). Logged for every path, including the local fallback.
            dlog(`[init] remote.connect failed host=${active.remoteHost}:${active.remotePort || 9876} error=${String((connectResult as { error?: unknown }).error)}`)
            // A remote connection that fails to dial should not silently become a
            // local window (the "blank bat window" symptom) — surface why, then
            // close this window. The startup safety-net (above) guarantees a local
            // window remains, so this never leaves the app with zero windows.
            setAppNotification(t('app.remoteConnectionFailed', { error: connectResult.error }))
            setTimeout(() => { try { window.close() } catch { /* window already gone */ } }, 2000)
            return
          } else {
            // Scope host workspace:reload broadcasts to the profile we're viewing.
            // Set synchronously here — BEFORE any await below — so a reload that
            // arrives immediately after the socket connects can never fall through
            // to the local windowId branch (see workspace-store.listenForReload).
            workspaceStore.setViewedRemoteProfileId(active.remoteProfileId || 'default')
            workspaceStore.setViewedRemoteOrigin(`${active.remoteHost}:${active.remotePort || 9876}`)
            const winIdx = await host.app.getWindowIndex()
            // Show the HOST-side target profile name when we have it (persisted on
            // the alias at selection time) so the title/sidebar reflect which
            // remote profile this is — not the local alias name, which can collide
            // with an unrelated local profile and read as if it were local.
            const remoteDisplayName = (typeof active.remoteProfileName === 'string' && active.remoteProfileName.trim())
              ? active.remoteProfileName.trim()
              : active.name
            setActiveProfileName(`${remoteDisplayName}:${winIdx}`)
            setActiveProfileIsRemote(true)
            setActiveProfileId(active.id)
            setActiveRemoteProfileId(active.remoteProfileId || 'default')
            setActiveRemoteOrigin(`${active.remoteHost}:${active.remotePort || 9876}`)
            setRemoteClientConnected(true)
            // Surface client/server app version skew once per fresh connect.
            // A 3.1.22 host silently accepting 3.1.26 clients was the trigger
            // for issue #115's cross-profile state leakage; warning the user
            // turns that gap into something diagnosable on the first dial.
            // Hosts that predate the handshake (~3.1.27) send no
            // `serverVersion`, in which case there is nothing to compare.
            const cr = connectResult as { clientVersion?: string; serverVersion?: string | null }
            if (cr.clientVersion && cr.serverVersion && cr.clientVersion !== cr.serverVersion) {
              setAppNotification(t('app.remoteVersionMismatch', { clientVersion: cr.clientVersion, serverVersion: cr.serverVersion }))
            }
            // Remember how we connected so the status poll can silently
            // re-dial after an idle drop without restarting the app.
            remoteConnParamsRef.current = {
              host: active.remoteHost,
              port: active.remotePort || 9876,
              token: active.remoteToken,
              fingerprint: active.remoteFingerprint,
            }
            reconnectRef.current = { inFlight: false, backoff: RECONNECT_BACKOFF_MIN, nextAt: 0 }
          }
        } else if (active?.type === 'remote') {
          // Remote profile missing connection info — close this window instead of
          // silently degrading to local. The startup safety-net keeps a local
          // window around.
          setAppNotification(t('app.remoteMissingInfo'))
          setTimeout(() => { try { window.close() } catch { /* window already gone */ } }, 2000)
          return
        } else if (active) {
          // For local profiles opened in a new window, load the profile snapshot
          // so workspaces.json reflects this profile's data (not the previous profile's).
          // Skip when the window was just opened via Cmd+N (app_new_window) — those
          // windows are intentionally empty, and profile.load would overwrite the
          // empty snapshot with the bound profile's saved workspaces.
          if (effectiveLaunchProfileId || windowProfileId) {
            if (freshEmptyWindow) {
              if (host.debug.isDebugMode === true) {
                dlog(`[init] skip profile.load: window is fresh-empty (Cmd+N)`)
              }
            } else {
              if (host.debug.isDebugMode === true) {
                dlog(`[init] profile.load local id=${active.id} reason=${effectiveLaunchProfileId ? 'launch' : 'window'}`)
              }
              await host.profile.load(active.id)
            }
          }
          const winIdx = await host.app.getWindowIndex()
          setActiveProfileName(`${active.name}:${winIdx}`)
          setActiveProfileIsRemote(false)
          setActiveProfileId(active.id)
          setActiveRemoteProfileId(null)
          setActiveRemoteOrigin(null)
        } else if (result.profiles.length > 0) {
          // Fallback: activeProfileId didn't match any profile — use first local profile
          const fallback = result.profiles.find(p => p.type !== 'remote') || result.profiles[0]
          const winIdx = await host.app.getWindowIndex()
          setActiveProfileName(`${fallback.name}:${winIdx}`)
          setActiveProfileIsRemote(fallback.type === 'remote')
          setActiveProfileId(fallback.id)
          setActiveRemoteProfileId(fallback.type === 'remote' ? (fallback.remoteProfileId || 'default') : null)
          setActiveRemoteOrigin(
            fallback.type === 'remote' && fallback.remoteHost
              ? `${fallback.remoteHost}:${fallback.remotePort || 9876}`
              : null,
          )
        }

        // Store windowId for cross-window workspace drag
        const winId = initWindowId || await host.app.getWindowId()
        if (winId) {
          currentWindowIdRef.current = winId
          setCurrentWindowId(winId)
          workspaceStore.setWindowId(winId)
        }

        // Active-profile window restore now runs earlier (right after profile
        // selection, from the main window) so it survives a remote connect
        // failure that closes this window.

        const tLoad = performance.now()
        // Load settings first (lightweight, no re-render), then workspaces (triggers heavy re-render)
        await settingsStore.load()
        dlog(`[init] settingsStore.load: ${(performance.now() - tLoad).toFixed(0)}ms`)

        // Sync i18n language with saved setting
        const savedLang = settingsStore.getSettings().language || 'en'
        if (i18next.language !== savedLang) i18next.changeLanguage(savedLang)

        const tWs = performance.now()
        await workspaceStore.load()
        dlog(`[init] workspaceStore.load: ${(performance.now() - tWs).toFixed(0)}ms`)
        if (host.debug.isDebugMode === true) {
          const loaded = workspaceStore.getState()
          const activeTerms = loaded.activeWorkspaceId
            ? loaded.terminals
              .filter(term => term.workspaceId === loaded.activeWorkspaceId)
              .map(term => `${term.id.slice(0, 8)}:${term.title || term.agentPreset || 'terminal'}`)
              .join(',')
            : ''
          dlog(`[init] workspace state workspaces=${loaded.workspaces.length} terminals=${loaded.terminals.length} activeWs=${loaded.activeWorkspaceId || 'none'} focused=${loaded.focusedTerminalId || 'none'} activeTerm=${loaded.activeTerminalId || 'none'} activeTerms=[${activeTerms}]`)
        }
      } catch (e) {
        console.error('Failed to initialize profile:', e)
        // Ensure workspaces still load even if profile init fails
        await settingsStore.load()
        const savedLang = settingsStore.getSettings().language || 'en'
        if (i18next.language !== savedLang) i18next.changeLanguage(savedLang)
        await workspaceStore.load()
      }
      dlog(`[init] total initProfile: ${(performance.now() - t0).toFixed(0)}ms`)
      dlog(`[startup] app ready (initProfile done): +${Date.now() - htmlT0}ms from HTML`)
    }
    initProfile()

    // Listen for system resume from sleep/hibernate — refresh remote connection
    // status and clear any reconnect backoff so the status poll re-dials right
    // away instead of waiting out a grown gate from before the machine slept.
    const unsubSystemResume = host.system.onResume(() => {
      reconnectRef.current.nextAt = 0
      reconnectRef.current.backoff = RECONNECT_BACKOFF_MIN
      host.remote.clientStatus().then(s => setRemoteClientConnected(s.connected))
    })

    // Listen for cross-window workspace reload
    const unsubReload = workspaceStore.listenForReload()

    // Listen for workspace detach/reattach events (main window only)
    const unsubDetach = host.workspace.onDetached((wsId) => {
      setDetachedIds(prev => new Set(prev).add(wsId))
    })
    const unsubReattach = host.workspace.onReattached((wsId) => {
      setDetachedIds(prev => {
        const next = new Set(prev)
        next.delete(wsId)
        return next
      })
    })

    return () => {
      unsubscribe()
      unsubscribeOutput()
      unsubSystemResume()
      unsubReload()
      unsubDetach()
      unsubReattach()
    }
  }, [])

  // Poll remote client connection status, and silently re-dial after an idle
  // drop. The Rust client has no auto-reconnect: once the socket dies it just
  // flips `connected` false, so without this the only recovery was restarting
  // the app. On a successful re-dial we reload workspaces to re-attach the
  // host-owned sessions/workspaces (they keep running on the host).
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    let disposed = false

    const attemptReconnect = async () => {
      // Only drive reconnection for a remote profile that is still wanted.
      if (!activeProfileIsRemoteRef.current) return
      if (remoteUnavailableRef.current) return
      const params = remoteConnParamsRef.current
      if (!params) return
      const state = reconnectRef.current
      if (state.inFlight) return
      if (Date.now() < state.nextAt) return
      state.inFlight = true
      try {
        const result = await host.remote.connect(params.host, params.port, params.token, params.fingerprint)
        const failed = !result || (typeof result === 'object' && 'error' in (result as Record<string, unknown>))
        if (failed) {
          state.backoff = Math.min(state.backoff * 2, RECONNECT_BACKOFF_MAX)
          state.nextAt = Date.now() + state.backoff
        } else {
          state.backoff = RECONNECT_BACKOFF_MIN
          state.nextAt = 0
          // The profile may have been torn down (deleted / made unavailable)
          // while this dial was in flight — don't resurrect a zombie session.
          if (!disposed && !remoteUnavailableRef.current && activeProfileIsRemoteRef.current) {
            setRemoteClientConnected(true)
            // Re-attach: pull canonical host-owned workspace/session state back,
            // but keep the workspace the user was on (don't jump to the host's
            // stored active selection just because the socket blipped).
            await workspaceStore.load({ preserveActiveSelection: true }).catch(() => {})
          } else {
            await host.remote.disconnect().catch(() => {})
          }
        }
      } catch {
        state.backoff = Math.min(state.backoff * 2, RECONNECT_BACKOFF_MAX)
        state.nextAt = Date.now() + state.backoff
      } finally {
        state.inFlight = false
      }
    }

    const check = () => {
      host.remote.clientStatus().then(s => {
        setRemoteClientConnected(s.connected)
        if (!s.connected) void attemptReconnect()
      })
    }
    const cancelStart = scheduleTauriStartupBackgroundWork(() => {
      check()
      interval = setInterval(check, 3000)
    })
    return () => {
      disposed = true
      cancelStart()
      if (interval) clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const markRemoteUnavailable = async (reason: string) => {
      if (remoteUnavailableRef.current) return
      remoteUnavailableRef.current = true
      setRemoteClientConnected(false)
      setAppNotification(reason)
      try {
        await host.remote.disconnect()
      } catch {
        // Connection may already be closed.
      }
      if (!disposed) {
        void host.debug.log('[remote] current profile became unavailable', {
          localProfileId: activeProfileIdRef.current,
          remoteProfileId: activeRemoteProfileIdRef.current,
          reason,
        }).catch(() => {})
      }
    }
    const unsubscribe = host.profile.onChanged(async rawPayload => {
      if (!activeProfileIsRemoteRef.current) return
      const localProfileId = activeProfileIdRef.current
      const remoteProfileId = activeRemoteProfileIdRef.current || 'default'
      const payload = normalizeProfileChangedPayload(rawPayload)
      if (!profileChangeMatchesRemoteOrigin(payload, activeRemoteOriginRef.current)) {
        if (host.debug.isDebugMode === true) {
          void host.debug.log('[remote] profile change ignored: remote origin mismatch', {
            viewedRemoteOrigin: activeRemoteOriginRef.current,
            eventRemoteOrigin: payload?.remoteOrigin,
            remoteProfileId,
          }).catch(() => {})
        }
        return
      }

      if (localProfileId) {
        try {
          const localResult = await host.profile.listLocal()
          const localProfiles = Array.isArray(localResult?.profiles) ? localResult.profiles : []
          const localStillExists = localProfiles.some((profile: ProfileEntryLike) => profile?.id === localProfileId)
          if (!localStillExists) {
            await markRemoteUnavailable(t('profiles.remoteProfileUnavailable', { profile: activeProfileName }))
            return
          }
        } catch {
          // If the local profile list cannot be read, fall through and use the event payload.
        }
      }

      const profiles = payload?.profiles || []
      const isLocalProfileEvent = !!localProfileId
        && profiles.some(profile => profile.id === localProfileId && profile.type === 'remote')
      if (isLocalProfileEvent) return

      if (profiles.length > 0 && !profiles.some(profile => profile.id === remoteProfileId)) {
        await markRemoteUnavailable(t('profiles.remoteTargetUnavailable', { profile: remoteProfileId }))
      }
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [activeProfileName, t])

  const handleAddWorkspace = useCallback(() => {
    const { workspaces, activeWorkspaceId } = workspaceStore.getState()
    const active = workspaces.find(w => w.id === activeWorkspaceId)
    setFolderPickerInitialPath(active ? parentPath(active.folderPath) : undefined)
    setFolderPickerOpen(true)
  }, [])

  const handleFolderPickerSelect = useCallback((paths: string[]) => {
    for (const folderPath of paths) {
      const name = folderPath.split(/[/\\]/).filter(Boolean).pop() || 'Workspace'
      workspaceStore.addWorkspace(name, folderPath)
    }
    workspaceStore.save()
    setFolderPickerOpen(false)
  }, [])


  const handleDetachWorkspace = useCallback(async (workspaceId: string) => {
    await host.workspace.detach(workspaceId)
  }, [])

  // Paste content to focused PTY terminal
  const handlePasteToTerminal = useCallback((content: string) => {
    const currentState = workspaceStore.getState()
    let terminalId = currentState.focusedTerminalId

    if (!terminalId && currentState.activeWorkspaceId) {
      const workspaceTerminals = workspaceStore.getWorkspaceTerminals(currentState.activeWorkspaceId)
      if (workspaceTerminals.length > 0) {
        terminalId = workspaceTerminals[0].id
      }
    }

    if (terminalId) {
      host.pty.write(terminalId, content)
    } else {
      console.warn('No terminal available to paste to')
    }
  }, [])

  // Send content to active Claude agent session
  const handleSendToAgent = useCallback((content: string) => {
    const currentState = workspaceStore.getState()
    // Find focused agent terminal, or first agent in active workspace
    let terminalId = currentState.focusedTerminalId
    let terminal: TerminalInstance | undefined

    if (terminalId) {
      terminal = currentState.terminals.find(t => t.id === terminalId)
      // If focused terminal is not an agent, find the first agent
      if (!terminal?.agentPreset || terminal.agentPreset === 'none') {
        terminal = undefined
        terminalId = null
      }
    }

    if (!terminalId && currentState.activeWorkspaceId) {
      const workspaceTerminals = workspaceStore.getWorkspaceTerminals(currentState.activeWorkspaceId)
      terminal = workspaceTerminals.find(t => t.agentPreset && t.agentPreset !== 'none')
      terminalId = terminal?.id ?? null
    }

    if (terminalId) {
      host.claude.sendMessage(terminalId, content)
    } else {
      console.warn('No Claude agent session available')
    }
  }, [])

  // Open profile in a new app instance (or focus if already open)
  const handleProfileNewWindow = useCallback(async (profileId: string) => {
    const result = await host.app.openNewInstance(profileId)
    if (result?.alreadyOpen) {
      setAppNotification(t('profiles.alreadyOpen'))
    }
    setShowProfiles(false)
  }, [t])

  const resolveProfileWindowClose = useCallback(async (action: ProfileWindowCloseAction) => {
    setProfileWindowCloseRequest(null)
    try {
      await host.app.resolveProfileWindowClose(action)
    } catch (err) {
      await host.debug.log('[App] resolveProfileWindowClose failed', {
        action,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {})
    }
  }, [])

  // Get the workspace for env dialog
  const envDialogWorkspace = envDialogWorkspaceId
    ? state.workspaces.find(w => w.id === envDialogWorkspaceId)
    : null

  // Filter out detached workspaces from main window
  const visibleWorkspaces = state.workspaces.filter(w => !detachedIds.has(w.id))
  // Workspace switches do not change the terminal collection. Keep each
  // workspace's array referentially stable so memoized hidden views do not
  // reconcile every mounted terminal and message timeline on every switch.
  const terminalsByWorkspace = useMemo(() => {
    const grouped = new Map<string, TerminalInstance[]>()
    for (const terminal of state.terminals) {
      const terminals = grouped.get(terminal.workspaceId)
      if (terminals) terminals.push(terminal)
      else grouped.set(terminal.workspaceId, [terminal])
    }
    return grouped
  }, [state.terminals])

  useEffect(() => {
    if (host.debug.isDebugMode !== true) return
    const mounted = Array.from(mountedWorkspaces).join(',')
    const activeTerms = state.activeWorkspaceId
      ? state.terminals
        .filter(term => term.workspaceId === state.activeWorkspaceId)
        .map(term => `${term.id.slice(0, 8)}:${term.title || term.agentPreset || 'terminal'}`)
        .join(',')
      : ''
    const summary = [
      `visible=${visibleWorkspaces.length}`,
      `mounted=${mounted || 'none'}`,
      `activeWs=${state.activeWorkspaceId || 'none'}`,
      `focused=${state.focusedTerminalId || 'none'}`,
      `activeTerm=${state.activeTerminalId || 'none'}`,
      `terms=[${activeTerms}]`,
    ].join(' ')
    if (summary === lastRenderSummaryRef.current) return
    lastRenderSummaryRef.current = summary
    void host.debug.log(`[App] render ${summary}`)
  }, [visibleWorkspaces.length, mountedWorkspaces, state.activeWorkspaceId, state.activeTerminalId, state.focusedTerminalId, state.terminals])

  // Detached window mode — render only that workspace, no sidebar
  if (detachedWorkspaceId) {
    const ws = state.workspaces.find(w => w.id === detachedWorkspaceId)
    if (!ws) {
      return (
        <div className="app">
          <main className="main-content">
            <div className="empty-state">
              <h2>{t('app.workspaceNotFound')}</h2>
              <p>{t('app.workspaceNotFoundDesc')}</p>
            </div>
          </main>
        </div>
      )
    }
    return (
      <div className="app">
        <main className="main-content" style={{ width: '100%' }}>
          <div className="workspace-container active">
            <WorkspaceView
              workspace={ws}
              terminals={terminalsByWorkspace.get(ws.id) ?? EMPTY_TERMINALS}
              focusedTerminalId={state.focusedTerminalId}
              isActive={true}
              isRemoteConnected={isRemoteConnected}
            />
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="app">
      <UpdateBanner />
      <Sidebar
        width={panelSettings.sidebar.width}
        workspaces={visibleWorkspaces}
        activeWorkspaceId={state.activeWorkspaceId}
        windowId={currentWindowId}
        groups={workspaceStore.getGroups()}
        activeGroup={workspaceStore.getActiveGroup()}
        onSetActiveGroup={(group) => workspaceStore.setActiveGroup(group)}
        onSetWorkspaceGroup={(id, group) => workspaceStore.setWorkspaceGroup(id, group)}
        onSelectWorkspace={(id) => workspaceStore.setActiveWorkspace(id)}
        onAddWorkspace={handleAddWorkspace}
        onRemoveWorkspace={(id) => {
          workspaceStore.removeWorkspace(id)
          workspaceStore.save()
        }}
        onRenameWorkspace={(id, alias) => {
          workspaceStore.renameWorkspace(id, alias)
          workspaceStore.save()
        }}
        onReorderWorkspaces={(workspaceIds) => {
          workspaceStore.reorderWorkspaces(workspaceIds)
        }}
        onOpenEnvVars={(workspaceId) => setEnvDialogWorkspaceId(workspaceId)}
        onDetachWorkspace={handleDetachWorkspace}
        activeProfileName={activeProfileName}
        isRemoteConnected={isRemoteConnected}
        onOpenProfiles={() => setShowProfiles(true)}
        onOpenSettings={() => setShowSettings(true)}
      />
      <ResizeHandle
        direction="horizontal"
        onResize={handleSidebarResize}
        onDoubleClick={handleSidebarResetWidth}
      />
      <main className="main-content">
        {visibleWorkspaces.length > 0 ? (
          // Only mount workspaces that have been visited (lazy mount)
          visibleWorkspaces.filter(w => mountedWorkspaces.has(w.id) || w.id === state.activeWorkspaceId).map(workspace => (
            <div
              key={workspace.id}
              className={`workspace-container ${workspace.id === state.activeWorkspaceId ? 'active' : 'hidden'}`}
            >
              <WorkspaceView
                workspace={workspace}
                terminals={terminalsByWorkspace.get(workspace.id) ?? EMPTY_TERMINALS}
                focusedTerminalId={workspace.id === state.activeWorkspaceId
                  ? state.focusedTerminalId
                  : workspace.focusedTerminalId ?? null}
                isActive={workspace.id === state.activeWorkspaceId}
                isRemoteConnected={isRemoteConnected}
              />
            </div>
          ))
        ) : (
          <div className="empty-state">
            <h2>{t('app.welcome')}</h2>
            <p>{t('app.welcomeHint')}</p>
          </div>
        )}
      </main>
      {/* Resize handle for snippet sidebar */}
      {showSnippetSidebar && !panelSettings.snippetSidebar.collapsed && (
        <ResizeHandle
          direction="horizontal"
          onResize={handleSnippetResize}
          onDoubleClick={handleSnippetResetWidth}
        />
      )}
      {/* Right sidebar: tabbed Snippets / Skills (Skills only for Claude Code terminals) */}
      {(() => {
        const focusedTerminal = state.focusedTerminalId ? state.terminals.find(t2 => t2.id === state.focusedTerminalId) : null
        const isClaudeCode = focusedTerminal?.agentPreset === 'claude-code' || focusedTerminal?.agentPreset === 'claude-code-v2'
        const effectiveTab = isClaudeCode ? rightPanelTab : 'snippets'

        if (!showSnippetSidebar) return null

        if (panelSettings.snippetSidebar.collapsed) {
          return (
            <div className="right-sidebar-collapsed">
              <button className="right-sidebar-collapsed-btn" onClick={() => handleRightPanelTabChange('snippets')} title={t('snippets.expandSnippets')}>
                {'\u{1F4DD}'}
              </button>
              {isClaudeCode && (
                <button className="right-sidebar-collapsed-btn" onClick={() => handleRightPanelTabChange('skills')} title={t('skills.expandSkills')}>
                  {'\u{26A1}'}
                </button>
              )}
            </div>
          )
        }

        // Markdown preview mode: takes over the entire right panel
        if (previewMarkdownPath) {
          return (
            <div className="right-sidebar-wrapper" style={{ width: `${panelSettings.snippetSidebar.width}px`, minWidth: `${panelSettings.snippetSidebar.width}px`, display: 'flex', flexDirection: 'column' }}>
              <MarkdownPreviewPanel
                filePath={previewMarkdownPath}
                onClose={() => {
                  setPreviewMarkdownPath(null)
                  // Restore panel collapsed state from before the preview opened
                  if (previewPrevCollapsed.current !== null) {
                    const wasCollapsed = previewPrevCollapsed.current
                    previewPrevCollapsed.current = null
                    if (wasCollapsed) {
                      setPanelSettings(prev => {
                        const updated = { ...prev, snippetSidebar: { ...prev.snippetSidebar, collapsed: true } }
                        savePanelSettings(updated)
                        return updated
                      })
                    }
                  }
                }}
              />
            </div>
          )
        }

        return (
          <div className="right-sidebar-wrapper" style={{ width: `${panelSettings.snippetSidebar.width}px`, minWidth: `${panelSettings.snippetSidebar.width}px`, display: 'flex', flexDirection: 'column' }}>
            <div className="right-sidebar-tabs">
              <button className={`right-sidebar-tab${effectiveTab === 'snippets' ? ' active' : ''}`} onClick={() => handleRightPanelTabChange('snippets')}>
                {t('snippets.title')}
              </button>
              {isClaudeCode && (
                <>
                  <button className={`right-sidebar-tab${effectiveTab === 'skills' ? ' active' : ''}`} onClick={() => handleRightPanelTabChange('skills')}>
                    {t('skills.title')}
                  </button>
                  <button className={`right-sidebar-tab${effectiveTab === 'agents' ? ' active' : ''}`} onClick={() => handleRightPanelTabChange('agents')}>
                    {t('agents.title')}
                  </button>
                </>
              )}
              <button className="right-sidebar-collapse" onClick={handleSnippetCollapse} title={t('snippets.collapsePanel')}>&raquo;</button>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {effectiveTab === 'skills' ? (
                <SkillsPanel
                  isVisible={true}
                  width={panelSettings.snippetSidebar.width}
                  collapsed={false}
                  onCollapse={handleSnippetCollapse}
                  activeCwd={state.activeWorkspaceId ? state.workspaces.find(w => w.id === state.activeWorkspaceId)?.folderPath ?? null : null}
                  activeSessionId={state.focusedTerminalId ?? null}
                />
              ) : effectiveTab === 'agents' ? (
                <AgentsPanel
                  isVisible={true}
                  activeSessionId={state.focusedTerminalId ?? null}
                />
              ) : (
                <SnippetSidebar
                  isVisible={true}
                  width={panelSettings.snippetSidebar.width}
                  collapsed={false}
                  workspaceId={state.activeWorkspaceId ?? undefined}
                  onCollapse={handleSnippetCollapse}
                  onPasteToTerminal={handlePasteToTerminal}
                  onSendToAgent={handleSendToAgent}
                />
              )}
            </div>
          </div>
        )
      })()}
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
      {folderPickerOpen && (
        <FolderPicker
          initialPath={folderPickerInitialPath}
          multiSelect
          onSelect={handleFolderPickerSelect}
          onClose={() => setFolderPickerOpen(false)}
        />
      )}
      {showProfiles && (
        <ProfilePanel
          onClose={() => setShowProfiles(false)}
          onSwitchNewWindow={handleProfileNewWindow}
          onProfileRenamed={async (profileId, newName) => {
            const wpId = await host.app.getWindowProfile()
            if (wpId === profileId) {
              const winIdx = await host.app.getWindowIndex()
              setActiveProfileName(`${newName}:${winIdx}`)
            }
          }}
        />
      )}
      {envDialogWorkspace && (
        <WorkspaceEnvDialog
          workspace={envDialogWorkspace}
          onAdd={(envVar: EnvVariable) => workspaceStore.addWorkspaceEnvVar(envDialogWorkspaceId!, envVar)}
          onRemove={(key: string) => workspaceStore.removeWorkspaceEnvVar(envDialogWorkspaceId!, key)}
          onUpdate={(key: string, updates: Partial<EnvVariable>) => workspaceStore.updateWorkspaceEnvVar(envDialogWorkspaceId!, key, updates)}
          onClose={() => setEnvDialogWorkspaceId(null)}
        />
      )}
      {profileWindowCloseRequest && (
        <ProfileWindowCloseDialog
          request={profileWindowCloseRequest}
          profileName={activeProfileName.replace(/:\d+$/, '')}
          onTemporaryClose={() => resolveProfileWindowClose('temporary')}
          onRemoveFromProfile={() => resolveProfileWindowClose('removeFromProfile')}
          onCancel={() => resolveProfileWindowClose('cancel')}
        />
      )}
      {appNotification && (
        <div className="app-notification-overlay" onClick={() => setAppNotification(null)}>
          <div className="app-notification" onClick={e => e.stopPropagation()}>
            <div className="app-notification-message">{appNotification}</div>
            <button className="app-notification-close" onClick={() => setAppNotification(null)}>{t('common.ok')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
