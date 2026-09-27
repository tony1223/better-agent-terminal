type FileChange = Record<string, unknown>

export function codexChangeDiffText(changes: FileChange[]): string {
  return changes.map(change => {
    const path = typeof change.path === 'string' ? change.path : typeof change.file_path === 'string' ? change.file_path : ''
    const kindValue = change.kind
    const kind = typeof kindValue === 'string' ? kindValue
      : kindValue && typeof kindValue === 'object' && 'type' in kindValue && typeof kindValue.type === 'string' ? kindValue.type
      : 'update'
    const diff = [change.diff, change.patch, change.unified_diff, change.unifiedDiff]
      .find(value => typeof value === 'string') as string | undefined
    const heading = `*** ${kind} File: ${path}`
    return diff ? `${heading}\n${diff}` : heading
  }).join('\n')
}

export function codexDiffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'claude-diff-line claude-diff-add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'claude-diff-line claude-diff-del'
  if (line.startsWith('@@')) return 'claude-diff-line claude-diff-hunk'
  if (line.startsWith('*** ') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    return 'claude-diff-line claude-diff-file'
  }
  return 'claude-diff-line'
}

export function isCodexDiffChangeLine(line: string): boolean {
  return (line.startsWith('+') && !line.startsWith('+++'))
    || (line.startsWith('-') && !line.startsWith('---'))
}
