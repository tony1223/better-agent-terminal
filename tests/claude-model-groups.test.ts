import * as assert from 'assert'
import { groupClaudeModels } from '../renderer/src/utils/claude-model-groups'
import { CLAUDE_BUILTIN_MODELS } from '../renderer/src/utils/claude-model-presets'

function main() {
  const families = groupClaudeModels(CLAUDE_BUILTIN_MODELS)

  // Opus 5 is the newest model and must stay at the top of the picker.
  assert.equal(families[0].key, 'claude-opus-5', 'Opus 5 should be the first family')
  assert.equal(families[0].label, 'Opus 5')
  assert.equal(families[1].key, 'claude-fable-5')

  // Every preset in the flat list must survive grouping exactly once, so no
  // model becomes unreachable from the picker.
  const grouped = families.flatMap(family => family.variants.map(variant => variant.value))
  assert.deepEqual(
    [...grouped].sort(),
    [...CLAUDE_BUILTIN_MODELS.map(m => m.value)].sort(),
    'grouping must preserve every preset id',
  )
  assert.equal(new Set(grouped).size, grouped.length, 'grouping must not duplicate presets')

  // The cross product collapses: 20 flat rows become one row per family.
  assert.ok(
    families.length < CLAUDE_BUILTIN_MODELS.length,
    `expected fewer families than presets, got ${families.length} vs ${CLAUDE_BUILTIN_MODELS.length}`,
  )

  const opus5 = families[0]
  assert.deepEqual(
    opus5.variants.map(v => v.label),
    ['200K', '300K', '1M'],
    'windows sort ascending with the full window last',
  )
  assert.deepEqual(opus5.variants.map(v => v.compactWindow), [200000, 300000, null])

  // Opus 4.7 is the widest family today (200K/300K/400K/1M).
  const opus47 = families.find(f => f.key === 'claude-opus-4-7')
  assert.ok(opus47, 'Opus 4.7 family should exist')
  assert.deepEqual(opus47!.variants.map(v => v.label), ['200K', '300K', '400K', '1M'])

  // Plain model ids become single-variant families labelled by their own
  // context window, with the parenthetical stripped from the row label.
  const opus46 = families.find(f => f.key === 'claude-opus-4-6')
  assert.ok(opus46, 'Opus 4.6 family should exist')
  assert.equal(opus46!.label, 'Opus 4.6', 'trailing (1M) belongs on the pill, not the row')
  assert.deepEqual(opus46!.variants.map(v => v.label), ['1M'])

  const haiku = families.find(f => f.key === 'claude-haiku-4-5-20251001')
  assert.ok(haiku, 'Haiku family should exist')
  assert.equal(haiku!.label, 'Haiku 4.5')
  assert.deepEqual(haiku!.variants.map(v => v.label), ['200K'])

  // A preset id newer than this build still groups under its base model, so a
  // remote host on a newer version stays usable.
  const forward = groupClaudeModels([
    { value: 'claude-opus-9:auto-compact-500k', displayName: 'Opus 9 · 500K Auto-Compact', description: '' },
    { value: 'claude-opus-9:2m', displayName: 'Opus 9 · 2M', description: '' },
  ])
  assert.equal(forward.length, 1, 'unknown presets group by their base model')
  assert.equal(forward[0].key, 'claude-opus-9')
  assert.equal(forward[0].label, 'Opus 9')
  assert.deepEqual(forward[0].variants.map(v => v.label), ['500K', '2M'])

  // The SDK emits `[1m]` rather than `:1m`; both mean "full window".
  const sdkForm = groupClaudeModels([
    { value: 'claude-opus-5[1m]', displayName: 'Opus 5 (1M)', description: '' },
  ])
  assert.equal(sdkForm[0].key, 'claude-opus-5')
  assert.deepEqual(sdkForm[0].variants.map(v => v.label), ['1M'])
  assert.equal(sdkForm[0].variants[0].compactWindow, null)

  // Duplicate ids must not produce duplicate pills.
  const deduped = groupClaudeModels([
    { value: 'claude-opus-5:1m', displayName: 'Opus 5 · 1M', description: '' },
    { value: 'claude-opus-5:1m', displayName: 'Opus 5 · 1M', description: '' },
  ])
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].variants.length, 1)

  // Entries without a value are skipped rather than creating an empty row.
  assert.deepEqual(groupClaudeModels([{ value: '', displayName: 'x', description: '' }]), [])

  console.log(`claude-model-groups: OK (${CLAUDE_BUILTIN_MODELS.length} presets → ${families.length} families)`)
}

main()
