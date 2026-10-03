import * as assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import i18next from 'i18next'

async function main() {
let debug = false
let failSave = false
let persisted: Record<string, unknown> | null = null
const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
;(globalThis as any).window = {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      if (command === 'settings_save') {
        if (failSave) throw new Error('Cannot save policy')
        persisted = JSON.parse(String(args?.data))
      }
      return command === 'debug_is_debug_mode' ? false : null
    },
  },
  localStorage: { getItem: (key: string) => key === 'BAT_DEBUG' && debug ? '1' : null },
}
const { settingsStore } = await import('../renderer/src/stores/settings-store')
const { AgentFastModeCheckbox } = await import('../renderer/src/components/AgentFastModeCheckbox')
const i18n = i18next.createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: { claude: { fastModeHint: 'Higher usage or additional charges may apply.' } } } } })
const render = () => renderToStaticMarkup(createElement(I18nextProvider, { i18n },
  createElement(AgentFastModeCheckbox, { sessionId: 'fresh-session', disabled: false,
    ensureSessionStarted: async () => assert.fail('Rendering must not start a session') })))

assert.equal(settingsStore.getSettings().allowFastMode, false)
assert.equal(render(), '', 'normal users cannot see Fast controls')
await assert.rejects(settingsStore.setAllowFastMode(true), /BAT_DEBUG/)
debug = true
assert.equal(render(), '', 'debug alone does not unlock Fast')
failSave = true
await assert.rejects(settingsStore.setAllowFastMode(true), /Cannot save policy/)
assert.equal(render(), '', 'failed host save must not unlock a paid setting')
failSave = false
await settingsStore.setAllowFastMode(true)
const html = render()
assert.match(html, /type="checkbox"/)
assert.match(html, /Fast/)
assert.doesNotMatch(html, /checked=""/, 'global opt-in must not select Fast for a fresh session')
assert.match(html, /additional charges/)
debug = false
assert.equal(render(), '', 'persisted opt-in cannot bypass the debug UI gate')
await settingsStore.setAllowFastMode(false)
assert.equal(settingsStore.getSettings().fastModeEpoch, 1)
assert.equal((persisted as unknown as Record<string, unknown>).allowFastMode, false)
assert.ok(calls.every(call => !call.command.startsWith('claude_')), 'rendering and global settings must not mutate session speed')
console.log('fast mode UI: debug gate, default-off, host save failure, separate session opt-in and revocation passed')
}

main().catch(error => { console.error(error); process.exit(1) })
