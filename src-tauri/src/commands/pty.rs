// Existing PTY host commands and remote routing for the standalone runtime.
#[cfg(feature = "desktop")]
use crate::commands::profile as profile_cmd;
#[cfg(feature = "desktop")]
use crate::commands::worker_buffer::WorkerBufferState;
use crate::host_context::HostContext;
#[cfg(feature = "desktop")]
use crate::remote_client::RustRemoteClientState;
#[cfg(feature = "desktop")]
use crate::window_registry;
pub use bat_pty::pty::*;
use bat_pty::PtyContext;
#[cfg(feature = "desktop")]
use serde::de::DeserializeOwned;
#[cfg(feature = "desktop")]
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
#[cfg(feature = "desktop")]
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, State, WebviewWindow};
#[cfg(feature = "desktop")]
const REMOTE_PTY_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn pty_context(app: &HostContext) -> PtyContext {
    let data_dir = app.data_dir_opt();
    let app = app.clone();
    PtyContext::new(
        data_dir,
        Arc::new(move |window, channel, payload| match window {
            Some(window) => crate::event_hub::publish_runtime_event_to_window(
                &app, window, channel, payload, "rust-pty",
            ),
            None => crate::event_hub::publish_runtime_event(&app, channel, payload, "rust-pty"),
        }),
    )
}
#[cfg(feature = "desktop")]
fn is_remote_profile_window(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Some(profile_id) = window_registry::profile_id_for_window(app, window.label()) else {
        return false;
    };
    profile_cmd::profile_get(app.clone(), profile_id)
        .map(|profile| profile.kind == "remote")
        .unwrap_or(false)
}

#[cfg(feature = "desktop")]
fn remote_invoke_for_window(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &str,
    args: Vec<Value>,
) -> Option<Result<Value, CommandError>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    Some(
        remote_client
            .invoke(window.label(), channel, args, REMOTE_PTY_TIMEOUT)
            .map_err(CommandError::from),
    )
}

#[cfg(feature = "desktop")]
fn remote_value_for_window<T>(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &str,
    args: Vec<Value>,
) -> Option<Result<T, CommandError>>
where
    T: DeserializeOwned,
{
    remote_invoke_for_window(app, window, channel, args).map(|result| {
        result.and_then(|value| serde_json::from_value(value).map_err(CommandError::from))
    })
}

