import { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerMonitor, clipboard, nativeImage } from 'electron'
import path from 'path'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import { execFileSync } from 'child_process'
import { WindowRegistry } from './window-registry'

// Fix PATH for GUI-launched apps on macOS.
// When launched via .dmg / Applications, macOS gives a minimal PATH that
// doesn't include Homebrew (/opt/homebrew/bin), NVM, etc.
// We source the user's login shell to get the real PATH.
if (process.platform === 'darwin') {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // fish stores PATH as a list; use string join to get colon-separated output
    const isFish = shell.endsWith('/fish') || shell === 'fish'
    const cmd = isFish ? 'string join : $PATH' : 'echo $PATH'
    const rawPath = execFileSync(shell, ['-l', '-c', cmd], {
      timeout: 3000,
      encoding: 'utf8',
    }).trim()
    if (rawPath) {
      process.env.PATH = rawPath
    }
  } catch {
    // Fallback: prepend the most common node locations
    const extraPaths = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      `${process.env.HOME}/.volta/bin`,
    ]
    // Resolve nvm: find the latest installed version's bin directory.
    // NOTE: This intentionally duplicates the semver sort from node-resolver.ts
    // because this code runs at the top level before any ES module imports,
    // and importing node-resolver here would break the PATH fix ordering.
    try {
      const nvmDir = `${process.env.HOME}/.nvm/versions/node`
      const versions = fsSync.readdirSync(nvmDir).filter((v: string) => v.startsWith('v'))
      if (versions.length > 0) {
        versions.sort((a: string, b: string) => {
          const pa = a.replace(/^v/, '').split('.').map(Number)
          const pb = b.replace(/^v/, '').split('.').map(Number)
          for (let i = 0; i < 3; i++) { const d = (pa[i]||0) - (pb[i]||0); if (d !== 0) return d; }
          return 0
        })
        extraPaths.push(`${nvmDir}/${versions[versions.length - 1]}/bin`)
      }
    } catch { /* nvm not installed */ }
    process.env.PATH = `${extraPaths.join(':')}:${process.env.PATH || ''}`
  }
}
import { PtyManager } from './pty-manager'
import { ClaudeAgentManager } from './claude-agent-manager'
import { CodexAgentManager } from './codex-agent-manager'
import { worktreeManager } from './worktree-manager'
import { checkForUpdates, UpdateCheckResult } from './update-checker'
import { snippetDb, CreateSnippetInput } from './snippet-db'
import { accountManager } from './account-manager'
import { ProfileManager, type ProfileSnapshot } from './profile-manager'
import { registerHandler, invokeHandler } from './remote/handler-registry'
import { broadcastHub } from './remote/broadcast-hub'
import { PROXIED_CHANNELS } from './remote/protocol'
import { RemoteServer } from './remote/remote-server'
import { RemoteClient } from './remote/remote-client'
import { getConnectionInfo } from './remote/tunnel-manager'
import { logger } from './logger'

// Startup timing — capture module load time before anything else
const _processStart = Number(process.env._BAT_T0 || Date.now())
console.log(`[startup] main.ts module loaded: +${Date.now() - _processStart}ms from process start`)

// Global error handlers — prevent silent crashes in main process
process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
  // EPIPE errors are expected when writing to pipes of killed subprocesses (e.g. Claude agent)
  // They are harmless and should not pollute logs.
  if (error.code === 'EPIPE') return
  logger.error('Uncaught exception:', error)
})
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason)
})

// GPU disk cache: set dedicated path to avoid "Unable to move the cache" errors on Windows.
// These errors block GPU compositing and can add seconds to first paint.
app.commandLine.appendSwitch('gpu-disk-cache-dir', path.join(app.getPath('temp'), 'bat-gpu-cache'))
// Disable GPU shader disk cache (another source of "Unable to create cache" errors)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// Disable Service Workers — we don't use them, and a corrupted SW database
// causes Chromium to block the renderer for 4+ seconds on Windows during I/O recovery.
app.commandLine.appendSwitch('disable-features', 'ServiceWorker')

// Set app name (shown in dock/taskbar instead of "Electron" during dev)
app.setName('BetterAgentTerminal')

// --runtime=N or BAT_RUNTIME=N: allow multiple independent instances with separate data directories
// Each runtime gets its own user data path and single-instance lock
// CLI arg takes precedence over env var; env var works reliably in dev mode (vite-plugin-electron)
const runtimeArg = process.argv.find(a => a.startsWith('--runtime='))
const runtimeId = runtimeArg ? runtimeArg.split('=')[1] : (process.env.BAT_RUNTIME || undefined)
if (runtimeId) {
  const basePath = app.getPath('userData')
  const runtimePath = path.join(path.dirname(basePath), `${path.basename(basePath)}-runtime-${runtimeId}`)
  app.setPath('userData', runtimePath)
  console.log(`[runtime] BAT_RUNTIME=${runtimeId}, userData=${runtimePath}`)
} else {
  console.log(`[runtime] default instance, userData=${app.getPath('userData')}`)
}

// Set AppUserModelId for Windows taskbar pinning (must be before app.whenReady)
if (process.platform === 'win32') {
  const appModelId = runtimeId
    ? `org.tonyq.better-agent-terminal.runtime-${runtimeId}`
    : 'org.tonyq.better-agent-terminal'
  app.setAppUserModelId(appModelId)

  // Fix Start Menu shortcut AppUserModelId for Windows notifications (issue #77).
  // NSIS installer may not embed the AppUserModelId into the .lnk, causing Windows
  // to silently drop all toast notifications. Patch it at startup if needed.
  if (!runtimeId) {
    try {
      const shortcutPath = path.join(
        app.getPath('appData'),
        'Microsoft', 'Windows', 'Start Menu', 'Programs', 'BetterAgentTerminal.lnk'
      )
      if (fsSync.existsSync(shortcutPath)) {
        const shortcut = shell.readShortcutLink(shortcutPath)
        if (shortcut.appUserModelId !== appModelId) {
          shell.writeShortcutLink(shortcutPath, 'update', { appUserModelId: appModelId })
        }
      }
    } catch { /* non-critical — notification may not work but app still runs */ }
  }
}

// Single instance lock — if a second instance is launched, focus existing and open new window
// Each --runtime=N has its own lock (via separate userData path)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // Another instance with the same runtime is already running
  app.quit()
}

const windowMap = new Map<string, BrowserWindow>() // windowId → BrowserWindow
let ptyManager: PtyManager | null = null
let claudeManager: ClaudeAgentManager | null = null
let codexManager: CodexAgentManager | null = null
const sessionManagerMap = new Map<string, 'claude' | 'codex'>()
let updateCheckResult: UpdateCheckResult | null = null
const profileManager = new ProfileManager()
const remoteServer = new RemoteServer()
let remoteClient: RemoteClient | null = null
const detachedWindows = new Map<string, BrowserWindow>() // workspaceId → BrowserWindow
let isAppQuitting = false // Distinguishes Cmd+Q (preserve) from Cmd+W (remove window)

/** Attach a will-resize throttle to a BrowserWindow to reduce DWM pressure on Windows. */
function setupResizeThrottle(win: BrowserWindow, label: string) {
  let lastResizeTime = 0
  let throttledCount = 0
  win.on('will-resize', (event, newBounds) => {
    const now = Date.now()
    const elapsed = now - lastResizeTime
    if (elapsed < 100) {
      event.preventDefault()
      throttledCount++
    } else {
      if (throttledCount > 0) {
        logger.log(`[resize] ${label} will-resize: ${throttledCount} events throttled since last ALLOWED`)
        throttledCount = 0
      }
      lastResizeTime = now
      logger.log(`[resize] ${label} will-resize ALLOWED ${newBounds.width}x${newBounds.height}`)
    }
  })
}

function getAllWindows(): BrowserWindow[] {
  const wins: BrowserWindow[] = []
  for (const win of windowMap.values()) {
    if (!win.isDestroyed()) wins.push(win)
  }
  for (const win of detachedWindows.values()) {
    if (!win.isDestroyed()) wins.push(win)
  }
  return wins
}

