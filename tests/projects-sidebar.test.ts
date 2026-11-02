import assert from 'node:assert/strict'
import { projectParentDir, projectPathKey } from '../renderer/src/utils/project-path'

type Snapshot = { workspaces: any[]; terminals: any[]; activeWorkspaceId?: string; activeTerminalId?: string }
let hostState: Snapshot = { workspaces: [], terminals: [] }
let rejectSave = false
let holdSave: Promise<void> | null = null
let saving = false
const scans: { roots: string[]; resolve: (value: unknown) => void }[] = []
const calls: string[] = []
;(globalThis as any).window = {
  __TAURI_INTERNALS__: { invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd)
    if (cmd === 'workspace_load') return JSON.stringify(hostState)
    if (cmd === 'workspace_save') {
      saving = true
      if (holdSave) await holdSave
      saving = false
      if (rejectSave) return false
      hostState = JSON.parse(String(args?.data))
      // Simulate host normalization; the renderer must read it back, rather
      // than treating its submitted draft as the canonical state.
      for (const workspace of hostState.workspaces) workspace.alias = 'host confirmed'
      return true
    }
    if (cmd === 'projects_list') return new Promise(resolve => scans.push({ roots: args?.codeRoots as string[], resolve }))
    return undefined
  } },
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

async function main() {
  assert.equal(projectPathKey('C:\\Code\\Repo\\'), projectPathKey('c:/code/repo'))
  assert.notEqual(projectPathKey('/Code/Repo'), projectPathKey('/code/repo'))
  assert.equal(projectParentDir('C:\\Repo'), 'C:/')
  assert.equal(projectParentDir('C:\\'), 'C:/')
  assert.equal(projectParentDir('/repo'), '/')
  assert.equal(projectParentDir('/'), '/')
  assert.equal(projectParentDir('\\\\server\\share\\repo'), '//server/share')
  assert.equal(projectParentDir('\\\\server\\share'), '//server/share')

  const { workspaceStore } = await import('../renderer/src/stores/workspace-store')
  const { projectsStore } = await import('../renderer/src/stores/projects-store')
  const apply = (value: Snapshot) => (workspaceStore as any).applySerializedData(JSON.stringify(value))
  const original: Snapshot = {
    workspaces: [{ id: 'repo', name: 'Repo', folderPath: 'C:/Code/Repo', createdAt: 1 }],
    terminals: [{ id: 'agent', workspaceId: 'repo', type: 'terminal', agentPreset: 'claude-code',
      cwd: 'C:/Code/Repo', title: 'Claude Agent', sdkSessionId: 'sdk-original', permissionMode: 'plan' }],
    activeWorkspaceId: 'repo', activeTerminalId: 'agent',
  }
  hostState = structuredClone(original)
  apply(original)
  workspaceStore.setViewedRemoteProfileId('default')
  workspaceStore.setViewedRemoteOrigin('host-a:9876')

  let release!: () => void
  holdSave = new Promise(resolve => { release = resolve })
  const before = JSON.stringify(workspaceStore.getState())
  const pending = workspaceStore.openProject('c:\\code\\repo\\', 'Other spelling')
  await tick()
  assert.equal(saving, true)
  assert.equal(JSON.stringify(workspaceStore.getState()), before, 'remote drafts must not alter the rendered state before host confirmation')
  release()
  await pending
  holdSave = null
  assert.equal(workspaceStore.getState().workspaces.length, 1)
  assert.equal(workspaceStore.getState().terminals.length, 1)
  assert.equal(workspaceStore.getState().workspaces[0].alias, 'host confirmed')
  assert.equal(workspaceStore.getState().focusedTerminalId, 'agent')
  assert.equal(hostState.terminals[0].sdkSessionId, 'sdk-original')
  assert.equal(hostState.terminals[0].permissionMode, 'plan')

  rejectSave = true
  const rejectedBefore = JSON.stringify(workspaceStore.getState())
  await assert.rejects(workspaceStore.openProject('C:/Code/New', 'New'), /Host rejected/)
  assert.equal(JSON.stringify(workspaceStore.getState()), rejectedBefore, 'a rejected remote mutation leaves no ghost workspace or agent')
  rejectSave = false
  await Promise.all([workspaceStore.openProject('C:/Code/New', 'New'), workspaceStore.openProject('c:\\code\\new', 'New')])
  assert.equal(hostState.workspaces.length, 2, 'queued opens re-read the confirmed snapshot and reuse an existing project')
  assert.equal(hostState.terminals.length, 2)

  const saveCount = calls.filter(cmd => cmd === 'workspace_save').length
  await workspaceStore.openProject('C:/Code/Repo', 'Repo')
  await tick()
  assert.equal(calls.filter(cmd => cmd === 'workspace_save').length, saveCount + 1,
    'selecting another existing workspace must not auto-save its detached draft before the explicit host write')
  assert.equal(workspaceStore.getState().focusedTerminalId, 'agent')

  const localBefore = workspaceStore.getState().terminals[0]
  localBefore.pid = 123
  workspaceStore.setViewedRemoteProfileId(null)
  await workspaceStore.openProject('c:/code/repo', 'Repo')
  assert.equal(workspaceStore.getState().terminals[0], localBefore, 'local focus retains mounted terminal runtime objects')
  assert.equal(workspaceStore.getState().terminals[0].pid, 123)

  // The project cache must be fresh on expansion, ignore closed/superseded
  // scans, and separate remote origins even when their code roots match.
  const project = (name: string) => ({ id: name, name, root: name, worktrees: [], sessionCount: 0, hasSessions: false })
  const unsubscribe = projectsStore.subscribe(() => {})
  assert.equal(scans.length, 1)
  assert.deepEqual(scans[0].roots, ['C:/Code'])
  unsubscribe()
  scans[0].resolve({ projects: [project('stale closed scan')] })
  await tick()
  assert.equal(projectsStore.getState().projects.length, 0)

  const unsubscribeAgain = projectsStore.subscribe(() => {})
  assert.equal(scans.length, 2)
  scans[1].resolve({ projects: [project('fresh')] })
  await tick()
  assert.equal(projectsStore.getState().projects[0].name, 'fresh')
  const older = projectsStore.refresh()
  const newer = projectsStore.refresh()
  scans[3].resolve({ projects: [project('newer')] })
  await newer
  scans[2].resolve({ projects: [project('older')] })
  await older
  assert.equal(projectsStore.getState().projects[0].name, 'newer')

  workspaceStore.setViewedRemoteProfileId('default')
  workspaceStore.setViewedRemoteOrigin('host-b:9876')
  assert.equal(projectsStore.getState().projects.length, 0, 'changing the binding clears cached projects before a new workspace snapshot arrives')
  apply(hostState)
  assert.equal(scans.length, 6)
  assert.equal(projectsStore.getState().projects.length, 0, 'do not show another host\'s cached projects during a new scan')
  scans[4].resolve({ projects: [project('stale binding')] })
  scans[5].resolve({ projects: [project('host b')] })
  await tick()
  assert.equal(projectsStore.getState().projects[0].name, 'host b')
  unsubscribeAgain()
  assert.ok(calls.includes('projects_list'))
  console.log('projects sidebar: passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
