// Persistent Codex app-server controller.
//
// This is intentionally a compatibility adapter, not a renderer contract
// change. Codex app-server speaks JSON-RPC over JSONL; this module maps its
// thread/turn/item notifications back into the existing claude:* event shape
// consumed by the renderer.

use crate::app_data;
use crate::codex_account_store;
use crate::codex_auth;
use crate::commands::app as app_cmd;
use crate::event_hub::publish_runtime_event;
use crate::sidecar::BridgeError;
use crate::subprocess::hide_console_window;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::Hasher;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, UNIX_EPOCH};
// Manager is only needed for the desktop resource-dir escape hatch (app.app()).
#[cfg(feature = "desktop")]
use tauri::Manager;

use crate::host_context::HostContext;

const DEFAULT_CODEX_MODEL: &str = "gpt-5.6-sol";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_START_TIMEOUT: Duration = Duration::from_secs(60);
const MSG_BUFFER_CAP: usize = 300;
const DEFAULT_CODEX_CONTEXT_WINDOW: u64 = 1_000_000;
const GPT_5_6_CONTEXT_WINDOW_FALLBACK: u64 = 353_400;
const DEFAULT_CODEX_REASONING_SUMMARY: &str = "auto";
const COMMAND_OUTPUT_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const CODEX_ACCOUNT_STATE_FILE: &str = "codex-account-state.json";
static CODEX_TEMP_IMAGE_COUNTER: AtomicU64 = AtomicU64::new(0);

type ReplySender = Sender<Result<Value, String>>;

#[derive(Default)]
struct PendingTable {
    inner: Mutex<HashMap<u64, ReplySender>>,
}

impl PendingTable {
    fn insert(&self, id: u64, tx: ReplySender) {
        self.inner
            .lock()
            .expect("codex pending lock")
            .insert(id, tx);
    }

    fn take(&self, id: u64) -> Option<ReplySender> {
        self.inner.lock().expect("codex pending lock").remove(&id)
    }

    fn drain_all(&self) -> Vec<ReplySender> {
        self.inner
            .lock()
            .expect("codex pending lock")
            .drain()
            .map(|(_, tx)| tx)
            .collect()
    }
}

struct CodexConnection {
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Arc<PendingTable>,
    child: Mutex<Child>,
    pid: u32,
    auth_account_id: Option<String>,
    /// CodexBinary::identity() of the binary this app-server was spawned
    /// with; ensure_connection recycles the connection when a different
    /// binary resolves (managed runtime installed after a fallback spawn).
    binary_identity: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAccountState {
    active_codex_home: Option<String>,
}

impl CodexConnection {
    fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({ "method": method, "params": params });
        let mut stdin = self.stdin.lock().map_err(|_| "codex stdin lock poisoned")?;
        writeln!(stdin, "{message}").map_err(|err| err.to_string())?;
        stdin.flush().map_err(|err| err.to_string())
    }

    // Reply to a server->client JSON-RPC request (e.g. approval requests).
    // Codex blocks the active turn until the request id receives a response.
    fn send_response(&self, id: Value, result: Value) -> Result<(), String> {
        let message = json!({ "id": id, "result": result });
        let mut stdin = self.stdin.lock().map_err(|_| "codex stdin lock poisoned")?;
        writeln!(stdin, "{message}").map_err(|err| err.to_string())?;
        stdin.flush().map_err(|err| err.to_string())
    }

    fn send_error_response(&self, id: Value, code: i64, message_text: &str) -> Result<(), String> {
        let message = json!({
            "id": id,
            "error": { "code": code, "message": message_text }
        });
        let mut stdin = self.stdin.lock().map_err(|_| "codex stdin lock poisoned")?;
        writeln!(stdin, "{message}").map_err(|err| err.to_string())?;
        stdin.flush().map_err(|err| err.to_string())
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.alloc_id();
        let message = json!({ "method": method, "id": id, "params": params });
        let (tx, rx) = channel();
        self.pending.insert(id, tx);
        {
            let mut stdin = self.stdin.lock().map_err(|_| "codex stdin lock poisoned")?;
            if let Err(err) = writeln!(stdin, "{message}") {
                let _ = self.pending.take(id);
                return Err(err.to_string());
            }
            if let Err(err) = stdin.flush() {
                let _ = self.pending.take(id);
                return Err(err.to_string());
            }
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                let _ = self.pending.take(id);
                Err(format!("codex app-server request timed out: {method}"))
            }
        }
    }

    fn request_logged(
        &self,
        app: &HostContext,
        session_id: &str,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let started = Instant::now();
        log_codex(
            app,
            session_id,
            format!("jsonrpc request start pid={} method={method}", self.pid),
        );
        let result = self.request(method, params, timeout);
        match &result {
            Ok(_) => log_codex(
                app,
                session_id,
                format!(
                    "jsonrpc request ok pid={} method={method} elapsedMs={}",
                    self.pid,
                    started.elapsed().as_millis()
                ),
            ),
            Err(err) => log_codex(
                app,
                session_id,
                format!(
                    "jsonrpc request failed pid={} method={method} elapsedMs={} error={err}",
                    self.pid,
                    started.elapsed().as_millis()
                ),
            ),
        }
        result
    }
}

impl Drop for CodexConnection {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// A server->client approval request (item/commandExecution/requestApproval or
// item/fileChange/requestApproval) waiting for the user's decision. The JSON-RPC
// request must be answered on the same connection or codex blocks the turn.
struct PendingApproval {
    request_id: Value,
    session_id: String,
    connection: Weak<CodexConnection>,
}

#[derive(Default)]
struct CodexInner {
    connection: Mutex<Option<Arc<CodexConnection>>>,
    sessions: Mutex<HashMap<String, CodexSession>>,
    thread_to_session: Mutex<HashMap<String, String>>,
    // Keyed by the synthetic toolUseId surfaced to the renderer
    // (claude:permission-request events).
    pending_approvals: Mutex<HashMap<String, PendingApproval>>,
    // Serializes unified-account auth catalog operations so concurrent windows
    // cannot interleave auth.json switches/captures.
    unified_swap_lock: Mutex<()>,
    // Set by account_login_cancel() to abort an in-flight `codex login` child;
    // the run_codex_login poll loop kills the process when it sees this.
    login_cancel: AtomicBool,
    // Remote device-code login child, kept alive between the device-login start
    // RPC (returns the sign-in URL + one-time code) and the poll RPC (waits for
    // the user to approve in their browser). None when no device login is in
    // flight. See account_login_device_start / account_login_device_poll.
    device_login: Mutex<Option<DeviceLoginSession>>,
}

/// Output captured from a running `codex login --device-auth` child while we
/// wait for it to print the sign-in URL and one-time code.
#[derive(Default)]
struct DeviceCapture {
    text: String,
    url: Option<String>,
    code: Option<String>,
    saw_code_marker: bool,
}

/// An in-flight `codex login --device-auth`. The child keeps polling OpenAI
/// until the user approves (or it times out / is cancelled); we reap it in the
/// poll RPC. Output is drained off-thread into `capture` so the pipe never
/// blocks the child.
struct DeviceLoginSession {
    child: Child,
    capture: Arc<Mutex<DeviceCapture>>,
    started: Instant,
}

#[derive(Clone, Default)]
pub struct CodexAppServerState {
    inner: Arc<CodexInner>,
}

#[derive(Clone)]
struct CodexSession {
    session_id: String,
    thread_id: Option<String>,
    cwd: String,
    model: String,
    sandbox_mode: String,
    approval_policy: String,
    effort: String,
    context_window: u64,
    start_time: Instant,
    active_turn_id: Option<String>,
    active_turn_key: Option<String>,
    assistant_text: String,
    thinking_text: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    num_turns: u64,
    last_turn_started_at: Option<Instant>,
    last_turn_first_token_ms: Option<u64>,
    last_turn_duration_ms: Option<u64>,
    messages: Vec<Value>,
    temporary_image_paths: Vec<PathBuf>,
    command_outputs: HashMap<String, String>,
    command_output_last_emit: HashMap<String, Instant>,
    runtime_status: Option<String>,
    runtime_message: Option<String>,
    runtime_status_started_at: Option<u128>,
    is_running: bool,
    is_resting: bool,
    abort_requested: bool,
    ignored_turn_ids: Vec<String>,
}

impl CodexSession {
    fn metadata(&self) -> Value {
        // cached input is a subset of input tokens in the Codex app-server
        // protocol, so adding it again would double-count context usage.
        let context_tokens = self.input_tokens + self.output_tokens;
        json!({
            "model": self.model,
            "sdkSessionId": self.thread_id,
            "cwd": self.cwd,
            "totalCost": 0,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "durationMs": self.start_time.elapsed().as_millis() as u64,
            "numTurns": self.num_turns,
            "contextWindow": self.context_window,
            "maxOutputTokens": 0,
            "contextTokens": context_tokens,
            "cacheReadTokens": self.cache_read_tokens,
            "cacheCreationTokens": 0,
            "callCacheRead": 0,
            "callCacheWrite": 0,
            "lastQueryCalls": 1,
            "codexSandboxMode": self.sandbox_mode,
            "codexApprovalPolicy": self.approval_policy,
            "effort": self.effort,
            "lastTurnFirstTokenMs": self.last_turn_first_token_ms,
            "lastTurnDurationMs": self.last_turn_duration_ms,
            "runtimeStatus": self.runtime_status.as_deref(),
            "runtimeMessage": self.runtime_message.as_deref(),
            "runtimeStatusStartedAt": self.runtime_status_started_at,
        })
    }
}

fn set_runtime_status(session: &mut CodexSession, status: &str, message: &str) {
    session.runtime_status = Some(status.to_string());
    session.runtime_message = Some(message.to_string());
    session.runtime_status_started_at = Some(now_millis());
}

fn clear_runtime_status(session: &mut CodexSession) {
    session.runtime_status = None;
    session.runtime_message = None;
    session.runtime_status_started_at = None;
}

fn clear_runtime_status_if_set(session: &mut CodexSession) -> bool {
    let had_status = session.runtime_status.is_some()
        || session.runtime_message.is_some()
        || session.runtime_status_started_at.is_some();
    if had_status {
        clear_runtime_status(session);
    }
    had_status
}

fn remember_ignored_turn(session: &mut CodexSession, turn_id: String) {
    if !session.ignored_turn_ids.iter().any(|id| id == &turn_id) {
        session.ignored_turn_ids.push(turn_id);
    }
    if session.ignored_turn_ids.len() > 16 {
        let drop_count = session.ignored_turn_ids.len() - 16;
        session.ignored_turn_ids.drain(0..drop_count);
    }
}

fn codex_context_window_for_model(model: &str) -> u64 {
    match model {
        // The app-server reports the authoritative value in token usage updates.
        // Keep this fallback accurate before the first update arrives.
        "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" => GPT_5_6_CONTEXT_WINDOW_FALLBACK,
        "gpt-5.5"
        | "gpt-5.4"
        | "gpt-5.4-mini"
        | "gpt-5.3-codex"
        | "gpt-5.3-codex-spark"
        | "codex-mini-latest"
        | "o4-mini"
        | "o3"
        | "gpt-4.1" => DEFAULT_CODEX_CONTEXT_WINDOW,
        _ if model.starts_with("gpt-5.") => DEFAULT_CODEX_CONTEXT_WINDOW,
        _ => DEFAULT_CODEX_CONTEXT_WINDOW,
    }
}

fn bridge_error(message: impl Into<String>) -> BridgeError {
    BridgeError {
        message: message.into(),
    }
}

pub fn is_codex_agent_preset_id(preset: Option<&str>) -> bool {
    match preset {
        Some("codex-agent") => true,
        Some("codex-agent-worktree") => true,
        _ => false,
    }
}

fn is_codex_agent_preset(options: &Value) -> bool {
    is_codex_agent_preset_id(options.get("agentPreset").and_then(Value::as_str))
}

pub fn should_handle_codex(options: &Option<Value>) -> bool {
    options.as_ref().map(is_codex_agent_preset).unwrap_or(false)
}

fn effective_cwd(options: &Value, context: &str) -> Result<String, BridgeError> {
    if options
        .get("useWorktree")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        if let Some(path) = options
            .get("worktreePath")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
        {
            return Ok(path.to_string());
        }
    }
    let cwd = options
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| bridge_error(format!("codex app-server {context}: missing cwd")))?
        .to_string();
    Ok(cwd)
}

fn worktree_payload(options: &Value) -> Option<Value> {
    if !options
        .get("useWorktree")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let worktree_path = options
        .get("worktreePath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())?;
    let branch_name = options
        .get("worktreeBranch")
        .and_then(Value::as_str)
        .filter(|branch| !branch.trim().is_empty())
        .unwrap_or("worktree");
    let git_root = Path::new(worktree_path)
        .parent()
        .and_then(Path::parent)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    Some(json!({
        "branchName": branch_name,
        "worktreePath": worktree_path,
        "sourceBranch": "",
        "gitRoot": git_root,
    }))
}

fn normalize_effort(value: Option<&str>) -> String {
    match value {
        Some(effort @ ("minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra")) => {
            effort.to_string()
        }
        _ => "high".to_string(),
    }
}

fn normalize_sandbox(value: Option<&str>) -> String {
    match value {
        Some("read-only") => "read-only".to_string(),
        Some("danger-full-access") => "danger-full-access".to_string(),
        _ => "workspace-write".to_string(),
    }
}

fn app_server_sandbox(value: &str) -> &'static str {
    match value {
        "read-only" => "read-only",
        "danger-full-access" => "danger-full-access",
        _ => "workspace-write",
    }
}

fn normalize_approval(value: Option<&str>) -> String {
    match value {
        Some("untrusted" | "on-request" | "never") => value.unwrap().to_string(),
        _ => "on-request".to_string(),
    }
}

enum CodexBinary {
    Native(PathBuf),
    Wrapper(String),
}

impl CodexBinary {
    /// Stable identity of a resolution result, recorded on the connection at
    /// spawn time so ensure_connection can tell when a *different* binary
    /// would resolve today (e.g. the managed runtime finished installing
    /// after this app-server was spawned from a PATH/npm fallback).
    fn identity(&self) -> String {
        match self {
            CodexBinary::Native(path) => format!("native:{}", path.display()),
            CodexBinary::Wrapper(command_name) => format!("wrapper:{command_name}"),
        }
    }
}

fn codex_exe_name() -> &'static str {
    if cfg!(windows) {
        "codex.exe"
    } else {
        "codex"
    }
}

fn codex_target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        _ => None,
    }
}

fn codex_platform_package() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("codex-linux-x64"),
        ("linux", "aarch64") => Some("codex-linux-arm64"),
        ("macos", "x86_64") => Some("codex-darwin-x64"),
        ("macos", "aarch64") => Some("codex-darwin-arm64"),
        ("windows", "x86_64") => Some("codex-win32-x64"),
        ("windows", "aarch64") => Some("codex-win32-arm64"),
        _ => None,
    }
}

fn codex_runtime_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        _ => None,
    }
}

fn managed_codex_candidate(app: &HostContext) -> Option<PathBuf> {
    // Managed installs mirror the npm package layout (bin/ + codex-package.json
    // + codex-resources/ + codex-path/). Legacy flat installs (codex at the key
    // root) are deliberately not resolved: they lack the code-mode-host and
    // sandbox helper binaries, and skipping them lets the auto-installer
    // replace them with a complete layout.
    let path = app
        .data_dir_opt()?
        .join("runtimes")
        .join("codex")
        .join(crate::runtime_catalog::codex_version())
        .join(codex_runtime_key()?)
        .join("bin")
        .join(codex_exe_name());
    path.is_file().then_some(path)
}

fn bundled_codex_candidate(base: &Path) -> Option<PathBuf> {
    let triple = codex_target_triple()?;
    let platform_pkg = codex_platform_package()?;
    let exe = codex_exe_name();
    // The @openai/codex native package lays the binary out under
    // vendor/<triple>/bin/<exe>; older layouts used vendor/<triple>/codex/<exe>.
    // Probe both for every node_modules location.
    let vendor_roots = [
        base.join("node-sidecar")
            .join("node_modules")
            .join("@openai")
            .join(platform_pkg)
            .join("vendor")
            .join(triple),
        base.join("node-sidecar")
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("vendor")
            .join(triple),
        base.join("node_modules")
            .join("@openai")
            .join(platform_pkg)
            .join("vendor")
            .join(triple),
        base.join("node_modules")
            .join("@openai")
            .join("codex")
            .join("vendor")
            .join(triple),
    ];
    // codex-runtime/bin/<exe> is the package layout current bundles ship;
    // codex-runtime/<exe> is the legacy flat layout of older bundles (kept so
    // an already-deployed bat-server bundle keeps resolving after an update).
    [
        base.join("codex-runtime").join("bin").join(exe),
        base.join("codex-runtime").join(exe),
    ]
    .into_iter()
    .chain(
        vendor_roots
            .iter()
            .flat_map(|root| [root.join("bin").join(exe), root.join("codex").join(exe)]),
    )
    .find(|path| path.is_file())
}

fn find_codex_on_path() -> Option<PathBuf> {
    let mut dirs = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]);
    } else if cfg!(target_os = "linux") {
        dirs.extend([
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
    }
    for dir in dirs {
        let candidate = dir.join(codex_exe_name());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_codex_binary(app: &HostContext) -> CodexBinary {
    if let Ok(override_path) = std::env::var("BAT_CODEX_BIN") {
        let path = PathBuf::from(&override_path);
        if path.is_file() {
            let ext = path
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext != "cmd" && ext != "bat" {
                return CodexBinary::Native(path);
            }
            return CodexBinary::Wrapper(override_path);
        }
    }

    if let Some(path) = managed_codex_candidate(app) {
        return CodexBinary::Native(path);
    }

    if let Some(path) = find_codex_on_path() {
        return CodexBinary::Native(path);
    }

    // Bundled-resource lookup is a desktop packaging concept; the headless
    // server resolves codex from PATH / cwd only.
    #[cfg(feature = "desktop")]
    if let Ok(resource_dir) = app.app().path().resource_dir() {
        if let Some(path) = bundled_codex_candidate(&resource_dir) {
            return CodexBinary::Native(path);
        }
    }

    if let Ok(mut cwd) = std::env::current_dir() {
        loop {
            if let Some(path) = bundled_codex_candidate(&cwd) {
                return CodexBinary::Native(path);
            }
            if !cwd.pop() {
                break;
            }
        }
    }

    CodexBinary::Wrapper("codex".to_string())
}

fn home_dir(app: &HostContext) -> Option<PathBuf> {
    app.home_dir()
}

fn default_codex_home(app: &HostContext) -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir(app).map(|home| home.join(".codex")))
}

fn codex_account_state_path(app: &HostContext) -> Option<PathBuf> {
    app.data_dir_opt()
        .map(|dir| dir.join(CODEX_ACCOUNT_STATE_FILE))
}

fn read_codex_account_state(app: &HostContext) -> CodexAccountState {
    let Some(path) = codex_account_state_path(app) else {
        return CodexAccountState::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<CodexAccountState>(&raw).ok())
        .unwrap_or_default()
}

fn write_codex_account_state(app: &HostContext, state: &CodexAccountState) -> Result<(), String> {
    let path = codex_account_state_path(app)
        .ok_or_else(|| "could not resolve app data dir for Codex account state".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("could not create Codex account state dir: {err}"))?;
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(state)
            .map_err(|err| format!("could not encode Codex account state: {err}"))?,
    )
    .map_err(|err| format!("could not write Codex account state: {err}"))
}

// --- Tier 2 unified-account gate ------------------------------------------
//
// The unified model is opt-in via settings.json. When OFF, every code path
// below falls through to the verbatim legacy (per-CODEX_HOME) behavior.

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnifiedSettingsProbe {
    // `None` (absent) means "use the default" — unified mode is ON by default;
    // it is only disabled when the user explicitly sets it to `false`.
    #[serde(default)]
    codex_unified_accounts: Option<bool>,
    #[serde(default)]
    codex_shared_home: Option<String>,
}

fn read_unified_settings(app: &HostContext) -> UnifiedSettingsProbe {
    let Some(dir) = app.data_dir_opt() else {
        return UnifiedSettingsProbe::default();
    };
    let Ok(raw) = fs::read_to_string(dir.join("settings.json")) else {
        return UnifiedSettingsProbe::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub(crate) fn codex_unified_enabled(app: &HostContext) -> bool {
    read_unified_settings(app)
        .codex_unified_accounts
        .unwrap_or(true)
}

/// The single runtime CODEX_HOME used in unified mode. Defaults to `~/.codex`
/// (mirrors Claude using the real `~/.claude`); overridable via `codexSharedHome`.
fn shared_home(app: &HostContext) -> Option<PathBuf> {
    let probe = read_unified_settings(app);
    if let Some(custom) = probe.codex_shared_home.filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(custom.trim());
        if path.is_absolute() {
            return Some(path);
        }
    }
    default_codex_home(app)
}

pub(crate) fn active_codex_home(app: &HostContext) -> Option<PathBuf> {
    if codex_unified_enabled(app) {
        return shared_home(app);
    }
    read_codex_account_state(app)
        .active_codex_home
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| default_codex_home(app))
}

/// Persist the live identity in the shared home back to the active account's
/// store on app exit (captures token refresh / new memory). No-op when the
/// unified model is OFF. Best-effort — never blocks shutdown.
pub fn snapshot_active_identity_on_exit(app: &HostContext) {
    if !codex_unified_enabled(app) {
        return;
    }
    let (Some(app_data), Some(shared)) = (app.data_dir_opt(), shared_home(app)) else {
        return;
    };
    app_cmd::log_tauri(
        app,
        &format!(
            "[codex-account] snapshot on exit before shared=[{}]",
            CodexAppServerState::auth_debug_summary(&shared)
        ),
    );
    codex_account_store::snapshot_active_for_exit(&app_data, &shared);
    app_cmd::log_tauri(
        app,
        &format!(
            "[codex-account] snapshot on exit after shared=[{}]",
            CodexAppServerState::auth_debug_summary(&shared)
        ),
    );
}

fn codex_home_label(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Codex")
        .to_string()
}

fn codex_auth_summary(codex_home: &Path) -> (Option<String>, Option<String>, bool) {
    // Authenticated = an auth.json exists/readable. Email/account_id parsing
    // (including the id_token JWT fallback) is shared with the account store.
    let authenticated = fs::read_to_string(codex_home.join("auth.json")).is_ok();
    let (account_id, email) = codex_account_store::read_auth_identity(codex_home);
    (email, account_id, authenticated)
}

/// True when an account JSON value carries a non-empty `email`. Used to drop
/// email-less Codex homes (e.g. a bare `~/.codex`) from the account lists.
fn value_has_email(value: &Value) -> bool {
    value
        .get("email")
        .and_then(|email| email.as_str())
        .map(|email| !email.trim().is_empty())
        .unwrap_or(false)
}

fn codex_account_info_value(app: &HostContext, codex_home: PathBuf, active: bool) -> Value {
    let (email, account_id, authenticated) = codex_auth_summary(&codex_home);
    let label = email
        .clone()
        .unwrap_or_else(|| codex_home_label(&codex_home));
    json!({
        "id": codex_home.to_string_lossy(),
        "label": label,
        "email": email,
        "accountId": account_id,
        "codexHome": codex_home.to_string_lossy(),
        "authenticated": authenticated,
        "active": active,
        "isDefault": default_codex_home(app).as_deref() == Some(codex_home.as_path()),
    })
}

