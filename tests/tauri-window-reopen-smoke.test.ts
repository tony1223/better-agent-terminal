// Exercises the startup anchor/restore race and native single-instance routing
// against a built desktop binary. Debug binaries require the Vite dev server.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTauriSmokeData, tauriSmokeExecutable } from './helpers/tauri-smoke-data'

const exePath = tauriSmokeExecutable()
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

async function waitFor(label: string, predicate: () => boolean) {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function run() {
  if (!existsSync(exePath)) {
    console.log(`tauri-window-reopen-smoke: skipped — exe not found at ${exePath}`)
    return
  }
  const fixture = createTauriSmokeData('bat-window-reopen-')
  const separate = createTauriSmokeData('bat-window-separate-')
  const children: ChildProcess[] = []
  let stderr = ''
  const logPath = join(fixture.dataDir, 'logs', 'debug.log')
  const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const count = (pattern: RegExp) => [...log().matchAll(pattern)].length
  const start = (args: string[] = [], env = fixture.env) => {
    const proc = spawn(exePath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stderr?.on('data', chunk => { stderr += chunk.toString() })
    proc.stdout?.on('data', () => { /* drain */ })
    children.push(proc)
    return proc
  }
  const exited = async (proc: ChildProcess) => {
    await waitFor(`secondary process ${proc.pid} to exit`, () => proc.exitCode !== null)
    assert.equal(proc.exitCode, 0, stderr)
  }
  try {
    const profiles = ['bat', 'default', 'game', 'smoke-remote'].map(id => ({
      id, name: id, type: id === 'smoke-remote' ? 'remote' : 'local',
      createdAt: 1, updatedAt: 1,
    }))
    mkdirSync(join(fixture.dataDir, 'profiles'))
    writeFileSync(join(fixture.dataDir, 'profiles', 'index.json'), JSON.stringify({
      profiles, activeProfileIds: ['smoke-remote'],
    }))
    // The incomplete remote alias triggers the local anchor without dialing a
    // real host. Activating the anchor also adds it to the restore target list.
    const first = start()
    const second = start()
    await waitFor('one surviving desktop process', () =>
      (first.exitCode === 0) !== (second.exitCode === 0))
    const primary = first.exitCode === 0 ? second : first
    await waitFor('local anchor renderer', () =>
      /profile selection windowId=profile-bat-/.test(log()))
    assert.equal(primary.exitCode, null, stderr)
    assert.equal(count(/\[startup\] window id: main/g), 1)
    assert.equal(count(/\[window\] created label=profile-bat-/g), 1,
      'startup anchor and active-profile restore must share one queued window')

    await exited(start())
    // Resolve a second spelling of the same data directory to the same lock.
    await exited(start(['--profile=bat'], {
      ...fixture.env, BAT_TAURI_DATA_DIR: join(fixture.dataDir, 'profiles', '..'),
    }))
    await waitFor('forwarded bat profile', () => log().includes('[app] second-instance profile=bat'))
    assert.equal(count(/\[window\] created label=profile-bat-/g), 1)
    assert.equal(count(/\[startup\] window id: main/g), 1)

    await exited(start(['--profile', 'game']))
    await waitFor('forwarded game profile renderer', () =>
      /profile selection windowId=profile-game-/.test(log()))
    await exited(start(['--profile=game']))
    await waitFor('both forwarded game requests', () =>
      count(/\[app\] second-instance profile=game/g) === 2)
    assert.equal(count(/\[window\] created label=profile-game-/g), 1)
    assert.equal(primary.exitCode, null, stderr)

    const independent = start([], separate.env)
    await waitFor('independent data directory startup', () => {
      const path = join(separate.dataDir, 'logs', 'debug.log')
      return existsSync(path) && readFileSync(path, 'utf8').includes('[startup] app ready')
    })
    assert.equal(independent.exitCode, null, stderr)
    assert.equal(primary.exitCode, null, stderr)
    assert.doesNotMatch(stderr, /thread '[^']*' panicked/)
    console.log('tauri-window-reopen-smoke: passed (queued restore, simultaneous launches, profile forwarding, data isolation)')
  } catch (error) {
    throw new Error(`${String(error)}\nstderr:\n${stderr.slice(-6000)}\nlog:\n${log().slice(-6000)}`)
  } finally {
    for (const proc of children) {
      if (!proc.pid || proc.exitCode !== null) continue
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        proc.kill('SIGTERM')
      }
    }
    await sleep(500)
    fixture.cleanup()
    separate.cleanup()
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