/** Reverse lookup: find windowId from a WebContents (for IPC sender context) */
function getWindowIdByWebContents(wc: Electron.WebContents): string | null {
  for (const [id, win] of windowMap) {
    if (!win.isDestroyed() && win.webContents === wc) return id
  }
  return null
}

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const GITHUB_REPO_URL = 'https://github.com/tony1223/better-agent-terminal'

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'GitHub Repository',
          click: () => shell.openExternal(GITHUB_REPO_URL)
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal(`${GITHUB_REPO_URL}/issues`)
        },
        {
          label: 'Releases',
          click: () => shell.openExternal(`${GITHUB_REPO_URL}/releases`)
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            const focusedWin = BrowserWindow.getFocusedWindow() || [...windowMap.values()][0]
            if (focusedWin) {
              dialog.showMessageBox(focusedWin, {
                type: 'info',
                title: 'About Better Agent Terminal',
                message: 'Better Agent Terminal',
                detail: `Version: ${app.getVersion()}\n\nA terminal aggregator with multi-workspace support and Claude Agent integration.\n\nAuthor: TonyQ`
              })
            }
          }
        }
      ]
    }
  ]

  // Add Update menu item if update is available
  if (updateCheckResult?.hasUpdate && updateCheckResult.latestRelease) {
    template.push({
      label: '🎉 Update Available!',
      submenu: [
        {
          label: `View ${updateCheckResult.latestRelease.tagName} on GitHub`,
          click: () => shell.openExternal(`${GITHUB_REPO_URL}/releases`)
        }
      ]
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function createWindow(windowId: string, bounds?: { x: number; y: number; width: number; height: number }) {
  const win = new BrowserWindow({
    width: bounds?.width || 1400,
    height: bounds?.height || 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 800,
    minHeight: 600,
    show: true,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    frame: true,
    titleBarStyle: 'default',
    title: 'Better Agent Terminal',
    icon: nativeImage.createFromPath(path.join(__dirname, process.platform === 'win32' ? '../assets/icon.ico' : '../assets/icon.png'))
  })

  windowMap.set(windowId, win)

  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png'))
    app.dock.setIcon(dockIcon)
  }

  // Create managers once (shared across all windows)
  if (!ptyManager) ptyManager = new PtyManager(getAllWindows)
  if (!claudeManager) claudeManager = new ClaudeAgentManager(getAllWindows)
  if (!codexManager) codexManager = new CodexAgentManager(getAllWindows)

  const urlParam = `?windowId=${encodeURIComponent(windowId)}`
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + urlParam)
    if (windowMap.size === 1) win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'), { search: urlParam })
  }

  setupResizeThrottle(win, `window-${windowId.slice(0, 12)}`)

  // Save window bounds on move/resize (debounced)
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const b = win.getBounds()
      windowRegistry.getEntry(windowId).then(entry => {
        if (entry) {
          entry.bounds = b
          entry.lastActiveAt = Date.now()
          windowRegistry.saveEntry(entry)
        }
      })
    }, 1000)
  }
  win.on('moved', saveBounds)
  win.on('resized', saveBounds)

  win.on('close', (e) => {
    if (isAppQuitting) {
      // App quitting (Cmd+Q): save handled by before-quit, just let it close
      return
    }

    // Manual close (Cmd+W / click X)
    e.preventDefault()
    windowRegistry.getEntry(windowId).then(async (entry) => {
      if (!entry?.profileId) {
        // No profile — just close and remove entry
        await windowRegistry.removeEntry(windowId)
        win.destroy()
        return
      }

      // Count how many windows this profile currently has open
      const allEntries = await windowRegistry.readAll()
      const profileWindowCount = allEntries.filter(e =>
        e.profileId === entry.profileId && windowMap.has(e.id)
      ).length

      if (profileWindowCount <= 1) {
        // Last window in profile — preserve snapshot but mark profile inactive
        await profileManager.deactivateProfile(entry.profileId!)
        win.destroy()
        return
      }

      // No workspaces — silently remove from profile without asking
      if (!entry.workspaces || entry.workspaces.length === 0) {
        const profileId = entry.profileId!
        await windowRegistry.removeEntry(windowId)
        await profileManager.save(profileId).catch(() => { /* ignore */ })
        const remaining = (await windowRegistry.readAll()).filter(e =>
          e.profileId === profileId && windowMap.has(e.id) && e.id !== windowId
        )
        if (remaining.length === 0) {
          await profileManager.deactivateProfile(profileId)
        }
        win.destroy()
        return
      }

      // Multiple windows — ask user
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Remove from profile', 'Close only', 'Cancel'],
        defaultId: 1,
        cancelId: 2,
        title: 'Close Window',
        message: 'How do you want to close this window?',
        detail: 'Remove from profile: this window won\'t be restored next time.\nClose only: preserve it in the profile for next launch.',
      })

      if (response === 2) return // Cancel

      if (response === 0) {
        // Remove from profile: delete entry, then save remaining windows
        const profileId = entry.profileId!
        await windowRegistry.removeEntry(windowId)
        await profileManager.save(profileId).catch(() => { /* ignore */ })
        // If that was the last open window for this profile, deactivate it
        const remaining = (await windowRegistry.readAll()).filter(e =>
          e.profileId === profileId && windowMap.has(e.id) && e.id !== windowId
        )
        if (remaining.length === 0) {
          await profileManager.deactivateProfile(profileId)
        }
      }
      // response === 1: Close only — keep entry in registry, save snapshot so it persists
      if (response === 1 && entry.profileId) {
        await profileManager.save(entry.profileId).catch(() => { /* ignore */ })
      }

      win.destroy()
    }).catch(() => { /* ignore */ })
  })

  win.on('closed', () => {
    windowMap.delete(windowId)
    // Close detached windows that were opened from this window
    // (for now close all detached — same as before)
    if (windowMap.size === 0) {
      for (const [, dw] of detachedWindows) {
        if (!dw.isDestroyed()) dw.close()
      }
      detachedWindows.clear()
    }
  })

  return win
}

function cleanupAllProcesses() {
  try { remoteClient?.disconnect() } catch { /* ignore */ }
  try { remoteServer.stop() } catch { /* ignore */ }
  try { claudeManager?.killAll() } catch { /* ignore */ }
  try { claudeManager?.dispose() } catch { /* ignore */ }
  try { codexManager?.killAll() } catch { /* ignore */ }
  try { codexManager?.dispose() } catch { /* ignore */ }
  try { ptyManager?.dispose() } catch { /* ignore */ }
  remoteClient = null
  claudeManager = null
  codexManager = null
  sessionManagerMap.clear()
  ptyManager = null
}

// Handle launch arguments (kept for backward compat but no longer spawns processes)
const profileArg = process.argv.find(a => a.startsWith('--profile='))
const launchProfileId = profileArg ? profileArg.split('=')[1] || null : null

const windowRegistry = new WindowRegistry()
profileManager.setWindowRegistry(windowRegistry)

// Helper: load snapshot for a profile, handling remote profiles by fetching from the remote server
async function loadProfileSnapshot(profileId: string): Promise<ProfileSnapshot | null> {
  const profileEntry = await profileManager.getProfile(profileId)
  if (profileEntry?.type === 'remote' && profileEntry.remoteHost && profileEntry.remoteToken) {
    try {
      const client = new RemoteClient(getAllWindows)
      const ok = await client.connect(
        profileEntry.remoteHost,
        profileEntry.remotePort || 9876,
        profileEntry.remoteToken,
      )
      if (!ok) {
        logger.error(`[profile] remote connect failed for profile ${profileId} (${profileEntry.remoteHost}:${profileEntry.remotePort})`)
        return null
      }
      remoteClient = client
      const targetProfileId = profileEntry.remoteProfileId || 'default'
      const snapshot = await client.invoke('profile:load-snapshot', [targetProfileId]) as ProfileSnapshot | null
      logger.log(`[profile] remote profile ${profileId} → got ${snapshot?.windows?.length ?? 0} window(s) from remote (target: ${targetProfileId})`)
      return snapshot
    } catch (err) {
      logger.error(`[profile] remote profile ${profileId} snapshot fetch failed:`, err instanceof Error ? err.message : String(err))
      return null
    }
  }
  return await profileManager.loadSnapshot(profileId)
}

