use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::io::{Read, Write};

pub const REMOTE_PROTOCOL_LEGACY_V1: &str = "bat-remote/legacy-v1";
pub const REMOTE_PROTOCOL_V2: &str = "bat-remote/v2";
pub const REMOTE_COMPRESSION_GZIP: &str = "gzip";
pub const REMOTE_COMPRESSION_NONE: &str = "none";
const REMOTE_GZIP_FRAME_MAGIC: &[u8] = b"BATGZIP1\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RemoteProtocol {
    LegacyV1,
    V2,
}

impl RemoteProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteProtocol::LegacyV1 => REMOTE_PROTOCOL_LEGACY_V1,
            RemoteProtocol::V2 => REMOTE_PROTOCOL_V2,
        }
    }
}

pub fn negotiate_remote_protocol(offered: &[String]) -> Option<RemoteProtocol> {
    if offered.is_empty() {
        return Some(RemoteProtocol::LegacyV1);
    }
    if offered.iter().any(|value| value == REMOTE_PROTOCOL_V2) {
        return Some(RemoteProtocol::V2);
    }
    if offered
        .iter()
        .any(|value| value == REMOTE_PROTOCOL_LEGACY_V1)
    {
        return Some(RemoteProtocol::LegacyV1);
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RemoteCompression {
    None,
    Gzip,
}

impl RemoteCompression {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteCompression::None => REMOTE_COMPRESSION_NONE,
            RemoteCompression::Gzip => REMOTE_COMPRESSION_GZIP,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteFramePayload {
    Text(String),
    Binary(Vec<u8>),
}

pub fn negotiate_remote_compression(offered: &[String]) -> RemoteCompression {
    if offered.iter().any(|value| value == REMOTE_COMPRESSION_GZIP) {
        RemoteCompression::Gzip
    } else {
        RemoteCompression::None
    }
}

pub fn encode_remote_frame(
    frame: &Value,
    compression: RemoteCompression,
) -> Result<RemoteFramePayload, String> {
    let raw =
        serde_json::to_vec(frame).map_err(|err| format!("remote frame encode failed: {err}"))?;
    match compression {
        RemoteCompression::None => String::from_utf8(raw)
            .map(RemoteFramePayload::Text)
            .map_err(|err| format!("remote frame utf-8 encode failed: {err}")),
        RemoteCompression::Gzip => {
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder
                .write_all(&raw)
                .map_err(|err| format!("remote frame gzip write failed: {err}"))?;
            let mut payload = REMOTE_GZIP_FRAME_MAGIC.to_vec();
            payload.extend(
                encoder
                    .finish()
                    .map_err(|err| format!("remote frame gzip finish failed: {err}"))?,
            );
            Ok(RemoteFramePayload::Binary(payload))
        }
    }
}

pub fn decode_remote_text_frame(text: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(text)
        .map_err(|err| format!("remote frame json parse failed: {err}"))
}

pub fn decode_remote_binary_frame(bytes: &[u8]) -> Result<Value, String> {
    let Some(compressed) = bytes.strip_prefix(REMOTE_GZIP_FRAME_MAGIC) else {
        return Err("remote binary frame has unsupported envelope".to_string());
    };
    let mut decoder = flate2::read::GzDecoder::new(compressed);
    let mut raw = Vec::new();
    decoder
        .read_to_end(&mut raw)
        .map_err(|err| format!("remote frame gzip decode failed: {err}"))?;
    serde_json::from_slice::<Value>(&raw)
        .map_err(|err| format!("remote frame json parse failed: {err}"))
}

// ===================== relay loop prevention =====================
//
// Relaying (a client reaching an upstream host through the host it is paired with)
// makes a host both a consumer and a producer of the same frame, which is exactly
// the shape that closes a cycle. The cycle is not hypothetical here: one desktop
// runs a remote server AND a remote client at the same time — lib.rs manages
// RustRemoteServerState and RustRemoteClientState side by side — so two desktops
// that each hold a remote profile pointing at the other form A -> B -> A, and
// nothing stops a profile pointing back at its own host either (connect validation
// checks only that host/port/token/fingerprint are non-empty). An event going round
// such a ring is re-broadcast forever, amplifying at every hop.
//
// Today the only thing preventing that is the `origin != "rust-remote-client"` test
// in event_hub, which suppresses re-broadcast of upstream events wholesale. Relay
// has to lift that suppression, so the guard has to be replaced by something that
// distinguishes "forwarding onward" from "forwarding back into a ring".
//
// A relayed frame therefore carries the path of hosts it has already traversed, and
// a host refuses to forward a frame whose path already names it. Identity is the
// server's TLS certificate fingerprint: persisted rather than regenerated
// (ensure_remote_certificate writes it once; the stability is pinned by
// ensure_certificate_reuses_node_compatible_plaintext_envelope) and already the
// value every client pins, so it needs no new storage or handshake field.
//
// `path.len()` IS the hop count. There is deliberately no separate depth field,
// because two fields can disagree and then the guard is only as strong as whichever
// one a given caller happened to check.

pub const REMOTE_RELAY_PATH_KEY: &str = "relayPath";

/// How many times a frame may be relayed. 1 covers the intended topology — a
/// client reaching one upstream host through the host it is paired with — and
/// nothing beyond it.
pub const MAX_RELAY_HOPS: usize = 1;

/// A path longer than this is not a topology this supports, it is a peer sending
/// nonsense. Refuse rather than allocate against it.
const RELAY_PATH_SANITY_LIMIT: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayRefusal {
    /// This host already appears in the path: forwarding would close a cycle.
    Cycle,
    /// The hop budget is spent.
    HopLimit,
    /// The path field is present but is not a list of identities.
    Malformed,
}

impl RelayRefusal {
    /// Stable wording for the log line a refusal should leave behind — a silently
    /// dropped frame is indistinguishable from a routing bug.
    pub fn as_str(self) -> &'static str {
        match self {
            RelayRefusal::Cycle => "relay path already names this host",
            RelayRefusal::HopLimit => "relay hop limit reached",
            RelayRefusal::Malformed => "relay path is malformed",
        }
    }
}

/// The hosts a frame has already traversed. An absent field means "never relayed",
/// which is every frame in the pre-relay protocol.
pub fn remote_relay_path(frame: &Value) -> Result<Vec<String>, RelayRefusal> {
    let Some(raw) = frame.get(REMOTE_RELAY_PATH_KEY) else {
        return Ok(Vec::new());
    };
    let Some(entries) = raw.as_array() else {
        return Err(RelayRefusal::Malformed);
    };
    if entries.len() > RELAY_PATH_SANITY_LIMIT {
        return Err(RelayRefusal::Malformed);
    }
    let mut path = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(hop) = entry.as_str().map(normalize_host_identity) else {
            return Err(RelayRefusal::Malformed);
        };
        if hop.is_empty() {
            return Err(RelayRefusal::Malformed);
        }
        path.push(hop);
    }
    Ok(path)
}

/// Decide whether `frame` may be relayed onward by the host identified by
/// `own_identity`, returning the frame to actually send — stamped with this hop —
/// or the reason it must be dropped.
///
/// Forwarding *without* stamping is precisely what would reintroduce the cycle, so
/// stamping is not a separate step a caller can forget: the only way to obtain a
/// forwardable frame is through this function.
pub fn relay_frame(frame: &Value, own_identity: &str) -> Result<Value, RelayRefusal> {
    let identity = normalize_host_identity(own_identity);
    if identity.is_empty() {
        return Err(RelayRefusal::Malformed);
    }
    let mut path = remote_relay_path(frame)?;
    // Cycle before hop limit: when both apply, "this would loop" is the more
    // useful thing to see in a log than "budget spent".
    if path.iter().any(|hop| hop == &identity) {
        return Err(RelayRefusal::Cycle);
    }
    if path.len() >= MAX_RELAY_HOPS {
        return Err(RelayRefusal::HopLimit);
    }
    let Some(map) = frame.as_object() else {
        return Err(RelayRefusal::Malformed);
    };
    path.push(identity);
    let mut relayed = map.clone();
    relayed.insert(REMOTE_RELAY_PATH_KEY.to_string(), json!(path));
    Ok(Value::Object(relayed))
}

/// Normalised form of a host identity (its TLS certificate fingerprint), so that
/// the relay path check and the self-connection check agree on what "the same host"
/// means rather than each rolling its own comparison.
///
/// Fingerprints are produced as uppercase hex with colons, so casing should already
/// agree. Normalising anyway costs nothing and stops a peer from walking past the
/// cycle check by echoing a hop back in a different case.
pub fn normalize_host_identity(identity: &str) -> String {
    identity.trim().to_ascii_uppercase()
}

/// Whether two host identities name the same host.
pub fn same_host_identity(left: &str, right: &str) -> bool {
    let left = normalize_host_identity(left);
    !left.is_empty() && left == normalize_host_identity(right)
}

// `agent:` is the target naming and the `claude:` spellings are the legacy
// surface being phased out; this rewrite is stage compatibility, not the end
// state. So the list below is not an exception list — it is the set of channels
// that ALREADY live under their final `agent:` name. Anything absent is still
// folded onto its old `claude:` spelling so existing clients keep working.
//
// Adding a channel here is what "migrated" means, and it has to be done in step
// with everything that matches on the canonical result: legacy_v1_param_keys,
// is_proxied_remote_event, and invoke_rust_for_remote's arms.
pub fn canonical_remote_channel(channel: &str) -> String {
    let Some(rest) = channel.strip_prefix("agent:") else {
        return channel.to_string();
    };
    if matches!(
        rest,
        "list-presets"
            | "get-supported-session-types"
            // Usage was born agent:-native — the poller publishes `agent:usage`
            // and the renderer listens on `agent:usage`. Folding it to
            // `claude:usage` invented a name nothing publishes or listens to,
            // which silently dropped the broadcast for every remote client.
            | "usage"
            | "usage-snapshot"
    ) {
        channel.to_string()
    } else {
        format!("claude:{rest}")
    }
}

pub fn remote_agent_channel(channel: &str) -> String {
    let Some(rest) = channel.strip_prefix("claude:") else {
        return channel.to_string();
    };
    format!("agent:{rest}")
}

fn object_from_keys(keys: &[&str], args: &[Value]) -> Value {
    let mut map = Map::new();
    for (index, key) in keys.iter().enumerate() {
        if let Some(value) = args.get(index) {
            map.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(map)
}

fn strip_null_fields(value: Value) -> Value {
    let Value::Object(map) = value else {
        return value;
    };
    Value::Object(
        map.into_iter()
            .filter(|(_, value)| !value.is_null())
            .collect(),
    )
}

fn legacy_v1_param_keys(channel: &str) -> Option<&'static [&'static str]> {
    let canonical = canonical_remote_channel(channel);
    match canonical.as_str() {
        "app:get-version" => Some(&[]),
        "app:new-window" => Some(&["profileId"]),
        "runtime:get-status" => Some(&[]),
        "runtime:install" | "runtime:clear-managed" => Some(&["tool"]),
        "agent:get-supported-session-types" | "agent:list-presets" => Some(&[]),
        "settings:save" => Some(&["data"]),
        "settings:get-shell-path" => Some(&["shellType"]),
        "workspace:load" => Some(&["profileId", "windowId"]),
        "workspace:save" => Some(&["profileId", "data", "windowId"]),
        "image:read-as-data-url" => Some(&["filePath"]),
        "pty:create" => Some(&["options"]),
        "pty:write" => Some(&["id", "data"]),
        "pty:read-buffer" => Some(&["id"]),
        "pty:resize" => Some(&["id", "cols", "rows"]),
        "pty:get-viewport-state" => Some(&["id"]),
        "pty:set-viewport-mode" => Some(&["id", "mode", "options"]),
        "pty:set-viewport-size" => Some(&["id", "cols", "rows", "source"]),
        "pty:kill" | "pty:get-cwd" => Some(&["id"]),
        "pty:restart" => Some(&["id", "cwd", "shell"]),
        "claude:auth-status"
        | "claude:account-list"
        | "claude:account-mark-warning-shown"
        | "claude:auth-login-start"
        | "claude:get-cli-path" => Some(&[]),
        // Read-only pull of the host's last usage snapshot per provider. No params
        // at all: host-wide, not scoped to a session. Declaring the empty key list
        // also stops a stray positional arg from being reinterpreted as a param by
        // the `_` fallback below.
        //
        // agent:-native, so the two spellings no longer collapse into one and both
        // are listed: `agent:` is the name to keep, `claude:` is accepted only so a
        // client that tries the legacy name first still gets an answer.
        "agent:usage-snapshot" | "claude:usage-snapshot" => Some(&[]),
        "claude:auth-login-submit-code" => Some(&["code", "loginId"]),
        "claude:auth-login-cancel" => Some(&["loginId"]),
        "claude:prepare-cli-session" => Some(&[
            "terminalId",
            "workspaceId",
            "cwd",
            "agentPreset",
            "currentSessionId",
        ]),
        "claude:send-message" => Some(&[
            "sessionId",
            "prompt",
            "images",
            "autoCompactWindow",
            "clientMessageId",
            "displayPrompt",
            "suppressUserEcho",
        ]),
        "claude:stop-session"
        | "claude:abort-session"
        | "claude:get-auto-continue"
        | "claude:reset-session"
        | "claude:get-supported-models"
        | "claude:get-supported-efforts"
        | "claude:get-supported-codex-sandbox-modes"
        | "claude:get-supported-codex-approval-policies"
        | "claude:get-account-info"
        | "claude:get-supported-commands"
        | "claude:get-supported-agents"
        | "claude:get-session-state"
        | "claude:get-session-meta"
        | "claude:get-worktree-status"
        | "claude:get-context-usage"
        | "claude:fork-session"
        | "claude:rest-session"
        | "claude:wake-session"
        | "claude:is-resting"
        | "claude:clear-archive"
        | "worktree:status" => Some(&["sessionId"]),
        "claude:set-auto-continue" => Some(&["sessionId", "opts"]),
        "claude:set-permission-mode" => Some(&["sessionId", "mode"]),
        "claude:set-codex-sandbox-mode" => Some(&["sessionId", "mode"]),
        "claude:set-codex-approval-policy" => Some(&["sessionId", "policy"]),
        "claude:set-model" => Some(&["sessionId", "model", "autoCompactWindow"]),
        "claude:set-effort" => Some(&["sessionId", "effort"]),
        "claude:cleanup-worktree" => Some(&["sessionId", "deleteBranch"]),
        "claude:scan-skills" => Some(&["cwd"]),
        "claude:resolve-permission" => Some(&["sessionId", "toolUseId", "result"]),
        "claude:resolve-ask-user" => Some(&["sessionId", "toolUseId", "answers"]),
        "claude:list-sessions" => Some(&["cwd", "agentKind"]),
        "claude:rewind-to-prompt" => Some(&["sessionId", "promptIndex"]),
        "claude:stop-task" => Some(&["sessionId", "taskId"]),
        "claude:archive-messages" => Some(&["sessionId", "messages"]),
        "claude:load-archived" => Some(&["sessionId", "offset", "limit"]),
        "claude:fetch-subagent-messages" => Some(&["sessionId", "agentToolUseId"]),
        "claude:account-switch" | "claude:account-remove" => Some(&["accountId"]),
        "codex:account-list" => Some(&[]),
        "codex:account-switch" => Some(&["codexHome"]),
        "codex:auth-login-device-start" => Some(&[]),
        "codex:auth-login-device-poll" | "codex:auth-login-device-cancel" => Some(&["loginId"]),
        "claude:check-mcp-json-status" | "claude:enable-all-project-mcp" => Some(&["cwd"]),
        "worktree:create" => Some(&["sessionId", "cwd", "installPnpm"]),
        "worktree:remove" => Some(&["sessionId", "deleteBranch"]),
        "worktree:merge" => Some(&["sessionId", "strategy"]),
        "worktree:rehydrate" => Some(&["sessionId", "cwd", "worktreePath", "branchName"]),
        "git:get-github-url" => Some(&["folderPath"]),
        "git:branch" | "git:status" | "git:getRoot" => Some(&["cwd"]),
        "git:log" => Some(&["cwd", "count"]),
        "git:diff" => Some(&["cwd", "commitHash", "filePath"]),
        "git:diff-files" => Some(&["cwd", "commitHash"]),
        "fs:readdir" | "fs:isDirectory" | "fs:search" | "fs:watch" | "fs:unwatch"
        | "fs:list-dirs" => match channel {
            "fs:search" => Some(&["dirPath", "query", "filesOnly"]),
            "fs:list-dirs" => Some(&["dirPath", "includeHidden"]),
            "fs:isDirectory" => Some(&["path"]),
            _ => Some(&["dirPath"]),
        },
        "fs:readFile" => Some(&["filePath"]),
        "fs:upload-tmp-begin" => Some(&["name", "totalBytes"]),
        "fs:upload-tmp-chunk" => Some(&["uploadId", "dataBase64"]),
        "fs:upload-tmp-end" | "fs:upload-tmp-abort" => Some(&["uploadId"]),
        "fs:upload-begin-dir" => Some(&["dir", "name", "totalBytes"]),
        "fs:download-read" => Some(&["path", "offset"]),
        "fs:mkdir" => Some(&["parentPath", "name"]),
        "fs:delete-path" => Some(&["targetPath"]),
        "fs:resolve-path-links" => Some(&["cwd", "rawPaths"]),
        "github:check-cli" => Some(&[]),
        "github:pr-list" | "github:issue-list" => Some(&["cwd"]),
        "github:pr-view" | "github:issue-view" => Some(&["cwd", "number"]),
        "github:pr-comment" | "github:issue-comment" => Some(&["cwd", "number", "body"]),
        "profile:load" | "profile:load-snapshot" | "profile:activate" | "profile:deactivate" => {
            Some(&["profileId"])
        }
        "snippet:getById" | "snippet:delete" | "snippet:toggleFavorite" => Some(&["id"]),
        "snippet:create" => Some(&["input"]),
        "snippet:update" => Some(&["id", "updates"]),
        "snippet:search" => Some(&["query"]),
        "snippet:getByWorkspace" => Some(&["workspaceId"]),
        _ => None,
    }
}

pub fn legacy_v1_args_to_params(channel: &str, args: &[Value]) -> Value {
    let canonical = canonical_remote_channel(channel);
    let channel = canonical.as_str();
    if args.is_empty() {
        return Value::Null;
    }
    if args.len() == 1 && args[0].is_object() {
        return args[0].clone();
    }
    match channel {
        "claude:start-session" => json!({
            "sessionId": args.first().cloned().unwrap_or(Value::Null),
            "options": args.get(1).cloned().unwrap_or(Value::Null),
        }),
        "claude:resume-session" | "claude:client-resume" => {
            let has_ultracode_slot = args.len() >= 16
                || args
                    .get(13)
                    .map(|value| value.is_boolean() || value.is_null())
                    .unwrap_or(false);
            let workspace_id_idx = if has_ultracode_slot { 14 } else { 13 };
            let workspace_name_idx = if has_ultracode_slot { 15 } else { 14 };
            json!({
                "sessionId": args.first().cloned().unwrap_or(Value::Null),
                "sdkSessionId": args.get(1).cloned().unwrap_or(Value::Null),
                "options": strip_null_fields(json!({
                    "cwd": args.get(2).cloned().unwrap_or(Value::Null),
                    "model": args.get(3).cloned().unwrap_or(Value::Null),
                    "apiVersion": args.get(4).cloned().unwrap_or(Value::Null),
                    "useWorktree": args.get(5).cloned().unwrap_or(Value::Null),
                    "worktreePath": args.get(6).cloned().unwrap_or(Value::Null),
                    "worktreeBranch": args.get(7).cloned().unwrap_or(Value::Null),
                    "agentPreset": args.get(8).cloned().unwrap_or(Value::Null),
                    "codexSandboxMode": args.get(9).cloned().unwrap_or(Value::Null),
                    "codexApprovalPolicy": args.get(10).cloned().unwrap_or(Value::Null),
                    "permissionMode": args.get(11).cloned().unwrap_or(Value::Null),
                    "effort": args.get(12).cloned().unwrap_or(Value::Null),
                    "ultracode": if has_ultracode_slot { args.get(13).cloned().unwrap_or(Value::Null) } else { Value::Null },
                    "workspaceId": args.get(workspace_id_idx).cloned().unwrap_or(Value::Null),
                    "workspaceName": args.get(workspace_name_idx).cloned().unwrap_or(Value::Null),
                })),
            })
        }
        _ => legacy_v1_param_keys(channel)
            .map(|keys| object_from_keys(keys, args))
            .unwrap_or_else(|| args.first().cloned().unwrap_or(Value::Null)),
    }
}

pub fn invoke_params_for_protocol(
    protocol: RemoteProtocol,
    channel: &str,
    args: &[Value],
    params: Option<Value>,
) -> Value {
    match protocol {
        RemoteProtocol::V2 => params.unwrap_or_else(|| legacy_v1_args_to_params(channel, args)),
        RemoteProtocol::LegacyV1 => legacy_v1_args_to_params(channel, args),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteInvokeRequest {
    pub protocol: RemoteProtocol,
    pub channel: String,
    #[serde(default)]
    pub args: Vec<Value>,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default, rename = "windowId")]
    pub window_id: Option<String>,
    #[serde(default, rename = "profileId")]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostDispatchRequest {
    pub channel: String,
    pub params: Value,
    pub window_id: Option<String>,
    pub profile_id: Option<String>,
    pub is_remote: bool,
}

pub fn normalize_remote_invoke(request: RemoteInvokeRequest) -> HostDispatchRequest {
    let channel = canonical_remote_channel(&request.channel);
    let params =
        invoke_params_for_protocol(request.protocol, &channel, &request.args, request.params);
    HostDispatchRequest {
        channel,
        params,
        window_id: request.window_id,
        profile_id: request.profile_id,
        is_remote: true,
    }
}

/// What a remote client is allowed to know about a profile.
///
/// A distinct type rather than a "clear the sensitive fields before sending" pass,
/// because a denylist leaks whatever sensitive field is added to `ProfileEntry`
/// next. Here the struct IS the allowlist and serde drops everything else, so a
/// new field has to be added deliberately to reach a client.
///
/// Nothing here is a credential, by design. A remote client never dials anything
/// itself — it asks this host to operate a profile and the host does the dialling —
/// so it needs neither the token nor the address of the target. Handing those down
/// so a client could dial directly would be handing out another machine's
/// credentials to something that was never authorised to reach it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProfileEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    /// Display only: the cached name of the host-side profile a remote alias points
    /// at, so a client can label the row without dialling anywhere to look it up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_profile_name: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// Rewrite a profile payload's `profiles` array through `RemoteProfileEntry`. Any
/// other key is passed through untouched, and a payload without a `profiles` array
/// comes back unchanged.
///
/// Every field defaults, so any object entry survives with blanks for whatever it
/// lacked; an entry that is not an object is not a profile and is dropped rather
/// than forwarded as-is.
pub fn strip_profile_secrets(payload: &Value) -> Value {
    let Some(map) = payload.as_object() else {
        return payload.clone();
    };
    let Some(Value::Array(profiles)) = map.get("profiles") else {
        return payload.clone();
    };
    let sanitized = profiles
        .iter()
        .filter_map(|entry| serde_json::from_value::<RemoteProfileEntry>(entry.clone()).ok())
        .filter_map(|entry| serde_json::to_value(entry).ok())
        .collect::<Vec<_>>();
    let mut out = map.clone();
    out.insert("profiles".to_string(), Value::Array(sanitized));
    Value::Object(out)
}

/// Event params as a remote client should see them.
///
/// Gated on the channel rather than "strip any `profiles` key you find": workspace
/// state has a `profiles` key too, and rewriting that would corrupt an unrelated
/// payload. Canonicalises first, like every other channel match in this module.
///
/// MUST run before `event_params_to_legacy_v1_args`: that folds `profile:changed`
/// params into `vec![params.clone()]`, so a sanitize placed after it would leave
/// the untouched original sitting in the legacy v1 args.
pub fn remote_event_params_for_clients<'a>(channel: &str, params: &'a Value) -> Cow<'a, Value> {
    if canonical_remote_channel(channel) == "profile:changed" {
        Cow::Owned(strip_profile_secrets(params))
    } else {
        Cow::Borrowed(params)
    }
}

