// Worker host commands and remote-profile routing.
use crate::commands::pty::{pty_context, PtyState};
use crate::host_context::HostContext;
pub use bat_pty::worker_buffer::*;
#[cfg(feature = "desktop")]
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, State, WebviewWindow};
#[cfg(feature = "desktop")]
async fn remote_worker_invoke<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &'static str,
    params: serde_json::Value,
) -> Option<Result<T, CommandError>> {
    let result =
        crate::commands::fs::remote_invoke_for_window(app, window, channel, vec![params]).await?;
    Some(
        result
            .and_then(|value| serde_json::from_value(value).map_err(|err| err.to_string()))
            .map_err(|message| CommandError { message }),
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worker_buffer_init(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkerBufferState>,
    panel_id: String,
) -> Result<bool, CommandError> {
    if panel_id.is_empty() {
        return Err(CommandError {
            message: "panel_id required".into(),
        });
    }
    if let Some(result) = remote_worker_invoke::<bool>(
        &app,
        &window,
        "worker:buffer-init",
        json!({ "panelId": panel_id }),
    )
    .await
    {
        return result;
    }
    worker_buffer_init_core(&state.handle(), &panel_id);
    Ok(true)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worker_buffer_append(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkerBufferState>,
    panel_id: String,
    lines: String,
) -> Result<bool, CommandError> {
    if panel_id.is_empty() {
        return Err(CommandError {
            message: "panel_id required".into(),
        });
    }
    if let Some(result) = remote_worker_invoke::<bool>(
        &app,
        &window,
        "worker:buffer-append",
        json!({ "panelId": panel_id, "lines": lines }),
    )
    .await
    {
        return result;
    }
    append_worker_log_lines(&state.handle(), &panel_id, &lines);
    Ok(true)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worker_buffer_read_all(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkerBufferState>,
    panel_id: String,
) -> Result<String, CommandError> {
    if let Some(result) = remote_worker_invoke::<String>(
        &app,
        &window,
        "worker:buffer-read-all",
        json!({ "panelId": panel_id }),
    )
    .await
    {
        return result;
    }
    Ok(worker_buffer_read_all_core(&state.handle(), &panel_id))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worker_buffer_clear(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkerBufferState>,
    panel_id: String,
) -> Result<bool, CommandError> {
    if let Some(result) = remote_worker_invoke::<bool>(
        &app,
        &window,
        "worker:buffer-clear",
        json!({ "panelId": panel_id }),
    )
    .await
    {
        return result;
    }
    worker_buffer_clear_core(&state.handle(), &panel_id);
    Ok(true)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worker_procfile_load(
    app: AppHandle,
    window: WebviewWindow,
    file_path: String,
) -> Result<Vec<ProcfileEntry>, CommandError> {
    if let Some(result) = remote_worker_invoke::<Vec<ProcfileEntry>>(
        &app,
        &window,
        "worker:procfile-load",
        json!({ "filePath": file_path }),
    )
    .await
    {
        return result;
    }
    crate::async_rt::spawn_blocking(move || {
        worker_procfile_load_impl(&file_path).map_err(|message| CommandError { message })
    })
    .await
    .map_err(|err| CommandError {
        message: format!("worker.procfileLoad worker failed: {err}"),
    })?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worker_procfile_start(
    app: AppHandle,
    window: WebviewWindow,
    pty_state: State<'_, PtyState>,
    worker_state: State<'_, WorkerBufferState>,
    options: WorkerProcessStartOptions,
) -> Result<String, CommandError> {
    if crate::commands::fs::is_remote_profile_window(&app, &window) {
        let params =
            json!({ "options": serde_json::to_value(&options).map_err(CommandError::from)? });
        if let Some(result) =
            remote_worker_invoke::<String>(&app, &window, "worker:procfile-start", params).await
        {
            return result;
        }
    }
    let pty_state = (*pty_state).clone();
    let worker_handle = worker_state.handle();
    let owner_window = Some(window.label().to_string());
    crate::async_rt::spawn_blocking(move || {
        worker_procfile_start_core(
            &HostContext::from_app(app.clone()),
            pty_state,
            worker_handle,
            options,
            owner_window,
        )
        .map_err(|message| CommandError { message })
    })
    .await
    .map_err(|err| CommandError {
        message: format!("worker.procfileStart worker failed: {err}"),
    })?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worker_procfile_stop(
    app: AppHandle,
    window: WebviewWindow,
    pty_state: State<'_, PtyState>,
    panel_id: String,
    name: String,
) -> Result<bool, CommandError> {
    if let Some(result) = remote_worker_invoke::<bool>(
        &app,
        &window,
        "worker:procfile-stop",
        json!({ "panelId": panel_id, "name": name }),
    )
    .await
    {
        return result;
    }
    worker_procfile_stop_core(
        &HostContext::from_app(app.clone()),
        &pty_state,
        &panel_id,
        &name,
    )
    .map_err(|message| CommandError { message })?;
    Ok(true)
}

pub fn worker_procfile_start_core(
    ctx: &HostContext,
    pty_state: PtyState,
    worker_handle: Arc<Mutex<HashMap<String, String>>>,
    options: WorkerProcessStartOptions,
    owner_window: Option<String>,
) -> Result<String, String> {
    bat_pty::worker_buffer::worker_procfile_start_core(
        &pty_context(ctx),
        pty_state,
        worker_handle,
        options,
        owner_window,
    )
}

pub fn worker_procfile_stop_core(
    ctx: &HostContext,
    pty_state: &PtyState,
    panel_id: &str,
    name: &str,
) -> Result<(), String> {
    bat_pty::worker_buffer::worker_procfile_stop_core(&pty_context(ctx), pty_state, panel_id, name)
}
