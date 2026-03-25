// @vitest-environment jsdom
/**
 * Tests for settings-store.ts
 * Covers: SettingsStore (subscribe, setters, persist) and statusline template parsing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Must use dynamic import with resetModules to get a fresh singleton per test
let settingsStore: typeof import('../../src/stores/settings-store').settingsStore
let parseStatuslineTemplate: typeof import('../../src/stores/settings-store').parseStatuslineTemplate
let exportStatuslineTemplate: typeof import('../../src/stores/settings-store').exportStatuslineTemplate

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('../../src/stores/settings-store')
  settingsStore = mod.settingsStore
  parseStatuslineTemplate = mod.parseStatuslineTemplate
  exportStatuslineTemplate = mod.exportStatuslineTemplate
  vi.restoreAllMocks()
})

describe('SettingsStore', () => {
  it('returns default settings', () => {
    const s = settingsStore.getSettings()
    expect(s.fontSize).toBe(14)
    expect(s.theme).toBe('dark')
    expect(s.agentAutoCommand).toBe(true)
  })

  it('notifies subscribers on change', () => {
    const listener = vi.fn()
    settingsStore.subscribe(listener)
    settingsStore.setFontSize(16)
    expect(listener).toHaveBeenCalledOnce()
    expect(settingsStore.getSettings().fontSize).toBe(16)
  })

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn()
    const unsub = settingsStore.subscribe(listener)
    unsub()
    settingsStore.setTheme('light')
    expect(listener).not.toHaveBeenCalled()
  })

  it('persists via electronAPI on set', () => {
    settingsStore.setFontSize(18)
    expect(window.electronAPI.settings.save).toHaveBeenCalled()
  })

  it('clamps defaultTerminalCount between 1 and 5', () => {
    settingsStore.setDefaultTerminalCount(0)
    expect(settingsStore.getSettings().defaultTerminalCount).toBe(1)
    settingsStore.setDefaultTerminalCount(99)
    expect(settingsStore.getSettings().defaultTerminalCount).toBe(5)
  })

  it('getAgentCommand returns null when disabled', () => {
    settingsStore.setAgentAutoCommand(false)
    expect(settingsStore.getAgentCommand()).toBeNull()
  })

  it('getAgentCommand returns claude for default settings', () => {
    expect(settingsStore.getAgentCommand()).toBe('claude')
  })
})

describe('parseStatuslineTemplate', () => {
  it('parses a single item', () => {
    const result = parseStatuslineTemplate('sessionId')
    const visible = result.filter(i => i.visible)
    expect(visible).toHaveLength(1)
    expect(visible[0].id).toBe('sessionId')
    expect(visible[0].align).toBe('left')
  })

  it('parses item with custom color', () => {
    const result = parseStatuslineTemplate('gitBranch(#61afef)')
    const item = result.find(i => i.id === 'gitBranch')
    expect(item?.color).toBe('#61afef')
    expect(item?.visible).toBe(true)
  })

  it('uses > as section separator', () => {
    const result = parseStatuslineTemplate('sessionId > tokens')
    const sessionId = result.find(i => i.id === 'sessionId')
    expect(sessionId?.separatorAfter).toBe(true)
  })

  it('uses | for alignment zones (2 zones)', () => {
    const result = parseStatuslineTemplate('sessionId | cost')
    expect(result.find(i => i.id === 'sessionId')?.align).toBe('left')
    expect(result.find(i => i.id === 'cost')?.align).toBe('right')
  })

  it('uses | for alignment zones (3 zones)', () => {
    const result = parseStatuslineTemplate('sessionId | cost | prompts')
    expect(result.find(i => i.id === 'sessionId')?.align).toBe('left')
    expect(result.find(i => i.id === 'cost')?.align).toBe('center')
    expect(result.find(i => i.id === 'prompts')?.align).toBe('right')
  })

  it('marks unmentioned items as not visible', () => {
    const result = parseStatuslineTemplate('sessionId')
    const hidden = result.filter(i => !i.visible)
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.every(i => !i.visible)).toBe(true)
  })

  it('ignores duplicate ids', () => {
    const result = parseStatuslineTemplate('sessionId,sessionId')
    const visible = result.filter(i => i.visible && i.id === 'sessionId')
    expect(visible).toHaveLength(1)
  })
})

describe('exportStatuslineTemplate', () => {
  it('round-trips a simple template', () => {
    const template = 'sessionId'
    const parsed = parseStatuslineTemplate(template)
    expect(exportStatuslineTemplate(parsed)).toBe(template)
  })

  it('round-trips a complex template', () => {
    const template = 'gitBranch(#61afef),sessionId > tokens,turns'
    const parsed = parseStatuslineTemplate(template)
    expect(exportStatuslineTemplate(parsed)).toBe(template)
  })

  it('round-trips template with alignment zones', () => {
    const template = 'sessionId | cost | prompts'
    const parsed = parseStatuslineTemplate(template)
    expect(exportStatuslineTemplate(parsed)).toBe(template)
  })
})
