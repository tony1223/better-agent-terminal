import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { filePreviewLines, prepareAgentFilePreview } from '../utils/agent-file-preview'
import { TextLineIndex } from '../utils/text-lines'
import { codexDiffLineClass, isCodexDiffChangeLine } from './CodexFileDiff.helpers'

interface AgentFilePreviewProps {
  input: Record<string, unknown>
  variant: 'edit' | 'write'
  expanded: boolean
  toggleId: string
  onToggle: (id: string) => void
}

const PAGE_LINES = 200

// Keep preparation stable during streaming and render just one expanded page.
export const AgentFilePreview = memo(function AgentFilePreview({ input, variant, expanded, toggleId, onToggle }: AgentFilePreviewProps) {
  const { t } = useTranslation()
  const preview = useMemo(() => prepareAgentFilePreview(input, variant), [input, variant])
  const [selection, setSelection] = useState({ preview, page: 0 })
  const page = selection.preview === preview ? selection.page : 0
  const pageCount = Math.ceil(preview.totalLines / PAGE_LINES)
  const indexes = useMemo(() => expanded && preview.isLong
    ? preview.sections.map(section => new TextLineIndex(section.text, section.lineCount))
    : null, [preview, expanded])
  const rows = useMemo(() => {
    let offset = 0
    return preview.sections.map((section, i) => {
      const start = Math.max(0, page * PAGE_LINES - offset)
      const end = Math.min(section.lineCount, (page + 1) * PAGE_LINES - offset)
      offset += section.lineCount
      return { kind: section.kind, lines: indexes
        ? indexes[i].page(start, Math.max(0, end - start))
        : filePreviewLines(section, !preview.isLong) }
    })
  }, [preview, indexes, page])

  if (rows.length === 0) return null
  return (
    <div className="claude-diff-block">
      {rows.map((section, sectionIndex) => section.lines.map((line, index) => {
        const unified = section.kind === 'unified'
        const changed = unified && isCodexDiffChangeLine(line)
        return (
          <div key={`${sectionIndex}-${index}`} className={unified
            ? codexDiffLineClass(line)
            : `claude-diff-line ${section.kind === 'delete' ? 'claude-diff-del' : 'claude-diff-add'}`}>
            <span className="claude-diff-sign">{unified ? (changed ? line[0] : ' ') : section.kind === 'delete' ? '-' : '+'}</span>
            <span className="claude-diff-text">{changed ? line.slice(1) : line}</span>
          </div>
        )
      }))}
      {expanded && pageCount > 1 && (
        <div className="claude-diff-pagination">
          <button disabled={page === 0} onClick={() => setSelection({ preview, page: page - 1 })}>{t('common.previousPage')}</button>
          <label>
            {t('common.page')}{' '}
            <input type="number" min={1} max={pageCount} value={page + 1}
              aria-label={t('common.page')}
              onChange={event => setSelection({ preview, page: Math.max(0, Math.min(pageCount - 1, Number(event.target.value) - 1)) })} />
            {' / '}{pageCount}{' · '}{page * PAGE_LINES + 1}–{Math.min(preview.totalLines, (page + 1) * PAGE_LINES)} / {preview.totalLines}
          </label>
          <button disabled={page + 1 === pageCount} onClick={() => setSelection({ preview, page: page + 1 })}>{t('common.nextPage')}</button>
        </div>
      )}
      {preview.isLong && (
        <div className="claude-diff-toggle" role="button" tabIndex={0}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(toggleId) } }}
          onClick={() => onToggle(toggleId)}>
          {expanded ? 'Collapse' : `Show all ${preview.totalLines} lines...`}
        </div>
      )}
    </div>
  )
})
