// An AskUserQuestion tool call, rendered as the Q&A it actually is.
//
// The generic tool row splits this exchange in half and says neither side in its
// own words: IN is the raw question JSON, OUT is the SDK's "Your questions have
// been answered: …" sentence. But these picks steer the rest of the turn exactly
// like a typed prompt, so the timeline states them plainly — one row for the
// question, one for the answer.
//
// Collapsed shows only what the user picked. Expanding the row turns the answer
// into the full ballot: every option that was offered, picked ones marked, each
// with the description that was on the button. Shared by both panels' timelines.

import { useTranslation } from 'react-i18next'
import { LinkedText } from './PathLinker'
import type { AskUserQnA } from './AskUserQuestion.helpers'

interface Ballot {
  label: string
  description: string
  picked: boolean
  custom: boolean
}

// Expanded view: the offered options in their original order, then any text the
// user typed themselves. Options the model listed but nobody picked stay in the
// list — "what was on the table" is the point of expanding.
function ballot(entry: AskUserQnA): Ballot[] {
  const picked = new Set(entry.answers.filter(answer => !answer.custom).map(answer => answer.label))
  const offered = entry.options.map(option => ({
    label: option.label,
    description: option.description,
    picked: picked.has(option.label),
    custom: false,
  }))
  const typed = entry.answers
    .filter(answer => answer.custom)
    .map(answer => ({ label: answer.label, description: answer.description, picked: true, custom: true }))
  return [...offered, ...typed]
}

export interface AgentAskUserQnAProps {
  entries: AskUserQnA[]
  /** Expanded entries list every offered option, not just the picks. */
  expanded: boolean
  /** Copies one Q&A pair, mirroring the click-to-copy on ordinary tool rows. */
  onCopy: (text: string, blockId: string) => void
  copiedId: string | null
  /** Namespaces this row's copy block ids against other rows in the timeline. */
  idPrefix: string
}

export function AgentAskUserQnA({ entries, expanded, onCopy, copiedId, idPrefix }: AgentAskUserQnAProps) {
  const { t } = useTranslation()
  if (entries.length === 0) return null

  return (
    <div className="claude-tool-blocks claude-qna">
      {entries.map((entry, index) => {
        const blockId = `${idPrefix}-${index}`
        const answered = entry.answers.length > 0
        const items = expanded ? ballot(entry) : entry.answers.map(answer => ({ ...answer, picked: true }))
        const copyText = `Q: ${entry.question}\nA: ${answered ? entry.answers.map(a => a.label).join(', ') : ''}`
        return (
          <div
            key={index}
            className="claude-qna-entry"
            onClick={() => onCopy(copyText, blockId)}
            title={t('claude.clickToCopy')}
          >
            <div className="claude-qna-row">
              <span className="claude-tool-row-label claude-qna-q">Q</span>
              <span className="claude-qna-question">
                <LinkedText text={entry.question} />
              </span>
              <span className="claude-qna-tags">
                {entry.header && <span className="claude-qna-tag">{entry.header}</span>}
                {entry.multiSelect && <span className="claude-qna-tag">{t('claude.multiSelectHint')}</span>}
              </span>
              <span className={`claude-tool-row-copy ${copiedId === blockId ? 'copied' : ''}`}>
                {copiedId === blockId ? '✓' : '⧉'}
              </span>
            </div>
            <div className="claude-qna-row">
              <span className="claude-tool-row-label claude-qna-a">A</span>
              <span className={`claude-qna-answers ${expanded ? 'expanded' : ''}`}>
                {!answered && <span className="claude-qna-pending">{t('claude.askAwaitingAnswer')}</span>}
                {items.map((item, itemIndex) => (
                  <span
                    key={itemIndex}
                    className={`claude-qna-pick ${item.picked ? 'picked' : ''} ${item.custom ? 'custom' : ''}`}
                    title={!expanded && item.description ? item.description : undefined}
                  >
                    <span className="claude-qna-mark">{item.picked ? '✓' : '○'}</span>
                    <span className="claude-qna-pick-label">{item.label}</span>
                    {expanded && item.description && (
                      <span className="claude-qna-pick-desc"><LinkedText text={item.description} /></span>
                    )}
                  </span>
                ))}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
