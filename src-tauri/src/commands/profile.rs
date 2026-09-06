// profile:* — Tauri profile index persistence.
//
// Electron stores profile metadata in <userData>/profiles/index.json and keeps
// remote tokens in a separate secret envelope. Tauri keeps tokens out of
// index.json and uses the old keyring item only as a migration fallback; this
// avoids repeated macOS Keychain prompts during normal profile reads/writes.

use crate::app_data;
#[cfg(feature = "desktop")]
use crate::commands::app::log_tauri;
use crate::electron_safe_storage::decrypt_electron_safe_storage_data;
use crate::event_hub::publish_runtime_event;
use crate::host_context::HostContext;
#[cfg(feature = "desktop")]
use crate::window_registry;
#[cfg(not(test))]
use keyring::use_native_store;
use keyring_core::Entry as KeyringEntry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, WebviewWindow};

const DEFAULT_PROFILE_ID: &str = "default";
const DEFAULT_PROFILE_NAME: &str = "Default";
const INDEX_FILE: &str = "index.json";
const INDEX_BACKUP_FILE: &str = "index.json.bak";
const TOKEN_FILE: &str = "remote-tokens.enc.json";
const REMOTE_TOKEN_KEYRING_SERVICE: &str = "better-agent-terminal:remote-profile-token";

static PROFILE_INDEX_TRANSACTION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PROFILE_SNAPSHOT_REPAIR_DIRS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static ATOMIC_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_profile_id: Option<String>,
    // Cached display name of the HOST-side target profile (remote_profile_id),
    // captured when the alias is created/edited so clients can show the remote
    // profile's name without re-dialing the host. Best-effort; may be stale if
    // the host later renames the profile.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_profile_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileListResponse {
    pub profiles: Vec<ProfileEntry>,
    pub active_profile_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileIndex {
    #[serde(default)]
    pub profiles: Vec<ProfileEntry>,
    #[serde(default)]
    pub active_profile_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProfileOptions {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub remote_host: Option<String>,
    pub remote_port: Option<u32>,
    pub remote_token: Option<String>,
    pub remote_fingerprint: Option<String>,
    pub remote_profile_id: Option<String>,
    pub remote_profile_name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileOptions {
    pub remote_host: Option<String>,
    pub remote_port: Option<u32>,
    pub remote_token: Option<String>,
    pub remote_fingerprint: Option<String>,
    pub remote_profile_id: Option<String>,
    pub remote_profile_name: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RemoteTokenStore {
    tokens: HashMap<String, String>,
}

#[derive(Debug, Default)]
struct TokenStoreRead {
    store: RemoteTokenStore,
    encrypted_unreadable: bool,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn default_entry() -> ProfileEntry {
    ProfileEntry {
        id: DEFAULT_PROFILE_ID.into(),
        name: DEFAULT_PROFILE_NAME.into(),
        kind: "local".into(),
        remote_host: None,
        remote_port: None,
        remote_token: None,
        remote_fingerprint: None,
        remote_profile_id: None,
        remote_profile_name: None,
        created_at: 0,
        updated_at: 0,
    }
}

fn default_index() -> ProfileIndex {
    ProfileIndex {
        profiles: vec![default_entry()],
        active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
        active_profile_id: None,
    }
}

fn profiles_dir(app: &HostContext) -> Option<PathBuf> {
    app.data_dir_opt().map(|dir| dir.join("profiles"))
}

fn app_data_dir(app: &HostContext) -> Option<PathBuf> {
    app.data_dir_opt()
}

fn workspace_path(app: &HostContext) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join("workspaces.json"))
}

fn profile_path(dir: &Path, profile_id: &str) -> PathBuf {
    dir.join(format!("{profile_id}.json"))
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.to_lowercase().chars() {
        let keep = ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch);
        if keep {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "profile".into()
    } else {
        trimmed
    }
}

fn normalize_index(mut index: ProfileIndex) -> ProfileIndex {
    if index.active_profile_ids.is_empty() {
        if let Some(id) = index.active_profile_id.take() {
            index.active_profile_ids = vec![id];
        }
    }
    if index.active_profile_ids.is_empty() {
        index.active_profile_ids = vec![DEFAULT_PROFILE_ID.into()];
    }
    if !index
        .profiles
        .iter()
        .any(|profile| profile.id == DEFAULT_PROFILE_ID)
    {
        index.profiles.insert(0, default_entry());
    }
    index
        .profiles
        .retain(|profile| !profile.id.trim().is_empty() && !profile.name.trim().is_empty());
    index.active_profile_id = None;
    index
}

fn activate_profile_in_index(index: &mut ProfileIndex, profile_id: &str) -> bool {
    if !index
        .profiles
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return false;
    }
    if !index.active_profile_ids.iter().any(|id| id == profile_id) {
        index.active_profile_ids.push(profile_id.to_string());
    }
    true
}

fn read_token_store_info(dir: &Path) -> TokenStoreRead {
    let path = dir.join(TOKEN_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return TokenStoreRead::default();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return TokenStoreRead::default();
    };
    if value.get("enc").and_then(Value::as_bool) == Some(true) {
        if let Some(data) = value.get("data").and_then(Value::as_str) {
            if let Some(store) = read_electron_safe_storage_token_store(dir, data) {
                return TokenStoreRead {
                    store,
                    encrypted_unreadable: false,
                };
            }
        }
        return TokenStoreRead {
            store: RemoteTokenStore::default(),
            encrypted_unreadable: true,
        };
    }
    if value.get("enc").and_then(Value::as_bool) == Some(false) {
        if let Some(data) = value.get("data").and_then(Value::as_str) {
            return TokenStoreRead {
                store: serde_json::from_str::<RemoteTokenStore>(data).unwrap_or_default(),
                encrypted_unreadable: false,
            };
        }
    }
    TokenStoreRead {
        store: serde_json::from_value::<RemoteTokenStore>(value).unwrap_or_default(),
        encrypted_unreadable: false,
    }
}

#[cfg(test)]
fn read_token_store(dir: &Path) -> RemoteTokenStore {
    read_token_store_info(dir).store
}

fn read_electron_safe_storage_token_store(dir: &Path, data: &str) -> Option<RemoteTokenStore> {
    let app_data_dir = dir.parent()?;
    let plaintext = decrypt_electron_safe_storage_data(app_data_dir, data)?;
    serde_json::from_slice::<RemoteTokenStore>(&plaintext).ok()
}

#[cfg(not(test))]
static PROFILE_SAFE_STORE_INIT: OnceLock<Result<(), String>> = OnceLock::new();
static REMOTE_TOKEN_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn remote_token_cache() -> &'static Mutex<HashMap<String, String>> {
    REMOTE_TOKEN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_remote_token(profile_id: &str, token: &str) {
    if let Ok(mut cache) = remote_token_cache().lock() {
        cache.insert(profile_id.to_string(), token.to_string());
    }
}

fn cached_remote_token(profile_id: &str) -> Option<String> {
    remote_token_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(profile_id).cloned())
}

fn forget_cached_remote_token(profile_id: &str) {
    if let Ok(mut cache) = remote_token_cache().lock() {
        cache.remove(profile_id);
    }
}

#[cfg(not(test))]
fn ensure_profile_safe_store() -> Result<(), String> {
    PROFILE_SAFE_STORE_INIT
        .get_or_init(|| use_native_store(false).map_err(|err| format!("{err:?}")))
        .clone()
}

