// remote.* — cross-machine server / client.
//
// The Rust host owns the remote server and the outbound remote client. The
// Node sidecar remains available only behind server-side invoke fallback for
// runtime namespaces that still require the Claude SDK wrapper.

use crate::log_file::append_line;
use crate::remote_client::RustRemoteClientState;
use crate::remote_server::RustRemoteServerState;
use crate::sidecar::{BridgeError, SidecarState};
use crate::{app_data, sidecar};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[derive(Debug, Default, Deserialize, PartialEq)]
struct RemoteAutoStartSettings {
    #[serde(default, rename = "remoteServerAutoStart")]
    auto_start: bool,
    #[serde(default, rename = "remoteServerPort")]
    port: Option<u16>,
    #[serde(default, rename = "remoteServerBindInterface")]
    bind_interface: Option<String>,
}

fn normalize_bind_interface(value: Option<&str>) -> String {
    match value {
        Some(value @ ("localhost" | "tailscale" | "all")) => value.to_string(),
        _ => "localhost".to_string(),
    }
}

fn parse_remote_auto_start_settings(raw: &str) -> RemoteAutoStartSettings {
    let parsed = serde_json::from_str::<RemoteAutoStartSettings>(raw).unwrap_or_default();
    RemoteAutoStartSettings {
        auto_start: parsed.auto_start,
        port: parsed.port,
        bind_interface: Some(normalize_bind_interface(parsed.bind_interface.as_deref())),
    }
}

fn read_remote_auto_start_settings(app: &AppHandle) -> RemoteAutoStartSettings {
    let Ok(dir) = app_data::app_data_dir(app) else {
        return RemoteAutoStartSettings::default();
    };
    let Ok(raw) = fs::read_to_string(dir.join("settings.json")) else {
        return RemoteAutoStartSettings::default();
    };
    parse_remote_auto_start_settings(&raw)
}

fn log_remote_auto_start(app: &AppHandle, message: &str) {
    let Ok(dir) = app_data::app_data_dir(app) else {
        return;
    };
    let _ = append_line(
        &dir.join("logs").join("tauri.log"),
        &format!("[RemoteServer] {message}\n"),
    );
}

fn maybe_auto_start_remote_server(app: AppHandle, state: SidecarState) -> Result<(), String> {
    let settings = read_remote_auto_start_settings(&app);
    if !settings.auto_start {
        return Ok(());
    }

    let remote_state = app.state::<RustRemoteServerState>();
    let status = remote_state.status();
    if status
        .get("running")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Ok(());
    }

    let port = settings.port.unwrap_or(9876);
    let bind_interface = normalize_bind_interface(settings.bind_interface.as_deref());
    let result = remote_state.start(
        crate::host_context::HostContext::from_app(app.clone()),
        state,
        Some(json!({ "port": port, "bindInterface": bind_interface })),
    )?;

    if let Some(error) = result.get("error").and_then(|value| value.as_str()) {
        return Err(error.to_string());
    }
    log_remote_auto_start(
        &app,
        &format!(
            "auto-started on {}:{} (iface={})",
            result
                .get("boundHost")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
            result
                .get("port")
                .and_then(|value| value.as_u64())
                .unwrap_or(port as u64),
            result
                .get("bindInterface")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
        ),
    );
    Ok(())
}

pub fn spawn_auto_start_remote_server(app: AppHandle) {
    let state = app.state::<sidecar::SidecarState>().inner().clone();
    std::thread::spawn(move || {
        if let Err(err) = maybe_auto_start_remote_server(app.clone(), state) {
            log_remote_auto_start(&app, &format!("auto-start failed: {err}"));
        }
    });
}

#[tauri::command]
pub async fn remote_start_server(
    app: AppHandle,
    state: State<'_, SidecarState>,
    remote_state: State<'_, RustRemoteServerState>,
    options: Option<Value>,
) -> Result<Value, BridgeError> {
    let sidecar_state = (*state).clone();
    let options = options.unwrap_or(Value::Null);
    remote_state
        .start(
            crate::host_context::HostContext::from_app(app),
            sidecar_state,
            Some(options),
        )
        .map_err(BridgeError::from)
}

