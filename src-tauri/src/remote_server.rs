use crate::account_store;
use crate::app_data;
use crate::claude_usage;
use crate::codex_app_server::{should_handle_codex, CodexAppServerState};
#[cfg(feature = "desktop")]
use crate::commands::update as update_cmd;
use crate::commands::{
    agent as agent_cmd, app as app_cmd, claude as claude_cmd, fs as fs_cmd, git as git_cmd,
    github as github_cmd, image as image_cmd, notification as notification_cmd,
    profile as profile_cmd, pty as pty_cmd, runtime as runtime_cmd, settings as settings_cmd,
    snippet as snippet_cmd, worker_buffer::WorkerBufferState, worktree as worktree_cmd,
};
use crate::electron_safe_storage::{
    read_secret_json, read_secret_string, write_secret_json, write_secret_string, SecretJsonRead,
};
use crate::host_context::HostContext;
use crate::latency_store;
use crate::network_addresses;
use crate::remote_core::{
    canonical_remote_channel, decode_remote_binary_frame, decode_remote_text_frame,
    encode_remote_frame, event_params_to_legacy_v1_args, legacy_v1_args_to_params,
    negotiate_remote_compression, negotiate_remote_protocol, remote_agent_channel,
    remote_event_params_for_clients, strip_profile_secrets, RemoteCompression, RemoteFramePayload,
    RemoteProtocol, REMOTE_PROTOCOL_LEGACY_V1, REMOTE_PROTOCOL_V2,
};
use crate::sidecar::SidecarState;
#[cfg(feature = "desktop")]
use crate::window_registry;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rcgen::{generate_simple_self_signed, CertifiedKey};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::{Role, WebSocket};
use tungstenite::Message;

const DEFAULT_REMOTE_PORT: u16 = 9876;
const INVOKE_TIMEOUT: Duration = Duration::from_secs(15);
const RUNTIME_STATUS_TIMEOUT: Duration = Duration::from_secs(30);
const SESSION_INVOKE_TIMEOUT: Duration = Duration::from_secs(300);
const CLAUDE_REMOTE_LOGIN_TTL: Duration = Duration::from_secs(180);
const REMOTE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const REMOTE_SOCKET_POLL_TIMEOUT: Duration = Duration::from_millis(200);
const REMOTE_SOCKET_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const REMOTE_ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(250);
const REMOTE_RESOURCE_LOG_INTERVAL: Duration = Duration::from_secs(10);
const MAX_REMOTE_CONNECTIONS: usize = 64;
const MAX_REMOTE_INVOKES: usize = 128;
const REMOTE_OUTBOUND_QUEUE_CAPACITY: usize = 256;
const REMOTE_OUTBOUND_BURST: usize = 64;
/// Owner label for sessions a remote client established. Remote clients are not
/// host windows, so they have no registry id of their own. One shared, stable
/// label keeps a reconnecting client from tripping the cross-window ownership
/// guard — that guard exists to stop two local profiles sharing a runtime, and
/// a client that reconnects is still the same owner.
const REMOTE_AGENT_SESSION_WINDOW: &str = "remote-client";

struct ClaudeRemoteLoginClaim {
    touched: Instant,
    login_id: Option<String>,
}

static CLAUDE_REMOTE_LOGIN_CLAIM: Mutex<Option<ClaudeRemoteLoginClaim>> = Mutex::new(None);

fn remote_capabilities() -> Value {
    json!({
        "remoteAuth": {
            "claude": "paste-code-v1",
            "codex": "device-code-v1",
        }
    })
}

fn clear_claude_remote_login_started() {
    if let Ok(mut claim) = CLAUDE_REMOTE_LOGIN_CLAIM.lock() {
        *claim = None;
    }
}

fn try_begin_claude_remote_login() -> bool {
    let Ok(mut claim) = CLAUDE_REMOTE_LOGIN_CLAIM.lock() else {
        return false;
    };
    if claim
        .as_ref()
        .is_some_and(|value| value.touched.elapsed() < CLAUDE_REMOTE_LOGIN_TTL)
    {
        return false;
    }
    *claim = Some(ClaudeRemoteLoginClaim {
        touched: Instant::now(),
        login_id: None,
    });
    true
}

fn bind_claude_remote_login_id(login_id: Option<&str>) {
    let Some(login_id) = login_id.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    if let Ok(mut claim) = CLAUDE_REMOTE_LOGIN_CLAIM.lock() {
        if let Some(claim) = claim.as_mut() {
            claim.login_id = Some(login_id.to_string());
            claim.touched = Instant::now();
        }
    }
}

/// Validate a continuation before it reaches the sidecar and renew the claim
/// for the bounded submit/cancel operation. Missing ids remain accepted for
/// legacy clients; current clients must echo the id returned by start.
fn touch_claude_remote_login(requested_login_id: Option<&str>) -> bool {
    let Ok(mut claim) = CLAUDE_REMOTE_LOGIN_CLAIM.lock() else {
        return false;
    };
    let Some(active) = claim.as_mut() else {
        return false;
    };
    if active.touched.elapsed() >= CLAUDE_REMOTE_LOGIN_TTL {
        *claim = None;
        return false;
    }
    // A claim without an id is still starting (or belongs to an already-active
    // local ceremony). Never let an origin-less remote continuation attach to it.
    let Some(expected) = active.login_id.as_deref() else {
        return false;
    };
    if requested_login_id.is_some_and(|requested| expected != requested) {
        return false;
    }
    active.touched = Instant::now();
    true
}

fn while_claude_remote_login_idle<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut claim = CLAUDE_REMOTE_LOGIN_CLAIM
        .lock()
        .map_err(|_| "Claude remote login state is unavailable".to_string())?;
    if claim
        .as_ref()
        .is_some_and(|value| value.touched.elapsed() < CLAUDE_REMOTE_LOGIN_TTL)
    {
        return Err("auth_in_progress".to_string());
    }
    *claim = None;
    operation()
}

const REMOTE_EVENT_BUFFER_FLUSH: Duration = Duration::from_secs(1);
const RECENT_CLIENT_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const TOKEN_FILE: &str = "server-token.enc.json";
const LEGACY_TOKEN_FILE: &str = "server-token.json";
const CERT_FILE: &str = "server-cert.enc.json";
// Device ids of remote clients we've already seen, so a new client connecting
// fires a one-time notification and reconnects of known clients stay silent.
const KNOWN_CLIENTS_FILE: &str = "remote-known-clients.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClientInfo {
    pub label: String,
    pub window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_info: Option<RemoteClientDeviceInfo>,
    pub connected_at: u64,
    pub protocol: String,
    pub compression: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClientDeviceInfo {
    pub app_name: Option<String>,
    pub app_version: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub label: Option<String>,
    pub model: Option<String>,
    pub os_version: Option<String>,
    pub platform: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RemoteConnectionInfo {
    pub port: u16,
    pub token: String,
    pub fingerprint: String,
    pub bound_host: String,
}

#[derive(Debug)]
struct RunningServer {
    port: u16,
    token: Arc<Mutex<String>>,
    fingerprint: String,
    bind_interface: String,
    bound_host: String,
    clients: Arc<Mutex<Vec<RemoteClientRecord>>>,
    // Clients that disconnected within the last 24h (RECENT_CLIENT_TTL_MS), so
    // the Settings panel can still show who was recently connected (e.g. after
    // a token rotation kicks everyone). Pruned by TTL on read/record.
    recent: Arc<Mutex<Vec<RecentClient>>>,
    event_buffer: Arc<Mutex<RemoteEventBuffer>>,
    accepting: Arc<AtomicBool>,
    active_connections: Arc<AtomicUsize>,
    active_invokes: Arc<AtomicUsize>,
    stop: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

#[derive(Debug)]
struct RemoteClientRecord {
    id: String,
    info: RemoteClientInfo,
    tx: mpsc::SyncSender<Value>,
    // Set true to force this client's connection thread to close on its next
    // poll iteration. Used by token rotation to revoke existing sessions.
    close: Arc<AtomicBool>,
}

#[derive(Debug)]
struct ResourceSlot {
    active: Arc<AtomicUsize>,
}

impl Drop for ResourceSlot {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn try_acquire_resource_slot(active: &Arc<AtomicUsize>, limit: usize) -> Option<ResourceSlot> {
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < limit).then_some(current + 1)
        })
        .ok()
        .map(|_| ResourceSlot {
            active: Arc::clone(active),
        })
}

struct AcceptLoopGuard {
    accepting: Arc<AtomicBool>,
}

impl Drop for AcceptLoopGuard {
    fn drop(&mut self) {
        self.accepting.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone)]
struct RecentClient {
    info: RemoteClientInfo,
    disconnected_at: u64,
}

#[derive(Debug, Default)]
struct RemoteEventBuffer {
    events: Vec<BufferedRemoteEvent>,
    indexes: HashMap<String, usize>,
    flush_scheduled: bool,
}

#[derive(Debug)]
struct BufferedRemoteEvent {
    channel: String,
    params: Value,
}

#[derive(Clone, Default)]
pub struct RustRemoteServerState {
    // Arc so HostContext can hand out cheap clones (all sharing the one running
    // server); the headless backing stores states by value in a type map.
    inner: Arc<Mutex<Option<RunningServer>>>,
}

impl RustRemoteServerState {
    /// This host's own identity — its running server's certificate fingerprint, or
    /// None when no server is running. Lets the remote client refuse to dial this
    /// very process; see the self-connection check in remote_client::connect.
    pub fn own_host_identity(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()?
            .as_ref()
            .map(|running| running.fingerprint.clone())
    }

    pub fn start(
        &self,
        ctx: HostContext,
        sidecar: SidecarState,
        options: Option<Value>,
    ) -> Result<Value, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "remote server lock poisoned")?;
        if let Some(running) = guard.as_ref() {
            return Ok(start_result(running));
        }

        let opts = options.unwrap_or(Value::Null);
        let requested_port = opts
            .get("port")
            .and_then(|value| value.as_u64())
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(DEFAULT_REMOTE_PORT);
        let bind_interface = normalize_bind_interface(
            opts.get("bindInterface")
                .and_then(|value| value.as_str())
                .unwrap_or("localhost"),
        );
        let bound_host = network_addresses::bound_host_for_interface(&bind_interface);
        let data_dir = ctx.data_dir()?;
        fs::create_dir_all(&data_dir)
            .map_err(|err| format!("remote data dir creation failed: {err}"))?;

        let token = opts
            .get("token")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| load_persisted_token(&data_dir))
            .unwrap_or_else(generate_token);
        persist_token(&data_dir, &token);

        let cert = ensure_remote_certificate(&data_dir)?;
        let fingerprint = fingerprint_sha256(&cert.cert_der);
        let config = Arc::new(build_tls_config(&cert)?);
        let listener = TcpListener::bind((bound_host.as_str(), requested_port))
            .map_err(|err| format!("remote server bind failed: {err}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("remote server nonblocking failed: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("remote server local_addr failed: {err}"))?
            .port();

        let token = Arc::new(Mutex::new(token));
        let clients = Arc::new(Mutex::new(Vec::new()));
        let recent = Arc::new(Mutex::new(Vec::new()));
        let event_buffer = Arc::new(Mutex::new(RemoteEventBuffer::default()));
        let accepting = Arc::new(AtomicBool::new(true));
        let active_connections = Arc::new(AtomicUsize::new(0));
        let active_invokes = Arc::new(AtomicUsize::new(0));
        let (stop_tx, stop_rx) = mpsc::channel();
        let thread_clients = Arc::clone(&clients);
        let thread_recent = Arc::clone(&recent);
        let thread_token = Arc::clone(&token);
        let thread_accepting = Arc::clone(&accepting);
        let thread_active_connections = Arc::clone(&active_connections);
        let thread_active_invokes = Arc::clone(&active_invokes);
        let thread_ctx = ctx.clone();
        let thread_sidecar = sidecar.clone();
        let log_bound_host = bound_host.clone();
        let log_bind_interface = bind_interface.clone();
        let log_fingerprint = fingerprint.clone();
        let handle = thread::Builder::new()
            .name("bat-remote-acc".to_string())
            .spawn(move || {
                let _accept_loop_guard = AcceptLoopGuard {
                    accepting: thread_accepting,
                };
                remote_debug_log(
                    &thread_ctx,
                    format!(
                        "server started host={} port={} iface={} fingerprint={}",
                        log_bound_host,
                        port,
                        log_bind_interface,
                        log_fingerprint.chars().take(23).collect::<String>()
                    ),
                );
                run_accept_loop(
                    listener,
                    config,
                    thread_token,
                    thread_ctx,
                    thread_sidecar,
                    thread_clients,
                    thread_recent,
                    thread_active_connections,
                    thread_active_invokes,
                    stop_rx,
                );
            })
            .map_err(|err| format!("remote accept thread start failed: {err}"))?;

        let running = RunningServer {
            port,
            token,
            fingerprint,
            bind_interface,
            bound_host,
            clients,
            recent,
            event_buffer,
            accepting,
            active_connections,
            active_invokes,
            stop: stop_tx,
            thread: Some(handle),
        };
        let result = start_result(&running);
        *guard = Some(running);
        Ok(result)
    }

    pub fn stop(&self) -> bool {
        let Ok(mut guard) = self.inner.lock() else {
            return false;
        };
        let Some(mut running) = guard.take() else {
            return true;
        };
        if let Ok(clients) = running.clients.lock() {
            for client in clients.iter() {
                client.close.store(true, Ordering::Release);
            }
        }
        let _ = running.stop.send(());
        if let Some(handle) = running.thread.take() {
            let _ = handle.join();
        }
        true
    }

    #[cfg(not(feature = "desktop"))]
    pub fn is_accepting(&self) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| {
                guard
                    .as_ref()
                    .map(|running| running.accepting.load(Ordering::Acquire))
            })
            .unwrap_or(false)
    }

    pub fn status(&self) -> Value {
        let Ok(guard) = self.inner.lock() else {
            return json!({ "running": false, "port": null, "fingerprint": null, "bindInterface": null, "boundHost": null, "clients": [] });
        };
        let Some(running) = guard.as_ref() else {
            return json!({ "running": false, "port": null, "fingerprint": null, "bindInterface": null, "boundHost": null, "clients": [] });
        };
        let now = unix_ms();
        let live = running
            .clients
            .lock()
            .map(|clients| {
                clients
                    .iter()
                    .map(|client| client.info.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let live_keys: std::collections::HashSet<(Option<String>, String)> = live
            .iter()
            .map(|info| (info.window_id.clone(), info.label.clone()))
            .collect();
        let mut clients: Vec<Value> = live
            .iter()
            .map(|info| client_status_json(info, true, None))
            .collect();
        if let Ok(mut recent) = running.recent.lock() {
            recent
                .retain(|entry| now.saturating_sub(entry.disconnected_at) <= RECENT_CLIENT_TTL_MS);
            let mut seen: std::collections::HashSet<(Option<String>, String)> =
                std::collections::HashSet::new();
            // Newest disconnect first; skip clients that reconnected (live) or
            // duplicates of the same window/label.
            for entry in recent.iter().rev() {
                let key = (entry.info.window_id.clone(), entry.info.label.clone());
                if live_keys.contains(&key) || !seen.insert(key) {
                    continue;
                }
                clients.push(client_status_json(
                    &entry.info,
                    false,
                    Some(entry.disconnected_at),
                ));
            }
        }
        json!({
            "running": true,
            "accepting": running.accepting.load(Ordering::Acquire),
            "port": running.port,
            "fingerprint": running.fingerprint,
            "bindInterface": running.bind_interface,
            "boundHost": running.bound_host,
            "activeConnections": running.active_connections.load(Ordering::Acquire),
            "activeInvokes": running.active_invokes.load(Ordering::Acquire),
            "connectionLimit": MAX_REMOTE_CONNECTIONS,
            "invokeLimit": MAX_REMOTE_INVOKES,
            "outboundQueueCapacity": REMOTE_OUTBOUND_QUEUE_CAPACITY,
            "clients": clients,
        })
    }

    pub fn connection_info(&self) -> Option<RemoteConnectionInfo> {
        let guard = self.inner.lock().ok()?;
        let running = guard.as_ref()?;
        let token = running.token.lock().ok()?.clone();
        Some(RemoteConnectionInfo {
            port: running.port,
            token,
            fingerprint: running.fingerprint.clone(),
            bound_host: running.bound_host.clone(),
        })
    }

    // Generate a fresh token, persist it, and revoke every currently
    // connected client so the old token stops working everywhere. New
    // connections must present the new token at auth. Returns the same
    // shape as start_result so the renderer can rebuild the URL/QR.
    pub fn rotate_token(&self, app: &HostContext) -> Result<Value, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "remote server lock poisoned".to_string())?;
        let Some(running) = guard.as_ref() else {
            return Err("remote server is not running".to_string());
        };
        let new_token = generate_token();
        {
            let mut token = running
                .token
                .lock()
                .map_err(|_| "remote token lock poisoned".to_string())?;
            *token = new_token.clone();
        }
        let data_dir = app.data_dir()?;
        persist_token(&data_dir, &new_token);
        let now = unix_ms();
        let mut revoked: Vec<RemoteClientInfo> = Vec::new();
        if let Ok(mut clients) = running.clients.lock() {
            for client in clients.iter() {
                client.close.store(true, Ordering::Release);
                revoked.push(client.info.clone());
            }
            clients.clear();
        }
        for info in revoked {
            record_recent_client(&running.recent, info, now);
        }
        remote_debug_log(app, "token rotated; existing clients revoked");
        Ok(json!({
            "port": running.port,
            "token": new_token,
            "fingerprint": running.fingerprint,
            "bindInterface": running.bind_interface,
            "boundHost": running.bound_host,
        }))
    }

    pub fn broadcast_event(&self, channel: &str, params: &Value) {
        let canonical = canonical_remote_channel(channel);
        let (clients, event_buffer) = {
            let Ok(guard) = self.inner.lock() else {
                return;
            };
            let Some(running) = guard.as_ref() else {
                return;
            };
            (
                Arc::clone(&running.clients),
                Arc::clone(&running.event_buffer),
            )
        };
        if !has_remote_clients(&clients) {
            return;
        }
        if should_buffer_remote_event(&canonical)
            && enqueue_remote_event(&clients, &event_buffer, canonical.as_str(), params)
        {
            return;
        }
        if should_flush_before_remote_event(&canonical) {
            flush_remote_event_buffer(&clients, &event_buffer);
        }
        send_remote_event_to_clients(&clients, canonical.as_str(), params);
    }
}