fn unified_account_info_value(
    account: &codex_account_store::CodexUnifiedAccount,
    shared: &Path,
    active: bool,
) -> Value {
    json!({
        "id": account.id,
        "label": account.label,
        "email": account.email,
        "accountId": account.account_id,
        // All unified accounts share one runtime home; keep the key so the
        // renderer's existing `activeCodexHome` fallback still resolves.
        "codexHome": shared.to_string_lossy(),
        "authenticated": true,
        "active": active,
        "isDefault": false,
        "unified": true,
        "needsLogin": account.needs_login,
        "lastValidatedAt": account.last_validated_at,
        "lastInvalidatedAt": account.last_invalidated_at,
        "lastAuthError": account.last_auth_error,
    })
}

fn discover_codex_homes(app: &HostContext) -> Vec<PathBuf> {
    let mut homes = Vec::new();
    let mut push_home = |path: Option<PathBuf>| {
        if let Some(path) = path {
            if !homes.iter().any(|existing| existing == &path) {
                homes.push(path);
            }
        }
    };

    push_home(active_codex_home(app));
    push_home(default_codex_home(app));

    if let Some(home) = home_dir(app) {
        if let Ok(entries) = fs::read_dir(home) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if name == ".codex" || name.starts_with(".codex-") {
                    push_home(Some(path));
                }
            }
        }
    }

    homes
}

// Read the Sakana/Fugu API key for the codex app-server runtime: an explicit
// env var wins, otherwise parse SAKANA_API_KEY from the codex home's `.env`
// (where the Fugu installer writes it, dotenvy KEY=VALUE). Returns None when
// Fugu isn't configured, so the default codex path is unaffected.
fn sakana_api_key_for_runtime(app: &HostContext) -> Option<String> {
    if let Ok(key) = std::env::var("SAKANA_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key);
        }
    }
    let mut homes: Vec<PathBuf> = Vec::new();
    if let Some(h) = active_codex_home(app) {
        homes.push(h);
    }
    if let Some(h) = default_codex_home(app) {
        if !homes.contains(&h) {
            homes.push(h);
        }
    }
    homes
        .iter()
        .find_map(|home| read_env_file_key(&home.join(".env"), "SAKANA_API_KEY"))
}

fn read_env_file_key(path: &Path, key: &str) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(val) = rest.trim_start().strip_prefix('=') {
                let val = val.trim().trim_matches('"').trim_matches('\'');
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

fn build_codex_command(app: &HostContext) -> Command {
    build_codex_command_with_args(app, &["app-server"], true)
}

fn build_codex_command_with_args(
    app: &HostContext,
    subcommand: &[&str],
    with_api_key_env: bool,
) -> Command {
    let mut codex_path_dir: Option<PathBuf> = None;
    let mut command = match resolve_codex_binary(app) {
        CodexBinary::Native(path) => {
            codex_path_dir = codex_path_dir_for_binary(&path);
            let mut command = Command::new(path);
            command.args(subcommand);
            command
        }
        CodexBinary::Wrapper(command_name) => {
            #[cfg(windows)]
            {
                let mut command = Command::new("cmd");
                command.arg("/C").arg(command_name).args(subcommand);
                command
            }
            #[cfg(not(windows))]
            {
                let mut command = Command::new(command_name);
                command.args(subcommand);
                command
            }
        }
    };
    // The ChatGPT (browser) login flow must not see OPENAI_API_KEY, or codex
    // treats the account as API-key authenticated; only the app-server needs it.
    if with_api_key_env {
        if let Some(api_key) = codex_auth::configured_openai_key_for_runtime(app) {
            command.env("OPENAI_API_KEY", api_key);
        }
        // Additive: the Sakana/Fugu provider authenticates with SAKANA_API_KEY
        // (the Fugu installer stores it in $CODEX_HOME/.env). Setting it never
        // affects the default OpenAI codex path; fugu just won't auth if absent.
        if let Some(sakana_key) = sakana_api_key_for_runtime(app) {
            command.env("SAKANA_API_KEY", sakana_key);
        }
    }
    if let Some(codex_home) = active_codex_home(app) {
        command.env("CODEX_HOME", codex_home);
    }
    // The `codex` CLI is a Node script (`#!/usr/bin/env node`) and codex
    // itself shells out to `codex exec` subprocesses. When the .app is
    // launched from Finder/Spotlight, the inherited PATH does not include
    // common Node install locations like `/opt/homebrew/bin`, so `env` fails
    // with exit 127. Augment PATH with the resolved node directory plus
    // well-known fallbacks. Also prepend Codex's bundled `path/` directory so
    // descendant shell commands can find vendored tools such as `rg`.
    let extra_path_dirs = codex_path_dir.into_iter().collect::<Vec<_>>();
    if let Some(path) = augmented_path_with_runtime_dirs(&extra_path_dirs) {
        command.env("PATH", path);
    }
    // Avoid launching codex app-server with cwd `/` (the default when a macOS
    // .app is started from Finder). Per-turn requests still pass an explicit
    // cwd; this only guards against fallbacks that read the process cwd.
    if let Some(home) = app.home_dir() {
        if home.is_dir() {
            command.current_dir(home);
        }
    }
    hide_console_window(&mut command);
    command
}

const CODEX_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

// How long to wait for `codex login --device-auth` to print the sign-in URL +
// one-time code before giving up on the start RPC.
const DEVICE_PROMPT_TIMEOUT: Duration = Duration::from_secs(45);

/// Drain a child stdout/stderr pipe line-by-line into the shared capture so the
/// pipe never fills (codex keeps printing while it polls for approval), parsing
/// out the sign-in URL and one-time code as they appear.
fn spawn_device_drain<R: std::io::Read + Send + 'static>(
    reader: R,
    capture: Arc<Mutex<DeviceCapture>>,
) {
    std::thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines() {
            match line {
                Ok(line) => {
                    if let Ok(mut cap) = capture.lock() {
                        ingest_device_line(&mut cap, &line);
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// Parse one output line from `codex login --device-auth`. The CLI prints (with
/// ANSI colour) a numbered list whose URL line holds `https://auth.openai.com/
/// codex/device` and whose code line holds a bare one-time code like
/// `G0GT-244PL` right after an "Enter this one-time code" marker.
fn ingest_device_line(cap: &mut DeviceCapture, raw: &str) {
    let line = strip_ansi(raw);
    let trimmed = line.trim();
    cap.text.push_str(trimmed);
    cap.text.push('\n');

    if cap.url.is_none() {
        if let Some(idx) = trimmed.find("https://") {
            let url: String = trimmed[idx..]
                .chars()
                .take_while(|c| !c.is_whitespace())
                .collect();
            if url.len() > "https://".len() {
                cap.url = Some(url);
            }
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("one-time code") {
        cap.saw_code_marker = true;
        return;
    }
    if cap.code.is_none() && cap.saw_code_marker && is_device_code(trimmed) {
        cap.code = Some(trimmed.to_string());
    }
}

/// Recognise a codex device code: two alphanumeric segments joined by a single
/// dash, e.g. `G0GT-244PL`. Deliberately strict so prose lines never match.
fn is_device_code(token: &str) -> bool {
    let mut parts = token.split('-');
    let (Some(first), Some(second), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let ok = |segment: &str| {
        segment.len() >= 3
            && segment.len() <= 8
            && segment.chars().all(|c| c.is_ascii_alphanumeric())
    };
    ok(first) && ok(second)
}

/// Strip ANSI/VT escape sequences (`\x1b[...m` and friends) from a line.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // Skip a CSI sequence: ESC [ ... <final byte 0x40..=0x7e>.
            if chars.next() == Some('[') {
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Last few non-empty lines of captured output, for surfacing in error text.
fn device_tail(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ")
}

/// Run `codex login` (ChatGPT browser OAuth by default; `--api-key <key>` when
/// provided). codex opens the browser itself and writes auth.json on success.
fn run_codex_login(
    app: &HostContext,
    api_key: Option<&str>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["login"];
    if let Some(key) = api_key {
        args.push("--api-key");
        args.push(key);
    }
    let mut child = build_codex_command_with_args(app, &args, false)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("failed to start codex login: {err}"))?;
    let started = Instant::now();
    loop {
        // User-requested cancel (e.g. closed the browser tab) — kill the pending
        // OAuth child so no auth.json is written and the UI can reset.
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("codex login cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                return Err(format!("codex login exited with {status}"));
            }
            Ok(None) if started.elapsed() >= CODEX_LOGIN_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("codex login timed out".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(err) => return Err(err.to_string()),
        }
    }
}

fn codex_path_dir_for_binary(binary: &Path) -> Option<PathBuf> {
    // Package layout keeps the exe in bin/ with codex-path/ as a sibling of
    // bin/ (i.e. under the grandparent). "path" is the legacy flat-layout
    // name; npm vendor trees also use codex-path/ next to the exe dir.
    let parent = binary.parent()?;
    let mut candidates = vec![parent.join("codex-path"), parent.join("path")];
    if let Some(grandparent) = parent.parent() {
        candidates.push(grandparent.join("codex-path"));
        candidates.push(grandparent.join("path"));
    }
    for candidate in candidates {
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn augmented_path_with_runtime_dirs(extra_dirs: &[PathBuf]) -> Option<std::ffi::OsString> {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = Vec::new();

    for dir in extra_dirs {
        if dir.is_dir() && !dirs.iter().any(|d| d == dir) {
            dirs.push(dir.clone());
        }
    }

    if let Some(node) = find_node_on_path(&existing) {
        if let Some(parent) = node.parent() {
            let dir = parent.to_path_buf();
            if !dirs.iter().any(|d| d == &dir) {
                dirs.push(dir);
            }
        }
    }

    #[cfg(target_os = "macos")]
    let fallbacks: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
    #[cfg(target_os = "linux")]
    let fallbacks: &[&str] = &["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
    #[cfg(windows)]
    let fallbacks: &[&str] = &[];

    for f in fallbacks {
        let p = PathBuf::from(f);
        if p.is_dir() && !dirs.iter().any(|d| d == &p) {
            dirs.push(p);
        }
    }

    if dirs.is_empty() {
        return None;
    }

    let mut combined: Vec<PathBuf> = dirs;
    for entry in std::env::split_paths(&existing) {
        if !combined.iter().any(|d| d == &entry) {
            combined.push(entry);
        }
    }
    std::env::join_paths(combined).ok()
}

fn find_node_on_path(path_env: &std::ffi::OsStr) -> Option<PathBuf> {
    let exe_names: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd", "node"]
    } else {
        &["node"]
    };
    for dir in std::env::split_paths(path_env) {
        for name in exe_names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    #[cfg(not(windows))]
    {
        for fallback in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            let p = PathBuf::from(fallback);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn text_from_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(text_from_value)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        Value::Object(map) => {
            for key in ["text", "message", "delta", "content", "summary"] {
                if let Some(v) = map.get(key) {
                    let text = text_from_value(v);
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn sanitize_terminal_output(value: &str) -> String {
    let mut stripped = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    let _ = chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    let _ = chars.next();
                    let mut saw_esc = false;
                    for c in chars.by_ref() {
                        if c == '\u{7}' {
                            break;
                        }
                        if saw_esc && c == '\\' {
                            break;
                        }
                        saw_esc = c == '\u{1b}';
                    }
                }
                Some(_) => {
                    let _ = chars.next();
                }
                None => {}
            }
            continue;
        }
        if ch == '\u{8}' {
            let _ = stripped.pop();
            continue;
        }
        stripped.push(ch);
    }
    stripped.replace("\r\n", "\n").replace('\r', "\n")
}

fn event_payload(session_id: &str, key: &str, value: Value) -> Value {
    json!({ "sessionId": session_id, key: value })
}

fn emit(app: &HostContext, name: &str, session_id: &str, key: &str, value: Value) {
    publish_runtime_event(
        app,
        name,
        event_payload(session_id, key, value),
        "codex-app-server",
    );
}

fn short_session_id(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

fn codex_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn log_codex_global(app: &HostContext, message: impl AsRef<str>) {
    if !codex_debug_enabled() {
        return;
    }
    app_cmd::log_tauri(app, &format!("[codex-app-server] {}", message.as_ref()));
}

fn log_codex(app: &HostContext, session_id: &str, message: impl AsRef<str>) {
    if !codex_debug_enabled() {
        return;
    }
    app_cmd::log_tauri(
        app,
        &format!(
            "[codex-app-server:{}] {}",
            short_session_id(session_id),
            message.as_ref()
        ),
    );
}

fn is_high_frequency_delta_notification(method: &str) -> bool {
    method.contains("Delta") || method.contains("delta")
}

fn make_user_message(session_id: &str, prompt: &str, image_count: usize) -> Value {
    let suffix = if image_count > 0 {
        format!(
            "\n[{image_count} image{} attached]",
            if image_count > 1 { "s" } else { "" }
        )
    } else {
        String::new()
    };
    json!({
        "id": format!("user-{}", now_millis()),
        "sessionId": session_id,
        "role": "user",
        "content": format!("{prompt}{suffix}"),
        "timestamp": now_millis(),
    })
}

fn make_system_message(session_id: &str, content: String) -> Value {
    json!({
        "id": format!("sys-{}", now_millis()),
        "sessionId": session_id,
        "role": "system",
        "content": content,
        "timestamp": now_millis(),
    })
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) as i64
}

fn parse_fixed_digits(text: &str, start: usize, len: usize) -> Option<u32> {
    text.get(start..start + len)?.parse::<u32>().ok()
}

fn parse_rfc3339_timestamp_millis(text: &str) -> Option<u128> {
    if text.len() < 20 {
        return None;
    }
    if text.get(4..5) != Some("-")
        || text.get(7..8) != Some("-")
        || !matches!(text.get(10..11), Some("T" | "t" | " "))
        || text.get(13..14) != Some(":")
        || text.get(16..17) != Some(":")
    {
        return None;
    }
    let year = parse_fixed_digits(text, 0, 4)? as i32;
    let month = parse_fixed_digits(text, 5, 2)?;
    let day = parse_fixed_digits(text, 8, 2)?;
    let hour = parse_fixed_digits(text, 11, 2)?;
    let minute = parse_fixed_digits(text, 14, 2)?;
    let second = parse_fixed_digits(text, 17, 2)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    let mut idx = 19;
    let bytes = text.as_bytes();
    let mut millis = 0u32;
    if bytes.get(idx) == Some(&b'.') {
        idx += 1;
        let start = idx;
        while let Some(byte) = bytes.get(idx) {
            if !byte.is_ascii_digit() {
                break;
            }
            idx += 1;
        }
        if idx == start {
            return None;
        }
        let fraction = &text[start..idx];
        let ms_digits = format!("{:0<3}", &fraction[..fraction.len().min(3)]);
        millis = ms_digits.parse::<u32>().ok()?;
    }

    let offset_seconds = match bytes.get(idx).copied() {
        Some(b'Z' | b'z') => {
            if idx + 1 != text.len() {
                return None;
            }
            0i64
        }
        Some(sign @ (b'+' | b'-')) => {
            if text.len() != idx + 6 || text.get(idx + 3..idx + 4) != Some(":") {
                return None;
            }
            let offset_hour = parse_fixed_digits(text, idx + 1, 2)?;
            let offset_minute = parse_fixed_digits(text, idx + 4, 2)?;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let seconds = (offset_hour as i64) * 3600 + (offset_minute as i64) * 60;
            if sign == b'+' {
                seconds
            } else {
                -seconds
            }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let local_seconds =
        days * 86_400 + (hour as i64) * 3600 + (minute as i64) * 60 + (second as i64);
    let utc_seconds = local_seconds - offset_seconds;
    if utc_seconds < 0 {
        return None;
    }
    Some((utc_seconds as u128) * 1000 + millis as u128)
}

fn image_extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn data_url_to_temp_image(data_url: &str) -> Result<PathBuf, String> {
    let Some(rest) = data_url.strip_prefix("data:") else {
        return Err("invalid image data URL".to_string());
    };
    let Some((metadata, payload)) = rest.split_once(',') else {
        return Err("invalid image data URL".to_string());
    };
    let mut metadata_parts = metadata.split(';');
    let mime = metadata_parts.next().unwrap_or("");
    let is_base64 = metadata_parts.any(|part| part.eq_ignore_ascii_case("base64"));
    if !is_base64 {
        return Err("image data URL must be base64 encoded".to_string());
    }
    let ext = image_extension_for_mime(mime)
        .ok_or_else(|| format!("unsupported image MIME type: {mime}"))?;
    let cleaned_payload: String = payload
        .chars()
        .filter(|ch| *ch != '\r' && *ch != '\n')
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned_payload.as_bytes())
        .map_err(|err| format!("invalid image data URL: {err}"))?;
    let dir = std::env::temp_dir().join("bat-codex-images");
    fs::create_dir_all(&dir).map_err(|err| format!("create temp image dir failed: {err}"))?;
    let n = CODEX_TEMP_IMAGE_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let path = dir.join(format!(
        "img-{}-{}-{n}.{ext}",
        std::process::id(),
        now_millis()
    ));
    fs::write(&path, bytes).map_err(|err| format!("write temp image failed: {err}"))?;
    Ok(path)
}

fn is_absolute_local_path(value: &str) -> bool {
    Path::new(value).is_absolute()
        || value.starts_with("\\\\")
        || value.as_bytes().get(1).is_some_and(|b| *b == b':')
}

fn codex_image_input_item(
    image: &str,
    temp_image_paths: &mut Vec<PathBuf>,
) -> Result<Value, String> {
    let trimmed = image.trim();
    if trimmed.is_empty() {
        return Err("empty image attachment".to_string());
    }
    if trimmed.starts_with("data:") {
        let path = data_url_to_temp_image(trimmed)?;
        let item = json!({ "type": "localImage", "path": path.to_string_lossy().to_string() });
        temp_image_paths.push(path);
        return Ok(item);
    }
    if is_absolute_local_path(trimmed) {
        return Ok(json!({ "type": "localImage", "path": trimmed }));
    }
    Ok(json!({ "type": "image", "url": trimmed }))
}

fn cleanup_temp_images(paths: Vec<PathBuf>) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

fn cleanup_session_temp_images(session: &mut CodexSession) {
    cleanup_temp_images(std::mem::take(&mut session.temporary_image_paths));
}

fn build_turn_input(prompt: &str, images: Vec<String>) -> Result<(Value, Vec<PathBuf>), String> {
    let mut temp_image_paths = Vec::new();
    let mut items = Vec::with_capacity(images.len() + 1);
    for image in images {
        match codex_image_input_item(&image, &mut temp_image_paths) {
            Ok(item) => items.push(item),
            Err(err) => {
                cleanup_temp_images(temp_image_paths);
                return Err(err);
            }
        }
    }
    items.push(json!({ "type": "text", "text": prompt, "text_elements": [] }));
    Ok((Value::Array(items), temp_image_paths))
}

fn build_turn_start_params(
    thread_id: &str,
    input: Value,
    model: &str,
    effort: &str,
    approval_policy: &str,
    sandbox_mode: &str,
) -> Value {
    // approvalPolicy / sandboxPolicy are per-turn overrides ("for this turn
    // and subsequent turns"). Always sending the session's current values
    // makes mid-session dropdown changes take effect on the next turn even
    // when the running thread ignores a thread/resume reconfigure.
    json!({
        "threadId": thread_id,
        "input": input,
        "model": model,
        "effort": effort,
        "summary": DEFAULT_CODEX_REASONING_SUMMARY,
        "approvalPolicy": approval_policy,
        "sandboxPolicy": app_server_sandbox_policy(sandbox_mode),
    })
}

// turn/start takes a tagged SandboxPolicy object, unlike thread/start's
// plain SandboxMode string.
fn app_server_sandbox_policy(value: &str) -> Value {
    match value {
        "read-only" => json!({ "type": "readOnly" }),
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        _ => json!({ "type": "workspaceWrite" }),
    }
}

// Codex models served by a non-default provider (currently Sakana, for the
// experimental Fugu agent) must pass their provider per-thread. Returns None
// for the built-in OpenAI models so their thread params stay byte-identical —
// the codex path is unchanged unless one of these specific models is selected.
fn provider_for_model(model: &str) -> Option<&'static str> {
    match model {
        "fugu" | "fugu-ultra" => Some("sakana"),
        _ => None,
    }
}

fn build_thread_start_params(
    model: &str,
    cwd: &str,
    approval_policy: &str,
    sandbox_mode: &str,
) -> Value {
    let mut params = json!({
        "model": model,
        "cwd": cwd,
        "approvalPolicy": approval_policy,
        "sandbox": app_server_sandbox(sandbox_mode),
        "serviceName": "better_agent_terminal",
    });
    if let Some(provider) = provider_for_model(model) {
        params["modelProvider"] = Value::String(provider.to_string());
    }
    params
}

fn build_thread_resume_params(
    thread_id: &str,
    model: &str,
    cwd: &str,
    approval_policy: &str,
    sandbox_mode: &str,
) -> Value {
    let mut params = json!({
        "threadId": thread_id,
        "model": model,
        "cwd": cwd,
        "approvalPolicy": approval_policy,
        "sandbox": app_server_sandbox(sandbox_mode),
        "serviceName": "better_agent_terminal",
    });
    if let Some(provider) = provider_for_model(model) {
        params["modelProvider"] = Value::String(provider.to_string());
    }
    params
}

fn is_thread_not_found_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("thread not found") || (lower.contains("thread") && lower.contains("not found"))
}

fn found_active_turn_from_interrupt_error(message: &str) -> Option<String> {
    let found = message.split(" but found ").nth(1)?.trim();
    let turn_id = found
        .split(|ch: char| ch.is_whitespace() || ch == ',' || ch == ';')
        .next()
        .unwrap_or_default()
        .trim();
    if turn_id.is_empty() || turn_id.eq_ignore_ascii_case("none") {
        None
    } else {
        Some(turn_id.to_string())
    }
}

fn is_no_active_turn_interrupt_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("no active turn to interrupt")
        || normalized.contains("expected active turn id") && normalized.contains("found none")
}

fn reasoning_text_from_item(item: &Value) -> String {
    if item_type(item) != Some("reasoning") {
        return String::new();
    }
    let summary = item.get("summary").map(text_from_value).unwrap_or_default();
    if !summary.trim().is_empty() {
        return summary;
    }
    item.get("content").map(text_from_value).unwrap_or_default()
}

fn completed_reasoning_message(
    session_id: &str,
    streaming_thinking: &mut String,
    item: &Value,
) -> Option<Value> {
    let streamed = std::mem::take(streaming_thinking);
    let completed = reasoning_text_from_item(item);
    let thinking = if completed.trim().is_empty() {
        streamed
    } else {
        completed
    };
    if thinking.trim().is_empty() {
        return None;
    }

    let id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("reasoning-{}", now_millis()));
    Some(json!({
        "id": id,
        "sessionId": session_id,
        "role": "assistant",
        "content": "",
        "thinking": thinking,
        "timestamp": now_millis(),
    }))
}

fn turn_error_message_from_value(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("additionalDetails")
                .and_then(Value::as_str)
                .filter(|message| !message.trim().is_empty())
                .map(str::to_string)
        })
}

fn codex_sessions_root(app: &HostContext) -> Option<PathBuf> {
    active_codex_home(app).map(|home| home.join("sessions"))
}

fn read_session_meta_id(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = entry
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| *value == "session_meta")
            .and_then(|_| entry.get("payload"))
            .and_then(|payload| payload.get("id"))
            .and_then(Value::as_str);
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            return Some(id.to_string());
        }
    }
    None
}

fn find_codex_session_log(root: &Path, thread_id: &str) -> Option<PathBuf> {
    let mut path_match = None;
    find_codex_session_log_exact(root, thread_id, &mut path_match).or(path_match)
}

fn find_codex_session_log_exact(
    root: &Path,
    thread_id: &str,
    path_match: &mut Option<PathBuf>,
) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_codex_session_log_exact(&path, thread_id, path_match) {
                return Some(found);
            }
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let meta_id = read_session_meta_id(&path);
        if meta_id.as_deref() == Some(thread_id) {
            return Some(path);
        }
        let path_text = path.to_string_lossy();
        if meta_id.is_none() && path_text.contains(thread_id) && path_match.is_none() {
            *path_match = Some(path);
        }
    }
    None
}

fn timestamp_or_now(value: Option<&Value>) -> u128 {
    if let Some(value) = value {
        if let Some(ms) = value.as_u64() {
            return ms as u128;
        }
        if let Some(text) = value.as_str().and_then(parse_rfc3339_timestamp_millis) {
            return text;
        }
    }
    now_millis()
}

fn codex_history_items_from_content(session_id: &str, content: &str) -> Vec<Value> {
    let mut items = Vec::new();
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(payload) = entry.get("payload") else {
            continue;
        };
        let timestamp = timestamp_or_now(entry.get("timestamp"));

        match entry.get("type").and_then(Value::as_str) {
            Some("event_msg") => match payload.get("type").and_then(Value::as_str) {
                Some("user_message") => {
                    if let Some(message) = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .filter(|message| !message.trim().is_empty())
                    {
                        items.push(json!({
                            "id": format!("hist-user-{}", items.len()),
                            "sessionId": session_id,
                            "role": "user",
                            "content": message,
                            "timestamp": timestamp,
                        }));
                    }
                }
                Some("agent_message") => {
                    if let Some(message) = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .filter(|message| !message.trim().is_empty())
                    {
                        items.push(json!({
                            "id": format!("hist-assistant-{}", items.len()),
                            "sessionId": session_id,
                            "role": "assistant",
                            "content": message,
                            "timestamp": timestamp,
                        }));
                    }
                }
                Some("exec_command_end") => {
                    let call_id = payload
                        .get("call_id")
                        .and_then(Value::as_str)
                        .unwrap_or("hist-exec");
                    let command = history_command_from_event(payload);
                    upsert_history_tool_call(
                        &mut items,
                        json!({
                            "id": call_id,
                            "sessionId": session_id,
                            "toolName": "Bash",
                            "input": { "command": command },
                            "status": history_status_from_event(payload),
                            "result": history_event_result(payload),
                            "timestamp": timestamp,
                        }),
                    );
                }
                Some("patch_apply_end") => {
                    let call_id = payload
                        .get("call_id")
                        .and_then(Value::as_str)
                        .unwrap_or("hist-patch");
                    let input =
                        history_tool_input_for_call(&items, call_id).unwrap_or_else(|| json!({}));
                    upsert_history_tool_call(
                        &mut items,
                        json!({
                            "id": call_id,
                            "sessionId": session_id,
                            "toolName": "apply_patch",
                            "input": input,
                            "status": history_status_from_event(payload),
                            "result": history_event_result(payload),
                            "timestamp": timestamp,
                        }),
                    );
                }
                Some("web_search_end") => {
                    let call_id = payload
                        .get("call_id")
                        .and_then(Value::as_str)
                        .unwrap_or("hist-web-search");
                    let input = web_search_input(payload);
                    upsert_history_tool_call(
                        &mut items,
                        json!({
                            "id": call_id,
                            "sessionId": session_id,
                            "toolName": "WebSearch",
                            "input": input,
                            "status": "completed",
                            "result": history_event_result(payload),
                            "timestamp": timestamp,
                        }),
                    );
                }
                _ => {}
            },
            Some("response_item") => match payload.get("type").and_then(Value::as_str) {
                Some("reasoning") => {
                    let thinking = reasoning_text_from_item(payload);
                    if !thinking.trim().is_empty() {
                        let id = payload
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("hist-reasoning-{}", items.len()));
                        items.push(json!({
                            "id": id,
                            "sessionId": session_id,
                            "role": "assistant",
                            "content": "",
                            "thinking": thinking,
                            "timestamp": timestamp,
                        }));
                    }
                }
                Some("function_call" | "custom_tool_call") => {
                    if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                        let name = payload
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Tool");
                        upsert_history_tool_call(
                            &mut items,
                            json!({
                                "id": call_id,
                                "sessionId": session_id,
                                "toolName": history_tool_name(name),
                                "input": history_tool_input(name, payload),
                                "status": "running",
                                "timestamp": timestamp,
                            }),
                        );
                    }
                }
                Some("function_call_output" | "custom_tool_call_output") => {
                    if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                        update_history_tool_call(
                            &mut items,
                            call_id,
                            json!({
                                "status": "completed",
                                "result": text_from_value(payload.get("output").unwrap_or(&Value::Null)),
                            }),
                        );
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    items
}

fn upsert_history_tool_call(items: &mut Vec<Value>, tool_call: Value) {
    let Some(tool_id) = tool_call.get("id").and_then(Value::as_str) else {
        items.push(tool_call);
        return;
    };
    if let Some(existing) = items
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(tool_id))
    {
        *existing = tool_call;
    } else {
        items.push(tool_call);
    }
}

fn update_history_tool_call(items: &mut Vec<Value>, tool_id: &str, updates: Value) {
    if let Some(existing) = items
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(tool_id))
    {
        if let (Some(existing_object), Some(update_object)) =
            (existing.as_object_mut(), updates.as_object())
        {
            for (key, value) in update_object {
                existing_object.insert(key.clone(), value.clone());
            }
        }
    } else {
        let mut tool_call = json!({
            "id": tool_id,
            "toolName": "Tool",
            "input": {},
            "status": "completed",
        });
        if let (Some(existing_object), Some(update_object)) =
            (tool_call.as_object_mut(), updates.as_object())
        {
            for (key, value) in update_object {
                existing_object.insert(key.clone(), value.clone());
            }
        }
        items.push(tool_call);
    }
}

fn history_tool_name(name: &str) -> String {
    match name {
        "exec_command" => "Bash".to_string(),
        "web_search" | "web_search_call" => "WebSearch".to_string(),
        other => other.to_string(),
    }
}

fn history_parse_arguments(payload: &Value) -> Value {
    if let Some(value) = payload.get("arguments").or_else(|| payload.get("input")) {
        if let Some(text) = value.as_str() {
            serde_json::from_str(text).unwrap_or_else(|_| json!({ "input": text }))
        } else {
            value.clone()
        }
    } else {
        json!({})
    }
}

fn history_tool_input(name: &str, payload: &Value) -> Value {
    let args = history_parse_arguments(payload);
    if name == "exec_command" {
        return json!({
            "command": args
                .get("cmd")
                .or_else(|| args.get("command"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            "cwd": args.get("workdir").or_else(|| args.get("cwd")).cloned(),
        });
    }
    args
}

fn history_tool_input_for_call(items: &[Value], call_id: &str) -> Option<Value> {
    items
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(call_id))
        .and_then(|item| item.get("input").cloned())
}

fn history_command_from_event(payload: &Value) -> String {
    payload
        .get("command")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .get(2)
                .or_else(|| items.last())
                .and_then(Value::as_str)
        })
        .or_else(|| payload.get("cmd").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

fn history_status_from_event(payload: &Value) -> &'static str {
    if payload.get("success").and_then(Value::as_bool) == Some(false) {
        return "error";
    }
    if payload
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "failed")
    {
        return "error";
    }
    if payload
        .get("exit_code")
        .and_then(Value::as_i64)
        .is_some_and(|code| code != 0)
    {
        return "error";
    }
    "completed"
}

