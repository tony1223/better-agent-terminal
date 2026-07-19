import * as assert from 'node:assert/strict'

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

;(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: (async <T>(cmd: string) => {
      if (cmd === 'workspace_save') return true as T
      if (cmd === 'app_set_dock_badge') return undefined as T
      throw new Error(`unexpected invoke: ${cmd}`)
    }) satisfies TauriInvoke,
  },
  batAppAPI: {
    debug: { isDebugMode: true },
  },
  location: { search: '?BAT_DEBUG=1' },
}

async function main() {
  const { sdkSessionRuntimeFamily, workspaceStore } = await import('../renderer/src/stores/workspace-store.ts')

  assert.equal(sdkSessionRuntimeFamily('claude-code'), 'claude')
  assert.equal(sdkSessionRuntimeFamily('claude-code-v2'), 'claude')
  assert.equal(sdkSessionRuntimeFamily('claude-code-worktree'), 'claude')
  assert.equal(sdkSessionRuntimeFamily('codex-agent'), 'codex')
  assert.equal(sdkSessionRuntimeFamily('codex-agent-worktree'), 'codex')
  assert.equal(sdkSessionRuntimeFamily('claude-channel'), null)

  ;(workspaceStore as unknown as {
    applySerializedData(data: string): void
  }).applySerializedData(JSON.stringify({
    workspaces: [
      { id: 'ws-a', name: 'A', folderPath: '/a', createdAt: 1, focusedTerminalId: 'claude-2', lastSdkSessionId: 'shared' },
    ],
    activeWorkspaceId: 'ws-a',
    activeTerminalId: 'claude-2',
    terminals: [
      { id: 'claude-1', workspaceId: 'ws-a', type: 'terminal', agentPreset: 'claude-code', title: 'Claude 1', cwd: '/a', sdkSessionId: 'shared' },
      { id: 'claude-2', workspaceId: 'ws-a', type: 'terminal', agentPreset: 'claude-code-worktree', title: 'Claude 2', cwd: '/a/.bat-worktrees/shared', sdkSessionId: 'shared', claudeCliSessionId: 'cli-shared', worktreePath: '/a/.bat-worktrees/shared', worktreeBranch: 'bat/shared', historyKey: 'shared-history' },
      { id: 'codex-1', workspaceId: 'ws-a', type: 'terminal', agentPreset: 'codex-agent', title: 'Codex 1', cwd: '/a', sdkSessionId: 'shared' },
    ],
  }))

  assert.equal(
    workspaceStore.findSdkSessionOwner('shared', 'claude-code-worktree', 'claude-2')?.id,
    'claude-1',
    'Claude SDK presets should block the same sdk session across Claude terminals',
  )
  assert.equal(
    workspaceStore.findSdkSessionOwner('shared', 'codex-agent-worktree', 'codex-2')?.id,
    'codex-1',
    'Codex SDK presets should block the same sdk session across Codex terminals',
  )
  assert.equal(
    workspaceStore.findSdkSessionOwner('shared', 'codex-agent', 'codex-1'),
    undefined,
    'the current terminal should not block itself',
  )
  assert.equal(
    workspaceStore.findSdkSessionOwner('shared', 'claude-code', 'claude-1')?.id,
    'claude-2',
    'another Claude owner should still be found when excluding the first owner',
  )
  assert.equal(
    workspaceStore.findSdkSessionOwner('shared', 'claude-channel', 'new-channel'),
    undefined,
    'non-SDK runtime families should not participate in sdk session ownership',
  )

  const replacementId = workspaceStore.repairTerminalIdentityCollision('claude-2')
  assert.ok(replacementId && replacementId !== 'claude-2')
  const repairedState = workspaceStore.getState()
  const repaired = repairedState.terminals.find(t => t.id === replacementId)
  assert.ok(repaired)
  assert.equal(repaired.sdkSessionId, undefined)
  assert.equal(repaired.claudeCliSessionId, undefined)
  assert.equal(repaired.worktreePath, undefined)
  assert.equal(repaired.worktreeBranch, undefined)
  assert.equal(repaired.cwd, '/a')
  assert.notEqual(repaired.historyKey, 'shared-history')
  assert.equal(repairedState.focusedTerminalId, replacementId)
  assert.equal(repairedState.activeTerminalId, replacementId)
  assert.equal(repairedState.workspaces[0].focusedTerminalId, replacementId)
  assert.equal(repairedState.workspaces[0].lastSdkSessionId, undefined)
  assert.ok(repairedState.terminals.some(t => t.id === 'claude-1'), 'the original owner must remain unchanged')

  console.log('workspace sdk session owner: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
