// Host API adapter.
//
// Renderer code should import { host } from this module instead of reading
// window.batAppAPI directly. The adapter routes ported namespaces through
// Tauri invoke commands. Anything that isn't ported yet
// throws a clear "not yet implemented" error so missing coverage fails
// loudly instead of silently no-oping.
//
// Runtime selection happens via getHostKind() using Tauri's injected
// window.__TAURI_INTERNALS__ hook; we also accept the legacy __TAURI__ global
// so older shells keep working. We never fall back silently.

import { dispatchTauriNativeDrop } from './utils/tauri-native-drop'

type BatAppAPI = any

export type HostKind = 'tauri' | 'unknown'

interface TauriInternals { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }

export function getHostKind(): HostKind {
  if (typeof globalThis === 'undefined') return 'unknown'
  const g = globalThis as unknown as { window?: unknown }
  const win = g.window as TauriInternals | undefined
  if (!win) return 'unknown'
  if (win.__TAURI_INTERNALS__ !== undefined || win.__TAURI__ !== undefined) return 'tauri'
  return 'unknown'
}

export const isTauri = (): boolean => getHostKind() === 'tauri'

let tauriImpl: BatAppAPI | null = null
let tauriMetricLoggerInstalled = false
let tauriProcessDebugMode: boolean | null = null
let tauriPtyInputTraceMode: boolean | null = null

function resolveHost(): BatAppAPI {
  const kind = getHostKind()
  if (kind === 'tauri') {
    if (!tauriImpl) tauriImpl = createTauriHost()
    return tauriImpl
  }
  throw new Error('host-api: no Tauri host runtime detected')
}

// Single proxy so callers can keep a stable reference. Property reads forward
// to the resolved host object on each access — cheap, and safe across HMR
// reloads where the underlying impl might be swapped.
export const host: BatAppAPI = new Proxy({} as BatAppAPI, {
  get(_target, prop) {
    const target = resolveHost() as unknown as Record<string | symbol, unknown>
    return target[prop]
  },
}) as BatAppAPI

// --- Tauri implementation ----------------------------------------------------
//
// Each ported namespace lives in its own factory so adding the next one is a
// localised change. Anything unported delegates to a "not implemented" stub.

function notImplemented(name: string): never {
  throw new Error(`host-api: ${name} is not yet implemented under Tauri`)
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value)
}

const TAURI_DROP_PATH_TTL_MS = 5000
const TAURI_DROP_PATH_MAX = 200
type TauriDroppedPathEntry = {
  path: string
  name: string
  createdAt: number
  claimed: boolean
}
const tauriDroppedPathCache: TauriDroppedPathEntry[] = []
let tauriDropPathListenerInstalled = false

function basenameForPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function pruneTauriDroppedPathCache(now = Date.now()): void {
  for (let i = tauriDroppedPathCache.length - 1; i >= 0; i--) {
    if (now - tauriDroppedPathCache[i].createdAt > TAURI_DROP_PATH_TTL_MS) {
      tauriDroppedPathCache.splice(i, 1)
    }
  }
  while (tauriDroppedPathCache.length > TAURI_DROP_PATH_MAX) {
    tauriDroppedPathCache.shift()
  }
}

export function registerTauriDroppedPaths(paths: string[], now = Date.now()): void {
  pruneTauriDroppedPathCache(now)
  for (const path of paths) {
    if (!isAbsoluteLocalPath(path)) continue
    const name = basenameForPath(path)
    if (!name) continue
    tauriDroppedPathCache.push({ path, name, createdAt: now, claimed: false })
  }
  pruneTauriDroppedPathCache(now)
}

function getPathFromRecentTauriDrop(file: File): string | null {
  pruneTauriDroppedPathCache()
  const name = (file as File & { name?: unknown }).name
  if (typeof name !== 'string' || !name) return null
  const matches = tauriDroppedPathCache.filter(entry => !entry.claimed && entry.name === name)
  if (matches.length !== 1) return null
  matches[0].claimed = true
  return matches[0].path
}

function getPathFromDroppedFile(file: File): string | null {
  const candidate = file as File & {
    path?: unknown
    mozFullPath?: unknown
    webkitRelativePath?: unknown
  }
  for (const value of [candidate.path, candidate.mozFullPath]) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed && isAbsoluteLocalPath(trimmed)) return trimmed
    }
  }
  // webkitRelativePath is relative to the dropped folder, not a host path.
  return getPathFromRecentTauriDrop(file)
}

function installTauriDropPathCache(api: BatAppAPI): void {
  if (tauriDropPathListenerInstalled) return
  tauriDropPathListenerInstalled = true
  import('@tauri-apps/api/webview')
    .then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(event => {
        const payload = event.payload
        const position = 'position' in payload ? payload.position : null
        const scale = typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0
          ? window.devicePixelRatio
          : 1
        const paths = 'paths' in payload ? payload.paths : []
        if (payload.type === 'drop') registerTauriDroppedPaths(paths)
        dispatchTauriNativeDrop({
          type: payload.type,
          paths,
          x: position ? position.x / scale : null,
          y: position ? position.y / scale : null,
        })
        if (payload.type !== 'drop') return
        void api.debug.log('[tauri:drag-drop]', {
          paths: paths.length,
        }).catch(() => {})
      }))
    .catch(() => {})
}

// We import @tauri-apps/api lazily so nothing in this module pulls Tauri's
// runtime until the Tauri host is available.
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
function getInvoke(): Invoke {
  // Resolved synchronously through the Tauri-injected window global. We do
  // NOT cache because the global gets swapped during HMR and tests, and
  // the property read is cheap.
  const g = (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: { invoke: Invoke } } }).window
  const direct = g?.__TAURI_INTERNALS__?.invoke
  if (direct) return direct
  throw new Error('host-api: tauri invoke not available; ensure window.__TAURI_INTERNALS__ is present')
}

