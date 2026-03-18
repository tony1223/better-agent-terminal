import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import App from './App'
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

const dlog = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)
const t0 = (window as unknown as { __t0?: number }).__t0 || Date.now()
dlog(`[startup] ── renderer ──────────────────────────────`)
dlog(`[startup] main.tsx top-level: +${Date.now() - t0}ms from HTML <script>`)

// Keep splash visible — React root is hidden behind it.
// Splash will be removed once React has painted (see rAF below).
const splash = document.getElementById('splash')
const root = document.getElementById('root')!
root.style.display = ''

dlog(`[startup] before createRoot: +${Date.now() - t0}ms`)

ReactDOM.createRoot(root).render(<App />)

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
