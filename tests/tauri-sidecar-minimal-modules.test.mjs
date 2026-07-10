import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const allInOneConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.all-in-one.conf.json', import.meta.url), 'utf8'))

async function pingBundledSidecar(serverPath) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BAT_SIDECAR_DISABLE_SDK: '1',
    },
  })
  const stderrChunks = []
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

  try {
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        rl.removeAllListeners()
        child.stderr.removeListener('data', onStderr)
        child.stdin.removeListener('error', onError)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
      }
      const stderrTail = () => Buffer.concat(stderrChunks).toString('utf8').slice(-4000)
      const onStderr = (chunk) => stderrChunks.push(Buffer.from(chunk))
      const onError = (err) => {
        cleanup()
        reject(err)
      }
      const onExit = (code, signal) => {
        cleanup()
        reject(new Error(`bundled sidecar exited before ping response code=${code} signal=${signal} stderr=${stderrTail()}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        child.kill()
        reject(new Error(`timed out waiting for bundled sidecar ping stderr=${stderrTail()}`))
      }, 10_000)

      child.stderr.on('data', onStderr)
      child.stdin.on('error', onError)
      child.on('error', onError)
      child.on('exit', onExit)
      rl.on('line', (line) => {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg?.id !== 'bundle-ping') return
        cleanup()
        child.kill()
        resolve(msg)
      })
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 'bundle-ping',
        method: 'ping',
        params: { from: 'tauri-sidecar-minimal-modules' },
      }) + '\n')
    })
  } finally {
    rl.close()
    if (!child.killed) child.kill()
  }
}

assert.equal(
  allInOneConfig?.bundle?.resources?.['../node-sidecar/dist-node_modules/'],
  'node-sidecar/node_modules/',
  'Tauri all-in-one config should package the minimal sidecar node_modules tree',
)
assert.equal(
  config?.bundle?.resources?.['../node-sidecar/node_modules/'],
  undefined,
  'Tauri should not package the full sidecar node_modules tree',
)
assert.equal(
  config?.bundle?.resources?.['../node-sidecar/dist-node_modules/'],
  undefined,
  'Tauri lightweight base config should not package Claude native runtime resources',
)

const anthropicModules = new URL('../node-sidecar/dist-node_modules/@anthropic-ai', import.meta.url)
const openaiModules = new URL('../node-sidecar/dist-node_modules/@openai', import.meta.url)
let anthropicPackages = []
let openaiPackages = []
try {
  anthropicPackages = await readdir(anthropicModules)
} catch (err) {
  if (err?.code === 'ENOENT') {
    console.log('tauri-sidecar-minimal-modules: skipped (run prepare:tauri-bundle first)')
    process.exit(0)
  }
  throw err
}
try {
  openaiPackages = await readdir(openaiModules)
} catch (err) {
  if (err?.code !== 'ENOENT') throw err
}

assert.ok(
  anthropicPackages.some((name) => /^claude-agent-sdk-(win32|darwin|linux)-/.test(name)),
  'minimal sidecar node_modules must retain the platform Claude native package',
)
assert.ok(
  !anthropicPackages.includes('claude-agent-sdk'),
  'minimal sidecar node_modules should not contain the JS Claude SDK package',
)
assert.ok(
  !openaiPackages.some((name) => /^codex-(win32|darwin|linux)-/.test(name)),
  'minimal sidecar node_modules must not contain Codex native packages',
)
assert.ok(
  !openaiPackages.includes('codex') && !openaiPackages.includes('codex-sdk'),
  'minimal sidecar node_modules should not contain Codex JS packages',
)

const codexExe = process.platform === 'win32' ? 'codex.exe' : 'codex'
const codexRuntimeBinary = new URL(`../codex-runtime/bin/${codexExe}`, import.meta.url)
const codexRuntimeInfo = await stat(codexRuntimeBinary)
assert.ok(codexRuntimeInfo.size > 1024 * 1024, 'Codex app-server runtime should be packaged outside sidecar node_modules')
const codexCodeModeHost = new URL(`../codex-runtime/bin/${process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'}`, import.meta.url)
const codexCodeModeHostInfo = await stat(codexCodeModeHost)
assert.ok(codexCodeModeHostInfo.size > 0, 'Codex code-mode host must ship next to the codex binary')

const server = join(root, 'node-sidecar', 'dist', 'server.mjs')
const serverInfo = await stat(server)
const serverSource = await readFile(server, 'utf8')
assert.ok(serverInfo.size > 500 * 1024, 'bundled sidecar should not be an empty shim')
assert.ok(
  serverSource.includes('@anthropic-ai/claude-agent-sdk/sdk.mjs') && serverSource.includes('_zod'),
  'bundled sidecar should include JS dependencies',
)
assert.ok(
  !serverSource.includes('await import(path)'),
  'bundled sidecar must not retain variable handler imports',
)

const pingReply = await pingBundledSidecar(server)
assert.equal(pingReply.result?.ok, true, 'bundled sidecar must boot and answer ping without external handler files')
assert.deepEqual(pingReply.result?.echo, { from: 'tauri-sidecar-minimal-modules' })

console.log('tauri-sidecar-minimal-modules: passed')
