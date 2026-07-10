import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { host } from '../host-api'

type LoginKind = 'claude' | 'codex'

interface RemoteLoginDialogProps {
  kind: LoginKind
  hostLabel?: string
  onClose: () => void
  onSuccess: () => void
}

type Phase = 'starting' | 'awaiting-code' | 'awaiting-approval' | 'submitting' | 'error'

// Sign-in flows against a remote host. Both run the agent CLI on the host and
// surface its sign-in URL so a remote client can authenticate the host without
// a browser there.
//
// - claude: `claude auth login` prints a URL + "paste code" prompt; the user
//   signs in, copies the code the callback page shows, and pastes it back here.
//   See node-sidecar/src/handlers/claude-auth-login.mjs.
// - codex: the host app-server returns a structured URL + one-time code and
//   notifies completion after browser approval. No paste-back is required. See
//   codex_app_server::account_login_device_start / _poll.
export function RemoteLoginDialog({ kind, hostLabel, onClose, onSuccess }: Readonly<RemoteLoginDialogProps>) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('starting')
  const [url, setUrl] = useState<string>('')
  const [deviceCode, setDeviceCode] = useState<string>('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'url' | 'code' | null>(null)
  const startedRef = useRef(false)
  const stoppedRef = useRef(false)
  const completedRef = useRef(false)
  const ownsLoginRef = useRef(false)
  const cancelSentRef = useRef(false)
  const loginIdRef = useRef<string>('')
  const pollTimerRef = useRef<number | null>(null)

  const label = kind === 'codex' ? 'Codex' : 'Claude'
  const displayHost = hostLabel || t('workspace.remoteHostFallback')
  const loginErrorText = (value: string | undefined, fallbackKey: string): string => {
    if (value === 'auth_in_progress') return t('workspace.remoteLoginInProgress')
    return value || t(fallbackKey)
  }

  const cancelRemoteLogin = useCallback(() => {
    if (cancelSentRef.current || completedRef.current || !ownsLoginRef.current) return
    cancelSentRef.current = true
    const loginId = loginIdRef.current || undefined
    if (kind === 'codex') {
      void host.codex.authLoginDeviceCancel?.(loginId).catch(() => { /* best effort */ })
    } else {
      void (host.claude as { authLoginCancel?: (loginId?: string) => Promise<unknown> }).authLoginCancel?.(loginId)
        .catch(() => { /* best effort */ })
    }
  }, [kind])

  const cancel = useCallback(() => {
    stoppedRef.current = true
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    cancelRemoteLogin()
    onClose()
  }, [cancelRemoteLogin, onClose])

  // Poll the host until the codex device login completes, fails, or times out.
  const pollCodex = useCallback(() => {
    const tick = async () => {
      if (stoppedRef.current) return
      try {
        const res = await host.codex.authLoginDevicePoll(loginIdRef.current || undefined)
        if (stoppedRef.current) return
        if (res?.status === 'success') {
          stoppedRef.current = true
          completedRef.current = true
          onSuccess()
          onClose()
          return
        }
        if (res?.status === 'error') {
          setError(loginErrorText(res.error, 'workspace.remoteLoginFailed'))
          setPhase('error')
          return
        }
      } catch (err) {
        if (stoppedRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
        return
      }
      if (!stoppedRef.current) pollTimerRef.current = window.setTimeout(() => void tick(), 2000)
    }
    pollTimerRef.current = window.setTimeout(() => void tick(), 2000)
  }, [onClose, onSuccess, t])

  // Kick off the login on mount.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    stoppedRef.current = false

    if (kind === 'codex') {
      // Device-code flow: get URL + code, then poll until the user approves.
      ;(async () => {
        try {
          const res = await host.codex.authLoginDeviceStart()
          if (res?.ok && res.url && res.code && res.loginId) {
            loginIdRef.current = res.loginId
            ownsLoginRef.current = true
            if (stoppedRef.current) {
              cancelRemoteLogin()
              return
            }
            setUrl(res.url)
            setDeviceCode(res.code)
            setPhase('awaiting-approval')
            pollCodex()
          } else {
            if (stoppedRef.current) return
            setError(loginErrorText(res?.error, 'workspace.remoteLoginStartFailed'))
            setPhase('error')
          }
        } catch (err) {
          if (stoppedRef.current) return
          setError(err instanceof Error ? err.message : String(err))
          setPhase('error')
        }
      })()
      return () => {
        stoppedRef.current = true
        if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
        cancelRemoteLogin()
      }
    }

    // claude paste-code flow.
    ;(async () => {
      try {
        const api = host.claude as { authLoginStart: () => Promise<{ ok?: boolean; url?: string; loginId?: string; error?: string }> }
        const res = await api.authLoginStart()
        if (res?.ok && res.url && res.loginId) {
          loginIdRef.current = res.loginId
          ownsLoginRef.current = true
          if (stoppedRef.current) {
            cancelRemoteLogin()
            return
          }
          setUrl(res.url)
          setPhase('awaiting-code')
        } else {
          if (stoppedRef.current) return
          setError(loginErrorText(res?.error, 'workspace.remoteLoginStartFailed'))
          setPhase('error')
        }
      } catch (err) {
        if (stoppedRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()
    return () => {
      stoppedRef.current = true
      cancelRemoteLogin()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  const submit = useCallback(async () => {
    const trimmed = code.trim()
    if (!trimmed) return
    setPhase('submitting')
    setError(null)
    try {
      const api = host.claude as { authLoginSubmitCode: (c: string, loginId?: string) => Promise<{ success?: boolean; error?: string; terminal?: boolean }> }
      const res = await api.authLoginSubmitCode(trimmed, loginIdRef.current || undefined)
      if (res?.success) {
        completedRef.current = true
        onSuccess()
        onClose()
        return
      }
      setError(loginErrorText(res?.error, 'workspace.remoteLoginFailed'))
      setPhase(res?.terminal ? 'error' : 'awaiting-code')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [code, onClose, onSuccess])

  const copy = useCallback((value: string, which: 'url' | 'code') => {
    if (!value) return
    void navigator.clipboard?.writeText(value).then(
      () => { setCopied(which); setTimeout(() => setCopied(null), 1500) },
      () => { /* ignore */ },
    )
  }, [])

  const openUrl = useCallback(() => {
    if (url) void host.shell?.openExternal?.(url).catch(() => { /* ignore */ })
  }, [url])

  const urlBox = (
    <div
      className="dialog-login-url"
      style={{
        wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12,
        background: 'var(--bg-secondary)', padding: '8px 10px', borderRadius: 6,
        border: '1px solid var(--border-color, #333)', marginBottom: 8,
      }}
    >
      {url}
    </div>
  )

  return (
    <div className="dialog-overlay" onClick={cancel}>
      <div className="dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h3>{t('workspace.remoteLoginTitle', { provider: label, host: displayHost })}</h3>

        {phase === 'starting' && (
          <p>{t('workspace.remoteLoginStarting')}</p>
        )}

        {phase === 'error' && (
          <p style={{ color: 'var(--text-error, #e06c75)' }}>{error}</p>
        )}

        {/* codex device-code flow */}
        {kind === 'codex' && phase === 'awaiting-approval' && (
          <>
            <p>{t('workspace.remoteLoginCodexSteps')}</p>
            {urlBox}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="dialog-btn secondary" onClick={openUrl} type="button">{t('workspace.remoteLoginOpenBrowser')}</button>
              <button className="dialog-btn secondary" onClick={() => copy(url, 'url')} type="button">{copied === 'url' ? t('workspace.remoteLoginCopied') : t('workspace.remoteLoginCopyUrl')}</button>
            </div>
            <p style={{ marginBottom: 4 }}>{t('workspace.remoteLoginOneTimeCode')}</p>
            <div
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                fontFamily: 'monospace', fontSize: 20, letterSpacing: 2,
                background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 6,
                border: '1px solid var(--border-color, #333)', marginBottom: 12,
              }}
            >
              <span>{deviceCode}</span>
              <button className="dialog-btn secondary" onClick={() => copy(deviceCode, 'code')} type="button">{copied === 'code' ? t('workspace.remoteLoginCopied') : t('workspace.remoteLoginCopy')}</button>
            </div>
            <p style={{ opacity: 0.7, fontSize: 13 }}>{t('workspace.remoteLoginWaiting')}</p>
          </>
        )}

        {/* claude paste-code flow */}
        {kind === 'claude' && (phase === 'awaiting-code' || phase === 'submitting') && (
          <>
            <p>{t('workspace.remoteLoginClaudeSteps')}</p>
            {urlBox}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="dialog-btn secondary" onClick={openUrl} type="button">{t('workspace.remoteLoginOpenBrowser')}</button>
              <button className="dialog-btn secondary" onClick={() => copy(url, 'url')} type="button">{copied === 'url' ? t('workspace.remoteLoginCopied') : t('workspace.remoteLoginCopyUrl')}</button>
            </div>
            <input
              className="dialog-input"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                border: '1px solid var(--border-color, #333)', borderRadius: 6, marginBottom: 4,
              }}
              type="text"
              placeholder={t('workspace.remoteLoginPasteCode')}
              value={code}
              autoFocus
              disabled={phase === 'submitting'}
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void submit() }}
            />
            {error && <p style={{ color: 'var(--text-error, #e06c75)', marginTop: 4 }}>{error}</p>}
          </>
        )}

        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={cancel} type="button">{t('workspace.accountCancelLogin')}</button>
          {kind === 'claude' && (phase === 'awaiting-code' || phase === 'submitting') && (
            <button
              className="dialog-btn confirm"
              onClick={() => void submit()}
              disabled={phase === 'submitting' || !code.trim()}
              type="button"
            >
              {phase === 'submitting' ? t('workspace.remoteLoginSubmitting') : t('workspace.remoteLoginSubmit')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
