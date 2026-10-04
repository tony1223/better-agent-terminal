use crate::app_data;
use crate::commands::app::log_tauri;
pub use bat_app_storage::window_snapshot::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const WINDOWS_FILE: &str = "windows.json";
const WORKSPACES_FILE: &str = "workspaces.json";
const PROFILES_DIR: &str = "profiles";

fn bat_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn debug_registry_log(app: &AppHandle, message: impl AsRef<str>) {
    if bat_debug_enabled() {
        log_tauri(
            &crate::host_context::HostContext::from_app(app.clone()),
            &format!("[window-registry] {}", message.as_ref()),
        );
    }
}

#[derive(Default)]
pub struct WindowRegistryState {
    entries: Mutex<Vec<WindowEntry>>,
    // One-shot markers for windows created by app_new_window (Cmd+N) so the
    // renderer knows to skip profile.load() — those windows should land
    // empty instead of inheriting the bound profile's saved workspaces.
    // Per-window flag, consumed once on first read.
    fresh_windows: Mutex<HashSet<String>>,
}

fn app_data_dir(app: &AppHandle) -> Option<PathBuf> {
    app_data::app_data_dir_opt(app)
}

fn windows_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join(WINDOWS_FILE))
}

fn workspace_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join(WORKSPACES_FILE))
}

fn profile_path(app: &AppHandle, profile_id: &str) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join(PROFILES_DIR).join(format!("{profile_id}.json")))
}

fn profile_index_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|dir| dir.join(PROFILES_DIR).join("index.json"))
}

fn known_profile_safe_ids(app: &AppHandle) -> HashMap<String, Option<String>> {
    let path = profile_index_path(app);
    known_profile_safe_ids_at(path.as_deref())
}

fn write_profile_snapshots_for_ids(
    app: &AppHandle,
    entries: &[WindowEntry],
    profile_ids: &HashSet<String>,
) {
    for profile_id in profile_ids {
        let windows = profile_windows(entries, profile_id);
        write_profile_snapshot(app, profile_id, &windows);
    }
}

fn normalize_entries_for_app(app: &AppHandle, entries: &mut Vec<WindowEntry>) -> bool {
    let mut affected_profile_ids =
        normalize_window_entry_profile_ids(entries, &known_profile_safe_ids(app));
    let (pruned_profile_ids, pruned_count) = prune_overlapping_profile_window_entries(entries);
    affected_profile_ids.extend(pruned_profile_ids);
    if affected_profile_ids.is_empty() {
        return false;
    }
    if pruned_count > 0 {
        debug_registry_log(
            app,
            format!("normalize pruned overlapping window entries count={pruned_count}"),
        );
    }
    persist_entries(app, entries);
    write_profile_snapshots_for_ids(app, entries, &affected_profile_ids);
    true
}

fn load_entries(app: &AppHandle) -> Vec<WindowEntry> {
    let Some(path) = windows_path(app) else {
        return Vec::new();
    };
    let mut entries = load_entries_at(&path);
    normalize_entries_for_app(app, &mut entries);
    entries
}

fn ensure_entries_ready(app: &AppHandle, entries: &mut Vec<WindowEntry>) {
    if entries.is_empty() {
        *entries = load_entries(app);
    } else {
        normalize_entries_for_app(app, entries);
    }
}

fn persist_entries(app: &AppHandle, entries: &[WindowEntry]) {
    if let Some(path) = windows_path(app) {
        persist_entries_at(&path, entries);
    }
}

fn read_global_workspace_snapshot(app: &AppHandle) -> WindowSnapshot {
    workspace_path(app)
        .map(|path| read_global_workspace_snapshot_at(&path))
        .unwrap_or_else(empty_snapshot)
}

fn write_global_workspace(app: &AppHandle, snapshot: &WindowSnapshot) {
    if let Some(path) = workspace_path(app) {
        write_global_workspace_at(&path, snapshot);
    }
}

fn read_profile_snapshot(app: &AppHandle, profile_id: &str) -> Vec<WindowSnapshot> {
    profile_path(app, profile_id)
        .map(|path| read_profile_snapshot_at(&path))
        .unwrap_or_default()
}

fn write_profile_snapshot(app: &AppHandle, profile_id: &str, windows: &[WindowSnapshot]) {
    if let Some(path) = profile_path(app, profile_id) {
        let name = profile_name(app, profile_id).unwrap_or_else(|| profile_id.to_string());
        write_profile_snapshot_at(&path, profile_id, &name, windows);
    }
}

