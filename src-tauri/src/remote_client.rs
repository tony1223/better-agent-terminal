use crate::commands::pty as pty_cmd;
use crate::event_hub::publish_runtime_event;
use crate::host_context::HostContext;
use crate::remote_core::{
    canonical_remote_channel, decode_remote_binary_frame, decode_remote_text_frame,
    encode_remote_frame, is_proxied_remote_event, legacy_v1_event_args_to_params,
    RemoteCompression, RemoteFramePayload, REMOTE_COMPRESSION_GZIP, REMOTE_PROTOCOL_LEGACY_V1,
    REMOTE_PROTOCOL_V2,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::client::IntoClientRequest;
use tungstenite::protocol::WebSocket;
use tungstenite::Message;

const AUTH_TIMEOUT: Duration = Duration::from_secs(6);
const INVOKE_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_TIMEOUT: Duration = Duration::from_millis(100);
// The client loop's per-invoke deadline is authoritative (it can clean up the
// pending map and reply with a descriptive error). The caller's recv_timeout is
// only a backstop for a wedged/dead loop thread, so give it a little slack past
// the real deadline instead of racing it.
const PENDING_REPLY_GRACE: Duration = Duration::from_secs(5);
// Send a WebSocket Ping on an idle connection at this cadence. Without it an
// idle TCP/WS flow over NAT/Tailscale gets silently reaped: no bytes flow, the
// router drops the mapping, and the half-open socket is never noticed until the
// next invoke fails with "not connected to remote server". Periodic pings keep
// the mapping warm AND surface a dead peer promptly (the write errors → the
// loop breaks → `connected` flips false → the renderer auto-reconnects).
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);
const CLIENT_DEVICE_ID_FILE: &str = "remote-client-id.json";

type RemoteWebSocket = WebSocket<StreamOwned<ClientConnection, TcpStream>>;

#[derive(Clone, Default)]
pub struct RustRemoteClientState {
    // Connections are pooled by identity (host, port, token) and shared by every
    // window that targets the same host. `bindings` records which connection each
    // window owns, so an invoke from one window can only ever ride that window's
    // own connection — never another window's (or another host's). This keeps two
    // windows on two different hosts fully isolated.
    pool: Arc<Mutex<HashMap<ConnectionKey, Arc<RunningClient>>>>,
    bindings: Arc<Mutex<HashMap<String, ConnectionKey>>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct ConnectionKey {
    host: String,
    port: u16,
    // SHA-256 of the token, hex-encoded. Never the plaintext token, so the key is
    // safe to keep in maps and to render in logs (truncated, see Display).
    token_hash: String,
}

impl ConnectionKey {
    fn new(host: &str, port: u16, token: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        let token_hash = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Self {
            host: host.to_string(),
            port,
            token_hash,
        }
    }
}

impl std::fmt::Display for ConnectionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Log-safe: host:port plus the first 8 hex chars of the token hash.
        let short = &self.token_hash[..8.min(self.token_hash.len())];
        write!(f, "{}:{}#{}", self.host, self.port, short)
    }
}

struct RunningClient {
    host: String,
    port: u16,
    compression: RemoteCompression,
    protocol: String,
    // Host's app version as echoed in the auth-result `serverVersion` field,
    // or None when the host predates the version-handshake fix. The renderer
    // compares it to the client's own version to surface a skew warning
    // (issue #115 was triggered by exactly that gap going undetected).
    server_version: Option<String>,
    // Additive host feature advertisement. Missing against older hosts.
    capabilities: Option<Value>,
    connected: Arc<AtomicBool>,
    tx: mpsc::Sender<ClientCommand>,
    // window_labels currently bound to this connection. The socket is torn down
    // only when the last referrer is released, so sibling windows on the same
    // host keep sharing it.
    referrers: Mutex<HashSet<String>>,
}

enum ClientCommand {
    Invoke {
        id: String,
        channel: String,
        args: Vec<Value>,
        timeout: Duration,
        reply: mpsc::Sender<Result<Value, String>>,
    },
    Disconnect,
}

struct PendingInvoke {
    channel: String,
    deadline: Instant,
    reply: mpsc::Sender<Result<Value, String>>,
}

struct RemoteConnection {
    ws: RemoteWebSocket,
    protocol: String,
    compression: RemoteCompression,
    server_version: Option<String>,
    capabilities: Option<Value>,
}

