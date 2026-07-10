#!/usr/bin/env node
// Assemble a self-contained, install-and-go Linux release for the headless
// `bat-server` binary, mirroring the desktop all-in-one AppImage: the same
// node-sidecar + portable Node runtime + native claude-agent-sdk (+ optional
// codex runtime), laid out *exe-relative* so the headless resolver finds
// everything with zero manual provisioning.
//
//   bat-server                                  (the tauri-free binary)
//   node-sidecar/dist/server.mjs                (find_sidecar_script)
//   node-sidecar/package.json
//   node-sidecar/node_modules/@anthropic-ai/…   (native SDK + bundled claude)
//   node-runtime/<target>/bin/node              (find_bundled_node)
//   codex-runtime/bin/codex, codex-runtime/…    (optional; npm package layout)
//   AppRun                                       (AppImage launcher)
//   install.sh                                   (tarball installer -> systemd)
//
// Inputs (must be prepared first, ON LINUX, via `pnpm run prepare:tauri-bundle:*`
// so the node_modules / node runtime are Linux-native):
//   node-sidecar/dist/server.mjs, node-sidecar/package.json,
//   node-sidecar/dist-node_modules/, node-sidecar/runtime/<target>/,
//   codex-runtime/ (optional)
//
// Emits into <out>/:
//   bat-server-<target>.tar.gz   (the tree + install.sh)
//   bat-server-<target>.AppImage (when --appimage and appimagetool resolves)
//
// Usage:
//   node scripts/build-bat-server-bundle.mjs \
//     --bin src-tauri/target/x86_64-unknown-linux-musl/release/bat-server \
//     --target linux-x86_64 [--appimage] [--out dist-bat-server]

import { mkdir, rm, cp, writeFile, chmod, access, stat, readdir } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

// Rust-style arch names, matching node-sidecar/runtime/<target> and the Rust
// resolver's `<plat>-<arch>` (std::env::consts::ARCH). bat-server is built
// static-musl so one binary runs on any Linux regardless of glibc age; the
// bundle's glibc floor comes from the official Node runtime (>= 2.28).
const TARGETS = {
  'linux-x86_64': { rustTriple: 'x86_64-unknown-linux-musl', appImageArch: 'x86_64' },
  'linux-aarch64': { rustTriple: 'aarch64-unknown-linux-musl', appImageArch: 'aarch64' },
}

function parseArgs(argv) {
  const out = { bin: null, target: 'linux-x86_64', outDir: join(repoRoot, 'dist-bat-server'), appimage: false }
  for (const a of argv) {
    if (a === '--appimage') out.appimage = true
    else if (a.startsWith('--bin=')) out.bin = a.slice('--bin='.length)
    else if (a === '--bin') out._wantBin = true
    else if (a.startsWith('--target=')) out.target = a.slice('--target='.length)
    else if (a.startsWith('--out=')) out.outDir = resolve(a.slice('--out='.length))
    else if (out._wantBin) { out.bin = a; out._wantBin = false }
    else if (out._wantTarget) { out.target = a; out._wantTarget = false }
    else if (out._wantOut) { out.outDir = resolve(a); out._wantOut = false }
    else if (a === '--target') out._wantTarget = true
    else if (a === '--out') out._wantOut = true
  }
  return out
}

async function exists(p) {
  try { await access(p, FS.F_OK); return true } catch { return false }
}

