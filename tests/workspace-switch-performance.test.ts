import * as assert from 'node:assert/strict'
import { createPanelActivation } from '../renderer/src/utils/panel-activation.ts'
import { touchBoundedLru } from '../renderer/src/utils/bounded-lru.ts'
import { rememberMountedWorkspace } from '../renderer/src/utils/workspace-mounts.ts'

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

let mountedWorkspaces = new Set<string>()
mountedWorkspaces = rememberMountedWorkspace(mountedWorkspaces, 'one')
mountedWorkspaces = rememberMountedWorkspace(mountedWorkspaces, 'two')
mountedWorkspaces = rememberMountedWorkspace(mountedWorkspaces, 'three')
assert.deepEqual(
  [...mountedWorkspaces],
  ['one', 'two', 'three'],
  'visited workspace views must remain mounted so their text state survives switching',
)

let mountedTerminals = new Set<string>()
mountedTerminals = touchBoundedLru(mountedTerminals, 'one', 2)
mountedTerminals = touchBoundedLru(mountedTerminals, 'two', 2)
mountedTerminals = touchBoundedLru(mountedTerminals, 'three', 2)
assert.deepEqual([...mountedTerminals], ['two', 'three'], 'old inactive terminal panels should be released')

mountedTerminals = touchBoundedLru(mountedTerminals, 'four', 2, new Set(['two']))
assert.deepEqual([...mountedTerminals], ['two', 'four'], 'running or prompting terminal panels must remain mounted')

console.log('workspace switch activation regression: passed')
