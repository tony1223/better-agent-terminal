import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import App from './App'
import { LatencyStatsPanel } from './components/LatencyStatsPanel'
import { getHostKind, host, installTauriShim } from './host-api'

// Install a permissive Tauri host shim before React mounts. It is keyed off the
// host adapter so unmigrated callsites do not crash render. Missing features
// still log a "not yet implemented" warning the first time they are hit.
installTauriShim()
import './styles/base.css'
import './styles/layout.css'
import './styles/panels.css'
import './styles/settings.css'
import './styles/context-menu.css'
import './styles/notifications.css'
import './styles/env-snippets.css'
import './styles/resize.css'
import './styles/file-browser.css'
import './styles/path-linker.css'
import './styles/prompt-box.css'
import './styles/claude-agent.css'
import './styles/claude-channel-agent.css'
import './styles/claude-cli-agent.css'
import './styles/skills-panel.css'

const dlog = (...args: unknown[]) => host.debug.log(...args)
const t0 = (window as unknown as { __t0?: number }).__t0 || Date.now()
const tauriSmokeWindowTokens = new Set<string>()

function installVisualViewportVars(): void {
  const root = document.documentElement
  let frame = 0
  const update = () => {
    frame = 0
    const viewport = window.visualViewport
    const height = Math.max(1, Math.floor(viewport?.height ?? window.innerHeight))
    const offsetTop = Math.max(0, Math.floor(viewport?.offsetTop ?? 0))
    const keyboardBottom = Math.max(0, Math.floor(window.innerHeight - height - offsetTop))
    root.style.setProperty('--bat-viewport-height', `${height}px`)
    root.style.setProperty('--bat-viewport-offset-top', `${offsetTop}px`)
    root.style.setProperty('--bat-keyboard-bottom-offset', `${keyboardBottom}px`)
  }
  const schedule = () => {
    if (frame) return
    frame = window.requestAnimationFrame(update)
  }

  update()
  window.visualViewport?.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', schedule)
}

// White-screen / WebView2 paint-stall detector. JS crashes are already logged
// below ([window.error], [unhandledrejection], [react-error]); a blank window
// with NONE of those logged means the compositor stopped presenting frames
// while React/DOM keep updating. Timers keep firing when that happens but
// requestAnimationFrame does not — so if rAF hasn't run for a while *while the
// document is visible*, record it as a likely paint stall (the signature we
// could not otherwise see in the log).
function installRenderWatchdog(): void {
  const STALL_MS = 5000
  let lastRaf = Date.now()
  let stalled = false

  const tick = () => {
    const now = Date.now()
    if (stalled) {
      dlog(`[render-watchdog] rAF resumed after ${now - lastRaf}ms gap (visibility=${document.visibilityState})`)
      stalled = false
    }
    lastRaf = now
    window.requestAnimationFrame(tick)
  }
  window.requestAnimationFrame(tick)

  window.setInterval(() => {
    // Hidden/minimized windows legitimately throttle rAF to ~0 — not a stall.
    if (document.visibilityState !== 'visible') return
    const gap = Date.now() - lastRaf
    if (gap >= STALL_MS && !stalled) {
      stalled = true
      dlog(`[render-watchdog] rAF stalled ${gap}ms while visible (hasFocus=${document.hasFocus()}) — likely WebView2 paint stall`)
    }
  }, 2000)

  // Occlusion/restore is the usual trigger; log transitions so a stall can be
  // correlated with the window being minimised/occluded and brought back.
  document.addEventListener('visibilitychange', () => {
    dlog(`[render-watchdog] visibility=${document.visibilityState} hasFocus=${document.hasFocus()}`)
    if (document.visibilityState === 'visible') {
      lastRaf = Date.now()
      stalled = false
    }
  })
}

installVisualViewportVars()
installRenderWatchdog()
dlog(`[startup] ── renderer ──────────────────────────────`)
dlog(`[startup] host kind: ${getHostKind()}`)
dlog(`[startup] location: ${window.location.href}`)
void host.app.getWindowId()
  .then((windowId) => dlog(`[startup] window id: ${windowId}`))
  .catch((err) => dlog(`[startup] window id failed: ${String((err as { message?: unknown })?.message ?? err)}`))