async function requirePath(p, what) {
  if (!(await exists(p))) {
    throw new Error(
      `missing ${what}: ${p}\n` +
      `  Run the bundle prep first, ON LINUX, so deps are Linux-native:\n` +
      `    pnpm run prepare:tauri-bundle:all-in-one`,
    )
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status ?? r.signal}`)
  }
}

const APPRUN = `#!/bin/sh
# AppImage launcher for the headless bat-server. Resources live next to this
# binary inside the mounted AppDir, so the resolver finds them exe-relative.
HERE="$(dirname "$(readlink -f "$0")")"
cd "$HERE" || exit 1
# Single-purpose server box: let Claude Code's bypassPermissions run as root
# (same escape hatch the SDK documents for containers/CI). Honor an explicit
# override if the operator set one.
if [ "$(id -u)" = "0" ]; then
  export IS_SANDBOX="\${IS_SANDBOX:-1}"
fi
exec "$HERE/bat-server" "$@"
`

const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=bat-server
Exec=bat-server
Icon=bat-server
Categories=Development;
Terminal=true
Comment=Better Agent Terminal headless server
`

export function installScript(target) {
  return `#!/usr/bin/env bash
# Install the self-contained bat-server bundle as a systemd service.
# Re-runnable: regenerates the unit and preserves an existing credential.
set -euo pipefail

PREFIX="\${PREFIX:-/opt/bat-server}"
DATA_DIR="\${BAT_DATA_DIR:-/root/.bat-server}"
PORT="\${BAT_PORT:-9876}"
BIND="\${BAT_BIND:-localhost}"
TOKEN_FILE="\${BAT_TOKEN_FILE:-/etc/bat-server/credentials/token}"
# systemd does not export HOME for system services, but the Rust host resolves
# the Codex/Claude home (~/.codex, ~/.claude) from \$HOME. Without it, Codex
# fails with "could not resolve shared Codex home". Default to the installing
# user's home, falling back to root's.
HOME_DIR="\${BAT_HOME:-\${HOME:-/root}}"
UNIT=/etc/systemd/system/bat-server.service

SRC="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

# BAT_TOKEN remains supported for existing automation, but new installs keep
# the value in an owner-only credential file. Existing units are migrated
# without rotating the token so connected clients remain compatible.
if [ -n "\${BAT_TOKEN:-}" ]; then
  echo >&2 "[bat-server] warning: BAT_TOKEN is supported for compatibility; prefer BAT_TOKEN_FILE or the managed systemd credential"
  TOKEN="$BAT_TOKEN"
elif [ -s "$TOKEN_FILE" ]; then
  TOKEN="$(head -n1 "$TOKEN_FILE")"
elif [ -f "$UNIT" ]; then
  TOKEN="$(sed -nE 's/.*--token(=|[[:space:]]+)([^[:space:]]+).*/\\2/p' "$UNIT" | head -n1 || true)"
  if [ -n "$TOKEN" ]; then
    echo >&2 "[bat-server] warning: migrating the legacy inline token to an owner-only credential file"
  fi
else
  TOKEN=""
fi
[ -n "$TOKEN" ] || TOKEN="$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \\n')"

TOKEN_DIR="$(dirname "$TOKEN_FILE")"
install -d -m 0700 "$TOKEN_DIR"
TOKEN_TMP="$(mktemp "$TOKEN_DIR/.token.XXXXXX")"
trap 'rm -f "$TOKEN_TMP"' EXIT
printf '%s\\n' "$TOKEN" > "$TOKEN_TMP"
chmod 0600 "$TOKEN_TMP"
mv -f "$TOKEN_TMP" "$TOKEN_FILE"
trap - EXIT

# LoadCredential is preferred on systemd 247+. Older distributions retain a
# safe, compatible fallback that passes only the owner-only file path.
SYSTEMD_VERSION="$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
TOKEN_SOURCE_DIRECTIVE="Environment=BAT_TOKEN_FILE=$TOKEN_FILE"
if [[ "$SYSTEMD_VERSION" =~ ^[0-9]+$ ]] && [ "$SYSTEMD_VERSION" -ge 247 ]; then
  TOKEN_SOURCE_DIRECTIVE="LoadCredential=bat-server-token:$TOKEN_FILE"
else
  echo >&2 "[bat-server] warning: systemd credentials are unavailable; using the owner-only token file fallback"
fi

echo "[bat-server] installing to $PREFIX"
mkdir -p "$PREFIX" "$DATA_DIR"
# Upgrades over a previous install: stop the running service first so cp can
# overwrite the live binary (otherwise: "Text file busy"). It is started
# again by "systemctl enable --now" below.
if systemctl is-active --quiet bat-server.service 2>/dev/null; then
  echo "[bat-server] stopping running service for upgrade"
  systemctl stop bat-server.service
fi
# Copy the whole bundle tree (binary + node-sidecar + node-runtime + codex-runtime).
cp -a "$SRC"/. "$PREFIX"/
chmod +x "$PREFIX/bat-server"

cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Better Agent Terminal headless server (bat-server)
After=network.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
Environment=IS_SANDBOX=1
Environment=HOME=$HOME_DIR
$TOKEN_SOURCE_DIRECTIVE
UMask=0077
ExecStart=$PREFIX/bat-server --bind=$BIND --port=$PORT --data-dir=$DATA_DIR
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl enable --now bat-server.service
sleep 1
systemctl is-active bat-server.service >/dev/null && echo "[bat-server] active" || { journalctl -u bat-server.service -n 20 --no-pager; exit 1; }

echo
echo "  bind:  $BIND"
echo "  port:  $PORT"
echo "  token: $TOKEN"
echo "  token-file: $TOKEN_FILE"
echo "  data:  $DATA_DIR"
echo
echo "If bound to localhost, tunnel from your client:"
echo "  ssh -N -L $PORT:127.0.0.1:$PORT root@<this-host>"
echo "then connect to wss://127.0.0.1:$PORT (token above)."
`
}

const README = `# bat-server self-contained Linux bundle

Everything needed to run the Better Agent Terminal headless server is in this
directory (binary + Node runtime + node-sidecar + native Claude SDK). No system
node/claude/pnpm required.

## Install as a systemd service (recommended)

    sudo ./install.sh

The installer keeps the token in /etc/bat-server/credentials/token with mode
0600 and uses a systemd credential when supported. Set BAT_TOKEN_FILE to choose
another owner-restricted path. PREFIX, BAT_PORT, BAT_BIND, BAT_DATA_DIR, and
BAT_HOME remain available as install-time overrides.

BAT_TOKEN is retained for compatibility and is migrated into the credential
file; using it prints a warning.

## Or run directly

    mkdir -p ~/.config/better-agent-terminal
    (umask 077; head -c32 /dev/urandom | od -An -tx1 | tr -d ' \\n' > ~/.config/better-agent-terminal/bat-server-token)
    cd "$(dirname "$0")" && IS_SANDBOX=1 ./bat-server --bind=localhost --port=9876 --token-file=~/.config/better-agent-terminal/bat-server-token --data-dir=~/.bat-server

The working directory must be this bundle root so the bundled claude/node/sidecar
resolve exe-relative.

## Notes
- IS_SANDBOX=1 lets Claude Code's bypassPermissions run as root on this
  single-purpose box (the SDK's documented container/CI escape hatch).
- Claude/Codex still need credentials (logged-in CLI or API key) on first use.
- --token and BAT_TOKEN remain supported for older automation but emit a
  warning; prefer --token-file, BAT_TOKEN_FILE, or the systemd installer.
`

async function buildAppImage(appDir, outFile, appImageArch) {
  // appimagetool is itself an AppImage; on CI/containers without FUSE it must
  // run via extract-and-run. Prefer a PATH tool, else skip with a clear note.
  const tool = process.env.APPIMAGETOOL || 'appimagetool'
  const probe = spawnSync(tool, ['--version'], { stdio: 'ignore' })
  if (probe.status !== 0 && probe.error) {
    console.warn(`[bat-server] appimagetool not found (${tool}); skipping AppImage. ` +
      `Set APPIMAGETOOL=/path/to/appimagetool to enable.`)
    return false
  }
  run(tool, [appDir, outFile], {
    env: { ...process.env, ARCH: appImageArch, APPIMAGE_EXTRACT_AND_RUN: '1' },
  })
  return true
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const targetSpec = TARGETS[args.target]
  if (!targetSpec) {
    throw new Error(`unknown --target ${args.target}; known: ${Object.keys(TARGETS).join(', ')}`)
  }
  const binPath = args.bin
    ? resolve(args.bin)
    : join(repoRoot, 'src-tauri', 'target', targetSpec.rustTriple, 'release', 'bat-server')

  // Resolve and validate inputs.
  const sidecarDist = join(repoRoot, 'node-sidecar', 'dist', 'server.mjs')
  const sidecarPkg = join(repoRoot, 'node-sidecar', 'package.json')
  const sidecarNodeModules = join(repoRoot, 'node-sidecar', 'dist-node_modules')
  const nodeRuntime = join(repoRoot, 'node-sidecar', 'runtime', args.target)
  const codexRuntime = join(repoRoot, 'codex-runtime')

  await requirePath(binPath, 'bat-server binary (--bin)')
  await requirePath(sidecarDist, 'node-sidecar/dist/server.mjs (build:tauri-sidecar)')
  await requirePath(sidecarPkg, 'node-sidecar/package.json')
  await requirePath(sidecarNodeModules, 'node-sidecar/dist-node_modules (prepare:tauri-sidecar-node-modules)')
  await requirePath(join(nodeRuntime, 'bin', 'node'), `node-runtime for ${args.target} (fetch-node-runtime --target=${args.target})`)
  const haveCodex = await exists(codexRuntime)

  // Assemble the AppDir.
  const appDir = join(args.outDir, `bat-server-${args.target}.AppDir`)
  await rm(appDir, { recursive: true, force: true })
  await mkdir(appDir, { recursive: true })

  console.log(`[bat-server] assembling ${appDir}`)
  await cp(binPath, join(appDir, 'bat-server'))
  await chmod(join(appDir, 'bat-server'), 0o755)

  await mkdir(join(appDir, 'node-sidecar', 'dist'), { recursive: true })
  await cp(sidecarDist, join(appDir, 'node-sidecar', 'dist', 'server.mjs'))
  await cp(sidecarPkg, join(appDir, 'node-sidecar', 'package.json'))
  await cp(sidecarNodeModules, join(appDir, 'node-sidecar', 'node_modules'), { recursive: true })

  // node-runtime/<target>/bin/node — exactly where find_bundled_node probes.
  await mkdir(join(appDir, 'node-runtime'), { recursive: true })
  await cp(nodeRuntime, join(appDir, 'node-runtime', args.target), { recursive: true })

  if (haveCodex) {
    await cp(codexRuntime, join(appDir, 'codex-runtime'), { recursive: true })
  } else {
    console.warn('[bat-server] codex-runtime/ absent — bundle is Claude-only (run prepare:tauri-codex-runtime to include it)')
  }

  // Launcher + installer + AppImage metadata.
  await writeFile(join(appDir, 'AppRun'), APPRUN); await chmod(join(appDir, 'AppRun'), 0o755)
  await writeFile(join(appDir, 'install.sh'), installScript(args.target)); await chmod(join(appDir, 'install.sh'), 0o755)
  await writeFile(join(appDir, 'README.md'), README)
  await writeFile(join(appDir, 'bat-server.desktop'), DESKTOP_ENTRY)
  // Minimal 1x1 PNG icon so appimagetool is satisfied.
  await writeFile(join(appDir, 'bat-server.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYAAAB1l0gQAAAAAElFTkSuQmCC',
    'base64'))

  // tar.gz of the assembled tree (renamed from .AppDir to a clean dir name).
  const stageName = `bat-server-${args.target}`
  const stageDir = join(args.outDir, stageName)
  await rm(stageDir, { recursive: true, force: true })
  await cp(appDir, stageDir, { recursive: true })
  const tarball = join(args.outDir, `${stageName}.tar.gz`)
  console.log(`[bat-server] writing ${tarball}`)
  run('tar', ['-C', args.outDir, '-czf', tarball, stageName])

  let appImageOut = null
  if (args.appimage) {
    appImageOut = join(args.outDir, `bat-server-${targetSpec.appImageArch}.AppImage`)
    const ok = await buildAppImage(appDir, appImageOut, targetSpec.appImageArch)
    if (!ok) appImageOut = null
  }

  // Report sizes.
  const sz = async (p) => (await exists(p)) ? `${(((await stat(p)).size) / 1048576).toFixed(1)} MB` : 'n/a'
  console.log('\n[bat-server] done:')
  console.log(`  tarball:  ${tarball}  (${await sz(tarball)})`)
  if (appImageOut) console.log(`  AppImage: ${appImageOut}  (${await sz(appImageOut)})`)
  console.log(`  staged:   ${stageDir}`)
  console.log(`  codex:    ${haveCodex ? 'included' : 'NOT included (Claude-only)'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[bat-server] ${err.message}`)
    process.exit(1)
  })
}
