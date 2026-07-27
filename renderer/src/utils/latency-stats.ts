// Aggregation for the response-time statistics page.
//
// Pure functions over the raw samples the Rust host hands back, kept out of the
// component so they can be tested without React. The samples themselves are
// written by node-sidecar/src/lib/latency-sample.mjs; see src-tauri/src/latency_store.rs
// for the storage format.
//
// Two deliberate rules run through everything here:
//
//   1. **Hour is the viewing unit, day is the statistics unit.** A bucket is one
//      local hour-of-day (0..23) aggregated across every day in range, because a
//      single day rarely has enough turns in any one hour to mean anything.
//   2. **Every figure carries its sample count.** The page annotates thin
//      buckets rather than hiding them: "3.2s over 2 samples" is useful, "3.2s"
//      alone is a lie by omission.

/** One record as stored on disk. Fields are null when the SDK omitted them. */
export interface LatencySample {
  kind: 'turn' | 'compact'
  provider: string
  sessionId: string | null
  /** Epoch ms — when the request went out, not when the result was processed. */
  at: number
  model: string | null
  /** The raw effort mode string, e.g. 'high' / 'xhigh' / 'ultracode'. */
  effort: string | null
  ultracode: boolean
  autoCompactWindow: number | null
  /** Server-side API duration. The headline metric. */
  apiMs: number | null
  /** Time to first token. Only on turn samples. */
  ttftMs?: number | null
  /** Wall time including any wait for a human. Recorded, never averaged. */
  wallMs?: number | null
  outputTokens?: number | null
  numTurns?: number | null
  subtype?: string | null
  trigger?: string | null
  preTokens?: number | null
  postTokens?: number | null
}

/** Which number a view is summarising. */
export type LatencyMetric = 'apiMs' | 'ttftMs'

/** The dimensions a view can be sliced by. `null` on a filter means "any". */
export interface LatencyFilter {
  kind?: LatencySample['kind']
  model?: string | null
  effort?: string | null
  ultracode?: boolean | null
  autoCompactWindow?: number | null
}

/**
 * Below this, a bucket's average is shown but flagged. Not a hard cut: the raw
 * list is the point of the page, and silently dropping thin buckets would make
 * a quiet hour look like an hour that was never sampled.
 */
export const LOW_SAMPLE_THRESHOLD = 5

export interface LatencyStat {
  count: number
  /** Arithmetic mean in ms, or null when nothing in the group had the metric. */
  meanMs: number | null
  medianMs: number | null
  p90Ms: number | null
  minMs: number | null
  maxMs: number | null
  /** True when `count` is too small to read much into the average. */
  lowData: boolean
}

export interface HourBucket extends LatencyStat {
  /** Local hour of day, 0..23. */
  hour: number
}

export interface DayBucket extends LatencyStat {
  /** Local calendar day as `YYYY-MM-DD`. */
  day: string
}

export interface GroupBucket extends LatencyStat {
  key: string
  label: string
}

const EMPTY_STAT: LatencyStat = {
  count: 0,
  meanMs: null,
  medianMs: null,
  p90Ms: null,
  minMs: null,
  maxMs: null,
  lowData: true,
}

function metricValue(sample: LatencySample, metric: LatencyMetric): number | null {
  const raw = metric === 'ttftMs' ? sample.ttftMs : sample.apiMs
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/**
 * Summarise a list of durations.
 *
 * `count` is the number of samples that actually carried the metric, not the
 * number of samples considered: a turn with no ttft_ms must not inflate the
 * confidence of a ttft figure.
 */
export function summarise(values: number[]): LatencyStat {
  if (values.length === 0) return { ...EMPTY_STAT }
  const sorted = [...values].sort((a, b) => a - b)
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    count: sorted.length,
    meanMs: total / sorted.length,
    medianMs: quantile(sorted, 0.5),
    p90Ms: quantile(sorted, 0.9),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    lowData: sorted.length < LOW_SAMPLE_THRESHOLD,
  }
}

/**
 * Nearest-rank quantile on an already-sorted list.
 *
 * Deliberately not interpolating: with a handful of samples an interpolated p90
 * invents a duration that never happened, and this page is read alongside the
 * raw records where that invented number would not appear.
 */
function quantile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

export function matchesFilter(sample: LatencySample, filter: LatencyFilter): boolean {
  if (filter.kind && sample.kind !== filter.kind) return false
  if (filter.model != null && sample.model !== filter.model) return false
  if (filter.effort != null && sample.effort !== filter.effort) return false
  if (filter.ultracode != null && sample.ultracode !== filter.ultracode) return false
  if (filter.autoCompactWindow != null && sample.autoCompactWindow !== filter.autoCompactWindow) {
    return false
  }
  return true
}

export function filterSamples(samples: LatencySample[], filter: LatencyFilter): LatencySample[] {
  return samples.filter(sample => matchesFilter(sample, filter))
}

/**
 * One bucket per local hour of day, 0..23, always all 24 present.
 *
 * Empty hours are kept as zero-count buckets so the shape of the day is honest:
 * a gap where nobody was working reads differently from a fast hour, and a table
 * that skipped them would silently renumber the axis.
 */
export function hourBuckets(samples: LatencySample[], metric: LatencyMetric): HourBucket[] {
  const byHour: number[][] = Array.from({ length: 24 }, () => [])
  for (const sample of samples) {
    const value = metricValue(sample, metric)
    if (value === null) continue
    // Local hour, from the machine's own offset — the whole question is about
    // the user's clock, not UTC.
    byHour[new Date(sample.at).getHours()].push(value)
  }
  return byHour.map((values, hour) => ({ hour, ...summarise(values) }))
}

