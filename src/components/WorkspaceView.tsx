import { useEffect, useCallback, useState, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workspace, TerminalInstance, EnvVariable } from '../types'
import { workspaceStore } from '../stores/workspace-store'
import { settingsStore } from '../stores/settings-store'
import { ThumbnailBar } from './ThumbnailBar'
import { CloseConfirmDialog } from './CloseConfirmDialog'
import { ResizeHandle } from './ResizeHandle'
import { FolderPicker } from './FolderPicker'
import { AgentPresetId, getAgentPreset, getVisiblePresets } from '../types/agent-presets'
import { isProcfileName } from '../utils/procfile-parser'

// Lazy load heavy components (xterm.js, Claude SDK, etc.)
const MainPanel = lazy(() => import('./MainPanel').then(m => ({ default: m.MainPanel })))
const FileTree = lazy(() => import('./FileTree').then(m => ({ default: m.FileTree })))
const GitPanel = lazy(() => import('./GitPanel').then(m => ({ default: m.GitPanel })))
const GitHubPanel = lazy(() => import('./GitHubPanel').then(m => ({ default: m.GitHubPanel })))

type WorkspaceTab = 'terminal' | 'files' | 'git' | 'github'
const TAB_KEY = 'better-terminal-workspace-tab'

function loadWorkspaceTab(): WorkspaceTab {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    if (saved === 'terminal' || saved === 'files' || saved === 'git' || saved === 'github') return saved
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
  isRemoteConnected?: boolean
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

function buildAgentAutoCommand(presetId: string, settings: ReturnType<typeof settingsStore.getSettings>): string | null {
  if (presetId === 'codex-cli') {
    return settings.allowBypassPermissions
      ? 'codex --yolo'
      : 'codex'
  }
  const preset = getAgentPreset(presetId)
  return preset?.command || null
}

// Track which workspaces have been initialized (outside component to persist across renders)
const initializedWorkspaces = new Set<string>()

// Allow clearing on profile switch so terminals re-initialize
export function clearInitializedWorkspaces(): void {
  initializedWorkspaces.clear()
}

export function WorkspaceView({ workspace, terminals, focusedTerminalId, isActive, isRemoteConnected = false }: Readonly<WorkspaceViewProps>) {
  const { t } = useTranslation()
  const [showCloseConfirm, setShowCloseConfirm] = useState<string | null>(null)
  const [thumbnailSettings, setThumbnailSettings] = useState<ThumbnailSettings>(loadThumbnailSettings)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(loadWorkspaceTab)
  const [hasGithubRemote, setHasGithubRemote] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [detectedProcfiles, setDetectedProcfiles] = useState<string[]>([])
  const [showProcfilePicker, setShowProcfilePicker] = useState(false)

  // Detect git repo, GitHub remote, and Procfiles
  useEffect(() => {
    window.electronAPI.git.getGithubUrl(workspace.folderPath).then(url => {
      setHasGithubRemote(!!url)
    }).catch(() => setHasGithubRemote(false))
    window.electronAPI.git.getRoot(workspace.folderPath).then(root => {
      setIsGitRepo(!!root)
    }).catch(() => setIsGitRepo(false))
    // Detect Procfiles in workspace folder
    window.electronAPI.fs.readdir(workspace.folderPath).then(entries => {
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
          // Worker terminals manage their own PTYs internally via WorkerPanel
          if (terminal.procfilePath) continue
          if (terminal.agentPreset === 'claude-code' || terminal.agentPreset === 'claude-code-v2' || terminal.agentPreset === 'claude-code-worktree' || terminal.agentPreset === 'codex-agent' || terminal.agentPreset === 'codex-agent-worktree') continue
          // claude-cli presets use startClaudeCliPty for bundled CLI + env setup
          if (terminal.agentPreset === 'claude-cli' || terminal.agentPreset === 'claude-cli-worktree') {
            startClaudeCliPty(terminal.id, terminal.cwd || workspace.folderPath, terminal.agentPreset === 'claude-cli-worktree')
            continue
          }
          window.electronAPI.pty.create({
            id: terminal.id,
            cwd: terminal.cwd || workspace.folderPath,
            type: 'terminal',
            agentPreset: terminal.agentPreset,
            shell,
            customEnv,
            perTerminalHistory: settings.perTerminalHistory,
            historyKey: terminal.historyKey,
          })
          // Auto-run agent command for non-Claude agents
          if (terminal.agentPreset && terminal.agentPreset !== 'none' && settings.agentAutoCommand) {
            const command = buildAgentAutoCommand(terminal.agentPreset, settings)
            if (command) {
              setTimeout(() => {
                window.electronAPI.pty.write(terminal.id, command + '\r')
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
          const agentTerminal = workspaceStore.addTerminal(workspace.id, defaultAgent as AgentPresetId)
          if (defaultAgent === 'codex-agent-worktree') {
            const wtResult = await window.electronAPI.worktree.create(agentTerminal.id, workspace.folderPath)
            if (wtResult.success && wtResult.worktreePath) {
              workspaceStore.updateTerminalCwd(agentTerminal.id, wtResult.worktreePath)
              workspaceStore.setTerminalWorktreeInfo(agentTerminal.id, wtResult.worktreePath, wtResult.branchName)
              workspaceStore.setTerminalGeneratedTitle(agentTerminal.id, 'Codex Agent (worktree)')
            }
          }
          if (defaultAgent === 'claude-cli' || defaultAgent === 'claude-cli-worktree') {
            startClaudeCliPty(agentTerminal.id, workspace.folderPath, defaultAgent === 'claude-cli-worktree')
          } else if (defaultAgent !== 'claude-code' && defaultAgent !== 'claude-code-v2' && defaultAgent !== 'claude-code-worktree' && defaultAgent !== 'codex-agent' && defaultAgent !== 'codex-agent-worktree') {
            window.electronAPI.pty.create({
              id: agentTerminal.id,
              cwd: workspace.folderPath,
              type: 'terminal',
              agentPreset: defaultAgent as AgentPresetId,
              shell,
              customEnv,
              perTerminalHistory: settings.perTerminalHistory,
              historyKey: agentTerminal.historyKey,
            })
            if (settings.agentAutoCommand) {
              const command = buildAgentAutoCommand(defaultAgent, settings)
              if (command) {
                setTimeout(() => {
                  window.electronAPI.pty.write(agentTerminal.id, command + '\r')
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
            customEnv,
            perTerminalHistory: settings.perTerminalHistory,
            historyKey: terminal.historyKey,
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
      customEnv,
      perTerminalHistory: settings.perTerminalHistory,
      historyKey: terminal.historyKey,
    })
    // Focus the new terminal
    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
  }, [workspace.id, workspace.folderPath, workspace.envVars])

  // Listen for keyboard shortcut events to create new terminals
  useEffect(() => {
    if (!isActive) return
    // Like `handleCloseTerminal` except with the current terminal ID filled in
    function handleAppCloseTerminalEvent(e: Event) {
      const { terminalId } = (e as CustomEvent).detail as { terminalId: string }
      // Only close terminal when in the terminal tab
      if (activeTab === 'terminal' && terminalId) {
        handleCloseTerminal(terminalId)
      }
    }
    window.addEventListener('workspace-add-terminal', handleAddTerminal)
    window.addEventListener('workspace-close-terminal', handleAppCloseTerminalEvent)
    return () => {
      window.removeEventListener('workspace-add-terminal', handleAddTerminal)
      window.removeEventListener('workspace-close-terminal', handleAppCloseTerminalEvent)
    }
  }, [isActive, activeTab])

  const handleAddWorktreeTerminal = useCallback(async () => {
    const terminal = workspaceStore.addTerminal(workspace.id)
    const wtResult = await window.electronAPI.worktree.create(terminal.id, workspace.folderPath)

    if (!wtResult.success || !wtResult.worktreePath) {
      workspaceStore.removeTerminal(terminal.id)
      workspaceStore.save()
      alert(wtResult.error || 'Failed to create worktree terminal.')
      return
    }

    const shell = await getShellFromSettings()
    const settings = settingsStore.getSettings()
    const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)

    workspaceStore.updateTerminalCwd(terminal.id, wtResult.worktreePath)
    workspaceStore.setTerminalWorktreeInfo(terminal.id, wtResult.worktreePath, wtResult.branchName)
    workspaceStore.setTerminalGeneratedTitle(terminal.id, 'Terminal (worktree)')

    window.electronAPI.pty.create({
      id: terminal.id,
      cwd: wtResult.worktreePath,
      type: 'terminal',
      shell,
      customEnv,
      perTerminalHistory: settings.perTerminalHistory,
      historyKey: terminal.historyKey,
    })

    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
  }, [workspace.id, workspace.folderPath, workspace.envVars])

  /** Create a claude-cli PTY terminal with bundled CLI, CLAUDE_CODE_NO_FLICKER, and optional worktree */
  const startClaudeCliPty = useCallback(async (terminalId: string, cwd: string, isWorktree: boolean) => {
    const settings = settingsStore.getSettings()
    const shell = await getShellFromSettings()
    const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)
    const cliPath = await window.electronAPI.claude.getCliPath()

    // Set up worktree if needed
    let effectiveCwd = cwd
    if (isWorktree) {
      const wtResult = await window.electronAPI.worktree.create(terminalId, cwd)
      if (wtResult.success && wtResult.worktreePath) {
        effectiveCwd = wtResult.worktreePath
        workspaceStore.setTerminalWorktreeInfo(terminalId, wtResult.worktreePath, wtResult.branchName)
      }
    }

    const termInst = workspaceStore.getState().terminals.find(t => t.id === terminalId)
    window.electronAPI.pty.create({
      id: terminalId,
      cwd: effectiveCwd,
      type: 'terminal',
      agentPreset: isWorktree ? 'claude-cli-worktree' as AgentPresetId : 'claude-cli' as AgentPresetId,
      shell,
      customEnv: {
        ...customEnv,
        CLAUDE_CODE_NO_FLICKER: '1',
      },
      perTerminalHistory: settingsStore.getSettings().perTerminalHistory,
      historyKey: termInst?.historyKey,
    })

    // Build CLI command using bundled CLI.
    // Since claude-code 2.1.113 the bundled CLI is a native binary (claude[.exe])
    // rather than cli.js — invoke directly instead of via `node`. Legacy cli.js
    // paths (ending in .js) still use the node launcher.
    // PowerShell needs `& "..."` to invoke a quoted executable path.
    // Worktree sessions start fresh (--continue would resume a session in git root)
    const isLegacyJs = /\.js$/i.test(cliPath)
    const isPowerShell = !!shell && /pwsh|powershell/i.test(shell)
    const cmdParts: string[] = []
    if (isLegacyJs) {
      cmdParts.push('node', `"${cliPath}"`)
    } else if (isPowerShell) {
      cmdParts.push('&', `"${cliPath}"`)
    } else {
      cmdParts.push(`"${cliPath}"`)
    }
    if (!isWorktree) {
      cmdParts.push('--continue')
    }
    if (settings.allowBypassPermissions) {
      cmdParts.push('--dangerously-skip-permissions')
    }
    const cmd = cmdParts.join(' ')

    setTimeout(() => {
      window.electronAPI.pty.write(terminalId, cmd + '\r')
    }, 500)
  }, [workspace.folderPath, workspace.envVars])

  const handleAddAgent = useCallback(async (presetId: string) => {
    const preset = getAgentPreset(presetId)
    if (!preset) return

    if (preset.backend === 'sdk') {
      const terminal = workspaceStore.addTerminal(workspace.id, presetId as AgentPresetId)
      if (presetId === 'codex-agent-worktree') {
        const wtResult = await window.electronAPI.worktree.create(terminal.id, workspace.folderPath)
        if (!wtResult.success || !wtResult.worktreePath) {
          workspaceStore.removeTerminal(terminal.id)
          workspaceStore.save()
          alert(wtResult.error || 'Failed to create Codex Agent worktree.')
          return
        }
        workspaceStore.updateTerminalCwd(terminal.id, wtResult.worktreePath)
        workspaceStore.setTerminalWorktreeInfo(terminal.id, wtResult.worktreePath, wtResult.branchName)
        workspaceStore.setTerminalGeneratedTitle(terminal.id, 'Codex Agent (worktree)')
      }
      workspaceStore.setFocusedTerminal(terminal.id)
      workspaceStore.save()
    } else if (preset.backend === 'cli') {
      const isWorktree = presetId === 'claude-cli-worktree'
      const terminal = workspaceStore.addTerminal(workspace.id, presetId as AgentPresetId)
      workspaceStore.setFocusedTerminal(terminal.id)
      workspaceStore.save()
      await startClaudeCliPty(terminal.id, workspace.folderPath, isWorktree)
    } else {
      // pty: generic PTY with auto-run command
      const terminal = workspaceStore.addTerminal(workspace.id, presetId as AgentPresetId)
      const shell = await getShellFromSettings()
      const settings = settingsStore.getSettings()
      const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)
      window.electronAPI.pty.create({
        id: terminal.id,
        cwd: workspace.folderPath,
        type: 'terminal',
        agentPreset: presetId as AgentPresetId,
        shell,
        customEnv,
        perTerminalHistory: settings.perTerminalHistory,
        historyKey: terminal.historyKey,
      })
      const command = buildAgentAutoCommand(presetId, settings)
      if (command && settings.agentAutoCommand) {
        setTimeout(() => {
          window.electronAPI.pty.write(terminal.id, command + '\r')
        }, 500)
      }
      workspaceStore.setFocusedTerminal(terminal.id)
      workspaceStore.save()
    }
  }, [workspace.id, workspace.folderPath, workspace.envVars, startClaudeCliPty])

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

  const isDebugMode = window.electronAPI?.debug?.isDebugMode

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
      window.electronAPI.pty.kill(id)
      workspaceStore.removeTerminal(id)
      workspaceStore.save()
    }
  }, [terminals])

  const handleConfirmClose = useCallback((cleanWorktree = false) => {
    if (showCloseConfirm) {
      const terminal = terminals.find(t => t.id === showCloseConfirm)
      if (terminal?.agentPreset === 'claude-code' || terminal?.agentPreset === 'claude-code-v2' || terminal?.agentPreset === 'claude-code-worktree' || terminal?.agentPreset === 'codex-agent' || terminal?.agentPreset === 'codex-agent-worktree') {
        window.electronAPI.claude.stopSession(showCloseConfirm)
        if (cleanWorktree && terminal?.agentPreset === 'claude-code-worktree') {
          window.electronAPI.claude.cleanupWorktree(showCloseConfirm, true)
        } else if (cleanWorktree && terminal?.agentPreset === 'codex-agent-worktree') {
          window.electronAPI.worktree.remove(showCloseConfirm, true)
        }
      } else {
        window.electronAPI.pty.kill(showCloseConfirm)
        // Clean up worktree for PTY-based worktree terminals
        if (cleanWorktree && terminal?.worktreePath) {
          window.electronAPI.worktree.remove(showCloseConfirm, true)
        }
      }
      workspaceStore.removeTerminal(showCloseConfirm)
      workspaceStore.save()
      setShowCloseConfirm(null)
    }
  }, [showCloseConfirm, terminals])

  const handleRestart = useCallback(async (id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (terminal) {
      if (terminal.agentPreset === 'claude-code' || terminal.agentPreset === 'claude-code-v2' || terminal.agentPreset === 'claude-code-worktree' || terminal.agentPreset === 'codex-agent' || terminal.agentPreset === 'codex-agent-worktree') {
        // Stop and restart Claude session
        await window.electronAPI.claude.stopSession(id)
        await window.electronAPI.claude.startSession(id, {
          cwd: terminal.cwd,
          agentPreset: terminal.agentPreset,
          ...(terminal.agentPreset === 'claude-code-worktree' || terminal.agentPreset === 'codex-agent-worktree' ? { useWorktree: true, worktreePath: terminal.worktreePath, worktreeBranch: terminal.worktreeBranch } : {}),
        })
      } else if (terminal.agentPreset === 'claude-cli' || terminal.agentPreset === 'claude-cli-worktree') {
        // Restart claude-cli PTY with bundled CLI
        await window.electronAPI.pty.kill(id)
        await startClaudeCliPty(id, terminal.cwd || workspace.folderPath, terminal.agentPreset === 'claude-cli-worktree')
      } else {
        const cwd = await window.electronAPI.pty.getCwd(id) || terminal.cwd
        const shell = await getShellFromSettings()
        await window.electronAPI.pty.restart(id, cwd, shell)
        workspaceStore.updateTerminalCwd(id, cwd)
      }
    }
  }, [terminals])

  const handleSwitchApiVersion = useCallback(async (id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (!terminal || (terminal.agentPreset !== 'claude-code' && terminal.agentPreset !== 'claude-code-v2')) return
    // Stop current session
    await window.electronAPI.claude.stopSession(id)
    // Switch agentPreset in store
    const newPreset = workspaceStore.switchTerminalApiVersion(id)
    if (!newPreset) return
    const newApiVersion = newPreset === 'claude-code-v2' ? 'v2' as const : 'v1' as const
    // Resume with the same sdkSessionId but new API version
    const sdkSessionId = terminal.sdkSessionId
    if (sdkSessionId) {
      await window.electronAPI.claude.resumeSession(id, sdkSessionId, terminal.cwd, terminal.model, newApiVersion, undefined, undefined, undefined, newPreset)
    } else {
      await window.electronAPI.claude.startSession(id, { cwd: terminal.cwd, apiVersion: newApiVersion })
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

  // Send content to the active Claude agent session
  const handleSendToClaude = useCallback(async (content: string) => {
    if (!agentTerminal) return false
    await window.electronAPI.claude.sendMessage(agentTerminal.id, content)
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
        agentPresets={getVisiblePresets().filter(p => p.id !== 'none' && (!p.needsGitRepo || isGitRepo))}
        onReorder={handleReorderTerminals}
        onCloseTerminal={handleCloseTerminal}
        showAddButton={true}
        height={thumbnailSettings.height}
        collapsed={thumbnailSettings.collapsed}
        onCollapse={handleThumbnailCollapse}
      />

      {showCloseConfirm && (
        <CloseConfirmDialog
          onConfirm={() => handleConfirmClose(false)}
          onCancel={() => setShowCloseConfirm(null)}
          isWorktree={!!terminals.find(t => t.id === showCloseConfirm)?.worktreePath}
          onConfirmAndClean={() => handleConfirmClose(true)}
        />
      )}
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
    </div>
  )
}
