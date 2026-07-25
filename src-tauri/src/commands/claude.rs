// claude.* — Rust-owned runtime routing for Claude-compatible agent sessions.
//
// Commands keep the renderer-facing IPC stable, then route through Rust to the
// native Codex app-server, local native helpers, or the Node sidecar compatibility
// bridge. Keep runtime ownership decisions in ClaudeRuntimeRouter so local Tauri
// calls and remote-server fallbacks do not grow separate compatibility rules.
//
// MVP commands:
//   claude_ping            — round-trip probe used by tests.
//   claude_auth_status     — returns null until accounts are wired through.
//   claude_account_list    — reads Rust account_store index.
//
// Each one resolves the SpawnConfig from the AppHandle so the bridge can
// find both `node` on PATH and the bundled sidecar script. Failures bubble
// up as { message } strings to the renderer.

use crate::account_store;
use crate::app_data;
use crate::codex_app_server::{
    active_codex_home, is_codex_agent_preset_id, should_handle_codex, CodexAppServerState,
};
use crate::commands::app as app_cmd;
use crate::commands::notification as notification_cmd;
use crate::commands::profile as profile_cmd;
use crate::commands::worktree as worktree_cmd;
use crate::event_hub::publish_runtime_event;
use crate::host_context::HostContext;
use crate::remote_client::RustRemoteClientState;
use crate::remote_core::remote_agent_channel;
use crate::sidecar::{BridgeError, SidecarState};
use crate::subprocess::hide_console_window;
#[cfg(feature = "desktop")]
use crate::window_registry;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
// Long-running calls (startSession can boot the agent SDK, sendMessage may
// stream for minutes). 5 minutes is generous but bounded — callers that
// need true cancellation should issue abortSession through a separate
// invoke rather than relying on this timeout.
const SESSION_TIMEOUT: Duration = Duration::from_secs(300);
const SESSION_LIST_LIMIT: usize = 50;
const PREVIEW_LINE_LIMIT: usize = 200;
const PREVIEW_CHARS: usize = 120;
const AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_LOGIN_TIMEOUT: Duration = Duration::from_secs(180);
const WORKTREE_DIFF_MAX_BYTES: usize = 10 * 1024 * 1024;
const CLAUDE_CLI_HOOK_SCRIPT: &str = r#"import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : ''
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { raw += chunk })
process.stdin.on('end', () => {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {}
    const sessionId = input.session_id || input.sessionId || ''
    if (!sessionId) process.exit(0)
    const eventsPath = arg('--events')
    if (!eventsPath) process.exit(0)
    mkdirSync(dirname(eventsPath), { recursive: true })
    appendFileSync(eventsPath, JSON.stringify({
      terminalId: arg('--terminal-id'),
      workspaceId: arg('--workspace-id'),
      agentPreset: arg('--agent-preset'),
      sessionId,
      cwd: input.cwd || arg('--cwd') || process.env.CLAUDE_PROJECT_DIR || '',
      source: input.source || '',
      transcriptPath: input.transcript_path || input.transcriptPath || '',
      hookEventName: input.hook_event_name || input.hookEventName || '',
      timestamp: Date.now()
    }) + '\n', 'utf8')
  } catch {
    process.exit(0)
  }
})
"#;

fn bat_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn claude_debug_log(app: &HostContext, message: impl AsRef<str>) {
    if bat_debug_enabled() {
        app_cmd::log_tauri(app, message.as_ref());
    }
}

fn call(
    app: &HostContext,
    state: &SidecarState,
    method: &str,
    params: Value,
) -> Result<Value, BridgeError> {
    call_with_timeout(app, state, method, params, DEFAULT_TIMEOUT)
}

fn call_with_timeout(
    app: &HostContext,
    state: &SidecarState,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, BridgeError> {
    let cfg = app.sidecar_spawn_config()?;
    let sink = app.sidecar_emit_sink();
    state.call_with_emit(&cfg, Some(sink), method, params, timeout)
}

#[cfg(feature = "desktop")]
async fn call_blocking(
    app: AppHandle,
    state: State<'_, SidecarState>,
    method: &'static str,
    params: Value,
) -> Result<Value, BridgeError> {
    call_with_timeout_blocking(app, state, method, params, DEFAULT_TIMEOUT).await
}

#[cfg(feature = "desktop")]
fn is_remote_profile_window(app: &HostContext, window: &WebviewWindow) -> bool {
    let Some(profile_id) = window_registry::profile_id_for_window(app.app(), window.label()) else {
        return false;
    };
    profile_cmd::profile_get(app.app().clone(), profile_id)
        .map(|profile| profile.kind == "remote")
        .unwrap_or(false)
}

#[cfg(feature = "desktop")]
async fn remote_invoke_for_window(
    app: &HostContext,
    _state: &SidecarState,
    window: &WebviewWindow,
    channel: &'static str,
    args: Vec<Value>,
    timeout: Duration,
) -> Option<Result<Value, BridgeError>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>();
    let window_label = window.label().to_string();
    let remote_channel = remote_agent_channel(channel);
    let error_channel = remote_channel.clone();
    let result = crate::async_rt::spawn_blocking(move || {
        remote_client
            .invoke(&window_label, &remote_channel, args, timeout)
            .map_err(BridgeError::from)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("remote.invoke {error_channel} worker failed: {err}"),
    });
    Some(match result {
        Ok(value) => value,
        Err(err) => Err(err),
    })
}

fn option_field(options: &Option<Value>, key: &str) -> Value {
    options
        .as_ref()
        .and_then(|value| value.get(key))
        .cloned()
        .unwrap_or(Value::Null)
}

fn app_data_dir(app: &HostContext) -> Result<PathBuf, BridgeError> {
    app.data_dir().map_err(|err| BridgeError {
        message: format!("could not resolve app data dir: {err}"),
    })
}

fn account_error(err: impl std::fmt::Display) -> BridgeError {
    BridgeError {
        message: err.to_string(),
    }
}

fn claude_sdk_package_name(target_os: &str, arch: &str) -> Option<&'static str> {
    match (target_os, arch) {
        ("windows", "x86_64") => Some("claude-agent-sdk-win32-x64"),
        ("windows", "aarch64") => Some("claude-agent-sdk-win32-arm64"),
        ("macos", "x86_64") => Some("claude-agent-sdk-darwin-x64"),
        ("macos", "aarch64") => Some("claude-agent-sdk-darwin-arm64"),
        ("linux", "x86_64") => Some("claude-agent-sdk-linux-x64"),
        ("linux", "aarch64") => Some("claude-agent-sdk-linux-arm64"),
        _ => None,
    }
}

fn claude_runtime_platform_dir(target_os: &str, arch: &str) -> Option<&'static str> {
    match (target_os, arch) {
        ("windows", "x86_64") => Some("win32-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

fn claude_exe_name(target_os: &str) -> &'static str {
    if target_os == "windows" {
        "claude.exe"
    } else {
        "claude"
    }
}

fn find_bundled_claude_cli_in_base(
    base_dir: &Path,
    target_os: &str,
    arch: &str,
) -> Option<PathBuf> {
    let package = claude_sdk_package_name(target_os, arch)?;
    let candidate = base_dir
        .join("node-sidecar")
        .join("node_modules")
        .join("@anthropic-ai")
        .join(package)
        .join(claude_exe_name(target_os));
    candidate.is_file().then_some(candidate)
}

fn managed_claude_cli_path(data_dir: &Path, target_os: &str, arch: &str) -> Option<PathBuf> {
    Some(
        data_dir
            .join("runtimes")
            .join("claude-agent-sdk")
            .join(crate::runtime_catalog::claude_version())
            .join(claude_runtime_platform_dir(target_os, arch)?)
            .join(claude_exe_name(target_os)),
    )
}

fn find_managed_claude_cli(app: &HostContext, target_os: &str, arch: &str) -> Option<PathBuf> {
    let candidate = managed_claude_cli_path(&app_data_dir(app).ok()?, target_os, arch)?;
    (candidate.is_file() && claude_cli_version_check(&candidate)).then_some(candidate)
}

fn compressed_claude_cli_cache_key(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_string().as_bytes());
    hasher.update(modified.to_string().as_bytes());
    Some(format!("{:x}", hasher.finalize())[..16].to_string())
}

fn extract_compressed_claude_cli(
    app: &HostContext,
    compressed_path: &Path,
    target_os: &str,
) -> Option<PathBuf> {
    let key = compressed_claude_cli_cache_key(compressed_path)?;
    let out_dir = app_data_dir(app)
        .ok()?
        .join("bin")
        .join("claude-agent-sdk")
        .join(key);
    let out_path = out_dir.join(claude_exe_name(target_os));
    if out_path.is_file() {
        #[cfg(unix)]
        {
            let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(0o700));
        }
        return Some(out_path);
    }
    let bytes = fs::read(compressed_path).ok()?;
    let mut decoder = GzDecoder::new(&bytes[..]);
    let mut decoded = Vec::new();
    decoder.read_to_end(&mut decoded).ok()?;
    fs::create_dir_all(&out_dir).ok()?;
    fs::write(&out_path, decoded).ok()?;
    #[cfg(unix)]
    {
        fs::set_permissions(&out_path, fs::Permissions::from_mode(0o700)).ok()?;
    }
    Some(out_path)
}

fn find_packaged_claude_cli_in_base(
    app: &HostContext,
    base_dir: &Path,
    target_os: &str,
    arch: &str,
) -> Option<PathBuf> {
    if let Some(candidate) = find_bundled_claude_cli_in_base(base_dir, target_os, arch) {
        return Some(candidate);
    }
    let package = claude_sdk_package_name(target_os, arch)?;
    let compressed_candidate = base_dir
        .join("node-sidecar")
        .join("node_modules")
        .join("@anthropic-ai")
        .join(package)
        .join(format!("{}.gz", claude_exe_name(target_os)));
    compressed_candidate
        .is_file()
        .then(|| extract_compressed_claude_cli(app, &compressed_candidate, target_os))
        .flatten()
}

fn find_claude_cli_on_path(
    path_env: Option<&str>,
    pathext_env: Option<&str>,
    target_os: &str,
) -> Option<PathBuf> {
    let path_env = path_env?;
    let exts = if target_os == "windows" {
        pathext_env
            .unwrap_or(".COM;.EXE;.BAT;.CMD")
            .split(';')
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(path_env).find_map(|dir| {
        exts.iter().find_map(|ext| {
            let candidate = dir.join(format!("claude{ext}"));
            candidate.is_file().then_some(candidate)
        })
    })
}

fn find_claude_cli_in_dirs(
    dirs: impl IntoIterator<Item = PathBuf>,
    pathext_env: Option<&str>,
    target_os: &str,
) -> Option<PathBuf> {
    let exts = if target_os == "windows" {
        pathext_env
            .unwrap_or(".COM;.EXE;.BAT;.CMD")
            .split(';')
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };
    dirs.into_iter().find_map(|dir| {
        exts.iter().find_map(|ext| {
            let candidate = dir.join(format!("claude{ext}"));
            candidate.is_file().then_some(candidate)
        })
    })
}

fn common_claude_dirs(target_os: &str) -> Vec<PathBuf> {
    match target_os {
        "macos" => vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ],
        "linux" => vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ],
        _ => Vec::new(),
    }
}

fn claude_cli_version_check(candidate: &Path) -> bool {
    let mut command = Command::new(candidate);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() >= Duration::from_secs(5) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn resolve_system_claude_cli_path(target_os: &str) -> Option<PathBuf> {
    if let Some(candidate) = find_claude_cli_on_path(
        std::env::var("PATH").ok().as_deref(),
        std::env::var("PATHEXT").ok().as_deref(),
        target_os,
    ) {
        if claude_cli_version_check(&candidate) {
            return Some(candidate);
        }
    }
    find_claude_cli_in_dirs(
        common_claude_dirs(target_os),
        std::env::var("PATHEXT").ok().as_deref(),
        target_os,
    )
    .filter(|candidate| claude_cli_version_check(candidate))
}

pub(crate) fn resolve_claude_cli_path(app: &HostContext) -> String {
    if let Ok(override_path) = std::env::var("BAT_SIDECAR_CLAUDE_BIN") {
        if !override_path.trim().is_empty() {
            return override_path;
        }
    }
    let target_os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    if let Some(candidate) = find_managed_claude_cli(app, target_os, arch) {
        return candidate.to_string_lossy().to_string();
    }
    if let Some(candidate) = resolve_system_claude_cli_path(target_os) {
        return candidate.to_string_lossy().to_string();
    }
    // Bundled-resource lookup is a desktop packaging concept only.
    #[cfg(feature = "desktop")]
    if let Ok(resource_dir) = app.app().path().resource_dir() {
        if let Some(candidate) =
            find_packaged_claude_cli_in_base(app, &resource_dir, target_os, arch)
        {
            return candidate.to_string_lossy().to_string();
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(candidate) = find_packaged_claude_cli_in_base(app, &cwd, target_os, arch) {
            return candidate.to_string_lossy().to_string();
        }
    }
    String::new()
}

fn build_claude_cli_command(cli_path: &str, args: &[&str]) -> Command {
    if cfg!(windows) {
        let ext = Path::new(cli_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if matches!(ext.as_deref(), Some("cmd") | Some("bat")) {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(cli_path).args(args);
            hide_console_window(&mut command);
            return command;
        }
    }
    let mut command = Command::new(cli_path);
    command.args(args);
    hide_console_window(&mut command);
    command
}

fn run_claude_cli_native(
    app: &HostContext,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let cli_path = resolve_claude_cli_path(app);
    if cli_path.trim().is_empty() {
        return Err("Claude CLI not found".to_string());
    }
    let mut child = build_claude_cli_command(&cli_path, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| err.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(status.to_string());
                }
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                return Ok(stdout);
            }
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Claude CLI timed out".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => return Err(err.to_string()),
        }
    }
}

fn parse_auth_status_stdout(stdout: &str) -> Value {
    serde_json::from_str::<Value>(stdout).unwrap_or(Value::Null)
}

pub(crate) fn fetch_auth_status_native(app: &HostContext) -> Value {
    run_claude_cli_native(app, &["auth", "status"], AUTH_STATUS_TIMEOUT)
        .map(|stdout| parse_auth_status_stdout(&stdout))
        .unwrap_or(Value::Null)
}

pub(crate) fn account_info_from_auth_status(value: &Value) -> Value {
    let email = value.get("email").and_then(Value::as_str);
    let subscription_type = value.get("subscriptionType").and_then(Value::as_str);
    if email.is_none() && subscription_type.is_none() {
        return Value::Null;
    }
    let mut info = serde_json::Map::new();
    if let Some(email) = email {
        info.insert("email".to_string(), Value::String(email.to_string()));
    }
    if let Some(subscription_type) = subscription_type {
        info.insert(
            "subscriptionType".to_string(),
            Value::String(subscription_type.to_string()),
        );
    }
    Value::Object(info)
}

pub(crate) fn auth_login_native(app: &HostContext) -> Value {
    match run_claude_cli_native(app, &["auth", "login"], AUTH_LOGIN_TIMEOUT) {
        Ok(_) => json!({ "success": true }),
        Err(err) => json!({ "success": false, "error": err }),
    }
}