impl Drop for RustRemoteServerState {
    fn drop(&mut self) {
        // Only the final owner tears the running server down. `HostContext`'s
        // `state()`/`try_state()` hand out *clones of the value* (the desktop
        // backing does `.inner().clone()`, the headless backing clones out of
        // its type map). Each such clone shares the one `inner` Arc, so a naive
        // `self.stop()` here would let any transient `ctx.try_state::<…>()`
        // lookup kill the shared server the moment that temporary clone drops —
        // which froze remote PTY output mid-session on the headless build.
        // Guarding on the last strong reference keeps the graceful
        // stop-on-shutdown behaviour while making clone-out lookups safe.
        if Arc::strong_count(&self.inner) == 1 {
            let _ = self.stop();
        }
    }
}

fn client_status_json(
    info: &RemoteClientInfo,
    connected: bool,
    disconnected_at: Option<u64>,
) -> Value {
    let mut value = serde_json::to_value(info).unwrap_or_else(|_| json!({}));
    if let Value::Object(map) = &mut value {
        map.insert("connected".to_string(), json!(connected));
        if let Some(ts) = disconnected_at {
            map.insert("disconnectedAt".to_string(), json!(ts));
        }
    }
    value
}

fn record_recent_client(recent: &Arc<Mutex<Vec<RecentClient>>>, info: RemoteClientInfo, now: u64) {
    if let Ok(mut recent) = recent.lock() {
        recent.retain(|entry| now.saturating_sub(entry.disconnected_at) <= RECENT_CLIENT_TTL_MS);
        recent.push(RecentClient {
            info,
            disconnected_at: now,
        });
    }
}

// Identity used to decide whether a connecting client is already known.
// Mirrors the (window_id, label) key the live/recent client lists dedup on,
// so "already recorded" matches what the Settings panel shows.
fn client_identity_key(info: &RemoteClientInfo) -> (Option<String>, String) {
    (info.window_id.clone(), info.label.clone())
}

// True if a client matching `key` is already in our records — either
// currently connected or recently disconnected within the TTL window. Used to
// fire the "new client connected" notification only for clients we have not
// seen yet; reconnects from a known client stay silent. Lock order is
// clients -> recent, matching the rest of the module.
fn client_already_recorded(
    clients: &Arc<Mutex<Vec<RemoteClientRecord>>>,
    recent: &Arc<Mutex<Vec<RecentClient>>>,
    key: &(Option<String>, String),
    now: u64,
) -> bool {
    if let Ok(clients) = clients.lock() {
        if clients
            .iter()
            .any(|client| &client_identity_key(&client.info) == key)
        {
            return true;
        }
    }
    if let Ok(mut recent) = recent.lock() {
        recent.retain(|entry| now.saturating_sub(entry.disconnected_at) <= RECENT_CLIENT_TTL_MS);
        if recent
            .iter()
            .any(|entry| &client_identity_key(&entry.info) == key)
        {
            return true;
        }
    }
    false
}

fn has_remote_clients(clients: &Arc<Mutex<Vec<RemoteClientRecord>>>) -> bool {
    clients
        .lock()
        .map(|clients| !clients.is_empty())
        .unwrap_or(false)
}

fn should_buffer_remote_event(channel: &str) -> bool {
    matches!(
        canonical_remote_channel(channel).as_str(),
        "claude:stream" | "claude:tool-result"
    )
}

fn should_flush_before_remote_event(channel: &str) -> bool {
    matches!(
        canonical_remote_channel(channel).as_str(),
        "claude:message"
            | "claude:tool-use"
            | "claude:result"
            | "claude:turn-end"
            | "claude:error"
            | "claude:history"
            | "claude:resume-loading"
            | "claude:session-reset"
    )
}

fn enqueue_remote_event(
    clients: &Arc<Mutex<Vec<RemoteClientRecord>>>,
    event_buffer: &Arc<Mutex<RemoteEventBuffer>>,
    channel: &str,
    params: &Value,
) -> bool {
    let Some(key) = buffered_remote_event_key(channel, params) else {
        return false;
    };
    let canonical = canonical_remote_channel(channel);
    let should_spawn = {
        let Ok(mut buffer) = event_buffer.lock() else {
            return false;
        };
        if let Some(index) = buffer.indexes.get(&key).copied() {
            if canonical == "claude:stream" {
                if let Some(event) = buffer.events.get_mut(index) {
                    merge_buffered_stream_params(&mut event.params, params);
                }
            } else if let Some(event) = buffer.events.get_mut(index) {
                event.params = params.clone();
            }
        } else {
            let index = buffer.events.len();
            buffer.indexes.insert(key, index);
            buffer.events.push(BufferedRemoteEvent {
                channel: canonical,
                params: params.clone(),
            });
        }
        if buffer.flush_scheduled {
            false
        } else {
            buffer.flush_scheduled = true;
            true
        }
    };

    if should_spawn {
        let clients = Arc::clone(clients);
        let event_buffer = Arc::clone(event_buffer);
        thread::spawn(move || {
            thread::sleep(REMOTE_EVENT_BUFFER_FLUSH);
            flush_remote_event_buffer(&clients, &event_buffer);
        });
    }
    true
}

fn flush_remote_event_buffer(
    clients: &Arc<Mutex<Vec<RemoteClientRecord>>>,
    event_buffer: &Arc<Mutex<RemoteEventBuffer>>,
) {
    let events = {
        let Ok(mut buffer) = event_buffer.lock() else {
            return;
        };
        buffer.flush_scheduled = false;
        buffer.indexes.clear();
        std::mem::take(&mut buffer.events)
    };
    for event in events {
        send_remote_event_to_clients(clients, event.channel.as_str(), &event.params);
    }
}

fn send_remote_event_to_clients(
    clients: &Arc<Mutex<Vec<RemoteClientRecord>>>,
    channel: &str,
    params: &Value,
) {
    // The single choke point where events become client frames — buffered ones flush
    // through here too — so this is where a payload gets stripped of anything a
    // remote client must not see. Ahead of the legacy v1 conversion on purpose: that
    // copies the whole payload into `args`, so sanitizing afterwards would sanitize
    // one copy and ship the other.
    let sanitized = remote_event_params_for_clients(channel, params);
    let params = sanitized.as_ref();
    let args = event_params_to_legacy_v1_args(channel, params);
    let agent_channel = remote_agent_channel(channel);
    if let Ok(mut clients) = clients.lock() {
        clients.retain(|client| {
            let frame = json!({
                "type": "event",
                "channel": agent_channel.clone(),
                "params": params.clone(),
                "args": args.clone(),
            });
            try_queue_remote_frame(&client.tx, &client.close, frame)
        });
    };
}

fn try_queue_remote_frame(
    tx: &mpsc::SyncSender<Value>,
    close: &Arc<AtomicBool>,
    frame: Value,
) -> bool {
    match tx.try_send(frame) {
        Ok(()) => true,
        Err(mpsc::TrySendError::Full(_)) | Err(mpsc::TrySendError::Disconnected(_)) => {
            // Never let an unread remote client turn event broadcasts into an
            // unbounded memory sink. Revoking it also makes the connection loop
            // drop the socket on its next poll.
            close.store(true, Ordering::Release);
            false
        }
    }
}

fn buffered_remote_event_key(channel: &str, params: &Value) -> Option<String> {
    let canonical = canonical_remote_channel(channel);
    let session_id = remote_key_part(params.get("sessionId"))?;
    match canonical.as_str() {
        "claude:stream" => Some(format!("{canonical}:{session_id}")),
        "claude:tool-result" => {
            let tool_id = remote_key_part(params.get("result").and_then(|value| value.get("id")))?;
            Some(format!("{canonical}:{session_id}:{tool_id}"))
        }
        _ => None,
    }
}

fn remote_key_part(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Null => None,
        value => Some(value.to_string()),
    }
}

fn merge_buffered_stream_params(existing: &mut Value, incoming: &Value) {
    if !existing.is_object() || !incoming.is_object() {
        *existing = incoming.clone();
        return;
    }
    let existing_map = existing.as_object_mut().expect("checked object");
    let incoming_map = incoming.as_object().expect("checked object");

    for (key, value) in incoming_map {
        if key != "data" {
            existing_map.insert(key.clone(), value.clone());
        }
    }

    let Some(Value::Object(incoming_data)) = incoming_map.get("data") else {
        existing_map.insert("data".to_string(), incoming["data"].clone());
        return;
    };
    let data = existing_map
        .entry("data".to_string())
        .or_insert_with(|| json!({}));
    let Value::Object(existing_data) = data else {
        *data = Value::Object(incoming_data.clone());
        return;
    };

    for (key, value) in incoming_data {
        match (key.as_str(), existing_data.get_mut(key), value.as_str()) {
            ("text" | "thinking", Some(Value::String(existing_text)), Some(delta)) => {
                existing_text.push_str(delta);
            }
            ("text" | "thinking", _, Some(delta)) => {
                existing_data.insert(key.clone(), Value::String(delta.to_string()));
            }
            _ => {
                existing_data.insert(key.clone(), value.clone());
            }
        }
    }
}

