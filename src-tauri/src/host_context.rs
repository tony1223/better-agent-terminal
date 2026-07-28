// The decoupling seam between the RemoteServer / agent-session backend and
// Tauri.
//
// Goal (issue #117 + architecture): the server core (remote server, sessions,
// PTY, sidecar bridge) is domain logic and must not depend on the GUI shell
// (`tauri` -> `wry` -> `webkit2gtk`). Server-reachable code takes `&HostContext`
// instead of `tauri::AppHandle`; `HostContext` has two backings selected by the
// `desktop` feature:
//
//   * desktop  -> wraps a live `tauri::AppHandle` (behaviour identical to before)
//   * headless -> wraps an `Arc<HeadlessHost>`: a tauri-free state registry +
//                 event sink, so the `bat-server` binary links no wry/webkit.
//
// The headless backing stores states in a `TypeId`-keyed map of `dyn Any`, so
// this module compiles without statically referencing each concrete state type
// (breaking the `HeadlessHost` <-> `RustRemoteServerState` cycle). Concrete
// states are inserted at construction time in the headless `run_headless_server`.

use serde_json::Value;
use std::path::PathBuf;

#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, Manager};

use crate::sidecar::{BridgeError, EventSink, SidecarState, SpawnConfig};

// ===================== desktop backing =====================

#[cfg(feature = "desktop")]
#[derive(Clone)]
pub struct HostContext {
    app: AppHandle,
}

#[cfg(feature = "desktop")]
impl HostContext {
    pub fn from_app(app: AppHandle) -> Self {
        Self { app }
    }

    /// Escape hatch for call paths not yet migrated off `AppHandle` (desktop
    /// only). New code should prefer the typed accessors below.
    #[allow(dead_code)]
    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    /// A managed shared state, cloned out (states are cheap `Arc` handles).
    #[allow(dead_code)]
    pub fn state<T: Clone + Send + Sync + 'static>(&self) -> T {
        self.app.state::<T>().inner().clone()
    }

    #[allow(dead_code)]
    pub fn try_state<T: Clone + Send + Sync + 'static>(&self) -> Option<T> {
        self.app.try_state::<T>().map(|s| s.inner().clone())
    }

    /// Push a renderer-facing event to local webviews.
    #[allow(dead_code)]
    pub fn emit(&self, topic: &str, payload: Value) {
        let _ = self.app.emit(topic, payload);
    }

    #[allow(dead_code)]
    pub fn emit_to(&self, window: &str, topic: &str, payload: Value) {
        let _ = self.app.emit_to(window, topic, payload);
    }

    #[allow(dead_code)]
    pub fn version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    #[allow(dead_code)]
    pub fn data_dir(&self) -> Result<PathBuf, String> {
        crate::app_data::app_data_dir(&self.app)
    }

    #[allow(dead_code)]
    pub fn data_dir_opt(&self) -> Option<PathBuf> {
        crate::app_data::app_data_dir_opt(&self.app)
    }

    #[allow(dead_code)]
    pub fn resource_dir(&self) -> Option<PathBuf> {
        self.app.path().resource_dir().ok()
    }

    #[allow(dead_code)]
    pub fn home_dir(&self) -> Option<PathBuf> {
        self.app.path().home_dir().ok()
    }

    #[allow(dead_code)]
    pub fn sidecar(&self) -> SidecarState {
        self.app.state::<SidecarState>().inner().clone()
    }

    pub fn sidecar_spawn_config(&self) -> Result<SpawnConfig, BridgeError> {
        crate::sidecar::resolve_spawn_config(&self.app)
    }

    pub fn sidecar_emit_sink(&self) -> EventSink {
        crate::sidecar::app_handle_emit_sink(self.app.clone())
    }
}

// ===================== headless backing =====================

/// Tauri-free host registry backing `HostContext` in the `bat-server` build.
/// Holds the managed states (as `dyn Any`), the data dir, and an event sink
/// that broadcasts to connected remote clients. Constructed once by the
/// headless `run_headless_server`.
#[cfg(not(feature = "desktop"))]
pub struct HeadlessHost {
    states: std::collections::HashMap<std::any::TypeId, Box<dyn std::any::Any + Send + Sync>>,
    data_dir: Option<PathBuf>,
    emit_sink: EventSink,
}