pub(crate) fn auth_logout_native(app: &HostContext) -> Value {
    match run_claude_cli_native(app, &["auth", "logout"], AUTH_STATUS_TIMEOUT) {
        Ok(_) => json!({ "success": true }),
        Err(err) => json!({ "success": false, "error": err }),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillScanEntry {
    name: String,
    description: String,
    scope: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionListEntry {
    sdk_session_id: String,
    timestamp: u128,
    preview: String,
    message_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ClaudeCliSessionEvent {
    #[serde(default)]
    terminal_id: String,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    agent_preset: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    transcript_path: String,
    #[serde(default)]
    timestamp: Option<u128>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeCliPrepareSessionResult {
    session_id: String,
    launch_mode: String,
    settings_path: String,
    events_path: String,
    hook_script_path: String,
    cli_path: String,
    node_path: String,
    source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SlashCommandEntry {
    name: String,
    description: String,
    argument_hint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentScanEntry {
    name: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn system_time_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn encode_claude_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn claude_project_dir_candidates(projects_dir: &Path, cwd: &str) -> Vec<PathBuf> {
    let encoded = encode_claude_project_dir(cwd);
    let mut candidates = vec![projects_dir.join(&encoded)];
    if cfg!(windows) && !encoded.is_empty() {
        let mut chars = encoded.chars();
        if let Some(first) = chars.next() {
            let rest = chars.as_str();
            let lower = format!("{}{}", first.to_ascii_lowercase(), rest);
            let upper = format!("{}{}", first.to_ascii_uppercase(), rest);
            if lower != encoded {
                candidates.push(projects_dir.join(lower));
            }
            if upper != encoded {
                candidates.push(projects_dir.join(upper));
            }
        }
    }
    candidates
}

fn safe_file_segment(value: &str) -> String {
    let safe = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .take(120)
        .collect::<String>();
    if safe.is_empty() {
        "terminal".into()
    } else {
        safe
    }
}

fn generate_uuid_v4() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (idx, byte) in bytes.iter().enumerate() {
        if matches!(idx, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn is_safe_cli_session_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 128
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
}

fn write_if_changed(path: &Path, text: &str) -> Result<(), BridgeError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::read_to_string(path)
        .map(|existing| existing == text)
        .unwrap_or(false)
    {
        return Ok(());
    }
    fs::write(path, text)?;
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn strip_windows_verbatim_prefix(value: &str) -> String {
    let forward = value.replace('\\', "/");
    if forward.len() >= 6
        && forward[..4].eq_ignore_ascii_case("//?/")
        && forward.as_bytes()[5] == b':'
    {
        return forward[4..].to_string();
    }
    if forward.len() >= 10 && forward[..8].eq_ignore_ascii_case("//?/UNC/") {
        return format!("//{}", &forward[8..]);
    }
    forward
}

fn drive_letter_mount_path(windows_path: &str, mount_root: &str) -> Option<String> {
    let forward = strip_windows_verbatim_prefix(windows_path);
    let bytes = forward.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' || bytes[2] != b'/' || !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let rest = &forward[2..];
    if mount_root.is_empty() {
        Some(format!("/{drive}{rest}"))
    } else {
        Some(format!("{mount_root}/{drive}{rest}"))
    }
}

fn build_claude_cli_hook_command(
    node_path: &Path,
    hook_script_path: &Path,
    events_path: &Path,
    terminal_id: &str,
    workspace_id: &str,
    agent_preset: &str,
    cwd: &str,
) -> String {
    let node_path_text = node_path.to_string_lossy().to_string();
    let node_forward = strip_windows_verbatim_prefix(&node_path_text);
    let args = [
        hook_script_path.to_string_lossy().to_string(),
        "--events".into(),
        events_path.to_string_lossy().to_string(),
        "--terminal-id".into(),
        terminal_id.into(),
        "--workspace-id".into(),
        workspace_id.into(),
        "--agent-preset".into(),
        agent_preset.into(),
        "--cwd".into(),
        cwd.into(),
    ];
    let args_text = args
        .iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");

    let Some(wsl_node_path) = drive_letter_mount_path(&node_path_text, "/mnt") else {
        return format!("{} {args_text}", shell_quote(&node_path_text));
    };
    let git_bash_node_path =
        drive_letter_mount_path(&node_path_text, "").unwrap_or_else(|| node_forward.clone());
    let wsl_node = shell_quote(&wsl_node_path);
    let git_bash_node = shell_quote(&git_bash_node_path);
    let fallback_node = shell_quote(&node_forward);
    format!(
        "if [ -x {wsl_node} ]; then {wsl_node} {args_text}; elif [ -x {git_bash_node} ]; then {git_bash_node} {args_text}; else {fallback_node} {args_text}; fi"
    )
}

fn claude_cli_dir(app: &HostContext) -> Result<PathBuf, BridgeError> {
    Ok(app_data_dir(app)?.join("claude-cli"))
}

fn claude_cli_events_path(app: &HostContext) -> Result<PathBuf, BridgeError> {
    Ok(claude_cli_dir(app)?.join("session-events.jsonl"))
}

fn claude_cli_hook_script_path(app: &HostContext) -> Result<PathBuf, BridgeError> {
    Ok(claude_cli_dir(app)?.join("hook-session-start.mjs"))
}

fn claude_cli_settings_path(app: &HostContext, terminal_id: &str) -> Result<PathBuf, BridgeError> {
    Ok(claude_cli_dir(app)?
        .join("settings")
        .join(format!("{}.json", safe_file_segment(terminal_id))))
}

fn read_latest_claude_cli_event<F>(
    events_path: &Path,
    predicate: F,
) -> Option<ClaudeCliSessionEvent>
where
    F: Fn(&ClaudeCliSessionEvent) -> bool,
{
    let raw = fs::read_to_string(events_path).ok()?;
    raw.lines().rev().find_map(|line| {
        let event = serde_json::from_str::<ClaudeCliSessionEvent>(line).ok()?;
        if is_safe_cli_session_id(&event.session_id) && predicate(&event) {
            Some(event)
        } else {
            None
        }
    })
}

fn claude_history_file_exists(cwd: &str, session_id: &str) -> bool {
    if cwd.trim().is_empty() || !is_safe_cli_session_id(session_id) {
        return false;
    }
    let Some(home) = home_dir() else {
        return false;
    };
    let projects_dir = home.join(".claude").join("projects");
    claude_project_dir_candidates(&projects_dir, cwd)
        .into_iter()
        .any(|dir| dir.join(format!("{session_id}.jsonl")).is_file())
}

fn claude_cli_event_transcript_exists(event: Option<&ClaudeCliSessionEvent>) -> bool {
    event
        .map(|event| event.transcript_path.trim())
        .filter(|path| !path.is_empty())
        .map(|path| Path::new(path).is_file())
        .unwrap_or(false)
}

fn choose_claude_cli_session(
    events_path: &Path,
    terminal_id: &str,
    workspace_id: &str,
    cwd: &str,
    agent_preset: &str,
    current_session_id: Option<&str>,
) -> (String, String) {
    if let Some(event) =
        read_latest_claude_cli_event(events_path, |event| event.terminal_id == terminal_id)
    {
        return (event.session_id, "terminal-event".into());
    }

    if let Some(session_id) = current_session_id.map(str::trim) {
        if is_safe_cli_session_id(session_id) {
            return (session_id.to_string(), "terminal-state".into());
        }
    }

    if let Some(event) = read_latest_claude_cli_event(events_path, |event| {
        event.workspace_id == workspace_id && event.agent_preset == agent_preset && event.cwd == cwd
    }) {
        return (event.session_id, "workspace-event".into());
    }

    (generate_uuid_v4(), "new".into())
}

fn write_claude_cli_hook_assets(
    app: &HostContext,
    terminal_id: &str,
    workspace_id: &str,
    cwd: &str,
    agent_preset: &str,
) -> Result<(PathBuf, PathBuf, PathBuf, String), BridgeError> {
    let settings_path = claude_cli_settings_path(app, terminal_id)?;
    let events_path = claude_cli_events_path(app)?;
    let hook_script_path = claude_cli_hook_script_path(app)?;
    let node_path = app.sidecar_spawn_config()?.node_path;
    let node_path_text = node_path.to_string_lossy().to_string();

    write_if_changed(&hook_script_path, CLAUDE_CLI_HOOK_SCRIPT)?;
    if let Some(parent) = events_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let hook_command = build_claude_cli_hook_command(
        &node_path,
        &hook_script_path,
        &events_path,
        terminal_id,
        workspace_id,
        agent_preset,
        cwd,
    );

    let settings = json!({
        "hooks": {
            "SessionStart": [
                {
                    "matcher": "startup|resume|clear|compact",
                    "hooks": [
                        {
                            "type": "command",
                            "command": hook_command
                        }
                    ]
                }
            ]
        }
    });
    let settings_text = serde_json::to_string_pretty(&settings)?;
    write_if_changed(&settings_path, &(settings_text + "\n"))?;
    Ok((settings_path, events_path, hook_script_path, node_path_text))
}

pub(crate) fn prepare_cli_session_native(
    app: &HostContext,
    terminal_id: String,
    workspace_id: String,
    cwd: String,
    agent_preset: String,
    current_session_id: Option<String>,
) -> Result<Value, BridgeError> {
    let (settings_path, events_path, hook_script_path, node_path) =
        write_claude_cli_hook_assets(app, &terminal_id, &workspace_id, &cwd, &agent_preset)?;
    let (mut session_id, mut source) = choose_claude_cli_session(
        &events_path,
        &terminal_id,
        &workspace_id,
        &cwd,
        &agent_preset,
        current_session_id.as_deref(),
    );
    let selected_event = if source == "terminal-event" {
        read_latest_claude_cli_event(&events_path, |event| event.terminal_id == terminal_id)
    } else if source == "workspace-event" {
        read_latest_claude_cli_event(&events_path, |event| {
            event.workspace_id == workspace_id
                && event.agent_preset == agent_preset
                && event.cwd == cwd
        })
    } else {
        None
    };
    let can_resume = source != "new"
        && (claude_history_file_exists(&cwd, &session_id)
            || claude_cli_event_transcript_exists(selected_event.as_ref()));
    let launch_mode = if can_resume {
        "resume"
    } else {
        if !is_uuid_like(&session_id) {
            session_id = generate_uuid_v4();
            source = "new".into();
        }
        "session"
    };
    Ok(serde_json::to_value(ClaudeCliPrepareSessionResult {
        session_id,
        launch_mode: launch_mode.into(),
        settings_path: settings_path.to_string_lossy().to_string(),
        events_path: events_path.to_string_lossy().to_string(),
        hook_script_path: hook_script_path.to_string_lossy().to_string(),
        cli_path: resolve_claude_cli_path(app),
        node_path,
        source,
    })?)
}

#[derive(Default)]
struct ClaudeSessionPreview {
    preview: String,
    message_count: usize,
    custom_title: Option<String>,
    first_prompt: Option<String>,
    git_branch: Option<String>,
    summary: Option<String>,
}

fn normalize_session_hint_text(text: &str) -> Option<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty()
        || normalized == "[Request interrupted by user for tool use]"
        || normalized.starts_with("<local-command-caveat>")
    {
        return None;
    }
    Some(normalized.chars().take(PREVIEW_CHARS).collect())
}

fn preview_text_from_claude_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return normalize_session_hint_text(text);
    }
    content.as_array().and_then(|blocks| {
        blocks.iter().find_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .and_then(normalize_session_hint_text)
            } else {
                None
            }
        })
    })
}

fn summary_text_from_claude_record(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("summary") {
        return None;
    }
    value
        .get("summary")
        .or_else(|| value.get("title"))
        .or_else(|| value.pointer("/message/summary"))
        .or_else(|| value.pointer("/message/content"))
        .or_else(|| value.get("content"))
        .and_then(Value::as_str)
        .and_then(normalize_session_hint_text)
}

fn read_claude_session_preview(path: &Path) -> ClaudeSessionPreview {
    let Ok(file) = fs::File::open(path) else {
        return ClaudeSessionPreview::default();
    };
    let reader = BufReader::new(file);
    let mut details = ClaudeSessionPreview::default();
    for line in reader
        .lines()
        .map_while(Result::ok)
        .take(PREVIEW_LINE_LIMIT)
    {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        details.message_count += 1;
        if details.git_branch.is_none() {
            details.git_branch = value
                .get("gitBranch")
                .or_else(|| value.get("git_branch"))
                .and_then(Value::as_str)
                .and_then(normalize_session_hint_text);
        }
        if let Some(summary) = summary_text_from_claude_record(&value) {
            details.summary = Some(summary);
        }
        if details.first_prompt.is_none()
            && value.get("type").and_then(Value::as_str) == Some("user")
        {
            if let Some(text) = preview_text_from_claude_content(&value["message"]["content"]) {
                details.preview = text.clone();
                details.first_prompt = Some(text);
            }
        }
    }
    details.custom_title = details
        .summary
        .clone()
        .or_else(|| details.first_prompt.clone())
        .or_else(|| {
            if details.preview.is_empty() {
                None
            } else {
                Some(details.preview.clone())
            }
        });
    details
}

fn list_claude_sessions_in_projects(cwd: &str, projects_dir: &Path) -> Vec<SessionListEntry> {
    if cwd.is_empty() {
        return Vec::new();
    }
    let mut results = Vec::new();
    for dir in claude_project_dir_candidates(projects_dir, cwd) {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let details = read_claude_session_preview(&path);
            results.push(SessionListEntry {
                sdk_session_id: stem.to_string(),
                timestamp: metadata
                    .modified()
                    .map(system_time_millis)
                    .unwrap_or_default(),
                preview: if details.preview.is_empty() {
                    "(no preview)".to_string()
                } else {
                    details.preview
                },
                message_count: details.message_count,
                custom_title: details.custom_title,
                first_prompt: details.first_prompt,
                git_branch: details.git_branch,
                created_at: None,
                summary: details.summary,
            });
        }
    }

    let mut seen = HashSet::new();
    let mut deduped = results
        .into_iter()
        .filter(|entry| seen.insert(entry.sdk_session_id.clone()))
        .collect::<Vec<_>>();
    deduped.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    deduped.truncate(SESSION_LIST_LIMIT);
    deduped
}

fn walk_jsonl_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_jsonl_files(&path, out);
        } else if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn first_codex_input_text(value: &Value) -> Option<String> {
    let payload = value.get("payload")?;
    payload
        .get("input")
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("op")
                .and_then(|op| op.get("content"))
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        if item.get("type").and_then(Value::as_str) == Some("input_text") {
                            item.get("text").and_then(Value::as_str)
                        } else {
                            None
                        }
                    })
                })
        })
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .map(|text| {
            text.lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(PREVIEW_CHARS)
                .collect()
        })
}

fn normalize_codex_cwd_for_match(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    while normalized.len() > 1
        && normalized.ends_with('/')
        && !(normalized.len() == 3
            && normalized.as_bytes().get(1) == Some(&b':')
            && normalized.as_bytes().get(2) == Some(&b'/'))
    {
        normalized.pop();
    }
    normalized
}

fn read_codex_session_summary(path: &Path) -> Option<(String, String, String)> {
    let Ok(file) = fs::File::open(path) else {
        return None;
    };
    let reader = BufReader::new(file);
    let mut thread_id = String::new();
    let mut cwd = String::new();
    let mut preview = String::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if thread_id.is_empty() && value.get("type").and_then(Value::as_str) == Some("session_meta")
        {
            if let Some(id) = value["payload"]["id"].as_str().filter(|id| !id.is_empty()) {
                thread_id = id.to_string();
            }
        }
        if cwd.is_empty() && value.get("type").and_then(Value::as_str) == Some("session_meta") {
            if let Some(session_cwd) = value["payload"]["cwd"]
                .as_str()
                .filter(|session_cwd| !session_cwd.is_empty())
            {
                cwd = normalize_codex_cwd_for_match(session_cwd);
            }
        }
        if preview.is_empty() {
            if let Some(text) = first_codex_input_text(&value) {
                preview = text;
            }
        }
        if !thread_id.is_empty() && !cwd.is_empty() && !preview.is_empty() {
            break;
        }
    }
    Some((thread_id, cwd, preview))
}

fn list_codex_sessions_in_root(root: &Path, cwd: &str) -> Vec<SessionListEntry> {
    let target_cwd = normalize_codex_cwd_for_match(cwd);
    let mut files = Vec::new();
    walk_jsonl_files(root, &mut files);
    let mut results = Vec::new();
    for path in files {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let fallback_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string();
        if fallback_id.is_empty() {
            continue;
        }
        let (mut sdk_session_id, session_cwd, preview) = read_codex_session_summary(&path)
            .unwrap_or_else(|| (String::new(), String::new(), String::new()));
        if !target_cwd.is_empty() && session_cwd != target_cwd {
            continue;
        }
        if sdk_session_id.is_empty() {
            sdk_session_id = fallback_id;
        }
        let readable_preview = if preview.is_empty() {
            None
        } else {
            Some(preview.clone())
        };
        let preview = if preview.is_empty() {
            format!(
                "({}...)",
                sdk_session_id.chars().take(8).collect::<String>()
            )
        } else {
            preview
        };
        results.push(SessionListEntry {
            sdk_session_id,
            timestamp: metadata
                .modified()
                .map(system_time_millis)
                .unwrap_or_default(),
            preview,
            message_count: 0,
            custom_title: readable_preview.clone(),
            first_prompt: readable_preview,
            git_branch: None,
            created_at: None,
            summary: None,
        });
    }
    results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    results.truncate(SESSION_LIST_LIMIT);
    results
}

