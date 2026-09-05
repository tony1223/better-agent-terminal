import { host, parseWindowsBuildNumber, type TerminalViewportState } from '../host-api'
import { useEffect, useRef, useState, memo, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { workspaceStore } from '../stores/workspace-store'
import { settingsStore } from '../stores/settings-store'
import type { AgentPresetId } from '../types/agent-presets'
import { createPtyInputWriter, type PtyInputWriter } from '../utils/pty-input-writer'
import {
  describeTerminalInputData,
  describeTerminalKeyEvent,
  isBackspaceKeyEvent,
  getExpectedPlainBackspaceInput,
  getTerminalKeyInput,
  getTerminalKeyInputOverride,
  isPrintableTerminalInputData,
  shouldBlockForImeComposition,
  shouldTraceTerminalInputData,
  shouldTraceTerminalKeyEvent,
  shouldUseDirectTerminalKeyInput,
} from '../utils/terminal-key-input'
import '@xterm/xterm/css/xterm.css'

const dlog = (...args: unknown[]) => host.debug.log(...args)
const MOBILE_TERMINAL_COLS = 56
const MOBILE_TERMINAL_ROWS = 24
const DEFAULT_VIEWPORT_STATE: TerminalViewportState = {
  mode: 'desktop',
  cols: 100,
  rows: 30,
  updatedBy: 'desktop',
  updatedAt: 0,
}
interface TerminalPanelProps {
  terminalId: string
  onClose?: (id: string) => void
  isActive?: boolean
  terminalType?: 'terminal' | 'code-agent'
  agentPreset?: AgentPresetId
  ptyReady?: boolean
  // Retained for renderer-host compatibility. Fresh local and remote xterms
  // now both hydrate because local panels may be released by the LRU.
  remoteHydrate?: boolean
  onReadySize?: (size: { cols: number, rows: number }) => void
}

interface ContextMenu {
  x: number
  y: number
  hasSelection: boolean
}

function getWindowsBuildNumber(): number | undefined {
  if (host.platform !== 'win32') return undefined
  return parseWindowsBuildNumber(host.systemVersion)
}

function isClaudeCliPreset(agentPreset?: AgentPresetId): boolean {
  return agentPreset === 'claude-cli' || agentPreset === 'claude-cli-worktree' || agentPreset === 'claude-cli-agent'
}

function isTerminalKeyboardEventTarget(container: HTMLElement, target: EventTarget | null): boolean {
  if (target instanceof Node && container.contains(target)) return true
  return target === document.body || target === document.documentElement || target === document
}

export const TerminalPanel = memo(function TerminalPanel({
  terminalId,
  onClose,
  isActive = true,
  terminalType,
  agentPreset,
  ptyReady = true,
  onReadySize,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [terminalReady, setTerminalReady] = useState(false)
  const [viewportState, setViewportState] = useState<TerminalViewportState>(DEFAULT_VIEWPORT_STATE)
  const hasBeenFocusedRef = useRef(false)
  const isActiveRef = useRef(isActive)
  const doResizeRef = useRef<(() => void) | null>(null)
  const supportsImagePaste = agentPreset === 'codex-cli' || isClaudeCliPreset(agentPreset)
  const isClaudeCliTerminal = isClaudeCliPreset(agentPreset)
  const ptyReadyRef = useRef(ptyReady)
  const ptyInputRef = useRef<PtyInputWriter | null>(null)
  const onReadySizeRef = useRef(onReadySize)
  const viewportStateRef = useRef(viewportState)
  const lastInputTraceKeyRef = useRef<{
    at: number
    event: Record<string, unknown>
    isBackspace: boolean
  } | null>(null)
  const inputTraceSeqRef = useRef(0)
  const { t } = useTranslation()

  // Keep isActiveRef in sync with isActive prop
  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    ptyReadyRef.current = ptyReady
    if (ptyReady) {
      doResizeRef.current?.()
    }
  }, [ptyReady])

  useEffect(() => {
    onReadySizeRef.current = onReadySize
  }, [onReadySize])

  useEffect(() => {
    viewportStateRef.current = viewportState
  }, [viewportState])

  useEffect(() => {
    setViewportState(DEFAULT_VIEWPORT_STATE)
  }, [terminalId])

  useEffect(() => {
    return host.pty.onViewportState((id: string, state: TerminalViewportState) => {
      if (id !== terminalId) return
      setViewportState(state)
    })
  }, [terminalId])

  useEffect(() => {
    if (!ptyReady) return
    let cancelled = false
    host.pty.getViewportState(terminalId)
      .then((state: TerminalViewportState) => {
        if (!cancelled) setViewportState(state)
      })
      .catch(() => {
        // PTY startup can lag behind the panel mount; desktop is the runtime default.
      })
    return () => {
      cancelled = true
    }
  }, [ptyReady, terminalId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    if (viewportState.mode === 'mobile') {
      const cols = viewportState.cols > 0 ? viewportState.cols : MOBILE_TERMINAL_COLS
      const rows = viewportState.rows > 0 ? viewportState.rows : MOBILE_TERMINAL_ROWS
      if (terminal.cols !== cols || terminal.rows !== rows) {
        terminal.resize(cols, rows)
      }
      requestAnimationFrame(() => {
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      })
      return
    }
    if (isActiveRef.current) {
      requestAnimationFrame(() => doResizeRef.current?.())
    }
  }, [viewportState.mode, viewportState.cols, viewportState.rows])

  const pasteAbortRef = useRef<{ cancelled: boolean } | null>(null)

  const shouldTracePtyInput = () => host.debug.isPtyInputTrace === true

  const traceTerminalKeyEvent = (event: KeyboardEvent) => {
    if (!shouldTracePtyInput()) return
    if (!shouldTraceTerminalKeyEvent(event)) return
    const described = describeTerminalKeyEvent(event)
    const expectedPlainBackspaceInput = isBackspaceKeyEvent(event)
      ? getExpectedPlainBackspaceInput(host.platform)
      : null
    lastInputTraceKeyRef.current = {
      at: performance.now(),
      event: described,
      isBackspace: isBackspaceKeyEvent(event),
    }
    dlog('[pty-input:key]', {
      terminalId,
      terminalType,
      agentPreset,
      event: described,
      expectedPlainBackspaceInput: expectedPlainBackspaceInput === null
        ? null
        : describeTerminalInputData(expectedPlainBackspaceInput),
    })
  }

  const traceTerminalInputData = (phase: string, data: string) => {
    if (!shouldTracePtyInput()) return
    const now = performance.now()
    const lastKey = lastInputTraceKeyRef.current
    const recentKey = lastKey && now - lastKey.at < 1000 ? lastKey : null
    if (!shouldTraceTerminalInputData(data) && !recentKey?.isBackspace) return
    const seq = ++inputTraceSeqRef.current
    dlog(`[pty-input:${phase}]`, {
      seq,
      terminalId,
      terminalType,
      agentPreset,
      data: describeTerminalInputData(data),
      afterKeyMs: recentKey ? Math.round(now - recentKey.at) : null,
      afterKey: recentKey?.event ?? null,
    })
  }

  const getNativeTerminalKeyInput = (event: KeyboardEvent, imeComposing: boolean): string | null => {
    return getTerminalKeyInput(event, {
      imeComposing,
      platform: host.platform,
    })
  }

  const traceTextareaInputEvent = (phase: string, event: Event, textarea: HTMLTextAreaElement) => {
    if (!shouldTracePtyInput()) return
    const maybeInput = event as InputEvent
    const maybeKey = event as KeyboardEvent
    const payload: Record<string, unknown> = {
      terminalId,
      terminalType,
      agentPreset,
      type: event.type,
      textareaValue: textarea.value ? describeTerminalInputData(textarea.value) : null,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      isComposing: 'isComposing' in event ? Boolean((event as { isComposing?: boolean }).isComposing) : null,
    }
    if (event.type === 'keydown' || event.type === 'keyup') {
      payload.event = describeTerminalKeyEvent(maybeKey)
    }
    if (event.type === 'beforeinput' || event.type === 'input') {
      payload.inputType = maybeInput.inputType
      payload.data = maybeInput.data ? describeTerminalInputData(maybeInput.data) : null
    }
    dlog(`[pty-input:textarea.${phase}]`, payload)
  }

  const writePtyInput = (data: string) => {
    traceTerminalInputData('writePtyInput', data)
    const writer = ptyInputRef.current
    if (writer) {
      writer.write(data)
    } else {
      host.pty.write(terminalId, data)
    }
  }

  // Chunked write with sequential scheduling (avoids creating thousands of timers)
  const writeChunked = (text: string) => {
    const CHUNK_SIZE = 2000
    const DELAY = 30
    const abort = { cancelled: false }
    pasteAbortRef.current = abort
    let offset = 0

    const sendNext = () => {
      if (abort.cancelled || offset >= text.length) {
        pasteAbortRef.current = null
        return
      }
      const chunk = text.slice(offset, offset + CHUNK_SIZE)
      offset += CHUNK_SIZE
      writePtyInput(chunk)
      setTimeout(sendNext, DELAY)
    }
    sendNext()
  }

  // Handle paste with size confirmation for large text
  const handlePasteText = async (text: string) => {
    if (!text) return

    // Cancel any in-progress paste
    if (pasteAbortRef.current) {
      pasteAbortRef.current.cancelled = true
    }

    const CONFIRM_THRESHOLD = 10 * 1024 // 10KB

    if (text.length > CONFIRM_THRESHOLD) {
      const sizeKB = (text.length / 1024).toFixed(1)
      const sizeMB = (text.length / (1024 * 1024)).toFixed(2)
      const sizeLabel = text.length > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`
      const lines = text.split('\n').length

      const confirmed = await host.dialog.confirm(
        `About to paste a large text:\n\n• Size: ${sizeLabel} (${text.length.toLocaleString()} chars)\n• Lines: ${lines.toLocaleString()}\n\nThis may take a moment. Continue?`,
        'Large Paste Warning'
      )
      if (!confirmed) return
    }

    if (text.length > 4000) {
      writeChunked(text)
    } else {
      writePtyInput(text)
    }
  }

  const handlePasteImage = async () => {
    dlog(`[paste-image] begin terminal=${terminalId} type=${terminalType}`)
    let filePath: string | null = null
    try {
      filePath = await host.clipboard.saveImage()
    } catch (err) {
      dlog(`[paste-image] saveImage threw: ${(err as Error)?.message ?? String(err)}`)
      return false
    }
    dlog(`[paste-image] saveImage → ${filePath ?? 'null'}`)
    if (!filePath) return false
    let written = false
    try {
      written = await host.clipboard.writeImage(filePath)
    } catch (err) {
      dlog(`[paste-image] writeImage threw: ${(err as Error)?.message ?? String(err)}`)
      return false
    }
    dlog(`[paste-image] writeImage → ${written}`)
    if (!written) return false
    writePtyInput('\x1bv')
    dlog(`[paste-image] sent \\x1bv to pty terminal=${terminalId}`)
    return true
  }

  const handlePasteFromClipboard = async ({ textOnly = false }: { textOnly?: boolean } = {}) => {
    dlog(`[paste-clipboard] start textOnly=${textOnly} supportsImage=${supportsImagePaste} terminal=${terminalId}`)
    if (!textOnly && supportsImagePaste) {
      try {
        const items = await navigator.clipboard.read()
        const types = items.flatMap(item => item.types)
        const hasImage = types.some(type => type.startsWith('image/'))
        dlog(`[paste-clipboard] navigator.clipboard.read items=${items.length} types=${JSON.stringify(types)} hasImage=${hasImage}`)
        if (hasImage) {
          const pastedImage = await handlePasteImage()
          dlog(`[paste-clipboard] handlePasteImage → ${pastedImage}`)
          if (pastedImage) return
        }
      } catch (err) {
        dlog(`[paste-clipboard] navigator.clipboard.read threw: ${(err as Error)?.message ?? String(err)}`)
      }
    }

    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        await handlePasteText(text)
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err)
    }
  }

  // Handle context menu actions
  const handleCopy = () => {
    if (terminalRef.current) {
      const selection = terminalRef.current.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection)
      }
    }
    setContextMenu(null)
  }

  const handlePaste = async () => {
    await handlePasteFromClipboard()
    setContextMenu(null)
  }

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null)
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  // Handle terminal resize and focus when becoming active
  useEffect(() => {
    if (isActive && terminalReady && terminalRef.current) {
      const terminal = terminalRef.current

      // Use requestAnimationFrame to ensure DOM is fully rendered
      const rafId = requestAnimationFrame(() => {
        if (!terminal) return

        dlog(`[resize] isActive effect → doResize terminal=${terminalId}`)
        doResizeRef.current?.()

        // Force refresh terminal content to fix black screen / text overlap after visibility change
        requestAnimationFrame(() => {
          terminal.clearTextureAtlas()
          terminal.refresh(0, terminal.rows - 1)
          terminal.focus()

          // Full-screen TUIs (Claude/Codex/etc.) on the alternate buffer can return
          // from display:none with stale geometry: when the panel is re-shown at the
          // same size, FitAddon.fit() and xterm's resize() both no-op, so neither the
          // renderer nor the PTY (SIGWINCH) is nudged and the app never repaints. This
          // surfaces as vertical jitter until the user manually resizes the window.
          // Replicate that manual resize with a one-row nudge so the TUI repaints
          // cleanly. Plain shells stay on the normal buffer and are left untouched. #114
          if (ptyReadyRef.current && terminal.buffer.active.type === 'alternate') {
            const { cols, rows } = terminal
            if (cols > 1 && rows > 1) {
              dlog(`[resize] alt-buffer reshow nudge cols=${cols} rows=${rows} terminal=${terminalId}`)
              terminal.resize(cols, rows - 1)
              host.pty.resize(terminalId, cols, rows - 1)
              requestAnimationFrame(() => {
                terminal.resize(cols, rows)
                host.pty.resize(terminalId, cols, rows)
              })
            }
          }

          // Execute agent command on first focus for code-agent terminals
          if (!hasBeenFocusedRef.current && terminalType === 'code-agent') {
            hasBeenFocusedRef.current = true
            const terminalInstance = workspaceStore.getState().terminals.find(t => t.id === terminalId)
            if (terminalInstance && !terminalInstance.agentCommandSent && !terminalInstance.hasUserInput) {
              const agentCommand = settingsStore.getAgentCommand()
              if (agentCommand) {
                setTimeout(() => {
                  const currentTerminal = workspaceStore.getState().terminals.find(t => t.id === terminalId)
                  if (isActiveRef.current && currentTerminal && !currentTerminal.hasUserInput && !currentTerminal.agentCommandSent) {
                    writePtyInput(agentCommand + '\r')
                    workspaceStore.markAgentCommandSent(terminalId)
                  }
                }, 3000)
              }
            }
          }
        })
      })

      return () => cancelAnimationFrame(rafId)
    }
  }, [isActive, terminalReady, terminalId, terminalType])

  // Add intersection observer to detect when terminal becomes visible
  useEffect(() => {
    if (!containerRef.current || !terminalRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && isActive && doResizeRef.current) {
            dlog(`[resize] IntersectionObserver → visible, doResize terminal=${terminalId}`)
            setTimeout(() => {
              doResizeRef.current?.()
            }, 50)
          }
        })
      },
      { threshold: 0.1 }
    )

    observer.observe(containerRef.current)

    return () => observer.disconnect()
  }, [isActive, terminalId])

  useEffect(() => {
    if (!containerRef.current) return

    const settings = settingsStore.getSettings()
    const colors = settingsStore.getTerminalColors()
    const windowsBuildNumber = getWindowsBuildNumber()
    const useDirectTerminalKeyInput = shouldUseDirectTerminalKeyInput(host.platform)

    // Create terminal instance with customizable colors
    const terminal = new Terminal({
      theme: {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        cursorAccent: colors.background,
        selectionBackground: '#5c5142',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff'
      },
      fontSize: settings.fontSize,
      fontFamily: settingsStore.getFontFamilyString(),
      cursorBlink: true,
      scrollback: 10000,
      convertEol: !isClaudeCliTerminal,
      allowProposedApi: true,
      allowTransparency: !isClaudeCliTerminal,
      disableStdin: useDirectTerminalKeyInput,
      windowsPty: host.platform === 'win32'
        ? {
            backend: 'conpty',
            buildNumber: windowsBuildNumber
          }
        : undefined
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      // Open URL in default browser
      host.shell.openExternal(uri)
    })
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(unicode11Addon)
    terminal.unicode.activeVersion = '11'

    const ptyInput = createPtyInputWriter((chunk) => {
      traceTerminalInputData('host.pty.write', chunk)
      return host.pty.write(terminalId, chunk)
    })
    ptyInputRef.current = ptyInput

    let imeComposing = false
    let imeCompositionEndTimer: ReturnType<typeof setTimeout> | null = null
    const writeTerminalUserInput = (phase: string, data: string) => {
      traceTerminalInputData(phase, data)
      ptyInput.write(data)
      if (terminalType === 'code-agent') {
        workspaceStore.markHasUserInput(terminalId)
      }
    }

    const handleNativeTerminalKeydown = (event: KeyboardEvent) => {
      if (!useDirectTerminalKeyInput) return
      const container = containerRef.current
      if (!container || !isActiveRef.current || !ptyReadyRef.current) return
      if (!isTerminalKeyboardEventTarget(container, event.target)) return

      if (imeComposing && event.key === 'Enter') {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }

      const lowerKey = event.key.toLowerCase()
      const copyModifier = event.ctrlKey || event.metaKey
      if (copyModifier && event.shiftKey && lowerKey === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          event.preventDefault()
          event.stopImmediatePropagation()
          navigator.clipboard.writeText(selection)
        }
        return
      }
      if (copyModifier && lowerKey === 'v') {
        event.preventDefault()
        event.stopImmediatePropagation()
        handlePasteFromClipboard({ textOnly: event.shiftKey })
        return
      }
      if (copyModifier && !event.shiftKey && lowerKey === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          event.preventDefault()
          event.stopImmediatePropagation()
          navigator.clipboard.writeText(selection)
          return
        }
      }

      const input = getNativeTerminalKeyInput(event, imeComposing)
      if (input === null) return

      event.preventDefault()
      event.stopImmediatePropagation()
      traceTerminalKeyEvent(event)
      writeTerminalUserInput('direct-key', input)
    }
    window.addEventListener('keydown', handleNativeTerminalKeydown, true)

    terminal.open(containerRef.current)

    // The DOM renderer lays a row out with the browser's text flow, so a run
    // that falls back to a second CJK font (Japanese 弾/顔 next to Traditional
    // Chinese on Windows, for example) no longer measures a whole number of
    // cells and every column after it drifts — table borders end up one cell
    // off on exactly those rows. The WebGL renderer draws each glyph into its
    // own cell. Keep the DOM renderer when WebGL is unavailable or lost.
    let webglAddon: WebglAddon | null = null
    try {
      webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        dlog(`[render] webgl context lost, using DOM renderer terminal=${terminalId}`)
        webglAddon?.dispose()
        webglAddon = null
      })
      terminal.loadAddon(webglAddon)
    } catch (error) {
      dlog(`[render] webgl renderer unavailable, using DOM renderer terminal=${terminalId}`, error)
      webglAddon?.dispose()
      webglAddon = null
    }

    // Register file:// URL link provider (WebLinksAddon only handles http/https)
    terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) { callback(undefined); return }
        const text = line.translateToString()
        const fileUrlRegex = /file:\/\/\/[^\s'"\])}>,;`]+/g
        let match
        const links: ILink[] = []
        while ((match = fileUrlRegex.exec(text)) !== null) {
          const url = match[0]
          const startX = match.index + 1
          const endX = match.index + url.length
          links.push({
            text: url,
            range: {
              start: { x: startX, y: bufferLineNumber },
              end: { x: endX, y: bufferLineNumber }
            },
            activate(_event, text) {
              host.shell.openExternal(text)
            }
          })
        }
        callback(links.length > 0 ? links : undefined)
      }
    })

    // Deduplicated resize helper — avoids redundant pty.resize IPC calls
    let lastSentCols = 0
    let lastSentRows = 0
    const doResize = () => {
      const viewport = viewportStateRef.current
      if (viewport.mode === 'mobile') {
        const cols = viewport.cols > 0 ? viewport.cols : MOBILE_TERMINAL_COLS
        const rows = viewport.rows > 0 ? viewport.rows : MOBILE_TERMINAL_ROWS
        if (terminal.cols !== cols || terminal.rows !== rows) {
          terminal.resize(cols, rows)
        }
        return
      }
      fitAddon.fit()
      const { cols, rows } = terminal
      if (ptyReadyRef.current && (cols !== lastSentCols || rows !== lastSentRows)) {
        lastSentCols = cols
        lastSentRows = rows
        dlog(`[resize] pty.resize cols=${cols} rows=${rows} terminal=${terminalId}`)
        host.pty.resize(terminalId, cols, rows)
      }
    }
    doResizeRef.current = doResize

    let readySizeRaf: number | null = null
    let refreshRaf: number | null = null
    const scheduleFullRefresh = () => {
      if (refreshRaf !== null) return
      refreshRaf = requestAnimationFrame(() => {
        refreshRaf = null
        terminal.refresh(0, terminal.rows - 1)
      })
    }
    if (onReadySizeRef.current) {
      readySizeRaf = requestAnimationFrame(() => {
        try {
          fitAddon.fit()
        } catch {
          // xterm can throw if the panel is not measurable yet; report the current fallback size.
        }
        onReadySizeRef.current?.({ cols: terminal.cols, rows: terminal.rows })
      })
    }

    // Fix IME textarea position - force it to bottom left
    const fixImePosition = () => {
      const textarea = containerRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      if (textarea) {
        textarea.style.position = 'fixed'
        textarea.style.bottom = '80px'
        textarea.style.left = '220px'
        textarea.style.top = 'auto'
        textarea.style.width = '1px'
        textarea.style.height = '20px'
        textarea.style.opacity = '0'
        textarea.style.zIndex = '10'
      }
    }

    // Use MutationObserver to keep fixing position when xterm.js changes it
    let mutationCount = 0
    const observer = new MutationObserver(() => {
      mutationCount++
      if (mutationCount <= 20 || mutationCount % 100 === 0) {
        dlog(`[render] MutationObserver #${mutationCount} terminal=${terminalId}`)
      }
      fixImePosition()
    })

    const textarea = containerRef.current?.querySelector('.xterm-helper-textarea')
    if (textarea) {
      observer.observe(textarea, { attributes: true, attributeFilter: ['style'] })
      fixImePosition()
    }

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    setTerminalReady(true)

    terminal.onData((data) => {
      if (!ptyReadyRef.current) return
      if (useDirectTerminalKeyInput) {
        traceTerminalInputData('xterm.onData.ignored', data)
        return
      }
      writeTerminalUserInput('xterm.onData', data)
    })

    // Track IME composition state on xterm's hidden textarea
    // to prevent CAPS LOCK and other keys from committing partial IME input
    const xtermTextarea = containerRef.current?.querySelector('.xterm-helper-textarea') as HTMLElement | null
    const onCompositionStart = () => {
      if (imeCompositionEndTimer !== null) {
        clearTimeout(imeCompositionEndTimer)
        imeCompositionEndTimer = null
      }
      imeComposing = true
    }
    const onCompositionEnd = (event: CompositionEvent) => {
      if (
        useDirectTerminalKeyInput &&
        isActiveRef.current &&
        ptyReadyRef.current &&
        isPrintableTerminalInputData(event.data)
      ) {
        writeTerminalUserInput('compositionend', event.data)
      }
      imeCompositionEndTimer = setTimeout(() => {
        imeComposing = false
        imeCompositionEndTimer = null
      }, 0)
    }
    if (xtermTextarea) {
      xtermTextarea.addEventListener('compositionstart', onCompositionStart)
      xtermTextarea.addEventListener('compositionend', onCompositionEnd)
    }

    const xtermInputTextarea = xtermTextarea instanceof HTMLTextAreaElement ? xtermTextarea : null
    const traceTextareaEvent = (event: Event) => {
      if (!xtermInputTextarea) return
      traceTextareaInputEvent(event.type, event, xtermInputTextarea)
    }
    if (xtermInputTextarea) {
      xtermInputTextarea.addEventListener('keydown', traceTextareaEvent, true)
      xtermInputTextarea.addEventListener('beforeinput', traceTextareaEvent, true)
      xtermInputTextarea.addEventListener('input', traceTextareaEvent, true)
      xtermInputTextarea.addEventListener('keyup', traceTextareaEvent, true)
      xtermInputTextarea.addEventListener('compositionstart', traceTextareaEvent, true)
      xtermInputTextarea.addEventListener('compositionend', traceTextareaEvent, true)
    }

    // Handle copy and paste shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
      // Only handle keydown events to prevent duplicate actions
      if (event.type !== 'keydown') return true
      traceTerminalKeyEvent(event)

      const inputOverride = getTerminalKeyInputOverride(event, {
        imeComposing,
        platform: host.platform,
      })
      if (inputOverride !== null) {
        event.preventDefault()
        if (!useDirectTerminalKeyInput) {
          traceTerminalInputData('key-override', inputOverride)
          ptyInput.write(inputOverride)
          if (terminalType === 'code-agent') {
            workspaceStore.markHasUserInput(terminalId)
          }
        }
        return false
      }

      // During IME composition, block non-composition key events
      // to prevent CAPS LOCK etc. from committing partial input. A stale
      // event.isComposing by itself must not block normal terminal typing.
      if (imeComposing || event.isComposing) {
        // keyCode 229 = IME composition event, let it through
        // Editing/navigation keys must still reach xterm so Backspace can
        // delete composing text and recover if compositionend was missed.
        // Everything else (CAPS LOCK, modifiers, etc.) should be blocked.
        return !shouldBlockForImeComposition(event, imeComposing)
      }

      // Ctrl+Shift+C for copy
      if (event.ctrlKey && event.shiftKey && event.key === 'C') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
        }
        return false
      }
      // Ctrl+Shift+V for paste
      if (event.ctrlKey && event.shiftKey && event.key === 'V') {
        handlePasteFromClipboard({ textOnly: true })
        return false
      }
      // Ctrl/Cmd+V for paste
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        handlePasteFromClipboard()
        return false
      }
      // Ctrl+C for copy when there's a selection
      if (event.ctrlKey && !event.shiftKey && event.key === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
          return false
        }
        // If no selection, let Ctrl+C pass through for interrupt signal
        return true
      }
      return true
    })

    // Right-click context menu for copy/paste
    const containerEl = containerRef.current
    const onPaste = (e: ClipboardEvent) => {
      if (!isActiveRef.current) return
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      e.preventDefault()
      handlePasteText(text)
    }
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      const selection = terminal.getSelection()
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        hasSelection: !!selection
      })
    }
    containerEl.addEventListener('paste', onPaste)
    containerEl.addEventListener('contextmenu', onContextMenu)

    // Cancels in-flight scrollback hydration when the terminal unmounts.
    let outputHydrationCancelled = false

    // Handle terminal output.
    //
    // Remote attaches and locally remounted LRU panels replay scrollback. Queue
    // live output while reading the backend buffer, then paint exactly one
    // ordered snapshot before going live.
    const writePtyOutput = (data: string) => {
      if (isClaudeCliTerminal) {
        terminal.write(data, scheduleFullRefresh)
      } else {
        terminal.write(data)
      }
      // Update activity time when there's output
      workspaceStore.updateTerminalActivity(terminalId)
    }
    let outputHydrated = false
    const pendingOutput: string[] = []
    const unsubscribeOutput = host.pty.onOutput((id, data) => {
      if (id !== terminalId) return
      if (!outputHydrated) {
        pendingOutput.push(data)
        return
      }
      writePtyOutput(data)
    })
    // Go live: optionally flush the chunks queued during hydration, then let
    // subsequent output write straight through.
    const goLive = (queuedStart: number) => {
      for (let index = queuedStart; index < pendingOutput.length; index++) {
        writePtyOutput(pendingOutput[index])
      }
      pendingOutput.length = 0
      outputHydrated = true
    }
    const goLiveAfterSnapshot = (snapshot: string) => {
      // Output appended before the read may be both in the snapshot and in our
      // pending event queue. Drop only the longest queued prefix proven to be
      // the snapshot suffix; keep anything emitted after the snapshot.
      let includedChunks = 0
      let queuedPrefix = ''
      for (let index = 0; index < pendingOutput.length; index++) {
        queuedPrefix += pendingOutput[index]
        if (queuedPrefix.length > snapshot.length) break
        if (snapshot.endsWith(queuedPrefix)) includedChunks = index + 1
      }
      goLive(includedChunks)
    }
    const hydrateScrollback = async () => {
      // The PTY may not exist on the host yet (create still in flight over the
      // wire), so retry briefly on failure before giving up and going live.
      for (let attempt = 0; attempt < 20 && !outputHydrationCancelled; attempt++) {
        try {
          const buffer = await host.pty.readBuffer(terminalId)
          if (outputHydrationCancelled) return
          if (buffer) {
            // Paint the snapshot, then retain only queued chunks that landed
            // after it so neither scrollback duplication nor output loss wins
            // the read/event race.
            if (isClaudeCliTerminal) {
              terminal.write(buffer, scheduleFullRefresh)
            } else {
              terminal.write(buffer)
            }
            goLiveAfterSnapshot(buffer)
          } else {
            // Empty snapshot — the PTY exists but nothing is buffered yet (we
            // won the race against the first prompt), so the real early output
            // is whatever landed in the queue. Flush it.
            goLive(0)
          }
          return
        } catch {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      // Hydration never succeeded (create failed?) — don't strand live output.
      if (!outputHydrationCancelled) goLive(0)
    }
    void hydrateScrollback()

    // Handle terminal exit
    const unsubscribeExit = host.pty.onExit((id, exitCode) => {
      if (id === terminalId) {
        terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`)
        if (settingsStore.getCloseTerminalAfterProcessExit()) {
          onClose?.(terminalId)
        }
      }
    })

    // Handle resize — debounce with 500ms to avoid expensive xterm reflows during window drag
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let resizeObserverCount = 0
    const resizeObserver = new ResizeObserver((entries) => {
      resizeObserverCount++
      const entry = entries[0]
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      dlog(`[render] ResizeObserver #${resizeObserverCount} terminal=${terminalId} active=${isActiveRef.current} ${w}x${h}`)
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        if (!isActiveRef.current) return
        dlog(`[render] ResizeObserver debounce → doResize terminal=${terminalId}`)
        const t0 = performance.now()
        doResize()
        const t1 = performance.now()
        terminal.refresh(0, terminal.rows - 1)
        const t2 = performance.now()
        dlog(`[render] doResize=${(t1-t0).toFixed(1)}ms refresh=${(t2-t1).toFixed(1)}ms terminal=${terminalId}`)
      }, 200)
    })
    resizeObserver.observe(containerRef.current)

    // Initial resize — only for active terminal, delayed to ensure DOM is ready
    if (isActiveRef.current) {
      setTimeout(() => {
        dlog(`[resize] initial doResize terminal=${terminalId}`)
        doResize()
      }, 100)
    }

    // Subscribe to settings changes for font and color updates
    const unsubscribeSettings = settingsStore.subscribe(() => {
      const newSettings = settingsStore.getSettings()
      const newColors = settingsStore.getTerminalColors()
      terminal.options.fontSize = newSettings.fontSize
      terminal.options.fontFamily = settingsStore.getFontFamilyString()
      terminal.options.theme = {
        ...terminal.options.theme,
        background: newColors.background,
        foreground: newColors.foreground,
        cursor: newColors.cursor,
        cursorAccent: newColors.background
      }
      if (isActiveRef.current) {
        dlog(`[resize] settings changed → doResize terminal=${terminalId}`)
        doResize()
      }
    })

    return () => {
      outputHydrationCancelled = true
      window.removeEventListener('keydown', handleNativeTerminalKeydown, true)
      unsubscribeOutput()
      unsubscribeExit()
      unsubscribeSettings()
      if (resizeTimer) clearTimeout(resizeTimer)
      if (imeCompositionEndTimer !== null) clearTimeout(imeCompositionEndTimer)
      if (readySizeRaf !== null) cancelAnimationFrame(readySizeRaf)
      if (refreshRaf !== null) cancelAnimationFrame(refreshRaf)
      resizeObserver.disconnect()
      observer.disconnect()
      if (xtermTextarea) {
        xtermTextarea.removeEventListener('compositionstart', onCompositionStart)
        xtermTextarea.removeEventListener('compositionend', onCompositionEnd)
      }
      if (xtermInputTextarea) {
        xtermInputTextarea.removeEventListener('keydown', traceTextareaEvent, true)
        xtermInputTextarea.removeEventListener('beforeinput', traceTextareaEvent, true)
        xtermInputTextarea.removeEventListener('input', traceTextareaEvent, true)
        xtermInputTextarea.removeEventListener('keyup', traceTextareaEvent, true)
        xtermInputTextarea.removeEventListener('compositionstart', traceTextareaEvent, true)
        xtermInputTextarea.removeEventListener('compositionend', traceTextareaEvent, true)
      }
      ptyInput.dispose()
      if (ptyInputRef.current === ptyInput) {
        ptyInputRef.current = null
      }
      containerEl.removeEventListener('paste', onPaste)
      containerEl.removeEventListener('contextmenu', onContextMenu)
      doResizeRef.current = null
      terminal.dispose()
    }
  }, [terminalId])

  const handleViewportModeToggle = async () => {
    if (!ptyReadyRef.current) return
    const current = viewportStateRef.current
    try {
      if (current.mode === 'mobile') {
        const next = await host.pty.setViewportMode(terminalId, 'desktop', { source: 'desktop' })
        setViewportState(next)
        requestAnimationFrame(() => doResizeRef.current?.())
        return
      }

      const next = await host.pty.setViewportMode(terminalId, 'mobile', {
        cols: MOBILE_TERMINAL_COLS,
        rows: MOBILE_TERMINAL_ROWS,
        source: 'desktop',
      })
      setViewportState(next)
      const terminal = terminalRef.current
      if (terminal) {
        terminal.resize(next.cols || MOBILE_TERMINAL_COLS, next.rows || MOBILE_TERMINAL_ROWS)
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void host.debug.log(`[TerminalPanel] viewport mode switch failed terminal=${terminalId}: ${message}`)
    }
  }

  const isMobileLayout = viewportState.mode === 'mobile'
  const mobilePanelStyle: CSSProperties | undefined = isMobileLayout
    ? { width: `min(calc(${viewportState.cols || MOBILE_TERMINAL_COLS}ch + 24px), 100%)` }
    : undefined

  return (
    <div className={`terminal-panel-shell ${isMobileLayout ? 'mobile-layout' : 'desktop-layout'}`}>
      <div className="terminal-viewport-bar">
        <span className={`terminal-viewport-badge ${isMobileLayout ? 'mobile' : 'desktop'}`}>
          {isMobileLayout ? t('terminal.mobileLayout') : t('terminal.desktopLayout')}
        </span>
        <button
          type="button"
          className="terminal-viewport-action"
          onClick={handleViewportModeToggle}
          disabled={!ptyReady}
        >
          {isMobileLayout ? t('terminal.useDesktopLayout') : t('terminal.useMobileLayout')}
        </button>
      </div>
      <div className="terminal-panel-stage">
        <div
          ref={containerRef}
          className="terminal-panel"
          style={mobilePanelStyle}
          tabIndex={0}
          onMouseDownCapture={() => containerRef.current?.focus({ preventScroll: true })}
        >
          {contextMenu && (
            <div
              className="context-menu"
              style={{
                position: 'fixed',
                left: contextMenu.x,
                top: contextMenu.y,
                zIndex: 1000
              }}
            >
              {contextMenu.hasSelection && (
                <button onClick={handleCopy} className="context-menu-item">
                  複製
                </button>
              )}
              <button onClick={handlePaste} className="context-menu-item">
                貼上
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