fn profile_name(app: &AppHandle, profile_id: &str) -> Option<String> {
    read_profile_name_at(&profile_index_path(app)?, profile_id)
}

fn initial_entry_for_window(
    app: &AppHandle,
    entries: &[WindowEntry],
    window_id: &str,
) -> WindowEntry {
    let inferred_profile_id =
        infer_profile_id_from_window_id(window_id, &known_profile_safe_ids(app))
            .unwrap_or_else(|| DEFAULT_PROFILE_ID.into());
    let mut entry = WindowEntry {
        id: window_id.to_string(),
        profile_id: inferred_profile_id,
        snapshot: empty_snapshot(),
        detached_workspace_id: None,
        detached_parent_window_id: None,
        last_active_at: now_millis(),
    };
    if window_id != "main" {
        return entry;
    }

    let global_snapshot = read_global_workspace_snapshot(app);
    if snapshot_has_content(&global_snapshot) {
        entry.snapshot = global_snapshot;
        return entry;
    }

    if let Some(seed) = best_existing_profile_entry(entries) {
        entry.profile_id = seed.profile_id;
        entry.snapshot = seed.snapshot;
    }
    entry
}

pub fn ensure_entry(app: &AppHandle, window_id: &str) -> WindowEntry {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    if let Some(index) = entries.iter().position(|entry| entry.id == window_id) {
        let entry = entries[index].clone();
        if window_id != "main" || snapshot_has_content(&entry.snapshot) {
            return entry;
        }

        let seeded = initial_entry_for_window(app, &entries, window_id);
        if snapshot_has_content(&seeded.snapshot) {
            entries[index] = seeded.clone();
            persist_entries(app, &entries);
            write_global_workspace(app, &seeded.snapshot);
            let windows = profile_windows(&entries, &seeded.profile_id);
            write_profile_snapshot(app, &seeded.profile_id, &windows);
            return seeded;
        }

        return entry;
    }
    let entry = initial_entry_for_window(app, &entries, window_id);
    entries.push(entry.clone());
    persist_entries(app, &entries);
    if window_id == "main" && snapshot_has_content(&entry.snapshot) {
        write_global_workspace(app, &entry.snapshot);
        let windows = profile_windows(&entries, &entry.profile_id);
        write_profile_snapshot(app, &entry.profile_id, &windows);
    }
    entry
}

pub fn get_entry(app: &AppHandle, window_id: &str) -> WindowEntry {
    ensure_entry(app, window_id)
}

pub fn profile_id_for_window(app: &AppHandle, window_id: &str) -> Option<String> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .find(|entry| entry.id == window_id && entry.detached_workspace_id.is_none())
        .map(|entry| entry.profile_id.clone())
}

pub fn has_other_live_profile_windows(
    app: &AppHandle,
    profile_id: &str,
    current_window_id: &str,
) -> bool {
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries.iter().any(|entry| {
        entry.id != current_window_id
            && entry.profile_id == profile_id
            && entry.detached_workspace_id.is_none()
            && live_window_ids.contains(&entry.id)
    })
}

pub fn live_profile_window_count(app: &AppHandle, profile_id: &str) -> usize {
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .filter(|entry| {
            entry.profile_id == profile_id
                && entry.detached_workspace_id.is_none()
                && live_window_ids.contains(&entry.id)
        })
        .count()
}

pub fn window_bounds(app: &AppHandle, window_id: &str) -> Option<(f64, f64, f64, f64)> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .find(|entry| entry.id == window_id)
        .and_then(|entry| entry.snapshot.bounds.as_ref())
        .and_then(bounds_tuple)
}

pub fn update_window_bounds(
    app: &AppHandle,
    window_id: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    if width < 100.0 || height < 100.0 {
        return;
    }
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let Some(entry) = entries.iter_mut().find(|entry| entry.id == window_id) else {
        return;
    };
    entry.snapshot.bounds = Some(json!({
        "x": x,
        "y": y,
        "width": width,
        "height": height,
    }));
    entry.last_active_at = now_millis();
    let profile_id = entry.profile_id.clone();
    persist_entries(app, &entries);
    let windows = profile_windows(&entries, &profile_id);
    write_profile_snapshot(app, &profile_id, &windows);
}

