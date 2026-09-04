// First-run runtime auto-install (desktop host only).
//
// The managed-runtime installer (Settings → Runtime) shipped without any
// automatic trigger, so a fresh lightweight install came up with NO runtimes
// and nothing offered to fix it (the user had to discover the Settings tab).
// This module closes that gap: shortly after launch it asks the host for
// runtime status and, for every required tool that is MISSING (no managed /
// system / bundled source) but installable, kicks off the managed install in
// the background. Node goes first — the sidecar depends on it.
//
// It also refreshes STALE managed installs: after an app upgrade the runtime
// catalog pin moves, but the resolvers only ever use the pinned directory, so
// an older managed runtime is silently ignored and the app falls back to PATH
// or the bundled copy. The host flags those as `managedStale`; they are
// re-installed the same way (the old version dir is pruned by the installer).
//
// Deliberately quiet: progress/results go to the persistent debug log, and the
// Settings → Runtime tab reflects the outcome. Tools that are 'broken' (a
// source exists but failed its probe) are NOT auto-touched — replacing a
// user's broken-but-present install is a decision, not a default.

import { host } from '../host-api'

type RuntimeTool = 'node' | 'codex' | 'claude'

interface RuntimeItemStatus {
  tool: RuntimeTool
  state: 'ready' | 'missing' | 'installing' | 'broken'
  source: 'managed' | 'system' | 'bundled' | 'missing'
  canInstallManaged: boolean
  message?: string
  pinnedVersion?: string | null
  managedStale?: boolean
}

interface RuntimeStatus {
  node: RuntimeItemStatus
  codex: RuntimeItemStatus
  claude: RuntimeItemStatus
}

const INITIAL_DELAY_MS = 5_000
// Node first: the sidecar (and therefore most agent features) needs it.
const INSTALL_ORDER: RuntimeTool[] = ['node', 'codex', 'claude']

let started = false

/** Missing entirely, or a managed install left behind by an older catalog pin. */
export function shouldAutoInstall(item: Pick<RuntimeItemStatus, 'state' | 'source' | 'managedStale'>): boolean {
  if (item.state === 'missing') return true
  return item.source === 'managed' && item.managedStale === true
}

export function startRuntimeAutoInstall(): void {
  if (started) return
  started = true

  window.setTimeout(() => {
    void (async () => {
      const log = (msg: string) => host.debug.log(`[runtime-auto-install] ${msg}`)
      let status: RuntimeStatus | null
      try {
        status = await host.runtime.getStatus() as RuntimeStatus | null
      } catch (err) {
        log(`getStatus failed: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (!status) return

      const missing = INSTALL_ORDER
        .map(tool => status?.[tool])
        .filter((item): item is RuntimeItemStatus => !!item && item.canInstallManaged && shouldAutoInstall(item))
      if (missing.length === 0) return

      const describe = (item: RuntimeItemStatus) =>
        item.managedStale ? `${item.tool} (stale managed → ${item.pinnedVersion ?? '?'})` : item.tool
      log(`runtimes needing managed install: ${missing.map(describe).join(', ')} — starting`)
      for (const item of missing) {
        try {
          const result = await host.runtime.install(item.tool) as { ok?: boolean; message?: string } | null
          if (result?.ok) {
            log(`installed ${item.tool}`)
          } else {
            log(`install ${item.tool} failed: ${result?.message || 'unknown error'}`)
          }
        } catch (err) {
          log(`install ${item.tool} threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })()
  }, INITIAL_DELAY_MS)
}
