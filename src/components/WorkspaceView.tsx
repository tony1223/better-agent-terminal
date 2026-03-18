import { useEffect, useCallback, useState, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workspace, TerminalInstance, EnvVariable } from '../types'
import { workspaceStore } from '../stores/workspace-store'
import { settingsStore } from '../stores/settings-store'
import { ThumbnailBar } from './ThumbnailBar'
import { CloseConfirmDialog } from './CloseConfirmDialog'
import { ResizeHandle } from './ResizeHandle'
import { AgentPresetId, getAgentPreset } from '../types/agent-presets'

// Lazy load heavy components (xterm.js, Claude SDK, etc.)
const MainPanel = lazy(() => import('./MainPanel').then(m => ({ default: m.MainPanel })))
const FileTree = lazy(() => import('./FileTree').then(m => ({ default: m.FileTree })))
const GitPanel = lazy(() => import('./GitPanel').then(m => ({ default: m.GitPanel })))

type WorkspaceTab = 'terminal' | 'files' | 'git'
const TAB_KEY = 'better-terminal-workspace-tab'

function loadWorkspaceTab(): WorkspaceTab {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    if (saved === 'terminal' || saved === 'files' || saved === 'git') return saved
  } catch { /* ignore */ }
  return 'terminal'
}

// ThumbnailBar panel settings
const THUMBNAIL_SETTINGS_KEY = 'better-terminal-thumbnail-settings'
const DEFAULT_THUMBNAIL_HEIGHT = 180
const MIN_THUMBNAIL_HEIGHT = 80
const MAX_THUMBNAIL_HEIGHT = 400

interface ThumbnailSettings {
  height: number
  collapsed: boolean
}

