import { useEffect, useState } from 'react'
import type { TerminalInstance } from '../types'
import { ActivityIndicator } from './ActivityIndicator'

// Global preview cache - persists across component unmounts
const previewCache = new Map<string, string>()

// Strip all ANSI escape sequences (not just colors)
const stripAnsi = (str: string): string => {
  return str
    // CSI sequences: \x1b[ followed by params and command char
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // OSC sequences: \x1b] ... (terminated by BEL \x07 or ST \x1b\\)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Other escape sequences: \x1b followed by single char
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[=>]/g, '')
    // DCS, PM, APC sequences
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    // Bell character
    .replace(/\x07/g, '')
    // Carriage return (often used for overwriting lines)
    .replace(/\r/g, '')
    // Any remaining single-char escapes
    .replace(/\x1b./g, '')
}

// Global listener setup - only once
let globalListenerSetup = false
const setupGlobalListener = () => {
  if (globalListenerSetup) return
  globalListenerSetup = true

  window.electronAPI.pty.onOutput((id, data) => {
    const prev = previewCache.get(id) || ''
    const combined = prev + data
    // Keep last 8 lines, clean all ANSI escape sequences for readability
    const cleaned = stripAnsi(combined)
    const lines = cleaned.split('\n').slice(-8)
    previewCache.set(id, lines.join('\n'))
  })
}

interface TerminalThumbnailProps {
  terminal: TerminalInstance
  isActive: boolean
  onClick: () => void
}

export function TerminalThumbnail({ terminal, isActive, onClick }: TerminalThumbnailProps) {
  const [preview, setPreview] = useState<string>(previewCache.get(terminal.id) || '')
  const isClaudeCode = terminal.type === 'claude-code'

  useEffect(() => {
    setupGlobalListener()

    // Poll for updates from cache
    const interval = setInterval(() => {
      const cached = previewCache.get(terminal.id) || ''
      setPreview(cached)
    }, 500)

    return () => clearInterval(interval)
  }, [terminal.id])

  return (
    <div
      className={`thumbnail ${isActive ? 'active' : ''} ${isClaudeCode ? 'claude-code' : ''}`}
      onClick={onClick}
    >
      <div className="thumbnail-header">
        <div className={`thumbnail-title ${isClaudeCode ? 'claude-code' : ''}`}>
          {isClaudeCode && <span>✦</span>}
          <span>{terminal.title}</span>
        </div>
        <ActivityIndicator terminalId={terminal.id} size="small" />
      </div>
      <div className="thumbnail-preview">
        {preview || '$ _'}
      </div>
    </div>
  )
}