app.whenReady().then(async () => {
  const t0 = Date.now()
  logger.init(app.getPath('userData'))
  logger.log(`[startup] ═══════════════════════════════════════`)
  logger.log(`[startup] app.whenReady fired at +${t0 - _t0}ms from IPC reg, +${t0 - _processStart}ms from process`)

  // Ensure profile system is initialized (migrates from workspaces.json on first run)
  const migratedEntries = await windowRegistry.ensureInitialized()

  // If migration just happened (first run after upgrade), save migrated data as profile snapshot
  // BEFORE clearing windows.json, so workspaces aren't lost
  if (migratedEntries.length > 0) {
    const profileIds = [...new Set(migratedEntries.filter(e => e.profileId).map(e => e.profileId!))]
    for (const pid of profileIds) {
      const saved = await profileManager.save(pid).catch(() => false)
      logger.log(`[startup] saved migration snapshot for profile ${pid}: ${saved}`)
    }
  }

  // Collect window IDs to create
  const windowsToCreate: { id: string; bounds?: { x: number; y: number; width: number; height: number } }[] = []

  // Clear windows.json — it's purely runtime state, snapshots are the source of truth
  await windowRegistry.clear()

  // Helper: apply a snapshot's windows into the registry
  const applySnapshot = async (profileId: string, snapshot: ProfileSnapshot): Promise<number> => {
    if (!snapshot || snapshot.windows.length === 0) return 0
    for (const winSnap of snapshot.windows) {
      const entry = await windowRegistry.createEntry({ profileId })
      entry.workspaces = winSnap.workspaces
      entry.activeWorkspaceId = winSnap.activeWorkspaceId
      entry.activeGroup = winSnap.activeGroup
      entry.terminals = winSnap.terminals
      entry.activeTerminalId = winSnap.activeTerminalId
      entry.bounds = winSnap.bounds
      await windowRegistry.saveEntry(entry)
      windowsToCreate.push({ id: entry.id, bounds: winSnap.bounds })
    }
    return snapshot.windows.length
  }

  // Helper: restore windows for a profile at startup
  const restoreFromSnapshot = async (profileId: string): Promise<number> => {
    const snapshot = await loadProfileSnapshot(profileId)
    if (!snapshot) return 0
    return applySnapshot(profileId, snapshot)
  }

  if (launchProfileId) {
    // --profile= launch: restore that profile's windows
    const count = await restoreFromSnapshot(launchProfileId)
    if (count === 0) {
      // No snapshot — create empty window
      const entry = await windowRegistry.createEntry({ profileId: launchProfileId })
      windowsToCreate.push({ id: entry.id })
    }
    await profileManager.activateProfile(launchProfileId)
    logger.log(`[startup] profile launch ${launchProfileId} → ${windowsToCreate.length} window(s)`)
  } else {
    // Normal launch: restore windows for all active profiles
    let activeProfileIds = await profileManager.getActiveProfileIds()
    logger.log(`[startup] active profiles: ${activeProfileIds.join(', ') || '(none)'}`)

    // If no active profiles, fallback to default or first local profile
    if (activeProfileIds.length === 0) {
      const { profiles } = await profileManager.list()
      const fallback = profiles.find(p => p.id === 'default') || profiles.find(p => p.type === 'local') || profiles[0]
      const fallbackId = fallback?.id || 'default'
      activeProfileIds = [fallbackId]
      await profileManager.activateProfile(fallbackId)
      logger.log(`[startup] no active profiles, falling back to ${fallbackId}`)
    }

    for (const pid of activeProfileIds) {
      const count = await restoreFromSnapshot(pid)
      logger.log(`[startup] restored ${count} window(s) from profile ${pid}`)
    }

    // If still no windows (all snapshots empty), create one empty window
    if (windowsToCreate.length === 0) {
      const entry = await windowRegistry.createEntry({ profileId: activeProfileIds[0] })
      windowsToCreate.push({ id: entry.id })
      logger.log(`[startup] created empty window for profile ${activeProfileIds[0]}`)
    }
  }

  const t1 = Date.now()
  buildMenu()
  logger.log(`[startup] buildMenu: ${Date.now() - t1}ms`)
  remoteServer.configDir = app.getPath('userData')

  // Create all windows in this process
  for (const w of windowsToCreate) {
    const t2 = Date.now()
    const win = createWindow(w.id, w.bounds)
    logger.log(`[startup] createWindow ${w.id}: ${Date.now() - t2}ms`)
    // Startup instrumentation on first window only
    if (windowMap.size === 1) {
      win.webContents.on('did-start-loading', () => {
        logger.log(`[startup] did-start-loading: +${Date.now() - t0}ms from whenReady`)
      })
      win.webContents.on('dom-ready', () => {
        logger.log(`[startup] dom-ready: +${Date.now() - t0}ms from whenReady`)
      })
      win.webContents.on('did-finish-load', () => {
        logger.log(`[startup] did-finish-load: +${Date.now() - t0}ms from whenReady`)
      })
      const ipcSub = () => {
        logger.log(`[startup] first-renderer-ipc: +${Date.now() - t0}ms from whenReady`)
        win.webContents.removeListener('ipc-message', ipcSub)
      }
      win.webContents.on('ipc-message', ipcSub)
    }
  }

  // Second instance launched — open a new window in existing process
  app.on('second-instance', async (_event, argv) => {
    // Check if launched with --profile=
    const profileArg2 = argv.find(a => a.startsWith('--profile='))
    const profileId2 = profileArg2 ? profileArg2.split('=')[1] || null : null

    if (profileId2) {
      // Open profile (focus if already open, otherwise restore from snapshot)
      const entries = await windowRegistry.readAll()
      const existing = entries.filter(e => e.profileId === profileId2)
      const openWin = existing.find(e => {
        const w = windowMap.get(e.id)
        return w && !w.isDestroyed()
      })
      if (openWin) {
        const w = windowMap.get(openWin.id)!
        if (w.isMinimized()) w.restore()
        w.focus()
      } else {
        await profileManager.activateProfile(profileId2)
        const snapshot = await loadProfileSnapshot(profileId2)
        if (snapshot && snapshot.windows.length > 0) {
          for (const winSnap of snapshot.windows) {
            const entry = await windowRegistry.createEntry({ profileId: profileId2 })
            entry.workspaces = winSnap.workspaces
            entry.activeWorkspaceId = winSnap.activeWorkspaceId
            entry.activeGroup = winSnap.activeGroup
            entry.terminals = winSnap.terminals
            entry.activeTerminalId = winSnap.activeTerminalId
            entry.bounds = winSnap.bounds
            await windowRegistry.saveEntry(entry)
            createWindow(entry.id, winSnap.bounds)
          }
        } else {
          const entry = await windowRegistry.createEntry({ profileId: profileId2 })
          createWindow(entry.id)
        }
      }
    } else {
      // No profile arg — open new window inheriting first active profile
      const activeIds = await profileManager.getActiveProfileIds()
      const pid = activeIds[0] || 'default'
      const entry = await windowRegistry.createEntry({ profileId: pid })
      createWindow(entry.id)
    }
  })

  // Listen for system resume from sleep/hibernate
  powerMonitor.on('resume', () => {
    logger.log('System resumed from sleep')
    for (const win of getAllWindows()) {
      win.webContents.send('system:resume')
    }
  })

  // Check for updates after startup
  setTimeout(async () => {
    try {
      updateCheckResult = await checkForUpdates()
      if (updateCheckResult.hasUpdate) {
        // Rebuild menu to show update option
        buildMenu()
      }
    } catch (error) {
      logger.error('Failed to check for updates:', error)
    }
  }, 2000)
})

// Cleanup runs once: before-quit covers cmd+Q / File→Quit paths,
// window-all-closed covers the user closing the last window.
// Guard with a flag to avoid running twice.
let _cleanupDone = false
function runCleanupOnce() {
  if (_cleanupDone) return
  _cleanupDone = true
  cleanupAllProcesses()
}

app.on('before-quit', async (e) => {
  if (!isAppQuitting) {
    e.preventDefault()
    isAppQuitting = true

    // Save all open windows' profiles before quitting
    try {
      const allEntries = await windowRegistry.readAll()
      const profileIds = [...new Set(allEntries.filter(e => e.profileId).map(e => e.profileId!))]
      await Promise.all(profileIds.map(pid => profileManager.save(pid).catch(() => { /* ignore */ })))
      logger.log(`[quit] saved ${profileIds.length} profile snapshot(s)`)
    } catch (err) {
      logger.error(`[quit] failed to save profiles: ${err}`)
    }

    runCleanupOnce()
    app.quit()
  }
})

app.on('window-all-closed', () => {
  runCleanupOnce()
  app.quit()
  // Force exit — child processes (PTY shells, Claude CLI) may keep the event loop alive.
  if (process.platform !== 'darwin') {
    setTimeout(() => process.exit(0), 2000)
  }
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const entry = await windowRegistry.createEntry()
    createWindow(entry.id)
  }
})

// ── Proxied handler registration (callable by both IPC and remote server) ──

