import { useCallback, useEffect, useRef, useState } from 'react'
import { requestSessionReload } from '../utils/session-reload'

export function useSessionReload({ sessionId, available, busy, ensureSessionStarted, onFeedback }: {
  sessionId: string
  available: boolean
  busy: boolean
  ensureSessionStarted: () => Promise<void>
  onFeedback: (message: string) => void
}) {
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    ++generation.current
    inFlight.current = false
    setPending(false)
    return () => { ++generation.current }
  }, [sessionId])
  const reload = useCallback(async () => {
    if (inFlight.current) return
    if (!available) { onFeedback('Session reload is available for Claude SDK and Codex sessions.'); return }
    if (busy) { onFeedback('Session is already reloading.'); return }
    const current = generation.current
    inFlight.current = true
    setPending(true)
    try {
      await ensureSessionStarted()
      if (current !== generation.current) return
      const result = await requestSessionReload(sessionId)
      if (current !== generation.current) return
      onFeedback(result.deferred
        ? 'Current agent stopped. The replacement starts on your next message; the conversation and settings are preserved.'
        : 'Agent restarted with fresh MCP configuration. The conversation and settings are preserved.')
    } catch (error) {
      if (current === generation.current) onFeedback(`Session reload failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (current === generation.current) { inFlight.current = false; setPending(false) }
    }
  }, [available, busy, ensureSessionStarted, onFeedback, sessionId])
  return { reload, pending }
}