pub fn mark_window_active(app: &AppHandle, window_id: &str) {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    if let Some(entry) = entries.iter_mut().find(|entry| entry.id == window_id) {
        entry.last_active_at = now_millis();
    } else {
        let entry = initial_entry_for_window(app, &entries, window_id);
        entries.push(entry);
    }
    persist_entries(app, &entries);
}

pub fn latest_live_window_id(app: &AppHandle) -> Option<String> {
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    latest_live_window_id_for_entries(&entries, &live_window_ids)
}

pub fn window_index(app: &AppHandle, window_id: &str) -> u32 {
    let entry = ensure_entry(app, window_id);
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let state = app.state::<WindowRegistryState>();
    let entries = state.entries.lock().unwrap();
    window_index_for_entries(&entries, &live_window_ids, &entry)
}

pub fn workspace_json(app: &AppHandle, window_id: &str) -> Option<String> {
    let entry = ensure_entry(app, window_id);
    serde_json::to_string_pretty(&workspace_value_from_snapshot(&entry.snapshot)).ok()
}

pub fn save_workspace_json(app: &AppHandle, window_id: &str, data: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        debug_registry_log(
            app,
            format!(
                "save ignored window={window_id} reason=parse-failed bytes={}",
                data.len()
            ),
        );
        return false;
    };
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    // Ignore saves from windows that no longer have a registry entry.
    // A "Remove from profile" close fires one last workspace.save while the
    // webview tears down — resurrecting the entry there would re-add the
    // window to the profile snapshot and the next launch would restore it.
    let Some(slot_index) = entries.iter().position(|entry| entry.id == window_id) else {
        debug_registry_log(
            app,
            format!(
                "save ignored window={window_id} reason=missing-registry-entry workspaces={} terminals={}",
                value.get("workspaces").map_or(0, value_array_len),
                value.get("terminals").map_or(0, value_array_len)
            ),
        );
        return false;
    };
    let mut entry = entries[slot_index].clone();
    entry.snapshot = snapshot_from_workspace_value(value);
    entry.last_active_at = now_millis();
    entries[slot_index] = entry.clone();
    persist_entries(app, &entries);
    if window_id == "main" {
        write_global_workspace(app, &entry.snapshot);
    }
    let windows = profile_windows(&entries, &entry.profile_id);
    write_profile_snapshot(app, &entry.profile_id, &windows);
    debug_registry_log(
        app,
        format!(
            "save wrote window={} profile={} profileWindows={} snapshotWorkspaces={} snapshotTerminals={}",
            window_id,
            entry.profile_id,
            windows.len(),
            value_array_len(&entry.snapshot.workspaces),
            value_array_len(&entry.snapshot.terminals)
        ),
    );
    true
}

pub fn load_profile_workspace_into_window(
    app: &AppHandle,
    window_id: &str,
    profile_id: &str,
    workspace: Value,
) -> bool {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let mut entry = entries
        .iter()
        .find(|entry| entry.id == window_id)
        .cloned()
        .unwrap_or_else(|| WindowEntry {
            id: window_id.to_string(),
            profile_id: profile_id.to_string(),
            snapshot: empty_snapshot(),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        });
    entry.profile_id = profile_id.to_string();
    entry.snapshot = snapshot_from_workspace_value(workspace);
    entry.detached_workspace_id = None;
    entry.detached_parent_window_id = None;
    entry.last_active_at = now_millis();
    if let Some(slot) = entries
        .iter_mut()
        .find(|candidate| candidate.id == window_id)
    {
        *slot = entry.clone();
    } else {
        entries.push(entry.clone());
    }
    persist_entries(app, &entries);
    if window_id == "main" {
        write_global_workspace(app, &entry.snapshot);
    }
    true
}

pub fn profile_workspace_from_existing_window(app: &AppHandle, profile_id: &str) -> Option<Value> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    latest_profile_workspace_value(&entries, profile_id)
}

// Window id whose snapshot `profile_workspace_from_existing_window` would serve,
// so a remote save can target the same window the matching load reads back.
// Keep the predicate in sync with `latest_profile_workspace_value`.
pub fn latest_profile_window_id(app: &AppHandle, profile_id: &str) -> Option<String> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .filter(|entry| {
            entry.profile_id == profile_id
                && entry.detached_workspace_id.is_none()
                && snapshot_has_content(&entry.snapshot)
        })
        .max_by_key(|entry| entry.last_active_at)
        .map(|entry| entry.id.clone())
}

