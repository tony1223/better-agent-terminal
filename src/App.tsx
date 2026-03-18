import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { workspaceStore } from './stores/workspace-store'
import { settingsStore } from './stores/settings-store'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView, clearInitializedWorkspaces } from './components/WorkspaceView'
import { SettingsPanel } from './components/SettingsPanel'
import { SnippetSidebar } from './components/SnippetPanel'
import { WorkspaceEnvDialog } from './components/WorkspaceEnvDialog'
import { ResizeHandle } from './components/ResizeHandle'
import { ProfilePanel } from './components/ProfilePanel'
import type { AppState, EnvVariable } from './types'

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

export default function App() {
  const { t } = useTranslation()
  const [state, setState] = useState<AppState>(workspaceStore.getState())
  const [showSettings, setShowSettings] = useState(false)
  const [showProfiles, setShowProfiles] = useState(false)
  const [activeProfileName, setActiveProfileName] = useState<string>('Default')
  const [isRemoteConnected, setIsRemoteConnected] = useState(false)
  const [appNotification, setAppNotification] = useState<string | null>(null)
  const [envDialogWorkspaceId, setEnvDialogWorkspaceId] = useState<string | null>(null)
  // Snippet sidebar is always visible by default
  const [showSnippetSidebar] = useState(true)
  // Panel settings for resizable panels
  const [panelSettings, setPanelSettings] = useState<PanelSettings>(loadPanelSettings)
  // Detached workspace support
  const [detachedWorkspaceId] = useState(() => window.electronAPI.workspace.getDetachedId())
  const [detachedIds, setDetachedIds] = useState<Set<string>>(new Set())
  // Track workspaces that have been visited (for lazy mounting)
  const [mountedWorkspaces, setMountedWorkspaces] = useState<Set<string>>(new Set())

  // Sync window title with active profile
  useEffect(() => {
    document.title = `Better Terminal - ${activeProfileName}`
  }, [activeProfileName])

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

  useEffect(() => {
    const unsubscribe = workspaceStore.subscribe(() => {
      setState(workspaceStore.getState())
    })

    // Global listener for all terminal output - updates activity for ALL terminals
    // This is needed because WorkspaceView only renders terminals for the active workspace
    const unsubscribeOutput = window.electronAPI.pty.onOutput((id) => {
      workspaceStore.updateTerminalActivity(id)
    })

    // Load saved workspaces and settings on startup
    // If launched with --profile, use that profile instead of the stored active one
    const dlog = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)
    const htmlT0 = (window as unknown as { __t0?: number }).__t0 || Date.now()
    dlog(`[startup] App useEffect fired: +${Date.now() - htmlT0}ms from HTML`)
    const initProfile = async () => {
      const t0 = performance.now()
      try {
        const launchProfileId = await window.electronAPI.app.getLaunchProfile()
        dlog(`[init] getLaunchProfile: ${(performance.now() - t0).toFixed(0)}ms`)

        const t1 = performance.now()
        const result = await window.electronAPI.profile.list()
        dlog(`[init] profile.list: ${(performance.now() - t1).toFixed(0)}ms`)

        // Use launch profile if provided (new window), otherwise use stored active profile
        const active = launchProfileId
          ? result.profiles.find(p => p.id === launchProfileId)
          : result.profiles.find(p => p.id === result.activeProfileId)

        if (active?.type === 'remote' && active.remoteHost && active.remoteToken) {
          // Try connecting to remote
          const tRemote = performance.now()
          const connectResult = await window.electronAPI.remote.connect(
            active.remoteHost,
            active.remotePort || 9876,
            active.remoteToken
          )
          dlog(`[init] remote.connect: ${(performance.now() - tRemote).toFixed(0)}ms`)
          if ('error' in connectResult) {
            if (launchProfileId) {
              // New window launch failed — show error and close instead of corrupting shared state
              setAppNotification(t('app.remoteConnectionFailed', { error: connectResult.error }))
              setTimeout(() => window.close(), 3000)
              return
            }
            // Main window: fall back to first local profile
            const localProfile = result.profiles.find(p => p.type !== 'remote')
            if (localProfile) {
              await window.electronAPI.profile.load(localProfile.id)
              setActiveProfileName(localProfile.name)
            }
          } else {
            setActiveProfileName(active.name)
            setIsRemoteConnected(true)
          }
        } else if (active?.type === 'remote') {
          // Remote profile missing connection info — fall back
          if (launchProfileId) {
            setAppNotification(t('app.remoteMissingInfo'))
            setTimeout(() => window.close(), 3000)
            return
          }
          const localProfile = result.profiles.find(p => p.type !== 'remote')
          if (localProfile) {
            await window.electronAPI.profile.load(localProfile.id)
            setActiveProfileName(localProfile.name)
          }
        } else if (active) {
          setActiveProfileName(active.name)
        } else if (result.profiles.length > 0) {
          // Fallback: activeProfileId didn't match any profile — use first local profile
          const fallback = result.profiles.find(p => p.type !== 'remote') || result.profiles[0]
          setActiveProfileName(fallback.name)
        }

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

    // Listen for system resume from sleep/hibernate — refresh remote connection status
    const unsubSystemResume = window.electronAPI.system.onResume(() => {
      window.electronAPI.remote.clientStatus().then(s => setIsRemoteConnected(s.connected))
    })

    // Listen for workspace detach/reattach events (main window only)
    const unsubDetach = window.electronAPI.workspace.onDetached((wsId) => {
      setDetachedIds(prev => new Set(prev).add(wsId))
    })
    const unsubReattach = window.electronAPI.workspace.onReattached((wsId) => {
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
      unsubDetach()
      unsubReattach()
    }
  }, [])

  // Poll remote client connection status
  useEffect(() => {
    const check = () => {
      window.electronAPI.remote.clientStatus().then(s => setIsRemoteConnected(s.connected))
    }
    check()
    const interval = setInterval(check, 3000)
    return () => clearInterval(interval)
  }, [])

  const handleAddWorkspace = useCallback(async () => {
    const folderPath = await window.electronAPI.dialog.selectFolder()
    if (folderPath) {
      const name = folderPath.split(/[/\\]/).pop() || 'Workspace'
      workspaceStore.addWorkspace(name, folderPath)
      workspaceStore.save()
    }
  }, [])

  const handleDetachWorkspace = useCallback(async (workspaceId: string) => {
    await window.electronAPI.workspace.detach(workspaceId)
  }, [])

  // Paste content to focused terminal
  const handlePasteToTerminal = useCallback((content: string) => {
    const currentState = workspaceStore.getState()
    // Try focused terminal first, then fall back to active terminal or first terminal in active workspace
    let terminalId = currentState.focusedTerminalId

    if (!terminalId && currentState.activeWorkspaceId) {
      const workspaceTerminals = workspaceStore.getWorkspaceTerminals(currentState.activeWorkspaceId)
      if (workspaceTerminals.length > 0) {
        terminalId = workspaceTerminals[0].id
      }
    }

    if (terminalId) {
      window.electronAPI.pty.write(terminalId, content)
    } else {
      console.warn('No terminal available to paste to')
    }
  }, [])

  // Handle profile switch: kill all terminals, load profile, reload store
  const handleProfileSwitch = useCallback(async (profileId: string) => {
    // Kill all running terminals and claude sessions
    const currentState = workspaceStore.getState()
    for (const terminal of currentState.terminals) {
      try { await window.electronAPI.pty.kill(terminal.id) } catch { /* ignore */ }
    }

    // Disconnect existing remote connection if any
    await window.electronAPI.remote.disconnect()

    // Check if this is a remote profile
    const profile = await window.electronAPI.profile.get(profileId)
    if (!profile) return

    if (profile.type === 'remote' && profile.remoteHost && profile.remoteToken) {
      // Connect to remote host
      const connectResult = await window.electronAPI.remote.connect(
        profile.remoteHost,
        profile.remotePort || 9876,
        profile.remoteToken
      )
      if ('error' in connectResult) {
        setAppNotification(t('app.remoteConnectionFailedFallback', { error: connectResult.error }))
        // Fall back to first local profile
        const listResult = await window.electronAPI.profile.list()
        const localProfile = listResult.profiles.find(p => p.type !== 'remote')
        if (localProfile) {
          await window.electronAPI.profile.load(localProfile.id)
          await workspaceStore.load()
          setActiveProfileName(localProfile.name)
        }
        setIsRemoteConnected(false)
        setShowProfiles(false)
        return
      }
      // Set as active profile (no local workspace load for remote)
      await window.electronAPI.profile.setActiveId(profileId)
    } else {
      // Load the local profile (writes to workspaces.json)
      const result = await window.electronAPI.profile.load(profileId)
      if (!result) return
    }

    // Clear workspace init tracking so terminals re-initialize after profile switch
    clearInitializedWorkspaces()

    // Reload workspace store from the (possibly remote) workspaces.json
    await workspaceStore.load()

    // Update active profile name and remote status
    const listResult = await window.electronAPI.profile.list()
    const active = listResult.profiles.find(p => p.id === listResult.activeProfileId)
    if (active) setActiveProfileName(active.name)
    setIsRemoteConnected(profile.type === 'remote')

    setShowProfiles(false)
  }, [])

  // Open profile in a new app instance
  const handleProfileNewWindow = useCallback(async (profileId: string) => {
    await window.electronAPI.app.openNewInstance(profileId)
    setShowProfiles(false)
  }, [])

  // Get the workspace for env dialog
  const envDialogWorkspace = envDialogWorkspaceId
    ? state.workspaces.find(w => w.id === envDialogWorkspaceId)
    : null

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
              terminals={workspaceStore.getWorkspaceTerminals(ws.id)}
              focusedTerminalId={state.focusedTerminalId}
              isActive={true}
            />
          </div>
        </main>
      </div>
    )
  }

  // Filter out detached workspaces from main window
  const visibleWorkspaces = state.workspaces.filter(w => !detachedIds.has(w.id))

  return (
    <div className="app">
      <Sidebar
        width={panelSettings.sidebar.width}
        workspaces={visibleWorkspaces}
        activeWorkspaceId={state.activeWorkspaceId}
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
          visibleWorkspaces.filter(w => mountedWorkspaces.has(w.id)).map(workspace => (
            <div
              key={workspace.id}
              className={`workspace-container ${workspace.id === state.activeWorkspaceId ? 'active' : 'hidden'}`}
            >
              <WorkspaceView
                workspace={workspace}
                terminals={workspaceStore.getWorkspaceTerminals(workspace.id)}
                focusedTerminalId={workspace.id === state.activeWorkspaceId ? state.focusedTerminalId : null}
                isActive={workspace.id === state.activeWorkspaceId}
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
      <SnippetSidebar
        isVisible={showSnippetSidebar}
        width={panelSettings.snippetSidebar.width}
        collapsed={panelSettings.snippetSidebar.collapsed}
        onCollapse={handleSnippetCollapse}
        onPasteToTerminal={handlePasteToTerminal}
      />
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
      {showProfiles && (
        <ProfilePanel onClose={() => setShowProfiles(false)} onSwitch={handleProfileSwitch} onSwitchNewWindow={handleProfileNewWindow} />
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
