import { useTranslation } from 'react-i18next'
import type { InterruptedTurnSummary } from '../utils/interrupted-turn'

interface InterruptedTurnCardProps {
  summary: InterruptedTurnSummary
  onContinue: () => void
  onDismiss: () => void
}

/**
 * Shown at the end of the timeline after a turn was interrupted (Esc, stop,
 * abort, error). Everything on it comes from messages already on screen;
 * "Continue" sends one short prompt, so resuming costs a normal turn and
 * nothing more.
 */
export function InterruptedTurnCard({ summary, onContinue, onDismiss }: Readonly<InterruptedTurnCardProps>) {
  const { t } = useTranslation()
  return (
    <div className="claude-interrupted-card" role="status">
      <div className="claude-interrupted-head">
        <span className="claude-interrupted-title">⏸ {t('claude.interruptedTitle')}</span>
        <button type="button" className="claude-interrupted-dismiss" onClick={onDismiss} title={t('claude.interruptedDismiss')}>×</button>
      </div>
      {summary.prompt && (
        <div className="claude-interrupted-row">
          <span className="claude-interrupted-label">{t('claude.interruptedPrompt')}</span>
          <span className="claude-interrupted-text">{summary.prompt}</span>
        </div>
      )}
      {summary.toolCount > 0 && (
        <div className="claude-interrupted-row">
          <span className="claude-interrupted-label">{t('claude.interruptedTools', { count: summary.toolCount })}</span>
          <span className="claude-interrupted-text">
            {summary.lastTools.map((label, i) => (
              <span key={i} className="claude-interrupted-tool">{label}</span>
            ))}
            {summary.unfinishedTools > 0 && (
              <span className="claude-interrupted-unfinished">{t('claude.interruptedUnfinished', { count: summary.unfinishedTools })}</span>
            )}
          </span>
        </div>
      )}
      {summary.lastReply && (
        <div className="claude-interrupted-row">
          <span className="claude-interrupted-label">{t('claude.interruptedLastReply')}</span>
          <span className="claude-interrupted-text">{summary.lastReply}</span>
        </div>
      )}
      <div className="claude-interrupted-actions">
        <button type="button" className="claude-interrupted-continue" onClick={onContinue}>
          ▶ {t('claude.interruptedContinue')}
        </button>
        <span className="claude-interrupted-hint">{t('claude.interruptedHint')}</span>
      </div>
    </div>
  )
}
