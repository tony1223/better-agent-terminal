// Better Agent Terminal — Node sidecar.
//
// Speaks line-delimited JSON-RPC 2.0 over stdio. Tauri spawns one of these
// per app instance and forwards renderer invocations through it. This file
// is plain ESM JS — no build step — so the same file runs under `node` in
// dev and (eventually) under a bundled Node runtime in release.
//
// Wire format (one JSON object per stdin/stdout line, no Content-Length):
//   request:      {"jsonrpc":"2.0","id":N,"method":"foo.bar","params":...}
//   response ok:  {"jsonrpc":"2.0","id":N,"result":...}
//   response err: {"jsonrpc":"2.0","id":N,"error":{"code":N,"message":"..."}}
//   server event: {"jsonrpc":"2.0","method":"event:name","params":...}
//
// We deliberately ignore JSON-RPC batching for now — every callsite under
// host.* sends one request at a time, so the extra complexity buys nothing.
//
// Run with: node node-sidecar/src/server.mjs
//
// Tests live in node-sidecar/tests/server.test.mjs.
//
// Code layout: this file is a thin orchestrator. Shared singletons live
// under ./lib/, RPC handlers under ./handlers/. Handler modules call
// registerHandler() at import time; importing them here is what wires
// every method up.

import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { registerHandler, handlers, dispatch, sendEvent, writeMessage, __setSendEventForTests } from './lib/protocol.mjs'
import { initLogger, getLogPath, attachProcessHooks, __setLogPathOverrideForTests } from './lib/logger.mjs'
import { sessions } from './lib/state.mjs'
import { loadAnthropicSdk, __setSdkOverrideForTests } from './lib/sdk-loader.mjs'
import { __setProjectsDirOverrideForTests, __normalizeMainPath } from './lib/data-paths.mjs'
import {
  CLAUDE_BUILTIN_MODELS,
  CLAUDE_BUILTIN_DEDUP_KEYS,
  CLAUDE_MODEL_CONTEXT_WINDOWS,
  expectedContextWindowForModel,
  sdkModelForClaudeSelection,
} from './lib/models.mjs'
import { dataUrlToContentBlock, loadInstalledPlugins, loadInstalledPluginEntries, __setPluginsPathOverrideForTests } from './lib/plugins.mjs'
import { scanSkills, scanPluginSkills, parseSkillFrontmatter } from './lib/skills.mjs'

const CLAUDE_HANDLER_MODULES = [
  './handlers/claude-auth.mjs',
  './handlers/claude-auth-login.mjs',
  './handlers/claude-session.mjs',
  './handlers/claude-permission.mjs',
  './handlers/claude-history.mjs',
  './handlers/claude-send.mjs',
  './handlers/claude-readonly.mjs',
  './handlers/claude-mcp.mjs',
  './handlers/claude-channel.mjs',
  './handlers/claude-cli.mjs',
]

// Keep the import specifiers as string literals. The Tauri release build
// bundles this entry into one dist/server.mjs file; variable import(path)
// leaves runtime imports behind and packaged installs do not ship
// node-sidecar/dist/handlers/*.mjs.
const CLAUDE_HANDLER_LOADERS = new Map([
  ['./handlers/claude-auth.mjs', () => import('./handlers/claude-auth.mjs')],
  ['./handlers/claude-auth-login.mjs', () => import('./handlers/claude-auth-login.mjs')],
  ['./handlers/claude-session.mjs', () => import('./handlers/claude-session.mjs')],
  ['./handlers/claude-permission.mjs', () => import('./handlers/claude-permission.mjs')],
  ['./handlers/claude-history.mjs', () => import('./handlers/claude-history.mjs')],
  ['./handlers/claude-send.mjs', () => import('./handlers/claude-send.mjs')],
  ['./handlers/claude-readonly.mjs', () => import('./handlers/claude-readonly.mjs')],
  ['./handlers/claude-mcp.mjs', () => import('./handlers/claude-mcp.mjs')],
  ['./handlers/claude-channel.mjs', () => import('./handlers/claude-channel.mjs')],
  ['./handlers/claude-cli.mjs', () => import('./handlers/claude-cli.mjs')],
])

export let findClaudeCliPath
export let listSessionsFallback
export let __resetMetadataCacheForTests
export let fetchAuthStatus
export let readAccountIndex
export let resolveClaudeCliBinary
export let resolveClaudeCliBinaryWithInstall
export let __resetClaudeCliCacheForTests
export let __setClaudeNativeCatalogForTests
export let __setClaudeNativeDownloaderForTests

