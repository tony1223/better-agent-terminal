import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import path from 'path'
import { PtyManager } from './pty-manager'
import { checkForUpdates, UpdateCheckResult } from './update-checker'
import { snippetDb, CreateSnippetInput } from './snippet-db'

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let updateCheckResult: UpdateCheckResult | null = null

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
          label: `Download ${updateCheckResult.latestRelease.tagName}`,
          click: () => {
            const url = updateCheckResult!.latestRelease!.downloadUrl || updateCheckResult!.latestRelease!.htmlUrl
            shell.openExternal(url)
          }
        },
        {
          label: 'View Release Notes',
          click: () => shell.openExternal(updateCheckResult!.latestRelease!.htmlUrl)
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

  ptyManager = new PtyManager(mainWindow)

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    ptyManager?.dispose()
    ptyManager = null
  })
}

app.whenReady().then(async () => {
  buildMenu()
  createWindow()

  // Check for updates after startup
  setTimeout(async () => {
    try {
      updateCheckResult = await checkForUpdates()
      if (updateCheckResult.hasUpdate) {
        // Rebuild menu to show update option
        buildMenu()
      }
    } catch (error) {
      console.error('Failed to check for updates:', error)
    }
  }, 2000)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// IPC Handlers
ipcMain.handle('pty:create', async (_event, options) => {
  return ptyManager?.create(options)
})

ipcMain.handle('pty:write', async (_event, id: string, data: string) => {
  ptyManager?.write(id, data)
})

ipcMain.handle('pty:resize', async (_event, id: string, cols: number, rows: number) => {
  ptyManager?.resize(id, cols, rows)
})

ipcMain.handle('pty:kill', async (_event, id: string) => {
  return ptyManager?.kill(id)
})

ipcMain.handle('pty:restart', async (_event, id: string, cwd: string, shell?: string) => {
  return ptyManager?.restart(id, cwd, shell)
})

ipcMain.handle('pty:get-cwd', async (_event, id: string) => {
  return ptyManager?.getCwd(id)
})

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('workspace:save', async (_event, data: string) => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'workspaces.json')
  await fs.writeFile(configPath, data, 'utf-8')
  return true
})

ipcMain.handle('workspace:load', async () => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'workspaces.json')
  try {
    const data = await fs.readFile(configPath, 'utf-8')
    return data
  } catch {
    return null
  }
})

// Settings handlers
ipcMain.handle('settings:save', async (_event, data: string) => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'settings.json')
  await fs.writeFile(configPath, data, 'utf-8')
  return true
})

ipcMain.handle('settings:load', async () => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'settings.json')
  try {
    const data = await fs.readFile(configPath, 'utf-8')
    return data
  } catch {
    return null
  }
})

ipcMain.handle('settings:get-shell-path', async (_event, shellType: string) => {
  const fs = await import('fs')

  // macOS and Linux support
  if (process.platform === 'darwin' || process.platform === 'linux') {
    if (shellType === 'auto') {
      return process.env.SHELL || '/bin/zsh'
    }
    // For non-auto, return the shellType as-is (custom path) or default shell
    if (shellType === 'pwsh' || shellType === 'powershell' || shellType === 'cmd') {
      // Windows shells requested on Unix - fall back to default
      return process.env.SHELL || '/bin/zsh'
    }
    return shellType // custom path
  }

  // Windows support
  if (shellType === 'auto' || shellType === 'pwsh') {
    const pwshPaths = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
      process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\pwsh.exe'
    ]
    for (const p of pwshPaths) {
      if (fs.existsSync(p)) {
        return p
      }
    }
    if (shellType === 'pwsh') return 'pwsh.exe'
  }

  if (shellType === 'auto' || shellType === 'powershell') {
    return 'powershell.exe'
  }

  if (shellType === 'cmd') {
    return 'cmd.exe'
  }

  return shellType // custom path
})

ipcMain.handle('shell:open-external', async (_event, url: string) => {
  await shell.openExternal(url)
})

// Update checker handlers
ipcMain.handle('update:check', async () => {
  try {
    return await checkForUpdates()
  } catch (error) {
    console.error('Failed to check for updates:', error)
    return {
      hasUpdate: false,
      currentVersion: app.getVersion(),
      latestRelease: null
    }
  }
})

ipcMain.handle('update:get-version', () => {
  return app.getVersion()
})

// Snippet handlers
ipcMain.handle('snippet:getAll', () => {
  return snippetDb.getAll()
})

ipcMain.handle('snippet:getById', (_event, id: number) => {
  return snippetDb.getById(id)
})

ipcMain.handle('snippet:create', (_event, input: CreateSnippetInput) => {
  return snippetDb.create(input)
})

ipcMain.handle('snippet:update', (_event, id: number, updates: Partial<CreateSnippetInput>) => {
  return snippetDb.update(id, updates)
})

ipcMain.handle('snippet:delete', (_event, id: number) => {
  return snippetDb.delete(id)
})

ipcMain.handle('snippet:toggleFavorite', (_event, id: number) => {
  return snippetDb.toggleFavorite(id)
})

ipcMain.handle('snippet:search', (_event, query: string) => {
  return snippetDb.search(query)
})

ipcMain.handle('snippet:getCategories', () => {
  return snippetDb.getCategories()
})

ipcMain.handle('snippet:getFavorites', () => {
  return snippetDb.getFavorites()
})
