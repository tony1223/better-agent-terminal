import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface ProfileEntry {
  id: string
  name: string
  type: 'local' | 'remote'
  remoteHost?: string
  remotePort?: number
  remoteToken?: string
  createdAt: number
  updatedAt: number
}

interface ProfilePanelProps {
  onClose: () => void
  onSwitch: (profileId: string) => void
  onSwitchNewWindow: (profileId: string) => void
}

export function ProfilePanel({ onClose, onSwitch, onSwitchNewWindow }: ProfilePanelProps) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<ProfileEntry[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string>('default')
  const [creating, setCreating] = useState<'local' | 'remote' | false>(false)
  const [newName, setNewName] = useState('')
  const [remoteHost, setRemoteHost] = useState('')
  const [remotePort, setRemotePort] = useState('9876')
  const [remoteToken, setRemoteToken] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editingRemoteId, setEditingRemoteId] = useState<string | null>(null)
  const [editRemoteHost, setEditRemoteHost] = useState('')
  const [editRemotePort, setEditRemotePort] = useState('')
  const [editRemoteToken, setEditRemoteToken] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, 'ok' | 'fail' | 'testing'>>({})
  const createInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  const loadProfiles = useCallback(async () => {
    const result = await window.electronAPI.profile.list()
    setProfiles(result.profiles)
    setActiveProfileId(result.activeProfileId)
  }, [])

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  useEffect(() => {
    if (creating && createInputRef.current) {
      createInputRef.current.focus()
    }
  }, [creating])

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (creating) { setCreating(false); setNewName('') }
        else if (editingId) { setEditingId(null); setEditValue('') }
        else if (editingRemoteId) { setEditingRemoteId(null) }
        else if (confirmDelete) { setConfirmDelete(null) }
        else if (confirmSwitch) { setConfirmSwitch(null) }
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [creating, editingId, confirmDelete, confirmSwitch, onClose])

  const handleCreate = async () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    if (creating === 'remote') {
      if (!remoteHost.trim() || !remoteToken.trim()) return
      await window.electronAPI.profile.create(trimmed, {
        type: 'remote',
        remoteHost: remoteHost.trim(),
        remotePort: parseInt(remotePort) || 9876,
        remoteToken: remoteToken.trim(),
      })
    } else {
      await window.electronAPI.profile.create(trimmed)
    }
    setCreating(false)
    setNewName('')
    setRemoteHost('')
    setRemotePort('9876')
    setRemoteToken('')
    loadProfiles()
  }

  const handleRename = async (profileId: string) => {
    const trimmed = editValue.trim()
    if (!trimmed) { setEditingId(null); return }
    await window.electronAPI.profile.rename(profileId, trimmed)
    setEditingId(null)
    setEditValue('')
    loadProfiles()
  }

  const handleStartEditRemote = (profile: ProfileEntry) => {
    setEditingRemoteId(profile.id)
    setEditRemoteHost(profile.remoteHost || '')
    setEditRemotePort(String(profile.remotePort || 9876))
    setEditRemoteToken(profile.remoteToken || '')
  }

  const handleSaveRemote = async (profileId: string) => {
    const host = editRemoteHost.trim()
    const token = editRemoteToken.trim()
    if (!host || !token) return
    await window.electronAPI.profile.update(profileId, {
      remoteHost: host,
      remotePort: parseInt(editRemotePort) || 9876,
      remoteToken: token,
    })
    setEditingRemoteId(null)
    loadProfiles()
  }

  const handleDelete = async (profileId: string) => {
    await window.electronAPI.profile.delete(profileId)
    setConfirmDelete(null)
    loadProfiles()
  }

  const handleDuplicate = async (profileId: string) => {
    const source = profiles.find(p => p.id === profileId)
    if (!source) return
    await window.electronAPI.profile.duplicate(profileId, `${source.name} (Copy)`)
    loadProfiles()
  }

  const handleTestConnection = useCallback(async (profile: ProfileEntry) => {
    if (!profile.remoteHost || !profile.remoteToken) return
    setTestingId(profile.id)
    setTestResult(prev => ({ ...prev, [profile.id]: 'testing' }))
    try {
      const result = await window.electronAPI.remote.testConnection(
        profile.remoteHost,
        profile.remotePort || 9876,
        profile.remoteToken
      )
      setTestResult(prev => ({ ...prev, [profile.id]: result.ok ? 'ok' : 'fail' }))
    } catch {
      setTestResult(prev => ({ ...prev, [profile.id]: 'fail' }))
    } finally {
      setTestingId(null)
    }
  }, [])

  const handleSaveCurrent = async () => {
    await window.electronAPI.profile.save(activeProfileId)
    loadProfiles()
  }

  const handleSwitchRequest = (profileId: string) => {
    if (profileId === activeProfileId) return
    setConfirmSwitch(profileId)
  }

  const handleSwitchConfirm = async (saveFirst: boolean, newWindow = false) => {
    if (!confirmSwitch) return
    if (saveFirst) {
      await window.electronAPI.profile.save(activeProfileId)
    }
    setConfirmSwitch(null)
    if (newWindow) {
      onSwitchNewWindow(confirmSwitch)
    } else {
      onSwitch(confirmSwitch)
    }
  }

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleString()
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="settings-header">
          <h2>{t('profiles.title')}</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-body" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button className="profile-action-btn" onClick={handleSaveCurrent} title={t('profiles.saveCurrent')}>
              {t('profiles.saveCurrent')}
            </button>
            <button className="profile-action-btn" onClick={() => { setCreating('local'); setNewName('') }}>
              {t('profiles.addLocal')}
            </button>
            <button className="profile-action-btn" onClick={() => { setCreating('remote'); setNewName('') }}>
              {t('profiles.addRemote')}
            </button>
          </div>

          {creating && (
            <div className="profile-create-row" style={{ flexDirection: 'column', gap: 8 }}>
              <input
                ref={createInputRef}
                type="text"
                className="profile-name-input"
                placeholder={t('profiles.profileNamePlaceholder')}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && creating === 'local') handleCreate()
                  if (e.key === 'Escape') { setCreating(false); setNewName('') }
                }}
              />
              {creating === 'remote' && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="profile-name-input"
                    placeholder={t('profiles.hostPlaceholder')}
                    value={remoteHost}
                    onChange={e => setRemoteHost(e.target.value)}
                    style={{ flex: '1 1 120px' }}
                  />
                  <input
                    type="number"
                    className="profile-name-input"
                    placeholder={t('profiles.portPlaceholder')}
                    value={remotePort}
                    onChange={e => setRemotePort(e.target.value)}
                    style={{ width: 70 }}
                  />
                  <input
                    type="text"
                    className="profile-name-input"
                    placeholder={t('profiles.tokenPlaceholder')}
                    value={remoteToken}
                    onChange={e => setRemoteToken(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
                    style={{ flex: '1 1 160px' }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="profile-action-btn" onClick={handleCreate}>{t('common.create')}</button>
                <button className="profile-action-btn" onClick={() => { setCreating(false); setNewName('') }}>{t('common.cancel')}</button>
              </div>
            </div>
          )}

          <div className="profile-list">
            {profiles.map(profile => (
              <div
                key={profile.id}
                className={`profile-item ${profile.id === activeProfileId ? 'active' : ''}`}
                onClick={() => handleSwitchRequest(profile.id)}
              >
                <div className="profile-item-info">
                  {editingId === profile.id ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      className="profile-name-input"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onBlur={() => handleRename(profile.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename(profile.id)
                        if (e.key === 'Escape') { setEditingId(null); setEditValue('') }
                      }}
                      onClick={e => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      <span className="profile-item-name">
                        {profile.id === activeProfileId && <span className="profile-active-dot" />}
                        {profile.name}
                        {(profile.type === 'remote') && (
                          <span style={{ fontSize: 10, color: '#58a6ff', marginLeft: 6, opacity: 0.8 }}>{t('profiles.remote')}</span>
                        )}
                      </span>
                      <span className="profile-item-meta">
                        {profile.type === 'remote'
                          ? `${profile.remoteHost}:${profile.remotePort}`
                          : t('profiles.updated', { date: formatDate(profile.updatedAt) })}
                      </span>
                    </>
                  )}
                </div>
                {/* Remote connection edit form */}
                {editingRemoteId === profile.id && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, width: '100%' }} onClick={e => e.stopPropagation()}>
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.host')}
                      value={editRemoteHost}
                      onChange={e => setEditRemoteHost(e.target.value)}
                      style={{ flex: '1 1 120px' }}
                    />
                    <input
                      type="number"
                      className="profile-name-input"
                      placeholder={t('profiles.portPlaceholder')}
                      value={editRemotePort}
                      onChange={e => setEditRemotePort(e.target.value)}
                      style={{ width: 70 }}
                    />
                    <input
                      type="text"
                      className="profile-name-input"
                      placeholder={t('profiles.tokenPlaceholder')}
                      value={editRemoteToken}
                      onChange={e => setEditRemoteToken(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveRemote(profile.id) }}
                      style={{ flex: '1 1 160px' }}
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="profile-action-btn" onClick={() => handleSaveRemote(profile.id)}>{t('common.save')}</button>
                      <button className="profile-action-btn" onClick={() => setEditingRemoteId(null)}>{t('common.cancel')}</button>
                    </div>
                  </div>
                )}
                <div className="profile-item-actions" onClick={e => e.stopPropagation()}>
                  {profile.type === 'remote' && (
                    <button
                      className={`profile-icon-btn ${testResult[profile.id] === 'ok' ? 'success' : testResult[profile.id] === 'fail' ? 'danger' : ''}`}
                      title={testResult[profile.id] === 'ok' ? t('profiles.connected') : testResult[profile.id] === 'fail' ? t('profiles.connectionFailed') : t('profiles.testConnection')}
                      onClick={() => handleTestConnection(profile)}
                      disabled={testingId === profile.id}
                    >
                      {testingId === profile.id ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spin">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                          {testResult[profile.id] === 'ok' && <polyline points="22 4 12 14.01 9 11.01" />}
                          {testResult[profile.id] === 'fail' && <><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>}
                        </svg>
                      )}
                    </button>
                  )}
                  {profile.type === 'remote' && (
                    <button
                      className="profile-icon-btn"
                      title={t('profiles.editConnection')}
                      onClick={() => handleStartEditRemote(profile)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </button>
                  )}
                  <button
                    className="profile-icon-btn"
                    title={t('profiles.rename')}
                    onClick={() => { setEditingId(profile.id); setEditValue(profile.name) }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="profile-icon-btn"
                    title={t('profiles.duplicate')}
                    onClick={() => handleDuplicate(profile.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  {profile.id !== 'default' && (
                    <button
                      className="profile-icon-btn danger"
                      title={t('common.delete')}
                      onClick={() => setConfirmDelete(profile.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <div className="settings-overlay" style={{ zIndex: 1001 }} onClick={() => setConfirmDelete(null)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 360, padding: 20 }}>
            <h3 style={{ margin: '0 0 12px', color: '#e5534b' }}>{t('profiles.deleteProfile')}</h3>
            <p style={{ margin: '0 0 16px', color: '#aaa' }}>
              {t('profiles.deleteConfirm', { name: profiles.find(p => p.id === confirmDelete)?.name })}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="profile-action-btn" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</button>
              <button className="profile-action-btn danger" onClick={() => handleDelete(confirmDelete)}>{t('common.delete')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm switch dialog */}
      {confirmSwitch && (
        <div className="settings-overlay" style={{ zIndex: 1001 }} onClick={() => setConfirmSwitch(null)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 480, padding: 20 }}>
            <h3 style={{ margin: '0 0 12px' }}>{t('profiles.switchProfile')}</h3>
            <p style={{ margin: '0 0 16px', color: '#aaa' }}>
              {t('profiles.switchConfirm')}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="profile-action-btn" onClick={() => setConfirmSwitch(null)}>{t('common.cancel')}</button>
              <button className="profile-action-btn" onClick={() => handleSwitchConfirm(false)}>{t('profiles.switchHere')}</button>
              <button className="profile-action-btn" onClick={() => handleSwitchConfirm(true)}>{t('profiles.saveAndSwitchHere')}</button>
              <button className="profile-action-btn primary" onClick={() => handleSwitchConfirm(false, true)}>{t('profiles.newWindow')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
