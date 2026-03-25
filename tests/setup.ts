/**
 * Vitest global setup file.
 * - Registers @testing-library/jest-dom matchers
 * - Provides a comprehensive window.electronAPI mock for jsdom tests
 */

import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

const noop = () => {}

/** Complete mock of the electronAPI exposed by preload.ts via contextBridge */
export const mockElectronAPI = {
  platform: 'darwin' as const,
  pty: {
    create: vi.fn().mockResolvedValue(true),
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(true),
    restart: vi.fn().mockResolvedValue(true),
    getCwd: vi.fn().mockResolvedValue(null),
    onOutput: vi.fn().mockReturnValue(noop),
    onExit: vi.fn().mockReturnValue(noop),
  },
  workspace: {
    save: vi.fn().mockResolvedValue(true),
    load: vi.fn().mockResolvedValue(null),
    detach: vi.fn().mockResolvedValue(true),
    reattach: vi.fn().mockResolvedValue(true),
    getDetachedId: vi.fn().mockReturnValue(null),
    onDetached: vi.fn().mockReturnValue(noop),
    onReattached: vi.fn().mockReturnValue(noop),
  },
  settings: {
    save: vi.fn().mockResolvedValue(true),
    load: vi.fn().mockResolvedValue(null),
    getShellPath: vi.fn().mockResolvedValue('/bin/zsh'),
  },
  dialog: {
    selectFolder: vi.fn().mockResolvedValue(null),
    selectImages: vi.fn().mockResolvedValue([]),
    confirm: vi.fn().mockResolvedValue(true),
  },
  image: {
    readAsDataUrl: vi.fn().mockResolvedValue(''),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(undefined),
  },
  app: {
    openNewInstance: vi.fn().mockResolvedValue(undefined),
    getLaunchProfile: vi.fn().mockResolvedValue(null),
    setDockBadge: vi.fn().mockResolvedValue(undefined),
  },
  update: {
    check: vi.fn().mockResolvedValue(null),
    getVersion: vi.fn().mockResolvedValue('2.1.1'),
  },
  clipboard: {
    saveImage: vi.fn().mockResolvedValue(null),
    writeImage: vi.fn().mockResolvedValue(true),
  },
  claude: {
    startSession: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockReturnValue(noop),
    onToolUse: vi.fn().mockReturnValue(noop),
    onToolResult: vi.fn().mockReturnValue(noop),
    onResult: vi.fn().mockReturnValue(noop),
    onError: vi.fn().mockReturnValue(noop),
    onStream: vi.fn().mockReturnValue(noop),
    onStatus: vi.fn().mockReturnValue(noop),
    onModeChange: vi.fn().mockReturnValue(noop),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setEffort: vi.fn().mockResolvedValue(undefined),
    set1MContext: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    getSupportedModels: vi.fn().mockResolvedValue([]),
    getAccountInfo: vi.fn().mockResolvedValue(null),
    getSupportedCommands: vi.fn().mockResolvedValue([]),
    scanSkills: vi.fn().mockResolvedValue([]),
    getSessionMeta: vi.fn().mockResolvedValue(null),
    getUsage: vi.fn().mockResolvedValue(null),
    resolvePermission: vi.fn().mockResolvedValue(undefined),
    resolveAskUser: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    resumeSession: vi.fn().mockResolvedValue(undefined),
    forkSession: vi.fn().mockResolvedValue(null),
    stopTask: vi.fn().mockResolvedValue(true),
    restSession: vi.fn().mockResolvedValue(true),
    wakeSession: vi.fn().mockResolvedValue(true),
    isResting: vi.fn().mockResolvedValue(false),
    archiveMessages: vi.fn().mockResolvedValue(true),
    loadArchived: vi.fn().mockResolvedValue({ messages: [], total: 0, hasMore: false }),
    clearArchive: vi.fn().mockResolvedValue(true),
    onHistory: vi.fn().mockReturnValue(noop),
    onPermissionRequest: vi.fn().mockReturnValue(noop),
    onAskUser: vi.fn().mockReturnValue(noop),
    onAskUserResolved: vi.fn().mockReturnValue(noop),
    onPermissionResolved: vi.fn().mockReturnValue(noop),
    onSessionReset: vi.fn().mockReturnValue(noop),
    onPromptSuggestion: vi.fn().mockReturnValue(noop),
  },
  git: {
    getGithubUrl: vi.fn().mockResolvedValue(null),
    getBranch: vi.fn().mockResolvedValue(null),
    getLog: vi.fn().mockResolvedValue([]),
    getDiff: vi.fn().mockResolvedValue(''),
    getDiffFiles: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue([]),
    getRoot: vi.fn().mockResolvedValue(null),
  },
  fs: {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue({ content: '' }),
    search: vi.fn().mockResolvedValue([]),
    watch: vi.fn().mockResolvedValue(true),
    unwatch: vi.fn().mockResolvedValue(true),
    onChanged: vi.fn().mockReturnValue(noop),
  },
  profile: {
    list: vi.fn().mockResolvedValue({ profiles: [], activeProfileId: '' }),
    create: vi.fn().mockResolvedValue({ id: '', name: '', type: 'local', createdAt: 0, updatedAt: 0 }),
    save: vi.fn().mockResolvedValue(true),
    load: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    rename: vi.fn().mockResolvedValue(true),
    update: vi.fn().mockResolvedValue(true),
    duplicate: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue(null),
    getActiveId: vi.fn().mockResolvedValue(''),
    setActiveId: vi.fn().mockResolvedValue(undefined),
  },
  remote: {
    startServer: vi.fn().mockResolvedValue({ port: 0, token: '' }),
    stopServer: vi.fn().mockResolvedValue(true),
    serverStatus: vi.fn().mockResolvedValue({ running: false, port: null, clients: [] }),
    connect: vi.fn().mockResolvedValue({ connected: true }),
    disconnect: vi.fn().mockResolvedValue(true),
    clientStatus: vi.fn().mockResolvedValue({ connected: false, info: null }),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
  },
  tunnel: {
    getConnection: vi.fn().mockResolvedValue({ error: 'not connected' }),
  },
  system: {
    onResume: vi.fn().mockReturnValue(noop),
  },
  debug: {
    log: vi.fn(),
  },
  snippet: {
    getAll: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    toggleFavorite: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    getCategories: vi.fn().mockResolvedValue([]),
    getFavorites: vi.fn().mockResolvedValue([]),
  },
}

// Install mock on window when in jsdom environment
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'electronAPI', {
    value: mockElectronAPI,
    writable: true,
    configurable: true,
  })
}
