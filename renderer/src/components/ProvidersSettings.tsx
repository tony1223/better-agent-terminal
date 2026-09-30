import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { settingsStore, useSettings } from '../stores/settings-store'
import {
  canDisableProvider,
  isProviderEnabled,
  listPresets,
  listProviders,
  type ProviderDefinition,
} from '../../../shared/providers.mjs'

interface ProvidersSettingsProps {
  /** Provider-specific settings shown under an enabled provider (accounts, API key…). */
  sectionFor: (provider: ProviderDefinition) => ReactNode
}

// Settings → Providers: one row per provider from shared/providers.json with an
// enable toggle and, while enabled, its own settings section. Disabled
// providers' session types are hidden, their usage is not polled and their
// runtime is not auto-installed; existing sessions are kept.
export function ProvidersSettings({ sectionFor }: Readonly<ProvidersSettingsProps>) {
  const { t } = useTranslation()
  const toggles = useSettings(s => s.providers)
  const options = settingsStore.providerToggleOptions()
  const providers = listProviders().filter(provider => options.debug || !provider.debugOnly)

  const sessionTypesOf = (provider: ProviderDefinition) =>
    listPresets()
      .filter(preset => preset.provider === provider.id && !preset.hidden && (options.debug || !preset.debug))
      .map(preset => preset.name)
      .join(', ')

  return (
    <div className="settings-section">
      <h3>{t('settings.providersTitle')}</h3>
      <p className="settings-hint">{t('settings.providersHint')}</p>
      {providers.map(provider => {
        const enabled = isProviderEnabled(provider.id, toggles, options)
        const locked = enabled && !canDisableProvider(provider.id, toggles, options)
        const section = enabled ? sectionFor(provider) : null
        return (
          <div key={provider.id} className="settings-group provider-settings-row">
            <label className="settings-checkbox" title={locked ? t('settings.providerLastEnabled') : undefined}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={locked}
                onChange={e => settingsStore.setProviderEnabled(provider.id, e.target.checked)}
              />
              <strong>{provider.label}</strong>
            </label>
            <p className="settings-hint">
              {enabled
                ? t('settings.providerSessionTypes', { types: sessionTypesOf(provider) })
                : t('settings.providerDisabledHint')}
              {locked && ` ${t('settings.providerLastEnabled')}`}
            </p>
            {section && <div className="provider-settings-section">{section}</div>}
          </div>
        )
      })}
    </div>
  )
}
