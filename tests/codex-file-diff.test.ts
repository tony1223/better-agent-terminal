import * as assert from 'assert'
import { codexChangeDiffText, codexDiffLineClass, isCodexDiffChangeLine } from '../renderer/src/components/CodexFileDiff.helpers'

const diff = codexChangeDiffText([
  { path: 'src/new.ts', kind: 'add', diff: '+export const value = 1' },
  { path: 'src/old.ts', kind: 'delete', diff: '-old content' },
  { path: 'src/edit.ts', kind: 'update', diff: '@@ -1 +1 @@\n-before\n+after' },
])
assert.ok(diff.includes('*** add File: src/new.ts\n+export const value = 1'))
assert.ok(diff.includes('*** delete File: src/old.ts\n-old content'))
assert.ok(diff.includes('*** update File: src/edit.ts\n@@ -1 +1 @@\n-before\n+after'))
assert.equal(codexDiffLineClass('*** add File: src/new.ts'), 'claude-diff-line claude-diff-file')
assert.equal(codexDiffLineClass('@@ -1 +1 @@'), 'claude-diff-line claude-diff-hunk')
assert.equal(codexDiffLineClass('+after'), 'claude-diff-line claude-diff-add')
assert.equal(codexDiffLineClass('-before'), 'claude-diff-line claude-diff-del')
assert.equal(isCodexDiffChangeLine('+++ b/src/edit.ts'), false)
assert.equal(codexChangeDiffText([{ path: 'legacy.ts', kind: { type: 'update' }, unified_diff: '-old\n+new' }]), '*** update File: legacy.ts\n-old\n+new')
assert.equal(codexChangeDiffText([]), '')
