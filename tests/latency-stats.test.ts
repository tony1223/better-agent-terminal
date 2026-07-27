// Tests for renderer/src/utils/latency-stats.ts — the aggregation behind the
// response-time statistics page.
//
// The page is labelled experimental precisely because averages over small
// samples mislead, so most of what is pinned here is about NOT lying: counts
// that reflect how much data really backed a figure, thin buckets flagged rather
// than hidden, and hours bucketed on the user's clock instead of UTC.
//
// Run with: pnpm run test:latency-stats

import * as assert from 'node:assert/strict'

import {
  LOW_SAMPLE_THRESHOLD,
  availableDimensions,
  dayBuckets,
  filterSamples,
  formatDuration,
  formatHour,
  groupBuckets,
  hourBuckets,
  localDayKey,
  overallStat,
  parseSamples,
  summarise,
  type LatencySample,
} from '../renderer/src/utils/latency-stats'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log('  ok  -', name)
  } catch (err) {
    failures++
    console.error('  FAIL-', name, '\n   ', (err as Error).message)
  }
}

/** A sample at a given LOCAL hour on a given local date. */
function turn(
  localDate: string,
  hour: number,
  apiMs: number | null,
  extra: Partial<LatencySample> = {},
): LatencySample {
  const [year, month, day] = localDate.split('-').map(Number)
  return {
    kind: 'turn',
    provider: 'claude',
    sessionId: 's1',
    at: new Date(year, month - 1, day, hour, 30).getTime(),
    model: 'claude-opus-4-8',
    effort: 'high',
    ultracode: false,
    autoCompactWindow: 160_000,
    apiMs,
    ttftMs: null,
    wallMs: null,
    ...extra,
  }
}

test('summarise reports the spread, not just the mean', () => {
  const stat = summarise([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])
  assert.equal(stat.count, 10)
  assert.equal(stat.meanMs, 550)
  assert.equal(stat.minMs, 100)
  assert.equal(stat.maxMs, 1000)
  // Nearest-rank, so every reported quantile is a duration that really happened.
  assert.equal(stat.medianMs, 500)
  assert.equal(stat.p90Ms, 900)
  assert.equal(stat.lowData, false)
})

test('a p90 is always a value that actually occurred', () => {
  // Interpolating between 100 and 9000 would report ~7200 — a duration no turn
  // ever took, which the raw list on the same page would contradict.
  const stat = summarise([100, 9000])
  assert.equal(stat.p90Ms, 9000)
  assert.equal(stat.medianMs, 100)
})

test('a thin bucket is flagged rather than dropped', () => {
  const thin = summarise(Array.from({ length: LOW_SAMPLE_THRESHOLD - 1 }, () => 1000))
  assert.equal(thin.lowData, true)
  assert.equal(thin.meanMs, 1000, 'still reported, just marked')

  const enough = summarise(Array.from({ length: LOW_SAMPLE_THRESHOLD }, () => 1000))
  assert.equal(enough.lowData, false)
})

test('an empty group reports nothing rather than zero', () => {
  const stat = summarise([])
  assert.equal(stat.count, 0)
  // Zero would render as "0ms", i.e. "instant", which is the opposite of "no data".
  assert.equal(stat.meanMs, null)
  assert.equal(stat.medianMs, null)
  assert.equal(stat.lowData, true)
})

// The count is the page's only defence against a confident-looking average. If a
// sample missing the metric still counted, a ttft figure backed by two real
// measurements would claim ten.
test('a sample missing the metric does not pad the count', () => {
  const samples = [
    turn('2026-07-01', 9, 1000, { ttftMs: 500 }),
    turn('2026-07-01', 9, 2000, { ttftMs: null }),
    turn('2026-07-01', 9, 3000, { ttftMs: 700 }),
  ]
  assert.equal(overallStat(samples, 'apiMs').count, 3)

  const ttft = overallStat(samples, 'ttftMs')
  assert.equal(ttft.count, 2)
  assert.equal(ttft.meanMs, 600)
})

test('a turn with no timing at all contributes to neither metric', () => {
  const samples = [turn('2026-07-01', 9, null, { ttftMs: null }), turn('2026-07-01', 9, 1000)]
  assert.equal(overallStat(samples, 'apiMs').count, 1)
  assert.equal(overallStat(samples, 'ttftMs').count, 0)
})

