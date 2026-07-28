// Response-time statistics — the Statistics ▸ Response Time menu item.
//
// Mounted next to <App /> in main.tsx rather than inside it: App has four early
// return branches (profile startup, detached window, missing workspace, normal)
// and the menu can fire while any of them is on screen.
//
// Aggregation lives in utils/latency-stats.ts so it can be tested without React;
// this file is layout, controls and the raw record list. Strings are hardcoded
// English to match the sibling diagnostics modal (Cache Efficiency History) —
// the native menu that opens it has no i18n either.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { host } from '../host-api'
import {
  LOW_SAMPLE_THRESHOLD,
  availableDimensions,
  dayBuckets,
  filterSamples,
  formatDuration,
  formatHour,
  groupBuckets,
  hourBuckets,
  overallStat,
  parseSamples,
  type LatencyFilter,
  type LatencyMetric,
  type LatencySample,
  type LatencyStat,
} from '../utils/latency-stats'

type View = 'hour' | 'day' | 'model' | 'effort' | 'window' | 'raw'

const RANGE_DAYS = [7, 30, 60] as const
const DAY_MS = 86_400_000

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'hour', label: 'By hour' },
  { id: 'day', label: 'By day' },
  { id: 'model', label: 'By model' },
  { id: 'effort', label: 'By effort' },
  { id: 'window', label: 'By compact window' },
  { id: 'raw', label: 'Raw records' },
]

// The metrics a view can summarise, and which record kinds carry each. `title`
// is where the difference between the three turn durations is spelled out —
// they are easy to confuse and reading the wrong one silently answers a
// different question.
const METRICS: Array<{
  id: LatencyMetric
  label: string
  summaryLabel: string
  title: string
  kinds: Array<LatencySample['kind']>
}> = [
  {
    id: 'apiMs',
    label: 'API time',
    summaryLabel: 'API time',
    title: "The SDK's duration_api_ms: every API round-trip in the turn, added up.",
    kinds: ['turn', 'compact', 'request'],
  },
  {
    id: 'apiMsPerRequest',
    label: 'Per request',
    summaryLabel: 'API time per request',
    title:
      "The turn's API time spread across the requests it made, counted in requests rather "
      + 'than turns. One 40s call and twelve 3s calls have nearly the same API time; this '
      + 'tells them apart on records written before per-request timing existed. For anything '
      + 'recent, Requests has the real spread.',
    kinds: ['turn'],
  },
  {
    id: 'wallMs',
    label: 'Wall time',
    summaryLabel: 'wall time',
    title:
      'The turn end to end, including tool execution and any wait for a human to approve one. '
      + 'The only figure that matches how long the turn felt — and the only one you can make '
      + 'worse by going to lunch.',
    kinds: ['turn'],
  },
  {
    id: 'ttftMs',
    label: 'First token',
    summaryLabel: 'time to first token',
    title: 'Time from the request going out to its first token.',
    kinds: ['turn', 'request'],
  },
]

/**
 * What the sample count is counting.
 *
 * Not cosmetic: the per-request view spreads each turn across the requests it
 * made, so its `n` really is a number of API calls, and calling those "turns"
 * overstated how many turns the page had seen — by a factor of however many
 * calls each one took.
 */
function countNoun(kind: LatencySample['kind'], metric: LatencyMetric): string {
  if (kind === 'compact') return 'compactions'
  if (kind === 'request' || metric === 'apiMsPerRequest') return 'API requests'
  return 'turns'
}

const COL = { label: 110, count: 64, mean: 90, median: 90, p90: 90, max: 90 }
const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '4px 0',
  borderBottom: '1px solid #333',
  fontWeight: 600,
  color: '#bbb',
}
const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '3px 0',
  borderBottom: '1px solid #222',
  alignItems: 'center',
}

function num(width: number, value: string, color = '#eee'): React.ReactElement {
  return <span style={{ width, textAlign: 'right', color }}>{value}</span>
}

function chip(active: boolean): React.CSSProperties {
  return {
    padding: '2px 8px',
    borderRadius: 4,
    border: `1px solid ${active ? '#666' : '#333'}`,
    background: active ? '#2a2a3e' : 'transparent',
    color: active ? '#eee' : '#999',
    cursor: 'pointer',
    fontSize: 12,
  }
}

const SELECT_STYLE: React.CSSProperties = {
  background: '#1a1a1a',
  color: '#ccc',
  border: '1px solid #333',
  borderRadius: 4,
  fontSize: 12,
  padding: '2px 4px',
}

/**
 * One aggregate row: the numbers, plus a bar sized by the mean.
 *
 * The bar is a plain div width — there is no charting library in this project
 * and one table that also reads as a shape beats adding a dependency.
 */