fn history_event_result(payload: &Value) -> Value {
    payload
        .get("aggregated_output")
        .or_else(|| payload.get("stdout"))
        .or_else(|| payload.get("stderr"))
        .or_else(|| payload.get("output"))
        .or_else(|| payload.get("formatted_output"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn load_codex_history_items(app: &HostContext, session_id: &str, thread_id: &str) -> Vec<Value> {
    let Some(root) = codex_sessions_root(app) else {
        return Vec::new();
    };
    let Some(path) = find_codex_session_log(&root, thread_id) else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .map(|content| codex_history_items_from_content(session_id, &content))
        .unwrap_or_default()
}

fn item_type(item: &Value) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

fn item_id(item: &Value) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .or_else(|| item.get("call_id").and_then(Value::as_str))
        .unwrap_or("codex-item")
        .to_string()
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_array)
        .and_then(|items| items.iter().find_map(|item| non_empty_string(Some(item))))
}

fn web_search_input(item: &Value) -> Value {
    let action = item.get("action");
    if let Some(query) = non_empty_string(item.get("query"))
        .or_else(|| action.and_then(|value| non_empty_string(value.get("query"))))
        .or_else(|| first_non_empty_string(item.get("queries")))
        .or_else(|| action.and_then(|value| first_non_empty_string(value.get("queries"))))
    {
        return json!({ "query": query });
    }
    if let Some(url) = non_empty_string(item.get("url"))
        .or_else(|| action.and_then(|value| non_empty_string(value.get("url"))))
    {
        return json!({ "url": url });
    }
    json!({})
}

fn tool_status(item: &Value) -> &'static str {
    match item.get("status").and_then(Value::as_str) {
        Some("failed" | "declined") => "error",
        Some("completed") => "completed",
        _ => "running",
    }
}

fn completed_tool_status(item: &Value) -> &'static str {
    match item.get("status").and_then(Value::as_str) {
        Some("failed" | "declined") => "error",
        Some("running") if item_type(item) != Some("webSearch") => "running",
        _ => "completed",
    }
}

fn tool_result_value(item: &Value) -> Option<Value> {
    item.get("aggregatedOutput")
        .or_else(|| item.get("result"))
        .or_else(|| item.get("error"))
        .cloned()
}

fn completed_tool_result(item: &Value) -> Value {
    let mut tool_result = json!({
        "id": item_id(item),
        "status": completed_tool_status(item),
        "result": tool_result_value(item),
    });

    if item_type(item) == Some("webSearch") {
        let input = web_search_input(item);
        if input.as_object().is_some_and(|obj| !obj.is_empty()) {
            tool_result["input"] = input;
        }
    }

    tool_result
}

fn push_session_item(session: &mut CodexSession, item: Value) {
    session.messages.push(item);
    if session.messages.len() > MSG_BUFFER_CAP {
        let excess = session.messages.len() - MSG_BUFFER_CAP;
        session.messages.drain(0..excess);
    }
}

fn upsert_session_tool_call(session: &mut CodexSession, tool_call: Value) {
    let Some(tool_id) = tool_call.get("id").and_then(Value::as_str) else {
        push_session_item(session, tool_call);
        return;
    };
    if let Some(existing) = session
        .messages
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(tool_id))
    {
        *existing = tool_call;
    } else {
        push_session_item(session, tool_call);
    }
}

fn update_session_tool_call(session: &mut CodexSession, tool_id: &str, updates: Value) {
    let Some(update_object) = updates.as_object() else {
        return;
    };
    let Some(existing) = session
        .messages
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(tool_id))
    else {
        return;
    };
    let Some(existing_object) = existing.as_object_mut() else {
        return;
    };
    for (key, value) in update_object {
        existing_object.insert(key.clone(), value.clone());
    }
}

