/**
 * Single source of truth for the Claude model picker.
 *
 * The picker has two orthogonal axes — which model, and where auto-compact
 * kicks in — but the runtime protocol flattens them into one preset id
 * (`claude-opus-5:auto-compact-300k`). CLAUDE_MODEL_TABLE is the only place
 * that knows the product of the two; the lists and lookup maps below are all
 * derived, so adding a model is a one-line change here.
 *
 * Mirrored by node-sidecar/src/lib/models.mjs and the table in
 * src-tauri/src/commands/claude.rs. Drift guard: node-sidecar/tests/server.test.mjs.
 */

/** Auto-compact target in tokens. `null` is the `:1m` preset — no early compaction. */
export type ClaudeCompactWindow = number | null

export type ClaudeModelDef = {
  /** SDK model id, and the base of every preset id derived from it. */
  id: string
  /** Row label in the picker. */
  label: string
  /** Physical context window of the underlying model. */
  contextWindow: number
  /**
   * Auto-compact presets this model offers, in display order. Empty means the
   * model has no presets and the bare id is selected directly.
   */
  windows: ClaudeCompactWindow[]
  /** Description for preset-less models; preset rows derive their own. */
  description?: string
}

/** Ordered newest-first — the picker renders the rows in this order. */
export const CLAUDE_MODEL_TABLE: ClaudeModelDef[] = [
  { id: 'claude-opus-5', label: 'Opus 5', contextWindow: 1_000_000, windows: [200_000, 300_000, null] },
  { id: 'claude-fable-5', label: 'Fable 5', contextWindow: 1_000_000, windows: [200_000, 300_000, null] },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 1_000_000, windows: [200_000, 300_000, null] },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', contextWindow: 1_000_000, windows: [200_000, 300_000, 400_000, null] },
  { id: 'claude-opus-4-6', label: 'Opus 4.6 (1M)', contextWindow: 1_000_000, windows: [] },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', contextWindow: 1_000_000, windows: [200_000, 300_000, null] },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (1M)', contextWindow: 1_000_000, windows: [] },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    contextWindow: 200_000,
    windows: [],
    description: 'claude-haiku-4-5 · fast & lightweight',
  },
]

/**
 * Preset id naming convention: `<base>:auto-compact-<N>k` compacts at N*1000
 * tokens, `<base>:<N>m` disables early auto-compact on an N-million window.
 */
function compactPresetId(def: ClaudeModelDef, window: ClaudeCompactWindow): string {
  return window === null
    ? `${def.id}:${def.contextWindow / 1_000_000}m`
    : `${def.id}:auto-compact-${window / 1000}k`
}

/** Pill label for one compact window: `200K`, `300K`, `1M`. */
export function claudeCompactWindowLabel(def: ClaudeModelDef, window: ClaudeCompactWindow): string {
  return window === null ? `${def.contextWindow / 1_000_000}M` : `${window / 1000}K`
}

function displayNameFor(def: ClaudeModelDef, window: ClaudeCompactWindow): string {
  const label = claudeCompactWindowLabel(def, window)
  return window === null ? `${def.label} · ${label}` : `${def.label} · ${label} Auto-Compact`
}

function descriptionFor(def: ClaudeModelDef, window: ClaudeCompactWindow): string {
  return window === null
    ? `${def.id} · no early auto-compact`
    : `${def.id} · compact at ${claudeCompactWindowLabel(def, window)} tokens`
}

export type ClaudeModelInfo = {
  value: string
  displayName: string
  description: string
}

export const CLAUDE_BUILTIN_MODELS: ClaudeModelInfo[] = CLAUDE_MODEL_TABLE.flatMap(def =>
  def.windows.length === 0
    ? [{
        value: def.id,
        displayName: def.label,
        description: def.description ?? `${def.id} · ${def.contextWindow / 1_000_000}M context`,
      }]
    : def.windows.map(window => ({
        value: compactPresetId(def, window),
        displayName: displayNameFor(def, window),
        description: descriptionFor(def, window),
      })),
)

/**
 * Base ids plus the `model[1m]` alias the SDK emits for every 1M-capable
 * model. Doubles as the dedup set that keeps SDK-discovered models from
 * duplicating a builtin entry.
 */
export const CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS = new Map<string, number>(
  CLAUDE_MODEL_TABLE.flatMap(def => {
    const entries: [string, number][] = [[def.id, def.contextWindow]]
    if (def.contextWindow >= 1_000_000) entries.push([`${def.id}[1m]`, def.contextWindow])
    return entries
  }),
)