#[tauri::command]
pub async fn remote_stop_server(
    remote_state: State<'_, RustRemoteServerState>,
) -> Result<Value, BridgeError> {
    Ok(Value::Bool(remote_state.stop()))
}

#[tauri::command]
pub async fn remote_server_status(
    remote_state: State<'_, RustRemoteServerState>,
) -> Result<Value, BridgeError> {
    Ok(remote_state.status())
}

#[tauri::command]
pub async fn remote_rotate_token(
    app: AppHandle,
    remote_state: State<'_, RustRemoteServerState>,
) -> Result<Value, BridgeError> {
    remote_state
        .rotate_token(&crate::host_context::HostContext::from_app(app.clone()))
        .map_err(BridgeError::from)
}

#[tauri::command]
pub async fn remote_connect(
    app: AppHandle,
    window: WebviewWindow,
    client_state: State<'_, RustRemoteClientState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
    label: Option<String>,
) -> Result<Value, BridgeError> {
    let state = (*client_state).clone();
    let window_id = Some(window.label().to_string());
    crate::async_rt::spawn_blocking(move || {
        Ok(state
            .connect(
                crate::host_context::HostContext::from_app(app.clone()),
                host,
                port,
                token,
                fingerprint,
                label,
                window_id,
            )
            .unwrap_or_else(|error| json!({ "connected": false, "error": error })))
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("remote.connect worker failed: {err}"),
    })?
}

#[tauri::command]
pub async fn remote_disconnect(
    window: WebviewWindow,
    client_state: State<'_, RustRemoteClientState>,
) -> Result<Value, BridgeError> {
    Ok(Value::Bool(client_state.disconnect(window.label())))
}

#[tauri::command]
pub async fn remote_client_status(
    window: WebviewWindow,
    client_state: State<'_, RustRemoteClientState>,
) -> Result<Value, BridgeError> {
    Ok(client_state.status(window.label()))
}

#[tauri::command]
pub async fn remote_test_connection(
    client_state: State<'_, RustRemoteClientState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
) -> Result<Value, BridgeError> {
    let state = (*client_state).clone();
    crate::async_rt::spawn_blocking(move || {
        Ok(state
            .test_connection(host, port, token, fingerprint)
            .unwrap_or_else(|error| json!({ "ok": false, "error": error })))
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("remote.testConnection worker failed: {err}"),
    })?
}

#[tauri::command]
pub async fn remote_list_profiles(
    client_state: State<'_, RustRemoteClientState>,
    host: String,
    port: u16,
    token: String,
    fingerprint: String,
) -> Result<Value, BridgeError> {
    let state = (*client_state).clone();
    crate::async_rt::spawn_blocking(move || {
        Ok(state
            .list_profiles(host, port, token, fingerprint)
            .unwrap_or_else(|error| json!({ "error": error })))
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("remote.listProfiles worker failed: {err}"),
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_remote_auto_start_settings_reads_electron_shape() {
        let parsed = parse_remote_auto_start_settings(
            r#"{"remoteServerAutoStart":true,"remoteServerPort":12345,"remoteServerBindInterface":"all"}"#,
        );
        assert_eq!(
            parsed,
            RemoteAutoStartSettings {
                auto_start: true,
                port: Some(12345),
                bind_interface: Some("all".to_string()),
            }
        );
    }

    #[test]
    fn parse_remote_auto_start_settings_defaults_invalid_bind_interface() {
        let parsed = parse_remote_auto_start_settings(
            r#"{"remoteServerAutoStart":true,"remoteServerBindInterface":"public"}"#,
        );
        assert_eq!(parsed.bind_interface.as_deref(), Some("localhost"));
    }

    #[test]
    fn parse_remote_auto_start_settings_is_lenient() {
        let parsed = parse_remote_auto_start_settings("{not-json");
        assert_eq!(parsed.auto_start, false);
        assert_eq!(parsed.port, None);
        assert_eq!(parsed.bind_interface.as_deref(), Some("localhost"));
    }
}