#[derive(Debug)]
struct AllowAnyServerCertificate;

impl ServerCertVerifier for AllowAnyServerCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

impl RustRemoteClientState {
    pub fn connect(
        &self,
        app: HostContext,
        host: String,
        port: u16,
        token: String,
        fingerprint: String,
        label: Option<String>,
        window_id: Option<String>,
    ) -> Result<Value, String> {
        validate_connection_fields(&host, port, &token, &fingerprint)?;
        // Capture before `app` may be moved into the client_loop thread below;
        // surfaced in the connect return so the renderer can compare against
        // `serverVersion` and flag client/server skew (issue #115).
        let client_version = app.version();
        let label = label
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(default_client_label);
        let key = ConnectionKey::new(&host, port, &token);

        // Re-bind safety: if this window was bound to a different connection,
        // release that first (tearing the old socket down only if this window was
        // its last referrer). Covers an in-window host switch.
        if let Some(window_label) = window_id.as_deref() {
            let previous = self
                .bindings
                .lock()
                .expect("remote client bindings lock")
                .get(window_label)
                .cloned();
            if matches!(previous, Some(previous_key) if previous_key != key) {
                self.release_binding(window_label);
            }
        }

        // Reuse a live connection to the same host identity, otherwise open one.
        let existing = self
            .pool
            .lock()
            .expect("remote client pool lock")
            .get(&key)
            .cloned();
        let client = match existing {
            Some(client) if client.connected.load(Ordering::SeqCst) => client,
            _ => {
                let device_id = load_or_create_client_device_id(&app);
                let connection = connect_socket(
                    &host,
                    port,
                    &token,
                    &fingerprint,
                    &label,
                    window_id.clone(),
                    device_id,
                )?;
                let compression = connection.compression;
                let protocol = connection.protocol.clone();
                let server_version = connection.server_version.clone();
                let capabilities = connection.capabilities.clone();
                let (tx, rx) = mpsc::channel();
                let connected = Arc::new(AtomicBool::new(true));
                let connected_for_loop = Arc::clone(&connected);
                let remote_origin = format!("{host}:{port}");
                thread::spawn(move || {
                    client_loop(
                        app,
                        connection.ws,
                        rx,
                        connected_for_loop,
                        compression,
                        remote_origin,
                    )
                });
                let client = Arc::new(RunningClient {
                    host: host.clone(),
                    port,
                    compression,
                    protocol,
                    server_version,
                    capabilities,
                    connected,
                    tx,
                    referrers: Mutex::new(HashSet::new()),
                });
                self.pool
                    .lock()
                    .expect("remote client pool lock")
                    .insert(key.clone(), Arc::clone(&client));
                client
            }
        };

        // Bind this window to the chosen connection.
        if let Some(window_label) = window_id.as_deref() {
            client
                .referrers
                .lock()
                .expect("remote client referrers lock")
                .insert(window_label.to_string());
            self.bindings
                .lock()
                .expect("remote client bindings lock")
                .insert(window_label.to_string(), key.clone());
        }

        let info = json!({
            "host": client.host,
            "port": client.port,
            "compression": client.compression.as_str(),
        });
        // Surface client/server app version pair so the renderer can flag
        // skew once per connect (issue #115's data-corruption window opened
        // when a 3.1.22 host kept accepting 3.1.26 clients silently).
        // `serverVersion` is None against hosts that predate this handshake.
        let server_version = client
            .server_version
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null);
        Ok(json!({
            "connected": true,
            "info": info,
            "protocol": client.protocol,
            "clientVersion": client_version,
            "serverVersion": server_version,
            "capabilities": client.capabilities,
        }))
    }

    /// Release a window's connection binding. The underlying socket is torn down
    /// only when the last referrer is dropped, so sibling windows on the same host
    /// keep sharing it. Returns false when the window had no binding.
    fn release_binding(&self, window_label: &str) -> bool {
        let key = {
            let mut bindings = self.bindings.lock().expect("remote client bindings lock");
            match bindings.remove(window_label) {
                Some(key) => key,
                None => return false,
            }
        };
        let client = self
            .pool
            .lock()
            .expect("remote client pool lock")
            .get(&key)
            .cloned();
        let Some(client) = client else {
            return true;
        };
        let now_empty = {
            let mut referrers = client
                .referrers
                .lock()
                .expect("remote client referrers lock");
            referrers.remove(window_label);
            referrers.is_empty()
        };
        if now_empty {
            client.connected.store(false, Ordering::SeqCst);
            let _ = client.tx.send(ClientCommand::Disconnect);
            self.pool
                .lock()
                .expect("remote client pool lock")
                .remove(&key);
        }
        true
    }

    pub fn disconnect(&self, window_label: &str) -> bool {
        self.release_binding(window_label)
    }

    pub fn status(&self, window_label: &str) -> Value {
        let key = self
            .bindings
            .lock()
            .expect("remote client bindings lock")
            .get(window_label)
            .cloned();
        let Some(key) = key else {
            return json!({ "connected": false, "info": null });
        };
        let client = self
            .pool
            .lock()
            .expect("remote client pool lock")
            .get(&key)
            .cloned();
        let Some(client) = client else {
            return json!({ "connected": false, "info": null });
        };
        let connected = client.connected.load(Ordering::SeqCst);
        json!({
            "connected": connected,
            "info": if connected {
                json!({
                    "host": client.host,
                    "port": client.port,
                    "compression": client.compression.as_str(),
                })
            } else {
                Value::Null
            },
            "capabilities": if connected {
                client.capabilities.clone().unwrap_or(Value::Null)
            } else {
                Value::Null
            },
        })
    }

    pub fn invoke(
        &self,
        window_label: &str,
        channel: &str,
        args: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        if channel.trim().is_empty() {
            return Err("remote.invoke: channel is required".to_string());
        }
        // Route strictly to this window's own connection. If the window has no
        // live binding, fail closed — never fall back to another window's/host's
        // connection (that was the cross-host bleed bug).
        let key = self
            .bindings
            .lock()
            .expect("remote client bindings lock")
            .get(window_label)
            .cloned();
        let Some(key) = key else {
            return Err("remote.invoke: not connected to remote server".to_string());
        };
        let client = self
            .pool
            .lock()
            .expect("remote client pool lock")
            .get(&key)
            .cloned();
        let Some(client) = client else {
            return Err("remote.invoke: not connected to remote server".to_string());
        };
        if !client.connected.load(Ordering::SeqCst) {
            return Err("remote.invoke: not connected to remote server".to_string());
        }
        let tx = client.tx.clone();
        let id = self.next_id();
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(ClientCommand::Invoke {
            id,
            channel: channel.to_string(),
            args,
            timeout,
            reply: reply_tx,
        })
        .map_err(|_| "remote.invoke: connection closed".to_string())?;
        reply_rx
            .recv_timeout(timeout + PENDING_REPLY_GRACE)
            .map_err(|_| format!("Remote invoke timeout: {channel}"))?
    }

    pub fn test_connection(
        &self,
        host: String,
        port: u16,
        token: String,
        fingerprint: String,
    ) -> Result<Value, String> {
        validate_connection_fields(&host, port, &token, &fingerprint)?;
        let mut connection = connect_socket(
            &host,
            port,
            &token,
            &fingerprint,
            &default_client_label(),
            None,
            None,
        )?;
        let _ = connection.ws.close(None);
        Ok(json!({ "ok": true }))
    }

    pub fn list_profiles(
        &self,
        host: String,
        port: u16,
        token: String,
        fingerprint: String,
    ) -> Result<Value, String> {
        validate_connection_fields(&host, port, &token, &fingerprint)?;
        let mut connection = connect_socket(
            &host,
            port,
            &token,
            &fingerprint,
            &default_client_label(),
            None,
            None,
        )?;
        let result = invoke_socket(
            &mut connection.ws,
            connection.compression,
            "profile:list",
            Vec::new(),
            INVOKE_TIMEOUT,
        )?;
        let _ = connection.ws.close(None);
        let profiles = result
            .get("profiles")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .map(|profile| {
                        json!({
                            "id": profile.get("id").cloned().unwrap_or(Value::Null),
                            "name": profile.get("name").cloned().unwrap_or(Value::Null),
                            "type": profile.get("type").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let active_profile_ids = result
            .get("activeProfileIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(json!({ "profiles": profiles, "activeProfileIds": active_profile_ids }))
    }

    fn next_id(&self) -> String {
        let seq = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        format!("{}-{seq}", unix_ms())
    }
}

fn client_loop(
    app: HostContext,
    mut ws: RemoteWebSocket,
    rx: mpsc::Receiver<ClientCommand>,
    connected: Arc<AtomicBool>,
    compression: RemoteCompression,
    remote_origin: String,
) {
    let mut pending: HashMap<String, PendingInvoke> = HashMap::new();
    let mut last_ping = Instant::now();
    loop {
        while let Ok(command) = rx.try_recv() {
            match command {
                ClientCommand::Disconnect => {
                    let _ = ws.close(None);
                    connected.store(false, Ordering::SeqCst);
                    drain_pending(&mut pending, "Disconnected");
                    return;
                }
                ClientCommand::Invoke {
                    id,
                    channel,
                    args,
                    timeout,
                    reply,
                } => {
                    log_remote_pty_write_args(&app, "remote-client.send", &channel, &args);
                    let frame =
                        json!({ "type": "invoke", "id": id, "channel": channel, "args": args });
                    match send_json_frame(&mut ws, frame, compression) {
                        Ok(()) => {
                            pending.insert(
                                id,
                                PendingInvoke {
                                    channel,
                                    // Honor the caller's timeout instead of a fixed 30s, so long
                                    // session calls (agent:send-message at 300s) aren't killed
                                    // mid-turn while the host is still waiting on the API.
                                    deadline: Instant::now() + timeout,
                                    reply,
                                },
                            );
                        }
                        Err(err) => {
                            let _ = reply.send(Err(err));
                        }
                    }
                }
            }
        }

        expire_pending(&mut pending);
        // Keep the idle connection warm and detect a dead peer. A failed write
        // here means the socket is gone; break so `connected` flips false and
        // the client surfaces the drop (the renderer then auto-reconnects).
        if last_ping.elapsed() >= KEEPALIVE_INTERVAL {
            if ws.send(Message::Ping(Vec::<u8>::new().into())).is_err() {
                break;
            }
            last_ping = Instant::now();
        }
        match ws.read() {
            Ok(Message::Text(text)) if compression == RemoteCompression::None => {
                if let Ok(frame) = decode_remote_text_frame(&text) {
                    handle_frame(&app, &mut pending, frame, &remote_origin);
                }
            }
            Ok(Message::Binary(bytes)) if compression == RemoteCompression::Gzip => {
                if let Ok(frame) = decode_remote_binary_frame(&bytes) {
                    handle_frame(&app, &mut pending, frame, &remote_origin);
                }
            }
            Ok(Message::Ping(bytes)) => {
                let _ = ws.send(Message::Pong(bytes));
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(err))
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    connected.store(false, Ordering::SeqCst);
    drain_pending(&mut pending, "Connection closed");
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
    if !pty_cmd::pty_input_trace_required(data) {
        return;
    }
    pty_cmd::pty_input_debug_log(
        app,
        format!("{phase} id={id} {}", pty_cmd::describe_pty_input(data)),
    );
}

/// Stamp host-origin `workspace:reload` payloads so the renderer can tell them
/// apart from local-origin reloads. Host and client both label their main
/// window "main", so windowId alone cannot distinguish a host broadcast from a
/// reload targeted at this machine's own local window — without the tag, a
/// local window would adopt the HOST's workspace list and the next local save
/// would persist it over this machine's own data. Legacy hosts (<= v3.1.8)
/// still send the bare workspace JSON string; wrap it so the tag survives.
fn tag_remote_workspace_reload(params: Value, remote_origin: &str) -> Value {
    match params {
        Value::Object(mut map) => {
            map.insert(
                "remoteOrigin".to_string(),
                Value::String(remote_origin.to_string()),
            );
            Value::Object(map)
        }
        Value::String(data) => json!({ "data": data, "remoteOrigin": remote_origin }),
        other => other,
    }
}

/// Profile ids are only unique inside one host (nearly every installation has
/// a `default`). Stamp the source connection on proxied profile events so two
/// remote windows attached to different hosts cannot consume each other's
/// `profile:changed` broadcast.
fn tag_remote_profile_changed(params: Value, remote_origin: &str) -> Value {
    match params {
        Value::Object(mut map) => {
            map.insert(
                "remoteOrigin".to_string(),
                Value::String(remote_origin.to_string()),
            );
            Value::Object(map)
        }
        other => other,
    }
}

fn handle_frame(
    app: &HostContext,
    pending: &mut HashMap<String, PendingInvoke>,
    frame: Value,
    remote_origin: &str,
) {
    let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
    if matches!(frame_type, "invoke-result" | "invoke-error") {
        let Some(id) = frame.get("id").and_then(Value::as_str) else {
            return;
        };
        if let Some(pending) = pending.remove(id) {
            let result = if frame_type == "invoke-error" {
                Err(frame
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Remote invoke failed")
                    .to_string())
            } else {
                Ok(frame.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = pending.reply.send(result);
        }
        return;
    }
    if frame_type == "event" {
        let Some(raw_channel) = frame.get("channel").and_then(Value::as_str) else {
            return;
        };
        let channel = canonical_remote_channel(raw_channel);
        if !is_proxied_remote_event(&channel) {
            return;
        }
        let mut params = frame.get("params").cloned().unwrap_or_else(|| {
            let args = frame
                .get("args")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            legacy_v1_event_args_to_params(&channel, &args)
        });
        if channel == "workspace:reload" {
            params = tag_remote_workspace_reload(params, remote_origin);
        } else if channel == "profile:changed" {
            params = tag_remote_profile_changed(params, remote_origin);
        }
        publish_runtime_event(app, &channel, params, "rust-remote-client");
    }
}

fn expire_pending(pending: &mut HashMap<String, PendingInvoke>) {
    let now = Instant::now();
    let expired = pending
        .iter()
        .filter_map(|(id, pending)| (pending.deadline <= now).then_some(id.clone()))
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(pending) = pending.remove(&id) {
            let _ = pending
                .reply
                .send(Err(format!("Remote invoke timeout: {}", pending.channel)));
        }
    }
}

fn drain_pending(pending: &mut HashMap<String, PendingInvoke>, message: &str) {
    for (_, pending) in pending.drain() {
        let _ = pending.reply.send(Err(message.to_string()));
    }
}

fn generate_client_device_id() -> String {
    let bytes = rand::random::<[u8; 16]>();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// A stable per-install identifier sent to the host as `clientInfo.deviceId`.
// The host uses it to recognize this client on reconnect, so it only shows a
// "new client connected" notification the first time this install connects.
// Generated once and persisted under the app data dir.
fn load_or_create_client_device_id(app: &HostContext) -> Option<String> {
    let data_dir = app.data_dir().ok()?;
    let path = data_dir.join(CLIENT_DEVICE_ID_FILE);
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Some(existing) = serde_json::from_str::<Value>(&raw)
            .ok()
            .as_ref()
            .and_then(|value| value.get("deviceId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
        {
            return Some(existing);
        }
    }
    let id = generate_client_device_id();
    let _ = std::fs::create_dir_all(&data_dir);
    let _ = std::fs::write(&path, json!({ "deviceId": id }).to_string());
    Some(id)
}

fn connect_socket(
    host: &str,
    port: u16,
    token: &str,
    fingerprint: &str,
    label: &str,
    window_id: Option<String>,
    device_id: Option<String>,
) -> Result<RemoteConnection, String> {
    let pinned_fingerprint = normalize_fingerprint(fingerprint);
    if pinned_fingerprint.is_empty() {
        return Err("fingerprint is required for TLS pinning".to_string());
    }
    let tcp = TcpStream::connect((host, port))
        .map_err(|err| format!("remote TCP connect failed: {err}"))?;
    tcp.set_read_timeout(Some(AUTH_TIMEOUT))
        .map_err(|err| format!("remote TCP timeout failed: {err}"))?;
    tcp.set_write_timeout(Some(AUTH_TIMEOUT))
        .map_err(|err| format!("remote TCP write timeout failed: {err}"))?;

    let mut connection = ClientConnection::new(build_client_config()?, server_name_for(host)?)
        .map_err(|err| format!("remote TLS setup failed: {err}"))?;
    let mut tcp_for_handshake = tcp;
    while connection.is_handshaking() {
        connection
            .complete_io(&mut tcp_for_handshake)
            .map_err(|err| format!("remote TLS handshake failed: {err}"))?;
    }
    let peer_fingerprint = connection
        .peer_certificates()
        .and_then(|certs| certs.first())
        .map(|cert| fingerprint_sha256(cert.as_ref()))
        .unwrap_or_default();
    if normalize_fingerprint(&peer_fingerprint) != pinned_fingerprint {
        return Err(format!(
            "fingerprint mismatch: expected {}, got {}",
            summarize_fingerprint(&pinned_fingerprint),
            summarize_fingerprint(&peer_fingerprint)
        ));
    }

    // The websocket upgrade and auth handshake below both block on reads for the
    // server's response (the HTTP 101, then the auth-result frame). Keep the
    // generous AUTH_TIMEOUT that is already on the socket in effect through both
    // stages — only switch to the short non-blocking POLL_TIMEOUT once the
    // connection is live (for the steady-state client loop). On relayed /
    // high-latency paths (e.g. Tailscale DERP) the 101 can take several hundred
    // ms; previously POLL_TIMEOUT was applied *before* the upgrade, so the read
    // for the 101 timed out ~100ms after sending the upgrade and every such
    // connection failed regardless of the much larger AUTH_TIMEOUT. (gh #116)
    let tls = StreamOwned::new(connection, tcp_for_handshake);
    let request = format!("wss://{host}:{port}/")
        .into_client_request()
        .map_err(|err| format!("remote websocket request failed: {err}"))?;
    let (mut ws, _) = tungstenite::client(request, tls).map_err(|err| {
        // A read timeout while waiting for the server's HTTP 101 surfaces as
        // `Interrupted` (WouldBlock on Unix) or `Failure(Io(TimedOut))` (on
        // Windows). Report it distinctly so a slow/relayed path is not mistaken
        // for an auth or fingerprint failure. (gh #116)
        let timed_out = match &err {
            tungstenite::HandshakeError::Interrupted(_) => true,
            tungstenite::HandshakeError::Failure(tungstenite::Error::Io(io_err)) => {
                io_err.kind() == io::ErrorKind::WouldBlock
                    || io_err.kind() == io::ErrorKind::TimedOut
            }
            _ => false,
        };
        if timed_out {
            format!(
                "remote websocket upgrade timed out after {}s waiting for the server response (slow or relayed network path?)",
                AUTH_TIMEOUT.as_secs()
            )
        } else {
            format!("remote websocket connect failed: {err}")
        }
    })?;
    // Connection established; the auth loop below and the steady-state client
    // loop both expect the short non-blocking poll timeout.
    ws.get_ref()
        .sock
        .set_read_timeout(Some(POLL_TIMEOUT))
        .map_err(|err| format!("remote stream polling timeout failed: {err}"))?;
    let mut client_info = json!({
        "appName": "Better Agent Terminal Desktop",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "deviceName": label,
        "label": label,
        "platform": std::env::consts::OS,
    });
    // The host dedups "new client" notifications on this stable id.
    if let Some(id) = device_id.as_deref().filter(|id| !id.is_empty()) {
        client_info["deviceId"] = json!(id);
    }
    send_json_frame(
        &mut ws,
        json!({
            "type": "auth",
            "id": format!("{}-auth", unix_ms()),
            "token": token,
            "protocols": [REMOTE_PROTOCOL_V2, REMOTE_PROTOCOL_LEGACY_V1],
            "compression": [REMOTE_COMPRESSION_GZIP],
            "args": [label, { "windowId": window_id, "clientInfo": client_info }],
        }),
        RemoteCompression::None,
    )?;
    let deadline = Instant::now() + AUTH_TIMEOUT;
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => {
                let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if frame.get("type").and_then(Value::as_str) != Some("auth-result") {
                    continue;
                }
                if let Some(error) = frame.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
                let protocol = frame
                    .get("protocol")
                    .and_then(Value::as_str)
                    .unwrap_or(REMOTE_PROTOCOL_LEGACY_V1)
                    .to_string();
                let compression = match frame.get("compression").and_then(Value::as_str) {
                    Some(REMOTE_COMPRESSION_GZIP) => RemoteCompression::Gzip,
                    _ => RemoteCompression::None,
                };
                let server_version = frame
                    .get("serverVersion")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                let capabilities = frame
                    .get("capabilities")
                    .filter(|value| value.is_object())
                    .cloned();
                return Ok(RemoteConnection {
                    ws,
                    protocol,
                    compression,
                    server_version,
                    capabilities,
                });
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(err))
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut =>
            {
                if Instant::now() >= deadline {
                    return Err("remote auth timed out".to_string());
                }
            }
            Err(err) => return Err(format!("remote auth failed: {err}")),
        }
    }
}

fn invoke_socket(
    ws: &mut RemoteWebSocket,
    compression: RemoteCompression,
    channel: &str,
    args: Vec<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let id = format!("{}-invoke", unix_ms());
    send_json_frame(
        ws,
        json!({ "type": "invoke", "id": id, "channel": channel, "args": args }),
        compression,
    )?;
    let deadline = Instant::now() + timeout;
    loop {
        match ws.read() {
            Ok(Message::Text(text)) if compression == RemoteCompression::None => {
                let Ok(frame) = decode_remote_text_frame(&text) else {
                    continue;
                };
                if frame.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                    continue;
                }
                match frame.get("type").and_then(Value::as_str) {
                    Some("invoke-result") => {
                        return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
                    }
                    Some("invoke-error") => {
                        return Err(frame
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Remote invoke failed")
                            .to_string());
                    }
                    _ => {}
                }
            }
            Ok(Message::Binary(bytes)) if compression == RemoteCompression::Gzip => {
                let Ok(frame) = decode_remote_binary_frame(&bytes) else {
                    continue;
                };
                if frame.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                    continue;
                }
                match frame.get("type").and_then(Value::as_str) {
                    Some("invoke-result") => {
                        return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
                    }
                    Some("invoke-error") => {
                        return Err(frame
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Remote invoke failed")
                            .to_string());
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(err))
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut =>
            {
                if Instant::now() >= deadline {
                    return Err(format!("Remote invoke timeout: {channel}"));
                }
            }
            Err(err) => return Err(format!("Remote invoke failed: {err}")),
        }
    }
}

fn build_client_config() -> Result<Arc<ClientConfig>, String> {
    let provider = rustls::crypto::ring::default_provider();
    let config = ClientConfig::builder_with_provider(provider.into())
        .with_safe_default_protocol_versions()
        .map_err(|err| format!("remote TLS protocol config failed: {err:?}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AllowAnyServerCertificate))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

fn server_name_for(host: &str) -> Result<ServerName<'static>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ServerName::IpAddress(ip.into()));
    }
    ServerName::try_from(host.to_string()).map_err(|_| "remote host is not a valid DNS name".into())
}

fn send_json_frame(
    ws: &mut RemoteWebSocket,
    frame: Value,
    compression: RemoteCompression,
) -> Result<(), String> {
    match encode_remote_frame(&frame, compression)? {
        RemoteFramePayload::Text(text) => ws.send(Message::Text(text.into())),
        RemoteFramePayload::Binary(bytes) => ws.send(Message::Binary(bytes.into())),
    }
    .map_err(|err| format!("remote websocket send failed: {err}"))
}

fn validate_connection_fields(
    host: &str,
    port: u16,
    token: &str,
    fingerprint: &str,
) -> Result<(), String> {
    if host.trim().is_empty() || port == 0 || token.trim().is_empty() {
        return Err("host, port, and token are required".to_string());
    }
    if fingerprint.trim().is_empty() {
        return Err("fingerprint is required".to_string());
    }
    Ok(())
}

fn default_client_label() -> String {
    let suffix = unix_ms() % 1_000_000;
    format!("Client-{suffix:06}")
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn fingerprint_sha256(cert_der: &[u8]) -> String {
    let digest = Sha256::digest(cert_der);
    digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn normalize_fingerprint(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .map(|ch| ch.to_ascii_uppercase())
        .collect::<Vec<_>>()
        .chunks(2)
        .filter(|chunk| chunk.len() == 2)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(":")
}

fn summarize_fingerprint(value: &str) -> String {
    let normalized = normalize_fingerprint(value);
    if normalized.len() <= 23 {
        normalized
    } else {
        format!("{}...", &normalized[..23])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_fingerprint_like_node_client() {
        assert_eq!(
            normalize_fingerprint("aa bb:cc-dd"),
            "AA:BB:CC:DD".to_string()
        );
        assert_eq!(summarize_fingerprint("AA:BB").as_str(), "AA:BB");
    }

    #[test]
    fn validates_remote_connection_fields() {
        assert!(validate_connection_fields("localhost", 9876, "token", "AA").is_ok());
        assert!(validate_connection_fields("", 9876, "token", "AA").is_err());
        assert!(validate_connection_fields("localhost", 0, "token", "AA").is_err());
        assert!(validate_connection_fields("localhost", 9876, "", "AA").is_err());
        assert!(validate_connection_fields("localhost", 9876, "token", "").is_err());
    }

    #[test]
    fn connection_key_is_stable_and_token_safe() {
        let a = ConnectionKey::new("host", 9001, "secret-token");
        let b = ConnectionKey::new("host", 9001, "secret-token");
        let c = ConnectionKey::new("host", 9001, "other-token");
        let d = ConnectionKey::new("host", 9002, "secret-token");
        assert_eq!(a, b, "same (host, port, token) must collapse to one key");
        assert_ne!(a, c, "different token must be a different connection");
        assert_ne!(a, d, "different port must be a different connection");
        let shown = a.to_string();
        assert!(shown.starts_with("host:9001#"));
        assert!(
            !shown.contains("secret-token"),
            "Display must never leak the plaintext token"
        );
    }

    #[test]
    fn tags_remote_workspace_reload_payloads() {
        // Object payloads gain the origin tag in place.
        let tagged = tag_remote_workspace_reload(
            json!({ "windowId": "main", "profileId": "default", "data": "{}" }),
            "hostb:9876",
        );
        assert_eq!(tagged["remoteOrigin"], json!("hostb:9876"));
        assert_eq!(tagged["windowId"], json!("main"));
        // Legacy bare-string payloads are wrapped so the tag survives.
        let wrapped =
            tag_remote_workspace_reload(Value::String("{\"workspaces\":[]}".into()), "hostb:9876");
        assert_eq!(wrapped["remoteOrigin"], json!("hostb:9876"));
        assert_eq!(wrapped["data"], json!("{\"workspaces\":[]}"));
    }

    #[test]
    fn tags_remote_profile_changed_payloads() {
        let tagged = tag_remote_profile_changed(
            json!({
                "profiles": [{ "id": "default", "name": "Default", "type": "local" }],
                "activeProfileIds": ["default"],
            }),
            "hostb:9876",
        );
        assert_eq!(tagged["remoteOrigin"], json!("hostb:9876"));
        assert_eq!(tagged["profiles"][0]["id"], json!("default"));
    }

    #[test]
    fn invoke_without_binding_fails_closed() {
        let state = RustRemoteClientState::default();
        let err = state
            .invoke(
                "win-A",
                "pty:read-buffer",
                Vec::new(),
                Duration::from_secs(1),
            )
            .expect_err("an unbound window must not reach any connection");
        assert!(err.contains("not connected"));
    }

    // Build a fake pooled connection without opening a socket, so the
    // pool/binding/referrer lifecycle can be exercised in isolation.
    fn register_fake_client(state: &RustRemoteClientState, windows: &[&str]) -> ConnectionKey {
        let key = ConnectionKey::new("host", 9001, "tok");
        let (tx, _rx) = mpsc::channel();
        let client = Arc::new(RunningClient {
            host: "host".to_string(),
            port: 9001,
            compression: RemoteCompression::None,
            protocol: "v2".to_string(),
            server_version: None,
            capabilities: None,
            connected: Arc::new(AtomicBool::new(true)),
            tx,
            referrers: Mutex::new(HashSet::new()),
        });
        state
            .pool
            .lock()
            .unwrap()
            .insert(key.clone(), Arc::clone(&client));
        for window in windows {
            client
                .referrers
                .lock()
                .unwrap()
                .insert((*window).to_string());
            state
                .bindings
                .lock()
                .unwrap()
                .insert((*window).to_string(), key.clone());
        }
        key
    }

    #[test]
    fn last_referrer_release_tears_down_shared_connection() {
        let state = RustRemoteClientState::default();
        let key = register_fake_client(&state, &["win-A", "win-B"]);

        // Each bound window sees its own connection as live.
        assert_eq!(state.status("win-A")["connected"], json!(true));
        assert_eq!(state.status("win-B")["connected"], json!(true));

        // Releasing one referrer keeps the shared socket alive for the sibling.
        assert!(state.disconnect("win-A"));
        assert!(state.pool.lock().unwrap().contains_key(&key));
        assert_eq!(state.status("win-A")["connected"], json!(false));
        assert_eq!(state.status("win-B")["connected"], json!(true));

        // Releasing the last referrer tears the connection down.
        assert!(state.disconnect("win-B"));
        assert!(!state.pool.lock().unwrap().contains_key(&key));
        assert!(!state.disconnect("win-B"), "second release is a no-op");
    }
}