function StatRow({
  label,
  stat,
  maxMean,
  title,
}: {
  label: string
  stat: LatencyStat
  maxMean: number
  title?: string
}): React.ReactElement {
  const width = stat.meanMs !== null && maxMean > 0 ? Math.max(1, (stat.meanMs / maxMean) * 100) : 0
  // Thin buckets are dimmed and annotated rather than dropped: an hour nobody
  // worked in reads differently from a fast hour, and hiding it would quietly
  // change what the table is a table of.
  const dim = stat.count === 0 || stat.lowData
  return (
    <div style={ROW_STYLE} title={title}>
      <span style={{ width: COL.label, color: dim ? '#777' : '#eee' }}>{label}</span>
      {num(COL.count, stat.count === 0 ? '—' : String(stat.count), dim ? '#777' : '#888')}
      {num(COL.mean, formatDuration(stat.meanMs), dim ? '#777' : '#8be9fd')}
      {num(COL.median, formatDuration(stat.medianMs), dim ? '#777' : '#eee')}
      {num(COL.p90, formatDuration(stat.p90Ms), dim ? '#777' : '#d19a66')}
      {num(COL.max, formatDuration(stat.maxMs), dim ? '#777' : '#888')}
      <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 60 }}>
        <span
          style={{
            height: 8,
            width: `${width}%`,
            background: dim ? '#444' : '#4a7fb5',
            borderRadius: 2,
          }}
        />
        {stat.count > 0 && stat.lowData && (
          <span style={{ color: '#e6a700', fontSize: 11, whiteSpace: 'nowrap' }}>
            few samples
          </span>
        )}
      </span>
    </div>
  )
}

function StatTable({
  rows,
  firstColumn,
}: {
  rows: Array<{ label: string; stat: LatencyStat; title?: string }>
  firstColumn: string
}): React.ReactElement {
  const maxMean = rows.reduce((max, row) => Math.max(max, row.stat.meanMs ?? 0), 0)
  return (
    <div style={{ fontSize: 12 }}>
      <div style={HEADER_STYLE}>
        <span style={{ width: COL.label }}>{firstColumn}</span>
        {num(COL.count, 'n', '#bbb')}
        {num(COL.mean, 'mean', '#bbb')}
        {num(COL.median, 'median', '#bbb')}
        {num(COL.p90, 'p90', '#bbb')}
        {num(COL.max, 'max', '#bbb')}
        <span style={{ flex: 1, minWidth: 60 }} />
      </div>
      {rows.map(row => (
        <StatRow key={row.label} label={row.label} stat={row.stat} maxMean={maxMean} title={row.title} />
      ))}
      {rows.length === 0 && (
        <div style={{ padding: '12px 0', color: '#777' }}>No samples in this range.</div>
      )}
    </div>
  )
}