pub(crate) fn list_sessions_native(cwd: &str, agent_kind: Option<&str>) -> Vec<SessionListEntry> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    if agent_kind == Some("codex") {
        if cwd.is_empty() {
            return Vec::new();
        }
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        return list_codex_sessions_in_root(&codex_home.join("sessions"), cwd);
    }
    list_claude_sessions_in_projects(cwd, &home.join(".claude").join("projects"))
}

/// Mirror of renderer/src/utils/claude-model-presets.ts CLAUDE_MODEL_TABLE.
/// `windows` lists the auto-compact presets a model offers, in tokens; `None`
/// is the `:1m` preset (no early compaction), and an empty slice means the
/// model has no presets and its bare id is selected directly.
struct ClaudeModelDef {
    id: &'static str,
    label: &'static str,
    context_window: u64,
    windows: &'static [Option<u64>],
    /// Description for preset-less models; preset rows derive their own.
    description: Option<&'static str>,
}

/// Ordered newest-first — the picker renders the rows in this order.
const CLAUDE_MODEL_TABLE: &[ClaudeModelDef] = &[
    ClaudeModelDef {
        id: "claude-opus-5",
        label: "Opus 5",
        context_window: 1_000_000,
        windows: &[Some(200_000), Some(300_000), None],
        description: None,
    },
    ClaudeModelDef {
        id: "claude-fable-5",
        label: "Fable 5",
        context_window: 1_000_000,
        windows: &[Some(200_000), Some(300_000), None],
        description: None,
    },
    ClaudeModelDef {
        id: "claude-opus-4-8",
        label: "Opus 4.8",
        context_window: 1_000_000,
        windows: &[Some(200_000), Some(300_000), None],
        description: None,
    },
    ClaudeModelDef {
        id: "claude-opus-4-7",
        label: "Opus 4.7",
        context_window: 1_000_000,
        windows: &[Some(200_000), Some(300_000), Some(400_000), None],
        description: None,
    },
    ClaudeModelDef {
        id: "claude-opus-4-6",
        label: "Opus 4.6 (1M)",
        context_window: 1_000_000,
        windows: &[],
        description: None,
    },
    ClaudeModelDef {
        id: "claude-sonnet-5",
        label: "Sonnet 5",
        context_window: 1_000_000,
        windows: &[Some(200_000), Some(300_000), None],
        description: None,
    },
    ClaudeModelDef {
        id: "claude-sonnet-4-6",
        label: "Sonnet 4.6 (1M)",
        context_window: 1_000_000,
        windows: &[],
        description: None,
    },
    ClaudeModelDef {
        id: "claude-haiku-4-5-20251001",
        label: "Haiku 4.5",
        context_window: 200_000,
        windows: &[],
        description: Some("claude-haiku-4-5 · fast & lightweight"),
    },
];

/// Preset id naming convention: `<base>:auto-compact-<N>k` compacts at N*1000
/// tokens; `<base>:<N>m` disables early auto-compact on an N-million window.
fn claude_compact_preset_id(def: &ClaudeModelDef, window: Option<u64>) -> String {
    match window {
        Some(tokens) => format!("{}:auto-compact-{}k", def.id, tokens / 1000),
        None => format!("{}:{}m", def.id, def.context_window / 1_000_000),
    }
}

fn claude_compact_window_label(def: &ClaudeModelDef, window: Option<u64>) -> String {
    match window {
        Some(tokens) => format!("{}K", tokens / 1000),
        None => format!("{}M", def.context_window / 1_000_000),
    }
}

pub(crate) fn claude_builtin_models_native() -> Value {
    let models = CLAUDE_MODEL_TABLE
        .iter()
        .flat_map(|def| {
            if def.windows.is_empty() {
                let description = def.description.map(str::to_string).unwrap_or_else(|| {
                    format!("{} · {}M context", def.id, def.context_window / 1_000_000)
                });
                return vec![json!({
                    "value": def.id,
                    "displayName": def.label,
                    "description": description,
                    "source": "builtin"
                })];
            }
            def.windows
                .iter()
                .map(|&window| {
                    let label = claude_compact_window_label(def, window);
                    let (display_name, description) = match window {
                        Some(_) => (
                            format!("{} · {} Auto-Compact", def.label, label),
                            format!("{} · compact at {} tokens", def.id, label),
                        ),
                        None => (
                            format!("{} · {}", def.label, label),
                            format!("{} · no early auto-compact", def.id),
                        ),
                    };
                    json!({
                        "value": claude_compact_preset_id(def, window),
                        "displayName": display_name,
                        "description": description,
                        "source": "builtin"
                    })
                })
                .collect()
        })
        .collect::<Vec<_>>();
    Value::Array(models)
}

fn claude_context_window_for_model(model: Option<&str>) -> u64 {
    let Some(model) = model else { return 0 };
    // A bare id or its `[1m]` alias resolves to the physical window; an
    // auto-compact preset resolves to its compact target, which is the budget
    // the session actually runs against.
    let base = model.trim_end_matches("[1m]");
    for def in CLAUDE_MODEL_TABLE {
        if base == def.id {
            return def.context_window;
        }
        for &window in def.windows {
            if claude_compact_preset_id(def, window) == model {
                return window.unwrap_or(def.context_window);
            }
        }
    }
    0
}

pub(crate) fn session_meta_from_notification_snapshot(
    session: &notification_cmd::AgentNotificationSession,
) -> Value {
    if let Some(meta) = session.latest_meta.as_ref() {
        return meta.clone();
    }
    let model = session.model.as_deref();
    json!({
        "permissionMode": session.permission_mode.as_deref().unwrap_or("default"),
        "model": session.model.as_deref(),
        "effort": session.effort.as_deref(),
        "autoCompactWindow": session.auto_compact_window,
        "sdkSessionId": session.sdk_session_id.as_deref(),
        "cwd": session.cwd.as_str(),
        "totalCost": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "durationMs": 0,
        "numTurns": 0,
        "contextWindow": claude_context_window_for_model(model),
        "maxOutputTokens": 0,
        "contextTokens": 0,
        "cacheReadTokens": 0,
        "cacheCreationTokens": 0,
        "callCacheRead": 0,
        "callCacheWrite": 0,
        "lastQueryCalls": 0,
        "codexSandboxMode": session.codex_sandbox_mode.as_deref(),
        "codexApprovalPolicy": session.codex_approval_policy.as_deref(),
    })
}

pub(crate) fn session_state_from_notification_snapshot(
    session: &notification_cmd::AgentNotificationSession,
) -> Value {
    json!({
        "active": true,
        "permissionMode": session.permission_mode.as_deref().unwrap_or("default"),
        "model": session.model.as_deref(),
        "effort": session.effort.as_deref(),
        "autoContinue": session.auto_continue.clone().unwrap_or_else(|| json!({
            "enabled": false,
            "max": 0,
            "used": 0,
            "prompt": "",
        })),
        "isResting": session.is_resting,
        "autoCompactWindow": session.auto_compact_window,
        "codexSandboxMode": session.codex_sandbox_mode.as_deref(),
        "codexApprovalPolicy": session.codex_approval_policy.as_deref(),
    })
}

fn value_u64(value: &Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|item| {
            item.as_u64()
                .or_else(|| item.as_i64().and_then(|n| (n >= 0).then_some(n as u64)))
        })
        .unwrap_or(0)
}

pub(crate) fn context_usage_from_notification_snapshot(
    session: &notification_cmd::AgentNotificationSession,
) -> Option<Value> {
    let meta = session.latest_meta.as_ref()?;
    let model = meta
        .get("model")
        .and_then(Value::as_str)
        .or(session.model.as_deref());
    let input_tokens = value_u64(meta, "inputTokens");
    let output_tokens = value_u64(meta, "outputTokens");
    let cache_creation_tokens = value_u64(meta, "cacheCreationTokens");
    let cache_read_tokens = value_u64(meta, "cacheReadTokens");
    let total_tokens = value_u64(meta, "contextTokens")
        .max(input_tokens + cache_creation_tokens + cache_read_tokens);
    if total_tokens == 0 {
        return None;
    }
    let context_window = value_u64(meta, "contextWindow");
    let model_window = claude_context_window_for_model(model);
    let max_tokens = if context_window > 0 {
        context_window
    } else if model_window > 0 {
        model_window
    } else {
        200_000
    };
    let percentage = if max_tokens > 0 {
        ((total_tokens as f64 / max_tokens as f64) * 100.0).round() as u64
    } else {
        0
    };
    Some(json!({
        "categories": [{ "name": "Context", "tokens": total_tokens, "color": "#8B5CF6" }],
        "totalTokens": total_tokens,
        "maxTokens": max_tokens,
        "percentage": percentage,
        "model": model.unwrap_or("unknown"),
        "apiUsage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_creation_input_tokens": cache_creation_tokens,
            "cache_read_input_tokens": cache_read_tokens,
        },
    }))
}

fn worktree_git_root_from_path(worktree_path: &str) -> Option<PathBuf> {
    Path::new(worktree_path)
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn run_git_in_dir(
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
    max_bytes: usize,
) -> Option<String> {
    if !cwd.is_dir() {
        return None;
    }
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() || output.stdout.len() > max_bytes {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_status_in_dir(cwd: &Path, args: &[&str], timeout: Duration) -> bool {
    if !cwd.is_dir() {
        return false;
    }
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
}

pub(crate) fn worktree_status_from_notification_snapshot(
    session: &notification_cmd::AgentNotificationSession,
) -> Option<Value> {
    let worktree_path = session.worktree_path.as_deref()?;
    if !Path::new(worktree_path).is_dir() {
        return None;
    }
    let branch_name = session
        .worktree_branch
        .as_deref()
        .filter(|value| !value.is_empty())?;
    let git_root = worktree_git_root_from_path(worktree_path)?;
    let source_branch = run_git_in_dir(
        &git_root,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )
    .unwrap_or_default();
    let diff = if source_branch.is_empty() {
        String::new()
    } else {
        let range = format!("{source_branch}...{branch_name}");
        run_git_in_dir(
            &git_root,
            &["diff", &range],
            DEFAULT_TIMEOUT,
            WORKTREE_DIFF_MAX_BYTES,
        )
        .unwrap_or_default()
    };
    Some(json!({
        "diff": diff,
        "branchName": branch_name,
        "worktreePath": worktree_path,
        "sourceBranch": source_branch,
    }))
}

pub(crate) fn cleanup_worktree_from_notification_snapshot(
    session: &notification_cmd::AgentNotificationSession,
    delete_branch: bool,
) -> bool {
    let Some(worktree_path) = session.worktree_path.as_deref() else {
        return false;
    };
    let Some(git_root) = worktree_git_root_from_path(worktree_path) else {
        return false;
    };
    if Path::new(worktree_path).is_dir() {
        let removed_by_git = run_git_status_in_dir(
            &git_root,
            &["worktree", "remove", worktree_path, "--force"],
            DEFAULT_TIMEOUT,
        );
        if !removed_by_git {
            let _ = fs::remove_dir_all(worktree_path);
            let _ = run_git_status_in_dir(&git_root, &["worktree", "prune"], DEFAULT_TIMEOUT);
        }
    }
    if delete_branch {
        if let Some(branch) = session
            .worktree_branch
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            let _ = run_git_status_in_dir(&git_root, &["branch", "-D", branch], DEFAULT_TIMEOUT);
        }
    }
    true
}

pub(crate) fn supported_commands_native(cwd: &Path) -> Vec<SlashCommandEntry> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut push_unique = |entry: SkillScanEntry| {
        if seen.insert(entry.name.clone()) {
            entries.push(SlashCommandEntry {
                name: entry.name,
                description: entry.description,
                argument_hint: String::new(),
            });
        }
    };
    for entry in scan_commands_dir(&cwd.join(".claude").join("commands"), "project") {
        push_unique(entry);
    }
    if let Some(home) = home_dir() {
        for entry in scan_commands_dir(&home.join(".claude").join("commands"), "global") {
            push_unique(entry);
        }
    }
    entries
}

fn scan_agents_dir(dir: &Path) -> Vec<AgentScanEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                return None;
            }
            let content = fs::read_to_string(&path).ok()?;
            let fallback_name = path.file_stem()?.to_string_lossy().to_string();
            let name =
                parse_frontmatter_field(&content, "name").unwrap_or_else(|| fallback_name.clone());
            let description = parse_frontmatter_field(&content, "description")
                .unwrap_or_else(|| first_heading(&content));
            let model =
                parse_frontmatter_field(&content, "model").filter(|value| !value.is_empty());
            Some(AgentScanEntry {
                name,
                description,
                model,
            })
        })
        .collect()
}

pub(crate) fn supported_agents_native(cwd: &Path) -> Vec<AgentScanEntry> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut push_unique = |entry: AgentScanEntry| {
        if seen.insert(entry.name.clone()) {
            entries.push(entry);
        }
    };
    for entry in scan_agents_dir(&cwd.join(".claude").join("agents")) {
        push_unique(entry);
    }
    if let Some(home) = home_dir() {
        for entry in scan_agents_dir(&home.join(".claude").join("agents")) {
            push_unique(entry);
        }
    }
    entries
}

pub(crate) fn claude_supported_efforts_native() -> Value {
    json!(["low", "medium", "high", "xhigh", "max", "ultracode"])
}

pub(crate) fn codex_supported_sandbox_modes_native() -> Value {
    json!(["read-only", "workspace-write", "danger-full-access"])
}

pub(crate) fn codex_supported_approval_policies_native() -> Value {
    json!(["untrusted", "on-request", "never"])
}

fn parse_frontmatter_field(content: &str, field: &str) -> Option<String> {
    let rest = content.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let block = rest[..end].trim();
    for line in block.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() == field {
            return Some(value.trim().trim_matches(['"', '\'']).to_string());
        }
    }
    None
}

fn first_heading(content: &str) -> String {
    let body = if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            &rest[end + 4..]
        } else {
            content
        }
    } else {
        content
    };
    body.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .trim_start_matches('#')
        .trim()
        .chars()
        .take(200)
        .collect()
}

fn scan_markdown_file(path: &Path, fallback_name: &str, scope: &str) -> Option<SkillScanEntry> {
    let content = fs::read_to_string(path).ok()?;
    let name = parse_frontmatter_field(&content, "name").unwrap_or_else(|| fallback_name.into());
    let description =
        parse_frontmatter_field(&content, "description").unwrap_or_else(|| first_heading(&content));
    Some(SkillScanEntry {
        name,
        description,
        scope: scope.to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

fn scan_commands_dir(dir: &Path, scope: &str) -> Vec<SkillScanEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                return None;
            }
            let name = path.file_stem()?.to_string_lossy().to_string();
            scan_markdown_file(&path, &name, scope)
        })
        .collect()
}

fn scan_skills_dir(dir: &Path, scope: &str) -> Vec<SkillScanEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                let skill_md = path.join("SKILL.md");
                let name = path.file_name()?.to_string_lossy().to_string();
                return scan_markdown_file(&skill_md, &name, scope);
            }
            if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                let name = path.file_stem()?.to_string_lossy().to_string();
                return scan_markdown_file(&path, &name, scope);
            }
            None
        })
        .collect()
}

pub(crate) fn scan_skills_native(cwd: &Path) -> Vec<SkillScanEntry> {
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push_unique = |entry: SkillScanEntry| {
        if seen.insert(entry.name.clone()) {
            results.push(entry);
        }
    };

    for entry in scan_commands_dir(&cwd.join(".claude").join("commands"), "project") {
        push_unique(entry);
    }
    for entry in scan_skills_dir(&cwd.join(".claude").join("skills"), "project") {
        push_unique(entry);
    }
    if let Some(home) = home_dir() {
        for entry in scan_commands_dir(&home.join(".claude").join("commands"), "global") {
            push_unique(entry);
        }
        for entry in scan_skills_dir(&home.join(".claude").join("skills"), "global") {
            push_unique(entry);
        }
    }
    results
}

