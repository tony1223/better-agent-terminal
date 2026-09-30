import { useCallback, useEffect, useRef, useState } from 'react'
import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import type { EnvVariable, TerminalInstance } from '../types'
import type { AgentPresetId } from '../types/agent-presets'
import { TerminalPanel } from './TerminalPanel'
import { isWorktreePreset, panelOfPreset } from '../../../shared/providers.mjs'

interface ClaudeCliPanelProps {
  terminal: TerminalInstance
  isActive: boolean
  onClose: (id: string) => void
  workspaceId?: string
}

interface ClaudeCliPrepareResult {
  sessionId: string
  launchMode: 'resume' | 'session'
  settingsPath: string
  cliPath?: string
  nodePath?: string
}

interface WorktreeCreateResult {
  success?: boolean
  worktreePath?: string
  branchName?: string
  error?: string
}

const startedClaudeCliTokens = new Set<string>()

const DEFAULT_PTY_COLS = 100
const DEFAULT_PTY_ROWS = 30

function mergeEnvVars(global: EnvVariable[] = [], workspace: EnvVariable[] = []): Record<string, string> {
  const result: Record<string, string> = {}
  for (const env of global) {
    if (env.enabled && env.key) result[env.key] = env.value
  }
  for (const env of workspace) {
    if (env.enabled && env.key) result[env.key] = env.value
  }
  return result
}

function buildClaudeLaunch(
  cliPath: string,
  settingsPath: string,
  sessionId: string,
  launchMode: 'resume' | 'session',
  nodePath: string | undefined,
  allowBypassPermissions: boolean,
): { command: string, args: string[] } {
  const args = [
    '--settings',
    settingsPath,
    launchMode === 'resume' ? '--resume' : '--session-id',
    sessionId,
  ]
  if (allowBypassPermissions) {
    args.push('--dangerously-skip-permissions')
  }

  if (/\.js$/i.test(cliPath)) {
    return { command: nodePath || 'node', args: [cliPath, ...args] }
  }
  if (/\.(?:cmd|bat)$/i.test(cliPath)) {
    return { command: 'cmd.exe', args: ['/D', '/C', cliPath, ...args] }
  }
  return { command: cliPath, args }
}

// Runtime check only: preset ids are plain strings (see shared/providers.json).
function isClaudeCliPreset(value: TerminalInstance['agentPreset']): boolean {
  return panelOfPreset(value) === 'claude-cli'
}

export function ClaudeCliPanel({ terminal, isActive, onClose, workspaceId }: Readonly<ClaudeCliPanelProps>) {
  const startedTokenRef = useRef<string | null>(null)
  const [readySize, setReadySize] = useState<{ cols: number, rows: number } | null>(null)
  const [ptyReady, setPtyReady] = useState(false)

  const handleReadySize = useCallback((size: { cols: number, rows: number }) => {
    const cols = Number.isFinite(size.cols) && size.cols > 0 ? Math.floor(size.cols) : DEFAULT_PTY_COLS
    const rows = Number.isFinite(size.rows) && size.rows > 0 ? Math.floor(size.rows) : DEFAULT_PTY_ROWS
    setReadySize(prev => (prev?.cols === cols && prev.rows === rows ? prev : { cols, rows }))
  }, [])

  useEffect(() => {
    if (!isClaudeCliPreset(terminal.agentPreset)) return
    const token = `${terminal.id}:${terminal.claudeCliRestartToken ?? 0}`
    setPtyReady(startedClaudeCliTokens.has(token))
  }, [terminal.agentPreset, terminal.claudeCliRestartToken, terminal.id])

  useEffect(() => {
    if (!isClaudeCliPreset(terminal.agentPreset)) return
    if (!readySize) return
    const token = `${terminal.id}:${terminal.claudeCliRestartToken ?? 0}`
    if (startedTokenRef.current === token || startedClaudeCliTokens.has(token)) {
      startedTokenRef.current = token
      setPtyReady(true)
      return
    }
    startedTokenRef.current = token
    let cancelled = false

    const start = async () => {
      const settings = settingsStore.getSettings()
      const workspace = workspaceStore.getState().workspaces.find(w => w.id === terminal.workspaceId)
      const customEnv = mergeEnvVars(settings.globalEnvVars, workspace?.envVars)
      const preset = terminal.agentPreset as AgentPresetId
      const isWorktree = isWorktreePreset(preset)
      let effectiveCwd = terminal.worktreePath || terminal.cwd || workspace?.folderPath || ''

      if (isWorktree && !terminal.worktreePath) {
        const wtResult = await host.worktree.create(
          terminal.id,
          terminal.cwd || workspace?.folderPath || effectiveCwd,
          settings.worktreePnpmInstallEnabled === true,
        ) as WorktreeCreateResult
        if (cancelled) return
        if (!wtResult.success || !wtResult.worktreePath) {
          alert(wtResult.error || 'Failed to create Claude CLI worktree.')
          return
        }
        effectiveCwd = wtResult.worktreePath
        workspaceStore.updateTerminalCwd(terminal.id, wtResult.worktreePath)
        workspaceStore.setTerminalWorktreeInfo(terminal.id, wtResult.worktreePath, wtResult.branchName)
        workspaceStore.setTerminalGeneratedTitle(terminal.id, 'Claude CLI (worktree)')
      }

      const prepared = await host.claude.prepareCliSession(
        terminal.id,
        workspaceId || terminal.workspaceId,
        effectiveCwd,
        preset,
        terminal.claudeCliSessionId,
      ) as ClaudeCliPrepareResult
      if (cancelled) return

      workspaceStore.setTerminalClaudeCliSessionId(terminal.id, prepared.sessionId)
      const cliPath = String(prepared.cliPath || await host.claude.getCliPath()).trim()
      if (!cliPath) {
        throw new Error('Claude CLI not found')
      }
      const launch = buildClaudeLaunch(
        cliPath,
        prepared.settingsPath,
        prepared.sessionId,
        prepared.launchMode,
        prepared.nodePath,
        settings.allowBypassPermissions,
      )
      try {
        await host.pty.create({
          id: terminal.id,
          cwd: effectiveCwd,
          type: 'terminal',
          agentPreset: preset,
          command: launch.command,
          args: launch.args,
          cols: readySize.cols,
          rows: readySize.rows,
          customEnv: {
            ...customEnv,
            CLAUDE_CODE_NO_FLICKER: '1',
          },
          perTerminalHistory: settings.perTerminalHistory,
          historyKey: terminal.historyKey,
        })
        if (cancelled) return
        startedClaudeCliTokens.add(token)
        setPtyReady(true)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!message.includes('already exists')) throw err
        if (cancelled) return
        startedClaudeCliTokens.add(token)
        setPtyReady(true)
      }
    }

    void start().catch(err => {
      const message = err instanceof Error ? err.message : String(err)
      void host.debug.log(`[ClaudeCliPanel] failed to start ${terminal.id}: ${message}`).catch(() => {})
    })

    return () => {
      cancelled = true
    }
  }, [
    terminal.id,
    terminal.agentPreset,
    terminal.claudeCliRestartToken,
    terminal.claudeCliSessionId,
    terminal.cwd,
    terminal.historyKey,
    terminal.worktreePath,
    terminal.workspaceId,
    readySize,
    workspaceId,
  ])

  return (
    <TerminalPanel
      terminalId={terminal.id}
      isActive={isActive}
      onClose={onClose}
      agentPreset={terminal.agentPreset}
      ptyReady={ptyReady}
      onReadySize={handleReadySize}
    />
  )
}