pub fn event_params_to_legacy_v1_args(channel: &str, params: &Value) -> Vec<Value> {
    let canonical = canonical_remote_channel(channel);
    let channel = canonical.as_str();
    if let Value::Array(values) = params {
        return values.clone();
    }
    match channel {
        "pty:output" => vec![params["id"].clone(), params["data"].clone()],
        "pty:exit" => vec![params["id"].clone(), params["exitCode"].clone()],
        "pty:viewport-state" => vec![params["id"].clone(), params["state"].clone()],
        "claude:session-reset" => vec![params["sessionId"].clone()],
        "claude:message" => vec![params["sessionId"].clone(), params["message"].clone()],
        "claude:tool-use" => vec![params["sessionId"].clone(), params["toolCall"].clone()],
        "claude:tool-result" => vec![params["sessionId"].clone(), params["result"].clone()],
        "claude:stream" => vec![params["sessionId"].clone(), params["data"].clone()],
        "claude:result" => vec![params["sessionId"].clone(), params["result"].clone()],
        "claude:turn-end" => vec![params["sessionId"].clone(), params["payload"].clone()],
        "claude:error" => vec![params["sessionId"].clone(), params["error"].clone()],
        "claude:status" => vec![params["sessionId"].clone(), params["meta"].clone()],
        "claude:modeChange" => vec![params["sessionId"].clone(), params["mode"].clone()],
        "claude:history" => vec![
            params["sessionId"].clone(),
            params
                .get("items")
                .or_else(|| params.get("payload"))
                .cloned()
                .unwrap_or(Value::Null),
        ],
        "claude:resume-loading" => vec![
            params["sessionId"].clone(),
            params
                .get("loading")
                .or_else(|| params.get("payload"))
                .cloned()
                .unwrap_or(Value::Null),
        ],
        "claude:permission-request" | "claude:ask-user" => {
            vec![params["sessionId"].clone(), params["data"].clone()]
        }
        "claude:permission-resolved" | "claude:ask-user-resolved" => {
            vec![params["sessionId"].clone(), params["toolUseId"].clone()]
        }
        "claude:prompt-suggestion" => {
            vec![params["sessionId"].clone(), params["suggestion"].clone()]
        }
        "claude:worktree-info" => vec![params["sessionId"].clone(), params["payload"].clone()],
        "claude:rate-limit" => vec![params["sessionId"].clone(), params["info"].clone()],
        "fs:changed"
        | "profile:changed"
        | "workspace:detached"
        | "workspace:reattached"
        | "workspace:reload"
        | "runtime:changed"
        | "system:resume" => vec![params.clone()],
        _ => vec![params.clone()],
    }
}