test('hours are bucketed on the local clock, across every day in range', () => {
  const buckets = hourBuckets(
    [
      turn('2026-07-01', 14, 1000),
      turn('2026-07-02', 14, 3000),
      turn('2026-07-03', 9, 500),
    ],
    'apiMs',
  )
  assert.equal(buckets.length, 24, 'all 24 hours present')
  assert.equal(buckets[14].count, 2, 'the same hour on different days aggregates')
  assert.equal(buckets[14].meanMs, 2000)
  assert.equal(buckets[9].count, 1)
})

// A gap where nobody was working must not be confused with a fast hour, and
// dropping empty hours would silently renumber the axis.
test('hours with no samples stay in the table as empty buckets', () => {
  const buckets = hourBuckets([turn('2026-07-01', 14, 1000)], 'apiMs')
  assert.equal(buckets[3].count, 0)
  assert.equal(buckets[3].meanMs, null)
  assert.equal(buckets[3].hour, 3, 'the index still is the hour it claims to be')
  assert.equal(buckets[23].hour, 23)
})

test('days are local calendar days, oldest first, gaps not padded', () => {
  const buckets = dayBuckets(
    [
      turn('2026-07-03', 10, 3000),
      turn('2026-07-01', 10, 1000),
      turn('2026-07-01', 11, 2000),
    ],
    'apiMs',
  )
  assert.deepEqual(
    buckets.map(b => b.day),
    ['2026-07-01', '2026-07-03'],
    'the unused 07-02 is absent, not an empty row',
  )
  assert.equal(buckets[0].count, 2)
  assert.equal(buckets[0].meanMs, 1500)
})

test('a local day key matches the day the hour bucketing used', () => {
  // 23:30 local on the 1st is the 2nd in UTC for any negative offset; both
  // helpers must agree on which day that is, or the two tables disagree.
  const at = new Date(2026, 6, 1, 23, 30).getTime()
  assert.equal(localDayKey(at), '2026-07-01')
  assert.equal(new Date(at).getHours(), 23)
})

// runtimeEffortForMode() maps 'ultracode' to 'xhigh' before the CLI sees it, so
// grouping on the resolved level alone would bury the mode that spawns dozens of
// agents inside the ordinary xhigh row and drag its average up.
test('ultracode is grouped apart from the effort level it resolves to', () => {
  const groups = groupBuckets(
    [
      turn('2026-07-01', 10, 1000, { effort: 'xhigh', ultracode: false }),
      turn('2026-07-01', 11, 60_000, { effort: 'xhigh', ultracode: true }),
    ],
    'apiMs',
    'effort',
  )
  const keys = groups.map(g => g.key).sort()
  assert.deepEqual(keys, ['xhigh', 'xhigh + ultracode'])
  assert.equal(groups.find(g => g.key === 'xhigh')!.meanMs, 1000)
})

test('a session recorded as effort ultracode is not double-labelled', () => {
  const groups = groupBuckets(
    [turn('2026-07-01', 10, 1000, { effort: 'ultracode', ultracode: true })],
    'apiMs',
    'effort',
  )
  assert.deepEqual(
    groups.map(g => g.key),
    ['ultracode'],
  )
})

test('grouping by model and by compact window both work, busiest first', () => {
  const samples = [
    turn('2026-07-01', 10, 1000, { model: 'claude-opus-4-8' }),
    turn('2026-07-01', 11, 2000, { model: 'claude-opus-4-8' }),
    turn('2026-07-01', 12, 500, { model: 'claude-sonnet-4-6' }),
  ]
  const byModel = groupBuckets(samples, 'apiMs', 'model')
  assert.deepEqual(
    byModel.map(g => g.key),
    ['claude-opus-4-8', 'claude-sonnet-4-6'],
  )
  assert.equal(byModel[0].count, 2)

  const byWindow = groupBuckets(
    [
      turn('2026-07-01', 10, 1000, { autoCompactWindow: 160_000 }),
      turn('2026-07-01', 11, 4000, { autoCompactWindow: null }),
    ],
    'apiMs',
    'autoCompactWindow',
  )
  assert.deepEqual(byWindow.map(g => g.key).sort(), ['(default)', '160000'])
})