pub fn move_workspace(
    app: &AppHandle,
    source_window_id: &str,
    target_window_id: &str,
    workspace_id: &str,
    insert_index: usize,
) -> Option<(String, String)> {
    if source_window_id == target_window_id {
        debug_registry_log(
            app,
            format!(
                "move workspace ignored reason=same-window source={} target={} workspace={}",
                source_window_id, target_window_id, workspace_id
            ),
        );
        return None;
    }
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);

    let Some(source_index) = entries
        .iter()
        .position(|entry| entry.id == source_window_id)
    else {
        debug_registry_log(
            app,
            format!(
                "move workspace failed reason=missing-source source={} target={} workspace={} entries={}",
                source_window_id,
                target_window_id,
                workspace_id,
                entries.len()
            ),
        );
        return None;
    };
    let Some(target_index) = entries
        .iter()
        .position(|entry| entry.id == target_window_id)
    else {
        debug_registry_log(
            app,
            format!(
                "move workspace failed reason=missing-target source={} target={} workspace={} entries={}",
                source_window_id,
                target_window_id,
                workspace_id,
                entries.len()
            ),
        );
        return None;
    };
    let mut source = entries[source_index].clone();
    let mut target = entries[target_index].clone();

    let source_profile_id = source.profile_id.clone();
    let target_profile_id = target.profile_id.clone();
    if !move_workspace_between_entries(&mut source, &mut target, workspace_id, insert_index) {
        debug_registry_log(
            app,
            format!(
                "move workspace failed reason=missing-workspace source={} target={} workspace={} sourceProfile={} targetProfile={} sourceWorkspaces={} targetWorkspaces={}",
                source_window_id,
                target_window_id,
                workspace_id,
                source_profile_id,
                target_profile_id,
                value_array_len(&source.snapshot.workspaces),
                value_array_len(&target.snapshot.workspaces)
            ),
        );
        return None;
    }

    source.last_active_at = now_millis();
    target.last_active_at = now_millis();
    entries[source_index] = source.clone();
    entries[target_index] = target.clone();

    persist_entries(app, &entries);
    if source_window_id == "main" {
        write_global_workspace(app, &source.snapshot);
    }
    if target_window_id == "main" {
        write_global_workspace(app, &target.snapshot);
    }
    let source_windows = profile_windows(&entries, &source_profile_id);
    write_profile_snapshot(app, &source_profile_id, &source_windows);
    if target_profile_id != source_profile_id {
        let target_windows = profile_windows(&entries, &target_profile_id);
        write_profile_snapshot(app, &target_profile_id, &target_windows);
    }
    debug_registry_log(
        app,
        format!(
            "move workspace wrote source={} target={} workspace={} sourceProfile={} targetProfile={} sourceWorkspaces={} targetWorkspaces={}",
            source_window_id,
            target_window_id,
            workspace_id,
            source_profile_id,
            target_profile_id,
            value_array_len(&source.snapshot.workspaces),
            value_array_len(&target.snapshot.workspaces)
        ),
    );

    let source_json =
        serde_json::to_string_pretty(&workspace_value_from_snapshot(&source.snapshot))
            .unwrap_or_else(|_| "{}".into());
    let target_json =
        serde_json::to_string_pretty(&workspace_value_from_snapshot(&target.snapshot))
            .unwrap_or_else(|_| "{}".into());
    Some((source_json, target_json))
}

pub fn detached_entry_for_workspace(app: &AppHandle, workspace_id: &str) -> Option<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .find(|entry| entry.detached_workspace_id.as_deref() == Some(workspace_id))
        .cloned()
}

pub fn create_detached_entry(
    app: &AppHandle,
    parent_window_id: &str,
    workspace_id: &str,
) -> Option<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    if let Some(entry) = entries
        .iter()
        .find(|entry| entry.detached_workspace_id.as_deref() == Some(workspace_id))
        .cloned()
    {
        return Some(entry);
    }
    let parent = entries
        .iter()
        .find(|entry| entry.id == parent_window_id)
        .cloned()
        .unwrap_or_else(|| WindowEntry {
            id: parent_window_id.to_string(),
            profile_id: DEFAULT_PROFILE_ID.into(),
            snapshot: if parent_window_id == "main" {
                read_global_workspace_snapshot(app)
            } else {
                empty_snapshot()
            },
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        });
    if !value_array(&parent.snapshot.workspaces)
        .iter()
        .any(|workspace| value_id(workspace) == Some(workspace_id))
    {
        return None;
    }
    let entry = WindowEntry {
        id: make_detached_window_id(workspace_id),
        profile_id: parent.profile_id,
        snapshot: parent.snapshot,
        detached_workspace_id: Some(workspace_id.to_string()),
        detached_parent_window_id: Some(parent_window_id.to_string()),
        last_active_at: now_millis(),
    };
    entries.push(entry.clone());
    Some(entry)
}