function tauriDebugLog(...args: unknown[]): void {
  try {
    void getInvoke()<void>('debug_log', { args }).catch(() => {})
  } catch {
    // Best-effort instrumentation only.
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function refreshTauriDebugMode(): void {
  try {
    void getInvoke()<boolean>('debug_is_debug_mode')
      .then(value => { tauriProcessDebugMode = value === true })
      .catch(() => {})
  } catch {
    // Best-effort instrumentation only.
  }
}

function refreshTauriPtyInputTraceMode(): void {
  try {
    void getInvoke()<boolean>('debug_is_pty_input_trace')
      .then(value => { tauriPtyInputTraceMode = value === true })
      .catch(() => {})
  } catch {
    // Best-effort instrumentation only.
  }
}

function readTauriDebugMode(): boolean {
  if (tauriProcessDebugMode === true) return true
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env
  const envDebug = env?.BAT_DEBUG ?? env?.VITE_BAT_DEBUG
  if (envDebug === '1' || envDebug === 'true' || envDebug === 'TRUE' || envDebug === true) return true
  const win = (globalThis as unknown as {
    window?: {
      location?: { search?: string }
      localStorage?: { getItem: (key: string) => string | null }
    }
  }).window ?? null
  const params = new URLSearchParams(win?.location?.search || '')
  const debugParam = params.get('BAT_DEBUG')
  if (debugParam === '1' || debugParam === 'true' || debugParam === 'TRUE') return true
  try {
    const stored = win?.localStorage?.getItem('BAT_DEBUG')
    return stored === '1' || stored === 'true' || stored === 'TRUE'
  } catch {
    return false
  }
}

function readTauriPtyInputTraceMode(): boolean {
  if (tauriPtyInputTraceMode === true) return true
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env
  const envTrace = env?.BAT_TRACE_PTY_INPUT ?? env?.VITE_BAT_TRACE_PTY_INPUT
  if (envTrace === '1' || envTrace === 'true' || envTrace === 'TRUE' || envTrace === true) return true
  const win = (globalThis as unknown as {
    window?: {
      location?: { search?: string }
      localStorage?: { getItem: (key: string) => string | null }
    }
  }).window ?? null
  const params = new URLSearchParams(win?.location?.search || '')
  const traceParam = params.get('BAT_TRACE_PTY_INPUT')
  if (traceParam === '1' || traceParam === 'true' || traceParam === 'TRUE') return true
  try {
    const stored = win?.localStorage?.getItem('BAT_TRACE_PTY_INPUT')
    return stored === '1' || stored === 'true' || stored === 'TRUE'
  } catch {
    return false
  }
}

// Tauri's event bus is async (`listen()` returns Promise<UnlistenFn>) but
// the renderer host contract is `onX(cb): () => void`. We adapt by
// resolving listen() synchronously through the Tauri-injected globals,
// which expose a `listen` helper alongside `invoke`. Returning an
// unsubscribe function that awaits the underlying promise is enough — any
// events that fire before the promise resolves will queue at Tauri's
// dispatch layer, so callers don't need to await registration.
type UnlistenFn = () => void
type ListenEvent<T> = { event: string; payload: T; id: number }
type ListenFn = <T>(
  event: string,
  handler: (event: ListenEvent<T>) => void,
) => Promise<UnlistenFn>

function getListen(): ListenFn {
  type Win = { __TAURI_INTERNALS__?: unknown }
  const g = (globalThis as unknown as { window?: Win }).window
  if (!g?.__TAURI_INTERNALS__) {
    throw new Error('host-api: tauri listen not available; ensure window.__TAURI_INTERNALS__ is present')
  }
  // Lazy import: the `@tauri-apps/api/event` module reads
  // window.__TAURI_INTERNALS__ on call, so this only runs under Tauri.
  // We wrap it in a thunk so the import stays lazy
  // that never call host.pty.onOutput / onExit.
  return ((event: string, handler: (e: ListenEvent<unknown>) => void) =>
    import('@tauri-apps/api/event').then(m => m.listen(event, handler))
  ) as ListenFn
}

function listenAdapter<T>(
  event: string,
  cb: (payload: T) => void,
): UnlistenFn {
  let unlisten: UnlistenFn | null = null
  let cancelled = false
  getListen()<T>(event, e => cb(e.payload))
    .then(fn => {
      if (cancelled) fn()
      else unlisten = fn
    })
    .catch(() => { /* ignore — listen failed; caller already has noop */ })
  return () => {
    cancelled = true
    if (unlisten) unlisten()
  }
}

let currentWindowIdForEventPromise: Promise<string | null> | null = null
function getCurrentWindowIdForEvent(): Promise<string | null> {
  if (!currentWindowIdForEventPromise) {
    currentWindowIdForEventPromise = getInvoke()<string | null>('app_get_window_id')
      .catch(() => null)
  }
  return currentWindowIdForEventPromise
}

function listenTargetedStringPayload(
  event: string,
  valueKey: string,
  cb: (value: string) => void,
): UnlistenFn {
  return listenAdapter<unknown>(event, payload => {
    let value: string | null = null
    let targetWindowId: string | null = null
    if (typeof payload === 'string') {
      value = payload
    } else if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>
      value = typeof record[valueKey] === 'string' ? record[valueKey] : null
      targetWindowId = typeof record.windowId === 'string' ? record.windowId : null
    }
    if (!value) return
    if (!targetWindowId) {
      cb(value)
      return
    }
    void getCurrentWindowIdForEvent().then(currentWindowId => {
      if (currentWindowId === targetWindowId) cb(value)
    })
  })
}

// Stamp the agent session's workspace identity onto the start/resume
// options. The notification center needs this to label and route entries
// by workspace — several workspaces can share one cwd and window, so the
// path alone can't tell them apart. Best-effort: the session id is the
// terminal id, but if the terminal/workspace can't be resolved we leave
// the options untouched and the Rust side falls back to the cwd.
async function attachWorkspaceIdentity(
  sessionId: string,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const { workspaceStore } = await import('./stores/workspace-store')
    const state = workspaceStore.getState()
    const terminal = state.terminals.find(t => t.id === sessionId)
    if (!terminal) return options
    const workspace = state.workspaces.find(w => w.id === terminal.workspaceId)
    if (!workspace) return options
    return {
      ...options,
      workspaceId: workspace.id,
      workspaceName: workspace.alias?.trim() || workspace.name,
    }
  } catch {
    return options
  }
}

async function getAgentPresetForSession(sessionId: string): Promise<string | undefined> {
  try {
    const { workspaceStore } = await import('./stores/workspace-store')
    return workspaceStore.getState().terminals.find(t => t.id === sessionId)?.agentPreset
  } catch {
    return undefined
  }
}

const CLAUDE_EVENT_PAYLOAD_KEYS: Record<string, string> = {
  onMessage: 'message',
  onToolUse: 'toolCall',
  onToolResult: 'result',
  onResult: 'result',
  onTurnEnd: 'payload',
  onError: 'error',
  onStream: 'data',
  onStatus: 'meta',
  onCommands: 'commands',
  onModeChange: 'mode',
  onPermissionRequest: 'data',
  onAskUser: 'data',
  onPermissionResolved: 'toolUseId',
  onAskUserResolved: 'toolUseId',
  onHistory: 'items',
  onResumeLoading: 'loading',
  onSessionReset: '__none__',
  onRateLimit: 'info',
  onWorktreeInfo: 'payload',
  onPromptSuggestion: 'suggestion',
  onTask: 'task',
}

const CLAUDE_EVENT_PAYLOAD_FALLBACKS = new Set(['onHistory', 'onResumeLoading'])

export function resolveClaudeEventSecondArg(
  listenerKey: string,
  payload: Record<string, unknown>,
): unknown {
  const payloadKey = CLAUDE_EVENT_PAYLOAD_KEYS[listenerKey] || 'payload'
  if (payloadKey === '__none__') return undefined
  if (Object.prototype.hasOwnProperty.call(payload, payloadKey)) {
    return payload[payloadKey]
  }
  if (
    CLAUDE_EVENT_PAYLOAD_FALLBACKS.has(listenerKey)
    && Object.prototype.hasOwnProperty.call(payload, 'payload')
  ) {
    return payload.payload
  }
  return payload[payloadKey]
}

type PtyOutputPayload = { id: string; data: string }
type PtyExitPayload = { id: string; exitCode: number }
export type TerminalViewportMode = 'desktop' | 'mobile'
export type TerminalViewportSource = 'desktop' | 'mobile'
export type TerminalViewportState = {
  mode: TerminalViewportMode
  cols: number
  rows: number
  updatedBy: TerminalViewportSource
  updatedAt: number
}
export type SetViewportModeOptions = {
  cols?: number
  rows?: number
  source: TerminalViewportSource
}
type PtyViewportStatePayload = { id: string; state: TerminalViewportState }
type SidecarMetricPayload = {
  phase: string
  method?: string
  elapsedMs: number
  ok: boolean
}
type NotificationEntry = {
  id: string
  sessionId: string
  windowId: string | null
  profileId: string | null
  workspaceId?: string
  workspaceName: string
  cwd: string
  reason: 'completed' | 'error' | 'aborted' | 'connected'
  result?: string
  error?: string
  timestamp: number
  read: boolean
  agentKind?: 'claude' | 'codex'
  kind?: 'remote-client'
  title?: string
}
type ProfileWindowCloseAction = 'temporary' | 'removeFromProfile' | 'cancel'
type ProfileWindowCloseRequest = {
  windowId: string
  profileId: string
  windowIndex: number
  windowCount: number
}

