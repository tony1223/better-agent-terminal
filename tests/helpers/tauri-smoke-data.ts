import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
