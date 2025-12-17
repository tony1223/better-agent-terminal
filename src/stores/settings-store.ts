import type { AppSettings, ShellType } from '../types'

type Listener = () => void

const defaultSettings: AppSettings = {
  shell: 'auto',
  customShellPath: '',
  fontSize: 14,
  theme: 'dark'
}

class SettingsStore {
  private settings: AppSettings = { ...defaultSettings }
  private listeners: Set<Listener> = new Set()

  getSettings(): AppSettings {
    return this.settings
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(listener => listener())
  }

  setShell(shell: ShellType): void {
    this.settings = { ...this.settings, shell }
    this.notify()
    this.save()
  }

  setCustomShellPath(path: string): void {
    this.settings = { ...this.settings, customShellPath: path }
    this.notify()
    this.save()
  }

  setFontSize(size: number): void {
    this.settings = { ...this.settings, fontSize: size }
    this.notify()
    this.save()
  }

  setTheme(theme: 'dark' | 'light'): void {
    this.settings = { ...this.settings, theme }
    this.notify()
    this.save()
  }

  async save(): Promise<void> {
    const data = JSON.stringify(this.settings)
    await window.electronAPI.settings.save(data)
  }

  async load(): Promise<void> {
    const data = await window.electronAPI.settings.load()
    if (data) {
      try {
        const parsed = JSON.parse(data)
        this.settings = { ...defaultSettings, ...parsed }
        this.notify()
      } catch (e) {
        console.error('Failed to parse settings:', e)
      }
    }
  }
}

export const settingsStore = new SettingsStore()
