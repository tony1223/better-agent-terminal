import { useTranslation } from 'react-i18next'

interface AboutPanelProps {
  onClose: () => void
}

export function AboutPanel({ onClose }: AboutPanelProps) {
  const { t } = useTranslation()
  const handleLinkClick = (url: string) => {
    window.electronAPI.shell.openExternal(url)
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel about-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('about.title')}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-content about-content">
          <div className="about-logo">
            <span className="about-icon">⬛</span>
            <h1>{t('about.appName')}</h1>
          </div>

          <p className="about-description">
            {t('about.description')}
          </p>

          <div className="about-info">
            <div className="about-row">
              <span className="about-label">{t('about.author')}</span>
              <span className="about-value">{t('about.authorName')}</span>
            </div>
            <div className="about-row">
              <span className="about-label">{t('about.github')}</span>
              <a
                href="#"
                className="about-link"
                onClick={(e) => {
                  e.preventDefault()
                  handleLinkClick('https://github.com/tony1223/better-agent-terminal')
                }}
              >
                github.com/tony1223/better-agent-terminal
              </a>
            </div>
          </div>

          <div className="about-credits">
            <p>{t('about.builtWith')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