test('compactions and turns are separable', () => {
  const samples: LatencySample[] = [
    turn('2026-07-01', 10, 1000),
    { ...turn('2026-07-01', 11, 12_000), kind: 'compact', trigger: 'auto' },
  ]
  assert.equal(filterSamples(samples, { kind: 'turn' }).length, 1)
  assert.equal(filterSamples(samples, { kind: 'compact' }).length, 1)
  assert.equal(overallStat(filterSamples(samples, { kind: 'compact' }), 'apiMs').meanMs, 12_000)
})

test('filters combine and an unset filter means any', () => {
  const samples = [
    turn('2026-07-01', 10, 1000, { model: 'a', effort: 'high' }),
    turn('2026-07-01', 11, 2000, { model: 'a', effort: 'low' }),
    turn('2026-07-01', 12, 3000, { model: 'b', effort: 'high' }),
  ]
  assert.equal(filterSamples(samples, {}).length, 3)
  assert.equal(filterSamples(samples, { model: 'a' }).length, 2)
  assert.equal(filterSamples(samples, { model: 'a', effort: 'high' }).length, 1)
  // false is a real value for ultracode, not "no filter" — a `!filter.ultracode`
  // check here would silently ignore the "plain runs only" selection.
  assert.equal(filterSamples(samples, { ultracode: false }).length, 3)
  assert.equal(filterSamples(samples, { ultracode: true }).length, 0)
})

test('the dropdowns only offer values the data actually has', () => {
  const dims = availableDimensions([
    turn('2026-07-01', 10, 1000, { model: 'b', effort: 'high', autoCompactWindow: 160_000 }),
    turn('2026-07-01', 11, 1000, { model: 'a', effort: 'high', autoCompactWindow: null }),
  ])
  assert.deepEqual(dims.models, ['a', 'b'])
  assert.deepEqual(dims.efforts, ['high'])
  assert.deepEqual(dims.compactWindows, [160_000])
})

test('durations read at a glance and null is not zero', () => {
  assert.equal(formatDuration(null), '—')
  assert.equal(formatDuration(820), '820ms')
  assert.equal(formatDuration(1_400), '1.4s')
  assert.equal(formatDuration(125_000), '2m 05s')
  assert.equal(formatHour(0), '00:00')
  assert.equal(formatHour(14), '14:00')
})

test('a malformed record is skipped without taking the page down', () => {
  const samples = parseSamples([
    { kind: 'turn', at: 1_700_000_000_000, apiMs: 1000, model: 'm' },
    null,
    'nonsense',
    { kind: 'turn', apiMs: 1000 }, // no timestamp — cannot be bucketed
    { kind: 'turn', at: 'yesterday', apiMs: 1000 },
    { kind: 'compact', at: 1_700_000_100_000, apiMs: 9000, trigger: 'auto' },
  ])
  assert.equal(samples.length, 2)
  assert.equal(samples[0].kind, 'turn')
  assert.equal(samples[1].kind, 'compact')
  assert.equal(samples[1].trigger, 'auto')
})

test('parsing a non-array answer yields no samples rather than throwing', () => {
  assert.deepEqual(parseSamples(null), [])
  assert.deepEqual(parseSamples({ error: 'nope' }), [])
  assert.deepEqual(parseSamples(undefined), [])
})

test('parsed samples keep the fields the raw list displays', () => {
  const [sample] = parseSamples([
    {
      kind: 'turn',
      provider: 'claude',
      sessionId: 'abc',
      at: 1_700_000_000_000,
      model: 'claude-opus-4-8',
      effort: 'ultracode',
      ultracode: true,
      autoCompactWindow: 160_000,
      apiMs: 42_000,
      ttftMs: 1_800,
      wallMs: 91_000,
      outputTokens: 3_210,
      numTurns: 7,
      subtype: 'success',
    },
  ])
  assert.equal(sample.sessionId, 'abc')
  assert.equal(sample.ultracode, true)
  assert.equal(sample.wallMs, 91_000)
  assert.equal(sample.outputTokens, 3_210)
  assert.equal(sample.subtype, 'success')
})

console.log(failures === 0 ? '\nlatency-stats: OK' : `\nlatency-stats: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
