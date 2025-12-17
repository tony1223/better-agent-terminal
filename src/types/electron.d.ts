import type { CreatePtyOptions } from './index'

interface ElectronAPI {
  pty: {
    create: (options: CreatePtyOptions) => Promise<boolean>
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    kill: (id: string) => Promise<boolean>
    restart: (id: string, cwd: string, shell?: string) => Promise<boolean>
    getCwd: (id: string) => Promise<string | null>
    onOutput: (callback: (id: string, data: string) => void) => () => void
    onExit: (callback: (id: string, exitCode: number) => void) => () => void
  }
  workspace: {
    save: (data: string) => Promise<boolean>
    load: () => Promise<string | null>
  }
  settings: {
    save: (data: string) => Promise<boolean>
    load: () => Promise<string | null>
    getShellPath: (shell: string) => Promise<string>
  }
  dialog: {
    selectFolder: () => Promise<string | null>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
