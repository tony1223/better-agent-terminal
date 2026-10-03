import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from './data-paths.mjs'

export function isFastModeDebugEnabled(env = process.env) {
  return ['1', 'true', 'TRUE'].includes(env.BAT_DEBUG)
}

export function readFastModePolicy() {
  if (!isFastModeDebugEnabled()) return { allowed: false, epoch: 0 }
  try {
    const settings = JSON.parse(readFileSync(join(resolveDataDir(), 'settings.json'), 'utf8'))
    return {
      allowed: settings.allowFastMode === true,
      epoch: Number.isSafeInteger(settings.fastModeEpoch) && settings.fastModeEpoch >= 0 ? settings.fastModeEpoch : 0,
    }
  } catch {
    return { allowed: false, epoch: 0 }
  }
}

// Fail closed for unknown/custom models. Never switch a user's model to enable Fast.
export function supportsClaudeFastMode(model) {
  return /^claude-opus-(?:5-5|5|4-8)(?:\[|:|$)/.test(String(model || ''))
}

export function effectiveFastMode(session, policy) {
  if (session?.fastMode !== true || !isFastModeDebugEnabled()) return false
  policy ??= readFastModePolicy()
  return policy.allowed
    && session.fastModeEpoch === policy.epoch && supportsClaudeFastMode(session.model)
}

export function refreshFastMode(session) {
  if (session.fastMode && !effectiveFastMode(session)) {
    session.fastMode = false
    session.fastModeState = 'off'
    session.fastModeDisabledReason = null
  }
}

export function applyFastModeStatus(session, message) {
  if (message?.parent_tool_use_id || !['off', 'on', 'cooldown'].includes(message?.fast_mode_state)) return false
  session.fastModeState = message.fast_mode_state
  session.fastModeDisabledReason = message.fast_mode_disabled_reason || null
  if (message.fast_mode_state === 'off') session.fastMode = false
  return true
}
