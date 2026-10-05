import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { host } from '../host-api'
import { formatErrorMessage } from '../utils/error-message'

export interface LinkMenuTarget {
  x: number
  y: number
  href: string
}

export function LinkContextMenu({ target, onClose }: { target: LinkMenuTarget; onClose: () => void }) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [position, setPosition] = useState({ x: target.x, y: target.y })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    setPosition({
      x: Math.max(8, Math.min(target.x, window.innerWidth - menu.offsetWidth - 8)),
      y: Math.max(8, Math.min(target.y, window.innerHeight - menu.offsetHeight - 8)),
    })
  }, [target.x, target.y, error])

  useEffect(() => {
    setError(null)
  }, [target.href])

  useEffect(() => {
    const dismissOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape, true)
    document.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape, true)
      document.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const copyLink = async () => {
    try {
      // Copy the URL directly: signed download query parameters must survive.
      if (await host.clipboard.writeText(target.href) === false) {
        throw new Error(t('common.copyLinkFailed'))
      }
      onClose()
    } catch (copyError) {
      setError(formatErrorMessage(copyError, t('common.copyLinkFailed')))
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className="floating-context-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
      onClick={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
    >
      <button type="button" className="context-menu-item" role="menuitem" autoFocus onClick={() => { void copyLink() }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="8" y="8" width="12" height="12" rx="2" />
          <path d="M16 8V4H4v12h4" />
        </svg>
        {t('common.copyLink')}
      </button>
      {error && <div className="context-menu-error" role="alert">{error}</div>}
    </div>,
    document.body,
  )
}
