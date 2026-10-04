# Remote WebSocket Protocol V2

Last updated: 2026-06-10

This document records the intended Better Agent Terminal remote WebSocket v2 protocol.

Implementation entry points:

- Server: `src-tauri/src/remote_server.rs`
- Client: `src-tauri/src/remote_client.rs`
- Shared protocol helpers: `src-tauri/crates/bat-remote-protocol/src/remote_core.rs`

## Transport

- Scheme: `wss://`
- Default port: `9876`
- Server TLS: self-signed certificate generated and persisted by the host.
- Client TLS validation: certificate fingerprint pinning.
- Frame encoding: one JSON object per WebSocket message. Uncompressed connections use text frames. Compressed connections use BAT gzip binary frames after authentication.

The client accepts the self-signed certificate only after comparing the server certificate SHA-256 fingerprint with the fingerprint stored in the remote profile or connection URL.

## Connection URL

Copy/paste URL format:

```text
wss://<host>:<port>?token=<token>&fp=<sha256-fingerprint>
```

Rules:

- `host`, `token`, and `fp` are required.
- `port` defaults to `9876` when omitted by UI parser code.
- `fp` is the SHA-256 fingerprint of the server TLS certificate.
- UI output formats the fingerprint as colon-separated uppercase hex.

## Server Persistence

The remote server persists:

- Token: `<app-data>/server-token.enc.json`
- TLS certificate and private key: `<app-data>/server-cert.enc.json`

If persisted token or certificate data cannot be read, the server generates a replacement.

## Protocol Identifier

V2 protocol id:

```text
bat-remote/v2
```

New clients should send this in the auth frame:

```json
{
  "type": "auth",
  "id": "1700000000000-auth",
  "token": "<server-token>",
  "protocols": ["bat-remote/v2"],
  "compression": ["gzip"],
  "args": ["Client Label", { "windowId": "optional-window-id" }]
}
```

Server success response:

```json
{
  "type": "auth-result",
  "id": "1700000000000-auth",
  "result": true,
  "protocol": "bat-remote/v2",
  "compression": "gzip"
}
```

Server error response:

```json
{
  "type": "auth-result",
  "id": "1700000000000-auth",
  "error": "Invalid token"
}
```

Rules:

- `token` must exactly match the server token.
- `protocols` must include `bat-remote/v2`.
- `compression` is optional. Omitted or unsupported values mean `none`.
- New BAT clients should advertise `["gzip"]`. Legacy clients do not advertise compression and remain fully uncompressed.
- `auth` and `auth-result` are always uncompressed text frames. After a successful `compression: "gzip"` auth result, every following BAT frame on that connection is sent as a gzip binary frame. There is no per-message threshold.
- `args[0]` is the client label displayed in server status.
- `args[1].windowId` is optional and recorded in the server connected-client list when present.

## Compression

Compression is negotiated at the BAT protocol layer, not with WebSocket `permessage-deflate`.

Supported compression ids:

```text
gzip
```

Negotiation:

1. Client sends `auth` as an uncompressed text JSON frame.
2. New clients include `compression: ["gzip"]`.
3. Legacy clients omit `compression`; this is equivalent to `compression: []`.
4. Server selects `gzip` only when the offered list contains `gzip`.
5. Server sends `auth-result` as an uncompressed text JSON frame with the selected compression:

```json
{
  "type": "auth-result",
  "id": "1700000000000-auth",
  "result": true,
  "protocol": "bat-remote/v2",
  "compression": "gzip"
}
```

If no supported compression is selected, the server uses:

```json
{
  "type": "auth-result",
  "id": "1700000000000-auth",
  "result": true,
  "protocol": "bat-remote/v2",
  "compression": "none"
}
```

Binary frame envelope for compressed frames:

```text
BATGZIP1\0<gzip-compressed-json-bytes>
```

Wire layout:

```text
offset  size  content
0       8     ASCII magic bytes: 42 41 54 47 5A 49 50 31 ("BATGZIP1")
8       1     NUL byte: 00
9       n     gzip-compressed UTF-8 JSON object bytes
```

Rules:

- Compression is explicit opt-in. A client that does not send `compression: ["gzip"]` receives and sends only text JSON frames.
- When `gzip` is negotiated, all post-auth BAT frames are gzip binary frames in both directions.
- When `none` is negotiated, all BAT frames remain uncompressed WebSocket text frames.
- There is no per-message compression threshold. The connection either compresses every post-auth BAT frame or none of them.
- A compressed binary frame without the `BATGZIP1\0` prefix is invalid.
- An uncompressed text frame received after `gzip` negotiation is invalid for protocol purposes and should be ignored or treated as a connection error by implementations.
- A compressed binary frame received after `none` negotiation is invalid for protocol purposes and should be ignored or treated as a connection error by implementations.
- `auth` and `auth-result` stay text JSON so negotiation is always readable by old clients and diagnostic tooling.

## Frame Types

### `ping`

Client to server:

```json
{ "type": "ping", "id": "1" }
```

Server response:

```json
{ "type": "pong", "id": "1" }
```

### `invoke`

Client to server:

```json
{
  "type": "invoke",
  "id": "1700000000000-1",
  "channel": "agent:get-supported-models",
  "params": {
    "sessionId": "session-id"
  }
}
```

Server success response:

```json
{
  "type": "invoke-result",
  "id": "1700000000000-1",
  "result": {}
}
```

Server error response:

```json
{
  "type": "invoke-error",
  "id": "1700000000000-1",
  "error": "Remote invoke failed"
}
```

Rules:

- `id` is an opaque request id and must be echoed by the server.
- `channel` is required.
- `params` is the named parameter object.
- New v2 channels must use named params. Do not add new positional argument shapes.

### `event`

Server to client:

```json
{
  "type": "event",
  "channel": "agent:message",
  "params": {
    "sessionId": "session-id",
    "message": {
      "type": "assistant",
      "content": "..."
    }
  }
}
```

Rules:

- Events are broadcast by the host runtime to connected remote clients.
- `channel` must be allowlisted by the remote client before being published to renderer listeners.
- `params` must match the existing renderer event payload shape.
- Renderer-facing event names remain stable.

## Runtime Channel Normalization

V2 uses `agent:*` as the canonical remote namespace for agent runtime calls and events.

Runtime behavior:

- Outbound remote agent invokes are sent as `agent:*`.
- Inbound `agent:*` and `claude:*` agent runtime channels are accepted and normalized to the same runtime handler.
- Broadcast agent runtime events are sent as `agent:*`.
- Renderer-facing event names remain the existing local contract; normalization happens below the renderer API.
- Runtime normalization is not tied to protocol negotiation.

## Dispatch Model

Server dispatch order for invoke frames:

1. Validate auth and v2 protocol selection.
2. Read `channel` and named `params`.
3. Try Rust-native remote handling in `invoke_rust_for_remote`.
4. If Rust does not own the channel, translate the channel name to a sidecar method.
5. Call the Node sidecar compatibility bridge.

Channel to sidecar method conversion:

```text
agent:start-session -> claude.startSession
image:read-as-data-url -> image.readAsDataUrl
git:getRoot -> git.getRoot
```

Timeouts:

- Default server invoke timeout: 15 seconds.
- Long Claude session calls (`agent:start-session`, `agent:resume-session`, `agent:send-message`, `agent:fork-session`): 300 seconds.
- Client pending invoke timeout: honors the per-call timeout passed by the
  caller (default 30 seconds; session calls such as `agent:send-message` use
  300 seconds to match the server). The client must not cap session calls at the
  default — doing so kills a long agent turn mid-flight even though the host is
  still streaming `claude:*` events. A client-side `Remote invoke timeout:
  agent:send-message` is treated like the local sendMessage RPC timeout: the
  turn is still alive and driven by events, not a failure.

## Connection Lifecycle (keepalive + reconnect)

The transport can drop silently while the network tunnel (e.g. Tailscale) stays
up: an idle TCP/WS flow with no bytes is reaped by NAT/firewall idle timeouts or
host sleep, leaving a half-open socket. The protocol therefore defines an
application-driven keepalive and a client-driven reconnect.

Keepalive:

- The client sends a WebSocket Ping control frame on an otherwise idle
  connection every ~20 seconds (`KEEPALIVE_INTERVAL` in `remote_client.rs`). The
  server's tungstenite read loop auto-responds with a Pong.
