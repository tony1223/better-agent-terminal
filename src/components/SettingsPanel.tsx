import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import QRCode from 'qrcode'
import type { AppSettings, ShellType, FontType, ColorPresetId, StatuslineItemConfig, LanguageCode, EffortLevel, CodexEffortLevel } from '../types'
import { FONT_OPTIONS, COLOR_PRESETS, SHELL_OPTIONS, STATUSLINE_ITEMS, EFFORT_LEVELS, CODEX_EFFORT_LEVELS } from '../types'
import { settingsStore, parseStatuslineTemplate, exportStatuslineTemplate } from '../stores/settings-store'
import { EnvVarEditor } from './EnvVarEditor'
import { AgentPresetId, getVisiblePresets } from '../types/agent-presets'
import { buildConnectionUrl } from '../utils/connection-url'
import { CLAUDE_BUILTIN_MODELS } from '../utils/claude-model-presets'
import { CODEX_MODELS } from '../utils/codex-models'

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
  fingerprint: string | null
  bindInterface: 'localhost' | 'tailscale' | 'all' | null
  boundHost: string | null
  clients: { label: string; windowId?: string | null; connectedAt: number }[]
}

type BindInterface = 'localhost' | 'tailscale' | 'all'

interface RemoteClientStatus {
  connected: boolean
  info: { host: string; port: number } | null
}

interface CxDetectionStatus {
  enabled: boolean
  detected: boolean
  path?: string
  version?: string
  cacheDir: string
  error?: string
}