async function loadHandlers() {
  const loaded = new Map()
  const load = async (path) => {
    const loader = CLAUDE_HANDLER_LOADERS.get(path)
    if (!loader) throw new Error(`sidecar: missing handler loader for ${path}`)
    if (!loaded.has(path)) loaded.set(path, await loader())
    return loaded.get(path)
  }
  for (const path of CLAUDE_HANDLER_MODULES) await load(path)
  const readonly = await load('./handlers/claude-readonly.mjs')
  findClaudeCliPath = readonly.findClaudeCliPath
  listSessionsFallback = readonly.listSessionsFallback
  __resetMetadataCacheForTests = readonly.__resetMetadataCacheForTests

  const auth = await load('./handlers/claude-auth.mjs')
  fetchAuthStatus = auth.fetchAuthStatus
  readAccountIndex = auth.readAccountIndex
  resolveClaudeCliBinary = auth.resolveClaudeCliBinary
  resolveClaudeCliBinaryWithInstall = auth.resolveClaudeCliBinaryWithInstall
  __resetClaudeCliCacheForTests = auth.__resetClaudeCliCacheForTests
  __setClaudeNativeCatalogForTests = auth.__setClaudeNativeCatalogForTests
  __setClaudeNativeDownloaderForTests = auth.__setClaudeNativeDownloaderForTests
}

// Ping is the lone built-in that doesn't fit any namespace — keep it
// here so the entry file has at least one obvious registration.
registerHandler('ping', async (params) => {
  // Round-trip echo. Used by the Rust bridge as a startup probe.
  return { ok: true, echo: params ?? null, pid: process.pid }
})

// sidecar.* — process-level utility namespace. getLogPath returns the
// resolved path of the sidecar's append-only debug log so the renderer
// (or a future bug-report flow) can surface it to the user.
registerHandler('sidecar.getLogPath', async () => ({ path: getLogPath() }))

// Re-export the test-visible surface. server.test.mjs imports these
// directly off the module, so every name listed below must be present.
export {
  // protocol primitives
  dispatch,
  handlers,
  registerHandler,
  sendEvent,
  __setSendEventForTests,
  // logger
  initLogger,
  getLogPath,
  attachProcessHooks,
  __setLogPathOverrideForTests,
  // state
  sessions,
  // sdk loader
  loadAnthropicSdk,
  __setSdkOverrideForTests,
  // data paths
  __setProjectsDirOverrideForTests,
  __normalizeMainPath,
  // models
  CLAUDE_BUILTIN_MODELS,
  CLAUDE_BUILTIN_DEDUP_KEYS,
  CLAUDE_MODEL_CONTEXT_WINDOWS,
  expectedContextWindowForModel,
  sdkModelForClaudeSelection,
  // plugins / images
  dataUrlToContentBlock,
  loadInstalledPlugins,
  loadInstalledPluginEntries,
  __setPluginsPathOverrideForTests,
  // skills
  scanSkills,
  scanPluginSkills,
  parseSkillFrontmatter,
}

export { resolveDataDir } from './lib/data-paths.mjs'

// --- main ------------------------------------------------------------------

function main() {
  // Boot the on-disk log first so anything that happens during stdin
  // setup (including uncaughtException from a malformed handler import,
  // though those'd already have crashed module load) lands in the file.
  initLogger()
  attachProcessHooks()
  // readline handles CR/LF differences, partial chunks, and large lines
  // without us needing to buffer-and-split manually.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    const reply = await dispatch(parsed)
    if (reply) writeMessage(reply)
  })
  rl.on('close', () => {
    // Stdin closed — Tauri parent went away. Exit cleanly so we don't
    // become a zombie if the process tree teardown is unusual on Windows.
    process.exit(0)
  })
}

// import.meta.url comparison handles both `node server.mjs` and being
// imported by tests. When imported, main() is not run and the test can
// drive `dispatch` directly via the exported handlers.
const isMain = (() => {
  try {
    const meta = __normalizeMainPath(fileURLToPath(import.meta.url))
    const argv = __normalizeMainPath(process.argv[1] || '')
    return Boolean(meta) && meta === argv
  } catch {
    return false
  }
})()

await loadHandlers()

if (isMain) main()