/** Local `YYYY-MM-DD` for an epoch ms, matching what `hourBuckets` reads. */
export function localDayKey(at: number): string {
  const date = new Date(at)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * One bucket per local calendar day that has at least one sample, oldest first.
 *
 * Unlike the hour view this does not fill gaps: a day with no turns is a day the
 * app was not used, and padding the range with empty rows would bury the days
 * that do have data.
 */
export function dayBuckets(samples: LatencySample[], metric: LatencyMetric): DayBucket[] {
  const byDay = new Map<string, number[]>()
  for (const sample of samples) {
    const value = metricValue(sample, metric)
    if (value === null) continue
    const key = localDayKey(sample.at)
    const bucket = byDay.get(key)
    if (bucket) bucket.push(value)
    else byDay.set(key, [value])
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, values]) => ({ day, ...summarise(values) }))
}

/** How a sample is labelled when grouping by one of the dimensions. */
export type LatencyDimension = 'model' | 'effort' | 'autoCompactWindow'

function dimensionKey(sample: LatencySample, dimension: LatencyDimension): string {
  if (dimension === 'model') return sample.model ?? '(unknown)'
  if (dimension === 'autoCompactWindow') {
    return sample.autoCompactWindow === null ? '(default)' : String(sample.autoCompactWindow)
  }
  // `ultracode` is a mode, not a level: the sidecar resolves it to xhigh before
  // the CLI sees it, so folding it in here would hide the setting that fans out
  // to dozens of agents inside the plain xhigh row.
  const effort = sample.effort ?? '(default)'
  return sample.ultracode && effort !== 'ultracode' ? `${effort} + ultracode` : effort
}

/** One bucket per distinct value of `dimension`, busiest first. */
export function groupBuckets(
  samples: LatencySample[],
  metric: LatencyMetric,
  dimension: LatencyDimension,
): GroupBucket[] {
  const byKey = new Map<string, number[]>()
  for (const sample of samples) {
    const value = metricValue(sample, metric)
    if (value === null) continue
    const key = dimensionKey(sample, dimension)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(value)
    else byKey.set(key, [value])
  }
  return [...byKey.entries()]
    .map(([key, values]) => ({ key, label: key, ...summarise(values) }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
}

/** Distinct values present in the data, for populating the filter dropdowns. */
export function availableDimensions(samples: LatencySample[]): {
  models: string[]
  efforts: string[]
  compactWindows: number[]
} {
  const models = new Set<string>()
  const efforts = new Set<string>()
  const compactWindows = new Set<number>()
  for (const sample of samples) {
    if (sample.model) models.add(sample.model)
    if (sample.effort) efforts.add(sample.effort)
    if (typeof sample.autoCompactWindow === 'number') compactWindows.add(sample.autoCompactWindow)
  }
  return {
    models: [...models].sort(),
    efforts: [...efforts].sort(),
    compactWindows: [...compactWindows].sort((a, b) => a - b),
  }
}

/** Overall summary for the header line. */
export function overallStat(samples: LatencySample[], metric: LatencyMetric): LatencyStat {
  const values: number[] = []
  for (const sample of samples) {
    const value = metricValue(sample, metric)
    if (value !== null) values.push(value)
  }
  return summarise(values)
}

/** `1.4s` / `820ms` / `2m 05s` — short enough for a dense table. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${`${seconds}`.padStart(2, '0')}s`
}

/** `14:00` for hour 14 — the label on the hour axis. */
export function formatHour(hour: number): string {
  return `${`${hour}`.padStart(2, '0')}:00`
}

/**
 * Parse whatever the host returned into samples, dropping anything unusable.
 *
 * The host reads two months of append-only JSONL written by a different process,
 * so being strict here (rather than trusting the shape) is what keeps one odd
 * record from blanking the whole page.
 */
export function parseSamples(raw: unknown): LatencySample[] {
  if (!Array.isArray(raw)) return []
  const samples: LatencySample[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const at = record.at
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    const kind = record.kind === 'compact' ? 'compact' : 'turn'
    samples.push({
      kind,
      provider: typeof record.provider === 'string' ? record.provider : 'claude',
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
      at,
      model: typeof record.model === 'string' ? record.model : null,
      effort: typeof record.effort === 'string' ? record.effort : null,
      ultracode: record.ultracode === true,
      autoCompactWindow:
        typeof record.autoCompactWindow === 'number' ? record.autoCompactWindow : null,
      apiMs: typeof record.apiMs === 'number' ? record.apiMs : null,
      ttftMs: typeof record.ttftMs === 'number' ? record.ttftMs : null,
      wallMs: typeof record.wallMs === 'number' ? record.wallMs : null,
      outputTokens: typeof record.outputTokens === 'number' ? record.outputTokens : null,
      numTurns: typeof record.numTurns === 'number' ? record.numTurns : null,
      subtype: typeof record.subtype === 'string' ? record.subtype : null,
      trigger: typeof record.trigger === 'string' ? record.trigger : null,
      preTokens: typeof record.preTokens === 'number' ? record.preTokens : null,
      postTokens: typeof record.postTokens === 'number' ? record.postTokens : null,
    })
  }
  return samples
}
