// notification:* — in-memory notification center.
//
// The Electron host pumps notifications in from the agent managers
// (claude/codex). Tauri keeps the same renderer-facing API and
// records agent sessions at the command boundary; when the Rust event
// hub sees a completed `claude:turn-end`, it inserts an entry here.
//
// State is process-local on purpose: the Electron impl
// (electron/notification-center.ts) does the same thing — entries
// are not persisted across launches.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
#[cfg(feature = "desktop")]
use std::time::Duration;

#[cfg(feature = "desktop")]
use crate::commands::app::log_tauri;
#[cfg(feature = "desktop")]
use crate::commands::workspace::remote_profile_target_id;
use crate::event_hub::publish_runtime_event;
#[cfg(feature = "desktop")]
use crate::event_hub::publish_runtime_event_to_windows;
use crate::host_context::HostContext;
#[cfg(feature = "desktop")]
use crate::remote_client::RustRemoteClientState;
#[cfg(feature = "desktop")]
use crate::window_registry;

const MAX_ENTRIES: usize = 50;
pub const AGENT_SESSION_COLLISION_PREFIX: &str = "BAT_AGENT_SESSION_COLLISION";
static NEXT_NOTIFICATION_ID: AtomicU64 = AtomicU64::new(0);

// Mirror renderer/src/stores/notification-store.ts NotificationEntry. The
// renderer-side interface is the source of truth — bumping fields
// here means bumping the TypeScript interface too.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct NotificationEntry {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "windowId")]
    pub window_id: Option<String>,
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
    #[serde(rename = "workspaceId", skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(rename = "workspaceName")]
    pub workspace_name: String,
    pub cwd: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub timestamp: i64,
    pub read: bool,
    #[serde(rename = "agentKind", skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<String>,
    // Distinguishes the notification source. Absent/None = agent
    // completion (the default surface); "remote-client" = a new remote
    // client connected to the host's WebSocket server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    // Free-form headline for non-agent entries (e.g. the connecting
    // client's label). Agent entries leave this None and render from
    // workspace_name instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    // Windows delivers local completion toasts from the host, even while the
    // webview is throttled. Older/remote hosts may omit this additive field.
    #[serde(rename = "nativeNotificationHandled", skip_serializing_if = "Option::is_none")]
    pub native_notification_handled: Option<bool>,
}