#[cfg(test)]
fn ensure_profile_safe_store() -> Result<(), String> {
    Err("profile safe store disabled in unit tests".into())
}

fn remote_token_entry(profile_id: &str) -> Result<KeyringEntry, String> {
    ensure_profile_safe_store()?;
    KeyringEntry::new(REMOTE_TOKEN_KEYRING_SERVICE, profile_id)
        .map_err(|err| format!("could not create keyring entry: {err:?}"))
}

fn load_remote_token_from_safe_store(profile_id: &str) -> Option<String> {
    if let Some(token) = cached_remote_token(profile_id) {
        return Some(token);
    }
    let token = remote_token_entry(profile_id)
        .ok()?
        .get_password()
        .ok()
        .filter(|token| !token.is_empty())?;
    cache_remote_token(profile_id, &token);
    Some(token)
}

fn delete_remote_token_from_safe_store(profile_id: &str) {
    forget_cached_remote_token(profile_id);
    if let Ok(entry) = remote_token_entry(profile_id) {
        let _ = entry.delete_credential();
    }
}

fn profile_index_guard() -> std::sync::MutexGuard<'static, ()> {
    PROFILE_INDEX_TRANSACTION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn atomic_temp_path(path: &Path) -> PathBuf {
    let sequence = ATOMIC_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut name = path
        .file_name()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "profile-data".into());
    name.push(format!(".{}.{}.tmp", std::process::id(), sequence));
    path.with_file_name(name)
}

#[cfg(windows)]
fn replace_file(temp: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temp_wide = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            temp_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temp, destination)
}

fn write_owner_only(path: &Path, content: String) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = atomic_temp_path(path);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
        }

        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn write_token_store(dir: &Path, store: &RemoteTokenStore) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let payload = json!({
        "enc": false,
        "data": serde_json::to_string(store).unwrap_or_else(|_| "{}".into()),
    });
    write_owner_only(
        &dir.join(TOKEN_FILE),
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".into()),
    )
}

fn hydrate_remote_tokens(dir: &Path, mut index: ProfileIndex) -> ProfileIndex {
    let mut token_store = read_token_store_info(dir);
    let mut store_changed = false;
    for profile in &mut index.profiles {
        if profile.kind == "remote" && profile.remote_token.is_none() {
            if let Some(token) = token_store.store.tokens.get(&profile.id).cloned() {
                cache_remote_token(&profile.id, &token);
                profile.remote_token = Some(token);
            } else if let Some(token) = load_remote_token_from_safe_store(&profile.id) {
                if !token_store.encrypted_unreadable {
                    token_store
                        .store
                        .tokens
                        .insert(profile.id.clone(), token.clone());
                    store_changed = true;
                }
                profile.remote_token = Some(token);
            }
        }
    }
    if store_changed {
        let _ = write_token_store(dir, &token_store.store);
    }
    index
}

fn strip_and_persist_remote_tokens(
    dir: &Path,
    mut index: ProfileIndex,
) -> std::io::Result<ProfileIndex> {
    let token_store = read_token_store_info(dir);
    let preserve_unreadable_encrypted_store = token_store.encrypted_unreadable;
    let mut store = token_store.store;
    let mut store_changed = false;
    let ids = index
        .profiles
        .iter()
        .map(|profile| profile.id.clone())
        .collect::<HashSet<_>>();
    for profile in &mut index.profiles {
        if profile.kind == "remote" {
            if let Some(token) = profile.remote_token.take() {
                cache_remote_token(&profile.id, &token);
                if store.tokens.get(&profile.id) != Some(&token) {
                    store.tokens.insert(profile.id.clone(), token);
                    store_changed = true;
                }
            }
        } else {
            profile.remote_token = None;
            store_changed |= store.tokens.remove(&profile.id).is_some();
            forget_cached_remote_token(&profile.id);
        }
    }
    let before_retain = store.tokens.len();
    store.tokens.retain(|id, _| ids.contains(id));
    store_changed |= store.tokens.len() != before_retain;
    if preserve_unreadable_encrypted_store && !store_changed && store.tokens.is_empty() {
        return Ok(index);
    }
    write_token_store(dir, &store)?;
    Ok(index)
}

fn read_index_file(path: &Path) -> io::Result<Option<ProfileIndex>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    serde_json::from_str::<ProfileIndex>(&raw)
        .map(Some)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn read_index_for_update_unlocked(dir: &Path) -> io::Result<ProfileIndex> {
    let primary = dir.join(INDEX_FILE);
    let backup = dir.join(INDEX_BACKUP_FILE);
    let parsed = match read_index_file(&primary) {
        Ok(Some(index)) => index,
        Ok(None) => match read_index_file(&backup)? {
            Some(index) => index,
            None => default_index(),
        },
        Err(primary_error) => match read_index_file(&backup) {
            Ok(Some(index)) => index,
            _ => return Err(primary_error),
        },
    };
    Ok(hydrate_remote_tokens(dir, normalize_index(parsed)))
}

fn read_index_at(dir: &Path) -> ProfileIndex {
    let _guard = profile_index_guard();
    read_index_for_update_unlocked(dir).unwrap_or_else(|_| default_index())
}

fn backup_valid_index_unlocked(dir: &Path) -> io::Result<()> {
    let primary = dir.join(INDEX_FILE);
    let Ok(raw) = fs::read_to_string(&primary) else {
        return Ok(());
    };
    if serde_json::from_str::<ProfileIndex>(&raw).is_err() {
        return Ok(());
    }
    write_owner_only(&dir.join(INDEX_BACKUP_FILE), raw)
}

fn write_index_at_unlocked(dir: &Path, index: ProfileIndex) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let clean = strip_and_persist_remote_tokens(dir, normalize_index(index))?;
    let serialized = serde_json::to_string_pretty(&clean)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    backup_valid_index_unlocked(dir)?;
    write_owner_only(&dir.join(INDEX_FILE), serialized)
}

#[cfg(test)]
fn write_index_at(dir: &Path, index: ProfileIndex) -> io::Result<()> {
    let _guard = profile_index_guard();
    write_index_at_unlocked(dir, index)
}

fn update_index_at<T>(
    dir: &Path,
    update: impl FnOnce(&mut ProfileIndex) -> io::Result<T>,
) -> io::Result<T> {
    let _guard = profile_index_guard();
    let mut index = read_index_for_update_unlocked(dir)?;
    let result = update(&mut index)?;
    write_index_at_unlocked(dir, index)?;
    Ok(result)
}

fn list_response_at(dir: &Path) -> ProfileListResponse {
    let index = read_index_at(dir);
    ProfileListResponse {
        profiles: index.profiles,
        active_profile_ids: index.active_profile_ids,
    }
}

fn emit_profile_changed(app: &HostContext) {
    let payload = profiles_dir(app)
        .map(|dir| {
            let response = list_response_at(&dir);
            json!({
                "profiles": response.profiles,
                "activeProfileIds": response.active_profile_ids,
            })
        })
        .unwrap_or_else(|| {
            json!({
                "profiles": [default_entry()],
                "activeProfileIds": [DEFAULT_PROFILE_ID],
            })
        });
    publish_runtime_event(app, "profile:changed", payload, "profile");
}

fn load_profile_snapshot_at(dir: &Path, profile_id: &str, activate: bool) -> Option<Value> {
    let snapshot = read_snapshot_at(dir, profile_id)?;
    if activate {
        update_index_at(dir, |index| {
            if activate_profile_in_index(index, profile_id) {
                Ok(())
            } else {
                Err(io::Error::new(io::ErrorKind::NotFound, "profile not found"))
            }
        })
        .ok()?;
    }
    Some(snapshot)
}

