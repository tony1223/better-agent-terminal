// Mirror of renderer/src/utils/claude-model-presets.ts CLAUDE_MODEL_TABLE.
// Keep the table — and only the table — in sync; everything below is derived.
// Drift guard: see node-sidecar/tests/server.test.mjs.
//
// Fields: id (SDK model id / preset base), label (picker row), contextWindow
// (physical window), windows (auto-compact presets in tokens, null = the
// `:1m` preset with no early compaction, empty = no presets at all),
// description (preset-less models only; preset rows derive their own).
// Ordered newest-first — the picker renders the rows in this order.
export const CLAUDE_MODEL_TABLE = [
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

// Preset id naming convention: `<base>:auto-compact-<N>k` compacts at N*1000
// tokens; `<base>:<N>m` disables early auto-compact on an N-million window.
function compactPresetId(def, window) {
  return window === null
    ? `${def.id}:${def.contextWindow / 1_000_000}m`
    : `${def.id}:auto-compact-${window / 1000}k`
}

function compactWindowLabel(def, window) {
  return window === null ? `${def.contextWindow / 1_000_000}M` : `${window / 1000}K`
}

export const CLAUDE_BUILTIN_MODELS = CLAUDE_MODEL_TABLE.flatMap(def =>
  def.windows.length === 0
    ? [{
        value: def.id,
        displayName: def.label,
        description: def.description ?? `${def.id} · ${def.contextWindow / 1_000_000}M context`,
      }]
    : def.windows.map(window => ({
        value: compactPresetId(def, window),
        displayName: window === null
          ? `${def.label} · ${compactWindowLabel(def, window)}`
          : `${def.label} · ${compactWindowLabel(def, window)} Auto-Compact`,
        description: window === null
          ? `${def.id} · no early auto-compact`
          : `${def.id} · compact at ${compactWindowLabel(def, window)} tokens`,
      })),
)

// Dedup set for SDK-discovered models. Note it includes the `[1m]` variants of
// base ids (which the builtin model list itself doesn't carry, but the SDK
// does emit), so SDK results that duplicate a builtin via either form get
// filtered. Mirrors the keys of the renderer-side
// CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS.
export const CLAUDE_BUILTIN_DEDUP_KEYS = CLAUDE_MODEL_TABLE.flatMap(def =>
  def.contextWindow >= 1_000_000 ? [def.id, `${def.id}[1m]`] : [def.id],
)

// Used by claude.getContextUsage to compute the maxTokens budget. Base ids map
// to the physical window; preset ids map to the auto-compact target, since
// that is the budget a session actually runs against (`:1m` has no early
// compaction, so its budget is the full window).
export const CLAUDE_MODEL_CONTEXT_WINDOWS = new Map([
  ...CLAUDE_MODEL_TABLE.flatMap(def =>
    def.contextWindow >= 1_000_000
      ? [[def.id, def.contextWindow], [`${def.id}[1m]`, def.contextWindow]]
      : [[def.id, def.contextWindow]],
  ),
  ...CLAUDE_MODEL_TABLE.flatMap(def =>
    def.windows.map(window => [compactPresetId(def, window), window ?? def.contextWindow]),
  ),
])

export function expectedContextWindowForModel(model) {
  if (!model) return null
  if (CLAUDE_MODEL_CONTEXT_WINDOWS.has(model)) return CLAUDE_MODEL_CONTEXT_WINDOWS.get(model)
  // Fallback: strip any [1m] suffix and try base id.
  const base = model.replace(/\[1m\]$/, '')
  if (CLAUDE_MODEL_CONTEXT_WINDOWS.has(base)) return CLAUDE_MODEL_CONTEXT_WINDOWS.get(base)
  return null
}

// Auto-compact presets wrap the underlying base model, and the compact window
// is configured separately via CLAUDE_CODE_AUTO_COMPACT_WINDOW env.
export const CLAUDE_PRESET_SDK_MODELS = new Map(
  CLAUDE_MODEL_TABLE.flatMap(def => def.windows.map(window => [compactPresetId(def, window), def.id])),
)

// The regex fallbacks keep presets working for remote clients even when a
// preset id is newer than the table above.
const AUTO_COMPACT_SUFFIX = /^(.+):auto-compact-(\d+)k$/
const CONTEXT_ONLY_SUFFIX = /^(.+):(\d+)m$/

// Physical window per base id, plus the `[1m]` alias of it. Deliberately not
// CLAUDE_MODEL_CONTEXT_WINDOWS, which maps preset ids to their compact target
// rather than to the window the model actually has.
const CLAUDE_BASE_CONTEXT_WINDOWS = new Map(
  CLAUDE_MODEL_TABLE.flatMap(def =>
    def.contextWindow >= 1_000_000
      ? [[def.id, def.contextWindow], [`${def.id}[1m]`, def.contextWindow]]
      : [[def.id, def.contextWindow]],
  ),
)

// Claude Code takes the 1M window from a `[1m]` suffix on the model id and
// strips it again before the request reaches the provider, so a bare id runs
// at 200K however large the model's physical window is. `impliedWindow` is
// what the preset id itself asked for, used only when the table has never
// heard of the model.
function withContextSuffix(baseId, impliedWindow = 0) {
  const window = CLAUDE_BASE_CONTEXT_WINDOWS.get(baseId) ?? impliedWindow
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
export function sdkModelForClaudeSelection(model) {
  if (!model) return undefined
  if (model.endsWith('[1m]')) return model
  const mapped = CLAUDE_PRESET_SDK_MODELS.get(model)
  if (mapped) return withContextSuffix(mapped)
  // Past the table: the preset id still names the window it wants, and
  // anything beyond 200K is only reachable on a 1M model.
  const auto = AUTO_COMPACT_SUFFIX.exec(model)
  if (auto) return withContextSuffix(auto[1], Number(auto[2]) * 1_000)
  const contextOnly = CONTEXT_ONLY_SUFFIX.exec(model)
  if (contextOnly) return withContextSuffix(contextOnly[1], Number(contextOnly[2]) * 1_000_000)
  return withContextSuffix(model)
}

// Auto-compact window a preset id encodes: a number for auto-compact
// presets, null for context-only presets (clear any early compaction),
// undefined for plain model ids (leave the session's window untouched).
export function autoCompactWindowForClaudeSelection(model) {
  if (typeof model !== 'string') return undefined
  const ac = AUTO_COMPACT_SUFFIX.exec(model)
  if (ac) return Number(ac[2]) * 1000
  return CONTEXT_ONLY_SUFFIX.test(model) ? null : undefined
}