function registerProxiedHandlers() {
  const MESSAGE_ARCHIVE_DIR = path.join(app.getPath('userData'), 'message-archives')

  // PTY
  registerHandler('pty:create', (_ctx, options: unknown) => ptyManager?.create(options as import('../src/types').CreatePtyOptions))
  registerHandler('pty:write', (_ctx, id: string, data: string) => ptyManager?.write(id, data))
  registerHandler('pty:resize', (_ctx, id: string, cols: number, rows: number) => {
    logger.log(`[resize] pty:resize id=${id} cols=${cols} rows=${rows}`)
    return ptyManager?.resize(id, cols, rows)
  })
  registerHandler('pty:kill', (_ctx, id: string) => ptyManager?.kill(id))
  registerHandler('pty:restart', (_ctx, id: string, cwd: string, shellPath?: string) => ptyManager?.restart(id, cwd, shellPath))
  registerHandler('pty:get-cwd', (_ctx, id: string) => ptyManager?.getCwd(id))

  // Workspace persistence — save/load from window registry entry
  registerHandler('workspace:save', async (ctx, data: string) => {
    if (!ctx.windowId) return false
    const parsed = JSON.parse(data)
    const entry = await windowRegistry.getEntry(ctx.windowId)
    if (!entry) return false
    entry.workspaces = parsed.workspaces || []
    entry.activeWorkspaceId = parsed.activeWorkspaceId || null
    entry.activeGroup = parsed.activeGroup || null
    entry.terminals = parsed.terminals || []
    entry.activeTerminalId = parsed.activeTerminalId || null
    entry.lastActiveAt = Date.now()
    await windowRegistry.saveEntry(entry)
    // Also persist to profile snapshot so force-quit doesn't lose state
    if (entry.profileId) {
      profileManager.save(entry.profileId).catch(() => { /* ignore */ })
    }
    return true
  })
  registerHandler('workspace:load', async (ctx) => {
    if (!ctx.windowId) return null
    const entry = await windowRegistry.getEntry(ctx.windowId)
    if (!entry) return null
    return JSON.stringify({
      workspaces: entry.workspaces,
      activeWorkspaceId: entry.activeWorkspaceId,
      activeGroup: entry.activeGroup,
      terminals: entry.terminals,
      activeTerminalId: entry.activeTerminalId,
    })
  })

  // Settings persistence
  registerHandler('settings:save', async (_ctx, data: string) => {
    const configPath = path.join(app.getPath('userData'), 'settings.json')
    await fs.writeFile(configPath, data, 'utf-8')
    return true
  })
  registerHandler('settings:load', async (_ctx) => {
    const configPath = path.join(app.getPath('userData'), 'settings.json')
    try { return await fs.readFile(configPath, 'utf-8') } catch { return null }
  })
  registerHandler('settings:clear-terminal-history', async () => {
    const historyDir = path.join(app.getPath('userData'), 'terminal-history')
    try {
      const entries = await fs.readdir(historyDir)
      for (const entry of entries) {
        if (entry === '.zsh-wrapper') continue
        await fs.rm(path.join(historyDir, entry), { recursive: true, force: true })
      }
      return true
    } catch {
      return true
    }
  })
  const shellPathCache = new Map<string, string>()
  registerHandler('settings:get-shell-path', (_ctx, shellType: string) => {
    const cached = shellPathCache.get(shellType)
    if (cached) return cached

    let result: string
    if (process.platform === 'darwin' || process.platform === 'linux') {
      if (shellType === 'auto') result = process.env.SHELL || '/bin/zsh'
      else if (shellType === 'zsh') result = '/bin/zsh'
      else if (shellType === 'bash') {
        if (fsSync.existsSync('/opt/homebrew/bin/bash')) result = '/opt/homebrew/bin/bash'
        else if (fsSync.existsSync('/usr/local/bin/bash')) result = '/usr/local/bin/bash'
        else result = '/bin/bash'
      }
      else if (shellType === 'sh') result = '/bin/sh'
      else if (shellType === 'pwsh' || shellType === 'powershell' || shellType === 'cmd') result = process.env.SHELL || '/bin/zsh'
      else result = shellType
    } else {
      if (shellType === 'auto' || shellType === 'pwsh') {
        const pwshPaths = [
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
          process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\pwsh.exe'
        ]
        let found = ''
        for (const p of pwshPaths) { if (fsSync.existsSync(p)) { found = p; break } }
        if (found) result = found
        else if (shellType === 'pwsh') result = 'pwsh.exe'
        else if (shellType === 'auto' || shellType === 'powershell') result = 'powershell.exe'
        else if (shellType === 'cmd') result = 'cmd.exe'
        else result = shellType
      }
      else if (shellType === 'powershell') result = 'powershell.exe'
      else if (shellType === 'cmd') result = 'cmd.exe'
      else result = shellType
    }

    shellPathCache.set(shellType, result)
    return result
  })

  // Get bundled Claude CLI path for claude-cli preset
  registerHandler('claude:get-cli-path', () => {
    try {
      let resolved = require.resolve('@anthropic-ai/claude-code/cli.js')
      if (resolved.includes('app.asar') && !resolved.includes('app.asar.unpacked')) {
        resolved = resolved.replace('app.asar', 'app.asar.unpacked')
      }
      return resolved
    } catch {
      return ''
    }
  })

  // Session manager dispatcher: routes to Claude or Codex manager based on agentPreset
  function getManager(sessionId: string): ClaudeAgentManager | CodexAgentManager | null {
    const type = sessionManagerMap.get(sessionId)
    if (type === 'codex') return codexManager
    return claudeManager
  }

  // Claude Agent SDK
  registerHandler('claude:start-session', (_ctx, sessionId: string, options: { cwd: string; prompt?: string; permissionMode?: string; model?: string; effort?: string; apiVersion?: 'v1' | 'v2'; useWorktree?: boolean; worktreePath?: string; worktreeBranch?: string; autoCompactWindow?: number; agentPreset?: string; codexSandboxMode?: string; codexApprovalPolicy?: string }) => {
    if (options.agentPreset === 'codex-cli') {
      sessionManagerMap.set(sessionId, 'codex')
      return codexManager?.startSession(sessionId, options)
    }
    sessionManagerMap.set(sessionId, 'claude')
    return claudeManager?.startSession(sessionId, options)
  })
  registerHandler('claude:send-message', (_ctx, sessionId: string, prompt: string, images?: string[]) => getManager(sessionId)?.sendMessage(sessionId, prompt, images))
  registerHandler('claude:stop-session', (_ctx, sessionId: string) => getManager(sessionId)?.stopSession(sessionId))
  registerHandler('claude:abort-session', (_ctx, sessionId: string) => getManager(sessionId)?.abortSession(sessionId))
  registerHandler('claude:set-permission-mode', (_ctx, sessionId: string, mode: string) => getManager(sessionId)?.setPermissionMode(sessionId, mode as import('@anthropic-ai/claude-agent-sdk').PermissionMode))
  registerHandler('claude:set-model', (_ctx, sessionId: string, model: string, autoCompactWindow?: number) => {
    const mgr = getManager(sessionId)
    if (mgr instanceof ClaudeAgentManager) return mgr.setModel(sessionId, model, autoCompactWindow)
    return (mgr as CodexAgentManager)?.setModel(sessionId, model)
  })
  registerHandler('claude:set-effort', (_ctx, sessionId: string, effort: string) => getManager(sessionId)?.setEffort(sessionId, effort as 'low' | 'medium' | 'high' | 'max'))
  registerHandler('claude:reset-session', (_ctx, sessionId: string) => getManager(sessionId)?.resetSession(sessionId))
  registerHandler('claude:get-supported-models', (_ctx, sessionId: string) => getManager(sessionId)?.getSupportedModels(sessionId))
  registerHandler('claude:get-account-info', (_ctx, sessionId: string) => getManager(sessionId)?.getAccountInfo(sessionId))
  registerHandler('claude:get-supported-commands', (_ctx, sessionId: string) => getManager(sessionId)?.getSupportedCommands(sessionId))
  registerHandler('claude:get-supported-agents', (_ctx, sessionId: string) => getManager(sessionId)?.getSupportedAgents(sessionId))
  registerHandler('claude:get-worktree-status', (_ctx, sessionId: string) => getManager(sessionId)?.getWorktreeStatus(sessionId))
  registerHandler('claude:cleanup-worktree', (_ctx, sessionId: string, deleteBranch: boolean) => getManager(sessionId)?.cleanupWorktree(sessionId, deleteBranch))
  // Standalone worktree operations (for claude-cli preset, not tied to SDK session)
  registerHandler('worktree:create', async (_ctx, sessionId: string, cwd: string) => {
    try {
      const info = await worktreeManager.createWorktree(sessionId, cwd)
      return { success: true, ...info }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  registerHandler('worktree:remove', async (_ctx, sessionId: string, deleteBranch: boolean) => {
    try {
      await worktreeManager.removeWorktree(sessionId, deleteBranch)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  registerHandler('worktree:status', async (_ctx, sessionId: string) => {
    return worktreeManager.getWorktreeStatus(sessionId)
  })
  registerHandler('worktree:merge', async (_ctx, sessionId: string, strategy: 'merge' | 'cherry-pick') => {
    return worktreeManager.mergeWorktree(sessionId, strategy)
  })
  registerHandler('worktree:rehydrate', (_ctx, sessionId: string, cwd: string, worktreePath: string, branchName: string) => {
    worktreeManager.rehydrate(sessionId, cwd, worktreePath, branchName)
    return { success: true }
  })

  // claude auth login — open browser-based login flow
  registerHandler('claude:auth-login', async () => {
    const { execFile } = await import('child_process')
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      execFile('claude', ['auth', 'login'], { timeout: 60000 }, (err) => {
        if (err) {
          logger.error('[auth-login]', err)
          resolve({ success: false, error: err.message })
        } else {
          resolve({ success: true })
        }
      })
    })
  })

  // claude auth status — get current auth info
  registerHandler('claude:auth-status', async () => {
    const { execFile } = await import('child_process')
    return new Promise<{ loggedIn: boolean; email?: string; subscriptionType?: string; authMethod?: string } | null>((resolve) => {
      execFile('claude', ['auth', 'status'], { timeout: 10000 }, (err, stdout) => {
        if (err) {
          logger.error('[auth-status]', err)
          resolve(null)
        } else {
          try {
            resolve(JSON.parse(stdout))
          } catch {
            resolve(null)
          }
        }
      })
    })
  })

  // claude auth logout
  registerHandler('claude:auth-logout', async () => {
    const { execFile } = await import('child_process')
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      execFile('claude', ['auth', 'logout'], { timeout: 10000 }, (err) => {
        if (err) {
          logger.error('[auth-logout]', err)
          resolve({ success: false, error: err.message })
        } else {
          resolve({ success: true })
        }
      })
    })
  })

  // Claude account management
  registerHandler('claude:account-list', async () => {
    await accountManager.load()
    return {
      accounts: accountManager.getAccounts(),
      activeAccountId: accountManager.getActiveAccountId(),
      switchWarningShown: accountManager.isSwitchWarningShown(),
    }
  })

  registerHandler('claude:account-import-current', async () => {
    await accountManager.load()
    const account = await accountManager.importCurrentAccount()
    return account
  })

  registerHandler('claude:account-login-new', async () => {
    await accountManager.load()
    return accountManager.loginNewAccount()
  })

  registerHandler('claude:account-switch', async (_ctx, accountId: string) => {
    await accountManager.load()
    return accountManager.switchAccount(accountId)
  })

  registerHandler('claude:account-remove', async (_ctx, accountId: string) => {
    await accountManager.load()
    return accountManager.removeAccount(accountId)
  })

  registerHandler('claude:account-mark-warning-shown', async () => {
    await accountManager.load()
    await accountManager.markSwitchWarningShown()
    return true
  })

  // Scan .claude/commands/ directories for skill files
  registerHandler('claude:scan-skills', async (_ctx, cwd: string) => {
    const fs = await import('fs')
    const pathMod = await import('path')
    const results: { name: string; description: string; scope: 'project' | 'global' }[] = []
    const homePath = app.getPath('home')
    const dirs: { dir: string; scope: 'project' | 'global' }[] = [
      { dir: pathMod.join(cwd, '.claude', 'commands'), scope: 'project' },
      { dir: pathMod.join(homePath, '.claude', 'commands'), scope: 'global' },
    ]
    for (const { dir, scope } of dirs) {
      try {
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.md'))
        for (const file of files) {
          const name = file.replace(/\.md$/, '')
          try {
            const content = fs.readFileSync(pathMod.join(dir, file), 'utf-8')
            const firstLine = content.split('\n').find((l: string) => l.trim()) || ''
            const description = firstLine.replace(/^#\s*/, '').trim()
            results.push({ name, description, scope })
          } catch {
            results.push({ name, description: '', scope })
          }
        }
      } catch { /* directory doesn't exist or not readable */ }
    }
    return results
  })
  registerHandler('claude:get-session-meta', (_ctx, sessionId: string) => getManager(sessionId)?.getSessionMeta(sessionId))
  registerHandler('claude:get-context-usage', (_ctx, sessionId: string) => getManager(sessionId)?.getContextUsage(sessionId))
  registerHandler('claude:resolve-permission', (_ctx, sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[]; message?: string; dontAskAgain?: boolean }) => getManager(sessionId)?.resolvePermission(sessionId, toolUseId, result))
  registerHandler('claude:resolve-ask-user', (_ctx, sessionId: string, toolUseId: string, answers: Record<string, string>) => getManager(sessionId)?.resolveAskUser(sessionId, toolUseId, answers))
  registerHandler('claude:list-sessions', (_ctx, cwd: string) => claudeManager?.listSessions(cwd))
  registerHandler('claude:resume-session', (_ctx, sessionId: string, sdkSessionId: string, cwd: string, model?: string, apiVersion?: 'v1' | 'v2', useWorktree?: boolean, worktreePath?: string, worktreeBranch?: string) => {
    const type = sessionManagerMap.get(sessionId)
    if (type === 'codex') return codexManager?.resumeSession(sessionId, sdkSessionId, cwd, model)
    return claudeManager?.resumeSession(sessionId, sdkSessionId, cwd, model, apiVersion, useWorktree, worktreePath, worktreeBranch)
  })
  registerHandler('claude:fork-session', (_ctx, sessionId: string) => getManager(sessionId)?.forkSession(sessionId))
  registerHandler('claude:stop-task', (_ctx, sessionId: string, taskId: string) => getManager(sessionId)?.stopTask(sessionId, taskId))
  registerHandler('claude:rest-session', (_ctx, sessionId: string) => getManager(sessionId)?.restSession(sessionId))
  registerHandler('claude:wake-session', (_ctx, sessionId: string) => getManager(sessionId)?.wakeSession(sessionId))
  registerHandler('claude:is-resting', (_ctx, sessionId: string) => getManager(sessionId)?.isResting(sessionId) ?? false)
  registerHandler('claude:fetch-subagent-messages', (_ctx, sessionId: string, agentToolUseId: string) => getManager(sessionId)?.fetchSubagentMessages(sessionId, agentToolUseId) ?? [])

  // Message archiving
  registerHandler('claude:archive-messages', async (_ctx, sessionId: string, messages: unknown[]) => {
    await fs.mkdir(MESSAGE_ARCHIVE_DIR, { recursive: true })
    const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
    const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    await fs.appendFile(filePath, lines, 'utf-8')
    return true
  })
  registerHandler('claude:load-archived', async (_ctx, sessionId: string, offset: number, limit: number) => {
    const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const total = lines.length
      const end = total - offset
      const start = Math.max(0, end - limit)
      if (end <= 0) return { messages: [], total, hasMore: false }
      const slice = lines.slice(start, end)
      return { messages: slice.map(l => JSON.parse(l)), total, hasMore: start > 0 }
    } catch { return { messages: [], total: 0, hasMore: false } }
  })
  registerHandler('claude:clear-archive', async (_ctx, sessionId: string) => {
    const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
    try { await fs.unlink(filePath) } catch { /* ignore */ }
    return true
  })


  // Git
  registerHandler('git:get-github-url', async (_ctx, folderPath: string) => {
    try {
      const { execSync } = await import('child_process')
      const remote = execSync('git remote get-url origin', { cwd: folderPath, encoding: 'utf-8', timeout: 3000 }).trim()
      const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/)
      if (sshMatch) return `https://github.com/${sshMatch[1]}`
      const httpsMatch = remote.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/)
      if (httpsMatch) return `https://github.com/${httpsMatch[1]}`
      return null
    } catch { return null }
  })
  registerHandler('git:branch', async (_ctx, cwd: string) => {
    try {
      const { execSync } = await import('child_process')
      return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }).trim() || null
    } catch { return null }
  })
  registerHandler('git:log', async (_ctx, cwd: string, count: number = 50) => {
    try {
      const { execFileSync } = await import('child_process')
      const safeCount = Math.max(1, Math.min(Math.floor(Number(count)) || 50, 500))
      const raw = execFileSync('git', ['log', `--pretty=format:%H||%an||%ai||%s`, '-n', String(safeCount)], { cwd, encoding: 'utf-8', timeout: 5000 }).trim()
      if (!raw) return []
      return raw.split('\n').map(line => {
        const parts = line.split('||')
        return { hash: parts[0], author: parts[1], date: parts[2], message: parts.slice(3).join('||') }
      })
    } catch { return [] }
  })
  registerHandler('git:diff', async (_ctx, cwd: string, commitHash?: string, filePath?: string) => {
    try {
      const { execFileSync } = await import('child_process')
      const args = commitHash && commitHash !== 'working'
        ? ['diff', `${commitHash}~1..${commitHash}`]
        : ['diff', 'HEAD']
      if (filePath) args.push('--', filePath)
      return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 * 5 })
    } catch { return '' }
  })
  registerHandler('git:diff-files', async (_ctx, cwd: string, commitHash?: string) => {
    try {
      const { execFileSync } = await import('child_process')
      const args = commitHash && commitHash !== 'working'
        ? ['diff', '--name-status', `${commitHash}~1..${commitHash}`]
        : ['diff', '--name-status', 'HEAD']
      const raw = execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 5000 })
      if (!raw.trim()) return []
      return raw.trim().split('\n').map(line => {
        const tab = line.indexOf('\t')
        return { status: tab > 0 ? line.substring(0, tab).trim() : line.charAt(0), file: tab > 0 ? line.substring(tab + 1) : line.substring(2) }
      })
    } catch { return [] }
  })
  registerHandler('git:getRoot', async (_ctx, cwd: string) => {
    try {
      const { execSync } = await import('child_process')
      return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8', timeout: 5000 }).trim()
    } catch { return null }
  })
  registerHandler('git:status', async (_ctx, cwd: string) => {
    try {
      const { execSync } = await import('child_process')
      const raw = execSync('git status --porcelain -uall', { cwd, encoding: 'utf-8', timeout: 5000 })
      if (!raw.trim()) return []
      return raw.split('\n').filter(line => line.trim()).map(line => ({ status: line.substring(0, 2).trim(), file: line.substring(3) }))
    } catch { return [] }
  })

  // GitHub CLI (gh)
  registerHandler('github:check-cli', async (_ctx) => {
    try {
      const { execSync } = await import('child_process')
      execSync('gh --version', { encoding: 'utf-8', timeout: 5000, shell: true })
      try {
        // gh auth status exits non-zero if ANY account has issues, even if the active account is fine.
        // Use gh auth token which only checks the active account and returns 0 if authenticated.
        execSync('gh auth token', { encoding: 'utf-8', timeout: 5000, shell: true, stdio: 'pipe' })
        return { installed: true, authenticated: true }
      } catch {
        return { installed: true, authenticated: false }
      }
    } catch {
      return { installed: false, authenticated: false }
    }
  })
  registerHandler('github:pr-list', async (_ctx, cwd: string) => {
    try {
      const { execSync } = await import('child_process')
      const raw = execSync('gh pr list --json number,title,state,author,createdAt,updatedAt,labels,headRefName,isDraft --limit 50', { cwd, encoding: 'utf-8', timeout: 15000, shell: true, maxBuffer: 5 * 1024 * 1024 })
      return JSON.parse(raw)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:issue-list', async (_ctx, cwd: string) => {
    try {
      const { execSync } = await import('child_process')
      const raw = execSync('gh issue list --json number,title,state,author,createdAt,updatedAt,labels --limit 50', { cwd, encoding: 'utf-8', timeout: 15000, shell: true, maxBuffer: 5 * 1024 * 1024 })
      return JSON.parse(raw)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:pr-view', async (_ctx, cwd: string, number: number) => {
    try {
      const { execSync } = await import('child_process')
      const raw = execSync(`gh pr view ${number} --json number,title,state,author,body,comments,reviews,createdAt,headRefName,baseRefName,additions,deletions,files`, { cwd, encoding: 'utf-8', timeout: 15000, shell: true, maxBuffer: 5 * 1024 * 1024 })
      return JSON.parse(raw)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:issue-view', async (_ctx, cwd: string, number: number) => {
    try {
      const { execSync } = await import('child_process')
      const raw = execSync(`gh issue view ${number} --json number,title,state,author,body,comments,createdAt,labels`, { cwd, encoding: 'utf-8', timeout: 15000, shell: true, maxBuffer: 5 * 1024 * 1024 })
      return JSON.parse(raw)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:pr-comment', async (_ctx, cwd: string, number: number, body: string) => {
    try {
      const { execFileSync } = await import('child_process')
      execFileSync('gh', ['pr', 'comment', String(number), '--body', body], { cwd, encoding: 'utf-8', timeout: 15000 })
      return { success: true }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  registerHandler('github:issue-comment', async (_ctx, cwd: string, number: number, body: string) => {
    try {
      const { execFileSync } = await import('child_process')
      execFileSync('gh', ['issue', 'comment', String(number), '--body', body], { cwd, encoding: 'utf-8', timeout: 15000 })
      return { success: true }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  // File system
  // File watcher for auto-refresh
  const fileWatchers = new Map<string, ReturnType<typeof fsSync.watch>>()
  registerHandler('fs:watch', (_ctx, _dirPath: string) => {
    if (fileWatchers.has(_dirPath)) return true
    try {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      const watcher = fsSync.watch(_dirPath, { recursive: true }, () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          broadcastHub.broadcast('fs:changed', _dirPath)
        }, 500)
      })
      watcher.on('error', () => {
        fileWatchers.delete(_dirPath)
      })
      fileWatchers.set(_dirPath, watcher)
      return true
    } catch { return false }
  })
  registerHandler('fs:unwatch', (_ctx, _dirPath: string) => {
    const watcher = fileWatchers.get(_dirPath)
    if (watcher) {
      watcher.close()
      fileWatchers.delete(_dirPath)
    }
    return true
  })

  registerHandler('fs:readdir', async (_ctx, dirPath: string) => {
    const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.cache', '__pycache__', '.DS_Store'])
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      return entries
        .filter(e => !IGNORED.has(e.name))
        .sort((a, b) => { if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1; return a.name.localeCompare(b.name) })
        .map(e => ({ name: e.name, path: path.join(dirPath, e.name), isDirectory: e.isDirectory() }))
    } catch { return [] }
  })
  registerHandler('fs:readFile', async (_ctx, filePath: string) => {
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > 512 * 1024) return { error: 'File too large', size: stat.size }
      const content = await fs.readFile(filePath, 'utf-8')
      return { content }
    } catch { return { error: 'Failed to read file' } }
  })
  registerHandler('fs:search', async (_ctx, dirPath: string, query: string) => {
    const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.cache', '__pycache__', '.DS_Store', 'release'])
    const results: { name: string; path: string; isDirectory: boolean }[] = []
    const lowerQuery = query.toLowerCase()
    async function walk(dir: string, depth: number) {
      if (depth > 8 || results.length >= 100) return
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const e of entries) {
          if (results.length >= 100) return
          if (IGNORED.has(e.name)) continue
          const fullPath = path.join(dir, e.name)
          if (e.name.toLowerCase().includes(lowerQuery)) results.push({ name: e.name, path: fullPath, isDirectory: e.isDirectory() })
          if (e.isDirectory()) await walk(fullPath, depth + 1)
        }
      } catch { /* skip */ }
    }
    await walk(dirPath, 0)
    return results.sort((a, b) => { if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1; return a.name.localeCompare(b.name) })
  })

  // Snippets
  registerHandler('snippet:getAll', (_ctx) => snippetDb.getAll())
  registerHandler('snippet:getById', (_ctx, id: number) => snippetDb.getById(id))
  registerHandler('snippet:create', (_ctx, input: CreateSnippetInput) => snippetDb.create(input))
  registerHandler('snippet:update', (_ctx, id: number, updates: Partial<CreateSnippetInput>) => snippetDb.update(id, updates))
  registerHandler('snippet:delete', (_ctx, id: number) => snippetDb.delete(id))
  registerHandler('snippet:toggleFavorite', (_ctx, id: number) => snippetDb.toggleFavorite(id))
  registerHandler('snippet:search', (_ctx, query: string) => snippetDb.search(query))
  registerHandler('snippet:getCategories', (_ctx) => snippetDb.getCategories())
  registerHandler('snippet:getFavorites', (_ctx) => snippetDb.getFavorites())
  registerHandler('snippet:getByWorkspace', (_ctx, workspaceId?: string) => snippetDb.getByWorkspace(workspaceId))

  // Profile (subset exposed to remote clients)
  registerHandler('profile:list', (_ctx) => profileManager.list())
  // Local-only profile list (never proxied to remote). Used by the renderer
  // to resolve the window's own identity when connected to a remote host,
  // since the proxied profile:list returns the REMOTE host's profiles and
  // the client's local aliases won't be found there.
  ipcMain.handle('profile:list-local', () => profileManager.list())
  registerHandler('profile:load', (_ctx, profileId: string) => profileManager.load(profileId))
  registerHandler('profile:load-snapshot', (_ctx, profileId: string) => profileManager.loadSnapshot(profileId))
  registerHandler('profile:get-active-ids', (_ctx) => profileManager.getActiveProfileIds())
  registerHandler('profile:activate', (_ctx, profileId: string) => profileManager.activateProfile(profileId))
  registerHandler('profile:deactivate', (_ctx, profileId: string) => profileManager.deactivateProfile(profileId))
}

// ── Bind all proxied handlers to ipcMain ──

// Channels that MUST run locally even when connected to a remote host.
// These handlers depend on ctx.windowId which the remote protocol doesn't
// forward; proxying them would return null and break the UI.
// The snapshot data for workspaces is already replicated into the local
// windowRegistry via applySnapshot() at startup, so reading locally works.
const ALWAYS_LOCAL_CHANNELS = new Set([
  'workspace:save', 'workspace:load',
])

function bindProxiedHandlersToIpc() {
  for (const channel of PROXIED_CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      // If remote client is connected, route to remote server — unless this
      // channel is pinned to local execution.
      if (remoteClient?.isConnected && !ALWAYS_LOCAL_CHANNELS.has(channel)) {
        return remoteClient.invoke(channel, args)
      }
      const windowId = getWindowIdByWebContents(event.sender)
      return invokeHandler(channel, args, windowId)
    })
  }
}

