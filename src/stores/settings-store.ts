import type { AppSettings, ShellType, FontType, ColorPresetId, EnvVariable, AgentCommandType } from '../types'
import { FONT_OPTIONS, COLOR_PRESETS, AGENT_COMMAND_OPTIONS } from '../types'

type Listener = () => void

const defaultSettings: AppSettings = {
  shell: 'auto',
  customShellPath: '',
  fontSize: 14,
  fontFamily: 'sf-mono',
  customFontFamily: '',
  theme: 'dark',
  colorPreset: 'novel',
  customBackgroundColor: '#1f1d1a',
  customForegroundColor: '#dfdbc3',
  customCursorColor: '#dfdbc3',
  globalEnvVars: [],
  agentAutoCommand: false,
  agentCommandType: 'claude',
  agentCustomCommand: ''
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

  setFontFamily(fontFamily: FontType): void {
    this.settings = { ...this.settings, fontFamily }
    this.notify()
    this.save()
  }

  setCustomFontFamily(customFontFamily: string): void {
    this.settings = { ...this.settings, customFontFamily }
    this.notify()
    this.save()
  }

  setColorPreset(colorPreset: ColorPresetId): void {
    this.settings = { ...this.settings, colorPreset }
    this.notify()
    this.save()
  }

  setCustomBackgroundColor(customBackgroundColor: string): void {
    this.settings = { ...this.settings, customBackgroundColor }
    this.notify()
    this.save()
  }

  setCustomForegroundColor(customForegroundColor: string): void {
    this.settings = { ...this.settings, customForegroundColor }
    this.notify()
    this.save()
  }

  setCustomCursorColor(customCursorColor: string): void {
    this.settings = { ...this.settings, customCursorColor }
    this.notify()
    this.save()
  }

  // Environment Variables
  setGlobalEnvVars(envVars: EnvVariable[]): void {
    this.settings = { ...this.settings, globalEnvVars: envVars }
    this.notify()
    this.save()
  }

  addGlobalEnvVar(envVar: EnvVariable): void {
    const current = this.settings.globalEnvVars || []
    this.settings = { ...this.settings, globalEnvVars: [...current, envVar] }
    this.notify()
    this.save()
  }

  removeGlobalEnvVar(key: string): void {
    const current = this.settings.globalEnvVars || []
    this.settings = { ...this.settings, globalEnvVars: current.filter(e => e.key !== key) }
    this.notify()
    this.save()
  }

  updateGlobalEnvVar(key: string, updates: Partial<EnvVariable>): void {
    const current = this.settings.globalEnvVars || []
    this.settings = {
      ...this.settings,
      globalEnvVars: current.map(e => e.key === key ? { ...e, ...updates } : e)
    }
    this.notify()
    this.save()
  }

  // Agent Auto Command
  setAgentAutoCommand(agentAutoCommand: boolean): void {
    this.settings = { ...this.settings, agentAutoCommand }
    this.notify()
    this.save()
  }

  setAgentCommandType(agentCommandType: AgentCommandType): void {
    this.settings = { ...this.settings, agentCommandType }
    this.notify()
    this.save()
  }

  setAgentCustomCommand(agentCustomCommand: string): void {
    this.settings = { ...this.settings, agentCustomCommand }
    this.notify()
    this.save()
  }

  // Get the agent command to execute
  getAgentCommand(): string | null {
    if (!this.settings.agentAutoCommand) return null
    if (this.settings.agentCommandType === 'custom') {
      return this.settings.agentCustomCommand || null
    }
    const option = AGENT_COMMAND_OPTIONS.find(o => o.id === this.settings.agentCommandType)
    return option?.command || null
  }

  // Get terminal colors based on preset or custom settings
  getTerminalColors(): { background: string; foreground: string; cursor: string } {
    if (this.settings.colorPreset === 'custom') {
      return {
        background: this.settings.customBackgroundColor,
        foreground: this.settings.customForegroundColor,
        cursor: this.settings.customCursorColor
      }
    }
    const preset = COLOR_PRESETS.find(p => p.id === this.settings.colorPreset)
    return preset || COLOR_PRESETS[0]
  }

  // Get the actual CSS font-family string based on settings
  getFontFamilyString(): string {
    if (this.settings.fontFamily === 'custom' && this.settings.customFontFamily) {
      return `"${this.settings.customFontFamily}", monospace`
    }
    const fontOption = FONT_OPTIONS.find(f => f.id === this.settings.fontFamily)
    return fontOption?.fontFamily || 'monospace'
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
