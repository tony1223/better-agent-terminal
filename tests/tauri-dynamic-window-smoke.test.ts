// Smoke test for Tauri dynamic window creation.
//
// This launches the built Tauri executable with a test-only env hook that
// asks the main renderer to open a profile window through host.app.newWindow(),
// the same renderer IPC path used by Ctrl+N. It then watches Tauri's debug.log
// for the dynamic window lifecycle markers.
//
// Run with:
//   TAURI_PROFILE=debug pnpm run test:tauri-dynamic-window-smoke

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { createTauriSmokeData, tauriSmokeExecutable } from './helpers/tauri-smoke-data'

const exePath = tauriSmokeExecutable()

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
}

function readLog(logPath: string): string {
  if (!existsSync(logPath)) return ''
  return readFileSync(logPath, 'utf8')
}

async function waitFor(
  label: string,
  fn: () => string | null,
  timeoutMs = 15_000,
): Promise<string> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = fn()
    if (value) return value
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function isDevServerReachable(): Promise<boolean> {
  return new Promise(resolve => {
    const req = request('http://127.0.0.1:5173/', { method: 'HEAD', timeout: 1000 }, res => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

async function run(): Promise<void> {
  if (!existsSync(exePath)) {
    console.log(`tauri-dynamic-window-smoke: skipped — exe not found at ${exePath}`)
    return
  }

  if (process.env.TAURI_PROFILE === 'debug' && !(await isDevServerReachable())) {
    throw new Error('tauri-dynamic-window-smoke: debug profile requires Vite at http://127.0.0.1:5173/')
  }

  const token = `dyn-${Date.now()}-${process.pid}`
  const fixture = createTauriSmokeData('bat-dynamic-window-')
  const logPath = join(fixture.dataDir, 'logs', 'debug.log')
  const proc = spawn(exePath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...fixture.env,
      BAT_TAURI_DYNAMIC_WINDOW_SMOKE_TOKEN: token,
    },
  })
  let stderr = ''
  let exitedEarly: number | null = null
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  proc.stdout?.on('data', () => { /* drain */ })
  proc.on('exit', code => {
    if (exitedEarly === null) exitedEarly = code ?? -1
  })
  const assertStillRunning = () => {
    if (exitedEarly !== null) {
      throw new Error(`tauri-dynamic-window-smoke: exe exited early with code ${exitedEarly}; stderr=${stderr}`)
    }
  }

  try {
    const marker = `[window-smoke:${token}] renderer-requested`
    await waitFor('renderer dynamic window smoke request log', () => {
      assertStillRunning()
      return readLog(logPath).includes(marker) ? marker : null
    })

    const windowLabel = await waitFor('dynamic window queue log', () => {
      assertStillRunning()
      const log = readLog(logPath)
      const markerIndex = log.indexOf(marker)
      if (markerIndex < 0) return null
      const match = log.slice(markerIndex).match(/\[window\] queue-build label=([^\s]+)/)
      return match?.[1] ?? null
    })

    await waitFor(`renderer new-window result log for ${windowLabel}`, () => {
      assertStillRunning()
      const log = readLog(logPath)
      return log.includes(`[window-smoke:${token}] renderer-new-window id=${windowLabel}`)
        ? 'renderer-new-window'
        : null
    })

    await waitFor(`created log for ${windowLabel}`, () => {
      assertStillRunning()
      return readLog(logPath).includes(`[window] created label=${windowLabel}`) ? 'created' : null
    })
    await waitFor(`page-load Finished log for ${windowLabel}`, () => {
      assertStillRunning()
      const log = readLog(logPath)
      return log.includes(`[window] page-load label=${windowLabel} event=Finished`) ? 'finished' : null
    })

    assertStillRunning()
    if (/thread '[^']*' panicked/.test(stderr)) {
      throw new Error(`tauri-dynamic-window-smoke: panic detected on stderr:\n${stderr}`)
    }

    console.log(`tauri-dynamic-window-smoke: passed (${windowLabel})`)
  } finally {
    if (proc.pid) killTree(proc.pid)
    await sleep(500)
    fixture.cleanup()
  }
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
