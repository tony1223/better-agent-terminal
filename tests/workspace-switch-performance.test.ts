import * as assert from 'node:assert/strict'
import { createPanelActivation } from '../renderer/src/utils/panel-activation.ts'
import { touchBoundedLru } from '../renderer/src/utils/bounded-lru.ts'

const activation = createPanelActivation(false)
const changes: boolean[] = []
const unsubscribe = activation.subscribe(active => changes.push(active))

assert.equal(activation.current, false)
activation.set(false)
activation.set(true)
activation.set(true)
activation.set(false)

assert.deepEqual(
  changes,
  [true, false],
  'panel activation should notify only on real visibility changes',
)
assert.equal(activation.current, false)

unsubscribe()
activation.set(true)
assert.deepEqual(changes, [true, false], 'unsubscribed panels must not receive activation work')

let mounted = new Set<string>()
mounted = touchBoundedLru(mounted, 'one', 2)
mounted = touchBoundedLru(mounted, 'two', 2)
mounted = touchBoundedLru(mounted, 'three', 2)
assert.deepEqual([...mounted], ['two', 'three'], 'old inactive panels should be released')

mounted = touchBoundedLru(mounted, 'four', 2, new Set(['two']))
assert.deepEqual([...mounted], ['two', 'four'], 'running or prompting panels must remain mounted')

console.log('workspace switch activation regression: passed')
