// Sidecar logger — mirrors stderr writes to <dataDir>/sidecar.log so the
// user (or a future bug report flow) can read sidecar diagnostics
// post-mortem. The Tauri Rust side already captures the last few lines of
// stderr when the sidecar exits unexpectedly (#43), but anything that
// happens in a healthy long-lived sidecar — SDK unavailable warnings,
// remote-secrets refusal, send-error stack traces — was getting flushed
// to a stderr nobody reads.
//
// Design:
//   - Open `<dataDir>/sidecar.log` for append on first init().
//   - Each line: ISO timestamp + level tag + message + newline.
//   - File mode 0o600 so secrets that leak into log lines aren't
//     world-readable (matches remote-secrets pattern).
//   - Rotate-on-init: if the existing file is >5 MB we truncate. Cheap
//     bound, no rolling files. The sidecar restarts every Tauri launch
//     so the file gets fresh starts naturally too.
//   - Never throw out of log()/error()/warn(). The logger is best-effort;
//     a disk full or permission error must not break the JSON-RPC loop.
//   - Test seam: __setLogPathOverrideForTests(path) swaps the resolved
//     log path so suite runs don't pollute the real userData dir.

import { mkdirSync, appendFileSync, statSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveDataDir } from './data-paths.mjs'
import { redactConnectionCredentials } from './connection-redaction.mjs'

const MAX_LOG_BYTES = 5 * 1024 * 1024 // 5 MB
let _logPath = null
let _logPathOverride = null
let _initialized = false

export function __setLogPathOverrideForTests(p) {
  _logPathOverride = typeof p === 'string' && p ? p : null
  _logPath = null
  _initialized = false
}

function resolveLogPath() {
  if (_logPathOverride) return _logPathOverride
  return join(resolveDataDir(), 'sidecar.log')
}

// Idempotent. Safe to call multiple times — the second call only re-runs
// the rotate check.
export function initLogger() {
  try {
    _logPath = resolveLogPath()
    mkdirSync(dirname(_logPath), { recursive: true, mode: 0o700 })
    // Rotate if too big. Truncate to empty rather than rotating to .1 —
    // the user only ever wants the most recent run anyway, and a single-
    // file approach avoids cleanup logic.
    let needsRotate = false
    try {
      const stat = statSync(_logPath)
      if (stat.size > MAX_LOG_BYTES) needsRotate = true
    } catch { /* missing file is fine */ }
    if (needsRotate) {
      try { writeFileSync(_logPath, '', { mode: 0o600 }) } catch { /* ignore */ }
    } else {
      // Touch with mode 0600 if we're creating it for the first time.
      try {
        // openSync({a}) creates the file if missing; closeSync flushes.
        const fd = openSync(_logPath, 'a', 0o600)
        closeSync(fd)
      } catch { /* ignore */ }
    }
    _initialized = true
  } catch {
    // Best-effort — leave _initialized false so subsequent log() calls
    // skip the file write. stderr still gets the line.
    _initialized = false
  }
}

export function getLogPath() {
  if (!_logPath) _logPath = resolveLogPath()
  return _logPath
}

function formatLine(level, args) {
  const ts = new Date().toISOString()
  const parts = args.map(a => {
    if (a instanceof Error) return a.stack || a.message
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  })
  return `${ts} ${level} ${redactConnectionCredentials(parts.join(' '))}\n`
}

function emit(level, args) {
  const line = formatLine(level, args)
  // Always mirror to stderr — that's what's already wired into Tauri's
  // stderr-tail capture from #43. Adding the file write is purely
  // additive.
  try { process.stderr.write(line) } catch { /* ignore */ }
  if (_initialized && _logPath) {
    try { appendFileSync(_logPath, line, { mode: 0o600 }) } catch { /* ignore */ }
  }
}

export function log(...args) { emit('LOG ', args) }
export function info(...args) { emit('INFO', args) }
export function warn(...args) { emit('WARN', args) }
export function error(...args) { emit('ERR ', args) }

// Capture unhandled errors so they make it to the log even if no
// handler-level catch fires. Idempotent — only attaches once per
// process.
let _processHooksAttached = false
export function attachProcessHooks() {
  if (_processHooksAttached) return
  _processHooksAttached = true
  process.on('uncaughtException', (err) => { error('uncaughtException:', err) })
  process.on('unhandledRejection', (reason) => { error('unhandledRejection:', reason) })
}
