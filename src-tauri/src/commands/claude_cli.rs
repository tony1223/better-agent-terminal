use crate::commands::claude::resolve_claude_cli_path;
use crate::host_context::HostContext;
use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use serde_json::{json, Map, Value};
use std::time::Duration;
use tauri::{AppHandle, State};

const CLI_TIMEOUT: Duration = Duration::from_secs(15);
const CLI_START_TIMEOUT: Duration = Duration::from_secs(30);

fn call_cli(
    app: &HostContext,
    state: &SidecarState,
    method: &str,
    mut params: Value,
    timeout: Duration,
) -> Result<Value, BridgeError> {
    if let Value::Object(map) = &mut params {
        map.entry("cliPath".to_string())
            .or_insert_with(|| Value::String(resolve_claude_cli_path(app)));
    }
    let cfg = app.sidecar_spawn_config()?;
    let sink = app.sidecar_emit_sink();
    state.call_with_emit(&cfg, Some(sink), method, params, timeout)
}

async fn call_cli_blocking(
    app: AppHandle,
    state: State<'_, SidecarState>,
    method: &'static str,
    params: Value,
    timeout: Duration,
) -> Result<Value, BridgeError> {
    let sidecar = (*state).clone();
    crate::async_rt::spawn_blocking(move || {
        call_cli(
            &HostContext::from_app(app.clone()),
            &sidecar,
            method,
            params,
            timeout,
        )
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("{method} worker failed: {err}"),
    })?
}

#[tauri::command]
pub async fn claude_cli_get_capabilities(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, BridgeError> {
    call_cli_blocking(
        app,
        state,
        "claudeCli.getCapabilities",
        json!({}),
        CLI_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn claude_cli_start_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    let mut params = match options {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    params.insert("sessionId".into(), Value::String(session_id));
    call_cli_blocking(
        app,
        state,
        "claudeCli.startSession",
        Value::Object(params),
        CLI_START_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn claude_cli_stop_session(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call_cli_blocking(
        app,
        state,
        "claudeCli.stopSession",
        json!({ "sessionId": session_id }),
        CLI_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn claude_cli_get_status(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    call_cli_blocking(
        app,
        state,
        "claudeCli.getStatus",
        json!({ "sessionId": session_id }),
        CLI_TIMEOUT,
    )
    .await
}
