// JSON-RPC bridge to the Node sidecar.
//
// Spawns `node node-sidecar/dist/server.mjs` lazily on first call, sends
// requests as line-delimited JSON over stdin, reads replies as
// line-delimited JSON over stdout, and correlates by id. Server-pushed
// events (id-less messages with method "event:foo") fan out to subscribers.
//
// We deliberately do NOT use tokio process here — std::process + std::thread
// match the rest of the Rust side (PTY, etc.) and avoid pulling tokio's
// process feature into the bundle. Each request blocks the calling thread
// on a std::sync::mpsc channel with a generous timeout. Tauri commands
// invoking the bridge run on the async runtime's worker pool, so blocking
// for a few hundred ms is fine.
//
// If the sidecar dies, the next call detects the exit and respawns it.
// Repeated fast exits are rate-limited with a short backoff so a broken
// packaged sidecar cannot create an unbounded spawn loop.

#[cfg(feature = "desktop")]
use crate::event_hub::publish_runtime_event;
use crate::log_file::append_line;
use crate::subprocess::hide_console_window;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
// AppHandle is only needed by the desktop-backed spawn-config / emit-sink
// helpers below; the sidecar bridge itself (SidecarState, spawn, call) is
// tauri-free and compiles into the headless build.
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};

// Cap stderr tail buffer at this many lines. Enough to capture a typical
// Node startup error trace (import failure, syntax error, etc.) while
// keeping memory bounded if something starts spamming stderr.
const STDERR_TAIL_LIMIT: usize = 100;
const RESTART_BACKOFF_WINDOW: Duration = Duration::from_secs(30);
const RESTART_BACKOFF_LIMIT: usize = 3;
const RESTART_BACKOFF_DURATION: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SidecarLaunchMode {
    // Constructed only on non-Windows at runtime (and in tests), but referenced
    // by `as_str` and the spawn-log test on all platforms — keep it defined.
    #[cfg_attr(windows, allow(dead_code))]
    DirectScriptArg,
    #[cfg(windows)]
    WindowsEvalBootstrap,
}

impl SidecarLaunchMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::DirectScriptArg => "direct-script-arg",
            #[cfg(windows)]
            Self::WindowsEvalBootstrap => "windows-eval-bootstrap",
        }
    }
}

// Avoid launching the sidecar with cwd `/` (the default when a macOS .app is
// started from Finder). Falls back to None when no usable home dir is found,
// in which case the spawn keeps the parent's cwd unchanged.
fn safe_default_cwd() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

#[derive(Debug, Serialize)]
pub struct BridgeError {
    pub message: String,
}

impl<E: std::fmt::Display> From<E> for BridgeError {
    fn from(e: E) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

// Per-pending-request reply slot. Reader thread looks up by id and sends
// the parsed result here; the calling thread blocks on the matching
// Receiver with a timeout.
type ReplySender = Sender<Result<Value, String>>;

#[derive(Default)]
struct PendingTable {
    inner: Mutex<HashMap<u64, ReplySender>>,
}

impl PendingTable {
    fn insert(&self, id: u64, tx: ReplySender) {
        self.inner.lock().expect("pending lock").insert(id, tx);
    }
    fn take(&self, id: u64) -> Option<ReplySender> {
        self.inner.lock().expect("pending lock").remove(&id)
    }
    fn drain_all(&self) -> Vec<ReplySender> {
        let mut guard = self.inner.lock().expect("pending lock");
        guard.drain().map(|(_, tx)| tx).collect()
    }
}

// One spawned sidecar process plus the plumbing to talk to it.
struct SidecarHandle {
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Arc<PendingTable>,
    // We hold the Child here so dropping the bridge kills the sidecar.
    // The reader thread joins automatically when stdout closes (= child exits).
    child: Mutex<Child>,
    // Last STDERR_TAIL_LIMIT lines emitted by the sidecar's stderr,
    // captured by a reader thread. Surfaced in error messages when the
    // child exits unexpectedly so users see Node's own error trace
    // (e.g. "Cannot find module '@anthropic-ai/claude-agent-sdk'")
    // instead of an opaque "child exited" / Win32 ERROR_NO_DATA.
    // We hold an Arc here so the field outlives the spawn closures;
    // the working clones live in the stderr / stdout reader threads.
    #[allow(dead_code)]
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

fn snapshot_stderr_tail(tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    let guard = tail.lock().expect("stderr tail lock");
    if guard.is_empty() {
        return String::new();
    }
    let joined: Vec<String> = guard.iter().cloned().collect();
    joined.join("\n")
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn format_sidecar_log_line(line: &str) -> String {
    format!("{} [stderr] {}\n", timestamp_millis(), line)
}

fn format_sidecar_spawn_log_line(
    node_path: &Path,
    script_path: &Path,
    cwd: Option<&Path>,
    mode: SidecarLaunchMode,
) -> String {
    let cwd = cwd
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "<inherit>".into());
    format!(
        "{} [spawn] node={} script={} cwd={} mode={}\n",
        timestamp_millis(),
        node_path.display(),
        script_path.display(),
        cwd,
        mode.as_str(),
    )
}

// Sidecar deaths used to be silent — the log showed only the NEXT [spawn],
// making "why did it die?" unanswerable. Two complementary markers fix that:
// the stderr reader logs [exit] the moment the pipe closes (real-time, no
// status), and ensure_spawned logs the harvested exit status when it finds
// the previous child dead at respawn time.
fn format_sidecar_exit_log_line(detail: &str) -> String {
    format!("{} [exit] {}\n", timestamp_millis(), detail)
}

#[cfg(windows)]
fn windows_sidecar_eval_bootstrap() -> &'static str {
    r#"
const { pathToFileURL } = await import('node:url');
const entry = process.env.BAT_SIDECAR_ENTRY_PATH;
if (!entry || !entry.trim()) {
  throw new Error('BAT_SIDECAR_ENTRY_PATH is required');
}
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
"#
}

fn configure_sidecar_entry(command: &mut Command, script_path: &Path) -> SidecarLaunchMode {
    #[cfg(windows)]
    {
        // Avoid passing an absolute C:\... path as Node's argv[1]. Some
        // Windows launch paths can still mangle that script argument into a
        // bare drive prefix ("C:"), causing Node to fail during resolveMainPath.
        // The env var is not parsed as part of the child command line, and the
        // bootstrap restores process.argv[1] before importing the real entry so
        // server.mjs still detects itself as the main module.
        command
            .arg("--input-type=module")
            .arg("--eval")
            .arg(windows_sidecar_eval_bootstrap())
            .env("BAT_SIDECAR_ENTRY_PATH", script_path);
        SidecarLaunchMode::WindowsEvalBootstrap
    }
    #[cfg(not(windows))]
    {
        command.arg(script_path);
        SidecarLaunchMode::DirectScriptArg
    }
}

impl SidecarHandle {
    fn alloc_id(&self) -> u64 {
        // Start at 1 so 0 is reserved for "uninitialised" if it ever leaks.
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }
}

#[derive(Default)]
struct RestartBackoff {
    failures: VecDeque<Instant>,
    blocked_until: Option<Instant>,
}

impl RestartBackoff {
    fn prune(&mut self, now: Instant) {
        while self
            .failures
            .front()
            .map(|t| now.duration_since(*t) > RESTART_BACKOFF_WINDOW)
            .unwrap_or(false)
        {
            self.failures.pop_front();
        }
    }