struct RemoteCertificate {
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCertificate {
    cert: String,
    private_key: String,
    created_at: u64,
}

fn load_persisted_token(data_dir: &Path) -> Option<String> {
    match read_secret_string(data_dir, &data_dir.join(TOKEN_FILE)) {
        SecretJsonRead::Read(token) if !token.is_empty() => Some(token),
        _ => load_legacy_plaintext_token(data_dir),
    }
}

fn load_legacy_plaintext_token(data_dir: &Path) -> Option<String> {
    let path = data_dir.join(LEGACY_TOKEN_FILE);
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    value
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn persist_token(data_dir: &Path, token: &str) {
    let _ = write_secret_string(data_dir, &data_dir.join(TOKEN_FILE), token);
}

fn load_known_device_ids(data_dir: &Path) -> Vec<String> {
    let raw = match fs::read_to_string(data_dir.join(KNOWN_CLIENTS_FILE)) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .as_ref()
        .and_then(|value| value.get("knownDeviceIds"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// Records `device_id` as a known remote client. Returns true when the device
// was not previously known (i.e. this is its first connection ever), persisting
// the updated set so the notification only fires once across app restarts.
fn register_known_remote_device(data_dir: &Path, device_id: &str) -> bool {
    let mut known = load_known_device_ids(data_dir);
    if known.iter().any(|id| id == device_id) {
        return false;
    }
    known.push(device_id.to_string());
    let _ = fs::create_dir_all(data_dir);
    let _ = fs::write(
        data_dir.join(KNOWN_CLIENTS_FILE),
        json!({ "knownDeviceIds": known }).to_string(),
    );
    true
}

fn ensure_remote_certificate(data_dir: &Path) -> Result<RemoteCertificate, String> {
    let cert_path = data_dir.join(CERT_FILE);
    if let SecretJsonRead::Read(stored) =
        read_secret_json::<StoredCertificate>(data_dir, &cert_path)
    {
        if let Ok(cert) = stored_certificate_to_remote(&stored) {
            return Ok(cert);
        }
    }

    let stored = generate_stored_certificate()?;
    let cert = stored_certificate_to_remote(&stored)?;
    let _ = write_secret_json(data_dir, &cert_path, &stored);
    Ok(cert)
}

#[cfg(test)]
fn generate_remote_certificate() -> Result<RemoteCertificate, String> {
    stored_certificate_to_remote(&generate_stored_certificate()?)
}

fn generate_stored_certificate() -> Result<StoredCertificate, String> {
    let subject_alt_names = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    let CertifiedKey { cert, signing_key } = generate_simple_self_signed(subject_alt_names)
        .map_err(|err| format!("remote certificate generation failed: {err}"))?;
    Ok(StoredCertificate {
        cert: cert.pem(),
        private_key: signing_key.serialize_pem(),
        created_at: unix_ms(),
    })
}

fn stored_certificate_to_remote(stored: &StoredCertificate) -> Result<RemoteCertificate, String> {
    let cert_der = pem_to_der(&stored.cert, "CERTIFICATE")
        .ok_or_else(|| "remote certificate PEM parse failed".to_string())?;
    let key_der = pem_to_der(&stored.private_key, "PRIVATE KEY")
        .or_else(|| pem_to_der(&stored.private_key, "RSA PRIVATE KEY"))
        .or_else(|| pem_to_der(&stored.private_key, "EC PRIVATE KEY"))
        .ok_or_else(|| "remote private key PEM parse failed".to_string())?;
    Ok(RemoteCertificate { cert_der, key_der })
}

fn pem_to_der(pem: &str, label: &str) -> Option<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let after_begin = pem.split(&begin).nth(1)?;
    let body = after_begin.split(&end).next()?;
    let encoded = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<String>();
    B64.decode(encoded).ok()
}

fn build_tls_config(cert: &RemoteCertificate) -> Result<ServerConfig, String> {
    let provider = rustls::crypto::ring::default_provider();
    ServerConfig::builder_with_provider(provider.into())
        .with_safe_default_protocol_versions()
        .map_err(|err| format!("remote TLS protocol config failed: {err:?}"))?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.cert_der.clone())],
            PrivateKeyDer::try_from(cert.key_der.clone())
                .map_err(|err| format!("remote TLS private key parse failed: {err}"))?,
        )
        .map_err(|err| format!("remote TLS certificate config failed: {err}"))
}

fn fingerprint_sha256(cert_der: &[u8]) -> String {
    let digest = Sha256::digest(cert_der);
    digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn normalize_bind_interface(value: &str) -> String {
    match value {
        "localhost" | "tailscale" | "all" => value.to_string(),
        _ => "localhost".to_string(),
    }
}

fn generate_token() -> String {
    let bytes = rand::random::<[u8; 16]>();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn start_result(running: &RunningServer) -> Value {
    let token = running
        .token
        .lock()
        .map(|token| token.clone())
        .unwrap_or_default();
    json!({
        "port": running.port,
        "token": token,
        "fingerprint": running.fingerprint,
        "bindInterface": running.bind_interface,
        "boundHost": running.bound_host,
    })
}

fn run_accept_loop(
    listener: TcpListener,
    config: Arc<ServerConfig>,
    token: Arc<Mutex<String>>,
    ctx: HostContext,
    sidecar: SidecarState,
    clients: Arc<Mutex<Vec<RemoteClientRecord>>>,
    recent: Arc<Mutex<Vec<RecentClient>>>,
    active_connections: Arc<AtomicUsize>,
    active_invokes: Arc<AtomicUsize>,
    stop_rx: mpsc::Receiver<()>,
) {
    let mut last_capacity_log = None;
    let mut last_accept_error_log = None;
    loop {
        match stop_rx.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match listener.accept() {
            Ok((stream, addr)) => {
                let Some(connection_slot) =
                    try_acquire_resource_slot(&active_connections, MAX_REMOTE_CONNECTIONS)
                else {
                    let now = Instant::now();
                    if last_capacity_log.is_none_or(|last: Instant| {
                        now.duration_since(last) >= REMOTE_RESOURCE_LOG_INTERVAL
                    }) {
                        crate::commands::app::log_tauri(
                            &ctx,
                            &format!(
                                "[remote-server] connection capacity reached active={} limit={}",
                                active_connections.load(Ordering::Acquire),
                                MAX_REMOTE_CONNECTIONS
                            ),
                        );
                        last_capacity_log = Some(now);
                    }
                    drop(stream);
                    continue;
                };
                let config = Arc::clone(&config);
                let token = Arc::clone(&token);
                let client_ctx = ctx.clone();
                let sidecar = sidecar.clone();
                let clients = Arc::clone(&clients);
                let recent = Arc::clone(&recent);
                let active_invokes = Arc::clone(&active_invokes);
                let peer = addr.to_string();
                remote_debug_log(&ctx, format!("tcp accepted peer={peer}"));
                let spawn_peer = peer.clone();
                if let Err(err) = thread::Builder::new()
                    .name("bat-remote-cli".to_string())
                    .spawn(move || {
                        let _connection_slot = connection_slot;
                        if let Err(err) = handle_client(
                            stream,
                            config,
                            token,
                            client_ctx.clone(),
                            sidecar,
                            clients,
                            recent,
                            active_invokes,
                            spawn_peer.clone(),
                        ) {
                            remote_debug_log(
                                &client_ctx,
                                format!("client closed peer={spawn_peer} error={err}"),
                            );
                        }
                    })
                {
                    crate::commands::app::log_tauri(
                        &ctx,
                        &format!(
                            "[remote-server] client thread start failed peer={peer} active={} error={err}",
                            active_connections.load(Ordering::Acquire)
                        ),
                    );
                }
            }
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => {
                // Resource pressure (for example EMFILE/ENFILE) is recoverable.
                // Keep the listener alive and retry instead of leaving a headless
                // process parked forever with a dead accept loop.
                let now = Instant::now();
                if last_accept_error_log.is_none_or(|last: Instant| {
                    now.duration_since(last) >= REMOTE_RESOURCE_LOG_INTERVAL
                }) {
                    crate::commands::app::log_tauri(
                        &ctx,
                        &format!("[remote-server] accept failed; retrying error={err}"),
                    );
                    last_accept_error_log = Some(now);
                }
                thread::sleep(REMOTE_ACCEPT_RETRY_DELAY);
            }
        }
    }
}

fn handle_client(
    stream: TcpStream,
    config: Arc<ServerConfig>,
    token: Arc<Mutex<String>>,
    ctx: HostContext,
    sidecar: SidecarState,
    clients: Arc<Mutex<Vec<RemoteClientRecord>>>,
    recent: Arc<Mutex<Vec<RecentClient>>>,
    active_invokes: Arc<AtomicUsize>,
    peer: String,
) -> Result<(), String> {
    // Desktop bridge during the app->ctx migration: most of this function still
    // uses `app` directly; the dispatch entry already takes `&HostContext`.
    #[cfg(feature = "desktop")]
    let app = ctx.app().clone();
    stream
        .set_nonblocking(false)
        .map_err(|err| format!("remote stream blocking mode failed: {err}"))?;
    stream
        .set_read_timeout(Some(REMOTE_HANDSHAKE_TIMEOUT))
        .map_err(|err| format!("remote stream timeout failed: {err}"))?;
    stream
        .set_write_timeout(Some(REMOTE_SOCKET_WRITE_TIMEOUT))
        .map_err(|err| format!("remote stream write timeout failed: {err}"))?;
    let connection =
        ServerConnection::new(config).map_err(|err| format!("remote TLS failed: {err}"))?;
    let tls = StreamOwned::new(connection, stream);
    let mut ws = accept_websocket_tls(tls)
        .map_err(|err| format!("remote websocket accept failed: {err}"))?;
    ws.get_mut()
        .sock
        .set_read_timeout(Some(REMOTE_SOCKET_POLL_TIMEOUT))
        .map_err(|err| format!("remote stream polling timeout failed: {err}"))?;
    remote_debug_log(&ctx, format!("websocket accepted peer={peer}"));
    let mut authenticated = false;
    let mut client_label = String::from("Remote Client");
    let mut client_id = String::new();
    let mut client_protocol = RemoteProtocol::LegacyV1;
    let mut client_compression = RemoteCompression::None;
    let (out_tx, out_rx) = mpsc::sync_channel::<Value>(REMOTE_OUTBOUND_QUEUE_CAPACITY);
    let close = Arc::new(AtomicBool::new(false));

    loop {
        if close.load(Ordering::Acquire) {
            remote_debug_log(&ctx, format!("client revoked peer={peer}"));
            break;
        }
        for _ in 0..REMOTE_OUTBOUND_BURST {
            match out_rx.try_recv() {
                Ok(frame) => send_frame(&mut ws, frame, client_compression)?,
                Err(mpsc::TryRecvError::Empty) | Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
        let msg = match ws.read() {
            Ok(msg) => msg,
            Err(tungstenite::Error::Io(err))
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(_) => break,
        };
        let frame = match msg {
            Message::Text(text)
                if !authenticated || client_compression == RemoteCompression::None =>
            {
                match decode_remote_text_frame(&text) {
                    Ok(frame) => frame,
                    Err(_) => continue,
                }
            }
            Message::Binary(bytes)
                if authenticated && client_compression == RemoteCompression::Gzip =>
            {
                match decode_remote_binary_frame(&bytes) {
                    Ok(frame) => frame,
                    Err(_) => continue,
                }
            }
            _ => continue,
        };
        let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
        let id = frame.get("id").cloned().unwrap_or(Value::Null);

        if frame_type == "auth" {
            let current_token = token.lock().map(|token| token.clone()).unwrap_or_default();
            if frame.get("token").and_then(Value::as_str) != Some(current_token.as_str()) {
                remote_debug_log(
                    &ctx,
                    format!("auth failed peer={peer} reason=invalid-token"),
                );
                send_frame(
                    &mut ws,
                    json!({ "type": "auth-result", "id": id, "error": "Invalid token" }),
                    RemoteCompression::None,
                )?;
                break;
            }
            let offered = frame
                .get("protocols")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .or_else(|| {
                    frame
                        .get("protocol")
                        .and_then(Value::as_str)
                        .map(|value| vec![value.to_string()])
                })
                .unwrap_or_default();
            let Some(protocol) = negotiate_remote_protocol(&offered) else {
                remote_debug_log(
                    &ctx,
                    format!(
                        "auth failed peer={peer} reason=unsupported-protocol offered={offered:?}"
                    ),
                );
                send_frame(
                    &mut ws,
                    json!({ "type": "auth-result", "id": id, "error": "Unsupported remote protocol" }),
                    RemoteCompression::None,
                )?;
                break;
            };
            client_protocol = protocol;
            let offered_compression = frame
                .get("compression")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            client_compression = negotiate_remote_compression(&offered_compression);
            let args = frame.get("args").and_then(Value::as_array);
            let context = args.and_then(|args| args.get(1));
            let client_info = context
                .and_then(|value| value.get("clientInfo"))
                .or_else(|| frame.get("clientInfo"))
                .and_then(parse_client_info);
            let label = args
                .and_then(|args| args.first())
                .and_then(Value::as_str)
                .or_else(|| client_info.as_ref().and_then(|info| info.label.as_deref()))
                .unwrap_or("Remote Client")
                .to_string();
            let window_id = context
                .and_then(|value| value.get("windowId"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let device_summary = format_client_device_summary(client_info.as_ref());
            client_label = label.clone();
            let device_id = client_info
                .as_ref()
                .and_then(|info| info.device_id.as_deref())
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
            let protocol_name = protocol.as_str().to_string();
            client_id = format!("{}-{}", unix_ms(), generate_token());
            // Decide before inserting into `clients`, otherwise we'd always
            // find the just-added record and never treat anyone as new.
            // Prefer the persisted device-id set so a known client stays silent
            // across restarts (the unique id the client provides); clients that
            // send no device id fall back to the in-memory live/recent dedup.
            let identity_key = (window_id.clone(), label.clone());
            let already_known = match device_id.as_deref() {
                Some(id) => match ctx.data_dir() {
                    Ok(dir) => !register_known_remote_device(&dir, id),
                    Err(_) => client_already_recorded(&clients, &recent, &identity_key, unix_ms()),
                },
                None => client_already_recorded(&clients, &recent, &identity_key, unix_ms()),
            };
            if let Ok(mut guard) = clients.lock() {
                guard.push(RemoteClientRecord {
                    id: client_id.clone(),
                    info: RemoteClientInfo {
                        label,
                        window_id,
                        client_info,
                        connected_at: unix_ms(),
                        protocol: protocol_name.clone(),
                        compression: client_compression.as_str().to_string(),
                    },
                    tx: out_tx.clone(),
                    close: Arc::clone(&close),
                });
            }
            authenticated = true;
            remote_debug_log(&ctx,
                format!(
                    "auth ok peer={peer} label={client_label}{device_summary} protocol={protocol_name} compression={}",
                    client_compression.as_str()
                ),
            );
            if already_known {
                remote_debug_log(
                    &ctx,
                    format!("known client reconnected; notification skipped label={client_label}"),
                );
            } else {
                notification_cmd::add_remote_client_notification(&ctx, &client_label);
            }
            // Echo the host's app version so the client can detect
            // client/server skew and warn (issue #115 was triggered by a
            // 3.1.22 server still running while clients had moved past it;
            // pre-validation hosts that lacked the windowId fixes corrupted
            // shared workspace state). Surfacing the mismatch turns a silent
            // protocol gap into something diagnosable on first connect.
            let server_version = ctx.version();
            send_frame(
                &mut ws,
                json!({
                    "type": "auth-result",
                    "id": id,
                    "result": true,
                    "protocol": protocol_name,
                    "compression": client_compression.as_str(),
                    "serverVersion": server_version,
                    "capabilities": remote_capabilities(),
                }),
                RemoteCompression::None,
            )?;
            continue;
        }

        if !authenticated {
            break;
        }
        if frame_type == "ping" {
            send_frame(
                &mut ws,
                json!({ "type": "pong", "id": id }),
                client_compression,
            )?;
            continue;
        }
        if frame_type == "invoke" {
            let channel = frame
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            log_remote_pty_write_frame(&ctx, "remote-server.recv-frame", &channel, &frame);
            remote_debug_log(&ctx, format!("invoke start peer={peer} channel={channel}"));
            let Some(invoke_slot) = try_acquire_resource_slot(&active_invokes, MAX_REMOTE_INVOKES)
            else {
                send_frame(
                    &mut ws,
                    json!({
                        "type": "invoke-error",
                        "id": id,
                        "error": "Remote server is busy; retry this request shortly"
                    }),
                    client_compression,
                )?;
                continue;
            };
            let invoke_app = ctx.clone();
            let invoke_ctx = ctx.clone();
            let invoke_sidecar = sidecar.clone();
            let invoke_peer = peer.clone();
            let invoke_frame = frame.clone();
            let invoke_tx = out_tx.clone();
            let invoke_close = Arc::clone(&close);
            let spawn_id = id.clone();
            let spawn_channel = channel.clone();
            if let Err(err) = thread::Builder::new()
                .name("bat-remote-inv".to_string())
                .spawn(move || {
                    let _invoke_slot = invoke_slot;
                    let result = invoke_sidecar_for_remote(
                        &invoke_ctx,
                        &invoke_sidecar,
                        client_protocol,
                        &channel,
                        &invoke_frame,
                    );
                    let response = match result {
                        Ok(value) => {
                            remote_debug_log(
                                &invoke_app,
                                format!("invoke ok peer={invoke_peer} channel={channel}"),
                            );
                            json!({ "type": "invoke-result", "id": id, "result": value })
                        }
                        Err(err) => {
                            remote_debug_log(
                                &invoke_app,
                                format!(
                                    "invoke error peer={invoke_peer} channel={channel} error={err}"
                                ),
                            );
                            json!({ "type": "invoke-error", "id": id, "error": err })
                        }
                    };
                    let _ = try_queue_remote_frame(&invoke_tx, &invoke_close, response);
                })
            {
                crate::commands::app::log_tauri(
                    &ctx,
                    &format!(
                        "[remote-server] invoke thread start failed peer={peer} channel={spawn_channel} active={} error={err}",
                        active_invokes.load(Ordering::Acquire)
                    ),
                );
                send_frame(
                    &mut ws,
                    json!({
                        "type": "invoke-error",
                        "id": spawn_id,
                        "error": "Remote server could not start this request; retry shortly"
                    }),
                    client_compression,
                )?;
            }
            continue;
        }
    }
    let now = unix_ms();
    let mut removed: Vec<RemoteClientInfo> = Vec::new();
    if let Ok(mut guard) = clients.lock() {
        guard.retain(|client| {
            let keep = if client_id.is_empty() {
                client.info.label != client_label
            } else {
                client.id != client_id
            };
            if !keep {
                removed.push(client.info.clone());
            }
            keep
        });
    }
    for info in removed {
        record_recent_client(&recent, info, now);
    }
    Ok(())
}

fn parse_client_info(value: &Value) -> Option<RemoteClientDeviceInfo> {
    serde_json::from_value::<RemoteClientDeviceInfo>(value.clone()).ok()
}

fn format_client_device_summary(info: Option<&RemoteClientDeviceInfo>) -> String {
    let Some(info) = info else {
        return String::new();
    };
    let mut parts = Vec::new();
    if let Some(device_name) = info
        .device_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(device_name.to_string());
    }
    if let Some(platform) = info
        .platform
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        match info
            .os_version
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            Some(os_version) => parts.push(format!("{platform} {os_version}")),
            None => parts.push(platform.to_string()),
        }
    }
    if let Some(app_version) = info
        .app_version
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(format!("app {app_version}"));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" device={}", parts.join(" / "))
    }
}

fn remote_debug_enabled() -> bool {
    matches!(std::env::var("BAT_DEBUG").as_deref(), Ok("1") | Ok("true"))
}

/// Mirror the local `claude_start_session` bookkeeping for a session a remote
/// client is establishing.
///
/// Locally every session-establishing command registers the session in
/// `AgentNotificationState` (commands/claude.rs) before routing to a runtime.
/// The remote path returns to the client before reaching that code, so without
/// this the host never learns a remote session exists: it cannot capture
/// `sdkSessionId` off `claude:status` (notification.rs bails on an unknown
/// session), cannot raise a completion notification when the turn ends, and
/// answers every read-only probe with "no such session".
///
/// Failures are logged, not propagated: registration is bookkeeping, and a
/// remote client that cannot start a session because of it would be strictly
/// worse off than before.
fn register_remote_agent_session(ctx: &HostContext, channel: &str, params: &Value) {
    if !matches!(
        channel,
        "claude:start-session" | "claude:resume-session" | "claude:client-resume"
    ) {
        return;
    }
    let Ok(session_id) = string_param(params, "sessionId", channel) else {
        return;
    };
    let options = params.get("options").cloned().unwrap_or(Value::Null);
    if let Err(err) = notification_cmd::register_agent_session_from_options(
        ctx,
        REMOTE_AGENT_SESSION_WINDOW,
        &session_id,
        Some(&options),
    ) {
        remote_debug_log(
            ctx,
            format!("{channel}: register agent session failed: {err}"),
        );
    }
}

fn remote_debug_log(app: &HostContext, message: impl AsRef<str>) {
    if remote_debug_enabled() {
        crate::commands::app::log_tauri(app, &format!("[remote-server] {}", message.as_ref()));
    }
}

fn log_remote_pty_write_data(app: &HostContext, phase: &str, id: &str, data: &str) {
    if !pty_cmd::pty_input_trace_required(data) {
        return;
    }
    pty_cmd::pty_input_debug_log(
        app,
        format!("{phase} id={id} {}", pty_cmd::describe_pty_input(data)),
    );
}

fn log_remote_pty_write_args(app: &HostContext, phase: &str, channel: &str, args: &[Value]) {
    if canonical_remote_channel(channel) != "pty:write" {
        return;
    }
    let Some(id) = args.first().and_then(Value::as_str) else {
        return;
    };
    let Some(data) = args.get(1).and_then(Value::as_str) else {
        return;
    };
    log_remote_pty_write_data(app, phase, id, data);
}

fn log_remote_pty_write_params(app: &HostContext, phase: &str, channel: &str, params: &Value) {
    if canonical_remote_channel(channel) != "pty:write" {
        return;
    }
    let Some(id) = params.get("id").and_then(Value::as_str) else {
        return;
    };
    let Some(data) = params.get("data").and_then(Value::as_str) else {
        return;
    };
    log_remote_pty_write_data(app, phase, id, data);
}

fn log_remote_pty_write_frame(app: &HostContext, phase: &str, channel: &str, frame: &Value) {
    let args = frame
        .get("args")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    log_remote_pty_write_args(app, phase, channel, args);
    if let Some(params) = frame.get("params") {
        log_remote_pty_write_params(app, phase, channel, params);
    }
}

fn accept_websocket_tls(
    mut tls: StreamOwned<ServerConnection, TcpStream>,
) -> Result<WebSocket<StreamOwned<ServerConnection, TcpStream>>, String> {
    let mut request = Vec::with_capacity(1024);
    let mut buf = [0_u8; 1024];
    let deadline = Instant::now() + REMOTE_HANDSHAKE_TIMEOUT;
    while request.len() < 16 * 1024 {
        let n = match tls.read(&mut buf) {
            Ok(n) => n,
            Err(err)
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut =>
            {
                if Instant::now() >= deadline {
                    return Err("websocket request read timed out".to_string());
                }
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(err) => return Err(format!("websocket request read failed: {err}")),
        };
        if n == 0 {
            return Err("websocket request closed before headers".to_string());
        }
        request.extend_from_slice(&buf[..n]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    if !request.windows(4).any(|window| window == b"\r\n\r\n") {
        return Err("websocket request headers too large".to_string());
    }

    let accept_key = websocket_accept_key_from_request(&request)?;
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept_key}\r\n\
         \r\n"
    );
    tls.write_all(response.as_bytes())
        .map_err(|err| format!("websocket response write failed: {err}"))?;
    tls.flush()
        .map_err(|err| format!("websocket response flush failed: {err}"))?;

    Ok(WebSocket::from_raw_socket(tls, Role::Server, None))
}

fn websocket_accept_key_from_request(request: &[u8]) -> Result<String, String> {
    let header_end = request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "websocket request missing header terminator".to_string())?;
    let raw = std::str::from_utf8(&request[..header_end])
        .map_err(|err| format!("websocket request headers are not utf-8: {err}"))?;
    let mut lines = raw.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    if !request_line.starts_with("GET ") {
        return Err("websocket request must use GET".to_string());
    }

    let mut upgrade_ok = false;
    let mut connection_ok = false;
    let mut version_ok = false;
    let mut key = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "upgrade" => upgrade_ok = value.eq_ignore_ascii_case("websocket"),
            "connection" => {
                connection_ok = value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
            }
            "sec-websocket-version" => version_ok = value == "13",
            "sec-websocket-key" => key = Some(value.to_string()),
            _ => {}
        }
    }
    if !upgrade_ok {
        return Err("websocket request missing Upgrade: websocket".to_string());
    }
    if !connection_ok {
        return Err("websocket request missing Connection: Upgrade".to_string());
    }
    if !version_ok {
        return Err("websocket request missing Sec-WebSocket-Version: 13".to_string());
    }
    let key = key.ok_or_else(|| "websocket request missing Sec-WebSocket-Key".to_string())?;
    let key_bytes = B64
        .decode(&key)
        .map_err(|_| "websocket request has invalid Sec-WebSocket-Key".to_string())?;
    if key_bytes.len() != 16 {
        return Err("websocket request Sec-WebSocket-Key must decode to 16 bytes".to_string());
    }
    Ok(derive_accept_key(key.as_bytes()))
}

