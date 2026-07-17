import type { TerminalInstance } from '../types'

export function rememberMountedWorkspace(
  previous: ReadonlySet<string>,
  workspaceId: string,
): Set<string> {
  if (previous.has(workspaceId) && previous instanceof Set) return previous
  return new Set(previous).add(workspaceId)
}

type TerminalMountState = Pick<
  TerminalInstance,
  'agentPreset' | 'hasPendingAction' | 'isAgentRunning' | 'procfilePath'
>

export function shouldKeepTerminalPanelMounted(terminal: TerminalMountState): boolean {
  const isPlainTerminal = !terminal.agentPreset || terminal.agentPreset === 'none'

  return isPlainTerminal
    || terminal.isAgentRunning === true
    || terminal.hasPendingAction === true
    || Boolean(terminal.procfilePath)
    || terminal.agentPreset === 'claude-channel'
    || terminal.agentPreset === 'claude-cli-agent'
}
