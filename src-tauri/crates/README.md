# Rust core crates

These libraries own the reusable runtime and storage code. The application in
`src-tauri/src` supplies Tauri commands, resource/data directories, windows,
remote routing, and event publication through the existing host API.

| Crate | Responsibility |
| --- | --- |
| `bat-host-support` | Path guards, secret storage, logging, subprocess and platform helpers |
| `bat-accounts` | Claude and Codex account persistence |
| `bat-git` | Git command parsing and worktree operations |
| `bat-remote-protocol` | Remote protocol rules and session replay |
| `bat-runtime` | Runtime catalog and installation |
| `bat-app-storage` | Settings, snippets, profile and window/workspace snapshots, latency metrics |
| `bat-agent-bridge` | Node process lifecycle, JSON-RPC requests and event callbacks |
| `bat-filesystem` | File operations, search, transfers and bounded directory watchers |
| `bat-pty` | PTY lifecycle, IO, viewport and worker scrollback/Procfile processes |

Keep these crates independent of Tauri and application session/window state.
The host owns each store, watcher, or bridge state and supplies paths or event
callbacks. Existing command adapters re-export shared types so desktop and
headless consumers continue to use the same IPC contracts and data formats.

`bat-pty` receives a data directory and a callback carrying the target window,
event channel and JSON payload. The host retains remote routing and supplies
the shared PTY/worker state. Window snapshots live in `bat-app-storage`; the
desktop registry retains live-window operations and passes file paths to the
snapshot persistence functions.

CI uses `scripts/stable-rust-crates-cache.mjs` to verify each crate's sources
and its transitive workspace dependencies before normalizing source timestamps.
A change invalidates that crate and its consumers; unrelated crates keep their
artifacts. Cargo metadata supplies the dependency graph, including optional and
platform-specific path dependencies. The runtime catalog is an additional
input for `bat-runtime`.

When adding a core crate, register it in `STABLE_CRATES` and account for any
compile-time inputs outside its `.rs` files and manifest. The cache test builds
a real Cargo fixture to verify reuse, dependency edits, retries, and rollbacks.
Old or incomplete cache state requires one full core-crate rebuild. Record new
cache state only after a successful build.
