import type { TerminalInstance } from '../types'
import { panelOfPreset } from '../../../shared/providers.mjs'

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
    || panelOfPreset(terminal.agentPreset) === 'claude-channel'
    || panelOfPreset(terminal.agentPreset) === 'claude-cli-agent'
}