#[derive(Default, Clone)]
pub struct NotificationState {
    inner: Arc<Mutex<Vec<NotificationEntry>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentNotificationSession {
    pub window_id: Option<String>,
    pub profile_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub cwd: String,
    pub agent_kind: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub auto_compact_window: Option<i64>,
    pub sdk_session_id: Option<String>,
    pub codex_sandbox_mode: Option<String>,
    pub codex_approval_policy: Option<String>,
    pub latest_meta: Option<Value>,
    pub original_cwd: Option<String>,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub auto_continue: Option<Value>,
    pub is_resting: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentSessionOwner {
    window_id: Option<String>,
    profile_id: Option<String>,
}

#[derive(Default, Clone)]
pub struct AgentNotificationState {
    inner: Arc<Mutex<HashMap<String, AgentNotificationSession>>>,
    owners: Arc<Mutex<HashMap<String, AgentSessionOwner>>>,
}

impl NotificationState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<NotificationEntry>> {
        // Mutex poisoning here would mean a previous handler panicked
        // mid-update; we recover by treating that as "empty store"
        // rather than propagating the poison into every subsequent
        // call. The renderer can re-fetch via list() to resync.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl AgentNotificationState {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, AgentNotificationSession>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_owners(&self) -> std::sync::MutexGuard<'_, HashMap<String, AgentSessionOwner>> {
        self.owners.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct FocusResult {
    pub id: String,
    #[serde(rename = "windowId")]
    pub window_id: String,
}

// The list/mark/clear commands proxy to the host when this window views a
// remote profile: the notification center is host-owned state, so a remote
// window shows the host's entries and the host applies every mutation. The
// focus/window-read commands stay local — they act on local OS windows.
#[cfg(feature = "desktop")]
async fn remote_notification_invoke(
    app: &AppHandle,
    window_label: &str,
    channel: &'static str,
    args: Vec<Value>,
) -> Option<Result<Value, String>> {
    remote_profile_target_id(app, window_label)?;
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let routing_label = window_label.to_string();
    let result = crate::async_rt::spawn_blocking(move || {
        remote_client.invoke(&routing_label, channel, args, Duration::from_secs(15))
    })
    .await;
    Some(match result {
        Ok(value) => value,
        Err(err) => Err(format!("remote.invoke {channel} worker failed: {err}")),
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn notification_list(app: AppHandle, window: WebviewWindow) -> Vec<NotificationEntry> {
    let label = window.label().to_string();
    if let Some(result) = remote_notification_invoke(&app, &label, "notification:list", Vec::new()).await {
        return match result {
            Ok(value) => serde_json::from_value(value).unwrap_or_default(),
            Err(err) => {
                log_tauri(&HostContext::from_app(app.clone()), &format!("[notification] remote list failed: {err}"));
                Vec::new()
            }
        };
    }
    notification_list_core(&HostContext::from_app(app))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn notification_mark_read(app: AppHandle, window: WebviewWindow, id: String) -> bool {
    let label = window.label().to_string();
    if let Some(result) =
        remote_notification_invoke(&app, &label, "notification:mark-read", vec![json!({ "id": id })]).await
    {
        return result.ok().and_then(|v| v.as_bool()).unwrap_or(false);
    }
    notification_mark_read_core(&HostContext::from_app(app), &id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn notification_mark_all_read(app: AppHandle, window: WebviewWindow) -> bool {
    let label = window.label().to_string();
    if let Some(result) =
        remote_notification_invoke(&app, &label, "notification:mark-all-read", Vec::new()).await
    {
        return result.is_ok();
    }
    notification_mark_all_read_core(&HostContext::from_app(app));
    true
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn notification_clear(app: AppHandle, window: WebviewWindow) -> bool {
    let label = window.label().to_string();
    if let Some(result) = remote_notification_invoke(&app, &label, "notification:clear", Vec::new()).await {
        return result.is_ok();
    }
    notification_clear_core(&HostContext::from_app(app));
    true
}

// Host-side implementations. Shared by the local commands above and the
// remote server dispatch (`notification:*` arms in remote_server.rs).
pub fn notification_list_core(app: &HostContext) -> Vec<NotificationEntry> {
    app.try_state::<NotificationState>()
        .map(|state| state.lock().clone())
        .unwrap_or_default()
}

pub fn notification_mark_read_core(app: &HostContext, id: &str) -> bool {
    let Some(state) = app.try_state::<NotificationState>() else {
        return false;
    };
    let updated = {
        let mut entries = state.lock();
        match entries.iter_mut().find(|e| e.id == id) {
            Some(e) if !e.read => {
                e.read = true;
                true
            }
            _ => false,
        }
    };
    if updated {
        publish_update(app, &state);
    }
    updated
}

pub fn notification_mark_all_read_core(app: &HostContext) -> bool {
    let Some(state) = app.try_state::<NotificationState>() else {
        return false;
    };
    let mut changed = false;
    {
        let mut entries = state.lock();
        for e in entries.iter_mut() {
            if !e.read {
                e.read = true;
                changed = true;
            }
        }
    }
    if changed {
        publish_update(app, &state);
    }
    changed
}

pub fn notification_clear_core(app: &HostContext) -> bool {
    let Some(state) = app.try_state::<NotificationState>() else {
        return false;
    };
    let cleared = {
        let mut entries = state.lock();
        if entries.is_empty() {
            false
        } else {
            entries.clear();
            true
        }
    };
    if cleared {
        publish_update(app, &state);
    }
    cleared
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn notification_mark_window_read(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NotificationState>,
) -> bool {
    let window_id = window.label().to_string();
    let mut changed = false;
    {
        let mut entries = state.lock();
        for e in entries.iter_mut() {
            if !e.read && e.window_id.as_deref() == Some(&window_id) {
                e.read = true;
                changed = true;
            }
        }
    }
    if changed {
        publish_update(&HostContext::from_app(app), &state);
    }
    true
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn notification_focus_latest_unread(
    app: AppHandle,
    state: State<'_, NotificationState>,
) -> Option<FocusResult> {
    let (id, window_id, workspace_id) = {
        let entries = state.lock();
        entries
            .iter()
            .find(|entry| !entry.read && entry.window_id.is_some())
            .map(|entry| {
                (
                    entry.id.clone(),
                    entry.window_id.clone().unwrap(),
                    entry.workspace_id.clone(),
                )
            })?
    };
    focus_notification_window(&app, &window_id)?;
    activate_notification_workspace(&app, &window_id, workspace_id.as_deref());
    mark_entry_read_and_emit(&app, &state, &id);
    Some(FocusResult { id, window_id })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn notification_focus_entry(
    app: AppHandle,
    state: State<'_, NotificationState>,
    id: String,
) -> Option<FocusResult> {
    let (window_id, workspace_id) = {
        let entries = state.lock();
        let entry = entries.iter().find(|entry| entry.id == id)?;
        (entry.window_id.clone()?, entry.workspace_id.clone())
    };
    focus_notification_window(&app, &window_id)?;
    activate_notification_workspace(&app, &window_id, workspace_id.as_deref());
    mark_entry_read_and_emit(&app, &state, &id);
    Some(FocusResult { id, window_id })
}

pub fn register_agent_session_from_options(
    app: &HostContext,
    window_id: &str,
    session_id: &str,
    options: Option<&Value>,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Ok(());
    }
    let cwd = effective_notification_cwd(options).unwrap_or_default();
    // The window->profile map is GUI-only; headless sessions carry no local
    // window, so the profile id is supplied by the remote session context.
    #[cfg(feature = "desktop")]
    let profile_id = Some(window_registry::get_entry(app.app(), window_id).profile_id);
    #[cfg(not(feature = "desktop"))]
    let profile_id: Option<String> = None;
    let workspace_id = options.and_then(|value| string_option(value, "workspaceId"));
    let workspace_name = options.and_then(|value| string_option(value, "workspaceName"));
    let agent_kind = options.and_then(agent_kind_from_options);
    let model = options.and_then(|value| string_option(value, "model"));
    let permission_mode = options.and_then(|value| string_option(value, "permissionMode"));
    let effort = options.and_then(|value| {
        if value.get("ultracode").and_then(Value::as_bool) == Some(true) {
            Some("ultracode".to_string())
        } else {
            string_option(value, "effort")
        }
    });
    let auto_compact_window = options.and_then(|value| value.get("autoCompactWindow")?.as_i64());
    let sdk_session_id = options.and_then(|value| string_option(value, "sdkSessionId"));
    let codex_sandbox_mode = options.and_then(|value| string_option(value, "codexSandboxMode"));
    let codex_approval_policy =
        options.and_then(|value| string_option(value, "codexApprovalPolicy"));
    let uses_worktree = options
        .and_then(|value| value.get("useWorktree"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let original_cwd = uses_worktree
        .then(|| options.and_then(|value| string_option(value, "cwd")))
        .flatten();
    let worktree_path = uses_worktree
        .then(|| options.and_then(|value| string_option(value, "worktreePath")))
        .flatten();
    let worktree_branch = uses_worktree
        .then(|| options.and_then(|value| string_option(value, "worktreeBranch")))
        .flatten();
    let next = AgentNotificationSession {
        window_id: Some(window_id.to_string()),
        profile_id,
        workspace_id,
        workspace_name,
        cwd,
        agent_kind,
        model,
        permission_mode,
        effort,
        auto_compact_window,
        sdk_session_id,
        codex_sandbox_mode,
        codex_approval_policy,
        latest_meta: None,
        original_cwd,
        worktree_path,
        worktree_branch,
        auto_continue: Some(default_auto_continue()),
        is_resting: false,
    };
    let requested_owner = AgentSessionOwner {
        window_id: next.window_id.clone(),
        profile_id: next.profile_id.clone(),
    };
    let state = app.state::<AgentNotificationState>();
    let collision = {
        let mut owners = state.lock_owners();
        let collision = owners.get(session_id).and_then(|existing| {
            let owner_is_live = agent_session_owner_window_is_live(app, existing);
            agent_session_collision_message(existing, &requested_owner, session_id, owner_is_live)
        });
        if collision.is_none() {
            owners.insert(session_id.to_string(), requested_owner);
        }
        collision
    };
    if let Some(message) = collision {
        log_agent_session_collision(app, &message);
        return Err(message);
    }
    // Ownership is independent of notification metadata. A malformed or
    // legacy start request without cwd may fail later in the runtime, but it
    // still has to claim its process-wide session id above.
    if next.cwd.is_empty() {
        return Ok(());
    }
    state.lock().insert(session_id.to_string(), next);
    Ok(())
}

fn agent_session_collision_message(
    existing: &AgentSessionOwner,
    requested: &AgentSessionOwner,
    session_id: &str,
    owner_is_live: bool,
) -> Option<String> {
    let same_window = existing.window_id == requested.window_id;
    let same_profile = existing.profile_id == requested.profile_id;
    if same_window && same_profile {
        return None;
    }
    // A closed window from the same profile may be safely re-attached in a
    // newly-created window. A different profile is never allowed to inherit
    // that runtime, even when the old owner window has already closed.
    if same_profile && !owner_is_live {
        return None;
    }
    let short_session_id = session_id.chars().take(8).collect::<String>();
    Some(format!(
        "{AGENT_SESSION_COLLISION_PREFIX}: session {short_session_id} is already owned by profile={} window={}; requested profile={} window={}. BAT blocked the attachment to prevent agent conversations from mixing.",
        existing.profile_id.as_deref().unwrap_or("unknown"),
        existing.window_id.as_deref().unwrap_or("unknown"),
        requested.profile_id.as_deref().unwrap_or("unknown"),
        requested.window_id.as_deref().unwrap_or("unknown"),
    ))
}

#[cfg(feature = "desktop")]
fn agent_session_owner_window_is_live(app: &HostContext, owner: &AgentSessionOwner) -> bool {
    owner
        .window_id
        .as_deref()
        .is_some_and(|window_id| app.app().get_webview_window(window_id).is_some())
}

#[cfg(not(feature = "desktop"))]
fn agent_session_owner_window_is_live(_app: &HostContext, _owner: &AgentSessionOwner) -> bool {
    false
}

#[cfg(feature = "desktop")]
fn log_agent_session_collision(app: &HostContext, message: &str) {
    log_tauri(app, &format!("[agent-session] WARNING {message}"));
}

#[cfg(not(feature = "desktop"))]
fn log_agent_session_collision(_app: &HostContext, _message: &str) {}

#[cfg(feature = "desktop")]
pub fn ensure_agent_session_access(
    app: &HostContext,
    window_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let requested = AgentSessionOwner {
        window_id: Some(window_id.to_string()),
        profile_id: Some(window_registry::get_entry(app.app(), window_id).profile_id),
    };
    let state = app.state::<AgentNotificationState>();
    let (collision, transferred) = {
        let mut owners = state.lock_owners();
        let Some(existing) = owners.get(session_id).cloned() else {
            owners.insert(session_id.to_string(), requested);
            return Ok(());
        };
        let owner_is_live = agent_session_owner_window_is_live(app, &existing);
        let collision =
            agent_session_collision_message(&existing, &requested, session_id, owner_is_live);
        let transferred = collision.is_none() && existing.window_id != requested.window_id;
        if transferred {
            // Same profile, old window gone: transfer event ownership before a
            // read-only state probe decides it can reuse the live runtime.
            owners.insert(session_id.to_string(), requested.clone());
        }
        (collision, transferred)
    };
    if let Some(message) = collision {
        log_agent_session_collision(app, &message);
        Err(message)
    } else {
        if transferred {
            if let Some(session) = state.lock().get_mut(session_id) {
                session.window_id = requested.window_id;
                session.profile_id = requested.profile_id;
            }
        }
        Ok(())
    }
}

pub fn unregister_agent_session(app: &HostContext, session_id: &str) {
    if let Some(state) = app.try_state::<AgentNotificationState>() {
        state.lock().remove(session_id);
        state.lock_owners().remove(session_id);
    }
}

pub fn get_agent_session_cwd(app: &HostContext, session_id: &str) -> Option<String> {
    let state = app.try_state::<AgentNotificationState>()?;
    let cwd = state
        .lock()
        .get(session_id)
        .map(|session| session.cwd.clone());
    cwd
}

pub fn get_agent_session_snapshot(
    app: &HostContext,
    session_id: &str,
) -> Option<AgentNotificationSession> {
    let state = app.try_state::<AgentNotificationState>()?;
    let session = state.lock().get(session_id).cloned();
    session
}

pub fn get_agent_session_window(app: &HostContext, session_id: &str) -> Option<String> {
    let state = app.try_state::<AgentNotificationState>()?;
    let window = state
        .lock()
        .get(session_id)
        .and_then(|session| session.window_id.clone());
    window
}

pub fn add_agent_completion_from_event(app: &HostContext, topic: &str, payload: &Value) {
    if topic != "claude:turn-end" {
        return;
    }
    let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let event_payload = payload.get("payload").unwrap_or(payload);
    if event_payload.get("reason").and_then(Value::as_str) != Some("completed") {
        return;
    }
    let Some(agent_state) = app.try_state::<AgentNotificationState>() else {
        return;
    };
    let Some(session) = agent_state.lock().get(session_id).cloned() else {
        return;
    };
    let Some(notification_state) = app.try_state::<NotificationState>() else {
        return;
    };
    let result = event_payload
        .get("result")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from);
    add_entry(
        app,
        &notification_state,
        NotificationEntry {
            id: next_notification_id(),
            session_id: session_id.to_string(),
            window_id: session.window_id,
            profile_id: session.profile_id,
            workspace_id: session.workspace_id,
            workspace_name: session
                .workspace_name
                .unwrap_or_else(|| workspace_name(&session.cwd)),
            cwd: session.cwd,
            reason: "completed".into(),
            result,
            error: None,
            timestamp: now_ms(),
            read: false,
            agent_kind: session.agent_kind,
            kind: None,
            title: None,
            native_notification_handled: None,
        },
    );
}

// Push an in-app notification when a new remote client connects to the
// host's WebSocket server. Reuses the notification center so it shows up
// in the same bell as agent completions; the renderer branches on
// `kind == "remote-client"` to render the connection headline.
pub fn add_remote_client_notification(app: &HostContext, label: &str) {
    let Some(state) = app.try_state::<NotificationState>() else {
        return;
    };
    let trimmed = label.trim();
    let title = if trimmed.is_empty() {
        "Remote client".to_string()
    } else {
        trimmed.to_string()
    };
    add_entry(
        app,
        &state,
        NotificationEntry {
            id: next_notification_id(),
            session_id: String::new(),
            window_id: None,
            profile_id: None,
            workspace_id: None,
            workspace_name: String::new(),
            cwd: String::new(),
            reason: "connected".into(),
            result: None,
            error: None,
            timestamp: now_ms(),
            read: false,
            agent_kind: None,
            kind: Some("remote-client".into()),
            title: Some(title),
            native_notification_handled: None,
        },
    );
}

pub fn update_agent_session_meta_from_event(app: &HostContext, topic: &str, payload: &Value) {
    if topic != "claude:status" {
        return;
    }
    let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let Some(meta) = payload.get("meta") else {
        return;
    };
    let Some(agent_state) = app.try_state::<AgentNotificationState>() else {
        return;
    };
    let mut sessions = agent_state.lock();
    let Some(session) = sessions.get_mut(session_id) else {
        return;
    };
    session.latest_meta = Some(meta.clone());
    if let Some(cwd) = string_option(meta, "cwd") {
        session.cwd = cwd;
    }
    if let Some(model) = string_option(meta, "model") {
        session.model = Some(model);
    }
    if let Some(permission_mode) = string_option(meta, "permissionMode") {
        session.permission_mode = Some(permission_mode);
    }
    if let Some(effort) = string_option(meta, "effort") {
        session.effort = Some(effort);
    }
    if let Some(sdk_session_id) = string_option(meta, "sdkSessionId") {
        session.sdk_session_id = Some(sdk_session_id);
    }
    if let Some(value) = meta.get("autoCompactWindow").and_then(Value::as_i64) {
        session.auto_compact_window = Some(value);
    }
    if let Some(mode) = string_option(meta, "codexSandboxMode") {
        session.codex_sandbox_mode = Some(mode);
    }
    if let Some(policy) = string_option(meta, "codexApprovalPolicy") {
        session.codex_approval_policy = Some(policy);
    }
}

pub fn update_agent_session_worktree_from_event(app: &HostContext, topic: &str, payload: &Value) {
    if topic != "claude:worktree-info" {
        return;
    }
    let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let Some(agent_state) = app.try_state::<AgentNotificationState>() else {
        return;
    };
    let mut sessions = agent_state.lock();
    let Some(session) = sessions.get_mut(session_id) else {
        return;
    };
    let Some(worktree) = payload.get("payload") else {
        return;
    };
    apply_worktree_payload(session, worktree);
}

pub fn clear_agent_session_worktree(app: &HostContext, session_id: &str) {
    let Some(agent_state) = app.try_state::<AgentNotificationState>() else {
        return;
    };
    let mut sessions = agent_state.lock();
    let Some(session) = sessions.get_mut(session_id) else {
        return;
    };
    if let Some(original_cwd) = session.original_cwd.take() {
        session.cwd = original_cwd;
    }
    session.worktree_path = None;
    session.worktree_branch = None;
}

pub fn set_agent_session_auto_continue(
    app: &HostContext,
    session_id: &str,
    opts: &Value,
) -> Option<bool> {
    let agent_state = app.try_state::<AgentNotificationState>()?;
    let mut sessions = agent_state.lock();
    let session = sessions.get_mut(session_id)?;
    let mut auto = session
        .auto_continue
        .clone()
        .unwrap_or_else(default_auto_continue);
    if let Some(enabled) = opts.get("enabled").and_then(Value::as_bool) {
        auto["enabled"] = Value::Bool(enabled);
    }
    if let Some(max) = opts.get("max").and_then(Value::as_i64) {
        auto["max"] = Value::Number(max.into());
    }
    if let Some(prompt) = string_option(opts, "prompt") {
        auto["prompt"] = Value::String(prompt);
    }
    auto["used"] = Value::Number(0.into());
    session.auto_continue = Some(auto);
    Some(true)
}

pub fn get_agent_session_auto_continue(app: &HostContext, session_id: &str) -> Option<Value> {
    let agent_state = app.try_state::<AgentNotificationState>()?;
    let sessions = agent_state.lock();
    let session = sessions.get(session_id)?;
    Some(
        session
            .auto_continue
            .clone()
            .unwrap_or_else(default_auto_continue),
    )
}

pub fn update_agent_session_permission_mode(app: &HostContext, session_id: &str, mode: &str) {
    update_agent_session_meta_field(
        app,
        session_id,
        "permissionMode",
        Value::String(mode.into()),
    );
}

pub fn update_agent_session_model(
    app: &HostContext,
    session_id: &str,
    model: &str,
    auto_compact_window: Option<i64>,
) {
    update_agent_session_meta_field(app, session_id, "model", Value::String(model.into()));
    if let Some(value) = auto_compact_window {
        update_agent_session_meta_field(
            app,
            session_id,
            "autoCompactWindow",
            Value::Number(value.into()),
        );
    }
}

pub fn update_agent_session_effort(app: &HostContext, session_id: &str, effort: &str) {
    update_agent_session_meta_field(app, session_id, "effort", Value::String(effort.into()));
}

pub fn set_agent_session_resting(app: &HostContext, session_id: &str, resting: bool) {
    let Some(agent_state) = app.try_state::<AgentNotificationState>() else {
        return;
    };
    let mut sessions = agent_state.lock();
    if let Some(session) = sessions.get_mut(session_id) {
        session.is_resting = resting;
    }
}

fn update_agent_session_meta_field(app: &HostContext, session_id: &str, key: &str, value: Value) {
    let Some(agent_state) = app.try_state::<AgentNotificationState>() else {
        return;
    };
    let mut sessions = agent_state.lock();
    let Some(session) = sessions.get_mut(session_id) else {
        return;
    };
    match key {
        "permissionMode" => session.permission_mode = value.as_str().map(String::from),
        "model" => session.model = value.as_str().map(String::from),
        "effort" => session.effort = value.as_str().map(String::from),
        "autoCompactWindow" => session.auto_compact_window = value.as_i64(),
        _ => {}
    }
    if let Some(Value::Object(map)) = session.latest_meta.as_mut() {
        map.insert(key.to_string(), value);
    }
}

fn apply_worktree_payload(session: &mut AgentNotificationSession, worktree: &Value) {
    if worktree.is_null() {
        if let Some(original_cwd) = session.original_cwd.take() {
            session.cwd = original_cwd;
        }
        session.worktree_path = None;
        session.worktree_branch = None;
        return;
    }
    let Some(worktree_path) = string_option(worktree, "worktreePath") else {
        return;
    };
    if session.original_cwd.is_none() {
        session.original_cwd = Some(session.cwd.clone());
    }
    session.cwd = worktree_path.clone();
    session.worktree_path = Some(worktree_path);
    if let Some(branch_name) = string_option(worktree, "branchName") {
        session.worktree_branch = Some(branch_name);
    }
}

// Bring a window to the front and switch it to a workspace. Used by the
// notification center's focus commands and by an OS toast click.
#[cfg(feature = "desktop")]
pub fn focus_window_and_workspace(app: &AppHandle, window_id: &str, workspace_id: Option<&str>) {
    let _ = focus_notification_window(app, window_id);
    activate_notification_workspace(app, window_id, workspace_id);
}

#[cfg(feature = "desktop")]
fn focus_notification_window(app: &AppHandle, window_id: &str) -> Option<()> {
    let win = app.get_webview_window(window_id)?;
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    Some(())
}

// Ask the focused window's renderer to switch to the workspace the agent
// ran in. Focusing the OS window alone isn't enough — several workspaces
// can live as tabs inside one window, so without this the user lands on
// whichever workspace happened to be active. Targeted at the owning
// window so other windows don't react to an id they don't have.
#[cfg(feature = "desktop")]
fn activate_notification_workspace(app: &AppHandle, window_id: &str, workspace_id: Option<&str>) {
    if let Some(workspace_id) = workspace_id.filter(|id| !id.is_empty()) {
        let _ = app.emit_to(
            window_id,
            "notification:activate-workspace",
            json!({ "windowId": window_id, "workspaceId": workspace_id }),
        );
    }
}

#[cfg(feature = "desktop")]
fn mark_entry_read_and_emit(app: &AppHandle, state: &State<'_, NotificationState>, id: &str) {
    let changed = {
        let mut entries = state.lock();
        if let Some(entry) = entries.iter_mut().find(|entry| entry.id == id) {
            if entry.read {
                false
            } else {
                entry.read = true;
                true
            }
        } else {
            false
        }
    };
    if changed {
        publish_update(&HostContext::from_app(app.clone()), state);
    }
}

// Push the current entry list to every listener. Goes through the event hub
// so `notification:update` also reaches remote clients (it is on the
// proxied-event allowlist). Locally it targets only windows that view a
// local profile: a remote-profile window shows the *host's* list, and a
// local update landing there would overwrite it with this machine's entries.
fn publish_update(app: &HostContext, state: &NotificationState) {
    let entries = state.lock().clone();
    let payload = serde_json::to_value(entries).unwrap_or_default();
    #[cfg(feature = "desktop")]
    {
        let handle = app.app();
        let local_windows: Vec<String> = handle
            .webview_windows()
            .keys()
            .filter(|label| remote_profile_target_id(handle, label).is_none())
            .cloned()
            .collect();
        publish_runtime_event_to_windows(
            app,
            &local_windows,
            "notification:update",
            payload,
            "rust-notification",
        );
        return;
    }
    #[cfg(not(feature = "desktop"))]
    publish_runtime_event(app, "notification:update", payload, "rust-notification");
}

// Helper used by the (future) agent sidecar to push a new entry.
// We expose it on `NotificationState` so the eventual claude/codex/
// runtime modules can call it directly without re-parsing JSON.
#[allow(dead_code)]
pub fn add_entry(app: &HostContext, state: &NotificationState, mut entry: NotificationEntry) {
    #[cfg(all(feature = "desktop", windows))]
    handle_native_completion_notification(app, &mut entry);
    {
        let mut entries = state.lock();
        // One entry per workspace: a fresh completion replaces that
        // workspace's previous entry. Keyed by workspace id when known,
        // so sibling workspaces that share a cwd (and window) no longer
        // collapse into a single notification.
        let key = entry_dedup_key(&entry);
        entries.retain(|e| entry_dedup_key(e) != key);
        entries.insert(0, entry);
        if entries.len() > MAX_ENTRIES {
            entries.truncate(MAX_ENTRIES);
        }
    }
    publish_update(app, state);
}

#[cfg(all(feature = "desktop", windows))]
fn handle_native_completion_notification(app: &HostContext, entry: &mut NotificationEntry) {
    if entry.kind.is_some() || entry.reason != "completed" {
        return;
    }
    let Some(label) = entry.window_id.as_deref() else {
        return;
    };
    let Some(window) = app.app().get_webview_window(label) else {
        return;
    };
    // The local host must never deliver a remote profile's toasts. Those
    // windows receive the remote host's entries through their existing API.
    if remote_profile_target_id(app.app(), label).is_some() {
        return;
    }
    let settings = app
        .data_dir_opt()
        .and_then(|dir| crate::commands::settings::settings_load_impl(&dir).ok().flatten())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    let focused = window.is_focused().unwrap_or(false);
    // Claim both delivery and intentional suppression. A delayed renderer
    // must not reconsider focus/settings later and toast an old completion.
    entry.native_notification_handled = Some(true);
    let notify = completion_toast_enabled(&settings, focused);
    log_tauri(app, &format!(
        "[notify] completion id={} session={} eventAt={} hostAt={} focused={focused} deliver={notify}",
        entry.id, entry.session_id, entry.timestamp, now_ms(),
    ));
    if !notify {
        return;
    }
    crate::commands::app::notify_windows_toast(
        app.app().clone(),
        label.to_string(),
        format!("{} ✓", entry.workspace_name),
        entry.result.as_deref().map(completion_toast_body),
        entry.workspace_id.clone(),
        settings.get("notifySound").and_then(Value::as_bool) != Some(false),
    );
}

fn completion_toast_enabled(settings: &Value, focused: bool) -> bool {
    settings.get("notifyOnComplete").and_then(Value::as_bool) != Some(false)
        && !(focused && settings.get("notifyOnlyBackground").and_then(Value::as_bool) == Some(true))
}

fn completion_toast_body(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = line.chars();
    let mut body: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        body.push('…');
    }
    body
}

fn next_notification_id() -> String {
    let seq = NEXT_NOTIFICATION_ID.fetch_add(1, Ordering::SeqCst) + 1;
    format!("notif-{}-{seq}", now_ms())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn workspace_name(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(String::from)
        .unwrap_or_else(|| cwd.to_string())
}

fn effective_notification_cwd(options: Option<&Value>) -> Option<String> {
    let options = options?;
    let cwd = options.get("cwd").and_then(Value::as_str)?;
    if options.get("useWorktree").and_then(Value::as_bool) == Some(true) {
        if let Some(worktree_path) = options
            .get("worktreePath")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
        {
            return Some(worktree_path.to_string());
        }
    }
    Some(cwd.to_string())
}

fn agent_kind_from_options(options: &Value) -> Option<String> {
    match options.get("agentPreset").and_then(Value::as_str) {
        Some("codex-agent" | "codex-agent-worktree") => Some("codex".into()),
        Some("claude-code" | "claude-code-v2" | "claude-code-worktree") | None => {
            Some("claude".into())
        }
        Some(_) => None,
    }
}

fn string_option(options: &Value, key: &str) -> Option<String> {
    options
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

fn default_auto_continue() -> Value {
    serde_json::json!({
        "enabled": false,
        "max": 0,
        "used": 0,
        "prompt": "",
    })
}

// Dedup key for the notification list — one entry per workspace.
// Prefer the workspace id: sibling workspaces can share a cwd, so the
// path alone would wrongly merge them. Falls back to the normalized cwd
// for sessions registered without a workspace id (older renderer, or
// non-workspace sessions).
fn entry_dedup_key(entry: &NotificationEntry) -> String {
    // Remote-client entries carry no workspace/cwd, so without a special
    // case they would all fold into a single "cwd:" key. Dedup per client
    // label instead, so a reconnect from the same client refreshes its
    // entry while different clients each keep their own.
    if entry.kind.as_deref() == Some("remote-client") {
        return match entry.title.as_deref() {
            Some(label) if !label.is_empty() => format!("client:{label}"),
            _ => format!("id:{}", entry.id),
        };
    }
    match entry.workspace_id.as_deref() {
        Some(id) if !id.is_empty() => format!("ws:{id}"),
        _ => format!("cwd:{}", normalize_workspace_key(&entry.cwd)),
    }
}

pub fn normalize_workspace_key(cwd: &str) -> String {
    let normalized = cwd
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        // Windows drive letter — case-insensitive comparison.
        normalized.to_lowercase()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str, cwd: &str, read: bool) -> NotificationEntry {
        NotificationEntry {
            id: id.into(),
            session_id: "s1".into(),
            window_id: Some("main".into()),
            profile_id: None,
            workspace_id: None,
            workspace_name: "ws".into(),
            cwd: cwd.into(),
            reason: "completed".into(),
            result: None,
            error: None,
            timestamp: 0,
            read,
            agent_kind: None,
            kind: None,
            title: None,
            native_notification_handled: None,
        }
    }

    #[test]
    fn completion_toast_uses_settings_and_focus_at_completion() {
        assert!(completion_toast_enabled(&json!({}), false));
        assert!(completion_toast_enabled(&json!({}), true));
        assert!(!completion_toast_enabled(&json!({ "notifyOnComplete": false }), false));
        let background_only = json!({ "notifyOnlyBackground": true });
        assert!(completion_toast_enabled(&background_only, false));
        assert!(!completion_toast_enabled(&background_only, true));
        assert!(completion_toast_enabled(&json!({ "notifyOnlyBackground": false }), true));
    }

    #[test]
    fn native_notification_marker_is_additive_and_survives_broadcast() {
        let mut entry = sample_entry("completion", "/repo", false);
        let old_payload = serde_json::to_value(&entry).unwrap();
        assert!(old_payload.get("nativeNotificationHandled").is_none());
        let restored: NotificationEntry = serde_json::from_value(old_payload).unwrap();
        assert_eq!(restored.native_notification_handled, None);
        entry.native_notification_handled = Some(true);
        let payload = serde_json::to_value(&entry).unwrap();
        assert_eq!(payload["nativeNotificationHandled"], true);
        assert!(!entry.read, "native delivery must not consume the bell's unread entry");
    }

    #[test]
    fn completion_toast_body_preserves_unicode_and_bounds_long_results() {
        assert_eq!(completion_toast_body("已完成\n\n  檢查通過"), "已完成 檢查通過");
        assert_eq!(completion_toast_body(&"刀".repeat(120)), "刀".repeat(120));
        assert_eq!(completion_toast_body(&"刀".repeat(121)), format!("{}…", "刀".repeat(120)));
    }

    #[test]
    fn string_option_trims_empty_values() {
        let options = serde_json::json!({
            "model": " claude-sonnet-4-6 ",
            "effort": ""
        });
        assert_eq!(
            string_option(&options, "model").as_deref(),
            Some("claude-sonnet-4-6")
        );
        assert_eq!(string_option(&options, "effort"), None);
    }

    #[test]
    fn default_auto_continue_matches_electron_shape() {
        let value = default_auto_continue();
        assert_eq!(value["enabled"], false);
        assert_eq!(value["max"], 0);
        assert_eq!(value["used"], 0);
        assert_eq!(value["prompt"], "");
    }

    fn sample_agent_owner(window_id: &str, profile_id: &str) -> AgentSessionOwner {
        AgentSessionOwner {
            window_id: Some(window_id.into()),
            profile_id: Some(profile_id.into()),
        }
    }

    #[test]
    fn agent_session_owner_blocks_cross_window_and_cross_profile_collisions() {
        let existing = sample_agent_owner("window-a", "profile-a");
        let same_owner = sample_agent_owner("window-a", "profile-a");
        assert!(
            agent_session_collision_message(&existing, &same_owner, "session-1", true).is_none()
        );

        let live_sibling = sample_agent_owner("window-b", "profile-a");
        assert!(
            agent_session_collision_message(&existing, &live_sibling, "session-1", true).is_some()
        );
        assert!(
            agent_session_collision_message(&existing, &live_sibling, "session-1", false).is_none()
        );

        let other_profile = sample_agent_owner("window-b", "profile-b");
        let error = agent_session_collision_message(&existing, &other_profile, "session-1", false)
            .expect("cross-profile ownership must remain isolated");
        assert!(error.starts_with(AGENT_SESSION_COLLISION_PREFIX));
        assert!(error.contains("profile=profile-a"));
        assert!(error.contains("profile=profile-b"));
    }

    #[test]
    fn apply_worktree_payload_sets_and_clears_session_worktree() {
        let mut session = AgentNotificationSession {
            window_id: Some("main".into()),
            profile_id: Some("default".into()),
            workspace_id: None,
            workspace_name: None,
            cwd: "/repo".into(),
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

        apply_worktree_payload(
            &mut session,
            &serde_json::json!({
                "worktreePath": "/repo/.bat-worktrees/s-1",
                "branchName": "bat/worktree-s-1"
            }),
        );
        assert_eq!(session.cwd, "/repo/.bat-worktrees/s-1");
        assert_eq!(session.original_cwd.as_deref(), Some("/repo"));
        assert_eq!(session.worktree_branch.as_deref(), Some("bat/worktree-s-1"));

        apply_worktree_payload(&mut session, &Value::Null);
        assert_eq!(session.cwd, "/repo");
        assert_eq!(session.original_cwd, None);
        assert_eq!(session.worktree_path, None);
        assert_eq!(session.worktree_branch, None);
    }

    #[test]
    fn effective_notification_cwd_prefers_worktree_path() {
        let options = serde_json::json!({
            "cwd": "/repo",
            "useWorktree": true,
            "worktreePath": "/repo/.bat-worktrees/s-1"
        });
        assert_eq!(
            effective_notification_cwd(Some(&options)).as_deref(),
            Some("/repo/.bat-worktrees/s-1")
        );
        let no_worktree = serde_json::json!({ "cwd": "/repo" });
        assert_eq!(
            effective_notification_cwd(Some(&no_worktree)).as_deref(),
            Some("/repo")
        );
    }

    #[test]
    fn agent_kind_maps_codex_and_claude_presets() {
        assert_eq!(
            agent_kind_from_options(&serde_json::json!({ "agentPreset": "codex-agent" }))
                .as_deref(),
            Some("codex")
        );
        assert_eq!(
            agent_kind_from_options(&serde_json::json!({ "agentPreset": "claude-code-v2" }))
                .as_deref(),
            Some("claude")
        );
        assert_eq!(
            agent_kind_from_options(&serde_json::json!({ "agentPreset": "unknown" })),
            None
        );
    }

    #[test]
    fn workspace_name_uses_last_path_component() {
        assert_eq!(workspace_name("C:/work/repo"), "repo");
        assert_eq!(workspace_name("/"), "/");
    }

    #[test]
    fn fresh_state_is_empty() {
        let s = NotificationState::default();
        assert!(s.lock().is_empty());
    }

    #[test]
    fn normalize_workspace_key_matches_electron() {
        // Trailing slashes are dropped, backslashes are folded to
        // forward slashes, drive letter is lowercased on Windows.
        assert_eq!(normalize_workspace_key("C:\\Users\\Me"), "c:/users/me");
        assert_eq!(normalize_workspace_key("C:/Users/Me/"), "c:/users/me");
        assert_eq!(normalize_workspace_key("/home/me/repo/"), "/home/me/repo");
        // No drive letter: case is preserved (Linux/macOS are
        // case-sensitive, so collapsing to lowercase would over-merge).
        assert_eq!(normalize_workspace_key("/Home/Me"), "/Home/Me");
    }

    #[test]
    fn entry_serializes_camel_case() {
        // Renderer-side interface uses sessionId / windowId / etc.
        // The serde rename has to land or the renderer reads
        // undefined.
        let e = sample_entry("n1", "/repo", false);
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"sessionId\":\"s1\""));
        assert!(json.contains("\"windowId\":\"main\""));
        assert!(json.contains("\"workspaceName\":\"ws\""));
        // Optional fields with None should be omitted entirely.
        assert!(!json.contains("\"result\":"));
        assert!(!json.contains("\"error\":"));
        assert!(!json.contains("\"agentKind\":"));
        assert!(!json.contains("\"workspaceId\":"));
    }

    #[test]
    fn entry_serializes_workspace_id_when_present() {
        let e = workspace_entry("n1", "ws-1", "/repo");
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"workspaceId\":\"ws-1\""));
    }

    // We can't construct an AppHandle in unit tests, so the state
    // mutation logic is exercised through small wrapper helpers
    // that don't touch the emitter.

    fn raw_mark_read(state: &NotificationState, id: &str) -> bool {
        let mut entries = state.lock();
        match entries.iter_mut().find(|e| e.id == id) {
            Some(e) if !e.read => {
                e.read = true;
                true
            }
            _ => false,
        }
    }

    fn raw_mark_all_read(state: &NotificationState) -> bool {
        let mut entries = state.lock();
        let mut changed = false;
        for e in entries.iter_mut() {
            if !e.read {
                e.read = true;
                changed = true;
            }
        }
        changed
    }

    fn raw_mark_window_read(state: &NotificationState, window_id: &str) -> bool {
        let mut entries = state.lock();
        let mut changed = false;
        for e in entries.iter_mut() {
            if !e.read && e.window_id.as_deref() == Some(window_id) {
                e.read = true;
                changed = true;
            }
        }
        changed
    }

    fn raw_clear(state: &NotificationState) -> bool {
        let mut entries = state.lock();
        if entries.is_empty() {
            false
        } else {
            entries.clear();
            true
        }
    }

    fn raw_add(state: &NotificationState, entry: NotificationEntry) {
        let mut entries = state.lock();
        let key = entry_dedup_key(&entry);
        entries.retain(|e| entry_dedup_key(e) != key);
        entries.insert(0, entry);
        if entries.len() > MAX_ENTRIES {
            entries.truncate(MAX_ENTRIES);
        }
    }

    fn workspace_entry(id: &str, workspace_id: &str, cwd: &str) -> NotificationEntry {
        let mut entry = sample_entry(id, cwd, false);
        entry.workspace_id = Some(workspace_id.into());
        entry
    }

    #[test]
    fn mark_read_only_returns_true_when_changed() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("n1", "/repo", false));
        assert!(raw_mark_read(&state, "n1"));
        // Already read — second call should be a no-op.
        assert!(!raw_mark_read(&state, "n1"));
        // Missing id — also no-op.
        assert!(!raw_mark_read(&state, "missing"));
    }

    #[test]
    fn mark_all_read_returns_true_only_when_anything_changed() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("a", "/r1", false));
        raw_add(&state, sample_entry("b", "/r2", true));
        assert!(raw_mark_all_read(&state));
        // Now everything is read, so a second call reports no change.
        assert!(!raw_mark_all_read(&state));
        let entries = state.lock();
        assert!(entries.iter().all(|e| e.read));
    }

    #[test]
    fn mark_window_read_only_marks_current_window() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("main", "/r1", false));
        let mut other = sample_entry("other", "/r2", false);
        other.window_id = Some("win-2".into());
        raw_add(&state, other);

        assert!(raw_mark_window_read(&state, "main"));
        let entries = state.lock();
        assert!(
            entries
                .iter()
                .find(|entry| entry.id == "main")
                .unwrap()
                .read
        );
        assert!(
            !entries
                .iter()
                .find(|entry| entry.id == "other")
                .unwrap()
                .read
        );
    }

    #[test]
    fn clear_returns_false_when_already_empty() {
        let state = NotificationState::default();
        assert!(!raw_clear(&state));
        raw_add(&state, sample_entry("a", "/r1", false));
        assert!(raw_clear(&state));
        assert!(state.lock().is_empty());
    }

    #[test]
    fn add_dedupes_by_workspace_key() {
        let state = NotificationState::default();
        raw_add(&state, sample_entry("a", "C:/repo", false));
        // Same workspace by case-insensitive key — should replace
        // the existing entry rather than accumulate two.
        raw_add(&state, sample_entry("b", "c:\\repo\\", false));
        let entries = state.lock();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "b");
    }

    #[test]
    fn entry_dedup_key_prefers_workspace_id() {
        let with_id = workspace_entry("a", "ws-1", "C:/repo");
        assert_eq!(entry_dedup_key(&with_id), "ws:ws-1");
        // No workspace id — fall back to the normalized cwd path.
        let without_id = sample_entry("b", "C:/repo", false);
        assert_eq!(entry_dedup_key(&without_id), "cwd:c:/repo");
    }

    fn remote_client_entry(id: &str, label: &str) -> NotificationEntry {
        let mut entry = sample_entry(id, "", false);
        entry.session_id = String::new();
        entry.window_id = None;
        entry.workspace_name = String::new();
        entry.reason = "connected".into();
        entry.kind = Some("remote-client".into());
        entry.title = Some(label.into());
        entry
    }

    #[test]
    fn remote_client_entries_dedup_per_label_not_cwd() {
        // Connection entries carry no cwd; keying on cwd would collapse
        // them all into one. Distinct labels must each keep an entry.
        let a = remote_client_entry("a", "Laptop");
        let b = remote_client_entry("b", "Phone");
        assert_eq!(entry_dedup_key(&a), "client:Laptop");
        assert_ne!(entry_dedup_key(&a), entry_dedup_key(&b));

        let state = NotificationState::default();
        raw_add(&state, a);
        raw_add(&state, b);
        assert_eq!(state.lock().len(), 2);
        // A reconnect from the same label refreshes that entry in place.
        raw_add(&state, remote_client_entry("c", "Laptop"));
        let entries = state.lock();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.id == "c"));
        assert!(!entries.iter().any(|e| e.id == "a"));
    }

    #[test]
    fn add_keeps_sibling_workspaces_sharing_a_cwd() {
        let state = NotificationState::default();
        // Two workspaces opened on the same repo folder.
        raw_add(&state, workspace_entry("a", "ws-1", "C:/repo"));
        raw_add(&state, workspace_entry("b", "ws-2", "C:/repo"));
        // Same cwd, distinct workspace ids — both must survive.
        assert_eq!(state.lock().len(), 2);
        // A newer completion for ws-1 replaces only ws-1's entry.
        raw_add(&state, workspace_entry("c", "ws-1", "C:/repo"));
        let entries = state.lock();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.id == "b"));
        assert!(entries.iter().any(|e| e.id == "c"));
        assert!(!entries.iter().any(|e| e.id == "a"));
    }

    #[test]
    fn add_caps_at_max_entries() {
        let state = NotificationState::default();
        for i in 0..(MAX_ENTRIES + 10) {
            raw_add(
                &state,
                sample_entry(&format!("n{i}"), &format!("/repo/{i}"), false),
            );
        }
        assert_eq!(state.lock().len(), MAX_ENTRIES);
        // Newest entry sits at the front.
        assert_eq!(state.lock()[0].id, format!("n{}", MAX_ENTRIES + 9));
    }

    #[test]
    fn focus_latest_unread_skips_read_and_windowless() {
        let state = NotificationState::default();
        // Add a read entry with a windowId — should be skipped.
        raw_add(&state, sample_entry("read", "/r1", true));
        // Add an unread entry but windowId = None — should be skipped.
        let mut wl = sample_entry("no-window", "/r2", false);
        wl.window_id = None;
        raw_add(&state, wl);
        // Add an unread entry with a windowId — this is the match.
        raw_add(&state, sample_entry("hit", "/r3", false));

        // We can't call notification_focus_latest_unread directly
        // without a State, so reproduce the logic here.
        let entries = state.lock();
        let mut found: Option<FocusResult> = None;
        for e in entries.iter() {
            if !e.read {
                if let Some(w) = &e.window_id {
                    found = Some(FocusResult {
                        id: e.id.clone(),
                        window_id: w.clone(),
                    });
                    break;
                }
            }
        }
        assert_eq!(found.unwrap().id, "hit");
    }
}
