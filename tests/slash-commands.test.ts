// Tests for renderer/src/utils/slash-commands.ts — the `/` menu's grouping,
// de-duplication and filtering.
//
// The menu was empty of Claude Code content for so long that the overlap between
// BAT's commands and the CLI's was never visible. Now that the list actually
// arrives, the parts that hurt are the ones nobody could see before: duplicate
// names, and a highlight that points at a different row than the one that runs.
//
// Deterministic + offline. Run with: pnpm exec tsx tests/slash-commands.test.ts

import * as assert from 'node:assert/strict'

import {
  claudeCommandSource,
  mergeSlashCommands,
  filterSlashCommands,
  groupSlashCommands,
  flattenSlashGroups,
  CLAUDE_BUILTIN_COMMANDS,
  type SlashCommandInfo,
} from '../renderer/src/utils/slash-commands'

let failures = 0
function test(name: string, fn: () => void) {
  try { fn(); console.log('  ok  -', name) } catch (err) {
    failures++; console.error('  FAIL-', name, '\n   ', (err as Error).message)
  }
}

const cmd = (name: string, description = '', argumentHint = ''): SlashCommandInfo =>
  ({ name, description, argumentHint })

// A trimmed copy of what ClaudeAgentPanel contributes.
const BAT: SlashCommandInfo[] = [
  cmd('new', 'Reset session'),
  cmd('model', 'Select model'),
  cmd('compact', 'Manually compact conversation context'),
  cmd('resume', 'Resume a previous session'),
]

test('a plugin command is recognised by its namespace', () => {
  assert.equal(claudeCommandSource('dtd-altium:place-part'), 'plugin')
  assert.equal(claudeCommandSource('some-marketplace:deep:name'), 'plugin')
})

test('Claude Code built-ins are told apart from installed things', () => {
  assert.equal(claudeCommandSource('security-review'), 'builtin')
  assert.equal(claudeCommandSource('init'), 'builtin')
  assert.equal(claudeCommandSource('my-personal-skill'), 'skill')
})

// The whole point of merging rather than concatenating. /model exists on both
// sides; BAT intercepts the name before the prompt is sent, so the CLI's row is
// unreachable and listing it just offers the user a choice where one option
// silently does nothing.
test('a name BAT already owns is not listed twice', () => {
  const merged = mergeSlashCommands(BAT, [
    cmd('model', 'Set the model for this session'),
    cmd('compact', 'Compact the conversation'),
    cmd('init', 'Initialise a CLAUDE.md'),
  ])
  assert.equal(merged.filter(c => c.name === 'model').length, 1)
  assert.equal(merged.filter(c => c.name === 'compact').length, 1)
  // BAT's own description survives, because BAT's handler is what runs.
  assert.equal(merged.find(c => c.name === 'model')?.description, 'Select model')
  assert.equal(merged.find(c => c.name === 'model')?.source, 'bat')
  // Non-overlapping CLI commands still come through.
  assert.equal(merged.find(c => c.name === 'init')?.source, 'builtin')
})

test('the CLI repeating itself does not produce repeated rows', () => {
  const merged = mergeSlashCommands([], [cmd('review'), cmd('review'), cmd('plan')])
  assert.deepEqual(merged.map(c => c.name), ['review', 'plan'])
})

test('malformed entries are skipped rather than rendered as blanks', () => {
  const merged = mergeSlashCommands([], [
    null as unknown as SlashCommandInfo,
    { name: '', description: 'x', argumentHint: '' },
    { name: 'ok' } as SlashCommandInfo,
  ])
  assert.deepEqual(merged.map(c => c.name), ['ok'])
  // Missing optional fields become empty strings, never undefined — the menu
  // renders them straight into a template.
  assert.equal(merged[0].description, '')
  assert.equal(merged[0].argumentHint, '')
})

test('groups appear in a fixed order and empty ones are dropped', () => {
  const merged = mergeSlashCommands(BAT, [
    cmd('my-skill'),
    cmd('init'),
    cmd('acme:deploy'),
  ])
  const groups = groupSlashCommands(merged)
  assert.deepEqual(groups.map(g => g.source), ['bat', 'builtin', 'plugin', 'skill'])

  // Nothing from the CLI at all: only BAT's group is rendered.
  const batOnly = groupSlashCommands(mergeSlashCommands(BAT, []))
  assert.deepEqual(batOnly.map(g => g.source), ['bat'])
  assert.equal(batOnly[0].label, 'BAT')
})

// Arrow-key navigation indexes a flat array while the DOM renders headed
// sections. If the two walk the rows in different orders the highlight sits on
// one command and Enter runs another.
test('the flat navigation order matches the rendered order', () => {
  const merged = mergeSlashCommands(BAT, [cmd('my-skill'), cmd('init'), cmd('acme:deploy')])
  const flat = flattenSlashGroups(groupSlashCommands(merged))
  assert.deepEqual(
    flat.map(c => c.name),
    ['new', 'model', 'compact', 'resume', 'init', 'acme:deploy', 'my-skill'],
  )
  // Same set as the merge, just reordered — grouping must not lose a command.
  assert.equal(flat.length, merged.length)
  assert.deepEqual(new Set(flat.map(c => c.name)), new Set(merged.map(c => c.name)))
})

test('filtering matches names and aliases but not descriptions', () => {
  const entries = mergeSlashCommands([], [
    { name: 'usage', description: 'Show cost and limits', argumentHint: '', aliases: ['cost', 'stats'] },
    { name: 'review', description: 'Review the usage of this module', argumentHint: '' },
  ])
  assert.deepEqual(filterSlashCommands(entries, 'cost').map(c => c.name), ['usage'])
  // 'usage' appears in /review's description; matching prose would surface it.
  assert.deepEqual(filterSlashCommands(entries, 'usage').map(c => c.name), ['usage'])
  assert.deepEqual(filterSlashCommands(entries, 'rev').map(c => c.name), ['review'])
})

test('an empty filter returns everything, and a copy', () => {
  const entries = mergeSlashCommands(BAT, [])
  const filtered = filterSlashCommands(entries, '   ')
  assert.equal(filtered.length, entries.length)
  filtered.pop()
  assert.equal(entries.length, BAT.length, 'filtering must not mutate its input')
})

test('filtering is case-insensitive both ways', () => {
  const entries = mergeSlashCommands([], [cmd('Security-Review')])
  assert.equal(filterSlashCommands(entries, 'SECURITY').length, 1)
  assert.equal(filterSlashCommands(entries, 'security').length, 1)
})

// The set only picks a heading. Letting it drift behind a Claude Code release
// mislabels a row; dropping a name from the menu entirely would be the real bug,
// and this pins that it cannot happen.
test('an unknown name is still listed, just under a different heading', () => {
  assert.equal(CLAUDE_BUILTIN_COMMANDS.has('a-command-shipped-next-year'), false)
  const merged = mergeSlashCommands([], [cmd('a-command-shipped-next-year')])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].source, 'skill')
})

console.log(failures === 0 ? '\nslash-commands: OK' : `\nslash-commands: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
