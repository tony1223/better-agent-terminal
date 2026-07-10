// Runtime event hub for renderer-facing pub-sub.
//
// The renderer-facing event contract is compatibility-sensitive: existing
// event names and payload shapes must stay stable. This hub centralizes the
// publish point in Rust without changing what JavaScript receives.

use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::host_context::HostContext;
// The proxied-event broadcast is desktop-only: a desktop host explicitly fans
// proxied events out to connected clients. The headless server has no local
// webview, so HostContext::emit already routes every event straight to
// RemoteServer::broadcast via the emit sink.
use crate::commands::notification;
#[cfg(feature = "desktop")]
use crate::remote_core::is_proxied_remote_event;
#[cfg(feature = "desktop")]
use crate::remote_server::RustRemoteServerState;

#[derive(Clone, Default)]
pub struct RuntimeEventHubState {
    next_seq: Arc<AtomicU64>,
}

enum LocalEventTargets<'a> {
    One(&'a str),
    Many(&'a [String]),
}

impl RuntimeEventHubState {
    pub fn publish(&self, app: &HostContext, topic: &str, payload: Value, origin: &'static str) {
        let target_window = agent_event_window(app, topic, &payload);
        let targets = target_window.as_deref().map(LocalEventTargets::One);
        self.publish_impl(app, targets, topic, payload, origin);
    }

    pub fn publish_to_window(
        &self,
        app: &HostContext,
        window: &str,
        topic: &str,
        payload: Value,
        origin: &'static str,
    ) {
        self.publish_impl(
            app,
            Some(LocalEventTargets::One(window)),
            topic,
            payload,
            origin,
        );
    }

    pub fn publish_to_windows(
        &self,
        app: &HostContext,
        windows: &[String],
        topic: &str,
        payload: Value,
        origin: &'static str,
    ) {
        self.publish_impl(
            app,
            Some(LocalEventTargets::Many(windows)),
            topic,
            payload,
            origin,
        );
    }

    fn publish_impl(
        &self,
        app: &HostContext,
        targets: Option<LocalEventTargets<'_>>,
        topic: &str,
        payload: Value,
        origin: &'static str,
    ) {
        // Keep a monotonic sequence internally so future buffering/replay can
        // be added without changing renderer event payloads.
        let _seq = self.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        // Desktop events with a known owner only wake that webview. Unknown
        // and global events retain the legacy broadcast behaviour. A
        // headless HostContext always emits once to its RemoteServer sink.
        #[cfg(feature = "desktop")]
        match targets {
            Some(LocalEventTargets::One(window)) => {
                app.emit_to(window, topic, payload.clone());
            }
            Some(LocalEventTargets::Many(windows)) if !windows.is_empty() => {
                let mut emitted = std::collections::HashSet::new();
                for window in windows {
                    if emitted.insert(window) {
                        app.emit_to(window, topic, payload.clone());
                    }
                }
            }
            Some(LocalEventTargets::Many(_)) => {}
            None => app.emit(topic, payload.clone()),
        }
        #[cfg(not(feature = "desktop"))]
        {
            let _ = targets;
            app.emit(topic, payload.clone());
        }
        notification::update_agent_session_meta_from_event(app, topic, &payload);
        notification::update_agent_session_worktree_from_event(app, topic, &payload);
        notification::add_agent_completion_from_event(app, topic, &payload);
        #[cfg(feature = "desktop")]
        if origin != "node-sidecar"
            && origin != "rust-remote-client"
            && is_proxied_remote_event(topic)
        {
            if let Some(remote_state) = app.try_state::<RustRemoteServerState>() {
                remote_state.broadcast_event(topic, &payload);
            }
        }
        #[cfg(not(feature = "desktop"))]
        let _ = origin;
    }
}

fn agent_event_window(app: &HostContext, topic: &str, payload: &Value) -> Option<String> {
    if !topic.starts_with("claude:") {
        return None;
    }
    let session_id = payload.get("sessionId").and_then(Value::as_str)?;
    notification::get_agent_session_window(app, session_id)
}

pub fn publish_runtime_event(app: &HostContext, topic: &str, payload: Value, origin: &'static str) {
    let hub = app.state::<RuntimeEventHubState>();
    hub.publish(app, topic, payload, origin);
}

pub fn publish_runtime_event_to_windows(
    app: &HostContext,
    windows: &[String],
    topic: &str,
    payload: Value,
    origin: &'static str,
) {
    let hub = app.state::<RuntimeEventHubState>();
    hub.publish_to_windows(app, windows, topic, payload, origin);
}

pub fn publish_runtime_event_to_window(
    app: &HostContext,
    window: &str,
    topic: &str,
    payload: Value,
    origin: &'static str,
) {
    let hub = app.state::<RuntimeEventHubState>();
    hub.publish_to_window(app, window, topic, payload, origin);
}
