import { useCallback, useEffect, useRef, useState } from 'react'
import { host } from '../host-api'

/** Copies a whole file body to the clipboard.
 *
 * Distinct from the preview surfaces' existing "copy path" buttons — this one
 * copies the contents, which is what you want for a script you are about to
 * paste into a terminal.
 */
export function CopyContentButton({ content, className, label = 'Copy script' }: {
  content: string
  className?: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Without this the timer can fire after the preview closes and setState on an
  // unmounted component — easy to hit, since closing the modal is the natural
  // thing to do right after copying.
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 1500)
    }).catch(error => {
      void host.debug.log(`[CopyContentButton] clipboard write failed: ${String(error)}`)
    })
  }, [content])

  return (
    <button
      className={className}
      onClick={handleCopy}
      title={`${label} (${content.length.toLocaleString()} characters)`}
    >
      {copied ? '✓ Copied' : label}
    </button>
  )
}
