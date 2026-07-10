// workspace:save / workspace:load / workspace:move-to-window for the Tauri shell.
//
// Electron's workspace store is keyed by windowId because that runtime
// supports multi-window workspaces with detach/reattach. The Tauri build now
// keeps a small Rust window registry and snapshots per window/profile. The
// renderer treats payloads as opaque text — same shape as settings.{load,save}
// — which lets the host-api adapter route either runtime without changing
// types.
//
// File location: <app-data>/workspaces.json. We keep the filename stable
// so an Electron→Tauri migration can copy the file from the old userData
// directory without translation. Cross-window move emits the existing
// workspace:reload event so renderer stores can reuse the Electron reload
// path; detach/reattach create and close Tauri webview windows while emitting
// the existing workspace:detached/workspace:reattached events.

use super::app::{log_tauri, renderer_url};
use crate::app_data;
use crate::commands::profile as profile_cmd;
use crate::remote_client::RustRemoteClientState;
use crate::remote_server::RustRemoteServerState;
use crate::window_registry;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use thiserror::Error;

fn bat_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn debug_workspace_log(app: &tauri::AppHandle, message: impl AsRef<str>) {
    if bat_debug_enabled() {
        log_tauri(
            &crate::host_context::HostContext::from_app(app.clone()),
            &format!("[workspace] {}", message.as_ref()),
        );
    }
}

