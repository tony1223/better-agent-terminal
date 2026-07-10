// Unit tests for renderer/src/host-api.ts.
//
// Run with: pnpm exec tsx tests/host-api.test.ts
// (or via the test:host-api script).

import * as assert from 'node:assert/strict'

// jsdom-free: we synthesise a globalThis.window that the adapter inspects.
type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
type WinShape = {
  batAppAPI?: unknown
  __TAURI_INTERNALS__?: { invoke?: TauriInvoke }
  __TAURI__?: unknown
  location?: { search?: string }
  localStorage?: { getItem: (key: string) => string | null }
}
const setWindow = (shape: WinShape | undefined) => {
  ;(globalThis as { window?: WinShape | undefined }).window = shape
}

// Force a fresh module per scenario so the adapter's cached host gets reset.
async function loadFreshAdapter() {
  const url = new URL('../renderer/src/host-api.ts', import.meta.url)
  const cacheBust = `${url.href}?t=${Date.now()}-${Math.random()}`
  return import(cacheBust)
}

function stripBestEffortDebugModeCall<T extends { cmd: string }>(calls: T[]): T[] {
  return calls.filter(call => ![
    'debug_is_debug_mode',
    'debug_is_pty_input_trace',
  ].includes(call.cmd))
}

async function run() {
  // 1) No window -> getHostKind === 'unknown'
  setWindow(undefined)
  {
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'unknown')
    assert.equal(mod.isTauri(), false)
    assert.throws(() => (mod.host as { settings: { load: () => unknown } }).settings.load(),
      /no Tauri host runtime detected/)
  }

  // 2) Tauri detection routes ported namespaces through invoke
  {
    const invokeCalls: { cmd: string; args?: Record<string, unknown> }[] = []
    const invoke: TauriInvoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args })
      // Mirror Rust return shapes for the commands we care about.
      if (cmd === 'debug_is_debug_mode') return false as unknown as T
      if (cmd === 'debug_is_pty_input_trace') return false as unknown as T
      if (cmd === 'settings_load') return null as unknown as T
      if (cmd === 'settings_save') return undefined as unknown as T
      if (cmd === 'shell_open_external') return undefined as unknown as T
      if (cmd === 'shell_open_path') return undefined as unknown as T
      if (cmd === 'dialog_confirm') return true as unknown as T
      if (cmd === 'fs_read_file') return { content: 'hello' } as unknown as T
      if (cmd === 'settings_get_shell_path') return '/bin/zsh' as unknown as T
      if (cmd === 'settings_clear_terminal_history') return true as unknown as T
      if (cmd === 'dialog_select_folder') return ['C:/picked/folder'] as unknown as T
      if (cmd === 'dialog_select_files') return ['C:/picked/a.txt', 'C:/picked/b.txt'] as unknown as T
      if (cmd === 'dialog_select_images') return ['C:/picked/a.png'] as unknown as T
      if (cmd === 'clipboard_save_image') return '/tmp/bat-clipboard-1.png' as unknown as T
      if (cmd === 'clipboard_write_image') return true as unknown as T
      if (cmd === 'clipboard_write_text') return true as unknown as T
      if (cmd === 'fs_home') return '/home/me' as unknown as T
      if (cmd === 'fs_readdir') return [{ name: 'src', path: '/x/src', isDirectory: true }] as unknown as T
      if (cmd === 'fs_list_dirs') return { current: '/x', parent: null, entries: [] } as unknown as T
      if (cmd === 'fs_mkdir') return { path: '/x/foo' } as unknown as T
      if (cmd === 'fs_delete_path') return { path: '/x/foo' } as unknown as T
      if (cmd === 'fs_quick_locations') return [{ name: 'Home', path: '/home/me', kind: 'home' }] as unknown as T
      if (cmd === 'fs_search') return [{ name: 'hit.txt', path: '/x/hit.txt', isDirectory: false }] as unknown as T
      if (cmd === 'fs_resolve_path_links') {
        return [{ rawPath: 'src/main.ts:3', path: '/x/src/main.ts', exists: true, line: 3 }] as unknown as T
      }
      if (cmd === 'fs_watch') return true as unknown as T
      if (cmd === 'fs_unwatch') return true as unknown as T
      if (cmd === 'image_read_as_data_url') return 'data:image/png;base64,xx' as unknown as T
      if (cmd === 'image_save_data_url') return '/x/saved.png' as unknown as T
      if (cmd === 'pty_create') return 'term-1' as unknown as T
      if (cmd === 'pty_write') return undefined as unknown as T
      if (cmd === 'pty_resize') return undefined as unknown as T
      if (cmd === 'pty_get_viewport_state') {
        return {
          mode: 'desktop',
          cols: 120,
          rows: 32,
          updatedBy: 'desktop',
          updatedAt: 1,
        } as unknown as T
      }
      if (cmd === 'pty_set_viewport_mode') {
        return {
          mode: args?.mode,
          cols: args?.mode === 'mobile' ? 56 : 120,
          rows: args?.mode === 'mobile' ? 24 : 32,
          updatedBy: 'desktop',
          updatedAt: 2,
        } as unknown as T
      }
      if (cmd === 'pty_set_viewport_size') {
        return {
          mode: 'mobile',
          cols: args?.cols,
          rows: args?.rows,
          updatedBy: args?.source,
          updatedAt: 3,
        } as unknown as T
      }
      if (cmd === 'pty_kill') return undefined as unknown as T
      if (cmd === 'pty_restart') return true as unknown as T
      if (cmd === 'pty_get_cwd') return '/x' as unknown as T
      if (cmd === 'workspace_load') return null as unknown as T
      if (cmd === 'workspace_save') return true as unknown as T
      if (cmd === 'workspace_detach') return true as unknown as T
      if (cmd === 'workspace_reattach') return true as unknown as T
      if (cmd === 'workspace_move_to_window') return true as unknown as T
      if (cmd === 'update_get_version') return '0.1.0' as unknown as T
      if (cmd === 'update_check') {
        return { hasUpdate: false, currentVersion: '0.1.0', latestRelease: null } as unknown as T
      }
      if (cmd === 'debug_log') return undefined as unknown as T
      if (cmd === 'debug_open_logs_folder') return true as unknown as T
      if (cmd === 'git_get_github_url') return 'https://github.com/owner/repo' as unknown as T
      if (cmd === 'git_get_branch') return 'main' as unknown as T
      if (cmd === 'git_get_log') {
        return [{ hash: 'h1', author: 'a', date: 'd', message: 'm' }] as unknown as T
      }
      if (cmd === 'git_get_diff') return 'diff --git a/x b/x\n' as unknown as T
      if (cmd === 'git_get_diff_files') {
        return [{ status: 'M', file: 'a.ts' }] as unknown as T
      }
      if (cmd === 'git_get_root') return '/repo' as unknown as T
      if (cmd === 'git_get_status') {
        return [{ status: 'M', file: 'a.ts' }] as unknown as T
      }
      if (cmd === 'app_get_window_id') return 'main' as unknown as T
      if (cmd === 'app_get_window_index') return 1 as unknown as T
      if (cmd === 'app_get_launch_profile') return null as unknown as T
      if (cmd === 'app_get_window_profile') return null as unknown as T
      if (cmd === 'app_new_window') return 'main' as unknown as T
      if (cmd === 'app_focus_next_window') return false as unknown as T
      if (cmd === 'app_open_new_instance') return { alreadyOpen: true } as unknown as T
      if (cmd === 'app_restore_active_profiles') return ['profile-y'] as unknown as T
      if (cmd === 'app_resolve_profile_window_close') return true as unknown as T
      if (cmd === 'app_set_dock_badge') return undefined as unknown as T
      if (cmd === 'notification_list') return [] as unknown as T
      if (cmd === 'notification_mark_read') return true as unknown as T
      if (cmd === 'notification_mark_all_read') return true as unknown as T
      if (cmd === 'notification_mark_window_read') return true as unknown as T
      if (cmd === 'notification_clear') return true as unknown as T
      if (cmd === 'notification_focus_latest_unread') return null as unknown as T
      if (cmd === 'notification_focus_entry') return null as unknown as T
      if (cmd === 'github_check_cli') {
        return { installed: true, authenticated: true } as unknown as T
      }
      if (cmd === 'github_pr_list') return [] as unknown as T
      if (cmd === 'github_issue_list') return [] as unknown as T
      if (cmd === 'github_pr_view') return { number: 1 } as unknown as T
      if (cmd === 'github_issue_view') return { number: 2 } as unknown as T
      if (cmd === 'github_pr_comment') return { success: true } as unknown as T
      if (cmd === 'github_issue_comment') return { success: true } as unknown as T
      if (cmd === 'snippet_get_all') return [] as unknown as T
      if (cmd === 'snippet_get_by_id') return null as unknown as T
      if (cmd === 'snippet_get_favorites') return [] as unknown as T
      if (cmd === 'snippet_search') return [] as unknown as T
      if (cmd === 'snippet_get_by_workspace') return [] as unknown as T
      if (cmd === 'snippet_get_categories') return ['env', 'k8s'] as unknown as T
      if (cmd === 'snippet_create') return { id: 1 } as unknown as T
      if (cmd === 'snippet_update') return { id: 1 } as unknown as T
      if (cmd === 'snippet_delete') return true as unknown as T
      if (cmd === 'snippet_toggle_favorite') return { id: 1 } as unknown as T
      if (cmd === 'profile_list') {
        return { profiles: [{ id: 'default', name: 'Default', type: 'local' }], activeProfileIds: ['default'] } as unknown as T
      }
      if (cmd === 'profile_list_local') {
        return { profiles: [{ id: 'default', name: 'Default', type: 'local' }], activeProfileIds: ['default'] } as unknown as T
      }
      if (cmd === 'profile_get') return { id: 'default', name: 'Default' } as unknown as T
      if (cmd === 'profile_get_active_ids') return ['default'] as unknown as T
      if (cmd === 'profile_create') return { id: 'default', name: 'New' } as unknown as T
      if (cmd === 'profile_save') return true as unknown as T
      if (cmd === 'profile_load') return null as unknown as T
      if (cmd === 'profile_delete') return false as unknown as T
      if (cmd === 'profile_rename') return false as unknown as T
      if (cmd === 'profile_update') return false as unknown as T
      if (cmd === 'profile_duplicate') return null as unknown as T
      if (cmd === 'profile_activate') return undefined as unknown as T
      if (cmd === 'profile_deactivate') return undefined as unknown as T
      if (cmd === 'claude_auth_status') return null as unknown as T
      if (cmd === 'claude_account_list') {
        return { accounts: [], activeAccountId: null, switchWarningShown: false } as unknown as T
      }
      if (cmd === 'claude_start_session') return { ok: true, sessionId: 's-1' } as unknown as T
      if (cmd === 'claude_send_message') return { ok: true } as unknown as T
      if (cmd === 'claude_stop_session') return { ok: true, existed: true } as unknown as T
      if (cmd === 'claude_abort_session') return { ok: true } as unknown as T
      if (cmd === 'claude_stop_task') return true as unknown as T
      if (cmd === 'claude_resume_session') return { ok: true } as unknown as T
      if (cmd === 'claude_auth_login') return { success: false, error: 'stub' } as unknown as T
      if (cmd === 'claude_auth_logout') return { success: true } as unknown as T
      if (cmd === 'claude_account_import_current') return null as unknown as T
      if (cmd === 'claude_account_login_new') return { success: false, error: 'stub' } as unknown as T
      if (cmd === 'claude_account_switch') return false as unknown as T
      if (cmd === 'claude_account_remove') return false as unknown as T
      if (cmd === 'claude_account_mark_warning_shown') return true as unknown as T
      if (cmd === 'claude_get_cli_path') return '' as unknown as T
      if (cmd === 'claude_list_sessions') return [] as unknown as T
      if (cmd === 'claude_scan_skills') return [] as unknown as T
      if (cmd === 'claude_cleanup_worktree') return true as unknown as T
      if (cmd === 'claude_set_auto_continue') return true as unknown as T
      if (cmd === 'claude_get_auto_continue') return { enabled: false, max: 0, used: 0, prompt: '' } as unknown as T
      if (cmd === 'claude_set_permission_mode') return true as unknown as T
      if (cmd === 'claude_set_codex_sandbox_mode') return true as unknown as T
      if (cmd === 'claude_set_codex_approval_policy') return true as unknown as T
      if (cmd === 'claude_set_model') return true as unknown as T
      if (cmd === 'claude_set_effort') return true as unknown as T
      if (cmd === 'claude_reset_session') return true as unknown as T
      if (cmd === 'claude_get_supported_models') return [] as unknown as T
      if (cmd === 'claude_get_supported_efforts') return [] as unknown as T
      if (cmd === 'claude_get_supported_codex_sandbox_modes') return [] as unknown as T
      if (cmd === 'claude_get_supported_codex_approval_policies') return [] as unknown as T
      if (cmd === 'claude_get_supported_commands') return [] as unknown as T
      if (cmd === 'claude_get_supported_agents') return [] as unknown as T
      if (cmd === 'claude_get_account_info') return null as unknown as T
      if (cmd === 'claude_get_session_state') return null as unknown as T
      if (cmd === 'claude_get_session_meta') return null as unknown as T
      if (cmd === 'claude_get_context_usage') return null as unknown as T
      if (cmd === 'claude_get_worktree_status') return null as unknown as T
      if (cmd === 'claude_channel_get_capabilities') return { supported: false } as unknown as T
      if (cmd === 'claude_channel_start_session') return { ok: true, sessionId: 'ch-1' } as unknown as T
      if (cmd === 'claude_channel_send_message') return { ok: true, messageId: 'm-1' } as unknown as T
      if (cmd === 'claude_channel_stop_session') return { ok: true, existed: true } as unknown as T
      if (cmd === 'claude_channel_get_status') return { ok: true, status: 'ready' } as unknown as T
      if (cmd === 'claude_cli_get_capabilities') return { supported: false } as unknown as T
      if (cmd === 'claude_cli_start_session') return { ok: true, sessionId: 'cli-1' } as unknown as T
      if (cmd === 'claude_cli_stop_session') return { ok: true, existed: true } as unknown as T
      if (cmd === 'claude_cli_get_status') return { ok: true, status: 'ready' } as unknown as T
      if (cmd === 'worktree_create') return { success: false, error: 'stub' } as unknown as T
      if (cmd === 'worktree_remove') return { success: false, error: 'stub' } as unknown as T
      if (cmd === 'worktree_status') return null as unknown as T
      if (cmd === 'worktree_merge') return { success: false, error: 'stub' } as unknown as T
      if (cmd === 'worktree_rehydrate') return { success: false } as unknown as T
      if (cmd === 'agent_list_presets') return [] as unknown as T
      if (cmd === 'worker_buffer_init') return true as unknown as T
      if (cmd === 'worker_buffer_append') return true as unknown as T
      if (cmd === 'worker_buffer_read_all') return '' as unknown as T
      if (cmd === 'worker_buffer_clear') return true as unknown as T
      if (cmd === 'remote_start_server') return { error: 'stub' } as unknown as T
      if (cmd === 'remote_stop_server') return false as unknown as T
      if (cmd === 'remote_server_status') {
        return { running: false, port: null, fingerprint: null, bindInterface: null, boundHost: null, clients: [] } as unknown as T
      }
      if (cmd === 'remote_connect') return { error: 'stub' } as unknown as T
      if (cmd === 'remote_disconnect') return false as unknown as T
      if (cmd === 'remote_client_status') return { connected: false, info: null } as unknown as T
      if (cmd === 'remote_test_connection') return { ok: false, error: 'stub' } as unknown as T
      if (cmd === 'remote_list_profiles') return { error: 'stub' } as unknown as T
      if (cmd === 'tunnel_get_connection') return { error: 'stub' } as unknown as T
      throw new Error(`unexpected invoke: ${cmd}`)
    }
    setWindow({ __TAURI_INTERNALS__: { invoke } })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'tauri')
    assert.equal(mod.isTauri(), true)
    assert.ok(
      ['win32', 'darwin', 'linux'].includes(mod.host.platform),
      `unexpected platform: ${mod.host.platform}`,
    )
    assert.equal(mod.host.systemVersion, '')

    const loaded = await mod.host.settings.load()
    assert.equal(loaded, null)

    await mod.host.settings.save('{"theme":"dark"}')
    await mod.host.shell.openExternal('https://example.com')
    await mod.host.shell.openPath('C:/Users/me/project')
    assert.equal(
      mod.host.shell.getPathForFile({ path: 'C:\\Users\\me\\drop' } as unknown as File),
      'C:\\Users\\me\\drop',
    )
    assert.equal(
      mod.host.shell.getPathForFile({ webkitRelativePath: 'drop/file.txt' } as unknown as File),
      null,
    )
    mod.registerTauriDroppedPaths(['C:\\Users\\me\\dropped-folder'])
    assert.equal(
      mod.host.shell.getPathForFile({ name: 'dropped-folder' } as unknown as File),
      'C:\\Users\\me\\dropped-folder',
    )
    // Cached native paths are one-shot and ambiguous same-name drops are ignored.
    assert.equal(
      mod.host.shell.getPathForFile({ name: 'dropped-folder' } as unknown as File),
      null,
    )
    mod.registerTauriDroppedPaths(['C:\\a\\same-name', 'D:\\b\\same-name'])
    assert.equal(
      mod.host.shell.getPathForFile({ name: 'same-name' } as unknown as File),
      null,
    )
    const ok = await mod.host.dialog.confirm('Proceed?', 'Heads up')
    assert.equal(ok, true)
    // title is optional — the adapter passes undefined through.
    await mod.host.dialog.confirm('Just a message')

    const fsResult = await mod.host.fs.readFile('C:/Users/me/notes.txt')
    assert.deepEqual(fsResult, { content: 'hello' })

    const shellPath = await mod.host.settings.getShellPath('zsh')
    assert.equal(shellPath, '/bin/zsh')
    assert.equal(await mod.host.settings.clearTerminalHistory(), true)

    const folder = await mod.host.dialog.selectFolder()
    assert.deepEqual(folder, ['C:/picked/folder'])
    const files = await mod.host.dialog.selectFiles()
    assert.deepEqual(files, ['C:/picked/a.txt', 'C:/picked/b.txt'])
    const images = await mod.host.dialog.selectImages()
    assert.deepEqual(images, ['C:/picked/a.png'])

    const wrote = await mod.host.clipboard.writeText('hello clipboard')
    assert.equal(wrote, true)
    assert.equal(await mod.host.clipboard.saveImage(), '/tmp/bat-clipboard-1.png')
    assert.equal(await mod.host.clipboard.writeImage('/tmp/bat-clipboard-1.png'), true)

    const home = await mod.host.fs.home()
    assert.equal(home, '/home/me')
    const dirs = await mod.host.fs.readdir('/x')
    assert.deepEqual(dirs, [{ name: 'src', path: '/x/src', isDirectory: true }])
    const ls = await mod.host.fs.listDirs('/x', true)
    assert.deepEqual(ls, { current: '/x', parent: null, entries: [] })
    const made = await mod.host.fs.mkdir('/x', 'foo')
    assert.deepEqual(made, { path: '/x/foo' })
    const removed = await mod.host.fs.deletePath('/x/foo')
    assert.deepEqual(removed, { path: '/x/foo' })
    const ql = await mod.host.fs.quickLocations()
    assert.deepEqual(ql, [{ name: 'Home', path: '/home/me', kind: 'home' }])
    const found = await mod.host.fs.search('/x', 'hit')
    assert.deepEqual(found, [{ name: 'hit.txt', path: '/x/hit.txt', isDirectory: false }])
    assert.deepEqual(await mod.host.fs.resolvePathLinks('/x', ['src/main.ts:3']), [
      { rawPath: 'src/main.ts:3', path: '/x/src/main.ts', exists: true, line: 3 },
    ])
    assert.equal(await mod.host.fs.watch('/x'), true)
    assert.equal(await mod.host.fs.unwatch('/x'), true)
    const unsubFsChanged = mod.host.fs.onChanged(() => {})
    assert.equal(typeof unsubFsChanged, 'function')
    unsubFsChanged()

    const dataUrl = await mod.host.image.readAsDataUrl('/x/img.png')
    assert.equal(dataUrl, 'data:image/png;base64,xx')
    assert.equal(await mod.host.image.saveDataUrl('data:image/png;base64,xx', 'saved.png'), '/x/saved.png')

    const ptyId = await mod.host.pty.create({
      id: 'term-1', cwd: '/x', type: 'terminal',
    } as unknown as Parameters<typeof mod.host.pty.create>[0])
    assert.equal(ptyId, 'term-1')
    await mod.host.pty.write('term-1', 'echo hi\n')
    await mod.host.pty.resize('term-1', 120, 32)
    assert.deepEqual(await mod.host.pty.getViewportState('term-1'), {
      mode: 'desktop',
      cols: 120,
      rows: 32,
      updatedBy: 'desktop',
      updatedAt: 1,
    })
    assert.deepEqual(await mod.host.pty.setViewportMode('term-1', 'mobile', {
      cols: 56,
      rows: 24,
      source: 'desktop',
    }), {
      mode: 'mobile',
      cols: 56,
      rows: 24,
      updatedBy: 'desktop',
      updatedAt: 2,
    })
    assert.deepEqual(await mod.host.pty.setViewportSize('term-1', 48, 24, 'mobile'), {
      mode: 'mobile',
      cols: 48,
      rows: 24,
      updatedBy: 'mobile',
      updatedAt: 3,
    })
    await mod.host.pty.kill('term-1')
    assert.equal(await mod.host.pty.restart('term-1', '/x', '/bin/zsh'), true)
    assert.equal(await mod.host.pty.getCwd('term-1'), '/x')

    const wsLoaded = await mod.host.workspace.load()
    assert.equal(wsLoaded, null)
    const wsSaved = await mod.host.workspace.save('{"workspaces":[]}')
    assert.equal(wsSaved, true)
    assert.equal(await mod.host.workspace.detach('workspace-1'), true)
    assert.equal(await mod.host.workspace.reattach('workspace-1'), true)
    assert.equal(await mod.host.workspace.moveToWindow('main', 'win-2', 'workspace-1', 0), true)
    const unsubWorkspaceDetached = mod.host.workspace.onDetached(() => {})
    assert.equal(typeof unsubWorkspaceDetached, 'function')
    unsubWorkspaceDetached()
    const unsubWorkspaceReattached = mod.host.workspace.onReattached(() => {})
    assert.equal(typeof unsubWorkspaceReattached, 'function')
    unsubWorkspaceReattached()
    const unsubWorkspaceReload = mod.host.workspace.onReload(() => {})
    assert.equal(typeof unsubWorkspaceReload, 'function')
    unsubWorkspaceReload()
    // workspace.getDetachedId is synchronous and always null under Tauri.
    assert.equal(mod.host.workspace.getDetachedId(), null)

    const version = await mod.host.update.getVersion()
    assert.equal(version, '0.1.0')
    // update.check now routes through the sidecar.
    const updateInfo = await mod.host.update.check()
    assert.deepEqual(updateInfo, { hasUpdate: false, currentVersion: '0.1.0', latestRelease: null })
    // Renderer log forwarding takes any arg shape and packs into `args`.
    await mod.host.debug.log('boot', { phase: 1 }, 42)
    assert.equal(await mod.host.debug.openLogsFolder(), true)

    // git.* — read-only ops mirroring the Electron handlers.
    const ghUrl = await mod.host.git.getGithubUrl('/repo')
    assert.equal(ghUrl, 'https://github.com/owner/repo')
    const branch = await mod.host.git.getBranch('/repo')
    assert.equal(branch, 'main')
    const log = await mod.host.git.getLog('/repo', 25)
    assert.deepEqual(log, [{ hash: 'h1', author: 'a', date: 'd', message: 'm' }])
    // count is optional — undefined still flows through to invoke
    await mod.host.git.getLog('/repo')
    const diff = await mod.host.git.getDiff('/repo', 'abc', 'a.ts')
    assert.equal(diff, 'diff --git a/x b/x\n')
    // commit + filePath both optional
    await mod.host.git.getDiff('/repo')
    const diffFiles = await mod.host.git.getDiffFiles('/repo', 'abc')
    assert.deepEqual(diffFiles, [{ status: 'M', file: 'a.ts' }])
    await mod.host.git.getDiffFiles('/repo')
    const root = await mod.host.git.getRoot('/repo')
    assert.equal(root, '/repo')
    const status = await mod.host.git.getStatus('/repo')
    assert.deepEqual(status, [{ status: 'M', file: 'a.ts' }])

    // app.* — Tauri window/profile shell.
    assert.equal(await mod.host.app.getWindowId(), 'main')
    assert.equal(await mod.host.app.getWindowIndex(), 1)
    assert.equal(await mod.host.app.getLaunchProfile(), null)
    assert.equal(await mod.host.app.getWindowProfile(), null)
    assert.equal(await mod.host.app.newWindow(), 'main')
    assert.equal(await mod.host.app.focusNextWindow(), false)
    const newInst = await mod.host.app.openNewInstance('profile-x')
    assert.deepEqual(newInst, { alreadyOpen: true })
    assert.deepEqual(await mod.host.app.restoreActiveProfiles('profile-x'), ['profile-y'])
    assert.equal(await mod.host.app.resolveProfileWindowClose('temporary'), true)
    const unsubProfileWindowClose = mod.host.app.onProfileWindowCloseRequested(() => {})
    assert.equal(typeof unsubProfileWindowClose, 'function')
    unsubProfileWindowClose()
    await mod.host.app.setDockBadge(7)

    // notification.* — in-memory store on the Rust side.
    assert.deepEqual(await mod.host.notification.list(), [])
    assert.equal(await mod.host.notification.markRead('n1'), true)
    assert.equal(await mod.host.notification.markAllRead(), true)
    assert.equal(await mod.host.notification.markWindowRead(), true)
    assert.equal(await mod.host.notification.clear(), true)
    assert.equal(await mod.host.notification.focusLatestUnread(), null)
    assert.equal(await mod.host.notification.focusEntry('n1'), null)
    // onUpdate returns a synchronous unsubscriber; the underlying
    // listen() never resolves in this stub-free environment, but
    // the unsub is still callable.
    const unsubNotif = mod.host.notification.onUpdate(() => {})
    assert.equal(typeof unsubNotif, 'function')
    unsubNotif()

    // system.onResume — Tauri build returns a no-op unsub.
    const unsubResume = mod.host.system.onResume(() => {})
    assert.equal(typeof unsubResume, 'function')
    assert.equal(unsubResume(), undefined)

    // github.* — shells out to gh CLI on the Rust side.
    const cli = await mod.host.github.checkCli()
    assert.deepEqual(cli, { installed: true, authenticated: true })
    assert.deepEqual(await mod.host.github.listPRs('/repo'), [])
    assert.deepEqual(await mod.host.github.listIssues('/repo'), [])
    assert.deepEqual(await mod.host.github.viewPR('/repo', 42), { number: 1 })
    assert.deepEqual(await mod.host.github.viewIssue('/repo', 7), { number: 2 })
    assert.deepEqual(
      await mod.host.github.commentPR('/repo', 42, 'lgtm'),
      { success: true },
    )
    assert.deepEqual(
      await mod.host.github.commentIssue('/repo', 7, 'thx'),
      { success: true },
    )

    // snippet.* — JSON-backed env snippet store on the Rust side.
    assert.deepEqual(await mod.host.snippet.getAll(), [])
    assert.equal(await mod.host.snippet.getById(1), null)
    assert.deepEqual(await mod.host.snippet.getFavorites(), [])
    assert.deepEqual(await mod.host.snippet.search('foo'), [])
    assert.deepEqual(await mod.host.snippet.getByWorkspace('ws-1'), [])
    // workspaceId is optional — undefined still flows through.
    await mod.host.snippet.getByWorkspace()
    assert.deepEqual(await mod.host.snippet.getCategories(), ['env', 'k8s'])
    const created = await mod.host.snippet.create({ title: 't', content: 'c' })
    assert.deepEqual(created, { id: 1 })
    const updated = await mod.host.snippet.update(1, { title: 'new' })
    assert.deepEqual(updated, { id: 1 })
    assert.equal(await mod.host.snippet.delete(1), true)
    const toggled = await mod.host.snippet.toggleFavorite(1)
    assert.deepEqual(toggled, { id: 1 })

    // profile.* — single-window MVP returns one default profile.
    const plist = await mod.host.profile.list()
    assert.deepEqual(plist, {
      profiles: [{ id: 'default', name: 'Default', type: 'local' }],
      activeProfileIds: ['default'],
    })
    await mod.host.profile.listLocal()
    assert.deepEqual(await mod.host.profile.get('default'), { id: 'default', name: 'Default' })
    assert.deepEqual(await mod.host.profile.getActiveIds(), ['default'])
    await mod.host.profile.create('New')
    // create with options
    await mod.host.profile.create('Remote', { type: 'remote' })
    assert.equal(await mod.host.profile.save('default'), true)
    assert.equal(await mod.host.profile.load('default'), null)
    assert.equal(await mod.host.profile.delete('default'), false)
    assert.equal(await mod.host.profile.rename('default', 'X'), false)
    await mod.host.profile.update('default', { remoteHost: 'h' })
    assert.equal(await mod.host.profile.duplicate('default', 'Copy'), null)
    await mod.host.profile.activate('default')
    await mod.host.profile.deactivate('default')

    // claude.* — Phase 2 sidecar bridge. authStatus and accountList route
    // through the Rust SidecarState into the Node sidecar. The renderer
    // still sees Promise-returning methods identical to the Electron shape.
    assert.equal(await mod.host.claude.authStatus(), null)
    assert.deepEqual(await mod.host.claude.accountList(), {
      accounts: [], activeAccountId: null, switchWarningShown: false,
    })
    // Lifecycle: startSession, sendMessage, stopSession, abortSession.
    const started = await mod.host.claude.startSession('s-1', { cwd: '/x' })
    assert.deepEqual(started, { ok: true, sessionId: 's-1' })
    await mod.host.claude.sendMessage('s-1', 'hello')
    // sendMessage's optional images + autoCompactWindow are passed through.
    await mod.host.claude.sendMessage('s-1', 'with images', ['/img.png'], 4000)
    assert.deepEqual(await mod.host.claude.stopSession('s-1'), { ok: true, existed: true })
    await mod.host.claude.abortSession('s-1')
    assert.equal(await mod.host.claude.stopTask('s-1', 'task-1'), true)
    assert.deepEqual(
      await mod.host.claude.resumeSession(
        's-1',
        'sdk-1',
        '/cwd',
        'claude-sonnet-4-6',
        'v2',
        true,
        '/wt',
        'feat',
        'codex-agent-worktree',
        'workspace-write',
        'on-request',
        'plan',
        'high',
      ),
      { ok: true },
    )
    // Event listener registration returns a synchronous unsubscriber.
    const unsubMsg = mod.host.claude.onMessage(() => {})
    assert.equal(typeof unsubMsg, 'function')
    unsubMsg()
    // Three more event listeners added in slice 3.
    mod.host.claude.onStream(() => {})()
    mod.host.claude.onStatus(() => {})()
    mod.host.claude.onModeChange(() => {})()
    // Slice #38: 6 panel-state lifecycle listeners. They're in the
    // explicit eventListeners map (not the permissive fallback), so
    // each must register a real Tauri listen() and return a function
    // unsubscriber.
    for (const name of [
      'onHistory', 'onResumeLoading', 'onSessionReset',
      'onRateLimit', 'onWorktreeInfo', 'onPromptSuggestion',
    ] as const) {
      const unsub = (mod.host.claude as Record<string, (cb: unknown) => unknown>)[name](() => {})
      assert.equal(typeof unsub, 'function', `${name} should return an unsubscriber`)
      ;(unsub as () => void)()
    }
    assert.deepEqual(
      mod.resolveClaudeEventSecondArg('onHistory', { sessionId: 's-1', items: ['claude'] }),
      ['claude'],
    )
    assert.deepEqual(
      mod.resolveClaudeEventSecondArg('onHistory', { sessionId: 's-1', payload: ['codex'] }),
      ['codex'],
    )
    assert.equal(
      mod.resolveClaudeEventSecondArg('onResumeLoading', { sessionId: 's-1', payload: true }),
      true,
    )
    assert.equal(
      mod.resolveClaudeEventSecondArg('onSessionReset', { sessionId: 's-1', payload: 'ignored' }),
      undefined,
    )
    // Account / auth ops.
    assert.deepEqual(await mod.host.claude.authLogin(), { success: false, error: 'stub' })
    assert.deepEqual(await mod.host.claude.authLogout(), { success: true })
    assert.equal(await mod.host.claude.accountImportCurrent(), null)
    assert.deepEqual(await mod.host.claude.accountLoginNew(), { success: false, error: 'stub' })
    assert.equal(await mod.host.claude.accountSwitch('a-1'), false)
    assert.equal(await mod.host.claude.accountRemove('a-1'), false)
    assert.equal(await mod.host.claude.accountMarkWarningShown(), true)
    // Read-only metadata reaches the sidecar through stub returns.
    assert.equal(await mod.host.claude.getCliPath(), '')
    assert.deepEqual(await mod.host.claude.listSessions('/cwd'), [])
    assert.deepEqual(await mod.host.claude.listSessions('/cwd', 'codex'), [])
    assert.deepEqual(await mod.host.claude.scanSkills('/cwd'), [])
    assert.equal(await mod.host.claude.cleanupWorktree('s-1', true), true)
    assert.equal(await mod.host.claude.setAutoContinue('s-1', { enabled: true }), true)
    assert.deepEqual(await mod.host.claude.getAutoContinue('s-1'), { enabled: false, max: 0, used: 0, prompt: '' })
    assert.equal(await mod.host.claude.setPermissionMode('s-1', 'acceptEdits'), true)
    assert.equal(await mod.host.claude.setCodexSandboxMode('s-1', 'workspace-write'), true)
    assert.equal(await mod.host.claude.setCodexApprovalPolicy('s-1', 'on-request'), true)
    assert.equal(await mod.host.claude.setModel('s-1', 'claude-opus-4-7'), true)
    assert.equal(await mod.host.claude.setEffort('s-1', 'high'), true)
    assert.equal(await mod.host.claude.resetSession('s-1'), true)
    assert.deepEqual(await mod.host.claude.getSupportedModels('s-1'), [])
    assert.deepEqual(await mod.host.claude.getSupportedEfforts('s-1'), [])
    assert.deepEqual(await mod.host.claude.getSupportedCodexSandboxModes('s-1'), [])
    assert.deepEqual(await mod.host.claude.getSupportedCodexApprovalPolicies('s-1'), [])
    assert.deepEqual(await mod.host.claude.getSupportedCommands('s-1'), [])
    assert.deepEqual(await mod.host.claude.getSupportedAgents('s-1'), [])
    assert.equal(await mod.host.claude.getAccountInfo('s-1'), null)
    assert.equal(await mod.host.claude.getSessionState('s-1'), null)
    assert.equal(await mod.host.claude.getSessionMeta('s-1'), null)
    assert.equal(await mod.host.claude.getContextUsage('s-1'), null)
    assert.equal(await mod.host.claude.getWorktreeStatus('s-1'), null)

    // claudeChannel.* — debug-only experimental runtime surface.
    assert.deepEqual(await mod.host.claudeChannel.getCapabilities(), { supported: false })
    assert.deepEqual(await mod.host.claudeChannel.startSession('ch-1', { cwd: '/cwd' }), { ok: true, sessionId: 'ch-1' })
    assert.deepEqual(await mod.host.claudeChannel.sendMessage('ch-1', 'hello', 'm-1'), { ok: true, messageId: 'm-1' })
    assert.deepEqual(await mod.host.claudeChannel.getStatus('ch-1'), { ok: true, status: 'ready' })
    assert.deepEqual(await mod.host.claudeChannel.stopSession('ch-1'), { ok: true, existed: true })
    mod.host.claudeChannel.onMessage(() => {})()
    mod.host.claudeChannel.onStatus(() => {})()
    mod.host.claudeChannel.onTurnEnd(() => {})()
    // claudeCli.* — debug-only subscription CLI transcript runtime surface.
    assert.deepEqual(await mod.host.claudeCli.getCapabilities(), { supported: false })
    assert.deepEqual(await mod.host.claudeCli.startSession('cli-1', { cwd: '/cwd' }), { ok: true, sessionId: 'cli-1' })
    assert.deepEqual(await mod.host.claudeCli.getStatus('cli-1'), { ok: true, status: 'ready' })
    assert.deepEqual(await mod.host.claudeCli.stopSession('cli-1'), { ok: true, existed: true })
    mod.host.claudeCli.onMessage(() => {})()
    mod.host.claudeCli.onStatus(() => {})()
    mod.host.claudeCli.onTurnEnd(() => {})()

    // worktree.* — sidecar-routed. The fixture returns shaped failures so
    // this adapter test can focus on command names + payloads.
    assert.deepEqual(await mod.host.worktree.create('s-1', '/cwd'), {
      success: false, error: 'stub',
    })
    assert.deepEqual(await mod.host.worktree.remove('s-1', true), {
      success: false, error: 'stub',
    })
    assert.equal(await mod.host.worktree.status('s-1'), null)
    assert.deepEqual(await mod.host.worktree.merge('s-1', 'merge'), {
      success: false, error: 'stub',
    })
    assert.deepEqual(
      await mod.host.worktree.rehydrate('s-1', '/cwd', '/wt', 'feat'),
      { success: false },
    )

    // agent.listPresets — single call.
    assert.deepEqual(await mod.host.agent.listPresets(), [])

    // workerBuffer.* — Rust-backed in-process state.
    assert.equal(await mod.host.workerBuffer.init('p1'), true)
    assert.equal(await mod.host.workerBuffer.append('p1', 'line\n'), true)
    assert.equal(await mod.host.workerBuffer.readAll('p1'), '')
    assert.equal(await mod.host.workerBuffer.clear('p1'), true)

    // remote.* / tunnel.* — Phase 3 stubs returning shaped objects so the
    // renderer's polling clientStatus / serverStatus doesn't crash on
    // .connected / .running destructuring.
    assert.deepEqual(await mod.host.remote.startServer({ port: 9876 }), { error: 'stub' })
    assert.equal(await mod.host.remote.stopServer(), false)
    const srvStatus = await mod.host.remote.serverStatus()
    assert.equal((srvStatus as { running: boolean }).running, false)
    assert.deepEqual(await mod.host.remote.connect('h', 9876, 't', 'fp'), { error: 'stub' })
    // connect with optional label
    await mod.host.remote.connect('h', 9876, 't', 'fp', 'lbl')
    assert.equal(await mod.host.remote.disconnect(), false)
    assert.deepEqual(await mod.host.remote.clientStatus(), { connected: false, info: null })
    assert.deepEqual(await mod.host.remote.testConnection('h', 9876, 't', 'fp'), {
      ok: false, error: 'stub',
    })
    assert.deepEqual(await mod.host.remote.listProfiles('h', 9876, 't', 'fp'), { error: 'stub' })
    assert.deepEqual(await mod.host.tunnel.getConnection(), { error: 'stub' })

    const calledCommands = new Set(invokeCalls.map(call => call.cmd))
    for (const cmd of [
      'fs_resolve_path_links',
      'fs_watch',
      'fs_unwatch',
      'claude_stop_task',
      'claude_resume_session',
      'claude_set_codex_sandbox_mode',
      'claude_set_codex_approval_policy',
      'settings_clear_terminal_history',
      'image_save_data_url',
      'clipboard_save_image',
      'clipboard_write_image',
      'pty_get_viewport_state',
      'pty_set_viewport_mode',
      'pty_set_viewport_size',
      'pty_restart',
      'pty_get_cwd',
      'debug_open_logs_folder',
      'worktree_create',
      'worktree_rehydrate',
    ]) {
      assert.ok(calledCommands.has(cmd), `${cmd} must route through Tauri invoke`)
    }

    const sendMessageLogs = invokeCalls.filter(call =>
      call.cmd === 'debug_log'
      && Array.isArray((call.args as { args?: unknown[] } | undefined)?.args)
      && String((call.args as { args: unknown[] }).args[0]).startsWith('[tauri:claude.sendMessage]')
    )
    assert.equal(sendMessageLogs.length, 4, 'sendMessage should log start/end for both calls')
    const stableInvokeCalls = stripBestEffortDebugModeCall(
      invokeCalls.filter(call => !sendMessageLogs.includes(call))
    )

    assert.deepEqual(stableInvokeCalls, [
      { cmd: 'settings_load', args: undefined },
      { cmd: 'settings_save', args: { data: '{"theme":"dark"}' } },
      { cmd: 'shell_open_external', args: { url: 'https://example.com' } },
      { cmd: 'shell_open_path', args: { path: 'C:/Users/me/project' } },
      { cmd: 'dialog_confirm', args: { message: 'Proceed?', title: 'Heads up' } },
      { cmd: 'dialog_confirm', args: { message: 'Just a message', title: undefined } },
      { cmd: 'fs_read_file', args: { path: 'C:/Users/me/notes.txt' } },
      { cmd: 'settings_get_shell_path', args: { shellType: 'zsh' } },
      { cmd: 'settings_clear_terminal_history', args: undefined },
      { cmd: 'dialog_select_folder', args: undefined },
      { cmd: 'dialog_select_files', args: undefined },
      { cmd: 'dialog_select_images', args: undefined },
      { cmd: 'clipboard_write_text', args: { text: 'hello clipboard' } },
      { cmd: 'clipboard_save_image', args: undefined },
      { cmd: 'clipboard_write_image', args: { filePath: '/tmp/bat-clipboard-1.png' } },
      { cmd: 'fs_home', args: undefined },
      { cmd: 'fs_readdir', args: { dirPath: '/x' } },
      { cmd: 'fs_list_dirs', args: { dirPath: '/x', includeHidden: true } },
      { cmd: 'fs_mkdir', args: { parentPath: '/x', name: 'foo' } },
      { cmd: 'fs_delete_path', args: { targetPath: '/x/foo' } },
      { cmd: 'fs_quick_locations', args: undefined },
      { cmd: 'fs_search', args: { dirPath: '/x', query: 'hit' } },
      { cmd: 'fs_resolve_path_links', args: { cwd: '/x', rawPaths: ['src/main.ts:3'] } },
      { cmd: 'fs_watch', args: { dirPath: '/x' } },
      { cmd: 'fs_unwatch', args: { dirPath: '/x' } },
      { cmd: 'image_read_as_data_url', args: { path: '/x/img.png' } },
      { cmd: 'image_save_data_url', args: { dataUrl: 'data:image/png;base64,xx', defaultName: 'saved.png' } },
      { cmd: 'pty_create', args: { options: { id: 'term-1', cwd: '/x', type: 'terminal' } } },
      { cmd: 'pty_write', args: { id: 'term-1', data: 'echo hi\n' } },
      { cmd: 'pty_resize', args: { id: 'term-1', cols: 120, rows: 32 } },
      { cmd: 'pty_get_viewport_state', args: { id: 'term-1' } },
      {
        cmd: 'pty_set_viewport_mode',
        args: {
          id: 'term-1',
          mode: 'mobile',
          options: { cols: 56, rows: 24, source: 'desktop' },
        },
      },
      {
        cmd: 'pty_set_viewport_size',
        args: { id: 'term-1', cols: 48, rows: 24, source: 'mobile' },
      },
      { cmd: 'pty_kill', args: { id: 'term-1' } },
      { cmd: 'pty_restart', args: { id: 'term-1', cwd: '/x', shell: '/bin/zsh' } },
      { cmd: 'pty_get_cwd', args: { id: 'term-1' } },
      { cmd: 'workspace_load', args: undefined },
      { cmd: 'workspace_save', args: { data: '{"workspaces":[]}' } },
      { cmd: 'workspace_detach', args: { workspaceId: 'workspace-1' } },
      { cmd: 'workspace_reattach', args: { workspaceId: 'workspace-1' } },
      {
        cmd: 'workspace_move_to_window',
        args: {
          sourceWindowId: 'main',
          targetWindowId: 'win-2',
          workspaceId: 'workspace-1',
          insertIndex: 0,
        },
      },
      { cmd: 'update_get_version', args: undefined },
      { cmd: 'update_check', args: undefined },
      { cmd: 'debug_log', args: { args: ['boot', { phase: 1 }, 42] } },
      { cmd: 'debug_open_logs_folder', args: undefined },
      { cmd: 'git_get_github_url', args: { folderPath: '/repo' } },
      { cmd: 'git_get_branch', args: { cwd: '/repo' } },
      { cmd: 'git_get_log', args: { cwd: '/repo', count: 25 } },
      { cmd: 'git_get_log', args: { cwd: '/repo', count: undefined } },
      { cmd: 'git_get_diff', args: { cwd: '/repo', commitHash: 'abc', filePath: 'a.ts' } },
      { cmd: 'git_get_diff', args: { cwd: '/repo', commitHash: undefined, filePath: undefined } },
      { cmd: 'git_get_diff_files', args: { cwd: '/repo', commitHash: 'abc' } },
      { cmd: 'git_get_diff_files', args: { cwd: '/repo', commitHash: undefined } },
      { cmd: 'git_get_root', args: { cwd: '/repo' } },
      { cmd: 'git_get_status', args: { cwd: '/repo' } },
      { cmd: 'app_get_window_id', args: undefined },
      { cmd: 'app_get_window_index', args: undefined },
      { cmd: 'app_get_launch_profile', args: undefined },
      { cmd: 'app_get_window_profile', args: undefined },
      { cmd: 'app_new_window', args: undefined },
      { cmd: 'app_focus_next_window', args: undefined },
      { cmd: 'app_open_new_instance', args: { profileId: 'profile-x' } },
      { cmd: 'app_restore_active_profiles', args: { currentProfileId: 'profile-x' } },
      { cmd: 'app_resolve_profile_window_close', args: { action: 'temporary' } },
      { cmd: 'app_set_dock_badge', args: { count: 7 } },
      { cmd: 'notification_list', args: undefined },
      { cmd: 'notification_mark_read', args: { id: 'n1' } },
      { cmd: 'notification_mark_all_read', args: undefined },
      { cmd: 'notification_mark_window_read', args: undefined },
      { cmd: 'notification_clear', args: undefined },
      { cmd: 'notification_focus_latest_unread', args: undefined },
      { cmd: 'notification_focus_entry', args: { id: 'n1' } },
      { cmd: 'github_check_cli', args: undefined },
      { cmd: 'github_pr_list', args: { cwd: '/repo' } },
      { cmd: 'github_issue_list', args: { cwd: '/repo' } },
      { cmd: 'github_pr_view', args: { cwd: '/repo', number: 42 } },
      { cmd: 'github_issue_view', args: { cwd: '/repo', number: 7 } },
      { cmd: 'github_pr_comment', args: { cwd: '/repo', number: 42, body: 'lgtm' } },
      { cmd: 'github_issue_comment', args: { cwd: '/repo', number: 7, body: 'thx' } },
      { cmd: 'snippet_get_all', args: undefined },
      { cmd: 'snippet_get_by_id', args: { id: 1 } },
      { cmd: 'snippet_get_favorites', args: undefined },
      { cmd: 'snippet_search', args: { query: 'foo' } },
      { cmd: 'snippet_get_by_workspace', args: { workspaceId: 'ws-1' } },
      { cmd: 'snippet_get_by_workspace', args: { workspaceId: undefined } },
      { cmd: 'snippet_get_categories', args: undefined },
      { cmd: 'snippet_create', args: { input: { title: 't', content: 'c' } } },
      { cmd: 'snippet_update', args: { id: 1, updates: { title: 'new' } } },
      { cmd: 'snippet_delete', args: { id: 1 } },
      { cmd: 'snippet_toggle_favorite', args: { id: 1 } },
      { cmd: 'profile_list', args: undefined },
      { cmd: 'profile_list_local', args: undefined },
      { cmd: 'profile_get', args: { profileId: 'default' } },
      { cmd: 'profile_get_active_ids', args: undefined },
      { cmd: 'profile_create', args: { name: 'New', options: undefined } },
      { cmd: 'profile_create', args: { name: 'Remote', options: { type: 'remote' } } },
      { cmd: 'profile_save', args: { profileId: 'default' } },
      { cmd: 'profile_load', args: { profileId: 'default' } },
      { cmd: 'profile_delete', args: { profileId: 'default' } },
      { cmd: 'profile_rename', args: { profileId: 'default', newName: 'X' } },
      { cmd: 'profile_update', args: { profileId: 'default', updates: { remoteHost: 'h' } } },
      { cmd: 'profile_duplicate', args: { profileId: 'default', newName: 'Copy' } },
      { cmd: 'profile_activate', args: { profileId: 'default' } },
      { cmd: 'profile_deactivate', args: { profileId: 'default' } },
      { cmd: 'claude_auth_status', args: undefined },
      { cmd: 'claude_account_list', args: undefined },
      { cmd: 'claude_start_session', args: { sessionId: 's-1', options: { cwd: '/x' } } },
      { cmd: 'claude_send_message', args: { sessionId: 's-1', prompt: 'hello', images: undefined, autoCompactWindow: undefined, clientMessageId: undefined, displayPrompt: undefined, suppressUserEcho: undefined } },
      { cmd: 'claude_send_message', args: { sessionId: 's-1', prompt: 'with images', images: ['/img.png'], autoCompactWindow: 4000, clientMessageId: undefined, displayPrompt: undefined, suppressUserEcho: undefined } },
      { cmd: 'claude_stop_session', args: { sessionId: 's-1' } },
      { cmd: 'claude_abort_session', args: { sessionId: 's-1' } },
      { cmd: 'claude_stop_task', args: { sessionId: 's-1', taskId: 'task-1' } },
      {
        cmd: 'claude_resume_session',
        args: {
          sessionId: 's-1',
          sdkSessionId: 'sdk-1',
          options: {
            cwd: '/cwd',
            model: 'claude-sonnet-4-6',
            apiVersion: 'v2',
            useWorktree: true,
            worktreePath: '/wt',
            worktreeBranch: 'feat',
            agentPreset: 'codex-agent-worktree',
            codexSandboxMode: 'workspace-write',
            codexApprovalPolicy: 'on-request',
            permissionMode: 'plan',
            effort: 'high',
          },
        },
      },
      { cmd: 'claude_auth_login', args: undefined },
      { cmd: 'claude_auth_logout', args: undefined },
      { cmd: 'claude_account_import_current', args: undefined },
      { cmd: 'claude_account_login_new', args: undefined },
      { cmd: 'claude_account_switch', args: { accountId: 'a-1' } },
      { cmd: 'claude_account_remove', args: { accountId: 'a-1' } },
      { cmd: 'claude_account_mark_warning_shown', args: undefined },
      { cmd: 'claude_get_cli_path', args: undefined },
      { cmd: 'claude_list_sessions', args: { cwd: '/cwd', agentKind: undefined } },
      { cmd: 'claude_list_sessions', args: { cwd: '/cwd', agentKind: 'codex' } },
      { cmd: 'claude_scan_skills', args: { cwd: '/cwd' } },
      { cmd: 'claude_cleanup_worktree', args: { sessionId: 's-1', deleteBranch: true } },
      { cmd: 'claude_set_auto_continue', args: { sessionId: 's-1', opts: { enabled: true } } },
      { cmd: 'claude_get_auto_continue', args: { sessionId: 's-1' } },
      { cmd: 'claude_set_permission_mode', args: { sessionId: 's-1', mode: 'acceptEdits' } },
      { cmd: 'claude_set_codex_sandbox_mode', args: { sessionId: 's-1', mode: 'workspace-write' } },
      { cmd: 'claude_set_codex_approval_policy', args: { sessionId: 's-1', policy: 'on-request' } },
      { cmd: 'claude_set_model', args: { sessionId: 's-1', model: 'claude-opus-4-7', autoCompactWindow: undefined } },
      { cmd: 'claude_set_effort', args: { sessionId: 's-1', effort: 'high' } },
      { cmd: 'claude_reset_session', args: { sessionId: 's-1' } },
      // Session-read commands attach the terminal's agentPreset so the Rust
      // router can pick the Claude/Codex runtime; the test store has no
      // terminal 's-1', so the lookup resolves to undefined.
      { cmd: 'claude_get_supported_models', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_supported_efforts', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_supported_codex_sandbox_modes', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_supported_codex_approval_policies', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_supported_commands', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_supported_agents', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_account_info', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_session_state', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_session_meta', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_context_usage', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_get_worktree_status', args: { sessionId: 's-1', agentPreset: undefined } },
      { cmd: 'claude_channel_get_capabilities', args: undefined },
      { cmd: 'claude_channel_start_session', args: { sessionId: 'ch-1', options: { cwd: '/cwd' } } },
      { cmd: 'claude_channel_send_message', args: { sessionId: 'ch-1', prompt: 'hello', messageId: 'm-1' } },
      { cmd: 'claude_channel_get_status', args: { sessionId: 'ch-1' } },
      { cmd: 'claude_channel_stop_session', args: { sessionId: 'ch-1' } },
      { cmd: 'claude_cli_get_capabilities', args: undefined },
      { cmd: 'claude_cli_start_session', args: { sessionId: 'cli-1', options: { cwd: '/cwd' } } },
      { cmd: 'claude_cli_get_status', args: { sessionId: 'cli-1' } },
      { cmd: 'claude_cli_stop_session', args: { sessionId: 'cli-1' } },
      { cmd: 'worktree_create', args: { sessionId: 's-1', cwd: '/cwd' } },
      { cmd: 'worktree_remove', args: { sessionId: 's-1', deleteBranch: true } },
      { cmd: 'worktree_status', args: { sessionId: 's-1' } },
      { cmd: 'worktree_merge', args: { sessionId: 's-1', strategy: 'merge' } },
      { cmd: 'worktree_rehydrate', args: { sessionId: 's-1', cwd: '/cwd', worktreePath: '/wt', branchName: 'feat' } },
      { cmd: 'agent_list_presets', args: undefined },
      { cmd: 'worker_buffer_init', args: { panelId: 'p1' } },
      { cmd: 'worker_buffer_append', args: { panelId: 'p1', lines: 'line\n' } },
      { cmd: 'worker_buffer_read_all', args: { panelId: 'p1' } },
      { cmd: 'worker_buffer_clear', args: { panelId: 'p1' } },
      { cmd: 'remote_start_server', args: { options: { port: 9876 } } },
      { cmd: 'remote_stop_server', args: undefined },
      { cmd: 'remote_server_status', args: undefined },
      { cmd: 'remote_connect', args: { host: 'h', port: 9876, token: 't', fingerprint: 'fp', label: undefined } },
      { cmd: 'remote_connect', args: { host: 'h', port: 9876, token: 't', fingerprint: 'fp', label: 'lbl' } },
      { cmd: 'remote_disconnect', args: undefined },
      { cmd: 'remote_client_status', args: undefined },
      { cmd: 'remote_test_connection', args: { host: 'h', port: 9876, token: 't', fingerprint: 'fp' } },
      { cmd: 'remote_list_profiles', args: { host: 'h', port: 9876, token: 't', fingerprint: 'fp' } },
      { cmd: 'tunnel_get_connection', args: undefined },
    ])
  }

  // 4) Tauri detection still throws "not implemented" for unported namespaces
  {
    const invoke: TauriInvoke = async () => undefined as unknown as never
    setWindow({ __TAURI_INTERNALS__: { invoke } })
    const mod = await loadFreshAdapter()
    // remote/tunnel were ported as sidecar stubs in Phase 3 prep; pick a
    // namespace that's still entirely unrouted (none right now — every
    // preload namespace is at least stub-routed). We retain the per-method
    // canaries below to cover that case explicitly.
    assert.equal(await mod.host.workspace.detach('workspace-1'), undefined)
    // claude.* unported methods used to throw, but the surface is too
    // large for that to be useful — unrecognized keys now return
    // Promise.resolve(null) with a one-time console.warn so panel
    // mounts don't crash. Same applies to worktree.* keys that aren't
    // in the explicit map. claude.setAutoContinue is now
    // explicitly routed (see scenario 3), so use a synthetic key here.
    const setRes = await (mod.host as { claude: { unknownMethodXyz: () => Promise<unknown> } }).claude.unknownMethodXyz()
    assert.equal(setRes, null)
    assert.throws(
      () => (mod.host as { openai: { unknownMethod: unknown } }).openai.unknownMethod,
      /host-api: openai\.unknownMethod is not yet implemented under Tauri/,
    )
  }

  // 5) Legacy __TAURI__ marker still works (detection only — invoke can't be
  //    resolved without __TAURI_INTERNALS__, so calls error clearly).
  {
    setWindow({ __TAURI__: {} })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'tauri')
    assert.throws(() => (mod.host as { settings: { load: () => unknown } }).settings.load(),
      /tauri invoke not available/)
  }

  // 5) Tauri debug mode is synchronously derived for renderer guards.
  {
    const invoke: TauriInvoke = async () => undefined as unknown as never
    setWindow({ __TAURI_INTERNALS__: { invoke }, location: { search: '?BAT_DEBUG=1' } })
    const mod = await loadFreshAdapter()
    assert.equal(mod.host.debug.isDebugMode, true)
    assert.equal(mod.host.debug.isPtyInputTrace, false, 'ordinary debug mode must not log terminal input')
  }

  // PTY input tracing is a separate, explicit diagnostic switch.
  {
    const invoke: TauriInvoke = async () => undefined as unknown as never
    setWindow({ __TAURI_INTERNALS__: { invoke }, location: { search: '?BAT_TRACE_PTY_INPUT=1' } })
    const mod = await loadFreshAdapter()
    assert.equal(mod.host.debug.isPtyInputTrace, true)
  }

  // 6) Tauri wins when both markers exist because installTauriShim() itself
  //    attaches window.batAppAPI inside the Tauri runtime.
  {
    setWindow({ batAppAPI: { ping: () => 'pong' }, __TAURI_INTERNALS__: { invoke: () => Promise.resolve(null) } })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'tauri')
    assert.equal(mod.isTauri(), true)
  }

  // 7) installTauriShim() lets unmigrated callsites no-op gracefully.
  //    - Ported APIs (settings.load) still go through invoke
  //    - Sync APIs return sensible defaults (workspace.getDetachedId -> null,
  //      platform -> detected)
  //    - Unknown async APIs return Promise.resolve(null)
  //    - Listener registrations (on*) return a no-op unsubscriber
  {
    const invokeCalls: string[] = []
    const invoke: TauriInvoke = async <T>(cmd: string) => {
      invokeCalls.push(cmd)
      if (cmd === 'debug_is_debug_mode') return false as unknown as T
      if (cmd === 'debug_is_pty_input_trace') return false as unknown as T
      return null as unknown as T
    }
    // No batAppAPI yet — the shim should install one.
    const win: WinShape = { __TAURI_INTERNALS__: { invoke } }
    setWindow(win)
    const mod = await loadFreshAdapter()
    mod.installTauriShim()
    const shimmed = (win as unknown as { batAppAPI?: Record<string, unknown> }).batAppAPI
    assert.ok(shimmed, 'installTauriShim should attach window.batAppAPI')
    assert.equal(mod.getHostKind(), 'tauri')
    assert.equal(mod.isTauri(), true)

    // platform is synchronous and required by App.tsx during render
    const platform = (shimmed as { platform: string }).platform
    assert.ok(['win32', 'darwin', 'linux'].includes(platform), `unexpected platform: ${platform}`)

    // workspace.getDetachedId is synchronous; preload returns string|null
    const detached = (shimmed as { workspace: { getDetachedId: () => string | null } }).workspace.getDetachedId()
    assert.equal(detached, null)

    // Unknown async API returns Promise.resolve(null)
    const result = await (shimmed as { foo: { bar: () => Promise<unknown> } }).foo.bar()
    assert.equal(result, null)

    // Listener-style registration returns a no-op unsubscriber that itself returns void.
    const unsub = (shimmed as { pty: { onOutput: (cb: (...a: unknown[]) => void) => () => void } }).pty.onOutput(() => {})
    assert.equal(typeof unsub, 'function')
    assert.equal(unsub(), undefined)

    // Ported settings.load is still routed through invoke.
    await (shimmed as { settings: { load: () => Promise<unknown> } }).settings.load()
    assert.deepEqual(stripBestEffortDebugModeCall(invokeCalls.map(cmd => ({ cmd }))), [{ cmd: 'settings_load' }])
  }

  // 8) installTauriShim() is a no-op when not running under Tauri.
  {
    setWindow({ batAppAPI: { foo: 1 } })
    const mod = await loadFreshAdapter()
    mod.installTauriShim()
    const win = (globalThis as { window?: { batAppAPI: { foo: number } } }).window
    // The original batAppAPI is left alone.
    assert.equal(win?.batAppAPI?.foo, 1)
  }

  // 9) startSession/resumeSession stamp workspace identity onto the
  //    options when the session's terminal maps to a workspace. The
  //    no-mapping case is covered by scenario 2 (payloads unchanged).
  {
    const invokeCalls: { cmd: string; args?: Record<string, unknown> }[] = []
    const invoke: TauriInvoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args })
      return { ok: true } as unknown as T
    }
    setWindow({ __TAURI_INTERNALS__: { invoke } })
    const mod = await loadFreshAdapter()
    const { workspaceStore } = await import('../renderer/src/stores/workspace-store')
    const ws = workspaceStore.addWorkspace('Plan workspace', 'C:/repo')
    const term = workspaceStore.addTerminal(ws.id, 'claude-code')
    // alias takes priority over name in the stamped workspaceName.
    workspaceStore.renameWorkspace(ws.id, 'Renamed workspace')

    await mod.host.claude.startSession(term.id, { cwd: 'C:/repo' })
    await mod.host.claude.resumeSession(term.id, 'sdk-1', 'C:/repo')

    const startOptions = invokeCalls.find(c => c.cmd === 'claude_start_session')
      ?.args?.options as { workspaceId?: string; workspaceName?: string } | undefined
    assert.equal(startOptions?.workspaceId, ws.id)
    assert.equal(startOptions?.workspaceName, 'Renamed workspace')

    const resumeOptions = invokeCalls.find(c => c.cmd === 'claude_resume_session')
      ?.args?.options as { workspaceId?: string; workspaceName?: string } | undefined
    assert.equal(resumeOptions?.workspaceId, ws.id)
    assert.equal(resumeOptions?.workspaceName, 'Renamed workspace')
  }

  console.log('host-api: passed')
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
