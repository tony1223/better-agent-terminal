import { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerMonitor, clipboard, nativeImage } from 'electron'
import path from 'path'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import { execFileSync } from 'child_process'

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
    ].join(':')
    process.env.PATH = `${extraPaths}:${process.env.PATH || ''}`
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

// Set AppUserModelId for Windows taskbar pinning (must be before app.whenReady)
if (process.platform === 'win32') {
  app.setAppUserModelId('org.tonyq.better-agent-terminal')
}

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let claudeManager: ClaudeAgentManager | null = null
let updateCheckResult: UpdateCheckResult | null = null
const profileManager = new ProfileManager()
const remoteServer = new RemoteServer()
let remoteClient: RemoteClient | null = null
const detachedWindows = new Map<string, BrowserWindow>() // workspaceId → BrowserWindow

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
  if (mainWindow && !mainWindow.isDestroyed()) wins.push(mainWindow)
  for (const win of detachedWindows.values()) {
    if (!win.isDestroyed()) wins.push(win)
  }
  return wins
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
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About Better Agent Terminal',
              message: 'Better Agent Terminal',
              detail: `Version: ${app.getVersion()}\n\nA terminal aggregator with multi-workspace support and Claude Code integration.\n\nAuthor: TonyQ`
            })
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    // Show immediately — splash screen is inline HTML/CSS, paints instantly.
    // Using show:false throttles the Chromium renderer, adding seconds to first paint.
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
    icon: path.join(__dirname, '../assets/icon.ico')
  })

  ptyManager = new PtyManager(getAllWindows)
  claudeManager = new ClaudeAgentManager(getAllWindows)

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  setupResizeThrottle(mainWindow, 'main')

  mainWindow.on('closed', () => {
    // Close all detached windows when main window closes
    for (const [, win] of detachedWindows) {
      if (!win.isDestroyed()) win.close()
    }
    detachedWindows.clear()
    mainWindow = null
  })
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

// Handle --profile launch argument: expose to frontend without changing global state
const profileArg = process.argv.find(a => a.startsWith('--profile='))
const launchProfileId = profileArg ? profileArg.split('=')[1] || null : null

app.whenReady().then(async () => {
  const t0 = Date.now()
  logger.init(app.getPath('userData'))
  logger.log(`[startup] ═══════════════════════════════════════`)
  logger.log(`[startup] app.whenReady fired at +${t0 - _t0}ms from IPC reg, +${t0 - _processStart}ms from process`)
  const t1 = Date.now()
  buildMenu()
  logger.log(`[startup] buildMenu: ${Date.now() - t1}ms`)
  remoteServer.configDir = app.getPath('userData')
  const t2 = Date.now()
  createWindow()
  logger.log(`[startup] createWindow: ${Date.now() - t2}ms`)
  if (mainWindow) {
    mainWindow.webContents.on('did-start-loading', () => {
      logger.log(`[startup] did-start-loading: +${Date.now() - t0}ms from whenReady`)
    })
    mainWindow.webContents.on('dom-ready', () => {
      logger.log(`[startup] dom-ready: +${Date.now() - t0}ms from whenReady`)
    })
    mainWindow.webContents.on('did-finish-load', () => {
      logger.log(`[startup] did-finish-load: +${Date.now() - t0}ms from whenReady`)
    })
    // Track when renderer sends its first IPC (= JS bundle has executed)
    const ipcSub = () => {
      logger.log(`[startup] first-renderer-ipc: +${Date.now() - t0}ms from whenReady`)
      mainWindow?.webContents.removeListener('ipc-message', ipcSub)
    }
    mainWindow.webContents.on('ipc-message', ipcSub)
  }

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
  runCleanupOnce()
})