fn invoke_sidecar_for_remote(
    ctx: &HostContext,
    sidecar: &SidecarState,
    protocol: RemoteProtocol,
    channel: &str,
    frame: &Value,
) -> Result<Value, String> {
    if channel.is_empty() {
        return Err("remote invoke: missing channel".to_string());
    }
    let dispatch_channel = canonical_remote_channel(channel);
    let channel = dispatch_channel.as_str();
    let args = frame
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut params = match protocol {
        RemoteProtocol::V2 => frame
            .get("params")
            .cloned()
            .unwrap_or_else(|| legacy_v1_args_to_params(channel, &args)),
        RemoteProtocol::LegacyV1 => legacy_v1_args_to_params(channel, &args),
    };
    if matches!(
        channel,
        "claude:auth-login-submit-code" | "claude:auth-login-cancel"
    ) {
        if !params.is_object() {
            params = json!({});
        }
        if let Some(map) = params.as_object_mut() {
            map.insert("deferRelease".to_string(), Value::Bool(true));
        }
        let requested_login_id = params
            .get("loginId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        if !touch_claude_remote_login(requested_login_id) {
            return Ok(json!({
                "ok": false,
                "success": false,
                "error": "invalid login session",
                "terminal": false,
            }));
        }
    }
    log_remote_pty_write_params(&ctx, "remote-server.decoded", channel, &params);
    // Ahead of the dispatch below so it covers both runtimes: Codex is served
    // natively by invoke_rust_for_remote, Claude is forwarded to the sidecar,
    // and locally both are registered by the same claude_start_session call.
    register_remote_agent_session(ctx, channel, &params);
    if let Some(result) = invoke_rust_for_remote(ctx, channel, &params) {
        return result;
    }
    let claimed_claude_login = channel == "claude:auth-login-start";
    if claimed_claude_login {
        if !try_begin_claude_remote_login() {
            return Ok(json!({
                "ok": false,
                "error": "auth_in_progress",
                "terminal": false,
            }));
        }
    }
    let method = channel_to_sidecar_method(channel);
    let cfg = ctx.sidecar_spawn_config().map_err(|err| err.message)?;
    let sink = ctx.sidecar_emit_sink();
    let timeout = remote_invoke_timeout(channel);
    let result = match sidecar.call_with_emit(&cfg, Some(sink), &method, params, timeout) {
        Ok(result) => result,
        Err(err) => {
            if claimed_claude_login {
                clear_claude_remote_login_started();
            }
            return Err(err.message);
        }
    };
    let login_id = result
        .get("loginId")
        .and_then(Value::as_str)
        .map(str::to_string);
    if claimed_claude_login && result.get("ok").and_then(Value::as_bool) == Some(true) {
        bind_claude_remote_login_id(login_id.as_deref());
    }
    let terminal = result
        .get("terminal")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let finished = finish_remote_claude_login(ctx, channel, result);
    if terminal || finished.is_err() {
        clear_claude_remote_login_started();
    }
    if (terminal || finished.is_err()) && login_id.is_some() {
        let release_sink = ctx.sidecar_emit_sink();
        let _ = sidecar.call_with_emit(
            &cfg,
            Some(release_sink),
            "claude.authLoginRelease",
            json!({ "loginId": login_id }),
            INVOKE_TIMEOUT,
        );
    }
    finished
}

// Shared with the desktop paste-code commands — see
// claude_cmd::finish_claude_login_stage for the bookkeeping itself.
fn finish_remote_claude_login(
    ctx: &HostContext,
    channel: &str,
    result: Value,
) -> Result<Value, String> {
    let stage = match channel {
        "claude:auth-login-start" => claude_cmd::ClaudeLoginStage::Start,
        "claude:auth-login-submit-code" => claude_cmd::ClaudeLoginStage::SubmitCode,
        "claude:auth-login-cancel" => claude_cmd::ClaudeLoginStage::Cancel,
        _ => return Ok(result),
    };
    claude_cmd::finish_claude_login_stage(ctx, stage, channel, result)
}

fn profile_id_from_params(channel: &str, params: &Value) -> Result<String, String> {
    let profile_id = params
        .get("profileId")
        .and_then(Value::as_str)
        .or_else(|| params.as_str())
        .unwrap_or("")
        .trim();
    if profile_id.is_empty() {
        Err(format!("{channel}: profileId is required"))
    } else {
        Ok(profile_id.to_string())
    }
}

fn string_param(params: &Value, key: &str, method: &str) -> Result<String, String> {
    string_param_any(params, &[key], method)
}

fn string_param_any(params: &Value, keys: &[&str], method: &str) -> Result<String, String> {
    if let Some(value) = params.as_str() {
        return Ok(value.to_string());
    }
    for key in keys {
        if let Some(value) = params.get(*key).and_then(Value::as_str) {
            return Ok(value.to_string());
        }
    }
    Err(format!(
        "{method}: missing {}",
        keys.first().copied().unwrap_or("string")
    ))
}

fn optional_string_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn i64_param(params: &Value, key: &str, method: &str) -> Result<i64, String> {
    if let Some(value) = params.as_i64() {
        return Ok(value);
    }
    params
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("{method}: missing {key}"))
}

fn u32_param(params: &Value, key: &str, method: &str) -> Result<u32, String> {
    let value = i64_param(params, key, method)?;
    u32::try_from(value).map_err(|_| format!("{method}: invalid {key}"))
}

fn u16_param(params: &Value, key: &str, method: &str) -> Result<u16, String> {
    let value = i64_param(params, key, method)?;
    u16::try_from(value).map_err(|_| format!("{method}: invalid {key}"))
}

fn remote_app_data_dir(ctx: &HostContext, method: &str) -> Result<std::path::PathBuf, String> {
    ctx.data_dir()
        .map_err(|err| format!("{method}: could not resolve app data dir: {err}"))
}

fn bool_param(params: &Value, key: &str, default: bool) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn string_vec_param(params: &Value, key: &str, method: &str) -> Result<Vec<String>, String> {
    let Some(values) = params.get(key).and_then(Value::as_array) else {
        return Err(format!("{method}: missing {key}"));
    };
    Ok(values
        .iter()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect())
}

fn optional_string_vec_param(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn deserialize_param<T: DeserializeOwned>(
    value: Value,
    method: &str,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(value).map_err(|err| format!("{method}: invalid {key}: {err}"))
}

fn to_json_value<T: Serialize>(method: &str, value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|err| format!("{method} serialization failed: {err}"))
}

fn bridge_error_message(err: crate::sidecar::BridgeError) -> String {
    err.message
}

fn codex_for_remote_session(
    ctx: &HostContext,
    channel: &str,
    params: &Value,
) -> Option<Result<(CodexAppServerState, String), String>> {
    let session_id = match string_param(params, "sessionId", channel) {
        Ok(value) => value,
        Err(err) => return Some(Err(err)),
    };
    let codex = ctx.state::<CodexAppServerState>();
    if !codex.is_owned(&session_id) {
        return None;
    }
    Some(Ok((codex, session_id)))
}

