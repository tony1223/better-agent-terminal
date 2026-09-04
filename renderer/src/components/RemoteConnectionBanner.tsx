import { useTranslation } from 'react-i18next'

const barStyle: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 12,
  transform: 'translateX(-50%)',
  zIndex: 9998,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  maxWidth: 'min(560px, 92vw)',
  padding: '8px 14px',
  borderRadius: 8,
  fontSize: 13,
  lineHeight: 1.4,
  background: 'var(--bg-secondary, #26231f)',
  color: 'var(--text-primary, #dfdbc3)',
  border: '1px solid var(--warning-color, #d29922)',
  boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
}

const dotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: 'var(--warning-color, #d29922)',
  animation: 'breathe-active 1.6s ease-in-out infinite',
}

/**
 * Shown while a remote-profile window has lost its host connection and the
 * background reconnect loop in App.tsx is retrying. Only after a connection
 * existed once: the initial connect has its own startup screen, and a banner
 * flashing before the first status poll would be noise.
 */
export function RemoteConnectionBanner({ visible, hostName }: Readonly<{ visible: boolean; hostName: string }>) {
  const { t } = useTranslation()
  if (!visible) return null
  return (
    <div style={barStyle} role="status">
      <span style={dotStyle} />
      <span>{t('remoteBanner.reconnecting', { host: hostName })}</span>
    </div>
  )
}