    fn remaining_block(&mut self, now: Instant) -> Option<Duration> {
        match self.blocked_until {
            Some(until) if until > now => Some(until.duration_since(now)),
            Some(_) => {
                self.blocked_until = None;
                None
            }
            None => None,
        }
    }

    fn record_failure(&mut self, now: Instant) {
        self.prune(now);
        self.failures.push_back(now);
        if self.failures.len() >= RESTART_BACKOFF_LIMIT {
            self.failures.clear();
            self.blocked_until = Some(now + RESTART_BACKOFF_DURATION);
        }
    }

    #[cfg(test)]
    fn clear(&mut self) {
        self.failures.clear();
        self.blocked_until = None;
    }
}

#[derive(Default, Clone)]
pub struct SidecarState {
    inner: Arc<Mutex<Option<Arc<SidecarHandle>>>>,
    restart_backoff: Arc<Mutex<RestartBackoff>>,
}

// Public spawn config. Passed in from the Tauri-side resolver so tests can
// inject any node + script path, while production code builds it from
// app handle paths.
pub struct SpawnConfig {
    pub node_path: PathBuf,
    pub script_path: PathBuf,
    /// Optional app data directory. When set, the sidecar receives it via
    /// the `BAT_SIDECAR_DATA_DIR` env var so file-backed handlers
    /// (claude.accountList, snippets-by-sidecar, etc.) read/write to the
    /// same on-disk location as the Rust host.
    pub data_dir: Option<PathBuf>,
    /// Extra environment variables for the sidecar process. Tests use
    /// this to set `BAT_SIDECAR_DISABLE_SDK=1` and force deterministic
    /// stub behaviour for claude.sendMessage; production leaves it empty.
    pub extra_env: Vec<(String, String)>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure_spawned(
        &self,
        cfg: &SpawnConfig,
        emit: Option<EventSink>,
    ) -> Result<Arc<SidecarHandle>, BridgeError> {
        let mut guard = self.inner.lock().expect("sidecar lock");
        if let Some(h) = guard.as_ref() {
            // Confirm the child is still alive. If it exited, drop and respawn.
            let mut child_guard = h.child.lock().expect("child lock");
            match child_guard.try_wait() {
                Ok(Some(status)) => {
                    // Exited. Record the harvested status, then fall through
                    // to respawn.
                    drop(child_guard);
                    if let Some(dir) = &cfg.data_dir {
                        let _ = append_line(
                            &dir.join("logs").join("sidecar.log"),
                            &format_sidecar_exit_log_line(&format!(
                                "previous sidecar found dead at respawn: status={status}"
                            )),
                        );
                    }
                    *guard = None;
                    self.record_restart_failure();
                }
                Ok(None) => {
                    // Still alive — return existing handle.
                    drop(child_guard);
                    return Ok(Arc::clone(h));
                }
                Err(err) => {
                    drop(child_guard);
                    if let Some(dir) = &cfg.data_dir {
                        let _ = append_line(
                            &dir.join("logs").join("sidecar.log"),
                            &format_sidecar_exit_log_line(&format!(
                                "previous sidecar unreachable at respawn: try_wait error={err}"
                            )),
                        );
                    }
                    *guard = None;
                    self.record_restart_failure();
                }
            }
        }
        if let Some(remaining) = self.restart_backoff_remaining() {
            return Err(BridgeError {
                message: format!(
                    "sidecar: restart backoff active for {}ms after repeated exits",
                    remaining.as_millis()
                ),
            });
        }
        let handle = match spawn_sidecar(cfg, emit) {
            Ok(handle) => handle,
            Err(err) => {
                self.record_restart_failure();
                return Err(err);
            }
        };
        let arc = Arc::new(handle);
        *guard = Some(Arc::clone(&arc));
        Ok(arc)
    }

    fn restart_backoff_remaining(&self) -> Option<Duration> {
        self.restart_backoff
            .lock()
            .expect("restart backoff lock")
            .remaining_block(Instant::now())
    }

    fn record_restart_failure(&self) {
        self.restart_backoff
            .lock()
            .expect("restart backoff lock")
            .record_failure(Instant::now());
    }

    #[cfg(test)]
    pub fn call(
        &self,
        cfg: &SpawnConfig,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        self.call_with_emit(cfg, None, method, params, timeout)
    }

    pub fn call_with_emit(
        &self,
        cfg: &SpawnConfig,
        emit: Option<EventSink>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let ensure_started = Instant::now();
        let handle = match self.ensure_spawned(cfg, emit.clone()) {
            Ok(handle) => {
                emit_sidecar_metric(
                    &emit,
                    "ensureSpawned",
                    Some(method),
                    ensure_started.elapsed(),
                    true,
                );
                handle
            }
            Err(err) => {
                emit_sidecar_metric(
                    &emit,
                    "ensureSpawned",
                    Some(method),
                    ensure_started.elapsed(),
                    false,
                );
                return Err(err);
            }
        };
        let id = handle.alloc_id();
        let (tx, rx) = channel::<Result<Value, String>>();
        handle.pending.insert(id, tx);
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&payload).map_err(BridgeError::from)?;
        {
            let mut stdin = handle.stdin.lock().expect("stdin lock");
            if let Err(e) = writeln!(stdin, "{line}") {
                handle.pending.take(id);
                return Err(BridgeError::from(e));
            }
            if let Err(e) = stdin.flush() {
                handle.pending.take(id);
                return Err(BridgeError::from(e));
            }
        }
        let call_started = Instant::now();
        let result = match rx.recv_timeout(timeout) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(msg)) => Err(BridgeError { message: msg }),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                handle.pending.take(id);
                Err(BridgeError {
                    message: format!("sidecar: timeout waiting for {method}"),
                })
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                handle.pending.take(id);
                Err(BridgeError {
                    message: format!("sidecar: channel closed for {method}"),
                })
            }
        };
        emit_sidecar_metric(
            &emit,
            "call",
            Some(method),
            call_started.elapsed(),
            result.is_ok(),
        );
        result
    }

    // Test helper: forcibly drop the current handle so the next call respawns.
    #[cfg(test)]
    pub fn reset(&self) {
        let mut guard = self.inner.lock().expect("sidecar lock");
        if let Some(h) = guard.take() {
            // Try to kill the child; ignore errors — it may already be dead.
            if let Ok(mut child) = h.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            // Wake any blocked callers with a clear error so tests don't hang.
            for tx in h.pending.drain_all() {
                let _ = tx.send(Err("sidecar: state reset".to_string()));
            }
        }
        self.restart_backoff
            .lock()
            .expect("restart backoff lock")
            .clear();
    }
}

// EventSink lets the bridge forward sidecar-pushed notifications without
// hard-coding tauri::AppHandle: tests inject a Vec-collecting closure,
// production code wraps `app.emit(name, params)` from an AppHandle.
pub type EventSink = Arc<dyn Fn(&str, &Value) + Send + Sync + 'static>;