pub fn legacy_v1_event_args_to_params(channel: &str, args: &[Value]) -> Value {
    let canonical = canonical_remote_channel(channel);
    match canonical.as_str() {
        "pty:output" => json!({
            "id": args.first().cloned().unwrap_or(Value::Null),
            "data": args.get(1).cloned().unwrap_or(Value::Null),
        }),
        "pty:exit" => json!({
            "id": args.first().cloned().unwrap_or(Value::Null),
            "exitCode": args.get(1).cloned().unwrap_or(Value::Null),
        }),
        "pty:viewport-state" => json!({
            "id": args.first().cloned().unwrap_or(Value::Null),
            "state": args.get(1).cloned().unwrap_or(Value::Null),
        }),
        "claude:session-reset" => json!({
            "sessionId": args.first().cloned().unwrap_or(Value::Null),
        }),
        "claude:message" => claude_event_params(args, "message"),
        "claude:tool-use" => claude_event_params(args, "toolCall"),
        "claude:tool-result" => claude_event_params(args, "result"),
        "claude:stream" => claude_event_params(args, "data"),
        "claude:result" => claude_event_params(args, "result"),
        "claude:turn-end" => claude_event_params(args, "payload"),
        "claude:error" => claude_event_params(args, "error"),
        "claude:status" => claude_event_params(args, "meta"),
        "claude:permission-request" => claude_event_params(args, "data"),
        "claude:permission-resolved" => claude_event_params(args, "toolUseId"),
        "claude:ask-user" => claude_event_params(args, "data"),
        "claude:ask-user-resolved" => claude_event_params(args, "toolUseId"),
        "claude:modeChange" => claude_event_params(args, "mode"),
        "claude:history" => claude_event_params(args, "items"),
        "claude:resume-loading" => claude_event_params(args, "loading"),
        "claude:prompt-suggestion" => claude_event_params(args, "suggestion"),
        "claude:worktree-info" => claude_event_params(args, "payload"),
        "claude:rate-limit" => claude_event_params(args, "info"),
        "fs:changed"
        | "profile:changed"
        | "workspace:detached"
        | "workspace:reattached"
        | "workspace:reload"
        | "runtime:changed"
        | "system:resume" => args.first().cloned().unwrap_or(Value::Null),
        _ => json!({ "args": args }),
    }
}

