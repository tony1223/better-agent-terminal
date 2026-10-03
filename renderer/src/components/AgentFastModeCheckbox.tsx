import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'

const subscribeSettings = (listener: () => void) => settingsStore.subscribe(listener)
const getFastModeConfigured = () => settingsStore.getSettings().allowFastMode === true
const getFastModeEpoch = () => settingsStore.getSettings().fastModeEpoch || 0

interface FastModeMeta {
  fastMode: boolean
  supportsFastMode: boolean
  fastModeState?: string
  fastModeDisabledReason?: string | null
}

interface Props {
  sessionId: string
  disabled: boolean
  ensureSessionStarted: () => Promise<unknown>
}

function isFastModeMeta(value: unknown): value is FastModeMeta {
  return !!value && typeof value === 'object'
    && typeof (value as FastModeMeta).fastMode === 'boolean'
    && typeof (value as FastModeMeta).supportsFastMode === 'boolean'
}

export const AgentFastModeCheckbox = memo(function AgentFastModeCheckbox({ sessionId, disabled, ensureSessionStarted }: Props) {
  const { t } = useTranslation()
  const configured = useSyncExternalStore(subscribeSettings, getFastModeConfigured, getFastModeConfigured)
  const allowed = configured && host.debug.isDebugMode === true
  const epoch = useSyncExternalStore(subscribeSettings, getFastModeEpoch, getFastModeEpoch)
  const [meta, setMeta] = useState<FastModeMeta | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const generation = useRef(0)

  useEffect(() => {
    ++generation.current
    const request = ++revision.current
    let active = true
    setMeta(null)
    setPending(false)
    setError('')
    if (!allowed) return () => { ++revision.current; ++generation.current }
    const unsubStatus = host.claude.onStatus((sid: string, value: unknown) => {
      if (active && sid === sessionId && isFastModeMeta(value)) {
        ++revision.current
        setMeta(value)
      }
    })
    const unsubReset = host.claude.onSessionReset((sid: string) => {
      if (active && sid === sessionId) {
        ++generation.current
        ++revision.current
        setMeta(null)
        setPending(false)
      }
    })
    host.claude.getSessionMeta(sessionId).then((value: unknown) => {
      if (active && revision.current === request && isFastModeMeta(value)) setMeta(value)
    }).catch(() => { /* A fresh session is initialized on the first explicit toggle. */ })
    return () => { active = false; ++revision.current; ++generation.current; unsubStatus(); unsubReset() }
  }, [sessionId, allowed, epoch])

  if (!allowed) return null
  const unsupported = meta?.supportsFastMode === false
  const state = meta?.fastModeState
  const hint = unsupported ? t('claude.fastModeUnsupported')
    : disabled ? t('claude.fastModeBusy')
      : state === 'cooldown' ? t('claude.fastModeCooldown')
        : state === 'pending' ? t('claude.fastModePending') : t('claude.fastModeHint')

  const toggle = async (enabled: boolean) => {
    setPending(true)
    setError('')
    const startedGeneration = generation.current
    try {
      await ensureSessionStarted()
      if (generation.current !== startedGeneration) return
      const request = ++revision.current
      const value: unknown = await host.claude.setFastMode(sessionId, enabled)
      if (!isFastModeMeta(value)) throw new Error(t('claude.fastModeUnavailable'))
      // A status broadcast may arrive first. Both carry host-owned state.
      if (generation.current === startedGeneration && revision.current === request) setMeta(value)
    } catch (err) {
      if (generation.current === startedGeneration) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === startedGeneration) setPending(false)
    }
  }

  return <span className="claude-fast-control">
    <label className="claude-fast-checkbox" title={meta?.fastModeDisabledReason || hint}>
      <input type="checkbox" checked={meta?.fastMode === true} disabled={disabled || pending || unsupported}
        onChange={event => { void toggle(event.target.checked) }} />
      Fast{pending ? '…' : state === 'cooldown' ? ` (${t('claude.fastModeCooling')})` : ''}
    </label>
    {error && <span className="claude-fast-error" role="alert">{error}</span>}
  </span>
})
