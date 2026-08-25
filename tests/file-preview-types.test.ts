import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXT_TO_LANG,
  IMAGE_EXTS,
  TEXT_EXTS,
  canPreview,
  getFileExt,
  getRichPreviewKind,
  isScriptFile,
} from '../renderer/src/utils/file-preview'

// getFileExt
{
  assert.equal(getFileExt('README.md'), 'md')
  assert.equal(getFileExt('Report.CSV'), 'csv', 'extension match must be case-insensitive')
  // Dotfiles carry the name itself as the extension.
  assert.equal(getFileExt('.gitignore'), 'gitignore')
  assert.equal(getFileExt('.env'), 'env')
  // Paths, not just bare names — PathLinker passes a full path.
  assert.equal(getFileExt('C:\\workspaces\\tools\\app\\main.ts'), 'ts')
  assert.equal(getFileExt('/home/user/scripts/deploy.sh'), 'sh')
  // Regression: splitting the *whole path* on '.' misreads a dot in a
  // directory name as the file's extension.
  assert.equal(getFileExt('C:\\some.dir\\README'), 'readme')
  assert.equal(getFileExt('/etc/my.app/config'), 'config')
}

// The drift this module exists to prevent: .sql previewed in the path-link
// modal but not in the file browser, because only one of the two duplicated
// lists mentioned it. All three of the requested types must be previewable.
{
  for (const name of ['query.sql', 'data.csv', 'page.html', 'page.htm']) {
    assert.equal(canPreview(name), 'text', `${name} should be previewable as text`)
  }
  assert.equal(canPreview('photo.png'), 'image')
  assert.equal(canPreview('paper.pdf'), 'pdf')
  assert.equal(canPreview('archive.zip'), null)
  assert.equal(canPreview('a.out'), null)
  // Procfiles have no extension, so the caller supplies the classification.
  assert.equal(canPreview('Procfile'), null)
  assert.equal(canPreview('Procfile', true), 'text')
}

// Rich (non-source) render modes
{
  assert.equal(getRichPreviewKind('notes.md'), 'markdown')
  assert.equal(getRichPreviewKind('index.html'), 'html')
  assert.equal(getRichPreviewKind('index.htm'), 'html')
  assert.equal(getRichPreviewKind('rows.csv'), 'csv')
  // Plain source files must stay on the highlighted-source path.
  assert.equal(getRichPreviewKind('query.sql'), null)
  assert.equal(getRichPreviewKind('main.ts'), null)
}

// Copy-whole-script affordance
{
  for (const name of ['deploy.sh', 'build.ps1', 'x.bash', 'x.zsh', 'x.cmd', 'x.bat']) {
    assert.equal(isScriptFile(name), true, `${name} should offer copy-script`)
  }
  for (const name of ['notes.txt', 'main.ts', 'data.csv']) {
    assert.equal(isScriptFile(name), false, `${name} should not offer copy-script`)
  }
  // Every script extension must also be previewable, or the button would be
  // attached to a pane that reports "Preview not available".
  for (const name of ['deploy.sh', 'build.ps1', 'x.bash', 'x.zsh', 'x.cmd', 'x.bat']) {
    assert.equal(canPreview(name), 'text', `${name} must be previewable to be copyable`)
  }
}

// EXT_TO_LANG values must all be languages PathLinker actually registers.
// hljs.highlight() throws on an unregistered language name, and HighlightedCode
// swallows that into an escaped-plain-text fallback — so a typo here degrades
// highlighting silently. Read the registrations out of the source and compare.
{
  const pathLinkerSource = readFileSync(
    join(__dirname, '..', 'renderer', 'src', 'components', 'PathLinker.tsx'),
    'utf8',
  )
  const registered = new Set(
    [...pathLinkerSource.matchAll(/hljs\.registerLanguage\('([^']+)'/g)].map(m => m[1]),
  )
  assert.ok(registered.size > 20, `expected the hljs registration block, found ${registered.size}`)
  for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
    assert.ok(registered.has(lang), `EXT_TO_LANG.${ext} -> '${lang}' is not registered in PathLinker`)
  }
}

// Every extension that maps to a language must be previewable in the first
// place, otherwise the mapping is unreachable.
{
  for (const ext of Object.keys(EXT_TO_LANG)) {
    assert.ok(TEXT_EXTS.has(ext), `EXT_TO_LANG lists '${ext}' but TEXT_EXTS does not`)
  }
  // The two sets must not overlap, or canPreview's order silently decides.
  for (const ext of IMAGE_EXTS) {
    assert.equal(TEXT_EXTS.has(ext), false, `'${ext}' is in both TEXT_EXTS and IMAGE_EXTS`)
  }
}

console.log('file preview types regression: passed')