const CLAUDE_PRESET_AUTO_COMPACT = new Map<string, ClaudeCompactWindow>(
  CLAUDE_MODEL_TABLE.flatMap(def =>
    def.windows.map(window => [compactPresetId(def, window), window] as [string, ClaudeCompactWindow]),
  ),
)

const CLAUDE_PRESET_SDK_MODELS = new Map<string, string>(
  CLAUDE_MODEL_TABLE.flatMap(def =>
    def.windows.map(window => [compactPresetId(def, window), def.id] as [string, string]),
  ),
)

/** Bare id and `[1m]` alias both canonicalize to the model's `:1m` preset. */
const CLAUDE_CANONICAL_PRESETS = new Map<string, string>(
  CLAUDE_MODEL_TABLE.flatMap(def => {
    if (!def.windows.includes(null)) return []
    const preset = compactPresetId(def, null)
    return [[def.id, preset], [`${def.id}[1m]`, preset]] as [string, string][]
  }),
)

const CLAUDE_SELECTION_DISPLAY_NAMES = new Map<string, string>([
  ...CLAUDE_BUILTIN_MODELS.map(model => [model.value, model.displayName] as [string, string]),
  ...CLAUDE_MODEL_TABLE.flatMap(def => {
    const name = def.windows.includes(null) ? displayNameFor(def, null) : def.label
    return [[def.id, name], [`${def.id}[1m]`, name]] as [string, string][]
  }),
])

/** Default for fresh installs and for migrating away from retired model ids. */
export const CLAUDE_OPUS_47_1M_PRESET = 'claude-opus-4-7:1m'

const AUTO_COMPACT_PRESET = /^(.+):auto-compact-(\d+)k$/
const CONTEXT_ONLY_PRESET = /^(.+):(\d+)m$/

export function isClaudeModelPreset(model?: string): boolean {
  return !!model && CLAUDE_PRESET_AUTO_COMPACT.has(model)
}

export function normalizeClaudeModelSelection(model?: string): string | undefined {
  if (!model) return model
  return CLAUDE_CANONICAL_PRESETS.get(model) || model
}

/**
 * Claude Code takes the 1M window from a `[1m]` suffix on the model id and
 * strips it again before the request reaches the provider, so a bare id runs
 * at 200K however large the model's physical window is. `impliedWindow` is
 * what the preset id itself asked for, used only when the table has never
 * heard of the model.
 */
function withContextSuffix(baseId: string, impliedWindow = 0): string {
  const window = CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS.get(baseId) ?? impliedWindow
  return window > 200_000 ? `${baseId}[1m]` : baseId
}

/**
 * The model id to hand the CLI for a selection.
 *
 * Re-attaching `[1m]` is the whole point: dropping it made `:1m` and
 * `:auto-compact-300k` both resolve to a bare id that silently ran at 200K,
 * which in turn put the 300K compact target above the real window where it
 * could never fire.
 */
export function sdkModelForClaudeSelection(model?: string): string | undefined {
  if (!model) return undefined
  if (model.endsWith('[1m]')) return model
  const mapped = CLAUDE_PRESET_SDK_MODELS.get(model)
  if (mapped) return withContextSuffix(mapped)
  // Regex fallback so a preset minted by a newer host still resolves on an
  // older remote client. Past the table the preset id still names the window
  // it wants, and anything beyond 200K is only reachable on a 1M model.
  const auto = AUTO_COMPACT_PRESET.exec(model)
  if (auto) return withContextSuffix(auto[1], Number(auto[2]) * 1_000)
  const contextOnly = CONTEXT_ONLY_PRESET.exec(model)
  if (contextOnly) return withContextSuffix(contextOnly[1], Number(contextOnly[2]) * 1_000_000)
  return withContextSuffix(model)
}

export function autoCompactWindowForClaudeSelection(
  model: string | undefined,
  fallbackAutoCompactWindow?: number | null,
): number | null {
  if (model && CLAUDE_PRESET_AUTO_COMPACT.has(model)) {
    return CLAUDE_PRESET_AUTO_COMPACT.get(model) ?? null
  }
  return fallbackAutoCompactWindow ?? null
}

/** Physical context window of the underlying model, not the auto-compact target. */
export function contextWindowForClaudeSelection(model?: string): number | undefined {
  const sdkModel = sdkModelForClaudeSelection(model)
  if (!sdkModel) return undefined
  return CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS.get(sdkModel)
}

export function displayNameForClaudeSelection(model?: string): string {
  if (!model) return ''
  return CLAUDE_SELECTION_DISPLAY_NAMES.get(model) || model
}

/* ---- Two-axis picker ---- */

export type ClaudeModelPickerOption = {
  /** Preset id to hand to the runtime. */
  value: string
  /** Pill label: `200K`, `300K`, `1M`. */
  label: string
  window: ClaudeCompactWindow
}