function createTauriHost(): BatAppAPI {
  // Build a partial implementation: only ported namespaces are real; the rest
  // throw via a Proxy so missing coverage fails loudly.
  refreshTauriDebugMode()
  refreshTauriPtyInputTraceMode()
  const platform = detectPlatform()
  const ported: Record<string, unknown> = {
    platform,
    systemVersion: '',
    settings: {
      load: () => getInvoke()<string | null>('settings_load'),
      save: (data: string) => getInvoke()<void>('settings_save', { data }),
      // Tauri auto-camelCases Rust args, so `shell_type: String` lands as
      // `shellType` in the invoke payload.
      getShellPath: (shell: string) =>
        getInvoke()<string>('settings_get_shell_path', { shellType: shell }),
      clearTerminalHistory: () => getInvoke()<boolean>('settings_clear_terminal_history'),
      detectCx: () => getInvoke()<{
        enabled: boolean
        detected: boolean
        path?: string
        version?: string
        cacheDir: string
        error?: string
      }>('settings_detect_cx'),
    },
    runtime: {
      getStatus: () => getInvoke()<unknown>('runtime_get_status'),
      install: (tool: string) => getInvoke()<unknown>('runtime_install', { tool }),
      openRuntimeFolder: () => getInvoke()<void>('runtime_open_runtime_folder'),
      clearManaged: (tool?: string) =>
        getInvoke()<void>('runtime_clear_managed', tool ? { tool } : {}),
      onChanged: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('runtime:changed', callback),
    },
    shell: {
      openExternal: (url: string) => getInvoke()<void>('shell_open_external', { url }),
      openPath: (path: string) => getInvoke()<void>('shell_open_path', { path }),
      // Opens the containing folder with the item selected, like a native
      // right-click "Show in Folder". Distinct from openPath, which hands the
      // file to its default app.
      revealPath: (path: string) => getInvoke()<void>('shell_reveal_path', { path }),
      // Tauri native drag/drop routes absolute paths through webview events.
      // Browser File drops can still reach this fallback in non-native builds;
      // use a cached/native or non-standard path when present, otherwise return
      // null so callers can fall back to dataURL or native pickers.
      getPathForFile: (file: File) => getPathFromDroppedFile(file),
    },
    dialog: {
      confirm: (message: string, title?: string) =>
        getInvoke()<boolean>('dialog_confirm', { message, title }),
      selectFolder: () => getInvoke()<string[] | null>('dialog_select_folder'),
      selectImages: () => getInvoke()<string[]>('dialog_select_images'),
      selectFiles: () => getInvoke()<string[]>('dialog_select_files'),
    },
    clipboard: {
      writeText: (text: string) => getInvoke()<boolean>('clipboard_write_text', { text }),
      saveImage: () => getInvoke()<string | null>('clipboard_save_image'),
      writeImage: (filePath: string) => getInvoke()<boolean>('clipboard_write_image', { filePath }),
      // The host emits app:copy-shortcut from a global copy shortcut. Tauri has
      // no equivalent hook here, so emulate the same renderer callback from
      // a capture-phase keydown listener.
      onCopyShortcut: (callback: () => void) => {
        if (typeof document === 'undefined') return () => {}
        const handler = (event: KeyboardEvent) => {
          if (event.defaultPrevented) return
          if (event.shiftKey || !(event.ctrlKey || event.metaKey)) return
          if (event.key.toLowerCase() !== 'c') return
          callback()
        }
        document.addEventListener('keydown', handler, true)
        return () => document.removeEventListener('keydown', handler, true)
      },
    },
    image: {
      readAsDataUrl: (filePath: string) =>
        getInvoke()<string>('image_read_as_data_url', { path: filePath }),
      saveDataUrl: (dataUrl: string, defaultName?: string) =>
        getInvoke()<string | null>('image_save_data_url', { dataUrl, defaultName }),
    },
    fs: {
      readFile: (filePath: string) =>
        getInvoke()<{ content?: string; error?: string; size?: number }>(
          'fs_read_file',
          { path: filePath },
        ),
      readdir: (dirPath: string) =>
        getInvoke()<{ name: string; path: string; isDirectory: boolean }[]>(
          'fs_readdir',
          { dirPath },
        ),
      isDirectory: (path: string) => getInvoke()<boolean>('fs_is_directory', { path }),
      home: () => getInvoke()<string>('fs_home'),
      listDirs: (dirPath: string, includeHidden: boolean) =>
        getInvoke()<
          | { current: string; parent: string | null; entries: { name: string; path: string }[] }
          | { error: string }
        >('fs_list_dirs', { dirPath, includeHidden }),
      mkdir: (parentPath: string, name: string) =>
        getInvoke()<{ path: string } | { error: string }>('fs_mkdir', { parentPath, name }),
      deletePath: (targetPath: string) =>
        getInvoke()<{ path: string } | { error: string }>('fs_delete_path', { targetPath }),
      quickLocations: () =>
        getInvoke()<{ name: string; path: string; kind: 'home' | 'drive' | 'volume' | 'root' }[]>(
          'fs_quick_locations',
        ),
      search: (dirPath: string, query: string, filesOnly = false) =>
        getInvoke()<{ name: string; path: string; isDirectory: boolean }[]>(
          'fs_search',
          { dirPath, query, ...(filesOnly ? { filesOnly: true } : {}) },
        ),
      // Path-link resolution and file watching are native Rust routes.
      // They keep the renderer-facing path/result/event contract intact.
      resolvePathLinks: (cwd: string, rawPaths: string[]) =>
        getInvoke()<
          { rawPath: string; path: string; exists: boolean; line?: number; column?: number }[]
        >('fs_resolve_path_links', { cwd, rawPaths }),
      // Upload a CLIENT-LOCAL file into a workspace directory (local copy, or
      // chunked stream to the host in remote mode). Resolves with the final path.
      uploadToDir: (localPath: string, destDir: string) =>
        getInvoke()<string>('fs_upload_to_dir', { localPath, destDir }),
      // Save a workspace file to a client-local location via the native save
      // dialog (local copy, or chunked pull from the host in remote mode).
      // Resolves with the saved path, or null when the user cancels.
      downloadFile: (sourcePath: string) =>
        getInvoke()<string | null>('fs_download_file', { sourcePath }),
      watch: (dirPath: string) => getInvoke()<boolean>('fs_watch', { dirPath }),
      unwatch: (dirPath: string) => getInvoke()<boolean>('fs_unwatch', { dirPath }),
      onChanged: (callback: (dirPath: string) => void) =>
        listenAdapter<string>('fs:changed', callback),
    },
    update: {
      getVersion: () => getInvoke()<string>('update_get_version'),
      // Tauri handles this natively in Rust and returns the same
      // shape consumed by UpdateNotification.
      // Returns the same shape the renderer's UpdateNotification consumed
      // as { hasUpdate, currentVersion, latestRelease }.
      check: () => getInvoke()<unknown>('update_check'),
      // Auto-updater (tauri-plugin-updater): bundle mode drives which
      // per-mode manifest is fetched; channel is 'stable' | 'pre'.
      getBundleMode: () => getInvoke()<'all-in-one' | 'lightweight'>('update_get_bundle_mode'),
      checkNative: (channel: 'stable' | 'pre') =>
        getInvoke()<{ available: boolean; currentVersion: string; version?: string; notes?: string | null; channel: string }>(
          'update_check_native',
          { channel },
        ),
      install: (channel: 'stable' | 'pre') =>
        getInvoke()<{ installed: boolean; version?: string; reason?: string }>('update_install', { channel }),
      onDownloadProgress: (callback: (payload: { downloaded: number; total: number | null }) => void) =>
        listenAdapter<{ downloaded: number; total: number | null }>('update://download-progress', callback),
      onDownloadFinished: (callback: () => void) =>
        listenAdapter<unknown>('update://download-finished', () => callback()),
    },
    debug: {
      // Renderer logs forward to Rust and are persisted under
      // <app-data>/logs/debug.log, matching the previous debuggability.
      log: (...args: unknown[]) => getInvoke()<void>('debug_log', { args }),
      openLogsFolder: () => getInvoke()<boolean>('debug_open_logs_folder'),
      // The renderer reads this synchronously during render.
      get isDebugMode() { return readTauriDebugMode() },
      // High-volume, potentially sensitive key tracing is opt-in and separate
      // from ordinary BAT_DEBUG diagnostics.
      get isPtyInputTrace() { return readTauriPtyInputTraceMode() },
    },
    workspace: {
      load: () => getInvoke()<string | null>('workspace_load'),
      save: (data: string) => getInvoke()<boolean>('workspace_save', { data }),
      detach: (workspaceId: string) =>
        getInvoke()<boolean>('workspace_detach', { workspaceId }),
      reattach: (workspaceId: string) =>
        getInvoke()<boolean>('workspace_reattach', { workspaceId }),
      moveToWindow: (
        sourceWindowId: string,
        targetWindowId: string,
        workspaceId: string,
        insertIndex: number,
      ) => getInvoke()<boolean>('workspace_move_to_window', {
        sourceWindowId,
        targetWindowId,
        workspaceId,
        insertIndex,
      }),
      getDetachedId: () => {
        const search = typeof window !== 'undefined' ? window.location?.search || '' : ''
        return new URLSearchParams(search).get('detached')
      },
      onDetached: (callback: (workspaceId: string) => void) =>
        listenTargetedStringPayload('workspace:detached', 'workspaceId', callback),
      onReattached: (callback: (workspaceId: string) => void) =>
        listenTargetedStringPayload('workspace:reattached', 'workspaceId', callback),
      onReload: (callback: (data?: unknown) => void) =>
        listenAdapter<unknown>('workspace:reload', callback),
    },
    profile: {
      // Tauri persists profile metadata and local profile snapshots using the
      // profile JSON layout. Multi-window profile open/restore lives
      // under app.openNewInstance / app.restoreActiveProfiles below.
      list: () => getInvoke()<unknown>('profile_list'),
      listLocal: () => getInvoke()<unknown>('profile_list_local'),
      get: (profileId: string) => getInvoke()<unknown>('profile_get', { profileId }),
      getActiveIds: () => getInvoke()<string[]>('profile_get_active_ids'),
      onChanged: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('profile:changed', callback),
      create: (name: string, options?: unknown) =>
        getInvoke()<unknown>('profile_create', { name, options }),
      save: (profileId: string) => getInvoke()<boolean>('profile_save', { profileId }),
      load: (profileId: string) => getInvoke()<unknown>('profile_load', { profileId }),
      delete: (profileId: string) =>
        getInvoke()<boolean>('profile_delete', { profileId }),
      rename: (profileId: string, newName: string) =>
        getInvoke()<boolean>('profile_rename', { profileId, newName }),
      update: (profileId: string, updates: unknown) =>
        getInvoke()<boolean>('profile_update', { profileId, updates }),
      duplicate: (profileId: string, newName: string) =>
        getInvoke()<unknown>('profile_duplicate', { profileId, newName }),
      activate: (profileId: string) =>
        getInvoke()<void>('profile_activate', { profileId }),
      deactivate: (profileId: string) =>
        getInvoke()<void>('profile_deactivate', { profileId }),
    },
    snippet: {
      // JSON-backed env snippet store. Mirrors
      // the snippet store. Tauri auto-camelCases struct field
      // names, so e.g. CreateSnippetInput.workspace_id surfaces as
      // workspaceId in the invoke payload.
      getAll: () => getInvoke()<unknown[]>('snippet_get_all'),
      getById: (id: number) => getInvoke()<unknown>('snippet_get_by_id', { id }),
      getFavorites: () => getInvoke()<unknown[]>('snippet_get_favorites'),
      search: (query: string) => getInvoke()<unknown[]>('snippet_search', { query }),
      getByWorkspace: (workspaceId?: string) =>
        getInvoke()<unknown[]>('snippet_get_by_workspace', { workspaceId }),
      getCategories: () => getInvoke()<string[]>('snippet_get_categories'),
      create: (input: unknown) => getInvoke()<unknown>('snippet_create', { input }),
      update: (id: number, updates: unknown) =>
        getInvoke()<unknown>('snippet_update', { id, updates }),
      delete: (id: number) => getInvoke()<boolean>('snippet_delete', { id }),
      toggleFavorite: (id: number) =>
        getInvoke()<unknown>('snippet_toggle_favorite', { id }),
    },
    notification: {
      // In-memory store on the Rust side — see
      // src-tauri/src/commands/notification.rs. Push updates fire
      // via the "notification:update" Tauri event.
      list: () => getInvoke()<NotificationEntry[]>('notification_list'),
      markRead: (id: string) => getInvoke()<boolean>('notification_mark_read', { id }),
      markAllRead: () => getInvoke()<boolean>('notification_mark_all_read'),
      markWindowRead: () => getInvoke()<boolean>('notification_mark_window_read'),
      clear: () => getInvoke()<boolean>('notification_clear'),
      focusLatestUnread: () =>
        getInvoke()<{ id: string; windowId: string } | null>('notification_focus_latest_unread'),
      focusEntry: (id: string) =>
        getInvoke()<{ id: string; windowId: string } | null>('notification_focus_entry', { id }),
      onUpdate: (cb: (entries: NotificationEntry[]) => void) =>
        listenAdapter<NotificationEntry[]>('notification:update', cb),
      // Fired at this window after a notification is focused — payload is
      // the workspace id the agent ran in, so the renderer can switch to
      // that workspace tab (focusing the OS window alone isn't enough).
      onActivateWorkspace: (cb: (workspaceId: string) => void) =>
        listenTargetedStringPayload('notification:activate-workspace', 'workspaceId', cb),
    },
    system: {
      // Tauri does not expose a power-monitor resume event here.
      // Approximate it from renderer lifecycle signals so remote/account
      // status refreshes after the app comes back from sleep or network
      // reconnect. This stays behind the existing system.onResume contract.
      onResume: (cb: () => void) => {
        const win = typeof window !== 'undefined' ? window : null
        const doc = typeof document !== 'undefined' ? document : null
        if (!win?.addEventListener) return () => {}
        let hiddenAt = 0
        let lastFired = 0
        const fire = () => {
          const now = Date.now()
          if (now - lastFired < 1000) return
          lastFired = now
          cb()
        }
        const onVisibility = () => {
          if (!doc) return
          if (doc.visibilityState === 'hidden') {
            hiddenAt = Date.now()
            return
          }
          if (hiddenAt && Date.now() - hiddenAt > 5000) fire()
          hiddenAt = 0
        }
        const onFocus = () => {
          if (hiddenAt && Date.now() - hiddenAt > 5000) fire()
        }
        const onOnline = () => fire()
        doc?.addEventListener?.('visibilitychange', onVisibility)
        win.addEventListener('focus', onFocus)
        win.addEventListener('online', onOnline)
        return () => {
          doc?.removeEventListener?.('visibilitychange', onVisibility)
          win.removeEventListener('focus', onFocus)
          win.removeEventListener('online', onOnline)
        }
      },
    },
    app: {
      // Tauri window/profile shell: see src-tauri/src/commands/app.rs.
      getWindowId: () => getInvoke()<string | null>('app_get_window_id'),
      getWindowIndex: () => getInvoke()<number>('app_get_window_index'),
      getLaunchProfile: () => getInvoke()<string | null>('app_get_launch_profile'),
      getWindowProfile: () => getInvoke()<string | null>('app_get_window_profile'),
      setTitle: (title: string) => getInvoke()<void>('app_set_title', { title }),
      resolveProfileWindowClose: (action: ProfileWindowCloseAction) =>
        getInvoke()<boolean>('app_resolve_profile_window_close', { action }),
      onProfileWindowCloseRequested: (callback: (request: ProfileWindowCloseRequest) => void) =>
        listenAdapter<ProfileWindowCloseRequest>('app:profile-window-close-requested', request => {
          if (!request?.windowId) return
          void getCurrentWindowIdForEvent().then(currentWindowId => {
            if (currentWindowId === request.windowId) callback(request)
          })
        }),
      // The Statistics menu item. Rust emits this to one window only (the focused
      // one), so unlike the close request above it needs no windowId filter —
      // adding one would just race the async window-id lookup.
      onStatsRequested: (callback: () => void) =>
        listenAdapter<unknown>('app:stats-requested', () => callback()),
      newWindow: () => getInvoke()<string>('app_new_window'),
      takeFreshWindowFlag: () => getInvoke()<boolean>('app_take_fresh_window_flag'),
      focusNextWindow: () => getInvoke()<boolean>('app_focus_next_window'),
      openNewInstance: (profileId: string) =>
        getInvoke()<{ alreadyOpen: boolean; windowIds?: string[]; error?: string }>(
          'app_open_new_instance',
          { profileId },
        ),
      restoreActiveProfiles: (currentProfileId?: string | null) =>
        getInvoke()<string[]>('app_restore_active_profiles', { currentProfileId }),
      setDockBadge: (count: number) => getInvoke()<void>('app_set_dock_badge', { count }),
    },
    github: {
      // gh CLI shell-out — see src-tauri/src/commands/github.rs.
      // Read commands return either parsed JSON (Value passes through
      // as `unknown`) or `{error: msg}` matching the renderer shape.
      checkCli: () =>
        getInvoke()<{ installed: boolean; authenticated: boolean }>('github_check_cli'),
      listPRs: (cwd: string) => getInvoke()<unknown>('github_pr_list', { cwd }),
      listIssues: (cwd: string) => getInvoke()<unknown>('github_issue_list', { cwd }),
      viewPR: (cwd: string, number: number) =>
        getInvoke()<unknown>('github_pr_view', { cwd, number }),
      viewIssue: (cwd: string, number: number) =>
        getInvoke()<unknown>('github_issue_view', { cwd, number }),
      commentPR: (cwd: string, number: number, body: string) =>
        getInvoke()<{ success: true } | { error: string }>(
          'github_pr_comment',
          { cwd, number, body },
        ),
      commentIssue: (cwd: string, number: number, body: string) =>
        getInvoke()<{ success: true } | { error: string }>(
          'github_issue_comment',
          { cwd, number, body },
        ),
    },
    codex: {
      accountInfo: () => getInvoke()<unknown>('codex_account_info'),
      accountList: () => getInvoke()<unknown>('codex_account_list'),
      accountSwitch: (codexHome: string) =>
        getInvoke()<unknown>('codex_account_switch', { codexHome }),
      // Tier 2 unified-account model (opt-in shared sessions).
      unifiedStatus: () => getInvoke()<unknown>('codex_unified_status'),
      unifiedMigrate: () => getInvoke()<unknown>('codex_unified_migrate'),
      accountCaptureCurrent: (label?: string) =>
        getInvoke()<unknown>('codex_account_capture_current', { label }),
      accountRemove: (accountId: string) =>
        getInvoke()<unknown>('codex_account_remove_unified', { accountId }),
      accountLogin: (apiKey?: string) =>
        getInvoke()<unknown>('codex_account_login', { apiKey }),
      accountLoginCancel: () =>
        getInvoke()<unknown>('codex_account_login_cancel'),
      // Structured app-server device login (remote hosts): start returns the
      // URL, one-time code, and opaque login id; poll/cancel echo that id.
      authLoginDeviceStart: () =>
        getInvoke()<{ ok?: boolean; url?: string; code?: string; loginId?: string; error?: string }>(
          'codex_account_login_device_start',
        ),
      authLoginDevicePoll: (loginId?: string) =>
        getInvoke()<{ status?: string; account?: unknown; error?: string }>(
          'codex_account_login_device_poll',
          loginId ? { loginId } : undefined,
        ),
      authLoginDeviceCancel: (loginId?: string) =>
        getInvoke()<unknown>(
          'codex_account_login_device_cancel',
          loginId ? { loginId } : undefined,
        ),
      // Codex Fugu (Sakana provider) config — write the provider block + key
      // into ~/.codex so the app-server can route the fugu model to provider
      // "sakana". BAT_DEBUG-gated feature.
      fuguStatus: () =>
        getInvoke()<{ codexHome: string | null; providerConfigured: boolean; keyConfigured: boolean }>('codex_fugu_status'),
      fuguSetKey: (apiKey: string) =>
        getInvoke()<{ codexHome: string | null; providerConfigured: boolean; keyConfigured: boolean }>('codex_fugu_set_key', { apiKey }),
    },
    git: {
      // Read-only git wrappers — see src-tauri/src/commands/git.rs.
      // The Rust side returns safe defaults (None / empty Vec / empty String)
      // when git fails or the cwd isn't a repo, mirroring the host handlers.
      getGithubUrl: (folderPath: string) =>
        getInvoke()<string | null>('git_get_github_url', { folderPath }),
      getBranch: (cwd: string) =>
        getInvoke()<string | null>('git_get_branch', { cwd }),
      getLog: (cwd: string, count?: number) =>
        getInvoke()<{ hash: string; author: string; date: string; message: string }[]>(
          'git_get_log',
          { cwd, count },
        ),
      getDiff: (cwd: string, commitHash?: string, filePath?: string) =>
        getInvoke()<string>('git_get_diff', { cwd, commitHash, filePath }),
      getDiffFiles: (cwd: string, commitHash?: string) =>
        getInvoke()<{ status: string; file: string }[]>(
          'git_get_diff_files',
          { cwd, commitHash },
        ),
      getRoot: (cwd: string) =>
        getInvoke()<string | null>('git_get_root', { cwd }),
      getStatus: (cwd: string) =>
        getInvoke()<{ status: string; file: string }[]>('git_get_status', { cwd }),
    },
    claude: new Proxy({}, {
      // The Claude surface is large (30+ host methods).
      // Phase 2 ports authStatus/accountList plus the four session
      // lifecycle calls and six event-stream listeners that the renderer
      // attaches at startup. Everything else still throws a per-method
      // "not yet implemented". claude_ping is internal-only.
      get(_t, prop) {
        const key = String(prop)
        if (key === 'authStatus') {
          return () => getInvoke()<unknown>('claude_auth_status')
        }
        if (key === 'accountList') {
          return () => getInvoke()<unknown>('claude_account_list')
        }
        if (key === 'startSession') {
          return async (sessionId: string, options: unknown) =>
            getInvoke()<unknown>('claude_start_session', {
              sessionId,
              options: options == null
                ? options
                : await attachWorkspaceIdentity(sessionId, options as Record<string, unknown>),
            })
        }
        if (key === 'sendMessage') {
          return async (
            sessionId: string,
            prompt: string,
            images?: string[],
            autoCompactWindow?: number | null,
            clientMessage?: { id?: string; displayContent?: string; suppressUserEcho?: boolean },
          ) => {
            const startedAt = performance.now()
            tauriDebugLog('[tauri:claude.sendMessage] start', {
              sessionId,
              promptLen: prompt.length,
              images: images?.length ?? 0,
              autoCompactWindow: autoCompactWindow ?? null,
            })
            try {
              const result = await getInvoke()<unknown>('claude_send_message', {
                sessionId,
                prompt,
                images,
                autoCompactWindow,
                clientMessageId: clientMessage?.id,
                displayPrompt: clientMessage?.displayContent,
                suppressUserEcho: clientMessage?.suppressUserEcho,
              })
              tauriDebugLog('[tauri:claude.sendMessage] end', {
                sessionId,
                ok: true,
                elapsedMs: Math.round(performance.now() - startedAt),
              })
              return result
            } catch (err) {
              tauriDebugLog('[tauri:claude.sendMessage] end', {
                sessionId,
                ok: false,
                elapsedMs: Math.round(performance.now() - startedAt),
                error: formatUnknownError(err),
              })
              throw err
            }
          }
        }
        if (key === 'stopSession') {
          return (sessionId: string) =>
            getInvoke()<unknown>('claude_stop_session', { sessionId })
        }
        if (key === 'abortSession') {
          return (sessionId: string) =>
            getInvoke()<unknown>('claude_abort_session', { sessionId })
        }
        if (key === 'interruptTurn') {
          return (sessionId: string) =>
            getInvoke()<unknown>('claude_interrupt_turn', { sessionId })
        }
        if (key === 'stopTask') {
          return (sessionId: string, taskId: string) =>
            getInvoke()<boolean>('claude_stop_task', { sessionId, taskId })
        }
        // rewindToPrompt: cut the SDK session transcript at the given
        // user-prompt index and rebuild as a new SDK session id.
        if (key === 'rewindToPrompt') {
          return (sessionId: string, promptIndex: number) =>
            getInvoke()<unknown>('claude_rewind_to_prompt', { sessionId, promptIndex })
        }
        // forkSession: ask the SDK to copy the current SDK transcript into a
        // new SDK session id so the renderer can branch the conversation
        // without losing the original. Returns { newSdkSessionId } on
        // success, or null when the fork couldn't run (no current id, SDK
        // missing, abort).
        if (key === 'forkSession') {
          return (sessionId: string) =>
            getInvoke()<unknown>('claude_fork_session', { sessionId })
        }
        // fetchSubagentMessages: load the per-message expansion of an
        // Agent/Task subagent run so the renderer can show the inner
        // message stream. Returns [] when the SDK helper is unavailable
        // or the agent transcript can't be located — same contract as
        // the host, which lets the panel fall back to a single-line
        // summary instead of throwing.
        if (key === 'fetchSubagentMessages') {
          return (sessionId: string, agentToolUseId: string) =>
            getInvoke()<unknown>('claude_fetch_subagent_messages', { sessionId, agentToolUseId })
        }
        // Resting UX: pause/resume a session without destroying its SDK
        // session id. restSession aborts in-flight + emits a system hint;
        // the next sendMessage auto-wakes via the sidecar's
        // s.isResting=false flip.
        if (key === 'restSession') {
          return (sessionId: string) =>
            getInvoke()<unknown>('claude_rest_session', { sessionId })
        }
        if (key === 'wakeSession') {
          return (sessionId: string) =>
            getInvoke()<unknown>('claude_wake_session', { sessionId })
        }
        if (key === 'isResting') {
          return (sessionId: string) =>
            getInvoke()<unknown>('claude_is_resting', { sessionId })
        }
        // Conversation archive ops — append/page/clear off-screen
        // messages to a per-session JSONL under <data-dir>/message-archives/.
        if (key === 'archiveMessages') {
          return (sessionId: string, messages: unknown[]) =>
            getInvoke()<boolean>('claude_archive_messages', { sessionId, messages })
        }
        if (key === 'loadArchived') {
          return (sessionId: string, offset: number, limit: number) =>
            getInvoke()<{ messages: unknown[]; total: number; hasMore: boolean }>(
              'claude_load_archived',
              { sessionId, offset, limit },
            )
        }
        if (key === 'clearArchive') {
          return (sessionId: string) =>
            getInvoke()<boolean>('claude_clear_archive', { sessionId })
        }
        // resumeSession: rehydrate an existing SDK session id so the next
        // sendMessage continues that conversation instead of starting
        // fresh. Renderer panels call this on remount when they have a
        // savedSdkSessionId from a prior run.
        if (key === 'resumeSession') {
          return async (
            sessionId: string,
            sdkSessionId: string,
            cwd: string,
            model?: string,
            apiVersion?: string,
            useWorktree?: boolean,
            worktreePath?: string,
            worktreeBranch?: string,
            agentPreset?: string,
            codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
            codexApprovalPolicy?: 'untrusted' | 'on-request' | 'never',
            permissionMode?: string,
            effort?: string,
            ultracode?: boolean,
            autoCompactWindow?: number | null,
          ) => getInvoke()<unknown>('claude_resume_session', {
            sessionId,
            sdkSessionId,
            options: await attachWorkspaceIdentity(sessionId, {
              cwd,
              model,
              apiVersion,
              ...(useWorktree ? { useWorktree, worktreePath, worktreeBranch } : {}),
              ...(agentPreset ? { agentPreset } : {}),
              ...(codexSandboxMode ? { codexSandboxMode } : {}),
              ...(codexApprovalPolicy ? { codexApprovalPolicy } : {}),
              ...(permissionMode ? { permissionMode } : {}),
              ...(effort ? { effort } : {}),
              ...(ultracode ? { ultracode } : {}),
              // number = enforce this auto-compact window; null = explicitly
              // uncapped (context-only preset); undefined = let the sidecar
              // derive it from the model preset id.
              ...(typeof autoCompactWindow === 'number' || autoCompactWindow === null ? { autoCompactWindow } : {}),
            }),
          })
        }
        // clientResume: like resumeSession, but the host re-emits the session's
        // history WITHOUT disturbing it when it already exists there (e.g. a
        // remote host that has the session open), and only does a real resume
        // when the session is absent. Remote panels call this on remount so the
        // transcript loads even when the host keeps the session live — plain
        // getSessionState comes back empty in that case and would render blank.
        if (key === 'clientResume') {
          return async (
            sessionId: string,
            sdkSessionId: string,
            cwd: string,
            model?: string,
            apiVersion?: string,
            useWorktree?: boolean,
            worktreePath?: string,
            worktreeBranch?: string,
            agentPreset?: string,
            codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
            codexApprovalPolicy?: 'untrusted' | 'on-request' | 'never',
            permissionMode?: string,
            effort?: string,
            ultracode?: boolean,
          ) => getInvoke()<unknown>('claude_client_resume', {
            sessionId,
            sdkSessionId,
            options: await attachWorkspaceIdentity(sessionId, {
              cwd,
              model,
              apiVersion,
              ...(useWorktree ? { useWorktree, worktreePath, worktreeBranch } : {}),
              ...(agentPreset ? { agentPreset } : {}),
              ...(codexSandboxMode ? { codexSandboxMode } : {}),
              ...(codexApprovalPolicy ? { codexApprovalPolicy } : {}),
              ...(permissionMode ? { permissionMode } : {}),
              ...(effort ? { effort } : {}),
              ...(ultracode ? { ultracode } : {}),
            }),
          })
        }
        // Account / auth ops.
        if (key === 'authLogout') return () => getInvoke()<unknown>('claude_auth_logout')
        // Interactive URL ("paste code") login. The host command runs the flow
        // locally or forwards it to the remote host, so this is the only login
        // path: `claude auth login` redirects to a hosted callback page, so
        // nothing but the user can supply the code.
        if (key === 'authLoginStart') {
          return () => getInvoke()<{
            ok: boolean
            url?: string
            loginId?: string
            error?: string
          }>('claude_auth_login_start')
        }
        if (key === 'authLoginSubmitCode') {
          return (code: string, loginId?: string) =>
            getInvoke()<{ success: boolean; error?: string }>(
              'claude_auth_login_submit_code',
              { code, ...(loginId ? { loginId } : {}) },
            )
        }
        if (key === 'authLoginCancel') {
          return (loginId?: string) => getInvoke()<unknown>(
            'claude_auth_login_cancel',
            loginId ? { loginId } : undefined,
          )
        }
        if (key === 'accountImportCurrent') {
          return () => getInvoke()<unknown>('claude_account_import_current')
        }
        // Account changes are host-owned: the host applies the switch/removal/
        // login and then broadcasts here, so every window — including other
        // remote clients that did not initiate it — repaints from one source.
        if (key === 'onAccountChanged') {
          return (cb: (payload: { agent?: string; accountId?: string | null }) => void) =>
            listenAdapter<{ agent?: string; accountId?: string | null }>(
              'claude:account-changed',
              p => cb(p ?? {}),
            )
        }
        if (key === 'accountSwitch') {
          return (accountId: string) =>
            getInvoke()<unknown>('claude_account_switch', { accountId })
        }
        if (key === 'accountRemove') {
          return (accountId: string) =>
            getInvoke()<unknown>('claude_account_remove', { accountId })
        }
        if (key === 'accountMarkWarningShown') {
          return () => getInvoke()<unknown>('claude_account_mark_warning_shown')
        }
        // Read-only metadata.
        if (key === 'getCliPath') return () => getInvoke()<unknown>('claude_get_cli_path')
        if (key === 'prepareCliSession') {
          return (
            terminalId: string,
            workspaceId: string,
            cwd: string,
            agentPreset: string,
            currentSessionId?: string,
          ) => getInvoke()<unknown>('claude_prepare_cli_session', {
            terminalId,
            workspaceId,
            cwd,
            agentPreset,
            currentSessionId,
          })
        }
        if (key === 'listSessions') {
          return (cwd: string, agentKind?: 'claude' | 'codex') =>
            getInvoke()<unknown>('claude_list_sessions', { cwd, agentKind })
        }
        if (key === 'scanSkills') {
          return (cwd: string) => getInvoke()<unknown>('claude_scan_skills', { cwd })
        }
        if (key === 'cleanupWorktree') {
          return (sessionId: string, deleteBranch: boolean) =>
            getInvoke()<unknown>('claude_cleanup_worktree', { sessionId, deleteBranch })
        }
        // Per-session state setters/getters. Sidecar holds the values
        // until the SDK lands; getters read back exactly what was set.
        if (key === 'setAutoContinue') {
          return (sessionId: string, opts: unknown) =>
            getInvoke()<unknown>('claude_set_auto_continue', { sessionId, opts })
        }
        if (key === 'getAutoContinue') {
          return (sessionId: string) =>
            getInvoke()<unknown>('claude_get_auto_continue', { sessionId })
        }
        if (key === 'setPermissionMode') {
          return (sessionId: string, mode: string) =>
            getInvoke()<unknown>('claude_set_permission_mode', { sessionId, mode })
        }
        if (key === 'setCodexSandboxMode') {
          return (sessionId: string, mode: string) =>
            getInvoke()<boolean>('claude_set_codex_sandbox_mode', { sessionId, mode })
        }
        if (key === 'setCodexApprovalPolicy') {
          return (sessionId: string, policy: string) =>
            getInvoke()<boolean>('claude_set_codex_approval_policy', { sessionId, policy })
        }
        if (key === 'setModel') {
          return (sessionId: string, model: string, autoCompactWindow?: number) =>
            getInvoke()<unknown>('claude_set_model', { sessionId, model, autoCompactWindow })
        }
        if (key === 'setEffort') {
          return (sessionId: string, effort: string) =>
            getInvoke()<unknown>('claude_set_effort', { sessionId, effort })
        }
        if (key === 'resetSession') {
          return (sessionId: string) =>
            getInvoke()<unknown>('claude_reset_session', { sessionId })
        }
        // canUseTool round-trip resolution. Renderer's permission UI calls
        // these when the user clicks Allow/Deny on a permission prompt or
        // submits answers to AskUserQuestion.
        if (key === 'resolvePermission') {
          return (sessionId: string, toolUseId: string, result: unknown) =>
            getInvoke()<unknown>('claude_resolve_permission', { sessionId, toolUseId, result })
        }
        if (key === 'resolveAskUser') {
          return (sessionId: string, toolUseId: string, answers: unknown) =>
            getInvoke()<unknown>('claude_resolve_ask_user', { sessionId, toolUseId, answers })
        }
        // Project MCP detection / approval (cwd-keyed, not session-keyed).
        // Mounted by ClaudeAgentPanel to spot unapproved `<cwd>/.mcp.json`
        // and offer to flip enableAllProjectMcpServers in project settings.
        if (key === 'checkMcpJsonStatus') {
          return (cwd: string) =>
            getInvoke()<{ exists: boolean; approved: boolean; servers: string[] }>(
              'claude_check_mcp_json_status', { cwd })
        }
        if (key === 'enableAllProjectMcp') {
          return (cwd: string) =>
            getInvoke()<{ ok: boolean; changed: boolean; path: string }>(
              'claude_enable_all_project_mcp', { cwd })
        }
        const sessionReadCommands: Record<string, string> = {
          getSupportedModels: 'claude_get_supported_models',
          getSupportedEfforts: 'claude_get_supported_efforts',
          getSupportedCodexSandboxModes: 'claude_get_supported_codex_sandbox_modes',
          getSupportedCodexApprovalPolicies: 'claude_get_supported_codex_approval_policies',
          getSupportedCommands: 'claude_get_supported_commands',
          getSupportedAgents: 'claude_get_supported_agents',
          getAccountInfo: 'claude_get_account_info',
          getSessionState: 'claude_get_session_state',
          getSessionMeta: 'claude_get_session_meta',
          getContextUsage: 'claude_get_context_usage',
          getWorktreeStatus: 'claude_get_worktree_status',
        }
        if (sessionReadCommands[key]) {
          const cmd = sessionReadCommands[key]
          return async (sessionId: string) => getInvoke()<unknown>(cmd, {
            sessionId,
            agentPreset: await getAgentPresetForSession(sessionId),
          })
        }
        // Listener registrations — the sidecar emits id-less notifications
        // like {"method":"event:claude:message","params":{sessionId,...}}.
        // The Rust bridge strips the "event:" prefix and forwards via
        // Tauri's Emitter, so the renderer subscribes through @tauri-apps
        // /api/event::listen on names like "claude:message".
        const eventListeners: Record<string, string> = {
          onMessage: 'claude:message',
          onToolUse: 'claude:tool-use',
          onToolResult: 'claude:tool-result',
          onResult: 'claude:result',
          onTurnEnd: 'claude:turn-end',
          onError: 'claude:error',
          onStream: 'claude:stream',
          onStatus: 'claude:status',
          // The CLI's slash-command list (its built-ins, plugin commands and
          // skills), pushed on init and again whenever the CLI discovers more.
          // Push rather than poll: the panel mounts before any CLI exists, so
          // asking on mount always came back empty.
          onCommands: 'claude:commands',
          onModeChange: 'claude:modeChange',
          // canUseTool round-trip events. The sidecar emits permission-
          // request / ask-user when the SDK is blocked on a tool call;
          // the renderer's permission UI listens here and calls
          // claude.resolvePermission / resolveAskUser to answer. Resolved
          // events fire after the answer to let other panels clear state.
          onPermissionRequest: 'claude:permission-request',
          onAskUser: 'claude:ask-user',
          onPermissionResolved: 'claude:permission-resolved',
          onAskUserResolved: 'claude:ask-user-resolved',
          // Panel-state lifecycle events. onSessionReset fires when the
          // sidecar drops a session; renderer panels clear their UI. The
          // others (history, resume-loading, rate-limit, worktree-info,
          // prompt-suggestion) are emitted by feature-specific paths in
          // sendMessage / resumeSession / SDK stream handling.
          onHistory: 'claude:history',
          onResumeLoading: 'claude:resume-loading',
          onSessionReset: 'claude:session-reset',
          onRateLimit: 'claude:rate-limit',
          onWorktreeInfo: 'claude:worktree-info',
          onPromptSuggestion: 'claude:prompt-suggestion',
          // Background task / dynamic-workflow lifecycle (best-effort; the
          // SDK does not guarantee these). Lets the panel show whether a
          // workflow / subagent is running, which matters for the soft vs
          // hard interrupt UX.
          onTask: 'claude:task',
        }
        if (eventListeners[key]) {
          const evName = eventListeners[key]
          return (cb: (sessionId: string, payload: unknown) => void) =>
            listenAdapter<{ sessionId: string; [k: string]: unknown }>(evName, p => {
              // The renderer event contract is `(sessionId, payload)`.
              // Sidecar payloads encode sessionId in the wrapper object;
              // the second arg is whatever sub-key the event uses
              // (message / toolCall / result / payload / data / error).
              // Codex history/resume-loading producers use `{ payload }`;
              // Claude uses `{ items }` / `{ loading }`. Normalize both.
              cb(p.sessionId, resolveClaudeEventSecondArg(key, p))
            })
        }
        // Unported claude.* methods get a permissive default rather than
        // throwing, since the Claude surface has 40+ methods and a single
        // unported call would otherwise crash the panel that holds it.
        // Any access logs once via warnOnce and returns:
        //   - on*  -> () => () => {}  (no-op unsubscriber)
        //   - else -> (...) => Promise.resolve(null)
        // Callers that actually need a real impl will see the warning in
        // DevTools and we port it on demand.
        return permissiveValueFor(`claude.${key}`)
      },
    }),
    claudeChannel: {
      getCapabilities: () => getInvoke()<unknown>('claude_channel_get_capabilities'),
      startSession: async (sessionId: string, options: unknown) =>
        getInvoke()<unknown>('claude_channel_start_session', {
          sessionId,
          options: options == null
            ? options
            : await attachWorkspaceIdentity(sessionId, options as Record<string, unknown>),
        }),
      sendMessage: (sessionId: string, prompt: string, messageId?: string) =>
        getInvoke()<unknown>('claude_channel_send_message', { sessionId, prompt, messageId }),
      stopSession: (sessionId: string) =>
        getInvoke()<unknown>('claude_channel_stop_session', { sessionId }),
      getStatus: (sessionId: string) =>
        getInvoke()<unknown>('claude_channel_get_status', { sessionId }),
      onMessage: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-channel:message', callback),
      onStatus: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-channel:status', callback),
      onTurnEnd: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-channel:turn-end', callback),
      onAssistant: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-channel:assistant', callback),
      onToolUse: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-channel:tool-use', callback),
      onToolResult: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-channel:tool-result', callback),
      onThinking: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-channel:thinking', callback),
      onUsage: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-channel:usage', callback),
      onResult: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-channel:result', callback),
    },
    claudeCli: {
      getCapabilities: () => getInvoke()<unknown>('claude_cli_get_capabilities'),
      startSession: async (sessionId: string, options: unknown) =>
        getInvoke()<unknown>('claude_cli_start_session', {
          sessionId,
          options: options == null
            ? options
            : await attachWorkspaceIdentity(sessionId, options as Record<string, unknown>),
        }),
      stopSession: (sessionId: string) =>
        getInvoke()<unknown>('claude_cli_stop_session', { sessionId }),
      getStatus: (sessionId: string) =>
        getInvoke()<unknown>('claude_cli_get_status', { sessionId }),
      onMessage: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-cli:message', callback),
      onStatus: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-cli:status', callback),
      onTurnEnd: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-cli:turn-end', callback),
      onAssistant: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-cli:assistant', callback),
      onToolUse: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-cli:tool-use', callback),
      onToolResult: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-cli:tool-result', callback),
      onThinking: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-cli:thinking', callback),
      onUsage: (callback: (payload: unknown) => void) =>
        listenAdapter<unknown>('claude-cli:usage', callback),
    },
    remoteFs: {
      // Streams a CLIENT-LOCAL file to the connected remote host's tmp dir
      // (chunked over the remote transport) and resolves with the host-side
      // path. Only meaningful in a remote-profile window.
      uploadToHostTmp: (localPath: string) =>
        getInvoke()<string>('remote_upload_file_to_host', { localPath }),
    },
    worktree: new Proxy({}, {
      // worktree.* — agent-tied. Sidecar handlers mirror the host
      // WorktreeManager while keeping the renderer-facing shape stable.
      get(_t, prop) {
        const key = String(prop)
        if (key === 'create') {
          return (sessionId: string, cwd: string, installPnpm?: boolean) =>
            getInvoke()<unknown>('worktree_create', {
              sessionId,
              cwd,
              ...(installPnpm ? { installPnpm: true } : {}),
            })
        }
        if (key === 'remove') {
          return (sessionId: string, deleteBranch: boolean) =>
            getInvoke()<unknown>('worktree_remove', { sessionId, deleteBranch })
        }
        if (key === 'status') {
          return (sessionId: string) =>
            getInvoke()<unknown>('worktree_status', { sessionId })
        }
        if (key === 'merge') {
          return (sessionId: string, strategy: string) =>
            getInvoke()<unknown>('worktree_merge', { sessionId, strategy })
        }
        if (key === 'rehydrate') {
          return (sessionId: string, cwd: string, worktreePath: string, branchName: string) =>
            getInvoke()<unknown>('worktree_rehydrate', {
              sessionId, cwd, worktreePath, branchName,
            })
        }
        return permissiveValueFor(`worktree.${key}`)
      },
    }),
    agent: {
      getSupportedSessionTypes: () => getInvoke()<string[]>('agent_get_supported_session_types'),
      listPresets: () => getInvoke()<Array<string | Record<string, unknown>>>('agent_list_presets'),
      // Host-wide subscription usage snapshot (5h/7d windows), broadcast by
      // the Rust host's single per-host poller. Not session-scoped — agent:*
      // because it describes the host/account, not one Claude session.
      onUsage: (callback: (payload: unknown) => void) =>
        listenAdapter<{ payload: unknown }>('agent:usage', p => callback(p?.payload)),
      // Pull path: last snapshot per provider ({ claude?, codex? }). The first
      // broadcast fires before the webview subscribes, so the renderer cache
      // fetches this once on startup instead of waiting a full poll cycle.
      getUsageSnapshot: () => getInvoke()<Record<string, unknown>>('agent_usage_snapshot'),
      // Lazy usage peek for a NON-active Claude account (account dropdown
      // only; short host-side cache; null when its stored token expired).
      peekUsage: (accountId: string) =>
        getInvoke()<Record<string, unknown> | null>('agent_usage_peek', { accountId }),
      // Raw server-side response-time samples in [fromMs, toMs], oldest first.
      // Host-owned like usage: on a remote-profile window the command forwards to
      // the host, which is the machine that actually made the API calls.
      getLatencySamples: (fromMs: number, toMs: number) =>
        getInvoke()<unknown>('agent_latency_samples', { fromMs, toMs }),
    },
    workerBuffer: {
      // Renderer-side terminal buffer cache. We back this with a Rust
      // Mutex<HashMap<String, String>> rather than the sidecar so it
      // stays fast for tight write loops (xterm output, etc).
      init: (panelId: string) =>
        getInvoke()<boolean>('worker_buffer_init', { panelId }),
      append: (panelId: string, lines: string) =>
        getInvoke()<boolean>('worker_buffer_append', { panelId, lines }),
      readAll: (panelId: string) =>
        getInvoke()<string>('worker_buffer_read_all', { panelId }),
      clear: (panelId: string) =>
        getInvoke()<boolean>('worker_buffer_clear', { panelId }),
      loadProcfile: (filePath: string) =>
        getInvoke()<Array<{ name: string; command: string }>>('worker_procfile_load', { filePath }),
      startProcess: (options: {
        panelId: string
        name: string
        command: string
        cwd: string
        shell?: string
        customEnv?: Record<string, string>
      }) =>
        getInvoke()<string>('worker_procfile_start', { options }),
      stopProcess: (panelId: string, name: string) =>
        getInvoke()<boolean>('worker_procfile_stop', { panelId, name }),
    },
    remote: {
      // Phase 3 namespace; sidecar stubs return shaped objects so the
      // renderer's polling clientStatus() / serverStatus() doesn't crash
      // when it destructures `.connected` / `.running`.
      startServer: (options?: unknown) =>
        getInvoke()<unknown>('remote_start_server', { options }),
      stopServer: () => getInvoke()<unknown>('remote_stop_server'),
      serverStatus: () => getInvoke()<unknown>('remote_server_status'),
      rotateToken: () => getInvoke()<unknown>('remote_rotate_token'),
      connect: (host: string, port: number, token: string, fingerprint: string, label?: string) =>
        getInvoke()<unknown>('remote_connect', { host, port, token, fingerprint, label }),
      disconnect: () => getInvoke()<unknown>('remote_disconnect'),
      clientStatus: () =>
        getInvoke()<{
          connected: boolean
          info: { host: string; port: number } | null
          capabilities?: unknown
        }>(
          'remote_client_status',
        ),
      testConnection: (host: string, port: number, token: string, fingerprint: string) =>
        getInvoke()<unknown>('remote_test_connection', { host, port, token, fingerprint }),
      listProfiles: (host: string, port: number, token: string, fingerprint: string) =>
        getInvoke()<unknown>('remote_list_profiles', { host, port, token, fingerprint }),
    },
    tunnel: {
      getConnection: () => getInvoke()<unknown>('tunnel_get_connection'),
    },
    pty: {
      create: (options: unknown) =>
        getInvoke()<string>('pty_create', { options: options as Record<string, unknown> }),
      write: (id: string, data: string) => getInvoke()<void>('pty_write', { id, data }),
      readBuffer: (id: string) => getInvoke()<string>('pty_read_buffer', { id }),
      resize: (id: string, cols: number, rows: number) =>
        getInvoke()<void>('pty_resize', { id, cols, rows }),
      getViewportState: (id: string) =>
        getInvoke()<TerminalViewportState>('pty_get_viewport_state', { id }),
      setViewportMode: (
        id: string,
        mode: TerminalViewportMode,
        options?: SetViewportModeOptions,
      ) => getInvoke()<TerminalViewportState>('pty_set_viewport_mode', { id, mode, options }),
      setViewportSize: (
        id: string,
        cols: number,
        rows: number,
        source: TerminalViewportSource,
      ) => getInvoke()<TerminalViewportState>('pty_set_viewport_size', {
        id,
        cols,
        rows,
        source,
      }),
      kill: (id: string) => getInvoke()<void>('pty_kill', { id }),
      restart: (id: string, cwd: string, shell?: string) =>
        getInvoke()<boolean>('pty_restart', { id, cwd, shell }),
      getCwd: (id: string) => getInvoke()<string | null>('pty_get_cwd', { id }),
      onOutput: (callback: (id: string, data: string) => void) =>
        listenAdapter<PtyOutputPayload>('pty:output', p => callback(p.id, p.data)),
      onExit: (callback: (id: string, exitCode: number) => void) =>
        listenAdapter<PtyExitPayload>('pty:exit', p => callback(p.id, p.exitCode)),
      onViewportState: (callback: (id: string, state: TerminalViewportState) => void) =>
        listenAdapter<PtyViewportStatePayload>(
          'pty:viewport-state',
          p => callback(p.id, p.state),
        ),
    },
  }

  return new Proxy({}, {
    get(_target, prop) {
      const key = String(prop)
      if (key in ported) return ported[key]
      // Synthesise a nested namespace proxy so calls like host.foo.bar()
      // produce a useful error instead of TypeError on undefined access.
      return new Proxy({}, {
        get(_t, sub) { notImplemented(`${key}.${String(sub)}`) },
      })
    },
  }) as BatAppAPI
}