function loadThumbnailSettings(): ThumbnailSettings {
  try {
    const saved = localStorage.getItem(THUMBNAIL_SETTINGS_KEY)
    if (saved) {
      return JSON.parse(saved)
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
}

// Helper to get shell path from settings
async function getShellFromSettings(): Promise<string | undefined> {
  const settings = settingsStore.getSettings()
  if (settings.shell === 'custom' && settings.customShellPath) {
    return settings.customShellPath
  }
  return window.electronAPI.settings.getShellPath(settings.shell)
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

// Track which workspaces have been initialized (outside component to persist across renders)
const initializedWorkspaces = new Set<string>()

// Allow clearing on profile switch so terminals re-initialize
export function clearInitializedWorkspaces(): void {
  initializedWorkspaces.clear()
}

export function WorkspaceView({ workspace, terminals, focusedTerminalId, isActive }: Readonly<WorkspaceViewProps>) {
  const { t } = useTranslation()
  const [showCloseConfirm, setShowCloseConfirm] = useState<string | null>(null)
  const [thumbnailSettings, setThumbnailSettings] = useState<ThumbnailSettings>(loadThumbnailSettings)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(loadWorkspaceTab)

  const handleTabChange = useCallback((tab: WorkspaceTab) => {
    setActiveTab(tab)
    try { localStorage.setItem(TAB_KEY, tab) } catch { /* ignore */ }
  }, [])

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

  // Initialize terminals when workspace becomes active
  // If terminals were restored from a saved profile, start their PTY/agent processes
  // If no terminals exist, create default ones from settings
  useEffect(() => {
    if (!isActive || initializedWorkspaces.has(workspace.id)) return
    initializedWorkspaces.add(workspace.id)

    const initTerminals = async () => {
      const dlog = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)
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
          if (terminal.agentPreset === 'claude-code') continue
          window.electronAPI.pty.create({
            id: terminal.id,
            cwd: terminal.cwd || workspace.folderPath,
            type: 'terminal',
            agentPreset: terminal.agentPreset,
            shell,
            customEnv
          })
          // Auto-run agent command for non-Claude agents
          if (terminal.agentPreset && terminal.agentPreset !== 'none' && settings.agentAutoCommand) {
            const preset = getAgentPreset(terminal.agentPreset)
            if (preset?.command) {
              setTimeout(() => {
                window.electronAPI.pty.write(terminal.id, preset.command + '\r')
              }, 500)
            }
          }
        }
      } else {
        // No terminals: create defaults from settings
        const terminalCount = settings.defaultTerminalCount || 1
        const createAgentTerminal = settings.createDefaultAgentTerminal === true
        const defaultAgent = createAgentTerminal
          ? (workspace.defaultAgent || settings.defaultAgent || 'claude')
          : 'none'

        if (createAgentTerminal) {
          const agentTerminal = workspaceStore.addTerminal(workspace.id, defaultAgent as AgentPresetId)
          if (defaultAgent !== 'claude-code') {
            window.electronAPI.pty.create({
              id: agentTerminal.id,
              cwd: workspace.folderPath,
              type: 'terminal',
              agentPreset: defaultAgent as AgentPresetId,
              shell,
              customEnv
            })
            if (settings.agentAutoCommand) {
              const preset = getAgentPreset(defaultAgent)
              if (preset?.command) {
                setTimeout(() => {
                  window.electronAPI.pty.write(agentTerminal.id, preset.command + '\r')
                }, 500)
              }
            }
          }
        }

        for (let i = 0; i < terminalCount; i++) {
          const terminal = workspaceStore.addTerminal(workspace.id)
          window.electronAPI.pty.create({
            id: terminal.id,
            cwd: workspace.folderPath,
            type: 'terminal',
            shell,
            customEnv
          })
        }
        // Persist newly created default terminals
        workspaceStore.save()
      }
      dlog(`[init] initTerminals total: ${(performance.now() - t0).toFixed(0)}ms, terminals=${terminals.length}`)
      dlog(`[startup] initTerminals done: +${Date.now() - htmlT0}ms from HTML`)
    }
    initTerminals()
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
    window.electronAPI.pty.create({
      id: terminal.id,
      cwd: workspace.folderPath,
      type: 'terminal',
      shell,
      customEnv
    })
    // Focus the new terminal
    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
  }, [workspace.id, workspace.folderPath, workspace.envVars])

  const handleAddClaudeAgent = useCallback(() => {
    const agentTerminal = workspaceStore.addTerminal(workspace.id, 'claude-code' as AgentPresetId)
    // Claude Agent SDK session will be started by ClaudeAgentPanel on mount
    workspaceStore.setFocusedTerminal(agentTerminal.id)
    workspaceStore.save()
  }, [workspace.id])

  const handleCloseTerminal = useCallback((id: string) => {
    const terminal = terminals.find(t => t.id === id)
    // Show confirm for agent terminals
    if (terminal?.agentPreset && terminal.agentPreset !== 'none') {
      setShowCloseConfirm(id)
    } else {
      // Regular terminals always use PTY
      window.electronAPI.pty.kill(id)
      workspaceStore.removeTerminal(id)
      workspaceStore.save()
    }
  }, [terminals])

  const handleConfirmClose = useCallback(() => {
    if (showCloseConfirm) {
      const terminal = terminals.find(t => t.id === showCloseConfirm)
      if (terminal?.agentPreset === 'claude-code') {
        window.electronAPI.claude.stopSession(showCloseConfirm)
      } else {
        window.electronAPI.pty.kill(showCloseConfirm)
      }
      workspaceStore.removeTerminal(showCloseConfirm)
      workspaceStore.save()
      setShowCloseConfirm(null)
    }
  }, [showCloseConfirm, terminals])

  const handleRestart = useCallback(async (id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (terminal) {
      if (terminal.agentPreset === 'claude-code') {
        // Stop and restart Claude session
        await window.electronAPI.claude.stopSession(id)
        await window.electronAPI.claude.startSession(id, { cwd: terminal.cwd })
      } else {
        const cwd = await window.electronAPI.pty.getCwd(id) || terminal.cwd
        const shell = await getShellFromSettings()
        await window.electronAPI.pty.restart(id, cwd, shell)
        workspaceStore.updateTerminalCwd(id, cwd)
      }
    }
  }, [terminals])

  const handleFocus = useCallback((id: string) => {
    workspaceStore.setFocusedTerminal(id)
  }, [])

  const handleReorderTerminals = useCallback((orderedIds: string[]) => {
    workspaceStore.reorderTerminals(orderedIds)
  }, [])

  // Determine what to show
  // mainTerminal: the currently focused or first available terminal
  const mainTerminal = focusedTerminal || agentTerminal || terminals[0]

  // Show all terminals in thumbnail bar (clicking switches focus)
  const thumbnailTerminals = terminals

  return (
    <div className="workspace-view">
      {/* Top tab bar: Terminal | Files | Git */}
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
                workspaceId={workspace.id}
              />
            </div>
          ))}
        </div>
      </Suspense>

      {activeTab === 'files' && (
        <Suspense fallback={<div className="loading-panel" />}>
          <div className="workspace-tab-content">
            <FileTree rootPath={workspace.folderPath} />
          </div>
        </Suspense>
      )}

      {activeTab === 'git' && (
        <Suspense fallback={<div className="loading-panel" />}>
          <div className="workspace-tab-content">
            <GitPanel workspaceFolderPath={workspace.folderPath} />
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
        onAddClaudeAgent={handleAddClaudeAgent}
        onReorder={handleReorderTerminals}
        showAddButton={true}
        height={thumbnailSettings.height}
        collapsed={thumbnailSettings.collapsed}
        onCollapse={handleThumbnailCollapse}
      />

      {showCloseConfirm && (
        <CloseConfirmDialog
          onConfirm={handleConfirmClose}
          onCancel={() => setShowCloseConfirm(null)}
        />
      )}
    </div>
  )
}
