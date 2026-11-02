import assert from 'node:assert/strict'
import { uploadReleaseAsset } from '../scripts/upload-release-asset.mjs'

const calls = []
const delays = []
await uploadReleaseAsset('v3.2.16-pre.5', 'bundle/installer with spaces.exe', {
  run: args => { calls.push(args); return { status: calls.length === 1 ? 1 : 0 } },
  wait: async ms => { delays.push(ms) },
})
assert.equal(calls.length, 2, 'a failed upload is retried')
assert.deepEqual(calls[0], ['release', 'upload', 'v3.2.16-pre.5', 'bundle/installer with spaces.exe', '--clobber'])
assert.deepEqual(calls[1], calls[0], 'a retry replaces a previously saved asset')
assert.deepEqual(delays, [2000])

let failures = 0
await assert.rejects(uploadReleaseAsset('v-test', 'installer.exe', {
  run: () => { failures++; return { status: 1 } },
  wait: async () => {},
}), /failed after 3 attempts/)
assert.equal(failures, 3, 'persistent failures stop the release step')

let successfulCalls = 0
await uploadReleaseAsset('v-test', 'installer.exe', {
  run: () => { successfulCalls++; return { status: 0 } },
  wait: async () => { assert.fail('a successful upload must not wait') },
})
assert.equal(successfulCalls, 1)

const missingCommand = new Error('gh executable not found')
await assert.rejects(uploadReleaseAsset('v-test', 'installer.exe', {
  run: () => ({ error: missingCommand }),
  wait: async () => { assert.fail('a missing gh executable cannot be retried') },
}), error => error === missingCommand)
console.log('release asset upload: passed')
