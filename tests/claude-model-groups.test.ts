import * as assert from 'assert'
import { readFileSync } from 'fs'
import {
  CLAUDE_BUILTIN_MODELS,
  contextWindowForClaudeSelection,
  groupClaudeModelRows,
  sdkModelForClaudeSelection,
} from '../renderer/src/utils/claude-model-presets'
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  codexModelValueForRow,
  groupCodexModelRows,
  splitCodexModelSelection,
} from '../renderer/src/utils/codex-models'

function main() {
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.6-sol')
  assert.deepEqual(
    CODEX_MODELS.slice(0, 5).map(model => model.value),
    ['gpt-6-astra', 'gpt-6-astra:272k', 'gpt-6-astra:872k', 'gpt-5.6-sol', 'gpt-5.6-terra'],
    'the Codex picker should lead with GPT-6 Astra and its context-window presets, then the GPT-5.6 family',
  )
  assert.ok(CODEX_MODELS.every(model => typeof model.description === 'string' && model.description.length > 0))

  assert.deepEqual(splitCodexModelSelection('gpt-6-astra:872k'), { model: 'gpt-6-astra', contextWindow: 872_000 })
  assert.deepEqual(splitCodexModelSelection('gpt-6-astra'), { model: 'gpt-6-astra', contextWindow: null })
  assert.deepEqual(splitCodexModelSelection('vendor:model'), { model: 'vendor:model', contextWindow: null })

  // Codex rows: Astra collapses to one row with Default / 272K / 872K pills,
  // everything from Sol down stays a plain single row.
  const codexRows = groupCodexModelRows(CODEX_MODELS.map(model => ({ ...model, source: 'builtin' })))
  assert.equal(codexRows[0].key, 'gpt-6-astra')
  assert.equal(codexRows[0].label, 'GPT-6 Astra')
  assert.deepEqual(
    codexRows[0].options.map(option => [option.label, option.value, option.contextWindow]),
    [['Default', 'gpt-6-astra', null], ['272K', 'gpt-6-astra:272k', 272_000], ['872K', 'gpt-6-astra:872k', 872_000]],
  )
  assert.equal(codexRows[1].key, 'gpt-5.6-sol')
  assert.deepEqual(codexRows.slice(1).map(row => row.options.length), codexRows.slice(1).map(() => 0),
    'only the Astra row carries window pills')
  assert.equal(codexRows.length, CODEX_MODELS.length - 2, 'Astra presets collapse into a single row')
  const codexGrouped = codexRows.flatMap(row => (row.options.length > 0 ? row.options.map(o => o.value) : [row.key]))
  assert.deepEqual([...codexGrouped].sort(), [...CODEX_MODELS.map(m => m.value)].sort(), 'grouping must preserve every Codex id')
  assert.equal(codexModelValueForRow(codexRows[0], 872_000), 'gpt-6-astra:872k', 'carry the window when the row offers it')
  assert.equal(codexModelValueForRow(codexRows[0], undefined), 'gpt-6-astra', 'no carried window → Default pill')
  assert.equal(codexModelValueForRow(codexRows[0], null), 'gpt-6-astra')
  assert.equal(codexModelValueForRow(codexRows[1], 872_000), 'gpt-5.6-sol', 'plain rows ignore the carried window')

  const rows = groupClaudeModelRows(CLAUDE_BUILTIN_MODELS)

  // Fable 5.1 is the newest model and must stay at the top of the picker.
  assert.equal(rows[0].key, 'claude-fable-5-1', 'Fable 5.1 should be the first row')
  assert.equal(rows[0].label, 'Fable 5.1')
  assert.equal(rows[1].key, 'claude-opus-5')
  assert.equal(rows[2].key, 'claude-fable-5')

  // Every preset in the flat list must survive grouping exactly once, so no
  // model becomes unreachable from the picker.
  const grouped = rows.flatMap(row => (row.options.length > 0 ? row.options.map(o => o.value) : [row.key]))
  assert.deepEqual(
    [...grouped].sort(),
    [...CLAUDE_BUILTIN_MODELS.map(m => m.value)].sort(),
    'grouping must preserve every preset id',
  )
  assert.equal(new Set(grouped).size, grouped.length, 'grouping must not duplicate presets')

  // The cross product collapses: the flat rows become one row per model.
  assert.ok(
    rows.length < CLAUDE_BUILTIN_MODELS.length,
    `expected fewer rows than presets, got ${rows.length} vs ${CLAUDE_BUILTIN_MODELS.length}`,
  )

  const fable51 = rows[0]
  assert.deepEqual(
    fable51.options.map(o => o.label),
    ['200K', '300K', '1M'],
    'windows sort ascending with the full window last',
  )
  assert.deepEqual(fable51.options.map(o => o.window), [200000, 300000, null])
  assert.equal(sdkModelForClaudeSelection('claude-fable-5-1:auto-compact-300k'), 'claude-fable-5-1[1m]')
  assert.equal(contextWindowForClaudeSelection('claude-fable-5-1:1m'), 1000000)

  const panelSource = readFileSync('renderer/src/components/ClaudeAgentPanel.tsx', 'utf8')
  assert.ok(
    panelSource.includes("'fable-5-1': { ...P(10, 50), cacheRead: 0.25 }"),
    'Fable 5.1 should use the published $10/$50 pricing and $0.25 cache-read price',
  )
  assert.match(panelSource, /'sonnet-5':\s+P\(2, 10\)/, 'Sonnet 5 pricing should be $2/$10 per MTok')

  // Opus 4.7 is the widest model today (200K/300K/400K/1M).
  const opus47 = rows.find(r => r.key === 'claude-opus-4-7')
  assert.ok(opus47, 'Opus 4.7 row should exist')
  assert.deepEqual(opus47!.options.map(o => o.label), ['200K', '300K', '400K', '1M'])

  // Preset-less models stay single rows with no window pills to choose from.
  const opus46 = rows.find(r => r.key === 'claude-opus-4-6')
  assert.ok(opus46, 'Opus 4.6 row should exist')
  assert.deepEqual(opus46!.options, [])

  const haiku = rows.find(r => r.key === 'claude-haiku-4-5-20251001')
  assert.ok(haiku, 'Haiku row should exist')
  assert.deepEqual(haiku!.options, [])

  // A preset id newer than this build still groups under its base model, so a
  // remote host on a newer version stays usable.
  const forward = groupClaudeModelRows([
    { value: 'claude-opus-9:auto-compact-500k', displayName: 'Opus 9 · 500K Auto-Compact', description: '' },
    { value: 'claude-opus-9:2m', displayName: 'Opus 9 · 2M', description: '' },
  ])
  assert.equal(forward.length, 1, 'unknown presets group by their base model')
  assert.equal(forward[0].key, 'claude-opus-9')
  assert.equal(forward[0].label, 'Opus 9')
  assert.deepEqual(forward[0].options.map(o => o.label), ['500K', '2M'])

  // The SDK emits `[1m]` rather than `:1m`; both mean "full window".
  const sdkForm = groupClaudeModelRows([
    { value: 'claude-opus-5[1m]', displayName: 'Opus 5 (1M)', description: '' },
  ])
  assert.equal(sdkForm[0].key, 'claude-opus-5')
  assert.deepEqual(sdkForm[0].options.map(o => o.label), ['1M'])
  assert.equal(sdkForm[0].options[0].window, null)

  // Unknown base id: the row label falls back to the display name with the
  // window variant stripped off, in either form it gets tagged with.
  const unknownParen = groupClaudeModelRows([
    { value: 'claude-zeta-1[1m]', displayName: 'Zeta 1 (1M)', description: '' },
  ])
  assert.equal(unknownParen[0].label, 'Zeta 1', 'trailing (1M) belongs on the pill, not the row')

  // Duplicate ids must not produce duplicate pills.
  const deduped = groupClaudeModelRows([
    { value: 'claude-opus-5:1m', displayName: 'Opus 5 · 1M', description: '' },
    { value: 'claude-opus-5:1m', displayName: 'Opus 5 · 1M', description: '' },
  ])
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].options.length, 1)

  // Entries without a value are skipped rather than creating an empty row.
  assert.deepEqual(groupClaudeModelRows([{ value: '', displayName: 'x', description: '' }]), [])

  console.log(`claude-model-groups: OK (${CLAUDE_BUILTIN_MODELS.length} presets → ${rows.length} rows)`)
}

main()
