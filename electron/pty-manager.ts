import { BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import type { CreatePtyOptions } from '../src/types'

// Try to import node-pty, fall back to child_process if not available
let pty: typeof import('node-pty') | null = null
let ptyAvailable = false
try {
  pty = require('node-pty')
  // Test if native module works by checking if spawn function exists and module is properly built
  if (pty && typeof pty.spawn === 'function') {
    ptyAvailable = true
  }
} catch (e) {
  console.warn('node-pty not available, falling back to child_process:', e)
}

interface PtyInstance {
  process: any // IPty or ChildProcess
  type: 'terminal' | 'claude-code'
  cwd: string
  usePty: boolean
}

export class PtyManager {
  private instances: Map<string, PtyInstance> = new Map()
  private window: BrowserWindow

  constructor(window: BrowserWindow) {
    this.window = window
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      // Prefer PowerShell 7 (pwsh) over Windows PowerShell
      const fs = require('fs')
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
      return 'powershell.exe'
    } else if (process.platform === 'darwin') {
      return process.env.SHELL || '/bin/zsh'
    } else {
      // Linux - detect available shell
      const fs = require('fs')
      if (process.env.SHELL) {
        return process.env.SHELL
      } else if (fs.existsSync('/bin/bash')) {
        return '/bin/bash'
      } else {
        return '/bin/sh'
      }
    }
  }

  create(options: CreatePtyOptions): boolean {
    const { id, cwd, type, shell: shellOverride } = options

    const shell = shellOverride || this.getDefaultShell()
    let args: string[] = []

    // For PowerShell (pwsh or powershell), bypass execution policy to allow unsigned scripts
    if (shell.includes('powershell') || shell.includes('pwsh')) {
      args = ['-ExecutionPolicy', 'Bypass', '-NoLogo']
    }

    // Try node-pty first, fallback to child_process if it fails
    let usedPty = false

    if (ptyAvailable && pty) {
      try {
        // Set UTF-8 environment variables
        const envWithUtf8 = {
          ...process.env,
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        }

        const ptyProcess = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd,
          env: envWithUtf8 as { [key: string]: string }
        })

        ptyProcess.onData((data: string) => {
          this.window.webContents.send('pty:output', id, data)
        })

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          this.window.webContents.send('pty:exit', id, exitCode)
          this.instances.delete(id)
        })

        this.instances.set(id, { process: ptyProcess, type, cwd, usePty: true })
        usedPty = true
        console.log('Created terminal using node-pty')
      } catch (e) {
        console.warn('node-pty spawn failed, falling back to child_process:', e)
        ptyAvailable = false // Don't try again
      }
    }

    if (!usedPty) {
      try {
        // Fallback to child_process with proper stdio
        // For PowerShell, add -NoExit and UTF-8 command
        let shellArgs = [...args]
        if (shell.includes('powershell') || shell.includes('pwsh')) {
          shellArgs.push(
            '-NoExit',
            '-Command',
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8'
          )
        }

        // Set UTF-8 environment variables
        const envWithUtf8 = {
          ...process.env,
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        }

        const childProcess = spawn(shell, shellArgs, {
          cwd,
          env: envWithUtf8 as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false
        })

        childProcess.stdout?.on('data', (data: Buffer) => {
          this.window.webContents.send('pty:output', id, data.toString())
        })

        childProcess.stderr?.on('data', (data: Buffer) => {
          this.window.webContents.send('pty:output', id, data.toString())
        })

        childProcess.on('exit', (exitCode: number | null) => {
          this.window.webContents.send('pty:exit', id, exitCode ?? 0)
          this.instances.delete(id)
        })

        childProcess.on('error', (error) => {
          console.error('Child process error:', error)
          this.window.webContents.send('pty:output', id, `\r\n[Error: ${error.message}]\r\n`)
        })

        // Send initial message
        this.window.webContents.send('pty:output', id, `[Terminal - child_process mode]\r\n`)

        this.instances.set(id, { process: childProcess, type, cwd, usePty: false })
        console.log('Created terminal using child_process fallback')
      } catch (error) {
        console.error('Failed to create terminal:', error)
        return false
      }
    }

    return true
  }

  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      if (instance.usePty) {
        instance.process.write(data)
      } else {
        // For child_process, write to stdin only (shell handles echo)
        const cp = instance.process as ChildProcess
        cp.stdin?.write(data)
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id)
    if (instance && instance.usePty) {
      instance.process.resize(cols, rows)
    }
  }

  kill(id: string): boolean {
    const instance = this.instances.get(id)
    if (instance) {
      if (instance.usePty) {
        instance.process.kill()
      } else {
        (instance.process as ChildProcess).kill()
      }
      this.instances.delete(id)
      return true
    }
    return false
  }

  restart(id: string, cwd: string, shell?: string): boolean {
    const instance = this.instances.get(id)
    if (instance) {
      const type = instance.type
      this.kill(id)
      return this.create({ id, cwd, type, shell })
    }
    return false
  }

  getCwd(id: string): string | null {
    const instance = this.instances.get(id)
    if (instance) {
      return instance.cwd
    }
    return null
  }

  dispose(): void {
    for (const [id] of this.instances) {
      this.kill(id)
    }
  }
}