- The purpose is twofold: keep the NAT mapping warm so the flow is not reaped,
  and surface a dead peer promptly — a failed Ping write breaks the client loop
  and flips `connected` to `false` instead of spinning on an undead socket.
- This is distinct from the JSON `ping`/`pong` frames above, which remain
  available for application-level liveness probing.

Reconnect (client-owned):

- The Rust client does not reconnect itself; on a dropped socket it flips
  `connected` to `false` and drains pending invokes with "Connection closed".
- The renderer drives recovery. Its status poll (every 3s) and the
  `system:resume` signal detect `connected === false` for a remote profile and
  re-dial with the original connection params using exponential backoff
  (`RECONNECT_BACKOFF_MIN` 3s → `RECONNECT_BACKOFF_MAX` 30s; reset on success or
  on resume). Overlapping dials are guarded, and a dial that completes after the
  profile was made unavailable is torn down instead of resurrected.
- On a successful re-dial the client re-attaches by reloading the host-owned
  workspace/session state (the host keeps sessions and PTYs alive across a client
  disconnect — see the recent-clients note in `remote_server.rs`). The user
  returns to the same workspaces without restarting the app.

Disconnected invoke behavior:

- An `invoke` issued while `connected === false` fails fast with
  `remote.invoke: not connected to remote server` before anything is sent — the
  request is neither queued nor retried at the transport layer. UI that sends
  user input (agent message send) must treat this as a transient disconnect:
  preserve the user's input, avoid surfacing the raw error string, and let the
  reconnect path restore the session.

### Server resource guardrails

The headless server must stay recoverable when clients disappear mid-write or
the host is under process/thread pressure:

- At most 64 TCP connection handlers may be live at once, including TLS/WS
  handshakes. Excess connections are accepted and immediately closed so the
  listen backlog can continue draining.
- TLS/WS handshakes have a 10-second read deadline, and every socket write has a
  10-second timeout. A peer that stops reading cannot pin a connection thread
  forever.
- At most 128 remote invokes may execute concurrently across all clients. New
  invokes over the limit receive a retryable `invoke-error` instead of spawning
  another OS thread.
- Each authenticated client has a bounded 256-frame outbound queue. The server
  writes at most 64 queued frames per poll iteration; a client whose queue fills
  is revoked rather than consuming unbounded memory.
- Accept, client, and invoke threads use fallible named thread creation. An OS
  task-limit error is logged and handled without panicking the accept loop.
- Recoverable `accept(2)` failures are rate-limited in logs and retried. The
  headless supervisor also checks the accept-loop liveness once per second and
  exits non-zero if that critical thread stops, allowing
  `Restart=on-failure` to recover the service.

`remote_server_status` exposes the additive diagnostics `accepting`,
`activeConnections`, `activeInvokes`, `connectionLimit`, `invokeLimit`, and
`outboundQueueCapacity`.

## Current Channel Groups

App metadata:

```text
app:get-version
```

Result:

```json
{
  "version": "3.0.0",
  "protocol": "bat-remote/v2"
}
```

Remote runtime metadata:

```text
agent:get-supported-session-types
agent:get-supported-models
agent:get-supported-efforts
agent:get-supported-codex-sandbox-modes
agent:get-supported-codex-approval-policies
agent:get-supported-commands
agent:get-supported-agents
agent:get-session-state
agent:get-session-meta
agent:get-context-usage
agent:get-worktree-status
```

`agent:get-supported-session-types` returns the host-supported session creation type ids, such as
`none`, `claude-code`, `claude-cli`, `codex-agent`, and worktree variants. Remote clients must use
this host response to decide which add-session actions to show; they should not infer supported
session types from local renderer code. `agent:list-presets` is kept as a compatibility alias.

Claude / Codex session control:

```text
agent:start-session
agent:resume-session
agent:client-resume
agent:send-message
agent:stop-session
agent:abort-session
agent:reset-session
agent:set-model
agent:set-effort
agent:set-codex-sandbox-mode
agent:set-codex-approval-policy
agent:resolve-permission
agent:resolve-ask-user
```