#[cfg(feature = "desktop")]
pub fn app_handle_emit_sink(app: AppHandle) -> EventSink {
    use crate::host_context::HostContext;
    Arc::new(move |name: &str, params: &Value| {
        publish_runtime_event(
            &HostContext::from_app(app.clone()),
            name,
            params.clone(),
            "node-sidecar",
        );
        app.state::<crate::remote_server::RustRemoteServerState>()
            .broadcast_event(name, params);
    })
}

fn emit_sidecar_metric(
    emit: &Option<EventSink>,
    phase: &str,
    method: Option<&str>,
    elapsed: Duration,
    ok: bool,
) {
    if let Some(sink) = emit.as_ref() {
        let mut payload = serde_json::json!({
            "phase": phase,
            "elapsedMs": elapsed.as_millis() as u64,
            "ok": ok,
        });
        if let Some(method) = method {
            payload["method"] = Value::String(method.to_string());
        }
        sink("sidecar:metric", &payload);
    }
}

fn spawn_sidecar(cfg: &SpawnConfig, emit: Option<EventSink>) -> Result<SidecarHandle, BridgeError> {
    let mut command = Command::new(&cfg.node_path);
    let launch_mode = configure_sidecar_entry(&mut command, &cfg.script_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let cwd = safe_default_cwd();
    if let Some(dir) = cwd.as_ref() {
        command.current_dir(dir);
    }
    hide_console_window(&mut command);
    if let Some(dir) = &cfg.data_dir {
        command.env("BAT_SIDECAR_DATA_DIR", dir);
    }
    for (k, v) in &cfg.extra_env {
        command.env(k, v);
    }
    let stderr_log_path = cfg
        .data_dir
        .as_ref()
        .map(|dir| dir.join("logs").join("sidecar.log"));
    if let Some(path) = stderr_log_path.as_ref() {
        let _ = append_line(
            path,
            &format_sidecar_spawn_log_line(
                &cfg.node_path,
                &cfg.script_path,
                cwd.as_deref(),
                launch_mode,
            ),
        );
    }
    let spawn_started = Instant::now();
    let mut child = match command.spawn() {
        Ok(child) => {
            emit_sidecar_metric(&emit, "spawnProcess", None, spawn_started.elapsed(), true);
            child
        }
        Err(e) => {
            emit_sidecar_metric(&emit, "spawnProcess", None, spawn_started.elapsed(), false);
            return Err(BridgeError {
                message: format!("sidecar: failed to spawn {}: {e}", cfg.node_path.display()),
            });
        }
    };
    let stdin = child.stdin.take().ok_or_else(|| BridgeError {
        message: "sidecar: failed to capture stdin".into(),
    })?;
    let stdout = child.stdout.take().ok_or_else(|| BridgeError {
        message: "sidecar: failed to capture stdout".into(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| BridgeError {
        message: "sidecar: failed to capture stderr".into(),
    })?;

    let pending: Arc<PendingTable> = Arc::new(PendingTable::default());
    let pending_for_reader = Arc::clone(&pending);
    let stderr_tail: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LIMIT)));
    let stderr_tail_for_stdout_reader = Arc::clone(&stderr_tail);
    let stderr_tail_for_stderr_reader = Arc::clone(&stderr_tail);
    let emit_for_stderr = emit.clone();
    let sidecar_pid = child.id();
    // Stderr reader: append to the tail buffer (capped) and fan out as
    // a `sidecar:stderr` event so the renderer / DevTools can show
    // diagnostic output in real time. The tail is also surfaced in the
    // `child exited` error message below.
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            {
                let mut guard = stderr_tail_for_stderr_reader
                    .lock()
                    .expect("stderr tail lock");
                if guard.len() >= STDERR_TAIL_LIMIT {
                    guard.pop_front();
                }
                guard.push_back(line.clone());
            }
            if let Some(sink) = emit_for_stderr.as_ref() {
                sink("sidecar:stderr", &Value::String(line.clone()));
            }
            if let Some(path) = stderr_log_path.as_ref() {
                let _ = append_line(path, &format_sidecar_log_line(&line));
            }
        }
        // Pipe EOF: the sidecar process closed stderr, which in practice
        // means it exited (or was killed). Timestamp the death so silent
        // disappearances are visible in the log instead of only the next
        // [spawn]. The exit STATUS is logged separately by ensure_spawned
        // when it harvests the dead child at respawn time.
        if let Some(path) = stderr_log_path.as_ref() {
            let _ = append_line(
                path,
                &format_sidecar_exit_log_line(&format!(
                    "stderr closed; sidecar pid={sidecar_pid} likely exited"
                )),
            );
        }
    });

    // Reader thread: parse line-delimited JSON, route by id, fan out events.
    let emit_for_reader = emit.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: SidecarReply = match serde_json::from_str(trimmed) {
                Ok(m) => m,
                Err(_) => continue, // malformed line; skip
            };
            // Server events have no id and a method like "event:name".
            // Strip the "event:" prefix and forward the params payload to
            // the registered sink (Tauri AppHandle in production, a test
            // collector in unit tests).
            if msg.id.is_none() {
                if let Some(method) = msg.method.as_deref() {
                    if let Some(name) = method.strip_prefix("event:") {
                        if let Some(sink) = emit_for_reader.as_ref() {
                            let params = msg.params.unwrap_or(Value::Null);
                            sink(name, &params);
                        }
                    }
                }
                continue;
            }
            let id = msg.id.unwrap();
            if let Some(tx) = pending_for_reader.take(id) {
                let outcome = if let Some(err) = msg.error {
                    Err(format!("sidecar({}): {}", err.code, err.message))
                } else {
                    Ok(msg.result.unwrap_or(Value::Null))
                };
                let _ = tx.send(outcome);
            }
        }
        // stdout closed => child exited. Wake all pending callers so they
        // don't hang forever, and include any captured stderr so the
        // failure mode is actionable instead of a generic "child exited".
        let tail = snapshot_stderr_tail(&stderr_tail_for_stdout_reader);
        let err_message = if tail.is_empty() {
            "sidecar: child exited".to_string()
        } else {
            format!("sidecar: child exited; stderr tail:\n{tail}")
        };
        for tx in pending_for_reader.drain_all() {
            let _ = tx.send(Err(err_message.clone()));
        }
    });

    Ok(SidecarHandle {
        stdin: Mutex::new(stdin),
        next_id: AtomicU64::new(0),
        pending,
        child: Mutex::new(child),
        stderr_tail,
    })
}

#[derive(Debug, Deserialize)]
struct SidecarReply {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<u64>,
    method: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<SidecarReplyError>,
}

#[derive(Debug, Deserialize)]
struct SidecarReplyError {
    code: i64,
    message: String,
}

// ---------------------------------------------------------------------------
// Tauri-facing helper: build a SpawnConfig from the app handle.
//
// The Node binary is resolved from PATH (via the `node` symbol). The script
// path falls back through:
//   1) BAT_SIDECAR_SCRIPT environment variable (used in dev / tests).
//   2) <resource_dir>/node-sidecar/dist/server.mjs (production-bundled).
//   3) <resource_dir>/node-sidecar/src/server.mjs (legacy bundled fallback).
//   4) <cwd>/node-sidecar/src/server.mjs (development fallback).
//   5) <cwd>/node-sidecar/dist/server.mjs (prepared-build fallback).
// We keep this resolver outside SidecarState so the state struct stays
// trivially constructible in tests.

