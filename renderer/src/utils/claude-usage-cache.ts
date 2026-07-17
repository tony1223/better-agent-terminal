import { host } from '../host-api'

// Renderer-side cache for the host-wide `claude:usage` broadcast (the Rust
// host runs ONE poller per host, keyed to the active account). Panels read
// the cached snapshot on mount and subscribe for refreshes — they never poll
// themselves, and a panel opened between poll ticks still paints immediately.

export interface HostUsageWindow {
  /** 0-1, same scale as the SDK rate_limit_event. */
  utilization: number | null
  /** Epoch ms, or null when the endpoint omitted it. */
  resetsAt: number | null
}

export type UsageProvider = 'claude' | 'codex'

export interface HostUsageSnapshot {
  provider: UsageProvider
  fiveHour: HostUsageWindow | null
  sevenDay: HostUsageWindow | null
  extraUsage: {
    isEnabled: boolean
    monthlyLimit: number | null
    usedCredits: number | null
    currency: string | null
  } | null
  /** Codex only: subscription plan reported with the rate-limit snapshot. */
  planType: string | null
  accountEmail: string | null
  fetchedAt: number
}

export interface HostRateLimitStateWindow {
  resetsAt: number
  utilization: number | null
  isUsingOverage: boolean
}

export type HostRateLimitState = Record<string, HostRateLimitStateWindow>

// Host snapshots are authoritative for which named windows currently exist.
// Build a fresh state object so a weekly-only Codex response cannot leave an
// older 5h/7d value visible. Per-turn overage/reset details remain compatible
// when the same window is still present.
export function rateLimitsFromHostUsage(
  snapshot: HostUsageSnapshot,
  previous: HostRateLimitState,
): HostRateLimitState {
  const next: HostRateLimitState = {}
  for (const [key, window] of [['five_hour', snapshot.fiveHour], ['seven_day', snapshot.sevenDay]] as const) {
    if (!window) continue
    next[key] = {
      resetsAt: window.resetsAt ?? previous[key]?.resetsAt ?? Date.now(),
      utilization: window.utilization,
      isUsingOverage: previous[key]?.isUsingOverage ?? false,
    }
  }
  return next
}

const lastSnapshots: Partial<Record<UsageProvider, HostUsageSnapshot>> = {}
const listeners = new Set<() => void>()
let started = false

// The Rust poller sends resetsAt as the endpoint's ISO string (no datetime
// dependency host-side); normalize to epoch ms here. Numbers pass through so
// the shape stays compatible if a future producer pre-parses.
function normalizeWindow(value: unknown): HostUsageWindow | null {
  if (!value || typeof value !== 'object') return null
  const w = value as Record<string, unknown>
  const utilization = typeof w.utilization === 'number' ? w.utilization : null
  let resetsAt: number | null = null
  if (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)) {
    resetsAt = w.resetsAt
  } else if (typeof w.resetsAt === 'string') {
    const parsed = Date.parse(w.resetsAt)
    if (Number.isFinite(parsed)) resetsAt = parsed
  }
  if (utilization === null && resetsAt === null) return null
  return { utilization, resetsAt }
}

function ingest(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  const provider: UsageProvider = p.provider === 'codex' ? 'codex' : 'claude'
  const fiveHour = normalizeWindow(p.fiveHour)
  const sevenDay = normalizeWindow(p.sevenDay)
  const hasExplicitWindows = Object.prototype.hasOwnProperty.call(p, 'fiveHour')
    || Object.prototype.hasOwnProperty.call(p, 'sevenDay')
  // A full Codex read can validly contain only unsupported/absent windows.
  // Accept its explicit nulls so stale 5h/7d values are cleared.
  if (!fiveHour && !sevenDay && !(provider === 'codex' && hasExplicitWindows)) return false
  lastSnapshots[provider] = {
    provider,
    fiveHour,
    sevenDay,
    extraUsage: (p.extraUsage && typeof p.extraUsage === 'object')
      ? p.extraUsage as HostUsageSnapshot['extraUsage']
      : null,
    planType: typeof p.planType === 'string' ? p.planType : null,
    accountEmail: typeof p.accountEmail === 'string' ? p.accountEmail : null,
    fetchedAt: typeof p.fetchedAt === 'number' ? p.fetchedAt : Date.now(),
  }
  return true
}

function ensureStarted(): void {
  if (started) return
  started = true
  // Pull the host's last snapshots once: the first broadcast happens ~3s
  // after Rust setup, usually before this webview subscribed.
  try {
    void host.agent.getUsageSnapshot().then((snapshots: Record<string, unknown>) => {
      if (!snapshots || typeof snapshots !== 'object') return
      let changed = false
      for (const value of Object.values(snapshots)) {
        if (ingest(value)) changed = true
      }
      if (changed) listeners.forEach(listener => listener())
    }).catch(() => {})
  } catch { /* old host without the command */ }
  try {
    host.agent.onUsage((payload: unknown) => {
      if (ingest(payload)) listeners.forEach(listener => listener())
    })
  } catch {
    // Host without the usage event surface (e.g. old host over remote):
    // panels simply keep using rate_limit_event data.
  }
}

export function getHostUsageSnapshot(provider: UsageProvider = 'claude'): HostUsageSnapshot | null {
  ensureStarted()
  return lastSnapshots[provider] ?? null
}

export function subscribeHostUsage(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
