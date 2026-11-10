import * as assert from 'assert'
import { readFileSync } from 'fs'
import { getClaudeModelPricing } from '../renderer/src/utils/claude-model-pricing'
import {
  CLAUDE_BUILTIN_MODELS,
  claudeSelectionForModelAndWindow,
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
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-6-sol')
  assert.deepEqual(
    CODEX_MODELS.slice(0, 13).map(model => model.value),
    [
      'gpt-6.1-sol', 'gpt-6.1-sol:272k', 'gpt-6.1-sol:872k',
      'gpt-6-astra', 'gpt-6-astra:272k', 'gpt-6-astra:872k',
      'gpt-6-sol', 'gpt-6-sol:272k', 'gpt-6-sol:872k',
      'gpt-6-luna', 'gpt-6-luna:272k', 'gpt-6-luna:872k',
      'gpt-5.6-sol',
    ],
    'the Codex picker should follow the Codex catalog priority: GPT-6.1 Sol, Astra, GPT-6 Sol, Luna, then the GPT-5.6 family',
  )
  assert.ok(CODEX_MODELS.every(model => typeof model.description === 'string' && model.description.length > 0))

  assert.deepEqual(splitCodexModelSelection('gpt-6-astra:872k'), { model: 'gpt-6-astra', contextWindow: 872_000 })
  assert.deepEqual(splitCodexModelSelection('gpt-6-astra'), { model: 'gpt-6-astra', contextWindow: null })
  assert.deepEqual(splitCodexModelSelection('vendor:model'), { model: 'vendor:model', contextWindow: null })

  // Codex rows: each GPT-6 model collapses to one row with Default / 272K /
  // 872K pills, everything from GPT-5.6 Sol down stays a plain single row.
  const codexRows = groupCodexModelRows(CODEX_MODELS.map(model => ({ ...model, source: 'builtin' })))
  assert.deepEqual(codexRows.slice(0, 5).map(row => row.key), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'])
  assert.equal(codexRows[0].label, 'GPT-6.1 Sol')
  assert.equal(codexRows[1].label, 'GPT-6 Astra')
  assert.deepEqual(
    codexRows[1].options.map(option => [option.label, option.value, option.contextWindow]),
    [['Default', 'gpt-6-astra', null], ['272K', 'gpt-6-astra:272k', 272_000], ['872K', 'gpt-6-astra:872k', 872_000]],
  )
  assert.deepEqual(codexRows.slice(0, 4).map(row => row.options.length), [3, 3, 3, 3], 'every GPT-6 row carries window pills')
  assert.deepEqual(codexRows.slice(4).map(row => row.options.length), codexRows.slice(4).map(() => 0),
    'rows from GPT-5.6 Sol down carry no window pills')
  assert.equal(codexRows.length, CODEX_MODELS.length - 8, 'four GPT-6 preset pairs collapse into their rows')
  const codexGrouped = codexRows.flatMap(row => (row.options.length > 0 ? row.options.map(o => o.value) : [row.key]))
  assert.deepEqual([...codexGrouped].sort(), [...CODEX_MODELS.map(m => m.value)].sort(), 'grouping must preserve every Codex id')
  assert.equal(codexModelValueForRow(codexRows[1], 872_000), 'gpt-6-astra:872k', 'carry the window when the row offers it')
  assert.equal(codexModelValueForRow(codexRows[1], undefined), 'gpt-6-astra', 'no carried window → Default pill')
  assert.equal(codexModelValueForRow(codexRows[1], null), 'gpt-6-astra')
  assert.equal(codexModelValueForRow(codexRows[0], 872_000), 'gpt-6.1-sol:872k', 'GPT-6.1 Sol carries the window too')
  assert.equal(codexModelValueForRow(codexRows[4], 872_000), 'gpt-5.6-sol', 'plain rows ignore the carried window')

  const rows = groupClaudeModelRows(CLAUDE_BUILTIN_MODELS)

  // New releases lead the picker without removing earlier model selections.
  assert.deepEqual(rows.slice(0, 5).map(row => row.key), [
    'claude-fable-5-2', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-fable-5',
  ])
  assert.equal(rows[0].label, 'Fable 5.2')
  const fable52 = rows[0]
  assert.deepEqual(fable52.options.map(o => o.label), ['200K', '300K', '1M'])
  for (const option of fable52.options) {
    const sdkModel = sdkModelForClaudeSelection(option.value)
    assert.equal(sdkModel, 'claude-fable-5-2[1m]')
    assert.equal(contextWindowForClaudeSelection(option.value), 1_000_000)
    assert.equal(claudeSelectionForModelAndWindow(sdkModel, option.window), option.value,
      'host session metadata must restore the selected Fable 5.2 compact window')
  }
  assert.equal(sdkModelForClaudeSelection('claude-fable-5-2'), 'claude-fable-5-2[1m]')

  const opus55 = rows[1]
  assert.deepEqual(opus55.options.map(o => o.label), ['200K', '300K', '1M'])
  for (const option of opus55.options) {
    const sdkModel = sdkModelForClaudeSelection(option.value)
    assert.equal(sdkModel, 'claude-opus-5-5[1m]')
    assert.equal(contextWindowForClaudeSelection(option.value), 1_000_000)
    assert.equal(claudeSelectionForModelAndWindow(sdkModel, option.window), option.value,
      'host session metadata must restore the selected Opus 5.5 compact window')
  }

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

  const fable51 = rows[2]
  assert.deepEqual(
    fable51.options.map(o => o.label),
    ['200K', '300K', '1M'],
    'windows sort ascending with the full window last',
  )
  assert.deepEqual(fable51.options.map(o => o.window), [200000, 300000, null])
  assert.equal(sdkModelForClaudeSelection('claude-fable-5-1:auto-compact-300k'), 'claude-fable-5-1[1m]')
  assert.equal(contextWindowForClaudeSelection('claude-fable-5-1:1m'), 1000000)

  for (const panel of ['ClaudeAgentPanel', 'CodexAgentPanel']) {
    const source = readFileSync(`renderer/src/components/${panel}.tsx`, 'utf8')
    assert.ok(source.includes('getClaudeModelPricing(model, totalIn, true)'),
      `${panel} must treat per-model SDK usage as cumulative when estimating tiered pricing`)
  }
  for (const model of ['claude-fable-5-2', 'claude-fable-5-2[1m]', ...fable52.options.map(o => o.value)]) {
    assert.deepEqual(getClaudeModelPricing(model), {
      input: 8, output: 40, cacheRead: 0.20, cacheWrite5m: 10, cacheWrite1h: 16,
    }, `${model} must use Fable 5.2 pricing rather than the Fable 5 family fallback`)
  }
  assert.deepEqual(getClaudeModelPricing('claude-fable-5-1[1m]'), {
    input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20,
  })
  assert.equal(getClaudeModelPricing('claude-sonnet-5')?.cacheRead, 0.20)
  assert.deepEqual(getClaudeModelPricing('claude-sonnet-5-5[1m]'), {
    input: 2, output: 10, cacheRead: 0.10, cacheWrite5m: 2.5, cacheWrite1h: 4,
  })
  const haikuShort = getClaudeModelPricing('claude-haiku-5-5[1m]', 100_000)!
  assert.equal(haikuShort.input, 0.10)
  assert.equal(haikuShort.output, 0.50)
  assert.ok(Math.abs(haikuShort.cacheRead - 0.01) < 1e-10)
  assert.equal(haikuShort.cacheWrite5m, 0.125)
  assert.equal(haikuShort.cacheWrite1h, 0.20)
  assert.deepEqual(getClaudeModelPricing('claude-haiku-5-5', 100_001), {
    input: 0.50, output: 2.50, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1,
  })
  assert.equal(getClaudeModelPricing('claude-haiku-5-5', 200_000, true), null,
    'cumulative tokens cannot identify which requests exceeded the pricing threshold')
  assert.deepEqual(getClaudeModelPricing('claude-haiku-5-5', 90_000, true), haikuShort)
  assert.equal(getClaudeModelPricing('claude-haiku-5-5'), null)
  assert.equal(getClaudeModelPricing('unknown-model', 200_000), null)
  const sonnet55 = rows.find(r => r.key === 'claude-sonnet-5-5')
  assert.ok(sonnet55, 'Sonnet 5.5 row should exist')
  assert.deepEqual(sonnet55!.options.map(o => o.label), ['200K', '300K', '1M'])
  assert.equal(rows.indexOf(sonnet55!) + 1, rows.findIndex(r => r.key === 'claude-sonnet-5'), 'Sonnet 5.5 sits directly above Sonnet 5')

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

  const haiku55 = rows.find(r => r.key === 'claude-haiku-5-5')
  assert.ok(haiku55, 'Haiku 5.5 row should exist')
  assert.deepEqual(haiku55!.options.map(o => o.label), ['200K', '300K', '1M'])
  for (const option of haiku55!.options) {
    const sdkModel = sdkModelForClaudeSelection(option.value)
    assert.equal(sdkModel, 'claude-haiku-5-5[1m]')
    assert.equal(contextWindowForClaudeSelection(option.value), 1_000_000)
    assert.equal(claudeSelectionForModelAndWindow(sdkModel, option.window), option.value,
      'host metadata must restore the selected Haiku 5.5 compact window')
  }

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

  // Host meta reports the SDK id and the auto-compact window separately; the
  // pair must fold back into the preset the user picked, not the `:1m` one.
  assert.equal(claudeSelectionForModelAndWindow('claude-opus-5[1m]', 300_000), 'claude-opus-5:auto-compact-300k')
  assert.equal(claudeSelectionForModelAndWindow('claude-opus-5', 200_000), 'claude-opus-5:auto-compact-200k')
  assert.equal(claudeSelectionForModelAndWindow('claude-opus-5[1m]', null), 'claude-opus-5:1m')
  assert.equal(claudeSelectionForModelAndWindow('claude-opus-5[1m]', undefined), 'claude-opus-5:1m')
  assert.equal(claudeSelectionForModelAndWindow('claude-opus-5[1m]', 350_000), 'claude-opus-5:auto-compact-350k')
  assert.equal(claudeSelectionForModelAndWindow('claude-opus-5:auto-compact-300k', 300_000), 'claude-opus-5:auto-compact-300k')
  assert.equal(claudeSelectionForModelAndWindow('claude-haiku-4-5-20251001', 100_000), 'claude-haiku-4-5-20251001')
  assert.equal(claudeSelectionForModelAndWindow(undefined, 300_000), undefined)

  console.log(`claude-model-groups: OK (${CLAUDE_BUILTIN_MODELS.length} presets → ${rows.length} rows)`)
}

main()
