import { useState, useEffect } from 'react'
import type { AppSettings, ShellType } from '../types'
import { settingsStore } from '../stores/settings-store'

interface SettingsPanelProps {
  onClose: () => void
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<AppSettings>(settingsStore.getSettings())

  useEffect(() => {
    return settingsStore.subscribe(() => {
      setSettings(settingsStore.getSettings())
    })
  }, [])

  const handleShellChange = (shell: ShellType) => {
    settingsStore.setShell(shell)
  }

  const handleCustomPathChange = (path: string) => {
    settingsStore.setCustomShellPath(path)
  }

  const handleFontSizeChange = (size: number) => {
    settingsStore.setFontSize(size)
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3>Shell</h3>
            <div className="settings-group">
              <label>Default Shell</label>
              <select
                value={settings.shell}
                onChange={e => handleShellChange(e.target.value as ShellType)}
              >
                <option value="auto">Auto (prefer pwsh)</option>
                <option value="pwsh">PowerShell 7 (pwsh)</option>
                <option value="powershell">Windows PowerShell</option>
                <option value="cmd">Command Prompt (cmd)</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            {settings.shell === 'custom' && (
              <div className="settings-group">
                <label>Custom Shell Path</label>
                <input
                  type="text"
                  value={settings.customShellPath}
                  onChange={e => handleCustomPathChange(e.target.value)}
                  placeholder="C:\path\to\shell.exe"
                />
              </div>
            )}
          </div>

          <div className="settings-section">
            <h3>Appearance</h3>
            <div className="settings-group">
              <label>Font Size: {settings.fontSize}px</label>
              <input
                type="range"
                min="10"
                max="24"
                value={settings.fontSize}
                onChange={e => handleFontSizeChange(Number(e.target.value))}
              />
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <p className="settings-note">Changes are saved automatically. Restart terminals to apply shell changes.</p>
        </div>
      </div>
    </div>
  )
}
