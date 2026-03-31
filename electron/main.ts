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
import { checkForUpdates, UpdateCheckResult } from './update-checker'
import { snippetDb, CreateSnippetInput } from './snippet-db'
import { ProfileManager } from './profile-manager'
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
process.on('uncaughtException', (error) => {
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

// Set AppUserModelId for Windows taskbar pinning (must be before app.whenReady)
if (process.platform === 'win32') {
  app.setAppUserModelId('org.tonyq.better-agent-terminal')
}

// Single instance lock — if a second instance is launched, focus existing and open new window
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // Another instance is already running — it will handle second-instance event
  app.quit()
}

const windowMap = new Map<string, BrowserWindow>() // windowId → BrowserWindow
let ptyManager: PtyManager | null = null
let claudeManager: ClaudeAgentManager | null = null
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
                detail: `Version: ${app.getVersion()}\n\nA terminal aggregator with multi-workspace support and Claude Code integration.\n\nAuthor: TonyQ`
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
      // App quitting (Cmd+Q): save all windows into profile snapshot, keep entries
      windowRegistry.getEntry(windowId).then(async (entry) => {
        if (entry?.profileId) {
          await profileManager.save(entry.profileId).catch(() => { /* ignore */ })
        }
      }).catch(() => { /* ignore */ })
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
      // response === 1: Close only — keep entry in registry, no snapshot update

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
  try { ptyManager?.dispose() } catch { /* ignore */ }
  remoteClient = null
  claudeManager = null
  ptyManager = null
}

// Handle launch arguments (kept for backward compat but no longer spawns processes)
const profileArg = process.argv.find(a => a.startsWith('--profile='))
const launchProfileId = profileArg ? profileArg.split('=')[1] || null : null

const windowRegistry = new WindowRegistry()
profileManager.setWindowRegistry(windowRegistry)