fn unique_profile_id(index: &ProfileIndex, name: &str) -> String {
    let base = slugify(name);
    let ids = index
        .profiles
        .iter()
        .map(|profile| profile.id.as_str())
        .collect::<HashSet<_>>();
    if !ids.contains(base.as_str()) {
        return base;
    }
    for n in 2..10_000 {
        let candidate = format!("{base}-{n}");
        if !ids.contains(candidate.as_str()) {
            return candidate;
        }
    }
    format!("{base}-{}", now_millis())
}

fn profile_from_options(
    id: String,
    name: String,
    options: Option<CreateProfileOptions>,
) -> ProfileEntry {
    let now = now_millis();
    let options = options.unwrap_or_default();
    let kind = options.kind.unwrap_or_else(|| "local".into());
    ProfileEntry {
        id,
        name,
        kind: if kind == "remote" {
            "remote".into()
        } else {
            "local".into()
        },
        remote_host: options.remote_host,
        remote_port: options.remote_port,
        remote_token: options.remote_token,
        remote_fingerprint: options.remote_fingerprint,
        remote_profile_id: options.remote_profile_id,
        remote_profile_name: options.remote_profile_name,
        created_at: now,
        updated_at: now,
    }
}

fn empty_workspace_state() -> Value {
    json!({
        "workspaces": [],
        "activeWorkspaceId": Value::Null,
        "activeGroup": Value::Null,
        "terminals": [],
        "activeTerminalId": Value::Null,
    })
}

fn snapshot_from_workspace(profile: &ProfileEntry, workspace: Value) -> Value {
    json!({
        "id": profile.id,
        "name": profile.name,
        "version": 2,
        "windows": [{
            "workspaces": workspace.get("workspaces").cloned().unwrap_or_else(|| json!([])),
            "activeWorkspaceId": workspace.get("activeWorkspaceId").cloned().unwrap_or(Value::Null),
            "activeGroup": workspace.get("activeGroup").cloned().unwrap_or(Value::Null),
            "terminals": workspace.get("terminals").cloned().unwrap_or_else(|| json!([])),
            "activeTerminalId": workspace.get("activeTerminalId").cloned().unwrap_or(Value::Null),
        }],
    })
}

fn empty_snapshot(profile: &ProfileEntry) -> Value {
    json!({
        "id": profile.id,
        "name": profile.name,
        "version": 2,
        "windows": [],
    })
}

