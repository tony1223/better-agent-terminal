import type { AgentPresetId } from './agent-presets'
import { CODEX_EFFORT_LEVELS, type AgentParamValue } from './index'
import { settingsStore } from '../stores/settings-store'

export interface AgentParamOption {
  value: AgentParamValue
  label: string
}

export interface AgentParamDefinition {
  key: string
  label: string
  type: 'select' | 'boolean'
  defaultValue: AgentParamValue
  options?: AgentParamOption[]
}

function getCodexAgentParamDefinitions(): AgentParamDefinition[] {
  const settings = settingsStore.getSettings()
  const dangerousMode = settings.allowBypassPermissions === true
  const defaultEffort = settings.defaultCodexEffort && CODEX_EFFORT_LEVELS.includes(settings.defaultCodexEffort)
    ? settings.defaultCodexEffort
    : 'high'

  return [
    {
      key: 'sandboxMode',
      label: 'Codex sandbox mode',
      type: 'select',
      defaultValue: dangerousMode ? 'danger-full-access' : 'workspace-write',
      options: [
        { value: 'read-only', label: 'sandbox: read-only' },
        { value: 'workspace-write', label: 'sandbox: workspace-write' },
        { value: 'danger-full-access', label: 'sandbox: danger-full-access' },
      ],
    },
    {
      key: 'approvalPolicy',
      label: 'Codex approval policy',
      type: 'select',
      defaultValue: dangerousMode ? 'never' : 'on-request',
      options: [
        { value: 'untrusted', label: 'approval: untrusted' },
        { value: 'on-request', label: 'approval: on-request' },
        { value: 'never', label: 'approval: never' },
      ],
    },
    {
      key: 'effortLevel',
      label: 'Codex reasoning effort',
      type: 'select',
      defaultValue: defaultEffort,
      options: CODEX_EFFORT_LEVELS.map(level => ({ value: level, label: `effort: ${level}` })),
    },
  ]
}

function getAgentParamDefinitions(agentPreset?: AgentPresetId | null): AgentParamDefinition[] {
  if (agentPreset === 'codex-agent' || agentPreset === 'codex-agent-worktree') return getCodexAgentParamDefinitions()
  return []
}

function isValidAgentParamValue(definition: AgentParamDefinition, value: AgentParamValue | undefined): boolean {
  if (value === undefined) return false
  if (definition.type === 'boolean') return typeof value === 'boolean'
  if (definition.type === 'select') return !!definition.options?.some(option => option.value === value)
  return false
}

export function normalizeAgentParams(
  agentPreset?: AgentPresetId | null,
  params?: Record<string, AgentParamValue>,
): Record<string, AgentParamValue> | undefined {
  const definitions = getAgentParamDefinitions(agentPreset)
  if (definitions.length === 0) return params

  const normalized: Record<string, AgentParamValue> = { ...(params || {}) }
  for (const definition of definitions) {
    const currentValue = params?.[definition.key]
    normalized[definition.key] = isValidAgentParamValue(definition, currentValue)
      ? currentValue as AgentParamValue
      : definition.defaultValue
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}
