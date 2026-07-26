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
assert.match(workflow, /GH_REPO:\s*\$\{\{ github\.repository \}\}/)
assert.match(workflow, /pattern:\s*updater-meta-\*/)

// Incremental publishing. The release page is opened before the matrix runs and
// each leg uploads its own installer, so a download appears as soon as ITS
// platform is done rather than when the slowest one is, and a leg that fails
// costs only its own asset instead of withholding the entire release.
assert.match(workflow, /^\s{2}create-release:\s*\n\s+needs:\s*verify/m)
assert.match(workflow, /build:\s*\n\s+needs:\s*\[verify, create-release\]/)
// The matrix legs write to the release, so they need more than the read-only default.
assert.match(workflow, /timeout-minutes:\s*90\n\s*#[^\n]*\n\s*permissions:\s*\n\s+contents:\s*write/)
assert.match(workflow, /name:\s*Publish this platform's installer to the release/)
// Ordered before the updater metadata upload: a manifest entry must never point
// at an installer that failed to reach the page.
assert.ok(
  workflow.indexOf("name: Publish this platform's installer to the release")
    < workflow.indexOf('name: Upload updater metadata'),
  'the installer must be published before the updater metadata is uploaded',
)
// macOS runners still ship bash 3.2, where `shopt -s globstar` is not merely
// unsupported but fatal under `set -e` — "invalid shell option name", exit 1.
// It killed both mac arm64 legs of v3.1.54-pre.2 *after* they had finished
// building, and it is invisible on Linux and Windows (bash 4.4+), so the only
// thing that catches it is a rule. Collect installers with `find` instead.
// (The `**` patterns that remain are upload-artifact `path:` inputs, globbed by
// @actions/glob rather than by a shell.)
// Anchored to a line that STARTS with the command, for the same reason as the
// sccache assertions above: release.yml carries a comment explaining why this is
// banned, and that comment has to be allowed to name the thing it warns about.
assert.doesNotMatch(workflow, /^\s*shopt\s+-s\b[^\n]*globstar/m)
assert.match(workflow, /done < <\(find src-tauri\/target\/release\/bundle -type f/)
// A pipeline would run the loop body in a subshell and `published` would come
// back 0 on every leg, turning a successful upload into "no installer found".
assert.doesNotMatch(workflow, /find src-tauri\/target\/release\/bundle[^\n]*\|\s*while/)
// The whole point: manifests still get written when part of the matrix failed.
assert.match(workflow, /release:\s*\n\s+needs:\s*\[create-release, build\]\s*\n\s+if:\s*\$\{\{ always\(\) && needs\.create-release\.result == 'success' \}\}/)
assert.match(workflow, /bat-server-publish:\s*\n(?:\s*#[^\n]*\n)*\s+needs:\s*\[create-release, bat-server-build\]/)
// A .dmg-less release must not bump the Homebrew cask to a download that 404s.
assert.match(workflow, /steps\.legs\.outputs\.has_mac == 'true'/)
// Nor should a failed Linux leg stop the Windows installer reaching Chocolatey.
assert.match(workflow, /choco:\s*\n(?:\s*#[^\n]*\n)*\s+needs:\s*\[build, release\]\s*\n(?:\s*#[^\n]*\n)*\s+if:\s*\$\{\{ always\(\)/)
assert.match(workflow, /steps\.winartifact\.outcome == 'success'/)

// The optional self-hosted Windows leg. Windows is the release's critical path
// (7.1 min on v3.1.53 vs macOS's 4.6) and most of the gap is work a reused
// machine would not repeat, so the leg can be pointed at a self-hosted runner.
// Every assertion here is about that switch staying SAFE, because the runner is
// a machine CI cannot verify the state of.
//
// 1. Default is hosted. `runs-on` reads verify's decision, which falls back to
//    ["windows-latest"] whenever WIN_RUNNER_LABELS is unset — so all of this is
//    inert until someone opts in, and non-Windows legs keep using matrix.os.
assert.match(workflow, /runs-on:\s*\$\{\{ matrix\.platform == 'win' && fromJSON\(needs\.verify\.outputs\.win_labels\) \|\| matrix\.os \}\}/)
assert.match(workflow, /win_labels:\s*\$\{\{ steps\.win-runner\.outputs\.labels \}\}/)
assert.match(workflow, /hosted='\["windows-latest"\]'/)
// 2. Keeping the target dir is the entire point, so checkout must not be allowed
//    to `git clean -x` it away — and the replacement clean must exclude exactly
//    that one path and nothing else.
assert.match(workflow, /clean:\s*\$\{\{ runner\.environment == 'github-hosted' \}\}/)
assert.match(workflow, /git clean -ffdx -e src-tauri\/target/)
// 3. CARGO_INCREMENTAL is the payoff (196.9s -> 10.3-12.8s warm) and must stay
//    self-hosted-only: on a hosted runner rust-cache strips incremental/ before
//    saving, so generating it there is pure cost.
assert.match(workflow, /if:\s*env\.BUILD_MATRIX_ENTRY == 'true' && runner\.environment == 'self-hosted'\n\s+shell:\s*bash\n\s+run:\s*echo "CARGO_INCREMENTAL=1" >> "\$GITHUB_ENV"/)
// 4. No cache step may run on a self-hosted runner. Restoring is redundant there,
//    but SAVING would push 600-735 MB per leg into a 10 GB repo quota that is
//    already at the cap, evicting the macOS/Linux target dirs that keep those
//    legs at 9 minutes instead of 30. A self-hosted Windows leg must not buy its
//    own speed with everyone else's.
for (const step of ['Cache Cargo registry base', 'Cache Rust build outputs', 'Cache Tauri bundle tools']) {
  assert.match(
    workflow,
    new RegExp(`name: ${step}\\n\\s+if: env\\.BUILD_MATRIX_ENTRY == 'true' && runner\\.environment == 'github-hosted'`),
    `${step} must be gated to hosted runners so it cannot evict the other legs' caches`,
  )
}

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
