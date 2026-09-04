// Lazy SDK loader. Tries to import @anthropic-ai/claude-agent-sdk once;
// caches the resolved module or null if the import fails (e.g. release
// build without bundled node_modules). Subsequent calls return the
// cached value instantly. This lets feature handlers opportunistically
// use real SDK calls when available and fall back to stubs otherwise.
//
// We expose loadAnthropicSdk for tests so they can stub a fake module
// and verify augmentation paths without depending on the real SDK
// (which spawns the claude CLI on first call).

import { info as logInfo, warn as logWarn } from './logger.mjs'

let _sdkLoadAttempted = false
let _sdkModule = null
let _sdkOverrideSet = false
let _sdkOverride = null

export async function loadAnthropicSdk() {
  if (_sdkOverrideSet) return _sdkOverride
  if (_sdkLoadAttempted) return _sdkModule
  _sdkLoadAttempted = true
  const startedAt = Date.now()
  // Escape hatch for tests + dev shells: BAT_SIDECAR_DISABLE_SDK=1
  // forces the SDK-unavailable path even if @anthropic-ai/claude-agent-sdk
  // is importable. The e2e test uses this so claude.sendMessage takes
  // the deterministic stub path instead of trying to call the real API.
  if (process.env.BAT_SIDECAR_DISABLE_SDK === '1') {
    _sdkModule = null
    logInfo(`claude.sdkLoad: disabled elapsedMs=${Date.now() - startedAt}`)
    return null
  }
  try {
    _sdkModule = await import('@anthropic-ai/claude-agent-sdk')
    logInfo(`claude.sdkLoad: ok elapsedMs=${Date.now() - startedAt}`)
    return _sdkModule
  } catch (err) {
    _sdkModule = null
    const msg = err instanceof Error ? err.message : String(err)
    logWarn(`claude.sdkLoad: failed elapsedMs=${Date.now() - startedAt} error=${msg}`)
    return null
  }
}

// Test-only setter — pass an object to swap in a fake SDK, null to
// force the "SDK unavailable" path, undefined to clear the override
// and let normal lazy loading resume.
// True while a test has swapped the SDK: nothing will be spawned, so checks
// that only guard the real CLI spawn (e.g. cwd existence) can stand down.
export function hasSdkOverrideForTests() {
  return _sdkOverrideSet
}

export function __setSdkOverrideForTests(value) {
  if (value === undefined) {
    _sdkOverrideSet = false
    _sdkOverride = null
  } else {
    _sdkOverrideSet = true
    _sdkOverride = value
  }
}
