// fs:* — Tauri, remote-profile, and host-context adapters.
#[cfg(feature = "desktop")]
use crate::commands::profile as profile_cmd;
use crate::event_hub::publish_runtime_event;
use crate::host_context::HostContext;
use crate::path_guard::resolve_transfer_path;
use crate::remote_client::RustRemoteClientState;
#[cfg(feature = "desktop")]
use crate::window_registry;
pub use bat_filesystem::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, State, WebviewWindow};
const REMOTE_FS_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(feature = "desktop")]
pub(crate) fn is_remote_profile_window(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Some(profile_id) = window_registry::profile_id_for_window(app, window.label()) else {
        return false;
    };
    profile_cmd::profile_get(app.clone(), profile_id)
        .map(|profile| profile.kind == "remote")
        .unwrap_or(false)
}

#[cfg(feature = "desktop")]
pub(crate) async fn remote_invoke_for_window(
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
        remote_client.invoke(&window_label, channel, args, REMOTE_FS_TIMEOUT)
    })
    .await
    .map_err(|err| format!("remote.invoke {channel} worker failed: {err}"));
    Some(match result {
        Ok(value) => value,
        Err(err) => Err(err),
    })
}

#[cfg(feature = "desktop")]
fn remote_invoke_for_window_blocking(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &str,
    args: Vec<Value>,
) -> Option<Result<Value, String>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    Some(remote_client.invoke(window.label(), channel, args, REMOTE_FS_TIMEOUT))
}

fn from_remote_value<T>(value: Value) -> Result<T, String>
where
    T: DeserializeOwned,
{
    serde_json::from_value(value).map_err(|err| err.to_string())
}

fn home_string(app: &HostContext) -> Option<PathBuf> {
    app.home_dir()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_read_file(app: AppHandle, window: WebviewWindow, path: String) -> FsReadResult {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "fs:readFile", vec![json!(path.clone())]).await
    {
        return result
            .and_then(from_remote_value)
            .unwrap_or_else(|err| FsReadResult {
                error: Some(err),
                ..Default::default()
            });
    }
    crate::async_rt::spawn_blocking(move || fs_read_file_impl(path))
        .await
        .unwrap_or_else(|err| FsReadResult {
            error: Some(err.to_string()),
            ..Default::default()
        })
}

