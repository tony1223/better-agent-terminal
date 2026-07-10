import assert from 'node:assert/strict'
import { join } from 'node:path'

import { codexRuntimeRequiredFiles } from '../scripts/prepare-tauri-codex-runtime.mjs'

// codex-runtime/ must mirror the npm package layout: codex only finds its
// helper binaries (code-mode host, bundled rg, sandbox helpers) when the
// executable sits in bin/ next to a codex-package.json marker.
assert.deepEqual(codexRuntimeRequiredFiles('darwin'), [
  join('bin', 'codex'),
  join('bin', 'codex-code-mode-host'),
  join('codex-path', 'rg'),
  'codex-package.json',
])

assert.deepEqual(codexRuntimeRequiredFiles('win32'), [
  join('bin', 'codex.exe'),
  join('bin', 'codex-code-mode-host.exe'),
  join('codex-path', 'rg.exe'),
  'codex-package.json',
])

console.log('prepare-tauri-codex-runtime: passed')
