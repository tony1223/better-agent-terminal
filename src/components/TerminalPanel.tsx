import { useEffect, useRef, useState, memo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { workspaceStore } from '../stores/workspace-store'
import { settingsStore } from '../stores/settings-store'
import '@xterm/xterm/css/xterm.css'

const dlog = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)

interface TerminalPanelProps {
  terminalId: string
  isActive?: boolean
  terminalType?: 'terminal' | 'code-agent'
}

interface ContextMenu {
  x: number
  y: number
  hasSelection: boolean
}

let renderCount = 0
export const TerminalPanel = memo(function TerminalPanel({ terminalId, isActive = true, terminalType }: TerminalPanelProps) {
  renderCount++
  if (renderCount <= 50 || renderCount % 50 === 0) {
    dlog(`[render] TerminalPanel render #${renderCount} terminal=${terminalId} active=${isActive}`)
  }
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [terminalReady, setTerminalReady] = useState(false)
  const hasBeenFocusedRef = useRef(false)
  const isActiveRef = useRef(isActive)
  const doResizeRef = useRef<(() => void) | null>(null)

  // Keep isActiveRef in sync with isActive prop
  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  const pasteAbortRef = useRef<{ cancelled: boolean } | null>(null)

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
      window.electronAPI.pty.write(terminalId, chunk)
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

      const confirmed = await window.electronAPI.dialog.confirm(
        `About to paste a large text:\n\n• Size: ${sizeLabel} (${text.length.toLocaleString()} chars)\n• Lines: ${lines.toLocaleString()}\n\nThis may take a moment. Continue?`,
        'Large Paste Warning'
      )
      if (!confirmed) return
    }

    if (text.length > 4000) {
      writeChunked(text)
    } else {
      window.electronAPI.pty.write(terminalId, text)
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
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        handlePasteText(text)
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err)
    }
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

        // Force refresh terminal content to fix black screen after visibility change
        requestAnimationFrame(() => {
          terminal.refresh(0, terminal.rows - 1)
          terminal.focus()

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
                    window.electronAPI.pty.write(terminalId, agentCommand + '\r')
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

    // Create terminal instance with customizable colors
    const terminal = new Terminal({
      theme: {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        cursorAccent: colors.background,
        selectionBackground: '#5c5142',
        black: '#3b3228',
        red: '#cb6077',
        green: '#beb55b',
        yellow: '#f4bc87',
        blue: '#8ab3b5',
        magenta: '#a89bb9',
        cyan: '#7bbda4',
        white: '#d0c8c6',
        brightBlack: '#554d46',
        brightRed: '#cb6077',
        brightGreen: '#beb55b',
        brightYellow: '#f4bc87',
        brightBlue: '#8ab3b5',
        brightMagenta: '#a89bb9',
        brightCyan: '#7bbda4',
        brightWhite: '#f5f1e6'
      },
      fontSize: settings.fontSize,
      fontFamily: settingsStore.getFontFamilyString(),
      cursorBlink: true,
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
      allowTransparency: true,
      scrollOnOutput: true
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      // Open URL in default browser
      window.electronAPI.shell.openExternal(uri)
    })
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(containerRef.current)

    // Register file:// URL link provider (WebLinksAddon only handles http/https)
    terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) { callback(undefined); return }
        const text = line.translateToString()
        const fileUrlRegex = /file:\/\/\/[^\s'"\])}>,;`]+/g
        let match
        const links = []
        while ((match = fileUrlRegex.exec(text)) !== null) {
          links.push({
            text: match[0],
            range: {
              start: { x: match.index + 1, y: bufferLineNumber },
              end: { x: match.index + match[0].length, y: bufferLineNumber }
            },
            activate() {
              window.electronAPI.shell.openExternal(match![0])
            }
          })
        }
        callback(links.length > 0 ? links : undefined)
      }
    })

    // Load unicode11 addon after terminal is open
    terminal.loadAddon(unicode11Addon)
    terminal.unicode.activeVersion = '11'

    // Deduplicated resize helper — avoids redundant pty.resize IPC calls
    let lastSentCols = 0
    let lastSentRows = 0
    const doResize = () => {
      fitAddon.fit()
      const { cols, rows } = terminal
      if (cols !== lastSentCols || rows !== lastSentRows) {
        lastSentCols = cols
        lastSentRows = rows
        dlog(`[resize] pty.resize cols=${cols} rows=${rows} terminal=${terminalId}`)
        window.electronAPI.pty.resize(terminalId, cols, rows)
      }
    }
    doResizeRef.current = doResize

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

    // Handle terminal input
    terminal.onData((data) => {
      window.electronAPI.pty.write(terminalId, data)
      // Mark terminal as having user input (for agent command tracking)
      if (terminalType === 'code-agent') {
        workspaceStore.markHasUserInput(terminalId)
      }
    })

    // Track IME composition state on xterm's hidden textarea
    // to prevent CAPS LOCK and other keys from committing partial IME input
    let imeComposing = false
    const xtermTextarea = containerRef.current?.querySelector('.xterm-helper-textarea')
    if (xtermTextarea) {
      xtermTextarea.addEventListener('compositionstart', () => { imeComposing = true })
      xtermTextarea.addEventListener('compositionend', () => { imeComposing = false })
    }

    // Handle copy and paste shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
      // Only handle keydown events to prevent duplicate actions
      if (event.type !== 'keydown') return true

      // During IME composition, block non-composition key events
      // to prevent CAPS LOCK etc. from committing partial input
      if (imeComposing || event.isComposing) {
        // keyCode 229 = IME composition event, let it through
        // Everything else (CAPS LOCK, modifiers, etc.) should be blocked
        return event.keyCode === 229
      }

      // Shift+Enter for newline (multiline input)
      if (event.shiftKey && event.key === 'Enter') {
        event.preventDefault()
        // Send newline character to allow multiline input
        window.electronAPI.pty.write(terminalId, '\n')
        return false
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
        navigator.clipboard.readText().then((text) => {
          handlePasteText(text)
        })
        return false
      }
      // Ctrl+V for paste (standard shortcut)
      if (event.ctrlKey && !event.shiftKey && event.key === 'v') {
        event.preventDefault()
        // On Windows, check if clipboard contains an image and send Alt+V
        const isWindows = navigator.platform.toLowerCase().includes('win')
        if (isWindows) {
          navigator.clipboard.read().then(async (items) => {
            let hasImage = false
            for (const item of items) {
              if (item.types.some(type => type.startsWith('image/'))) {
                hasImage = true
                break
              }
            }
            if (hasImage) {
              // Send Alt+V (ESC + v) to terminal for image paste handling
              window.electronAPI.pty.write(terminalId, '\x1bv')
            } else {
              // Normal text paste
              const text = await navigator.clipboard.readText()
              handlePasteText(text)
            }
          }).catch(() => {
            // Fallback to text paste if clipboard.read() fails
            navigator.clipboard.readText().then((text) => {
              handlePasteText(text)
            })
          })
        } else {
          // On macOS/Linux, just paste text directly
          navigator.clipboard.readText().then((text) => {
            handlePasteText(text)
          })
        }
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
    containerRef.current.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const selection = terminal.getSelection()
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        hasSelection: !!selection
      })
    })

    // Handle terminal output
    const unsubscribeOutput = window.electronAPI.pty.onOutput((id, data) => {
      if (id === terminalId) {
        terminal.write(data)
        // Update activity time when there's output
        workspaceStore.updateTerminalActivity(terminalId)
      }
    })

    // Handle terminal exit
    const unsubscribeExit = window.electronAPI.pty.onExit((id, exitCode) => {
      if (id === terminalId) {
        terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`)
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
      unsubscribeOutput()
      unsubscribeExit()
      unsubscribeSettings()
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      observer.disconnect()
      doResizeRef.current = null
      terminal.dispose()
    }
  }, [terminalId])

  return (
    <div ref={containerRef} className="terminal-panel">
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
  )
})
