import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function tauriSmokeExecutable() {
  const config = JSON.parse(readFileSync(resolve('src-tauri', 'tauri.conf.json'), 'utf8'))
  const target = process.env.CARGO_TARGET_DIR
    ? resolve(process.env.CARGO_TARGET_DIR)
    : resolve('src-tauri', 'target')
  const profile = process.env.TAURI_PROFILE === 'debug' ? 'debug' : 'release'
  const extension = process.platform === 'win32' ? '.exe' : ''
  // Tauri renames the Cargo binary to mainBinaryName when producing bundles.
  // Probe that name first so release smoke tests exercise the actual installer
  // binary, then fall back to the unrenamed binary from a plain cargo build.
  const candidates = [config.mainBinaryName, 'better-agent-terminal']
    .filter(Boolean).map(name => join(target, profile, `${name}${extension}`))
  return candidates.find(path => existsSync(path)) ?? candidates[0]
}

export function createTauriSmokeData(prefix: string) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    codexUnifiedAccounts: false,
    codexSharedHome: join(dataDir, 'codex-home'),
  }))
  return {
    dataDir,
    env: {
      ...process.env,
      BAT_TAURI_DATA_DIR: dataDir,
      BAT_SIDECAR_DATA_DIR: dataDir,
      CODEX_HOME: join(dataDir, 'codex-home'),
      BAT_DEBUG: '1',
    },
    cleanup: () => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  }
}