#[cfg(feature = "desktop")]
pub fn resolve_spawn_config(app: &tauri::AppHandle) -> Result<SpawnConfig, BridgeError> {
    use tauri::Manager;

    // Runtime setup prefers app-data managed Node, then the all-in-one
    // bundled runtime, then a user-managed PATH Node. Packaged builds should
    // not accidentally route Claude sidecar startup through an unrelated
    // system Node when the bundled runtime is present.
    let managed = find_managed_node(app);
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|dir| find_bundled_node(&dir));
    let cwd_bundled = std::env::current_dir()
        .ok()
        .and_then(|cwd| find_bundled_node(&cwd));
    let system = which_node();
    let node_path = choose_node_path(managed, bundled, cwd_bundled, system).ok_or_else(|| {
        BridgeError {
            message:
                "sidecar: could not find `node` (no managed runtime, no bundled runtime, no PATH runtime)"
                    .into(),
        }
    })?;
    // Tauri app data dir, if available. We pass it to the sidecar via env
    // so file-backed handlers land in the same directory the Rust side
    // uses (e.g. claude-accounts.json written by the Electron build).
    let data_dir = crate::app_data::app_data_dir_opt(app);

    if let Ok(env_script) = std::env::var("BAT_SIDECAR_SCRIPT") {
        let p = PathBuf::from(env_script);
        if p.is_file() {
            return Ok(SpawnConfig {
                node_path,
                script_path: p,
                data_dir,
                extra_env: Vec::new(),
            });
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(candidate) = find_sidecar_script(&resource_dir, true) {
            return Ok(SpawnConfig {
                node_path,
                script_path: candidate,
                data_dir,
                extra_env: Vec::new(),
            });
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(dev) = find_sidecar_script(&cwd, false) {
        return Ok(SpawnConfig {
            node_path,
            script_path: dev,
            data_dir,
            extra_env: Vec::new(),
        });
    }

    Err(BridgeError {
        message: "sidecar: could not locate node-sidecar dist/server.mjs or src/server.mjs".into(),
    })
}

// Headless equivalent of resolve_spawn_config: no AppHandle/resource_dir. Node
// comes from a bundle next to the executable, the cwd, or PATH; the script from
// BAT_SIDECAR_SCRIPT or the same exe-relative / cwd `node-sidecar/` locations.
// data_dir is the headless server's --data-dir (already env-pinned).
#[cfg(not(feature = "desktop"))]
pub fn resolve_spawn_config_headless(
    data_dir: Option<PathBuf>,
) -> Result<SpawnConfig, BridgeError> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let bundled = exe_dir.as_deref().and_then(find_bundled_node);
    let cwd_bundled = std::env::current_dir()
        .ok()
        .and_then(|cwd| find_bundled_node(&cwd));
    let node_path =
        choose_node_path(None, bundled, cwd_bundled, which_node()).ok_or_else(|| BridgeError {
            message: "bat-server: could not find `node` (no bundled runtime, no PATH node)".into(),
        })?;

    if let Ok(env_script) = std::env::var("BAT_SIDECAR_SCRIPT") {
        let p = PathBuf::from(env_script);
        if p.is_file() {
            return Ok(SpawnConfig {
                node_path,
                script_path: p,
                data_dir,
                extra_env: Vec::new(),
            });
        }
    }

    let bases: Vec<PathBuf> = exe_dir
        .into_iter()
        .chain(std::env::current_dir().ok())
        .collect();
    for base in &bases {
        if let Some(script) = find_sidecar_script(base, true) {
            return Ok(SpawnConfig {
                node_path,
                script_path: script,
                data_dir,
                extra_env: Vec::new(),
            });
        }
    }

    Err(BridgeError {
        message: "bat-server: could not locate node-sidecar dist/server.mjs or src/server.mjs"
            .into(),
    })
}

fn choose_node_path(
    managed: Option<PathBuf>,
    bundled: Option<PathBuf>,
    cwd_bundled: Option<PathBuf>,
    system: Option<PathBuf>,
) -> Option<PathBuf> {
    managed.or(bundled).or(cwd_bundled).or(system)
}

fn find_sidecar_script(base_dir: &Path, prefer_dist: bool) -> Option<PathBuf> {
    let dist = base_dir
        .join("node-sidecar")
        .join("dist")
        .join("server.mjs");
    let src = base_dir.join("node-sidecar").join("src").join("server.mjs");
    let candidates = if prefer_dist {
        [dist, src]
    } else {
        [src, dist]
    };
    candidates.into_iter().find(|p| p.is_file())
}

fn node_runtime_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

#[cfg(feature = "desktop")]
fn find_managed_node(app: &tauri::AppHandle) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
    let root = crate::app_data::app_data_dir_opt(app)?
        .join("runtimes")
        .join("node")
        .join(crate::runtime_catalog::node_version())
        .join(node_runtime_key()?);
    let candidates = [root.join(exe_name), root.join("bin").join(exe_name)];
    candidates.into_iter().find(|path| path.is_file())
}

// Look for a bundled Node runtime under <resource_dir>/node-runtime.
// The build-side fetch script (scripts/fetch-node-runtime.mjs) drops
// platform-specific binaries here; resource_dir is the Tauri-managed
// directory that bundle.resources is unpacked into at install time.
//
// Probe order:
//   1) <resource>/node-runtime/<platform>-<arch>/node[.exe]
//      (matches Node.org's portable archive layout — bin/node on
//      darwin/linux, node.exe at root on windows)
//   2) <resource>/node-runtime/node[.exe]  (flat fallback for when
//      we ship a single platform's binary without subdirs)
//
// Returns None when no bundled binary is found; resolve_spawn_config
// then falls back to PATH lookup. Keeping this resolver pure (no
// network / no spawn) means the dev path stays predictable and tests
// don't need fixtures unless they want to verify a specific layout.
fn find_bundled_node(resource_dir: &std::path::Path) -> Option<PathBuf> {
    let runtime = resource_dir.join("node-runtime");
    if !runtime.is_dir() {
        return None;
    }
    let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
    let arch = std::env::consts::ARCH;
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    // 1) platform-arch subdir, with optional bin/ layer
    let sub = runtime.join(format!("{platform}-{arch}"));
    if sub.is_dir() {
        let direct = sub.join(exe_name);
        if direct.is_file() {
            return Some(direct);
        }
        let in_bin = sub.join("bin").join(exe_name);
        if in_bin.is_file() {
            return Some(in_bin);
        }
    }
    // 2) flat fallback at runtime root
    let flat = runtime.join(exe_name);
    if flat.is_file() {
        return Some(flat);
    }
    None
}

