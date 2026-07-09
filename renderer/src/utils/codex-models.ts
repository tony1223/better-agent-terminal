import type { CodexEffortLevel } from '../types'
import { CODEX_EFFORT_LEVELS as CODEX_EFFORT_LEVELS_SOURCE } from '../types'

export type CodexModelInfo = {
  value: string
  displayName: string
  description: string
}

// Re-export the single source of truth (renderer/src/types) so callers that
// import from this module keep working without a second, drifting list.
export const CODEX_EFFORT_LEVELS: readonly CodexEffortLevel[] = CODEX_EFFORT_LEVELS_SOURCE

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'

export const CODEX_MODELS: CodexModelInfo[] = [
  { value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Newest frontier · recommended (ChatGPT login)' },
  { value: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Previous frontier GPT-5.5' },
  { value: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Flagship GPT-5.4' },
  { value: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', description: 'Fast GPT-5.4' },
  { value: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', description: 'GPT-5.3 · codex variant' },
  { value: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark', description: 'GPT-5.3 · lightweight codex' },
  { value: 'codex-mini-latest', displayName: 'Codex Mini', description: 'codex-mini · optimized for code' },
  { value: 'o4-mini', displayName: 'o4-mini', description: 'OpenAI o4-mini · fast reasoning' },
  { value: 'o3', displayName: 'o3', description: 'OpenAI o3 · reasoning model' },
  { value: 'gpt-4.1', displayName: 'GPT-4.1', description: 'OpenAI GPT-4.1' },
]

export function normalizeCodexEffort(value: unknown): CodexEffortLevel {
  return typeof value === 'string' && CODEX_EFFORT_LEVELS.includes(value as CodexEffortLevel)
    ? value as CodexEffortLevel
    : 'high'
}
