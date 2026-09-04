import { host, isTauri } from '../host-api'
import { useEffect, useRef, useState, memo, useCallback, type WheelEvent as ReactWheelEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import type { WorkerCommandRequest, WorkerCommandResult } from '../utils/worker-command'
import '@xterm/xterm/css/xterm.css'

const dlog = (...args: unknown[]) => host.debug.log(...args)

const WORKER_COLORS = [
  '#61afef', '#98c379', '#e5c07b', '#c678dd',
  '#e06c75', '#56b6c2', '#d19a66', '#be5046',
]

type ProcessStatus = 'starting' | 'running' | 'stopped' | 'crashed'

interface WorkerProcess {
  name: string
  command: string
  ptyId: string
  color: string
  status: ProcessStatus
  exitCode?: number
  autoStart: boolean
}

interface WorkerLogEntry {
  name: string
  color: string
  data: string
}

function parseWorkerBuffer(raw: string): WorkerLogEntry[] {
  if (!raw.trim()) return []
  const entries: WorkerLogEntry[] = []
  for (const line of raw.trim().split('\n')) {
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as Partial<WorkerLogEntry>
      if (typeof parsed.name === 'string' && typeof parsed.color === 'string' && typeof parsed.data === 'string') {
        entries.push({ name: parsed.name, color: parsed.color, data: parsed.data })
      }
    } catch {
      // Ignore malformed persisted lines; new output will continue appending.
    }
  }
  return entries
}

// Persist auto-start preferences per Procfile
function loadAutoStartPrefs(procfilePath: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(`worker-autostart:${procfilePath}`)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function saveAutoStartPrefs(procfilePath: string, prefs: Record<string, boolean>): void {
  try {
    localStorage.setItem(`worker-autostart:${procfilePath}`, JSON.stringify(prefs))
  } catch { /* ignore */ }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    try { await host.clipboard.writeText(text) } catch { /* ignore */ }
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255]
}