// ── Renderer debug log (fire-and-forget, no blocking) ──
ipcMain.on('debug:log', (_event, ...args: unknown[]) => {
  logger.log('[renderer]', ...args)
})

// ── Local-only IPC handlers (not proxied) ──

function registerLocalHandlers() {
  ipcMain.handle('dialog:select-folder', async (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parentWin!, {
      defaultPath: app.getPath('home'),
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    })
    return result.canceled ? null : result.filePaths
  })

  ipcMain.handle('dialog:select-images', async (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parentWin!, {
      defaultPath: app.getPath('home'),
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:select-files', async (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parentWin!, {
      defaultPath: app.getPath('home'),
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:confirm', async (event, message: string, title?: string) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showMessageBox(parentWin!, {
      type: 'warning',
      buttons: ['OK', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: title || 'Confirm',
      message,
    })
    return result.response === 0
  })

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (url.startsWith('file:///')) {
      const filePath = decodeURIComponent(new URL(url).pathname)
      const { existsSync } = await import('fs')
      if (!existsSync(filePath)) {
        const { dialog } = await import('electron')
        dialog.showMessageBox({ type: 'warning', title: 'File not found', message: `File does not exist:\n${filePath}` })
        return
      }
    }
    await shell.openExternal(url)
  })
  ipcMain.handle('shell:open-path', async (_event, folderPath: string) => { await shell.openPath(folderPath) })

  ipcMain.handle('update:check', async () => {
    try { return await checkForUpdates() }
    catch (error) { logger.error('Failed to check for updates:', error); return { hasUpdate: false, currentVersion: app.getVersion(), latestRelease: null } }
  })
  ipcMain.handle('update:get-version', () => app.getVersion())

  ipcMain.handle('clipboard:saveImage', async () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const os = await import('os')
    const filePath = path.join(os.tmpdir(), `bat-clipboard-${Date.now()}.png`)
    await fs.writeFile(filePath, image.toPNG())
    return filePath
  })
  ipcMain.handle('clipboard:writeImage', async (_event, filePath: string) => {
    const image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  })

  ipcMain.handle('image:read-as-data-url', async (_event, filePath: string) => {
    const ext = path.extname(filePath).toLowerCase()
    const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
    const mime = mimeMap[ext] || 'image/png'
    const data = await fs.readFile(filePath)
    return `data:${mime};base64,${data.toString('base64')}`
  })

  // Remote server handlers (always local)
  ipcMain.handle('remote:start-server', async (_event, port?: number, token?: string) => {
    try { return remoteServer.start(port, token) }
    catch (err: unknown) { return { error: err instanceof Error ? err.message : String(err) } }
  })
  ipcMain.handle('remote:stop-server', async () => {
    remoteServer.stop()
    return true
  })
  ipcMain.handle('remote:server-status', async () => ({
    running: remoteServer.isRunning,
    port: remoteServer.port,
    clients: remoteServer.connectedClients
  }))

  // Mobile QR code connection: ensure server is running, return connection URL
  ipcMain.handle('tunnel:get-connection', async () => {
    try {
      let port: number
      let token: string
      if (!remoteServer.isRunning) {
        const result = remoteServer.start()
        port = result.port
        token = result.token
      } else {
        port = remoteServer.port!
        const tokenPath = path.join(app.getPath('userData'), 'server-token.json')
        token = JSON.parse(fsSync.readFileSync(tokenPath, 'utf-8')).token
      }
      return getConnectionInfo(port, token)
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Remote client handlers
  ipcMain.handle('remote:connect', async (_event, host: string, port: number, token: string, label?: string) => {
    try {
      remoteClient = new RemoteClient(getAllWindows)
      const ok = await remoteClient.connect(host, port, token, label)
      if (!ok) {
        remoteClient = null
        return { error: 'Connection failed (auth rejected or unreachable)' }
      }
      return { connected: true }
    } catch (err: unknown) {
      remoteClient = null
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('remote:disconnect', async () => {
    remoteClient?.disconnect()
    remoteClient = null
    return true
  })
  ipcMain.handle('remote:client-status', async () => ({
    connected: remoteClient?.isConnected ?? false,
    info: remoteClient?.connectionInfo ?? null
  }))
  ipcMain.handle('remote:test-connection', async (_event, host: string, port: number, token: string) => {
    const testClient = new RemoteClient(getAllWindows)
    try {
      const ok = await testClient.connect(host, port, token)
      testClient.disconnect()
      return { ok }
    } catch {
      return { ok: false }
    }
  })
  ipcMain.handle('remote:list-profiles', async (_event, host: string, port: number, token: string) => {
    const tempClient = new RemoteClient(getAllWindows)
    try {
      const ok = await tempClient.connect(host, port, token)
      if (!ok) return { error: 'Connection failed' }
      const result = await tempClient.invoke('profile:list', []) as { profiles: { id: string; name: string; type: string }[] }
      tempClient.disconnect()
      return { profiles: result.profiles.map(p => ({ id: p.id, name: p.name, type: p.type })) }
    } catch (err) {
      tempClient.disconnect()
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Profile handlers (local-only — list/load/activate/deactivate/get-active-ids are proxied)
  ipcMain.handle('profile:create', async (_event, name: string, options?: { type?: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string; remoteProfileId?: string }) => profileManager.create(name, options))
  ipcMain.handle('profile:save', async (_event, profileId: string) => profileManager.save(profileId))
  ipcMain.handle('profile:delete', async (_event, profileId: string) => profileManager.delete(profileId))
  ipcMain.handle('profile:rename', async (_event, profileId: string, newName: string) => profileManager.rename(profileId, newName))
  ipcMain.handle('profile:duplicate', async (_event, profileId: string, newName: string) => profileManager.duplicate(profileId, newName))
  ipcMain.handle('profile:update', async (_event, profileId: string, updates: { remoteHost?: string; remotePort?: number; remoteToken?: string; remoteProfileId?: string }) => profileManager.update(profileId, updates))
  ipcMain.handle('profile:get', async (_event, profileId: string) => profileManager.getProfile(profileId))

  // Get the profile ID this instance was launched with (--profile= argument)
  ipcMain.handle('app:get-launch-profile', () => launchProfileId)
  ipcMain.handle('app:get-window-id', (event) => getWindowIdByWebContents(event.sender))
  // Get the profile ID bound to this window's registry entry
  ipcMain.handle('app:get-window-profile', async (event) => {
    const windowId = getWindowIdByWebContents(event.sender)
    if (!windowId) return null
    const entry = await windowRegistry.getEntry(windowId)
    return entry?.profileId ?? null
  })
  // Get this window's index within its profile (1-based)
  ipcMain.handle('app:get-window-index', async (event) => {
    const windowId = getWindowIdByWebContents(event.sender)
    if (!windowId) return 1
    const entries = await windowRegistry.readAll()
    const entry = entries.find(e => e.id === windowId)
    if (!entry?.profileId) return 1
    const sameProfile = entries.filter(e => e.profileId === entry.profileId)
    return sameProfile.findIndex(e => e.id === windowId) + 1
  })

  // Dock badge count (macOS/Linux)
  ipcMain.handle('app:set-dock-badge', (_event, count: number) => {
    if (process.platform === 'darwin') {
      app.dock.setBadge(count > 0 ? String(count) : '')
    } else if (process.platform === 'linux') {
      app.setBadgeCount(count)
    }
  })

  // Open new empty window (Cmd+N) — inherits profileId from source window
  ipcMain.handle('app:new-window', async (event) => {
    let profileId: string | undefined
    const sourceWindowId = getWindowIdByWebContents(event.sender)
    if (sourceWindowId) {
      const sourceEntry = await windowRegistry.getEntry(sourceWindowId)
      profileId = sourceEntry?.profileId
    }
    const entry = await windowRegistry.createEntry({ profileId })
    createWindow(entry.id)
    return entry.id
  })

  // Open profile windows (focus existing if already open, otherwise restore all from snapshot)
  ipcMain.handle('app:open-new-instance', async (_event, profileId: string) => {
    const entries = await windowRegistry.readAll()
    const existingForProfile = entries.filter(e => e.profileId === profileId)

    // If any windows already open for this profile, focus the most recent one
    const openWindows = existingForProfile.filter(e => {
      const win = windowMap.get(e.id)
      return win && !win.isDestroyed()
    })
    if (openWindows.length > 0) {
      const mostRecent = openWindows.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
      const win = windowMap.get(mostRecent.id)!
      if (win.isMinimized()) win.restore()
      win.focus()
      return { alreadyOpen: true, windowId: mostRecent.id }
    }

    // Mark profile as active
    await profileManager.activateProfile(profileId)

    // Load profile snapshot (handles both local and remote profiles)
    const snapshot = await loadProfileSnapshot(profileId)
    if (snapshot && snapshot.windows.length > 0) {
      const windowIds: string[] = []
      for (const winSnap of snapshot.windows) {
        const entry = await windowRegistry.createEntry({ profileId })
        entry.workspaces = winSnap.workspaces
        entry.activeWorkspaceId = winSnap.activeWorkspaceId
        entry.activeGroup = winSnap.activeGroup
        entry.terminals = winSnap.terminals
        entry.activeTerminalId = winSnap.activeTerminalId
        entry.bounds = winSnap.bounds
        await windowRegistry.saveEntry(entry)
        createWindow(entry.id, winSnap.bounds)
        windowIds.push(entry.id)
      }
      return { alreadyOpen: false, windowIds }
    }

    // Fallback: no snapshot data, open empty window
    const entry = await windowRegistry.createEntry({ profileId })
    createWindow(entry.id)
    return { alreadyOpen: false, windowIds: [entry.id] }
  })

  // Cross-window workspace move (re-index only, no session rebuild)
  ipcMain.handle('workspace:move-to-window', async (_event, sourceWindowId: string, targetWindowId: string, workspaceId: string, insertIndex: number) => {
    const sourceEntry = await windowRegistry.getEntry(sourceWindowId)
    const targetEntry = await windowRegistry.getEntry(targetWindowId)
    if (!sourceEntry || !targetEntry) return false

    // Find workspace in source
    const srcWorkspaces = sourceEntry.workspaces as any[]
    const wsIndex = srcWorkspaces.findIndex((w: any) => w.id === workspaceId)
    if (wsIndex === -1) return false
    const [workspace] = srcWorkspaces.splice(wsIndex, 1)

    // Move associated terminals (single pass)
    const movedTerminals: any[] = []
    const remainingTerminals: any[] = []
    for (const t of sourceEntry.terminals as any[]) {
      if (t.workspaceId === workspaceId) movedTerminals.push(t)
      else remainingTerminals.push(t)
    }
    sourceEntry.terminals = remainingTerminals

    // Insert workspace at target position
    const tgtWorkspaces = targetEntry.workspaces as any[]
    const clampedIndex = Math.min(insertIndex, tgtWorkspaces.length)
    tgtWorkspaces.splice(clampedIndex, 0, workspace)
    ;(targetEntry.terminals as any[]).push(...movedTerminals)

    // Fix activeWorkspaceId if the moved workspace was active in source
    if (sourceEntry.activeWorkspaceId === workspaceId) {
      sourceEntry.activeWorkspaceId = srcWorkspaces[0]?.id || null
    }
    // Set moved workspace as active in target
    targetEntry.activeWorkspaceId = workspaceId

    // Fix activeTerminalId in source if it belonged to the moved workspace
    const movedTerminalIds = new Set(movedTerminals.map((t: any) => t.id))
    if (sourceEntry.activeTerminalId && movedTerminalIds.has(sourceEntry.activeTerminalId)) {
      sourceEntry.activeTerminalId = null
    }

    // Save both entries
    sourceEntry.lastActiveAt = Date.now()
    targetEntry.lastActiveAt = Date.now()
    await windowRegistry.saveEntry(sourceEntry)
    await windowRegistry.saveEntry(targetEntry)

    // Notify both renderers to reload
    const sourceWin = windowMap.get(sourceWindowId)
    const targetWin = windowMap.get(targetWindowId)
    if (sourceWin && !sourceWin.isDestroyed()) sourceWin.webContents.send('workspace:reload')
    if (targetWin && !targetWin.isDestroyed()) targetWin.webContents.send('workspace:reload')

    logger.log(`[workspace] Moved workspace ${workspaceId} from ${sourceWindowId} to ${targetWindowId}`)
    return true
  })

  // Workspace detach/reattach (local window management)
  ipcMain.handle('workspace:detach', async (event, workspaceId: string) => {
    if (detachedWindows.has(workspaceId)) {
      const existing = detachedWindows.get(workspaceId)!
      if (!existing.isDestroyed()) existing.focus()
      return true
    }
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const detachedWin = new BrowserWindow({
      width: 900, height: 700, minWidth: 600, minHeight: 400,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
      frame: true, titleBarStyle: 'default', icon: nativeImage.createFromPath(path.join(__dirname, process.platform === 'win32' ? '../assets/icon.ico' : '../assets/icon.png'))
    })
    setupResizeThrottle(detachedWin, 'detached')
    detachedWindows.set(workspaceId, detachedWin)
    const urlParam = `?detached=${encodeURIComponent(workspaceId)}`
    if (VITE_DEV_SERVER_URL) { detachedWin.loadURL(VITE_DEV_SERVER_URL + urlParam) }
    else { detachedWin.loadFile(path.join(__dirname, '../dist/index.html'), { search: urlParam }) }
    detachedWin.on('closed', () => {
      detachedWindows.delete(workspaceId)
      if (parentWin && !parentWin.isDestroyed()) parentWin.webContents.send('workspace:reattached', workspaceId)
    })
    if (parentWin && !parentWin.isDestroyed()) parentWin.webContents.send('workspace:detached', workspaceId)
    return true
  })

  ipcMain.handle('workspace:reattach', async (_event, workspaceId: string) => {
    const win = detachedWindows.get(workspaceId)
    if (win && !win.isDestroyed()) win.close()
    detachedWindows.delete(workspaceId)
    return true
  })

  // ── Worker buffer file operations ──
  const wbDir = path.join(app.getPath('userData'), 'worker-buffers')

  ipcMain.handle('worker-buffer:init', async (_event, panelId: string) => {
    await fs.mkdir(wbDir, { recursive: true })
    await fs.writeFile(path.join(wbDir, `${panelId}.jsonl`), '', 'utf-8')
  })

  ipcMain.handle('worker-buffer:append', async (_event, panelId: string, lines: string) => {
    await fs.appendFile(path.join(wbDir, `${panelId}.jsonl`), lines, 'utf-8')
  })

  ipcMain.handle('worker-buffer:readAll', async (_event, panelId: string) => {
    try {
      return await fs.readFile(path.join(wbDir, `${panelId}.jsonl`), 'utf-8')
    } catch { return '' }
  })

  ipcMain.handle('worker-buffer:clear', async (_event, panelId: string) => {
    try { await fs.unlink(path.join(wbDir, `${panelId}.jsonl`)) } catch { /* ignore */ }
  })
}

// ── Worker buffer cleanup on startup ──
const workerBufferDir = path.join(app.getPath('userData'), 'worker-buffers')
fs.rm(workerBufferDir, { recursive: true, force: true }).catch(() => {})

// ── Initialize all IPC ──
const _t0 = Date.now()
registerProxiedHandlers()
bindProxiedHandlersToIpc()
registerLocalHandlers()
console.log(`[startup] IPC registration: ${Date.now() - _t0}ms`)
