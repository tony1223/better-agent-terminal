import assert from 'node:assert/strict'
import { prepareFilePickerResults } from '../renderer/src/utils/file-picker-search'

const input = [
  { name: 'src', path: '/repo/src', isDirectory: true },
  { name: 'my-target.ts', path: '/repo/src/my-target.ts', isDirectory: false },
  { name: 'target-helper.ts', path: '/repo/src/target-helper.ts', isDirectory: false },
  { name: 'target', path: '/repo/src/target', isDirectory: false },
  { name: 'target', path: '/repo/src/target', isDirectory: false },
]

const results = prepareFilePickerResults(input, 'target')
assert.deepEqual(
  results.map((entry) => entry.path),
  ['/repo/src/target', '/repo/src/target-helper.ts', '/repo/src/my-target.ts'],
  'Ctrl+P should remove directories/duplicates and rank exact then prefix matches',
)
assert.equal(input.length, 5, 'normalization must not mutate the host result array')
assert.deepEqual(prepareFilePickerResults(input, 'target', 1).map((entry) => entry.name), ['target'])

console.info('file-picker-search: passed')
