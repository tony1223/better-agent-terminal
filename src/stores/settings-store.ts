import type { AppSettings, ShellType, FontType, ColorPresetId, EnvVariable, AgentCommandType, StatuslineItemConfig, StatuslineItemId, LanguageCode } from '../types'
import type { AgentPresetId } from '../types/agent-presets'
import { FONT_OPTIONS, COLOR_PRESETS, AGENT_COMMAND_OPTIONS, STATUSLINE_ITEMS } from '../types'

type Listener = () => void

const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

const defaultSettings: AppSettings = {
  language: 'en',
  shell: 'auto',
  customShellPath: '',
  fontSize: 14,
  fontFamily: isWindows ? 'cascadia-code' : 'sf-mono',
  customFontFamily: '',
  theme: 'dark',
  colorPreset: 'novel',
  customBackgroundColor: '#1f1d1a',
  customForegroundColor: '#dfdbc3',
  customCursorColor: '#dfdbc3',
  globalEnvVars: [],
  defaultAgent: 'claude-code' as AgentPresetId,
  agentAutoCommand: true,
  agentCommandType: 'claude',
  agentCustomCommand: '',
  defaultTerminalCount: 1,
  createDefaultAgentTerminal: true,
  allowBypassPermissions: true,
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

  setLanguage(language: LanguageCode): void {
    this.settings = { ...this.settings, language }
    this.notify()
    this.save()
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

  setDefaultTerminalCount(count: number): void {
    this.settings = { ...this.settings, defaultTerminalCount: Math.max(1, Math.min(5, count)) }
    this.notify()
    this.save()
  }

  setCreateDefaultAgentTerminal(create: boolean): void {
    this.settings = { ...this.settings, createDefaultAgentTerminal: create }
    this.notify()
    this.save()
  }

  setDefaultAgent(agent: AgentPresetId): void {
    this.settings = { ...this.settings, defaultAgent: agent }
    this.notify()
    this.save()
  }

  setAllowBypassPermissions(allow: boolean): void {
    this.settings = { ...this.settings, allowBypassPermissions: allow }
    this.notify()
    this.save()
  }


  setCollapseToolOutputs(collapse: boolean): void {
    this.settings = { ...this.settings, collapseToolOutputs: collapse }
    this.notify()
    this.save()
  }

  setDefaultModel(model: string): void {
    this.settings = { ...this.settings, defaultModel: model || undefined }
    this.notify()
    this.save()
  }

  setDefaultEffort(effort: 'low' | 'medium' | 'high' | 'max'): void {
    this.settings = { ...this.settings, defaultEffort: effort }
    this.notify()
    this.save()
  }

  setShowDockBadge(show: boolean): void {
    this.settings = { ...this.settings, showDockBadge: show }
    this.notify()
    this.save()
    if (!show) window.electronAPI?.app?.setDockBadge?.(0)
  }

  setNotifyOnComplete(enabled: boolean): void {
    this.settings = { ...this.settings, notifyOnComplete: enabled }
    this.notify()
    this.save()
  }

  setNotifySound(enabled: boolean): void {
    this.settings = { ...this.settings, notifySound: enabled }
    this.notify()
    this.save()
  }

  setNotifyOnlyBackground(enabled: boolean): void {
    this.settings = { ...this.settings, notifyOnlyBackground: enabled }
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

  // Statusline configuration
  getStatuslineItems(): StatuslineItemConfig[] {
    // Items whose color is managed dynamically in the renderer — strip any user-configured color
    const DYNAMIC_COLOR_ITEMS = new Set(['contextPct'])
    const stripDynamicColors = (items: StatuslineItemConfig[]) =>
      items.map(i => DYNAMIC_COLOR_ITEMS.has(i.id) ? { ...i, color: undefined } : i)

    if (this.settings.statuslineItems?.length) {
      const savedIds = new Set(this.settings.statuslineItems.map(i => i.id))
      const missing = STATUSLINE_ITEMS
        .filter(d => !savedIds.has(d.id))
        .map(d => ({ id: d.id, visible: d.defaultVisible, align: 'left' as const }))
      return stripDynamicColors([...this.settings.statuslineItems, ...missing])
    }
    // Default template
    return stripDynamicColors(parseStatuslineTemplate('gitBranch(#61afef),sessionId(#d19a66) > tokens,turns,duration > contextPct,cost > usage5h,usage5hReset > usage7d(#e5c07b),usage7dReset(#e5c07b) > prompts(#d19a66)'))
  }

  setStatuslineItems(items: StatuslineItemConfig[]): void {
    this.settings = { ...this.settings, statuslineItems: items }
    this.notify()
    this.save()
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

// Parse a single token like "sessionId(#e06c75)" → { id: "sessionId", color: "#e06c75" }
function parseToken(token: string): { id: string; color?: string } {
  const match = token.match(/^(\w+)\(([^)]+)\)$/)
  if (match) return { id: match[1], color: match[2] }
  return { id: token }
}

// Template string → config
// Format: "sessionId(#e06c75),tokens > cost | prompts"
export function parseStatuslineTemplate(template: string): StatuslineItemConfig[] {
  const allIds = new Set(STATUSLINE_ITEMS.map(d => d.id))
  const alignZones = template.split('|').map(s => s.trim())
  const aligns: Array<'left' | 'center' | 'right'> =
    alignZones.length >= 3 ? ['left', 'center', 'right'] :
    alignZones.length === 2 ? ['left', 'right'] : ['left']

  const result: StatuslineItemConfig[] = []
  const seenIds = new Set<string>()

  for (let zi = 0; zi < alignZones.length && zi < 3; zi++) {
    const align = aligns[zi]
    const sections = alignZones[zi].split('>').map(s => s.trim()).filter(Boolean)
    for (let si = 0; si < sections.length; si++) {
      const tokens = sections[si].split(',').map(s => s.trim()).filter(Boolean)
      for (let ii = 0; ii < tokens.length; ii++) {
        const { id, color } = parseToken(tokens[ii])
        if (!allIds.has(id) || seenIds.has(id)) continue
        seenIds.add(id)
        result.push({
          id: id as StatuslineItemId,
          visible: true,
          align,
          color,
          separatorAfter: ii === tokens.length - 1 && si < sections.length - 1,
        })
      }
    }
  }
  for (const def of STATUSLINE_ITEMS) {
    if (!seenIds.has(def.id)) {
      result.push({ id: def.id, visible: false, align: 'left' })
    }
  }
  return result
}

// Config → template string
export function exportStatuslineTemplate(items: StatuslineItemConfig[]): string {
  const zones: Record<string, string[][]> = { left: [[]], center: [[]], right: [[]] }
  for (const item of items.filter(i => i.visible)) {
    const align = item.align || 'left'
    if (!zones[align]) zones[align] = [[]]
    const token = item.color ? `${item.id}(${item.color})` : item.id
    zones[align][zones[align].length - 1].push(token)
    if (item.separatorAfter) zones[align].push([])
  }
  const fmt = (sections: string[][]) =>
    sections.filter(s => s.length).map(s => s.join(',')).join(' > ')
  const left = fmt(zones.left)
  const center = fmt(zones.center)
  const right = fmt(zones.right)
  if (center) return [left, center, right].filter(Boolean).join(' | ')
  if (right) return [left, right].filter(Boolean).join(' | ')
  return left
}