function ansiColor(hex: string, text: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`
}

function prefixWorkerChunk(data: string, prefix: string, wasMidLine: boolean): { output: string; midLine: boolean } {
  let output = ''
  let atLineStart = !wasMidLine

  for (let index = 0; index < data.length; index++) {
    const char = data[index]
    const next = data[index + 1]

    if (char === '\r' && next === '\n') {
      output += '\r\n'
      index++
      atLineStart = true
      continue
    }

    if (char === '\n') {
      output += '\n'
      atLineStart = true
      continue
    }

    if (char === '\r') {
      output += '\r' + prefix
      atLineStart = false
      continue
    }

    if (atLineStart) {
      output += prefix
      atLineStart = false
    }
    output += char
  }

  return { output, midLine: !atLineStart }
}

function getProcfileWorkingDirectory(procfilePath: string, fallbackCwd: string): string {
  const normalized = procfilePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash <= 0) return fallbackCwd
  return procfilePath.slice(0, lastSlash)
}

function buildWorkerHeader(procfilePath: string, processCount: number): string {
  const filename = procfilePath.split(/[\\/]/).pop() || 'Procfile'
  return ansiColor('#888', `Worker: ${filename} (${processCount} processes)\r\n`) +
    ansiColor('#555', '\u2500'.repeat(60) + '\r\n')
}

// Derive worktree-aware env vars for Procfile-spawned processes, so users can
// allocate non-conflicting ports per worktree (e.g. `PORT=$((5173+$BAT_PORT_OFFSET))`).
function getWorktreeProcessEnv(processCwd: string): Record<string, string> {
  const m = /\.bat-worktrees[/\\]([0-9a-f]+)(?:[/\\]|$)/.exec(processCwd)
  if (!m) return {}
  const id = m[1]
  const index = parseInt(id.slice(0, 6), 16) % 100
  return {
    BAT_WORKTREE_ID: id,
    BAT_WORKTREE_INDEX: String(index),
    BAT_PORT_OFFSET: String(index * 10),
  }
}

interface WorkerPanelProps {
  terminalId: string
  procfilePath: string
  cwd: string
  isActive: boolean
}

export const WorkerPanel = memo(function WorkerPanel({ terminalId, procfilePath, cwd, isActive }: WorkerPanelProps) {
  const processCwd = getProcfileWorkingDirectory(procfilePath, cwd)
  const containerRef = useRef<HTMLDivElement>(null)
  const processListRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const doResizeRef = useRef<(() => void) | null>(null)
  const isActiveRef = useRef(isActive)
  const isRemoteClientRef = useRef(false)
  const midLineRef = useRef<Map<string, boolean>>(new Map())
  const processesRef = useRef<WorkerProcess[]>([])
  const shellRef = useRef<string | undefined>()
  const ptyIdsRef = useRef<Set<string>>(new Set())
  const logVisibleRef = useRef<Map<string, boolean>>(new Map())
  const entriesRef = useRef<WorkerLogEntry[]>([])
  const pendingBatchRef = useRef<WorkerLogEntry[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spotlightRef = useRef<string | null>(null)

  const [processes, setProcesses] = useState<WorkerProcess[]>([])
  const [logVisible, setLogVisible] = useState<Record<string, boolean>>({})
  const [spotlightService, setSpotlightService] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { processesRef.current = processes }, [processes])
  useEffect(() => {
    const map = new Map<string, boolean>()
    for (const [k, v] of Object.entries(logVisible)) map.set(k, v)
    logVisibleRef.current = map
  }, [logVisible])

  // Flush pending batch to disk
  const flushToDisk = useCallback(async () => {
    const batch = pendingBatchRef.current
    if (batch.length === 0) return
    pendingBatchRef.current = []
    const lines = batch.map(e => JSON.stringify(e)).join('\n') + '\n'
    await host.workerBuffer.append(terminalId, lines)
  }, [terminalId])

  // Schedule a flush (debounced 500ms)
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      flushToDisk()
    }, 500)
  }, [flushToDisk])

  // Re-render terminal from entries with only visible processes
  const reRenderTerminal = useCallback((entries: WorkerLogEntry[], visibleMap: Map<string, boolean>) => {
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.clear()
    terminal.write('\x1b[2J\x1b[H') // full clear + cursor home
    midLineRef.current = new Map()

    for (const entry of entries) {
      // __header__ entries are always shown and already formatted
      if (entry.name === '__header__') {
        terminal.write(entry.data)
        continue
      }

      if (visibleMap.get(entry.name) === false) continue

      const maxLen = Math.max(...processesRef.current.map(p => p.name.length))
      const color = entry.color || processesRef.current.find(p => p.name === entry.name)?.color || '#ffffff'
      const paddedName = entry.name.padEnd(maxLen)
      const prefix = ansiColor(color, paddedName) + '\x1b[90m | \x1b[0m'
      const formatted = prefixWorkerChunk(entry.data, prefix, !!midLineRef.current.get(entry.name))
      midLineRef.current.set(entry.name, formatted.midLine)

      terminal.write(formatted.output)
    }
  }, [])

  const toggleLogVisible = useCallback(async (name: string) => {
    // Compute next visibility state from current ref
    const next: Record<string, boolean> = Object.fromEntries(logVisibleRef.current)
    next[name] = next[name] === false ? true : false
    const map = new Map<string, boolean>(Object.entries(next))
    logVisibleRef.current = map
    setLogVisible(next)

    // Flush pending batch before re-rendering from the in-memory log.
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    await flushToDisk()

    reRenderTerminal(entriesRef.current, map)
  }, [flushToDisk, reRenderTerminal])

  const toggleSpotlight = useCallback(async (name: string) => {
    const next = spotlightRef.current === name ? null : name
    spotlightRef.current = next
    setSpotlightService(next)

    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    await flushToDisk()

    // Build visibility map: spotlight overrides individual toggles
    const map = new Map<string, boolean>(logVisibleRef.current)
    if (next !== null) {
      for (const proc of processesRef.current) map.set(proc.name, proc.name === next)
    }
    reRenderTerminal(entriesRef.current, map)
  }, [flushToDisk, reRenderTerminal])

  const handleProcessListWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const list = processListRef.current
    if (!list || list.scrollWidth <= list.clientWidth) return

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (delta === 0) return
    event.preventDefault()
    list.scrollLeft += delta
  }, [])

  const clearLog = useCallback(async () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    pendingBatchRef.current = []
    await host.workerBuffer.clear(terminalId)
    entriesRef.current = []

    midLineRef.current = new Map()
    const headerText = buildWorkerHeader(procfilePath, processesRef.current.length)
    const terminal = terminalRef.current
    if (terminal) {
      terminal.clear()
      terminal.write('\x1b[2J\x1b[H')
      terminal.write(headerText)
    }

    const headerEntry = { name: '__header__', color: '', data: headerText }
    entriesRef.current.push(headerEntry)
    pendingBatchRef.current.push(headerEntry)
    scheduleFlush()
  }, [procfilePath, scheduleFlush, terminalId])

  const toggleAutoStart = useCallback((name: string) => {
    setProcesses(prev => {
      const updated = prev.map(p =>
        p.name === name ? { ...p, autoStart: !p.autoStart } : p
      )
      // Persist
      const prefs: Record<string, boolean> = {}
      for (const p of updated) prefs[p.name] = p.autoStart
      saveAutoStartPrefs(procfilePath, prefs)
      return updated
    })
  }, [procfilePath])

  // Write prefixed output to combined terminal
  const writeOutput = useCallback((name: string, color: string, data: string, persist = true) => {
    const terminal = terminalRef.current
    if (!terminal) return

    const entry = { name, color, data }
    entriesRef.current.push(entry)

    // Queue for disk flush
    if (persist) {
      pendingBatchRef.current.push(entry)
      scheduleFlush()
    }

    // __header__ entries are pre-formatted, write directly
    if (name === '__header__') {
      terminal.write(data)
      return
    }

    // Skip rendering for hidden/non-spotlighted processes
    if (spotlightRef.current !== null) {
      if (name !== spotlightRef.current) return
    } else if (logVisibleRef.current.get(name) === false) return

    const maxLen = Math.max(...processesRef.current.map(p => p.name.length))
    const paddedName = name.padEnd(maxLen)
    const prefix = ansiColor(color, paddedName) + '\x1b[90m | \x1b[0m'
    const formatted = prefixWorkerChunk(data, prefix, !!midLineRef.current.get(name))
    midLineRef.current.set(name, formatted.midLine)

    terminal.write(formatted.output)
  }, [scheduleFlush])

  // Start a single process PTY
  const startProcess = useCallback(async (proc: WorkerProcess) => {
    dlog(`[worker] starting process: ${proc.name} (${proc.ptyId})`)

    setProcesses(prev => prev.map(p =>
      p.ptyId === proc.ptyId ? { ...p, status: 'starting' as const, exitCode: undefined } : p
    ))

    const ptyId = await host.workerBuffer.startProcess({
      panelId: terminalId,
      name: proc.name,
      command: proc.command,
      cwd: processCwd,
      // A remote window's shell setting describes this machine, not the
      // host; leave it unset so the host resolves its own default shell.
      shell: isRemoteClientRef.current ? undefined : shellRef.current,
      customEnv: getWorktreeProcessEnv(processCwd),
    })
    ptyIdsRef.current.add(ptyId)
    setTimeout(() => {
      setProcesses(prev => prev.map(p =>
        p.ptyId === proc.ptyId && p.status === 'starting' ? { ...p, status: 'running' as const } : p
      ))
    }, 300)
  }, [processCwd, terminalId])

  // Re-read Procfile and sync process list (add new, remove deleted, update commands)
  const reloadProcfile = useCallback(async () => {
    const entries = await host.workerBuffer.loadProcfile(procfilePath).catch(error => {
      dlog(`[worker] failed to load Procfile ${procfilePath}:`, String(error))
      return []
    })
    if (entries.length === 0) return

    const autoStartPrefs = loadAutoStartPrefs(procfilePath)
    const current = processesRef.current
    const currentByName = new Map(current.map(p => [p.name, p]))
    const newNames = new Set(entries.map(e => e.name))

    // Stop and remove processes that no longer exist in Procfile
    for (const proc of current) {
      if (!newNames.has(proc.name)) {
        if (proc.status === 'running' || proc.status === 'starting') {
          await host.workerBuffer.stopProcess(terminalId, proc.name)
          ptyIdsRef.current.delete(proc.ptyId)
        }
        writeOutput(proc.name, proc.color, `\n\x1b[90mRemoved from Procfile\x1b[0m\n`)
      }
    }

    // Build updated process list
    const updated: WorkerProcess[] = entries.map((entry, i) => {
      const existing = currentByName.get(entry.name)
      if (existing) {
        // Keep existing process state, but update command if changed
        if (existing.command !== entry.command) {
          writeOutput(existing.name, existing.color, `\n\x1b[33mCommand updated: ${entry.command}\x1b[0m\n`)
        }
        return { ...existing, command: entry.command, color: WORKER_COLORS[i % WORKER_COLORS.length] }
      }
      // New process
      const proc: WorkerProcess = {
        name: entry.name,
        command: entry.command,
        ptyId: `${terminalId}__w__${entry.name}`,
        color: WORKER_COLORS[i % WORKER_COLORS.length],
        autoStart: autoStartPrefs[entry.name] === true,
        status: 'stopped' as ProcessStatus,
      }
      writeOutput(proc.name, proc.color, `\n\x1b[32mAdded from Procfile\x1b[0m\n`)
      return proc
    })

    processesRef.current = updated
    setProcesses(updated)
    return updated
  }, [procfilePath, terminalId, writeOutput])

  // Stop a single process (reload Procfile to sync list)
  const stopProcess = useCallback(async (proc: WorkerProcess) => {
    await reloadProcfile()
    const fresh = processesRef.current.find(p => p.name === proc.name)
    if (!fresh) return
    dlog(`[worker] stopping process: ${fresh.name}`)
    await host.workerBuffer.stopProcess(terminalId, fresh.name)
    ptyIdsRef.current.delete(fresh.ptyId)
  }, [reloadProcfile, terminalId])

  // Restart a single process (reload Procfile first to pick up command changes)
  const restartProcess = useCallback(async (proc: WorkerProcess) => {
    const updated = await reloadProcfile()
    const fresh = (updated || processesRef.current).find(p => p.name === proc.name)
    if (!fresh) return // process was removed from Procfile

    dlog(`[worker] restarting process: ${fresh.name}`)
    await host.workerBuffer.stopProcess(terminalId, fresh.name)
    ptyIdsRef.current.delete(fresh.ptyId)

    midLineRef.current.set(fresh.name, false)
    writeOutput(fresh.name, fresh.color, `\n\x1b[33mRestarting...\x1b[0m\n`)
    await startProcess(fresh)
  }, [startProcess, writeOutput, reloadProcfile, terminalId])

  // Batch operations (reload Procfile once, then act on fresh list)
  const startAll = useCallback(async () => {
    await reloadProcfile()
    for (const p of processesRef.current) {
      if (p.status === 'stopped' || p.status === 'crashed') startProcess(p)
    }
  }, [startProcess, reloadProcfile])

  const stopAll = useCallback(async () => {
    await reloadProcfile()
    for (const p of processesRef.current) {
      if (p.status === 'running' || p.status === 'starting') {
        dlog(`[worker] stopping process: ${p.name}`)
        await host.workerBuffer.stopProcess(terminalId, p.name)
        ptyIdsRef.current.delete(p.ptyId)
      }
    }
  }, [reloadProcfile, terminalId])

  const restartAll = useCallback(async () => {
    const updated = await reloadProcfile()
    const procs = updated || processesRef.current
    for (const p of procs) {
      dlog(`[worker] restarting process: ${p.name}`)
      if (p.status === 'running' || p.status === 'starting') {
        await host.workerBuffer.stopProcess(terminalId, p.name)
        ptyIdsRef.current.delete(p.ptyId)
      }
      midLineRef.current.set(p.name, false)
      writeOutput(p.name, p.color, `\n\x1b[33mRestarting...\x1b[0m\n`)
      await startProcess(p)
    }
  }, [reloadProcfile, startProcess, writeOutput, terminalId])

  const workerStatusSnapshot = useCallback(() => (
    processesRef.current.map(proc => ({
      name: proc.name,
      status: proc.status,
      command: proc.command,
    }))
  ), [])

  const findWorkerProcess = useCallback((target: string) => {
    const normalized = target.trim().toLowerCase()
    if (!normalized || normalized === 'all') return null
    const processes = processesRef.current
    return processes.find(proc => proc.name.toLowerCase() === normalized)
      || processes.find(proc => proc.name.toLowerCase().includes(normalized))
      || null
  }, [])

  const matchesProcfileTarget = useCallback((target: string) => {
    const normalized = target.trim().toLowerCase()
    if (!normalized || normalized === 'all') return true
    const filename = procfilePath.split(/[\\/]/).pop()?.toLowerCase() || ''
    return filename === normalized || filename.includes(normalized) || procfilePath.toLowerCase().includes(normalized)
  }, [procfilePath])

  const executeWorkerCommand = useCallback(async (request: WorkerCommandRequest): Promise<WorkerCommandResult | null> => {
    const terminal = workspaceStore.getState().terminals.find(t => t.id === terminalId)
    if (request.workspaceId && terminal?.workspaceId !== request.workspaceId) return null

    const target = request.target || 'all'
    const isAll = target.toLowerCase() === 'all'
    const procfileName = procfilePath.split(/[\\/]/).pop() || 'Procfile'
    const targetProc = isAll ? null : findWorkerProcess(target)
    const targetsThisPanel = isAll || Boolean(targetProc) || matchesProcfileTarget(target)

    if (request.action === 'status') {
      const statuses = workerStatusSnapshot()
      if (!isAll && !targetProc && !matchesProcfileTarget(target)) return null
      return {
        requestId: request.requestId,
        terminalId,
        procfilePath,
        handled: true,
        statuses: targetProc ? statuses.filter(proc => proc.name === targetProc.name) : statuses,
        message: `Worker status from ${procfileName}.`,
      }
    }

    if (request.action === 'reload') {
      if (!targetsThisPanel) return null
      await reloadProcfile()
      return {
        requestId: request.requestId,
        terminalId,
        procfilePath,
        handled: true,
        statuses: workerStatusSnapshot(),
        message: `Reloaded ${procfileName}.`,
      }
    }

    if (request.action === 'clear') {
      if (!targetsThisPanel) return null
      await clearLog()
      return {
        requestId: request.requestId,
        terminalId,
        procfilePath,
        handled: true,
        message: `Cleared worker log for ${procfileName}.`,
      }
    }

    if (isAll) {
      if (request.action === 'start') await startAll()
      else if (request.action === 'stop') await stopAll()
      else if (request.action === 'restart') await restartAll()
      return {
        requestId: request.requestId,
        terminalId,
        procfilePath,
        handled: true,
        statuses: workerStatusSnapshot(),
        message: `${request.action} all requested for ${procfileName}.`,
      }
    }

    const proc = targetProc
    if (!proc) return null
    if (request.action === 'start') {
      if (proc.status === 'running' || proc.status === 'starting') {
        return {
          requestId: request.requestId,
          terminalId,
          procfilePath,
          handled: true,
          statuses: workerStatusSnapshot(),
          message: `${proc.name} is already ${proc.status}.`,
        }
      }
      await reloadProcfile()
      const fresh = findWorkerProcess(target)
      if (fresh) await startProcess(fresh)
    } else if (request.action === 'stop') {
      await stopProcess(proc)
    } else if (request.action === 'restart') {
      await restartProcess(proc)
    }
    return {
      requestId: request.requestId,
      terminalId,
      procfilePath,
      handled: true,
      statuses: workerStatusSnapshot(),
      message: `${request.action} requested for ${proc.name}.`,
    }
  }, [clearLog, findWorkerProcess, matchesProcfileTarget, procfilePath, reloadProcfile, restartAll, restartProcess, startAll, startProcess, stopAll, stopProcess, terminalId, workerStatusSnapshot])

  useEffect(() => {
    const onWorkerCommand = (event: Event) => {
      const request = (event as CustomEvent<WorkerCommandRequest>).detail
      if (!request?.requestId) return
      void executeWorkerCommand(request).then(result => {
        if (!result) return
        window.dispatchEvent(new CustomEvent('bat-worker-command-result', { detail: result }))
      }).catch(error => {
        window.dispatchEvent(new CustomEvent('bat-worker-command-result', {
          detail: {
            requestId: request.requestId,
            terminalId,
            procfilePath,
            handled: true,
            message: '',
            error: error instanceof Error ? error.message : String(error),
          } satisfies WorkerCommandResult,
        }))
      })
    }
    window.addEventListener('bat-worker-command', onWorkerCommand as EventListener)
    return () => window.removeEventListener('bat-worker-command', onWorkerCommand as EventListener)
  }, [executeWorkerCommand, procfilePath, terminalId])

  // Main init effect: create xterm, parse Procfile, start processes
  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false
    // --- Create combined xterm.js (synchronous) ---
    const settings = settingsStore.getSettings()
    const colors = settingsStore.getTerminalColors()

    const terminal = new Terminal({
      theme: {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        cursorAccent: colors.background,
        selectionBackground: '#5c5142',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
        blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
        brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
      },
      fontSize: settings.fontSize,
      fontFamily: settingsStore.getFontFamilyString(),
      cursorBlink: false,
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
      allowTransparency: true,
      disableStdin: true,
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    const webLinksAddon = new WebLinksAddon((_, uri) => {
      host.shell.openExternal(uri)
    })
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(unicode11Addon)
    terminal.unicode.activeVersion = '11'
    terminal.open(containerRef.current)
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true

      if (event.key === 'End') {
        event.preventDefault()
        terminal.scrollToBottom()
        return false
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          event.preventDefault()
          void copyText(selection)
          return false
        }
      }

      return true
    })

    // disableStdin makes the xterm helper textarea readonly, so it often
    // doesn't receive focus after a mouse selection — meaning xterm's own
    // Ctrl+C handler above never fires. Fall back to a document-level
    // listener that copies the xterm selection whenever this panel is the
    // active one and there's something selected.
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return
      if (e.key === 'End') {
        e.preventDefault()
        e.stopPropagation()
        terminal.scrollToBottom()
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return
      if (e.key.toLowerCase() !== 'c') return
      const sel = terminal.getSelection()
      if (!sel) return
      e.preventDefault()
      e.stopPropagation()
      void copyText(sel)
    }
    const onCopyShortcut = () => {
      if (!isActiveRef.current) return
      const sel = terminal.getSelection()
      if (sel) void copyText(sel)
    }
    document.addEventListener('keydown', onDocKeyDown, true)
    const unsubscribeCopyShortcut = host.clipboard.onCopyShortcut(onCopyShortcut)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Resize helper
    let lastCols = 0, lastRows = 0
    const doResize = () => {
      fitAddon.fit()
      const { cols, rows } = terminal
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols
        lastRows = rows
        for (const id of ptyIdsRef.current) {
          host.pty.resize(id, cols, rows)
        }
      }
    }
    doResizeRef.current = doResize

    // ResizeObserver
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        if (isActiveRef.current) doResize()
      }, 200)
    })
    resizeObserver.observe(containerRef.current)
    setTimeout(() => doResize(), 100)

    // Event listeners
    const unsubOutput = host.pty.onOutput((id, data) => {
      const proc = processesRef.current.find(p => p.ptyId === id)
      if (proc) {
        if (proc.status !== 'running') {
          setProcesses(prev => prev.map(p =>
            p.ptyId === id && p.status !== 'running' ? { ...p, status: 'running' as const, exitCode: undefined } : p
          ))
        }
        writeOutput(proc.name, proc.color, data, !isTauri())
      }
    })

    const unsubExit = host.pty.onExit((id, exitCode) => {
      const proc = processesRef.current.find(p => p.ptyId === id)
      if (!proc) return
      ptyIdsRef.current.delete(id)
      midLineRef.current.set(proc.name, false)
      const colorCode = exitCode === 0 ? '32' : '31'
      const exitMsg = `\x1b[${colorCode}mProcess exited with code ${exitCode}\x1b[0m`
      // Buffer as a special entry (uses \n so prefix logic applies)
      writeOutput(proc.name, proc.color, `\n${exitMsg}\n`)
      setProcesses(prev => prev.map(p =>
        p.ptyId === id ? { ...p, status: (exitCode === 0 ? 'stopped' : 'crashed') as ProcessStatus, exitCode } : p
      ))
    })

    const unsubSettings = settingsStore.subscribe(() => {
      const s = settingsStore.getSettings()
      const c = settingsStore.getTerminalColors()
      terminal.options.fontSize = s.fontSize
      terminal.options.fontFamily = settingsStore.getFontFamilyString()
      terminal.options.theme = {
        ...terminal.options.theme,
        background: c.background,
        foreground: c.foreground,
        cursor: c.cursor,
      }
      if (isActiveRef.current) doResize()
    })

    // --- Async: read Procfile and start processes ---
    ;(async () => {
      // Init worker buffer without discarding existing scrollback for this panel.
      await host.workerBuffer.init(terminalId)

      const remoteStatus = await host.remote.clientStatus().catch(() => ({ connected: false }))
      const isRemoteClient = remoteStatus.connected === true
      isRemoteClientRef.current = isRemoteClient

      // Resolve shell path
      if (settings.shell === 'custom' && settings.customShellPath) {
        shellRef.current = settings.customShellPath
      } else {
        shellRef.current = await host.settings.getShellPath(settings.shell)
      }

      // Read Procfile
      const entries = await host.workerBuffer.loadProcfile(procfilePath).catch(error => {
        setError(error instanceof Error ? error.message : String(error))
        return []
      })
      if (disposed) return
      if (entries.length === 0) {
        setError('No valid entries found in Procfile')
        return
      }

      // Build process list with saved autoStart preferences
      const autoStartPrefs = loadAutoStartPrefs(procfilePath)
      const procs: WorkerProcess[] = entries.map((entry, i) => ({
        name: entry.name,
        command: entry.command,
        ptyId: `${terminalId}__w__${entry.name}`,
        color: WORKER_COLORS[i % WORKER_COLORS.length],
        autoStart: autoStartPrefs[entry.name] === true, // default false until explicitly enabled
        status: 'stopped' as ProcessStatus,
      }))

      for (const proc of procs) {
        const existingCwd = await host.pty.getCwd(proc.ptyId).catch(() => null)
        if (existingCwd) {
          proc.status = 'running'
          ptyIdsRef.current.add(proc.ptyId)
        } else if (!isRemoteClient && proc.autoStart) {
          proc.status = 'starting'
        }
      }

      processesRef.current = procs
      setProcesses(procs)

      const rawBuffer = await host.workerBuffer.readAll(terminalId).catch(() => '')
      const restoredEntries = parseWorkerBuffer(rawBuffer)
      if (restoredEntries.length > 0) {
        entriesRef.current = restoredEntries
        reRenderTerminal(restoredEntries, logVisibleRef.current)
      } else {
        // Write header (use __header__ as a virtual name so it's always visible during re-render)
        const headerText = buildWorkerHeader(procfilePath, procs.length)
        writeOutput('__header__', '', headerText)
      }

      // Start only processes with autoStart enabled
      for (const proc of procs) {
        if (disposed) break
        if (isRemoteClient || !proc.autoStart || proc.status === 'running') continue
        await startProcess(proc)
      }
    })()

    return () => {
      disposed = true
      unsubOutput()
      unsubExit()
      unsubSettings()
      unsubscribeCopyShortcut()
      document.removeEventListener('keydown', onDocKeyDown, true)
      if (resizeTimer) clearTimeout(resizeTimer)
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      void flushToDisk()
      resizeObserver.disconnect()
      doResizeRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      if (isRemoteClientRef.current) return
      ptyIdsRef.current.clear()
      for (const proc of processesRef.current) {
        host.workerBuffer.stopProcess(terminalId, proc.name)
      }
    }
  }, [terminalId, procfilePath, processCwd, writeOutput, startProcess, reRenderTerminal, flushToDisk])

  // Handle resize/refresh when becoming active
  useEffect(() => {
    if (isActive && terminalRef.current) {
      requestAnimationFrame(() => {
        doResizeRef.current?.()
        requestAnimationFrame(() => {
          terminalRef.current?.clearTextureAtlas()
          terminalRef.current?.refresh(0, (terminalRef.current?.rows ?? 1) - 1)
        })
      })
    }
  }, [isActive])

  if (error) {
    return (
      <div className="worker-panel">
        <div className="worker-error">
          <div className="worker-error-title">Failed to load Procfile</div>
          <div className="worker-error-detail">{error}</div>
          <div className="worker-error-path">{procfilePath}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="worker-panel">
      {processes.length > 0 && (
        <div className="worker-process-bar">
          <div className="worker-process-scroll" aria-label="Worker processes">
            <div className="worker-process-list" ref={processListRef} onWheel={handleProcessListWheel}>
              {processes.map(proc => {
                const isVisible = logVisible[proc.name] !== false
                return (
                  <div
                    key={proc.ptyId}
                    className={`worker-process-card${spotlightService !== null && spotlightService !== proc.name ? ' worker-card-dimmed' : ''}${spotlightService === proc.name ? ' worker-card-spotlight' : ''}`}
                  >
                    <span className={`worker-status-dot worker-status-${proc.status}`} />
                    <span
                      className="worker-process-name"
                      style={{ color: proc.color, cursor: 'pointer' }}
                      onClick={() => toggleSpotlight(proc.name)}
                      title={spotlightService === proc.name ? 'Exit spotlight' : `Spotlight: ${proc.name}`}
                    >
                      {proc.name}
                    </span>
                    <div className="worker-process-actions">
                      <button
                        className={`worker-btn worker-btn-log ${isVisible ? 'active' : ''}`}
                        onClick={() => toggleLogVisible(proc.name)}
                        title={isVisible ? 'Hide log' : 'Show log'}
                      >
                        {isVisible ? '◉' : '○'}
                      </button>
                      <button
                        className={`worker-btn worker-btn-auto ${proc.autoStart ? 'active' : ''}`}
                        onClick={() => toggleAutoStart(proc.name)}
                        title={proc.autoStart ? 'Auto-start ON (click to disable)' : 'Auto-start OFF (click to enable)'}
                      >
                        {proc.autoStart ? '⚡' : '💤'}
                      </button>
                      {(proc.status === 'stopped' || proc.status === 'crashed') && (
                        <button className="worker-btn" onClick={async () => {
                          await reloadProcfile()
                          const fresh = processesRef.current.find(p => p.name === proc.name)
                          if (fresh) startProcess(fresh)
                        }} title="Start">
                          ▶
                        </button>
                      )}
                      {(proc.status === 'running' || proc.status === 'starting') && (
                        <button className="worker-btn" onClick={() => stopProcess(proc)} title="Stop">
                          ■
                        </button>
                      )}
                      <button className="worker-btn" onClick={() => restartProcess(proc)} title="Restart">
                        ⟳
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="worker-global-actions">
            <button className="worker-btn" onClick={startAll} title="Start All">▶ All</button>
            <button className="worker-btn" onClick={stopAll} title="Stop All">■ All</button>
            <button className="worker-btn" onClick={restartAll} title="Restart All">⟳ All</button>
            <button className="worker-btn" onClick={clearLog} title="Clear Log">⌫ Log</button>
            <button className="worker-btn" onClick={() => reloadProcfile()} title="Reload Procfile">⟲ Procfile</button>
          </div>
        </div>
      )}
      <div ref={containerRef} className="worker-terminal" />
    </div>
  )
})
