import * as assert from 'node:assert/strict'
import { createPanelActivation } from '../renderer/src/utils/panel-activation.ts'
import { touchBoundedLru } from '../renderer/src/utils/bounded-lru.ts'
import {
  rememberMountedWorkspace,
  shouldKeepTerminalPanelMounted,
} from '../renderer/src/utils/workspace-mounts.ts'

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

assert.equal(
  shouldKeepTerminalPanelMounted({ agentPreset: 'none' }),
  true,
  'plain terminal panels must keep their parsed xterm scrollback while inactive',
)
assert.equal(
  shouldKeepTerminalPanelMounted({}),
  true,
  'legacy plain terminals without an explicit preset must also remain mounted',
)
assert.equal(
  shouldKeepTerminalPanelMounted({ agentPreset: 'codex-agent' }),
  false,
  'idle agent panels should remain eligible for LRU eviction',
)
assert.equal(
  shouldKeepTerminalPanelMounted({ agentPreset: 'codex-agent', isAgentRunning: true }),
  true,
  'running agent panels must remain mounted',
)

let terminalPanels = new Set<string>()
terminalPanels = touchBoundedLru(terminalPanels, 'plain-one', 2)
terminalPanels = touchBoundedLru(terminalPanels, 'agent-one', 2)
terminalPanels = touchBoundedLru(
  terminalPanels,
  'agent-two',
  2,
  new Set(['plain-one']),
)
assert.deepEqual(
  [...terminalPanels],
  ['plain-one', 'agent-two'],
  'the panel LRU must not discard an inactive plain terminal and its scrollback',
)

console.log('workspace switch activation regression: passed')