fn thread_id_from_params(params: &Value) -> Option<String> {
    params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| params.get("thread_id").and_then(Value::as_str))
        .or_else(|| {
            params
                .get("turn")
                .and_then(|v| v.get("threadId").or_else(|| v.get("thread_id")))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            params
                .get("item")
                .and_then(|v| v.get("threadId").or_else(|| v.get("thread_id")))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

fn turn_id_from_params(params: &Value) -> Option<String> {
    params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| params.get("turn_id").and_then(Value::as_str))
        .or_else(|| {
            params
                .get("turn")
                .and_then(|v| {
                    v.get("id")
                        .or_else(|| v.get("turnId"))
                        .or_else(|| v.get("turn_id"))
                })
                .and_then(Value::as_str)
        })
        .or_else(|| {
            params
                .get("item")
                .and_then(|v| v.get("turnId").or_else(|| v.get("turn_id")))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

impl CodexAppServerState {
    pub fn is_owned(&self, session_id: &str) -> bool {
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .contains_key(session_id)
    }

    pub fn supported_models(&self) -> Value {
        let mut models = vec![
            json!({ "value": "gpt-5.6-sol", "displayName": "GPT-5.6 Sol", "description": "Newest frontier - recommended (ChatGPT login)", "source": "builtin" }),
            json!({ "value": "gpt-5.5", "displayName": "GPT-5.5", "description": "Previous frontier GPT-5.5", "source": "builtin" }),
            json!({ "value": "gpt-5.4", "displayName": "GPT-5.4", "description": "Flagship GPT-5.4", "source": "builtin" }),
            json!({ "value": "gpt-5.4-mini", "displayName": "GPT-5.4 Mini", "description": "Fast GPT-5.4", "source": "builtin" }),
            json!({ "value": "gpt-5.3-codex", "displayName": "GPT-5.3 Codex", "description": "GPT-5.3 - codex variant", "source": "builtin" }),
            json!({ "value": "gpt-5.3-codex-spark", "displayName": "GPT-5.3 Codex Spark", "description": "GPT-5.3 - lightweight codex", "source": "builtin" }),
            json!({ "value": "codex-mini-latest", "displayName": "Codex Mini", "description": "codex-mini - optimized for code", "source": "builtin" }),
            json!({ "value": "o4-mini", "displayName": "o4-mini", "description": "OpenAI o4-mini - fast reasoning", "source": "builtin" }),
            json!({ "value": "o3", "displayName": "o3", "description": "OpenAI o3 - reasoning model", "source": "builtin" }),
            json!({ "value": "gpt-4.1", "displayName": "GPT-4.1", "description": "OpenAI GPT-4.1", "source": "builtin" }),
        ];
        // Sakana/Fugu provider models — experimental, only listed when BAT_DEBUG
        // is on. Selecting one routes thread/start through provider "sakana"
        // (requires the Fugu install + SAKANA_API_KEY). The list above is
        // unchanged for normal codex users.
        if codex_debug_enabled() {
            models.push(json!({ "value": "fugu", "displayName": "Fugu (Sakana)", "description": "Sakana Fugu - experimental, needs Fugu install", "source": "sakana" }));
            models.push(json!({ "value": "fugu-ultra", "displayName": "Fugu Ultra (Sakana)", "description": "Sakana Fugu Ultra - experimental", "source": "sakana" }));
        }
        Value::Array(models)
    }

    pub fn supported_efforts(&self) -> Value {
        // `max`/`ultra` require Codex CLI >= 0.143.0 (GPT-5.6 tier). Older
        // models ignore the higher tiers; the runtime enforces per-model support.
        json!(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    }

    pub fn supported_sandbox_modes(&self) -> Value {
        json!(["read-only", "workspace-write", "danger-full-access"])
    }

    pub fn supported_approval_policies(&self) -> Value {
        json!(["untrusted", "on-request", "never"])
    }

    pub fn account_info(&self, app: &HostContext) -> Value {
        if codex_unified_enabled(app) {
            return self.unified_account_info(app);
        }
        active_codex_home(app)
            .map(|home| codex_account_info_value(app, home, true))
            .unwrap_or_else(|| {
                json!({
                    "label": "Codex",
                    "authenticated": false,
                    "active": true,
                })
            })
    }

    pub fn account_list(&self, app: &HostContext) -> Value {
        if codex_unified_enabled(app) {
            return self.unified_account_list(app);
        }
        let active = active_codex_home(app);
        let accounts = discover_codex_homes(app)
            .into_iter()
            .map(|home| {
                let is_active = active.as_deref() == Some(home.as_path());
                codex_account_info_value(app, home, is_active)
            })
            // Only real, signed-in homes count: drop ones with no resolvable
            // email (e.g. a bare ~/.codex that would otherwise show as ".codex").
            .filter(value_has_email)
            .collect::<Vec<_>>();
        json!({
            "accounts": accounts,
            "activeCodexHome": active.map(|path| path.to_string_lossy().to_string()),
        })
    }

    // --- Tier 2 unified-account operations ---------------------------------

    fn shared_auth_account_id(shared: &Path) -> Option<String> {
        if shared.join("auth.json").exists() {
            Some(codex_account_store::derive_account_id(shared))
        } else {
            None
        }
    }

    fn auth_failure_message(message: &str) -> bool {
        let lower = message.to_ascii_lowercase();
        lower.contains("your session has ended")
            || lower.contains("please log in again")
            || lower.contains("token_invalidated")
            || lower.contains("app_session_terminated")
            || lower.contains("access token could not be refreshed")
            || lower.contains("failed to refresh token")
            || lower.contains("401 unauthorized")
    }

    fn mark_shared_auth_valid(&self, app: &HostContext, reason: &str) {
        if !codex_unified_enabled(app) {
            return;
        }
        let (Some(app_data), Some(shared)) = (app.data_dir_opt(), shared_home(app)) else {
            return;
        };
        match codex_account_store::mark_shared_auth_valid(&app_data, &shared) {
            Ok(Some(account)) => app_cmd::log_tauri(
                app,
                &format!(
                    "[codex-account] marked valid reason={reason} account={} email={} shared=[{}]",
                    account.id,
                    account.email.as_deref().unwrap_or("none"),
                    Self::auth_debug_summary(&shared)
                ),
            ),
            Ok(None) => {}
            Err(err) => app_cmd::log_tauri(
                app,
                &format!("[codex-account] mark valid failed reason={reason}: {err}"),
            ),
        }
    }

    fn mark_shared_auth_needs_login(&self, app: &HostContext, reason: &str) {
        if !codex_unified_enabled(app) {
            return;
        }
        let (Some(app_data), Some(shared)) = (app.data_dir_opt(), shared_home(app)) else {
            return;
        };
        match codex_account_store::mark_shared_auth_needs_login(&app_data, &shared, reason) {
            Ok(Some(account)) => app_cmd::log_tauri(
                app,
                &format!(
                    "[codex-account] marked needsLogin account={} email={} reason={} shared=[{}]",
                    account.id,
                    account.email.as_deref().unwrap_or("none"),
                    reason,
                    Self::auth_debug_summary(&shared)
                ),
            ),
            Ok(None) => {}
            Err(err) => app_cmd::log_tauri(
                app,
                &format!("[codex-account] mark needsLogin failed reason={reason}: {err}"),
            ),
        }
    }

    fn auth_debug_summary(home: &Path) -> String {
        let auth_path = home.join("auth.json");
        let (account_id, email) = codex_account_store::read_auth_identity(home);
        let metadata = fs::metadata(&auth_path).ok();
        let size = metadata.as_ref().map(|m| m.len());
        let modified_ms = metadata
            .and_then(|m| m.modified().ok())
            .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis());
        let fingerprint = fs::read(&auth_path).ok().map(|bytes| {
            let mut hasher = DefaultHasher::new();
            hasher.write(&bytes);
            format!("{:016x}", hasher.finish())
        });
        format!(
            "home={} exists={} accountId={} email={} size={} mtimeMs={} fp={}",
            home.to_string_lossy(),
            auth_path.exists(),
            account_id.as_deref().unwrap_or("none"),
            email.as_deref().unwrap_or("none"),
            size.map(|v| v.to_string())
                .unwrap_or_else(|| "none".to_string()),
            modified_ms
                .map(|v| v.to_string())
                .unwrap_or_else(|| "none".to_string()),
            fingerprint.as_deref().unwrap_or("none")
        )
    }

    fn sync_unified_active_from_shared(
        &self,
        app: &HostContext,
        reason: &str,
    ) -> Result<(bool, Option<String>), String> {
        if !codex_unified_enabled(app) {
            return Ok((false, None));
        }
        let _swap = self
            .inner
            .unified_swap_lock
            .lock()
            .map_err(|_| "codex swap lock poisoned".to_string())?;
        let app_data = app
            .data_dir_opt()
            .ok_or_else(|| "could not resolve app data dir".to_string())?;
        let shared =
            shared_home(app).ok_or_else(|| "could not resolve shared Codex home".to_string())?;
        let before = codex_account_store::read_index(&app_data).active_account_id;
        let shared_before = Self::auth_debug_summary(&shared);
        let account = codex_account_store::sync_active_from_shared_home(&app_data, &shared)
            .map_err(|err| err.to_string())?;
        let after = codex_account_store::read_index(&app_data).active_account_id;
        let changed = before != after;
        let shared_after = Self::auth_debug_summary(&shared);
        if changed {
            app_cmd::log_tauri(
                app,
                &format!(
                    "[codex-account] sync active from CODEX_HOME reason={reason} beforeActive={} afterActive={} sharedBefore=[{}] sharedAfter=[{}]",
                    before.as_deref().unwrap_or("none"),
                    after.as_deref().unwrap_or("none"),
                    shared_before,
                    shared_after
                ),
            );
        } else {
            log_codex_global(
                app,
                format!(
                    "account sync unchanged reason={reason} active={} shared=[{}]",
                    after.as_deref().unwrap_or("none"),
                    shared_after
                ),
            );
        }
        Ok((changed, account.map(|a| a.id).or(after)))
    }

    fn unified_account_info(&self, app: &HostContext) -> Value {
        let _ = self.sync_unified_active_from_shared(app, "account-info");
        let Some(app_data) = app.data_dir_opt() else {
            return json!({ "label": "Codex", "authenticated": false, "active": true, "unified": true });
        };
        let shared = shared_home(app).unwrap_or_else(|| app_data.clone());
        let index = codex_account_store::read_index(&app_data);
        let active = index
            .active_account_id
            .as_ref()
            .and_then(|id| index.accounts.iter().find(|a| &a.id == id));
        match active {
            Some(account) => unified_account_info_value(account, &shared, true),
            None => {
                json!({ "label": "Codex", "authenticated": false, "active": true, "unified": true })
            }
        }
    }

    fn unified_account_list(&self, app: &HostContext) -> Value {
        let _ = self.sync_unified_active_from_shared(app, "account-list");
        let Some(app_data) = app.data_dir_opt() else {
            return json!({ "accounts": [], "unified": true });
        };
        let shared = shared_home(app).unwrap_or_else(|| app_data.clone());
        let index = codex_account_store::read_index(&app_data);
        let accounts = index
            .accounts
            .iter()
            .map(|account| {
                let active = index.active_account_id.as_deref() == Some(account.id.as_str());
                unified_account_info_value(account, &shared, active)
            })
            // Only accounts with a resolvable email count; hide email-less
            // entries (e.g. an imported home labelled ".codex").
            .filter(value_has_email)
            .collect::<Vec<_>>();
        json!({
            "accounts": accounts,
            "activeCodexHome": shared.to_string_lossy(),
            "activeAccountId": index.active_account_id,
            "unified": true,
        })
    }

    fn any_session_running(&self) -> bool {
        self.inner
            .sessions
            .lock()
            .map(|sessions| sessions.values().any(|session| session.is_running))
            .unwrap_or(false)
    }

    fn drop_connection(&self, app: &HostContext, reason: &str) {
        let old = match self.inner.connection.lock() {
            Ok(mut guard) => guard.take(),
            Err(_) => return,
        };
        // Dropping a CodexConnection kills AND waits the child app-server, which
        // can block for up to ~1s. On account switch the identity files are
        // already swapped, so reap the old process off-thread; this keeps the
        // switch snappy and lets the new app-server spawn in parallel.
        if let Some(old) = old {
            let pid = old.pid;
            log_codex_global(
                app,
                format!("drop_connection reason={reason} pid={pid} action=kill-and-wait"),
            );
            std::thread::spawn(move || drop(old));
        } else {
            log_codex_global(app, format!("drop_connection reason={reason} pid=none"));
        }
    }

    fn switch_unified(&self, app: &HostContext, selector: String) -> Result<Value, String> {
        let _swap = self
            .inner
            .unified_swap_lock
            .lock()
            .map_err(|_| "codex swap lock poisoned".to_string())?;
        let app_data = app
            .data_dir_opt()
            .ok_or_else(|| "could not resolve app data dir".to_string())?;
        let shared =
            shared_home(app).ok_or_else(|| "could not resolve shared Codex home".to_string())?;
        let _ = codex_account_store::sync_active_from_shared_home(&app_data, &shared);
        let index = codex_account_store::read_index(&app_data);
        let id = codex_account_store::resolve_selector(&index, selector.trim())
            .ok_or_else(|| format!("unknown Codex account: {selector}"))?;
        let target_account = index
            .accounts
            .iter()
            .find(|account| account.id == id)
            .ok_or_else(|| format!("unknown Codex account: {selector}"))?;
        if target_account.needs_login {
            return Err(format!(
                "Codex account {} needs login before it can be used again.",
                target_account
                    .email
                    .as_deref()
                    .unwrap_or(target_account.label.as_str())
            ));
        }
        let target_store = codex_account_store::account_store_home(&app_data, &id);
        let target_auth = Self::auth_debug_summary(&target_store);
        let shared_before = Self::auth_debug_summary(&shared);
        app_cmd::log_tauri(
            app,
            &format!(
                "[codex-account] switch requested target={id} selector={} targetAuth=[{}] sharedBefore=[{}]",
                selector.trim(),
                target_auth,
                shared_before
            ),
        );

        let shared_id = Self::shared_auth_account_id(&shared);
        if index.active_account_id.as_deref() == Some(id.as_str())
            && shared_id.as_deref() == Some(id.as_str())
        {
            let account = index.accounts.iter().find(|a| a.id == id);
            app_cmd::log_tauri(
                app,
                &format!(
                    "[codex-account] switch no-op target={id} shared=[{}]",
                    Self::auth_debug_summary(&shared)
                ),
            );
            return Ok(json!({
                "success": true,
                "verified": true,
                "account": account.map(|a| unified_account_info_value(a, &shared, true)),
            }));
        }

        if self.any_session_running() {
            return Err(
                "Cannot switch Codex account while a turn is running. Stop or wait for the active turn first."
                    .to_string(),
            );
        }

        let account = codex_account_store::switch_unified_account(&app_data, &shared, &id)
            .map_err(|err| err.to_string())?;
        let shared_after_copy = Self::auth_debug_summary(&shared);
        let verified = Self::shared_auth_account_id(&shared).as_deref() == Some(id.as_str());
        app_cmd::log_tauri(
            app,
            &format!(
                "[codex-account] switch copied target={id} verified={verified} targetAuth=[{}] sharedAfter=[{}]",
                target_auth,
                shared_after_copy
            ),
        );
        if !verified {
            return Err(format!(
                "Codex account switch did not take effect; target={id} sharedAfter=[{}]",
                shared_after_copy
            ));
        }
        // Drop the connection so the next request lazily respawns the app-server
        // with the switched auth.
        self.drop_connection(app, "unified-switch");
        // Reset every session's thread state (mirrors the legacy switch path). A
        // codex thread/rollout is bound to the identity that created it, so the
        // newly selected account cannot resume the previous account's thread
        // ("thread not found / no rollout found"). Clearing the thread ids makes
        // the next message start a fresh thread for the new account instead of
        // trying to resume a stale one.
        self.inner
            .thread_to_session
            .lock()
            .map_err(|_| "codex thread map lock poisoned".to_string())?
            .clear();
        let mut updates = Vec::new();
        {
            let mut sessions = self
                .inner
                .sessions
                .lock()
                .map_err(|_| "codex sessions lock poisoned".to_string())?;
            for (session_id, session) in sessions.iter_mut() {
                session.thread_id = None;
                session.active_turn_id = None;
                session.active_turn_key = None;
                session.is_running = false;
                session.is_resting = false;
                session.abort_requested = false;
                set_runtime_status(
                    session,
                    "starting",
                    "Codex account switched. The next message will start a new Codex thread.",
                );
                updates.push((session_id.clone(), session.metadata()));
            }
        }
        for (session_id, meta) in updates {
            emit(app, "claude:status", &session_id, "meta", meta);
        }
        app_cmd::log_tauri(
            app,
            &format!(
                "[codex-account] unified auth switch -> {id} label={} verified=true shared=[{}]",
                account.label,
                Self::auth_debug_summary(&shared)
            ),
        );
        Ok(json!({
            "success": true,
            "verified": true,
            "account": unified_account_info_value(&account, &shared, true),
        }))
    }

    /// Startup hook: recover from an interrupted swap, then auto-migrate legacy
    /// multi-HOME Codex accounts into the unified model on first run (unified is
    /// the default). Copy-only and idempotent. Intended to run off the UI thread.
    pub fn init_unified_on_startup(&self, app: &HostContext) {
        if !codex_unified_enabled(app) {
            return;
        }
        let (Some(app_data), Some(shared)) = (app.data_dir_opt(), shared_home(app)) else {
            return;
        };
        codex_account_store::recover_shared_home(&app_data, &shared);
        if codex_account_store::read_index(&app_data).migrated {
            return;
        }
        if let Err(err) = self.unified_migrate(app) {
            app_cmd::log_tauri(
                app,
                &format!("[codex-account] startup auto-migrate failed: {err}"),
            );
        }
    }

    pub fn unified_status(&self, app: &HostContext) -> Value {
        let enabled = codex_unified_enabled(app);
        let index = app
            .data_dir_opt()
            .map(|dir| codex_account_store::read_index(&dir))
            .unwrap_or_default();
        json!({
            "enabled": enabled,
            "migrated": index.migrated,
            "activeAccountId": index.active_account_id,
            "accountCount": index.accounts.len(),
        })
    }

    pub fn unified_migrate(&self, app: &HostContext) -> Result<Value, String> {
        let _swap = self
            .inner
            .unified_swap_lock
            .lock()
            .map_err(|_| "codex swap lock poisoned".to_string())?;
        let app_data = app
            .data_dir_opt()
            .ok_or_else(|| "could not resolve app data dir".to_string())?;
        let shared =
            shared_home(app).ok_or_else(|| "could not resolve shared Codex home".to_string())?;
        let homes = discover_codex_homes(app);
        // Prefer the account the user was just on (legacy OFF-mode active home).
        let prefer = read_codex_account_state(app)
            .active_codex_home
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| default_codex_home(app));
        let report =
            codex_account_store::migrate_from_homes(&app_data, &shared, &homes, prefer.as_deref())
                .map_err(|err| err.to_string())?;
        self.drop_connection(app, "unified-migrate");
        serde_json::to_value(&report).map_err(|err| err.to_string())
    }

    /// Run an interactive `codex login` (ChatGPT browser OAuth, or API key) for
    /// the active Codex home (the shared `~/.codex` in unified mode). In unified
    /// mode the freshly-authenticated identity is registered as an account and
    /// made active. Blocking — call from `spawn_blocking`.
    pub fn account_login(
        &self,
        app: &HostContext,
        api_key: Option<String>,
    ) -> Result<Value, String> {
        let unified = codex_unified_enabled(app);
        // Snapshot the current active identity before login overwrites the home,
        // so the previously-active account keeps its latest tokens.
        if unified {
            if let (Some(app_data), Some(shared)) = (app.data_dir_opt(), shared_home(app)) {
                let _swap = self.inner.unified_swap_lock.lock();
                codex_account_store::snapshot_active_for_exit(&app_data, &shared);
            }
        }

        // Clear any stale cancel request, run the (blocking) login, then clear
        // again so a late cancel can't leak into the next attempt.
        self.inner.login_cancel.store(false, Ordering::SeqCst);
        let login_result = run_codex_login(app, api_key.as_deref(), &self.inner.login_cancel);
        self.inner.login_cancel.store(false, Ordering::SeqCst);
        login_result?;

        self.finalize_codex_login(app);
        Ok(json!({ "success": true, "account": self.account_info(app) }))
    }

    /// Post-login bookkeeping shared by the browser-OAuth (`account_login`) and
    /// device-code (`account_login_device_poll`) flows: in unified mode register
    /// the freshly-authenticated identity as the active account, then drop the
    /// app-server connection so the next request respawns it with the new auth.
    fn finalize_codex_login(&self, app: &HostContext) {
        if codex_unified_enabled(app) {
            if let (Some(app_data), Some(shared)) = (app.data_dir_opt(), shared_home(app)) {
                let _swap = self.inner.unified_swap_lock.lock();
                match codex_account_store::capture_current(&app_data, &shared, None) {
                    Ok(account) => {
                        // The shared home already holds this identity → just mark active.
                        let _ = codex_account_store::set_active(&app_data, &account.id);
                        let _ = codex_account_store::mark_account_valid(&app_data, &account.id);
                    }
                    Err(err) => app_cmd::log_tauri(
                        app,
                        &format!("[codex-account] capture after login failed: {err}"),
                    ),
                }
            }
        }
        self.drop_connection(app, "account-login");
    }

    /// Start a device-code login on the host: spawn `codex login --device-auth`,
    /// drain its output off-thread, and return the sign-in URL + one-time code
    /// once codex prints them. The child keeps running (polling for approval)
    /// and is reaped by `account_login_device_poll`. Used for remote hosts where
    /// the local browser flow can't run. Blocking — call from spawn_blocking.
    pub fn account_login_device_start(&self, app: &HostContext) -> Result<Value, String> {
        // Drop any prior in-flight device login before starting a new one.
        self.clear_device_login();
        self.inner.login_cancel.store(false, Ordering::SeqCst);

        let mut child = build_codex_command_with_args(app, &["login", "--device-auth"], false)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("failed to start codex device login: {err}"))?;

        let capture = Arc::new(Mutex::new(DeviceCapture::default()));
        if let Some(out) = child.stdout.take() {
            spawn_device_drain(out, capture.clone());
        }
        if let Some(err) = child.stderr.take() {
            spawn_device_drain(err, capture.clone());
        }

        // Wait for codex to print the sign-in URL + code (or exit early).
        let deadline = Instant::now() + DEVICE_PROMPT_TIMEOUT;
        loop {
            if self.inner.login_cancel.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("codex device login cancelled".to_string());
            }
            if let Ok(cap) = capture.lock() {
                if let (Some(url), Some(code)) = (cap.url.clone(), cap.code.clone()) {
                    drop(cap);
                    if let Ok(mut slot) = self.inner.device_login.lock() {
                        *slot = Some(DeviceLoginSession {
                            child,
                            capture: capture.clone(),
                            started: Instant::now(),
                        });
                    }
                    return Ok(json!({ "ok": true, "url": url, "code": code }));
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let tail = capture
                        .lock()
                        .map(|cap| device_tail(&cap.text))
                        .unwrap_or_default();
                    return Err(format!(
                        "codex device login exited before prompting ({status}){}",
                        if tail.is_empty() {
                            String::new()
                        } else {
                            format!(": {tail}")
                        }
                    ));
                }
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("codex device login: no sign-in code received".to_string());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(err) => return Err(err.to_string()),
            }
        }
    }

    /// Poll an in-flight device-code login. Returns `{status:"pending"}` while
    /// the user has not yet approved, `{status:"success", account}` once codex
    /// exits 0 (auth.json written), or `{status:"error", error}` on failure /
    /// timeout. Clears the session on a terminal result.
    pub fn account_login_device_poll(&self, app: &HostContext) -> Result<Value, String> {
        enum Outcome {
            Pending,
            Success,
            Error(String),
        }
        let outcome = {
            let mut slot = self
                .inner
                .device_login
                .lock()
                .map_err(|_| "codex device login lock poisoned".to_string())?;
            let Some(session) = slot.as_mut() else {
                return Ok(json!({ "status": "error", "error": "no codex login in progress" }));
            };
            match session.child.try_wait() {
                Ok(Some(status)) => {
                    let outcome = if status.success() {
                        Outcome::Success
                    } else {
                        let tail = session
                            .capture
                            .lock()
                            .map(|cap| device_tail(&cap.text))
                            .unwrap_or_default();
                        Outcome::Error(if tail.is_empty() {
                            format!("codex login failed ({status})")
                        } else {
                            format!("codex login failed: {tail}")
                        })
                    };
                    *slot = None;
                    outcome
                }
                Ok(None) if session.started.elapsed() >= CODEX_LOGIN_TIMEOUT => {
                    let _ = session.child.kill();
                    let _ = session.child.wait();
                    *slot = None;
                    Outcome::Error("codex login timed out".to_string())
                }
                Ok(None) => Outcome::Pending,
                Err(err) => {
                    *slot = None;
                    Outcome::Error(err.to_string())
                }
            }
        };
        match outcome {
            Outcome::Pending => Ok(json!({ "status": "pending" })),
            Outcome::Success => {
                self.finalize_codex_login(app);
                Ok(json!({ "status": "success", "account": self.account_info(app) }))
            }
            Outcome::Error(error) => Ok(json!({ "status": "error", "error": error })),
        }
    }

    /// Kill and clear any in-flight device-code login child. Best-effort.
    fn clear_device_login(&self) {
        if let Ok(mut slot) = self.inner.device_login.lock() {
            if let Some(mut session) = slot.take() {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
    }

    /// Request cancellation of an in-flight `codex login`. Best-effort: sets a
    /// flag the run_codex_login poll loop checks (within ~50ms) to kill the
    /// child, and kills any device-code login child. A no-op if none running.
    pub fn account_login_cancel(&self) -> Value {
        self.inner.login_cancel.store(true, Ordering::SeqCst);
        self.clear_device_login();
        json!({ "success": true })
    }

    pub fn account_capture_current(
        &self,
        app: &HostContext,
        label: Option<String>,
    ) -> Result<Value, String> {
        let _swap = self
            .inner
            .unified_swap_lock
            .lock()
            .map_err(|_| "codex swap lock poisoned".to_string())?;
        let app_data = app
            .data_dir_opt()
            .ok_or_else(|| "could not resolve app data dir".to_string())?;
        let shared =
            shared_home(app).ok_or_else(|| "could not resolve shared Codex home".to_string())?;
        let account = codex_account_store::capture_current(&app_data, &shared, label)
            .map_err(|err| err.to_string())?;
        Ok(json!({
            "success": true,
            "account": unified_account_info_value(&account, &shared, true),
        }))
    }

    pub fn account_remove_unified(
        &self,
        app: &HostContext,
        account_id: String,
    ) -> Result<Value, String> {
        let _swap = self
            .inner
            .unified_swap_lock
            .lock()
            .map_err(|_| "codex swap lock poisoned".to_string())?;
        let app_data = app
            .data_dir_opt()
            .ok_or_else(|| "could not resolve app data dir".to_string())?;
        let shared =
            shared_home(app).ok_or_else(|| "could not resolve shared Codex home".to_string())?;
        let removed = codex_account_store::remove_account(&app_data, &shared, account_id.trim())
            .map_err(|err| err.to_string())?;
        if removed {
            self.drop_connection(app, "account-remove");
        }
        Ok(json!({ "success": removed }))
    }

    pub fn switch_account(&self, app: &HostContext, codex_home: String) -> Result<Value, String> {
        if codex_unified_enabled(app) {
            return self.switch_unified(app, codex_home);
        }
        let trimmed = codex_home.trim();
        if trimmed.is_empty() {
            return Err("Codex home path is required".to_string());
        }
        let path = PathBuf::from(trimmed);
        if !path.is_absolute() {
            return Err("Codex home path must be absolute".to_string());
        }
        fs::create_dir_all(&path).map_err(|err| format!("could not create CODEX_HOME: {err}"))?;
        write_codex_account_state(
            app,
            &CodexAccountState {
                active_codex_home: Some(path.to_string_lossy().to_string()),
            },
        )?;

        self.drop_connection(app, "legacy-switch");
        self.inner
            .thread_to_session
            .lock()
            .map_err(|_| "codex thread map lock poisoned".to_string())?
            .clear();

        let mut updates = Vec::new();
        {
            let mut sessions = self
                .inner
                .sessions
                .lock()
                .map_err(|_| "codex sessions lock poisoned".to_string())?;
            for (session_id, session) in sessions.iter_mut() {
                session.thread_id = None;
                session.active_turn_id = None;
                session.active_turn_key = None;
                session.is_running = false;
                session.is_resting = false;
                session.abort_requested = false;
                set_runtime_status(
                    session,
                    "starting",
                    "Codex account switched. The next message will start a new Codex thread.",
                );
                updates.push((session_id.clone(), session.metadata()));
            }
        }
        for (session_id, meta) in updates {
            emit(app, "claude:status", &session_id, "meta", meta);
        }
        app_cmd::log_tauri(
            app,
            &format!(
                "[codex-account] switched CODEX_HOME={}",
                path.to_string_lossy()
            ),
        );

        Ok(json!({
            "success": true,
            "account": codex_account_info_value(app, path, true),
        }))
    }

    fn ensure_thread_for_session(
        &self,
        app: &HostContext,
        session_id: &str,
    ) -> Result<String, BridgeError> {
        let (model, cwd, approval_policy, sandbox_mode, existing_thread) = {
            let sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let session = sessions
                .get(session_id)
                .ok_or_else(|| bridge_error("Codex session not started"))?;
            (
                session.model.clone(),
                session.cwd.clone(),
                session.approval_policy.clone(),
                session.sandbox_mode.clone(),
                session.thread_id.clone(),
            )
        };
        if let Some(thread_id) = existing_thread {
            return Ok(thread_id);
        }

        let connection = self.ensure_connection(app).map_err(|err| {
            self.inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .remove(session_id);
            bridge_error(err)
        })?;
        let response = connection
            .request_logged(
                app,
                session_id,
                "thread/start",
                build_thread_start_params(&model, &cwd, &approval_policy, &sandbox_mode),
                REQUEST_TIMEOUT,
            )
            .map_err(bridge_error)?;
        let Some(thread_id) = response
            .get("thread")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .or_else(|| response.get("threadId").and_then(Value::as_str))
            .map(str::to_string)
        else {
            self.inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .remove(session_id);
            return Err(bridge_error(
                "codex app-server thread/start returned no thread id",
            ));
        };
        {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            if let Some(session) = sessions.get_mut(session_id) {
                session.thread_id = Some(thread_id.clone());
                clear_runtime_status(session);
                emit(app, "claude:status", session_id, "meta", session.metadata());
            }
        }
        self.inner
            .thread_to_session
            .lock()
            .expect("codex thread map lock")
            .insert(thread_id.clone(), session_id.to_string());
        log_codex(
            app,
            session_id,
            format!("started new thread after Codex account switch thread={thread_id}"),
        );
        Ok(thread_id)
    }

    fn session_id_for_notification(&self, params: &Value) -> Option<String> {
        if let Some(thread_id) = thread_id_from_params(params) {
            if let Some(session_id) = self
                .inner
                .thread_to_session
                .lock()
                .expect("codex thread map lock")
                .get(&thread_id)
                .cloned()
            {
                return Some(session_id);
            }
        }
        let sessions = self.inner.sessions.lock().expect("codex sessions lock");
        if sessions.len() == 1 {
            sessions.keys().next().cloned()
        } else {
            None
        }
    }

    fn stale_turn_notification(
        &self,
        session_id: &str,
        method: &str,
        params: &Value,
    ) -> Option<(String, Option<String>)> {
        let turn_id = turn_id_from_params(params)?;
        let sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get(session_id)?;
        if session.ignored_turn_ids.iter().any(|id| id == &turn_id) {
            return Some((turn_id, session.active_turn_id.clone()));
        }
        if method != "turn/started" {
            if let Some(active_turn_id) = &session.active_turn_id {
                if active_turn_id != &turn_id {
                    return Some((turn_id, Some(active_turn_id.clone())));
                }
            }
        }
        None
    }

    fn take_thread_ownership(
        &self,
        app: &HostContext,
        thread_id: &str,
        owner_session_id: &str,
    ) -> Vec<String> {
        let mut status_updates: Vec<(String, Value)> = Vec::new();
        let mut remote_turns_to_interrupt: Vec<String> = Vec::new();
        let mut ownership_logs: Vec<String> = Vec::new();

        {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let mut owner_ignored_turns: Vec<String> = Vec::new();

            for (session_id, session) in sessions.iter_mut() {
                if session_id == owner_session_id {
                    continue;
                }
                if session.thread_id.as_deref() != Some(thread_id) {
                    continue;
                }

                let was_active = session.is_running
                    || session.is_resting
                    || session.abort_requested
                    || session.active_turn_id.is_some()
                    || session.active_turn_key.is_some()
                    || session.runtime_status.is_some()
                    || session.runtime_message.is_some();

                if let Some(turn_id) = session.active_turn_id.clone() {
                    remember_ignored_turn(session, turn_id.clone());
                    if !owner_ignored_turns.iter().any(|id| id == &turn_id) {
                        owner_ignored_turns.push(turn_id.clone());
                    }
                    if !remote_turns_to_interrupt.iter().any(|id| id == &turn_id) {
                        remote_turns_to_interrupt.push(turn_id.clone());
                    }
                    ownership_logs.push(format!(
                        "thread ownership transferred thread={thread_id} from session={session_id} activeTurn={turn_id}"
                    ));
                } else if let Some(turn_key) = session.active_turn_key.clone() {
                    remember_ignored_turn(session, turn_key.clone());
                    if !owner_ignored_turns.iter().any(|id| id == &turn_key) {
                        owner_ignored_turns.push(turn_key);
                    }
                }

                session.is_running = false;
                session.is_resting = false;
                session.abort_requested = false;
                session.active_turn_id = None;
                session.active_turn_key = None;
                let had_runtime_status = clear_runtime_status_if_set(session);

                if was_active || had_runtime_status {
                    status_updates.push((session_id.clone(), session.metadata()));
                }
            }

            if let Some(owner) = sessions.get_mut(owner_session_id) {
                owner.thread_id = Some(thread_id.to_string());
                for turn_id in owner_ignored_turns {
                    remember_ignored_turn(owner, turn_id);
                }
            }
        }

        self.inner
            .thread_to_session
            .lock()
            .expect("codex thread map lock")
            .insert(thread_id.to_string(), owner_session_id.to_string());

        for (session_id, metadata) in status_updates {
            emit(app, "claude:status", &session_id, "meta", metadata);
        }
        for message in ownership_logs {
            log_codex(app, owner_session_id, message);
        }

        remote_turns_to_interrupt
    }

    fn interrupt_turn_for_replacement(
        &self,
        app: &HostContext,
        connection: &CodexConnection,
        session_id: &str,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Vec<String>, String> {
        let mut turns_to_ignore = vec![turn_id.to_string()];
        let mut turn_to_interrupt = turn_id.to_string();
        let mut retried_found_turn = false;

        loop {
            match connection.request_logged(
                app,
                session_id,
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_to_interrupt.clone() }),
                REQUEST_TIMEOUT,
            ) {
                Ok(_) => {
                    log_codex(
                        app,
                        session_id,
                        format!("replacement turn/interrupt ok turn={turn_to_interrupt}"),
                    );
                    break;
                }
                Err(err) => {
                    if !retried_found_turn {
                        if let Some(found_turn_id) = found_active_turn_from_interrupt_error(&err) {
                            if found_turn_id != turn_to_interrupt {
                                log_codex(
                                    app,
                                    session_id,
                                    format!(
                                        "replacement turn/interrupt found active turn mismatch; retrying found turn={found_turn_id}"
                                    ),
                                );
                                turns_to_ignore.push(found_turn_id.clone());
                                turn_to_interrupt = found_turn_id;
                                retried_found_turn = true;
                                continue;
                            }
                        }
                    }
                    if is_no_active_turn_interrupt_error(&err) {
                        log_codex(
                            app,
                            session_id,
                            format!(
                                "replacement turn/interrupt found no active remote turn; continuing after clearing stale local turn={turn_to_interrupt}"
                            ),
                        );
                        break;
                    }
                    return Err(err);
                }
            }
        }

        Ok(turns_to_ignore)
    }

    fn remove_thread_owner_if_session(&self, thread_id: &str, session_id: &str) {
        let mut thread_map = self
            .inner
            .thread_to_session
            .lock()
            .expect("codex thread map lock");
        if thread_map
            .get(thread_id)
            .map(|owner| owner == session_id)
            .unwrap_or(false)
        {
            thread_map.remove(thread_id);
        }
    }

    // Read the account-level 5h/weekly rate-limit snapshot over the EXISTING
    // shared connection (one app-server process, one active account — so one
    // poll covers every session/window). Returns None when codex isn't in use:
    // we never spawn an app-server just to read usage.
    pub fn fetch_account_rate_limits(&self, app: &HostContext) -> Option<Value> {
        let connection = self.inner.connection.lock().ok()?.as_ref().cloned()?;
        connection
            .request_logged(
                app,
                "usage",
                "account/rateLimits/read",
                json!({}),
                Duration::from_secs(15),
            )
            .ok()
    }

    fn clear_connection_if_pid(&self, pid: u32) -> bool {
        let Ok(mut guard) = self.inner.connection.lock() else {
            return false;
        };
        let should_clear = guard
            .as_ref()
            .map(|connection| connection.pid == pid)
            .unwrap_or(false);
        if should_clear {
            *guard = None;
        }
        should_clear
    }

    fn ensure_connection(&self, app: &HostContext) -> Result<Arc<CodexConnection>, String> {
        let (active_changed, current_auth_id) =
            self.sync_unified_active_from_shared(app, "ensure-connection")?;
        if active_changed {
            self.drop_connection(app, "sync-active-changed");
        }

        if let Some(existing) = self
            .inner
            .connection
            .lock()
            .map_err(|_| "codex connection lock poisoned")?
            .clone()
        {
            let resolved_identity = resolve_codex_binary(app).identity();
            if codex_unified_enabled(app) && existing.auth_account_id != current_auth_id {
                log_codex_global(
                    app,
                    format!(
                        "ensure_connection dropping pid={} auth changed from {} to {}",
                        existing.pid,
                        existing.auth_account_id.as_deref().unwrap_or("none"),
                        current_auth_id.as_deref().unwrap_or("none")
                    ),
                );
                self.drop_connection(app, "connection-auth-mismatch");
            } else if existing.binary_identity != resolved_identity && !self.any_session_running() {
                // A different codex binary resolves now — typically the managed
                // runtime finished installing after this app-server was spawned
                // from a PATH/npm fallback (which can be releases old and reject
                // newer models). Recycle while no turn is in flight so the next
                // request spawns the catalog-pinned CLI instead of staying on
                // the stale binary until an app restart.
                log_codex_global(
                    app,
                    format!(
                        "ensure_connection dropping pid={} binary changed [{}] -> [{}]",
                        existing.pid, existing.binary_identity, resolved_identity
                    ),
                );
                self.drop_connection(app, "binary-changed");
            } else {
                if existing.binary_identity != resolved_identity {
                    log_codex_global(
                        app,
                        format!(
                            "ensure_connection reuse pid={} with stale binary [{}] (now resolves [{}]); turn in flight, recycling deferred",
                            existing.pid, existing.binary_identity, resolved_identity
                        ),
                    );
                } else {
                    log_codex_global(
                        app,
                        format!("ensure_connection reuse existing pid={}", existing.pid),
                    );
                }
                return Ok(existing);
            }
        }

        let (spawn_auth_id, spawn_auth_summary) = if codex_unified_enabled(app) {
            if let Some(shared) = shared_home(app) {
                (
                    Self::shared_auth_account_id(&shared),
                    Some(Self::auth_debug_summary(&shared)),
                )
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };
        log_codex_global(
            app,
            format!(
                "ensure_connection spawning codex app-server spawnAuthId={} spawnAuth=[{}]",
                spawn_auth_id.as_deref().unwrap_or("none"),
                spawn_auth_summary.as_deref().unwrap_or("non-unified")
            ),
        );
        let binary_identity = resolve_codex_binary(app).identity();
        let mut child = build_codex_command(app)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|err| format!("failed to start codex app-server: {err}"))?;
        let pid = child.id();
        log_codex_global(
            app,
            format!("codex app-server spawned pid={pid} binary=[{binary_identity}]"),
        );
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex app-server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex app-server stdout unavailable".to_string())?;
        let pending = Arc::new(PendingTable::default());
        let connection = Arc::new(CodexConnection {
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(0),
            pending: pending.clone(),
            child: Mutex::new(child),
            pid,
            auth_account_id: spawn_auth_id,
            binary_identity,
        });

        let app_for_reader = app.clone();
        let state_for_reader = self.clone();
        let connection_for_reader = Arc::downgrade(&connection);
        std::thread::spawn(move || {
            log_codex_global(&app_for_reader, format!("reader started pid={pid}"));
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        if let Ok(message) = serde_json::from_str::<Value>(&line) {
                            handle_server_message(
                                &app_for_reader,
                                &state_for_reader,
                                &pending,
                                &connection_for_reader,
                                message,
                            );
                        } else {
                            log_codex_global(
                                &app_for_reader,
                                format!("reader non-json line pid={pid} bytes={}", line.len()),
                            );
                        }
                    }
                    Ok(_) => {}
                    Err(err) => {
                        log_codex_global(
                            &app_for_reader,
                            format!("reader failed pid={pid} error={err}"),
                        );
                        break;
                    }
                }
            }
            for tx in pending.drain_all() {
                let _ = tx.send(Err("codex app-server exited".to_string()));
            }
            state_for_reader.cancel_dead_pending_approvals(&app_for_reader);
            let cleared = state_for_reader.clear_connection_if_pid(pid);
            log_codex_global(
                &app_for_reader,
                format!("reader exited pid={pid} clearedConnection={cleared}"),
            );
        });

        {
            let mut guard = self
                .inner
                .connection
                .lock()
                .map_err(|_| "codex connection lock poisoned")?;
            *guard = Some(connection.clone());
        }

        if let Err(err) = connection.request_logged(
            app,
            "init",
            "initialize",
            json!({
                "clientInfo": {
                    "name": "better_agent_terminal",
                    "title": "Better Agent Terminal",
                    "version": app.version()
                },
                "capabilities": { "experimentalApi": true }
            }),
            REQUEST_TIMEOUT,
        ) {
            let cleared = self.clear_connection_if_pid(pid);
            log_codex_global(
                app,
                format!("initialize failed pid={pid} clearedConnection={cleared} error={err}"),
            );
            return Err(err);
        }
        log_codex_global(app, format!("initialize ok pid={pid}"));
        if let Err(err) = connection.notify("initialized", json!({})) {
            let cleared = self.clear_connection_if_pid(pid);
            log_codex_global(
                app,
                format!(
                    "initialized notification failed pid={pid} clearedConnection={cleared} error={err}"
                ),
            );
            return Err(err);
        }
        log_codex_global(app, format!("initialized notification sent pid={pid}"));
        Ok(connection)
    }

    pub fn start_session(
        &self,
        app: &HostContext,
        session_id: String,
        options: Option<Value>,
    ) -> Result<Value, BridgeError> {
        let options = options.unwrap_or(Value::Null);
        let cwd = effective_cwd(&options, "startSession")?;
        let model = options
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_CODEX_MODEL)
            .to_string();
        let sandbox_mode =
            normalize_sandbox(options.get("codexSandboxMode").and_then(Value::as_str));
        let approval_policy =
            normalize_approval(options.get("codexApprovalPolicy").and_then(Value::as_str));
        let effort = normalize_effort(options.get("effort").and_then(Value::as_str));
        log_codex(
            app,
            &session_id,
            format!(
                "start_session requested cwd={cwd} model={model} effort={effort} sandbox={sandbox_mode} approval={approval_policy}"
            ),
        );
        let session = CodexSession {
            session_id: session_id.clone(),
            thread_id: None,
            cwd: cwd.clone(),
            model: model.clone(),
            sandbox_mode: sandbox_mode.clone(),
            approval_policy: approval_policy.clone(),
            effort,
            context_window: codex_context_window_for_model(&model),
            start_time: Instant::now(),
            active_turn_id: None,
            active_turn_key: None,
            assistant_text: String::new(),
            thinking_text: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            num_turns: 0,
            last_turn_started_at: None,
            last_turn_first_token_ms: None,
            last_turn_duration_ms: None,
            messages: Vec::new(),
            temporary_image_paths: Vec::new(),
            command_outputs: HashMap::new(),
            command_output_last_emit: HashMap::new(),
            runtime_status: None,
            runtime_message: None,
            runtime_status_started_at: None,
            is_running: false,
            is_resting: false,
            abort_requested: false,
            ignored_turn_ids: Vec::new(),
        };
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .insert(session_id.clone(), session);

        let connection = self.ensure_connection(app).map_err(|err| {
            self.inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .remove(&session_id);
            bridge_error(err)
        })?;
        let response = connection
            .request_logged(
                app,
                &session_id,
                "thread/start",
                build_thread_start_params(&model, &cwd, &approval_policy, &sandbox_mode),
                REQUEST_TIMEOUT,
            )
            .map_err(|err| {
                self.inner
                    .sessions
                    .lock()
                    .expect("codex sessions lock")
                    .remove(&session_id);
                bridge_error(err)
            })?;
        let thread_id = response
            .get("thread")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .or_else(|| response.get("threadId").and_then(Value::as_str))
            .ok_or_else(|| bridge_error("codex app-server thread/start returned no thread id"))?
            .to_string();
        log_codex(
            app,
            &session_id,
            format!("start_session thread/start ok thread={thread_id}"),
        );

        {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            if let Some(session) = sessions.get_mut(&session_id) {
                session.thread_id = Some(thread_id.clone());
                let msg = make_system_message(
                    &session_id,
                    format!(
                        "Codex session started (sandbox: {}, approval: {})",
                        session.sandbox_mode, session.approval_policy
                    ),
                );
                session.messages.push(msg.clone());
                emit(app, "claude:message", &session_id, "message", msg);
                emit(
                    app,
                    "claude:status",
                    &session_id,
                    "meta",
                    session.metadata(),
                );
                if let Some(payload) = worktree_payload(&options) {
                    emit(app, "claude:worktree-info", &session_id, "payload", payload);
                }
            }
        }
        self.take_thread_ownership(app, &thread_id, &session_id);

        if let Some(prompt) = options.get("prompt").and_then(Value::as_str) {
            if !prompt.trim().is_empty() {
                self.send_message(app, session_id.clone(), prompt.to_string(), Vec::new())?;
            }
        }
        Ok(json!({ "ok": true, "sessionId": session_id, "sdkSessionId": thread_id }))
    }

    pub fn resume_session(
        &self,
        app: &HostContext,
        session_id: String,
        sdk_session_id: String,
        options: Option<Value>,
    ) -> Result<Value, BridgeError> {
        let options = options.unwrap_or(Value::Null);
        let cwd = effective_cwd(&options, "resumeSession")?;
        let model = options
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_CODEX_MODEL)
            .to_string();
        let sandbox_mode =
            normalize_sandbox(options.get("codexSandboxMode").and_then(Value::as_str));
        let approval_policy =
            normalize_approval(options.get("codexApprovalPolicy").and_then(Value::as_str));
        log_codex(
            app,
            &session_id,
            format!(
                "resume_session requested thread={} cwd={cwd} model={model} sandbox={sandbox_mode} approval={approval_policy}",
                sdk_session_id
            ),
        );
        let connection = self.ensure_connection(app).map_err(bridge_error)?;
        emit(
            app,
            "claude:resume-loading",
            &session_id,
            "loading",
            json!(true),
        );
        let response = connection.request_logged(
            app,
            &session_id,
            "thread/resume",
            json!({
                "threadId": sdk_session_id,
                "model": model,
                "cwd": cwd,
                "approvalPolicy": approval_policy,
                "sandbox": app_server_sandbox(&sandbox_mode),
                "serviceName": "better_agent_terminal",
            }),
            REQUEST_TIMEOUT,
        );
        if let Err(err) = response {
            emit(
                app,
                "claude:resume-loading",
                &session_id,
                "loading",
                json!(false),
            );
            return Err(bridge_error(err));
        }

        let context_window = codex_context_window_for_model(&model);
        let session = CodexSession {
            session_id: session_id.clone(),
            thread_id: Some(sdk_session_id.clone()),
            cwd,
            model,
            sandbox_mode,
            approval_policy,
            effort: normalize_effort(options.get("effort").and_then(Value::as_str)),
            context_window,
            start_time: Instant::now(),
            active_turn_id: None,
            active_turn_key: None,
            assistant_text: String::new(),
            thinking_text: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            num_turns: 0,
            last_turn_started_at: None,
            last_turn_first_token_ms: None,
            last_turn_duration_ms: None,
            messages: Vec::new(),
            temporary_image_paths: Vec::new(),
            command_outputs: HashMap::new(),
            command_output_last_emit: HashMap::new(),
            runtime_status: None,
            runtime_message: None,
            runtime_status_started_at: None,
            is_running: false,
            is_resting: false,
            abort_requested: false,
            ignored_turn_ids: Vec::new(),
        };
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .insert(session_id.clone(), session.clone());
        let takeover_turns = self.take_thread_ownership(app, &sdk_session_id, &session_id);
        let mut takeover_turns_to_remember: Vec<String> = Vec::new();
        for turn_id in takeover_turns {
            match self.interrupt_turn_for_replacement(
                app,
                &connection,
                &session_id,
                &sdk_session_id,
                &turn_id,
            ) {
                Ok(turns_to_ignore) => takeover_turns_to_remember.extend(turns_to_ignore),
                Err(err) => log_codex(
                    app,
                    &session_id,
                    format!(
                        "thread takeover turn/interrupt failed during resume; continuing thread={sdk_session_id} turn={turn_id} error={err}"
                    ),
                ),
            }
        }
        if !takeover_turns_to_remember.is_empty() {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            if let Some(session) = sessions.get_mut(&session_id) {
                for turn_id in takeover_turns_to_remember {
                    remember_ignored_turn(session, turn_id);
                }
            }
        }
        emit(
            app,
            "claude:status",
            &session_id,
            "meta",
            session.metadata(),
        );
        if let Some(payload) = worktree_payload(&options) {
            emit(app, "claude:worktree-info", &session_id, "payload", payload);
        }
        let history_items = load_codex_history_items(app, &session_id, &sdk_session_id);
        log_codex(
            app,
            &session_id,
            format!(
                "resume_session thread/resume ok thread={} historyItems={}",
                sdk_session_id,
                history_items.len()
            ),
        );
        {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            if let Some(session) = sessions.get_mut(&session_id) {
                session.messages = history_items
                    .iter()
                    .rev()
                    .take(MSG_BUFFER_CAP)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            }
        }
        emit(
            app,
            "claude:history",
            &session_id,
            "items",
            json!(history_items),
        );
        emit(
            app,
            "claude:resume-loading",
            &session_id,
            "loading",
            json!(false),
        );
        Ok(json!({ "ok": true, "sessionId": session_id, "sdkSessionId": sdk_session_id }))
    }

    pub fn send_message(
        &self,
        app: &HostContext,
        session_id: String,
        prompt: String,
        images: Vec<String>,
    ) -> Result<Value, BridgeError> {
        let image_count = images.len();
        let prompt = if prompt.trim().is_empty() && !images.is_empty() {
            "Please analyze the attached image.".to_string()
        } else {
            prompt.trim().to_string()
        };
        log_codex(
            app,
            &session_id,
            format!(
                "send_message requested promptLen={} images={}",
                prompt.len(),
                image_count
            ),
        );
        if prompt.is_empty() {
            log_codex(app, &session_id, "send_message rejected: empty prompt");
            return Ok(json!({ "ok": false, "error": "empty prompt" }));
        }
        let (input, mut temp_image_paths) = match build_turn_input(&prompt, images) {
            Ok(input) => input,
            Err(err) => {
                log_codex(
                    app,
                    &session_id,
                    format!("send_message build_turn_input failed: {err}"),
                );
                self.fail_turn(app, &session_id, err.clone());
                return Ok(json!({ "ok": false, "error": err }));
            }
        };
        if let Err(err) = self.ensure_thread_for_session(app, &session_id) {
            cleanup_temp_images(temp_image_paths);
            return Err(err);
        }
        let (thread_id, model, effort, cwd, approval_policy, sandbox_mode, interrupted_turn) = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let Some(session) = sessions.get_mut(&session_id) else {
                cleanup_temp_images(temp_image_paths);
                log_codex(
                    app,
                    &session_id,
                    "send_message rejected: session not started",
                );
                return Err(bridge_error("Codex session not started"));
            };
            log_codex(
                app,
                &session_id,
                format!(
                    "send_message session state is_running={} activeTurn={} thread={}",
                    session.is_running,
                    session.active_turn_id.as_deref().unwrap_or("none"),
                    session.thread_id.as_deref().unwrap_or("none")
                ),
            );
            let interrupted_turn = if let Some(turn_id) = session.active_turn_id.clone() {
                let Some(thread_id) = session.thread_id.clone() else {
                    cleanup_temp_images(temp_image_paths);
                    let message =
                        "Codex turn already running but no thread id is available to interrupt.";
                    log_codex(
                        app,
                        &session_id,
                        format!("send_message rejected: {message}"),
                    );
                    return Ok(json!({ "ok": false, "error": message }));
                };
                log_codex(
                    app,
                    &session_id,
                    format!("send_message replacing active turn={turn_id}"),
                );
                Some((thread_id, turn_id))
            } else if session.is_running {
                cleanup_temp_images(temp_image_paths);
                let message = "Codex turn is still starting; wait for it to become interruptible.";
                log_codex(
                    app,
                    &session_id,
                    format!("send_message rejected: {message}"),
                );
                return Ok(json!({ "ok": false, "error": message }));
            } else {
                None
            };
            let Some(session_thread_id) = session.thread_id.clone() else {
                cleanup_temp_images(temp_image_paths);
                return Err(bridge_error("Codex thread not started"));
            };
            (
                session_thread_id,
                session.model.clone(),
                session.effort.clone(),
                session.cwd.clone(),
                session.approval_policy.clone(),
                session.sandbox_mode.clone(),
                interrupted_turn,
            )
        };
        let connection = match self.ensure_connection(app) {
            Ok(connection) => connection,
            Err(err) => {
                cleanup_temp_images(temp_image_paths);
                return Err(bridge_error(err));
            }
        };
        let takeover_turns = self.take_thread_ownership(app, &thread_id, &session_id);
        let mut turns_to_remember: Vec<String> = Vec::new();
        for turn_id in takeover_turns {
            match self.interrupt_turn_for_replacement(
                app,
                &connection,
                &session_id,
                &thread_id,
                &turn_id,
            ) {
                Ok(turns_to_ignore) => turns_to_remember.extend(turns_to_ignore),
                Err(err) => {
                    cleanup_temp_images(temp_image_paths);
                    log_codex(
                        app,
                        &session_id,
                        format!("thread takeover turn/interrupt failed before turn/start: {err}"),
                    );
                    return Ok(json!({
                        "ok": false,
                        "error": format!("Codex turn is still running and could not be interrupted: {err}")
                    }));
                }
            }
        }
        if let Some((interrupt_thread_id, interrupt_turn_id)) = interrupted_turn {
            match self.interrupt_turn_for_replacement(
                app,
                &connection,
                &session_id,
                &interrupt_thread_id,
                &interrupt_turn_id,
            ) {
                Ok(turns_to_ignore) => turns_to_remember.extend(turns_to_ignore),
                Err(err) => {
                    cleanup_temp_images(temp_image_paths);
                    log_codex(
                        app,
                        &session_id,
                        format!("replacement turn/interrupt failed before turn/start: {err}"),
                    );
                    return Ok(json!({
                        "ok": false,
                        "error": format!("Codex turn is still running and could not be interrupted: {err}")
                    }));
                }
            }
        }
        if !turns_to_remember.is_empty() {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            if let Some(session) = sessions.get_mut(&session_id) {
                for turn_id in turns_to_remember {
                    remember_ignored_turn(session, turn_id);
                }
            }
        }
        {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let Some(session) = sessions.get_mut(&session_id) else {
                cleanup_temp_images(temp_image_paths);
                log_codex(
                    app,
                    &session_id,
                    "send_message rejected after interrupt: session not found",
                );
                return Err(bridge_error("Codex session not started"));
            };
            cleanup_session_temp_images(session);
            session.temporary_image_paths.append(&mut temp_image_paths);
            session.abort_requested = false;
            session.is_running = true;
            session.is_resting = false;
            session.active_turn_id = None;
            session.num_turns += 1;
            session.active_turn_key = Some(format!(
                "local-{}-{}",
                session.session_id, session.num_turns
            ));
            session.last_turn_started_at = Some(Instant::now());
            session.last_turn_first_token_ms = None;
            session.last_turn_duration_ms = None;
            session.assistant_text.clear();
            session.thinking_text.clear();
            session.command_outputs.clear();
            session.command_output_last_emit.clear();
            set_runtime_status(
                session,
                "waiting_for_api",
                "Still waiting for Codex API response.",
            );
            let msg = make_user_message(&session_id, &prompt, image_count);
            session.messages.push(msg.clone());
            emit(app, "claude:message", &session_id, "message", msg);
            emit(
                app,
                "claude:status",
                &session_id,
                "meta",
                session.metadata(),
            );
        }
        log_codex(
            app,
            &session_id,
            format!(
                "turn/start request thread={} model={} effort={}",
                thread_id, model, effort
            ),
        );
        let response = match connection.request_logged(
            app,
            &session_id,
            "turn/start",
            build_turn_start_params(
                &thread_id,
                input.clone(),
                &model,
                &effort,
                &approval_policy,
                &sandbox_mode,
            ),
            TURN_START_TIMEOUT,
        ) {
            Ok(response) => response,
            Err(err) => {
                log_codex(app, &session_id, format!("turn/start failed: {err}"));
                if is_thread_not_found_error(&err) {
                    log_codex(
                        app,
                        &session_id,
                        format!("thread not found; attempting thread/resume thread={thread_id}"),
                    );
                    {
                        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
                        if let Some(session) = sessions.get_mut(&session_id) {
                            set_runtime_status(
                                session,
                                "starting",
                                "Resuming Codex thread before retrying the API request.",
                            );
                            emit(
                                app,
                                "claude:status",
                                &session_id,
                                "meta",
                                session.metadata(),
                            );
                        }
                    }
                    match connection.request_logged(
                        app,
                        &session_id,
                        "thread/resume",
                        build_thread_resume_params(
                            &thread_id,
                            &model,
                            &cwd,
                            &approval_policy,
                            &sandbox_mode,
                        ),
                        REQUEST_TIMEOUT,
                    ) {
                        Ok(_) => {
                            log_codex(
                                app,
                                &session_id,
                                format!("thread/resume ok; retrying turn/start thread={thread_id}"),
                            );
                            self.take_thread_ownership(app, &thread_id, &session_id);
                            match connection.request_logged(
                                app,
                                &session_id,
                                "turn/start",
                                build_turn_start_params(
                                    &thread_id,
                                    input,
                                    &model,
                                    &effort,
                                    &approval_policy,
                                    &sandbox_mode,
                                ),
                                TURN_START_TIMEOUT,
                            ) {
                                Ok(response) => response,
                                Err(retry_err) => {
                                    log_codex(
                                        app,
                                        &session_id,
                                        format!("turn/start retry failed after thread/resume: {retry_err}"),
                                    );
                                    self.fail_turn(
                                        app,
                                        &session_id,
                                        format!("Codex error after thread resume: {retry_err}"),
                                    );
                                    return Ok(json!({ "ok": false, "error": retry_err }));
                                }
                            }
                        }
                        Err(resume_err) => {
                            log_codex(
                                app,
                                &session_id,
                                format!("thread/resume failed: {resume_err}"),
                            );
                            let message = format!(
                                "Codex error: thread not found: {thread_id}; resume failed: {resume_err}"
                            );
                            self.fail_turn(app, &session_id, message.clone());
                            return Ok(json!({ "ok": false, "error": message }));
                        }
                    }
                } else {
                    self.fail_turn(app, &session_id, format!("Codex error: {err}"));
                    return Ok(json!({ "ok": false, "error": err }));
                }
            }
        };
        if let Some(turn_id) = response
            .get("turn")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
        {
            if let Some(session) = self
                .inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .get_mut(&session_id)
            {
                session.active_turn_id = Some(turn_id.to_string());
                session.active_turn_key = Some(turn_id.to_string());
            }
            log_codex(
                app,
                &session_id,
                format!("turn/start ok activeTurn={turn_id}"),
            );
        } else {
            log_codex(
                app,
                &session_id,
                "turn/start ok without turn id in response",
            );
        }
        Ok(json!({ "ok": true }))
    }

    fn fail_turn(&self, app: &HostContext, session_id: &str, message: String) {
        log_codex(app, session_id, format!("fail_turn: {message}"));
        self.cancel_pending_approvals(app, session_id);
        if Self::auth_failure_message(&message) {
            self.mark_shared_auth_needs_login(app, &message);
        }
        let (meta, turn_id, thread_id) = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            sessions.get_mut(session_id).map(|session| {
                let turn_id = session
                    .active_turn_id
                    .clone()
                    .or_else(|| session.active_turn_key.clone());
                let thread_id = session.thread_id.clone();
                session.abort_requested = false;
                session.is_running = false;
                session.active_turn_id = None;
                session.active_turn_key = None;
                clear_runtime_status(session);
                if let Some(started_at) = session.last_turn_started_at {
                    session.last_turn_duration_ms = Some(started_at.elapsed().as_millis() as u64);
                }
                cleanup_session_temp_images(session);
                session.command_outputs.clear();
                session.command_output_last_emit.clear();
                (Some(session.metadata()), turn_id, thread_id)
            })
        }
        .unwrap_or_else(|| (None, None, None));
        if let Some(meta) = meta {
            emit(app, "claude:status", session_id, "meta", meta);
        }
        emit(app, "claude:error", session_id, "error", json!(message));
        emit(
            app,
            "claude:turn-end",
            session_id,
            "payload",
            json!({ "reason": "error", "error": message, "turnId": turn_id, "sdkSessionId": thread_id }),
        );
    }

    pub fn abort_session(
        &self,
        app: &HostContext,
        session_id: String,
    ) -> Result<Value, BridgeError> {
        log_codex(app, &session_id, "abort_session requested");
        // Answer any approval prompt with "cancel" first so a pending approval
        // cannot keep the turn (and the interrupt below) blocked.
        self.cancel_pending_approvals(app, &session_id);
        let (thread_id, interrupt_turn_id, turn_end_id) = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let Some(session) = sessions.get_mut(&session_id) else {
                log_codex(app, &session_id, "abort_session ignored: session not found");
                return Ok(json!({ "ok": true }));
            };
            log_codex(
                app,
                &session_id,
                format!(
                    "abort_session state is_running={} activeTurn={} thread={}",
                    session.is_running,
                    session.active_turn_id.as_deref().unwrap_or("none"),
                    session.thread_id.as_deref().unwrap_or("none")
                ),
            );
            let thread_id = session.thread_id.clone();
            let interrupt_turn_id = session.active_turn_id.clone();
            let turn_end_id = session
                .active_turn_id
                .clone()
                .or_else(|| session.active_turn_key.clone());
            if let Some(turn_id) = interrupt_turn_id.clone() {
                remember_ignored_turn(session, turn_id);
            }
            session.abort_requested = true;
            session.is_running = false;
            session.active_turn_id = None;
            session.active_turn_key = None;
            cleanup_session_temp_images(session);
            session.command_outputs.clear();
            session.command_output_last_emit.clear();
            (thread_id, interrupt_turn_id, turn_end_id)
        };
        if let (Some(thread_id), Some(turn_id)) = (thread_id.clone(), interrupt_turn_id.clone()) {
            let connection = self.ensure_connection(app).map_err(bridge_error)?;
            match connection.request_logged(
                app,
                &session_id,
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
                REQUEST_TIMEOUT,
            ) {
                Ok(_) => log_codex(app, &session_id, "turn/interrupt ok"),
                Err(err) => log_codex(app, &session_id, format!("turn/interrupt failed: {err}")),
            }
        } else {
            log_codex(
                app,
                &session_id,
                "abort_session has no active turn to interrupt",
            );
        }
        emit(
            app,
            "claude:turn-end",
            &session_id,
            "payload",
            json!({ "reason": "aborted", "turnId": turn_end_id }),
        );
        Ok(json!({ "ok": true }))
    }

    pub fn stop_session(&self, session_id: String) -> Value {
        let removed = self
            .inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .remove(&session_id);
        if let Some(mut session) = removed {
            cleanup_session_temp_images(&mut session);
            if let Some(thread_id) = session.thread_id {
                self.remove_thread_owner_if_session(&thread_id, &session_id);
            }
            json!({ "ok": true, "existed": true })
        } else {
            json!({ "ok": true, "existed": false })
        }
    }

    pub fn reset_session(
        &self,
        app: &HostContext,
        session_id: String,
    ) -> Result<Value, BridgeError> {
        let (model, cwd, approval_policy, sandbox_mode, thread_id) = {
            let sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let session = sessions
                .get(&session_id)
                .ok_or_else(|| bridge_error("Codex session not started"))?;
            (
                session.model.clone(),
                session.cwd.clone(),
                session.approval_policy.clone(),
                session.sandbox_mode.clone(),
                session.thread_id.clone(),
            )
        };
        if let Some(thread_id) = thread_id {
            self.remove_thread_owner_if_session(&thread_id, &session_id);
        }
        let connection = self.ensure_connection(app).map_err(bridge_error)?;
        let response = connection
            .request_logged(
                app,
                &session_id,
                "thread/start",
                build_thread_start_params(&model, &cwd, &approval_policy, &sandbox_mode),
                REQUEST_TIMEOUT,
            )
            .map_err(bridge_error)?;
        let new_thread_id = response
            .get("thread")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .or_else(|| response.get("threadId").and_then(Value::as_str))
            .ok_or_else(|| bridge_error("codex app-server reset returned no thread id"))?
            .to_string();
        let meta = {
            let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let session = sessions
                .get_mut(&session_id)
                .ok_or_else(|| bridge_error("Codex session not started"))?;
            session.thread_id = Some(new_thread_id.clone());
            session.active_turn_id = None;
            session.active_turn_key = None;
            session.assistant_text.clear();
            session.thinking_text.clear();
            session.input_tokens = 0;
            session.output_tokens = 0;
            session.cache_read_tokens = 0;
            session.num_turns = 0;
            session.last_turn_started_at = None;
            session.last_turn_first_token_ms = None;
            session.last_turn_duration_ms = None;
            session.messages.clear();
            cleanup_session_temp_images(session);
            session.command_outputs.clear();
            session.command_output_last_emit.clear();
            session.abort_requested = false;
            session.is_running = false;
            session.is_resting = false;
            session.start_time = Instant::now();
            session.metadata()
        };
        self.inner
            .thread_to_session
            .lock()
            .expect("codex thread map lock")
            .insert(new_thread_id, session_id.clone());
        emit(
            app,
            "claude:session-reset",
            &session_id,
            "__none__",
            Value::Null,
        );
        emit(app, "claude:status", &session_id, "meta", meta);
        Ok(json!(true))
    }

    pub fn rest_session(&self, app: &HostContext, session_id: &str) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        session.is_resting = true;
        session.is_running = false;
        session.active_turn_id = None;
        session.active_turn_key = None;
        session.abort_requested = false;
        let msg = make_system_message(
            session_id,
            "Session is resting. Send a message to wake it up.".to_string(),
        );
        session.messages.push(msg.clone());
        drop(sessions);
        emit(app, "claude:message", session_id, "message", msg);
        emit(
            app,
            "claude:turn-end",
            session_id,
            "payload",
            json!({ "reason": "resting" }),
        );
        Some(json!(true))
    }

    pub fn wake_session(&self, session_id: &str) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        session.is_resting = false;
        Some(json!(true))
    }

    pub fn is_resting(&self, session_id: &str) -> Option<Value> {
        let sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get(session_id)?;
        Some(json!(session.is_resting))
    }

    pub fn get_session_state(&self, session_id: &str) -> Option<Value> {
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .get(session_id)
            .map(|session| {
                json!({
                    "sessionId": session.session_id,
                    "messages": session.messages,
                    "isStreaming": session.is_running,
                    "streamingText": session.assistant_text,
                    "streamingThinking": session.thinking_text,
                })
            })
    }

    pub fn get_session_meta(&self, session_id: &str) -> Option<Value> {
        self.inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .get(session_id)
            .map(CodexSession::metadata)
    }

    pub fn get_context_usage(&self, session_id: &str) -> Option<Value> {
        let sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get(session_id)?;
        let total_tokens = session.input_tokens + session.output_tokens;
        if total_tokens == 0 {
            return None;
        }
        let max_tokens = session.context_window;
        let percentage = if max_tokens > 0 {
            ((total_tokens as f64 / max_tokens as f64) * 100.0).round() as u64
        } else {
            0
        };
        Some(json!({
            "categories": [{ "name": "Context", "tokens": total_tokens, "color": "#10B981" }],
            "totalTokens": total_tokens,
            "maxTokens": max_tokens,
            "percentage": percentage,
            "model": session.model,
            "apiUsage": {
                "input_tokens": session.input_tokens,
                "output_tokens": session.output_tokens,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": session.cache_read_tokens,
            },
        }))
    }

    pub fn set_model(&self, app: &HostContext, session_id: &str, model: String) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        if session.model == model {
            return Some(json!(true));
        }
        session.model = model;
        session.context_window = codex_context_window_for_model(&session.model);
        let meta = session.metadata();
        let msg = make_system_message(
            session_id,
            format!("Codex model updated to {}.", session.model),
        );
        session.messages.push(msg.clone());
        emit(app, "claude:message", session_id, "message", msg);
        emit(app, "claude:status", session_id, "meta", meta.clone());
        Some(json!(true))
    }

    pub fn set_effort(&self, app: &HostContext, session_id: &str, effort: String) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        let next = normalize_effort(Some(&effort));
        if session.effort == next {
            return Some(json!(true));
        }
        session.effort = next;
        let meta = session.metadata();
        let msg = make_system_message(
            session_id,
            format!("Codex reasoning effort updated to {}.", session.effort),
        );
        session.messages.push(msg.clone());
        emit(app, "claude:message", session_id, "message", msg);
        emit(app, "claude:status", session_id, "meta", meta);
        Some(json!(true))
    }

    pub fn set_sandbox_mode(
        &self,
        app: &HostContext,
        session_id: &str,
        mode: String,
    ) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        let next = normalize_sandbox(Some(&mode));
        if session.sandbox_mode == next {
            return Some(json!(true));
        }
        session.sandbox_mode = next;
        let msg = make_system_message(
            session_id,
            format!("Codex sandbox updated to {}.", session.sandbox_mode),
        );
        session.messages.push(msg.clone());
        emit(app, "claude:message", session_id, "message", msg);
        Some(json!(true))
    }

    pub fn set_approval_policy(
        &self,
        app: &HostContext,
        session_id: &str,
        policy: String,
    ) -> Option<Value> {
        let mut sessions = self.inner.sessions.lock().expect("codex sessions lock");
        let session = sessions.get_mut(session_id)?;
        let next = normalize_approval(Some(&policy));
        if session.approval_policy == next {
            return Some(json!(true));
        }
        session.approval_policy = next;
        let msg = make_system_message(
            session_id,
            format!("Codex approval updated to {}.", session.approval_policy),
        );
        session.messages.push(msg.clone());
        emit(app, "claude:message", session_id, "message", msg);
        Some(json!(true))
    }

    pub fn reconfigure_session(
        &self,
        app: &HostContext,
        session_id: &str,
    ) -> Result<Value, BridgeError> {
        let (thread_id, model, cwd, approval_policy, sandbox_mode, meta) = {
            let sessions = self.inner.sessions.lock().expect("codex sessions lock");
            let session = sessions
                .get(session_id)
                .ok_or_else(|| bridge_error("Codex session not started"))?;
            let thread_id = session
                .thread_id
                .clone()
                .ok_or_else(|| bridge_error("Codex thread not started"))?;
            (
                thread_id,
                session.model.clone(),
                session.cwd.clone(),
                session.approval_policy.clone(),
                session.sandbox_mode.clone(),
                session.metadata(),
            )
        };
        let connection = self.ensure_connection(app).map_err(bridge_error)?;
        connection
            .request_logged(
                app,
                session_id,
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "model": model,
                    "cwd": cwd,
                    "approvalPolicy": approval_policy,
                    "sandbox": app_server_sandbox(&sandbox_mode),
                    "serviceName": "better_agent_terminal",
                }),
                REQUEST_TIMEOUT,
            )
            .map_err(bridge_error)?;
        emit(app, "claude:status", session_id, "meta", meta);
        Ok(json!(true))
    }

    // Server->client approval request (item/commandExecution/requestApproval or
    // item/fileChange/requestApproval): surface it to the renderer through the
    // existing claude:permission-request event shape and remember the JSON-RPC
    // request id so resolve_permission() can answer codex later.
    fn handle_approval_request(
        &self,
        app: &HostContext,
        connection: &Weak<CodexConnection>,
        request_id: Value,
        method: &str,
        params: Value,
    ) {
        let Some(session_id) = self.session_id_for_notification(&params) else {
            log_codex_global(
                app,
                format!("approval request {method} has no session mapping; declining"),
            );
            if let Some(connection) = connection.upgrade() {
                let _ = connection.send_response(request_id, json!({ "decision": "decline" }));
            }
            return;
        };
        if let Some((turn_id, active_turn_id)) =
            self.stale_turn_notification(&session_id, method, &params)
        {
            log_codex(
                app,
                &session_id,
                format!(
                    "approval request {method} cancelled for stale turn={turn_id} activeTurn={}",
                    active_turn_id.as_deref().unwrap_or("none")
                ),
            );
            if let Some(connection) = connection.upgrade() {
                let _ = connection.send_response(request_id, json!({ "decision": "cancel" }));
            }
            return;
        }
        let tool_use_id = format!(
            "codex-approval-{}",
            match &request_id {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            }
        );
        let (tool_name, input) = if method == "item/fileChange/requestApproval" {
            let mut input = serde_json::Map::new();
            if let Some(grant_root) = params.get("grantRoot").and_then(Value::as_str) {
                input.insert("grantRoot".to_string(), json!(grant_root));
            }
            ("Edit", Value::Object(input))
        } else {
            let mut input = serde_json::Map::new();
            if let Some(command) = params.get("command") {
                let command_text = match command {
                    Value::String(text) => text.clone(),
                    Value::Array(parts) => parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" "),
                    other => other.to_string(),
                };
                input.insert("command".to_string(), json!(command_text));
            }
            if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
                input.insert("cwd".to_string(), json!(cwd));
            }
            ("Bash", Value::Object(input))
        };
        // Full params in debug builds: shows networkApprovalContext /
        // proposedNetworkPolicyAmendments / availableDecisions in real traffic.
        log_codex(
            app,
            &session_id,
            format!("approval request {method} params={params}"),
        );
        let decision_reason = params
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                // Network-blocked commands carry the blocked host; surface it
                // so the user understands what approving means.
                params
                    .get("networkApprovalContext")
                    .and_then(|ctx| ctx.get("host"))
                    .and_then(Value::as_str)
                    .map(|host| format!("Needs network access to {host}"))
            });
        self.inner
            .pending_approvals
            .lock()
            .expect("codex approvals lock")
            .insert(
                tool_use_id.clone(),
                PendingApproval {
                    request_id,
                    session_id: session_id.clone(),
                    connection: connection.clone(),
                },
            );
        log_codex(
            app,
            &session_id,
            format!("approval request {method} pending as {tool_use_id}"),
        );
        emit(
            app,
            "claude:permission-request",
            &session_id,
            "data",
            json!({
                "toolUseId": tool_use_id,
                "toolName": tool_name,
                "input": input,
                "suggestions": [],
                "decisionReason": decision_reason,
            }),
        );
    }

    pub fn resolve_permission(
        &self,
        app: &HostContext,
        session_id: &str,
        tool_use_id: &str,
        result: &Value,
    ) -> Result<Value, BridgeError> {
        let pending = {
            let mut approvals = self
                .inner
                .pending_approvals
                .lock()
                .expect("codex approvals lock");
            match approvals.get(tool_use_id) {
                Some(entry) if entry.session_id == session_id => approvals.remove(tool_use_id),
                Some(_) => {
                    return Err(bridge_error(
                        "Permission request does not belong to this session",
                    ))
                }
                None => None,
            }
        };
        let Some(pending) = pending else {
            // Already resolved (e.g. from another window). Re-broadcast the
            // dismissal so every window clears the prompt, matching the
            // sidecar's idempotent behavior.
            emit(
                app,
                "claude:permission-resolved",
                session_id,
                "toolUseId",
                json!(tool_use_id),
            );
            return Ok(json!(false));
        };
        let behavior = result
            .get("behavior")
            .and_then(Value::as_str)
            .unwrap_or("deny");
        let decision = if behavior == "allow" {
            if result
                .get("dontAskAgain")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "acceptForSession"
            } else {
                "accept"
            }
        } else {
            "decline"
        };
        let connection = pending
            .connection
            .upgrade()
            .ok_or_else(|| bridge_error("Codex app-server connection closed"))?;
        connection
            .send_response(pending.request_id, json!({ "decision": decision }))
            .map_err(bridge_error)?;
        log_codex(
            app,
            session_id,
            format!("approval {tool_use_id} resolved decision={decision}"),
        );
        emit(
            app,
            "claude:permission-resolved",
            session_id,
            "toolUseId",
            json!(tool_use_id),
        );
        Ok(json!(true))
    }

    // Cancel any approvals still waiting on a session whose turn ended or was
    // aborted: answer codex with "cancel" and dismiss the renderer prompts.
    fn cancel_pending_approvals(&self, app: &HostContext, session_id: &str) {
        let drained: Vec<(String, PendingApproval)> = {
            let mut approvals = self
                .inner
                .pending_approvals
                .lock()
                .expect("codex approvals lock");
            let keys: Vec<String> = approvals
                .iter()
                .filter(|(_, entry)| entry.session_id == session_id)
                .map(|(key, _)| key.clone())
                .collect();
            keys.into_iter()
                .filter_map(|key| approvals.remove(&key).map(|entry| (key, entry)))
                .collect()
        };
        for (tool_use_id, pending) in drained {
            log_codex(
                app,
                session_id,
                format!("approval {tool_use_id} cancelled (turn ended)"),
            );
            if let Some(connection) = pending.connection.upgrade() {
                let _ =
                    connection.send_response(pending.request_id, json!({ "decision": "cancel" }));
            }
            emit(
                app,
                "claude:permission-resolved",
                session_id,
                "toolUseId",
                json!(tool_use_id),
            );
        }
    }

    // Dismiss prompts whose connection died (app-server exited): there is no
    // one to answer anymore, just clear the renderer state.
    fn cancel_dead_pending_approvals(&self, app: &HostContext) {
        let drained: Vec<(String, PendingApproval)> = {
            let mut approvals = self
                .inner
                .pending_approvals
                .lock()
                .expect("codex approvals lock");
            let keys: Vec<String> = approvals
                .iter()
                .filter(|(_, entry)| entry.connection.upgrade().is_none())
                .map(|(key, _)| key.clone())
                .collect();
            keys.into_iter()
                .filter_map(|key| approvals.remove(&key).map(|entry| (key, entry)))
                .collect()
        };
        for (tool_use_id, pending) in drained {
            emit(
                app,
                "claude:permission-resolved",
                &pending.session_id,
                "toolUseId",
                json!(tool_use_id),
            );
        }
    }
}

