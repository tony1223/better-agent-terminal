// The "open containing folder" context menu, shared by every surface that shows
// the user a file.
//
// The app's agents deliver files — reports, exports, generated images — and the
// user's next move is usually to get at that file in their own file manager, to
// copy it or open it in something else. Several unrelated surfaces cite files
// (agent prose, tool output, the preview modal, the file tree), so the menu lives
// here once instead of being pasted into each of them.
//
// Callers own only the target state and hand it over; this component owns the
// dismissal listener, the host call, and how a failure is reported.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { host } from '../host-api'
import { formatErrorMessage } from '../utils/error-message'
import { stripLineSuffix } from '../utils/file-path'

export interface RevealPathTarget {
  /** Viewport coordinates of the right-click. */
  x: number
  y: number
  /** The cited path. A "file.ts:42" suffix is fine — it is stripped here. */
  path: string
}

export function RevealPathMenu({ target, onClose }: { target: RevealPathTarget; onClose: () => void }) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const handleReveal = useCallback(async () => {
    const { path } = stripLineSuffix(target.path)
    try {
      await host.shell.revealPath(path)
      onClose()
    } catch (revealError) {
      // There is no app-wide toast and inline chat text has nowhere to host one,
      // so the menu stays open and reports the failure itself rather than
      // appearing to do nothing. The host already falls back to the nearest
      // surviving folder, so reaching here means either nothing on the path
      // exists or the file lives on a remote host — both worth saying out loud.
      const message = formatErrorMessage(revealError, 'Unable to open the containing folder')
      setError(message)
      void host.debug.log(`[RevealPathMenu] revealPath failed for ${path}: ${message}`)
    }
  }, [target.path, onClose])

  return (
    <div
      ref={menuRef}
      className="floating-context-menu"
      style={{ left: target.x, top: target.y }}
    >
      <div className="context-menu-item" onClick={() => { void handleReveal() }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        {t('common.openContainingFolder')}
      </div>
      {error && <div className="context-menu-error">{error}</div>}
    </div>
  )
}
