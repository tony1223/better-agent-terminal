// Tauri resource and event adapters for the standalone Node bridge.
#[cfg(feature = "desktop")]
use crate::event_hub::publish_runtime_event;
pub use bat_agent_bridge::*;
#[cfg(feature = "desktop")]
use serde_json::Value;
#[cfg(feature = "desktop")]
use std::path::PathBuf;
#[cfg(feature = "desktop")]
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};
#[cfg(feature = "desktop")]
pub fn app_handle_emit_sink(app: AppHandle) -> EventSink {
    use crate::host_context::HostContext;
    // Latency samples are peeled off into <data-dir>/metrics and go no further —
    // see latency_store::tap_latency_samples for why they are not forwarded.
    let data_dir = HostContext::from_app(app.clone()).data_dir_opt();
    crate::latency_store::tap_latency_samples(
        data_dir,
        Arc::new(move |name: &str, params: &Value| {
            publish_runtime_event(
                &HostContext::from_app(app.clone()),
                name,
                params.clone(),
                "node-sidecar",
            );
            app.state::<crate::remote_server::RustRemoteServerState>()
                .broadcast_event(name, params);
        }),
    )
}

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
