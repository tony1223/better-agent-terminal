import { useEffect, useState } from 'react'
import type { TerminalInstance } from '../types'
import { ActivityIndicator } from './ActivityIndicator'

// Global preview cache - persists across component unmounts
const previewCache = new Map<string, string>()

// Global listener setup - only once
let globalListenerSetup = false
const setupGlobalListener = () => {
  if (globalListenerSetup) return
  globalListenerSetup = true

  window.electronAPI.pty.onOutput((id, data) => {
    const prev = previewCache.get(id) || ''
    const combined = prev + data
    // Keep last 8 lines, clean ANSI codes for readability
    const cleaned = combined.replace(/\x1b\[[0-9;]*m/g, '')
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