function installTauriMetricLogger(api: BatAppAPI): void {
  if (tauriMetricLoggerInstalled) return
  tauriMetricLoggerInstalled = true
  listenAdapter<SidecarMetricPayload>('sidecar:metric', metric => {
    void api.debug.log('[sidecar:metric]', metric)
  })
}

// Permissive shim used to keep the React tree alive while we port the rest
// of the host surface. Unlike createTauriHost(), this version returns
// best-effort no-op values for unimplemented methods so synchronous reads
// during render (e.g. window.batAppAPI.platform, getDetachedId(),
// onSomething(cb)) don't blow up. Each unported access logs once via
// console.warn so the gap is visible in DevTools.
//
// Wire via installTauriShim() from main.tsx — it is intentionally NOT the
// default behaviour of `host`, because tests and ported call sites should
// continue to fail loudly instead of silently no-oping.

function detectPlatform(): 'win32' | 'darwin' | 'linux' {
  if (typeof navigator === 'undefined') return 'linux'
  const p = (navigator as { platform?: string }).platform || ''
  if (/win/i.test(p)) return 'win32'
  if (/mac/i.test(p)) return 'darwin'
  return 'linux'
}

const warned = new Set<string>()
function warnOnce(name: string): void {
  if (warned.has(name)) return
  warned.add(name)
  // eslint-disable-next-line no-console
  console.warn(`host-api: ${name} called under Tauri but not yet implemented; returning a no-op value`)
}

