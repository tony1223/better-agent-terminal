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

/* ---- Context-window presets ---- */

const CONTEXT_WINDOW_PRESET = /^(.+):(\d+)k$/
const TRAILING_WINDOW_PAREN = /\s*\(\d+[KM]\)$/

/** `gpt-6-astra:872k` → base model plus the window override; bare ids → null. */
export function splitCodexModelSelection(selection: string): { model: string; contextWindow: number | null } {
  const match = CONTEXT_WINDOW_PRESET.exec(selection)
  const thousands = match ? Number(match[2]) : 0
  if (match && thousands > 0) return { model: match[1], contextWindow: thousands * 1000 }
  return { model: selection, contextWindow: null }
}

export type CodexModelPickerOption = {
  /** Model id to hand to the host (bare id for the backend-default window). */
  value: string
  /** Pill label: `Default`, `272K`, `872K`. */
  label: string
  /** `null` is the backend default — no override sent. */
  contextWindow: number | null
}

export type CodexModelPickerRow = {
  /** Base model id. */
  key: string
  label: string
  description: string
  source: 'builtin' | 'sdk'
  /** Empty means the row itself is the selection — no window choice. */
  options: CodexModelPickerOption[]
}

/**
 * Collapse the flat model list into one row per base model, with the
 * context-window variants as pills (same layout as the Claude picker). A base
 * id that has variants becomes the row's `Default` option; models without
 * variants stay plain rows.
 */
export function groupCodexModelRows(
  models: readonly { value: string; displayName: string; description: string; source?: string }[],
): CodexModelPickerRow[] {
  const rows: CodexModelPickerRow[] = []
  const byBase = new Map<string, CodexModelPickerRow>()
  const seen = new Set<string>()
  const ensureRow = (base: string, model: { displayName: string; description: string; source?: string }) => {
    let row = byBase.get(base)
    if (!row) {
      row = {
        key: base,
        label: (model.displayName || '').replace(TRAILING_WINDOW_PAREN, '').trim() || base,
        description: model.description,
        source: model.source === 'sdk' ? 'sdk' : 'builtin',
        options: [],
      }
      byBase.set(base, row)
      rows.push(row)
    }
    return row
  }
  for (const model of models) {
    if (!model?.value || seen.has(model.value)) continue
    seen.add(model.value)
    const { model: base, contextWindow } = splitCodexModelSelection(model.value)
    if (contextWindow === null) {
      ensureRow(base, model)
      continue
    }
    const row = ensureRow(base, model)
    row.options.push({ value: model.value, label: `${Math.round(contextWindow / 1000)}K`, contextWindow })
  }
  // A base that gained variants needs an explicit "Default" pill so the
  // backend-default window stays selectable next to the overrides.
  for (const row of rows) {
    if (row.options.length === 0 || row.options.some(option => option.contextWindow === null)) continue
    row.options.unshift({ value: row.key, label: 'Default', contextWindow: null })
  }
  return rows
}

/**
 * Value a row resolves to when clicked: keep the current window override if
 * the target row offers it, otherwise fall back to the row's default.
 */
export function codexModelValueForRow(row: CodexModelPickerRow, carriedWindow: number | null | undefined): string {
  if (row.options.length === 0) return row.key
  const exact = carriedWindow === undefined ? undefined : row.options.find(option => option.contextWindow === carriedWindow)
  return (exact ?? row.options[0]).value
}

export function normalizeCodexEffort(value: unknown): CodexEffortLevel {
  return typeof value === 'string' && CODEX_EFFORT_LEVELS.includes(value as CodexEffortLevel)
    ? value as CodexEffortLevel
    : 'high'
}
