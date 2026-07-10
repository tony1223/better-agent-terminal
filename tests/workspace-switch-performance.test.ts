import * as assert from 'node:assert/strict'
import { createPanelActivation } from '../renderer/src/utils/panel-activation.ts'

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

console.log('workspace switch activation regression: passed')
