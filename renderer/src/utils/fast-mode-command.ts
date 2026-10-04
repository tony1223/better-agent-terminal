import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'
import type { SlashCommandInfo } from './slash-commands'

export const BAT_FAST_SLASH_COMMAND: SlashCommandInfo = {
  name: 'bat-fast',
  description: 'Set Fast mode for this session (higher usage or additional charges)',
  argumentHint: '<on|off>',
}

type BatFastCommand = 'on' | 'off' | 'usage'

export function parseBatFastCommand(input: string): BatFastCommand | null {
  const tokens = input.trim().split(/\s+/)
  if (tokens[0].toLowerCase() !== '/bat-fast') return null
  const action = tokens[1]?.toLowerCase()
  return tokens.length === 2 && (action === 'on' || action === 'off') ? action : 'usage'
}

interface CommandOptions {
  sessionId: string
  available: boolean
  busy: boolean
  pending: { current: boolean }
  ensureSessionStarted: () => Promise<unknown>
}

export async function executeBatFastCommand(command: BatFastCommand, options: CommandOptions): Promise<string> {
  if (command === 'usage') return 'Usage: /bat-fast on | /bat-fast off'
  if (!options.available) return 'Fast mode is unavailable for this agent.'
  if (host.debug.isDebugMode !== true) return 'Fast mode requires BAT_DEBUG=1 on the host.'
  if (command === 'on' && settingsStore.getSettings().allowFastMode !== true) {
    return 'Enable Fast mode in host settings first.'
  }
  if (options.busy) return 'Wait for the current turn to finish before changing Fast mode.'
  if (options.pending.current) return 'A Fast mode change is already in progress.'

  const epoch = settingsStore.getSettings().fastModeEpoch || 0
  options.pending.current = true
  try {
    await options.ensureSessionStarted()
    const enabled = command === 'on'
    if (enabled && (host.debug.isDebugMode !== true
      || settingsStore.getSettings().allowFastMode !== true
      || (settingsStore.getSettings().fastModeEpoch || 0) !== epoch)) {
      throw new Error('Fast mode settings changed; run /bat-fast on again after enabling Fast in host settings.')
    }
    const value: unknown = await host.claude.setFastMode(options.sessionId, enabled)
    const meta = value as { fastMode?: boolean; fastModeState?: string; fastModeDisabledReason?: string } | null
    if (!meta || typeof meta.fastMode !== 'boolean') throw new Error('Fast mode is unavailable on this host.')
    if (meta.fastMode !== enabled) throw new Error(meta.fastModeDisabledReason || 'The host did not apply the Fast mode change.')
    // The setter broadcasts canonical session status, which also updates the checkbox.
    if (!enabled) return 'Fast mode disabled for this session.'
    if (meta.fastModeState === 'cooldown') {
      return 'Fast mode requested for this session; temporarily using standard speed during cooldown.'
    }
    return meta.fastModeState === 'on'
      ? 'Fast mode enabled for this session. Higher usage or additional charges may apply.'
      : 'Fast mode requested for this session. Higher usage or additional charges may apply.'
  } catch (error) {
    return `Fast mode change failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    options.pending.current = false
  }
}
