// Smoke test for the Tauri release shell.
//
// Launches src-tauri/target/release/better-agent-terminal.exe, waits long
// enough for the WebView to spin up, and asserts the process did not
// crash early. Skipped if the exe doesn't exist (e.g., CI hasn't run
// `pnpm exec tauri build` yet).
//
// Run with: pnpm exec tsx tests/tauri-launch.test.ts
//
// This is a coarse signal — the test passes as long as the binary loads
// without an immediate panic. It can't observe the WebView contents from
// outside, so functional verification still has to happen interactively
// or via a future tauri-driver/webdriver harness.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

async function run(): Promise<void> {
  if (!existsSync(exePath)) {
    console.log(`tauri-launch: skipped — exe not found at ${exePath}`)
    return
  }

  // Capture stderr so we can sniff for Rust panics (`thread '...' panicked`)
  // or sidecar-bridge bring-up failures. stdout stays piped so launching
  // the WebView doesn't block on a full pipe.
  const fixture = createTauriSmokeData('bat-launch-')
  const proc = spawn(exePath, [], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let exitedEarly: number | null = null
  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  proc.stdout?.on('data', () => { /* drain */ })
  proc.on('exit', code => {
    if (exitedEarly === null) exitedEarly = code ?? -1
  })

  // 3 seconds is enough to see panics or initialization errors but short
  // enough to keep the test fast. WebView2 init on Windows usually finishes
  // in < 1s on warm cache.
  await sleep(3000)

  if (exitedEarly !== null) {
    fixture.cleanup()
    throw new Error(`tauri-launch: exe exited early with code ${exitedEarly}; stderr=${stderr}`)
  }

  // Sniff for Rust panics on stderr. WebView2 sometimes emits warnings on
  // a fresh user data dir — those don't include "panicked" so we can
  // afford a strict substring match.
  if (/thread '[^']*' panicked/.test(stderr)) {
    if (proc.pid) killTree(proc.pid)
    await sleep(500)
    fixture.cleanup()
    throw new Error(`tauri-launch: panic detected on stderr:\n${stderr}`)
  }

  // Tear down. We don't assert on the exit code after kill — Windows
  // taskkill returns non-zero termination codes, that's expected.
  killTree(proc.pid!)
  // Give the OS a moment to reap the process so the test runner can exit.
  await sleep(500)
  fixture.cleanup()

  console.log('tauri-launch: passed (binary loaded, no early crash, no panics)')
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