fn find_node_in_dirs<I>(dirs: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    let exe_names: &[&str] = if cfg!(windows) {
        // Do not launch the sidecar through node.cmd. Command shims run
        // through cmd.exe on Windows and can mangle absolute script paths
        // such as C:\... into a bare drive path ("C:"), which makes Node
        // crash while resolving the main module.
        &["node.exe"]
    } else {
        &["node"]
    };
    for entry in dirs {
        for name in exe_names {
            let candidate = entry.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn common_node_dirs() -> Vec<PathBuf> {
    if cfg!(windows) {
        Vec::new()
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]
    }
}

fn which_node() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        if let Some(candidate) = find_node_in_dirs(std::env::split_paths(&path)) {
            return Some(candidate);
        }
    }
    // macOS GUI apps launched from Finder do not inherit the user's shell PATH.
    // Homebrew installs Node under these prefixes, and lightweight BAT relies
    // on that external runtime when no bundled Node is shipped.
    find_node_in_dirs(common_node_dirs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn repo_root() -> PathBuf {
        // CARGO_MANIFEST_DIR points at src-tauri/. The repo root is one up.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repo root")
            .to_path_buf()
    }

    fn sidecar_script() -> PathBuf {
        repo_root()
            .join("node-sidecar")
            .join("src")
            .join("server.mjs")
    }

    fn require_node() -> Option<PathBuf> {
        which_node()
    }

    #[test]
    fn find_node_in_dirs_finds_candidate_without_path_env() {
        let tmp = std::env::temp_dir().join(format!("bat-node-dir-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
        let exe = tmp.join(exe_name);
        std::fs::write(&exe, b"fake").unwrap();
        let found = find_node_in_dirs(vec![tmp.clone()]).expect("expected node candidate");
        assert_eq!(found, exe);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    #[cfg(windows)]
    fn find_node_in_dirs_ignores_windows_command_shim() {
        let tmp =
            std::env::temp_dir().join(format!("bat-node-cmd-dir-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("node.cmd"), b"fake").unwrap();
        assert!(find_node_in_dirs(vec![tmp.clone()]).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn restart_backoff_blocks_after_repeated_failures() {
        let now = Instant::now();
        let mut backoff = RestartBackoff::default();
        backoff.record_failure(now);
        backoff.record_failure(now + Duration::from_secs(1));
        assert!(backoff
            .remaining_block(now + Duration::from_secs(2))
            .is_none());

        backoff.record_failure(now + Duration::from_secs(2));
        let remaining = backoff
            .remaining_block(now + Duration::from_secs(3))
            .expect("expected active backoff");
        assert!(remaining <= RESTART_BACKOFF_DURATION);
        assert!(remaining > Duration::from_secs(0));

        assert!(backoff
            .remaining_block(now + Duration::from_secs(8))
            .is_none());
    }

    #[test]
    fn sidecar_exit_log_line_has_exit_prefix() {
        let line = format_sidecar_exit_log_line("stderr closed; sidecar pid=123 likely exited");
        assert!(line.contains(" [exit] "));
        assert!(line.contains("pid=123"));
        assert!(line.ends_with('\n'));
    }

    #[test]
    fn sidecar_log_line_has_stderr_prefix() {
        let line = format_sidecar_log_line("boom");
        assert!(line.contains(" [stderr] boom\n"));
    }

    #[test]
    fn sidecar_spawn_log_line_includes_launch_paths_and_mode() {
        let node = PathBuf::from("/opt/node/bin/node");
        let script =
            PathBuf::from("/Applications/Better Agent Terminal/node-sidecar/dist/server.mjs");
        let cwd = PathBuf::from("/Users/example");
        let line = format_sidecar_spawn_log_line(
            &node,
            &script,
            Some(&cwd),
            SidecarLaunchMode::DirectScriptArg,
        );

        assert!(line.contains(" [spawn] "));
        assert!(line.contains("node=/opt/node/bin/node"));
        assert!(line
            .contains("script=/Applications/Better Agent Terminal/node-sidecar/dist/server.mjs"));
        assert!(line.contains("cwd=/Users/example"));
        assert!(line.contains("mode=direct-script-arg"));
        #[cfg(windows)]
        assert_eq!(
            SidecarLaunchMode::WindowsEvalBootstrap.as_str(),
            "windows-eval-bootstrap",
        );
    }

    #[test]
    fn choose_node_path_prefers_bundled_before_system() {
        let managed = None;
        let bundled = Some(PathBuf::from("bundled-node"));
        let cwd_bundled = Some(PathBuf::from("cwd-bundled-node"));
        let system = Some(PathBuf::from("system-node"));

        assert_eq!(
            choose_node_path(managed, bundled, cwd_bundled, system),
            Some(PathBuf::from("bundled-node")),
        );
    }

    #[test]
    fn choose_node_path_keeps_managed_first_and_system_fallback() {
        assert_eq!(
            choose_node_path(
                Some(PathBuf::from("managed-node")),
                Some(PathBuf::from("bundled-node")),
                Some(PathBuf::from("cwd-bundled-node")),
                Some(PathBuf::from("system-node")),
            ),
            Some(PathBuf::from("managed-node")),
        );
        assert_eq!(
            choose_node_path(None, None, None, Some(PathBuf::from("system-node"))),
            Some(PathBuf::from("system-node")),
        );
    }

    #[test]
    #[cfg(windows)]
    fn windows_eval_bootstrap_imports_entry_from_env_and_restores_argv() {
        let Some(node) = require_node() else {
            eprintln!("skipped: no node on PATH");
            return;
        };
        let tmp =
            std::env::temp_dir().join(format!("bat-sidecar-bootstrap-{}", std::process::id()));
        let script_dir = tmp.join("path with spaces");
        let script = script_dir.join("entry.mjs");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&script_dir).unwrap();
        std::fs::write(
            &script,
            "console.log(JSON.stringify({ argv: process.argv[1], href: import.meta.url }))\n",
        )
        .unwrap();

        let output = Command::new(node)
            .arg("--input-type=module")
            .arg("--eval")
            .arg(windows_sidecar_eval_bootstrap())
            .env("BAT_SIDECAR_ENTRY_PATH", &script)
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "stderr={}",
            String::from_utf8_lossy(&output.stderr),
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let payload: Value = serde_json::from_str(stdout.trim()).unwrap();
        assert_eq!(
            __normalize_windows_test_path(payload["argv"].as_str().unwrap()),
            __normalize_windows_test_path(&script.to_string_lossy()),
        );
        assert!(payload["href"].as_str().unwrap().starts_with("file:///"));

        let _ = std::fs::remove_dir_all(tmp);
    }

    #[cfg(windows)]
    fn __normalize_windows_test_path(path: &str) -> String {
        path.replace("\\\\?\\", "")
            .replace('\\', "/")
            .to_lowercase()
    }

    #[test]
    fn find_sidecar_script_prefers_dist_for_resources() {
        let tmp = std::env::temp_dir().join(format!(
            "bat-sidecar-script-{}-{}",
            std::process::id(),
            "dist"
        ));
        let root = tmp.join("node-sidecar");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        let src = root.join("src").join("server.mjs");
        let dist = root.join("dist").join("server.mjs");
        std::fs::write(&src, "").unwrap();
        std::fs::write(&dist, "").unwrap();

        assert_eq!(find_sidecar_script(&tmp, true), Some(dist));
        assert_eq!(find_sidecar_script(&tmp, false), Some(src));

        let _ = std::fs::remove_dir_all(tmp);
    }

    // Sidecar got split in slice #40 from a single server.mjs into a tree
    // with sibling lib/ and handlers/ subdirs. A raw src/server.mjs resource
    // is not enough; release builds must either ship the full src tree or the
    // M2 bundled dist/server.mjs artifact.
    #[test]
    fn tauri_conf_bundles_sidecar_entry() {
        let conf_path = repo_root().join("src-tauri").join("tauri.conf.json");
        let raw = std::fs::read_to_string(&conf_path).expect("tauri.conf.json must be readable");
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).expect("tauri.conf.json must parse");
        let resources = parsed
            .pointer("/bundle/resources")
            .and_then(|v| v.as_object())
            .expect("bundle.resources must be an object");
        let keys: Vec<&str> = resources.keys().map(|s| s.as_str()).collect();
        let bundles_dist = keys.iter().any(|k| *k == "../node-sidecar/dist/server.mjs");
        let bundles_full_src_tree = keys.iter().any(|k| {
            *k == "../node-sidecar/src/"
                || k.contains("node-sidecar/src/lib")
                || k.contains("node-sidecar/src/handlers")
                || *k == "../node-sidecar/src/**"
        });
        assert!(
            bundles_dist || bundles_full_src_tree,
            "bundle.resources must ship either bundled node-sidecar/dist/server.mjs or the full \
             node-sidecar/src/ tree (lib/ + handlers/); got keys: {keys:?}",
        );
        assert!(
            !keys.iter().any(|k| *k == "../node-sidecar/src/server.mjs"),
            "bundle.resources should not list server.mjs as a single file — it leaves \
             sibling lib/ and handlers/ unbundled."
        );
    }

    // Tauri native drag/drop events provide absolute paths for OS file/folder
    // drops. The renderer routes those events to Sidebar and all agent
    // attachment panels, so the config must keep native events enabled instead
    // of relying on browser File objects without host paths.
    #[test]
    fn tauri_conf_enables_native_dragdrop_path_events() {
        let conf_path = repo_root().join("src-tauri").join("tauri.conf.json");
        let raw = std::fs::read_to_string(&conf_path).expect("tauri.conf.json must be readable");
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).expect("tauri.conf.json must parse");
        let windows = parsed
            .pointer("/app/windows")
            .and_then(|v| v.as_array())
            .expect("app.windows must be an array");
        assert!(
            !windows.is_empty(),
            "app.windows must declare at least one window"
        );
        for (i, w) in windows.iter().enumerate() {
            let dde = w.get("dragDropEnabled").and_then(|v| v.as_bool());
            assert_eq!(
                dde,
                Some(true),
                "window[{i}].dragDropEnabled must be explicitly true so Tauri emits \
                 native drag-drop path events for folder/file drops.",
            );
        }
    }

    #[test]
    fn find_bundled_node_returns_none_for_missing_dir() {
        let tmp = std::env::temp_dir().join(format!(
            "bat-bundled-node-test-empty-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        // No node-runtime/ subdir present.
        assert!(find_bundled_node(&tmp).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_bundled_node_finds_platform_arch_layout() {
        // Layout matches Node.org portable archive: <runtime>/<plat>-<arch>/[bin/]node
        let tmp = std::env::temp_dir().join(format!(
            "bat-bundled-node-test-platarch-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let arch = std::env::consts::ARCH;
        let platform = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
        // Use the bin/ layer so we exercise the secondary probe path too.
        let bin_dir = tmp
            .join("node-runtime")
            .join(format!("{platform}-{arch}"))
            .join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let exe = bin_dir.join(exe_name);
        std::fs::write(&exe, b"fake").unwrap();
        let found = find_bundled_node(&tmp).expect("expected to find bundled node");
        assert_eq!(found, exe);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_bundled_node_finds_flat_fallback() {
        let tmp =
            std::env::temp_dir().join(format!("bat-bundled-node-test-flat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let runtime = tmp.join("node-runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
        let exe = runtime.join(exe_name);
        std::fs::write(&exe, b"fake").unwrap();
        let found = find_bundled_node(&tmp).expect("expected flat fallback to resolve");
        assert_eq!(found, exe);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_bundled_node_prefers_platform_subdir_over_flat() {
        // Both layouts present: platform-arch should win so we don't accidentally
        // ship a wrong-arch flat binary on a multi-platform release.
        let tmp =
            std::env::temp_dir().join(format!("bat-bundled-node-test-pref-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let runtime = tmp.join("node-runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
        let arch = std::env::consts::ARCH;
        let platform = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let sub = runtime.join(format!("{platform}-{arch}"));
        std::fs::create_dir_all(&sub).unwrap();
        let preferred = sub.join(exe_name);
        std::fs::write(&preferred, b"correct").unwrap();
        let flat = runtime.join(exe_name);
        std::fs::write(&flat, b"wrong").unwrap();
        let found = find_bundled_node(&tmp).expect("expected to find bundled node");
        assert_eq!(found, preferred);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn alloc_id_starts_at_one_and_increments() {
        // SidecarHandle::alloc_id just bumps an AtomicU64 starting from 0
        // and returns +1, so a freestanding atomic stand-in is enough — no
        // need to spawn a dummy child.
        let counter = AtomicU64::new(0);
        let next = || counter.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(next(), 1);
        assert_eq!(next(), 2);
        assert_eq!(next(), 3);
    }

    #[test]
    fn pending_table_inserts_and_takes() {
        let table = PendingTable::default();
        let (tx, _rx) = channel::<Result<Value, String>>();
        table.insert(7, tx);
        assert!(table.take(7).is_some());
        assert!(table.take(7).is_none());
    }

    #[test]
    fn pending_table_drain_returns_all() {
        let table = PendingTable::default();
        let (tx1, _) = channel::<Result<Value, String>>();
        let (tx2, _) = channel::<Result<Value, String>>();
        table.insert(1, tx1);
        table.insert(2, tx2);
        let drained = table.drain_all();
        assert_eq!(drained.len(), 2);
        assert!(table.take(1).is_none());
        assert!(table.take(2).is_none());
    }

    #[test]
    fn reply_parses_ok_result() {
        let r: SidecarReply =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":3,"result":{"x":1}}"#).unwrap();
        assert_eq!(r.id, Some(3));
        assert_eq!(r.result.unwrap()["x"], 1);
        assert!(r.error.is_none());
    }

    #[test]
    fn reply_parses_error() {
        let r: SidecarReply = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"nope"}}"#,
        )
        .unwrap();
        assert_eq!(r.id, Some(4));
        assert!(r.result.is_none());
        let e = r.error.unwrap();
        assert_eq!(e.code, -32601);
        assert_eq!(e.message, "nope");
    }

    #[test]
    fn reply_parses_event_no_id() {
        let r: SidecarReply =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"event:foo","params":{}}"#).unwrap();
        assert_eq!(r.id, None);
    }

    // The integration tests below require both `node` on PATH and the
    // sidecar script to exist. We skip gracefully (returning early with a
    // log) on machines that don't have them — keeps `cargo test` green
    // in minimal dev shells.
    // Resolve the bundled-node path the same way release would, but
    // looking at the on-disk node-sidecar/runtime/ checkout instead of
    // the Tauri resource_dir. Returns None when no runtime has been
    // fetched yet (CI / fresh checkout) so the test gracefully skips
    // rather than failing the whole suite.
    fn bundled_node_path_for_test() -> Option<PathBuf> {
        let runtime = repo_root().join("node-sidecar").join("runtime");
        find_bundled_node(&runtime.parent().unwrap()).or_else(|| {
            // find_bundled_node expects node-runtime/ but our local
            // checkout uses node-sidecar/runtime/. Probe directly.
            let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
            let arch = std::env::consts::ARCH;
            let platform = if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "darwin"
            } else {
                "linux"
            };
            let sub = runtime.join(format!("{platform}-{arch}"));
            if !sub.is_dir() {
                return None;
            }
            let direct = sub.join(exe_name);
            if direct.is_file() {
                return Some(direct);
            }
            let in_bin = sub.join("bin").join(exe_name);
            if in_bin.is_file() {
                return Some(in_bin);
            }
            None
        })
    }

    #[test]
    fn end_to_end_bundled_sdk_loads_through_bundled_node() {
        // The release contract: bundled Node + bundled node_modules in
        // node-sidecar/ together must let getSupportedModels return more
        // than just builtins (i.e. SDK augmentation actually fires).
        // If node-sidecar/node_modules is absent (fresh checkout, no
        // pnpm install yet) we skip rather than fail.
        let Some(node_path) = bundled_node_path_for_test() else {
            eprintln!("skipped: no bundled Node binary present");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let sidecar_node_modules = repo_root()
            .join("node-sidecar")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-agent-sdk");
        if !sidecar_node_modules.exists() {
            eprintln!("skipped: node-sidecar/node_modules not installed (run `pnpm --dir node-sidecar install`)");
            return;
        }
        let cfg = SpawnConfig {
            node_path,
            script_path: script,
            data_dir: None,
            extra_env: Vec::new(),
        };
        let state = SidecarState::new();
        let result = state
            .call(
                &cfg,
                "claude.getSupportedModels",
                Value::Null,
                Duration::from_secs(30),
            )
            .expect("getSupportedModels");
        let arr = result.as_array().expect("expected array");
        // Builtins=7 — anything more proves the bundled SDK was reachable.
        assert!(
            arr.len() >= 7,
            "expected at least 7 builtins, got {}",
            arr.len()
        );
        // At least one entry must come from the SDK to confirm augmentation.
        // (If sdk-import silently fell back to builtins-only this would be 7.)
        let has_sdk_entry = arr
            .iter()
            .any(|m| m.get("source").and_then(|s| s.as_str()) == Some("sdk"));
        assert!(
            has_sdk_entry,
            "expected ≥1 SDK-tagged model from bundled node_modules; got {:?}",
            arr
        );
        state.reset();
    }

    #[test]
    fn end_to_end_bundled_node_runs_sidecar() {
        // Verifies the bundled-Node code path by spawning the sidecar
        // through node-sidecar/runtime/<plat>-<arch>/[bin/]node[.exe]
        // and round-tripping a ping. Skips gracefully when no runtime
        // has been fetched (fresh checkout / CI before fetch step).
        let Some(node_path) = bundled_node_path_for_test() else {
            eprintln!("skipped: no node-sidecar/runtime/<plat>-<arch> binary present (run `pnpm run fetch:node-runtime`)");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = SpawnConfig {
            node_path: node_path.clone(),
            script_path: script,
            data_dir: None,
            extra_env: Vec::new(),
        };
        let state = SidecarState::new();
        let result = state
            .call(
                &cfg,
                "ping",
                json!({"via":"bundled"}),
                Duration::from_secs(10),
            )
            .expect("ping via bundled node");
        assert_eq!(result["ok"], true);
        assert_eq!(result["echo"]["via"], "bundled");
        // Sanity check: the spawned PID came from the bundled binary, not
        // a system node — we can't introspect the path post-spawn but we
        // CAN verify the binary we passed actually runs.
        eprintln!("bundled-node test ok via {}", node_path.display());
        state.reset();
    }

    #[test]
    fn end_to_end_ping_round_trip() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = SpawnConfig {
            node_path,
            script_path: script,
            data_dir: None,
            extra_env: Vec::new(),
        };
        let state = SidecarState::new();
        let result = state
            .call(
                &cfg,
                "ping",
                json!({"hello":"world"}),
                Duration::from_secs(5),
            )
            .expect("ping");
        assert_eq!(result["ok"], true);
        assert_eq!(result["echo"]["hello"], "world");
        // Tear down.
        state.reset();
    }

    #[test]
    fn end_to_end_stderr_tail_surfaces_in_child_exited_error() {
        // Spawn a script that writes a recognizable line to stderr and
        // then exits without responding to stdin. The first call must
        // come back with an error whose message includes the stderr
        // line — that's the diagnostic path users will hit when the
        // sidecar dies during startup (e.g. missing node_modules,
        // ESM parse error, etc.).
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script_dir =
            std::env::temp_dir().join(format!("bat-stderr-tail-{}", std::process::id()));
        std::fs::create_dir_all(&script_dir).unwrap();
        let script_path = script_dir.join("crash.mjs");
        std::fs::write(
            &script_path,
            "process.stderr.write('SYNTHETIC_STDERR_LINE_FOR_TEST\\n');\nprocess.exit(1);\n",
        )
        .unwrap();
        let cfg = SpawnConfig {
            node_path,
            script_path: script_path.clone(),
            data_dir: None,
            extra_env: Vec::new(),
        };
        let state = SidecarState::new();
        let err = state
            .call(&cfg, "ping", Value::Null, Duration::from_secs(5))
            .expect_err("expected error from crashing sidecar");
        assert!(
            err.message.contains("SYNTHETIC_STDERR_LINE_FOR_TEST"),
            "expected stderr tail in error message, got: {}",
            err.message,
        );
        assert!(
            err.message.contains("child exited"),
            "expected 'child exited' marker, got: {}",
            err.message,
        );
        state.reset();
        let _ = std::fs::remove_dir_all(&script_dir);
    }

    #[test]
    fn end_to_end_unknown_method_errors() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = SpawnConfig {
            node_path,
            script_path: script,
            data_dir: None,
            extra_env: Vec::new(),
        };
        let state = SidecarState::new();
        let err = state
            .call(&cfg, "no.such.method", Value::Null, Duration::from_secs(5))
            .expect_err("expected error");
        assert!(
            err.message.contains("-32601"),
            "unexpected: {}",
            err.message
        );
        state.reset();
    }

    #[test]
    fn end_to_end_claude_stubs() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = SpawnConfig {
            node_path,
            script_path: script,
            data_dir: None,
            extra_env: Vec::new(),
        };
        let state = SidecarState::new();
        let auth = state
            .call(
                &cfg,
                "claude.authStatus",
                Value::Null,
                Duration::from_secs(15),
            )
            .expect("authStatus");
        // authStatus is null OR an object (depends on whether `claude` is
        // installed and logged-in on the dev machine). Both are valid.
        assert!(
            auth.is_null() || auth.is_object(),
            "unexpected authStatus: {auth:?}"
        );
        let accounts = state
            .call(
                &cfg,
                "claude.accountList",
                Value::Null,
                Duration::from_secs(5),
            )
            .expect("accountList");
        // accountList wraps the array in `{accounts, activeAccountId,
        // switchWarningShown}` to match Electron's preload contract —
        // SettingsPanel reads result.accounts.length.
        assert!(
            accounts.is_object(),
            "accountList should be wrapped object: {accounts:?}"
        );
        let arr = accounts
            .get("accounts")
            .expect("accounts field")
            .as_array()
            .expect("accounts is array");
        // The dev machine may have a claude-accounts.json with real entries.
        // Just verify the shape — array of objects with id+email — without
        // asserting on length.
        for entry in arr {
            assert!(entry.is_object(), "non-object account: {entry:?}");
            assert!(entry.get("id").and_then(|v| v.as_str()).is_some());
            assert!(entry.get("email").and_then(|v| v.as_str()).is_some());
        }
        assert!(accounts.get("activeAccountId").is_some());
        assert!(accounts.get("switchWarningShown").is_some());
        state.reset();
    }

    #[test]
    fn end_to_end_session_lifecycle_emits_events() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        // Force the deterministic SDK-unavailable stub path so this test
        // doesn't try to call the real Anthropic API. The SDK code path
        // is exercised by end_to_end_bundled_sdk_loads_through_bundled_node.
        let cfg = SpawnConfig {
            node_path,
            script_path: script,
            data_dir: None,
            extra_env: vec![("BAT_SIDECAR_DISABLE_SDK".into(), "1".into())],
        };
        let state = SidecarState::new();
        // Collector sink — captures (event_name, payload) pairs from the
        // bridge's reader thread. Equivalent to Tauri's Emitter::emit, but
        // doesn't require an AppHandle in tests.
        let collected: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let collected_for_sink = Arc::clone(&collected);
        let sink: EventSink = Arc::new(move |name: &str, params: &Value| {
            collected_for_sink
                .lock()
                .unwrap()
                .push((name.to_string(), params.clone()));
        });

        // startSession then sendMessage. sendMessage triggers
        // claude:message + claude:turn-end events from the sidecar stub.
        state
            .call_with_emit(
                &cfg,
                Some(Arc::clone(&sink)),
                "claude.startSession",
                json!({"sessionId":"t-1","options":{"cwd":"/"}}),
                Duration::from_secs(5),
            )
            .expect("startSession");
        state
            .call_with_emit(
                &cfg,
                Some(Arc::clone(&sink)),
                "claude.sendMessage",
                json!({"sessionId":"t-1","prompt":"hi"}),
                Duration::from_secs(5),
            )
            .expect("sendMessage");

        // Events fire from the reader thread; give it a beat to flush.
        std::thread::sleep(Duration::from_millis(150));

        let events = collected.lock().unwrap();
        let names: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
        assert!(
            names.contains(&"claude:message"),
            "missing claude:message in {names:?}"
        );
        assert!(
            names.contains(&"claude:turn-end"),
            "missing claude:turn-end in {names:?}"
        );
        assert!(
            names.contains(&"sidecar:metric"),
            "missing sidecar:metric in {names:?}"
        );
        assert!(
            events.iter().any(|(name, payload)| {
                name == "sidecar:metric"
                    && payload["phase"] == "call"
                    && payload["method"] == "claude.sendMessage"
                    && payload["ok"] == true
                    && payload.get("elapsedMs").and_then(|v| v.as_u64()).is_some()
            }),
            "missing call metric for claude.sendMessage in {events:?}"
        );
        // Payload sanity: message event includes our session id.
        let msg_event = events.iter().find(|(n, _)| n == "claude:message").unwrap();
        assert_eq!(msg_event.1["sessionId"], "t-1");
        drop(events);
        state.reset();
    }

    #[test]
    fn end_to_end_session_state_round_trip() {
        // Verifies the sidecar's per-session state map round-trips through
        // the JSON-RPC bridge — startSession sets defaults, setters
        // mutate, getters read back, resetSession drops the entry.
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = SpawnConfig {
            node_path,
            script_path: script,
            data_dir: None,
            extra_env: Vec::new(),
        };
        let state = SidecarState::new();
        let timeout = Duration::from_secs(5);
        let sid = "rt-state-1";
        // start with options that pre-populate model + permissionMode.
        state.call(&cfg, "claude.startSession", json!({
            "sessionId": sid, "options": { "cwd": "/x", "model": "claude-sonnet-4-6", "permissionMode": "acceptEdits" }
        }), timeout).expect("startSession");
        // setters return true.
        let r = state
            .call(
                &cfg,
                "claude.setAutoContinue",
                json!({
                    "sessionId": sid, "opts": { "enabled": true, "max": 7, "prompt": "go on" }
                }),
                timeout,
            )
            .expect("setAutoContinue");
        assert_eq!(r, Value::Bool(true));
        // getters reflect the writes.
        let ac = state
            .call(
                &cfg,
                "claude.getAutoContinue",
                json!({"sessionId": sid}),
                timeout,
            )
            .expect("getAutoContinue");
        assert_eq!(ac["enabled"], true);
        assert_eq!(ac["max"], 7);
        assert_eq!(ac["used"], 0);
        assert_eq!(ac["prompt"], "go on");
        // permissionMode change.
        state
            .call(
                &cfg,
                "claude.setPermissionMode",
                json!({"sessionId": sid, "mode": "plan"}),
                timeout,
            )
            .expect("setPermissionMode");
        let meta = state
            .call(
                &cfg,
                "claude.getSessionMeta",
                json!({"sessionId": sid}),
                timeout,
            )
            .expect("meta");
        assert_eq!(meta["permissionMode"], "plan");
        assert_eq!(meta["model"], "claude-sonnet-4-6");
        // reset drops the entry.
        let reset = state
            .call(
                &cfg,
                "claude.resetSession",
                json!({"sessionId": sid}),
                timeout,
            )
            .expect("reset");
        assert_eq!(reset, Value::Bool(true));
        let after = state
            .call(
                &cfg,
                "claude.getSessionState",
                json!({"sessionId": sid}),
                timeout,
            )
            .expect("getSessionState");
        assert!(after.is_null());
        state.reset();
    }

    #[test]
    fn end_to_end_concurrent_calls_correlate_by_id() {
        let Some(node_path) = require_node() else {
            eprintln!("skipped: node not on PATH");
            return;
        };
        let script = sidecar_script();
        if !script.is_file() {
            eprintln!("skipped: missing {}", script.display());
            return;
        }
        let cfg = Arc::new(SpawnConfig {
            node_path,
            script_path: script,
            data_dir: None,
            extra_env: Vec::new(),
        });
        let state = Arc::new(SidecarState::new());
        // Warm the bridge so all threads share the same child.
        state
            .call(&cfg, "ping", Value::Null, Duration::from_secs(5))
            .unwrap();
        let mut joins = Vec::new();
        for i in 0..8u64 {
            let s = Arc::clone(&state);
            let c = Arc::clone(&cfg);
            joins.push(std::thread::spawn(move || {
                let r = s
                    .call(&c, "ping", json!({"i": i}), Duration::from_secs(5))
                    .expect("ping");
                assert_eq!(r["echo"]["i"], i);
            }));
        }
        for j in joins {
            j.join().unwrap();
        }
        state.reset();
    }
}