`agent:client-resume` is a non-destructive resume for a (re)connecting client. It takes the same
params as `agent:resume-session` (`sessionId`, `sdkSessionId`, options) and normalizes to
`claude:client-resume` on the host. When the host already has the session live, it re-emits the
persisted history (`claude:history`) read-only — without tearing down / restarting the SDK session,
so an in-flight host turn is not disturbed. When the session is absent on the host, it falls back to
a normal resume so the transcript still loads. Either way `claude:history` is (re)emitted, so a
client opening a session the host keeps active never renders blank (plain `agent:get-session-state`
returns the host's empty in-memory buffer in that case). Codex-owned sessions defer to the regular
resume path. Use this instead of `agent:resume-session` when a client just wants to view history.

`agent:resolve-permission` and `agent:resolve-ask-user` answer an outstanding host-owned prompt.
They normalize to `claude:resolve-permission` / `claude:resolve-ask-user` on the host. Params:
`agent:resolve-permission` takes `sessionId`, `toolUseId`, `result`; `agent:resolve-ask-user` takes
`sessionId`, `toolUseId`, `answers`. For codex-owned sessions the host routes
`claude:resolve-permission` into the codex app-server bridge so the pending JSON-RPC approval
request is answered; `claude:resolve-ask-user` / `claude:stop-task` are no-ops for codex sessions.

Codex accounts (host-owned, mirrors the Claude account channels):

```text
codex:account-list
codex:account-switch
```

`codex:account-list` takes no params and returns the host's codex account list.
`codex:account-switch` takes `codexHome` (the account entry id) and switches the host's active
codex account; the host applies the switch and returns the result. Remote clients must not mutate
local codex account state. Codex login remains host-only (the renderer blocks it on remote
windows).

PTY:

```text
pty:create
pty:write
pty:read-buffer
pty:resize
pty:get-viewport-state
pty:set-viewport-mode
pty:set-viewport-size
pty:kill
pty:get-cwd
pty:restart
```

Workspace / profile:

```text
workspace:load
workspace:save
workspace:move-to-window
agent:list-sessions
profile:list
profile:get-active-ids
profile:load
profile:load-snapshot
profile:activate
profile:deactivate
```

Filesystem transfer (host-owned; the host writes/reads files, clients stream
bytes over the transport):

```text
fs:upload-tmp-begin   name, totalBytes        → { uploadId, path }
fs:upload-begin-dir   dir, name, totalBytes   → { uploadId, path }
fs:upload-tmp-chunk   uploadId, dataBase64    → { received }
fs:upload-tmp-end     uploadId                → { path }
fs:upload-tmp-abort   uploadId                → bool
fs:download-read      path, offset            → { dataBase64, totalBytes, eof }
```

`fs:upload-tmp-begin` lands the file in the host's tmp dir (drag-drop into a
chat). `fs:upload-begin-dir` lands it in a caller-chosen host directory with
collision-safe naming (file tab upload); both share the chunk/end/abort
channels. Files are capped at 64 MiB and chunks at 4 MiB decoded.
`fs:download-read` is a stateless chunked read (≤1 MiB per call) used by the
file tab's download; the client loops with increasing `offset` until `eof`.

Worktree:

```text
worktree:create
worktree:remove
worktree:status
worktree:merge
worktree:rehydrate
```

Named params:

```text
worktree:create     sessionId, cwd, installPnpm
worktree:remove     sessionId, deleteBranch
worktree:status     sessionId
worktree:merge      sessionId, strategy
worktree:rehydrate  sessionId, cwd, worktreePath, branchName
```

Worktree rules:

- Worktree state is host-owned. The git worktree folder, its branch, and the
  `WorktreeState` session map live on the host machine; the paths a remote
  client holds (workspace folder, `worktreePath`) are host paths and must never
  be passed to the client's local git.
- The renderer's `worktree.*` host API maps 1:1 onto these channels. On a
  remote profile window, the Tauri `worktree_*` commands
  (`src-tauri/src/commands/worktree.rs`) detect the remote window and proxy the
  call to the host instead of running the native implementation; the host
  serves them in `invoke_rust_for_remote` (`remote_server.rs`).
- `worktree:create` must run on the host BEFORE `agent:start-session` is sent
  with `useWorktree: true`. The host sidecar refuses to start a worktree
  session whose `worktreePath` does not exist on the host (it does not fall
  back to the original cwd), so a client-side worktree path is a hard error,
  not a silent unisolated session.