fn handle_server_message(
    app: &HostContext,
    state: &CodexAppServerState,
    pending: &Arc<PendingTable>,
    connection: &Weak<CodexConnection>,
    message: Value,
) {
    // JSON-RPC discrimination: a message carrying BOTH `method` and `id` is a
    // server->client REQUEST that requires a response (codex blocks the turn
    // until it gets one). `method` without `id` is a notification; `id`
    // without `method` is a response to one of our requests. Checking the
    // request case first also prevents a server request id from being
    // mis-consumed as a response when it numerically collides with one of our
    // pending request ids.
    if let Some(method) = message
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match message.get("id") {
            Some(id) if !id.is_null() => {
                handle_server_request(app, state, connection, id.clone(), &method, params);
            }
            _ => handle_notification(app, state, &method, params),
        }
        return;
    }

    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if let Some(tx) = pending.take(id) {
            let result = if let Some(error) = message.get("error") {
                if codex_debug_enabled() {
                    app_cmd::log_tauri(
                        app,
                        &format!(
                            "[codex-app-server] response id={id} error={}",
                            error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("codex app-server error")
                        ),
                    );
                }
                Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("codex app-server error")
                    .to_string())
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = tx.send(result);
        }
    }
}

fn handle_server_request(
    app: &HostContext,
    state: &CodexAppServerState,
    connection: &Weak<CodexConnection>,
    request_id: Value,
    method: &str,
    params: Value,
) {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            state.handle_approval_request(app, connection, request_id, method, params);
        }
        _ => {
            // Unknown server->client request: answer with a JSON-RPC error so
            // codex never blocks the turn waiting for us.
            app_cmd::log_tauri(
                app,
                &format!("[codex-app-server] unhandled server request {method}; replying with method-not-found"),
            );
            if let Some(connection) = connection.upgrade() {
                let _ = connection.send_error_response(
                    request_id,
                    -32601,
                    &format!("better_agent_terminal does not handle {method}"),
                );
            }
        }
    }
}