app.on('window-all-closed', () => {
  runCleanupOnce()
  if (process.platform !== 'darwin') {
    app.quit()
    // Force exit — child processes (PTY shells, Claude CLI) may keep the event loop alive.
    // PTY kill() already called taskkill /T above; this is a final safety net.
    setTimeout(() => process.exit(0), 2000)
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// ── Proxied handler registration (callable by both IPC and remote server) ──

function registerProxiedHandlers() {
  const MESSAGE_ARCHIVE_DIR = path.join(app.getPath('userData'), 'message-archives')

  // PTY
  registerHandler('pty:create', (options: unknown) => ptyManager?.create(options as import('../src/types').CreatePtyOptions))
  registerHandler('pty:write', (id: string, data: string) => ptyManager?.write(id, data))
  registerHandler('pty:resize', (id: string, cols: number, rows: number) => {
    logger.log(`[resize] pty:resize id=${id} cols=${cols} rows=${rows}`)
    return ptyManager?.resize(id, cols, rows)
  })
  registerHandler('pty:kill', (id: string) => ptyManager?.kill(id))
  registerHandler('pty:restart', (id: string, cwd: string, shellPath?: string) => ptyManager?.restart(id, cwd, shellPath))
  registerHandler('pty:get-cwd', (id: string) => ptyManager?.getCwd(id))

  // Workspace persistence
  registerHandler('workspace:save', async (data: string) => {
    const configPath = path.join(app.getPath('userData'), 'workspaces.json')
    await fs.writeFile(configPath, data, 'utf-8')
    return true
  })
  registerHandler('workspace:load', async () => {
    const configPath = path.join(app.getPath('userData'), 'workspaces.json')
    try { return await fs.readFile(configPath, 'utf-8') } catch { return null }
  })

  // Settings persistence
  registerHandler('settings:save', async (data: string) => {
    const configPath = path.join(app.getPath('userData'), 'settings.json')
    await fs.writeFile(configPath, data, 'utf-8')
    return true
  })
  registerHandler('settings:load', async () => {
    const configPath = path.join(app.getPath('userData'), 'settings.json')
    try { return await fs.readFile(configPath, 'utf-8') } catch { return null }
  })
  const shellPathCache = new Map<string, string>()
  registerHandler('settings:get-shell-path', (shellType: string) => {
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
  registerHandler('claude:start-session', (sessionId: string, options: { cwd: string; prompt?: string; permissionMode?: string; model?: string }) => claudeManager?.startSession(sessionId, options))
  registerHandler('claude:send-message', (sessionId: string, prompt: string, images?: string[]) => claudeManager?.sendMessage(sessionId, prompt, images))
  registerHandler('claude:stop-session', (sessionId: string) => claudeManager?.stopSession(sessionId))
  registerHandler('claude:set-permission-mode', (sessionId: string, mode: string) => claudeManager?.setPermissionMode(sessionId, mode as import('@anthropic-ai/claude-agent-sdk').PermissionMode))
  registerHandler('claude:set-model', (sessionId: string, model: string) => claudeManager?.setModel(sessionId, model))
  registerHandler('claude:set-effort', (sessionId: string, effort: string) => claudeManager?.setEffort(sessionId, effort as 'low' | 'medium' | 'high' | 'max'))
  registerHandler('claude:set-1m-context', (sessionId: string, enable: boolean) => claudeManager?.set1MContext(sessionId, enable))
  registerHandler('claude:reset-session', (sessionId: string) => claudeManager?.resetSession(sessionId))
  registerHandler('claude:get-supported-models', (sessionId: string) => claudeManager?.getSupportedModels(sessionId))
  registerHandler('claude:get-account-info', (sessionId: string) => claudeManager?.getAccountInfo(sessionId))
  registerHandler('claude:get-supported-commands', (sessionId: string) => claudeManager?.getSupportedCommands(sessionId))
  registerHandler('claude:get-session-meta', (sessionId: string) => claudeManager?.getSessionMeta(sessionId))
  registerHandler('claude:resolve-permission', (sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; message?: string }) => claudeManager?.resolvePermission(sessionId, toolUseId, result))
  registerHandler('claude:resolve-ask-user', (sessionId: string, toolUseId: string, answers: Record<string, string>) => claudeManager?.resolveAskUser(sessionId, toolUseId, answers))
  registerHandler('claude:list-sessions', (cwd: string) => claudeManager?.listSessions(cwd))
  registerHandler('claude:resume-session', (sessionId: string, sdkSessionId: string, cwd: string, model?: string) => claudeManager?.resumeSession(sessionId, sdkSessionId, cwd, model))
  registerHandler('claude:fork-session', (sessionId: string) => claudeManager?.forkSession(sessionId))
  registerHandler('claude:stop-task', (sessionId: string, taskId: string) => claudeManager?.stopTask(sessionId, taskId))
  registerHandler('claude:rest-session', (sessionId: string) => claudeManager?.restSession(sessionId))
  registerHandler('claude:wake-session', (sessionId: string) => claudeManager?.wakeSession(sessionId))
  registerHandler('claude:is-resting', (sessionId: string) => claudeManager?.isResting(sessionId) ?? false)

  // Message archiving
  registerHandler('claude:archive-messages', async (sessionId: string, messages: unknown[]) => {
    await fs.mkdir(MESSAGE_ARCHIVE_DIR, { recursive: true })
    const filePath = path.join(MESSAGE_ARCHIVE_DIR, `${sessionId}.jsonl`)
    const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    await fs.appendFile(filePath, lines, 'utf-8')
    return true
  })
  registerHandler('claude:load-archived', async (sessionId: string, offset: number, limit: number) => {
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
  registerHandler('claude:clear-archive', async (sessionId: string) => {
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
  const TOKEN_CACHE_TTL = 10 * 60 * 1000     // 10 minutes
  const SESSION_KEY_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

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
    if (_cachedOrgId) return _cachedOrgId
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
      logger.log('[usage] Auto-detected org ID:', _cachedOrgId)
      return _cachedOrgId
    } catch (e) {
      logger.error('[usage] getOrgId failed:', e)
      return null
    }
  }

  /** Fetch usage via session key (primary — lenient rate limits) */
  async function fetchUsageViaSessionKey(): Promise<{ fiveHour: number | null; sevenDay: number | null; fiveHourReset: string | null; sevenDayReset: string | null } | null> {
    const creds = await getSessionKeyFromChrome()
    if (!creds) return null
    const orgId = await getOrgId(creds.sessionKey, creds.cfClearance)
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
      _cachedSessionKey = null
      _cachedOrgId = null
      _cachedCfClearance = null
      _sessionKeyCacheTime = 0
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

  registerHandler('claude:get-usage', async () => {
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

  // Git
  registerHandler('git:get-github-url', async (folderPath: string) => {
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
  registerHandler('git:branch', async (cwd: string) => {
    try {
      const { execSync } = await import('child_process')
      return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }).trim() || null
    } catch { return null }
  })
  registerHandler('git:log', async (cwd: string, count: number = 50) => {
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
  registerHandler('git:diff', async (cwd: string, commitHash?: string, filePath?: string) => {
    try {
      const { execFileSync } = await import('child_process')
      const args = commitHash && commitHash !== 'working'
        ? ['diff', `${commitHash}~1..${commitHash}`]
        : ['diff', 'HEAD']
      if (filePath) args.push('--', filePath)
      return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 * 5 })
    } catch { return '' }
  })
  registerHandler('git:diff-files', async (cwd: string, commitHash?: string) => {
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
  registerHandler('git:status', async (cwd: string) => {
    try {
      const { execSync } = await import('child_process')
      const raw = execSync('git status --porcelain -uall', { cwd, encoding: 'utf-8', timeout: 5000 })
      if (!raw.trim()) return []
      return raw.split('\n').filter(line => line.trim()).map(line => ({ status: line.substring(0, 2).trim(), file: line.substring(3) }))
    } catch { return [] }
  })

  // File system
  registerHandler('fs:readdir', async (dirPath: string) => {
    const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.cache', '__pycache__', '.DS_Store'])
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      return entries
        .filter(e => !IGNORED.has(e.name))
        .sort((a, b) => { if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1; return a.name.localeCompare(b.name) })
        .map(e => ({ name: e.name, path: path.join(dirPath, e.name), isDirectory: e.isDirectory() }))
    } catch { return [] }
  })
  registerHandler('fs:readFile', async (filePath: string) => {
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > 512 * 1024) return { error: 'File too large', size: stat.size }
      const content = await fs.readFile(filePath, 'utf-8')
      return { content }
    } catch { return { error: 'Failed to read file' } }
  })
  registerHandler('fs:search', async (dirPath: string, query: string) => {
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
  registerHandler('snippet:getAll', () => snippetDb.getAll())
  registerHandler('snippet:getById', (id: number) => snippetDb.getById(id))
  registerHandler('snippet:create', (input: CreateSnippetInput) => snippetDb.create(input))
  registerHandler('snippet:update', (id: number, updates: Partial<CreateSnippetInput>) => snippetDb.update(id, updates))
  registerHandler('snippet:delete', (id: number) => snippetDb.delete(id))
  registerHandler('snippet:toggleFavorite', (id: number) => snippetDb.toggleFavorite(id))
  registerHandler('snippet:search', (query: string) => snippetDb.search(query))
  registerHandler('snippet:getCategories', () => snippetDb.getCategories())
  registerHandler('snippet:getFavorites', () => snippetDb.getFavorites())

  // Profile (subset exposed to remote clients)
  registerHandler('profile:list', () => profileManager.list())
  registerHandler('profile:load', (profileId: string) => profileManager.load(profileId))
  registerHandler('profile:get-active-id', () => profileManager.getActiveProfileId())
  registerHandler('profile:set-active', (profileId: string) => profileManager.setActiveProfileId(profileId))
}

// ── Bind all proxied handlers to ipcMain ──

function bindProxiedHandlersToIpc() {
  for (const channel of PROXIED_CHANNELS) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      // If remote client is connected, route to remote server
      if (remoteClient?.isConnected) {
        return remoteClient.invoke(channel, args)
      }
      return invokeHandler(channel, args)
    })
  }
}

// ── Renderer debug log (fire-and-forget, no blocking) ──
ipcMain.on('debug:log', (_event, ...args: unknown[]) => {
  logger.log('[renderer]', ...args)
})

// ── Local-only IPC handlers (not proxied) ──

function registerLocalHandlers() {
  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: app.getPath('home'),
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:select-images', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: app.getPath('home'),
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:confirm', async (_event, message: string, title?: string) => {
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['OK', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: title || 'Confirm',
      message,
    })
    return result.response === 0
  })

  ipcMain.handle('shell:open-external', async (_event, url: string) => { await shell.openExternal(url) })
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

  // Profile handlers (local-only — list/load/set-active/get-active-id are proxied)
  ipcMain.handle('profile:create', async (_event, name: string, options?: { type?: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string }) => profileManager.create(name, options))
  ipcMain.handle('profile:save', async (_event, profileId: string) => profileManager.save(profileId))
  ipcMain.handle('profile:delete', async (_event, profileId: string) => profileManager.delete(profileId))
  ipcMain.handle('profile:rename', async (_event, profileId: string, newName: string) => profileManager.rename(profileId, newName))
  ipcMain.handle('profile:duplicate', async (_event, profileId: string, newName: string) => profileManager.duplicate(profileId, newName))
  ipcMain.handle('profile:update', async (_event, profileId: string, updates: { remoteHost?: string; remotePort?: number; remoteToken?: string }) => profileManager.update(profileId, updates))
  ipcMain.handle('profile:get', async (_event, profileId: string) => profileManager.getProfile(profileId))

  // Get the profile ID this instance was launched with (--profile= argument)
  ipcMain.handle('app:get-launch-profile', () => launchProfileId)

  // Open new instance with a specific profile
  ipcMain.handle('app:open-new-instance', async (_event, profileId: string) => {
    const { spawn } = await import('child_process')
    const args = [app.getAppPath(), `--profile=${profileId}`]
    spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
  })

  // Workspace detach/reattach (local window management)
  ipcMain.handle('workspace:detach', async (_event, workspaceId: string) => {
    if (detachedWindows.has(workspaceId)) {
      const existing = detachedWindows.get(workspaceId)!
      if (!existing.isDestroyed()) existing.focus()
      return true
    }
    const detachedWin = new BrowserWindow({
      width: 900, height: 700, minWidth: 600, minHeight: 400,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
      frame: true, titleBarStyle: 'default', icon: path.join(__dirname, '../assets/icon.ico')
    })
    setupResizeThrottle(detachedWin, 'detached')
    detachedWindows.set(workspaceId, detachedWin)
    const urlParam = `?detached=${encodeURIComponent(workspaceId)}`
    if (VITE_DEV_SERVER_URL) { detachedWin.loadURL(VITE_DEV_SERVER_URL + urlParam) }
    else { detachedWin.loadFile(path.join(__dirname, '../dist/index.html'), { search: urlParam }) }
    detachedWin.on('closed', () => {
      detachedWindows.delete(workspaceId)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace:reattached', workspaceId)
    })
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace:detached', workspaceId)
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
