import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collectTauriPreviewReadiness } from '../scripts/check-tauri-preview-readiness.mjs'

const root = join(tmpdir(), `bat-tauri-preview-readiness-${process.pid}`)
await rm(root, { recursive: true, force: true })

async function writeTauriConfigs(root, runtimeResources = true) {
  await writeFile(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({
    bundle: {
      resources: {
        '../node-sidecar/dist/server.mjs': 'node-sidecar/dist/server.mjs',
        '../node-sidecar/package.json': 'node-sidecar/package.json',
      },
    },
  }))
  await writeFile(join(root, 'src-tauri', 'tauri.all-in-one.conf.json'), JSON.stringify({
    bundle: {
      resources: runtimeResources
        ? {
            '../node-sidecar/dist-node_modules/': 'node-sidecar/node_modules/',
            '../codex-runtime/': 'codex-runtime/',
            '../node-sidecar/runtime/': 'node-runtime/',
          }
        : {},
    },
  }))
}

try {
  await mkdir(join(root, 'src-tauri'), { recursive: true })
  await mkdir(join(root, 'node-sidecar', 'dist'), { recursive: true })
  await mkdir(join(root, 'node-sidecar', 'dist-node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64'), { recursive: true })
  await mkdir(join(root, 'codex-runtime'), { recursive: true })
  await mkdir(join(root, 'node-sidecar', 'runtime', 'windows-x86_64'), { recursive: true })

  await writeTauriConfigs(root)
  await writeFile(join(root, 'node-sidecar', 'dist', 'server.mjs'), 'console.log("ok")')
  await writeFile(join(root, 'node-sidecar', 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'node-sidecar', 'dist-node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'), 'claude')
  await mkdir(join(root, 'codex-runtime', 'bin'), { recursive: true })
  await writeFile(join(root, 'codex-runtime', 'bin', 'codex.exe'), 'codex')
  await writeFile(join(root, 'codex-runtime', 'bin', 'codex-code-mode-host.exe'), 'code-mode-host')
  await mkdir(join(root, 'codex-runtime', 'codex-path'), { recursive: true })
  await writeFile(join(root, 'codex-runtime', 'codex-path', 'rg.exe'), 'rg')
  await writeFile(join(root, 'codex-runtime', 'codex-package.json'), '{}')
  await writeFile(join(root, 'node-sidecar', 'runtime', 'windows-x86_64', 'node.exe'), 'node')

  const ready = await collectTauriPreviewReadiness({
    root,
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal(ready.ok, true)

  await writeTauriConfigs(root, false)
  const notReady = await collectTauriPreviewReadiness({
    root,
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal(notReady.ok, false)
  assert.ok(notReady.checks.some((check) => check.name === 'resource:../node-sidecar/runtime/' && !check.ok))

  const lightweightReady = await collectTauriPreviewReadiness({
    root,
    platform: 'win32',
    arch: 'x64',
    mode: 'lightweight',
  })
  assert.equal(lightweightReady.ok, true)
  assert.ok(!lightweightReady.checks.some((check) => check.name === 'resource:../node-sidecar/runtime/'))

  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'src-tauri'), { recursive: true })
  await mkdir(join(root, 'node-sidecar', 'dist'), { recursive: true })
  await mkdir(join(root, 'node-sidecar', 'dist-node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64'), { recursive: true })
  await mkdir(join(root, 'codex-runtime', 'bin'), { recursive: true })
  await mkdir(join(root, 'codex-runtime', 'codex-path'), { recursive: true })
  await mkdir(join(root, 'node-sidecar', 'runtime', 'linux-x86_64', 'bin'), { recursive: true })
  await writeTauriConfigs(root)
  await writeFile(join(root, 'node-sidecar', 'dist', 'server.mjs'), 'console.log("ok")')
  await writeFile(join(root, 'node-sidecar', 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'node-sidecar', 'dist-node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude.gz'), 'compressed')
  await writeFile(join(root, 'codex-runtime', 'bin', 'codex'), 'codex')
  await writeFile(join(root, 'codex-runtime', 'bin', 'codex-code-mode-host'), 'code-mode-host')
  await writeFile(join(root, 'codex-runtime', 'codex-path', 'rg'), 'rg')
  await writeFile(join(root, 'codex-runtime', 'codex-package.json'), '{}')
  await writeFile(join(root, 'node-sidecar', 'runtime', 'linux-x86_64', 'bin', 'node'), 'node')
  const linuxReady = await collectTauriPreviewReadiness({
    root,
    platform: 'linux',
    arch: 'x64',
  })
  assert.equal(linuxReady.ok, true)
  assert.ok(linuxReady.checks.some((check) => check.name === 'sidecar:claude-native:linux-x64' && check.detail.includes('claude.gz')))

  console.log('check-tauri-preview-readiness: passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