/** Newest first — the last few turns are what someone checks after a slow one. */
function RawTable({ samples }: { samples: LatencySample[] }): React.ReactElement {
  const rows = useMemo(() => [...samples].reverse(), [samples])
  return (
    <div style={{ fontSize: 12 }}>
      <div style={HEADER_STYLE}>
        <span style={{ width: 140 }}>when</span>
        <span style={{ width: 60 }}>kind</span>
        <span style={{ width: 150 }}>model</span>
        <span style={{ width: 90 }}>effort</span>
        {num(70, 'api', '#bbb')}
        {num(70, 'ttft', '#bbb')}
        {num(70, 'wall', '#bbb')}
        {num(70, 'output', '#bbb')}
        <span style={{ flex: 1, minWidth: 80 }}>note</span>
      </div>
      {rows.map((sample, index) => (
        <div key={`${sample.at}-${index}`} style={ROW_STYLE}>
          <span style={{ width: 140, color: '#999' }}>
            {new Date(sample.at).toLocaleString()}
          </span>
          <span style={{ width: 60, color: sample.kind === 'compact' ? '#c678dd' : '#888' }}>
            {sample.kind}
          </span>
          <span style={{ width: 150, color: '#eee', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {sample.model ?? '—'}
          </span>
          <span style={{ width: 90, color: '#888' }}>
            {sample.effort ?? '—'}
            {sample.ultracode && sample.effort !== 'ultracode' ? ' +uc' : ''}
          </span>
          {num(70, formatDuration(sample.apiMs), '#8be9fd')}
          {num(70, formatDuration(sample.ttftMs ?? null), '#eee')}
          {/* Dimmed, not hidden: wall time is selectable as a metric now, but it
              includes waiting for a human to approve a tool, so it does not
              belong in the eye's path when scanning for a slow server. */}
          {num(70, formatDuration(sample.wallMs ?? null), '#666')}
          {num(70, sample.outputTokens != null ? sample.outputTokens.toLocaleString() : '—', '#d19a66')}
          <span style={{ flex: 1, minWidth: 80, color: '#777' }}>
            {sample.kind === 'compact'
              ? [sample.trigger, sample.preTokens != null ? `${sample.preTokens.toLocaleString()}→${(sample.postTokens ?? 0).toLocaleString()}` : null]
                  .filter(Boolean)
                  .join(' ')
              : sample.kind === 'request'
                // Prompt size is the point of a request record: it is what the
                // per-turn number cannot correlate against.
                ? [
                    sample.subagent ? 'subagent' : null,
                    sample.inputTokens != null ? `in ${sample.inputTokens.toLocaleString()}` : null,
                    sample.cacheReadTokens ? `cache ${sample.cacheReadTokens.toLocaleString()}` : null,
                    sample.stopReason && sample.stopReason !== 'end_turn' ? sample.stopReason : null,
                  ].filter(Boolean).join(' · ')
                : [
                    sample.subtype && sample.subtype !== 'success' ? sample.subtype : null,
                    sample.requestCount != null ? `${sample.requestCount} req` : null,
                  ].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
      {rows.length === 0 && (
        <div style={{ padding: '12px 0', color: '#777' }}>No samples in this range.</div>
      )}
    </div>
  )
}

export function LatencyStatsPanel(): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const [samples, setSamples] = useState<LatencySample[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rangeDays, setRangeDays] = useState<number>(30)
  const [metric, setMetric] = useState<LatencyMetric>('apiMs')
  const [view, setView] = useState<View>('hour')
  // Requests, not turns. A turn is however many API calls the model happened to
  // need, so its duration answers "how much work was there" far more than "how
  // fast was the API" — the question this page exists for. One call is the unit
  // that is actually comparable between two turns, two models, or two hours.
  const [kind, setKind] = useState<LatencySample['kind']>('request')
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<string | null>(null)
  const [compactWindow, setCompactWindow] = useState<number | null>(null)

  useEffect(() => {
    const unsubscribe = host.app.onStatsRequested?.(() => setOpen(true))
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  const load = useCallback(async (days: number) => {
    setLoading(true)
    setError(null)
    const toMs = Date.now()
    const fromMs = toMs - days * DAY_MS
    try {
      const raw = await host.agent.getLatencySamples(fromMs, toMs)
      setSamples(parseSamples(raw))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      void host.debug.log(`[stats] latency samples failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load(rangeDays)
  }, [open, rangeDays, load])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const dims = useMemo(() => availableDimensions(samples), [samples])

  // Only offer a metric the selected kind actually carries, and fall back to
  // apiMs rather than showing an empty table with no explanation: a compaction
  // has no ttft, and a request record is one request that never waited on a
  // tool, so neither "per request" nor wall time means anything on it.
  const metricsForKind = METRICS.filter(item => item.kinds.includes(kind))
  const effectiveMetric: LatencyMetric = metricsForKind.some(item => item.id === metric)
    ? metric
    : 'apiMs'

  const filter: LatencyFilter = useMemo(
    () => ({ kind, model, effort, autoCompactWindow: compactWindow }),
    [kind, model, effort, compactWindow],
  )
  const shown = useMemo(() => filterSamples(samples, filter), [samples, filter])
  const summary = useMemo(() => overallStat(shown, effectiveMetric), [shown, effectiveMetric])

  const rows = useMemo(() => {
    if (view === 'hour') {
      return hourBuckets(shown, effectiveMetric).map(bucket => ({
        label: formatHour(bucket.hour),
        stat: bucket as LatencyStat,
      }))
    }
    if (view === 'day') {
      return dayBuckets(shown, effectiveMetric).map(bucket => ({
        label: bucket.day,
        stat: bucket as LatencyStat,
      }))
    }
    const dimension = view === 'model' ? 'model' : view === 'effort' ? 'effort' : 'autoCompactWindow'
    return groupBuckets(shown, effectiveMetric, dimension).map(bucket => ({
      label: bucket.label,
      stat: bucket as LatencyStat,
    }))
  }, [view, shown, effectiveMetric])

  if (!open) return null

  const metricLabel = METRICS.find(item => item.id === effectiveMetric)?.summaryLabel ?? 'API time'

  return (
    <div className="claude-plan-overlay" onClick={() => setOpen(false)}>
      <div
        className="claude-plan-modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 1100, width: '86vw', height: '82vh', maxHeight: 860 }}
      >
        <div className="claude-plan-modal-header">
          <span className="claude-plan-modal-title">
            Response Time Statistics
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                fontWeight: 600,
                color: '#e6a700',
                border: '1px solid #e6a700',
                borderRadius: 3,
                padding: '1px 4px',
                verticalAlign: 'middle',
              }}
            >
              EXPERIMENTAL
            </span>
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="claude-plan-modal-close"
              title="Reload"
              style={{ fontSize: 13, opacity: 0.6 }}
              onClick={() => void load(rangeDays)}
            >
              Reload
            </button>
            <button className="claude-plan-modal-close" onClick={() => setOpen(false)}>
              &times;
            </button>
          </div>
        </div>
        <div className="claude-plan-modal-body" style={{ padding: '12px 16px', fontFamily: 'inherit' }}>
          <div style={{ fontSize: 11, color: '#999', lineHeight: 1.6, marginBottom: 10 }}>
            Server-side response time only — how long the API took, not how long you took
            to answer a permission prompt. One API request is the unit, because a turn is
            however many requests the model happened to need and its duration says as much
            about the size of the job as about the speed of the answer. Figures are
            approximate: they are averages over whatever landed in each bucket, and buckets
            under {LOW_SAMPLE_THRESHOLD} samples are marked. Samples are kept for 60 days,
            and only for sessions run since this build. Use <em>Raw records</em> to check
            any figure against the individual records behind it.
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 10, fontSize: 12 }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ color: '#888' }}>Range</span>
              {RANGE_DAYS.map(days => (
                <button key={days} style={chip(rangeDays === days)} onClick={() => setRangeDays(days)}>
                  {days}d
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ color: '#888' }}>Show</span>
              <button
                style={chip(kind === 'request')}
                onClick={() => setKind('request')}
                title="One record per API request, timed here rather than reported by the SDK — so it carries this process's own overhead. The comparable unit: a turn is however many calls the model happened to need."
              >
                Requests
              </button>
              <button
                style={chip(kind === 'turn')}
                onClick={() => setKind('turn')}
                title="One record per turn, using the SDK's own duration_api_ms. Authoritative on absolute API time, but a turn's length says as much about how much work it was as about how fast the API answered."
              >
                Turns
              </button>
              <button style={chip(kind === 'compact')} onClick={() => setKind('compact')}>
                Compactions
              </button>
            </div>
            {metricsForKind.length > 1 && (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span style={{ color: '#888' }}>Metric</span>
                {metricsForKind.map(item => (
                  <button
                    key={item.id}
                    style={chip(effectiveMetric === item.id)}
                    onClick={() => setMetric(item.id)}
                    title={item.title}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {VIEWS.map(item => (
                <button key={item.id} style={chip(view === item.id)} onClick={() => setView(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10, fontSize: 12 }}>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: '#888' }}>
              Model
              <select
                style={SELECT_STYLE}
                value={model ?? ''}
                onChange={e => setModel(e.target.value || null)}
              >
                <option value="">any</option>
                {dims.models.map(value => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: '#888' }}>
              Effort
              <select
                style={SELECT_STYLE}
                value={effort ?? ''}
                onChange={e => setEffort(e.target.value || null)}
              >
                <option value="">any</option>
                {dims.efforts.map(value => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: '#888' }}>
              Compact window
              <select
                style={SELECT_STYLE}
                value={compactWindow === null ? '' : String(compactWindow)}
                onChange={e => setCompactWindow(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">any</option>
                {dims.compactWindows.map(value => (
                  <option key={value} value={value}>
                    {value.toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ fontSize: 12, color: '#bbb', marginBottom: 8 }}>
            {loading ? (
              'Loading…'
            ) : error ? (
              <span style={{ color: '#e05252' }}>Could not read samples: {error}</span>
            ) : (
              <>
                {summary.count.toLocaleString()} {countNoun(kind, effectiveMetric)} with{' '}
                {metricLabel} in the last {rangeDays} days · mean{' '}
                <span style={{ color: '#8be9fd' }}>{formatDuration(summary.meanMs)}</span> · median{' '}
                {formatDuration(summary.medianMs)} · p90{' '}
                <span style={{ color: '#d19a66' }}>{formatDuration(summary.p90Ms)}</span>
                {summary.count > 0 && summary.lowData && (
                  <span style={{ color: '#e6a700' }}> · not much data yet</span>
                )}
              </>
            )}
          </div>

          {view === 'raw' ? (
            <RawTable samples={shown} />
          ) : (
            <StatTable
              rows={rows}
              firstColumn={
                view === 'hour'
                  ? 'hour'
                  : view === 'day'
                    ? 'day'
                    : view === 'model'
                      ? 'model'
                      : view === 'effort'
                        ? 'effort'
                        : 'window'
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}