- `worktree:create` / `worktree:merge` / `worktree:remove` / `worktree:rehydrate`
  are slow git mutations and use a long client invoke timeout (120s).
  `worktree:status` is polled by the merged-state chip and keeps the short
  default timeout so a stalled host fails fast.
- The related agent-tied calls (`agent:get-worktree-status`,
  `agent:cleanup-worktree`) and the `agent:worktree-info` broadcast event
  follow the normal `agent:*` routing above.

Files, Git, GitHub, and snippets use the same `invoke` frame pattern.

## Host-Owned State Sync

The host is the source of truth for shared remote state. Remote clients may request changes, but the host must apply the change first and then broadcast the resulting state or invalidation event to every connected client.

General principle:

- Except for purely local presentation state, clients do not own remote state.
- Message filters are client-only presentation state. They may be applied locally without host round trips because they do not change host data.
- All other actions must be sent to the host as `invoke` frames.
- The host executes or rejects the requested action, then returns an `invoke-result` / `invoke-error`.
- When the action changes shared state, the host broadcasts the canonical result or an invalidation event back to all connected clients.
- Clients should render the host response/reflection, not their own optimistic final state. Temporary local loading/pending UI is allowed while waiting for host confirmation.

Workspace state:

- `workspace:load` returns the current host workspace JSON for the selected remote profile.
- `workspace:save` is client-to-host. A client must not assume its local state is accepted until the host returns success.
- The `windowId` a client attaches to `workspace:load`/`workspace:save` is untrusted. The host honors it only when it names an existing host registry entry already bound to the requested profile; otherwise the host falls back to profile-targeted handling. Client window ids must never fabricate host registry entries or address the host's own windows (both sides label their main window `main`).
- Clients SHOULD omit `windowId` entirely on `workspace:load`/`workspace:save`. Client window labels are ephemeral and never name host registry entries, so sending them is at best ignored — and pre-validation hosts fabricate an empty phantom registry entry from the unknown label on `workspace:load`, serving an empty list on every reconnect while the previously saved data stays stranded under the prior label's phantom entry. Omitting `windowId` routes both load and save through the host's profile-level snapshot, the host-owned source of truth.
- After a successful `workspace:save`, the host broadcasts `workspace:reload` with the saved workspace JSON.
- Clients receiving `workspace:reload` must replace/reload their workspace state from the payload.
- The client-side Rust remote client stamps every `workspace:reload` it republishes from a host connection with `remoteOrigin: "<host>:<port>"`. Legacy bare-string payloads (hosts <= v3.1.8) are wrapped as `{ "data": "<workspace json>", "remoteOrigin": "<host>:<port>" }` so the tag survives.
- Renderer gating for `workspace:reload`:
  - A window viewing a remote profile applies only payloads carrying a `remoteOrigin` that matches its own connection, and whose `profileId` matches the viewed host profile. Untagged (local-origin) payloads are ignored on remote windows.
  - A window on a local profile must ignore any payload carrying `remoteOrigin` — otherwise a host broadcast with `windowId: "main"` would collide with the local main window, get adopted, and the next local save would persist the host's list over the machine's own data.
  - Bare-string payloads are never adopted directly; the window re-fetches through its own `workspace:load` routing instead.
- Host-side window/workspace changes that affect the serialized workspace view should also broadcast `workspace:reload`.
- `workspace:move-to-window` moves one workspace from a source host window to a target host window. Clients must send the source window id, target window id, workspace id, and insert index. The host applies the move, persists both affected window/profile snapshots, then emits `workspace:reload` for both affected windows.

Profile/window state:

- `profile:list` and `profile:get-active-ids` always read from the host.
- Host-side profile/window changes, including opening a profile window, closing the last window for a profile, activating/deactivating profiles, creating, updating, renaming, deleting, duplicating, or remote workspace saves that activate a profile, broadcast `profile:changed`.
- Profile creation is reflected by `profile:changed`; clients should add it to profile lists only after it appears in the host payload.
- Profile deletion is reflected by `profile:changed`; clients should remove it from profile lists when absent from the host payload.
- If the remote profile backing the current client window is deleted or becomes inaccessible, the client must stop mutating that profile, show a disconnected/unavailable state, and require the user to select another profile or reconnect. It must not keep writing to the deleted profile id.
- If a profile remains present but is no longer active, clients may keep an already-open view read/write-capable only if the host continues accepting its invokes. Profile list UI must still display the host's active state from `activeProfileIds`.
- `profile:changed` payload:

