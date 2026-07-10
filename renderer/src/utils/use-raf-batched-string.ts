import { useCallback, useEffect, useRef, useState } from 'react'
import type { PanelActivation } from './panel-activation'

// useRafBatchedString — accumulate streaming deltas in a ref and flush to
// React state at most once per animation frame. The Codex/Claude SDKs can
// stream many tokens per second; setting state on every chunk causes the
// whole panel to re-render, which is expensive when a sibling message
// already holds a large tool result (regex + split helpers run over the
// full string on every render). Batching collapses N chunks per frame
// into a single setState while keeping the visible streaming text live.
//
// `value`  — latest flushed value, safe to render
// `append` — buffer a delta and schedule a RAF flush
// `reset`  — synchronously clear the buffer + state (cancels pending RAF)
// `peek`   — read the latest buffered value (including unflushed deltas)
interface RafBatchedStringOptions {
  activation?: PanelActivation
  inactiveFlushMs?: number
}

export function useRafBatchedString(initial: string = '', options: RafBatchedStringOptions = {}): {
  value: string
  append: (delta: string) => void
  reset: (next: string) => void
  peek: () => string
} {
  const [value, setValue] = useState(initial)
  const bufferRef = useRef(initial)
  const rafRef = useRef<number | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { activation, inactiveFlushMs = 500 } = options

  const flush = useCallback(() => {
    rafRef.current = null
    timeoutRef.current = null
    setValue(bufferRef.current)
  }, [])

  const schedule = useCallback(() => {
    if (rafRef.current !== null || timeoutRef.current !== null) return
    if (activation?.current === false) {
      timeoutRef.current = setTimeout(flush, inactiveFlushMs)
    } else {
      rafRef.current = requestAnimationFrame(flush)
    }
  }, [activation, flush, inactiveFlushMs])

  const append = useCallback((delta: string) => {
    if (!delta) return
    bufferRef.current = bufferRef.current + delta
    schedule()
  }, [schedule])

  const reset = useCallback((next: string) => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    bufferRef.current = next
    setValue(next)
  }, [])

  const peek = useCallback(() => bufferRef.current, [])

  useEffect(() => {
    if (!activation) return
    return activation.subscribe(active => {
      if (active && timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
        rafRef.current = requestAnimationFrame(flush)
      } else if (!active && rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
        timeoutRef.current = setTimeout(flush, inactiveFlushMs)
      }
    })
  }, [activation, flush, inactiveFlushMs])

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
  }, [])

  return { value, append, reset, peek }
}