pub(crate) fn fs_home_native(app: &HostContext) -> String {
    home_string(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| String::from("/"))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_home(app: AppHandle, window: WebviewWindow) -> String {
    if let Some(result) = remote_invoke_for_window(&app, &window, "fs:home", vec![]).await {
        return result
            .and_then(from_remote_value)
            .unwrap_or_else(|_| String::from("/"));
    }
    fs_home_native(&crate::host_context::HostContext::from_app(app.clone()))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_readdir(app: AppHandle, window: WebviewWindow, dir_path: String) -> Vec<FsEntry> {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "fs:readdir", vec![json!(dir_path.clone())]).await
    {
        return result.and_then(from_remote_value).unwrap_or_default();
    }
    crate::async_rt::spawn_blocking(move || fs_readdir_impl(dir_path))
        .await
        .unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_is_directory(app: AppHandle, window: WebviewWindow, path: String) -> bool {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "fs:isDirectory", vec![json!(path.clone())]).await
    {
        return result.and_then(from_remote_value).unwrap_or(false);
    }
    crate::async_rt::spawn_blocking(move || fs_is_directory_impl(path))
        .await
        .unwrap_or(false)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_list_dirs(
    app: AppHandle,
    window: WebviewWindow,
    dir_path: String,
    include_hidden: bool,
) -> ListDirsResult {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "fs:list-dirs",
        vec![json!(dir_path.clone()), json!(include_hidden)],
    )
    .await
    {
        return result
            .and_then(from_remote_value)
            .unwrap_or_else(|err| ListDirsResult {
                error: Some(err),
                ..Default::default()
            });
    }
    let home = home_string(&crate::host_context::HostContext::from_app(app.clone()))
        .unwrap_or_else(|| PathBuf::from("/"));
    crate::async_rt::spawn_blocking(move || fs_list_dirs_impl(home, dir_path, include_hidden))
        .await
        .unwrap_or_else(|e| ListDirsResult {
            error: Some(format!("list dirs task failed: {e}")),
            ..Default::default()
        })
}

pub(crate) fn fs_list_dirs_native(
    app: &HostContext,
    dir_path: String,
    include_hidden: bool,
) -> ListDirsResult {
    let home = home_string(app).unwrap_or_else(|| PathBuf::from("/"));
    fs_list_dirs_impl(home, dir_path, include_hidden)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_mkdir(
    app: AppHandle,
    window: WebviewWindow,
    parent_path: String,
    name: String,
) -> PathOrError {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "fs:mkdir",
        vec![json!(parent_path.clone()), json!(name.clone())],
    )
    .await
    {
        return result
            .and_then(from_remote_value)
            .unwrap_or_else(|err| PathOrError {
                error: Some(err),
                ..Default::default()
            });
    }
    crate::async_rt::spawn_blocking(move || fs_mkdir_impl(parent_path, name))
        .await
        .unwrap_or_else(|e| PathOrError {
            error: Some(e.to_string()),
            ..Default::default()
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_delete_path(
    app: AppHandle,
    window: WebviewWindow,
    target_path: String,
) -> PathOrError {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "fs:delete-path",
        vec![json!(target_path.clone())],
    )
    .await
    {
        return result
            .and_then(from_remote_value)
            .unwrap_or_else(|err| PathOrError {
                error: Some(err),
                ..Default::default()
            });
    }
    crate::async_rt::spawn_blocking(move || fs_delete_path_impl(target_path))
        .await
        .unwrap_or_else(|e| PathOrError {
            error: Some(e.to_string()),
            ..Default::default()
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_quick_locations(app: AppHandle, window: WebviewWindow) -> Vec<QuickLocation> {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "fs:quick-locations", vec![]).await
    {
        return result.and_then(from_remote_value).unwrap_or_default();
    }
    let home = home_string(&crate::host_context::HostContext::from_app(app.clone()));
    crate::async_rt::spawn_blocking(move || fs_quick_locations_impl(home))
        .await
        .unwrap_or_default()
}

pub(crate) fn fs_quick_locations_native(app: &HostContext) -> Vec<QuickLocation> {
    fs_quick_locations_impl(home_string(app))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_search(
    app: AppHandle,
    window: WebviewWindow,
    dir_path: String,
    query: String,
    files_only: Option<bool>,
) -> Result<Vec<FsEntry>, String> {
    let files_only = files_only.unwrap_or(false);
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "fs:search",
        vec![
            json!(dir_path.clone()),
            json!(query.clone()),
            json!(files_only),
        ],
    )
    .await
    {
        return result.and_then(from_remote_value);
    }
    crate::async_rt::spawn_blocking(move || fs_search_impl(dir_path, query, files_only))
        .await
        .map_err(|err| err.to_string())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_resolve_path_links(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
    raw_paths: Vec<String>,
) -> Vec<PathLinkResult> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "fs:resolve-path-links",
        vec![json!(cwd.clone()), json!(raw_paths.clone())],
    )
    .await
    {
        return result.and_then(from_remote_value).unwrap_or_default();
    }
    crate::async_rt::spawn_blocking(move || fs_resolve_path_links_impl(cwd, raw_paths))
        .await
        .unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn fs_watch(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, FsWatcherState>,
    dir_path: String,
) -> bool {
    if let Some(result) =
        remote_invoke_for_window_blocking(&app, &window, "fs:watch", vec![json!(dir_path.clone())])
    {
        return result.and_then(from_remote_value).unwrap_or(false);
    }
    fs_watch_native(
        crate::host_context::HostContext::from_app(app),
        &state,
        dir_path,
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn fs_unwatch(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, FsWatcherState>,
    dir_path: String,
) -> bool {
    if let Some(result) = remote_invoke_for_window_blocking(
        &app,
        &window,
        "fs:unwatch",
        vec![json!(dir_path.clone())],
    ) {
        return result.and_then(from_remote_value).unwrap_or(false);
    }
    fs_unwatch_native(&state, dir_path)
}

fn stream_local_file_to_host(
    remote_client: &RustRemoteClientState,
    window_label: &str,
    local_path: &str,
    begin_channel: &str,
    begin_extra: Vec<Value>,
) -> Result<String, String> {
    use base64::Engine as _;
    use std::io::Read as _;

    let resolved =
        resolve_transfer_path(Path::new(local_path)).map_err(|err| format!("upload: {err}"))?;
    {
        let meta = fs::metadata(&resolved)
            .map_err(|err| format!("upload: cannot read local file: {err}"))?;
        if !meta.is_file() {
            return Err("upload: not a file".into());
        }
        let total = meta.len();
        if total == 0 {
            return Err("upload: file is empty".into());
        }
        if total > UPLOAD_MAX_TOTAL_BYTES {
            return Err(format!(
                "upload: file too large ({} bytes, limit {} bytes)",
                total, UPLOAD_MAX_TOTAL_BYTES
            ));
        }
        let name = Path::new(local_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "upload".into());

        let mut begin_args = begin_extra;
        begin_args.push(json!(name));
        begin_args.push(json!(total));
        let begin =
            remote_client.invoke(window_label, begin_channel, begin_args, REMOTE_FS_TIMEOUT)?;
        let upload_id = begin
            .get("uploadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "upload: host did not return uploadId".to_string())?
            .to_string();

        let abort = |remote_client: &RustRemoteClientState, reason: String| {
            let _ = remote_client.invoke(
                &window_label,
                "fs:upload-tmp-abort",
                vec![json!(upload_id.clone())],
                REMOTE_FS_TIMEOUT,
            );
            Err::<String, String>(reason)
        };

        let mut file = match fs::File::open(&resolved) {
            Ok(f) => f,
            Err(err) => return abort(&remote_client, format!("upload: open failed: {err}")),
        };
        // 1 MiB raw per chunk → ~1.37 MiB base64 per ws message: small enough
        // for any sane transport limit, big enough to keep round-trips low.
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            let read = match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(err) => return abort(&remote_client, format!("upload: read failed: {err}")),
            };
            let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..read]);
            if let Err(err) = remote_client.invoke(
                &window_label,
                "fs:upload-tmp-chunk",
                vec![json!(upload_id.clone()), json!(encoded)],
                REMOTE_FS_TIMEOUT,
            ) {
                return abort(&remote_client, format!("upload: chunk failed: {err}"));
            }
        }

        let end = remote_client.invoke(
            &window_label,
            "fs:upload-tmp-end",
            vec![json!(upload_id.clone())],
            REMOTE_FS_TIMEOUT,
        )?;
        end.get("path")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| "upload: host did not return final path".to_string())
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn remote_upload_file_to_host(
    app: AppHandle,
    window: WebviewWindow,
    local_path: String,
) -> Result<String, String> {
    if !is_remote_profile_window(&app, &window) {
        return Err("remote_upload_file_to_host: not a remote session".into());
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let window_label = window.label().to_string();

    crate::async_rt::spawn_blocking(move || {
        stream_local_file_to_host(
            &remote_client,
            &window_label,
            &local_path,
            "fs:upload-tmp-begin",
            vec![],
        )
    })
    .await
    .map_err(|err| format!("remote_upload_file_to_host worker failed: {err}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_upload_to_dir(
    app: AppHandle,
    window: WebviewWindow,
    local_path: String,
    dest_dir: String,
) -> Result<String, String> {
    if is_remote_profile_window(&app, &window) {
        let remote_client = app.state::<RustRemoteClientState>().inner().clone();
        let window_label = window.label().to_string();
        return crate::async_rt::spawn_blocking(move || {
            stream_local_file_to_host(
                &remote_client,
                &window_label,
                &local_path,
                "fs:upload-begin-dir",
                vec![json!(dest_dir)],
            )
        })
        .await
        .map_err(|err| format!("fs_upload_to_dir worker failed: {err}"))?;
    }
    crate::async_rt::spawn_blocking(move || fs_copy_into_dir_impl(local_path, dest_dir))
        .await
        .map_err(|err| format!("fs_upload_to_dir worker failed: {err}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_download_file(
    app: AppHandle,
    window: WebviewWindow,
    source_path: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt as _;

    let default_name = Path::new(&source_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let remote = if is_remote_profile_window(&app, &window) {
        Some((
            app.state::<RustRemoteClientState>().inner().clone(),
            window.label().to_string(),
        ))
    } else {
        None
    };
    let app_for_dialog = app.clone();

    crate::async_rt::spawn_blocking(move || -> Result<Option<String>, String> {
        let picked = app_for_dialog
            .dialog()
            .file()
            .set_file_name(&default_name)
            .blocking_save_file();
        let Some(file_path) = picked else {
            return Ok(None);
        };
        let dest = file_path
            .into_path()
            .map_err(|_| "download: invalid save path".to_string())?;

        if let Some((remote_client, window_label)) = remote {
            stream_host_file_to_local(&remote_client, &window_label, &source_path, &dest)?;
        } else {
            let abs = resolve_transfer_path(Path::new(&source_path))
                .map_err(|err| format!("download: {err}"))?;
            if !fs::metadata(&abs).map(|m| m.is_file()).unwrap_or(false) {
                return Err("download: not a file".into());
            }
            fs::copy(&abs, &dest).map_err(|err| format!("download: copy failed: {err}"))?;
        }
        Ok(Some(dest.to_string_lossy().to_string()))
    })
    .await
    .map_err(|err| format!("fs_download_file worker failed: {err}"))?
}

fn stream_host_file_to_local(
    remote_client: &RustRemoteClientState,
    window_label: &str,
    source_path: &str,
    dest: &Path,
) -> Result<(), String> {
    use base64::Engine as _;
    use std::io::Write as _;

    let mut out =
        fs::File::create(dest).map_err(|err| format!("download: create failed: {err}"))?;
    let fail = |out: fs::File, reason: String| {
        drop(out);
        let _ = fs::remove_file(dest);
        Err::<(), String>(reason)
    };
    let mut offset: u64 = 0;
    loop {
        let chunk = match remote_client.invoke(
            window_label,
            "fs:download-read",
            vec![json!(source_path), json!(offset)],
            REMOTE_FS_TIMEOUT,
        ) {
            Ok(value) => value,
            Err(err) => return fail(out, err),
        };
        let data = chunk
            .get("dataBase64")
            .and_then(Value::as_str)
            .unwrap_or("");
        let bytes = match base64::engine::general_purpose::STANDARD.decode(data.as_bytes()) {
            Ok(bytes) => bytes,
            Err(err) => return fail(out, format!("download: bad base64: {err}")),
        };
        if let Err(err) = out.write_all(&bytes) {
            return fail(out, format!("download: write failed: {err}"));
        }
        offset += bytes.len() as u64;
        let eof = chunk
            .get("eof")
            .and_then(Value::as_bool)
            .unwrap_or(bytes.is_empty());
        if eof || bytes.is_empty() {
            break;
        }
    }
    Ok(())
}

pub(crate) fn fs_watch_native(app: HostContext, state: &FsWatcherState, dir_path: String) -> bool {
    fs_watch_impl(
        Arc::new(move |channel, params| {
            publish_runtime_event(&app, channel, params.clone(), "rust-fs-watch");
        }),
        state,
        dir_path,
    )
}