fn read_json_safe(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_mcp_server_names(cwd: &Path) -> Option<Vec<String>> {
    let parsed = read_json_safe(&cwd.join(".mcp.json"))?;
    let servers = parsed.get("mcpServers")?.as_object()?;
    if servers.is_empty() {
        return None;
    }
    Some(servers.keys().cloned().collect())
}

fn mcp_settings_approves(settings: Option<&Value>, server_names: &[String]) -> bool {
    let Some(settings) = settings else {
        return false;
    };
    if settings
        .get("enableAllProjectMcpServers")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    let Some(list) = settings
        .get("enabledMcpjsonServers")
        .and_then(Value::as_array)
    else {
        return false;
    };
    server_names.iter().all(|name| {
        list.iter()
            .any(|value| value.as_str().is_some_and(|enabled| enabled == name))
    })
}

pub(crate) fn check_mcp_json_status_native(cwd: &Path) -> Value {
    if cwd.as_os_str().is_empty() {
        return json!({ "exists": false, "approved": false, "servers": [] });
    }
    let Some(servers) = read_mcp_server_names(cwd) else {
        return json!({ "exists": false, "approved": false, "servers": [] });
    };
    let mut sources = vec![
        cwd.join(".claude").join("settings.json"),
        cwd.join(".claude").join("settings.local.json"),
    ];
    if let Some(home) = home_dir() {
        sources.insert(0, home.join(".claude").join("settings.json"));
    }
    let approved = sources
        .iter()
        .any(|path| mcp_settings_approves(read_json_safe(path).as_ref(), &servers));
    json!({ "exists": true, "approved": approved, "servers": servers })
}

pub(crate) fn enable_all_project_mcp_native(cwd: &Path) -> Result<Value, BridgeError> {
    if cwd.as_os_str().is_empty() {
        return Err(BridgeError {
            message: "claude.enableAllProjectMcp: missing cwd".into(),
        });
    }
    let dir = cwd.join(".claude");
    let path = dir.join("settings.json");
    fs::create_dir_all(&dir).map_err(|err| BridgeError {
        message: format!("could not create {}: {err}", dir.display()),
    })?;
    let mut settings = read_json_safe(&path).unwrap_or_else(|| json!({}));
    if !settings.is_object() {
        settings = json!({});
    }
    if settings
        .get("enableAllProjectMcpServers")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Ok(json!({ "ok": true, "changed": false, "path": path.to_string_lossy() }));
    }
    if let Some(obj) = settings.as_object_mut() {
        obj.insert("enableAllProjectMcpServers".into(), Value::Bool(true));
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|err| BridgeError {
        message: err.to_string(),
    })? + "\n";
    fs::write(&path, text).map_err(|err| BridgeError {
        message: format!("could not write {}: {err}", path.display()),
    })?;
    Ok(json!({ "ok": true, "changed": true, "path": path.to_string_lossy() }))
}

fn archive_empty_page() -> Value {
    json!({ "messages": [], "total": 0, "hasMore": false })
}

fn archive_file_path(data_dir: &Path, session_id: &str) -> PathBuf {
    let safe = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    data_dir
        .join("message-archives")
        .join(format!("{safe}.jsonl"))
}

pub(crate) fn archive_messages_in_dir(
    data_dir: &Path,
    session_id: &str,
    messages: &Value,
) -> std::io::Result<bool> {
    if session_id.is_empty() {
        return Ok(false);
    }
    let Some(items) = messages.as_array() else {
        return Ok(false);
    };
    if items.is_empty() {
        return Ok(true);
    }
    let archive_dir = data_dir.join("message-archives");
    fs::create_dir_all(&archive_dir)?;
    let path = archive_file_path(data_dir, session_id);
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    for item in items {
        serde_json::to_writer(&mut file, item)?;
        writeln!(file)?;
    }
    Ok(true)
}

pub(crate) fn load_archived_from_dir(
    data_dir: &Path,
    session_id: &str,
    offset: u32,
    limit: u32,
) -> Value {
    if session_id.is_empty() {
        return archive_empty_page();
    }
    let raw = match fs::read_to_string(archive_file_path(data_dir, session_id)) {
        Ok(value) => value,
        Err(_) => return archive_empty_page(),
    };
    let lines = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    let total = lines.len();
    let offset = offset as usize;
    let limit = limit as usize;
    let end = total.saturating_sub(offset);
    if end == 0 {
        return json!({ "messages": [], "total": total, "hasMore": false });
    }
    let start = end.saturating_sub(limit);
    let messages = lines[start..end]
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    json!({ "messages": messages, "total": total, "hasMore": start > 0 })
}

pub(crate) fn clear_archive_in_dir(data_dir: &Path, session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    let _ = fs::remove_file(archive_file_path(data_dir, session_id));
    true
}

fn login_success(value: &Value) -> bool {
    value
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[cfg(feature = "desktop")]
async fn call_with_timeout_blocking(
    app: AppHandle,
    state: State<'_, SidecarState>,
    method: &'static str,
    params: Value,
    timeout: Duration,
) -> Result<Value, BridgeError> {
    call_sidecar_with_timeout_blocking(
        HostContext::from_app(app),
        (*state).clone(),
        method,
        params,
        timeout,
    )
    .await
}

async fn call_sidecar_with_timeout_blocking(
    app: HostContext,
    state: SidecarState,
    method: &'static str,
    params: Value,
    timeout: Duration,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || {
        call_with_timeout(&app, &state, method, params, timeout)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("{method} worker failed: {err}"),
    })?
}

fn emit_codex_route_metric(
    app: &HostContext,
    phase: &str,
    method: &str,
    session_id: &str,
    elapsed: Duration,
    ok: bool,
    detail: Option<String>,
) {
    let mut payload = json!({
        "phase": phase,
        "method": method,
        "sessionId": session_id,
        "elapsedMs": elapsed.as_millis() as u64,
        "ok": ok,
    });
    if let Some(detail) = detail {
        payload["detail"] = Value::String(detail);
    }
    publish_runtime_event(app, "sidecar:metric", payload, "codex-route");
}

fn is_codex_worktree_options(options: &Option<Value>) -> bool {
    options
        .as_ref()
        .and_then(|value| value.get("agentPreset"))
        .and_then(Value::as_str)
        == Some("codex-agent-worktree")
}

/// Refuse to spawn a local agent when the workspace cwd doesn't point at an
/// existing directory on THIS machine — defense-in-depth against state
/// corruption where a remote profile's workspace (e.g. a Linux `/home/x` path)
/// leaks into a local profile and we'd otherwise try to launch the agent
/// through the local sidecar with a foreign cwd. The native binary spawn
/// fails opaquely in that case ("claude.exe exists but failed to launch")
/// and burns a session per attempt; a clear refusal here makes the
/// mis-routing diagnosable. See issue #115. Called AFTER the remote-forward
/// branch returns None, so remote sessions still launch normally on the host.
fn validate_local_session_cwd(options: Option<&Value>) -> Result<(), BridgeError> {
    let Some(options) = options else {
        return Ok(());
    };
    let Some(cwd) = options.get("cwd").and_then(Value::as_str) else {
        return Ok(());
    };
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if std::path::Path::new(trimmed).is_dir() {
        return Ok(());
    }
    Err(BridgeError {
        message: format!(
            "Refusing to start local agent: cwd \"{trimmed}\" is not a directory on this machine. \
             If this workspace belongs to a remote profile, open that profile's window instead — \
             the path only exists on the remote host. If you believe the workspace IS local, the \
             folder may have been moved or deleted, or local state may have leaked from a remote \
             profile (issue #115); check the workspace's folderPath in settings."
        ),
    })
}

#[cfg(feature = "desktop")]
fn ensure_local_agent_session_access(
    app: &AppHandle,
    window: &WebviewWindow,
    session_id: &str,
) -> Result<(), BridgeError> {
    notification_cmd::ensure_agent_session_access(
        &HostContext::from_app(app.clone()),
        window.label(),
        session_id,
    )
    .map_err(|message| BridgeError { message })
}

async fn prepare_codex_worktree_options(
    worktree_state: worktree_cmd::WorktreeState,
    session_id: String,
    options: Option<Value>,
) -> Result<Option<Value>, BridgeError> {
    if !is_codex_worktree_options(&options) {
        return Ok(options);
    }

    let mut options_value = options.unwrap_or(Value::Null);
    let cwd = options_value
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| BridgeError {
            message: "codex worktree start: missing cwd".into(),
        })?
        .to_string();
    let worktree_path = options_value
        .get("worktreePath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .map(str::to_string);
    let branch_name = options_value
        .get("worktreeBranch")
        .and_then(Value::as_str)
        .filter(|branch| !branch.trim().is_empty())
        .map(str::to_string);
    let result = crate::async_rt::spawn_blocking(move || {
        worktree_cmd::ensure_worktree_for_session_native(
            &worktree_state,
            session_id,
            cwd,
            worktree_path,
            branch_name,
        )
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("codex worktree prepare worker failed: {err}"),
    })??;

    if result.get("success").and_then(Value::as_bool) != Some(true) {
        let message = result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Failed to create Codex Agent worktree.")
            .to_string();
        return Err(BridgeError { message });
    }

    if let Some(options_object) = options_value.as_object_mut() {
        options_object.insert("useWorktree".into(), Value::Bool(true));
        if let Some(path) = result.get("worktreePath").and_then(Value::as_str) {
            options_object.insert("worktreePath".into(), Value::String(path.to_string()));
        }
        if let Some(branch) = result.get("branchName").and_then(Value::as_str) {
            options_object.insert("worktreeBranch".into(), Value::String(branch.to_string()));
        }
        if let Some(original_cwd) = result
            .get("originalCwd")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
        {
            options_object.insert("cwd".into(), Value::String(original_cwd.to_string()));
        }
    }

    Ok(Some(options_value))
}

#[derive(Clone)]
struct ClaudeRuntimeRouter {
    app: HostContext,
    sidecar: SidecarState,
    codex: CodexAppServerState,
}

impl ClaudeRuntimeRouter {
    #[cfg(feature = "desktop")]
    fn from_states(
        app: AppHandle,
        sidecar: &State<'_, SidecarState>,
        codex: &State<'_, CodexAppServerState>,
    ) -> Self {
        Self {
            app: HostContext::from_app(app),
            sidecar: sidecar.inner().clone(),
            codex: codex.inner().clone(),
        }
    }

    #[cfg(not(feature = "desktop"))]
    #[allow(dead_code)]
    fn from_ctx(app: HostContext, sidecar: SidecarState, codex: CodexAppServerState) -> Self {
        Self {
            app,
            sidecar,
            codex,
        }
    }