fn invoke_rust_for_remote(
    ctx: &HostContext,
    channel: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    // Desktop bridge during the app->ctx migration: the match arms below still
    // use `app` (and the helpers they call) directly. Arms get migrated to the
    // ctx accessors module-group by module-group.
    #[cfg(feature = "desktop")]
    let app = ctx.app();
    let result = match channel {
        "app:get-version" => Ok(json!({
            "version": ctx.version(),
            "protocol": REMOTE_PROTOCOL_V2,
        })),
        #[cfg(feature = "desktop")]
        "app:new-window" => profile_id_from_params(channel, params)
            .map(|profile_id| Value::String(app_cmd::app_new_window_for_profile(app, &profile_id))),
        // Let a paired remote client (e.g. BAT Mobile) drive the desktop host's
        // self-update: check the per-channel manifest, download+install the new
        // bundle, then relaunch so it takes effect. Channel defaults to "stable".
        #[cfg(feature = "desktop")]
        "app:check-update" => {
            let update_channel =
                optional_string_param(params, "channel").unwrap_or_else(|| "stable".to_string());
            crate::async_rt::block_on(update_cmd::update_check_native(app.clone(), update_channel))
                .map_err(bridge_error_message)
        }
        #[cfg(feature = "desktop")]
        "app:install-update" => {
            let update_channel =
                optional_string_param(params, "channel").unwrap_or_else(|| "stable".to_string());
            crate::async_rt::block_on(update_cmd::update_install(app.clone(), update_channel))
                .map_err(bridge_error_message)
        }
        #[cfg(feature = "desktop")]
        "app:relaunch" => {
            // Ack first, then relaunch on a detached thread so the response
            // frame flushes to the client before the process restarts.
            let restart_app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                restart_app.restart();
            });
            Ok(json!({ "ok": true }))
        }
        // GUI / self-update of the app bundle: meaningless on a headless server
        // (no window, not an updatable bundle). Return a clear error instead.
        #[cfg(not(feature = "desktop"))]
        "app:new-window" | "app:check-update" | "app:install-update" | "app:relaunch" => {
            Err(format!("{channel}: not supported on a headless bat-server"))
        }
        "agent:get-supported-session-types" => Ok(agent_cmd::agent_supported_session_type_ids()),
        "agent:list-presets" => Ok(agent_cmd::agent_supported_session_presets()),
        "claude:start-session" => {
            let options = params.get("options").cloned().unwrap_or(Value::Null);
            let maybe_options = Some(options.clone());
            if !should_handle_codex(&maybe_options) {
                return None;
            }
            string_param(params, "sessionId", channel).and_then(|session_id| {
                let codex = ctx.state::<CodexAppServerState>();
                codex
                    .start_session(&ctx, session_id, maybe_options)
                    .map_err(bridge_error_message)
            })
        }
        "claude:resume-session" => {
            let options = params.get("options").cloned().unwrap_or(Value::Null);
            let maybe_options = Some(options.clone());
            if !should_handle_codex(&maybe_options) {
                return None;
            }
            string_param(params, "sessionId", channel).and_then(|session_id| {
                string_param(params, "sdkSessionId", channel).and_then(|sdk_session_id| {
                    let codex = ctx.state::<CodexAppServerState>();
                    codex
                        .resume_session(&ctx, session_id, sdk_session_id, maybe_options)
                        .map_err(bridge_error_message)
                })
            })
        }
        "claude:send-message" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.and_then(|(codex, session_id)| {
                let prompt = string_param(params, "prompt", channel)?;
                let images = optional_string_vec_param(params, "images");
                codex
                    .send_message(&ctx, session_id, prompt, images)
                    .map_err(bridge_error_message)
            })
        }
        "claude:abort-session" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.and_then(|(codex, session_id)| {
                codex
                    .abort_session(&ctx, session_id)
                    .map_err(bridge_error_message)
            })
        }
        "claude:stop-session" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|(codex, session_id)| codex.stop_session(session_id))
        }
        "claude:get-supported-models" => match codex_for_remote_session(ctx, channel, params) {
            Some(route) => route.map(|(codex, _)| codex.supported_models()),
            None => Ok(claude_cmd::claude_builtin_models_native()),
        },
        "claude:get-supported-efforts" => match codex_for_remote_session(ctx, channel, params) {
            Some(route) => route.map(|(codex, _)| codex.supported_efforts()),
            None => Ok(claude_cmd::claude_supported_efforts_native()),
        },
        "claude:get-supported-codex-sandbox-modes" => {
            match codex_for_remote_session(ctx, channel, params) {
                Some(route) => route.map(|(codex, _)| codex.supported_sandbox_modes()),
                None => Ok(claude_cmd::codex_supported_sandbox_modes_native()),
            }
        }
        "claude:get-supported-codex-approval-policies" => {
            match codex_for_remote_session(ctx, channel, params) {
                Some(route) => route.map(|(codex, _)| codex.supported_approval_policies()),
                None => Ok(claude_cmd::codex_supported_approval_policies_native()),
            }
        }
        "claude:get-supported-commands" | "claude:get-supported-agents" => {
            match codex_for_remote_session(ctx, channel, params) {
                Some(route) => route.map(|_| json!([])),
                None => string_param(params, "sessionId", channel).and_then(|session_id| {
                    let Some(session) =
                        notification_cmd::get_agent_session_snapshot(&ctx, &session_id)
                    else {
                        return Ok(json!([]));
                    };
                    if channel == "claude:get-supported-commands" {
                        serde_json::to_value(claude_cmd::supported_commands_native(Path::new(
                            &session.cwd,
                        )))
                        .map_err(|err| format!("{channel} serialization failed: {err}"))
                    } else {
                        serde_json::to_value(claude_cmd::supported_agents_native(Path::new(
                            &session.cwd,
                        )))
                        .map_err(|err| format!("{channel} serialization failed: {err}"))
                    }
                }),
            }
        }
        "claude:get-account-info" => match codex_for_remote_session(ctx, channel, params) {
            Some(route) => route.map(|_| Value::Null),
            None => Ok(claude_cmd::account_info_from_auth_status(
                &claude_cmd::fetch_auth_status_native(&ctx),
            )),
        },
        // The three probes below answer from the host's session map when it
        // knows the session, and otherwise fall through (`return None`) to the
        // sidecar, which owns the live Claude session. Reporting Null instead
        // would be a lie the client cannot tell apart from "no such session":
        // it drops the panel into a destructive resume that tears down a turn
        // the host is still streaming, and leaves the transcript unreplayed.
        "claude:get-session-state" => match codex_for_remote_session(ctx, channel, params) {
            Some(route) => route.map(|(codex, session_id)| {
                codex.get_session_state(&session_id).unwrap_or(Value::Null)
            }),
            // Unlike the meta probe below, this one must NOT answer from the
            // notification snapshot. That snapshot has no isStreaming,
            // streamingText, messages or pending-prompt fields at all (see
            // AgentNotificationSession), and a client reads a missing
            // isStreaming as false. So answering from it actively told every
            // remote client that a mid-turn session was idle -- connect to a
            // host that is working and the panel sits silent -- and hid the
            // question a blocked turn was waiting on, which is the whole point
            // of returning pendingAskUser/pendingPermission here.
            //
            // Falling through to the sidecar is not a downgrade: the sidecar
            // owns every live Claude session, so it either knows the session
            // and answers with all of the above, or nothing on this host does
            // and Null is the honest answer rather than a stub that claims the
            // session exists but is doing nothing.
            None => return None,
        },
        "claude:get-session-meta" => match codex_for_remote_session(ctx, channel, params) {
            Some(route) => route.map(|(codex, session_id)| {
                codex.get_session_meta(&session_id).unwrap_or(Value::Null)
            }),
            None => match string_param(params, "sessionId", channel) {
                Ok(session_id) => {
                    match notification_cmd::get_agent_session_snapshot(&ctx, &session_id) {
                        Some(session) => {
                            Ok(claude_cmd::session_meta_from_notification_snapshot(&session))
                        }
                        None => return None,
                    }
                }
                Err(err) => Err(err),
            },
        },
        "claude:get-context-usage" => match codex_for_remote_session(ctx, channel, params) {
            Some(route) => route.map(|(codex, session_id)| {
                codex.get_context_usage(&session_id).unwrap_or(Value::Null)
            }),
            None => match string_param(params, "sessionId", channel) {
                Ok(session_id) => {
                    match notification_cmd::get_agent_session_snapshot(&ctx, &session_id)
                        .and_then(|session| {
                            claude_cmd::context_usage_from_notification_snapshot(&session)
                        }) {
                        Some(usage) => Ok(usage),
                        None => return None,
                    }
                }
                Err(err) => Err(err),
            },
        },
        "claude:set-auto-continue" | "claude:set-permission-mode" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|_| json!(false))
        }
        "claude:get-auto-continue" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|_| Value::Null)
        }
        "claude:set-codex-sandbox-mode" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.and_then(|(codex, session_id)| {
                let mode = string_param(params, "mode", channel)?;
                let _ = codex.set_sandbox_mode(&ctx, &session_id, mode);
                codex
                    .reconfigure_session(&ctx, &session_id)
                    .map_err(bridge_error_message)
            })
        }
        "claude:set-codex-approval-policy" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.and_then(|(codex, session_id)| {
                let policy = string_param(params, "policy", channel)?;
                let _ = codex.set_approval_policy(&ctx, &session_id, policy);
                codex
                    .reconfigure_session(&ctx, &session_id)
                    .map_err(bridge_error_message)
            })
        }
        "claude:set-model" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.and_then(|(codex, session_id)| {
                let model = string_param(params, "model", channel)?;
                Ok(codex
                    .set_model(&ctx, &session_id, model)
                    .unwrap_or_else(|| json!(false)))
            })
        }
        "claude:set-effort" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.and_then(|(codex, session_id)| {
                let effort = string_param(params, "effort", channel)?;
                Ok(codex
                    .set_effort(&ctx, &session_id, effort)
                    .unwrap_or_else(|| json!(false)))
            })
        }
        "claude:reset-session" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.and_then(|(codex, session_id)| {
                codex
                    .reset_session(&ctx, session_id)
                    .map_err(bridge_error_message)
            })
        }
        "claude:rest-session" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|(codex, session_id)| {
                codex.rest_session(&ctx, &session_id).unwrap_or(Value::Null)
            })
        }
        "claude:wake-session" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|(codex, session_id)| codex.wake_session(&session_id).unwrap_or(Value::Null))
        }
        "claude:is-resting" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|(codex, session_id)| codex.is_resting(&session_id).unwrap_or(Value::Null))
        }
        "claude:fork-session" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|_| Value::Null)
        }
        "claude:fetch-subagent-messages" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|_| json!([]))
        }
        "claude:rewind-to-prompt" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|_| json!({ "error": "Rewind not supported for this session type" }))
        }
        "claude:resolve-permission" => {
            // Codex sessions have real approval prompts now; route the remote
            // client's answer into the bridge so the JSON-RPC request gets a
            // response (a stubbed `false` here leaves codex blocked).
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.and_then(|(codex, session_id)| {
                let tool_use_id = string_param(params, "toolUseId", channel)?;
                let result = params.get("result").cloned().unwrap_or(Value::Null);
                codex
                    .resolve_permission(&ctx, &session_id, &tool_use_id, &result)
                    .map_err(bridge_error_message)
            })
        }
        "claude:resolve-ask-user" | "claude:stop-task" => {
            let Some(route) = codex_for_remote_session(ctx, channel, params) else {
                return None;
            };
            route.map(|_| json!(false))
        }
        // Pull path for host-owned usage data, mirroring the renderer cache's
        // startup pull. The broadcast alone is lossy for a remote client in a way
        // it is not for the local webview: a phone connects at an arbitrary moment
        // rather than alongside host startup, so landing between two 150s poller
        // ticks is the norm, not the exception. Read-only, no sessionId, no side
        // effects — hand back the stored map untouched, since the client parses it
        // through the same code path as the broadcast. `{}` is a valid answer
        // meaning "the poller has not landed a snapshot yet".
        //
        // Not desktop-gated: the poller runs on the headless bat-server too, so a
        // client paired with a headless host gets real numbers here. `agent:` is
        // the name to keep; the `claude:` spelling is accepted only for a client
        // that tries the legacy name first.
        "agent:usage-snapshot" | "claude:usage-snapshot" => {
            Ok(claude_usage::agent_usage_snapshot())
        }
        // Response-time samples belong to whichever machine made the API calls,
        // which in remote mode is the host. A client reading its own would show
        // an empty page, so this is host-owned like usage: read-only, no side
        // effects, and the client renders whatever the host returns.
        "agent:latency-samples" => remote_app_data_dir(ctx, channel).and_then(|data_dir| {
            // Both bounds required. Defaulting a missing one would hand back
            // whatever range happened to be convenient, and a statistics page
            // silently showing the wrong window is worse than an error.
            let from_ms = i64_param(params, "fromMs", channel)?;
            let to_ms = i64_param(params, "toMs", channel)?;
            Ok(latency_store::latency_samples_core(&data_dir, from_ms, to_ms))
        }),
        "claude:auth-status" => Ok(claude_cmd::fetch_auth_status_native(&ctx)),
        "claude:account-list" => remote_app_data_dir(ctx, channel).and_then(|data_dir| {
            serde_json::to_value(account_store::read_index(&data_dir))
                .map_err(|err| format!("{channel} serialization failed: {err}"))
        }),
        // These three mutate host-owned account state on behalf of one client,
        // so they announce the result to *everyone* — the requesting client
        // gets its answer via the invoke reply, and the host's own windows plus
        // any other connected client repaint off the broadcast.
        "claude:account-switch" => while_claude_remote_login_idle(|| {
            string_param(params, "accountId", channel).and_then(|account_id| {
                let data_dir = remote_app_data_dir(ctx, channel)?;
                let ok = account_store::switch_account(&data_dir, &account_id)
                    .map_err(|err| err.to_string())?;
                if ok {
                    claude_cmd::broadcast_account_changed(ctx, "claude", Some(&account_id));
                }
                Ok(Value::Bool(ok))
            })
        }),
        "claude:account-remove" => while_claude_remote_login_idle(|| {
            string_param(params, "accountId", channel).and_then(|account_id| {
                let data_dir = remote_app_data_dir(ctx, channel)?;
                let ok = account_store::remove_account(&data_dir, &account_id)
                    .map_err(|err| err.to_string())?;
                if ok {
                    claude_cmd::broadcast_account_changed(ctx, "claude", Some(&account_id));
                }
                Ok(Value::Bool(ok))
            })
        }),
        "codex:account-list" => {
            let codex = ctx.state::<CodexAppServerState>();
            Ok(codex.account_list(&ctx))
        }
        "codex:account-switch" => {
            string_param(params, "codexHome", channel).and_then(|codex_home| {
                let codex = ctx.state::<CodexAppServerState>();
                let result = codex.switch_account(&ctx, codex_home)?;
                if result.get("success").and_then(Value::as_bool) == Some(true) {
                    claude_cmd::broadcast_account_changed(ctx, "codex", None);
                }
                Ok(result)
            })
        }
        "codex:auth-login-device-start" => {
            let codex = ctx.state::<CodexAppServerState>();
            codex.account_login_device_start(&ctx)
        }
        "codex:auth-login-device-poll" => {
            let codex = ctx.state::<CodexAppServerState>();
            let login_id = optional_string_param(params, "loginId");
            codex.account_login_device_poll(&ctx, login_id.as_deref())
        }
        "codex:auth-login-device-cancel" => {
            let codex = ctx.state::<CodexAppServerState>();
            let login_id = optional_string_param(params, "loginId");
            codex.account_login_device_cancel(&ctx, login_id.as_deref())
        }
        "claude:account-mark-warning-shown" => {
            remote_app_data_dir(ctx, channel).and_then(|data_dir| {
                account_store::mark_warning_shown(&data_dir)
                    .map(|_| Value::Bool(true))
                    .map_err(|err| err.to_string())
            })
        }
        "claude:get-cli-path" => Ok(Value::String(claude_cmd::resolve_claude_cli_path(&ctx))),
        "claude:prepare-cli-session" => {
            string_param(params, "terminalId", channel).and_then(|terminal_id| {
                string_param(params, "workspaceId", channel).and_then(|workspace_id| {
                    string_param(params, "cwd", channel).and_then(|cwd| {
                        string_param(params, "agentPreset", channel).and_then(|agent_preset| {
                            let current_session_id =
                                optional_string_param(params, "currentSessionId");
                            claude_cmd::prepare_cli_session_native(
                                &ctx,
                                terminal_id,
                                workspace_id,
                                cwd,
                                agent_preset,
                                current_session_id,
                            )
                            .map_err(bridge_error_message)
                        })
                    })
                })
            })
        }
        "claude:list-sessions" => string_param(params, "cwd", channel).and_then(|cwd| {
            let agent_kind = optional_string_param(params, "agentKind");
            serde_json::to_value(claude_cmd::list_sessions_native(
                &cwd,
                agent_kind.as_deref(),
            ))
            .map_err(|err| format!("{channel} serialization failed: {err}"))
        }),
        "claude:archive-messages" => {
            string_param(params, "sessionId", channel).and_then(|session_id| {
                let messages = params.get("messages").cloned().unwrap_or(Value::Null);
                let data_dir = remote_app_data_dir(ctx, channel)?;
                claude_cmd::archive_messages_in_dir(&data_dir, &session_id, &messages)
                    .map(|value| json!(value))
                    .map_err(|err| err.to_string())
            })
        }
        "claude:load-archived" => {
            string_param(params, "sessionId", channel).and_then(|session_id| {
                u32_param(params, "offset", channel).and_then(|offset| {
                    u32_param(params, "limit", channel).and_then(|limit| {
                        let data_dir = remote_app_data_dir(ctx, channel)?;
                        Ok(claude_cmd::load_archived_from_dir(
                            &data_dir,
                            &session_id,
                            offset,
                            limit,
                        ))
                    })
                })
            })
        }
        "claude:clear-archive" => {
            string_param(params, "sessionId", channel).and_then(|session_id| {
                let data_dir = remote_app_data_dir(ctx, channel)?;
                Ok(json!(claude_cmd::clear_archive_in_dir(
                    &data_dir,
                    &session_id
                )))
            })
        }
        "claude:scan-skills" => string_param(params, "cwd", channel).and_then(|cwd| {
            serde_json::to_value(claude_cmd::scan_skills_native(Path::new(&cwd)))
                .map_err(|err| format!("{channel} serialization failed: {err}"))
        }),
        "claude:check-mcp-json-status" => string_param(params, "cwd", channel)
            .map(|cwd| claude_cmd::check_mcp_json_status_native(Path::new(&cwd))),
        "claude:enable-all-project-mcp" => string_param(params, "cwd", channel).and_then(|cwd| {
            claude_cmd::enable_all_project_mcp_native(Path::new(&cwd)).map_err(bridge_error_message)
        }),
        "claude:get-worktree-status" => {
            string_param(params, "sessionId", channel).map(|session_id| {
                notification_cmd::get_agent_session_snapshot(&ctx, &session_id)
                    .and_then(|session| {
                        claude_cmd::worktree_status_from_notification_snapshot(&session)
                    })
                    .unwrap_or(Value::Null)
            })
        }
        "claude:cleanup-worktree" => string_param(params, "sessionId", channel).map(|session_id| {
            let delete_branch = bool_param(params, "deleteBranch", true);
            if let Some(session) = notification_cmd::get_agent_session_snapshot(&ctx, &session_id) {
                if claude_cmd::cleanup_worktree_from_notification_snapshot(&session, delete_branch)
                {
                    notification_cmd::clear_agent_session_worktree(&ctx, &session_id);
                    return json!(true);
                }
            }
            json!(false)
        }),
        "settings:load" => remote_app_data_dir(ctx, channel).and_then(|dir| {
            settings_cmd::settings_load_impl(&dir)
                .map_err(|err| err.to_string())
                .and_then(|value| to_json_value(channel, value))
        }),
        "settings:save" => string_param(params, "data", channel).and_then(|data| {
            let dir = remote_app_data_dir(ctx, channel)?;
            settings_cmd::settings_save_impl(&dir, data).map_err(|err| err.to_string())?;
            Ok(Value::Bool(true))
        }),
        "settings:get-shell-path" => string_param(params, "shellType", channel)
            .map(settings_cmd::settings_get_shell_path)
            .and_then(|value| to_json_value(channel, value)),
        "settings:detect-cx" => remote_app_data_dir(ctx, channel).and_then(|dir| {
            settings_cmd::settings_detect_cx_impl(&dir)
                .map_err(|err| err.to_string())
                .and_then(|value| to_json_value(channel, value))
        }),
        "workspace:load" => {
            let profile_id = optional_string_param(params, "profileId")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "default".to_string());
            // Client window ids are untrusted: only serve a per-window snapshot
            // when the id names an EXISTING registry entry bound to the
            // requested profile. An unknown id must not fabricate an entry (it
            // would bind to the default profile and shadow the requested one),
            // and an id colliding with one of the host's own windows — both
            // sides label their main window "main" — must not leak another
            // profile's data.
            // Live-window fast path is desktop-only; the headless host has no
            // local windows and serves the persisted snapshot below.
            #[cfg(feature = "desktop")]
            if let Some(window_id) = optional_string_param(params, "windowId")
                .filter(|value| !value.trim().is_empty())
                .filter(|value| {
                    window_registry::profile_id_for_window(app, value).as_deref()
                        == Some(profile_id.as_str())
                })
            {
                if let Some(data) = window_registry::workspace_json(app, &window_id) {
                    return Some(Ok(Value::String(data)));
                }
            }
            Ok(
                profile_cmd::profile_workspace_json_for_remote(&ctx, &profile_id)
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            )
        }
        "workspace:save" => {
            let profile_id = optional_string_param(params, "profileId")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "default".to_string());
            string_param(params, "data", channel).map(|data| {
                // Same trust rule as workspace:load: a client-supplied windowId
                // may only target a registry entry that is already bound to the
                // requested profile. Without this check a save claiming
                // windowId "main" would overwrite the HOST's own main-window
                // workspace (and its global workspaces.json + profile
                // snapshot) regardless of the requested target profile.
                #[cfg(feature = "desktop")]
                let window_id = optional_string_param(params, "windowId")
                    .filter(|value| !value.trim().is_empty())
                    .filter(|value| {
                        window_registry::profile_id_for_window(app, value).as_deref()
                            == Some(profile_id.as_str())
                    });
                #[cfg(not(feature = "desktop"))]
                let window_id: Option<String> = None;
                #[cfg(feature = "desktop")]
                let saved = if let Some(window_id) = window_id.as_deref() {
                    window_registry::save_workspace_json(app, window_id, &data)
                } else if let Some(target) =
                    window_registry::latest_profile_window_id(app, &profile_id)
                {
                    // workspace:load serves this profile from its live window, so
                    // a profile-targeted save must update that same window or the
                    // live snapshot would shadow it on the next load (a session the
                    // client just added would vanish). Fall back to the persisted
                    // profile snapshot only when no live window exists.
                    window_registry::save_workspace_json(app, &target, &data)
                } else {
                    profile_cmd::profile_save_workspace_for_remote(&ctx, &profile_id, &data)
                };
                // Headless has no live windows; persist straight to the snapshot.
                #[cfg(not(feature = "desktop"))]
                let saved =
                    profile_cmd::profile_save_workspace_for_remote(&ctx, &profile_id, &data);
                if saved {
                    let payload = if let Some(window_id) = window_id.as_deref() {
                        let payload =
                            json!({ "profileId": profile_id, "windowId": window_id, "data": data });
                        let _ = ctx.emit_to(window_id, "workspace:reload", payload.clone());
                        remote_debug_log(
                            &ctx,
                            format!(
                                "workspace:save targeted profile={} window={}",
                                profile_id, window_id
                            ),
                        );
                        payload
                    } else {
                        let payload = json!({ "profileId": profile_id, "data": data });
                        #[cfg(feature = "desktop")]
                        for window_id in
                            window_registry::live_window_ids_for_profile(app, &profile_id)
                        {
                            let _ = ctx.emit_to(
                                &window_id,
                                "workspace:reload",
                                json!({ "windowId": window_id, "data": data }),
                            );
                        }
                        payload
                    };
                    if let Some(remote_state) = ctx.try_state::<RustRemoteServerState>() {
                        remote_state.broadcast_event("workspace:reload", &payload);
                    }
                }
                Value::Bool(saved)
            })
        }
        "pty:create" => {
            let options_value = params
                .get("options")
                .cloned()
                .unwrap_or_else(|| params.clone());
            deserialize_param::<pty_cmd::CreatePtyOptions>(options_value, channel, "options")
                .and_then(|options| {
                    let app_handle = ctx.clone();
                    let pty_handle = ctx.state::<pty_cmd::PtyState>().handle();
                    let worker_buffer_handle = ctx.state::<WorkerBufferState>().handle();
                    let id = crate::async_rt::block_on(async move {
                        crate::async_rt::spawn_blocking(move || {
                            pty_cmd::start_pty_session(
                                &app_handle,
                                pty_handle,
                                Some(worker_buffer_handle),
                                options,
                                None,
                            )
                        })
                        .await
                        .map_err(|err| format!("pty.create worker failed: {err}"))?
                        .map_err(|err| format!("{err:?}"))
                    })?;
                    Ok(Value::String(id))
                })
        }
        "pty:write" => string_param(params, "id", channel).and_then(|id| {
            string_param(params, "data", channel).and_then(|data| {
                let state = ctx.state::<pty_cmd::PtyState>();
                log_remote_pty_write_data(&ctx, "remote-server.pty-write.enqueue", &id, &data);
                let result = pty_cmd::write_pty_session(&state, &id, &data);
                match &result {
                    Ok(()) => log_remote_pty_write_data(
                        &ctx,
                        "remote-server.pty-write.enqueue-ok",
                        &id,
                        &data,
                    ),
                    Err(_) => log_remote_pty_write_data(
                        &ctx,
                        "remote-server.pty-write.enqueue-err",
                        &id,
                        &data,
                    ),
                }
                result
                    .map(|_| Value::Bool(true))
                    .map_err(|err| format!("{err:?}"))
            })
        }),
        "pty:read-buffer" => string_param(params, "id", channel).and_then(|id| {
            let state = ctx.state::<pty_cmd::PtyState>();
            pty_cmd::read_pty_output_buffer(&state, &id)
                .map(Value::String)
                .map_err(|err| format!("{err:?}"))
        }),
        "pty:resize" => string_param(params, "id", channel).and_then(|id| {
            u16_param(params, "cols", channel).and_then(|cols| {
                u16_param(params, "rows", channel).and_then(|rows| {
                    let state = ctx.state::<pty_cmd::PtyState>();
                    pty_cmd::resize_pty_session_from_mobile_view(&ctx, &state, &id, cols, rows)
                        .map(Value::Bool)
                        .map_err(|err| format!("{err:?}"))
                })
            })
        }),
        "pty:get-viewport-state" => string_param(params, "id", channel).and_then(|id| {
            let state = ctx.state::<pty_cmd::PtyState>();
            pty_cmd::get_pty_viewport_state(&state, &id)
                .map_err(|err| format!("{err:?}"))
                .and_then(|state| to_json_value(channel, state))
        }),
        "pty:set-viewport-mode" => string_param(params, "id", channel).and_then(|id| {
            let mode_value = params
                .get("mode")
                .cloned()
                .ok_or_else(|| format!("{channel}: missing mode"))?;
            let mode =
                deserialize_param::<pty_cmd::TerminalViewportMode>(mode_value, channel, "mode")?;
            let options = match params.get("options").cloned() {
                Some(Value::Null) | None => None,
                Some(value) => Some(deserialize_param::<pty_cmd::SetViewportModeOptions>(
                    value, channel, "options",
                )?),
            };
            let state = ctx.state::<pty_cmd::PtyState>();
            pty_cmd::set_pty_viewport_mode(&ctx, &state, &id, mode, options)
                .map_err(|err| format!("{err:?}"))
                .and_then(|state| to_json_value(channel, state))
        }),
        "pty:set-viewport-size" => string_param(params, "id", channel).and_then(|id| {
            u16_param(params, "cols", channel).and_then(|cols| {
                u16_param(params, "rows", channel).and_then(|rows| {
                    let source_value = params
                        .get("source")
                        .cloned()
                        .ok_or_else(|| format!("{channel}: missing source"))?;
                    let source = deserialize_param::<pty_cmd::TerminalViewportSource>(
                        source_value,
                        channel,
                        "source",
                    )?;
                    let state = ctx.state::<pty_cmd::PtyState>();
                    pty_cmd::set_pty_viewport_size(&ctx, &state, &id, cols, rows, source)
                        .map_err(|err| format!("{err:?}"))
                        .and_then(|state| to_json_value(channel, state))
                })
            })
        }),
        "pty:kill" => string_param(params, "id", channel).and_then(|id| {
            let state = ctx.state::<pty_cmd::PtyState>();
            pty_cmd::kill_pty_session(&ctx, &state, &id)
                .map(|_| Value::Bool(true))
                .map_err(|err| format!("{err:?}"))
        }),
        "pty:restart" => string_param(params, "id", channel).and_then(|id| {
            string_param(params, "cwd", channel).and_then(|cwd| {
                let shell = optional_string_param(params, "shell");
                crate::async_rt::block_on(pty_cmd::pty_restart_native(
                    ctx.clone(),
                    ctx.state::<pty_cmd::PtyState>(),
                    id,
                    cwd,
                    shell,
                ))
                .map(Value::Bool)
                .map_err(|err| format!("{err:?}"))
            })
        }),
        "pty:get-cwd" => string_param(params, "id", channel).and_then(|id| {
            let state = ctx.state::<pty_cmd::PtyState>();
            pty_cmd::get_pty_cwd(&state, &id)
                .map(|cwd| cwd.map(Value::String).unwrap_or(Value::Null))
                .map_err(|err| format!("{err:?}"))
        }),
        "fs:home" => to_json_value(channel, fs_cmd::fs_home_native(&ctx)),
        "fs:readdir" => string_param_any(params, &["dirPath", "path"], channel)
            .and_then(|dir_path| to_json_value(channel, fs_cmd::fs_readdir_impl(dir_path))),
        "fs:readFile" => string_param_any(params, &["path", "filePath"], channel)
            .and_then(|path| to_json_value(channel, fs_cmd::fs_read_file_impl(path))),
        "fs:isDirectory" => string_param_any(params, &["path", "dirPath"], channel)
            .map(|path| Value::Bool(fs_cmd::fs_is_directory_impl(path))),
        "fs:list-dirs" => {
            string_param_any(params, &["dirPath", "path"], channel).and_then(|dir_path| {
                let include_hidden = bool_param(params, "includeHidden", false);
                let value = fs_cmd::fs_list_dirs_native(&ctx, dir_path, include_hidden);
                to_json_value(channel, value)
            })
        }
        "fs:mkdir" => string_param(params, "parentPath", channel).and_then(|parent_path| {
            string_param(params, "name", channel)
                .and_then(|name| to_json_value(channel, fs_cmd::fs_mkdir_impl(parent_path, name)))
        }),
        "fs:delete-path" => {
            string_param_any(params, &["targetPath", "path"], channel).and_then(|target_path| {
                to_json_value(channel, fs_cmd::fs_delete_path_impl(target_path))
            })
        }
        "fs:quick-locations" => to_json_value(channel, fs_cmd::fs_quick_locations_native(&ctx)),
        "fs:search" => {
            let dir_path = match string_param_any(params, &["dirPath", "path"], channel) {
                Ok(value) => value,
                Err(_) => return Some(Ok(Value::Array(Vec::new()))),
            };
            let query = match string_param(params, "query", channel) {
                Ok(value) => value,
                Err(_) => return Some(Ok(Value::Array(Vec::new()))),
            };
            let files_only = bool_param(params, "filesOnly", false);
            to_json_value(channel, fs_cmd::fs_search_impl(dir_path, query, files_only))
        }
        "fs:resolve-path-links" => string_param(params, "cwd", channel).and_then(|cwd| {
            string_vec_param(params, "rawPaths", channel).and_then(|raw_paths| {
                to_json_value(channel, fs_cmd::fs_resolve_path_links_impl(cwd, raw_paths))
            })
        }),
        "fs:watch" => string_param_any(params, &["dirPath", "path"], channel).map(|dir_path| {
            Value::Bool(fs_cmd::fs_watch_native(
                ctx.clone(),
                &ctx.state::<fs_cmd::FsWatcherState>(),
                dir_path,
            ))
        }),
        "fs:unwatch" => string_param_any(params, &["dirPath", "path"], channel).map(|dir_path| {
            Value::Bool(fs_cmd::fs_unwatch_native(
                &ctx.state::<fs_cmd::FsWatcherState>(),
                dir_path,
            ))
        }),
        "fs:upload-tmp-begin" => string_param(params, "name", channel).and_then(|name| {
            let total_bytes = params
                .get("totalBytes")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            fs_cmd::fs_upload_begin_impl(&ctx.state::<fs_cmd::FsUploadState>(), name, total_bytes)
        }),
        "fs:upload-begin-dir" => string_param(params, "dir", channel).and_then(|dir| {
            string_param(params, "name", channel).and_then(|name| {
                let total_bytes = params
                    .get("totalBytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                fs_cmd::fs_upload_begin_in_dir_impl(
                    &ctx.state::<fs_cmd::FsUploadState>(),
                    dir,
                    name,
                    total_bytes,
                )
            })
        }),
        "fs:download-read" => string_param(params, "path", channel).and_then(|path| {
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
            fs_cmd::fs_download_read_impl(path, offset)
        }),
        "fs:upload-tmp-chunk" => string_param(params, "uploadId", channel).and_then(|upload_id| {
            string_param(params, "dataBase64", channel).and_then(|data_base64| {
                fs_cmd::fs_upload_chunk_impl(
                    &ctx.state::<fs_cmd::FsUploadState>(),
                    upload_id,
                    data_base64,
                )
            })
        }),
        "fs:upload-tmp-end" => string_param(params, "uploadId", channel).and_then(|upload_id| {
            fs_cmd::fs_upload_end_impl(&ctx.state::<fs_cmd::FsUploadState>(), upload_id)
        }),
        "fs:upload-tmp-abort" => string_param(params, "uploadId", channel).map(|upload_id| {
            Value::Bool(fs_cmd::fs_upload_abort_impl(
                &ctx.state::<fs_cmd::FsUploadState>(),
                upload_id,
            ))
        }),
        "git:get-github-url" => {
            string_param_any(params, &["folderPath", "cwd"], channel).and_then(|folder_path| {
                let value =
                    crate::async_rt::block_on(git_cmd::git_get_github_url_native(folder_path));
                to_json_value(channel, value)
            })
        }
        "git:branch" => string_param(params, "cwd", channel).and_then(|cwd| {
            let value = crate::async_rt::block_on(git_cmd::git_get_branch_native(cwd));
            to_json_value(channel, value)
        }),
        "git:log" => string_param(params, "cwd", channel).and_then(|cwd| {
            let count = params.get("count").and_then(Value::as_i64);
            let value = crate::async_rt::block_on(git_cmd::git_get_log_native(cwd, count));
            to_json_value(channel, value)
        }),
        "git:diff" => string_param(params, "cwd", channel).and_then(|cwd| {
            let commit_hash = optional_string_param(params, "commitHash");
            let file_path = optional_string_param(params, "filePath");
            let value = crate::async_rt::block_on(git_cmd::git_get_diff_native(
                cwd,
                commit_hash,
                file_path,
            ));
            to_json_value(channel, value)
        }),
        "git:diff-files" => string_param(params, "cwd", channel).and_then(|cwd| {
            let commit_hash = optional_string_param(params, "commitHash");
            let value =
                crate::async_rt::block_on(git_cmd::git_get_diff_files_native(cwd, commit_hash));
            to_json_value(channel, value)
        }),
        "git:getRoot" => string_param(params, "cwd", channel).and_then(|cwd| {
            let value = crate::async_rt::block_on(git_cmd::git_get_root_native(cwd));
            to_json_value(channel, value)
        }),
        "git:status" => string_param(params, "cwd", channel).and_then(|cwd| {
            let value = crate::async_rt::block_on(git_cmd::git_get_status_native(cwd));
            to_json_value(channel, value)
        }),
        "github:check-cli" => {
            let value = crate::async_rt::block_on(github_cmd::github_check_cli_native());
            to_json_value(channel, value)
        }
        "github:pr-list" => string_param(params, "cwd", channel)
            .map(|cwd| crate::async_rt::block_on(github_cmd::github_pr_list_native(cwd))),
        "github:issue-list" => string_param(params, "cwd", channel)
            .map(|cwd| crate::async_rt::block_on(github_cmd::github_issue_list_native(cwd))),
        "github:pr-view" => string_param(params, "cwd", channel).and_then(|cwd| {
            i64_param(params, "number", channel).map(|number| {
                crate::async_rt::block_on(github_cmd::github_pr_view_native(cwd, number))
            })
        }),
        "github:issue-view" => string_param(params, "cwd", channel).and_then(|cwd| {
            i64_param(params, "number", channel).map(|number| {
                crate::async_rt::block_on(github_cmd::github_issue_view_native(cwd, number))
            })
        }),
        "github:pr-comment" => string_param(params, "cwd", channel).and_then(|cwd| {
            i64_param(params, "number", channel).and_then(|number| {
                string_param(params, "body", channel).map(|body| {
                    crate::async_rt::block_on(github_cmd::github_pr_comment_native(
                        cwd, number, body,
                    ))
                })
            })
        }),
        "github:issue-comment" => string_param(params, "cwd", channel).and_then(|cwd| {
            i64_param(params, "number", channel).and_then(|number| {
                string_param(params, "body", channel).map(|body| {
                    crate::async_rt::block_on(github_cmd::github_issue_comment_native(
                        cwd, number, body,
                    ))
                })
            })
        }),
        "image:read-as-data-url" => string_param_any(params, &["path", "filePath"], channel)
            .and_then(|path| {
                image_cmd::image_read_as_data_url_impl(path)
                    .map(Value::String)
                    .map_err(|err| err.to_string())
            }),
        "snippet:getAll" => remote_app_data_dir(ctx, channel).and_then(|dir| {
            to_json_value(
                channel,
                snippet_cmd::snippet_get_all_core(&dir, &ctx.state::<snippet_cmd::SnippetState>()),
            )
        }),
        "snippet:getById" => i64_param(params, "id", channel).and_then(|id| {
            let dir = remote_app_data_dir(ctx, channel)?;
            to_json_value(
                channel,
                snippet_cmd::snippet_get_by_id_core(
                    &dir,
                    &ctx.state::<snippet_cmd::SnippetState>(),
                    id,
                ),
            )
        }),
        "snippet:getFavorites" => remote_app_data_dir(ctx, channel).and_then(|dir| {
            to_json_value(
                channel,
                snippet_cmd::snippet_get_favorites_core(
                    &dir,
                    &ctx.state::<snippet_cmd::SnippetState>(),
                ),
            )
        }),
        "snippet:search" => {
            let query = match string_param(params, "query", channel) {
                Ok(value) => value,
                Err(_) => return Some(Ok(Value::Array(Vec::new()))),
            };
            remote_app_data_dir(ctx, channel).and_then(|dir| {
                to_json_value(
                    channel,
                    snippet_cmd::snippet_search_core(
                        &dir,
                        &ctx.state::<snippet_cmd::SnippetState>(),
                        query,
                    ),
                )
            })
        }
        "snippet:getByWorkspace" => {
            let workspace_id = params
                .as_str()
                .map(ToString::to_string)
                .or_else(|| optional_string_param(params, "workspaceId"));
            remote_app_data_dir(ctx, channel).and_then(|dir| {
                to_json_value(
                    channel,
                    snippet_cmd::snippet_get_by_workspace_core(
                        &dir,
                        &ctx.state::<snippet_cmd::SnippetState>(),
                        workspace_id,
                    ),
                )
            })
        }
        "snippet:getCategories" => remote_app_data_dir(ctx, channel).and_then(|dir| {
            to_json_value(
                channel,
                snippet_cmd::snippet_get_categories_core(
                    &dir,
                    &ctx.state::<snippet_cmd::SnippetState>(),
                ),
            )
        }),
        "snippet:create" => {
            let input_value = params
                .get("input")
                .cloned()
                .unwrap_or_else(|| params.clone());
            if !input_value
                .get("title")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
                || !input_value.get("content").and_then(Value::as_str).is_some()
            {
                Err("snippet:create: missing input.title / input.content".to_string())
            } else {
                deserialize_param::<snippet_cmd::CreateSnippetInput>(input_value, channel, "input")
                    .and_then(|input| {
                        let dir = remote_app_data_dir(ctx, channel)?;
                        to_json_value(
                            channel,
                            snippet_cmd::snippet_create_core(
                                &dir,
                                &ctx.state::<snippet_cmd::SnippetState>(),
                                input,
                            ),
                        )
                    })
            }
        }
        "snippet:update" => i64_param(params, "id", channel).and_then(|id| {
            let updates_value = params
                .get("updates")
                .cloned()
                .ok_or_else(|| "snippet:update: missing updates".to_string())?;
            deserialize_param::<snippet_cmd::UpdateSnippetInput>(updates_value, channel, "updates")
                .and_then(|updates| {
                    let dir = remote_app_data_dir(ctx, channel)?;
                    to_json_value(
                        channel,
                        snippet_cmd::snippet_update_core(
                            &dir,
                            &ctx.state::<snippet_cmd::SnippetState>(),
                            id,
                            updates,
                        ),
                    )
                })
        }),
        "snippet:delete" => i64_param(params, "id", channel).and_then(|id| {
            let dir = remote_app_data_dir(ctx, channel)?;
            Ok(Value::Bool(snippet_cmd::snippet_delete_core(
                &dir,
                &ctx.state::<snippet_cmd::SnippetState>(),
                id,
            )))
        }),
        "snippet:toggleFavorite" => i64_param(params, "id", channel).and_then(|id| {
            let dir = remote_app_data_dir(ctx, channel)?;
            to_json_value(
                channel,
                snippet_cmd::snippet_toggle_favorite_core(
                    &dir,
                    &ctx.state::<snippet_cmd::SnippetState>(),
                    id,
                ),
            )
        }),
        "worktree:create" => string_param(params, "sessionId", channel).and_then(|session_id| {
            string_param(params, "cwd", channel).and_then(|cwd| {
                let install_pnpm = Some(bool_param(params, "installPnpm", false));
                crate::async_rt::block_on(worktree_cmd::worktree_create_local(
                    ctx.clone(),
                    ctx.state::<worktree_cmd::WorktreeState>(),
                    session_id,
                    cwd,
                    install_pnpm,
                ))
                .map_err(bridge_error_message)
            })
        }),
        "worktree:remove" => string_param(params, "sessionId", channel).and_then(|session_id| {
            let delete_branch = bool_param(params, "deleteBranch", true);
            crate::async_rt::block_on(worktree_cmd::worktree_remove_local(
                ctx.state::<worktree_cmd::WorktreeState>(),
                session_id,
                delete_branch,
            ))
            .map_err(bridge_error_message)
        }),
        "worktree:status" => string_param(params, "sessionId", channel).and_then(|session_id| {
            crate::async_rt::block_on(worktree_cmd::worktree_status_local(
                ctx.state::<worktree_cmd::WorktreeState>(),
                session_id,
            ))
            .map_err(bridge_error_message)
        }),
        "worktree:merge" => string_param(params, "sessionId", channel).and_then(|session_id| {
            let strategy =
                optional_string_param(params, "strategy").unwrap_or_else(|| "merge".into());
            crate::async_rt::block_on(worktree_cmd::worktree_merge_local(
                ctx.state::<worktree_cmd::WorktreeState>(),
                session_id,
                strategy,
            ))
            .map_err(bridge_error_message)
        }),
        "worktree:rehydrate" => string_param(params, "sessionId", channel).and_then(|session_id| {
            string_param(params, "cwd", channel).and_then(|cwd| {
                string_param(params, "worktreePath", channel).and_then(|worktree_path| {
                    string_param(params, "branchName", channel).and_then(|branch_name| {
                        crate::async_rt::block_on(worktree_cmd::worktree_rehydrate_local(
                            ctx.state::<worktree_cmd::WorktreeState>(),
                            session_id,
                            cwd,
                            worktree_path,
                            branch_name,
                        ))
                        .map_err(bridge_error_message)
                    })
                })
            })
        }),
        // Entries reach the client stripped of credentials. `profile_list_core` is
        // shared with the local Tauri command, whose renderer genuinely needs the
        // token to dial a remote profile, so the stripping belongs here at the
        // boundary rather than at the source.
        "profile:list" => serde_json::to_value(profile_cmd::profile_list_core(&ctx))
            .map(|value| strip_profile_secrets(&value))
            .map_err(|err| format!("remote profile:list serialization failed: {err}")),
        "notification:list" => serde_json::to_value(notification_cmd::notification_list_core(&ctx))
            .map_err(|err| format!("remote notification:list serialization failed: {err}")),
        "notification:mark-read" => match optional_string_param(params, "id") {
            Some(id) => Ok(Value::Bool(notification_cmd::notification_mark_read_core(&ctx, &id))),
            None => Err("remote notification:mark-read requires id".to_string()),
        },
        "notification:mark-all-read" => Ok(Value::Bool(
            notification_cmd::notification_mark_all_read_core(&ctx),
        )),
        "notification:clear" => Ok(Value::Bool(notification_cmd::notification_clear_core(&ctx))),
        "profile:get-active-ids" => {
            serde_json::to_value(profile_cmd::profile_get_active_ids_core(&ctx))
                .map_err(|err| format!("remote profile:get-active-ids serialization failed: {err}"))
        }
        "profile:load-snapshot" => profile_id_from_params(channel, params).map(|profile_id| {
            profile_cmd::profile_load_snapshot_for_remote(&ctx, &profile_id).unwrap_or(Value::Null)
        }),
        "profile:load" => profile_id_from_params(channel, params).map(|profile_id| {
            profile_cmd::profile_load_for_remote(&ctx, &profile_id).unwrap_or(Value::Null)
        }),
        "profile:activate" => profile_id_from_params(channel, params)
            .map(|profile_id| Value::Bool(profile_cmd::activate_profile_id(&ctx, &profile_id))),
        "profile:deactivate" => profile_id_from_params(channel, params)
            .map(|profile_id| Value::Bool(profile_cmd::deactivate_profile_id(&ctx, &profile_id))),
        "runtime:get-status" => {
            runtime_cmd::runtime_status_core(ctx).and_then(|status| to_json_value(channel, status))
        }
        "runtime:install" => string_param(params, "tool", channel).and_then(|tool| {
            runtime_cmd::runtime_install_core(ctx, &tool)
                .and_then(|result| to_json_value(channel, result))
        }),
        "runtime:clear-managed" => {
            let tool = optional_string_param(params, "tool");
            runtime_cmd::runtime_clear_managed_core(ctx, tool.as_deref()).map(|_| Value::Null)
        }
        _ => return None,
    };
    Some(result)
}

