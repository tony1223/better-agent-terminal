// projects_list — project discovery for the sidebar's Projects section.
//
// Thin Tauri command that forwards to the Node sidecar `projects.list` handler
// (node-sidecar/src/handlers/projects.mjs). The sidecar does the git/FS scan
// and session-history merge; this command only marshals params and the result.
//
// Remote profile windows forward the call to the connected host as the
// `projects:list` channel, so the scan runs against the host's filesystem (the
// same machine the window's workspace paths live on). The remote server has no
// dedicated arm for it: unknown channels fall through to the sidecar method of
// the same name (`projects.list`).

use crate::commands::profile as profile_cmd;
use crate::remote_client::RustRemoteClientState;
use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, BridgeError, SidecarState};
use crate::window_registry;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewWindow};

const PROJECTS_TIMEOUT: Duration = Duration::from_secs(20);
const PROJECTS_REMOTE_CHANNEL: &str = "projects:list";

fn is_remote_profile_window(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Some(profile_id) = window_registry::profile_id_for_window(app, window.label()) else {
        return false;
    };
    profile_cmd::profile_get(app.clone(), profile_id)
        .map(|profile| profile.kind == "remote")
        .unwrap_or(false)
}

#[tauri::command]
pub async fn projects_list(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SidecarState>,
    code_roots: Option<Vec<String>>,
) -> Result<Value, BridgeError> {
    let params = json!({ "codeRoots": code_roots.unwrap_or_default() });

    if is_remote_profile_window(&app, &window) {
        let remote_client = app.state::<RustRemoteClientState>().inner().clone();
        let window_label = window.label().to_string();
        return tauri::async_runtime::spawn_blocking(move || {
            // Send the params object both as v2 `params` and as the single
            // legacy-v1 arg (a lone object arg is passed through as params).
            remote_client
                .invoke_params(
                    &window_label,
                    PROJECTS_REMOTE_CHANNEL,
                    vec![params.clone()],
                    Some(params),
                    PROJECTS_TIMEOUT,
                )
                .map_err(BridgeError::from)
        })
        .await
        .map_err(|err| BridgeError {
            message: format!("remote.invoke {PROJECTS_REMOTE_CHANNEL} worker failed: {err}"),
        })?;
    }

    let sidecar = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = resolve_spawn_config(&app)?;
        // The sidecar's event sink is sticky to whichever call first spawns it
        // (see SidecarState::ensure_spawned). If this command spawns the sidecar
        // first (the Projects section can scan early in startup), passing None
        // would drop ALL forwarded events (claude:message/stream/...) for the
        // whole session. Always pass a real sink.
        let sink = app_handle_emit_sink(app.clone());
        sidecar.call_with_emit(&cfg, Some(sink), "projects.list", params, PROJECTS_TIMEOUT)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("projects.list worker failed: {err}"),
    })?
}