    async fn sidecar_call(
        &self,
        method: &'static str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        call_sidecar_with_timeout_blocking(
            self.app.clone(),
            self.sidecar.clone(),
            method,
            params,
            timeout,
        )
        .await
    }

    async fn start_session(
        &self,
        session_id: String,
        options: Option<Value>,
    ) -> Result<Value, BridgeError> {
        if should_handle_codex(&options) {
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            let codex_session_id = session_id.clone();
            let codex_options = options.clone();
            let started = Instant::now();
            let result = crate::async_rt::spawn_blocking(move || {
                codex.start_session(&codex_app, codex_session_id, codex_options)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server start worker failed: {err}"),
            })?;
            match result {
                Ok(value) => {
                    emit_codex_route_metric(
                        &self.app,
                        "codexRuntime",
                        "codex.startSession",
                        &session_id,
                        started.elapsed(),
                        true,
                        None,
                    );
                    return Ok(value);
                }
                Err(err) => {
                    let message = err.message.clone();
                    emit_codex_route_metric(
                        &self.app,
                        "codexRuntime",
                        "codex.startSession",
                        &session_id,
                        started.elapsed(),
                        false,
                        Some(message),
                    );
                    let _ = self.codex.stop_session(session_id.clone());
                    return Err(err);
                }
            }
        }
        self.sidecar_call(
            "claude.startSession",
            json!({ "sessionId": session_id, "options": options.unwrap_or(Value::Null) }),
            SESSION_TIMEOUT,
        )
        .await
    }

    async fn send_message(
        &self,
        session_id: String,
        prompt: String,
        images: Option<Vec<String>>,
        auto_compact_window: Option<i64>,
        client_message_id: Option<String>,
        display_prompt: Option<String>,
        suppress_user_echo: Option<bool>,
    ) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            claude_debug_log(
                &self.app,
                &format!(
                    "[claude_send_message:{}] routing to codex app-server",
                    session_id.chars().take(8).collect::<String>()
                ),
            );
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            let codex_session_id = session_id.clone();
            let codex_prompt = prompt.clone();
            let codex_images = images.clone().unwrap_or_default();
            return crate::async_rt::spawn_blocking(move || {
                codex.send_message(&codex_app, codex_session_id, codex_prompt, codex_images)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server send worker failed: {err}"),
            })?;
        }
        self.sidecar_call(
            "claude.sendMessage",
            json!({
                "sessionId": session_id,
                "prompt": prompt,
                "images": images.unwrap_or_default(),
                "autoCompactWindow": auto_compact_window,
                "clientMessageId": client_message_id,
                "displayPrompt": display_prompt,
                "suppressUserEcho": suppress_user_echo.unwrap_or(false),
            }),
            SESSION_TIMEOUT,
        )
        .await
    }

    async fn stop_session(&self, session_id: String) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(self.codex.stop_session(session_id));
        }
        self.sidecar_call(
            "claude.stopSession",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn abort_session(&self, session_id: String) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            claude_debug_log(
                &self.app,
                &format!(
                    "[claude_abort_session:{}] routing to codex app-server",
                    session_id.chars().take(8).collect::<String>()
                ),
            );
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            let codex_session_id = session_id.clone();
            return crate::async_rt::spawn_blocking(move || {
                codex.abort_session(&codex_app, codex_session_id)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server abort worker failed: {err}"),
            })?;
        }
        self.sidecar_call(
            "claude.abortSession",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn interrupt_turn(&self, session_id: String) -> Result<Value, BridgeError> {
        // Soft interrupt (1× Esc): end the current turn but keep the
        // subprocess / session alive. For codex this is the app-server's
        // turn interrupt (abort_session), which already keeps the session;
        // for the SDK runtime it is the sidecar's turn-only interrupt.
        if self.codex.is_owned(&session_id) {
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            let codex_session_id = session_id.clone();
            return crate::async_rt::spawn_blocking(move || {
                codex.abort_session(&codex_app, codex_session_id)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server interrupt worker failed: {err}"),
            })?;
        }
        self.sidecar_call(
            "claude.interruptTurn",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn stop_task(&self, session_id: String, task_id: String) -> Result<bool, BridgeError> {
        if self.codex.is_owned(&session_id) {
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            let codex_session_id = session_id.clone();
            let value = crate::async_rt::spawn_blocking(move || {
                codex.abort_session(&codex_app, codex_session_id)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server stopTask worker failed: {err}"),
            })??;
            return Ok(value.get("ok").and_then(Value::as_bool).unwrap_or(true));
        }
        let value = self
            .sidecar_call(
                "claude.stopTask",
                json!({ "sessionId": session_id, "taskId": task_id }),
                DEFAULT_TIMEOUT,
            )
            .await?;
        Ok(value
            .as_bool()
            .or_else(|| value.get("ok").and_then(Value::as_bool))
            .unwrap_or(false))
    }

    async fn reset_session(&self, session_id: String) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            let codex_session_id = session_id.clone();
            return crate::async_rt::spawn_blocking(move || {
                codex.reset_session(&codex_app, codex_session_id)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server reset worker failed: {err}"),
            })?;
        }
        self.sidecar_call(
            "claude.resetSession",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn resume_session(
        &self,
        session_id: String,
        sdk_session_id: String,
        options: Option<Value>,
    ) -> Result<Value, BridgeError> {
        let should_use_codex = should_handle_codex(&options);
        if should_use_codex || self.codex.is_owned(&session_id) {
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            let codex_session_id = session_id.clone();
            let codex_sdk_session_id = sdk_session_id.clone();
            let codex_options = options.clone();
            let resume_started = Instant::now();
            let result = crate::async_rt::spawn_blocking(move || {
                codex.resume_session(
                    &codex_app,
                    codex_session_id,
                    codex_sdk_session_id,
                    codex_options,
                )
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server resume worker failed: {err}"),
            })?;
            match result {
                Ok(value) => {
                    emit_codex_route_metric(
                        &self.app,
                        "codexRuntime",
                        "codex.resumeSession",
                        &session_id,
                        resume_started.elapsed(),
                        true,
                        None,
                    );
                    return Ok(value);
                }
                Err(err) if should_use_codex => {
                    emit_codex_route_metric(
                        &self.app,
                        "codexRuntime",
                        "codex.resumeSession",
                        &session_id,
                        resume_started.elapsed(),
                        false,
                        Some(format!(
                            "resume failed for stale sdkSessionId {}; starting fresh: {}",
                            sdk_session_id, err.message
                        )),
                    );
                    let _ = self.codex.stop_session(session_id.clone());

                    let codex = self.codex.clone();
                    let codex_app = self.app.clone();
                    let codex_session_id = session_id.clone();
                    let codex_options = options.clone();
                    let fresh_started = Instant::now();
                    let fresh_result = crate::async_rt::spawn_blocking(move || {
                        codex.start_session(&codex_app, codex_session_id, codex_options)
                    })
                    .await
                    .map_err(|err| BridgeError {
                        message: format!("codex app-server fresh start worker failed: {err}"),
                    })?;
                    match fresh_result {
                        Ok(value) => {
                            emit_codex_route_metric(
                                &self.app,
                                "codexRuntime",
                                "codex.freshStartAfterResumeFailure",
                                &session_id,
                                fresh_started.elapsed(),
                                true,
                                Some(format!("replaced stale sdkSessionId {}", sdk_session_id)),
                            );
                            return Ok(value);
                        }
                        Err(start_err) => {
                            let message = start_err.message.clone();
                            emit_codex_route_metric(
                                &self.app,
                                "codexRuntime",
                                "codex.freshStartAfterResumeFailure",
                                &session_id,
                                fresh_started.elapsed(),
                                false,
                                Some(format!(
                                    "fresh start failed after stale sdkSessionId {}: {}",
                                    sdk_session_id, message
                                )),
                            );
                            let _ = self.codex.stop_session(session_id.clone());
                            return Err(start_err);
                        }
                    }
                }
                Err(err) => {
                    let message = err.message.clone();
                    emit_codex_route_metric(
                        &self.app,
                        "codexRuntime",
                        "codex.resumeSession",
                        &session_id,
                        resume_started.elapsed(),
                        false,
                        Some(message),
                    );
                    let _ = self.codex.stop_session(session_id.clone());
                    return Err(err);
                }
            }
        }
        self.sidecar_call(
            "claude.resumeSession",
            json!({
                "sessionId": session_id,
                "sdkSessionId": sdk_session_id,
                "options": options,
            }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    // Non-destructive resume for a (re)connecting client: re-emit history
    // without disturbing a live host session when it already exists, else fall
    // back to a normal resume. Codex history is owned by the app-server runtime,
    // so codex sessions defer to the regular resume.
    async fn client_resume(
        &self,
        session_id: String,
        sdk_session_id: String,
        options: Option<Value>,
    ) -> Result<Value, BridgeError> {
        if should_handle_codex(&options) || self.codex.is_owned(&session_id) {
            return self
                .resume_session(session_id, sdk_session_id, options)
                .await;
        }
        self.sidecar_call(
            "claude.clientResume",
            json!({
                "sessionId": session_id,
                "sdkSessionId": sdk_session_id,
                "options": options,
            }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    fn supported_models(&self, session_id: &str) -> Value {
        if self.codex.is_owned(session_id) {
            return self.codex.supported_models();
        }
        claude_builtin_models_native()
    }

    fn supported_efforts(&self, session_id: &str) -> Value {
        if self.codex.is_owned(session_id) {
            return self.codex.supported_efforts();
        }
        claude_supported_efforts_native()
    }

    fn supported_codex_sandbox_modes(&self, session_id: &str) -> Value {
        if self.codex.is_owned(session_id) {
            return self.codex.supported_sandbox_modes();
        }
        codex_supported_sandbox_modes_native()
    }

    fn supported_codex_approval_policies(&self, session_id: &str) -> Value {
        if self.codex.is_owned(session_id) {
            return self.codex.supported_approval_policies();
        }
        codex_supported_approval_policies_native()
    }

    async fn supported_commands(&self, session_id: String) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(json!([]));
        }
        if let Some(cwd) = notification_cmd::get_agent_session_cwd(&self.app, &session_id) {
            return Ok(
                serde_json::to_value(supported_commands_native(Path::new(&cwd)))
                    .unwrap_or_else(|_| json!([])),
            );
        }
        self.sidecar_call(
            "claude.getSupportedCommands",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn supported_agents(&self, session_id: String) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(json!([]));
        }
        if let Some(cwd) = notification_cmd::get_agent_session_cwd(&self.app, &session_id) {
            return Ok(
                serde_json::to_value(supported_agents_native(Path::new(&cwd)))
                    .unwrap_or_else(|_| json!([])),
            );
        }
        self.sidecar_call(
            "claude.getSupportedAgents",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn account_info(&self, session_id: String) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(Value::Null);
        }
        let host = self.app.clone();
        crate::async_rt::spawn_blocking(move || {
            account_info_from_auth_status(&fetch_auth_status_native(&host))
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("claude.getAccountInfo worker failed: {err}"),
        })
    }

    async fn session_state(
        &self,
        session_id: String,
        agent_preset: Option<String>,
    ) -> Result<Value, BridgeError> {
        if let Some(value) = self.codex.get_session_state(&session_id) {
            return Ok(value);
        }
        if is_codex_agent_preset_id(agent_preset.as_deref()) {
            return Ok(Value::Null);
        }
        if let Some(session) = notification_cmd::get_agent_session_snapshot(&self.app, &session_id)
        {
            return Ok(session_state_from_notification_snapshot(&session));
        }
        self.sidecar_call(
            "claude.getSessionState",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn session_meta(
        &self,
        session_id: String,
        agent_preset: Option<String>,
    ) -> Result<Value, BridgeError> {
        if let Some(value) = self.codex.get_session_meta(&session_id) {
            return Ok(value);
        }
        if is_codex_agent_preset_id(agent_preset.as_deref()) {
            return Ok(Value::Null);
        }
        if let Some(session) = notification_cmd::get_agent_session_snapshot(&self.app, &session_id)
        {
            return Ok(session_meta_from_notification_snapshot(&session));
        }
        self.sidecar_call(
            "claude.getSessionMeta",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn context_usage(&self, session_id: String) -> Result<Value, BridgeError> {
        if let Some(value) = self.codex.get_context_usage(&session_id) {
            return Ok(value);
        }
        if self.codex.is_owned(&session_id) {
            return Ok(Value::Null);
        }
        if let Some(session) = notification_cmd::get_agent_session_snapshot(&self.app, &session_id)
        {
            if let Some(value) = context_usage_from_notification_snapshot(&session) {
                return Ok(value);
            }
        }
        self.sidecar_call(
            "claude.getContextUsage",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn set_auto_continue(
        &self,
        session_id: String,
        opts: Value,
    ) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(json!(false));
        }
        if let Some(value) =
            notification_cmd::set_agent_session_auto_continue(&self.app, &session_id, &opts)
        {
            return Ok(json!(value));
        }
        self.sidecar_call(
            "claude.setAutoContinue",
            json!({ "sessionId": session_id, "opts": opts }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn get_auto_continue(&self, session_id: String) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(Value::Null);
        }
        if let Some(value) =
            notification_cmd::get_agent_session_auto_continue(&self.app, &session_id)
        {
            return Ok(value);
        }
        self.sidecar_call(
            "claude.getAutoContinue",
            json!({ "sessionId": session_id }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn set_permission_mode(
        &self,
        session_id: String,
        mode: String,
    ) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(json!(false));
        }
        let result = self
            .sidecar_call(
                "claude.setPermissionMode",
                json!({ "sessionId": session_id, "mode": mode }),
                DEFAULT_TIMEOUT,
            )
            .await?;
        if result.as_bool().unwrap_or(false) {
            notification_cmd::update_agent_session_permission_mode(&self.app, &session_id, &mode);
        }
        Ok(result)
    }

    async fn set_codex_sandbox_mode(
        &self,
        session_id: String,
        mode: String,
    ) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            let codex_session_id = session_id.clone();
            return crate::async_rt::spawn_blocking(move || {
                let _ = codex.set_sandbox_mode(&codex_app, &codex_session_id, mode);
                codex.reconfigure_session(&codex_app, &codex_session_id)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server setSandboxMode worker failed: {err}"),
            })?;
        }
        self.sidecar_call(
            "claude.setCodexSandboxMode",
            json!({ "sessionId": session_id, "mode": mode }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn set_codex_approval_policy(
        &self,
        session_id: String,
        policy: String,
    ) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            let codex_session_id = session_id.clone();
            return crate::async_rt::spawn_blocking(move || {
                let _ = codex.set_approval_policy(&codex_app, &codex_session_id, policy);
                codex.reconfigure_session(&codex_app, &codex_session_id)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server setApprovalPolicy worker failed: {err}"),
            })?;
        }
        self.sidecar_call(
            "claude.setCodexApprovalPolicy",
            json!({ "sessionId": session_id, "policy": policy }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn fork_session(&self, session_id: String) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(Value::Null);
        }
        self.sidecar_call(
            "claude.forkSession",
            json!({ "sessionId": session_id }),
            Duration::from_secs(90),
        )
        .await
    }

    async fn fetch_subagent_messages(
        &self,
        session_id: String,
        agent_tool_use_id: String,
    ) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(json!([]));
        }
        self.sidecar_call(
            "claude.fetchSubagentMessages",
            json!({ "sessionId": session_id, "agentToolUseId": agent_tool_use_id }),
            Duration::from_secs(30),
        )
        .await
    }

    async fn rewind_to_prompt(
        &self,
        session_id: String,
        prompt_index: u32,
    ) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(json!({ "error": "Rewind not supported for this session type" }));
        }
        self.sidecar_call(
            "claude.rewindToPrompt",
            json!({ "sessionId": session_id, "promptIndex": prompt_index }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn resolve_permission(
        &self,
        session_id: String,
        tool_use_id: String,
        result: Value,
    ) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            let codex = self.codex.clone();
            let codex_app = self.app.clone();
            return crate::async_rt::spawn_blocking(move || {
                codex.resolve_permission(&codex_app, &session_id, &tool_use_id, &result)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("codex app-server resolvePermission worker failed: {err}"),
            })?;
        }
        self.sidecar_call(
            "claude.resolvePermission",
            json!({ "sessionId": session_id, "toolUseId": tool_use_id, "result": result }),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn resolve_ask_user(
        &self,
        session_id: String,
        tool_use_id: String,
        answers: Value,
    ) -> Result<Value, BridgeError> {
        if self.codex.is_owned(&session_id) {
            return Ok(json!(false));
        }
        self.sidecar_call(
            "claude.resolveAskUser",
            json!({ "sessionId": session_id, "toolUseId": tool_use_id, "answers": answers }),
            DEFAULT_TIMEOUT,
        )
        .await
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn claude_ping(
    app: AppHandle,
    state: State<'_, SidecarState>,
    payload: Option<Value>,
) -> Result<Value, BridgeError> {
    call(
        &HostContext::from_app(app.clone()),
        &state,
        "ping",
        payload.unwrap_or(Value::Null),
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_auth_status(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:auth-status",
        vec![],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    let value = crate::async_rt::spawn_blocking(move || {
        fetch_auth_status_native(&HostContext::from_app(app.clone()))
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("claude.authStatus worker failed: {err}"),
    })?;
    Ok(value)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_account_list(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:account-list",
        vec![],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    let app_data_dir = app_data_dir(&HostContext::from_app(app.clone()))?;
    let index = account_store::read_index(&app_data_dir);
    Ok(serde_json::to_value(index).unwrap_or(Value::Null))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_start_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    worktree_state: State<'_, worktree_cmd::WorktreeState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:start-session",
        vec![
            json!(session_id.clone()),
            options.clone().unwrap_or(Value::Null),
        ],
        SESSION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    validate_local_session_cwd(options.as_ref())?;
    // Claim the process-wide runtime identity before worktree preparation can
    // create or rehydrate resources named by this session id. Register again
    // below with the effective worktree metadata once preparation succeeds.
    notification_cmd::register_agent_session_from_options(
        &HostContext::from_app(app.clone()),
        window.label(),
        &session_id,
        options.as_ref(),
    )
    .map_err(|message| BridgeError { message })?;
    let options =
        prepare_codex_worktree_options((*worktree_state).clone(), session_id.clone(), options)
            .await?;
    notification_cmd::register_agent_session_from_options(
        &HostContext::from_app(app.clone()),
        window.label(),
        &session_id,
        options.as_ref(),
    )
    .map_err(|message| BridgeError { message })?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .start_session(session_id, options)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_send_message(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    prompt: String,
    images: Option<Vec<String>>,
    auto_compact_window: Option<i64>,
    client_message_id: Option<String>,
    display_prompt: Option<String>,
    suppress_user_echo: Option<bool>,
) -> Result<Value, BridgeError> {
    claude_debug_log(
        &HostContext::from_app(app.clone()),
        &format!(
            "[claude_send_message:{}] requested promptLen={} images={} autoCompactWindow={:?}",
            session_id.chars().take(8).collect::<String>(),
            prompt.len(),
            images.as_ref().map(Vec::len).unwrap_or(0),
            auto_compact_window
        ),
    );
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:send-message",
        vec![
            json!(session_id.clone()),
            json!(prompt.clone()),
            json!(images.clone()),
            json!(auto_compact_window),
            json!(client_message_id.clone()),
            json!(display_prompt.clone()),
            json!(suppress_user_echo),
        ],
        SESSION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    notification_cmd::set_agent_session_resting(
        &HostContext::from_app(app.clone()),
        &session_id,
        false,
    );
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .send_message(
            session_id,
            prompt,
            images,
            auto_compact_window,
            client_message_id,
            display_prompt,
            suppress_user_echo,
        )
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_stop_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:stop-session",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    let result = ClaudeRuntimeRouter::from_states(app.clone(), &state, &codex_state)
        .stop_session(session_id.clone())
        .await?;
    // Keep ownership until the runtime has actually stopped. Releasing it
    // first leaves a window where another profile can claim the same id while
    // the previous sidecar/app-server session is still alive.
    notification_cmd::unregister_agent_session(&HostContext::from_app(app), &session_id);
    Ok(result)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_abort_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    claude_debug_log(
        &HostContext::from_app(app.clone()),
        &format!(
            "[claude_abort_session:{}] requested",
            session_id.chars().take(8).collect::<String>()
        ),
    );
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:abort-session",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .abort_session(session_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_interrupt_turn(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    // Remote clients keep the existing behavior: the host owns the session,
    // so a soft interrupt is routed through the same remote action as a
    // hard abort (no remote regression). Local sessions get the real
    // turn-only interrupt.
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:abort-session",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .interrupt_turn(session_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_stop_task(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    task_id: String,
) -> Result<bool, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:stop-task",
        vec![json!(session_id.clone()), json!(task_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result.map(|value| {
            value
                .as_bool()
                .or_else(|| value.get("ok").and_then(Value::as_bool))
                .unwrap_or(false)
        });
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .stop_task(session_id, task_id)
        .await
}

// --- account / auth ops ---------------------------------------------------

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_auth_login(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || auth_login_native(&HostContext::from_app(app.clone())))
        .await
        .map_err(|err| BridgeError {
            message: format!("claude.authLogin worker failed: {err}"),
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_auth_logout(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || auth_logout_native(&HostContext::from_app(app.clone())))
        .await
        .map_err(|err| BridgeError {
            message: format!("claude.authLogout worker failed: {err}"),
        })
}

// Interactive URL ("paste code") login. Unlike claude_auth_login (which
// opens a browser locally), these drive the CLI on the host and surface its
// sign-in URL, so a remote client can authenticate the host. The renderer
// uses these only when connected to a remote host; desktop keeps the browser
// flow. The sidecar (claude-auth-login.mjs) holds the in-flight login between
// the start and submit-code calls.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_auth_login_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:auth-login-start",
        vec![],
        AUTH_LOGIN_TIMEOUT,
    )
    .await
    {
        return result;
    }
    call_with_timeout_blocking(
        app,
        state,
        "claude.authLoginStart",
        Value::Null,
        AUTH_LOGIN_TIMEOUT,
    )
    .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_auth_login_submit_code(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    code: String,
    login_id: Option<String>,
) -> Result<Value, BridgeError> {
    let mut remote_args = vec![json!(code.clone())];
    if let Some(login_id) = login_id.as_ref() {
        remote_args.push(json!(login_id));
    }
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:auth-login-submit-code",
        remote_args,
        AUTH_LOGIN_TIMEOUT,
    )
    .await
    {
        return result;
    }
    call_with_timeout_blocking(
        app,
        state,
        "claude.authLoginSubmitCode",
        json!({ "code": code, "loginId": login_id }),
        AUTH_LOGIN_TIMEOUT,
    )
    .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_auth_login_cancel(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    login_id: Option<String>,
) -> Result<Value, BridgeError> {
    let remote_args = login_id
        .as_ref()
        .map(|value| vec![json!(value)])
        .unwrap_or_default();
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:auth-login-cancel",
        remote_args,
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    call_with_timeout_blocking(
        app,
        state,
        "claude.authLoginCancel",
        json!({ "loginId": login_id }),
        DEFAULT_TIMEOUT,
    )
    .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_account_import_current(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let app_data_dir = app_data_dir(&HostContext::from_app(app.clone()))?;
    let status_app = app.clone();
    let status_value = crate::async_rt::spawn_blocking(move || {
        fetch_auth_status_native(&HostContext::from_app(status_app.clone()))
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("claude.accountImportCurrent authStatus worker failed: {err}"),
    })?;
    let Some(status) = account_store::auth_status_from_value(&status_value) else {
        return Ok(Value::Null);
    };
    let Some(credential) = account_store::read_cli_credentials() else {
        return Ok(Value::Null);
    };
    let account = account_store::import_current_account(&app_data_dir, status, credential)
        .map_err(account_error)?;
    Ok(serde_json::to_value(account).unwrap_or(Value::Null))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_account_login_new(
    app: AppHandle,
    _state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    let app_data_dir = app_data_dir(&HostContext::from_app(app.clone()))?;
    let index = account_store::read_index(&app_data_dir);
    let active_account_id = index.active_account_id.clone();
    let backup_credential = account_store::read_cli_credentials();
    let login_app = app.clone();
    let login_result = crate::async_rt::spawn_blocking(move || {
        auth_login_native(&HostContext::from_app(login_app.clone()))
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("claude.accountLoginNew authLogin worker failed: {err}"),
    })?;
    if !login_success(&login_result) {
        return Ok(login_result);
    }
    let status_app = app.clone();
    let status_value = crate::async_rt::spawn_blocking(move || {
        fetch_auth_status_native(&HostContext::from_app(status_app.clone()))
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("claude.accountLoginNew authStatus worker failed: {err}"),
    })?;
    let Some(status) = account_store::auth_status_from_value(&status_value) else {
        if let Some(backup) = backup_credential {
            let _ = account_store::write_cli_credentials(&backup);
        }
        return Ok(
            json!({ "success": false, "error": "Login completed but could not verify account" }),
        );
    };
    let Some(new_credential) = account_store::read_cli_credentials() else {
        if let Some(backup) = backup_credential {
            let _ = account_store::write_cli_credentials(&backup);
        }
        return Ok(json!({ "success": false, "error": "Could not read credentials after login" }));
    };
    let account =
        match account_store::upsert_new_login_account(&app_data_dir, status, new_credential) {
            Ok(account) => account,
            Err(err) => {
                if let Some(backup) = backup_credential {
                    let _ = account_store::write_cli_credentials(&backup);
                }
                return Ok(json!({ "success": false, "error": err.to_string() }));
            }
        };
    if let (Some(backup), Some(active_id)) = (backup_credential, active_account_id) {
        if active_id != account.id {
            let _ = account_store::write_cli_credentials(&backup);
        }
    }
    Ok(json!({ "success": true, "account": account }))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_account_switch(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    account_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:account-switch",
        vec![json!(account_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    let app_data_dir = app_data_dir(&HostContext::from_app(app.clone()))?;
    let ok = account_store::switch_account(&app_data_dir, &account_id).map_err(account_error)?;
    Ok(Value::Bool(ok))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_account_remove(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    account_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:account-remove",
        vec![json!(account_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    let app_data_dir = app_data_dir(&HostContext::from_app(app.clone()))?;
    let ok = account_store::remove_account(&app_data_dir, &account_id).map_err(account_error)?;
    Ok(Value::Bool(ok))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_account_mark_warning_shown(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:account-mark-warning-shown",
        vec![],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    let app_data_dir = app_data_dir(&HostContext::from_app(app.clone()))?;
    account_store::mark_warning_shown(&app_data_dir).map_err(account_error)?;
    Ok(Value::Bool(true))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_info(
    app: AppHandle,
    codex: State<'_, CodexAppServerState>,
) -> Result<Value, BridgeError> {
    Ok(codex.account_info(&HostContext::from_app(app.clone())))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_list(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex: State<'_, CodexAppServerState>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "codex:account-list",
        vec![],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    Ok(codex.account_list(&HostContext::from_app(app.clone())))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_switch(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex: State<'_, CodexAppServerState>,
    codex_home: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "codex:account-switch",
        vec![json!(codex_home.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    codex
        .switch_account(&HostContext::from_app(app.clone()), codex_home)
        .map_err(|message| BridgeError { message })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_unified_status(
    app: AppHandle,
    codex: State<'_, CodexAppServerState>,
) -> Result<Value, BridgeError> {
    Ok(codex.unified_status(&HostContext::from_app(app.clone())))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_unified_migrate(
    app: AppHandle,
    codex: State<'_, CodexAppServerState>,
) -> Result<Value, BridgeError> {
    codex
        .unified_migrate(&HostContext::from_app(app.clone()))
        .map_err(|message| BridgeError { message })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_capture_current(
    app: AppHandle,
    codex: State<'_, CodexAppServerState>,
    label: Option<String>,
) -> Result<Value, BridgeError> {
    codex
        .account_capture_current(&HostContext::from_app(app.clone()), label)
        .map_err(|message| BridgeError { message })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_remove_unified(
    app: AppHandle,
    codex: State<'_, CodexAppServerState>,
    account_id: String,
) -> Result<Value, BridgeError> {
    codex
        .account_remove_unified(&HostContext::from_app(app.clone()), account_id)
        .map_err(|message| BridgeError { message })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_login(
    app: AppHandle,
    codex: State<'_, CodexAppServerState>,
    api_key: Option<String>,
) -> Result<Value, BridgeError> {
    // codex login is interactive (browser OAuth) and can take a while — run it
    // off the async runtime so it doesn't stall other commands.
    let codex = codex.inner().clone();
    crate::async_rt::spawn_blocking(move || {
        codex.account_login(&HostContext::from_app(app.clone()), api_key)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("codex login worker failed: {err}"),
    })?
    .map_err(|message| BridgeError { message })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_login_cancel(
    codex: State<'_, CodexAppServerState>,
) -> Result<Value, BridgeError> {
    Ok(codex.account_login_cancel())
}

// Device-code login for remote hosts. Codex app-server returns structured
// loginId/url/code fields and emits account/login/completed after browser
// approval. These commands retain the existing renderer IPC names and route to
// the connected host; loginId is additive for legacy client compatibility.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_login_device_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex: State<'_, CodexAppServerState>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "codex:auth-login-device-start",
        vec![],
        AUTH_LOGIN_TIMEOUT,
    )
    .await
    {
        return result;
    }
    let codex = codex.inner().clone();
    crate::async_rt::spawn_blocking(move || {
        codex.account_login_device_start(&HostContext::from_app(app.clone()))
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("codex device login worker failed: {err}"),
    })?
    .map_err(|message| BridgeError { message })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_login_device_poll(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex: State<'_, CodexAppServerState>,
    login_id: Option<String>,
) -> Result<Value, BridgeError> {
    let remote_args = login_id
        .as_ref()
        .map(|value| vec![json!(value)])
        .unwrap_or_default();
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "codex:auth-login-device-poll",
        remote_args,
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    let codex = codex.inner().clone();
    crate::async_rt::spawn_blocking(move || {
        codex.account_login_device_poll(&HostContext::from_app(app.clone()), login_id.as_deref())
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("codex device login poll worker failed: {err}"),
    })?
    .map_err(|message| BridgeError { message })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn codex_account_login_device_cancel(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex: State<'_, CodexAppServerState>,
    login_id: Option<String>,
) -> Result<Value, BridgeError> {
    let remote_args = login_id
        .as_ref()
        .map(|value| vec![json!(value)])
        .unwrap_or_default();
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "codex:auth-login-device-cancel",
        remote_args,
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    codex
        .account_login_device_cancel(&HostContext::from_app(app.clone()), login_id.as_deref())
        .map_err(|message| BridgeError { message })
}

// --- read-only metadata ---------------------------------------------------

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_cli_path(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-cli-path",
        vec![],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    Ok(Value::String(resolve_claude_cli_path(
        &HostContext::from_app(app.clone()),
    )))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_prepare_cli_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    terminal_id: String,
    workspace_id: String,
    cwd: String,
    agent_preset: String,
    current_session_id: Option<String>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:prepare-cli-session",
        vec![
            json!(terminal_id.clone()),
            json!(workspace_id.clone()),
            json!(cwd.clone()),
            json!(agent_preset.clone()),
            json!(current_session_id.clone()),
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    prepare_cli_session_native(
        &HostContext::from_app(app.clone()),
        terminal_id,
        workspace_id,
        cwd,
        agent_preset,
        current_session_id,
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_list_sessions(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    cwd: String,
    agent_kind: Option<String>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:list-sessions",
        vec![json!(cwd.clone()), json!(agent_kind.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    if agent_kind.as_deref() == Some("codex") {
        let sessions = active_codex_home(&HostContext::from_app(app.clone()))
            .map(|codex_home| list_codex_sessions_in_root(&codex_home.join("sessions"), &cwd))
            .unwrap_or_default();
        return Ok(serde_json::to_value(sessions).unwrap_or_else(|_| json!([])));
    }
    Ok(
        serde_json::to_value(list_sessions_native(&cwd, agent_kind.as_deref()))
            .unwrap_or_else(|_| json!([])),
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_supported_models(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-supported-models",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    Ok(ClaudeRuntimeRouter::from_states(app, &state, &codex_state).supported_models(&session_id))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_supported_efforts(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-supported-efforts",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    Ok(ClaudeRuntimeRouter::from_states(app, &state, &codex_state).supported_efforts(&session_id))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_supported_codex_sandbox_modes(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-supported-codex-sandbox-modes",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    Ok(ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .supported_codex_sandbox_modes(&session_id))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_supported_codex_approval_policies(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-supported-codex-approval-policies",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    Ok(ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .supported_codex_approval_policies(&session_id))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_supported_commands(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-supported-commands",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .supported_commands(session_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_supported_agents(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-supported-agents",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .supported_agents(session_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_account_info(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-account-info",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .account_info(session_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_session_state(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    agent_preset: Option<String>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-session-state",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .session_state(session_id, agent_preset)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_session_meta(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    agent_preset: Option<String>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-session-meta",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .session_meta(session_id, agent_preset)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_context_usage(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-context-usage",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .context_usage(session_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_worktree_status(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-worktree-status",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    if let Some(session) = notification_cmd::get_agent_session_snapshot(
        &HostContext::from_app(app.clone()),
        &session_id,
    ) {
        let status = crate::async_rt::spawn_blocking(move || {
            worktree_status_from_notification_snapshot(&session)
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("claude.getWorktreeStatus native worker failed: {err}"),
        })?;
        if let Some(value) = status {
            return Ok(value);
        }
    }
    call_blocking(
        app,
        state,
        "claude.getWorktreeStatus",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_scan_skills(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:scan-skills",
        vec![json!(cwd.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    let entries = scan_skills_native(Path::new(&cwd));
    Ok(serde_json::to_value(entries).unwrap_or_else(|_| json!([])))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_cleanup_worktree(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:cleanup-worktree",
        vec![json!(session_id.clone()), json!(delete_branch)],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    if let Some(session) = notification_cmd::get_agent_session_snapshot(
        &HostContext::from_app(app.clone()),
        &session_id,
    ) {
        if session.worktree_path.is_some() {
            let native_session = session.clone();
            let cleaned = crate::async_rt::spawn_blocking(move || {
                cleanup_worktree_from_notification_snapshot(&native_session, delete_branch)
            })
            .await
            .map_err(|err| BridgeError {
                message: format!("claude.cleanupWorktree native worker failed: {err}"),
            })?;
            if cleaned {
                notification_cmd::clear_agent_session_worktree(
                    &HostContext::from_app(app.clone()),
                    &session_id,
                );
                if let Some(updated) = notification_cmd::get_agent_session_snapshot(
                    &HostContext::from_app(app.clone()),
                    &session_id,
                ) {
                    publish_runtime_event(
                        &HostContext::from_app(app.clone()),
                        "claude:status",
                        json!({
                            "sessionId": session_id.as_str(),
                            "meta": session_meta_from_notification_snapshot(&updated),
                        }),
                        "tauri-native",
                    );
                }
                publish_runtime_event(
                    &HostContext::from_app(app.clone()),
                    "claude:worktree-info",
                    json!({ "sessionId": session_id.as_str(), "payload": Value::Null }),
                    "tauri-native",
                );
                return Ok(json!(true));
            }
        }
    }
    let result = call_blocking(
        app.clone(),
        state,
        "claude.cleanupWorktree",
        json!({
            "sessionId": session_id,
            "deleteBranch": delete_branch,
        }),
    )
    .await?;
    if result.as_bool().unwrap_or(false) {
        notification_cmd::clear_agent_session_worktree(
            &HostContext::from_app(app.clone()),
            &session_id,
        );
    }
    Ok(result)
}

// --- per-session state -----------------------------------------------------

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_set_auto_continue(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    opts: Value,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:set-auto-continue",
        vec![json!(session_id.clone()), opts.clone()],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .set_auto_continue(session_id, opts)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_get_auto_continue(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:get-auto-continue",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .get_auto_continue(session_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_set_permission_mode(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    mode: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:set-permission-mode",
        vec![json!(session_id.clone()), json!(mode.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .set_permission_mode(session_id, mode)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_set_codex_sandbox_mode(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    mode: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:set-codex-sandbox-mode",
        vec![json!(session_id.clone()), json!(mode.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .set_codex_sandbox_mode(session_id, mode)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_set_codex_approval_policy(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    policy: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:set-codex-approval-policy",
        vec![json!(session_id.clone()), json!(policy.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .set_codex_approval_policy(session_id, policy)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_set_model(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    model: String,
    auto_compact_window: Option<i64>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:set-model",
        vec![
            json!(session_id.clone()),
            json!(model.clone()),
            json!(auto_compact_window),
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    if let Some(value) = codex_state.set_model(
        &HostContext::from_app(app.clone()),
        &session_id,
        model.clone(),
    ) {
        return Ok(value);
    }
    let result = call_blocking(
        app.clone(),
        state,
        "claude.setModel",
        json!({
            "sessionId": session_id, "model": model, "autoCompactWindow": auto_compact_window,
        }),
    )
    .await?;
    if result.as_bool().unwrap_or(false) {
        notification_cmd::update_agent_session_model(
            &HostContext::from_app(app.clone()),
            &session_id,
            &model,
            auto_compact_window,
        );
    }
    Ok(result)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_set_effort(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    effort: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:set-effort",
        vec![json!(session_id.clone()), json!(effort.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    if let Some(value) = codex_state.set_effort(
        &HostContext::from_app(app.clone()),
        &session_id,
        effort.clone(),
    ) {
        return Ok(value);
    }
    let result = call_blocking(
        app.clone(),
        state,
        "claude.setEffort",
        json!({
            "sessionId": session_id, "effort": effort,
        }),
    )
    .await?;
    if result.as_bool().unwrap_or(false) {
        notification_cmd::update_agent_session_effort(
            &HostContext::from_app(app.clone()),
            &session_id,
            &effort,
        );
    }
    Ok(result)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_reset_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:reset-session",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .reset_session(session_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_fork_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:fork-session",
        vec![json!(session_id.clone())],
        Duration::from_secs(90),
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .fork_session(session_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_archive_messages(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    session_id: String,
    messages: Value,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:archive-messages",
        vec![json!(session_id.clone()), messages.clone()],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    let data_dir = app_data_dir(&HostContext::from_app(app.clone()))?;
    match archive_messages_in_dir(&data_dir, &session_id, &messages) {
        Ok(value) => Ok(json!(value)),
        Err(_) => Ok(json!(false)),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_load_archived(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    session_id: String,
    offset: u32,
    limit: u32,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:load-archived",
        vec![json!(session_id.clone()), json!(offset), json!(limit)],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    let data_dir = app_data_dir(&HostContext::from_app(app.clone()))?;
    Ok(load_archived_from_dir(
        &data_dir,
        &session_id,
        offset,
        limit,
    ))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_clear_archive(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:clear-archive",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    let data_dir = app_data_dir(&HostContext::from_app(app.clone()))?;
    Ok(json!(clear_archive_in_dir(&data_dir, &session_id)))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_rest_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:rest-session",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    if let Some(value) = codex_state.rest_session(&HostContext::from_app(app.clone()), &session_id)
    {
        return Ok(value);
    }
    let result = call_blocking(
        app.clone(),
        state,
        "claude.restSession",
        json!({ "sessionId": session_id.clone() }),
    )
    .await?;
    if result.as_bool().unwrap_or(false) {
        notification_cmd::set_agent_session_resting(
            &HostContext::from_app(app.clone()),
            &session_id,
            true,
        );
    }
    Ok(result)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_wake_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:wake-session",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    if let Some(value) = codex_state.wake_session(&session_id) {
        return Ok(value);
    }
    let result = call_blocking(
        app.clone(),
        state,
        "claude.wakeSession",
        json!({ "sessionId": session_id.clone() }),
    )
    .await?;
    if result.as_bool().unwrap_or(false) {
        notification_cmd::set_agent_session_resting(
            &HostContext::from_app(app.clone()),
            &session_id,
            false,
        );
    }
    Ok(result)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_is_resting(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:is-resting",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    if let Some(value) = codex_state.is_resting(&session_id) {
        return Ok(value);
    }
    if let Some(session) = notification_cmd::get_agent_session_snapshot(
        &HostContext::from_app(app.clone()),
        &session_id,
    ) {
        return Ok(json!(session.is_resting));
    }
    call_blocking(
        app,
        state,
        "claude.isResting",
        json!({ "sessionId": session_id }),
    )
    .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_fetch_subagent_messages(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    agent_tool_use_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:fetch-subagent-messages",
        vec![json!(session_id.clone()), json!(agent_tool_use_id.clone())],
        Duration::from_secs(30),
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .fetch_subagent_messages(session_id, agent_tool_use_id)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_rewind_to_prompt(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    prompt_index: u32,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:rewind-to-prompt",
        vec![json!(session_id.clone()), json!(prompt_index)],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .rewind_to_prompt(session_id, prompt_index)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_resume_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    worktree_state: State<'_, worktree_cmd::WorktreeState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    sdk_session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:resume-session",
        vec![
            json!(session_id.clone()),
            json!(sdk_session_id.clone()),
            option_field(&options, "cwd"),
            option_field(&options, "model"),
            option_field(&options, "apiVersion"),
            option_field(&options, "useWorktree"),
            option_field(&options, "worktreePath"),
            option_field(&options, "worktreeBranch"),
            option_field(&options, "agentPreset"),
            option_field(&options, "codexSandboxMode"),
            option_field(&options, "codexApprovalPolicy"),
            option_field(&options, "permissionMode"),
            option_field(&options, "effort"),
            option_field(&options, "ultracode"),
            option_field(&options, "workspaceId"),
            option_field(&options, "workspaceName"),
        ],
        SESSION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    validate_local_session_cwd(options.as_ref())?;
    notification_cmd::register_agent_session_from_options(
        &HostContext::from_app(app.clone()),
        window.label(),
        &session_id,
        options.as_ref(),
    )
    .map_err(|message| BridgeError { message })?;
    let options =
        prepare_codex_worktree_options((*worktree_state).clone(), session_id.clone(), options)
            .await?;
    notification_cmd::register_agent_session_from_options(
        &HostContext::from_app(app.clone()),
        window.label(),
        &session_id,
        options.as_ref(),
    )
    .map_err(|message| BridgeError { message })?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .resume_session(session_id, sdk_session_id, options)
        .await
}

// claude.clientResume: a remote client (re)opening a session view wants its
// history without disturbing a session the host may have live. Routes to the
// host over `agent:client-resume`; on the host (or for local windows) the
// runtime re-emits history read-only when the session exists, else resumes.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_client_resume(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    worktree_state: State<'_, worktree_cmd::WorktreeState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    sdk_session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:client-resume",
        vec![
            json!(session_id.clone()),
            json!(sdk_session_id.clone()),
            option_field(&options, "cwd"),
            option_field(&options, "model"),
            option_field(&options, "apiVersion"),
            option_field(&options, "useWorktree"),
            option_field(&options, "worktreePath"),
            option_field(&options, "worktreeBranch"),
            option_field(&options, "agentPreset"),
            option_field(&options, "codexSandboxMode"),
            option_field(&options, "codexApprovalPolicy"),
            option_field(&options, "permissionMode"),
            option_field(&options, "effort"),
            option_field(&options, "ultracode"),
            option_field(&options, "workspaceId"),
            option_field(&options, "workspaceName"),
        ],
        SESSION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    validate_local_session_cwd(options.as_ref())?;
    notification_cmd::register_agent_session_from_options(
        &HostContext::from_app(app.clone()),
        window.label(),
        &session_id,
        options.as_ref(),
    )
    .map_err(|message| BridgeError { message })?;
    let options =
        prepare_codex_worktree_options((*worktree_state).clone(), session_id.clone(), options)
            .await?;
    notification_cmd::register_agent_session_from_options(
        &HostContext::from_app(app.clone()),
        window.label(),
        &session_id,
        options.as_ref(),
    )
    .map_err(|message| BridgeError { message })?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .client_resume(session_id, sdk_session_id, options)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_resolve_permission(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    tool_use_id: String,
    result: Value,
) -> Result<Value, BridgeError> {
    if let Some(remote_result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:resolve-permission",
        vec![
            json!(session_id.clone()),
            json!(tool_use_id.clone()),
            result.clone(),
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return remote_result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .resolve_permission(session_id, tool_use_id, result)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_resolve_ask_user(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    codex_state: State<'_, CodexAppServerState>,
    session_id: String,
    tool_use_id: String,
    answers: Value,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:resolve-ask-user",
        vec![
            json!(session_id.clone()),
            json!(tool_use_id.clone()),
            answers.clone(),
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    ensure_local_agent_session_access(&app, &window, &session_id)?;
    ClaudeRuntimeRouter::from_states(app, &state, &codex_state)
        .resolve_ask_user(session_id, tool_use_id, answers)
        .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_check_mcp_json_status(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:check-mcp-json-status",
        vec![json!(cwd.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    Ok(check_mcp_json_status_native(Path::new(&cwd)))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn claude_enable_all_project_mcp(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    cwd: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &HostContext::from_app(app.clone()),
        &state,
        &window,
        "agent:enable-all-project-mcp",
        vec![json!(cwd.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    enable_all_project_mcp_native(Path::new(&cwd))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn validate_local_session_cwd_passes_when_cwd_missing_or_empty() {
        // No options at all — nothing to validate; downstream picks defaults.
        assert!(validate_local_session_cwd(None).is_ok());
        // Empty options object — still nothing to validate.
        let empty = json!({});
        assert!(validate_local_session_cwd(Some(&empty)).is_ok());
        // Whitespace-only cwd is treated as "unset" and skipped.
        let blank = json!({ "cwd": "   " });
        assert!(validate_local_session_cwd(Some(&blank)).is_ok());
    }

    #[test]
    fn validate_local_session_cwd_passes_for_existing_directory() {
        let dir = env::temp_dir();
        let options = json!({ "cwd": dir.to_string_lossy().to_string() });
        assert!(validate_local_session_cwd(Some(&options)).is_ok());
    }

    #[test]
    fn validate_local_session_cwd_rejects_non_existent_directory() {
        // The exact symptom of issue #115: a foreign Linux path arrives on a
        // local-routed start — we refuse before the binary spawn fails opaquely.
        let options = json!({ "cwd": "/home/definitely-not-on-this-machine-115" });
        let err = validate_local_session_cwd(Some(&options))
            .expect_err("a path that doesn't exist must be refused");
        assert!(err.message.contains("not a directory"));
        assert!(err
            .message
            .contains("/home/definitely-not-on-this-machine-115"));
        assert!(err.message.contains("#115"));
    }

    fn temp_data_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        env::temp_dir().join(format!(
            "bat-claude-command-{name}-{}-{stamp}",
            std::process::id()
        ))
    }

    #[test]
    fn claude_cli_resolves_bundled_sdk_binary_in_base() {
        let base = temp_data_dir("claude-cli-bundled");
        let bin = base
            .join("node-sidecar")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-agent-sdk-win32-x64")
            .join("claude.exe");
        fs::create_dir_all(bin.parent().unwrap()).unwrap();
        fs::write(&bin, b"fake").unwrap();

        assert_eq!(
            find_bundled_claude_cli_in_base(&base, "windows", "x86_64"),
            Some(bin)
        );

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn claude_cli_managed_path_matches_runtime_setup_layout() {
        let base = temp_data_dir("claude-cli-managed");
        let expected = base
            .join("runtimes")
            .join("claude-agent-sdk")
            .join(crate::runtime_catalog::claude_version())
            .join("darwin-arm64")
            .join("claude");

        assert_eq!(
            managed_claude_cli_path(&base, "macos", "aarch64"),
            Some(expected)
        );

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn claude_cli_path_search_honors_windows_pathext() {
        let base = temp_data_dir("claude-cli-path");
        fs::create_dir_all(&base).unwrap();
        let bin = base.join("claude.CMD");
        fs::write(&bin, b"fake").unwrap();
        let path = std::env::join_paths([base.clone()]).unwrap();

        assert_eq!(
            find_claude_cli_on_path(path.to_str(), Some(".CMD"), "windows"),
            Some(bin)
        );

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn auth_status_parser_returns_null_on_invalid_json() {
        let parsed = parse_auth_status_stdout(r#"{"authenticated":true,"email":"u@example.com"}"#);
        assert_eq!(parsed["authenticated"], true);
        assert_eq!(parsed["email"], "u@example.com");

        assert_eq!(parse_auth_status_stdout("not json"), Value::Null);
    }

    #[test]
    fn account_info_from_auth_status_keeps_public_metadata() {
        let info = account_info_from_auth_status(&json!({
            "loggedIn": true,
            "email": "u@example.com",
            "subscriptionType": "pro",
            "token": "secret"
        }));
        assert_eq!(info["email"], "u@example.com");
        assert_eq!(info["subscriptionType"], "pro");
        assert!(info.get("token").is_none());

        assert_eq!(
            account_info_from_auth_status(&json!({ "loggedIn": false })),
            Value::Null
        );
    }

    #[test]
    fn scan_commands_dir_reads_markdown_commands() {
        let base = temp_data_dir("scan-commands");
        let dir = base.join(".claude").join("commands");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("deploy.md"), "# Deploy app\nRun deployment").unwrap();

        let entries = scan_commands_dir(&dir, "project");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "deploy");
        assert_eq!(entries[0].description, "Deploy app");
        assert_eq!(entries[0].scope, "project");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn scan_skills_dir_reads_skill_frontmatter() {
        let base = temp_data_dir("scan-skills");
        let dir = base.join(".claude").join("skills").join("review");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: code-review\ndescription: Review changes\n---\n# Ignored heading",
        )
        .unwrap();

        let entries = scan_skills_dir(&base.join(".claude").join("skills"), "project");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "code-review");
        assert_eq!(entries[0].description, "Review changes");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn scan_skills_native_project_commands_take_precedence() {
        let base = temp_data_dir("scan-native");
        let command_dir = base.join(".claude").join("commands");
        let skill_dir = base.join(".claude").join("skills").join("deploy");
        fs::create_dir_all(&command_dir).unwrap();
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(command_dir.join("deploy.md"), "# Command deploy").unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: deploy\n---\n# Skill deploy",
        )
        .unwrap();

        let entries = scan_skills_native(&base);
        let deploy = entries
            .iter()
            .find(|entry| entry.name == "deploy")
            .expect("deploy entry");
        assert_eq!(deploy.description, "Command deploy");
        assert_eq!(deploy.scope, "project");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn mcp_status_detects_project_approval_sources() {
        let base = temp_data_dir("mcp-status");
        fs::create_dir_all(base.join(".claude")).unwrap();
        fs::write(
            base.join(".mcp.json"),
            r#"{"mcpServers":{"foo":{"command":"x"},"bar":{"command":"y"}}}"#,
        )
        .unwrap();

        let status = check_mcp_json_status_native(&base);
        assert_eq!(status["exists"], true);
        assert_eq!(status["approved"], false);
        assert_eq!(status["servers"].as_array().unwrap().len(), 2);

        fs::write(
            base.join(".claude").join("settings.local.json"),
            r#"{"enabledMcpjsonServers":["foo","bar"]}"#,
        )
        .unwrap();
        let approved = check_mcp_json_status_native(&base);
        assert_eq!(approved["approved"], true);

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn enable_all_project_mcp_preserves_existing_settings() {
        let base = temp_data_dir("mcp-enable");
        let settings_dir = base.join(".claude");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::write(settings_dir.join("settings.json"), r#"{"otherKey":"keep"}"#).unwrap();

        let first = enable_all_project_mcp_native(&base).expect("enable mcp");
        assert_eq!(first["ok"], true);
        assert_eq!(first["changed"], true);
        let written = read_json_safe(&settings_dir.join("settings.json")).unwrap();
        assert_eq!(written["otherKey"], "keep");
        assert_eq!(written["enableAllProjectMcpServers"], true);

        let second = enable_all_project_mcp_native(&base).expect("enable mcp again");
        assert_eq!(second["changed"], false);

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn list_claude_sessions_reads_project_jsonl_previews() {
        let base = temp_data_dir("claude-session-list");
        let projects_dir = base.join("projects");
        let cwd = "C:\\repo app";
        let session_dir = projects_dir.join(encode_claude_project_dir(cwd));
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(
            session_dir.join("sdk-1.jsonl"),
            r#"{"type":"system","message":{}}
{"type":"user","message":{"content":[{"type":"text","text":"hello from history"}]}}
{"type":"summary","summary":"Meaningful session title"}
"#,
        )
        .unwrap();

        let sessions = list_claude_sessions_in_projects(cwd, &projects_dir);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].sdk_session_id, "sdk-1");
        assert_eq!(sessions[0].preview, "hello from history");
        assert_eq!(
            sessions[0].custom_title.as_deref(),
            Some("Meaningful session title")
        );
        assert_eq!(
            sessions[0].first_prompt.as_deref(),
            Some("hello from history")
        );
        assert_eq!(
            sessions[0].summary.as_deref(),
            Some("Meaningful session title")
        );
        assert_eq!(sessions[0].message_count, 3);

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn uuid_generation_produces_v4_shape() {
        let id = generate_uuid_v4();
        assert!(is_uuid_like(&id));
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn shell_quote_preserves_windows_paths_and_quotes() {
        assert_eq!(
            shell_quote(r"C:\Users\User\AppData\Local\node.exe"),
            r#"'C:\Users\User\AppData\Local\node.exe'"#
        );
        assert_eq!(
            shell_quote("C:\\Users\\O'Malley"),
            r#"'C:\Users\O'"'"'Malley'"#
        );
    }

    #[test]
    fn windows_verbatim_paths_are_normalized_for_bash() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\User\node.exe"),
            "C:/Users/User/node.exe"
        );
        assert_eq!(
            drive_letter_mount_path(r"\\?\C:\Users\User\node.exe", "/mnt").as_deref(),
            Some("/mnt/c/Users/User/node.exe")
        );
    }

    #[test]
    fn claude_cli_hook_command_uses_bash_mounts_for_windows_node() {
        let command = build_claude_cli_hook_command(
            Path::new(
                r"C:\Users\User\AppData\Local\Programs\BetterAgentTerminal\node-runtime\windows-x86_64\node.exe",
            ),
            Path::new(
                r"C:\Users\User\AppData\Roaming\better-agent-terminal\claude-cli\hook-session-start.mjs",
            ),
            Path::new(
                r"C:\Users\User\AppData\Roaming\better-agent-terminal\claude-cli\session-events.jsonl",
            ),
            "term-1",
            "ws-1",
            "claude-cli",
            r"C:\workspaces\tools\better-terminal",
        );

        assert!(command.contains(
            "'/mnt/c/Users/User/AppData/Local/Programs/BetterAgentTerminal/node-runtime/windows-x86_64/node.exe'"
        ));
        assert!(command.contains(
            "'/c/Users/User/AppData/Local/Programs/BetterAgentTerminal/node-runtime/windows-x86_64/node.exe'"
        ));
        assert!(command.contains(
            "'C:\\Users\\User\\AppData\\Roaming\\better-agent-terminal\\claude-cli\\hook-session-start.mjs'"
        ));
        assert!(command.contains("'C:\\workspaces\\tools\\better-terminal'"));
        assert!(!command.contains("C:Users"));
    }

    #[test]
    fn claude_cli_hook_command_handles_verbatim_windows_node_path() {
        let command = build_claude_cli_hook_command(
            Path::new(
                r"\\?\C:\Users\User\AppData\Local\Programs\BetterAgentTerminal\node-runtime\windows-x86_64\node.exe",
            ),
            Path::new(
                r"C:\Users\User\AppData\Roaming\better-agent-terminal\claude-cli\hook-session-start.mjs",
            ),
            Path::new(
                r"C:\Users\User\AppData\Roaming\better-agent-terminal\claude-cli\session-events.jsonl",
            ),
            "term-1",
            "ws-1",
            "claude-cli",
            r"C:\workspaces\tools\better-terminal",
        );

        assert!(command.contains(
            "'/mnt/c/Users/User/AppData/Local/Programs/BetterAgentTerminal/node-runtime/windows-x86_64/node.exe'"
        ));
        assert!(!command.contains(r"\?\C:"));
        assert!(!command.contains("//?/C:"));
    }

    #[test]
    fn claude_cli_session_selection_prefers_latest_terminal_event() {
        let base = temp_data_dir("claude-cli-events");
        fs::create_dir_all(&base).unwrap();
        let events_path = base.join("session-events.jsonl");
        fs::write(
            &events_path,
            [
                r#"{"terminalId":"term-1","workspaceId":"ws","agentPreset":"claude-cli","sessionId":"old-session","cwd":"C:/repo","timestamp":1}"#,
                r#"{"terminalId":"term-2","workspaceId":"ws","agentPreset":"claude-cli","sessionId":"other-session","cwd":"C:/repo","timestamp":2}"#,
                r#"{"terminalId":"term-1","workspaceId":"ws","agentPreset":"claude-cli","sessionId":"new-session","cwd":"C:/repo","timestamp":3}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let (session_id, source) = choose_claude_cli_session(
            &events_path,
            "term-1",
            "ws",
            "C:/repo",
            "claude-cli",
            Some("state-session"),
        );
        assert_eq!(session_id, "new-session");
        assert_eq!(source, "terminal-event");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn claude_cli_session_selection_uses_state_then_workspace_then_new() {
        let base = temp_data_dir("claude-cli-fallbacks");
        fs::create_dir_all(&base).unwrap();
        let events_path = base.join("session-events.jsonl");
        fs::write(
            &events_path,
            r#"{"terminalId":"term-x","workspaceId":"ws","agentPreset":"claude-cli","sessionId":"workspace-session","cwd":"C:/repo","timestamp":1}"#,
        )
        .unwrap();

        let (state_session, state_source) = choose_claude_cli_session(
            &events_path,
            "term-1",
            "ws",
            "C:/repo",
            "claude-cli",
            Some("state-session"),
        );
        assert_eq!(state_session, "state-session");
        assert_eq!(state_source, "terminal-state");

        let (workspace_session, workspace_source) =
            choose_claude_cli_session(&events_path, "term-1", "ws", "C:/repo", "claude-cli", None);
        assert_eq!(workspace_session, "workspace-session");
        assert_eq!(workspace_source, "workspace-event");

        let (new_session, new_source) =
            choose_claude_cli_session(&events_path, "term-1", "ws", "C:/other", "claude-cli", None);
        assert!(is_uuid_like(&new_session));
        assert_eq!(new_source, "new");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn list_codex_sessions_reads_nested_session_meta_and_preview() {
        let base = temp_data_dir("codex-session-list");
        let nested = base.join("2026").join("05").join("11");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            nested.join("rollout.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"thread-1","cwd":"/repo/app"}}
{"type":"event_msg","payload":{"input":"ping\nsecond line"}}
"#,
        )
        .unwrap();
        fs::write(
            nested.join("other.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"thread-2","cwd":"/repo/other"}}
{"type":"event_msg","payload":{"input":"other cwd"}}
"#,
        )
        .unwrap();

        let sessions = list_codex_sessions_in_root(&base, "/repo/app/");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].sdk_session_id, "thread-1");
        assert_eq!(sessions[0].preview, "ping");
        assert_eq!(sessions[0].message_count, 0);

        let missing = list_codex_sessions_in_root(&base, "/repo/missing");
        assert!(missing.is_empty());

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn claude_builtin_models_include_sources_and_current_defaults() {
        let models = claude_builtin_models_native();
        let values = models
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["value"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(values.contains(&"claude-opus-5:auto-compact-200k"));
        assert!(values.contains(&"claude-opus-4-8:auto-compact-200k"));
        assert!(values.contains(&"claude-opus-4-7:auto-compact-200k"));
        assert!(values.contains(&"claude-sonnet-4-6"));
        assert!(models
            .as_array()
            .unwrap()
            .iter()
            .all(|model| model["source"] == "builtin"));
    }

    #[test]
    fn notification_session_meta_matches_sidecar_shape_defaults() {
        let session = notification_cmd::AgentNotificationSession {
            window_id: Some("main".into()),
            profile_id: Some("default".into()),
            workspace_id: None,
            workspace_name: None,
            cwd: "C:/repo".into(),
            agent_kind: Some("claude".into()),
            model: Some("claude-opus-4-7:auto-compact-300k".into()),
            permission_mode: Some("bypassPermissions".into()),
            effort: Some("high".into()),
            auto_compact_window: Some(300_000),
            sdk_session_id: Some("sdk-1".into()),
            codex_sandbox_mode: None,
            codex_approval_policy: None,
            latest_meta: None,
            original_cwd: None,
            worktree_path: None,
            worktree_branch: None,
            auto_continue: None,
            is_resting: false,
        };

        let meta = session_meta_from_notification_snapshot(&session);
        assert_eq!(meta["permissionMode"], "bypassPermissions");
        assert_eq!(meta["model"], "claude-opus-4-7:auto-compact-300k");
        assert_eq!(meta["effort"], "high");
        assert_eq!(meta["autoCompactWindow"], 300_000);
        assert_eq!(meta["sdkSessionId"], "sdk-1");
        assert_eq!(meta["cwd"], "C:/repo");
        assert_eq!(meta["contextWindow"], 300_000);
        assert_eq!(meta["inputTokens"], 0);
        assert_eq!(meta["outputTokens"], 0);
        assert_eq!(meta["numTurns"], 0);
    }

    #[test]
    fn notification_session_state_matches_sidecar_shape_with_cached_flags() {
        let session = notification_cmd::AgentNotificationSession {
            window_id: Some("main".into()),
            profile_id: Some("default".into()),
            workspace_id: None,
            workspace_name: None,
            cwd: "C:/repo".into(),
            agent_kind: Some("claude".into()),
            model: Some("claude-sonnet-4-6".into()),
            permission_mode: Some("plan".into()),
            effort: Some("medium".into()),
            auto_compact_window: Some(400_000),
            sdk_session_id: Some("sdk-1".into()),
            codex_sandbox_mode: Some("workspace-write".into()),
            codex_approval_policy: Some("on-request".into()),
            latest_meta: None,
            original_cwd: None,
            worktree_path: None,
            worktree_branch: None,
            auto_continue: Some(json!({
                "enabled": true,
                "max": 3,
                "used": 1,
                "prompt": "continue",
            })),
            is_resting: true,
        };

        let state = session_state_from_notification_snapshot(&session);
        assert_eq!(state["active"], true);
        assert_eq!(state["permissionMode"], "plan");
        assert_eq!(state["model"], "claude-sonnet-4-6");
        assert_eq!(state["effort"], "medium");
        assert_eq!(state["autoContinue"]["enabled"], true);
        assert_eq!(state["autoContinue"]["max"], 3);
        assert_eq!(state["autoContinue"]["used"], 1);
        assert_eq!(state["autoContinue"]["prompt"], "continue");
        assert_eq!(state["isResting"], true);
        assert_eq!(state["autoCompactWindow"], 400_000);
        assert_eq!(state["codexSandboxMode"], "workspace-write");
        assert_eq!(state["codexApprovalPolicy"], "on-request");
    }

    #[test]
    fn notification_context_usage_matches_sidecar_cached_shape() {
        let session = notification_cmd::AgentNotificationSession {
            window_id: Some("main".into()),
            profile_id: Some("default".into()),
            workspace_id: None,
            workspace_name: None,
            cwd: "C:/repo".into(),
            agent_kind: Some("claude".into()),
            model: Some("claude-sonnet-4-6".into()),
            permission_mode: Some("default".into()),
            effort: None,
            auto_compact_window: None,
            sdk_session_id: Some("sdk-1".into()),
            codex_sandbox_mode: None,
            codex_approval_policy: None,
            latest_meta: Some(json!({
                "model": "claude-sonnet-4-6",
                "inputTokens": 120,
                "outputTokens": 40,
                "cacheCreationTokens": 30,
                "cacheReadTokens": 50,
                "contextTokens": 200,
                "contextWindow": 1_000_000,
            })),
            original_cwd: None,
            worktree_path: None,
            worktree_branch: None,
            auto_continue: None,
            is_resting: false,
        };

        let usage = context_usage_from_notification_snapshot(&session).expect("context usage");
        assert_eq!(usage["totalTokens"], 200);
        assert_eq!(usage["maxTokens"], 1_000_000);
        assert_eq!(usage["percentage"], 0);
        assert_eq!(usage["model"], "claude-sonnet-4-6");
        assert_eq!(usage["categories"][0]["name"], "Context");
        assert_eq!(usage["categories"][0]["tokens"], 200);
        assert_eq!(usage["apiUsage"]["input_tokens"], 120);
        assert_eq!(usage["apiUsage"]["output_tokens"], 40);
        assert_eq!(usage["apiUsage"]["cache_creation_input_tokens"], 30);
        assert_eq!(usage["apiUsage"]["cache_read_input_tokens"], 50);
    }

    #[test]
    fn notification_context_usage_returns_none_without_tokens() {
        let session = notification_cmd::AgentNotificationSession {
            window_id: Some("main".into()),
            profile_id: Some("default".into()),
            workspace_id: None,
            workspace_name: None,
            cwd: "C:/repo".into(),
            agent_kind: Some("claude".into()),
            model: Some("claude-sonnet-4-6".into()),
            permission_mode: Some("default".into()),
            effort: None,
            auto_compact_window: None,
            sdk_session_id: Some("sdk-1".into()),
            codex_sandbox_mode: None,
            codex_approval_policy: None,
            latest_meta: Some(json!({
                "model": "claude-sonnet-4-6",
                "inputTokens": 0,
                "outputTokens": 0,
                "cacheCreationTokens": 0,
                "cacheReadTokens": 0,
                "contextTokens": 0,
            })),
            original_cwd: None,
            worktree_path: None,
            worktree_branch: None,
            auto_continue: None,
            is_resting: false,
        };

        assert_eq!(context_usage_from_notification_snapshot(&session), None);
    }

    #[test]
    fn notification_session_meta_prefers_latest_status_meta() {
        let session = notification_cmd::AgentNotificationSession {
            window_id: Some("main".into()),
            profile_id: Some("default".into()),
            workspace_id: None,
            workspace_name: None,
            cwd: "C:/repo".into(),
            agent_kind: Some("claude".into()),
            model: Some("claude-sonnet-4-6".into()),
            permission_mode: Some("default".into()),
            effort: None,
            auto_compact_window: None,
            sdk_session_id: None,
            codex_sandbox_mode: None,
            codex_approval_policy: None,
            latest_meta: Some(json!({
                "model": "claude-sonnet-4-6",
                "sdkSessionId": "sdk-live",
                "inputTokens": 12,
                "outputTokens": 5,
                "numTurns": 1
            })),
            original_cwd: None,
            worktree_path: None,
            worktree_branch: None,
            auto_continue: None,
            is_resting: false,
        };

        let meta = session_meta_from_notification_snapshot(&session);
        assert_eq!(meta["sdkSessionId"], "sdk-live");
        assert_eq!(meta["inputTokens"], 12);
        assert_eq!(meta["numTurns"], 1);
    }

    #[test]
    fn worktree_status_returns_none_without_registered_worktree() {
        let session = notification_cmd::AgentNotificationSession {
            window_id: Some("main".into()),
            profile_id: Some("default".into()),
            workspace_id: None,
            workspace_name: None,
            cwd: "C:/repo".into(),
            agent_kind: Some("claude".into()),
            model: None,
            permission_mode: None,
            effort: None,
            auto_compact_window: None,
            sdk_session_id: None,
            codex_sandbox_mode: None,
            codex_approval_policy: None,
            latest_meta: None,
            original_cwd: None,
            worktree_path: None,
            worktree_branch: None,
            auto_continue: None,
            is_resting: false,
        };

        assert_eq!(worktree_status_from_notification_snapshot(&session), None);
        assert!(!cleanup_worktree_from_notification_snapshot(&session, true));
    }

    #[test]
    fn worktree_git_root_resolves_bat_worktree_parent() {
        let root =
            worktree_git_root_from_path("C:/repo/.bat-worktrees/abc123").expect("git root path");
        assert!(root.ends_with(Path::new("C:/repo")));
    }

    #[test]
    #[ignore = "environment-sensitive: supported_commands_native also includes global ~/.claude/commands"]
    fn supported_commands_native_reads_project_commands() {
        let base = temp_data_dir("supported-commands");
        let command_dir = base.join(".claude").join("commands");
        fs::create_dir_all(&command_dir).unwrap();
        fs::write(command_dir.join("deploy.md"), "# Deploy\nRun deploy").unwrap();

        let commands = supported_commands_native(&base);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "deploy");
        assert_eq!(commands[0].description, "Deploy");
        assert_eq!(commands[0].argument_hint, "");

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn supported_agents_native_reads_frontmatter() {
        let base = temp_data_dir("supported-agents");
        let agent_dir = base.join(".claude").join("agents");
        fs::create_dir_all(&agent_dir).unwrap();
        fs::write(
            agent_dir.join("reviewer.md"),
            "---\nname: reviewer\ndescription: Review code\nmodel: claude-sonnet-4-6\n---\n# Ignored",
        )
        .unwrap();

        let agents = supported_agents_native(&base);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name, "reviewer");
        assert_eq!(agents[0].description, "Review code");
        assert_eq!(agents[0].model.as_deref(), Some("claude-sonnet-4-6"));

        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn archive_helpers_tail_page_and_clear_messages() {
        let data_dir = temp_data_dir("archive");
        let first_batch = json!([
            { "id": "m1", "content": "one" },
            { "id": "m2", "content": "two" },
            { "id": "m3", "content": "three" }
        ]);
        let second_batch = json!([{ "id": "m4", "content": "four" }]);

        assert_eq!(
            load_archived_from_dir(&data_dir, "session/with:unsafe", 0, 2),
            archive_empty_page()
        );
        assert_eq!(
            archive_messages_in_dir(&data_dir, "session/with:unsafe", &first_batch)
                .expect("archive first"),
            true
        );
        assert_eq!(
            archive_messages_in_dir(&data_dir, "session/with:unsafe", &second_batch)
                .expect("archive second"),
            true
        );

        let page = load_archived_from_dir(&data_dir, "session/with:unsafe", 0, 2);
        assert_eq!(page["total"], 4);
        assert_eq!(page["hasMore"], true);
        assert_eq!(page["messages"][0]["id"], "m3");
        assert_eq!(page["messages"][1]["id"], "m4");

        let previous_page = load_archived_from_dir(&data_dir, "session/with:unsafe", 2, 2);
        assert_eq!(previous_page["total"], 4);
        assert_eq!(previous_page["hasMore"], false);
        assert_eq!(previous_page["messages"][0]["id"], "m1");
        assert_eq!(previous_page["messages"][1]["id"], "m2");

        assert!(clear_archive_in_dir(&data_dir, "session/with:unsafe"));
        assert_eq!(
            load_archived_from_dir(&data_dir, "session/with:unsafe", 0, 2),
            archive_empty_page()
        );

        fs::remove_dir_all(data_dir).ok();
    }

    #[test]
    fn archive_helpers_reject_invalid_input_without_side_effects() {
        let data_dir = temp_data_dir("archive-invalid");

        assert_eq!(
            archive_messages_in_dir(&data_dir, "", &json!([])).expect("empty session"),
            false
        );
        assert_eq!(
            archive_messages_in_dir(&data_dir, "s-1", &json!({ "not": "an array" }))
                .expect("not array"),
            false
        );
        assert_eq!(clear_archive_in_dir(&data_dir, ""), false);

        fs::remove_dir_all(data_dir).ok();
    }
}