type SettingsTab = 'general' | 'agent' | 'remote' | 'advanced'
const CUSTOM_MODEL_OPTION = '__custom_model__'

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [settings, setSettings] = useState<AppSettings>(settingsStore.getSettings())
  const [availableFonts, setAvailableFonts] = useState<Set<FontType>>(new Set())

  // Remote server state
  const [serverStatus, setServerStatus] = useState<RemoteServerStatus>({ running: false, port: null, fingerprint: null, bindInterface: null, boundHost: null, clients: [] })
  const [serverPort, setServerPort] = useState(String(settings.remoteServerPort || 9876))
  const [serverToken, setServerToken] = useState<string | null>(null)
  const [bindInterface, setBindInterface] = useState<BindInterface>(settings.remoteServerBindInterface || 'localhost')
  const [clientStatus, setClientStatus] = useState<RemoteClientStatus>({ connected: false, info: null })

  // OpenAI API key state
  const [openaiKeyStatus, setOpenaiKeyStatus] = useState<{ hasKey: boolean }>({ hasKey: false })
  const [openaiKeyInput, setOpenaiKeyInput] = useState('')
  const [openaiKeySaving, setOpenaiKeySaving] = useState(false)
  const [cxStatus, setCxStatus] = useState<CxDetectionStatus | null>(null)
  const [cxDetecting, setCxDetecting] = useState(false)

  // QR code state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrInfo, setQrInfo] = useState<{ url: string; mode: string } | null>(null)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrAddresses, setQrAddresses] = useState<{ ip: string; mode: string; label: string }[]>([])
  const [qrToken, setQrToken] = useState<string | null>(null)
  const [qrFingerprint, setQrFingerprint] = useState<string | null>(null)
  const [qrPort, setQrPort] = useState<number>(9876)
  const [qrContext, setQrContext] = useState<{ windowId?: string | null } | undefined>(undefined)

  // One-shot connection URL — for `bind=all` we need a usable host (not 0.0.0.0),
  // so we resolve it on-demand via tunnel.getConnection().
  const [connectionUrlHost, setConnectionUrlHost] = useState<string | null>(null)

  // Statusline config state
  const [slItems, setSlItems] = useState<StatuslineItemConfig[]>(settingsStore.getStatuslineItems())
  const [slDragId, setSlDragId] = useState<string | null>(null)
  const [slDropId, setSlDropId] = useState<string | null>(null)
  const [slDropPos, setSlDropPos] = useState<'before' | 'after'>('before')
  const [slImporting, setSlImporting] = useState(false)
  const [slImportText, setSlImportText] = useState('')

  // Account switching state
  const [accounts, setAccounts] = useState<{ id: string; email: string; subscriptionType?: string; isDefault: boolean; createdAt: number }[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  const [switchWarningShown, setSwitchWarningShown] = useState(false)
  const [accountsLoading, setAccountsLoading] = useState(false)
  const [accountLoginLoading, setAccountLoginLoading] = useState(false)
  const [accountStatusMsg, setAccountStatusMsg] = useState('')

  // Get current platform for filtering shell options
  const platform = window.electronAPI?.platform || 'darwin'
  const platformShellOptions = SHELL_OPTIONS.filter(opt => opt.platforms.includes(platform))
  const isDebugMode = window.electronAPI?.debug?.isDebugMode === true
  const visibleAgentPresets = getVisiblePresets().filter(p => p.id !== 'none')
  const defaultAgentValue = visibleAgentPresets.some(p => p.id === settings.defaultAgent)
    ? settings.defaultAgent
    : 'claude-code'

  useEffect(() => {
    return settingsStore.subscribe(() => {
      setSettings(settingsStore.getSettings())
    })
  }, [])

  useEffect(() => {
    if (serverStatus.running) return
    setServerPort(String(settings.remoteServerPort || 9876))
    setBindInterface(settings.remoteServerBindInterface || 'localhost')
  }, [settings.remoteServerPort, settings.remoteServerBindInterface, serverStatus.running])

  useEffect(() => {
    if (!isDebugMode) return
    window.electronAPI.openai?.getApiKeyStatus().then(setOpenaiKeyStatus).catch(() => { /* ignore */ })
  }, [isDebugMode])

  const refreshCxStatus = useCallback(async () => {
    setCxDetecting(true)
    try {
      const status = await window.electronAPI.settings.detectCx()
      setCxStatus(status)
    } finally {
      setCxDetecting(false)
    }
  }, [])

  useEffect(() => {
    if (activeTab !== 'agent') return
    refreshCxStatus().catch(() => { /* ignore */ })
  }, [activeTab, settings.cxBinaryPath, settings.cxSemanticNavigationEnabled, refreshCxStatus])

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

  // Load accounts when account switching is enabled
  const loadAccounts = useCallback(async () => {
    if (settingsStore.getSettings().accountSwitching === false) return
    setAccountsLoading(true)
    try {
      const result = await window.electronAPI.claude.accountList()
      setAccounts(result.accounts)
      setActiveAccountId(result.activeAccountId)
      setSwitchWarningShown(result.switchWarningShown)
      if (result.accounts.length === 0) {
        const imported = await window.electronAPI.claude.accountImportCurrent()
        if (imported) {
          const refreshed = await window.electronAPI.claude.accountList()
          setAccounts(refreshed.accounts)
          setActiveAccountId(refreshed.activeAccountId)
          setSwitchWarningShown(refreshed.switchWarningShown)
        }
      }
    } catch (e) {
      window.electronAPI?.debug?.log?.(`[SettingsPanel] Failed to load accounts: ${e}`)
    }
    setAccountsLoading(false)
  }, [])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  const handleAccountSwitch = async (accountId: string) => {
    if (accountId === activeAccountId) return
    if (!switchWarningShown) {
      const confirmed = confirm(t('settings.accountSwitchingWarning'))
      if (!confirmed) return
      await window.electronAPI.claude.accountMarkWarningShown()
      setSwitchWarningShown(true)
    }
    const success = await window.electronAPI.claude.accountSwitch(accountId)
    if (success) {
      setActiveAccountId(accountId)
      window.dispatchEvent(new CustomEvent('claude-account-switched'))
    }
  }

  const handleAccountRemove = async (accountId: string) => {
    const account = accounts.find(a => a.id === accountId)
    if (!account) return
    const confirmed = confirm(t('settings.accountSwitchingRemoveConfirm', { email: account.email }))
    if (!confirmed) return
    const success = await window.electronAPI.claude.accountRemove(accountId)
    if (success) {
      await loadAccounts()
    }
  }

  const handleAccountLoginNew = async () => {
    setAccountLoginLoading(true)
    setAccountStatusMsg('Opening login in browser...')
    try {
      const result = await window.electronAPI.claude.accountLoginNew()
      if (result.success) {
        await loadAccounts()
        setAccountStatusMsg(result.account ? `Added ${result.account.email}` : 'Account added.')
      } else {
        setAccountStatusMsg(`Login failed: ${result.error || 'unknown error'}`)
      }
    } catch (e) {
      window.electronAPI?.debug?.log?.(`[SettingsPanel] Account login failed: ${e}`)
      setAccountStatusMsg(`Error: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
    setAccountLoginLoading(false)
  }

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

  // Resolve a usable host for the connection URL. boundHost is the literal
  // listen address — for `bind=all` that's `0.0.0.0`, which clients can't
  // connect to, so fall back to enumerating real interfaces.
  useEffect(() => {
    if (!serverStatus.running || !serverStatus.boundHost) {
      setConnectionUrlHost(null)
      return
    }
    const bh = serverStatus.boundHost
    if (bh !== '0.0.0.0' && bh !== '::') {
      setConnectionUrlHost(bh)
      return
    }
    let cancelled = false
    window.electronAPI.tunnel.getConnection().then(result => {
      if (cancelled) return
      if ('error' in result || !result.addresses?.length) {
        setConnectionUrlHost(bh)
        return
      }
      setConnectionUrlHost(result.addresses[0].ip)
    }).catch(() => { if (!cancelled) setConnectionUrlHost(bh) })
    return () => { cancelled = true }
  }, [serverStatus.running, serverStatus.boundHost, serverStatus.port])

  const connectionUrl = (() => {
    if (!serverStatus.running || !serverStatus.port || !serverStatus.fingerprint || !serverToken) return null
    const host = connectionUrlHost || serverStatus.boundHost
    if (!host) return null
    return buildConnectionUrl({ host, port: serverStatus.port, token: serverToken, fingerprint: serverStatus.fingerprint })
  })()

  const handleStartServer = async () => {
    const port = parseInt(serverPort) || 9876
    settingsStore.setRemoteServerPort(port)
    settingsStore.setRemoteServerBindInterface(bindInterface)
    const result = await window.electronAPI.remote.startServer({
      port,
      bindInterface,
    })
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

  const generateQrForIp = useCallback(async (ip: string, mode: string, token: string, fingerprint: string, port: number, context?: { windowId?: string | null }) => {
    const url = `wss://${ip}:${port}`
    const payload = JSON.stringify({ url, token, fingerprint, mode, context })
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
      setQrFingerprint(result.fingerprint)
      setQrContext(result.context)
      const port = parseInt(result.url.split(':').pop() || '9876')
      setQrPort(port)
      await generateQrForIp(result.addresses[0].ip, result.addresses[0].mode, result.token, result.fingerprint, port, result.context)
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

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: t('settings.tabGeneral') },
    { id: 'agent', label: t('settings.tabAgent') },
    { id: 'remote', label: t('settings.tabRemote') },
    { id: 'advanced', label: t('settings.tabAdvanced') },
  ]

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('settings.title')}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`settings-tab-btn${activeTab === tab.id ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="settings-content">

          {/* ── GENERAL TAB ── */}
          {activeTab === 'general' && (
            <>
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
                    <input type="checkbox" checked={settings.closeTerminalAfterProcessExit !== false} onChange={e => settingsStore.setCloseTerminalAfterProcessExit(e.target.checked)} />
                    {t('settings.closeTerminalAfterProcessExit')}
                  </label>
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
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </select>
                </div>
                {settings.colorPreset === 'custom' && (
                  <>
                    <div className="settings-group color-picker-group">
                      <label>{t('settings.backgroundColor')}</label>
                      <div className="color-input-wrapper">
                        <input type="color" value={settings.customBackgroundColor} onChange={e => handleCustomBackgroundColorChange(e.target.value)} />
                        <input type="text" value={settings.customBackgroundColor} onChange={e => handleCustomBackgroundColorChange(e.target.value)} placeholder="#1f1d1a" />
                      </div>
                    </div>
                    <div className="settings-group color-picker-group">
                      <label>{t('settings.textColor')}</label>
                      <div className="color-input-wrapper">
                        <input type="color" value={settings.customForegroundColor} onChange={e => handleCustomForegroundColorChange(e.target.value)} />
                        <input type="text" value={settings.customForegroundColor} onChange={e => handleCustomForegroundColorChange(e.target.value)} placeholder="#dfdbc3" />
                      </div>
                    </div>
                    <div className="settings-group color-picker-group">
                      <label>{t('settings.cursorColor')}</label>
                      <div className="color-input-wrapper">
                        <input type="color" value={settings.customCursorColor} onChange={e => handleCustomCursorColorChange(e.target.value)} />
                        <input type="text" value={settings.customCursorColor} onChange={e => handleCustomCursorColorChange(e.target.value)} placeholder="#dfdbc3" />
                      </div>
                    </div>
                  </>
                )}
                <div className="settings-group font-preview">
                  <label>{t('common.preview')}</label>
                  <div
                    className="font-preview-box"
                    style={{ fontFamily: settingsStore.getFontFamilyString(), fontSize: settings.fontSize, backgroundColor: terminalColors.background, color: terminalColors.foreground }}
                  >
                    $ echo "Hello World" 你好世界 0123456789
                  </div>
                </div>
              </div>

              <div className="settings-section">
                <h3>{t('settings.notifications')}</h3>
                <div className="settings-group checkbox-group">
                  <label>
                    <input type="checkbox" checked={settings.showDockBadge !== false} onChange={e => settingsStore.setShowDockBadge(e.target.checked)} />
                    {t('settings.showDockBadge')}
                  </label>
                  <p className="settings-hint">{t('settings.showDockBadgeHint')}</p>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input type="checkbox" checked={settings.notifyOnComplete !== false} onChange={e => settingsStore.setNotifyOnComplete(e.target.checked)} />
                    {t('settings.notifyOnComplete')}
                  </label>
                  <p className="settings-hint">{t('settings.notifyOnCompleteHint')}</p>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input type="checkbox" checked={settings.notifySound !== false} onChange={e => settingsStore.setNotifySound(e.target.checked)} />
                    {t('settings.notifySound')}
                  </label>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input type="checkbox" checked={settings.notifyOnlyBackground !== false} onChange={e => settingsStore.setNotifyOnlyBackground(e.target.checked)} />
                    {t('settings.notifyOnlyBackground')}
                  </label>
                  <p className="settings-hint">{t('settings.notifyOnlyBackgroundHint')}</p>
                </div>
              </div>
            </>
          )}

          {/* ── AGENT TAB ── */}
          {activeTab === 'agent' && (
            <>
              <div className="settings-section">
                <h3>{t('settings.agentDefaults')}</h3>
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
                        value={defaultAgentValue}
                        onChange={e => settingsStore.setDefaultAgent(e.target.value as AgentPresetId)}
                      >
                        {visibleAgentPresets.map(preset => (
                          <option key={preset.id} value={preset.id}>{preset.icon} {preset.name}</option>
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
              </div>

              {isDebugMode && (
                <div className="settings-section">
                  <h3>OpenAI (Direct) API Key</h3>
                  <p className="settings-hint">Stored locally, encrypted with OS keychain via Electron safeStorage. Used by the "OpenAI (Direct)" agent preset.</p>
                  <div className="settings-group">
                    <label>Status: {openaiKeyStatus.hasKey ? '✅ key configured' : '❌ no key'}</label>
                    <input
                      type="password"
                      value={openaiKeyInput}
                      onChange={e => setOpenaiKeyInput(e.target.value)}
                      placeholder="sk-..."
                      autoComplete="off"
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button
                        className="settings-btn"
                        disabled={!openaiKeyInput.trim() || openaiKeySaving}
                        onClick={async () => {
                          setOpenaiKeySaving(true)
                          try {
                            await window.electronAPI.openai.setApiKey(openaiKeyInput.trim())
                            setOpenaiKeyInput('')
                            const s = await window.electronAPI.openai.getApiKeyStatus()
                            setOpenaiKeyStatus(s)
                          } finally {
                            setOpenaiKeySaving(false)
                          }
                        }}
                      >
                        {openaiKeySaving ? 'Saving…' : 'Save Key'}
                      </button>
                      {openaiKeyStatus.hasKey && (
                        <button
                          className="settings-btn settings-btn-danger"
                          onClick={async () => {
                            if (!confirm('Clear saved OpenAI API key?')) return
                            await window.electronAPI.openai.clearApiKey()
                            const s = await window.electronAPI.openai.getApiKeyStatus()
                            setOpenaiKeyStatus(s)
                          }}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="settings-section">
                <h3>{t('settings.modelAndEffort')}</h3>
                <div className="settings-group">
                  <label>{t('settings.defaultClaudeModel')}</label>
                  <select
                    value={settings.defaultClaudeModelCustom ? CUSTOM_MODEL_OPTION : settings.defaultClaudeModel || ''}
                    onChange={e => {
                      const value = e.target.value
                      const custom = value === CUSTOM_MODEL_OPTION
                      settingsStore.setDefaultClaudeModel(custom ? settings.defaultClaudeModel || '' : value, custom)
                    }}
                  >
                    <option value="">{t('settings.agentModelDefault')}</option>
                    {CLAUDE_BUILTIN_MODELS.map(model => (
                      <option key={model.value} value={model.value}>
                        {model.displayName}
                      </option>
                    ))}
                    <option value={CUSTOM_MODEL_OPTION}>{t('settings.customModel')}</option>
                  </select>
                  {settings.defaultClaudeModelCustom && (
                    <input
                      type="text"
                      value={settings.defaultClaudeModel || ''}
                      onChange={e => settingsStore.setDefaultClaudeModel(e.target.value, true)}
                      placeholder={t('settings.customModelPlaceholder')}
                    />
                  )}
                  <p className="settings-hint">{t('settings.defaultClaudeModelHint')}</p>
                </div>
                <div className="settings-group">
                  <label>{t('settings.defaultClaudeEffort')}</label>
                  <select
                    value={settings.defaultEffort || 'high'}
                    onChange={e => settingsStore.setDefaultEffort(e.target.value as EffortLevel)}
                  >
                    {EFFORT_LEVELS.map(level => (
                      <option key={level} value={level}>
                        {level.charAt(0).toUpperCase() + level.slice(1)}{level === 'max' ? ' (Opus only)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="settings-hint">{t('settings.defaultClaudeEffortHint')}</p>
                </div>
                <div className="settings-group">
                  <label>{t('settings.defaultCodexModel')}</label>
                  <select
                    value={settings.defaultCodexModelCustom ? CUSTOM_MODEL_OPTION : settings.defaultCodexModel || ''}
                    onChange={e => {
                      const value = e.target.value
                      const custom = value === CUSTOM_MODEL_OPTION
                      settingsStore.setDefaultCodexModel(custom ? settings.defaultCodexModel || '' : value, custom)
                    }}
                  >
                    <option value="">{t('settings.agentModelDefault')}</option>
                    {CODEX_MODELS.map(model => (
                      <option key={model.value} value={model.value}>
                        {model.displayName}
                      </option>
                    ))}
                    <option value={CUSTOM_MODEL_OPTION}>{t('settings.customModel')}</option>
                  </select>
                  {settings.defaultCodexModelCustom && (
                    <input
                      type="text"
                      value={settings.defaultCodexModel || ''}
                      onChange={e => settingsStore.setDefaultCodexModel(e.target.value, true)}
                      placeholder={t('settings.customModelPlaceholder')}
                    />
                  )}
                  <p className="settings-hint">{t('settings.defaultCodexModelHint')}</p>
                </div>
                <div className="settings-group">
                  <label>{t('settings.defaultCodexEffort')}</label>
                  <select
                    value={settings.defaultCodexEffort || 'high'}
                    onChange={e => settingsStore.setDefaultCodexEffort(e.target.value as CodexEffortLevel)}
                  >
                    {CODEX_EFFORT_LEVELS.map(level => (
                      <option key={level} value={level}>
                        {level.charAt(0).toUpperCase() + level.slice(1)}
                      </option>
                    ))}
                  </select>
                  <p className="settings-hint">{t('settings.defaultCodexEffortHint')}</p>
                </div>
              </div>

              <div className="settings-section">
                <h3>{t('settings.agentBehavior')}</h3>
                <div className="settings-group checkbox-group">
                  <label>
                    <input type="checkbox" checked={settings.allowBypassPermissions === true} onChange={e => settingsStore.setAllowBypassPermissions(e.target.checked)} />
                    {t('settings.allowBypassPermissions')}
                  </label>
                  <p className="settings-hint">{t('settings.allowBypassPermissionsHint')}</p>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input type="checkbox" checked={settings.collapseToolOutputs === true} onChange={e => settingsStore.setCollapseToolOutputs(e.target.checked)} />
                    {t('settings.collapseToolOutputs')}
                  </label>
                  <p className="settings-hint">{t('settings.collapseToolOutputsHint')}</p>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input type="checkbox" checked={settings.cacheExpiryWarning === true} onChange={e => settingsStore.setCacheExpiryWarning(e.target.checked)} />
                    {t('settings.cacheExpiryWarning')}
                  </label>
                  <p className="settings-hint">{t('settings.cacheExpiryWarningHint')}</p>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input type="checkbox" checked={settings.cacheAlarmTimer === true} onChange={e => settingsStore.setCacheAlarmTimer(e.target.checked)} />
                    {t('settings.cacheAlarmTimer')}
                  </label>
                  <p className="settings-hint">{t('settings.cacheAlarmTimerHint')}</p>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.worktreePnpmInstallEnabled === true}
                      onChange={e => settingsStore.setWorktreePnpmInstallEnabled(e.target.checked)}
                    />
                    {t('settings.worktreePnpmInstall')}
                  </label>
                  <p className="settings-hint">{t('settings.worktreePnpmInstallHint')}</p>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!settings.autoCompactWindow}
                      onChange={e => settingsStore.setAutoCompactWindow(e.target.checked ? 400000 : undefined)}
                    />
                    {t('settings.autoCompactWindow')}
                  </label>
                  {!!settings.autoCompactWindow && (
                    <input
                      type="number"
                      value={settings.autoCompactWindow}
                      onChange={e => {
                        const val = parseInt(e.target.value, 10)
                        settingsStore.setAutoCompactWindow(val >= 200000 ? val : 200000)
                      }}
                      placeholder="400000"
                      min={200000}
                      step={10000}
                      style={{ marginTop: 4, width: 140 }}
                    />
                  )}
                  <p className="settings-hint">{t('settings.autoCompactWindowHint')}</p>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!settings.perTerminalHistory}
                      onChange={e => {
                        if (e.target.checked) {
                          if (confirm(t('settings.perTerminalHistorySecurityWarning'))) {
                            settingsStore.setPerTerminalHistory(true)
                          }
                        } else {
                          settingsStore.setPerTerminalHistory(false)
                        }
                      }}
                    />
                    {t('settings.perTerminalHistory')}
                  </label>
                  <p className="settings-hint">{t('settings.perTerminalHistoryHint')}</p>
                  <button
                    className="settings-btn settings-btn-danger"
                    style={{ marginTop: 6 }}
                    onClick={async () => {
                      if (confirm(t('settings.clearTerminalHistoryConfirm'))) {
                        await window.electronAPI.settings.clearTerminalHistory()
                        alert(t('settings.clearTerminalHistoryDone'))
                      }
                    }}
                  >
                    {t('settings.clearTerminalHistory')}
                  </button>
                </div>
                <div className="settings-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.cxSemanticNavigationEnabled === true}
                      onChange={e => {
                        settingsStore.setCxSemanticNavigationEnabled(e.target.checked)
                        window.setTimeout(() => refreshCxStatus().catch(() => { /* ignore */ }), 150)
                      }}
                    />
                    {t('settings.cxSemanticNavigation')}
                  </label>
                  <p className="settings-hint">{t('settings.cxSemanticNavigationHint')}</p>
                  <input
                    type="text"
                    value={settings.cxBinaryPath || ''}
                    onChange={e => settingsStore.setCxBinaryPath(e.target.value)}
                    onBlur={() => refreshCxStatus().catch(() => { /* ignore */ })}
                    placeholder={t('settings.cxBinaryPathPlaceholder')}
                    style={{ marginTop: 6 }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: cxStatus?.detected ? '#3fb950' : '#f85149' }}>
                      {cxDetecting
                        ? t('settings.cxDetecting')
                        : cxStatus?.detected
                          ? t('settings.cxDetected', { version: cxStatus.version || 'cx', path: cxStatus.path || 'cx' })
                          : t('settings.cxNotDetected', { error: cxStatus?.error || 'cx not found' })}
                    </span>
                    <button className="settings-btn" onClick={() => refreshCxStatus().catch(() => { /* ignore */ })}>
                      {t('settings.cxDetect')}
                    </button>
                  </div>
                  {cxStatus?.detected && (
                    <p className="settings-hint">
                      {t('settings.cxCacheDir', { path: cxStatus.cacheDir })}
                    </p>
                  )}
                  {!cxStatus?.detected && (() => {
                    const cxAgentPrompt = `Please install the cx semantic code navigation CLI on this machine.

1. Detect the OS and run the matching installer:
   - macOS:   brew tap ind-igo/cx && brew install cx
   - Linux:   curl -sL https://raw.githubusercontent.com/ind-igo/cx/master/install.sh | sh
   - Windows: irm https://raw.githubusercontent.com/ind-igo/cx/master/install.ps1 | iex
   - or:      cargo install cx-cli  (works on any platform with Rust)

2. Run \`cx --version\` to confirm the install and report the binary path.

3. Suggest a few common languages to add: \`cx lang add typescript python rust go\`

4. Tell me the absolute path to the cx binary so I can paste it into BAT's
   Settings → Agents → cx semantic navigation → "cx or /path/to/cx" field.

Reference: https://github.com/ind-igo/cx`
                    return (
                      <div style={{ marginTop: 10, padding: 10, background: 'rgba(255,255,255,0.03)', borderRadius: 4, border: '1px solid rgba(255,255,255,0.08)' }}>
                        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
                          {t('settings.cxInstallAgentHint')}{' '}
                          <a href="https://github.com/ind-igo/cx" style={{ color: '#58a6ff' }}
                            onClick={e => { e.preventDefault(); window.electronAPI?.openExternal?.('https://github.com/ind-igo/cx') }}>
                            github.com/ind-igo/cx
                          </a>
                        </p>
                        <button
                          onClick={() => navigator.clipboard.writeText(cxAgentPrompt)}
                          className="settings-btn"
                          style={{ marginTop: 8 }}
                          title={t('settings.cxInstallCopyPrompt')}
                        >
                          {t('settings.cxInstallCopyPrompt')}
                        </button>
                      </div>
                    )
                  })()}
                </div>
              </div>
            </>
          )}

          {/* ── REMOTE TAB ── */}
          {activeTab === 'remote' && (
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

              <div className="settings-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.remoteServerAutoStart === true}
                    onChange={e => settingsStore.setRemoteServerAutoStart(e.target.checked)}
                  />
                  {t('settings.remoteServerAutoStart')}
                </label>
                <p className="settings-hint">{t('settings.remoteServerAutoStartHint')}</p>
              </div>

              {serverStatus.running ? (
                <>
                  <div className="settings-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#3fb950', fontSize: 12 }}>
                      {t('settings.serverRunningOnPort', { port: serverStatus.port })}
                      {serverStatus.bindInterface && ` [${serverStatus.bindInterface}]`}
                    </span>
                    <button className="profile-action-btn danger" onClick={handleStopServer} style={{ marginLeft: 'auto' }}>
                      {t('settings.stopServer')}
                    </button>
                  </div>
                  {connectionUrl && (
                    <div className="settings-group">
                      <label>{t('settings.connectionUrl', 'Connection URL')}</label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="text" readOnly value={connectionUrl} style={{ fontFamily: 'monospace', fontSize: 11, flex: 1 }} onClick={e => (e.target as HTMLInputElement).select()} />
                        <button className="profile-action-btn" onClick={() => navigator.clipboard.writeText(connectionUrl)} title="Copy connection URL">{t('common.copy')}</button>
                      </div>
                      <p style={{ fontSize: 11, color: '#8b949e', marginTop: 4, lineHeight: 1.4 }}>
                        {t('settings.connectionUrlHint', 'Paste this into a remote profile to auto-fill host, port, token and fingerprint.')}
                      </p>
                    </div>
                  )}
                  {serverToken && (
                    <div className="settings-group">
                      <label>{t('settings.connectionToken')}</label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="text" readOnly value={serverToken} style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }} onClick={e => (e.target as HTMLInputElement).select()} />
                        <button className="profile-action-btn" onClick={() => navigator.clipboard.writeText(serverToken)} title="Copy token">{t('common.copy')}</button>
                      </div>
                    </div>
                  )}
                  {serverStatus.fingerprint && (
                    <div className="settings-group">
                      <label>{t('settings.certFingerprint', 'Certificate fingerprint (SHA-256)')}</label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="text" readOnly value={serverStatus.fingerprint} style={{ fontFamily: 'monospace', fontSize: 11, flex: 1 }} onClick={e => (e.target as HTMLInputElement).select()} />
                        <button className="profile-action-btn" onClick={() => navigator.clipboard.writeText(serverStatus.fingerprint || '')} title="Copy fingerprint">{t('common.copy')}</button>
                      </div>
                      <p style={{ fontSize: 11, color: '#8b949e', marginTop: 4, lineHeight: 1.4 }}>
                        {t('settings.certFingerprintHint', 'Clients must pin this fingerprint on first connect (TOFU).')}
                      </p>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      type="number"
                      value={serverPort}
                      onChange={e => {
                        setServerPort(e.target.value)
                        const port = parseInt(e.target.value)
                        if (Number.isFinite(port) && port > 0) settingsStore.setRemoteServerPort(port)
                      }}
                      placeholder={t('settings.port')}
                      style={{ width: 80 }}
                    />
                    <select
                      value={bindInterface}
                      onChange={e => {
                        const value = e.target.value as BindInterface
                        setBindInterface(value)
                        settingsStore.setRemoteServerBindInterface(value)
                      }}
                      style={{ fontSize: 12 }}
                      title={t('settings.bindInterfaceHint', 'Network interface to listen on')}
                    >
                      <option value="localhost">{t('settings.bindLocalhost', 'localhost (this machine only)')}</option>
                      <option value="tailscale">{t('settings.bindTailscale', 'Tailscale (tailnet only)')}</option>
                      <option value="all">{t('settings.bindAll', 'All interfaces (LAN / public)')}</option>
                    </select>
                    <button className="profile-action-btn primary" onClick={handleStartServer}>{t('settings.startServer')}</button>
                  </div>
                  <p style={{ fontSize: 11, color: '#d29922', marginTop: 6, lineHeight: 1.4 }}>{t('settings.serverWarning')}</p>
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
                  <a href="https://tailscale.com/" style={{ color: '#58a6ff' }} onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) || window.open(e.currentTarget.href) }}>Tailscale</a>{' '}
                  {t('settings.mobileConnectSeeReadme')}{' '}
                  <a href="https://github.com/tony1223/better-agent-terminal#remote-access--mobile-connect" style={{ color: '#58a6ff' }} onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) || window.open(e.currentTarget.href) }}>{t('settings.remoteAccessReadme')}</a>。
                </p>
                {!qrDataUrl ? (
                  <>
                    <button className="profile-action-btn primary" onClick={handleGenerateQR} disabled={qrLoading} style={{ marginTop: 4 }}>
                      {qrLoading ? t('settings.generating') : t('settings.generateQrCode')}
                    </button>
                    <p style={{ fontSize: 11, color: '#d29922', marginTop: 6, lineHeight: 1.4 }}>{t('settings.qrWarning')}</p>
                    {qrError && <p style={{ fontSize: 11, color: '#f85149', marginTop: 4 }}>{qrError}</p>}
                  </>
                ) : (
                  <div style={{ textAlign: 'center', marginTop: 8 }}>
                    {qrAddresses.length > 1 && (
                      <select
                        style={{ width: '100%', marginBottom: 8, fontSize: 12, padding: '4px 6px' }}
                        value={qrInfo?.url?.split('//')[1]?.split(':')[0] || ''}
                        onChange={async (e) => {
                          const addr = qrAddresses.find(a => a.ip === e.target.value)
                          if (addr && qrToken && qrFingerprint) await generateQrForIp(addr.ip, addr.mode, qrToken, qrFingerprint, qrPort, qrContext)
                        }}
                      >
                        {qrAddresses.map(addr => <option key={addr.ip} value={addr.ip}>{addr.label}</option>)}
                      </select>
                    )}
                    <img src={qrDataUrl} alt="QR Code" style={{ width: 200, height: 200, imageRendering: 'pixelated', borderRadius: 4, background: '#fff', padding: 4 }} />
                    <p style={{ fontSize: 11, color: '#8b949e', marginTop: 6, wordBreak: 'break-all', fontFamily: 'monospace' }}>{qrInfo?.url}</p>
                    <p style={{ fontSize: 11, color: qrInfo?.mode === 'tailscale' ? '#3fb950' : '#d29922', marginTop: 2 }}>
                      {qrInfo?.mode === 'tailscale' ? t('settings.viaTailscale') : t('settings.lanOnly')}
                    </p>
                    <button className="profile-action-btn" onClick={() => { setQrDataUrl(null); setQrInfo(null); setQrAddresses([]) }} style={{ marginTop: 8 }}>{t('common.close')}</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── ADVANCED TAB ── */}
          {activeTab === 'advanced' && (
            <>
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
                <h3>{t('settings.accountSwitching')}</h3>
                <p className="settings-hint" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  {t('settings.accountSwitchingHint')}
                </p>
                <label className="settings-checkbox" style={{ marginBottom: '10px' }}>
                  <input type="checkbox" checked={settings.accountSwitching !== false} onChange={(e) => settingsStore.setAccountSwitching(e.target.checked)} />
                  {t('settings.accountSwitchingEnabled')}
                </label>
                {settings.accountSwitching !== false && (
                  <div style={{ marginTop: '8px' }}>
                    {accountsLoading ? (
                      <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('settings.accountSwitchingImporting')}</p>
                    ) : accounts.length === 0 ? (
                      <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('settings.accountSwitchingNoAccounts')}</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {accounts.map(account => (
                          <div key={account.id} style={{
                            display: 'flex', alignItems: 'center', gap: '8px',
                            padding: '6px 10px', borderRadius: '4px',
                            background: account.id === activeAccountId ? 'var(--bg-tertiary)' : 'transparent',
                            border: account.id === activeAccountId ? '1px solid var(--border-color)' : '1px solid transparent',
                          }}>
                            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: account.id === activeAccountId ? '#3fb950' : 'var(--text-secondary)', flexShrink: 0 }} />
                            <span style={{ fontSize: '13px', flex: 1 }}>
                              {account.email}
                              {account.subscriptionType && <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginLeft: '6px' }}>({account.subscriptionType})</span>}
                            </span>
                            {account.id === activeAccountId ? (
                              <span style={{ fontSize: '11px', color: '#3fb950', fontWeight: 500 }}>{t('settings.accountSwitchingActive')}</span>
                            ) : (
                              <>
                                <button className="statusline-template-btn" style={{ fontSize: '11px' }} onClick={() => handleAccountSwitch(account.id)}>{t('settings.accountSwitchingSwitch')}</button>
                                {!account.isDefault && (
                                  <button className="statusline-template-btn" style={{ fontSize: '11px', color: '#f85149' }} onClick={() => handleAccountRemove(account.id)}>{t('settings.accountSwitchingRemove')}</button>
                                )}
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <button className="statusline-template-btn" style={{ marginTop: '10px', fontSize: '12px' }} onClick={handleAccountLoginNew} disabled={accountLoginLoading}>
                      {accountLoginLoading ? 'Opening login...' : t('settings.accountSwitchingAddAccount')}
                    </button>
                    {accountStatusMsg && (
                      <p style={{ fontSize: '11px', color: accountStatusMsg.startsWith('Error') || accountStatusMsg.startsWith('Login failed') ? '#f85149' : 'var(--text-secondary)', marginTop: '6px' }}>
                        {accountStatusMsg}
                      </p>
                    )}
                  </div>
                )}
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
            </>
          )}

        </div>

        <div className="settings-footer">
          <p className="settings-note">{t('settings.footerNote')}</p>
        </div>
      </div>
    </div>
  )
}
