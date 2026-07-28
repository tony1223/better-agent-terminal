// GH #124: the permission mode a session is in must survive a restart.
//
// It used to live only in ClaudeAgentPanel state, so every resume came back at
// bypassPermissions no matter what the user had picked — a session deliberately
// parked in `plan` silently regained the ability to write. Persisting it means
// two field lists in the workspace store (save and restore) plus the panel's
// restore rule, and dropping the field from either list reintroduces the bug
// with no other symptom. This locks all three.

import * as assert from 'node:assert/strict'

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

const savedPayloads: string[] = []

;(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: (async <T>(cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'workspace_save') {
        savedPayloads.push(String(args?.data ?? ''))
        return true as T
      }
      return undefined as T
    }) satisfies TauriInvoke,
  },
  batAppAPI: {
    debug: { isDebugMode: true },
  },
  location: { search: '?BAT_DEBUG=1' },
}

function terminal(id: string, extra: Record<string, unknown> = {}) {
  return { id, workspaceId: 'ws-a', type: 'terminal', agentPreset: 'claude-code', title: id, cwd: '/a', ...extra }
}

async function main() {
  const { PERMISSION_MODES, DEFAULT_PERMISSION_MODE, normalizePermissionMode } =
    await import('../renderer/src/utils/permission-modes.ts')
  const { workspaceStore } = await import('../renderer/src/stores/workspace-store.ts')

  // --- the restore rule -----------------------------------------------------

  for (const mode of PERMISSION_MODES) {
    assert.equal(normalizePermissionMode(mode), mode, `${mode} is a real mode and must survive verbatim`)
  }
  assert.equal(DEFAULT_PERMISSION_MODE, 'bypassPermissions',
    'the fallback must stay bypassPermissions — persistence restores what users chose, '
    + 'it does not re-default sessions that predate it')
  for (const junk of [undefined, null, '', 'plan-mode', 'PLAN', 42, {}, ['plan']]) {
    assert.equal(normalizePermissionMode(junk), DEFAULT_PERMISSION_MODE,
      `${JSON.stringify(junk) ?? 'undefined'} is not a mode and must not reach the sidecar`)
  }

  // --- the restore field list ----------------------------------------------

  const applySerializedData = (workspaceStore as unknown as {
    applySerializedData(data: string): void
  }).applySerializedData.bind(workspaceStore)

  applySerializedData(JSON.stringify({
    workspaces: [{ id: 'ws-a', name: 'A', folderPath: '/a', createdAt: 1 }],
    activeWorkspaceId: 'ws-a',
    activeTerminalId: 'keeps-mode',
    terminals: [
      terminal('keeps-mode', { permissionMode: 'plan' }),
      terminal('never-set'),
      terminal('junk-mode', { permissionMode: 42 }),
    ],
  }))

  const restored = (id: string) => workspaceStore.getState().terminals.find(t => t.id === id)
  assert.equal(restored('keeps-mode')?.permissionMode, 'plan',
    'the restore field list must carry permissionMode — without it the mode is read back as undefined '
    + 'and every restart lands on the default')
  assert.equal(restored('never-set')?.permissionMode, undefined,
    'a terminal that never had a mode must stay undefined rather than being pinned to a default on disk')
  assert.equal(restored('junk-mode')?.permissionMode, undefined,
    'a non-string on disk must be dropped at the store boundary, not passed along as a mode')

  // --- the save field list --------------------------------------------------

  savedPayloads.length = 0
  workspaceStore.updateTerminalPermissionMode('never-set', 'acceptEdits')
  assert.equal(restored('never-set')?.permissionMode, 'acceptEdits', 'the setter must update live state')
  await (workspaceStore as unknown as { _savePromise: Promise<void> })._savePromise

  assert.ok(savedPayloads.length > 0, 'changing the mode must trigger a save')
  const written = JSON.parse(savedPayloads[savedPayloads.length - 1]) as {
    terminals: Array<{ id: string; permissionMode?: unknown }>
  }
  assert.equal(written.terminals.find(t => t.id === 'never-set')?.permissionMode, 'acceptEdits',
    'the save field list must carry permissionMode — without it the mode lives only in memory '
    + 'and dies with the process, which is exactly the reported bug')
  assert.equal(written.terminals.find(t => t.id === 'keeps-mode')?.permissionMode, 'plan',
    'other terminals keep their own mode')

  // Writing the same value again must not churn the file: the setter is called
  // from onStatus on every status frame, which arrives many times per turn.
  savedPayloads.length = 0
  workspaceStore.updateTerminalPermissionMode('never-set', 'acceptEdits')
  await (workspaceStore as unknown as { _savePromise: Promise<void> })._savePromise
  assert.equal(savedPayloads.length, 0,
    'setting the mode to the value it already has must not schedule a write')

  console.log('workspace permission mode: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