fn generate_snapshot_uuid() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn generate_history_key() -> String {
    let bytes: [u8; 6] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// A profile snapshot is an independent runtime namespace. Copying its raw
// workspace/terminal ids makes two simultaneously-open profile windows address
// the same PTY/agent session in the process-wide runtime maps. Re-key every
// identity and drop conversation/runtime handles when duplicating a profile so
// the copy starts with the same layout and settings, but not the same live
// processes, transcripts, shell history, or worktree.
fn regenerate_duplicated_snapshot_identities(snapshot: &mut Value) {
    let Some(windows) = snapshot.get_mut("windows").and_then(Value::as_array_mut) else {
        return;
    };

    for window in windows {
        let Some(window) = window.as_object_mut() else {
            continue;
        };

        let mut workspace_id_map = HashMap::<String, String>::new();
        let mut workspace_paths = HashMap::<String, String>::new();
        let workspace_new_ids = window
            .get("workspaces")
            .and_then(Value::as_array)
            .map(|workspaces| {
                workspaces
                    .iter()
                    .map(|workspace| {
                        let new_id = generate_snapshot_uuid();
                        if let Some(old_id) = workspace.get("id").and_then(Value::as_str) {
                            workspace_id_map
                                .entry(old_id.to_string())
                                .or_insert_with(|| new_id.clone());
                            if let Some(folder_path) =
                                workspace.get("folderPath").and_then(Value::as_str)
                            {
                                workspace_paths
                                    .entry(old_id.to_string())
                                    .or_insert_with(|| folder_path.to_string());
                            }
                        }
                        new_id
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let mut terminal_id_map = HashMap::<String, String>::new();
        let terminal_new_ids = window
            .get("terminals")
            .and_then(Value::as_array)
            .map(|terminals| {
                terminals
                    .iter()
                    .map(|terminal| {
                        let new_id = generate_snapshot_uuid();
                        if let Some(old_id) = terminal.get("id").and_then(Value::as_str) {
                            terminal_id_map
                                .entry(old_id.to_string())
                                .or_insert_with(|| new_id.clone());
                        }
                        new_id
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if let Some(workspaces) = window.get_mut("workspaces").and_then(Value::as_array_mut) {
            for (index, workspace) in workspaces.iter_mut().enumerate() {
                let Some(workspace) = workspace.as_object_mut() else {
                    continue;
                };
                if let Some(new_id) = workspace_new_ids.get(index) {
                    workspace.insert("id".into(), Value::String(new_id.clone()));
                }
                if let Some(old_focus) = workspace
                    .get("focusedTerminalId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    if let Some(new_focus) = terminal_id_map.get(&old_focus) {
                        workspace
                            .insert("focusedTerminalId".into(), Value::String(new_focus.clone()));
                    }
                }
                workspace.remove("lastSdkSessionId");
            }
        }

        if let Some(terminals) = window.get_mut("terminals").and_then(Value::as_array_mut) {
            for (index, terminal) in terminals.iter_mut().enumerate() {
                let Some(terminal) = terminal.as_object_mut() else {
                    continue;
                };
                let old_workspace_id = terminal
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let is_worktree = terminal
                    .get("worktreePath")
                    .and_then(Value::as_str)
                    .is_some_and(|path| !path.is_empty())
                    || terminal
                        .get("agentPreset")
                        .and_then(Value::as_str)
                        .is_some_and(|preset| preset.ends_with("-worktree"));

                if let Some(new_id) = terminal_new_ids.get(index) {
                    terminal.insert("id".into(), Value::String(new_id.clone()));
                }
                if let Some(old_workspace_id) = old_workspace_id.as_deref() {
                    if let Some(new_workspace_id) = workspace_id_map.get(old_workspace_id) {
                        terminal.insert(
                            "workspaceId".into(),
                            Value::String(new_workspace_id.clone()),
                        );
                    }
                    if is_worktree {
                        if let Some(folder_path) = workspace_paths.get(old_workspace_id) {
                            terminal.insert("cwd".into(), Value::String(folder_path.clone()));
                        }
                    }
                }

                for key in [
                    "sdkSessionId",
                    "claudeCliSessionId",
                    "claudeCliRestartToken",
                    "sessionMeta",
                    "pendingPrompt",
                    "pendingImages",
                ] {
                    terminal.remove(key);
                }
                if is_worktree {
                    terminal.remove("worktreePath");
                    terminal.remove("worktreeBranch");
                    terminal.remove("worktreeMergedKind");
                }
                terminal.insert("historyKey".into(), Value::String(generate_history_key()));
            }
        }

        if let Some(old_active_workspace_id) = window
            .get("activeWorkspaceId")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            if let Some(new_active_workspace_id) = workspace_id_map.get(&old_active_workspace_id) {
                window.insert(
                    "activeWorkspaceId".into(),
                    Value::String(new_active_workspace_id.clone()),
                );
            }
        }
        if let Some(old_active_terminal_id) = window
            .get("activeTerminalId")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            if let Some(new_active_terminal_id) = terminal_id_map.get(&old_active_terminal_id) {
                window.insert(
                    "activeTerminalId".into(),
                    Value::String(new_active_terminal_id.clone()),
                );
            }
        }
    }
}

fn snapshot_runtime_identities(snapshot: &Value) -> (HashSet<String>, HashSet<String>) {
    let mut workspace_ids = HashSet::new();
    let mut terminal_ids = HashSet::new();
    let Some(windows) = snapshot.get("windows").and_then(Value::as_array) else {
        return (workspace_ids, terminal_ids);
    };
    for window in windows {
        if let Some(workspaces) = window.get("workspaces").and_then(Value::as_array) {
            workspace_ids.extend(
                workspaces
                    .iter()
                    .filter_map(|workspace| workspace.get("id").and_then(Value::as_str))
                    .filter(|id| !id.trim().is_empty())
                    .map(str::to_string),
            );
        }
        if let Some(terminals) = window.get("terminals").and_then(Value::as_array) {
            terminal_ids.extend(
                terminals
                    .iter()
                    .filter_map(|terminal| terminal.get("id").and_then(Value::as_str))
                    .filter(|id| !id.trim().is_empty())
                    .map(str::to_string),
            );
        }
    }
    (workspace_ids, terminal_ids)
}

// Older BAT releases copied profile snapshots verbatim and the legacy
// "Save Current" command could also persist another window's workspace.
// Preserve the first profile in index order (the source is kept before copies)
// and re-key later profiles before their windows can mount. This makes the
// repair deterministic instead of letting whichever window starts first claim
// a shared runtime and potentially strand the source profile's transcript.
fn repair_cross_profile_snapshot_collisions_at(
    dir: &Path,
    index: &ProfileIndex,
) -> io::Result<Vec<String>> {
    let _guard = profile_index_guard();
    let mut seen_workspace_ids = HashSet::<String>::new();
    let mut seen_terminal_ids = HashSet::<String>::new();
    let mut repaired_profile_ids = Vec::new();

    for profile in index
        .profiles
        .iter()
        .filter(|profile| profile.kind == "local")
    {
        let Some(mut snapshot) = read_snapshot_at(dir, &profile.id) else {
            continue;
        };
        let (workspace_ids, terminal_ids) = snapshot_runtime_identities(&snapshot);
        let collides = workspace_ids
            .iter()
            .any(|id| seen_workspace_ids.contains(id))
            || terminal_ids.iter().any(|id| seen_terminal_ids.contains(id));

        if collides {
            regenerate_duplicated_snapshot_identities(&mut snapshot);
            snapshot["id"] = Value::String(profile.id.clone());
            snapshot["name"] = Value::String(profile.name.clone());
            write_snapshot_at(dir, &profile.id, &snapshot)?;
            repaired_profile_ids.push(profile.id.clone());
            let (workspace_ids, terminal_ids) = snapshot_runtime_identities(&snapshot);
            seen_workspace_ids.extend(workspace_ids);
            seen_terminal_ids.extend(terminal_ids);
        } else {
            seen_workspace_ids.extend(workspace_ids);
            seen_terminal_ids.extend(terminal_ids);
        }
    }

    Ok(repaired_profile_ids)
}

fn repair_cross_profile_snapshot_collisions_once(
    dir: &Path,
    index: &ProfileIndex,
) -> io::Result<Vec<String>> {
    let scanned_dirs = PROFILE_SNAPSHOT_REPAIR_DIRS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut scanned_dirs = scanned_dirs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir_key = dir.to_path_buf();
    if scanned_dirs.contains(&dir_key) {
        return Ok(Vec::new());
    }
    // Hold this small process-wide gate across the one-time scan so a second
    // startup window cannot load a legacy duplicate while the first window is
    // still rewriting it. Failed scans are deliberately not cached and can be
    // retried by the next profile:list call.
    let repaired = repair_cross_profile_snapshot_collisions_at(dir, index)?;
    scanned_dirs.insert(dir_key);
    Ok(repaired)
}

fn migrate_snapshot(raw: Value) -> Option<Value> {
    if raw.get("version").and_then(Value::as_i64) == Some(2) {
        return Some(raw);
    }
    if raw.get("version").and_then(Value::as_i64) == Some(1) {
        return Some(json!({
            "id": raw.get("id").cloned().unwrap_or(Value::Null),
            "name": raw.get("name").cloned().unwrap_or(Value::Null),
            "version": 2,
            "windows": [{
                "workspaces": raw.get("workspaces").cloned().unwrap_or_else(|| json!([])),
                "activeWorkspaceId": raw.get("activeWorkspaceId").cloned().unwrap_or(Value::Null),
                "activeGroup": raw.get("activeGroup").cloned().unwrap_or(Value::Null),
                "terminals": raw.get("terminals").cloned().unwrap_or_else(|| json!([])),
                "activeTerminalId": raw.get("activeTerminalId").cloned().unwrap_or(Value::Null),
            }],
        }));
    }
    None
}

fn read_snapshot_at(dir: &Path, profile_id: &str) -> Option<Value> {
    let raw = fs::read_to_string(profile_path(dir, profile_id)).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    migrate_snapshot(value)
}

fn write_snapshot_at(dir: &Path, profile_id: &str, snapshot: &Value) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    write_owner_only(
        &profile_path(dir, profile_id),
        serde_json::to_string_pretty(snapshot).unwrap_or_else(|_| "{}".into()),
    )
}

fn workspace_from_first_snapshot_window(snapshot: &Value) -> Option<Value> {
    let first = snapshot.get("windows")?.as_array()?.first()?;
    Some(json!({
        "workspaces": first.get("workspaces").cloned().unwrap_or_else(|| json!([])),
        "activeWorkspaceId": first.get("activeWorkspaceId").cloned().unwrap_or(Value::Null),
        "activeGroup": first.get("activeGroup").cloned().unwrap_or(Value::Null),
        "terminals": first.get("terminals").cloned().unwrap_or_else(|| json!([])),
        "activeTerminalId": first.get("activeTerminalId").cloned().unwrap_or(Value::Null),
    }))
}

fn seed_default_snapshot_if_missing(dir: &Path, app: &HostContext, index: &ProfileIndex) {
    if read_snapshot_at(dir, DEFAULT_PROFILE_ID).is_some() {
        return;
    }
    let Some(profile) = index
        .profiles
        .iter()
        .find(|profile| profile.id == DEFAULT_PROFILE_ID)
    else {
        return;
    };
    let workspace = workspace_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(empty_workspace_state);
    let snapshot = snapshot_from_workspace(profile, workspace);
    let _ = write_snapshot_at(dir, DEFAULT_PROFILE_ID, &snapshot);
}

pub fn profile_list_core(app: &HostContext) -> ProfileListResponse {
    profiles_dir(app)
        .map(|dir| {
            let response = list_response_at(&dir);
            let index = ProfileIndex {
                profiles: response.profiles.clone(),
                active_profile_ids: response.active_profile_ids.clone(),
                active_profile_id: None,
            };
            seed_default_snapshot_if_missing(&dir, app, &index);
            match repair_cross_profile_snapshot_collisions_once(&dir, &index) {
                Ok(repaired) if !repaired.is_empty() => {
                    let message = format!(
                        "[profile] WARNING repaired duplicate runtime identities in profiles={}",
                        repaired.join(",")
                    );
                    #[cfg(feature = "desktop")]
                    log_tauri(app, &message);
                    #[cfg(not(feature = "desktop"))]
                    eprintln!("{message}");
                }
                Ok(_) => {}
                Err(err) => {
                    let message = format!(
                        "[profile] WARNING could not repair duplicate runtime identities: {err}"
                    );
                    #[cfg(feature = "desktop")]
                    log_tauri(app, &message);
                    #[cfg(not(feature = "desktop"))]
                    eprintln!("{message}");
                }
            }
            response
        })
        .unwrap_or_else(|| ProfileListResponse {
            profiles: vec![default_entry()],
            active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_list(app: AppHandle) -> ProfileListResponse {
    profile_list_core(&HostContext::from_app(app))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_list_local(app: AppHandle) -> ProfileListResponse {
    profile_list(app)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_get(app: AppHandle, profile_id: String) -> Option<ProfileEntry> {
    let dir = profiles_dir(&HostContext::from_app(app.clone()))?;
    read_index_at(&dir)
        .profiles
        .into_iter()
        .find(|profile| profile.id == profile_id)
}

pub fn profile_get_active_ids_core(app: &HostContext) -> Vec<String> {
    profiles_dir(app)
        .map(|dir| read_index_at(&dir).active_profile_ids)
        .unwrap_or_else(|| vec![DEFAULT_PROFILE_ID.into()])
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_get_active_ids(app: AppHandle) -> Vec<String> {
    profile_get_active_ids_core(&HostContext::from_app(app))
}

pub fn profile_load_snapshot_for_remote(app: &HostContext, profile_id: &str) -> Option<Value> {
    let dir = profiles_dir(app)?;
    load_profile_snapshot_at(&dir, profile_id, false)
}

// Routing validation must not run catalog repair or activate a desktop window.
pub fn profile_entry_for_context(app: &HostContext, profile_id: &str) -> Option<ProfileEntry> {
    let dir = profiles_dir(app)?;
    let _guard = profile_index_guard();
    read_index_for_update_unlocked(&dir).ok()?.profiles.into_iter().find(|p| p.id == profile_id)
}

pub fn profile_load_for_remote(app: &HostContext, profile_id: &str) -> Option<Value> {
    let dir = profiles_dir(app)?;
    let snapshot = load_profile_snapshot_at(&dir, profile_id, true);
    if snapshot.is_some() {
        emit_profile_changed(app);
    }
    snapshot
}

pub fn profile_workspace_json_for_remote(app: &HostContext, profile_id: &str) -> Option<String> {
    // A live local window can hold unsaved workspace edits; headless has no
    // windows, so it reads the persisted snapshot below.
    #[cfg(feature = "desktop")]
    if let Some(workspace) =
        window_registry::profile_workspace_from_existing_window(app.app(), profile_id)
    {
        return serde_json::to_string_pretty(&workspace).ok();
    }
    let dir = profiles_dir(app)?;
    let snapshot = load_profile_snapshot_at(&dir, profile_id, false)?;
    let workspace = workspace_from_first_snapshot_window(&snapshot)?;
    serde_json::to_string_pretty(&workspace).ok()
}

pub fn profile_save_workspace_for_remote(app: &HostContext, profile_id: &str, data: &str) -> bool {
    let Some(dir) = profiles_dir(app) else {
        return false;
    };
    let Ok(workspace) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    let wrote = update_index_at(&dir, |index| {
        let profile = index
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id && profile.kind == "local")
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "profile not found"))?;
        let snapshot = snapshot_from_workspace(&profile, workspace);
        write_snapshot_at(&dir, profile_id, &snapshot)?;
        let _ = activate_profile_in_index(index, profile_id);
        Ok(())
    })
    .is_ok();
    if wrote {
        emit_profile_changed(app);
    }
    wrote
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_create(
    app: AppHandle,
    name: String,
    options: Option<CreateProfileOptions>,
) -> ProfileEntry {
    let Some(dir) = profiles_dir(&HostContext::from_app(app.clone())) else {
        return profile_from_options(DEFAULT_PROFILE_ID.into(), name, options);
    };
    let fallback = profile_from_options(DEFAULT_PROFILE_ID.into(), name.clone(), options.clone());
    let Ok(entry) = update_index_at(&dir, |index| {
        let id = unique_profile_id(index, &name);
        let entry = profile_from_options(id, name, options);
        index.profiles.push(entry.clone());
        if entry.kind == "local" {
            let _ = write_snapshot_at(&dir, &entry.id, &empty_snapshot(&entry));
        }
        Ok(entry)
    }) else {
        return fallback;
    };
    emit_profile_changed(&HostContext::from_app(app.clone()));
    entry
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_save(app: AppHandle, window: WebviewWindow, profile_id: String) -> bool {
    let ctx = HostContext::from_app(app.clone());
    let window_id = window.label();
    let bound_profile_id = window_registry::profile_id_for_window(&app, window_id);
    if bound_profile_id.as_deref() != Some(profile_id.as_str()) {
        log_tauri(
            &ctx,
            &format!(
                "[profile] WARNING save rejected window={window_id} requestedProfile={profile_id} boundProfile={}",
                bound_profile_id.as_deref().unwrap_or("<none>")
            ),
        );
        return false;
    }
    let Some(workspace_json) = window_registry::workspace_json(&app, window_id) else {
        log_tauri(
            &ctx,
            &format!(
                "[profile] WARNING save rejected window={window_id} profile={profile_id} reason=missing-window-workspace"
            ),
        );
        return false;
    };
    let Ok(workspace) = serde_json::from_str::<Value>(&workspace_json) else {
        log_tauri(
            &ctx,
            &format!(
                "[profile] WARNING save rejected window={window_id} profile={profile_id} reason=invalid-window-workspace"
            ),
        );
        return false;
    };
    let Some(dir) = profiles_dir(&ctx) else {
        return false;
    };
    let saved = update_index_at(&dir, |index| {
        let profile = index
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id && profile.kind == "local")
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "profile not found"))?;
        let snapshot = snapshot_from_workspace(&profile, workspace);
        write_snapshot_at(&dir, &profile_id, &snapshot)?;
        let entry = index
            .profiles
            .iter_mut()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "profile not found"))?;
        entry.updated_at = now_millis();
        Ok(())
    })
    .is_ok();
    if saved {
        emit_profile_changed(&ctx);
    }
    saved
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_load(app: AppHandle, window: WebviewWindow, profile_id: String) -> Value {
    let Some(dir) = profiles_dir(&HostContext::from_app(app.clone())) else {
        return Value::Null;
    };
    let index = read_index_at(&dir);
    let Some(profile) = index
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.kind == "local")
        .cloned()
    else {
        return Value::Null;
    };
    let snapshot = read_snapshot_at(&dir, &profile_id);
    let workspace = snapshot
        .as_ref()
        .and_then(workspace_from_first_snapshot_window)
        .or_else(|| window_registry::profile_workspace_from_existing_window(&app, &profile_id));
    if let Some(workspace) = workspace {
        if let Some(path) = workspace_path(&HostContext::from_app(app.clone())) {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(
                path,
                serde_json::to_string_pretty(&workspace).unwrap_or_else(|_| "{}".into()),
            );
        }
        let snapshot = snapshot_from_workspace(&profile, workspace.clone());
        let _ = write_snapshot_at(&dir, &profile_id, &snapshot);
        let _ = window_registry::load_profile_workspace_into_window(
            &app,
            window.label(),
            &profile_id,
            workspace,
        );
    }
    let _ = activate_profile_id(&HostContext::from_app(app.clone()), &profile_id);
    snapshot.unwrap_or_else(|| empty_snapshot(&profile))
}

pub fn activate_profile_id(app: &HostContext, profile_id: &str) -> bool {
    let Some(dir) = profiles_dir(app) else {
        return false;
    };
    let saved = update_index_at(&dir, |index| {
        if activate_profile_in_index(index, profile_id) {
            Ok(())
        } else {
            Err(io::Error::new(io::ErrorKind::NotFound, "profile not found"))
        }
    })
    .is_ok();
    if saved {
        emit_profile_changed(app);
    }
    saved
}

pub fn deactivate_profile_id(app: &HostContext, profile_id: &str) -> bool {
    let Some(dir) = profiles_dir(app) else {
        return false;
    };
    let saved = update_index_at(&dir, |index| {
        index.active_profile_ids.retain(|id| id != profile_id);
        if index.active_profile_ids.is_empty() {
            index.active_profile_ids.push(DEFAULT_PROFILE_ID.into());
        }
        Ok(())
    })
    .is_ok();
    if saved {
        emit_profile_changed(app);
    }
    saved
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_delete(app: AppHandle, profile_id: String) -> bool {
    if profile_id == DEFAULT_PROFILE_ID {
        return false;
    }
    let Some(dir) = profiles_dir(&HostContext::from_app(app.clone())) else {
        return false;
    };
    let saved = update_index_at(&dir, |index| {
        let before = index.profiles.len();
        index.profiles.retain(|profile| profile.id != profile_id);
        index.active_profile_ids.retain(|id| id != &profile_id);
        if before == index.profiles.len() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "profile not found"));
        }
        Ok(())
    })
    .is_ok();
    if saved {
        delete_remote_token_from_safe_store(&profile_id);
        let _ = fs::remove_file(profile_path(&dir, &profile_id));
        emit_profile_changed(&HostContext::from_app(app.clone()));
    }
    saved
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_rename(app: AppHandle, profile_id: String, new_name: String) -> bool {
    let Some(dir) = profiles_dir(&HostContext::from_app(app.clone())) else {
        return false;
    };
    let snapshot_name = match update_index_at(&dir, |index| {
        let profile = index
            .profiles
            .iter_mut()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "profile not found"))?;
        profile.name = new_name;
        profile.updated_at = now_millis();
        Ok(profile.name.clone())
    }) {
        Ok(name) => name,
        Err(_) => return false,
    };
    if let Some(mut snapshot) = read_snapshot_at(&dir, &profile_id) {
        snapshot["name"] = Value::String(snapshot_name);
        let _ = write_snapshot_at(&dir, &profile_id, &snapshot);
    }
    emit_profile_changed(&HostContext::from_app(app.clone()));
    true
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_update(
    app: AppHandle,
    profile_id: String,
    updates: Option<UpdateProfileOptions>,
) -> bool {
    let Some(dir) = profiles_dir(&HostContext::from_app(app.clone())) else {
        return false;
    };
    let Some(updates) = updates else {
        return false;
    };
    let saved = update_index_at(&dir, |index| {
        let profile = index
            .profiles
            .iter_mut()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "profile not found"))?;
        if let Some(value) = updates.remote_host {
            profile.remote_host = Some(value);
        }
        if let Some(value) = updates.remote_port {
            profile.remote_port = Some(value);
        }
        if let Some(value) = updates.remote_token {
            profile.remote_token = Some(value);
        }
        if let Some(value) = updates.remote_fingerprint {
            profile.remote_fingerprint = Some(value);
        }
        if updates.remote_profile_id.is_some() {
            profile.remote_profile_id = updates.remote_profile_id;
        }
        if updates.remote_profile_name.is_some() {
            profile.remote_profile_name = updates.remote_profile_name;
        }
        if profile.remote_host.is_some() || profile.remote_fingerprint.is_some() {
            profile.kind = "remote".into();
        }
        profile.updated_at = now_millis();
        Ok(())
    })
    .is_ok();
    if saved {
        emit_profile_changed(&HostContext::from_app(app.clone()));
    }
    saved
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_duplicate(
    app: AppHandle,
    profile_id: String,
    new_name: String,
) -> Option<ProfileEntry> {
    let dir = profiles_dir(&HostContext::from_app(app.clone()))?;
    let copy = update_index_at(&dir, |index| {
        let source = index
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "profile not found"))?;
        let now = now_millis();
        let mut copy = source;
        copy.id = unique_profile_id(index, &new_name);
        copy.name = new_name;
        copy.created_at = now;
        copy.updated_at = now;
        index.profiles.push(copy.clone());
        Ok(copy)
    })
    .ok()?;
    if let Some(mut snapshot) = read_snapshot_at(&dir, &profile_id) {
        regenerate_duplicated_snapshot_identities(&mut snapshot);
        snapshot["id"] = Value::String(copy.id.clone());
        snapshot["name"] = Value::String(copy.name.clone());
        let _ = write_snapshot_at(&dir, &copy.id, &snapshot);
    } else if copy.kind == "local" {
        let _ = write_snapshot_at(&dir, &copy.id, &empty_snapshot(&copy));
    }
    emit_profile_changed(&HostContext::from_app(app.clone()));
    Some(copy)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_activate(app: AppHandle, profile_id: String) {
    let _ = activate_profile_id(&HostContext::from_app(app.clone()), &profile_id);
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_deactivate(app: AppHandle, profile_id: String) {
    let _ = deactivate_profile_id(&HostContext::from_app(app.clone()), &profile_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn temp_profile_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bat-profile-test-{}-{}-{name}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_returns_single_default_entry_for_empty_dir() {
        let dir = temp_profile_dir("empty");
        let r = list_response_at(&dir);
        assert_eq!(r.profiles.len(), 1);
        assert_eq!(r.profiles[0].id, DEFAULT_PROFILE_ID);
        assert_eq!(r.profiles[0].name, DEFAULT_PROFILE_NAME);
        assert_eq!(r.profiles[0].kind, "local");
        assert_eq!(r.active_profile_ids, vec![DEFAULT_PROFILE_ID.to_string()]);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn list_serializes_camel_case() {
        let r = ProfileListResponse {
            profiles: vec![default_entry()],
            active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"activeProfileIds\":[\"default\"]"));
        assert!(json.contains("\"createdAt\":0"));
        assert!(json.contains("\"updatedAt\":0"));
    }

    #[test]
    fn profile_index_create_rename_delete_round_trips() {
        let dir = temp_profile_dir("crud");
        let mut index = read_index_at(&dir);
        let entry = profile_from_options(
            unique_profile_id(&index, "My Profile"),
            "My Profile".into(),
            None,
        );
        index.profiles.push(entry.clone());
        write_index_at(&dir, index).unwrap();

        let mut index = read_index_at(&dir);
        assert!(index.profiles.iter().any(|profile| profile.id == entry.id));
        let profile = index
            .profiles
            .iter_mut()
            .find(|profile| profile.id == entry.id)
            .unwrap();
        profile.name = "Renamed".into();
        write_index_at(&dir, index).unwrap();

        let mut index = read_index_at(&dir);
        assert!(index
            .profiles
            .iter()
            .any(|profile| profile.name == "Renamed"));
        index.profiles.retain(|profile| profile.id != entry.id);
        write_index_at(&dir, index).unwrap();
        assert!(!read_index_at(&dir)
            .profiles
            .iter()
            .any(|profile| profile.id == entry.id));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn activate_profile_appends_without_dropping_existing_active_profiles() {
        let mut index = ProfileIndex {
            profiles: vec![
                default_entry(),
                profile_from_options("local-1".into(), "Local 1".into(), None),
                profile_from_options("local-2".into(), "Local 2".into(), None),
            ],
            active_profile_ids: vec![DEFAULT_PROFILE_ID.into(), "local-1".into()],
            active_profile_id: None,
        };

        assert!(activate_profile_in_index(&mut index, "local-2"));
        assert_eq!(
            index.active_profile_ids,
            vec![
                DEFAULT_PROFILE_ID.to_string(),
                "local-1".into(),
                "local-2".into()
            ]
        );
        assert!(activate_profile_in_index(&mut index, "local-2"));
        assert_eq!(
            index.active_profile_ids,
            vec![
                DEFAULT_PROFILE_ID.to_string(),
                "local-1".into(),
                "local-2".into()
            ]
        );
        assert!(!activate_profile_in_index(&mut index, "missing"));
    }

    #[test]
    fn concurrent_profile_updates_preserve_metadata_and_every_active_set_change() {
        let dir = Arc::new(temp_profile_dir("concurrent-updates"));
        let profile_ids = ["default", "lineage", "projects", "bat", "tail-hyper"];
        write_index_at(
            dir.as_ref(),
            ProfileIndex {
                profiles: profile_ids
                    .iter()
                    .map(|id| profile_from_options((*id).into(), (*id).into(), None))
                    .collect(),
                active_profile_ids: profile_ids.iter().map(|id| (*id).into()).collect(),
                active_profile_id: None,
            },
        )
        .unwrap();

        let ids_to_deactivate = ["default", "projects", "bat", "tail-hyper"];
        let barrier = Arc::new(Barrier::new(ids_to_deactivate.len()));
        let handles = ids_to_deactivate
            .into_iter()
            .map(|profile_id| {
                let dir = Arc::clone(&dir);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    update_index_at(dir.as_ref(), |index| {
                        index.active_profile_ids.retain(|id| id != profile_id);
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }

        let index = read_index_at(dir.as_ref());
        assert_eq!(index.profiles.len(), profile_ids.len());
        assert_eq!(index.active_profile_ids, vec!["lineage".to_string()]);
        assert!(serde_json::from_str::<ProfileIndex>(
            &fs::read_to_string(dir.join(INDEX_FILE)).unwrap()
        )
        .is_ok());
        fs::remove_dir_all(dir.as_ref()).ok();
    }

    #[test]
    fn malformed_index_without_valid_backup_refuses_to_overwrite_with_default() {
        let dir = temp_profile_dir("malformed-no-backup");
        let malformed = r#"{"profiles":"#;
        fs::write(dir.join(INDEX_FILE), malformed).unwrap();

        let result = update_index_at(&dir, |index| {
            index.active_profile_ids.push("lineage".into());
            Ok(())
        });

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read_to_string(dir.join(INDEX_FILE)).unwrap(), malformed);
        assert!(!dir.join(INDEX_BACKUP_FILE).exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn malformed_primary_recovers_from_last_valid_backup() {
        let dir = temp_profile_dir("recover-backup");
        let lineage = profile_from_options("lineage".into(), "lineage".into(), None);
        write_index_at(
            &dir,
            ProfileIndex {
                profiles: vec![default_entry(), lineage.clone()],
                active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
                active_profile_id: None,
            },
        )
        .unwrap();

        let mut next = read_index_at(&dir);
        next.profiles.push(profile_from_options(
            "projects".into(),
            "projects".into(),
            None,
        ));
        write_index_at(&dir, next).unwrap();
        fs::write(dir.join(INDEX_FILE), r#"{"profiles":"#).unwrap();

        update_index_at(&dir, |index| {
            assert!(activate_profile_in_index(index, &lineage.id));
            Ok(())
        })
        .unwrap();

        let recovered = read_index_at(&dir);
        assert!(recovered
            .profiles
            .iter()
            .any(|profile| profile.id == lineage.id));
        assert!(recovered.active_profile_ids.contains(&lineage.id));
        assert!(serde_json::from_str::<ProfileIndex>(
            &fs::read_to_string(dir.join(INDEX_FILE)).unwrap()
        )
        .is_ok());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn remote_tokens_are_stored_outside_index_and_rehydrated() {
        let dir = temp_profile_dir("tokens");
        let remote = profile_from_options(
            "remote-1".into(),
            "Remote".into(),
            Some(CreateProfileOptions {
                kind: Some("remote".into()),
                remote_host: Some("127.0.0.1".into()),
                remote_port: Some(9876),
                remote_token: Some("secret-token".into()),
                remote_fingerprint: Some("AA".into()),
                remote_profile_id: Some("default".into()),
                remote_profile_name: None,
            }),
        );
        write_index_at(
            &dir,
            ProfileIndex {
                profiles: vec![default_entry(), remote],
                active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
                active_profile_id: None,
            },
        )
        .unwrap();

        let index_raw = fs::read_to_string(dir.join(INDEX_FILE)).unwrap();
        assert!(!index_raw.contains("secret-token"));
        let rehydrated = read_index_at(&dir);
        let remote = rehydrated
            .profiles
            .iter()
            .find(|profile| profile.id == "remote-1")
            .unwrap();
        assert_eq!(remote.remote_token.as_deref(), Some("secret-token"));

        write_index_at(
            &dir,
            ProfileIndex {
                profiles: vec![default_entry()],
                active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
                active_profile_id: None,
            },
        )
        .unwrap();
        let store = read_token_store(&dir);
        assert!(!store.tokens.contains_key("remote-1"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unreadable_encrypted_remote_token_store_is_preserved_on_metadata_write() {
        let dir = temp_profile_dir("encrypted-token-preserve");
        let encrypted = r#"{"enc":true,"data":"djEwJGVuY3J5cHRlZA=="}"#;
        fs::write(dir.join(TOKEN_FILE), encrypted).unwrap();
        let remote = profile_from_options(
            "remote-1".into(),
            "Remote".into(),
            Some(CreateProfileOptions {
                kind: Some("remote".into()),
                remote_host: Some("127.0.0.1".into()),
                remote_port: Some(9876),
                remote_token: None,
                remote_fingerprint: Some("AA".into()),
                remote_profile_id: Some("default".into()),
                remote_profile_name: None,
            }),
        );

        write_index_at(
            &dir,
            ProfileIndex {
                profiles: vec![default_entry(), remote],
                active_profile_ids: vec![DEFAULT_PROFILE_ID.into(), "remote-1".into()],
                active_profile_id: None,
            },
        )
        .unwrap();

        assert_eq!(fs::read_to_string(dir.join(TOKEN_FILE)).unwrap(), encrypted);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn load_profile_snapshot_at_can_activate_without_sidecar_profile_handler() {
        let dir = temp_profile_dir("remote-load-snapshot");
        let entry = profile_from_options(
            unique_profile_id(&read_index_at(&dir), "Dev"),
            "Dev".into(),
            None,
        );
        write_index_at(
            &dir,
            ProfileIndex {
                profiles: vec![default_entry(), entry.clone()],
                active_profile_ids: vec![DEFAULT_PROFILE_ID.into()],
                active_profile_id: None,
            },
        )
        .unwrap();
        write_snapshot_at(
            &dir,
            &entry.id,
            &json!({
                "id": entry.id,
                "name": "Dev",
                "version": 2,
                "windows": [{
                    "workspaces": [{ "id": "w1" }],
                    "activeWorkspaceId": "w1",
                    "activeGroup": null,
                    "terminals": [],
                    "activeTerminalId": null
                }]
            }),
        )
        .unwrap();

        let snapshot = load_profile_snapshot_at(&dir, &entry.id, true).unwrap();
        assert_eq!(snapshot["version"], json!(2));
        assert!(read_index_at(&dir).active_profile_ids.contains(&entry.id));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn duplicate_assigns_new_id_and_name() {
        let dir = temp_profile_dir("duplicate");
        let mut index = read_index_at(&dir);
        let source =
            profile_from_options(unique_profile_id(&index, "Source"), "Source".into(), None);
        index.profiles.push(source.clone());
        let new_id = unique_profile_id(&index, "Source Copy");
        let mut copy = source.clone();
        copy.id = new_id;
        copy.name = "Source Copy".into();
        index.profiles.push(copy.clone());
        write_index_at(&dir, index).unwrap();

        let ids = read_index_at(&dir)
            .profiles
            .into_iter()
            .map(|profile| profile.id)
            .collect::<HashSet<_>>();
        assert!(ids.contains(&source.id));
        assert!(ids.contains(&copy.id));
        assert_ne!(source.id, copy.id);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn duplicated_snapshot_gets_an_independent_runtime_namespace() {
        let mut snapshot = json!({
            "id": "source",
            "name": "Source",
            "version": 2,
            "windows": [{
                "workspaces": [{
                    "id": "workspace-1",
                    "folderPath": "/repo",
                    "focusedTerminalId": "terminal-1",
                    "lastSdkSessionId": "sdk-workspace"
                }],
                "activeWorkspaceId": "workspace-1",
                "terminals": [{
                    "id": "terminal-1",
                    "workspaceId": "workspace-1",
                    "agentPreset": "claude-code-worktree",
                    "cwd": "/repo/.bat-worktrees/shared",
                    "sdkSessionId": "sdk-1",
                    "claudeCliSessionId": "cli-1",
                    "claudeCliRestartToken": 123,
                    "sessionMeta": { "inputTokens": 42 },
                    "worktreePath": "/repo/.bat-worktrees/shared",
                    "worktreeBranch": "bat/shared",
                    "worktreeMergedKind": "merged",
                    "historyKey": "shared-history"
                }],
                "activeTerminalId": "terminal-1"
            }]
        });

        regenerate_duplicated_snapshot_identities(&mut snapshot);

        let window = &snapshot["windows"][0];
        let workspace = &window["workspaces"][0];
        let terminal = &window["terminals"][0];
        let workspace_id = workspace["id"].as_str().unwrap();
        let terminal_id = terminal["id"].as_str().unwrap();

        assert_ne!(workspace_id, "workspace-1");
        assert_ne!(terminal_id, "terminal-1");
        assert_eq!(terminal["workspaceId"], workspace_id);
        assert_eq!(workspace["focusedTerminalId"], terminal_id);
        assert_eq!(window["activeWorkspaceId"], workspace_id);
        assert_eq!(window["activeTerminalId"], terminal_id);
        assert_eq!(terminal["cwd"], "/repo");
        assert_eq!(terminal["historyKey"].as_str().unwrap().len(), 12);
        for key in [
            "sdkSessionId",
            "claudeCliSessionId",
            "claudeCliRestartToken",
            "sessionMeta",
            "worktreePath",
            "worktreeBranch",
            "worktreeMergedKind",
        ] {
            assert!(terminal.get(key).is_none(), "{key} should not be copied");
        }
        assert!(workspace.get("lastSdkSessionId").is_none());
    }

    #[test]
    fn cross_profile_collision_repair_preserves_first_profile_owner() {
        let dir = temp_profile_dir("cross-profile-runtime-collision");
        let source = profile_from_options("source".into(), "Source".into(), None);
        let copy = profile_from_options("copy".into(), "Copy".into(), None);
        let index = ProfileIndex {
            profiles: vec![source.clone(), copy.clone()],
            active_profile_ids: vec![source.id.clone(), copy.id.clone()],
            active_profile_id: None,
        };
        let source_snapshot = json!({
            "id": source.id,
            "name": source.name,
            "version": 2,
            "windows": [{
                "workspaces": [{
                    "id": "shared-workspace",
                    "folderPath": "/repo",
                    "focusedTerminalId": "shared-terminal",
                    "lastSdkSessionId": "sdk-source"
                }],
                "activeWorkspaceId": "shared-workspace",
                "terminals": [{
                    "id": "shared-terminal",
                    "workspaceId": "shared-workspace",
                    "agentPreset": "claude-code-v2",
                    "cwd": "/repo",
                    "sdkSessionId": "sdk-source",
                    "historyKey": "source-history"
                }],
                "activeTerminalId": "shared-terminal"
            }]
        });
        let mut copy_snapshot = source_snapshot.clone();
        copy_snapshot["id"] = Value::String(copy.id.clone());
        copy_snapshot["name"] = Value::String(copy.name.clone());
        write_snapshot_at(&dir, &source.id, &source_snapshot).unwrap();
        write_snapshot_at(&dir, &copy.id, &copy_snapshot).unwrap();

        let repaired = repair_cross_profile_snapshot_collisions_at(&dir, &index).unwrap();
        assert_eq!(repaired, vec![copy.id.clone()]);

        let preserved = read_snapshot_at(&dir, &source.id).unwrap();
        let repaired_copy = read_snapshot_at(&dir, &copy.id).unwrap();
        assert_eq!(
            preserved["windows"][0]["terminals"][0]["id"],
            "shared-terminal"
        );
        assert_eq!(
            preserved["windows"][0]["terminals"][0]["sdkSessionId"],
            "sdk-source"
        );
        assert_ne!(
            repaired_copy["windows"][0]["terminals"][0]["id"],
            "shared-terminal"
        );
        assert!(repaired_copy["windows"][0]["terminals"][0]
            .get("sdkSessionId")
            .is_none());
        assert!(repair_cross_profile_snapshot_collisions_at(&dir, &index)
            .unwrap()
            .is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn snapshot_round_trip_uses_electron_v2_shape() {
        let dir = temp_profile_dir("snapshot");
        let profile = profile_from_options("local-1".into(), "Local".into(), None);
        let snapshot = snapshot_from_workspace(
            &profile,
            json!({
                "workspaces": [{"id": "w1"}],
                "activeWorkspaceId": "w1",
                "activeGroup": "g1",
                "terminals": [{"id": "t1"}],
                "activeTerminalId": "t1",
            }),
        );
        write_snapshot_at(&dir, &profile.id, &snapshot).unwrap();

        let loaded = read_snapshot_at(&dir, &profile.id).unwrap();
        assert_eq!(loaded["version"], 2);
        assert_eq!(loaded["windows"][0]["activeWorkspaceId"], "w1");
        let workspace = workspace_from_first_snapshot_window(&loaded).unwrap();
        assert_eq!(workspace["workspaces"][0]["id"], "w1");
        assert_eq!(workspace["activeTerminalId"], "t1");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn snapshot_migrates_v1_shape() {
        let migrated = migrate_snapshot(json!({
            "id": "default",
            "name": "Default",
            "version": 1,
            "workspaces": [{"id": "w1"}],
            "activeWorkspaceId": "w1",
            "activeGroup": null,
            "terminals": [],
            "activeTerminalId": null,
        }))
        .unwrap();
        assert_eq!(migrated["version"], 2);
        assert_eq!(migrated["windows"][0]["workspaces"][0]["id"], "w1");
    }
}
