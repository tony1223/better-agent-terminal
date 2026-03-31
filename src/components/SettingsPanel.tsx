import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import QRCode from 'qrcode'
import type { AppSettings, ShellType, FontType, ColorPresetId, StatuslineItemConfig, LanguageCode } from '../types'
import { FONT_OPTIONS, COLOR_PRESETS, SHELL_OPTIONS, STATUSLINE_ITEMS } from '../types'
import { settingsStore, parseStatuslineTemplate, exportStatuslineTemplate } from '../stores/settings-store'
import { EnvVarEditor } from './EnvVarEditor'
import { AGENT_PRESETS, AgentPresetId } from '../types/agent-presets'

interface SettingsPanelProps {
  onClose: () => void
}

// Check if a font is available using CSS Font Loading API
const checkFontAvailable = (fontFamily: string): boolean => {
  // Extract the primary font name (first in the list)
  const fontName = fontFamily.split(',')[0].trim().replace(/['"]/g, '')
  if (fontName === 'monospace') return true

  try {
    return document.fonts.check(`12px "${fontName}"`)
  } catch {
    return false
  }
}

interface RemoteServerStatus {
  running: boolean
  port: number | null
  clients: { label: string; connectedAt: number }[]
}

interface RemoteClientStatus {
  connected: boolean
  info: { host: string; port: number } | null
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<AppSettings>(settingsStore.getSettings())
  const [availableFonts, setAvailableFonts] = useState<Set<FontType>>(new Set())

  // Remote server state
  const [serverStatus, setServerStatus] = useState<RemoteServerStatus>({ running: false, port: null, clients: [] })
  const [serverPort, setServerPort] = useState('9876')
  const [serverToken, setServerToken] = useState<string | null>(null)
  const [clientStatus, setClientStatus] = useState<RemoteClientStatus>({ connected: false, info: null })

  // QR code state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrInfo, setQrInfo] = useState<{ url: string; mode: string } | null>(null)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrAddresses, setQrAddresses] = useState<{ ip: string; mode: string; label: string }[]>([])
  const [qrToken, setQrToken] = useState<string | null>(null)
  const [qrPort, setQrPort] = useState<number>(9876)

  // Statusline config state
  const [slItems, setSlItems] = useState<StatuslineItemConfig[]>(settingsStore.getStatuslineItems())
  const [slDragId, setSlDragId] = useState<string | null>(null)
  const [slDropId, setSlDropId] = useState<string | null>(null)
  const [slDropPos, setSlDropPos] = useState<'before' | 'after'>('before')
  const [slImporting, setSlImporting] = useState(false)
  const [slImportText, setSlImportText] = useState('')

  // Get current platform for filtering shell options
  const platform = window.electronAPI?.platform || 'darwin'
  const platformShellOptions = SHELL_OPTIONS.filter(opt => opt.platforms.includes(platform))

  useEffect(() => {
    return settingsStore.subscribe(() => {
      setSettings(settingsStore.getSettings())
    })
  }, [])

  // Check font availability on mount
  useEffect(() => {
    const checkFonts = async () => {
      // Wait for fonts to be loaded
      await document.fonts.ready

      const available = new Set<FontType>()
      for (const font of FONT_OPTIONS) {
        if (font.id === 'system' || font.id === 'custom' || checkFontAvailable(font.fontFamily)) {
          available.add(font.id)
        }
      }
      setAvailableFonts(available)
    }
    checkFonts()
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

  const handleFontFamilyChange = (fontFamily: FontType) => {
    settingsStore.setFontFamily(fontFamily)
  }

  const handleCustomFontFamilyChange = (customFontFamily: string) => {
    settingsStore.setCustomFontFamily(customFontFamily)
  }

  const handleColorPresetChange = (colorPreset: ColorPresetId) => {
    settingsStore.setColorPreset(colorPreset)
  }

  const handleCustomBackgroundColorChange = (color: string) => {
    settingsStore.setCustomBackgroundColor(color)
  }

  const handleCustomForegroundColorChange = (color: string) => {
    settingsStore.setCustomForegroundColor(color)
  }

  const handleCustomCursorColorChange = (color: string) => {
    settingsStore.setCustomCursorColor(color)
  }

  // Load remote status on mount and poll
  useEffect(() => {
    const refresh = async () => {
      const ss = await window.electronAPI.remote.serverStatus()
      setServerStatus(ss)
      const cs = await window.electronAPI.remote.clientStatus()
      setClientStatus(cs)
    }
    refresh()
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [])

  const handleStartServer = async () => {
    const result = await window.electronAPI.remote.startServer(parseInt(serverPort) || 9876)
    if ('error' in result) {
      alert(t('settings.failedToStartServer', { error: result.error }))
    } else {
      setServerToken(result.token)
      setServerPort(String(result.port))
    }
    const ss = await window.electronAPI.remote.serverStatus()
    setServerStatus(ss)
  }

  const handleStopServer = async () => {
    await window.electronAPI.remote.stopServer()
    setServerToken(null)
    const ss = await window.electronAPI.remote.serverStatus()
    setServerStatus(ss)
  }

  const generateQrForIp = useCallback(async (ip: string, mode: string, token: string, port: number) => {
    const url = `ws://${ip}:${port}`
    const payload = JSON.stringify({ url, token, mode })
    const dataUrl = await QRCode.toDataURL(payload, { width: 256, margin: 2 })
    setQrDataUrl(dataUrl)
    setQrInfo({ url, mode })
  }, [])

  const handleGenerateQR = useCallback(async () => {
    setQrLoading(true)
    setQrError(null)
    try {
      const result = await window.electronAPI.tunnel.getConnection()
      if ('error' in result) {
        setQrError(result.error)
        return
      }
      setQrAddresses(result.addresses)
      setQrToken(result.token)
      const port = parseInt(result.url.split(':').pop() || '9876')
      setQrPort(port)
      await generateQrForIp(result.addresses[0].ip, result.addresses[0].mode, result.token, port)
      // Refresh server status since we may have started it
      const ss = await window.electronAPI.remote.serverStatus()
      setServerStatus(ss)
      if (result.token) setServerToken(result.token)
    } catch (err) {
      setQrError(err instanceof Error ? err.message : String(err))
    } finally {
      setQrLoading(false)
    }
  }, [generateQrForIp])

  const terminalColors = settingsStore.getTerminalColors()

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('settings.title')}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3>{t('settings.language')}</h3>
            <div className="settings-group">
              <label>{t('settings.language')}</label>
              <select
                value={settings.language || 'en'}
                onChange={e => {
                  const value = e.target.value as LanguageCode
                  settingsStore.setLanguage(value)
                  i18next.changeLanguage(value)
                }}
              >
                <option value="en">English</option>
                <option value="zh-TW">繁體中文</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </div>
          </div>

          <div className="settings-section">
            <h3>{t('settings.shell')}</h3>
            <div className="settings-group">
              <label>{t('settings.defaultShell')}</label>
              <select
                value={settings.shell}
                onChange={e => handleShellChange(e.target.value as ShellType)}
              >
                {platformShellOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.name}</option>
                ))}
              </select>
            </div>

            {settings.shell === 'custom' && (
              <div className="settings-group">
                <label>{t('settings.customShellPath')}</label>
                <input
                  type="text"
                  value={settings.customShellPath}
                  onChange={e => handleCustomPathChange(e.target.value)}
                  placeholder={platform === 'win32' ? 'C:\\path\\to\\shell.exe' : '/path/to/shell'}
                />
              </div>
            )}

            <div className="settings-group">
              <label>{t('settings.defaultTerminalCount', { count: settings.defaultTerminalCount || 1 })}</label>
              <input
                type="range"
                min="1"
                max="5"
                value={settings.defaultTerminalCount || 1}
                onChange={e => settingsStore.setDefaultTerminalCount(Number(e.target.value))}
              />
            </div>

            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.createDefaultAgentTerminal === true}
                  onChange={e => settingsStore.setCreateDefaultAgentTerminal(e.target.checked)}
                />
                {t('settings.createAgentTerminalByDefault')}
              </label>
              <p className="settings-hint">{t('settings.createAgentTerminalHint')}</p>
            </div>

            {settings.createDefaultAgentTerminal && (
              <>
                <div className="settings-group">
                  <label>{t('settings.defaultAgent')}</label>
                  <select
                    value={settings.defaultAgent || 'claude-code'}
                    onChange={e => settingsStore.setDefaultAgent(e.target.value as AgentPresetId)}
                  >
                    {AGENT_PRESETS.filter(p => p.id !== 'none').map(preset => (
                      <option key={preset.id} value={preset.id}>
                        {preset.icon} {preset.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.agentAutoCommand === true}
                      onChange={e => settingsStore.setAgentAutoCommand(e.target.checked)}
                    />
                    {t('settings.autoRunAgentCommand')}
                  </label>
                  <p className="settings-hint">{t('settings.autoRunAgentCommandHint')}</p>
                </div>
              </>
            )}

            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.allowBypassPermissions === true}
                  onChange={e => settingsStore.setAllowBypassPermissions(e.target.checked)}
                />
                {t('settings.allowBypassPermissions')}
              </label>
              <p className="settings-hint">{t('settings.allowBypassPermissionsHint')}</p>
            </div>

            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.collapseToolOutputs === true}
                  onChange={e => settingsStore.setCollapseToolOutputs(e.target.checked)}
                />
                {t('settings.collapseToolOutputs')}
              </label>
              <p className="settings-hint">{t('settings.collapseToolOutputsHint')}</p>
            </div>

            <div className="settings-group">
              <label>{t('settings.defaultModel')}</label>
              <input
                type="text"
                value={settings.defaultModel || ''}
                onChange={e => settingsStore.setDefaultModel(e.target.value)}
                placeholder={t('settings.defaultModelPlaceholder')}
              />
              <p className="settings-hint">{t('settings.defaultModelHint')}</p>
            </div>

            <div className="settings-group">
              <label>{t('settings.defaultEffort')}</label>
              <select
                value={settings.defaultEffort || 'medium'}
                onChange={e => settingsStore.setDefaultEffort(e.target.value as 'low' | 'medium' | 'high')}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
              <p className="settings-hint">{t('settings.defaultEffortHint')}</p>
            </div>
          </div>

          <div className="settings-section">
            <h3>{t('settings.notifications')}</h3>
            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.showDockBadge !== false}
                  onChange={e => settingsStore.setShowDockBadge(e.target.checked)}
                />
                {t('settings.showDockBadge')}
              </label>
              <p className="settings-hint">{t('settings.showDockBadgeHint')}</p>
            </div>
            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.notifyOnComplete !== false}
                  onChange={e => settingsStore.setNotifyOnComplete(e.target.checked)}
                />
                {t('settings.notifyOnComplete')}
              </label>
              <p className="settings-hint">{t('settings.notifyOnCompleteHint')}</p>
            </div>
            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.notifySound !== false}
                  onChange={e => settingsStore.setNotifySound(e.target.checked)}
                />
                {t('settings.notifySound')}
              </label>
            </div>
            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.notifyOnlyBackground !== false}
                  onChange={e => settingsStore.setNotifyOnlyBackground(e.target.checked)}
                />
                {t('settings.notifyOnlyBackground')}
              </label>
              <p className="settings-hint">{t('settings.notifyOnlyBackgroundHint')}</p>
            </div>
          </div>

          <div className="settings-section">
            <h3>{t('settings.appearance')}</h3>
            <div className="settings-group">
              <label>{t('settings.fontSize', { size: settings.fontSize })}</label>
              <input
                type="range"
                min="10"
                max="24"
                value={settings.fontSize}
                onChange={e => handleFontSizeChange(Number(e.target.value))}
              />
            </div>

            <div className="settings-group">
              <label>{t('settings.fontFamily')}</label>
              <select
                value={settings.fontFamily}
                onChange={e => handleFontFamilyChange(e.target.value as FontType)}
              >
                {FONT_OPTIONS.map(font => (
                  <option key={font.id} value={font.id} disabled={!availableFonts.has(font.id) && font.id !== 'custom'}>
                    {font.name} {availableFonts.has(font.id) ? '✓' : t('settings.fontNotInstalled')}
                  </option>
                ))}
              </select>
            </div>

            {settings.fontFamily === 'custom' && (
              <div className="settings-group">
                <label>{t('settings.customFontName')}</label>
                <input
                  type="text"
                  value={settings.customFontFamily}
                  onChange={e => handleCustomFontFamilyChange(e.target.value)}
                  placeholder={t('settings.customFontPlaceholder')}
                />
              </div>
            )}

            <div className="settings-group">
              <label>{t('settings.colorTheme')}</label>
              <select
                value={settings.colorPreset}
                onChange={e => handleColorPresetChange(e.target.value as ColorPresetId)}
              >
                {COLOR_PRESETS.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </div>

            {settings.colorPreset === 'custom' && (
              <>
                <div className="settings-group color-picker-group">
                  <label>{t('settings.backgroundColor')}</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={settings.customBackgroundColor}
                      onChange={e => handleCustomBackgroundColorChange(e.target.value)}
                    />
                    <input
                      type="text"
                      value={settings.customBackgroundColor}
                      onChange={e => handleCustomBackgroundColorChange(e.target.value)}
                      placeholder="#1f1d1a"
                    />
                  </div>
                </div>

                <div className="settings-group color-picker-group">
                  <label>{t('settings.textColor')}</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={settings.customForegroundColor}
                      onChange={e => handleCustomForegroundColorChange(e.target.value)}
                    />
                    <input
                      type="text"
                      value={settings.customForegroundColor}
                      onChange={e => handleCustomForegroundColorChange(e.target.value)}
                      placeholder="#dfdbc3"
                    />
                  </div>
                </div>

                <div className="settings-group color-picker-group">
                  <label>{t('settings.cursorColor')}</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={settings.customCursorColor}
                      onChange={e => handleCustomCursorColorChange(e.target.value)}
                    />
                    <input
                      type="text"
                      value={settings.customCursorColor}
                      onChange={e => handleCustomCursorColorChange(e.target.value)}
                      placeholder="#dfdbc3"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="settings-group font-preview">
              <label>{t('common.preview')}</label>
              <div
                className="font-preview-box"
                style={{
                  fontFamily: settingsStore.getFontFamilyString(),
                  fontSize: settings.fontSize,
                  backgroundColor: terminalColors.background,
                  color: terminalColors.foreground
                }}
              >
                $ echo "Hello World" 你好世界 0123456789
              </div>
            </div>
          </div>

          {/* Statusline Configuration */}
          <div className="settings-section">
            <h3>{t('settings.statusline')}</h3>
            <p className="settings-hint" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              {t('settings.statuslineHint')}
            </p>
            <div className="statusline-config-list">
              {slItems.map(item => {
                const def = STATUSLINE_ITEMS.find(d => d.id === item.id)
                if (!def) return null
                return (
                  <div key={item.id}
                    className={`statusline-config-item${slDragId === item.id ? ' dragging' : ''}${slDropId === item.id ? ` drop-${slDropPos}` : ''}`}
                    draggable
                    onDragStart={() => setSlDragId(item.id)}
                    onDragEnd={() => { setSlDragId(null); setSlDropId(null) }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      setSlDropPos(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
                      setSlDropId(item.id)
                    }}
                    onDragLeave={() => setSlDropId(null)}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (!slDragId || slDragId === item.id) return
                      const items = [...slItems]
                      const dragIdx = items.findIndex(i => i.id === slDragId)
                      const targetIdx = items.findIndex(i => i.id === item.id)
                      if (dragIdx === -1 || targetIdx === -1) return
                      const [dragged] = items.splice(dragIdx, 1)
                      const insertIdx = slDropPos === 'after' ? targetIdx + (dragIdx < targetIdx ? 0 : 1) : targetIdx + (dragIdx < targetIdx ? -1 : 0)
                      items.splice(Math.max(0, insertIdx), 0, dragged)
                      setSlItems(items)
                      settingsStore.setStatuslineItems(items)
                      setSlDragId(null); setSlDropId(null)
                    }}
                    title={def.description}
                  >
                    <span className="statusline-config-drag">&#x2630;</span>
                    <span className="statusline-config-label">{def.label}</span>
                    <span className="statusline-config-align">
                      {(['left', 'center', 'right'] as const).map(a => (
                        <button key={a}
                          className={`statusline-align-btn${(item.align || 'left') === a ? ' active' : ''}`}
                          onClick={() => {
                            const updated = slItems.map(i => i.id === item.id ? { ...i, align: a } : i)
                            setSlItems(updated); settingsStore.setStatuslineItems(updated)
                          }}
                          title={a}
                        >{a === 'left' ? 'L' : a === 'center' ? 'C' : 'R'}</button>
                      ))}
                    </span>
                    <button
                      className={`statusline-sep-btn${item.separatorAfter ? ' active' : ''}`}
                      onClick={() => {
                        const updated = slItems.map(i => i.id === item.id ? { ...i, separatorAfter: !i.separatorAfter } : i)
                        setSlItems(updated); settingsStore.setStatuslineItems(updated)
                      }}
                      title={t('settings.statuslineToggleSeparator')}
                    >&gt;</button>
                    <span className="statusline-color-swatches">
                      {['', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#d19a66', '#abb2bf'].map(c => (
                        <button
                          key={c || 'default'}
                          className={`statusline-color-swatch${(item.color || '') === c ? ' active' : ''}`}
                          style={{ background: c || 'var(--text-secondary)' }}
                          onClick={() => {
                            const updated = slItems.map(i => i.id === item.id ? { ...i, color: c || undefined } : i)
                            setSlItems(updated); settingsStore.setStatuslineItems(updated)
                          }}
                          title={c || 'Default'}
                        />
                      ))}
                      <input
                        type="color"
                        className="statusline-color-custom"
                        value={item.color || '#999999'}
                        onChange={e => {
                          const updated = slItems.map(i => i.id === item.id ? { ...i, color: e.target.value } : i)
                          setSlItems(updated); settingsStore.setStatuslineItems(updated)
                        }}
                        title={t('settings.statuslineCustomColor')}
                      />
                    </span>
                    <label className="statusline-config-toggle">
                      <input type="checkbox" checked={item.visible} onChange={() => {
                        const updated = slItems.map(i => i.id === item.id ? { ...i, visible: !i.visible } : i)
                        setSlItems(updated); settingsStore.setStatuslineItems(updated)
                      }} />
                    </label>
                  </div>
                )
              })}
            </div>
            <div className="statusline-template-bar" style={{ marginTop: '8px', display: 'flex', gap: '4px', alignItems: 'center' }}>
              {slImporting ? (
                <>
                  <input
                    value={slImportText}
                    onChange={e => setSlImportText(e.target.value)}
                    placeholder="sessionId,tokens > cost | prompts"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && slImportText.trim()) {
                        const parsed = parseStatuslineTemplate(slImportText.trim())
                        setSlItems(parsed); settingsStore.setStatuslineItems(parsed)
                        setSlImporting(false); setSlImportText('')
                      }
                    }}
                    autoFocus
                    style={{ flex: 1, fontSize: '11px', padding: '3px 6px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '3px', color: 'var(--text-primary)' }}
                  />
                  <button className="statusline-template-btn" onClick={() => {
                    if (!slImportText.trim()) return
                    const parsed = parseStatuslineTemplate(slImportText.trim())
                    setSlItems(parsed); settingsStore.setStatuslineItems(parsed)
                    setSlImporting(false); setSlImportText('')
                  }}>{t('common.apply')}</button>
                  <button className="statusline-template-btn" onClick={() => { setSlImporting(false); setSlImportText('') }}>{t('common.cancel')}</button>
                </>
              ) : (
                <>
                  <input
                    readOnly
                    value={exportStatuslineTemplate(slItems)}
                    style={{ flex: 1, fontSize: '11px', padding: '3px 6px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '3px', color: 'var(--text-secondary)' }}
                    title={t('settings.statuslineCurrentTemplate')}
                  />
                  <button className="statusline-template-btn" onClick={() => navigator.clipboard.writeText(exportStatuslineTemplate(slItems))}>{t('common.copy')}</button>
                  <button className="statusline-template-btn" onClick={() => setSlImporting(true)}>{t('common.import')}</button>
                  <button className="statusline-template-btn" onClick={() => {
                    settingsStore.setStatuslineItems(undefined as unknown as StatuslineItemConfig[])
                    setSlItems(settingsStore.getStatuslineItems())
                  }}>{t('common.reset')}</button>
                </>
              )}
            </div>
          </div>

          <div className="settings-section">
            <h3>{t('settings.environmentVariables')}</h3>
            <p className="settings-hint" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              {t('settings.globalEnvVarsHint')}
            </p>
            <EnvVarEditor
              envVars={settings.globalEnvVars || []}
              onAdd={(envVar) => settingsStore.addGlobalEnvVar(envVar)}
              onRemove={(key) => settingsStore.removeGlobalEnvVar(key)}
              onUpdate={(key, updates) => settingsStore.updateGlobalEnvVar(key, updates)}
            />
          </div>
          <div className="settings-section">
            <h3>{t('settings.remoteAccess')}</h3>
            <p className="settings-hint" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              {t('settings.remoteAccessHint')}{' '}
              <a href="https://github.com/tony1223/better-agent-terminal#remote-access--mobile-connect"
                style={{ color: '#58a6ff' }}
                onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) || window.open(e.currentTarget.href) }}>
                {t('settings.remoteAccessReadme')}
              </a>。
            </p>

            {serverStatus.running ? (
              <>
                <div className="settings-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#3fb950', fontSize: 12 }}>{t('settings.serverRunningOnPort', { port: serverStatus.port })}</span>
                  <button className="profile-action-btn danger" onClick={handleStopServer} style={{ marginLeft: 'auto' }}>
                    {t('settings.stopServer')}
                  </button>
                </div>
                {serverToken && (
                  <div className="settings-group">
                    <label>{t('settings.connectionToken')}</label>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="text"
                        readOnly
                        value={serverToken}
                        style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }}
                        onClick={e => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        className="profile-action-btn"
                        onClick={() => navigator.clipboard.writeText(serverToken)}
                        title="Copy token"
                      >
                        {t('common.copy')}
                      </button>
                    </div>
                  </div>
                )}
                {serverStatus.clients.length > 0 && (
                  <div className="settings-group">
                    <label>{t('settings.connectedClients', { count: serverStatus.clients.length })}</label>
                    {serverStatus.clients.map((c, i) => (
                      <div key={i} style={{ fontSize: 12, color: '#aaa', padding: '2px 0' }}>
                        {c.label} — {t('settings.connectedAt', { time: new Date(c.connectedAt).toLocaleTimeString() })}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="settings-group">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    value={serverPort}
                    onChange={e => setServerPort(e.target.value)}
                    placeholder={t('settings.port')}
                    style={{ width: 80 }}
                  />
                  <button className="profile-action-btn primary" onClick={handleStartServer}>
                    {t('settings.startServer')}
                  </button>
                </div>
                <p style={{ fontSize: 11, color: '#d29922', marginTop: 6, lineHeight: 1.4 }}>
                  {t('settings.serverWarning')}
                </p>
              </div>
            )}

            {clientStatus.connected && clientStatus.info && (
              <div className="settings-group" style={{ marginTop: 8 }}>
                <span style={{ color: '#58a6ff', fontSize: 12 }}>
                  {t('settings.connectedToRemote', { host: clientStatus.info.host, port: clientStatus.info.port })}
                </span>
              </div>
            )}

            <div className="settings-group" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <label>{t('settings.mobileConnect')} <span style={{ fontSize: 10, color: '#d29922', fontWeight: 'normal' }}>{t('settings.mobileConnectExperimental')}</span></label>
              <p style={{ fontSize: 11, color: '#8b949e', marginTop: 2, marginBottom: 6, lineHeight: 1.4 }}>
                {t('settings.mobileConnectHint')}{' '}
                <a href="https://tailscale.com/" style={{ color: '#58a6ff' }}
                  onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) || window.open(e.currentTarget.href) }}>
                  Tailscale
                </a>{' '}
                {t('settings.mobileConnectSeeReadme')}{' '}
                <a href="https://github.com/tony1223/better-agent-terminal#remote-access--mobile-connect"
                  style={{ color: '#58a6ff' }}
                  onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) || window.open(e.currentTarget.href) }}>
                  {t('settings.remoteAccessReadme')}
                </a>。
              </p>
              {!qrDataUrl ? (
                <>
                  <button
                    className="profile-action-btn primary"
                    onClick={handleGenerateQR}
                    disabled={qrLoading}
                    style={{ marginTop: 4 }}
                  >
                    {qrLoading ? t('settings.generating') : t('settings.generateQrCode')}
                  </button>
                  <p style={{ fontSize: 11, color: '#d29922', marginTop: 6, lineHeight: 1.4 }}>
                    {t('settings.qrWarning')}
                  </p>
                  {qrError && (
                    <p style={{ fontSize: 11, color: '#f85149', marginTop: 4 }}>{qrError}</p>
                  )}
                </>
              ) : (
                <div style={{ textAlign: 'center', marginTop: 8 }}>
                  {qrAddresses.length > 1 && (
                    <select
                      style={{ width: '100%', marginBottom: 8, fontSize: 12, padding: '4px 6px' }}
                      value={qrInfo?.url?.split('//')[1]?.split(':')[0] || ''}
                      onChange={async (e) => {
                        const addr = qrAddresses.find(a => a.ip === e.target.value)
                        if (addr && qrToken) {
                          await generateQrForIp(addr.ip, addr.mode, qrToken, qrPort)
                        }
                      }}
                    >
                      {qrAddresses.map(addr => (
                        <option key={addr.ip} value={addr.ip}>{addr.label}</option>
                      ))}
                    </select>
                  )}
                  <img
                    src={qrDataUrl}
                    alt="QR Code"
                    style={{ width: 200, height: 200, imageRendering: 'pixelated', borderRadius: 4, background: '#fff', padding: 4 }}
                  />
                  <p style={{ fontSize: 11, color: '#8b949e', marginTop: 6, wordBreak: 'break-all', fontFamily: 'monospace' }}>
                    {qrInfo?.url}
                  </p>
                  <p style={{ fontSize: 11, color: qrInfo?.mode === 'tailscale' ? '#3fb950' : '#d29922', marginTop: 2 }}>
                    {qrInfo?.mode === 'tailscale' ? t('settings.viaTailscale') : t('settings.lanOnly')}
                  </p>
                  <button
                    className="profile-action-btn"
                    onClick={() => { setQrDataUrl(null); setQrInfo(null); setQrAddresses([]) }}
                    style={{ marginTop: 8 }}
                  >
                    {t('common.close')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <p className="settings-note">{t('settings.footerNote')}</p>
        </div>
      </div>
    </div>
  )
}
