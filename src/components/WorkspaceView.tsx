import { useEffect, useCallback, useState } from 'react'
import type { Workspace, TerminalInstance, EnvVariable } from '../types'
import { workspaceStore } from '../stores/workspace-store'
import { settingsStore } from '../stores/settings-store'
import { ThumbnailBar } from './ThumbnailBar'
import { CloseConfirmDialog } from './CloseConfirmDialog'
import { MainPanel } from './MainPanel'
import { AgentPresetId } from '../types/agent-presets'

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

export function WorkspaceView({ workspace, terminals, focusedTerminalId, isActive }: Readonly<WorkspaceViewProps>) {
  const [showCloseConfirm, setShowCloseConfirm] = useState<string | null>(null)

  // Categorize terminals
  const agentTerminal = terminals.find(t => t.agentPreset && t.agentPreset !== 'none')
  const focusedTerminal = terminals.find(t => t.id === focusedTerminalId)

  // Initialize first terminal when workspace loads (if no terminals exist)
  useEffect(() => {
    if (terminals.length === 0) {
      const createInitialTerminal = async () => {
        const defaultAgent = workspace.defaultAgent || settingsStore.getSettings().defaultAgent || 'none'
        const terminal = workspaceStore.addTerminal(workspace.id, defaultAgent as AgentPresetId)
        const shell = await getShellFromSettings()
        const settings = settingsStore.getSettings()
        const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)
        window.electronAPI.pty.create({
          id: terminal.id,
          cwd: workspace.folderPath,
          type: 'terminal',
          agentPreset: defaultAgent as AgentPresetId,
          shell,
          customEnv
        })
      }
      createInitialTerminal()
    }
  }, [workspace.id, terminals.length, workspace.defaultAgent, workspace.folderPath, workspace.envVars])

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
  }, [workspace.id, workspace.folderPath, workspace.envVars])

  const handleCloseTerminal = useCallback((id: string) => {
    const terminal = terminals.find(t => t.id === id)
    // Show confirm for agent terminals
    if (terminal?.agentPreset && terminal.agentPreset !== 'none') {
      setShowCloseConfirm(id)
    } else {
      window.electronAPI.pty.kill(id)
      workspaceStore.removeTerminal(id)
    }
  }, [terminals])

  const handleConfirmClose = useCallback(() => {
    if (showCloseConfirm) {
      window.electronAPI.pty.kill(showCloseConfirm)
      workspaceStore.removeTerminal(showCloseConfirm)
      setShowCloseConfirm(null)
    }
  }, [showCloseConfirm])

  const handleRestart = useCallback(async (id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (terminal) {
      const cwd = await window.electronAPI.pty.getCwd(id) || terminal.cwd
      const shell = await getShellFromSettings()
      await window.electronAPI.pty.restart(id, cwd, shell)
      workspaceStore.updateTerminalCwd(id, cwd)
    }
  }, [terminals])

  const handleFocus = useCallback((id: string) => {
    workspaceStore.setFocusedTerminal(id)
  }, [])

  // Determine what to show
  // mainTerminal: the currently focused or first available terminal
  const mainTerminal = focusedTerminal || agentTerminal || terminals[0]

  return (
    <div className="workspace-view">
      {/* Render ALL terminals, show/hide with CSS - keeps processes running */}
      <div className="terminals-container">
        {terminals.map(terminal => (
          <div
            key={terminal.id}
            className={`terminal-wrapper ${terminal.id === mainTerminal?.id ? 'active' : 'hidden'}`}
          >
            <MainPanel
              terminal={terminal}
              onClose={handleCloseTerminal}
              onRestart={handleRestart}
            />
          </div>
        ))}
      </div>

      <ThumbnailBar
        terminals={terminals}
        focusedTerminalId={mainTerminal?.id || null}
        onFocus={handleFocus}
        onAddTerminal={handleAddTerminal}
        showAddButton={true}
      />

      {
        showCloseConfirm && (
          <CloseConfirmDialog
            onConfirm={handleConfirmClose}
            onCancel={() => setShowCloseConfirm(null)}
          />
        )
      }
    </div >
  )
}