fn handle_notification(
    app: &HostContext,
    state: &CodexAppServerState,
    method: &str,
    params: Value,
) {
    // Account-level notifications carry no thread/session id and must be
    // handled BEFORE the session-mapping requirement below drops them.
    if method == "account/rateLimits/updated" {
        // Usage telemetry surfaces in the desktop status line only.
        #[cfg(feature = "desktop")]
        crate::claude_usage::publish_codex_usage(app.app(), &params);
        #[cfg(not(feature = "desktop"))]
        let _ = &params;
        return;
    }
    let Some(session_id) = state.session_id_for_notification(&params) else {
        if codex_debug_enabled() {
            app_cmd::log_tauri(
                app,
                &format!("[codex-app-server] notification {method} skipped: no session mapping"),
            );
        }
        return;
    };
    if let Some((turn_id, active_turn_id)) =
        state.stale_turn_notification(&session_id, method, &params)
    {
        if !is_high_frequency_delta_notification(method) {
            log_codex(
                app,
                &session_id,
                format!(
                    "notification {method} ignored for stale turn={turn_id} activeTurn={}",
                    active_turn_id.as_deref().unwrap_or("none")
                ),
            );
        }
        return;
    }
    match method {
        "thread/started" => {
            log_codex(app, &session_id, "notification thread/started");
            if let Some(thread_id) = thread_id_from_params(&params).or_else(|| {
                params
                    .get("thread")
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }) {
                state
                    .inner
                    .thread_to_session
                    .lock()
                    .expect("codex thread map lock")
                    .insert(thread_id.clone(), session_id.clone());
                if let Some(session) = state
                    .inner
                    .sessions
                    .lock()
                    .expect("codex sessions lock")
                    .get_mut(&session_id)
                {
                    session.thread_id = Some(thread_id);
                    emit(
                        app,
                        "claude:status",
                        &session_id,
                        "meta",
                        session.metadata(),
                    );
                }
            }
        }
        "turn/started" => {
            let turn_id = params
                .get("turn")
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            log_codex(
                app,
                &session_id,
                format!(
                    "notification turn/started turn={}",
                    turn_id.as_deref().unwrap_or("none")
                ),
            );
            let pending_interrupt = {
                let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
                sessions.get_mut(&session_id).and_then(|session| {
                    if session.abort_requested {
                        session.is_running = false;
                        session.active_turn_id = None;
                        session.active_turn_key = None;
                        clear_runtime_status_if_set(session);
                        return session.thread_id.clone().zip(turn_id.clone());
                    }
                    session.is_running = true;
                    clear_runtime_status_if_set(session);
                    if session.last_turn_started_at.is_none() {
                        session.num_turns += 1;
                        session.last_turn_started_at = Some(Instant::now());
                        session.last_turn_first_token_ms = None;
                        session.last_turn_duration_ms = None;
                    }
                    session.active_turn_id = turn_id.clone();
                    if turn_id.is_some() {
                        session.active_turn_key = turn_id.clone();
                    }
                    None
                })
            };
            if let Some((thread_id, turn_id)) = pending_interrupt {
                log_codex(
                    app,
                    &session_id,
                    format!("turn/started arrived after abort; interrupting turn={turn_id}"),
                );
                let interrupt_app = app.clone();
                let interrupt_state = state.clone();
                let interrupt_session_id = session_id.clone();
                std::thread::spawn(move || {
                    match interrupt_state
                        .ensure_connection(&interrupt_app)
                        .and_then(|connection| {
                            connection.request_logged(
                                &interrupt_app,
                                &interrupt_session_id,
                                "turn/interrupt",
                                json!({ "threadId": thread_id, "turnId": turn_id }),
                                REQUEST_TIMEOUT,
                            )
                        }) {
                        Ok(_) => log_codex(
                            &interrupt_app,
                            &interrupt_session_id,
                            "late turn/interrupt ok",
                        ),
                        Err(err) => log_codex(
                            &interrupt_app,
                            &interrupt_session_id,
                            format!("late turn/interrupt failed: {err}"),
                        ),
                    }
                });
            }
            if let Some(meta) = state.get_session_meta(&session_id) {
                emit(app, "claude:status", &session_id, "meta", meta);
            }
        }
        "error" => {
            log_codex(
                app,
                &session_id,
                format!("notification error params={params}"),
            );
            handle_error_notification(app, state, &session_id, &params)
        }
        "turn/completed" => {
            log_codex(
                app,
                &session_id,
                format!(
                    "notification turn/completed status={}",
                    params
                        .get("turn")
                        .and_then(|v| v.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                ),
            );
            handle_turn_completed(app, state, &session_id, &params)
        }
        "rawResponseItem/completed" => {
            if let Some(item) = params.get("item") {
                append_completed_reasoning_if_missing(app, state, &session_id, item);
            }
        }
        "thread/tokenUsage/updated" => handle_usage_updated(app, state, &session_id, &params),
        "item/started" => {
            if let Some(item) = params.get("item") {
                handle_item_started(app, state, &session_id, item);
            }
        }
        "item/completed" => {
            if let Some(item) = params.get("item") {
                handle_item_completed(app, state, &session_id, item);
            }
        }
        "item/agentMessage/delta" => {
            let delta = text_from_value(&params);
            if !delta.is_empty() {
                append_stream_delta(app, state, &session_id, "text", delta);
            }
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            let delta = text_from_value(&params);
            if !delta.is_empty() {
                append_stream_delta(app, state, &session_id, "thinking", delta);
            }
        }
        "item/commandExecution/outputDelta" => {
            handle_command_execution_output_delta(app, state, &session_id, &params);
        }
        _ => {}
    }
}

fn handle_error_notification(
    app: &HostContext,
    state: &CodexAppServerState,
    session_id: &str,
    params: &Value,
) {
    let message = params
        .get("error")
        .and_then(turn_error_message_from_value)
        .unwrap_or_else(|| "Codex turn failed.".to_string());
    state.fail_turn(app, session_id, message);
}

fn append_stream_delta(
    app: &HostContext,
    state: &CodexAppServerState,
    session_id: &str,
    key: &str,
    delta: String,
) {
    {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        if let Some(session) = sessions.get_mut(session_id) {
            if session.last_turn_first_token_ms.is_none() {
                if let Some(started_at) = session.last_turn_started_at {
                    session.last_turn_first_token_ms =
                        Some(started_at.elapsed().as_millis() as u64);
                }
            }
            if key == "text" {
                session.assistant_text.push_str(&delta);
            } else {
                session.thinking_text.push_str(&delta);
            }
            clear_runtime_status(session);
        }
    }
    emit(
        app,
        "claude:stream",
        session_id,
        "data",
        json!({ key: delta }),
    );
}

fn append_completed_reasoning_if_missing(
    app: &HostContext,
    state: &CodexAppServerState,
    session_id: &str,
    item: &Value,
) {
    let delta = reasoning_text_from_item(item);
    if delta.trim().is_empty() {
        return;
    }
    let completed_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let should_emit = {
        let sessions = state.inner.sessions.lock().expect("codex sessions lock");
        sessions
            .get(session_id)
            .map(|session| {
                let already_committed = session.messages.iter().rev().take(8).any(|message| {
                    completed_id
                        .is_some_and(|id| message.get("id").and_then(Value::as_str) == Some(id))
                });
                session.thinking_text.trim().is_empty() && !already_committed
            })
            .unwrap_or(false)
    };
    if should_emit {
        append_stream_delta(app, state, session_id, "thinking", delta);
    }
}

fn handle_command_execution_output_delta(
    app: &HostContext,
    state: &CodexAppServerState,
    session_id: &str,
    params: &Value,
) {
    let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
        return;
    };
    let delta = params
        .get("delta")
        .and_then(Value::as_str)
        .map(sanitize_terminal_output)
        .unwrap_or_default();
    if delta.is_empty() {
        return;
    }
    let result = {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        let output = session
            .command_outputs
            .entry(item_id.to_string())
            .or_default();
        output.push_str(&delta);
        let now = Instant::now();
        let should_emit = match session.command_output_last_emit.get(item_id) {
            Some(prev) => now.duration_since(*prev) >= COMMAND_OUTPUT_EMIT_INTERVAL,
            None => true,
        };
        if !should_emit {
            return;
        }
        session
            .command_output_last_emit
            .insert(item_id.to_string(), now);
        let output_snapshot = output.clone();
        update_session_tool_call(
            session,
            item_id,
            json!({
                "status": "running",
                "result": output_snapshot,
            }),
        );
        output_snapshot
    };
    emit(
        app,
        "claude:tool-result",
        session_id,
        "result",
        json!({
            "id": item_id,
            "status": "running",
            "result": result,
        }),
    );
}

