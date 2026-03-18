import { useTranslation } from 'react-i18next'

interface CloseConfirmDialogProps {
  onConfirm: () => void
  onCancel: () => void
}

export function CloseConfirmDialog({ onConfirm, onCancel }: CloseConfirmDialogProps) {
  const { t } = useTranslation()

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>{t('dialogs.closeCodeAgent')}</h3>
        <p>
          {t('dialogs.closeCodeAgentConfirm')}
        </p>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="dialog-btn confirm" onClick={onConfirm}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
