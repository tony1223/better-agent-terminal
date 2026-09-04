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

// `<model>:<N>k` rows are Better Agent Terminal presets (same convention as
// the Claude picker): the host strips the suffix before talking to the Codex
// app-server and sends a per-thread `model_context_window` override instead.
// The bare row uses whatever window the backend serves for the account.
export const CODEX_MODELS: CodexModelInfo[] = [
  { value: 'gpt-6-astra', displayName: 'GPT-6 Astra', description: 'Most capable · complex, demanding work' },
  { value: 'gpt-6-astra:272k', displayName: 'GPT-6 Astra (272K)', description: 'GPT-6 Astra · 272K context window' },
  { value: 'gpt-6-astra:872k', displayName: 'GPT-6 Astra (872K)', description: 'GPT-6 Astra · 872K context window' },
  { value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Flagship · complex, open-ended work' },
  { value: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'Balanced · everyday workhorse' },
  { value: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', description: 'Fast · clear, repeatable work' },
  { value: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark', description: 'Research preview · near-instant coding' },
  { value: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Previous frontier GPT-5.5' },
  { value: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Legacy · API-key authentication only' },
  { value: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', description: 'Legacy · API-key authentication only' },
  { value: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', description: 'Legacy · API-key authentication only' },
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