#[cfg(feature = "desktop")]
fn remote_unit_for_window(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &str,
    args: Vec<Value>,
) -> Option<Result<(), CommandError>> {
    remote_invoke_for_window(app, window, channel, args).map(|result| result.map(|_| ()))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn pty_create(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    worker_buffer: State<'_, WorkerBufferState>,
    options: CreatePtyOptions,
) -> Result<String, CommandError> {
    if let Some(result) =
        remote_value_for_window(&app, &window, "pty:create", vec![json!(options.clone())])
    {
        return result;
    }
    let handle = state.handle();
    let worker_buffer_handle = worker_buffer.handle();
    let owner_window = Some(window.label().to_string());
    crate::async_rt::spawn_blocking(move || {
        start_pty_session(
            &crate::host_context::HostContext::from_app(app.clone()),
            handle,
            Some(worker_buffer_handle),
            options,
            owner_window,
        )
    })
    .await
    .map_err(|e| CommandError {
        message: format!("pty.create worker failed: {e}"),
    })?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_write(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), CommandError> {
    let trace_input = pty_input_trace_required(&data);
    if let Some(result) = remote_unit_for_window(
        &app,
        &window,
        "pty:write",
        vec![json!(id.clone()), json!(data.clone())],
    ) {
        if trace_input {
            pty_input_debug_log(
                &crate::host_context::HostContext::from_app(app.clone()),
                format!("route=remote id={id} {}", describe_pty_input(&data)),
            );
        }
        return result;
    }
    if trace_input {
        pty_input_debug_log(
            &crate::host_context::HostContext::from_app(app.clone()),
            format!("route=local id={id} {}", describe_pty_input(&data)),
        );
    }
    claim_pty_session(&state, &id, window.label())?;
    let result = write_pty_session(&state, &id, &data);
    if trace_input {
        match &result {
            Ok(()) => pty_input_debug_log(
                &crate::host_context::HostContext::from_app(app.clone()),
                format!("route=local id={id} enqueue=ok"),
            ),
            Err(err) => pty_input_debug_log(
                &crate::host_context::HostContext::from_app(app.clone()),
                format!("route=local id={id} enqueue=error {}", err.message),
            ),
        }
    }
    result
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_read_buffer(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
) -> Result<String, CommandError> {
    if let Some(result) =
        remote_value_for_window(&app, &window, "pty:read-buffer", vec![json!(id.clone())])
    {
        return result;
    }
    claim_and_read_pty_output_buffer(&state, &id, window.label())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_resize(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    if let Some(result) = remote_unit_for_window(
        &app,
        &window,
        "pty:resize",
        vec![json!(id.clone()), json!(cols), json!(rows)],
    ) {
        return result;
    }
    claim_pty_session(&state, &id, window.label())?;
    resize_pty_session_from_desktop(
        &crate::host_context::HostContext::from_app(app.clone()),
        &state,
        &id,
        cols,
        rows,
    )
    .map(|_| ())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_get_viewport_state(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
) -> Result<TerminalViewportState, CommandError> {
    if let Some(result) = remote_value_for_window(
        &app,
        &window,
        "pty:get-viewport-state",
        vec![json!(id.clone())],
    ) {
        return result;
    }
    claim_pty_session(&state, &id, window.label())?;
    get_pty_viewport_state(&state, &id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_set_viewport_mode(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    mode: TerminalViewportMode,
    options: Option<SetViewportModeOptions>,
) -> Result<TerminalViewportState, CommandError> {
    if let Some(result) = remote_value_for_window(
        &app,
        &window,
        "pty:set-viewport-mode",
        vec![
            json!(id.clone()),
            json!(mode.clone()),
            json!(options.clone()),
        ],
    ) {
        return result;
    }
    claim_pty_session(&state, &id, window.label())?;
    set_pty_viewport_mode(
        &crate::host_context::HostContext::from_app(app.clone()),
        &state,
        &id,
        mode,
        options,
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_set_viewport_size(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    source: TerminalViewportSource,
) -> Result<TerminalViewportState, CommandError> {
    if let Some(result) = remote_value_for_window(
        &app,
        &window,
        "pty:set-viewport-size",
        vec![
            json!(id.clone()),
            json!(cols),
            json!(rows),
            json!(source.clone()),
        ],
    ) {
        return result;
    }
    claim_pty_session(&state, &id, window.label())?;
    set_pty_viewport_size(
        &crate::host_context::HostContext::from_app(app.clone()),
        &state,
        &id,
        cols,
        rows,
        source,
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_kill(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
) -> Result<(), CommandError> {
    if let Some(result) = remote_unit_for_window(&app, &window, "pty:kill", vec![json!(id.clone())])
    {
        return result;
    }
    kill_pty_session_with_exit(
        &crate::host_context::HostContext::from_app(app.clone()),
        &state,
        &id,
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn pty_restart(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    cwd: String,
    shell: Option<String>,
) -> Result<bool, CommandError> {
    if let Some(result) = remote_value_for_window(
        &app,
        &window,
        "pty:restart",
        vec![json!(id.clone()), json!(cwd.clone()), json!(shell.clone())],
    ) {
        return result;
    }
    let state = (*state).clone();
    crate::async_rt::spawn_blocking(move || {
        pty_restart_impl(
            crate::host_context::HostContext::from_app(app),
            state,
            id,
            cwd,
            shell,
        )
    })
    .await
    .map_err(|e| CommandError {
        message: format!("pty.restart worker failed: {e}"),
    })?
}

pub(crate) async fn pty_restart_native(
    app: HostContext,
    state: PtyState,
    id: String,
    cwd: String,
    shell: Option<String>,
) -> Result<bool, CommandError> {
    crate::async_rt::spawn_blocking(move || pty_restart_impl(app, state, id, cwd, shell))
        .await
        .map_err(|e| CommandError {
            message: format!("pty.restart worker failed: {e}"),
        })?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_get_cwd(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
) -> Result<Option<String>, CommandError> {
    if let Some(result) =
        remote_value_for_window(&app, &window, "pty:get-cwd", vec![json!(id.clone())])
    {
        return result;
    }
    get_pty_cwd(&state, &id)
}

pub(crate) fn pty_input_debug_log(app: &HostContext, message: impl AsRef<str>) {
    bat_pty::pty::pty_input_debug_log(&pty_context(app), message)
}

pub(crate) fn start_pty_session(
    app: &HostContext,
    map_handle: Arc<Mutex<HashMap<String, PtyEntry>>>,
    worker_buffer_handle: Option<Arc<Mutex<HashMap<String, String>>>>,
    options: CreatePtyOptions,
    owner_window: Option<String>,
) -> Result<String, CommandError> {
    bat_pty::pty::start_pty_session(
        &pty_context(app),
        map_handle,
        worker_buffer_handle,
        options,
        owner_window,
    )
}

pub(crate) fn resize_pty_session_from_desktop(
    app: &HostContext,
    state: &PtyState,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<bool, CommandError> {
    bat_pty::pty::resize_pty_session_from_desktop(&pty_context(app), state, id, cols, rows)
}

pub(crate) fn resize_pty_session_from_mobile_view(
    app: &HostContext,
    state: &PtyState,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<bool, CommandError> {
    bat_pty::pty::resize_pty_session_from_mobile_view(&pty_context(app), state, id, cols, rows)
}

pub(crate) fn set_pty_viewport_mode(
    app: &HostContext,
    state: &PtyState,
    id: &str,
    mode: TerminalViewportMode,
    options: Option<SetViewportModeOptions>,
) -> Result<TerminalViewportState, CommandError> {
    bat_pty::pty::set_pty_viewport_mode(&pty_context(app), state, id, mode, options)
}

pub(crate) fn set_pty_viewport_size(
    app: &HostContext,
    state: &PtyState,
    id: &str,
    cols: u16,
    rows: u16,
    source: TerminalViewportSource,
) -> Result<TerminalViewportState, CommandError> {
    bat_pty::pty::set_pty_viewport_size(&pty_context(app), state, id, cols, rows, source)
}

pub(crate) fn kill_pty_session(
    app: &HostContext,
    state: &PtyState,
    id: &str,
) -> Result<(), CommandError> {
    bat_pty::pty::kill_pty_session(&pty_context(app), state, id)
}

pub(crate) fn kill_pty_session_with_exit(
    app: &HostContext,
    state: &PtyState,
    id: &str,
) -> Result<(), CommandError> {
    bat_pty::pty::kill_pty_session_with_exit(&pty_context(app), state, id)
}

pub(crate) fn pty_restart_impl(
    app: HostContext,
    state: PtyState,
    id: String,
    cwd: String,
    shell: Option<String>,
) -> Result<bool, CommandError> {
    bat_pty::pty::pty_restart_impl(pty_context(&app), state, id, cwd, shell)
}