dlog(`[startup] main.tsx top-level: +${Date.now() - t0}ms from HTML <script>`)

if (getHostKind() === 'tauri') {
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<string>('bat:smoke-new-window', async (event) => {
      const token = event.payload || 'unknown'
      if (tauriSmokeWindowTokens.has(token)) return
      tauriSmokeWindowTokens.add(token)
      const windowId = await host.app.getWindowId().catch(() => null)
      if (windowId !== 'main') return
      dlog(`[window-smoke:${token}] renderer-requested`)
      const id = await host.app.newWindow()
      dlog(`[window-smoke:${token}] renderer-new-window id=${id}`)
    }))
    .catch((err) => dlog(`[window-smoke] listener failed: ${String((err as { message?: unknown })?.message ?? err)}`))
}

// Surface unhandled rejections with their actual contents. Tauri invoke
// rejects with a plain object (BridgeError → `{ message }`) which the
// browser console renders as `[object Object]` — useless for debugging.
// Stringify the reason so the message and any stack are visible in the
// log file, and re-print to console in a readable shape.
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason as unknown
  let detail: string
  try {
    if (r && typeof r === 'object') {
      const obj = r as Record<string, unknown>
      detail = JSON.stringify({
        message: obj.message,
        name: obj.name,
        code: obj.code,
        stack: typeof obj.stack === 'string' ? obj.stack.split('\n').slice(0, 6).join(' | ') : undefined,
        keys: Object.keys(obj),
      })
    } else {
      detail = String(r)
    }
  } catch {
    detail = '[unstringifiable rejection]'
  }
  dlog(`[unhandledrejection] ${detail}`)
  console.error('[unhandledrejection]', r, '→', detail)
})

window.addEventListener('error', (ev) => {
  const detail = JSON.stringify({
    message: ev.message,
    filename: ev.filename,
    lineno: ev.lineno,
    colno: ev.colno,
    stack: ev.error instanceof Error ? ev.error.stack?.split('\n').slice(0, 8).join(' | ') : undefined,
  })
  dlog(`[window.error] ${detail}`)
})

class RootErrorBoundary extends React.Component<
  Readonly<{ children: React.ReactNode }>,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    dlog(`[react-error] ${JSON.stringify({
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 8).join(' | '),
      componentStack: info.componentStack?.split('\n').slice(0, 8).join(' | '),
    })}`)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{
          height: '100vh',
          padding: 24,
          background: '#1e1e1e',
          color: '#cccccc',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          overflow: 'auto',
        }}>
          <h1 style={{ fontSize: 18, marginBottom: 12 }}>Renderer failed</h1>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#fca5a5' }}>
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

// Keep splash visible — React root is hidden behind it.
// Splash will be removed once React has painted (see rAF below).
const splash = document.getElementById('splash')
const root = document.getElementById('root')!
root.style.display = ''

dlog(`[startup] before createRoot: +${Date.now() - t0}ms`)

// LatencyStatsPanel sits beside <App /> rather than inside it: App returns early
// in four different shapes (profile startup, detached window, missing workspace,
// normal), and the Statistics menu item can fire while any of them is on screen.
// It renders null until the menu event arrives, so it costs one listener.
ReactDOM.createRoot(root).render(
  <RootErrorBoundary>
    <App />
    <LatencyStatsPanel />
  </RootErrorBoundary>
)

dlog(`[startup] after render() queued: +${Date.now() - t0}ms`)

// Remove splash only after React has committed to DOM and browser is ready to paint.
// Using double-rAF: first rAF fires before paint, second fires after paint is
// actually flushed — ensures React content is visible before we remove splash.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    if (splash) splash.remove()
    dlog(`[startup] splash removed (React painted): +${Date.now() - t0}ms from HTML`)
  })
})