fn claude_event_params(args: &[Value], payload_key: &str) -> Value {
    let mut map = Map::new();
    map.insert(
        "sessionId".to_string(),
        args.first().cloned().unwrap_or(Value::Null),
    );
    map.insert(
        payload_key.to_string(),
        args.get(1).cloned().unwrap_or(Value::Null),
    );
    Value::Object(map)
}

pub fn is_proxied_remote_event(channel: &str) -> bool {
    let canonical = canonical_remote_channel(channel);
    matches!(
        canonical.as_str(),
        "pty:output"
            | "pty:exit"
            | "pty:viewport-state"
            | "claude:message"
            | "claude:tool-use"
            | "claude:tool-result"
            | "claude:stream"
            | "claude:result"
            | "claude:turn-end"
            | "claude:error"
            | "claude:status"
            | "claude:permission-request"
            | "claude:permission-resolved"
            | "claude:ask-user"
            | "claude:ask-user-resolved"
            | "claude:modeChange"
            | "claude:history"
            | "claude:resume-loading"
            | "claude:prompt-suggestion"
            | "claude:session-reset"
            | "claude:worktree-info"
            | "claude:rate-limit"
            // Host-owned account state. Carries no sessionId, so
            // event_owner_key_for_event yields None and it fans out to every
            // window on the client rather than one session's owner.
            | "claude:account-changed"
            // agent:-native, so it stays spelled that way here — see the
            // migrated-channel list in canonical_remote_channel. This entry was
            // correct all along; what broke it was canonicalization rewriting
            // agent:usage into a claude:usage that nothing publishes.
            | "agent:usage"
            | "fs:changed"
            | "profile:changed"
            | "workspace:detached"
            | "workspace:reattached"
            | "workspace:reload"
            | "runtime:changed"
            | "system:resume"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_protocols_with_legacy_default() {
        assert_eq!(
            negotiate_remote_protocol(&[]),
            Some(RemoteProtocol::LegacyV1)
        );
        assert_eq!(
            negotiate_remote_protocol(&[
                REMOTE_PROTOCOL_LEGACY_V1.to_string(),
                REMOTE_PROTOCOL_V2.to_string(),
            ]),
            Some(RemoteProtocol::V2)
        );
        assert_eq!(negotiate_remote_protocol(&["unknown".into()]), None);
        assert_eq!(RemoteProtocol::V2.as_str(), REMOTE_PROTOCOL_V2);
    }

    #[test]
    fn runtime_channels_keep_legacy_params_and_changed_events() {
        assert_eq!(
            legacy_v1_args_to_params("runtime:install", &[json!("claude")]),
            json!({ "tool": "claude" })
        );
        assert_eq!(
            legacy_v1_args_to_params("runtime:clear-managed", &[json!("codex")]),
            json!({ "tool": "codex" })
        );
        assert!(is_proxied_remote_event("runtime:changed"));
        assert_eq!(
            legacy_v1_event_args_to_params(
                "runtime:changed",
                &[json!({ "tool": "claude", "ok": true })]
            ),
            json!({ "tool": "claude", "ok": true })
        );
    }

    #[test]
    fn account_changes_reach_remote_clients() {
        // The host broadcasts this after applying a switch / removal / login so
        // other clients repaint instead of holding a stale account chip.
        assert!(is_proxied_remote_event("claude:account-changed"));
        // The whitelist is matched *after* canonicalization, so an entry only
        // works in its canonical spelling — listing "agent:account-changed"
        // instead would silently never match and drop the event.
        assert_eq!(
            canonical_remote_channel("agent:account-changed"),
            "claude:account-changed"
        );
        assert!(is_proxied_remote_event("agent:account-changed"));
    }

    // A hydrated profile index as the host holds it: `remoteToken` is the live
    // credential for ANOTHER machine, read back out of the keyring on every index
    // read, and it must not leave this host.
    fn profile_payload() -> Value {
        json!({
            "profiles": [
                {
                    "id": "default",
                    "name": "Default",
                    "type": "local",
                    "createdAt": 1,
                    "updatedAt": 2,
                },
                {
                    "id": "hyper",
                    "name": "Tail Hyper",
                    "type": "remote",
                    "remoteHost": "hyper.tail.ts.net",
                    "remotePort": 9876,
                    "remoteToken": "s3cr3t-host-token",
                    "remoteFingerprint": "AA:BB:CC",
                    "remoteProfileId": "default",
                    "remoteProfileName": "Hyper Default",
                    "createdAt": 3,
                    "updatedAt": 4,
                },
            ],
            "activeProfileIds": ["default"],
        })
    }

    #[test]
    fn profile_credentials_do_not_reach_a_remote_client() {
        let sanitized = strip_profile_secrets(&profile_payload());
        let raw = serde_json::to_string(&sanitized).expect("serializes");
        // Asserted against the whole serialized frame, not field by field: a field
        // check only covers the fields somebody remembered to name.
        assert!(!raw.contains("s3cr3t-host-token"), "token leaked: {raw}");
        assert!(!raw.contains("remoteToken"), "token key leaked: {raw}");
        assert!(!raw.contains("hyper.tail.ts.net"), "address leaked: {raw}");
        assert!(!raw.contains("AA:BB:CC"), "fingerprint leaked: {raw}");
    }

    #[test]
    fn sanitized_profiles_still_carry_what_a_client_renders() {
        let sanitized = strip_profile_secrets(&profile_payload());
        // activeProfileIds is not a profile field and must survive untouched, or the
        // client cannot tell which profile is live.
        assert_eq!(sanitized["activeProfileIds"], json!(["default"]));
        let remote = &sanitized["profiles"][1];
        assert_eq!(remote["id"], json!("hyper"));
        assert_eq!(remote["name"], json!("Tail Hyper"));
        assert_eq!(remote["type"], json!("remote"));
        assert_eq!(remote["remoteProfileName"], json!("Hyper Default"));
        assert_eq!(remote["createdAt"], json!(3));
        assert_eq!(remote["updatedAt"], json!(4));
        // Same field set the desktop's own remote list_profiles reader keeps, and a
        // superset of what BAT Mobile's normalizeProfiles whitelists, so stripping
        // costs no client-visible information.
        assert_eq!(sanitized["profiles"][0]["type"], json!("local"));
    }

    #[test]
    fn a_new_profile_field_is_absent_until_it_is_added_deliberately() {
        // The point of routing through RemoteProfileEntry rather than clearing known
        // fields: whatever gets added to ProfileEntry next does not reach a client
        // just because nobody remembered to clear it.
        let payload = json!({
            "profiles": [{ "id": "x", "name": "X", "type": "local", "someFutureSecret": "nope" }],
        });
        let raw = serde_json::to_string(&strip_profile_secrets(&payload)).expect("serializes");
        assert!(!raw.contains("someFutureSecret"), "unknown field kept: {raw}");
    }

    #[test]
    fn only_profile_events_are_rewritten() {
        // Channel-gated: workspace payloads have a `profiles` key of their own shape
        // and must pass through byte-identical.
        let workspace = json!({ "profiles": [{ "unrelated": "shape" }] });
        assert_eq!(
            remote_event_params_for_clients("workspace:reload", &workspace).as_ref(),
            &workspace
        );
        let payload = profile_payload();
        let sanitized = remote_event_params_for_clients("profile:changed", &payload);
        assert!(!serde_json::to_string(sanitized.as_ref())
            .expect("serializes")
            .contains("remoteToken"));
    }

    #[test]
    fn the_legacy_v1_args_carry_the_sanitized_payload_too() {
        // profile:changed folds the whole payload into args, so a v1 client reads
        // `args[0]`, not `params`. Sanitizing after the fold would clean the copy
        // nobody reads. This asserts the order the server actually uses.
        let payload = profile_payload();
        let sanitized = remote_event_params_for_clients("profile:changed", &payload);
        let args = event_params_to_legacy_v1_args("profile:changed", sanitized.as_ref());
        let raw = serde_json::to_string(&args).expect("serializes");
        assert!(!raw.contains("remoteToken"), "token leaked via v1 args: {raw}");
        assert_eq!(args[0]["profiles"][1]["id"], json!("hyper"));
    }

    // Stand-ins for certificate fingerprints. The real ones are 95 chars of
    // colon-separated uppercase hex (see remote_server's
    // token_and_fingerprint_shapes_match_remote_contract); nothing here depends on
    // the length, only on them being distinct strings.
    const HOST_A: &str = "AA:01";
    const HOST_B: &str = "BB:02";
    const HOST_C: &str = "CC:03";

    fn event_frame() -> Value {
        json!({ "type": "event", "channel": "agent:usage", "params": { "payload": {} } })
    }

    #[test]
    fn pre_relay_frames_read_as_never_relayed() {
        // Every frame in the existing protocol lacks the field, and must not be
        // mistaken for a malformed one.
        assert_eq!(remote_relay_path(&event_frame()), Ok(Vec::new()));
    }

    #[test]
    fn relay_stamps_the_first_hop_and_preserves_the_frame() {
        let relayed = relay_frame(&event_frame(), HOST_A).expect("first hop forwards");
        assert_eq!(relayed[REMOTE_RELAY_PATH_KEY], json!([HOST_A]));
        // The payload has to survive untouched; relaying adds provenance, it does
        // not reshape the frame.
        assert_eq!(relayed["type"], json!("event"));
        assert_eq!(relayed["channel"], json!("agent:usage"));
        assert_eq!(relayed["params"], json!({ "payload": {} }));
    }

    #[test]
    fn relay_breaks_the_two_desktop_ring() {
        // A and B each hold a remote profile pointing at the other, which is what
        // makes them a ring: A broadcasts, B's remote client receives it and
        // re-broadcasts, A's remote client receives it and would re-broadcast
        // again, forever. B's hop is legitimate; A's would close the ring.
        let from_a = event_frame();
        let at_b = relay_frame(&from_a, HOST_B).expect("B forwards A's event once");
        assert_eq!(at_b[REMOTE_RELAY_PATH_KEY], json!([HOST_B]));
        assert_eq!(relay_frame(&at_b, HOST_A), Err(RelayRefusal::HopLimit));
    }

    #[test]
    fn relay_refuses_to_revisit_a_host_already_in_the_path() {
        let seen_b = json!({ "type": "event", REMOTE_RELAY_PATH_KEY: [HOST_B] });
        assert_eq!(relay_frame(&seen_b, HOST_B), Err(RelayRefusal::Cycle));
        // Cycle is reported ahead of HopLimit when both apply: "this would loop" is
        // the more useful log line than "budget spent".
        let seen_b_and_c = json!({ "type": "event", REMOTE_RELAY_PATH_KEY: [HOST_B, HOST_C] });
        assert_eq!(relay_frame(&seen_b_and_c, HOST_B), Err(RelayRefusal::Cycle));
        assert_eq!(relay_frame(&seen_b_and_c, HOST_A), Err(RelayRefusal::HopLimit));
    }

    #[test]
    fn relay_bounds_a_self_connected_host_to_one_extra_pass() {
        // A host connected to itself is reachable — connect validation has no
        // self-check — so pin what actually happens rather than assume it cannot.
        // A originates the frame unstamped, so A's own client sees it once and the
        // re-broadcast is allowed; the pass after that is refused. Bounded, not
        // free: a connect-time self-check is what would make it zero.
        let originated = event_frame();
        let once = relay_frame(&originated, HOST_A).expect("first pass forwards");
        assert_eq!(relay_frame(&once, HOST_A), Err(RelayRefusal::Cycle));
    }

    #[test]
    fn relay_cycle_check_survives_a_recased_identity() {
        // A peer must not be able to walk past the cycle check by echoing a hop
        // back in different casing.
        let lowercased = json!({ "type": "event", REMOTE_RELAY_PATH_KEY: ["aa:01"] });
        assert_eq!(relay_frame(&lowercased, HOST_A), Err(RelayRefusal::Cycle));
        // ...and a lowercase identity is stamped in the normalised form, so the
        // next host compares against a consistent spelling.
        let stamped = relay_frame(&event_frame(), "aa:01").expect("forwards");
        assert_eq!(stamped[REMOTE_RELAY_PATH_KEY], json!([HOST_A]));
    }

    #[test]
    fn relay_fails_closed_on_anything_it_cannot_trust() {
        let cases = [
            json!({ "type": "event", REMOTE_RELAY_PATH_KEY: "not-an-array" }),
            json!({ "type": "event", REMOTE_RELAY_PATH_KEY: [42] }),
            json!({ "type": "event", REMOTE_RELAY_PATH_KEY: [""] }),
            json!({ "type": "event", REMOTE_RELAY_PATH_KEY: ["  "] }),
        ];
        for frame in cases {
            assert_eq!(
                relay_frame(&frame, HOST_A),
                Err(RelayRefusal::Malformed),
                "must refuse: {frame}"
            );
        }
        // An absurdly long path is a peer sending nonsense, not a topology.
        let long = json!({
            "type": "event",
            REMOTE_RELAY_PATH_KEY: (0..RELAY_PATH_SANITY_LIMIT + 1)
                .map(|i| json!(format!("FP:{i}")))
                .collect::<Vec<_>>(),
        });
        assert_eq!(relay_frame(&long, HOST_A), Err(RelayRefusal::Malformed));
        // A host with no identity cannot prove it is not already in the path.
        assert_eq!(relay_frame(&event_frame(), "   "), Err(RelayRefusal::Malformed));
        // A frame that is not an object has nowhere to carry provenance.
        assert_eq!(relay_frame(&json!("bare"), HOST_A), Err(RelayRefusal::Malformed));
    }

    #[test]
    fn usage_broadcast_reaches_remote_clients() {
        // Regression. `agent:usage` is the published topic AND the name the
        // renderer listens on, so it is agent:-native and must survive
        // canonicalization intact. It did not: the rewrite folded it to
        // `claude:usage`, a name nothing publishes or listens to, so the allowlist
        // entry could never match and every remote client silently missed the 150s
        // broadcast. The local webview was unaffected, which is why it went unseen.
        assert_eq!(canonical_remote_channel("agent:usage"), "agent:usage");
        assert!(is_proxied_remote_event("agent:usage"));
    }

    #[test]
    fn usage_snapshot_pull_is_reachable_under_both_channel_names() {
        // agent: is the target naming, so the new pull channel is agent:-native and
        // keeps its name through canonicalization.
        assert_eq!(
            canonical_remote_channel("agent:usage-snapshot"),
            "agent:usage-snapshot"
        );
        // BAT Mobile tries agent:usage-snapshot first and falls back to the legacy
        // claude: spelling, so that one has to reach the same host arm. Being
        // agent:-native the two no longer collapse, hence both are registered.
        assert_eq!(
            canonical_remote_channel("claude:usage-snapshot"),
            "claude:usage-snapshot"
        );
        assert_eq!(
            remote_agent_channel("claude:usage-snapshot"),
            "agent:usage-snapshot"
        );
        // A no-arg read, under either protocol and either spelling.
        for channel in ["agent:usage-snapshot", "claude:usage-snapshot"] {
            assert_eq!(legacy_v1_args_to_params(channel, &[]), Value::Null);
            // Registered with an empty key list, so a stray positional arg is
            // dropped instead of falling through to the `_` arm and becoming the
            // params.
            assert_eq!(
                legacy_v1_args_to_params(channel, &[json!("stray")]),
                json!({}),
                "{channel} must ignore positional args"
            );
            // The pull is an invoke, not an event: it must not be confused with the
            // broadcast, which keeps its own single-provider shape.
            assert!(!is_proxied_remote_event(channel));
        }
    }

    #[test]
    fn quick_open_channels_keep_remote_search_and_image_params() {
        assert_eq!(
            legacy_v1_args_to_params("fs:search", &[json!("/repo"), json!("main"), json!(true)],),
            json!({ "dirPath": "/repo", "query": "main", "filesOnly": true })
        );
        assert_eq!(
            legacy_v1_args_to_params("image:read-as-data-url", &[json!("/repo/logo.png")]),
            json!({ "filePath": "/repo/logo.png" })
        );
    }

    #[test]
    fn negotiates_compression_by_explicit_opt_in() {
        assert_eq!(negotiate_remote_compression(&[]), RemoteCompression::None);
        assert_eq!(
            negotiate_remote_compression(&[REMOTE_COMPRESSION_GZIP.to_string()]),
            RemoteCompression::Gzip
        );
        assert_eq!(
            negotiate_remote_compression(&[REMOTE_COMPRESSION_NONE.to_string()]),
            RemoteCompression::None
        );
        assert_eq!(RemoteCompression::Gzip.as_str(), REMOTE_COMPRESSION_GZIP);
    }

    #[test]
    fn remote_frame_encoding_uses_text_when_uncompressed() {
        let frame = json!({ "type": "ping", "id": "1" });
        let payload = encode_remote_frame(&frame, RemoteCompression::None).unwrap();
        let RemoteFramePayload::Text(text) = payload else {
            panic!("expected text frame");
        };
        assert_eq!(decode_remote_text_frame(&text).unwrap(), frame);
    }

    #[test]
    fn remote_frame_encoding_uses_gzip_binary_when_enabled() {
        let frame = json!({
            "type": "event",
            "channel": "agent:history",
            "params": {
                "items": vec![json!({ "content": "hello world" }); 32],
            },
        });
        let payload = encode_remote_frame(&frame, RemoteCompression::Gzip).unwrap();
        let RemoteFramePayload::Binary(bytes) = payload else {
            panic!("expected binary frame");
        };
        assert_eq!(decode_remote_binary_frame(&bytes).unwrap(), frame);
        assert!(decode_remote_binary_frame(b"not-bat").is_err());
    }

    #[test]
    fn maps_legacy_claude_args_to_named_params() {
        assert_eq!(
            legacy_v1_args_to_params(
                "claude:start-session",
                &[json!("s1"), json!({ "cwd": "/repo" })]
            ),
            json!({ "sessionId": "s1", "options": { "cwd": "/repo" } })
        );
        assert_eq!(
            legacy_v1_args_to_params(
                "claude:send-message",
                &[json!("s1"), json!("hi"), json!(["img"]), json!(4000)]
            ),
            json!({
                "sessionId": "s1",
                "prompt": "hi",
                "images": ["img"],
                "autoCompactWindow": 4000,
            })
        );
        assert_eq!(
            legacy_v1_args_to_params(
                "claude:send-message",
                &[
                    json!("s1"),
                    json!("hi"),
                    json!([]),
                    Value::Null,
                    json!("user-1"),
                    json!("hi"),
                    json!(true),
                ]
            ),
            json!({
                "sessionId": "s1",
                "prompt": "hi",
                "images": [],
                "autoCompactWindow": null,
                "clientMessageId": "user-1",
                "displayPrompt": "hi",
                "suppressUserEcho": true,
            })
        );
        // resume-session carries workspace identity in trailing positional
        // args (13/14); they must land in the rebuilt options object.
        assert_eq!(
            legacy_v1_args_to_params(
                "claude:resume-session",
                &[
                    json!("s1"),
                    json!("sdk1"),
                    json!("/repo"),
                    Value::Null, // model
                    Value::Null, // apiVersion
                    Value::Null, // useWorktree
                    Value::Null, // worktreePath
                    Value::Null, // worktreeBranch
                    Value::Null, // agentPreset
                    Value::Null, // codexSandboxMode
                    Value::Null, // codexApprovalPolicy
                    Value::Null, // permissionMode
                    Value::Null, // effort
                    json!("ws-7"),
                    json!("Plan 5.3.7"),
                ]
            ),
            json!({
                "sessionId": "s1",
                "sdkSessionId": "sdk1",
                "options": {
                    "cwd": "/repo",
                    "workspaceId": "ws-7",
                    "workspaceName": "Plan 5.3.7",
                },
            })
        );
        assert_eq!(
            legacy_v1_args_to_params(
                "claude:resume-session",
                &[
                    json!("s1"),
                    json!("sdk1"),
                    json!("/repo"),
                    Value::Null, // model
                    Value::Null, // apiVersion
                    Value::Null, // useWorktree
                    Value::Null, // worktreePath
                    Value::Null, // worktreeBranch
                    Value::Null, // agentPreset
                    Value::Null, // codexSandboxMode
                    Value::Null, // codexApprovalPolicy
                    Value::Null, // permissionMode
                    json!("xhigh"),
                    json!(true),
                    json!("ws-7"),
                    json!("Plan 5.3.7"),
                ]
            ),
            json!({
                "sessionId": "s1",
                "sdkSessionId": "sdk1",
                "options": {
                    "cwd": "/repo",
                    "effort": "xhigh",
                    "ultracode": true,
                    "workspaceId": "ws-7",
                    "workspaceName": "Plan 5.3.7",
                },
            })
        );
    }

    #[test]
    fn maps_remote_login_ids_without_breaking_legacy_calls() {
        assert_eq!(
            legacy_v1_args_to_params(
                "claude:auth-login-submit-code",
                &[json!("auth-code"), json!("claude-login-id")],
            ),
            json!({ "code": "auth-code", "loginId": "claude-login-id" })
        );
        assert_eq!(
            legacy_v1_args_to_params("codex:auth-login-device-poll", &[json!("codex-login-id")],),
            json!({ "loginId": "codex-login-id" })
        );
        assert_eq!(
            legacy_v1_args_to_params("codex:auth-login-device-poll", &[]),
            Value::Null
        );
    }

    #[test]
    fn maps_legacy_claude_metadata_args_to_named_params() {
        assert_eq!(
            legacy_v1_args_to_params("claude:list-sessions", &[json!("C:/repo"), json!("codex")]),
            json!({ "cwd": "C:/repo", "agentKind": "codex" })
        );
        assert_eq!(
            legacy_v1_args_to_params(
                "claude:prepare-cli-session",
                &[
                    json!("term-1"),
                    json!("workspace-1"),
                    json!("C:/repo"),
                    json!("claude-agent"),
                    json!("existing-session"),
                ],
            ),
            json!({
                "terminalId": "term-1",
                "workspaceId": "workspace-1",
                "cwd": "C:/repo",
                "agentPreset": "claude-agent",
                "currentSessionId": "existing-session",
            })
        );
        assert_eq!(
            legacy_v1_args_to_params("claude:scan-skills", &[json!("C:/repo")]),
            json!({ "cwd": "C:/repo" })
        );
        assert_eq!(
            legacy_v1_args_to_params("claude:account-switch", &[json!("acct-1")]),
            json!({ "accountId": "acct-1" })
        );
    }

    #[test]
    fn maps_legacy_workspace_args_to_named_params() {
        assert_eq!(
            legacy_v1_args_to_params("workspace:load", &[json!("hyper")]),
            json!({ "profileId": "hyper" })
        );
        assert_eq!(
            legacy_v1_args_to_params("workspace:load", &[json!("hyper"), json!("win-2")]),
            json!({ "profileId": "hyper", "windowId": "win-2" })
        );
        assert_eq!(
            legacy_v1_args_to_params(
                "workspace:save",
                &[json!("hyper"), json!("{\"workspaces\":[]}")]
            ),
            json!({ "profileId": "hyper", "data": "{\"workspaces\":[]}" })
        );
        assert_eq!(
            legacy_v1_args_to_params(
                "workspace:save",
                &[json!("hyper"), json!("{\"workspaces\":[]}"), json!("win-2")]
            ),
            json!({ "profileId": "hyper", "data": "{\"workspaces\":[]}", "windowId": "win-2" })
        );
        assert_eq!(
            legacy_v1_args_to_params("app:new-window", &[json!("hyper")]),
            json!({ "profileId": "hyper" })
        );
    }

    #[test]
    fn maps_legacy_pty_args_to_named_params() {
        assert_eq!(
            legacy_v1_args_to_params("pty:write", &[json!("term-1"), json!("hello")]),
            json!({ "id": "term-1", "data": "hello" })
        );
        assert_eq!(
            legacy_v1_args_to_params("pty:resize", &[json!("term-1"), json!(120), json!(36)]),
            json!({ "id": "term-1", "cols": 120, "rows": 36 })
        );
        assert_eq!(
            legacy_v1_args_to_params("pty:get-viewport-state", &[json!("term-1")]),
            json!({ "id": "term-1" })
        );
        assert_eq!(
            legacy_v1_args_to_params(
                "pty:set-viewport-mode",
                &[
                    json!("term-1"),
                    json!("mobile"),
                    json!({ "cols": 56, "rows": 24, "source": "mobile" })
                ]
            ),
            json!({
                "id": "term-1",
                "mode": "mobile",
                "options": { "cols": 56, "rows": 24, "source": "mobile" }
            })
        );
        assert_eq!(
            legacy_v1_args_to_params(
                "pty:set-viewport-size",
                &[json!("term-1"), json!(56), json!(24), json!("mobile")]
            ),
            json!({ "id": "term-1", "cols": 56, "rows": 24, "source": "mobile" })
        );
    }

    #[test]
    fn v2_uses_named_params_when_present() {
        assert_eq!(
            invoke_params_for_protocol(
                RemoteProtocol::V2,
                "claude:send-message",
                &[json!("legacy")],
                Some(json!({ "sessionId": "v2", "prompt": "hi" })),
            ),
            json!({ "sessionId": "v2", "prompt": "hi" })
        );
    }

    #[test]
    fn agent_channels_alias_existing_claude_runtime_channels() {
        assert_eq!(
            canonical_remote_channel("agent:send-message"),
            "claude:send-message"
        );
        assert_eq!(
            remote_agent_channel("claude:send-message"),
            "agent:send-message"
        );
        assert_eq!(
            canonical_remote_channel("agent:list-presets"),
            "agent:list-presets"
        );
        assert_eq!(
            canonical_remote_channel("agent:get-supported-session-types"),
            "agent:get-supported-session-types"
        );
        assert_eq!(
            legacy_v1_args_to_params("agent:get-supported-session-types", &[]),
            Value::Null
        );
        assert_eq!(
            legacy_v1_args_to_params("agent:get-supported-codex-sandbox-modes", &[json!("s1")]),
            json!({ "sessionId": "s1" })
        );
        assert_eq!(
            invoke_params_for_protocol(
                RemoteProtocol::V2,
                "agent:send-message",
                &[json!("legacy")],
                Some(json!({ "sessionId": "v2", "prompt": "hi" })),
            ),
            json!({ "sessionId": "v2", "prompt": "hi" })
        );
    }

    #[test]
    fn maps_app_version_without_params() {
        assert_eq!(
            legacy_v1_args_to_params("app:get-version", &[]),
            Value::Null
        );
        assert_eq!(
            invoke_params_for_protocol(RemoteProtocol::V2, "app:get-version", &[], None),
            Value::Null
        );
    }

    #[test]
    fn normalizes_remote_invoke_into_host_dispatch_request() {
        let dispatch = normalize_remote_invoke(RemoteInvokeRequest {
            protocol: RemoteProtocol::LegacyV1,
            channel: "agent:send-message".into(),
            args: vec![json!("s1"), json!("hi")],
            params: None,
            window_id: Some("win-1".into()),
            profile_id: Some("default".into()),
        });
        assert_eq!(dispatch.channel, "claude:send-message");
        assert_eq!(dispatch.window_id.as_deref(), Some("win-1"));
        assert_eq!(dispatch.profile_id.as_deref(), Some("default"));
        assert!(dispatch.is_remote);
        assert_eq!(
            dispatch.params,
            json!({ "sessionId": "s1", "prompt": "hi" })
        );
    }

    #[test]
    fn maps_named_events_to_legacy_args() {
        assert_eq!(
            event_params_to_legacy_v1_args(
                "claude:message",
                &json!({ "sessionId": "s1", "message": { "role": "assistant" } }),
            ),
            vec![json!("s1"), json!({ "role": "assistant" })]
        );
        assert_eq!(
            event_params_to_legacy_v1_args(
                "pty:viewport-state",
                &json!({
                    "id": "term-1",
                    "state": { "mode": "mobile", "cols": 56, "rows": 24 }
                }),
            ),
            vec![
                json!("term-1"),
                json!({ "mode": "mobile", "cols": 56, "rows": 24 })
            ]
        );
        assert_eq!(
            event_params_to_legacy_v1_args(
                "claude:history",
                &json!({ "sessionId": "s1", "items": [{ "role": "user" }] }),
            ),
            vec![json!("s1"), json!([{ "role": "user" }])]
        );
        assert_eq!(
            event_params_to_legacy_v1_args(
                "claude:history",
                &json!({ "sessionId": "s1", "payload": [{ "role": "assistant" }] }),
            ),
            vec![json!("s1"), json!([{ "role": "assistant" }])]
        );
        assert_eq!(
            event_params_to_legacy_v1_args(
                "claude:resume-loading",
                &json!({ "sessionId": "s1", "loading": false }),
            ),
            vec![json!("s1"), json!(false)]
        );
        assert_eq!(
            event_params_to_legacy_v1_args(
                "claude:resume-loading",
                &json!({ "sessionId": "s1", "payload": true }),
            ),
            vec![json!("s1"), json!(true)]
        );
        assert_eq!(
            event_params_to_legacy_v1_args("workspace:reload", &json!("{\"workspaces\":[]}")),
            vec![json!("{\"workspaces\":[]}")]
        );
    }

    #[test]
    fn maps_legacy_event_args_to_named_params() {
        assert_eq!(
            legacy_v1_event_args_to_params(
                "claude:message",
                &[json!("s1"), json!({ "role": "assistant" })],
            ),
            json!({ "sessionId": "s1", "message": { "role": "assistant" } })
        );
        assert_eq!(
            legacy_v1_event_args_to_params(
                "pty:viewport-state",
                &[
                    json!("term-1"),
                    json!({ "mode": "desktop", "cols": 120, "rows": 36 })
                ],
            ),
            json!({
                "id": "term-1",
                "state": { "mode": "desktop", "cols": 120, "rows": 36 }
            })
        );
        assert_eq!(
            legacy_v1_event_args_to_params("workspace:reload", &[json!("{\"workspaces\":[]}")]),
            json!("{\"workspaces\":[]}")
        );
        assert!(is_proxied_remote_event("claude:stream"));
        assert!(!is_proxied_remote_event("settings:load"));
    }
}
