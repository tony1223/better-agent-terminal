import * as assert from 'node:assert/strict'
import { BatchedSubagentStreams, type SubagentStreamSnapshot } from '../renderer/src/utils/batched-subagent-streams'

const pending = new Map<number, { callback: () => void; delay: number }>()
let id = 0
const snapshots: SubagentStreamSnapshot[] = []
const streams = new BatchedSubagentStreams(snapshot => snapshots.push(snapshot), {
  schedule: (callback, delay) => { pending.set(++id, { callback, delay }); return id },
  cancel: handle => { pending.delete(handle as number) },
})
const tick = () => { [...pending.values()].forEach(job => job.callback()) }
for (let i = 0; i < 10_000; i++) streams.append(String(i % 4), { text: 'x', thinking: 'y' })
assert.equal(pending.size, 1)
assert.equal(snapshots.length, 0)
tick()
assert.equal(snapshots.length, 1, 'a burst across multiple agents publishes once')
assert.equal(snapshots[0].text.get('0')?.length, 2500)
assert.equal(snapshots[0].thinking.get('3')?.length, 2500)
streams.append('0', { text: 'last' })
tick()
assert.equal(snapshots[0].text.get('0')?.length, 2500, 'published snapshots must remain immutable')
assert.ok(snapshots[1].text.get('0')?.endsWith('last'))
streams.setActive(false)
streams.append('background', { text: 'delayed' })
assert.equal([...pending.values()][0].delay, 500)
streams.setActive(true)
assert.equal(pending.size, 1)
assert.equal([...pending.values()][0].delay, 50)
streams.delete('background')
tick()
assert.equal(snapshots.at(-1)?.text.has('background'), false, 'completed chunks must not reappear from a pending timer')
streams.append('0', { text: 'old session' })
streams.clear()
assert.equal(pending.size, 0)
assert.equal(snapshots.at(-1)?.text.size, 0)
assert.equal(snapshots.at(-1)?.thinking.size, 0)
streams.append('new session', { text: 'new' })
tick()
assert.deepEqual([...snapshots.at(-1)!.text], [['new session', 'new']])
streams.append('unmounted', { text: 'pending' })
const count = snapshots.length
streams.dispose()
tick()
assert.equal(pending.size, 0)
assert.equal(snapshots.length, count)
console.log('batched subagent streams regression: passed')