export type ClaudeModelPickerRow = {
  /** Base model id, or the raw value for models without presets. */
  key: string
  label: string
  description: string
  source: 'builtin' | 'sdk'
  /** Empty means the row itself is the selection — no compact-window choice. */
  options: ClaudeModelPickerOption[]
}

/** The SDK reports the full-window variant as `<base>[<N>m]`, not `<base>:<N>m`. */
const SDK_CONTEXT_PRESET = /^(.+)\[(\d+)m\]$/
/** Display names carry the variant as `Opus 5 · 300K` or as a `(1M)` suffix. */
const TRAILING_WINDOW_PAREN = /\s*\(\d+[KM]\)$/

function parsePresetId(value: string): { base: string; window: ClaudeCompactWindow; label: string } | null {
  const compact = AUTO_COMPACT_PRESET.exec(value)
  if (compact) return { base: compact[1], window: Number(compact[2]) * 1000, label: `${compact[2]}K` }
  const full = CONTEXT_ONLY_PRESET.exec(value) || SDK_CONTEXT_PRESET.exec(value)
  if (full) return { base: full[1], window: null, label: `${full[2]}M` }
  return null
}

/** Row label: the model name without whatever window variant it was tagged with. */
function rowLabelFor(displayName: string, fallback: string): string {
  const base = (displayName || '').split(' · ')[0].replace(TRAILING_WINDOW_PAREN, '').trim()
  return base || fallback
}

/**
 * Collapse a flat preset list into one row per model, with the compact-window
 * choices as options. Works on SDK-discovered models too: anything that isn't
 * a preset id becomes a plain row with no options.
 */
export function groupClaudeModelRows(
  models: readonly { value: string; displayName: string; description: string; source?: string }[],
): ClaudeModelPickerRow[] {
  const labelById = new Map(CLAUDE_MODEL_TABLE.map(def => [def.id, def.label]))
  const rows: ClaudeModelPickerRow[] = []
  const byBase = new Map<string, ClaudeModelPickerRow>()
  const seen = new Set<string>()

  for (const model of models) {
    // Skip blanks rather than rendering an empty row, and drop repeats so a
    // duplicated id can't produce two identical pills.
    if (!model?.value || seen.has(model.value)) continue
    seen.add(model.value)
    const source = model.source === 'sdk' ? 'sdk' : 'builtin'
    const parsed = parsePresetId(model.value)
    if (!parsed) {
      rows.push({
        key: model.value,
        label: model.displayName,
        description: model.description,
        source,
        options: [],
      })
      continue
    }
    let row = byBase.get(parsed.base)
    if (!row) {
      row = {
        key: parsed.base,
        label: labelById.get(parsed.base) || rowLabelFor(model.displayName, parsed.base),
        description: parsed.base,
        source,
        options: [],
      }
      byBase.set(parsed.base, row)
      rows.push(row)
    }
    row.options.push({ value: model.value, label: parsed.label, window: parsed.window })
  }
  // Narrowest window first, no-early-compaction last. The builtin table is
  // already in that order; SDK-discovered presets arrive in whatever order the
  // host listed them.
  for (const row of rows) row.options.sort((a, b) => optionSize(a) - optionSize(b))
  return rows
}

/** Effective size of an option, treating the no-compaction preset as the full window. */
function optionSize(option: ClaudeModelPickerOption): number {
  return option.window ?? Number.POSITIVE_INFINITY
}

/**
 * Carry a compact-window choice across a model switch: exact match when the
 * target offers it, otherwise the largest window that doesn't exceed it, so
 * moving to a narrower model never silently turns compaction off.
 */
export function pickClaudeModelOption(
  row: ClaudeModelPickerRow,
  window: ClaudeCompactWindow | undefined,
): ClaudeModelPickerOption | undefined {
  if (row.options.length === 0) return undefined
  // Nothing to carry over (coming from a preset-less model): start at the
  // narrowest window rather than silently running with compaction off.
  if (window === undefined) return row.options[0]
  const exact = row.options.find(option => option.window === window)
  if (exact) return exact
  const desired = window ?? Number.POSITIVE_INFINITY
  const sorted = [...row.options].sort((a, b) => optionSize(a) - optionSize(b))
  const fits = sorted.filter(option => optionSize(option) <= desired)
  return fits.length > 0 ? fits[fits.length - 1] : sorted[0]
}

/** The value a row resolves to for a given carried-over compact window. */
export function claudeModelValueForRow(
  row: ClaudeModelPickerRow,
  window: ClaudeCompactWindow | undefined,
): string {
  return pickClaudeModelOption(row, window)?.value ?? row.key
}