app.whenReady().then(async () => {
  const t0 = Date.now()
  logger.init(app.getPath('userData'))
  logger.log(`[startup] ═══════════════════════════════════════`)
  logger.log(`[startup] app.whenReady fired at +${t0 - _t0}ms from IPC reg, +${t0 - _processStart}ms from process`)

  // Ensure profile system is initialized (migrates from workspaces.json on first run)
  await windowRegistry.ensureInitialized()

  // Collect window IDs to create
  const windowsToCreate: { id: string; bounds?: { x: number; y: number; width: number; height: number } }[] = []

  // Clear windows.json — it's purely runtime state, snapshots are the source of truth
  await windowRegistry.clear()

  // Helper: restore all windows from a profile snapshot into the registry
  const restoreFromSnapshot = async (profileId: string): Promise<number> => {
    const snapshot = await profileManager.loadSnapshot(profileId)
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
        const snapshot = await profileManager.loadSnapshot(profileId2)
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

app.on('before-quit', () => {
  isAppQuitting = true
  runCleanupOnce()
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

  // Claude Agent SDK
  registerHandler('claude:start-session', (_ctx, sessionId: string, options: { cwd: string; prompt?: string; permissionMode?: string; model?: string; effort?: string }) => claudeManager?.startSession(sessionId, options))
  registerHandler('claude:send-message', (_ctx, sessionId: string, prompt: string, images?: string[]) => claudeManager?.sendMessage(sessionId, prompt, images))
  registerHandler('claude:stop-session', (_ctx, sessionId: string) => claudeManager?.stopSession(sessionId))
  registerHandler('claude:set-permission-mode', (_ctx, sessionId: string, mode: string) => claudeManager?.setPermissionMode(sessionId, mode as import('@anthropic-ai/claude-agent-sdk').PermissionMode))
  registerHandler('claude:set-model', (_ctx, sessionId: string, model: string) => claudeManager?.setModel(sessionId, model))
  registerHandler('claude:set-effort', (_ctx, sessionId: string, effort: string) => claudeManager?.setEffort(sessionId, effort as 'low' | 'medium' | 'high' | 'max'))
  registerHandler('claude:reset-session', (_ctx, sessionId: string) => claudeManager?.resetSession(sessionId))
  registerHandler('claude:get-supported-models', (_ctx, sessionId: string) => claudeManager?.getSupportedModels(sessionId))
  registerHandler('claude:get-account-info', (_ctx, sessionId: string) => claudeManager?.getAccountInfo(sessionId))
  registerHandler('claude:get-supported-commands', (_ctx, sessionId: string) => claudeManager?.getSupportedCommands(sessionId))
  registerHandler('claude:get-supported-agents', (_ctx, sessionId: string) => claudeManager?.getSupportedAgents(sessionId))

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
  registerHandler('claude:get-session-meta', (_ctx, sessionId: string) => claudeManager?.getSessionMeta(sessionId))
  registerHandler('claude:resolve-permission', (_ctx, sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[]; message?: string; dontAskAgain?: boolean }) => claudeManager?.resolvePermission(sessionId, toolUseId, result))
  registerHandler('claude:resolve-ask-user', (_ctx, sessionId: string, toolUseId: string, answers: Record<string, string>) => claudeManager?.resolveAskUser(sessionId, toolUseId, answers))
  registerHandler('claude:list-sessions', (_ctx, cwd: string) => claudeManager?.listSessions(cwd))
  registerHandler('claude:resume-session', (_ctx, sessionId: string, sdkSessionId: string, cwd: string, model?: string) => claudeManager?.resumeSession(sessionId, sdkSessionId, cwd, model))
  registerHandler('claude:fork-session', (_ctx, sessionId: string) => claudeManager?.forkSession(sessionId))
  registerHandler('claude:stop-task', (_ctx, sessionId: string, taskId: string) => claudeManager?.stopTask(sessionId, taskId))
  registerHandler('claude:rest-session', (_ctx, sessionId: string) => claudeManager?.restSession(sessionId))
  registerHandler('claude:wake-session', (_ctx, sessionId: string) => claudeManager?.wakeSession(sessionId))
  registerHandler('claude:is-resting', (_ctx, sessionId: string) => claudeManager?.isResting(sessionId) ?? false)

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

  // Claude usage (5h / 7d rate limits)
  // Primary: session key from Chrome cookies (lenient rate limits on claude.ai)
  // Fallback: OAuth token from Claude Code credentials (strict rate limits on api.anthropic.com)
  let _cachedOAuthToken: string | null = null
  let _cachedSessionKey: string | null = null
  let _cachedOrgId: string | null = null
  let _cachedCfClearance: string | null = null
  let _tokenCacheTime = 0
  let _sessionKeyCacheTime = 0
  let _orgIdCacheTime = 0
  const TOKEN_CACHE_TTL = 10 * 60 * 1000     // 10 minutes
  const SESSION_KEY_CACHE_TTL = 30 * 60 * 1000 // 30 minutes
  const ORG_ID_CACHE_TTL = 30 * 60 * 1000    // 30 minutes (re-detect after account switch)
  // OAuth account info — sourced from /api/oauth/account (authoritative org ID + plan tier)
  let _cachedOAuthOrgId: string | null = null
  let _cachedOAuthOrgName: string | null = null
  let _cachedOAuthRateLimitTier: string | null = null
  let _cachedOAuthEmail: string | null = null
  let _oauthOrgIdCacheTime = 0
  const OAUTH_ORG_ID_CACHE_TTL = 60 * 60 * 1000 // 1 hour (org membership rarely changes)
  // Firefox-specific: cached cookie path + EBUSY stale-cache state
  let _firefoxCookiePath: string | null = null
  let _firefoxCookiePathCacheTime = 0
  const FIREFOX_PATH_CACHE_TTL = 60 * 60 * 1000 // 1 hour (profile path rarely changes)
  let _firefoxEbusyUntil = 0                    // epoch ms — skip re-read until then
  const FIREFOX_EBUSY_TTL = 10 * 60 * 1000      // 10 min backoff when Firefox is running

  function clearSessionKeyCache() {
    _cachedSessionKey = null
    _cachedOrgId = null
    _cachedCfClearance = null
    _sessionKeyCacheTime = 0
    _orgIdCacheTime = 0
  }

  async function getOAuthToken(): Promise<string | null> {
    const now = Date.now()
    if (_cachedOAuthToken && now - _tokenCacheTime < TOKEN_CACHE_TTL) {
      return _cachedOAuthToken
    }
    try {
      let token: string | null = null
      if (process.platform === 'darwin') {
        const { execSync } = await import('child_process')
        const username = execSync('whoami', { encoding: 'utf-8' }).trim()
        const raw = execSync(
          `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w 2>/dev/null`,
          { encoding: 'utf-8', timeout: 3000 }
        ).trim()
        const creds = JSON.parse(raw)
        token = creds?.claudeAiOauth?.accessToken ?? null
      } else {
        const credPath = path.join(app.getPath('home'), '.claude', '.credentials.json')
        const raw = await fs.readFile(credPath, 'utf-8')
        const creds = JSON.parse(raw)
        token = creds?.claudeAiOauth?.accessToken ?? null
      }
      if (token && token.startsWith('sk-ant-oat')) {
        _cachedOAuthToken = token
        _tokenCacheTime = now
        return token
      }
      return null
    } catch { return null }
  }

  /** Fetch account info via OAuth — authoritative source for org ID and plan tier */
  async function getOAuthAccountInfo(): Promise<{ orgId: string; orgName: string; rateLimitTier: string; email: string } | null> {
    const now = Date.now()
    if (_cachedOAuthOrgId && now - _oauthOrgIdCacheTime < OAUTH_ORG_ID_CACHE_TTL) {
      return { orgId: _cachedOAuthOrgId, orgName: _cachedOAuthOrgName ?? '', rateLimitTier: _cachedOAuthRateLimitTier ?? '', email: _cachedOAuthEmail ?? '' }
    }
    const token = await getOAuthToken()
    if (!token) return null
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/account', {
        headers: { 'Authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Accept': 'application/json' },
      })
      if (!res.ok) return null
      const data = await res.json()
      const membership = data.memberships?.[0]
      if (!membership) return null
      _cachedOAuthOrgId = membership.organization.uuid
      _cachedOAuthOrgName = membership.organization.name ?? ''
      _cachedOAuthRateLimitTier = membership.organization.rate_limit_tier ?? ''
      _cachedOAuthEmail = data.email_address ?? ''
      _oauthOrgIdCacheTime = now
      logger.log('[usage] OAuth account info: org=', _cachedOAuthOrgId, 'tier=', _cachedOAuthRateLimitTier)
      return { orgId: _cachedOAuthOrgId!, orgName: _cachedOAuthOrgName, rateLimitTier: _cachedOAuthRateLimitTier, email: _cachedOAuthEmail }
    } catch (e) {
      logger.error('[usage] getOAuthAccountInfo failed:', e)
      return null
    }
  }

  /** Decrypt a Chrome v10 encrypted cookie value on macOS */
  function decryptChromeCookie(encHex: string, derivedKey: Buffer): string | null {
    try {
      const crypto = require('crypto')
      const encBuf = Buffer.from(encHex, 'hex')
      if (encBuf.length < 4 || encBuf.toString('utf-8', 0, 3) !== 'v10') return null
      const ciphertext = encBuf.subarray(3)
      const iv = Buffer.alloc(16, 0x20) // 16 space characters
      const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv)
      let dec = decipher.update(ciphertext)
      dec = Buffer.concat([dec, decipher.final()])
      return dec.toString('utf-8').replace(/[\x00-\x1f]/g, '').trim()
    } catch { return null }
  }

  /** Resolve Firefox profiles base directory for the current platform */
  function getFirefoxProfilesBase(): string[] {
    const home = app.getPath('home')
    if (process.platform === 'darwin') {
      return [path.join(home, 'Library/Application Support/Firefox')]
    }
    if (process.platform === 'win32') {
      const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
      return [path.join(appdata, 'Mozilla', 'Firefox')]
    }
    // Linux: standard + Snap + Flatpak
    return [
      path.join(home, '.mozilla', 'firefox'),
      path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
      path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
    ]
  }

  /** Parse Firefox profiles.ini and return absolute path to cookies.sqlite for the default profile */
  async function resolveFirefoxCookiePath(): Promise<string | null> {
    const now = Date.now()
    if (_firefoxCookiePath && now - _firefoxCookiePathCacheTime < FIREFOX_PATH_CACHE_TTL) {
      return _firefoxCookiePath
    }
    for (const base of getFirefoxProfilesBase()) {
      const iniPath = path.join(base, 'profiles.ini')
      let ini: string
      try { ini = await fs.readFile(iniPath, 'utf-8') } catch { continue }

      // Parse sections
      type Section = Record<string, string>
      const sections: Record<string, Section> = {}
      let current = ''
      for (const line of ini.split(/\r?\n/)) {
        const sec = line.match(/^\[(.+)\]$/)
        if (sec) { current = sec[1]; sections[current] = {}; continue }
        const kv = line.match(/^([^=]+)=(.*)$/)
        if (kv && current) sections[current][kv[1].trim()] = kv[2].trim()
      }

      // [Install*] Default= takes priority (points to the last-used install's profile)
      let profileRelOrAbs: string | null = null
      let isRelative = true
      for (const [name, vals] of Object.entries(sections)) {
        if (name.startsWith('Install') && vals['Default']) {
          profileRelOrAbs = vals['Default']
          isRelative = true // Install section paths are always relative to base
          break
        }
      }

      // Fallback: [Profile*] with Default=1
      if (!profileRelOrAbs) {
        for (const [name, vals] of Object.entries(sections)) {
          if (name.startsWith('Profile') && vals['Default'] === '1') {
            profileRelOrAbs = vals['Path']
            isRelative = vals['IsRelative'] !== '0'
            break
          }
        }
      }

      if (!profileRelOrAbs) continue

      const profileDir = isRelative
        ? path.join(base, profileRelOrAbs)
        : profileRelOrAbs
      const cookiePath = path.join(profileDir, 'cookies.sqlite')
      try { await fs.access(cookiePath) } catch { continue }

      _firefoxCookiePath = cookiePath
      _firefoxCookiePathCacheTime = now
      return cookiePath
    }
    return null
  }

  /** Extract session key and cf_clearance from Firefox cookies (plaintext, no decryption needed) */
  async function getSessionKeyFromFirefox(): Promise<{ sessionKey: string; cfClearance: string | null } | null> {
    const now = Date.now()
    if (_cachedSessionKey && now - _sessionKeyCacheTime < SESSION_KEY_CACHE_TTL) {
      return { sessionKey: _cachedSessionKey, cfClearance: _cachedCfClearance }
    }
    try {
      const ffCookiePath = await resolveFirefoxCookiePath()
      if (!ffCookiePath) return null

      // If Firefox is running and we hit EBUSY recently, return stale cached key
      if (now < _firefoxEbusyUntil) {
        if (_cachedSessionKey) {
          logger.log('[usage] Firefox DB busy, returning stale session key')
          return { sessionKey: _cachedSessionKey, cfClearance: _cachedCfClearance }
        }
        return null
      }

      const os = await import('os')
      const { execSync } = await import('child_process')
      const tmpDir = os.tmpdir()
      const tmpDb = path.join(tmpDir, 'bat-firefox-cookies.db')

      try {
        await fs.copyFile(ffCookiePath, tmpDb)
      } catch (e: any) {
        if (e?.code === 'EBUSY' || e?.code === 'EPERM') {
          _firefoxEbusyUntil = now + FIREFOX_EBUSY_TTL
          logger.log('[usage] Firefox DB locked (EBUSY), will retry in 10min')
          if (_cachedSessionKey) return { sessionKey: _cachedSessionKey, cfClearance: _cachedCfClearance }
        }
        return null
      }

      try { await fs.copyFile(ffCookiePath + '-wal', tmpDb + '-wal') } catch { /* ok */ }
      try { await fs.copyFile(ffCookiePath + '-shm', tmpDb + '-shm') } catch { /* ok */ }

      // Firefox stores cookies as plaintext in moz_cookies table
      const rawOutput = execSync(
        `sqlite3 "${tmpDb}" "SELECT name, value FROM moz_cookies WHERE host LIKE '%claude.ai%' AND name IN ('sessionKey','cf_clearance');"`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim()

      try { await fs.unlink(tmpDb) } catch { /* ok */ }
      try { await fs.unlink(tmpDb + '-wal') } catch { /* ok */ }
      try { await fs.unlink(tmpDb + '-shm') } catch { /* ok */ }

      if (!rawOutput) return null

      let sessionKey: string | null = null
      let cfClearance: string | null = null

      for (const line of rawOutput.split('\n')) {
        const pipeIdx = line.indexOf('|')
        if (pipeIdx < 0) continue
        const name = line.substring(0, pipeIdx)
        const value = line.substring(pipeIdx + 1)
        if (name === 'sessionKey' && value) {
          const idx = value.indexOf('sk-ant-sid')
          sessionKey = idx >= 0 ? value.substring(idx) : value
        } else if (name === 'cf_clearance' && value) {
          cfClearance = value
        }
      }

      if (!sessionKey || sessionKey.length < 10) return null

      _cachedSessionKey = sessionKey
      _cachedCfClearance = cfClearance
      _sessionKeyCacheTime = now
      logger.log('[usage] Extracted session key from Firefox (length:', sessionKey.length, ')')
      return { sessionKey, cfClearance }
    } catch (e) {
      logger.error('[usage] Failed to extract Firefox session key:', e)
      return null
    }
  }

  /** Extract session key and cf_clearance from Chrome cookies on macOS */
  async function getSessionKeyFromChrome(): Promise<{ sessionKey: string; cfClearance: string | null } | null> {
    if (process.platform !== 'darwin') return null
    const now = Date.now()
    if (_cachedSessionKey && now - _sessionKeyCacheTime < SESSION_KEY_CACHE_TTL) {
      return { sessionKey: _cachedSessionKey, cfClearance: _cachedCfClearance }
    }
    try {
      const crypto = await import('crypto')
      const { execSync } = await import('child_process')
      const os = await import('os')

      // Copy Chrome cookies DB to temp to avoid WAL lock
      const chromeCookiePath = path.join(app.getPath('home'), 'Library/Application Support/Google/Chrome/Default/Cookies')
      try { await fs.access(chromeCookiePath) } catch { return null }

      const tmpDir = os.tmpdir()
      const tmpDb = path.join(tmpDir, 'bat-chrome-cookies.db')
      await fs.copyFile(chromeCookiePath, tmpDb)
      // Also copy WAL and SHM files for consistency
      try { await fs.copyFile(chromeCookiePath + '-wal', tmpDb + '-wal') } catch { /* ok */ }
      try { await fs.copyFile(chromeCookiePath + '-shm', tmpDb + '-shm') } catch { /* ok */ }

      // Get Chrome safe storage password from Keychain
      const chromePassword = execSync(
        'security find-generic-password -s "Chrome Safe Storage" -w 2>/dev/null',
        { encoding: 'utf-8', timeout: 3000 }
      ).trim()
      if (!chromePassword) return null

      const derivedKey = crypto.pbkdf2Sync(chromePassword, 'saltysalt', 1003, 16, 'sha1')

      // Query sessionKey and cf_clearance
      const rawOutput = execSync(
        `sqlite3 "${tmpDb}" "SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai%' AND name IN ('sessionKey','cf_clearance');"`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim()

      // Clean up temp files
      try { await fs.unlink(tmpDb) } catch { /* ok */ }
      try { await fs.unlink(tmpDb + '-wal') } catch { /* ok */ }
      try { await fs.unlink(tmpDb + '-shm') } catch { /* ok */ }

      if (!rawOutput) return null

      let sessionKey: string | null = null
      let cfClearance: string | null = null

      for (const line of rawOutput.split('\n')) {
        const [name, hex] = line.split('|')
        if (!hex) continue
        const decrypted = decryptChromeCookie(hex, derivedKey as unknown as Buffer)
        if (!decrypted) continue

        // Strip non-ASCII chars from decrypted values
        const cleaned = decrypted.replace(/[^\x20-\x7E]/g, '').trim()
        if (name === 'sessionKey') {
          // Decrypted value may have garbage prefix; extract from sk-ant-sid
          const idx = cleaned.indexOf('sk-ant-sid')
          sessionKey = idx >= 0 ? cleaned.substring(idx) : cleaned
        } else if (name === 'cf_clearance') {
          cfClearance = cleaned
        }
      }

      if (!sessionKey || sessionKey.length < 10) return null

      _cachedSessionKey = sessionKey
      _cachedCfClearance = cfClearance
      _sessionKeyCacheTime = now
      logger.log('[usage] Extracted session key from Chrome (length:', sessionKey.length, ')')
      return { sessionKey, cfClearance }
    } catch (e) {
      logger.error('[usage] Failed to extract Chrome session key:', e)
      return null
    }
  }

  /** Auto-detect organization ID using session key */
  async function getOrgId(sessionKey: string, cfClearance: string | null): Promise<string | null> {
    const now = Date.now()
    if (_cachedOrgId && now - _orgIdCacheTime < ORG_ID_CACHE_TTL) return _cachedOrgId
    try {
      const cookieParts = [`sessionKey=${sessionKey}`]
      if (cfClearance) cookieParts.push(`cf_clearance=${cfClearance}`)

      const res = await fetch('https://claude.ai/api/organizations', {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Cookie': cookieParts.join('; '),
        },
      })
      if (!res.ok) {
        logger.error('[usage] Organizations API returned', res.status)
        return null
      }
      const orgs = await res.json()
      if (!Array.isArray(orgs) || orgs.length === 0) {
        logger.error('[usage] No organizations found')
        return null
      }
      _cachedOrgId = orgs[0].uuid
      _orgIdCacheTime = Date.now()
      logger.log('[usage] Auto-detected org ID:', _cachedOrgId)
      return _cachedOrgId
    } catch (e) {
      logger.error('[usage] getOrgId failed:', e)
      return null
    }
  }

  /** Fetch usage via session key (primary — lenient rate limits) */
  async function fetchUsageViaSessionKey(): Promise<{ fiveHour: number | null; sevenDay: number | null; fiveHourReset: string | null; sevenDayReset: string | null } | null> {
    const creds = (await getSessionKeyFromChrome()) ?? (await getSessionKeyFromFirefox())
    if (!creds) return null
    // Use OAuth org ID as the authoritative source — avoids wrong-org data when session key belongs to a different account
    const accountInfo = await getOAuthAccountInfo()
    const orgId = accountInfo?.orgId ?? (await getOrgId(creds.sessionKey, creds.cfClearance))
    if (!orgId) return null

    const cookieParts = [`sessionKey=${creds.sessionKey}`]
    if (creds.cfClearance) cookieParts.push(`cf_clearance=${creds.cfClearance}`)

    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Cookie': cookieParts.join('; '),
      },
    })

    if (res.status === 401 || res.status === 403) {
      clearSessionKeyCache()
      logger.log('[usage] Session key expired or blocked, will re-extract')
      return null
    }
    if (!res.ok) return null

    const data = await res.json()
    logger.log('[usage] [session-key] 5h=', data.five_hour?.utilization, 'reset=', data.five_hour?.resets_at, '7d=', data.seven_day?.utilization, 'reset=', data.seven_day?.resets_at)

    return {
      fiveHour: data.five_hour?.utilization ?? null,
      sevenDay: data.seven_day?.utilization ?? null,
      fiveHourReset: data.five_hour?.resets_at ?? null,
      sevenDayReset: data.seven_day?.resets_at ?? null,
    }
  }

  /** Fetch usage via OAuth (fallback — strict rate limits) */
  async function fetchUsageViaOAuth(): Promise<{ fiveHour: number | null; sevenDay: number | null; fiveHourReset: string | null; sevenDayReset: string | null } | 'rateLimited' | null> {
    const token = await getOAuthToken()
    if (!token) return null

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.0.32',
        'Accept': 'application/json',
      },
    })

    if (res.status === 429) return 'rateLimited'
    if (!res.ok) return null

    const data = await res.json()
    logger.log('[usage] [oauth] 5h=', data.five_hour?.utilization, '7d=', data.seven_day?.utilization)
    return {
      fiveHour: data.five_hour?.utilization ?? null,
      sevenDay: data.seven_day?.utilization ?? null,
      fiveHourReset: data.five_hour?.resets_at ?? null,
      sevenDayReset: data.seven_day?.resets_at ?? null,
    }
  }

  registerHandler('claude:get-usage', async (_ctx) => {
    try {
      // Try session key first (lenient rate limits on claude.ai)
      const sessionResult = await fetchUsageViaSessionKey()
      if (sessionResult) return sessionResult

      // Fall back to OAuth (strict rate limits on api.anthropic.com)
      const oauthResult = await fetchUsageViaOAuth()
      if (oauthResult === 'rateLimited') {
        return { rateLimited: true, retryAfterSec: 120 }
      }
      return oauthResult
    } catch (e) {
      logger.error('[usage] get-usage failed:', e)
      return null
    }
  })

  registerHandler('claude:get-usage-account', async (_ctx) => {
    try {
      const info = await getOAuthAccountInfo()
      if (!info) return null
      // Format rate_limit_tier for display: "default_claude_max_20x" → "Claude Max 20x"
      const tier = info.rateLimitTier
        .replace(/^default_/, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .replace(/(\d+[Xx])$/, m => m.toUpperCase())
      return { email: info.email, orgName: info.orgName, tier }
    } catch { return null }
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
  registerHandler('profile:load', (_ctx, profileId: string) => profileManager.load(profileId))
  registerHandler('profile:get-active-ids', (_ctx) => profileManager.getActiveProfileIds())
  registerHandler('profile:activate', (_ctx, profileId: string) => profileManager.activateProfile(profileId))
  registerHandler('profile:deactivate', (_ctx, profileId: string) => profileManager.deactivateProfile(profileId))
}

// ── Bind all proxied handlers to ipcMain ──

function bindProxiedHandlersToIpc() {
  for (const channel of PROXIED_CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      // If remote client is connected, route to remote server
      if (remoteClient?.isConnected) {
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

  // Profile handlers (local-only — list/load/activate/deactivate/get-active-ids are proxied)
  ipcMain.handle('profile:create', async (_event, name: string, options?: { type?: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string }) => profileManager.create(name, options))
  ipcMain.handle('profile:save', async (_event, profileId: string) => profileManager.save(profileId))
  ipcMain.handle('profile:delete', async (_event, profileId: string) => profileManager.delete(profileId))
  ipcMain.handle('profile:rename', async (_event, profileId: string, newName: string) => profileManager.rename(profileId, newName))
  ipcMain.handle('profile:duplicate', async (_event, profileId: string, newName: string) => profileManager.duplicate(profileId, newName))
  ipcMain.handle('profile:update', async (_event, profileId: string, updates: { remoteHost?: string; remotePort?: number; remoteToken?: string }) => profileManager.update(profileId, updates))
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

    // Load profile snapshot and open all its windows
    const snapshot = await profileManager.loadSnapshot(profileId)
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
}

// ── Initialize all IPC ──
const _t0 = Date.now()
registerProxiedHandlers()
bindProxiedHandlersToIpc()
registerLocalHandlers()
console.log(`[startup] IPC registration: ${Date.now() - _t0}ms`)
