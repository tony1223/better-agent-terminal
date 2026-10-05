// profile:* — host/window adapters for the persistent profile store.
#[cfg(feature = "desktop")]
use crate::commands::app::log_tauri;
use crate::event_hub::publish_runtime_event;
use crate::host_context::HostContext;
#[cfg(feature = "desktop")]
use crate::window_registry;
pub use bat_app_storage::profile::*;
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, WebviewWindow};
fn profiles_dir(app: &HostContext) -> Option<PathBuf> {
    app.data_dir_opt().map(|dir| dir.join("profiles"))
}

fn app_data_dir(app: &HostContext) -> Option<PathBuf> {
    app.data_dir_opt()
}

fn workspace_path(app: &HostContext) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join("workspaces.json"))
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
    read_index_for_update_unlocked(&dir)
        .ok()?
        .profiles
        .into_iter()
        .find(|p| p.id == profile_id)
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
    let write = |workspace| {
        update_index_at(&dir, |index| {
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
        .is_ok()
    };
    #[cfg(feature = "desktop")]
    let wrote =
        window_registry::with_runtime_workspace_meta(app.app(), profile_id, workspace, write);
    #[cfg(not(feature = "desktop"))]
    let wrote = write(workspace);
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
        if let Some(value) = updates.ssh_target {
            let trimmed = value.trim().to_string();
            profile.ssh_target = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
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