#[cfg(not(feature = "desktop"))]
impl HeadlessHost {
    #[allow(dead_code)]
    pub fn new(data_dir: Option<PathBuf>, emit_sink: EventSink) -> Self {
        Self {
            states: std::collections::HashMap::new(),
            data_dir,
            emit_sink,
        }
    }

    /// Register a managed state. Call once per state type before serving.
    #[allow(dead_code)]
    pub fn manage<T: Send + Sync + 'static>(&mut self, state: T) {
        self.states
            .insert(std::any::TypeId::of::<T>(), Box::new(state));
    }
}

#[cfg(not(feature = "desktop"))]
#[derive(Clone)]
pub struct HostContext {
    inner: std::sync::Arc<HeadlessHost>,
}

#[cfg(not(feature = "desktop"))]
impl HostContext {
    #[allow(dead_code)]
    pub fn from_headless(inner: std::sync::Arc<HeadlessHost>) -> Self {
        Self { inner }
    }

    #[allow(dead_code)]
    pub fn state<T: Clone + Send + Sync + 'static>(&self) -> T {
        self.try_state::<T>()
            .expect("HostContext::state: state type not registered on HeadlessHost")
    }

    #[allow(dead_code)]
    pub fn try_state<T: Clone + Send + Sync + 'static>(&self) -> Option<T> {
        self.inner
            .states
            .get(&std::any::TypeId::of::<T>())
            .and_then(|b| b.downcast_ref::<T>())
            .cloned()
    }

    /// No local webviews headless; events reach remote clients via the sink
    /// (RemoteServer broadcast).
    #[allow(dead_code)]
    pub fn emit(&self, topic: &str, payload: Value) {
        (self.inner.emit_sink)(topic, &payload);
    }

    #[allow(dead_code)]
    pub fn emit_to(&self, _window: &str, topic: &str, payload: Value) {
        (self.inner.emit_sink)(topic, &payload);
    }

    /// The desktop backing reads this from Tauri's generated package info;
    /// headless has no Tauri context, so `build.rs` exports the same
    /// `tauri.conf.json` version as `BAT_APP_VERSION`. `CARGO_PKG_VERSION` is
    /// *not* it — the release pipeline never rewrites Cargo.toml, so it would
    /// pin every `bat-server` release to a stale 0.1.0.
    #[allow(dead_code)]
    pub fn version(&self) -> String {
        env!("BAT_APP_VERSION").to_string()
    }

    #[allow(dead_code)]
    pub fn data_dir(&self) -> Result<PathBuf, String> {
        self.inner
            .data_dir
            .clone()
            .ok_or_else(|| "headless: app data dir not configured".to_string())
    }

    #[allow(dead_code)]
    pub fn data_dir_opt(&self) -> Option<PathBuf> {
        self.inner.data_dir.clone()
    }

    #[allow(dead_code)]
    pub fn resource_dir(&self) -> Option<PathBuf> {
        None
    }

    #[allow(dead_code)]
    pub fn home_dir(&self) -> Option<PathBuf> {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
    }

    #[allow(dead_code)]
    pub fn sidecar(&self) -> SidecarState {
        self.state::<SidecarState>()
    }

    pub fn sidecar_spawn_config(&self) -> Result<SpawnConfig, BridgeError> {
        crate::sidecar::resolve_spawn_config_headless(self.inner.data_dir.clone())
    }

    pub fn sidecar_emit_sink(&self) -> EventSink {
        self.inner.emit_sink.clone()
    }
}

#[cfg(test)]
mod tests {
    // `bat-server` reports `BAT_APP_VERSION` as `serverVersion` in the auth
    // handshake, and remote clients compare it against their own version to warn
    // about skew (issue #115). If it ever drifts from the version the release
    // pipeline writes into tauri.conf.json, every connection to a headless host
    // raises a false mismatch.
    #[test]
    fn app_version_matches_tauri_config() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must parse");
        assert_eq!(
            config["version"].as_str(),
            Some(env!("BAT_APP_VERSION")),
            "build.rs must export the tauri.conf.json version as BAT_APP_VERSION",
        );
    }
}
