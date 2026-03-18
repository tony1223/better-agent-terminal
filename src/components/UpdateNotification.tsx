import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface ReleaseInfo {
  version: string
  tagName: string
  htmlUrl: string
  downloadUrl: string | null
  body: string
  publishedAt: string
}

interface UpdateCheckResult {
  hasUpdate: boolean
  currentVersion: string
  latestRelease: ReleaseInfo | null
}

export function UpdateNotification() {
  const { t } = useTranslation()
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const result = await window.electronAPI.update.check()
        setUpdateInfo(result)
      } catch (error) {
        console.error('Failed to check for updates:', error)
      } finally {
        setChecking(false)
      }
    }

    // Check for updates after a short delay to not block startup
    const timer = setTimeout(checkUpdate, 2000)
    return () => clearTimeout(timer)
  }, [])

  if (checking || !updateInfo?.hasUpdate || dismissed || !updateInfo.latestRelease) {
    return null
  }

  const { latestRelease, currentVersion } = updateInfo

  const handleViewRelease = () => {
    window.electronAPI.shell.openExternal('https://github.com/tony1223/better-agent-terminal/releases')
  }

  // Parse changelog - extract first few lines
  const changelogLines = latestRelease.body
    .split('\n')
    .filter(line => line.trim())
    .slice(0, 8)
    .join('\n')

  return (
    <div className="update-notification-overlay">
      <div className="update-notification">
        <div className="update-header">
          <h3>{t('update.newVersionAvailable')}</h3>
          <button className="close-btn" onClick={() => setDismissed(true)}>×</button>
        </div>

        <div className="update-content">
          <div className="version-info">
            <span className="current-version">{t('update.currentVersion', { version: currentVersion })}</span>
            <span className="arrow">→</span>
            <span className="new-version">{t('update.newVersion', { version: latestRelease.tagName })}</span>
          </div>

          {changelogLines && (
            <div className="changelog">
              <h4>{t('update.whatsNew')}</h4>
              <pre>{changelogLines}</pre>
            </div>
          )}
        </div>

        <div className="update-actions">
          <button className="btn-primary" onClick={handleViewRelease}>
            {t('update.viewOnGithub')}
          </button>
        </div>
      </div>
    </div>
  )
}
