import type { AgentPreset } from '../types/agent-presets'
import { presetMenuRank } from '../../../shared/providers.mjs'

export interface AgentPresetMenuGroups {
  standardAgents: AgentPreset[]
  standardCli: AgentPreset[]
  worktreeAgents: AgentPreset[]
  worktreeCli: AgentPreset[]
}

// Menu order is data: shared/providers.json `menuOrder`.
function presetOrder(preset: AgentPreset): number {
  return presetMenuRank(preset.id)
}

function isWorktreePreset(preset: AgentPreset): boolean {
  return preset.needsGitRepo === true || preset.id.endsWith('-worktree')
}

function isAgentPreset(preset: AgentPreset): boolean {
  return preset.backend === 'sdk' || preset.backend === 'channel'
}

function sortPresets(presets: AgentPreset[]): AgentPreset[] {
  return [...presets].sort((a, b) => presetOrder(a) - presetOrder(b) || a.name.localeCompare(b.name))
}

export function groupAgentPresetsForMenu(presets: AgentPreset[]): AgentPresetMenuGroups {
  return {
    standardAgents: sortPresets(presets.filter(preset => !isWorktreePreset(preset) && isAgentPreset(preset))),
    standardCli: sortPresets(presets.filter(preset => !isWorktreePreset(preset) && !isAgentPreset(preset))),
    worktreeAgents: sortPresets(presets.filter(preset => isWorktreePreset(preset) && isAgentPreset(preset))),
    worktreeCli: sortPresets(presets.filter(preset => isWorktreePreset(preset) && !isAgentPreset(preset))),
  }
}

export function worktreeMenuName(name: string): string {
  return name.replace(/\s*\(worktree\)$/i, '')
}
