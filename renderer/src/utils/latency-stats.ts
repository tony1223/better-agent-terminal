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
  kind: 'turn' | 'compact' | 'request'
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
  /** API requests this process observed during the turn. Turn samples only. */
  requestCount?: number | null
  /** Sum of those requests' measured durations, for comparison against apiMs. */
  requestApiMsTotal?: number | null
  /** Prompt size of a single request. Request samples only. */
  inputTokens?: number | null
  cacheReadTokens?: number | null
  /** True when the request belonged to a subagent, not the main thread. */
  subagent?: boolean
  stopReason?: string | null
}

/**
 * Which number a view is summarising.
 *
 * The three duration metrics answer different questions about the same turn and
 * none of them substitutes for another:
 *
 *   - `apiMs` is the SDK's `duration_api_ms`: every API round-trip in the turn,
 *     added up. The headline, and the only figure the SDK itself vouches for.
 *   - `apiMsPerRequest` spreads that across the turn's request count, so both the
 *     figure and its sample count are in API calls rather than turns. One 40s
 *     call and twelve 3s calls have nearly the same `apiMs`; this is what tells
 *     them apart on records written before per-request timing existed.
 *   - `wallMs` is the turn end to end, including tool execution and any wait for
 *     a human to approve one. It is the only one that matches how long the turn
 *     *felt*, and the only one a person can make slower by going to lunch.
 */
export type LatencyMetric = 'apiMs' | 'ttftMs' | 'apiMsPerRequest' | 'wallMs'

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

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * How many API requests a turn's `apiMs` is spread across.
 *
 * `requestCount` is what this build counted from the stream, so it is the more
 * literal answer — but it only exists on records written since per-request
 * timing landed. `numTurns` is the SDK's own count and is on everything ever
 * stored, which is what keeps two months of history from dropping out of this
 * view the moment it is selected.
 *
 * Floored to a whole number: it is used both to divide and to decide how many
 * requests the result stands for, and those two must not disagree.
 */
function requestDivisor(sample: LatencySample): number | null {
  const counted = finite(sample.requestCount)
  if (counted !== null && counted >= 1) return Math.floor(counted)
  const sdk = finite(sample.numTurns)
  return sdk !== null && sdk >= 1 ? Math.floor(sdk) : null
}

/**
 * Ceiling on the per-request expansion below.
 *
 * The multiplier is a number read off two-month-old JSONL written by another
 * process; a corrupt record claiming a million requests should skew one bucket,
 * not hang the page building an array.
 */
const MAX_REQUEST_EXPANSION = 4096

function single(value: number | null): number[] {
  return value === null ? [] : [value]
}

/**
 * The values one sample contributes to a metric: usually one, sometimes none,
 * and for the per-request view as many as the turn had requests.
 *
 * That expansion is what makes `count` mean what the column promises. Summarised
 * one-value-per-turn, a per-request figure counted *turns* — "12 samples" while
 * describing requests — and its mean was a mean of per-turn means, in which a
 * turn that made one request weighed as much as a turn that made twenty.
 * Emitting the turn's average once per request fixes both at once: the count is
 * requests, and the mean collapses to Σ apiMs / Σ requests, which is the average
 * API call actually made.
 *
 * Within a turn every request gets that turn's average, because for records
 * written before per-request timing existed that is all there is. It spreads the
 * distribution too thin, never wrong on the total — and the `request` records
 * carry the real spread for anything recent.
 */
function metricValues(sample: LatencySample, metric: LatencyMetric): number[] {
  if (metric === 'ttftMs') return single(finite(sample.ttftMs))
  if (metric === 'wallMs') return single(finite(sample.wallMs))
  const apiMs = finite(sample.apiMs)
  if (metric !== 'apiMsPerRequest') return single(apiMs)
  // A request record is already one request; dividing it again would report
  // the same number under a label that promises something else.
  if (sample.kind === 'request') return single(apiMs)
  const divisor = requestDivisor(sample)
  if (apiMs === null || divisor === null) return []
  return new Array(Math.min(divisor, MAX_REQUEST_EXPANSION)).fill(apiMs / divisor)
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
    const values = metricValues(sample, metric)
    if (values.length === 0) continue
    // Local hour, from the machine's own offset — the whole question is about
    // the user's clock, not UTC.
    byHour[new Date(sample.at).getHours()].push(...values)
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
    const values = metricValues(sample, metric)
    if (values.length === 0) continue
    const key = localDayKey(sample.at)
    const bucket = byDay.get(key)
    if (bucket) bucket.push(...values)
    else byDay.set(key, values)
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
    const values = metricValues(sample, metric)
    if (values.length === 0) continue
    const key = dimensionKey(sample, dimension)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(...values)
    else byKey.set(key, values)
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
    values.push(...metricValues(sample, metric))
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
    const kind: LatencySample['kind'] = record.kind === 'compact'
      ? 'compact'
      : record.kind === 'request'
        ? 'request'
        : 'turn'
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
      requestCount: typeof record.requestCount === 'number' ? record.requestCount : null,
      requestApiMsTotal:
        typeof record.requestApiMsTotal === 'number' ? record.requestApiMsTotal : null,
      inputTokens: typeof record.inputTokens === 'number' ? record.inputTokens : null,
      cacheReadTokens: typeof record.cacheReadTokens === 'number' ? record.cacheReadTokens : null,
      subagent: record.subagent === true,
      stopReason: typeof record.stopReason === 'string' ? record.stopReason : null,
    })
  }
  return samples
}
