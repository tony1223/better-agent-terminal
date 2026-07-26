import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareTauriBundleMode } from '../scripts/prepare-tauri-bundle-mode.mjs'

const [cargo, buildScript, lib, main, serverMain, update, config, packageJson, markerScript, modeBuildScript, workflow] = await Promise.all([
  readFile('src-tauri/Cargo.toml', 'utf8'),
  readFile('src-tauri/build.rs', 'utf8'),
  readFile('src-tauri/src/lib.rs', 'utf8'),
  readFile('src-tauri/src/main.rs', 'utf8'),
  readFile('src-tauri/src/bin/bat-server.rs', 'utf8'),
  readFile('src-tauri/src/commands/update.rs', 'utf8'),
  readFile('src-tauri/tauri.conf.json', 'utf8'),
  readFile('package.json', 'utf8'),
  readFile('scripts/prepare-tauri-bundle-mode.mjs', 'utf8'),
  readFile('scripts/tauri-build-mode.mjs', 'utf8'),
  readFile('.github/workflows/release.yml', 'utf8'),
])

assert.match(cargo, /crate-type\s*=\s*\["rlib"\]/)
assert.doesNotMatch(cargo, /crate-type\s*=.*(?:staticlib|cdylib)/)

assert.doesNotMatch(buildScript, /BAT_BUNDLE_MODE/)
assert.doesNotMatch(lib, /generate_context!\(\)/)
assert.match(main, /run\(tauri::generate_context!\(\)\)/)
assert.match(serverMain, /run_headless_server_cli\(\s*tauri::generate_context!\(\)/)
assert.match(update, /read_to_string\(dir\.join\("bundle-mode\.txt"\)\)/)
assert.equal(JSON.parse(config).bundle.resources['target/bundle-mode.txt'], 'bundle-mode.txt')
assert.match(packageJson, /prepare-tauri-bundle-mode\.mjs --mode=all-in-one/)
assert.match(packageJson, /prepare-tauri-bundle-mode\.mjs --mode=lightweight/)
assert.match(markerScript, /writeFile\(marker, `\$\{mode\}\\n`\)/)
assert.match(modeBuildScript, /await prepareTauriBundleMode\(args\.mode\)/)

// sccache is deliberately absent. It measured 0 hits / 1 miss in all 11 build
// jobs of v3.1.53 — rust-cache already restores every dependency, so the only
// remaining compile is our own crate, which changes every commit. What it did
// do was write 823 GHA cache entries (~1 GB) against a 10 GB repo quota that
// was already full, evicting the 600-735 MB rust-cache target dirs that keep a
// release at 9 minutes instead of 30. Assert it stays gone.
// Matched against usage, not prose: release.yml carries a comment explaining
// the removal, and that comment has to be allowed to name the thing it warns
// about.
assert.doesNotMatch(workflow, /uses:\s*mozilla-actions\/sccache-action/)
assert.doesNotMatch(workflow, /RUSTC_WRAPPER:/)
assert.doesNotMatch(workflow, /SCCACHE_GHA_ENABLED:/)
assert.match(workflow, /shared-key:\s*bat-server-\$\{\{ matrix\.bundle_target \}\}/)
assert.match(workflow, /CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS:\s*\$\{\{ matrix\.aarch64_rustflags \}\}/)
assert.match(workflow, /aarch64_rustflags:\s*'-C link-arg=-lgcc'/)
assert.doesNotMatch(workflow, /name:\s*Cache (?:root|sidecar) node_modules/)
assert.match(workflow, /bat-server-build:\s*\n\s+needs:\s*verify/)
assert.match(workflow, /bat-server-publish:\s*\n\s+needs:\s*\[release, bat-server-build\]/)
assert.match(workflow, /GH_REPO:\s*\$\{\{ github\.repository \}\}/)
assert.match(workflow, /pattern:\s*release-\*/)
assert.match(workflow, /pattern:\s*updater-meta-\*/)

const root = await mkdtemp(join(tmpdir(), 'bat-bundle-mode-test-'))
try {
  const marker = await prepareTauriBundleMode('lightweight', { root })
  assert.equal(await readFile(marker, 'utf8'), 'lightweight\n')
  await prepareTauriBundleMode('all-in-one', { root })
  assert.equal(await readFile(marker, 'utf8'), 'all-in-one\n')
  await assert.rejects(prepareTauriBundleMode('unknown', { root }), /unsupported Tauri bundle mode/)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('Tauri compile cache contract: passed')
