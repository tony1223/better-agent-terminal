import { contextBridge, ipcRenderer } from 'electron'
import type { CreatePtyOptions } from '../src/types'

const electronAPI = {
  platform: process.platform as 'win32' | 'darwin' | 'linux',
  pty: {
    create: (options: CreatePtyOptions) => ipcRenderer.invoke('pty:create', options),
    write: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('pty:kill', id),
    restart: (id: string, cwd: string, shell?: string) => ipcRenderer.invoke('pty:restart', id, cwd, shell),
    getCwd: (id: string) => ipcRenderer.invoke('pty:get-cwd', id),
    onOutput: (callback: (id: string, data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: string, data: string) => callback(id, data)
      ipcRenderer.on('pty:output', handler)
      return () => ipcRenderer.removeListener('pty:output', handler)
    },
    onExit: (callback: (id: string, exitCode: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: string, exitCode: number) => callback(id, exitCode)
      ipcRenderer.on('pty:exit', handler)
      return () => ipcRenderer.removeListener('pty:exit', handler)
    }
  },
  workspace: {
    save: (data: string) => ipcRenderer.invoke('workspace:save', data),
    load: () => ipcRenderer.invoke('workspace:load'),
    detach: (workspaceId: string) => ipcRenderer.invoke('workspace:detach', workspaceId),
    reattach: (workspaceId: string) => ipcRenderer.invoke('workspace:reattach', workspaceId),
    getDetachedId: () => new URLSearchParams(window.location.search).get('detached'),
    onDetached: (callback: (workspaceId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, workspaceId: string) => callback(workspaceId)
      ipcRenderer.on('workspace:detached', handler)
      return () => ipcRenderer.removeListener('workspace:detached', handler)
    },
    onReattached: (callback: (workspaceId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, workspaceId: string) => callback(workspaceId)
      ipcRenderer.on('workspace:reattached', handler)
      return () => ipcRenderer.removeListener('workspace:reattached', handler)
    },
    moveToWindow: (sourceWindowId: string, targetWindowId: string, workspaceId: string, insertIndex: number) =>
      ipcRenderer.invoke('workspace:move-to-window', sourceWindowId, targetWindowId, workspaceId, insertIndex),
    onReload: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('workspace:reload', handler)
      return () => ipcRenderer.removeListener('workspace:reload', handler)
    },
  },
  settings: {
    save: (data: string) => ipcRenderer.invoke('settings:save', data),
    load: () => ipcRenderer.invoke('settings:load'),
    getShellPath: (shell: string) => ipcRenderer.invoke('settings:get-shell-path', shell),
    clearTerminalHistory: () => ipcRenderer.invoke('settings:clear-terminal-history')
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:select-folder') as Promise<string[] | null>,
    selectImages: () => ipcRenderer.invoke('dialog:select-images') as Promise<string[]>,
    selectFiles: () => ipcRenderer.invoke('dialog:select-files') as Promise<string[]>,
    confirm: (message: string, title?: string) => ipcRenderer.invoke('dialog:confirm', message, title) as Promise<boolean>,
  },
  image: {
    readAsDataUrl: (filePath: string) => ipcRenderer.invoke('image:read-as-data-url', filePath) as Promise<string>,
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    openPath: (folderPath: string) => ipcRenderer.invoke('shell:open-path', folderPath),
  },
  app: {
    openNewInstance: (profileId: string) => ipcRenderer.invoke('app:open-new-instance', profileId),
    getLaunchProfile: () => ipcRenderer.invoke('app:get-launch-profile') as Promise<string | null>,
    getWindowId: () => ipcRenderer.invoke('app:get-window-id') as Promise<string | null>,
    getWindowProfile: () => ipcRenderer.invoke('app:get-window-profile') as Promise<string | null>,
    getWindowIndex: () => ipcRenderer.invoke('app:get-window-index') as Promise<number>,
    newWindow: () => ipcRenderer.invoke('app:new-window') as Promise<string>,
    setDockBadge: (count: number) => ipcRenderer.invoke('app:set-dock-badge', count),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    getVersion: () => ipcRenderer.invoke('update:get-version')
  },
  clipboard: {
    saveImage: () => ipcRenderer.invoke('clipboard:saveImage'),
    writeImage: (filePath: string) => ipcRenderer.invoke('clipboard:writeImage', filePath),
  },
  claude: {
    startSession: (sessionId: string, options: { cwd: string; prompt?: string; permissionMode?: string; model?: string; effort?: string; apiVersion?: 'v1' | 'v2'; useWorktree?: boolean; worktreePath?: string; worktreeBranch?: string; autoCompactWindow?: number; agentPreset?: string; codexSandboxMode?: string; codexApprovalPolicy?: string }) =>
      ipcRenderer.invoke('claude:start-session', sessionId, options),
    sendMessage: (sessionId: string, prompt: string, images?: string[]) =>
      ipcRenderer.invoke('claude:send-message', sessionId, prompt, images),
    stopSession: (sessionId: string) =>
      ipcRenderer.invoke('claude:stop-session', sessionId),
    abortSession: (sessionId: string) =>
      ipcRenderer.invoke('claude:abort-session', sessionId),
    onMessage: (callback: (sessionId: string, message: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, message: unknown) => callback(sessionId, message)
      ipcRenderer.on('claude:message', handler)
      return () => ipcRenderer.removeListener('claude:message', handler)
    },
    onToolUse: (callback: (sessionId: string, toolCall: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, toolCall: unknown) => callback(sessionId, toolCall)
      ipcRenderer.on('claude:tool-use', handler)
      return () => ipcRenderer.removeListener('claude:tool-use', handler)
    },
    onToolResult: (callback: (sessionId: string, result: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, result: unknown) => callback(sessionId, result)
      ipcRenderer.on('claude:tool-result', handler)
      return () => ipcRenderer.removeListener('claude:tool-result', handler)
    },
    onResult: (callback: (sessionId: string, result: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, result: unknown) => callback(sessionId, result)
      ipcRenderer.on('claude:result', handler)
      return () => ipcRenderer.removeListener('claude:result', handler)
    },
    onError: (callback: (sessionId: string, error: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, error: string) => callback(sessionId, error)
      ipcRenderer.on('claude:error', handler)
      return () => ipcRenderer.removeListener('claude:error', handler)
    },
    onStream: (callback: (sessionId: string, data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: unknown) => callback(sessionId, data)
      ipcRenderer.on('claude:stream', handler)
      return () => ipcRenderer.removeListener('claude:stream', handler)
    },
    onStatus: (callback: (sessionId: string, meta: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, meta: unknown) => callback(sessionId, meta)
      ipcRenderer.on('claude:status', handler)
      return () => ipcRenderer.removeListener('claude:status', handler)
    },
    onModeChange: (callback: (sessionId: string, mode: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, mode: string) => callback(sessionId, mode)
      ipcRenderer.on('claude:modeChange', handler)
      return () => ipcRenderer.removeListener('claude:modeChange', handler)
    },
    setPermissionMode: (sessionId: string, mode: string) =>
      ipcRenderer.invoke('claude:set-permission-mode', sessionId, mode),
    setModel: (sessionId: string, model: string, autoCompactWindow?: number) =>
      ipcRenderer.invoke('claude:set-model', sessionId, model, autoCompactWindow),
    setEffort: (sessionId: string, effort: string) =>
      ipcRenderer.invoke('claude:set-effort', sessionId, effort),
    resetSession: (sessionId: string) =>
      ipcRenderer.invoke('claude:reset-session', sessionId),
    getSupportedModels: (sessionId: string) =>
      ipcRenderer.invoke('claude:get-supported-models', sessionId),
    getAccountInfo: (sessionId: string) =>
      ipcRenderer.invoke('claude:get-account-info', sessionId) as Promise<{ email?: string; organization?: string; subscriptionType?: string } | null>,
    getSupportedCommands: (sessionId: string) =>
      ipcRenderer.invoke('claude:get-supported-commands', sessionId) as Promise<{ name: string; description: string; argumentHint: string }[]>,
    getSupportedAgents: (sessionId: string) =>
      ipcRenderer.invoke('claude:get-supported-agents', sessionId) as Promise<{ name: string; description: string; model?: string }[]>,
    getWorktreeStatus: (sessionId: string) =>
      ipcRenderer.invoke('claude:get-worktree-status', sessionId) as Promise<{ diff: string; branchName: string; worktreePath: string; sourceBranch: string } | null>,
    cleanupWorktree: (sessionId: string, deleteBranch: boolean) =>
      ipcRenderer.invoke('claude:cleanup-worktree', sessionId, deleteBranch) as Promise<boolean>,
    scanSkills: (cwd: string) =>
      ipcRenderer.invoke('claude:scan-skills', cwd) as Promise<{ name: string; description: string; scope: 'project' | 'global' }[]>,
    getSessionMeta: (sessionId: string) =>
      ipcRenderer.invoke('claude:get-session-meta', sessionId) as Promise<Record<string, unknown> | null>,
    getContextUsage: (sessionId: string) =>
      ipcRenderer.invoke('claude:get-context-usage', sessionId) as Promise<{
        categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
        totalTokens: number
        maxTokens: number
        percentage: number
        model: string
        memoryFiles?: { path: string; type: string; tokens: number }[]
        mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[]
        apiUsage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } | null
      } | null>,
    getCliPath: () =>
      ipcRenderer.invoke('claude:get-cli-path') as Promise<string>,
    authLogin: () =>
      ipcRenderer.invoke('claude:auth-login') as Promise<{ success: boolean; error?: string }>,
    authStatus: () =>
      ipcRenderer.invoke('claude:auth-status') as Promise<{ loggedIn: boolean; email?: string; subscriptionType?: string; authMethod?: string } | null>,
    authLogout: () =>
      ipcRenderer.invoke('claude:auth-logout') as Promise<{ success: boolean; error?: string }>,
    accountList: () =>
      ipcRenderer.invoke('claude:account-list') as Promise<{ accounts: { id: string; email: string; subscriptionType?: string; isDefault: boolean; createdAt: number }[]; activeAccountId: string | null; switchWarningShown: boolean }>,
    accountImportCurrent: () =>
      ipcRenderer.invoke('claude:account-import-current') as Promise<{ id: string; email: string; subscriptionType?: string } | null>,
    accountLoginNew: () =>
      ipcRenderer.invoke('claude:account-login-new') as Promise<{ success: boolean; account?: { id: string; email: string; subscriptionType?: string }; error?: string }>,
    accountSwitch: (accountId: string) =>
      ipcRenderer.invoke('claude:account-switch', accountId) as Promise<boolean>,
    accountRemove: (accountId: string) =>
      ipcRenderer.invoke('claude:account-remove', accountId) as Promise<boolean>,
    accountMarkWarningShown: () =>
      ipcRenderer.invoke('claude:account-mark-warning-shown') as Promise<boolean>,
    resolvePermission: (sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[]; message?: string; dontAskAgain?: boolean }) =>
      ipcRenderer.invoke('claude:resolve-permission', sessionId, toolUseId, result),
    resolveAskUser: (sessionId: string, toolUseId: string, answers: Record<string, string>) =>
      ipcRenderer.invoke('claude:resolve-ask-user', sessionId, toolUseId, answers),
    listSessions: (cwd: string) =>
      ipcRenderer.invoke('claude:list-sessions', cwd),
    resumeSession: (sessionId: string, sdkSessionId: string, cwd: string, model?: string, apiVersion?: 'v1' | 'v2', useWorktree?: boolean, worktreePath?: string, worktreeBranch?: string) =>
      ipcRenderer.invoke('claude:resume-session', sessionId, sdkSessionId, cwd, model, apiVersion, useWorktree, worktreePath, worktreeBranch),
    forkSession: (sessionId: string) =>
      ipcRenderer.invoke('claude:fork-session', sessionId) as Promise<{ newSdkSessionId: string } | null>,
    stopTask: (sessionId: string, taskId: string) =>
      ipcRenderer.invoke('claude:stop-task', sessionId, taskId) as Promise<boolean>,
    restSession: (sessionId: string) =>
      ipcRenderer.invoke('claude:rest-session', sessionId) as Promise<boolean>,
    wakeSession: (sessionId: string) =>
      ipcRenderer.invoke('claude:wake-session', sessionId) as Promise<boolean>,
    isResting: (sessionId: string) =>
      ipcRenderer.invoke('claude:is-resting', sessionId) as Promise<boolean>,
    fetchSubagentMessages: (sessionId: string, agentToolUseId: string) =>
      ipcRenderer.invoke('claude:fetch-subagent-messages', sessionId, agentToolUseId) as Promise<unknown[]>,
    archiveMessages: (sessionId: string, messages: unknown[]) =>
      ipcRenderer.invoke('claude:archive-messages', sessionId, messages) as Promise<boolean>,
    loadArchived: (sessionId: string, offset: number, limit: number) =>
      ipcRenderer.invoke('claude:load-archived', sessionId, offset, limit) as Promise<{ messages: unknown[]; total: number; hasMore: boolean }>,
    clearArchive: (sessionId: string) =>
      ipcRenderer.invoke('claude:clear-archive', sessionId) as Promise<boolean>,
    onHistory: (callback: (sessionId: string, items: unknown[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, items: unknown[]) => callback(sessionId, items)
      ipcRenderer.on('claude:history', handler)
      return () => ipcRenderer.removeListener('claude:history', handler)
    },
    onPermissionRequest: (callback: (sessionId: string, data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: unknown) => callback(sessionId, data)
      ipcRenderer.on('claude:permission-request', handler)
      return () => ipcRenderer.removeListener('claude:permission-request', handler)
    },
    onAskUser: (callback: (sessionId: string, data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: unknown) => callback(sessionId, data)
      ipcRenderer.on('claude:ask-user', handler)
      return () => ipcRenderer.removeListener('claude:ask-user', handler)
    },
    onAskUserResolved: (callback: (sessionId: string, toolUseId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, toolUseId: string) => callback(sessionId, toolUseId)
      ipcRenderer.on('claude:ask-user-resolved', handler)
      return () => ipcRenderer.removeListener('claude:ask-user-resolved', handler)
    },
    onPermissionResolved: (callback: (sessionId: string, toolUseId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, toolUseId: string) => callback(sessionId, toolUseId)
      ipcRenderer.on('claude:permission-resolved', handler)
      return () => ipcRenderer.removeListener('claude:permission-resolved', handler)
    },
    onSessionReset: (callback: (sessionId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId)
      ipcRenderer.on('claude:session-reset', handler)
      return () => ipcRenderer.removeListener('claude:session-reset', handler)
    },
    onRateLimit: (callback: (sessionId: string, info: { rateLimitType: string; resetsAt: number; utilization: number | null; isUsingOverage: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, info: { rateLimitType: string; resetsAt: number; utilization: number | null; isUsingOverage: boolean }) => callback(sessionId, info)
      ipcRenderer.on('claude:rate-limit', handler)
      return () => ipcRenderer.removeListener('claude:rate-limit', handler)
    },
    onWorktreeInfo: (callback: (sessionId: string, info: { branchName: string; worktreePath: string; sourceBranch: string; gitRoot?: string } | null) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, info: { branchName: string; worktreePath: string; sourceBranch: string; gitRoot?: string } | null) => callback(sessionId, info)
      ipcRenderer.on('claude:worktree-info', handler)
      return () => ipcRenderer.removeListener('claude:worktree-info', handler)
    },
    onPromptSuggestion: (callback: (sessionId: string, suggestion: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, suggestion: string) => callback(sessionId, suggestion)
      ipcRenderer.on('claude:prompt-suggestion', handler)
      return () => ipcRenderer.removeListener('claude:prompt-suggestion', handler)
    },
  },
  worktree: {
    create: (sessionId: string, cwd: string) =>
      ipcRenderer.invoke('worktree:create', sessionId, cwd) as Promise<{ success: boolean; worktreePath?: string; branchName?: string; gitRoot?: string; sourceBranch?: string; error?: string }>,
    remove: (sessionId: string, deleteBranch: boolean) =>
      ipcRenderer.invoke('worktree:remove', sessionId, deleteBranch) as Promise<{ success: boolean; error?: string }>,
    status: (sessionId: string) =>
      ipcRenderer.invoke('worktree:status', sessionId) as Promise<{ diff: string; branchName: string; worktreePath: string; sourceBranch: string } | null>,
    merge: (sessionId: string, strategy: 'merge' | 'cherry-pick') =>
      ipcRenderer.invoke('worktree:merge', sessionId, strategy) as Promise<{ success: boolean; error?: string }>,
    rehydrate: (sessionId: string, cwd: string, worktreePath: string, branchName: string) =>
      ipcRenderer.invoke('worktree:rehydrate', sessionId, cwd, worktreePath, branchName) as Promise<{ success: boolean }>,
  },
  github: {
    checkCli: () => ipcRenderer.invoke('github:check-cli') as Promise<{ installed: boolean; authenticated: boolean }>,
    listPRs: (cwd: string) => ipcRenderer.invoke('github:pr-list', cwd),
    listIssues: (cwd: string) => ipcRenderer.invoke('github:issue-list', cwd),
    viewPR: (cwd: string, number: number) => ipcRenderer.invoke('github:pr-view', cwd, number),
    viewIssue: (cwd: string, number: number) => ipcRenderer.invoke('github:issue-view', cwd, number),
    commentPR: (cwd: string, number: number, body: string) => ipcRenderer.invoke('github:pr-comment', cwd, number, body) as Promise<{ success: true } | { error: string }>,
    commentIssue: (cwd: string, number: number, body: string) => ipcRenderer.invoke('github:issue-comment', cwd, number, body) as Promise<{ success: true } | { error: string }>,
  },
  git: {
    getGithubUrl: (folderPath: string) => ipcRenderer.invoke('git:get-github-url', folderPath) as Promise<string | null>,
    getBranch: (cwd: string) => ipcRenderer.invoke('git:branch', cwd) as Promise<string | null>,
    getLog: (cwd: string, count?: number) => ipcRenderer.invoke('git:log', cwd, count) as Promise<{ hash: string; author: string; date: string; message: string }[]>,
    getDiff: (cwd: string, commitHash?: string, filePath?: string) => ipcRenderer.invoke('git:diff', cwd, commitHash, filePath) as Promise<string>,
    getDiffFiles: (cwd: string, commitHash?: string) => ipcRenderer.invoke('git:diff-files', cwd, commitHash) as Promise<{ status: string; file: string }[]>,
    getStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd) as Promise<{ status: string; file: string }[]>,
    getRoot: (cwd: string) => ipcRenderer.invoke('git:getRoot', cwd) as Promise<string | null>,
  },
  fs: {
    readdir: (dirPath: string) => ipcRenderer.invoke('fs:readdir', dirPath) as Promise<{ name: string; path: string; isDirectory: boolean }[]>,
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath) as Promise<{ content?: string; error?: string; size?: number }>,
    search: (dirPath: string, query: string) => ipcRenderer.invoke('fs:search', dirPath, query) as Promise<{ name: string; path: string; isDirectory: boolean }[]>,
    watch: (dirPath: string) => ipcRenderer.invoke('fs:watch', dirPath) as Promise<boolean>,
    unwatch: (dirPath: string) => ipcRenderer.invoke('fs:unwatch', dirPath) as Promise<boolean>,
    onChanged: (callback: (dirPath: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, dirPath: string) => callback(dirPath)
      ipcRenderer.on('fs:changed', handler)
      return () => ipcRenderer.removeListener('fs:changed', handler)
    },
  },
  profile: {
    list: () => ipcRenderer.invoke('profile:list') as Promise<{ profiles: { id: string; name: string; type: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string; remoteProfileId?: string; createdAt: number; updatedAt: number }[]; activeProfileIds: string[] }>,
    // Local-only profile list — returns THIS machine's profiles even when
    // connected to a remote host (where profile:list would return the remote's
    // profiles). Used to resolve window identity / local aliases.
    listLocal: () => ipcRenderer.invoke('profile:list-local') as Promise<{ profiles: { id: string; name: string; type: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string; remoteProfileId?: string; createdAt: number; updatedAt: number }[]; activeProfileIds: string[] }>,
    create: (name: string, options?: { type?: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string; remoteProfileId?: string }) =>
      ipcRenderer.invoke('profile:create', name, options) as Promise<{ id: string; name: string; type: 'local' | 'remote'; createdAt: number; updatedAt: number }>,
    save: (profileId: string) => ipcRenderer.invoke('profile:save', profileId) as Promise<boolean>,
    load: (profileId: string) => ipcRenderer.invoke('profile:load', profileId) as Promise<unknown>,
    delete: (profileId: string) => ipcRenderer.invoke('profile:delete', profileId) as Promise<boolean>,
    rename: (profileId: string, newName: string) => ipcRenderer.invoke('profile:rename', profileId, newName) as Promise<boolean>,
    update: (profileId: string, updates: { remoteHost?: string; remotePort?: number; remoteToken?: string; remoteProfileId?: string }) => ipcRenderer.invoke('profile:update', profileId, updates) as Promise<boolean>,
    duplicate: (profileId: string, newName: string) => ipcRenderer.invoke('profile:duplicate', profileId, newName) as Promise<{ id: string; name: string; createdAt: number; updatedAt: number } | null>,
    get: (profileId: string) => ipcRenderer.invoke('profile:get', profileId) as Promise<{ id: string; name: string; type: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string; remoteProfileId?: string; createdAt: number; updatedAt: number } | null>,
    getActiveIds: () => ipcRenderer.invoke('profile:get-active-ids') as Promise<string[]>,
    activate: (profileId: string) => ipcRenderer.invoke('profile:activate', profileId) as Promise<void>,
    deactivate: (profileId: string) => ipcRenderer.invoke('profile:deactivate', profileId) as Promise<void>,
  },
  remote: {
    startServer: (port?: number, token?: string) =>
      ipcRenderer.invoke('remote:start-server', port, token) as Promise<{ port: number; token: string } | { error: string }>,
    stopServer: () =>
      ipcRenderer.invoke('remote:stop-server') as Promise<boolean>,
    serverStatus: () =>
      ipcRenderer.invoke('remote:server-status') as Promise<{ running: boolean; port: number | null; clients: { label: string; connectedAt: number }[] }>,
    connect: (host: string, port: number, token: string, label?: string) =>
      ipcRenderer.invoke('remote:connect', host, port, token, label) as Promise<{ connected: boolean } | { error: string }>,
    disconnect: () =>
      ipcRenderer.invoke('remote:disconnect') as Promise<boolean>,
    clientStatus: () =>
      ipcRenderer.invoke('remote:client-status') as Promise<{ connected: boolean; info: { host: string; port: number } | null }>,
    testConnection: (host: string, port: number, token: string) =>
      ipcRenderer.invoke('remote:test-connection', host, port, token) as Promise<{ ok: boolean }>,
    listProfiles: (host: string, port: number, token: string) =>
      ipcRenderer.invoke('remote:list-profiles', host, port, token) as Promise<{ profiles: { id: string; name: string; type: string }[] } | { error: string }>,
  },
  tunnel: {
    getConnection: () =>
      ipcRenderer.invoke('tunnel:get-connection') as Promise<{ url: string; token: string; mode: string } | { error: string }>,
  },
  system: {
    onResume: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('system:resume', handler)
      return () => ipcRenderer.removeListener('system:resume', handler)
    },
  },
  debug: {
    log: (...args: unknown[]) => ipcRenderer.send('debug:log', ...args),
    isDebugMode: !!process.env.BAT_DEBUG,
  },
  snippet: {
    getAll: () => ipcRenderer.invoke('snippet:getAll'),
    getById: (id: number) => ipcRenderer.invoke('snippet:getById', id),
    create: (input: { title: string; content: string; format?: string; category?: string; tags?: string; isFavorite?: boolean; workspaceId?: string }) =>
      ipcRenderer.invoke('snippet:create', input),
    update: (id: number, updates: { title?: string; content?: string; format?: string; category?: string; tags?: string; isFavorite?: boolean; workspaceId?: string }) =>
      ipcRenderer.invoke('snippet:update', id, updates),
    delete: (id: number) => ipcRenderer.invoke('snippet:delete', id),
    toggleFavorite: (id: number) => ipcRenderer.invoke('snippet:toggleFavorite', id),
    search: (query: string) => ipcRenderer.invoke('snippet:search', query),
    getCategories: () => ipcRenderer.invoke('snippet:getCategories'),
    getFavorites: () => ipcRenderer.invoke('snippet:getFavorites'),
    getByWorkspace: (workspaceId?: string) => ipcRenderer.invoke('snippet:getByWorkspace', workspaceId)
  },
  workerBuffer: {
    init: (panelId: string) => ipcRenderer.invoke('worker-buffer:init', panelId),
    append: (panelId: string, lines: string) => ipcRenderer.invoke('worker-buffer:append', panelId, lines),
    readAll: (panelId: string) => ipcRenderer.invoke('worker-buffer:readAll', panelId) as Promise<string>,
    clear: (panelId: string) => ipcRenderer.invoke('worker-buffer:clear', panelId),
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

declare global {
  interface Window {
    electronAPI: typeof electronAPI
  }
}