fn workspace_payload_summary(data: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return format!("bytes={} parse=failed", data.len());
    };
    let workspace_count = value
        .get("workspaces")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let terminal_count = value
        .get("terminals")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let active_workspace_id = value
        .get("activeWorkspaceId")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let active_terminal_id = value
        .get("activeTerminalId")
        .and_then(Value::as_str)
        .unwrap_or("none");
    format!(
        "bytes={} workspaces={workspace_count} terminals={terminal_count} activeWorkspace={active_workspace_id} activeTerminal={active_terminal_id}",
        data.len()
    )
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("could not resolve app data directory: {0}")]
    AppDataDir(String),
    #[error("workspace IO error: {0}")]
    Io(#[from] io::Error),
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl From<WorkspaceError> for CommandError {
    fn from(value: WorkspaceError) -> Self {
        Self {
            message: value.to_string(),
        }
    }
}

fn workspace_path(app: &tauri::AppHandle) -> Result<PathBuf, WorkspaceError> {
    let dir = app_data::app_data_dir(app).map_err(WorkspaceError::AppDataDir)?;
    Ok(dir.join("workspaces.json"))
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn workspace_load_impl(
    app: tauri::AppHandle,
    window_label: String,
) -> Result<Option<String>, CommandError> {
    if let Some(text) = window_registry::workspace_json(&app, &window_label) {
        return Ok(Some(text));
    }
    let path = workspace_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(WorkspaceError::from)?;
    Ok(Some(text))
}

fn remote_profile_target_id(app: &tauri::AppHandle, window_label: &str) -> Option<String> {
    let profile_id = window_registry::profile_id_for_window(app, window_label)?;
    let profile = profile_cmd::profile_get(app.clone(), profile_id)?;
    if profile.kind != "remote" {
        return None;
    }
    Some(
        profile
            .remote_profile_id
            .unwrap_or_else(|| "default".to_string()),
    )
}

async fn remote_workspace_invoke(
    app: &tauri::AppHandle,
    window_label: &str,
    channel: &'static str,
    args: Vec<Value>,
) -> Option<Result<Value, CommandError>> {
    let target_profile_id = remote_profile_target_id(app, window_label)?;
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let routing_label = window_label.to_string();
    // Deliberately do NOT send this window's label as the windowId param.
    // Client labels are ephemeral (profile-<id>-<timestamp>-<n>) and never name
    // a registry entry on the HOST, so a trusted host ignores them anyway —
    // while pre-validation hosts fabricate an empty phantom entry from the
    // unknown label on workspace:load and serve an empty list on every
    // reconnect (the saved data stays stranded under the previous label's
    // phantom entry). Omitting windowId makes every host fall back to the
    // profile-level snapshot for both load and save, which is the host-owned
    // source of truth.
    let mut invoke_args = Vec::with_capacity(args.len() + 1);
    invoke_args.push(json!(target_profile_id));
    invoke_args.extend(args);
    let result = crate::async_rt::spawn_blocking(move || {
        remote_client.invoke(
            &routing_label,
            channel,
            invoke_args,
            Duration::from_secs(30),
        )
    })
    .await
    .map_err(|err| CommandError {
        message: format!("remote.invoke {channel} worker failed: {err}"),
    });
    Some(match result {
        Ok(value) => value.map_err(|err| CommandError { message: err }),
        Err(err) => Err(err),
    })
}

#[tauri::command]
pub async fn workspace_load(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, CommandError> {
    let window_label = window.label().to_string();
    if let Some(remote_result) =
        remote_workspace_invoke(&app, &window_label, "workspace:load", Vec::new()).await
    {
        return remote_result.map(|value| match value {
            Value::String(text) => Some(text),
            Value::Null => None,
            other => Some(other.to_string()),
        });
    }
    crate::async_rt::spawn_blocking(move || workspace_load_impl(app, window_label))
        .await
        .map_err(|err| CommandError {
            message: format!("workspace.load worker failed: {err}"),
        })?
}

fn workspace_save_impl(
    app: tauri::AppHandle,
    window_label: String,
    data: String,
) -> Result<bool, CommandError> {
    if window_registry::save_workspace_json(&app, &window_label, &data) {
        return Ok(true);
    }
    // Only the main window may fall back to the legacy global workspaces.json
    // write (covers first-run ordering before its registry entry exists). For
    // any other window a rejected save means the registry entry is gone — e.g.
    // the final teardown save after "Remove from profile" — and writing it to
    // the global file would overwrite the main window's workspace list with
    // this window's state (which may even be remote-adopted host data).
    if window_label != "main" {
        debug_workspace_log(
            &app,
            format!("save dropped window={window_label} reason=no-registry-entry"),
        );
        return Ok(false);
    }
    let path = workspace_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(WorkspaceError::from)?;
    }
    fs::write(&path, data).map_err(WorkspaceError::from)?;
    Ok(true)
}

#[tauri::command]
pub async fn workspace_save(
    app: tauri::AppHandle,
    window: WebviewWindow,
    data: String,
) -> Result<bool, CommandError> {
    let window_label = window.label().to_string();
    debug_workspace_log(
        &app,
        format!(
            "save requested window={} {}",
            window_label,
            workspace_payload_summary(&data)
        ),
    );
    if let Some(remote_result) =
        remote_workspace_invoke(&app, &window_label, "workspace:save", vec![json!(data)]).await
    {
        let result = remote_result.map(|value| value.as_bool().unwrap_or(false));
        match &result {
            Ok(ok) => debug_workspace_log(
                &app,
                format!("save remote-result window={window_label} ok={ok}"),
            ),
            Err(error) => debug_workspace_log(
                &app,
                format!(
                    "save remote-error window={window_label} error={}",
                    error.message
                ),
            ),
        }
        return result;
    }
    let app_for_log = app.clone();
    let log_window_label = window_label.clone();
    let event_window_label = window_label.clone();
    let event_data = data.clone();
    let result =
        crate::async_rt::spawn_blocking(move || workspace_save_impl(app, window_label, data))
            .await
            .map_err(|err| CommandError {
                message: format!("workspace.save worker failed: {err}"),
            })?;
    match &result {
        Ok(ok) => debug_workspace_log(
            &app_for_log,
            format!("save local-result window={log_window_label} ok={ok}"),
        ),
        Err(error) => debug_workspace_log(
            &app_for_log,
            format!(
                "save local-error window={log_window_label} error={}",
                error.message
            ),
        ),
    }
    // The desktop renderer persists its own workspace changes (add/close/rename
    // a session) through this command without going through the remote server,
    // so remote clients otherwise never hear about them and only catch up on
    // their next reload. Broadcast the same workspace:reload a remote-originated
    // save would emit so a phone sitting on this profile updates live. This is
    // remote-only on purpose: the originating window already holds this state,
    // and echoing it back to local windows risks a reload -> save loop.
    if matches!(&result, Ok(true)) {
        if let Some(remote_state) = app_for_log.try_state::<RustRemoteServerState>() {
            let mut payload = json!({ "windowId": event_window_label, "data": event_data });
            if let Some(profile_id) =
                window_registry::profile_id_for_window(&app_for_log, &event_window_label)
            {
                payload["profileId"] = json!(profile_id);
            }
            remote_state.broadcast_event("workspace:reload", &payload);
        }
    }
    result
}

#[tauri::command]
pub async fn workspace_move_to_window(
    app: tauri::AppHandle,
    source_window_id: String,
    target_window_id: String,
    workspace_id: String,
    insert_index: usize,
) -> Result<bool, CommandError> {
    debug_workspace_log(
        &app,
        format!(
            "moveToWindow requested source={} target={} workspace={} insertIndex={}",
            source_window_id, target_window_id, workspace_id, insert_index
        ),
    );
    let worker_app = app.clone();
    let worker_workspace_id = workspace_id.clone();
    let emit_source_window_id = source_window_id.clone();
    let emit_target_window_id = target_window_id.clone();
    let moved = crate::async_rt::spawn_blocking(move || {
        window_registry::move_workspace(
            &worker_app,
            &source_window_id,
            &target_window_id,
            &worker_workspace_id,
            insert_index,
        )
    })
    .await
    .map_err(|err| CommandError {
        message: format!("workspace.moveToWindow worker failed: {err}"),
    })?;

    let Some((source_json, target_json)) = moved else {
        debug_workspace_log(
            &app,
            format!(
                "moveToWindow rejected source={} target={} workspace={}",
                emit_source_window_id, emit_target_window_id, workspace_id
            ),
        );
        return Ok(false);
    };
    debug_workspace_log(
        &app,
        format!(
            "moveToWindow emitting source={} target={} workspace={} sourceBytes={} targetBytes={}",
            emit_source_window_id,
            emit_target_window_id,
            workspace_id,
            source_json.len(),
            target_json.len()
        ),
    );
    let mut source_payload = json!({ "windowId": emit_source_window_id, "data": source_json });
    if let Some(profile_id) = window_registry::profile_id_for_window(&app, &emit_source_window_id) {
        source_payload["profileId"] = json!(profile_id);
    }
    let mut target_payload = json!({ "windowId": emit_target_window_id, "data": target_json });
    if let Some(profile_id) = window_registry::profile_id_for_window(&app, &emit_target_window_id) {
        target_payload["profileId"] = json!(profile_id);
    }
    let _ = app.emit_to(
        &emit_source_window_id,
        "workspace:reload",
        source_payload.clone(),
    );
    let _ = app.emit_to(
        &emit_target_window_id,
        "workspace:reload",
        target_payload.clone(),
    );
    // Like workspace_save, this desktop-driven move never reaches the remote
    // server, so broadcast both windows' reloads to remote clients. Each payload
    // carries its profileId so a phone applies only the one for the profile it
    // is currently viewing.
    if let Some(remote_state) = app.try_state::<RustRemoteServerState>() {
        remote_state.broadcast_event("workspace:reload", &source_payload);
        remote_state.broadcast_event("workspace:reload", &target_payload);
    }
    Ok(true)
}

fn emit_detached_closed(app: &tauri::AppHandle, workspace_id: &str) {
    let Some(entry) = window_registry::remove_detached_entry(app, workspace_id) else {
        return;
    };
    if let Some(parent_id) = entry.detached_parent_window_id {
        let _ = app.emit_to(
            &parent_id,
            "workspace:reattached",
            json!({ "windowId": parent_id, "workspaceId": workspace_id }),
        );
    }
}

#[tauri::command]
pub fn workspace_detach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    workspace_id: String,
) -> Result<bool, CommandError> {
    if let Some(existing) = window_registry::detached_entry_for_workspace(&app, &workspace_id) {
        if let Some(win) = app.get_webview_window(&existing.id) {
            let _ = win.set_focus();
            return Ok(true);
        }
    }

    let parent_window_id = window.label().to_string();
    let Some(entry) =
        window_registry::create_detached_entry(&app, &parent_window_id, &workspace_id)
    else {
        return Ok(false);
    };

    let url = format!(
        "index.html?detached={}",
        encode_query_component(&workspace_id)
    );
    let entry_id = entry.id.clone();
    log_tauri(
        &crate::host_context::HostContext::from_app(app.clone()),
        &format!("[window] detach-queue-build label={entry_id} url=app:{url}"),
    );
    let build_app = app.clone();
    let build_parent_window_id = parent_window_id.clone();
    let build_workspace_id = workspace_id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let schedule_app = build_app.clone();
        let schedule_entry_id = entry_id.clone();
        if let Err(err) = build_app.run_on_main_thread(move || {
            log_tauri(
                &crate::host_context::HostContext::from_app(schedule_app.clone()),
                &format!("[window] detach-create label={schedule_entry_id} url=app:{url}"),
            );
            let nav_app = schedule_app.clone();
            let nav_label = schedule_entry_id.clone();
            let load_label = schedule_entry_id.clone();
            let detached_window = match WebviewWindowBuilder::new(
                &schedule_app,
                &schedule_entry_id,
                renderer_url(&url),
            )
            .title("Better Agent Terminal")
            .inner_size(900.0, 700.0)
            .min_inner_size(600.0, 400.0)
            .on_navigation(move |url| {
                log_tauri(
                    &crate::host_context::HostContext::from_app(nav_app.clone()),
                    &format!("[window] navigation label={nav_label} url={url}"),
                );
                true
            })
            .on_page_load(move |window, payload| {
                log_tauri(
                    &crate::host_context::HostContext::from_app(window.app_handle().clone()),
                    &format!(
                        "[window] page-load label={load_label} event={:?} url={}",
                        payload.event(),
                        payload.url()
                    ),
                );
            })
            .build()
            {
                Ok(win) => win,
                Err(err) => {
                    let _ =
                        window_registry::remove_detached_entry(&schedule_app, &build_workspace_id);
                    log_tauri(
                        &crate::host_context::HostContext::from_app(schedule_app.clone()),
                        &format!(
                            "[window] detach-build-failed label={schedule_entry_id} error={err}"
                        ),
                    );
                    return;
                }
            };

            let close_app = schedule_app.clone();
            let close_workspace_id = build_workspace_id.clone();
            detached_window.on_window_event(move |event| {
                if matches!(
                    event,
                    WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                ) {
                    emit_detached_closed(&close_app, &close_workspace_id);
                }
            });

            log_tauri(
                &crate::host_context::HostContext::from_app(schedule_app.clone()),
                &format!("[window] detach-created label={schedule_entry_id}"),
            );
            let _ = schedule_app.emit_to(
                &build_parent_window_id,
                "workspace:detached",
                json!({ "windowId": build_parent_window_id, "workspaceId": build_workspace_id }),
            );
        }) {
            log_tauri(
                &crate::host_context::HostContext::from_app(build_app.clone()),
                &format!("[window] detach-schedule-failed label={entry_id} error={err}"),
            );
        }
    });
    Ok(true)
}

#[tauri::command]
pub fn workspace_reattach(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<bool, CommandError> {
    let Some(entry) = window_registry::detached_entry_for_workspace(&app, &workspace_id) else {
        return Ok(true);
    };
    if let Some(win) = app.get_webview_window(&entry.id) {
        let _ = win.close();
        return Ok(true);
    }
    emit_detached_closed(&app, &workspace_id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_path_uses_workspaces_json_filename() {
        // We can't easily build an AppHandle in a unit test; assert on the
        // filename component to guard against accidental rename of the
        // on-disk file (which would lose user workspace state on upgrade).
        let p = PathBuf::from("/fake/app-data").join("workspaces.json");
        assert_eq!(p.file_name().unwrap(), "workspaces.json");
    }

    #[test]
    fn query_component_encoder_percent_encodes_unsafe_bytes() {
        assert_eq!(encode_query_component("abc-_.~123"), "abc-_.~123");
        assert_eq!(
            encode_query_component("a b/中文"),
            "a%20b%2F%E4%B8%AD%E6%96%87"
        );
    }
}
