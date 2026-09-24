// remote-tunnel.* — client-side SSH port forwards for remote profiles.
//
// A remote profile may name an SSH target (an alias from ~/.ssh/config or
// user@host). The bat-server on that machine only listens on its loopback,
// so before dialing we spawn `ssh -N -L 127.0.0.1:<free>:<host>:<port>
// <target>` on this machine and dial the forwarded local port instead. One
// tunnel per profile is shared by every window viewing it; a window
// registers itself as an owner on each ensure() and the reaper kills tunnels
// whose owners have all gone away. Mobile profile contexts hold their own
// weak leases, independent of whether a desktop profile window is open.

use crate::host_context::HostContext;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, State, WebviewWindow};

const LOG_LINES: usize = 40;
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);
const LISTEN_WAIT: Duration = Duration::from_secs(15);
const LISTEN_POLL: Duration = Duration::from_millis(250);
const REAPER_INTERVAL: Duration = Duration::from_secs(5);

struct Tunnel {
    child: Child,
    local_port: u16,
    log: Arc<Mutex<VecDeque<String>>>,
    owners: TunnelOwners,
    destination: (String, String, u16),
    started_at: Instant,
}

#[derive(Default)]
struct TunnelOwners {
    windows: HashSet<String>,
    contexts: HashMap<String, Weak<AtomicBool>>,
}

impl TunnelOwners {
    fn retain_live(&mut self, window_alive: impl Fn(&str) -> bool) {
        self.windows.retain(|label| window_alive(label));
        self.contexts.retain(|_, closed| {
            closed
                .upgrade()
                .is_some_and(|closed| !closed.load(Ordering::Acquire))
        });
    }

    fn is_empty(&self) -> bool {
        self.windows.is_empty() && self.contexts.is_empty()
    }
}

enum TunnelOwner {
    #[cfg(feature = "desktop")]
    Window(String),
    Context(String, Weak<AtomicBool>),
}

