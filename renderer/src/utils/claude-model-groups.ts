// Two-axis presentation for the model picker.
//
// The wire format stays a flat list of preset ids — a model × context-window
// cross product (see claude-model-presets.ts) — because that is what the
// backend reports, what `claude.setModel` takes and what settings persist.
// Rendering that list one row per entry means the picker grows linearly every
// time a model gains another window, so instead we group it back into one row
// per model family with the windows as a segmented control.
//
// Parsing the preset id (rather than intersecting with a local table) keeps the
// picker working when the host reports a preset newer than this build knows —
// including remote hosts on a different version.

import { contextWindowForClaudeSelection } from './claude-model-presets'

// `<base>:auto-compact-<N>k` compacts early at N*1000 tokens.
const AUTO_COMPACT_SUFFIX = /^(.+):auto-compact-(\d+)k$/
// `<base>:<N>m` and the SDK-emitted `<base>[<N>m]` both mean "full window, no
// early compaction".
const CONTEXT_ONLY_SUFFIX = /^(.+):(\d+)m$/
const SDK_CONTEXT_SUFFIX = /^(.+)\[(\d+)m\]$/
// Display names carry the variant after a separator ('Opus 5 · 300K
// Auto-Compact') or in a trailing parenthetical ('Opus 4.6 (1M)'); the family
// row shows only the part before it.
const VARIANT_SEPARATOR = ' · '
const TRAILING_WINDOW_PAREN = /\s*\(\d+[KM]\)$/

export type ClaudeModelOption = {
  value: string
  displayName: string
  description: string
}

export type ClaudeModelVariant<T extends ClaudeModelOption> = {
  /** Preset id, passed through to the backend unchanged. */
  value: string
  /** Segmented-control label, e.g. '200K' or '1M'. Empty when unknown. */
  label: string
  /** Early auto-compact threshold in tokens; null = compact at the full window. */
  compactWindow: number | null
  /** The original list entry, so callers keep access to its description. */
  option: T
}

export type ClaudeModelFamily<T extends ClaudeModelOption> = {
  /** Underlying SDK model id, e.g. 'claude-opus-5'. Stable React key. */
  key: string
  /** Row label, e.g. 'Opus 5'. */
  label: string
  variants: ClaudeModelVariant<T>[]
}

function formatTokenWindow(tokens?: number | null): string {
  if (!tokens || tokens <= 0) return ''
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}

function parsePresetValue(value: string): { family: string; label: string; compactWindow: number | null } {
  const autoCompact = AUTO_COMPACT_SUFFIX.exec(value)
  if (autoCompact) {
    const compactWindow = Number(autoCompact[2]) * 1000
    return { family: autoCompact[1], label: formatTokenWindow(compactWindow), compactWindow }
  }
  const contextOnly = CONTEXT_ONLY_SUFFIX.exec(value) || SDK_CONTEXT_SUFFIX.exec(value)
  if (contextOnly) {
    return { family: contextOnly[1], label: formatTokenWindow(Number(contextOnly[2]) * 1_000_000), compactWindow: null }
  }
  // Plain model id — a single-variant family labelled by its own context window.
  return { family: value, label: formatTokenWindow(contextWindowForClaudeSelection(value)), compactWindow: null }
}

function familyLabel(displayName: string, fallback: string): string {
  const base = (displayName || '').split(VARIANT_SEPARATOR)[0].replace(TRAILING_WINDOW_PAREN, '').trim()
  return base || fallback
}

/**
 * Group a flat preset list into one entry per model family, preserving the
 * order families first appear (the lists are ordered newest-first) and sorting
 * each family's variants by window, smallest first with the full window last.
 */
export function groupClaudeModels<T extends ClaudeModelOption>(options: T[]): ClaudeModelFamily<T>[] {
  const families = new Map<string, ClaudeModelFamily<T>>()
  for (const option of options) {
    if (!option?.value) continue
    const parsed = parsePresetValue(option.value)
    let family = families.get(parsed.family)
    if (!family) {
      family = { key: parsed.family, label: familyLabel(option.displayName, parsed.family), variants: [] }
      families.set(parsed.family, family)
    }
    if (family.variants.some(variant => variant.value === option.value)) continue
    family.variants.push({
      value: option.value,
      label: parsed.label,
      compactWindow: parsed.compactWindow,
      option,
    })
  }
  for (const family of families.values()) {
    // null (no early compaction) sorts last — it is the largest window.
    family.variants.sort((a, b) => (a.compactWindow ?? Infinity) - (b.compactWindow ?? Infinity))
  }
  return [...families.values()]
}