```json
{
  "profiles": [
    {
      "id": "default",
      "name": "Default",
      "type": "local",
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000
    }
  ],
  "activeProfileIds": ["default"]
}
```

- Clients that display profile/window lists should refresh from the host when they receive `profile:changed`.

Workspace lifecycle:

- Workspace creation, deletion, reorder, rename, group changes, terminal add/remove, and window detach/reattach are host-owned workspace mutations.
- Clients request these mutations through the relevant invoke path, usually ending in `workspace:save` or a workspace/window command.
- Before requesting a cross-window workspace move, both participating clients should flush their current workspace snapshot to the host when possible. The move is still accepted or rejected by the host's canonical state, not by the client's drag payload.
- After the host accepts a workspace mutation, it broadcasts `workspace:reload` with the canonical serialized workspace state for that profile/window scope.
- Clients must reconcile local UI to the `workspace:reload` payload.
- If the currently selected workspace is removed in the host payload, the client must switch to the payload's `activeWorkspaceId` when present.
- If no `activeWorkspaceId` is present and workspaces remain, the client should select the first host-provided workspace.
- If no workspaces remain, the client should show an empty workspace state and wait for the user/host to create a workspace. It must not continue sending terminal/session actions tied to the removed workspace.
- If the currently selected terminal/session panel is removed from the host workspace payload, the client must close that panel locally and stop sending actions for the removed terminal/session id.

Session lists:

- `agent:list-sessions` returns the host's current session list for the requested `cwd` and optional agent kind.
- Session list UI must fetch from the host when the client switches into the list view. Clients should not rely on cached session lists.
- Session mutations remain host-owned. If a future session-list invalidation event is added, clients should still re-fetch with `agent:list-sessions` when opening the list.
- A session appearing in the list means the host can offer it for resume/restore. Clients should not invent list entries locally.
- A session absent from the latest host list should be removed from the visible list.
- If the user is viewing a resume list and the selected session disappears before selection, the client should disable/remove that row and require a fresh selection.
- If the currently open running session is stopped/aborted/removed by the host, the host should emit the corresponding agent status/error/turn-end event. The client must stop accepting input for that session until it receives or requests a fresh host-owned session state.

Shared prompts and questions (permission / ask-user):

- Permission requests (`agent:permission-request`) and AskUserQuestion prompts (`agent:ask-user`) are host-owned. The host broadcasts them to every connected client, so the same prompt is shown on the host and on all remote windows at once.
- A logical prompt is identified by its `toolUseId`. Every show and resolved event for one prompt carries the same `sessionId` and `toolUseId`.
- Any single window (host or any client) may answer. The answering window sends `agent:resolve-permission` / `agent:resolve-ask-user` as an `invoke`. The host applies the answer once against the pending entry keyed by `toolUseId`.
- After resolving, the host broadcasts `agent:permission-resolved` / `agent:ask-user-resolved` with the same `sessionId` and `toolUseId` to every connected client. On receipt, every other window must close/dismiss the prompt that matches that `toolUseId`. This is what makes an answer on one window dismiss the prompt on all other windows.
- The resolved broadcast is idempotent. If a second window answers a prompt whose pending entry is already gone (another window answered first), the host still re-broadcasts the resolved event for that `toolUseId` instead of staying silent. This self-heals any window whose first dismiss broadcast was dropped.
- Clients must scope the dismiss to the matching `toolUseId`. A resolved event whose `toolUseId` does not match the currently shown prompt must be ignored, so an idempotent re-broadcast cannot close a newer prompt that has since opened in the same session.
- Clients must not treat their own local answer as the authoritative dismiss across windows. The host's resolved broadcast is the canonical dismiss. Temporary local pending UI is allowed while waiting for it.

Required remote implementation behavior:

