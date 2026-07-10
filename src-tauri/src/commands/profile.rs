// profile:* — Tauri profile index persistence.
//
// Electron stores profile metadata in <userData>/profiles/index.json and keeps
// remote tokens in a separate secret envelope. Tauri keeps tokens out of
// index.json and uses the old keyring item only as a migration fallback; this
// avoids repeated macOS Keychain prompts during normal profile reads/writes.

use crate::app_data;
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
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, WebviewWindow};

const DEFAULT_PROFILE_ID: &str = "default";
const DEFAULT_PROFILE_NAME: &str = "Default";
const INDEX_FILE: &str = "index.json";
const TOKEN_FILE: &str = "remote-tokens.enc.json";
const REMOTE_TOKEN_KEYRING_SERVICE: &str = "better-agent-terminal:remote-profile-token";

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

#[derive(Debug, Default, Deserialize)]
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

fn write_owner_only(path: &Path, content: String) -> std::io::Result<()> {
    fs::write(path, content)?;
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

fn read_index_at(dir: &Path) -> ProfileIndex {
    let path = dir.join(INDEX_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return default_index();
    };
    let parsed = serde_json::from_str::<ProfileIndex>(&raw).unwrap_or_else(|_| default_index());
    hydrate_remote_tokens(dir, normalize_index(parsed))
}

fn write_index_at(dir: &Path, index: ProfileIndex) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let clean = strip_and_persist_remote_tokens(dir, normalize_index(index))?;
    write_owner_only(
        &dir.join(INDEX_FILE),
        serde_json::to_string_pretty(&clean).unwrap_or_else(|_| "{}".into()),
    )
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
    let mut index = read_index_at(dir);
    if activate && !activate_profile_in_index(&mut index, profile_id) {
        return None;
    }
    let snapshot = read_snapshot_at(dir, profile_id)?;
    if activate {
        let _ = write_index_at(dir, index);
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
    let mut index = read_index_at(&dir);
    let Some(profile) = index
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.kind == "local")
        .cloned()
    else {
        return false;
    };
    let Ok(workspace) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    let snapshot = snapshot_from_workspace(&profile, workspace);
    let wrote = write_snapshot_at(&dir, profile_id, &snapshot).is_ok();
    if wrote {
        let _ = activate_profile_in_index(&mut index, profile_id);
        let _ = write_index_at(&dir, index);
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
    let mut index = read_index_at(&dir);
    let id = unique_profile_id(&index, &name);
    let entry = profile_from_options(id, name, options);
    index.profiles.push(entry.clone());
    if entry.kind == "local" {
        let _ = write_snapshot_at(&dir, &entry.id, &empty_snapshot(&entry));
    }
    let _ = write_index_at(&dir, index);
    emit_profile_changed(&HostContext::from_app(app.clone()));
    entry
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn profile_save(app: AppHandle, profile_id: String) -> bool {
    let Some(dir) = profiles_dir(&HostContext::from_app(app.clone())) else {
        return false;
    };
    let index = read_index_at(&dir);
    let Some(profile) = index
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.kind == "local")
    else {
        return false;
    };
    let workspace = workspace_path(&HostContext::from_app(app.clone()))
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(empty_workspace_state);
    let snapshot = snapshot_from_workspace(profile, workspace);
    if write_snapshot_at(&dir, &profile_id, &snapshot).is_err() {
        return false;
    }
    let mut index = index;
    if let Some(entry) = index
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
    {
        entry.updated_at = now_millis();
    }
    let saved = write_index_at(&dir, index).is_ok();
    if saved {
        emit_profile_changed(&HostContext::from_app(app.clone()));
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
    let mut index = index;
    if activate_profile_in_index(&mut index, &profile_id) {
        let _ = write_index_at(&dir, index);
        emit_profile_changed(&HostContext::from_app(app.clone()));
    }
    snapshot.unwrap_or_else(|| empty_snapshot(&profile))
}

pub fn activate_profile_id(app: &HostContext, profile_id: &str) -> bool {
    let Some(dir) = profiles_dir(app) else {
        return false;
    };
    let mut index = read_index_at(&dir);
    if !activate_profile_in_index(&mut index, profile_id) {
        return false;
    }
    let saved = write_index_at(&dir, index).is_ok();
    if saved {
        emit_profile_changed(app);
    }
    saved
}

pub fn deactivate_profile_id(app: &HostContext, profile_id: &str) -> bool {
    let Some(dir) = profiles_dir(app) else {
        return false;
    };
    let mut index = read_index_at(&dir);
    index.active_profile_ids.retain(|id| id != profile_id);
    if index.active_profile_ids.is_empty() {
        index.active_profile_ids.push(DEFAULT_PROFILE_ID.into());
    }
    let saved = write_index_at(&dir, index).is_ok();
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
    let mut index = read_index_at(&dir);
    let before = index.profiles.len();
    index.profiles.retain(|profile| profile.id != profile_id);
    index.active_profile_ids.retain(|id| id != &profile_id);
    if before == index.profiles.len() {
        return false;
    }
    delete_remote_token_from_safe_store(&profile_id);
    let _ = fs::remove_file(profile_path(&dir, &profile_id));
    let saved = write_index_at(&dir, index).is_ok();
    if saved {
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
    let mut index = read_index_at(&dir);
    let Some(profile) = index
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
    else {
        return false;
    };
    profile.name = new_name;
    let snapshot_name = profile.name.clone();
    profile.updated_at = now_millis();
    if let Some(mut snapshot) = read_snapshot_at(&dir, &profile_id) {
        snapshot["name"] = Value::String(snapshot_name);
        let _ = write_snapshot_at(&dir, &profile_id, &snapshot);
    }
    let saved = write_index_at(&dir, index).is_ok();
    if saved {
        emit_profile_changed(&HostContext::from_app(app.clone()));
    }
    saved
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
    let mut index = read_index_at(&dir);
    let Some(profile) = index
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
    else {
        return false;
    };
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
    let saved = write_index_at(&dir, index).is_ok();
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
    let mut index = read_index_at(&dir);
    let source = index
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)?
        .clone();
    let now = now_millis();
    let mut copy = source;
    copy.id = unique_profile_id(&index, &new_name);
    copy.name = new_name;
    copy.created_at = now;
    copy.updated_at = now;
    index.profiles.push(copy.clone());
    if let Some(mut snapshot) = read_snapshot_at(&dir, &profile_id) {
        snapshot["id"] = Value::String(copy.id.clone());
        snapshot["name"] = Value::String(copy.name.clone());
        let _ = write_snapshot_at(&dir, &copy.id, &snapshot);
    } else if copy.kind == "local" {
        let _ = write_snapshot_at(&dir, &copy.id, &empty_snapshot(&copy));
    }
    write_index_at(&dir, index).ok()?;
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