pub fn remove_detached_entry(app: &AppHandle, workspace_id: &str) -> Option<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let index = entries
        .iter()
        .position(|entry| entry.detached_workspace_id.as_deref() == Some(workspace_id))?;
    Some(entries.remove(index))
}

pub fn entries_for_profile(app: &AppHandle, profile_id: &str) -> Vec<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    entries
        .iter()
        .filter(|entry| entry.profile_id == profile_id && entry.detached_workspace_id.is_none())
        .cloned()
        .collect()
}

pub fn live_window_ids_for_profile(app: &AppHandle, profile_id: &str) -> Vec<String> {
    let live_window_ids = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    entries_for_profile(app, profile_id)
        .into_iter()
        .filter(|entry| live_window_ids.contains(&entry.id))
        .map(|entry| entry.id)
        .collect()
}

pub fn create_entries_for_profile(app: &AppHandle, profile_id: &str) -> Vec<WindowEntry> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let snapshots = {
        let loaded = read_profile_snapshot(app, profile_id);
        if !loaded.is_empty() {
            loaded
        } else {
            let existing = profile_windows(&entries, profile_id);
            if !existing.is_empty() {
                write_profile_snapshot(app, profile_id, &existing);
                existing
            } else {
                vec![empty_snapshot()]
            }
        }
    };
    remove_profile_window_entries(&mut entries, profile_id);
    let mut created = Vec::new();
    for (idx, snapshot) in snapshots.into_iter().enumerate() {
        let entry = WindowEntry {
            id: make_window_id(profile_id, idx + 1),
            profile_id: profile_id.to_string(),
            snapshot,
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        };
        entries.push(entry.clone());
        created.push(entry);
    }
    persist_entries(app, &entries);
    created
}

pub fn create_empty_entry_for_profile(app: &AppHandle, profile_id: &str) -> WindowEntry {
    let state = app.state::<WindowRegistryState>();
    let entry = {
        let mut entries = state.entries.lock().unwrap();
        ensure_entries_ready(app, &mut entries);
        let entry = WindowEntry {
            id: make_window_id(profile_id, entries.len() + 1),
            profile_id: profile_id.to_string(),
            snapshot: empty_snapshot(),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        };
        entries.push(entry.clone());
        persist_entries(app, &entries);
        entry
    };
    state.fresh_windows.lock().unwrap().insert(entry.id.clone());
    entry
}

pub fn create_empty_entry_with_id_for_profile(
    app: &AppHandle,
    window_id: &str,
    profile_id: &str,
) -> WindowEntry {
    let state = app.state::<WindowRegistryState>();
    let entry = {
        let mut entries = state.entries.lock().unwrap();
        ensure_entries_ready(app, &mut entries);
        let entry = WindowEntry {
            id: window_id.to_string(),
            profile_id: profile_id.to_string(),
            snapshot: empty_snapshot(),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: now_millis(),
        };
        if let Some(slot) = entries
            .iter_mut()
            .find(|candidate| candidate.id == window_id)
        {
            *slot = entry.clone();
        } else {
            entries.push(entry.clone());
        }
        persist_entries(app, &entries);
        entry
    };
    state.fresh_windows.lock().unwrap().insert(entry.id.clone());
    entry
}

pub fn take_fresh_window_flag(app: &AppHandle, window_id: &str) -> bool {
    let state = app.state::<WindowRegistryState>();
    let mut fresh = state.fresh_windows.lock().unwrap();
    fresh.remove(window_id)
}

pub fn remove_profile_window_entry(app: &AppHandle, window_id: &str) -> Option<String> {
    let state = app.state::<WindowRegistryState>();
    let mut entries = state.entries.lock().unwrap();
    ensure_entries_ready(app, &mut entries);
    let profile_id = remove_profile_window_entry_from_entries(&mut entries, window_id)?;
    persist_entries(app, &entries);
    let windows = profile_windows(&entries, &profile_id);
    write_profile_snapshot(app, &profile_id, &windows);
    Some(profile_id)
}