fn completed_command_execution_result(
    state: &CodexAppServerState,
    session_id: &str,
    item: &Value,
) -> Option<String> {
    let item_id = item_id(item);
    let raw = item
        .get("aggregatedOutput")
        .or_else(|| item.get("result"))
        .or_else(|| item.get("error"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let accumulated = {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        sessions.get_mut(session_id).and_then(|session| {
            session.command_output_last_emit.remove(&item_id);
            session.command_outputs.remove(&item_id)
        })
    };
    raw.or(accumulated)
        .map(|value| sanitize_terminal_output(&value))
}

fn handle_item_started(
    app: &HostContext,
    state: &CodexAppServerState,
    session_id: &str,
    item: &Value,
) {
    let cleared_meta = {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        sessions.get_mut(session_id).and_then(|session| {
            if clear_runtime_status_if_set(session) {
                Some(session.metadata())
            } else {
                None
            }
        })
    };
    if let Some(meta) = cleared_meta {
        emit(app, "claude:status", session_id, "meta", meta);
    }

    match item_type(item) {
        Some("agentMessage") => {
            if let Some(session) = state
                .inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .get_mut(session_id)
            {
                session.assistant_text.clear();
            }
        }
        Some("commandExecution") => {
            let id = item_id(item);
            let tool_call = json!({
                "id": id,
                "sessionId": session_id,
                "toolName": "Bash",
                "input": { "command": item.get("command").and_then(Value::as_str).unwrap_or("") },
                "status": tool_status(item),
                "timestamp": now_millis(),
            });
            {
                let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
                if let Some(session) = sessions.get_mut(session_id) {
                    session.command_outputs.entry(id.clone()).or_default();
                    upsert_session_tool_call(session, tool_call.clone());
                }
            }
            emit(app, "claude:tool-use", session_id, "toolCall", tool_call);
        }
        Some("fileChange") => {
            let changes = item.get("changes").cloned().unwrap_or_else(|| json!([]));
            let path = item
                .get("changes")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|v| v.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let tool_call = json!({
                "id": item_id(item),
                "sessionId": session_id,
                "toolName": "Edit",
                "input": { "file_path": path, "changes": changes },
                "status": tool_status(item),
                "timestamp": now_millis(),
            });
            if let Some(session) = state
                .inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .get_mut(session_id)
            {
                upsert_session_tool_call(session, tool_call.clone());
            }
            emit(app, "claude:tool-use", session_id, "toolCall", tool_call);
        }
        Some("mcpToolCall") => {
            let name = match (
                item.get("server").and_then(Value::as_str),
                item.get("tool").and_then(Value::as_str),
            ) {
                (Some(server), Some(tool)) => format!("{server}/{tool}"),
                (_, Some(tool)) => tool.to_string(),
                _ => "MCP".to_string(),
            };
            let tool_call = json!({
                "id": item_id(item),
                "sessionId": session_id,
                "toolName": name,
                "input": item.get("arguments").cloned().unwrap_or_else(|| json!({})),
                "status": tool_status(item),
                "timestamp": now_millis(),
            });
            if let Some(session) = state
                .inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .get_mut(session_id)
            {
                upsert_session_tool_call(session, tool_call.clone());
            }
            emit(app, "claude:tool-use", session_id, "toolCall", tool_call);
        }
        Some("webSearch") => {
            let tool_call = json!({
                "id": item_id(item),
                "sessionId": session_id,
                "toolName": "WebSearch",
                "input": web_search_input(item),
                "status": "running",
                "timestamp": now_millis(),
            });
            if let Some(session) = state
                .inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .get_mut(session_id)
            {
                upsert_session_tool_call(session, tool_call.clone());
            }
            emit(app, "claude:tool-use", session_id, "toolCall", tool_call);
        }
        _ => {}
    }
}

fn handle_item_completed(
    app: &HostContext,
    state: &CodexAppServerState,
    session_id: &str,
    item: &Value,
) {
    if item_type(item) == Some("reasoning") {
        let message = {
            let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
            let Some(session) = sessions.get_mut(session_id) else {
                return;
            };
            let message = completed_reasoning_message(session_id, &mut session.thinking_text, item);
            if let Some(message) = message {
                let duplicate = session.messages.iter().any(|existing| {
                    existing.get("id").and_then(Value::as_str)
                        == message.get("id").and_then(Value::as_str)
                });
                if duplicate {
                    None
                } else {
                    push_session_item(session, message.clone());
                    Some(message)
                }
            } else {
                None
            }
        };
        if let Some(message) = message {
            emit(app, "claude:message", session_id, "message", message);
        }
        return;
    }

    if item_type(item) == Some("agentMessage") {
        let text = text_from_value(item);
        let (content, thinking) = {
            let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
            let Some(session) = sessions.get_mut(session_id) else {
                return;
            };
            let content = if text.trim().is_empty() {
                session.assistant_text.clone()
            } else {
                text
            };
            // A fallback reasoning buffer belongs only to this assistant item.
            // Taking it prevents later reasoning/tool phases in the same turn
            // from inheriting and re-emitting an already displayed summary.
            let thinking = std::mem::take(&mut session.thinking_text);
            if !content.trim().is_empty() {
                let mut msg = json!({
                    "id": format!("assistant-{}", now_millis()),
                    "sessionId": session_id,
                    "role": "assistant",
                    "content": content,
                    "timestamp": now_millis(),
                });
                if !thinking.is_empty() {
                    msg["thinking"] = json!(thinking);
                }
                session.messages.push(msg.clone());
                (Some(msg), None)
            } else {
                (None, Some(()))
            }
        };
        if let Some(msg) = content {
            emit(app, "claude:message", session_id, "message", msg);
        }
        let _ = thinking;
        return;
    }

    match item_type(item) {
        Some("commandExecution") => {
            let result = completed_command_execution_result(state, session_id, item);
            let tool_result = json!({
                "id": item_id(item),
                "status": tool_status(item),
                "result": result,
            });
            if let Some(session) = state
                .inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .get_mut(session_id)
            {
                update_session_tool_call(session, &item_id(item), tool_result.clone());
            }
            emit(app, "claude:tool-result", session_id, "result", tool_result);
        }
        Some("fileChange" | "mcpToolCall" | "webSearch") => {
            let tool_result = completed_tool_result(item);
            if let Some(session) = state
                .inner
                .sessions
                .lock()
                .expect("codex sessions lock")
                .get_mut(session_id)
            {
                update_session_tool_call(session, &item_id(item), tool_result.clone());
            }
            emit(app, "claude:tool-result", session_id, "result", tool_result);
        }
        _ => {}
    }
}

fn handle_usage_updated(
    app: &HostContext,
    state: &CodexAppServerState,
    session_id: &str,
    params: &Value,
) {
    let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
    let Some(session) = sessions.get_mut(session_id) else {
        return;
    };
    update_session_usage(session, params);
    emit(app, "claude:status", session_id, "meta", session.metadata());
}

fn update_session_usage(session: &mut CodexSession, params: &Value) {
    let usage = params
        .get("tokenUsage")
        .or_else(|| params.get("usage"))
        .unwrap_or(params);
    if let Some(v) = read_usage_u64(usage, &["inputTokens", "input_tokens", "input"]) {
        session.input_tokens = v;
    }
    if let Some(v) = read_usage_u64(usage, &["outputTokens", "output_tokens", "output"]) {
        session.output_tokens = v;
    }
    if let Some(v) = read_usage_u64(
        usage,
        &[
            "cacheReadTokens",
            "cachedInputTokens",
            "cached_input_tokens",
            "cache_read_tokens",
        ],
    ) {
        session.cache_read_tokens = v;
    }
    if let Some(v) = read_usage_u64(usage, &["modelContextWindow", "model_context_window"])
        .filter(|value| *value > 0)
    {
        session.context_window = v;
    }
}

fn read_usage_u64(usage: &Value, keys: &[&str]) -> Option<u64> {
    for key in keys {
        if let Some(value) = usage.get(*key).and_then(Value::as_u64) {
            return Some(value);
        }
    }
    for nested_key in ["total", "cumulative", "usage"] {
        if let Some(value) = usage
            .get(nested_key)
            .and_then(|nested| read_usage_u64(nested, keys))
        {
            return Some(value);
        }
    }
    None
}

fn handle_turn_completed(
    app: &HostContext,
    state: &CodexAppServerState,
    session_id: &str,
    params: &Value,
) {
    state.cancel_pending_approvals(app, session_id);
    let (reason, result, meta, error_message, turn_id, thread_id) = {
        let mut sessions = state.inner.sessions.lock().expect("codex sessions lock");
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        let turn = params.get("turn").unwrap_or(params);
        let turn_id = turn_id_from_params(params)
            .or_else(|| session.active_turn_id.clone())
            .or_else(|| turn.get("id").and_then(Value::as_str).map(str::to_string))
            .or_else(|| session.active_turn_key.clone());
        let thread_id = session.thread_id.clone();
        session.is_running = false;
        session.active_turn_id = None;
        session.active_turn_key = None;
        session.abort_requested = false;
        clear_runtime_status(session);
        cleanup_session_temp_images(session);
        session.command_outputs.clear();
        if let Some(usage) = turn.get("usage") {
            if let Some(v) = read_usage_u64(usage, &["inputTokens", "input_tokens", "input"]) {
                session.input_tokens = v;
            }
            if let Some(v) = read_usage_u64(usage, &["outputTokens", "output_tokens", "output"]) {
                session.output_tokens = v;
            }
            if let Some(v) = read_usage_u64(
                usage,
                &[
                    "cacheReadTokens",
                    "cached_input_tokens",
                    "cache_read_tokens",
                ],
            ) {
                session.cache_read_tokens = v;
            }
        }
        if let Some(started_at) = session.last_turn_started_at {
            session.last_turn_duration_ms = Some(started_at.elapsed().as_millis() as u64);
        }
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let reason = match status {
            "interrupted" => "aborted",
            "failed" => "error",
            _ => "completed",
        };
        let error_message = if reason == "error" {
            turn.get("error")
                .and_then(turn_error_message_from_value)
                .unwrap_or_else(|| "Codex turn failed.".to_string())
        } else {
            String::new()
        };
        let result = session.assistant_text.clone();
        (
            reason.to_string(),
            result,
            session.metadata(),
            error_message,
            turn_id,
            thread_id,
        )
    };
    emit(app, "claude:status", session_id, "meta", meta);
    if reason == "completed" {
        state.mark_shared_auth_valid(app, "turn-completed");
        emit(
            app,
            "claude:result",
            session_id,
            "result",
            json!({ "subtype": "success", "result": if result.is_empty() { Value::Null } else { json!(result) }, "totalCost": 0 }),
        );
    } else if reason == "error" {
        if CodexAppServerState::auth_failure_message(&error_message) {
            state.mark_shared_auth_needs_login(app, &error_message);
        }
        emit(
            app,
            "claude:error",
            session_id,
            "error",
            json!(error_message),
        );
    }
    emit(
        app,
        "claude:turn-end",
        session_id,
        "payload",
        if reason == "error" {
            json!({ "reason": reason, "error": error_message, "turnId": turn_id, "sdkSessionId": thread_id })
        } else {
            json!({ "reason": reason, "result": result, "turnId": turn_id, "sdkSessionId": thread_id })
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn device_login_parser_extracts_url_and_code() {
        // Exact ANSI-coloured lines emitted by `codex login --device-auth`
        // (captured from codex 0.142.4): blue (94m) URL + code, gray (90m) hints.
        let lines = [
            "\u{1b}[90mOpenAI's command-line coding agent\u{1b}[0m",
            "Follow these steps to sign in with ChatGPT using device code authorization:",
            "1. Open this link in your browser and sign in to your account",
            "   \u{1b}[94mhttps://auth.openai.com/codex/device\u{1b}[0m",
            "2. Enter this one-time code \u{1b}[90m(expires in 15 minutes)\u{1b}[0m",
            "   \u{1b}[94mG0GT-244PL\u{1b}[0m",
        ];
        let mut cap = DeviceCapture::default();
        for line in lines {
            ingest_device_line(&mut cap, line);
        }
        assert_eq!(
            cap.url.as_deref(),
            Some("https://auth.openai.com/codex/device")
        );
        assert_eq!(cap.code.as_deref(), Some("G0GT-244PL"));
    }

    #[test]
    fn device_code_pattern_is_strict() {
        assert!(is_device_code("G0GT-244PL"));
        assert!(is_device_code("ABCD-EFGHI"));
        assert!(!is_device_code("expires in 15 minutes"));
        assert!(!is_device_code("https://auth.openai.com/codex/device"));
        assert!(!is_device_code("one-time-code"));
        assert!(!is_device_code("plain"));
    }

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(strip_ansi("\u{1b}[94mhello\u{1b}[0m"), "hello");
        assert_eq!(strip_ansi("no codes"), "no codes");
    }

    #[test]
    fn app_server_sandbox_uses_protocol_values() {
        assert_eq!(app_server_sandbox("read-only"), "read-only");
        assert_eq!(app_server_sandbox("workspace-write"), "workspace-write");
        assert_eq!(
            app_server_sandbox("danger-full-access"),
            "danger-full-access"
        );
    }

    #[test]
    fn codex_worktree_preset_routes_to_rust_runtime() {
        assert!(should_handle_codex(&Some(json!({
            "agentPreset": "codex-agent",
            "cwd": "/repo"
        }))));
        assert!(should_handle_codex(&Some(json!({
            "agentPreset": "codex-agent-worktree",
            "cwd": "/repo",
            "useWorktree": true
        }))));
        assert!(should_handle_codex(&Some(json!({
            "agentPreset": "codex-agent-worktree",
            "cwd": "/repo",
            "useWorktree": true,
            "worktreePath": "/repo/.bat-worktrees/abc12345"
        }))));
    }

    #[test]
    fn codex_worktree_uses_worktree_path_as_effective_cwd() {
        let options = json!({
            "agentPreset": "codex-agent-worktree",
            "cwd": "/repo",
            "useWorktree": true,
            "worktreePath": "/repo/.bat-worktrees/abc12345"
        });
        assert_eq!(
            effective_cwd(&options, "test").expect("cwd"),
            "/repo/.bat-worktrees/abc12345"
        );
    }

    #[test]
    fn supported_models_returns_codex_models_not_claude_models() {
        let state = CodexAppServerState::default();
        let models = state.supported_models();
        let values = models
            .as_array()
            .expect("models")
            .iter()
            .filter_map(|model| model.get("value").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(values.contains(&"gpt-5.6-sol"));
        assert!(values.contains(&"gpt-5.5"));
        assert!(values.contains(&"gpt-5.3-codex"));
        assert!(!values.iter().any(|value| value.starts_with("claude-")));
    }

    #[test]
    fn codex_turn_input_converts_data_url_images_to_local_image_items() {
        let (input, temp_images) = build_turn_input(
            "describe this",
            vec!["data:image/png;base64,aGVsbG8=".to_string()],
        )
        .expect("turn input");
        let items = input.as_array().expect("input items");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["type"], "localImage");
        let path = items[0]["path"].as_str().expect("image path").to_string();
        assert!(Path::new(&path).is_file());
        assert_eq!(
            items[1],
            json!({ "type": "text", "text": "describe this", "text_elements": [] })
        );
        cleanup_temp_images(temp_images);
        assert!(!Path::new(&path).exists());
    }

    #[test]
    fn codex_turn_input_uses_protocol_url_field_for_remote_images() {
        let (input, temp_images) = build_turn_input(
            "describe this",
            vec!["https://example.com/screenshot.png".to_string()],
        )
        .expect("turn input");
        assert!(temp_images.is_empty());
        let items = input.as_array().expect("input items");
        assert_eq!(
            items[0],
            json!({ "type": "image", "url": "https://example.com/screenshot.png" })
        );
    }

    #[test]
    fn codex_turn_start_params_request_reasoning_summary() {
        let params = build_turn_start_params(
            "thread-1",
            json!([{ "type": "text", "text": "hello", "text_elements": [] }]),
            "gpt-5.6-sol",
            "max",
            "on-request",
            "workspace-write",
        );
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["model"], "gpt-5.6-sol");
        assert_eq!(params["effort"], "max");
        assert_eq!(params["summary"], DEFAULT_CODEX_REASONING_SUMMARY);
        assert!(params.get("reasoningEffort").is_none());
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["sandboxPolicy"], json!({ "type": "workspaceWrite" }));
    }

    #[test]
    fn codex_effort_normalization_preserves_all_supported_tiers() {
        for effort in ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] {
            assert_eq!(normalize_effort(Some(effort)), effort);
        }
        assert_eq!(normalize_effort(None), "high");
        assert_eq!(normalize_effort(Some("invalid")), "high");
    }

    #[test]
    fn codex_turn_start_sandbox_policy_uses_tagged_protocol_values() {
        assert_eq!(
            app_server_sandbox_policy("read-only"),
            json!({ "type": "readOnly" })
        );
        assert_eq!(
            app_server_sandbox_policy("danger-full-access"),
            json!({ "type": "dangerFullAccess" })
        );
        assert_eq!(
            app_server_sandbox_policy("anything-else"),
            json!({ "type": "workspaceWrite" })
        );
    }

    #[test]
    fn codex_thread_resume_params_preserve_runtime_options() {
        let params = build_thread_resume_params(
            "thread-1",
            "gpt-5.5",
            "/repo",
            "never",
            "danger-full-access",
        );
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["model"], "gpt-5.5");
        assert_eq!(params["cwd"], "/repo");
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(params["sandbox"], "danger-full-access");
        assert_eq!(params["serviceName"], "better_agent_terminal");
    }

    #[test]
    fn codex_thread_not_found_detector_matches_protocol_errors() {
        assert!(is_thread_not_found_error(
            "thread not found: 019e1bfc-e8f6-77e1-9886-1833ce991217"
        ));
        assert!(is_thread_not_found_error(
            "Codex error: Thread 019e1bfc not found"
        ));
        assert!(!is_thread_not_found_error(
            "turn failed: rate limit exceeded"
        ));
    }

    #[test]
    fn codex_interrupt_error_extracts_found_active_turn() {
        assert_eq!(
            found_active_turn_from_interrupt_error(
                "expected active turn id old-turn but found 019e5e58-d5ed-7bd1-8e8a-a6e3d2b836b7"
            )
            .as_deref(),
            Some("019e5e58-d5ed-7bd1-8e8a-a6e3d2b836b7")
        );
        assert_eq!(
            found_active_turn_from_interrupt_error("turn already completed"),
            None
        );
        assert_eq!(
            found_active_turn_from_interrupt_error(
                "expected active turn id old-turn but found none"
            ),
            None
        );
    }

    #[test]
    fn codex_interrupt_error_detects_no_active_turn() {
        assert!(is_no_active_turn_interrupt_error(
            "no active turn to interrupt"
        ));
        assert!(is_no_active_turn_interrupt_error(
            "expected active turn id old-turn but found none"
        ));
        assert!(!is_no_active_turn_interrupt_error(
            "expected active turn id old-turn but found new-turn"
        ));
        assert!(!is_no_active_turn_interrupt_error(
            "request timed out while interrupting turn"
        ));
    }

    #[test]
    fn codex_reasoning_text_prefers_summary() {
        let text = reasoning_text_from_item(&json!({
            "type": "reasoning",
            "summary": [{ "type": "summary_text", "text": "summary text" }],
            "content": [{ "type": "reasoning_text", "text": "raw reasoning text" }],
            "encrypted_content": null,
        }));
        assert_eq!(text, "summary text");
    }

    #[test]
    fn codex_reasoning_text_reads_thread_item_content_fallback() {
        let text = reasoning_text_from_item(&json!({
            "type": "reasoning",
            "id": "reasoning-1",
            "summary": [],
            "content": ["fallback reasoning text"],
        }));
        assert_eq!(text, "fallback reasoning text");
    }

    #[test]
    fn codex_completed_reasoning_becomes_a_timeline_message() {
        let mut streaming = "partial streamed summary".to_string();
        let message = completed_reasoning_message(
            "session-1",
            &mut streaming,
            &json!({
                "type": "reasoning",
                "id": "reasoning-1",
                "summary": [{ "type": "summary_text", "text": "authoritative summary" }],
            }),
        )
        .expect("reasoning message");

        assert!(streaming.is_empty());
        assert_eq!(message["id"], "reasoning-1");
        assert_eq!(message["sessionId"], "session-1");
        assert_eq!(message["role"], "assistant");
        assert_eq!(message["content"], "");
        assert_eq!(message["thinking"], "authoritative summary");
    }

    #[test]
    fn codex_completed_reasoning_falls_back_to_streamed_summary() {
        let mut streaming = "streamed summary".to_string();
        let message = completed_reasoning_message(
            "session-1",
            &mut streaming,
            &json!({ "type": "reasoning", "id": "reasoning-1", "summary": [] }),
        )
        .expect("reasoning message");

        assert!(streaming.is_empty());
        assert_eq!(message["thinking"], "streamed summary");
    }

    #[test]
    fn codex_terminal_output_sanitizer_removes_control_codes() {
        let output = sanitize_terminal_output(
            "vite build\u{1b}[2K\rtransforming...\n\u{1b}[32m✓\u{1b}[0m done",
        );
        assert_eq!(output, "vite build\ntransforming...\n✓ done");
    }

    #[test]
    fn codex_path_dir_detects_packaged_runtime_tools() {
        let root = env::temp_dir().join(format!(
            "bat-codex-runtime-path-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let runtime = root.join("codex-runtime");
        let path_dir = runtime.join("path");
        fs::create_dir_all(&path_dir).expect("create codex path dir");
        let binary = runtime.join(codex_exe_name());
        fs::write(&binary, "").expect("write fake codex binary");

        assert_eq!(
            codex_path_dir_for_binary(&binary).as_deref(),
            Some(path_dir.as_path())
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn codex_path_dir_detects_package_layout_runtime_tools() {
        let root = env::temp_dir().join(format!(
            "bat-codex-package-layout-path-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let runtime = root.join("codex-runtime");
        let bin_dir = runtime.join("bin");
        let path_dir = runtime.join("codex-path");
        fs::create_dir_all(&bin_dir).expect("create codex bin dir");
        fs::create_dir_all(&path_dir).expect("create codex-path dir");
        let binary = bin_dir.join(codex_exe_name());
        fs::write(&binary, "").expect("write fake codex binary");

        assert_eq!(
            codex_path_dir_for_binary(&binary).as_deref(),
            Some(path_dir.as_path())
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn codex_path_dir_detects_vendor_runtime_tools() {
        let root = env::temp_dir().join(format!(
            "bat-codex-vendor-path-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let triple = root.join("vendor").join("x86_64-pc-windows-msvc");
        let codex_dir = triple.join("codex");
        let path_dir = triple.join("path");
        fs::create_dir_all(&codex_dir).expect("create codex dir");
        fs::create_dir_all(&path_dir).expect("create codex path dir");
        let binary = codex_dir.join(codex_exe_name());
        fs::write(&binary, "").expect("write fake codex binary");

        assert_eq!(
            codex_path_dir_for_binary(&binary).as_deref(),
            Some(path_dir.as_path())
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn codex_augmented_path_prepends_runtime_tools() {
        let root = env::temp_dir().join(format!(
            "bat-codex-augmented-path-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let path_dir = root.join("path");
        fs::create_dir_all(&path_dir).expect("create path dir");

        let path = augmented_path_with_runtime_dirs(&[path_dir.clone()]).expect("augmented PATH");
        let first = std::env::split_paths(&path).next();

        assert_eq!(first.as_deref(), Some(path_dir.as_path()));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn codex_web_search_input_reads_nested_action_query() {
        let input = web_search_input(&json!({
            "type": "webSearch",
            "id": "ws_1",
            "query": "",
            "action": {
                "type": "search",
                "query": "tauri nsis PageReinstall",
                "queries": ["tauri nsis PageReinstall"]
            }
        }));
        assert_eq!(input, json!({ "query": "tauri nsis PageReinstall" }));
    }

    #[test]
    fn codex_web_search_input_falls_back_to_query_list() {
        let input = web_search_input(&json!({
            "type": "webSearch",
            "id": "ws_1",
            "action": {
                "type": "search",
                "queries": ["codex app-server webSearch event shape"]
            }
        }));
        assert_eq!(
            input,
            json!({ "query": "codex app-server webSearch event shape" })
        );
    }

    #[test]
    fn codex_web_search_input_reads_open_page_url() {
        let input = web_search_input(&json!({
            "type": "webSearch",
            "id": "ws_1",
            "action": {
                "type": "open_page",
                "url": "https://tauri.app/distribute/windows-installer/"
            }
        }));
        assert_eq!(
            input,
            json!({ "url": "https://tauri.app/distribute/windows-installer/" })
        );
    }

    #[test]
    fn codex_metadata_includes_context_window() {
        let session = CodexSession {
            session_id: "s-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            cwd: "/repo".to_string(),
            model: "gpt-5.6-sol".to_string(),
            sandbox_mode: "workspace-write".to_string(),
            approval_policy: "on-request".to_string(),
            effort: "high".to_string(),
            context_window: codex_context_window_for_model("gpt-5.6-sol"),
            start_time: Instant::now(),
            active_turn_id: None,
            active_turn_key: None,
            assistant_text: String::new(),
            thinking_text: String::new(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 25,
            num_turns: 1,
            last_turn_started_at: None,
            last_turn_first_token_ms: None,
            last_turn_duration_ms: None,
            messages: Vec::new(),
            temporary_image_paths: Vec::new(),
            command_outputs: HashMap::new(),
            command_output_last_emit: HashMap::new(),
            runtime_status: None,
            runtime_message: None,
            runtime_status_started_at: None,
            is_running: false,
            is_resting: false,
            abort_requested: false,
            ignored_turn_ids: Vec::new(),
        };

        let meta = session.metadata();
        assert_eq!(meta["contextWindow"], GPT_5_6_CONTEXT_WINDOW_FALLBACK);
        assert_eq!(meta["contextTokens"], 150);
    }

    #[test]
    fn codex_runtime_status_clear_reports_only_when_status_was_set() {
        let mut session = CodexSession {
            session_id: "s-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            cwd: "/repo".to_string(),
            model: "gpt-5.5".to_string(),
            sandbox_mode: "workspace-write".to_string(),
            approval_policy: "on-request".to_string(),
            effort: "high".to_string(),
            context_window: DEFAULT_CODEX_CONTEXT_WINDOW,
            start_time: Instant::now(),
            active_turn_id: None,
            active_turn_key: None,
            assistant_text: String::new(),
            thinking_text: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            num_turns: 0,
            last_turn_started_at: None,
            last_turn_first_token_ms: None,
            last_turn_duration_ms: None,
            messages: Vec::new(),
            temporary_image_paths: Vec::new(),
            command_outputs: HashMap::new(),
            command_output_last_emit: HashMap::new(),
            runtime_status: None,
            runtime_message: None,
            runtime_status_started_at: None,
            is_running: false,
            is_resting: false,
            abort_requested: false,
            ignored_turn_ids: Vec::new(),
        };

        assert!(!clear_runtime_status_if_set(&mut session));
        set_runtime_status(
            &mut session,
            "waiting_for_api",
            "Still waiting for Codex API response.",
        );
        assert!(clear_runtime_status_if_set(&mut session));
        assert_eq!(session.runtime_status, None);
        assert_eq!(session.runtime_message, None);
        assert_eq!(session.runtime_status_started_at, None);
        assert!(!clear_runtime_status_if_set(&mut session));
    }

    #[test]
    fn codex_context_usage_uses_app_server_usage_shape() {
        let state = CodexAppServerState::default();
        let mut session = CodexSession {
            session_id: "s-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            cwd: "/repo".to_string(),
            model: "gpt-5.6-sol".to_string(),
            sandbox_mode: "workspace-write".to_string(),
            approval_policy: "on-request".to_string(),
            effort: "high".to_string(),
            context_window: DEFAULT_CODEX_CONTEXT_WINDOW,
            start_time: Instant::now(),
            active_turn_id: None,
            active_turn_key: None,
            assistant_text: String::new(),
            thinking_text: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            num_turns: 1,
            last_turn_started_at: None,
            last_turn_first_token_ms: None,
            last_turn_duration_ms: None,
            messages: Vec::new(),
            temporary_image_paths: Vec::new(),
            command_outputs: HashMap::new(),
            command_output_last_emit: HashMap::new(),
            runtime_status: None,
            runtime_message: None,
            runtime_status_started_at: None,
            is_running: false,
            is_resting: false,
            abort_requested: false,
            ignored_turn_ids: Vec::new(),
        };
        update_session_usage(
            &mut session,
            &json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "tokenUsage": {
                    "modelContextWindow": 353_400,
                    "last": {
                        "inputTokens": 25,
                        "cachedInputTokens": 5,
                        "outputTokens": 10,
                        "reasoningOutputTokens": 2,
                        "totalTokens": 35
                    },
                    "total": {
                        "inputTokens": 150,
                        "cachedInputTokens": 100,
                        "outputTokens": 30,
                        "reasoningOutputTokens": 10,
                        "totalTokens": 180
                    }
                }
            }),
        );
        state
            .inner
            .sessions
            .lock()
            .expect("codex sessions lock")
            .insert("s-1".to_string(), session);

        let usage = state.get_context_usage("s-1").expect("usage");
        assert_eq!(usage["totalTokens"], 180);
        assert_eq!(usage["maxTokens"], 353_400);
        assert_eq!(usage["percentage"], 0);
        assert_eq!(usage["model"], "gpt-5.6-sol");
        assert_eq!(usage["apiUsage"]["input_tokens"], 150);
        assert_eq!(usage["apiUsage"]["output_tokens"], 30);
        assert_eq!(usage["apiUsage"]["cache_read_input_tokens"], 100);
        assert_eq!(usage["categories"][0]["name"], "Context");
        assert_eq!(state.get_context_usage("missing"), None);
    }

    #[test]
    fn codex_history_loader_reads_user_and_assistant_messages() {
        let content = r#"
{"timestamp":"2026-05-11T00:00:00Z","type":"session_meta","payload":{"id":"thread-1"}}
{"timestamp":"2026-05-11T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"ping"}}
{"timestamp":"2026-05-11T00:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"pong"}}
{"timestamp":"2026-05-11T00:00:03Z","type":"event_msg","payload":{"type":"other","message":"ignored"}}
"#;
        let items = codex_history_items_from_content("s-1", content);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["sessionId"], "s-1");
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[0]["content"], "ping");
        assert_eq!(items[0]["timestamp"].as_u64(), Some(1_778_457_601_000));
        assert_eq!(items[1]["role"], "assistant");
        assert_eq!(items[1]["content"], "pong");
        assert_eq!(items[1]["timestamp"].as_u64(), Some(1_778_457_602_000));
    }

    #[test]
    fn codex_history_loader_reads_tool_calls() {
        let content = r#"
{"timestamp":"2026-05-11T00:00:00Z","type":"session_meta","payload":{"id":"thread-1"}}
{"timestamp":"2026-05-11T00:00:01Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"ls -la\",\"workdir\":\"/tmp\"}","call_id":"call-1"}}
{"timestamp":"2026-05-11T00:00:02Z","type":"event_msg","payload":{"type":"exec_command_end","call_id":"call-1","command":["/bin/zsh","-lc","ls -la"],"aggregated_output":"total 0","exit_code":0,"status":"completed"}}
{"timestamp":"2026-05-11T00:00:03Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch","call_id":"call-2"}}
{"timestamp":"2026-05-11T00:00:04Z","type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call-2","stdout":"Success","success":true,"status":"completed"}}
"#;
        let items = codex_history_items_from_content("s-1", content);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], "call-1");
        assert_eq!(items[0]["sessionId"], "s-1");
        assert_eq!(items[0]["toolName"], "Bash");
        assert_eq!(items[0]["input"]["command"], "ls -la");
        assert_eq!(items[0]["status"], "completed");
        assert_eq!(items[0]["result"], "total 0");
        assert_eq!(items[1]["id"], "call-2");
        assert_eq!(items[1]["toolName"], "apply_patch");
        assert_eq!(items[1]["input"]["input"], "*** Begin Patch");
        assert_eq!(items[1]["result"], "Success");
    }

    #[test]
    fn codex_history_loader_preserves_reasoning_around_tools() {
        let content = r#"
{"timestamp":"2026-05-11T00:00:01Z","type":"response_item","payload":{"type":"reasoning","id":"reasoning-1","summary":[{"type":"summary_text","text":"inspect first"}]}}
{"timestamp":"2026-05-11T00:00:02Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"git status\"}","call_id":"call-1"}}
{"timestamp":"2026-05-11T00:00:03Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"clean"}}
{"timestamp":"2026-05-11T00:00:04Z","type":"response_item","payload":{"type":"reasoning","id":"reasoning-2","summary":[{"type":"summary_text","text":"verify next"}]}}
"#;
        let items = codex_history_items_from_content("s-1", content);

        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["id"], "reasoning-1");
        assert_eq!(items[0]["thinking"], "inspect first");
        assert_eq!(items[1]["id"], "call-1");
        assert_eq!(items[1]["toolName"], "Bash");
        assert_eq!(items[1]["status"], "completed");
        assert_eq!(items[2]["id"], "reasoning-2");
        assert_eq!(items[2]["thinking"], "verify next");
    }

    #[test]
    fn codex_item_id_falls_back_to_call_id() {
        assert_eq!(item_id(&json!({"call_id": "ws-full-id"})), "ws-full-id");
    }

    #[test]
    fn codex_completed_web_search_result_normalizes_status_and_input() {
        let search_result = completed_tool_result(&json!({
            "type": "webSearch",
            "call_id": "ws-search",
            "query": "IDEXX InterLink integration",
            "action": {
                "type": "search",
                "queries": ["IDEXX InterLink integration"]
            }
        }));

        assert_eq!(search_result["id"], "ws-search");
        assert_eq!(search_result["status"], "completed");
        assert_eq!(
            search_result["input"],
            json!({"query": "IDEXX InterLink integration"})
        );
        assert!(search_result["result"].is_null());

        let open_result = completed_tool_result(&json!({
            "type": "webSearch",
            "call_id": "ws-open",
            "action": {
                "type": "open_page",
                "url": "https://example.com/report.pdf"
            }
        }));

        assert_eq!(open_result["id"], "ws-open");
        assert_eq!(open_result["status"], "completed");
        assert_eq!(
            open_result["input"],
            json!({"url": "https://example.com/report.pdf"})
        );
    }

    #[test]
    fn codex_history_loader_normalizes_web_search_end_input() {
        let content = r#"
{"timestamp":"2026-05-11T00:00:00Z","type":"session_meta","payload":{"id":"thread-1"}}
{"timestamp":"2026-05-11T00:00:01Z","type":"event_msg","payload":{"type":"web_search_end","call_id":"ws-1","query":"IDEXX InterLink integration","action":{"type":"search","queries":["IDEXX InterLink integration"]}}}
"#;

        let items = codex_history_items_from_content("s-1", content);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "ws-1");
        assert_eq!(items[0]["sessionId"], "s-1");
        assert_eq!(items[0]["toolName"], "WebSearch");
        assert_eq!(
            items[0]["input"],
            json!({"query": "IDEXX InterLink integration"})
        );
        assert_eq!(items[0]["status"], "completed");
    }

    #[test]
    fn codex_history_timestamp_parser_handles_fractional_and_offsets() {
        assert_eq!(
            parse_rfc3339_timestamp_millis("2026-05-11T00:00:02.123Z"),
            Some(1_778_457_602_123)
        );
        assert_eq!(
            parse_rfc3339_timestamp_millis("2026-05-11T08:00:02+08:00"),
            Some(1_778_457_602_000)
        );
        assert_eq!(parse_rfc3339_timestamp_millis("not-a-time"), None);
    }

    #[test]
    fn codex_session_log_prefers_session_meta_over_path_match() {
        let root = env::temp_dir().join(format!(
            "bat-codex-log-test-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create temp codex session dir");

        let path_only_match = root.join("thread-1-stale.jsonl");
        fs::write(
            &path_only_match,
            r#"{"type":"session_meta","payload":{"id":"different-thread"}}"#,
        )
        .expect("write path-only match");

        let exact_match = nested.join("session.jsonl");
        fs::write(
            &exact_match,
            r#"{"type":"session_meta","payload":{"id":"thread-1"}}"#,
        )
        .expect("write exact match");

        let found = find_codex_session_log(&root, "thread-1").expect("find session log");
        assert_eq!(found, exact_match);

        fs::remove_dir_all(root).ok();
    }
}
