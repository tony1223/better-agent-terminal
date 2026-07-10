// fs:read-file — first port of the filesystem surface.
//
// Mirrors the renderer host contract: takes an arbitrary path string and
// returns one of three shapes:
//   { content }  — utf-8 file contents (for files <= 512 KiB)
//   { error }    — sensitive path or read failure
//   { error, size } — file exceeds the 512 KiB limit
//
// We keep the same payload and same byte cap so renderer call sites don't
// have to branch on host kind. The deny-list logic lives in
// crate::path_guard so we can unit-test it independently of Tauri.

use crate::commands::profile as profile_cmd;
use crate::event_hub::publish_runtime_event;
use crate::host_context::HostContext;
use crate::path_guard::is_sensitive_path;
use crate::remote_client::RustRemoteClientState;
#[cfg(feature = "desktop")]
use crate::window_registry;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, State, WebviewWindow};

const MAX_READ_BYTES: u64 = 512 * 1024;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(500);
const RESOLVE_PATH_LINK_LIMIT: usize = 200;

// Directory names we skip in listings/search — these are typically build
// outputs or VCS internals, not anything the user wants to wade through.
const IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    "dist",
    "dist-tauri",
    ".cache",
    "__pycache__",
    ".DS_Store",
    "release",
    "target",
];

const RESOLVE_TEXT_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "json", "jsonl", "css", "scss", "less", "html", "htm", "md", "mdx",
    "txt", "yml", "yaml", "toml", "xml", "svg", "sh", "bash", "zsh", "py", "rb", "go", "rs",
    "java", "c", "cpp", "h", "hpp", "cs", "csproj", "sln", "slnx", "fs", "fsproj", "vue", "svelte",
    "sql", "graphql", "log",
];

const REMOTE_FS_TIMEOUT: Duration = Duration::from_secs(15);

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

fn is_ignored_name(name: &str) -> bool {
    IGNORED_DIR_NAMES.iter().any(|n| *n == name)
}

fn home_string(app: &HostContext) -> Option<PathBuf> {
    app.home_dir()
}

fn expand_tilde(p: &str, home: &Path) -> PathBuf {
    if p == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return home.join(rest);
    }
    PathBuf::from(p)
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct FsReadResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathLinkResult {
    pub raw_path: String,
    pub path: String,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u64>,
}

struct FsWatchEntry {
    _watcher: RecommendedWatcher,
}

#[derive(Clone, Default)]
pub struct FsWatcherState {
    watchers: Arc<Mutex<HashMap<String, FsWatchEntry>>>,
}

