import * as assert from 'assert'

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

;(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: (async <T>(cmd: string) => {
      if (cmd === 'settings_save' || cmd === 'workspace_save') return true as T
      if (cmd === 'app_set_dock_badge') return undefined as T
      throw new Error(`unexpected invoke: ${cmd}`)
    }) satisfies TauriInvoke,
  },
}

async function main() {
  const { settingsStore } = await import('../renderer/src/stores/settings-store.ts')
  const { workspaceStore } = await import('../renderer/src/stores/workspace-store.ts')

  settingsStore.setDefaultCodexModel('gpt-5.4')
  settingsStore.setDefaultCodexEffort('max')

  const workspace = workspaceStore.addWorkspace('Codex defaults', 'C:/project')
  const first = workspaceStore.addTerminal(workspace.id, 'codex-agent')
  assert.equal(first.model, 'gpt-5.4', 'new Codex agent should snapshot the configured default model')
  assert.equal(first.agentParams?.effortLevel, 'max', 'new Codex agent should snapshot the configured default effort')

  settingsStore.setDefaultCodexModel('gpt-5.3-codex')
  settingsStore.setDefaultCodexEffort('low')
  workspaceStore.updateTerminalAgentParams(first.id, { sandboxMode: 'read-only' })
  const preserved = workspaceStore.getState().terminals.find(terminal => terminal.id === first.id)
  assert.equal(preserved?.model, 'gpt-5.4', 'changing defaults must not rewrite an existing Codex agent model')
  assert.equal(preserved?.agentParams?.effortLevel, 'max', 'changing defaults must not rewrite an existing Codex agent effort')

  const second = workspaceStore.addTerminal(workspace.id, 'codex-agent-worktree')
  assert.equal(second.model, 'gpt-5.3-codex', 'later Codex agents should use the latest default model')
  assert.equal(second.agentParams?.effortLevel, 'low', 'later Codex agents should use the latest default effort')

  const claude = workspaceStore.addTerminal(workspace.id, 'claude-code')
  assert.equal(claude.model, undefined, 'Codex defaults must not leak into Claude agents')
  assert.equal(claude.agentParams, undefined, 'Codex params must not leak into Claude agents')

  console.log('Codex agent defaults: passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
