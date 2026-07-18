#!/usr/bin/env bash
set -euo pipefail

ROOTS=("$@")
if [[ ${#ROOTS[@]} -eq 0 ]]; then
  ROOTS=("node-sidecar/dist-node_modules" "codex-runtime")
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[sign-macos-resource-binaries] skipped: not running on macOS"
  exit 0
fi

: "${APPLE_CERTIFICATE:?APPLE_CERTIFICATE is required}"
: "${APPLE_CERTIFICATE_PASSWORD:?APPLE_CERTIFICATE_PASSWORD is required}"

for root in "${ROOTS[@]}"; do
  if [[ ! -d "$root" ]]; then
    echo "[sign-macos-resource-binaries] missing resource root: $root" >&2
    exit 1
  fi
done

RUNNER_TEMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
CERTIFICATE_PATH="$RUNNER_TEMP/bat-macos-resource-signing.p12"
KEYCHAIN_PATH="$RUNNER_TEMP/bat-macos-resource-signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"

cleanup() {
  security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  rm -f "$CERTIFICATE_PATH"
}
trap cleanup EXIT

if ! printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$CERTIFICATE_PATH" 2>/dev/null; then
  printf '%s' "$APPLE_CERTIFICATE" | base64 -D > "$CERTIFICATE_PATH"
fi

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" >/dev/null
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH" >/dev/null
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" >/dev/null
security import "$CERTIFICATE_PATH" \
  -k "$KEYCHAIN_PATH" \
  -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign >/dev/null

EXISTING_KEYCHAINS="$(security list-keychains -d user | tr -d '"')"
security list-keychains -d user -s "$KEYCHAIN_PATH" $EXISTING_KEYCHAINS >/dev/null
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$KEYCHAIN_PASSWORD" \
  "$KEYCHAIN_PATH" >/dev/null

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(
    security find-identity -v -p codesigning "$KEYCHAIN_PATH" \
      | awk -F '"' '/Developer ID Application/ { print $2; exit }'
  )"
fi

if [[ -z "$IDENTITY" ]]; then
  echo "[sign-macos-resource-binaries] no Developer ID Application identity found" >&2
  security find-identity -v -p codesigning "$KEYCHAIN_PATH" >&2 || true
  exit 1
fi

# Binaries embedding a JS engine (V8 / JavaScriptCore) allocate JIT (MAP_JIT)
# memory. Under the hardened runtime this requires the allow-jit entitlements
# (matching how OpenAI and Anthropic sign their own distributions of these
# binaries). Without them:
#   - codex-code-mode-host (V8) aborts at startup with FatalProcessOutOfMemory,
#     so every Codex tool call fails with "code-mode host closed its stdout".
#   - the bundled claude binary (Bun/JSC) silently disables JIT-dependent
#     features; SharedArrayBuffer disappears and Claude Code sessions crash
#     with "ReferenceError: SharedArrayBuffer is not defined".
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JIT_ENTITLEMENTS="$SCRIPT_DIR/../build/entitlements.jit.plist"

needs_jit_entitlements() {
  case "$(basename "$1")" in
    codex-code-mode-host|claude) return 0 ;;
    *) return 1 ;;
  esac
}

count=0
jit_signed=()
for root in "${ROOTS[@]}"; do
  while IFS= read -r -d '' file_path; do
    if file "$file_path" | grep -q 'Mach-O'; then
      if needs_jit_entitlements "$file_path"; then
        codesign --force --timestamp --options runtime \
          --entitlements "$JIT_ENTITLEMENTS" --sign "$IDENTITY" "$file_path"
        jit_signed+=("$file_path")
      else
        codesign --force --timestamp --options runtime --sign "$IDENTITY" "$file_path"
      fi
      count=$((count + 1))
    fi
  done < <(find "$root" -type f -perm -111 -print0)
done

# Post-condition: JS-engine binaries must carry allow-jit after signing, or the
# packaged app ships broken Codex/Claude agents (see needs_jit_entitlements).
for file_path in ${jit_signed[@]+"${jit_signed[@]}"}; do
  if ! codesign -d --entitlements - "$file_path" 2>/dev/null \
      | grep -q 'com.apple.security.cs.allow-jit'; then
    echo "[sign-macos-resource-binaries] $file_path is missing allow-jit after signing" >&2
    exit 1
  fi
done

echo "[sign-macos-resource-binaries] signed $count Mach-O resource file(s) (${#jit_signed[@]} with JIT entitlements)"