pub(crate) fn fs_read_file_impl(path: String) -> FsReadResult {
    let abs = match PathBuf::from(&path).canonicalize() {
        // canonicalize fails for non-existent paths; fall back to a
        // best-effort absolute resolution against cwd so the deny-list
        // still gets to see a comparable shape.
        Ok(p) => p,
        Err(_) => match std::path::absolute(&path) {
            Ok(p) => p,
            Err(_) => PathBuf::from(&path),
        },
    };
    let abs_str = abs.to_string_lossy().to_string();
    if is_sensitive_path(&abs_str) {
        return FsReadResult {
            error: Some("Access denied (sensitive path)".into()),
            ..Default::default()
        };
    }
    let metadata = match fs::metadata(&abs) {
        Ok(m) => m,
        Err(_) => {
            return FsReadResult {
                error: Some("Failed to read file".into()),
                ..Default::default()
            };
        }
    };
    if metadata.len() > MAX_READ_BYTES {
        return FsReadResult {
            error: Some("File too large".into()),
            size: Some(metadata.len()),
            ..Default::default()
        };
    }
    match fs::read_to_string(&abs) {
        Ok(content) => FsReadResult {
            content: Some(content),
            ..Default::default()
        },
        Err(_) => FsReadResult {
            error: Some("Failed to read file".into()),
            ..Default::default()
        },
    }
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

fn entry_sort_key(a: &FsEntry, b: &FsEntry) -> std::cmp::Ordering {
    if a.is_directory != b.is_directory {
        // directories first
        return if a.is_directory {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    a.name.to_lowercase().cmp(&b.name.to_lowercase())
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

pub(crate) fn fs_is_directory_impl(path: String) -> bool {
    let abs = match std::path::absolute(&path) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let abs_str = abs.to_string_lossy().to_string();
    if is_sensitive_path(&abs_str) {
        return false;
    }
    fs::metadata(&abs)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

pub(crate) fn fs_readdir_impl(dir_path: String) -> Vec<FsEntry> {
    let abs = match std::path::absolute(&dir_path) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    let abs_str = abs.to_string_lossy().to_string();
    if is_sensitive_path(&abs_str) {
        return vec![];
    }
    let read = match fs::read_dir(&abs) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let mut out: Vec<FsEntry> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        let path_str = path.to_string_lossy().to_string();
        if is_sensitive_path(&path_str) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(FsEntry {
            name,
            path: path_str,
            is_directory: is_dir,
        });
    }
    out.sort_by(entry_sort_key);
    out
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirsItem {
    pub name: String,
    pub path: String,
}

// list-dirs is a tagged union { current, parent, entries } | { error }.
// We model the success and error variants as two structs sharing
// Option fields and serialize via skip_serializing_if so the JS side sees
// exactly the Electron shape.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ListDirsResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    // null means no parent (we're at root). The Electron handler emits
    // `null` literally rather than omitting the field, so we serialize the
    // outer Option<...> as null when we're at the root, and skip it
    // entirely when an error happened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<ListDirsItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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

pub(crate) fn fs_list_dirs_impl(
    home: PathBuf,
    dir_path: String,
    include_hidden: bool,
) -> ListDirsResult {
    let expanded = expand_tilde(&dir_path, &home);
    let abs = match std::path::absolute(&expanded) {
        Ok(p) => p,
        Err(e) => {
            return ListDirsResult {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    if is_sensitive_path(&abs.to_string_lossy()) {
        return ListDirsResult {
            error: Some("Access denied (sensitive path)".into()),
            ..Default::default()
        };
    }
    let read = match fs::read_dir(&abs) {
        Ok(r) => r,
        Err(e) => {
            return ListDirsResult {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    let mut entries: Vec<ListDirsItem> = Vec::new();
    for entry in read.flatten() {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let p = entry.path();
        if is_sensitive_path(&p.to_string_lossy()) {
            continue;
        }
        entries.push(ListDirsItem {
            name,
            path: p.to_string_lossy().to_string(),
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let parent = abs
        .parent()
        .filter(|p| p.as_os_str() != abs.as_os_str())
        .map(|p| p.to_string_lossy().to_string());
    ListDirsResult {
        current: Some(abs.to_string_lossy().to_string()),
        // Wrap in Some(Option) so the field always serializes (as
        // string-or-null) when we're on the success branch.
        parent: Some(parent),
        entries: Some(entries),
        error: None,
    }
}

pub(crate) fn fs_list_dirs_native(
    app: &HostContext,
    dir_path: String,
    include_hidden: bool,
) -> ListDirsResult {
    let home = home_string(app).unwrap_or_else(|| PathBuf::from("/"));
    fs_list_dirs_impl(home, dir_path, include_hidden)
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct PathOrError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn validate_dir_name(name: &str) -> Result<(), &'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
    {
        return Err("Invalid folder name");
    }
    Ok(())
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

pub(crate) fn fs_mkdir_impl(parent_path: String, name: String) -> PathOrError {
    let trimmed = name.trim();
    if let Err(msg) = validate_dir_name(&name) {
        return PathOrError {
            error: Some(msg.into()),
            ..Default::default()
        };
    }
    let parent_abs = match std::path::absolute(&parent_path) {
        Ok(p) => p,
        Err(e) => {
            return PathOrError {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    if is_sensitive_path(&parent_abs.to_string_lossy()) {
        return PathOrError {
            error: Some("Access denied (sensitive path)".into()),
            ..Default::default()
        };
    }
    let target = parent_abs.join(trimmed);
    match fs::create_dir(&target) {
        Ok(_) => PathOrError {
            path: Some(target.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => PathOrError {
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
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

pub(crate) fn fs_delete_path_impl(target_path: String) -> PathOrError {
    let abs = match std::path::absolute(&target_path) {
        Ok(p) => p,
        Err(e) => {
            return PathOrError {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    if is_sensitive_path(&abs.to_string_lossy()) {
        return PathOrError {
            error: Some("Access denied (sensitive path)".into()),
            ..Default::default()
        };
    }
    let metadata = match fs::symlink_metadata(&abs) {
        Ok(m) => m,
        Err(e) => {
            return PathOrError {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };
    if !metadata.is_dir() {
        return PathOrError {
            error: Some("Only directories can be deleted here".into()),
            ..Default::default()
        };
    }
    match fs::remove_dir_all(&abs) {
        Ok(_) => PathOrError {
            path: Some(abs.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => PathOrError {
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickLocation {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[cfg(target_os = "windows")]
fn windows_logical_drive_roots() -> Vec<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLogicalDrives() -> u32;
    }

    let mask = unsafe { GetLogicalDrives() };
    let mut roots = Vec::new();
    for idx in 0..26 {
        if (mask & (1 << idx)) != 0 {
            let letter = (b'A' + idx as u8) as char;
            roots.push(format!("{letter}:\\"));
        }
    }
    roots
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

pub(crate) fn fs_quick_locations_impl(home: Option<PathBuf>) -> Vec<QuickLocation> {
    let mut out: Vec<QuickLocation> = Vec::new();
    if let Some(home) = home {
        out.push(QuickLocation {
            name: "Home".into(),
            path: home.to_string_lossy().to_string(),
            kind: "home".into(),
        });
    }
    if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        for root in windows_logical_drive_roots() {
            let name = root.trim_end_matches('\\').to_string();
            out.push(QuickLocation {
                name,
                path: root,
                kind: "drive".into(),
            });
        }
    } else {
        out.push(QuickLocation {
            name: "/".into(),
            path: "/".into(),
            kind: "root".into(),
        });
        if cfg!(target_os = "macos") {
            if let Ok(read) = fs::read_dir("/Volumes") {
                for entry in read.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let p = entry.path();
                    let is_dir_or_link = entry
                        .file_type()
                        .map(|t| t.is_dir() || t.is_symlink())
                        .unwrap_or(false);
                    if is_dir_or_link {
                        out.push(QuickLocation {
                            name,
                            path: p.to_string_lossy().to_string(),
                            kind: "volume".into(),
                        });
                    }
                }
            }
        }
    }
    out
}

pub(crate) fn fs_quick_locations_native(app: &HostContext) -> Vec<QuickLocation> {
    fs_quick_locations_impl(home_string(app))
}

const SEARCH_MAX_DEPTH: usize = 8;
const SEARCH_MAX_RESULTS: usize = 100;

fn search_walk(dir: &Path, lower_query: &str, depth: usize, results: &mut Vec<FsEntry>) {
    if depth > SEARCH_MAX_DEPTH || results.len() >= SEARCH_MAX_RESULTS {
        return;
    }
    if is_sensitive_path(&dir.to_string_lossy()) {
        return;
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        if results.len() >= SEARCH_MAX_RESULTS {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        let p = entry.path();
        let p_str = p.to_string_lossy().to_string();
        if is_sensitive_path(&p_str) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if name.to_lowercase().contains(lower_query) {
            results.push(FsEntry {
                name: name.clone(),
                path: p_str,
                is_directory: is_dir,
            });
        }
        if is_dir {
            search_walk(&p, lower_query, depth + 1, results);
        }
    }
}

pub(crate) fn fs_search_impl(dir_path: String, query: String) -> Vec<FsEntry> {
    let abs = match std::path::absolute(&dir_path) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    let mut results: Vec<FsEntry> = Vec::new();
    let lower = query.to_lowercase();
    search_walk(&abs, &lower, 0, &mut results);
    results.sort_by(entry_sort_key);
    results
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn fs_search(
    app: AppHandle,
    window: WebviewWindow,
    dir_path: String,
    query: String,
) -> Vec<FsEntry> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "fs:search",
        vec![json!(dir_path.clone()), json!(query.clone())],
    )
    .await
    {
        return result.and_then(from_remote_value).unwrap_or_default();
    }
    crate::async_rt::spawn_blocking(move || fs_search_impl(dir_path, query))
        .await
        .unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedPathLink {
    cleaned: String,
    path_text: String,
    line: Option<u64>,
    column: Option<u64>,
}

fn trim_path_link(raw: &str) -> String {
    raw.trim_matches(|ch: char| {
        matches!(
            ch,
            '`' | '\'' | '"' | '(' | '<' | '[' | ')' | ',' | '.' | ';' | '>' | ']'
        )
    })
    .to_string()
}

fn parse_path_link(raw: &str) -> ParsedPathLink {
    let cleaned = trim_path_link(raw);
    let mut path_text = cleaned.clone();
    let mut line = None;
    let mut column = None;

    let parts = cleaned.split(':').collect::<Vec<_>>();
    if parts.len() >= 2 {
        let last_is_number = parts
            .last()
            .and_then(|part| part.parse::<u64>().ok())
            .is_some();
        if last_is_number {
            let last_value = parts.last().and_then(|part| part.parse::<u64>().ok());
            let previous_value = if parts.len() >= 3 {
                parts
                    .get(parts.len() - 2)
                    .and_then(|part| part.parse::<u64>().ok())
            } else {
                None
            };
            if let Some(prev) = previous_value {
                path_text = parts[..parts.len() - 2].join(":");
                line = Some(prev);
                column = last_value;
            } else if let Some(last) = last_value {
                path_text = parts[..parts.len() - 1].join(":");
                line = Some(last);
            }
        }
    }

    ParsedPathLink {
        cleaned,
        path_text,
        line,
        column,
    }
}

fn is_resolvable_text_path(path_text: &str) -> bool {
    Path::new(path_text)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_lowercase();
            RESOLVE_TEXT_EXTS.iter().any(|candidate| *candidate == ext)
        })
        .unwrap_or(false)
}

fn is_absolute_path_text(path_text: &str) -> bool {
    Path::new(path_text).is_absolute()
        || (path_text.len() >= 3
            && path_text.as_bytes()[0].is_ascii_alphabetic()
            && path_text.as_bytes()[1] == b':'
            && matches!(path_text.as_bytes()[2], b'/' | b'\\'))
}

fn resolve_path_link_candidate(
    cwd_abs: Option<&Path>,
    parsed: ParsedPathLink,
) -> Option<PathLinkResult> {
    if parsed.path_text.is_empty() || !is_resolvable_text_path(&parsed.path_text) {
        return None;
    }
    let candidate = if is_absolute_path_text(&parsed.path_text) {
        PathBuf::from(&parsed.path_text)
    } else {
        cwd_abs?.join(&parsed.path_text)
    };
    let abs = std::path::absolute(&candidate).ok()?;
    let abs_string = abs.to_string_lossy().to_string();
    if is_sensitive_path(&abs_string) {
        return None;
    }
    if !fs::metadata(&abs)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
    {
        return None;
    }
    Some(PathLinkResult {
        raw_path: parsed.cleaned,
        path: abs_string,
        exists: true,
        line: parsed.line,
        column: parsed.column,
    })
}

pub(crate) fn fs_resolve_path_links_impl(
    cwd: String,
    raw_paths: Vec<String>,
) -> Vec<PathLinkResult> {
    let cwd_abs = if cwd.trim().is_empty() {
        None
    } else {
        std::path::absolute(cwd).ok()
    };
    let mut seen = BTreeSet::new();
    let mut results = Vec::new();
    for raw in raw_paths {
        if seen.len() >= RESOLVE_PATH_LINK_LIMIT {
            break;
        }
        if raw.len() > 500 || !seen.insert(raw.clone()) {
            continue;
        }
        if let Some(result) = resolve_path_link_candidate(cwd_abs.as_deref(), parse_path_link(&raw))
        {
            results.push(result);
        }
    }
    results
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

fn remove_watcher(state: &FsWatcherState, dir_path: &str) -> bool {
    let Ok(mut guard) = state.watchers.lock() else {
        return false;
    };
    guard.remove(dir_path);
    true
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

pub(crate) fn fs_watch_native(app: HostContext, state: &FsWatcherState, dir_path: String) -> bool {
    if dir_path.trim().is_empty() {
        return false;
    }
    if state
        .watchers
        .lock()
        .map(|guard| guard.contains_key(&dir_path))
        .unwrap_or(false)
    {
        return true;
    }
    let abs = match std::path::absolute(&dir_path) {
        Ok(path) => path,
        Err(_) => return false,
    };
    let abs_string = abs.to_string_lossy().to_string();
    if is_sensitive_path(&abs_string) {
        return false;
    }
    let key = dir_path.clone();
    let watchers = state.watchers.clone();
    let debounce = Arc::new(AtomicU64::new(0));
    let debounce_for_event = debounce.clone();
    let app_for_event = app.clone();
    let abs_for_event = abs_string.clone();
    let key_for_error = key.clone();
    let mut watcher = match RecommendedWatcher::new(
        move |event| match event {
            Ok(_) => {
                let ticket = debounce_for_event.fetch_add(1, Ordering::SeqCst) + 1;
                let debounce_check = debounce_for_event.clone();
                let app_emit = app_for_event.clone();
                let changed_path = abs_for_event.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(WATCH_DEBOUNCE);
                    if debounce_check.load(Ordering::SeqCst) == ticket {
                        publish_runtime_event(
                            &app_emit,
                            "fs:changed",
                            serde_json::Value::String(changed_path),
                            "rust-fs-watch",
                        );
                    }
                });
            }
            Err(_) => {
                if let Ok(mut guard) = watchers.lock() {
                    guard.remove(&key_for_error);
                }
            }
        },
        Config::default(),
    ) {
        Ok(watcher) => watcher,
        Err(_) => return false,
    };
    if watcher.watch(&abs, RecursiveMode::Recursive).is_err() {
        return false;
    }
    let entry = FsWatchEntry { _watcher: watcher };
    if let Ok(mut guard) = state.watchers.lock() {
        if guard.contains_key(&key) {
            true
        } else {
            guard.insert(key, entry);
            true
        }
    } else {
        false
    }
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

pub(crate) fn fs_unwatch_native(state: &FsWatcherState, dir_path: String) -> bool {
    remove_watcher(&state, &dir_path)
}

// ---- fs:upload-tmp-* — chunked file upload from a remote client into the
// host's temp directory. The client drags a local file into its window; the
// bytes travel over the remote transport in base64 chunks and land in
// <temp>/bat-remote-uploads/<name>-<id><ext>. The final path is returned so
// the client can reference it in a conversation (CLAUDE.md: host applies the
// mutation, client renders the result).

const UPLOAD_MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB per file
const UPLOAD_MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024; // decoded, per chunk
const UPLOAD_STALE_SECS: u64 = 600; // GC abandoned partial uploads

struct UploadEntry {
    file: fs::File,
    path: PathBuf,
    received: u64,
    total: u64,
    last_activity: std::time::Instant,
}

#[derive(Clone, Default)]
pub struct FsUploadState {
    entries: Arc<Mutex<HashMap<String, UploadEntry>>>,
}

// Strip path separators and control characters; keep a readable stem + ext.
fn sanitize_upload_name(name: &str) -> (String, String) {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("upload")
        .trim()
        .to_string();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let (stem, ext) = match cleaned.rfind('.') {
        Some(idx) if idx > 0 => (cleaned[..idx].to_string(), cleaned[idx..].to_string()),
        _ => (cleaned, String::new()),
    };
    let stem = if stem.is_empty() {
        "upload".into()
    } else {
        stem
    };
    // Cap the stem so the final path stays comfortably under OS limits.
    let stem = stem.chars().take(80).collect::<String>();
    let ext = ext.chars().take(16).collect::<String>();
    (stem, ext)
}

fn prune_stale_uploads(entries: &mut HashMap<String, UploadEntry>) {
    let stale: Vec<String> = entries
        .iter()
        .filter(|(_, e)| e.last_activity.elapsed().as_secs() > UPLOAD_STALE_SECS)
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        if let Some(entry) = entries.remove(&id) {
            drop(entry.file);
            let _ = fs::remove_file(&entry.path);
        }
    }
}

pub(crate) fn fs_upload_begin_impl(
    state: &FsUploadState,
    name: String,
    total_bytes: u64,
) -> Result<Value, String> {
    if total_bytes == 0 {
        return Err("upload: totalBytes must be > 0".into());
    }
    if total_bytes > UPLOAD_MAX_TOTAL_BYTES {
        return Err(format!(
            "upload: file too large ({} bytes, limit {} bytes)",
            total_bytes, UPLOAD_MAX_TOTAL_BYTES
        ));
    }
    let dir = std::env::temp_dir().join("bat-remote-uploads");
    fs::create_dir_all(&dir).map_err(|err| format!("upload: create dir failed: {err}"))?;

    let (stem, ext) = sanitize_upload_name(&name);
    let upload_id = format!("{:016x}", rand::random::<u64>());
    let path = dir.join(format!("{stem}-{}{ext}", &upload_id[..8]));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|err| format!("upload: create file failed: {err}"))?;

    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "upload: state poisoned".to_string())?;
    prune_stale_uploads(&mut entries);
    entries.insert(
        upload_id.clone(),
        UploadEntry {
            file,
            path: path.clone(),
            received: 0,
            total: total_bytes,
            last_activity: std::time::Instant::now(),
        },
    );
    Ok(json!({
        "uploadId": upload_id,
        "path": path.to_string_lossy(),
    }))
}

pub(crate) fn fs_upload_chunk_impl(
    state: &FsUploadState,
    upload_id: String,
    data_base64: String,
) -> Result<Value, String> {
    use base64::Engine as _;
    use std::io::Write as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|err| format!("upload: bad base64: {err}"))?;
    if bytes.len() > UPLOAD_MAX_CHUNK_BYTES {
        return Err("upload: chunk too large".into());
    }
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "upload: state poisoned".to_string())?;
    let entry = entries
        .get_mut(&upload_id)
        .ok_or_else(|| "upload: unknown uploadId".to_string())?;
    if entry.received + bytes.len() as u64 > entry.total {
        let entry = entries.remove(&upload_id).expect("entry just fetched");
        drop(entry.file);
        let _ = fs::remove_file(&entry.path);
        return Err("upload: more bytes than declared totalBytes".into());
    }
    entry
        .file
        .write_all(&bytes)
        .map_err(|err| format!("upload: write failed: {err}"))?;
    entry.received += bytes.len() as u64;
    entry.last_activity = std::time::Instant::now();
    Ok(json!({ "received": entry.received }))
}

pub(crate) fn fs_upload_end_impl(
    state: &FsUploadState,
    upload_id: String,
) -> Result<Value, String> {
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "upload: state poisoned".to_string())?;
    let entry = entries
        .remove(&upload_id)
        .ok_or_else(|| "upload: unknown uploadId".to_string())?;
    if entry.received != entry.total {
        let path = entry.path.clone();
        drop(entry.file);
        let _ = fs::remove_file(&path);
        return Err(format!(
            "upload: incomplete ({} of {} bytes)",
            entry.received, entry.total
        ));
    }
    let path = entry.path.clone();
    drop(entry.file); // flush + close before handing the path out
    Ok(json!({ "path": path.to_string_lossy() }))
}

pub(crate) fn fs_upload_abort_impl(state: &FsUploadState, upload_id: String) -> bool {
    let Ok(mut entries) = state.entries.lock() else {
        return false;
    };
    if let Some(entry) = entries.remove(&upload_id) {
        drop(entry.file);
        let _ = fs::remove_file(&entry.path);
        true
    } else {
        false
    }
}

// Create <dir>/<name>, falling back to <stem>-<n><ext> when taken. create_new
// keeps the reserve atomic — no TOCTOU window between checking and opening.
fn create_unique_in_dir(dir: &Path, name: &str) -> Result<(fs::File, PathBuf), String> {
    let (stem, ext) = sanitize_upload_name(name);
    for n in 0..1000u32 {
        let file_name = if n == 0 {
            format!("{stem}{ext}")
        } else {
            format!("{stem}-{n}{ext}")
        };
        let candidate = dir.join(file_name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((file, candidate)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("upload: create file failed: {err}")),
        }
    }
    Err("upload: no free file name in destination".into())
}

fn validated_dest_dir(dest_dir: &str) -> Result<PathBuf, String> {
    let dir =
        std::path::absolute(dest_dir).map_err(|err| format!("upload: bad destination: {err}"))?;
    if is_sensitive_path(&dir.to_string_lossy()) {
        return Err("upload: access denied (sensitive path)".into());
    }
    if !dir.is_dir() {
        return Err("upload: destination is not a directory".into());
    }
    Ok(dir)
}

// fs:upload-begin-dir — like fs:upload-tmp-begin, but lands the file in a
// caller-chosen directory (the file tab's "upload into this folder"). The
// chunk/end/abort channels are shared with the tmp flow.
pub(crate) fn fs_upload_begin_in_dir_impl(
    state: &FsUploadState,
    dest_dir: String,
    name: String,
    total_bytes: u64,
) -> Result<Value, String> {
    if total_bytes == 0 {
        return Err("upload: totalBytes must be > 0".into());
    }
    if total_bytes > UPLOAD_MAX_TOTAL_BYTES {
        return Err(format!(
            "upload: file too large ({} bytes, limit {} bytes)",
            total_bytes, UPLOAD_MAX_TOTAL_BYTES
        ));
    }
    let dir = validated_dest_dir(&dest_dir)?;
    let (file, path) = create_unique_in_dir(&dir, &name)?;
    let upload_id = format!("{:016x}", rand::random::<u64>());
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "upload: state poisoned".to_string())?;
    prune_stale_uploads(&mut entries);
    entries.insert(
        upload_id.clone(),
        UploadEntry {
            file,
            path: path.clone(),
            received: 0,
            total: total_bytes,
            last_activity: std::time::Instant::now(),
        },
    );
    Ok(json!({
        "uploadId": upload_id,
        "path": path.to_string_lossy(),
    }))
}

const DOWNLOAD_MAX_TOTAL_BYTES: u64 = UPLOAD_MAX_TOTAL_BYTES;
const DOWNLOAD_CHUNK_BYTES: usize = 1024 * 1024;

// fs:download-read — stateless chunked read for "download host file to the
// remote client". Each call returns up to 1 MiB at `offset`; the client loops
// until eof. Stateless on purpose: nothing to GC if the client vanishes.
pub(crate) fn fs_download_read_impl(path: String, offset: u64) -> Result<Value, String> {
    use base64::Engine as _;
    use std::io::{Read as _, Seek as _, SeekFrom};

    let abs = std::path::absolute(&path).map_err(|err| format!("download: bad path: {err}"))?;
    if is_sensitive_path(&abs.to_string_lossy()) {
        return Err("download: access denied (sensitive path)".into());
    }
    let meta = fs::metadata(&abs).map_err(|err| format!("download: stat failed: {err}"))?;
    if !meta.is_file() {
        return Err("download: not a file".into());
    }
    let total = meta.len();
    if total > DOWNLOAD_MAX_TOTAL_BYTES {
        return Err(format!(
            "download: file too large ({total} bytes, limit {DOWNLOAD_MAX_TOTAL_BYTES} bytes)"
        ));
    }
    let mut file = fs::File::open(&abs).map_err(|err| format!("download: open failed: {err}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| format!("download: seek failed: {err}"))?;
    let mut buf = vec![0u8; DOWNLOAD_CHUNK_BYTES];
    let mut filled = 0usize;
    loop {
        let read = file
            .read(&mut buf[filled..])
            .map_err(|err| format!("download: read failed: {err}"))?;
        if read == 0 {
            break;
        }
        filled += read;
        if filled == buf.len() {
            break;
        }
    }
    let eof = offset + filled as u64 >= total;
    Ok(json!({
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(&buf[..filled]),
        "totalBytes": total,
        "eof": eof,
    }))
}

// Local-mode upload: copy a picked local file into the destination directory
// with the same collision-safe naming as the remote path.
pub(crate) fn fs_copy_into_dir_impl(src: String, dest_dir: String) -> Result<String, String> {
    let src_abs =
        std::path::absolute(&src).map_err(|err| format!("upload: bad source path: {err}"))?;
    if is_sensitive_path(&src_abs.to_string_lossy()) {
        return Err("upload: access denied (sensitive path)".into());
    }
    let meta =
        fs::metadata(&src_abs).map_err(|err| format!("upload: cannot read local file: {err}"))?;
    if !meta.is_file() {
        return Err("upload: not a file".into());
    }
    let dir = validated_dest_dir(&dest_dir)?;
    let name = src_abs
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "upload".into());
    let (mut out, path) = create_unique_in_dir(&dir, &name)?;
    let mut input =
        fs::File::open(&src_abs).map_err(|err| format!("upload: open failed: {err}"))?;
    if let Err(err) = std::io::copy(&mut input, &mut out) {
        drop(out);
        let _ = fs::remove_file(&path);
        return Err(format!("upload: copy failed: {err}"));
    }
    Ok(path.to_string_lossy().to_string())
}

// Shared client-side streaming loop: read a LOCAL file and push it to the
// connected remote host in base64 chunks. The destination is chosen by the
// begin channel — fs:upload-tmp-begin (host tmp dir, args [name, total]) or
// fs:upload-begin-dir (caller-chosen dir, args [dir, name, total] via
// begin_extra). Chunk/end/abort channels are shared between both flows.
fn stream_local_file_to_host(
    remote_client: &RustRemoteClientState,
    window_label: &str,
    local_path: &str,
    begin_channel: &str,
    begin_extra: Vec<Value>,
) -> Result<String, String> {
    use base64::Engine as _;
    use std::io::Read as _;

    {
        let meta = fs::metadata(local_path)
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

        let mut file = match fs::File::open(&local_path) {
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

// Client-side command: read a LOCAL file (the drop target machine) and stream
// it to the connected remote host's tmp dir. Only valid in a remote-profile
// window — in local mode the dropped path is already host-local and callers
// should use it directly.
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

// File-tab upload: put a picked LOCAL file into a destination directory.
// Local mode copies on disk; remote mode streams the bytes to the host and
// the host writes into the directory (host applies the mutation, client
// renders the result). Returns the final path.
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

// File-tab download: save a workspace file to a CLIENT-LOCAL location chosen
// via the native save dialog. Local mode copies; remote mode pulls the bytes
// from the host in chunks. Returns the saved path, or None on cancel.
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
            let abs = std::path::absolute(&source_path)
                .map_err(|err| format!("download: bad path: {err}"))?;
            if is_sensitive_path(&abs.to_string_lossy()) {
                return Err("download: access denied (sensitive path)".into());
            }
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

// Pull a host file down over the remote transport via fs:download-read,
// writing chunks to the chosen local destination. Partial files are removed
// on any failure.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn upload_roundtrip_writes_file_to_tmp() {
        use base64::Engine as _;
        let state = FsUploadState::default();
        let begin = fs_upload_begin_impl(&state, "notes.txt".into(), 11).unwrap();
        let id = begin
            .get("uploadId")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"hello world");
        fs_upload_chunk_impl(&state, id.clone(), b64).unwrap();
        let end = fs_upload_end_impl(&state, id).unwrap();
        let path = end.get("path").and_then(Value::as_str).unwrap().to_string();
        assert_eq!(fs::read(&path).unwrap(), b"hello world");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn upload_rejects_overflow_and_incomplete() {
        use base64::Engine as _;
        let state = FsUploadState::default();
        // Declaring 3 bytes then sending 7 must kill the upload and the file.
        let begin = fs_upload_begin_impl(&state, "a.bin".into(), 3).unwrap();
        let id = begin
            .get("uploadId")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let over = base64::engine::general_purpose::STANDARD.encode(b"toolong");
        assert!(fs_upload_chunk_impl(&state, id.clone(), over).is_err());
        assert!(fs_upload_end_impl(&state, id).is_err());
        // Ending before all declared bytes arrive must fail and delete.
        let begin = fs_upload_begin_impl(&state, "b.bin".into(), 10).unwrap();
        let id2 = begin
            .get("uploadId")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let p2 = begin
            .get("path")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        assert!(fs_upload_end_impl(&state, id2).is_err());
        assert!(!Path::new(&p2).exists());
    }

    #[test]
    fn upload_begin_in_dir_lands_in_destination_with_unique_names() {
        use base64::Engine as _;
        let dir = std::env::temp_dir().join(format!("bat-upload-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let state = FsUploadState::default();
        let mut paths = Vec::new();
        // Same name twice — second upload must get a suffixed file, not clobber.
        for expected in ["notes.txt", "notes-1.txt"] {
            let begin = fs_upload_begin_in_dir_impl(
                &state,
                dir.to_string_lossy().into(),
                "notes.txt".into(),
                5,
            )
            .unwrap();
            let id = begin
                .get("uploadId")
                .and_then(Value::as_str)
                .unwrap()
                .to_string();
            let b64 = base64::engine::general_purpose::STANDARD.encode(b"hello");
            fs_upload_chunk_impl(&state, id.clone(), b64).unwrap();
            let end = fs_upload_end_impl(&state, id).unwrap();
            let path = end.get("path").and_then(Value::as_str).unwrap().to_string();
            assert!(
                path.ends_with(expected),
                "{path} should end with {expected}"
            );
            assert_eq!(fs::read(&path).unwrap(), b"hello");
            paths.push(path);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn upload_begin_in_dir_rejects_missing_destination() {
        let state = FsUploadState::default();
        let missing = std::env::temp_dir().join("bat-upload-missing-dir-xyz");
        let result = fs_upload_begin_in_dir_impl(
            &state,
            missing.to_string_lossy().into(),
            "a.txt".into(),
            1,
        );
        assert!(result.is_err());
    }

    #[test]
    fn download_read_returns_chunks_until_eof() {
        use base64::Engine as _;
        let dir = std::env::temp_dir();
        let path = dir.join(format!("bat-download-{}.bin", std::process::id()));
        fs::write(&path, b"hello world").unwrap();

        let first = fs_download_read_impl(path.to_string_lossy().into(), 0).unwrap();
        let data = first.get("dataBase64").and_then(Value::as_str).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .unwrap();
        assert_eq!(bytes, b"hello world");
        assert_eq!(first.get("totalBytes").and_then(Value::as_u64), Some(11));
        assert_eq!(first.get("eof").and_then(Value::as_bool), Some(true));

        // Offset read returns the tail only.
        let tail = fs_download_read_impl(path.to_string_lossy().into(), 6).unwrap();
        let data = tail.get("dataBase64").and_then(Value::as_str).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .unwrap();
        assert_eq!(bytes, b"world");

        // Directories are refused.
        assert!(fs_download_read_impl(dir.to_string_lossy().into(), 0).is_err());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn copy_into_dir_copies_and_dedupes_names() {
        let base = std::env::temp_dir().join(format!("bat-copy-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let src = base.join("data.txt");
        fs::write(&src, b"payload").unwrap();

        let first =
            fs_copy_into_dir_impl(src.to_string_lossy().into(), dest.to_string_lossy().into())
                .unwrap();
        let second =
            fs_copy_into_dir_impl(src.to_string_lossy().into(), dest.to_string_lossy().into())
                .unwrap();
        assert!(first.ends_with("data.txt"));
        assert!(second.ends_with("data-1.txt"));
        assert_eq!(fs::read(&first).unwrap(), b"payload");
        assert_eq!(fs::read(&second).unwrap(), b"payload");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sanitize_upload_name_strips_separators() {
        let (stem, ext) = sanitize_upload_name("../../etc/passwd");
        assert_eq!(stem, "passwd");
        assert_eq!(ext, "");
        let (stem, ext) = sanitize_upload_name("C:\\evil\\..\\name.png");
        assert_eq!(stem, "name");
        assert_eq!(ext, ".png");
    }

    #[test]
    fn reads_small_utf8_file() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("bat-fs-{}.txt", std::process::id()));
        {
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(b"hello world").unwrap();
        }
        let result = fs_read_file_impl(path.to_string_lossy().into());
        assert_eq!(result.content.as_deref(), Some("hello world"));
        assert!(result.error.is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_path_link_extracts_line_and_column() {
        assert_eq!(
            parse_path_link("`src/main.ts:12:3`,"),
            ParsedPathLink {
                cleaned: "src/main.ts:12:3".into(),
                path_text: "src/main.ts".into(),
                line: Some(12),
                column: Some(3),
            }
        );
        assert_eq!(
            parse_path_link("C:\\repo\\src\\main.ts:9"),
            ParsedPathLink {
                cleaned: "C:\\repo\\src\\main.ts:9".into(),
                path_text: "C:\\repo\\src\\main.ts".into(),
                line: Some(9),
                column: None,
            }
        );
    }

    #[test]
    fn resolve_path_links_keeps_existing_text_files_only() {
        let dir = std::env::temp_dir().join(format!("bat-path-links-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.ts"), "export const a = 1").unwrap();
        fs::write(dir.join("image.png"), "not really png").unwrap();

        let results = fs_resolve_path_links_impl(
            dir.to_string_lossy().into(),
            vec![
                "a.ts:7:2".into(),
                "a.ts:7:2".into(),
                "missing.ts".into(),
                "image.png".into(),
            ],
        );

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].raw_path, "a.ts:7:2");
        assert_eq!(results[0].line, Some(7));
        assert_eq!(results[0].column, Some(2));
        assert!(results[0].path.ends_with("a.ts"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_files_above_size_cap() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("bat-fs-large-{}.bin", std::process::id()));
        {
            let mut f = fs::File::create(&path).unwrap();
            // 513 KiB — one byte past the cap.
            let chunk = vec![b'x'; 1024];
            for _ in 0..513 {
                f.write_all(&chunk).unwrap();
            }
        }
        let result = fs_read_file_impl(path.to_string_lossy().into());
        assert!(result.content.is_none());
        assert_eq!(result.error.as_deref(), Some("File too large"));
        assert_eq!(result.size, Some(513 * 1024));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_nonexistent_paths() {
        let result = fs_read_file_impl("/this/path/does/not/exist/xyz".into());
        assert!(result.content.is_none());
        assert_eq!(result.error.as_deref(), Some("Failed to read file"));
    }

    #[test]
    fn ignored_names_are_filtered() {
        for name in ["node_modules", ".git", "dist", "target"] {
            assert!(is_ignored_name(name), "{name} should be ignored");
        }
        assert!(!is_ignored_name("src"));
        assert!(!is_ignored_name("README.md"));
    }

    #[test]
    fn dir_name_validation_rejects_separators_and_dots() {
        assert!(validate_dir_name("foo").is_ok());
        assert!(validate_dir_name("foo bar").is_ok());
        assert!(validate_dir_name("").is_err());
        assert!(validate_dir_name("   ").is_err());
        assert!(validate_dir_name(".").is_err());
        assert!(validate_dir_name("..").is_err());
        assert!(validate_dir_name("a/b").is_err());
        assert!(validate_dir_name("a\\b").is_err());
    }

    #[test]
    fn tilde_expansion_handles_root_and_subpath() {
        let home = Path::new("/home/me");
        assert_eq!(expand_tilde("~", home), PathBuf::from("/home/me"));
        assert_eq!(expand_tilde("~/docs", home), PathBuf::from("/home/me/docs"));
        assert_eq!(
            expand_tilde("/etc/hosts", home),
            PathBuf::from("/etc/hosts")
        );
        // A literal "~user" form should pass through; we only strip "~" or "~/".
        assert_eq!(expand_tilde("~user", home), PathBuf::from("~user"));
    }

    #[test]
    fn entry_sort_puts_directories_first() {
        let mut entries = vec![
            FsEntry {
                name: "zfile".into(),
                path: "/a/zfile".into(),
                is_directory: false,
            },
            FsEntry {
                name: "ADir".into(),
                path: "/a/ADir".into(),
                is_directory: true,
            },
            FsEntry {
                name: "afile".into(),
                path: "/a/afile".into(),
                is_directory: false,
            },
            FsEntry {
                name: "bdir".into(),
                path: "/a/bdir".into(),
                is_directory: true,
            },
        ];
        entries.sort_by(entry_sort_key);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Directories first (sorted case-insensitively), then files alphabetical.
        assert_eq!(names, vec!["ADir", "bdir", "afile", "zfile"]);
    }

    #[test]
    fn readdir_skips_ignored_subdirs() {
        let dir = std::env::temp_dir().join(format!("bat-readdir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("README.md"), b"hi").unwrap();
        let result = fs_readdir_impl(dir.to_string_lossy().into());
        let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"README.md"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&".git"));
        // src is a directory, README.md is a file → src first.
        assert_eq!(names[0], "src");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_directory_distinguishes_files_from_directories() {
        let dir = std::env::temp_dir().join(format!("bat-is-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("file.txt");
        fs::write(&file, b"hi").unwrap();

        assert!(fs_is_directory_impl(dir.to_string_lossy().into()));
        assert!(!fs_is_directory_impl(file.to_string_lossy().into()));
        assert!(!fs_is_directory_impl(
            dir.join("missing").to_string_lossy().into()
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dirs_impl_filters_and_expands_home() {
        let base = std::env::temp_dir().join(format!("bat-list-dirs-{}", std::process::id()));
        let home = base.join("home");
        let docs = home.join("docs");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(docs.join("Visible")).unwrap();
        fs::create_dir_all(docs.join(".hidden")).unwrap();
        fs::write(docs.join("file.txt"), b"hi").unwrap();

        let visible = fs_list_dirs_impl(home.clone(), "~/docs".into(), false);
        let names: Vec<&str> = visible
            .entries
            .as_ref()
            .unwrap()
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        let docs_str = docs.to_string_lossy().to_string();
        assert_eq!(visible.current.as_deref(), Some(docs_str.as_str()));
        assert!(names.contains(&"Visible"));
        assert!(!names.contains(&".hidden"));
        assert!(!names.contains(&"file.txt"));

        let with_hidden = fs_list_dirs_impl(home, docs.to_string_lossy().into(), true);
        let hidden_names: Vec<&str> = with_hidden
            .entries
            .as_ref()
            .unwrap()
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert!(hidden_names.contains(&".hidden"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn quick_locations_impl_includes_home() {
        let home = PathBuf::from("/tmp/bat-home");
        let locations = fs_quick_locations_impl(Some(home.clone()));
        assert_eq!(locations[0].name, "Home");
        assert_eq!(locations[0].path, home.to_string_lossy().to_string());
        assert_eq!(locations[0].kind, "home");
    }

    #[test]
    fn search_respects_max_results_and_depth() {
        let dir = std::env::temp_dir().join(format!("bat-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // 3 matching files at the top level.
        for n in 0..3 {
            fs::write(dir.join(format!("hello-{n}.txt")), b"x").unwrap();
        }
        // Plus a deeply nested matching file (still within depth 8).
        let nested = dir.join("a/b/c/hello-deep.txt");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, b"x").unwrap();
        let result = fs_search_impl(dir.to_string_lossy().into(), "hello".into());
        let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
        assert!(names.iter().any(|n| n.contains("hello-deep.txt")));
        assert!(result.len() >= 4);
        assert!(result.len() <= SEARCH_MAX_RESULTS);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mkdir_rejects_invalid_names() {
        let parent = std::env::temp_dir();
        let r = fs_mkdir_impl(parent.to_string_lossy().into(), "..".into());
        assert_eq!(r.error.as_deref(), Some("Invalid folder name"));
        let r = fs_mkdir_impl(parent.to_string_lossy().into(), "a/b".into());
        assert_eq!(r.error.as_deref(), Some("Invalid folder name"));
    }

    #[test]
    fn delete_path_only_targets_directories() {
        let dir = std::env::temp_dir().join(format!("bat-delete-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, b"x").unwrap();
        // File deletion should be refused.
        let r = fs_delete_path_impl(file.to_string_lossy().into());
        assert_eq!(
            r.error.as_deref(),
            Some("Only directories can be deleted here")
        );
        // Directory deletion succeeds.
        let r = fs_delete_path_impl(dir.to_string_lossy().into());
        assert!(r.error.is_none());
        assert_eq!(r.path.as_deref(), Some(dir.to_string_lossy().as_ref()));
    }
}
