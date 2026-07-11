use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
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

pub fn canonical_remote_channel(channel: &str) -> String {
    let Some(rest) = channel.strip_prefix("agent:") else {
        return channel.to_string();
    };
    if rest == "list-presets" || rest == "get-supported-session-types" {
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