impl TunnelOwner {
    fn register(&self, owners: &mut TunnelOwners) {
        match self {
            #[cfg(feature = "desktop")]
            Self::Window(label) => {
                owners.windows.insert(label.clone());
            }
            Self::Context(id, closed) => {
                owners.contexts.insert(id.clone(), closed.clone());
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct RemoteTunnelState {
    inner: Arc<Mutex<HashMap<String, Tunnel>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTunnelSpec {
    /// Saved profile to read the SSH target and host address from.
    pub profile_id: Option<String>,
    /// Ad-hoc spec (profile editor before the profile is saved).
    pub ssh_target: Option<String>,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTunnelEndpoint {
    pub ready: bool,
    pub tunneled: bool,
    pub host: String,
    pub port: u16,
    pub spawned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

fn direct(host: String, port: u16) -> RemoteTunnelEndpoint {
    RemoteTunnelEndpoint {
        ready: true,
        tunneled: false,
        host,
        port,
        spawned: false,
        error: None,
        output: None,
    }
}

fn port_is_listening(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
}

fn free_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("could not reserve a local port: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("could not read reserved port: {err}"))
}

pub fn ssh_forward_args(
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
    target: &str,
) -> Vec<String> {
    vec![
        "-T".into(),
        "-N".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
        "-L".into(),
        format!("127.0.0.1:{local_port}:{remote_host}:{remote_port}"),
        target.to_string(),
    ]
}

fn push_log(log: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut buf) = log.lock() {
        if buf.len() >= LOG_LINES {
            buf.pop_front();
        }
        buf.push_back(line);
    }
}

fn log_text(log: &Arc<Mutex<VecDeque<String>>>) -> Option<String> {
    let buf = log.lock().ok()?;
    if buf.is_empty() {
        return None;
    }
    Some(buf.iter().cloned().collect::<Vec<_>>().join("\n"))
}

fn spawn_tunnel(
    app: &HostContext,
    key: &str,
    target: &str,
    remote_host: &str,
    remote_port: u16,
) -> Result<Tunnel, String> {
    let local_port = free_local_port()?;
    let args = ssh_forward_args(local_port, remote_host, remote_port, target);
    let mut command = Command::new("ssh");
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::subprocess::hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("could not start ssh: {err}"))?;
    let log = Arc::new(Mutex::new(VecDeque::new()));
    for stream in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let log = Arc::clone(&log);
        let app = app.clone();
        let key = key.to_string();
        std::thread::spawn(move || {
            // Windows ssh prints localized messages in the OEM code page;
            // `lines()` would stop at the first non-UTF-8 line and drop it.
            for line in BufReader::new(stream).split(b'\n').map_while(Result::ok) {
                let trimmed = String::from_utf8_lossy(&line).trim_end().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                crate::commands::app::log_tauri(&app, &format!("[remote-tunnel:{key}] {trimmed}"));
                push_log(&log, trimmed);
            }
        });
    }
    crate::commands::app::log_tauri(
        app,
        &format!(
            "[remote-tunnel:{key}] spawned ssh {} (pid {})",
            args.join(" "),
            child.id()
        ),
    );
    Ok(Tunnel {
        child,
        local_port,
        log,
        owners: TunnelOwners::default(),
        destination: (target.into(), remote_host.into(), remote_port),
        started_at: Instant::now(),
    })
}

/// The field is documented as an ssh destination, but "ssh ap01" or
/// "ssh user@host" is what people paste from a shell; drop the leading word.
pub fn normalize_ssh_target(raw: &str) -> Option<String> {
    let mut tokens = raw.split_whitespace().peekable();
    if let Some(first) = tokens.peek() {
        let lower = first.to_ascii_lowercase();
        if lower == "ssh" || lower == "ssh.exe" {
            tokens.next();
        }
    }
    let value = tokens.collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn tunnel_key(spec: &RemoteTunnelSpec, target: &str, host: &str, port: u16) -> String {
    match spec
        .profile_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
    {
        Some(id) => format!("profile:{id}"),
        None => format!("adhoc:{target}|{host}:{port}"),
    }
}

fn resolve_spec(
    app: &HostContext,
    spec: &RemoteTunnelSpec,
) -> Result<(Option<String>, String, u16), String> {
    if let Some(profile_id) = spec
        .profile_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
    {
        let profile = crate::commands::profile::profile_entry_for_context(app, profile_id)
            .ok_or_else(|| format!("profile {profile_id} not found"))?;
        let host = profile
            .remote_host
            .clone()
            .unwrap_or_else(|| "127.0.0.1".into());
        let port = profile
            .remote_port
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(9876);
        let target = profile.ssh_target.as_deref().and_then(normalize_ssh_target);
        return Ok((target, host, port));
    }
    let host = spec
        .remote_host
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".into());
    let port = spec.remote_port.unwrap_or(9876);
    let target = spec.ssh_target.as_deref().and_then(normalize_ssh_target);
    Ok((target, host, port))
}

fn wait_for_listen(state: &RemoteTunnelState, key: &str) -> RemoteTunnelEndpoint {
    let deadline = Instant::now() + LISTEN_WAIT;
    loop {
        let (port, exited, output) = {
            let Ok(mut map) = state.inner.lock() else {
                return failed("tunnel state poisoned", None);
            };
            let Some(tunnel) = map.get_mut(key) else {
                return failed("tunnel was stopped while starting", None);
            };
            let exited = matches!(tunnel.child.try_wait(), Ok(Some(_)));
            (tunnel.local_port, exited, log_text(&tunnel.log))
        };
        if exited {
            // Give the reader threads a moment to drain the final lines.
            std::thread::sleep(Duration::from_millis(150));
            let output = state
                .inner
                .lock()
                .ok()
                .and_then(|map| map.get(key).and_then(|t| log_text(&t.log)))
                .or(output);
            if let Ok(mut map) = state.inner.lock() {
                map.remove(key);
            }
            return failed("ssh exited before the tunnel was ready", output);
        }
        if port_is_listening(port) {
            return RemoteTunnelEndpoint {
                ready: true,
                tunneled: true,
                host: "127.0.0.1".into(),
                port,
                spawned: true,
                error: None,
                output: None,
            };
        }
        if Instant::now() >= deadline {
            return failed("timed out waiting for the ssh tunnel to listen", output);
        }
        std::thread::sleep(LISTEN_POLL);
    }
}

fn failed(message: &str, output: Option<String>) -> RemoteTunnelEndpoint {
    RemoteTunnelEndpoint {
        ready: false,
        tunneled: true,
        host: "127.0.0.1".into(),
        port: 0,
        spawned: false,
        error: Some(message.to_string()),
        output,
    }
}

fn ensure_tunnel(
    app: &HostContext,
    state: &RemoteTunnelState,
    owner: TunnelOwner,
    spec: &RemoteTunnelSpec,
) -> RemoteTunnelEndpoint {
    let (target, host, port) = match resolve_spec(app, spec) {
        Ok(resolved) => resolved,
        Err(err) => return failed(&err, None),
    };
    let Some(target) = target else {
        return direct(host, port);
    };
    let key = tunnel_key(spec, &target, &host, port);

    // Serialize creation as well as lookup: simultaneous desktop/mobile opens
    // must not spawn competing children and orphan the losing SSH process.
    let existing_port = {
        let Ok(mut map) = state.inner.lock() else {
            return failed("tunnel state poisoned", None);
        };
        let reusable = map.get_mut(&key).is_some_and(|tunnel| {
            tunnel.destination == (target.clone(), host.clone(), port)
                && matches!(tunnel.child.try_wait(), Ok(None))
        });
        if reusable {
            let tunnel = map.get_mut(&key).unwrap();
            owner.register(&mut tunnel.owners);
            Some(tunnel.local_port)
        } else {
            if let Some(old) = map.remove(&key) {
                kill_tunnel(app, &key, old, "exited or target changed");
            }
            let mut tunnel = match spawn_tunnel(app, &key, &target, &host, port) {
                Ok(tunnel) => tunnel,
                Err(err) => return failed(&err, None),
            };
            owner.register(&mut tunnel.owners);
            map.insert(key.clone(), tunnel);
            None
        }
    };
    if let Some(port) = existing_port {
        if port_is_listening(port) {
            return RemoteTunnelEndpoint {
                ready: true,
                tunneled: true,
                host: "127.0.0.1".into(),
                port,
                spawned: false,
                error: None,
                output: None,
            };
        }
        // Spawned by another window moments ago and still coming up.
        return wait_for_listen(state, &key);
    }

    wait_for_listen(state, &key)
}

/// A phone owns a connection context, not a webview. The weak closed flag is
/// released on profile close, failed open, socket disconnect or context drop.
pub fn ensure_context_tunnel(
    ctx: &HostContext,
    context_id: &str,
    closed: &Arc<AtomicBool>,
    spec: &RemoteTunnelSpec,
) -> RemoteTunnelEndpoint {
    let Some(state) = ctx.try_state::<RemoteTunnelState>() else {
        return failed("SSH tunnel manager unavailable", None);
    };
    if closed.load(Ordering::Acquire) {
        return failed("Profile context closed", None);
    }
    ensure_tunnel(
        ctx,
        &state,
        TunnelOwner::Context(context_id.into(), Arc::downgrade(closed)),
        spec,
    )
}

fn kill_tunnel(app: &HostContext, key: &str, mut tunnel: Tunnel, reason: &str) {
    let _ = tunnel.child.kill();
    let _ = tunnel.child.wait();
    crate::commands::app::log_tauri(app, &format!("[remote-tunnel:{key}] stopped ({reason})"));
}

pub fn stop_tunnels_for_key(app: &HostContext, state: &RemoteTunnelState, key: &str) -> bool {
    let removed = state.inner.lock().ok().and_then(|mut map| map.remove(key));
    match removed {
        Some(tunnel) => {
            kill_tunnel(app, key, tunnel, "stop requested");
            true
        }
        None => false,
    }
}

pub fn stop_all_tunnels(app: &HostContext, state: &RemoteTunnelState) {
    let drained: Vec<(String, Tunnel)> = state
        .inner
        .lock()
        .map(|mut map| map.drain().collect())
        .unwrap_or_default();
    for (key, tunnel) in drained {
        kill_tunnel(app, &key, tunnel, "app exit");
    }
}

/// Every few seconds: drop owner windows that no longer exist and kill
/// tunnels nobody views (or whose ssh has exited).
pub fn start_reaper(app: HostContext) {
    std::thread::spawn(move || loop {
        std::thread::sleep(REAPER_INTERVAL);
        let Some(state) = app.try_state::<RemoteTunnelState>() else {
            continue;
        };
        reap_once(&app, &state);
    });
}

fn reap_once(app: &HostContext, state: &RemoteTunnelState) {
    let mut doomed: Vec<(String, Tunnel, &'static str)> = Vec::new();
    if let Ok(mut map) = state.inner.lock() {
        let keys: Vec<String> = map.keys().cloned().collect();
        for key in keys {
            let Some(tunnel) = map.get_mut(&key) else {
                continue;
            };
            tunnel.owners.retain_live(|_label| {
                #[cfg(feature = "desktop")]
                {
                    app.app().get_webview_window(_label).is_some()
                }
                #[cfg(not(feature = "desktop"))]
                {
                    false
                }
            });
            let exited = matches!(tunnel.child.try_wait(), Ok(Some(_)));
            if exited || tunnel.owners.is_empty() {
                if let Some(tunnel) = map.remove(&key) {
                    doomed.push((key, tunnel, if exited { "ssh exited" } else { "no owners" }));
                }
            }
        }
    }
    for (key, tunnel, reason) in doomed {
        kill_tunnel(app, &key, tunnel, reason);
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn remote_tunnel_ensure(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteTunnelState>,
    spec: RemoteTunnelSpec,
) -> Result<RemoteTunnelEndpoint, String> {
    let state = (*state).clone();
    let owner = window.label().to_string();
    crate::async_rt::spawn_blocking(move || {
        ensure_tunnel(
            &HostContext::from_app(app),
            &state,
            TunnelOwner::Window(owner),
            &spec,
        )
    })
    .await
    .map_err(|err| format!("remote_tunnel_ensure worker failed: {err}"))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn remote_tunnel_stop(
    app: AppHandle,
    state: State<'_, RemoteTunnelState>,
    profile_id: String,
) -> bool {
    stop_tunnels_for_key(
        &HostContext::from_app(app),
        &state,
        &format!("profile:{profile_id}"),
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn remote_tunnel_status(
    state: State<'_, RemoteTunnelState>,
    profile_id: String,
) -> serde_json::Value {
    let key = format!("profile:{profile_id}");
    let Ok(mut map) = state.inner.lock() else {
        return serde_json::json!({ "running": false });
    };
    match map.get_mut(&key) {
        Some(tunnel) => {
            let running = matches!(tunnel.child.try_wait(), Ok(None));
            serde_json::json!({
                "running": running,
                "port": tunnel.local_port,
                "uptimeSeconds": tunnel.started_at.elapsed().as_secs(),
                "output": log_text(&tunnel.log),
            })
        }
        None => serde_json::json!({ "running": false }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_desktop_window_keeps_mobile_owned_tunnel_alive() {
        let closed = Arc::new(AtomicBool::new(false));
        let mut owners = TunnelOwners::default();
        owners.windows.insert("desktop-window".into());
        TunnelOwner::Context("phone".into(), Arc::downgrade(&closed)).register(&mut owners);
        owners.retain_live(|_| false);
        assert!(owners.windows.is_empty());
        assert!(!owners.is_empty());
        closed.store(true, Ordering::Release);
        owners.retain_live(|_| false);
        assert!(owners.is_empty());
    }

    #[test]
    fn closing_one_phone_never_releases_other_phone_or_desktop_owners() {
        let first = Arc::new(AtomicBool::new(false));
        let second = Arc::new(AtomicBool::new(false));
        let mut owners = TunnelOwners::default();
        owners.windows.insert("desktop-window".into());
        TunnelOwner::Context("first".into(), Arc::downgrade(&first)).register(&mut owners);
        let owner = TunnelOwner::Context("second".into(), Arc::downgrade(&second));
        owner.register(&mut owners);
        owner.register(&mut owners); // reconnect refreshes the same lease
        assert_eq!(owners.contexts.len(), 2);
        drop(first); // failed open / dropped context also releases its lease
        owners.retain_live(|_| true);
        assert_eq!(owners.contexts.len(), 1);
        second.store(true, Ordering::Release);
        owners.retain_live(|_| true);
        assert!(owners.contexts.is_empty());
        assert!(!owners.is_empty());
        owners.retain_live(|_| false);
        assert!(owners.is_empty());
    }

    #[test]
    fn forward_args_bind_loopback_only_and_never_prompt() {
        let args = ssh_forward_args(23456, "127.0.0.1", 9876, "ap01");
        assert_eq!(args.last().map(String::as_str), Some("ap01"));
        assert!(args.contains(&"127.0.0.1:23456:127.0.0.1:9876".to_string()));
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"ExitOnForwardFailure=yes".to_string()));
        assert!(args.contains(&"-N".to_string()));
    }

    #[test]
    fn ssh_target_drops_leading_ssh_word() {
        assert_eq!(normalize_ssh_target("ssh ap01").as_deref(), Some("ap01"));
        assert_eq!(
            normalize_ssh_target("  SSH  user@host ").as_deref(),
            Some("user@host")
        );
        assert_eq!(normalize_ssh_target("ap01").as_deref(), Some("ap01"));
        assert_eq!(normalize_ssh_target("ssh"), None);
        assert_eq!(normalize_ssh_target("   "), None);
    }

    #[test]
    fn tunnel_key_prefers_profile_id() {
        let spec = RemoteTunnelSpec {
            profile_id: Some("ap01".into()),
            ssh_target: None,
            remote_host: None,
            remote_port: None,
        };
        assert_eq!(tunnel_key(&spec, "x", "h", 1), "profile:ap01");
        let adhoc = RemoteTunnelSpec {
            profile_id: None,
            ssh_target: Some("ap01".into()),
            remote_host: Some("127.0.0.1".into()),
            remote_port: Some(9876),
        };
        assert_eq!(
            tunnel_key(&adhoc, "ap01", "127.0.0.1", 9876),
            "adhoc:ap01|127.0.0.1:9876"
        );
    }

    #[test]
    fn free_port_is_not_listening_after_release() {
        let port = free_local_port().unwrap();
        assert!(port > 0);
        assert!(!port_is_listening(port));
    }
}
