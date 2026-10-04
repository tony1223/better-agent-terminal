// git:* — read-only git operations the renderer surfaces in
// GitPanel / GitHubPanel / agent panels.
//
// bat-git runs the user's system `git` binary and parses its output. This
// module supplies async command wrappers and remote-profile routing, keeping
// the shared Git core independent of Tauri and agent session code.
//
// All commands return safe defaults (None / empty Vec / empty
// String) when git fails. The renderer treats those as "not a repo / nothing
// to show". We intentionally do NOT propagate stderr to the caller;
// a non-repo cwd is a normal state, not an error.

#[cfg(feature = "desktop")]
use crate::commands::profile as profile_cmd;
#[cfg(feature = "desktop")]
use crate::remote_client::RustRemoteClientState;
#[cfg(feature = "desktop")]
use crate::window_registry;
use bat_git::git::run_git;
pub use bat_git::git::{
    build_diff_args, build_diff_files_args, clamp_log_count, parse_diff_files, parse_github_url,
    parse_log, parse_status, GitFileEntry, GitLogEntry,
};
#[cfg(feature = "desktop")]
use serde::de::DeserializeOwned;
#[cfg(feature = "desktop")]
use serde_json::{json, Value};
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(feature = "desktop")]
const REMOTE_GIT_TIMEOUT: Duration = Duration::from_secs(15);

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
) -> Option<Result<Value, String>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let window_label = window.label().to_string();
    let result = crate::async_rt::spawn_blocking(move || {
        remote_client.invoke(&window_label, channel, args, REMOTE_GIT_TIMEOUT)
    })
    .await
    .map_err(|err| format!("remote.invoke {channel} worker failed: {err}"));
    Some(match result {
        Ok(value) => value,
        Err(err) => Err(err),
    })
}

#[cfg(feature = "desktop")]
fn from_remote_value<T>(value: Value) -> Result<T, String>
where
    T: DeserializeOwned,
{
    serde_json::from_value(value).map_err(|err| err.to_string())
}

async fn run_git_blocking(cwd: String, args: Vec<String>, timeout: Duration) -> Option<String> {
    crate::async_rt::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(&cwd, &refs, timeout)
    })
    .await
    .ok()
    .flatten()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn git_get_github_url(
    app: AppHandle,
    window: WebviewWindow,
    folder_path: String,
) -> Option<String> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "git:get-github-url",
        vec![json!(folder_path.clone())],
    )
    .await
    {
        return match result.and_then(from_remote_value) {
            Ok(value) => value,
            Err(_) => None,
        };
    }
    git_get_github_url_native(folder_path).await
}

pub(crate) async fn git_get_github_url_native(folder_path: String) -> Option<String> {
    let raw = run_git_blocking(
        folder_path,
        vec!["remote".into(), "get-url".into(), "origin".into()],
        Duration::from_secs(3),
    )
    .await?;
    parse_github_url(raw.trim())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn git_get_branch(app: AppHandle, window: WebviewWindow, cwd: String) -> Option<String> {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "git:branch", vec![json!(cwd.clone())]).await
    {
        return match result.and_then(from_remote_value) {
            Ok(value) => value,
            Err(_) => None,
        };
    }
    git_get_branch_native(cwd).await
}

pub(crate) async fn git_get_branch_native(cwd: String) -> Option<String> {
    let raw = run_git_blocking(
        cwd,
        vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
        Duration::from_secs(3),
    )
    .await?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn git_get_log(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
    count: Option<i64>,
) -> Vec<GitLogEntry> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "git:log",
        vec![json!(cwd.clone()), json!(count)],
    )
    .await
    {
        return result
            .and_then(from_remote_value)
            .unwrap_or_else(|_| Vec::new());
    }
    git_get_log_native(cwd, count).await
}

pub(crate) async fn git_get_log_native(cwd: String, count: Option<i64>) -> Vec<GitLogEntry> {
    let n = clamp_log_count(count);
    let n_str = n.to_string();
    let args = vec![
        "log".into(),
        "--pretty=format:%H||%an||%aI||%s".into(),
        "-n".into(),
        n_str,
    ];
    match run_git_blocking(cwd, args, Duration::from_secs(5)).await {
        Some(raw) => parse_log(&raw),
        None => Vec::new(),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn git_get_diff(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
    commit_hash: Option<String>,
    file_path: Option<String>,
) -> String {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "git:diff",
        vec![json!(cwd.clone()), json!(commit_hash), json!(file_path)],
    )
    .await
    {
        return result
            .and_then(from_remote_value)
            .unwrap_or_else(|_| String::new());
    }
    git_get_diff_native(cwd, commit_hash, file_path).await
}

pub(crate) async fn git_get_diff_native(
    cwd: String,
    commit_hash: Option<String>,
    file_path: Option<String>,
) -> String {
    let argv = build_diff_args(commit_hash.as_deref(), file_path.as_deref());
    run_git_blocking(cwd, argv, Duration::from_secs(10))
        .await
        .unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn git_get_diff_files(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
    commit_hash: Option<String>,
) -> Vec<GitFileEntry> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "git:diff-files",
        vec![json!(cwd.clone()), json!(commit_hash)],
    )
    .await
    {
        return result
            .and_then(from_remote_value)
            .unwrap_or_else(|_| Vec::new());
    }
    git_get_diff_files_native(cwd, commit_hash).await
}

pub(crate) async fn git_get_diff_files_native(
    cwd: String,
    commit_hash: Option<String>,
) -> Vec<GitFileEntry> {
    let argv = build_diff_files_args(commit_hash.as_deref());
    match run_git_blocking(cwd, argv, Duration::from_secs(5)).await {
        Some(raw) => parse_diff_files(&raw),
        None => Vec::new(),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn git_get_root(app: AppHandle, window: WebviewWindow, cwd: String) -> Option<String> {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "git:getRoot", vec![json!(cwd.clone())]).await
    {
        return match result.and_then(from_remote_value) {
            Ok(value) => value,
            Err(_) => None,
        };
    }
    git_get_root_native(cwd).await
}

pub(crate) async fn git_get_root_native(cwd: String) -> Option<String> {
    let raw = run_git_blocking(
        cwd,
        vec!["rev-parse".into(), "--show-toplevel".into()],
        Duration::from_secs(5),
    )
    .await?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn git_get_status(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
) -> Vec<GitFileEntry> {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "git:status", vec![json!(cwd.clone())]).await
    {
        return result
            .and_then(from_remote_value)
            .unwrap_or_else(|_| Vec::new());
    }
    git_get_status_native(cwd).await
}

pub(crate) async fn git_get_status_native(cwd: String) -> Vec<GitFileEntry> {
    match run_git_blocking(
        cwd,
        vec![
            "status".into(),
            "--porcelain".into(),
            "--untracked-files=all".into(),
        ],
        Duration::from_secs(5),
    )
    .await
    {
        Some(raw) => parse_status(&raw),
        None => Vec::new(),
    }
}