```text
host profile created/updated/deleted/activated/deactivated
  -> host broadcasts profile:changed
  -> client refreshes any visible profile/window list from host payload or profile:list
  -> if current backing profile is gone, client enters unavailable state and stops profile mutations

client requests profile/window mutation
  -> client sends invoke to host
  -> host applies or rejects
  -> host returns invoke-result/invoke-error
  -> on success host broadcasts profile:changed when profile/window membership changed
  -> all clients render host-reflected state

host workspace changed
  -> host broadcasts workspace:reload with canonical workspace JSON
  -> client applies payload, preserving only local presentation state
  -> if active workspace/terminal/session no longer exists, client exits that view and selects host fallback when available

client requests workspace mutation
  -> client sends invoke to host, commonly workspace:save
  -> host writes canonical state or rejects
  -> host returns invoke-result/invoke-error
  -> on success host broadcasts workspace:reload
  -> all clients apply the host payload

client requests workspace move between windows/profiles
  -> source and target clients flush their latest workspace snapshots when possible
  -> client invokes workspace:move-to-window on the host
  -> host validates source window, target window, and workspace id against canonical registry state
  -> host moves the workspace and associated terminals, then persists both affected window/profile snapshots
  -> host returns invoke-result/invoke-error
  -> host emits workspace:reload to the source and target windows
  -> all affected clients render only the host-reflected workspace state

client opens session/resume list
  -> client invokes agent:list-sessions against host
  -> host returns current list
  -> client renders that list and discards stale local entries

host session state changed
  -> host emits the existing agent event family such as agent:status, agent:error, agent:turn-end, agent:history, or agent:resume-loading
  -> client updates the open session from the host event
  -> if the session is no longer usable, client disables input until a new host-owned session is selected or created

host surfaces a permission/ask-user prompt
  -> host broadcasts agent:permission-request / agent:ask-user with sessionId and toolUseId
  -> every connected window shows the prompt for that toolUseId

host or any client answers a shared prompt/question
  -> answering window invokes agent:resolve-permission / agent:resolve-ask-user on the host
  -> host resolves the pending entry keyed by toolUseId, applying the answer once
  -> host broadcasts agent:permission-resolved / agent:ask-user-resolved with the same sessionId and toolUseId
  -> every other window dismisses the prompt matching that toolUseId
  -> if a window answers an already-resolved prompt, the host re-broadcasts the resolved event (idempotent) so lagging windows still dismiss
  -> a resolved event whose toolUseId does not match the shown prompt is ignored so newer prompts stay open
```

Implementation notes:

- `profile:changed` is the profile/window list invalidation and reflection event.
- `workspace:reload` is the workspace reflection event.
- Session lists are pull-based today: opening the list must call `agent:list-sessions`.
- Existing agent runtime events remain the session-state reflection mechanism.
- `agent:permission-resolved` / `agent:ask-user-resolved` are the shared-prompt dismiss reflection events. They are keyed by `toolUseId`, idempotent, and authoritative over a window's local answer.
- Message filter state is the exception: it is client-only and is not sent to the host.

## Event Allowlist

Currently expected proxied event families:

```text
pty:output
pty:exit
pty:viewport-state
agent:message
agent:tool-use
agent:tool-result
agent:stream
agent:result
agent:turn-end
agent:error
agent:status
agent:permission-request
agent:permission-resolved
agent:ask-user
agent:ask-user-resolved
agent:modeChange
agent:history
agent:resume-loading
agent:prompt-suggestion
agent:session-reset
agent:worktree-info
agent:rate-limit
fs:changed
profile:changed
workspace:detached
workspace:reattached
workspace:reload
system:resume
```

When adding a server broadcast event:

1. Add the event to the remote event allowlist.
2. Send named `params` matching the renderer event shape.
3. Keep the renderer event name and payload shape compatible.

## Compatibility Policy

- V2 is the canonical protocol shape.
- New requests and events use named `params`.
- Renderer-facing IPC names and event payloads remain additive-only unless a coordinated migration explicitly says otherwise.
- Protocol adapters should stay below the renderer contract.

## Checklist For Adding A Remote Capability

1. Add or update the renderer host API method.
2. Add the Tauri command or route it through an existing command.
3. If the command is remote-aware, call `remote_client.invoke(channel, params, timeout)` from the Tauri command when the current window is a remote profile.
4. Add the server-side `invoke_rust_for_remote` branch when Rust owns the capability.
5. If sidecar owns it, ensure `channel_to_sidecar_method` maps to an existing sidecar method.
6. If the capability emits events, add it to the event allowlist and emit named params.
7. Add or update tests for host API routing and remote invoke normalization.
