import * as assert from 'assert'
import { CLAUDE_BUILTIN_MODELS, groupClaudeModelRows } from '../renderer/src/utils/claude-model-presets'

function main() {
  const rows = groupClaudeModelRows(CLAUDE_BUILTIN_MODELS)

  // Opus 5 is the newest model and must stay at the top of the picker.
  assert.equal(rows[0].key, 'claude-opus-5', 'Opus 5 should be the first row')
  assert.equal(rows[0].label, 'Opus 5')
  assert.equal(rows[1].key, 'claude-fable-5')

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

  const opus5 = rows[0]
  assert.deepEqual(
    opus5.options.map(o => o.label),
    ['200K', '300K', '1M'],
    'windows sort ascending with the full window last',
  )
  assert.deepEqual(opus5.options.map(o => o.window), [200000, 300000, null])

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