fn remote_invoke_timeout(channel: &str) -> Duration {
    let canonical = canonical_remote_channel(channel);
    match canonical.as_str() {
        "runtime:get-status" => RUNTIME_STATUS_TIMEOUT,
        "claude:start-session"
        | "claude:resume-session"
        | "claude:client-resume"
        | "claude:send-message"
        | "claude:auth-login-start"
        | "claude:auth-login-submit-code"
        | "claude:auth-login-cancel"
        // Auth start may lazily spawn a CLI/app-server; completion remains a
        // separate poll/submit request with an opaque login id.
        | "codex:auth-login-device-start"
        | "codex:auth-login-device-poll"
        | "claude:fork-session"
        | "runtime:install"
        | "runtime:clear-managed" => SESSION_INVOKE_TIMEOUT,
        _ => INVOKE_TIMEOUT,
    }
}

fn channel_to_sidecar_method(channel: &str) -> String {
    let mut out = String::new();
    let mut upper_next = false;
    for ch in channel.replace(':', ".").chars() {
        if ch == '-' {
            upper_next = true;
            continue;
        }
        if upper_next {
            out.extend(ch.to_uppercase());
            upper_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn send_frame<S: io::Read + io::Write>(
    ws: &mut tungstenite::WebSocket<S>,
    frame: Value,
    compression: RemoteCompression,
) -> Result<(), String> {
    match encode_remote_frame(&frame, compression)? {
        RemoteFramePayload::Text(text) => ws.send(Message::Text(text.into())),
        RemoteFramePayload::Binary(bytes) => ws.send(Message::Binary(bytes.into())),
    }
    .map_err(|err| format!("remote websocket send failed: {err}"))
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[allow(dead_code)]
fn legacy_event_args(channel: &str, params: &Value) -> Vec<Value> {
    event_params_to_legacy_v1_args(channel, params)
}

#[allow(dead_code)]
fn protocol_name(protocol: RemoteProtocol) -> &'static str {
    match protocol {
        RemoteProtocol::LegacyV1 => REMOTE_PROTOCOL_LEGACY_V1,
        RemoteProtocol::V2 => REMOTE_PROTOCOL_V2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_client_info(window_id: Option<&str>, label: &str) -> RemoteClientInfo {
        RemoteClientInfo {
            label: label.to_string(),
            window_id: window_id.map(str::to_string),
            client_info: None,
            connected_at: 0,
            protocol: "bat-remote/v2".to_string(),
            compression: "none".to_string(),
        }
    }

    #[test]
    fn advertises_structured_remote_auth_capabilities() {
        let capabilities = remote_capabilities();
        assert_eq!(capabilities["remoteAuth"]["claude"], json!("paste-code-v1"));
        assert_eq!(capabilities["remoteAuth"]["codex"], json!("device-code-v1"));
    }

    #[test]
    fn claude_remote_login_claim_blocks_competing_auth_mutations() {
        clear_claude_remote_login_started();
        assert!(try_begin_claude_remote_login());
        assert!(!try_begin_claude_remote_login());
        assert!(!touch_claude_remote_login(None));
        bind_claude_remote_login_id(Some("login-a"));
        assert!(!touch_claude_remote_login(Some("login-b")));
        assert!(touch_claude_remote_login(Some("login-a")));
        assert!(touch_claude_remote_login(None));
        assert_eq!(
            while_claude_remote_login_idle(|| Ok::<_, String>(true)).unwrap_err(),
            "auth_in_progress"
        );
        clear_claude_remote_login_started();
        assert!(while_claude_remote_login_idle(|| Ok(true)).unwrap());
    }

    #[test]
    fn client_already_recorded_matches_live_and_recent() {
        let clients = Arc::new(Mutex::new(Vec::new()));
        let recent = Arc::new(Mutex::new(Vec::new()));
        let now = 1_000_000;
        let key = (Some("win-1".to_string()), "Laptop".to_string());

        // Brand-new client: not live, not recent.
        assert!(!client_already_recorded(&clients, &recent, &key, now));

        // A recent (disconnected within TTL) record counts as known.
        record_recent_client(&recent, test_client_info(Some("win-1"), "Laptop"), now);
        assert!(client_already_recorded(&clients, &recent, &key, now));

        // A different identity is still treated as new.
        let other = (Some("win-2".to_string()), "Phone".to_string());
        assert!(!client_already_recorded(&clients, &recent, &other, now));

        // Past the TTL the recent record is pruned, so it's new again.
        let later = now + RECENT_CLIENT_TTL_MS + 1;
        assert!(!client_already_recorded(&clients, &recent, &key, later));

        // A currently-connected client also counts as known.
        let (tx, _rx) = mpsc::sync_channel(1);
        clients.lock().unwrap().push(RemoteClientRecord {
            id: "c1".to_string(),
            info: test_client_info(Some("win-3"), "Tablet"),
            tx,
            close: Arc::new(AtomicBool::new(false)),
        });
        let live_key = (Some("win-3".to_string()), "Tablet".to_string());
        assert!(client_already_recorded(&clients, &recent, &live_key, later));
    }

    #[test]
    fn resource_slots_enforce_the_limit_and_release_on_drop() {
        let active = Arc::new(AtomicUsize::new(0));
        let first = try_acquire_resource_slot(&active, 2).expect("first slot");
        let second = try_acquire_resource_slot(&active, 2).expect("second slot");
        assert!(try_acquire_resource_slot(&active, 2).is_none());
        assert_eq!(active.load(Ordering::Acquire), 2);

        drop(first);
        let replacement = try_acquire_resource_slot(&active, 2).expect("released slot");
        assert_eq!(active.load(Ordering::Acquire), 2);
        drop((second, replacement));
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_full_outbound_queue_revokes_the_slow_client() {
        let (tx, _rx) = mpsc::sync_channel(1);
        tx.try_send(json!({ "already": "queued" })).unwrap();
        let close = Arc::new(AtomicBool::new(false));
        let clients = Arc::new(Mutex::new(vec![RemoteClientRecord {
            id: "slow-client".to_string(),
            info: test_client_info(None, "slow client"),
            tx,
            close: Arc::clone(&close),
        }]));

        send_remote_event_to_clients(&clients, "workspace:reload", &json!({ "data": "{}" }));

        assert!(clients.lock().unwrap().is_empty());
        assert!(close.load(Ordering::Acquire));
    }

    #[test]
    fn channel_to_sidecar_method_matches_js_bridge() {
        assert_eq!(
            channel_to_sidecar_method("claude:start-session"),
            "claude.startSession"
        );
        assert_eq!(
            channel_to_sidecar_method("image:read-as-data-url"),
            "image.readAsDataUrl"
        );
        assert_eq!(channel_to_sidecar_method("git:getRoot"), "git.getRoot");
    }

    #[test]
    fn token_and_fingerprint_shapes_match_remote_contract() {
        assert_eq!(generate_token().len(), 32);
        let cert = generate_remote_certificate().expect("cert");
        assert!(cert.cert_der.len() > 100);
        assert!(cert.key_der.len() > 100);
        assert_eq!(fingerprint_sha256(&cert.cert_der).len(), 95);
    }

    #[test]
    fn websocket_accept_key_parses_node_ws_upgrade_request() {
        let request = b"GET / HTTP/1.1\r\n\
            Host: 100.68.234.13:9876\r\n\
            Upgrade: websocket\r\n\
            Connection: Upgrade\r\n\
            Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
            Sec-WebSocket-Version: 13\r\n\
            \r\n";
        assert_eq!(
            websocket_accept_key_from_request(request).as_deref(),
            Ok("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        );
    }

    #[test]
    fn websocket_accept_key_rejects_plain_http_request() {
        let request = b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert!(websocket_accept_key_from_request(request).is_err());
    }

    #[test]
    fn websocket_accept_key_rejects_invalid_key() {
        let request = b"GET / HTTP/1.1\r\n\
            Host: localhost\r\n\
            Upgrade: websocket\r\n\
            Connection: Upgrade\r\n\
            Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==\r\n\
            Sec-WebSocket-Version: 13\r\n\
            \r\n";
        assert!(websocket_accept_key_from_request(request).is_err());
    }

    #[test]
    fn remote_event_buffer_merges_stream_text_and_thinking() {
        let mut existing = json!({
            "sessionId": "session-1",
            "data": {
                "text": "hello",
                "thinking": "plan",
                "kind": "delta"
            }
        });
        let incoming = json!({
            "sessionId": "session-1",
            "data": {
                "text": " world",
                "thinking": " more",
                "kind": "update",
                "index": 2
            }
        });

        merge_buffered_stream_params(&mut existing, &incoming);

        assert_eq!(existing["sessionId"], json!("session-1"));
        assert_eq!(existing["data"]["text"], json!("hello world"));
        assert_eq!(existing["data"]["thinking"], json!("plan more"));
        assert_eq!(existing["data"]["kind"], json!("update"));
        assert_eq!(existing["data"]["index"], json!(2));
    }

    #[test]
    fn remote_event_buffer_keys_tool_results_by_session_and_tool_id() {
        let stream = json!({ "sessionId": "session-1", "data": { "text": "a" } });
        let tool = json!({
            "sessionId": "session-1",
            "result": { "id": "tool-1", "result": "out" }
        });

        assert_eq!(
            buffered_remote_event_key("claude:stream", &stream).as_deref(),
            Some("claude:stream:session-1")
        );
        assert_eq!(
            buffered_remote_event_key("claude:tool-result", &tool).as_deref(),
            Some("claude:tool-result:session-1:tool-1")
        );
    }

    #[test]
    fn loads_persisted_token_from_node_compatible_plaintext_envelope() {
        let dir = temp_remote_dir("token");
        fs::write(
            dir.join(TOKEN_FILE),
            r#"{"enc":false,"data":"{\"value\":\"persisted-token\"}"}"#,
        )
        .unwrap();
        assert_eq!(
            load_persisted_token(&dir).as_deref(),
            Some("persisted-token")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migrates_legacy_plaintext_server_token() {
        let dir = temp_remote_dir("legacy-token");
        fs::write(dir.join(LEGACY_TOKEN_FILE), r#"{"token":"legacy-token"}"#).unwrap();
        assert_eq!(load_persisted_token(&dir).as_deref(), Some("legacy-token"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ensure_certificate_reuses_node_compatible_plaintext_envelope() {
        let dir = temp_remote_dir("cert");
        let stored = generate_stored_certificate().unwrap();
        let payload = json!({
            "enc": false,
            "data": serde_json::to_string(&stored).unwrap(),
        });
        fs::write(dir.join(CERT_FILE), payload.to_string()).unwrap();

        let cert1 = ensure_remote_certificate(&dir).unwrap();
        let cert2 = ensure_remote_certificate(&dir).unwrap();
        assert_eq!(
            fingerprint_sha256(&cert1.cert_der),
            fingerprint_sha256(&cert2.cert_der)
        );
        assert_eq!(cert1.cert_der, cert2.cert_der);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_profile_changed_frame_leaves_the_host_without_credentials() {
        // Drives the real choke point rather than the sanitizer in isolation, so
        // deleting the sanitize call — or moving it after the legacy v1 conversion —
        // fails here instead of passing quietly.
        let (tx, rx) = mpsc::sync_channel(1);
        let clients = Arc::new(Mutex::new(vec![RemoteClientRecord {
            id: "client-1".to_string(),
            info: RemoteClientInfo {
                label: "phone".to_string(),
                window_id: None,
                client_info: None,
                connected_at: 0,
                protocol: REMOTE_PROTOCOL_LEGACY_V1.to_string(),
                compression: "none".to_string(),
            },
            tx,
            close: Arc::new(AtomicBool::new(false)),
        }]));
        let payload = json!({
            "profiles": [{
                "id": "hyper",
                "name": "Tail Hyper",
                "type": "remote",
                "remoteHost": "hyper.tail.ts.net",
                "remotePort": 9876,
                "remoteToken": "s3cr3t-host-token",
                "remoteFingerprint": "AA:BB:CC",
                "createdAt": 1,
                "updatedAt": 2,
            }],
            "activeProfileIds": ["hyper"],
        });

        send_remote_event_to_clients(&clients, "profile:changed", &payload);

        let frame = rx.try_recv().expect("the client received a frame");
        let raw = serde_json::to_string(&frame).expect("serializes");
        assert!(
            !raw.contains("s3cr3t-host-token"),
            "token left the host: {raw}"
        );
        assert!(
            !raw.contains("hyper.tail.ts.net"),
            "address left the host: {raw}"
        );
        // A v1 client reads args[0], a v2 client reads params. Both must be sanitized
        // AND both must still name the profile.
        assert_eq!(frame["params"]["profiles"][0]["id"], json!("hyper"));
        assert_eq!(frame["args"][0]["profiles"][0]["id"], json!("hyper"));
    }

    #[test]
    fn a_host_with_no_server_running_claims_no_identity() {
        // The self-connection check keys off this: sharing "no identity" must not
        // read as "same host", or a client-only build could never connect anywhere.
        assert_eq!(RustRemoteServerState::default().own_host_identity(), None);
    }

    fn temp_remote_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bat-remote-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