function permissiveValueFor(name: string, asFunction = true): unknown {
  warnOnce(name)
  if (!asFunction) return null
  // Return a function that lazily resolves to null/Promise<null> so both
  // sync and async callers get a sensible shape. Listener registrations
  // (on*) are usually unsubscribers; we return a no-op for those.
  if (name.includes('.on')) return () => () => {}
  return (..._args: unknown[]) => {
    // Heuristic: methods named getX, listX, fetchX, loadX, saveX etc. tend
    // to be promise-returning. We can't tell statically, so default to a
    // resolved promise — synchronous callers can still chain .then() on a
    // promise.
    return Promise.resolve(null)
  }
}

// Namespaces whose methods are routed through Tauri invoke. Listed here so
// the permissive shim can prefer the real impl when present.
const PORTED_NAMESPACES = new Set([
  'settings', 'runtime', 'shell', 'dialog', 'fs', 'clipboard', 'image',
  'pty', 'workspace', 'update', 'debug', 'git', 'app',
  'notification', 'system', 'github', 'snippet', 'profile',
  'claude', 'claudeChannel', 'claudeCli', 'remoteFs', 'worktree', 'agent', 'workerBuffer',
  'remote', 'tunnel',
])

export function installTauriShim(): void {
  if (getHostKind() !== 'tauri') return
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window
  if (!win || win.batAppAPI) return
  if (!tauriImpl) tauriImpl = createTauriHost()
  const api = tauriImpl
  const real = api as unknown as Record<string, unknown>
  installTauriMetricLogger(api)
  installTauriDropPathCache(api)
  const platform = detectPlatform()
  const shim = new Proxy({}, {
    get(_t, prop) {
      const key = String(prop)
      if (key === 'platform') return platform
      if (key === 'systemVersion') return ''
      if (PORTED_NAMESPACES.has(key)) return real[key]
      // Build a nested namespace proxy that returns permissive values.
      return new Proxy({}, {
        get(_n, sub) {
          const subKey = String(sub)
          // getDetachedId is the one synchronous method preload.ts exposes
          // that the renderer reads during initial render — return null so
          // React doesn't choke.
          if (key === 'workspace' && subKey === 'getDetachedId') {
            return () => { warnOnce('workspace.getDetachedId'); return null }
          }
          return permissiveValueFor(`${key}.${subKey}`)
        },
      })
    },
  })
  win.batAppAPI = shim
}
