// worktree:* adapters retain the renderer contract, host routing and async workers.
use super::app::log_tauri;
#[cfg(feature = "desktop")]
use crate::commands::profile as profile_cmd;
use crate::host_context::HostContext;
#[cfg(feature = "desktop")]
use crate::remote_client::RustRemoteClientState;
use crate::sidecar::BridgeError;
#[cfg(feature = "desktop")]
use crate::window_registry;
pub use bat_git::worktree::WorktreeState;
use bat_git::worktree::{
    create_worktree_native, merge_worktree_native, rehydrate_worktree_native,
    remove_worktree_native, worktree_status_native, WorktreeLogger,
};
#[cfg(feature = "desktop")]
use serde_json::json;
use serde_json::Value;
use std::sync::Arc;
#[cfg(feature = "desktop")]
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[cfg(feature = "desktop")]
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
// Remote mutations include several host Git operations; polling has a shorter budget.
#[cfg(feature = "desktop")]
const REMOTE_MUTATION_TIMEOUT: Duration = Duration::from_secs(120);

pub fn ensure_worktree_for_session_native(
    state: &WorktreeState,
    session_id: String,
    cwd: String,
    worktree_path: Option<String>,
    branch_name: Option<String>,
) -> Result<Value, BridgeError> {
    bat_git::worktree::ensure_worktree_for_session_native(
        state,
        session_id,
        cwd,
        worktree_path,
        branch_name,
    )
    .map_err(BridgeError::from)
}

// Remote-client windows must run worktree git/filesystem work on the HOST
// machine: the workspace folder paths they hold only exist there. Mirror the
// claude.rs / git.rs routing — proxy to the host's worktree:* channels
// (remote_server.rs) when the calling window belongs to a remote profile,
// otherwise fall through to the native local implementation.
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
async fn remote_invoke_for_window(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &'static str,
    args: Vec<Value>,
    timeout: Duration,
) -> Option<Result<Value, BridgeError>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let window_label = window.label().to_string();
    let result = crate::async_rt::spawn_blocking(move || {
        remote_client
            .invoke(&window_label, channel, args, timeout)
            .map_err(BridgeError::from)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("remote.invoke {channel} worker failed: {err}"),
    });
    Some(match result {
        Ok(value) => value,
        Err(err) => Err(err),
    })
}

// _local variants hold the actual implementation. The #[tauri::command]
// wrappers add remote routing; remote_server.rs calls these directly when it
// serves the same channels on the host side (no window context there).
pub async fn worktree_create_local(
    app: HostContext,
    state: WorktreeState,
    session_id: String,
    cwd: String,
    install_pnpm: Option<bool>,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || {
        create_worktree_native(
            Some(Arc::new(move |message: &str| log_tauri(&app, message)) as WorktreeLogger),
            &state,
            session_id,
            cwd,
            install_pnpm.unwrap_or(false),
        )
        .map_err(BridgeError::from)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("worktree.create worker failed: {err}"),
    })?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_create(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
    cwd: String,
    install_pnpm: Option<bool>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:create",
        vec![
            json!(session_id.clone()),
            json!(cwd.clone()),
            json!(install_pnpm.unwrap_or(false)),
        ],
        REMOTE_MUTATION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_create_local(
        HostContext::from_app(app),
        (*state).clone(),
        session_id,
        cwd,
        install_pnpm,
    )
    .await
}

pub async fn worktree_remove_local(
    state: WorktreeState,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || {
        remove_worktree_native(&state, session_id, delete_branch)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("worktree.remove worker failed: {err}"),
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_remove(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:remove",
        vec![json!(session_id.clone()), json!(delete_branch)],
        REMOTE_MUTATION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_remove_local((*state).clone(), session_id, delete_branch).await
}

pub async fn worktree_status_local(
    state: WorktreeState,
    session_id: String,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || worktree_status_native(&state, session_id))
        .await
        .map_err(|err| BridgeError {
            message: format!("worktree.status worker failed: {err}"),
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_status(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:status",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_status_local((*state).clone(), session_id).await
}

pub async fn worktree_merge_local(
    state: WorktreeState,
    session_id: String,
    strategy: String,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || merge_worktree_native(&state, session_id, strategy))
        .await
        .map_err(|err| BridgeError {
            message: format!("worktree.merge worker failed: {err}"),
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_merge(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
    strategy: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:merge",
        vec![json!(session_id.clone()), json!(strategy.clone())],
        REMOTE_MUTATION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_merge_local((*state).clone(), session_id, strategy).await
}

pub async fn worktree_rehydrate_local(
    state: WorktreeState,
    session_id: String,
    cwd: String,
    worktree_path: String,
    branch_name: String,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || {
        rehydrate_worktree_native(&state, session_id, cwd, worktree_path, branch_name)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("worktree.rehydrate worker failed: {err}"),
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_rehydrate(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
    cwd: String,
    worktree_path: String,
    branch_name: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:rehydrate",
        vec![
            json!(session_id.clone()),
            json!(cwd.clone()),
            json!(worktree_path.clone()),
            json!(branch_name.clone()),
        ],
        REMOTE_MUTATION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_rehydrate_local(
        (*state).clone(),
        session_id,
        cwd,
        worktree_path,
        branch_name,
    )
    .await
}
