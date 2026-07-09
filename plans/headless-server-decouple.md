# Headless `bat-server` decouple — migration & risk assessment (#117)

Status: **landed** (decouple complete; shipped for both Linux arches). Tracking
GitHub issue
[#117](https://github.com/tony1223/better-agent-terminal/issues/117): the Linux
arm64 AppImage's `bat-server` links `libwebkit2gtk-4.1`, which requires
`GLIBC_2.35` / `GLIBCXX_3.4.30`; Oracle Linux 9 / RHEL 9 ship glibc 2.34, so it
fails to load **before `main()`**.

The webkit-free decouple is done (the headless build compiles tauri-free and
serves over `HostContext` — separation complete as of `8b66581`/`0e146cf`), and
the `bat-server` binary is now built **static-musl** so it carries no glibc
requirement at all (`d995379`); the bundle floor is the bundled Node runtime
(glibc ≥ 2.28). The release workflow's `bat-server-bundle` job is matrixed over
**`x86_64` and `aarch64`**, each on a native runner, so the ARM artifact #117
actually needs (`bat-server-linux-aarch64.tar.gz` / `bat-server-aarch64.AppImage`)
ships on every release. Sections below are retained as the migration record; the
"Done so far" table predates the final separation commits.

## 0. Motivation — why decouple (beyond #117)

#117 is a *symptom*, not the reason. The reason is architectural: the **core**
(remote server, sessions, PTY, sidecar bridge) is domain logic and **should not
depend on the GUI shell** (`tauri` → `wry` → `webkit2gtk`/GTK). Decoupling is a
stability win in its own right:

- **An entire class of GUI faults disappears from the server.** Everything we
  hit recently — the WebView2 paint-stall (white screen), the #112 libwayland
  skew, the #117 glibc skew — is webkit/GTK-layer fragility. A server that does
  not link that layer is immune to all of it, and can't be disturbed by the
  display stack while it is serving remote clients.
- **Truly headless:** no GTK init → no display/xvfb requirement. Runs in
  containers, plain servers, CI.
- **Smaller dependency / attack surface:** webkit2gtk + GTK + wry is a large C
  surface with its own CVEs and cross-distro version skew; not linking it means
  far fewer surprises, plus faster startup and lower memory.
- **Testability:** the `HostContext` seam lets the core be exercised without a
  `tauri` runtime or a display (the sidecar already does this via its
  `EventSink` closure — this generalises it to the whole server path).
- **The desktop build benefits too:** reaching host capabilities through a
  narrow seam instead of grabbing `AppHandle` everywhere makes the core cleaner
  and less sensitive to app-structure / tauri-version changes. **This work has
  value even if the EL9 build ever became moot.**

Consequence for **D4**: the EL9-container build of the *existing* binary is not
a substitute — it would ship #117 while leaving the GUI coupling and the whole
fragility class intact. The stability goal is what justifies the full decouple.

## 1. Goal & approach

Produce a **GUI-free, webkit-free `bat-server`** that runs on enterprise Linux
(glibc 2.34, no display server), without changing the desktop app.

- **Why a wrapper can't fix it:** webkit is an ELF `DT_NEEDED` dependency
  resolved by `ld.so` before any code runs. No runtime flag / env / LD trick
  cleanly avoids it. The only robust fix is **not linking webkit** → a build
  with `tauri`/`wry` excluded.
- **Two builds, one package:** same source, two `cargo` invocations —
  `better-agent-terminal` (desktop, default features, webkit) and `bat-server`
  (`--no-default-features --features headless`, no webkit). Both ship inside the
  one AppImage/exe; on EL9 you run the webkit-free `bat-server`.
- **Seam:** `tauri` is optional behind a default-on `desktop` feature. Every
  server-reachable function moves from `tauri::AppHandle` to
  `host_context::HostContext`. Desktop keeps an `AppHandle`-backed `HostContext`
  (behaviour identical); headless gets a tauri-free backing.

### Invariants

- **Desktop build stays green at every step** (`cargo check` / `pnpm run
  compile`). This is the only reliable per-step signal — see §2.
- All shipping builds keep `default = ["desktop"]`, so the desktop app and its
  bundled assets are byte-for-behaviour unchanged.

## 2. The headless error count is NOT a progress meter

`rustc` suppresses errors that cascade from a failed `use tauri`. Fixing one
import **reveals** previously-hidden errors in its callers (observed: fixing
`app_data` moved the visible total 425 → **460**, not a regression). So:

- The visible `cargo check --bin bat-server --no-default-features --features
  headless` count **wobbles upward** as imports get fixed and only collapses to
  0 at the very end. This is a **big-bang** migration for the headless build.
- **Track desktop-green, not the headless count.** The headless build flips from
  "many errors" to "compiles + links (verify no `libwebkit2gtk` via `readelf
  -d`)" only when the whole reachable graph is tauri-free.

## 3. Done so far (desktop green throughout)

| commit | content |
|---|---|
| `0bf4eca` | `HostContext` seam (AppHandle-backed), wired at sidecar fallthrough |
| `d9a4f38` | `tauri` optional behind `desktop`; `build.rs` gated; bins split (`bat-server` headless target) |
| `e04b83a` | headless entry stub; gated 10 desktop-only command modules |
| `0b67de6` | `agent`, `image` modules headless-compatible (playbook) |
| `0cfa903` | `sidecar` desktop-only helpers gated |
| `d3690c7` | `event_hub` desktop emit path gated, struct kept |
| `69038fb` | `app_data` tauri-free dir resolver |

## 4. `HostContext` API contract (derived from actual usage)

Capabilities the server-reachable code pulls off `AppHandle` (counts = call
sites in dispatch + reachable cores):

| capability | sites | desktop backing | headless backing |
|---|---|---|---|
| `app.state::<T>()` | ~49 | `app.state::<T>()` | field on `HeadlessHost` |
| `tauri::async_runtime::block_on` | 29 | tauri (tokio) | **shared executor (see Risk R4)** |
| `tauri::async_runtime::spawn_blocking` | 81 | tauri (tokio) | mostly inside desktop wrappers → gated; remainder via executor |
| `app.try_state::<T>()` | ~14 | `app.try_state` | `Option` field on `HeadlessHost` |
| `app.emit` / `app.emit_to` | ~8 | webview emit | no-op locally; `broadcast_event` to remote clients |
| `app.package_info().version` | ~5 | tauri | compile-time `env!("CARGO_PKG_VERSION")` |
| `app.path()` (resource/data dir) | ~2 | tauri | exe-relative / env (`app_data`, sidecar resolver) |
| `app.restart()` | 1 | tauri | desktop-only → gate / return error headless |

Proposed type:

```rust
#[cfg(feature = "desktop")]      pub struct HostContext { app: AppHandle }
#[cfg(not(feature = "desktop"))] pub struct HostContext { inner: Arc<HeadlessHost> }
```

with identical method surface (`state accessors`, `emit`, `data_dir`,
`sidecar_*`, `version`, `block_on`), so callers are backing-agnostic.

## 5. Migration inventory by module

Legend — **GATE**: wrapper-gate `#[tauri::command]` + AppHandle helpers behind
`desktop`, keep pure cores (validated on `agent`/`image`). **CORE**: a handful
of dispatch-reachable cores take `app` → migrate to `&HostContext`. **DEEP**:
structural / state-holding / dispatch.

| module | role | `#[command]` (GATE) | action | risk |
|---|---|---|---|---|
| `commands/claude.rs` | claude/codex session host | 64 | GATE + a few CORE (`fetch_auth_status_native`, `resolve_claude_cli_path`, `prepare_cli_session_native`) | **M** (largest surface) |
| `commands/fs.rs` | file ops + chunked upload | 15 | GATE + CORE (`fs_home_native`, `fs_list_dirs_native`, `fs_quick_locations_native`, watch/upload state) | **M** |
| `commands/snippet.rs` | snippets (state) | 10 | GATE + state struct headless | L |
| `commands/settings.rs` | settings load/save | 5 | GATE + CORE (`settings_*` take `app` for path) | L |
| `commands/pty.rs` | PTY sessions (state) | 10 | GATE + CORE (`resize/set_viewport*`, `pty_restart_native` take `app`) | **M** (terminal core) |
| `commands/app.rs` | version / window / relaunch | 12 | GATE; `app:new-window`/`relaunch` are GUI → headless stub/error | L |
| `commands/notification.rs` | session snapshot registry | 7 | GATE + CORE (snapshot getters take `app` → `AgentNotificationState`) | **M** (dispatch reads these) |
| `commands/worktree.rs` | git worktrees (state) | 6 | GATE + state | L |
| `commands/update.rs` | self-update | 5 | GATE; updater is desktop → headless stub/error | L |
| `commands/profile.rs` | profiles / workspace json | 13 | GATE + CORE (`profile_workspace_json_for_remote`) | L |
| `commands/worker_buffer.rs` | PTY scrollback (state) | 7 | GATE + state struct headless | L |
| `commands/git.rs` | local git porcelain | 7 | GATE (pure cores) | L |
| `commands/github.rs` | gh cli | 7 | GATE (pure cores) | L |
| `commands/agent.rs` | preset metadata | ✅ done | — | — |
| `commands/image.rs` | image read/save | ✅ done | — | — |
| `sidecar.rs` | node sidecar bridge | — | ✅ desktop helpers gated; **TODO headless `resolve_spawn_config` + emit sink** | **M** |
| `event_hub.rs` | renderer pub/sub | — | ✅ done (publish gated) | L |
| `app_data.rs` | data dir | — | ✅ done | L |
| `codex_app_server.rs` | codex app-server (state + subprocess) | — | DEEP: gate AppHandle methods, keep state + subprocess; `claude_usage`/`publish_runtime_event` refs gated | **M** |
| `window_registry.rs` | per-window/profile workspace persistence | — | CORE: dispatch uses `workspace_json`/`save_workspace_json`/`profile_id_for_window` with `app` → migrate to data-dir based | **M** |
| `remote_client.rs` | remote-profile client (desktop) | — | likely **fully desktop** → gate out of headless if not dispatch-reachable | L |
| `remote_server.rs` | **TCP/ws server + dispatch** | — | **DEEP (the heart):** `start(app)`→`start(ctx)`, `handle_client`/`invoke_*` `app`→`ctx` | **H** |
| `lib.rs` | entry | — | ✅ split; **TODO** real headless `run_headless_server` | **H** |

## 6. The hard parts (DEEP)

### 6.1 `remote_server.rs` dispatch (highest risk, ~35+ hidden)
`RustRemoteServerState::start(app)` spawns the accept thread and threads `app`
into `handle_client` → `invoke_sidecar_for_remote` → `invoke_rust_for_remote`.
Migrate the whole chain `app: AppHandle` → `ctx: HostContext`, replacing
`app.state` → `ctx.<state>()`, `app.emit_to` → `ctx.emit_to`,
`app.package_info` → `ctx.version()`, `app.restart` → desktop-gated. The struct
itself (TCP listener, threads, `broadcast_event`) is tauri-free.

### 6.2 `HeadlessHost` + `HostContext` headless backing
Plain `Arc` registry holding the states the dispatch needs (`SidecarState`,
`RustRemoteServerState`, `CodexAppServerState`, `PtyState`, `WorkerBufferState`,
`FsWatcherState`, `FsUploadState`, `AgentNotificationState`,
`WindowRegistryState`, …) + `data_dir` + an emit sink that calls
`broadcast_event`. Constructed once in the headless `run_headless_server`.
Circularity (HeadlessHost holds `RustRemoteServerState`, and `start(ctx)` takes
the ctx that holds it) is resolved with `Arc` sharing.

### 6.3 Real headless `run_headless_server` (replaces today's stub)
Parse args (done, tauri-free) → set data-dir env → build the states → build
`HeadlessHost`/`HostContext` → `remote_server.start(ctx, options)` → park the
thread. No `tauri::Builder`, no GTK, no display.

### 6.4 Sidecar headless resolver
Tauri-free `resolve_spawn_config`: node from PATH/managed/`current_exe`-relative
bundle; script from `BAT_SIDECAR_SCRIPT` / exe-relative resources / cwd (reuse
the kept `which_node`/`find_sidecar_script`/`choose_node_path`). Emit sink that
broadcasts to `RustRemoteServerState`.

## 7. Risk register

| id | risk | likelihood | impact | mitigation |
|---|---|---|---|---|
| **R1** | Desktop regression from mis-gating | med | **high** | Desktop `cargo check` + `pnpm run compile` after every step; CI gate is the default-feature build, so any break is caught |
| **R2** | Behaviour drift: headless does something desktop did differently (e.g. emit no-op, missing window registry) | med | med | Headless emit → `broadcast_event` only (correct for remote); functions that are inherently GUI (`new-window`, `relaunch`, dialogs) return a clear error headless |
| **R3** | Webkit-free binary still pulls `GLIBC_2.35` from its own deps if built on Ubuntu 22.04 | med | high | `readelf -d` / `objdump -T \| grep GLIBC_2.3[5-9]`; if any, build just `bat-server` on an older/EL9 base (cheap — no webkit) |
| **R4** | `tauri::async_runtime` (29 `block_on` + 81 `spawn_blocking`) unavailable headless | high | med | Most `spawn_blocking` live in desktop wrappers (gated). For the dispatch's `block_on`, add a tiny shared executor module (tokio is already in the dep graph; or `futures::executor::block_on`). Single seam. |
| **R5** | `codex_app_server` deeper coupling than visible (suppressed errors) | med | med | Migrate after `remote_server` so its real surface is visible; it already uses `std::process` (no GUI) |
| **R6** | Headless server never had a display-less runtime path before; untested | high | med | The 2–3 day test window; smoke: start `bat-server`, connect a remote client, run a claude + codex turn |
| **R7** | Packaging: bundling the webkit-free `bat-server` into the AppImage (vs the default-built one) | low | med | CI builds `bat-server` headless separately, overwrites `usr/bin/bat-server` in the bundle; verify with `readelf` in CI |
| **R8** | Count-not-a-meter creates false "stuck" impression | high | low | Documented (§2); rely on desktop-green + module checklist |

## 8. Verification plan

- **Per step:** `cargo check` (desktop, default) must be green; `pnpm run
  compile` for renderer-affecting changes (none expected here).
- **Headless build milestone:** `cargo check --bin bat-server
  --no-default-features --features headless` → 0 errors, then `cargo build`
  same flags links successfully.
- **No-webkit proof (Linux/CI):** `readelf -d target/.../bat-server | grep -i
  webkit` → empty; `objdump -T | grep 'GLIBC_2.3[5-9]'` → empty (or rebuild on
  older base per R3).
- **Runtime smoke (the 2–3 day window):** launch `bat-server --bind ...`,
  connect a remote client (desktop or BATMobile), start a Claude SDK turn and a
  Codex turn, exercise PTY + file upload.
- **No-regression on desktop:** existing `verify:tauri-pre-ci` gate unchanged.

## 9. Execution order (each lands desktop-green; headless flips at the end)

1. **Foundational states** → headless-compile: `codex_app_server`,
   `window_registry`, `remote_client` (or gate out), `codex_auth`. *(app_data,
   event_hub, sidecar-partial done.)*
2. **Executor seam** (R4): `crate::async_rt::{block_on, spawn_blocking}`.
3. **Command modules** → GATE pass: git, github, worker_buffer, snippet,
   settings, profile, app, update, worktree, notification, pty, fs, claude
   (+ migrate the handful of `app`-taking cores to `&HostContext`).
4. **`remote_server` dispatch** `app`→`ctx` (6.1) — the heart.
5. **`HostContext` headless backing + `HeadlessHost`** (6.2).
6. **Real `run_headless_server`** (6.3) + **sidecar headless resolver** (6.4).
7. **First green headless build** → `readelf` no-webkit proof.
8. **CI**: add the headless `cargo build` leg (same job, warm cache — cheap) and
   bundle `bat-server` into the AppImage; reply to #117.

## 10. Open decisions

- **D1 — packaging:** bundle the webkit-free `bat-server` *inside* the AppImage
  (user's preference, one package), vs. ship a separate `bat-server-linux-arm64`
  tarball. Inventory assumes the former; CI step differs only slightly.
- **D2 — build base for the headless bin** (R3): default to the existing
  Ubuntu-22.04-arm runner and rely on `readelf` proof; only move `bat-server` to
  an EL9 container if residual `GLIBC_2.35` symbols appear.
- **D3 — headless `app:new-window` / `relaunch` / dialogs:** return a structured
  "unsupported in headless" error vs. silently no-op. Proposed: explicit error.
- **D4 — scope:** finish the full decouple (this doc) vs. ship the EL9-container
  build of the *existing* binary as an interim unblock for #117. Currently
  committed to the full decouple.
