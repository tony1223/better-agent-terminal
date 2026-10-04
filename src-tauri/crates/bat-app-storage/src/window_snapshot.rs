//! Workspace/window snapshots and their persistent formats, without window APIs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
pub const DEFAULT_PROFILE_ID: &str = "default";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    #[serde(default)]
    pub workspaces: Value,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub active_group: Option<String>,
    #[serde(default)]
    pub terminals: Value,
    #[serde(default)]
    pub active_terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    pub id: String,
    pub profile_id: String,
    #[serde(flatten)]
    pub snapshot: WindowSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached_parent_window_id: Option<String>,
    pub last_active_at: i64,
}

pub fn value_array_len(value: &Value) -> usize {
    value.as_array().map_or(0, Vec::len)
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub fn empty_snapshot() -> WindowSnapshot {
    WindowSnapshot {
        workspaces: json!([]),
        active_workspace_id: None,
        active_group: None,
        terminals: json!([]),
        active_terminal_id: None,
        bounds: None,
    }
}

pub fn workspace_value_from_snapshot(snapshot: &WindowSnapshot) -> Value {
    json!({
        "workspaces": snapshot.workspaces,
        "activeWorkspaceId": snapshot.active_workspace_id,
        "activeGroup": snapshot.active_group,
        "terminals": snapshot.terminals,
        "activeTerminalId": snapshot.active_terminal_id,
    })
}

pub fn value_array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

pub fn value_id(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

pub fn value_workspace_id(value: &Value) -> Option<&str> {
    value.get("workspaceId").and_then(Value::as_str)
}

pub fn snapshot_from_workspace_value(value: Value) -> WindowSnapshot {
    WindowSnapshot {
        workspaces: value
            .get("workspaces")
            .cloned()
            .unwrap_or_else(|| json!([])),
        active_workspace_id: value
            .get("activeWorkspaceId")
            .and_then(Value::as_str)
            .map(str::to_string),
        active_group: value
            .get("activeGroup")
            .and_then(Value::as_str)
            .map(str::to_string),
        terminals: value.get("terminals").cloned().unwrap_or_else(|| json!([])),
        active_terminal_id: value
            .get("activeTerminalId")
            .and_then(Value::as_str)
            .map(str::to_string),
        bounds: None,
    }
}

pub fn move_workspace_between_entries(
    source: &mut WindowEntry,
    target: &mut WindowEntry,
    workspace_id: &str,
    insert_index: usize,
) -> bool {
    let mut source_workspaces = value_array(&source.snapshot.workspaces);
    let Some(workspace_index) = source_workspaces
        .iter()
        .position(|workspace| value_id(workspace) == Some(workspace_id))
    else {
        return false;
    };
    let workspace = source_workspaces.remove(workspace_index);

    let mut moved_terminals = Vec::new();
    let mut remaining_terminals = Vec::new();
    for terminal in value_array(&source.snapshot.terminals) {
        if value_workspace_id(&terminal) == Some(workspace_id) {
            moved_terminals.push(terminal);
        } else {
            remaining_terminals.push(terminal);
        }
    }

    let moved_terminal_ids = moved_terminals
        .iter()
        .filter_map(value_id)
        .map(str::to_string)
        .collect::<HashSet<_>>();

    let mut target_workspaces = value_array(&target.snapshot.workspaces);
    let clamped_index = insert_index.min(target_workspaces.len());
    target_workspaces.insert(clamped_index, workspace.clone());

    let mut target_terminals = value_array(&target.snapshot.terminals);
    target_terminals.extend(moved_terminals.iter().cloned());

    if source.snapshot.active_workspace_id.as_deref() == Some(workspace_id) {
        source.snapshot.active_workspace_id = source_workspaces
            .first()
            .and_then(value_id)
            .map(str::to_string);
    }
    target.snapshot.active_workspace_id = Some(workspace_id.to_string());

    if source
        .snapshot
        .active_terminal_id
        .as_ref()
        .is_some_and(|terminal_id| moved_terminal_ids.contains(terminal_id))
    {
        source.snapshot.active_terminal_id = source
            .snapshot
            .active_workspace_id
            .as_deref()
            .and_then(|active_workspace_id| {
                remaining_terminals
                    .iter()
                    .find(|terminal| value_workspace_id(terminal) == Some(active_workspace_id))
                    .and_then(value_id)
                    .map(str::to_string)
            });
    }
    target.snapshot.active_terminal_id = workspace
        .get("focusedTerminalId")
        .and_then(Value::as_str)
        .filter(|terminal_id| moved_terminal_ids.contains(*terminal_id))
        .map(str::to_string)
        .or_else(|| {
            moved_terminals
                .first()
                .and_then(value_id)
                .map(str::to_string)
        });

    source.snapshot.workspaces = json!(source_workspaces);
    source.snapshot.terminals = json!(remaining_terminals);
    target.snapshot.workspaces = json!(target_workspaces);
    target.snapshot.terminals = json!(target_terminals);
    true
}

pub fn safe_profile_id(profile_id: &str) -> String {
    profile_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

pub fn profile_safe_id_map(
    profile_ids: impl IntoIterator<Item = String>,
) -> HashMap<String, Option<String>> {
    let mut map = HashMap::new();
    for profile_id in profile_ids {
        let safe = safe_profile_id(&profile_id);
        map.entry(safe)
            .and_modify(|existing: &mut Option<String>| {
                if existing.as_deref() != Some(profile_id.as_str()) {
                    *existing = None;
                }
            })
            .or_insert(Some(profile_id));
    }
    map
}

pub fn infer_profile_id_from_window_id(
    window_id: &str,
    profile_safe_ids: &HashMap<String, Option<String>>,
) -> Option<String> {
    let suffix = window_id.strip_prefix("profile-")?;
    profile_safe_ids
        .iter()
        .filter_map(|(safe, profile_id)| {
            let profile_id = profile_id.as_ref()?;
            if safe.is_empty() {
                return None;
            }
            if suffix == safe || suffix.starts_with(&format!("{safe}-")) {
                Some((safe.len(), profile_id.clone()))
            } else {
                None
            }
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, profile_id)| profile_id)
}

pub fn normalize_window_entry_profile_ids(
    entries: &mut [WindowEntry],
    profile_safe_ids: &HashMap<String, Option<String>>,
) -> HashSet<String> {
    let mut affected_profile_ids = HashSet::new();
    for entry in entries {
        if entry.detached_workspace_id.is_some() {
            continue;
        }
        let Some(profile_id) = infer_profile_id_from_window_id(&entry.id, profile_safe_ids) else {
            continue;
        };
        if entry.profile_id != profile_id {
            affected_profile_ids.insert(entry.profile_id.clone());
            affected_profile_ids.insert(profile_id.clone());
            entry.profile_id = profile_id;
        }
    }
    affected_profile_ids
}

pub fn prune_overlapping_profile_window_entries(
    entries: &mut Vec<WindowEntry>,
) -> (HashSet<String>, usize) {
    let mut keep = vec![true; entries.len()];
    let mut sorted_indices = (0..entries.len()).collect::<Vec<_>>();
    sorted_indices.sort_by(|a, b| entries[*b].last_active_at.cmp(&entries[*a].last_active_at));

    let mut seen_terminal_ids_by_profile: HashMap<String, HashSet<String>> = HashMap::new();
    let mut affected_profile_ids = HashSet::new();
    let mut removed_count = 0;

    for index in sorted_indices {
        let entry = &entries[index];
        if entry.detached_workspace_id.is_some() || !snapshot_has_content(&entry.snapshot) {
            continue;
        }
        let terminal_ids = snapshot_terminal_ids(&entry.snapshot);
        if terminal_ids.is_empty() {
            continue;
        }
        let seen = seen_terminal_ids_by_profile
            .entry(entry.profile_id.clone())
            .or_default();
        if terminal_ids.iter().any(|id| seen.contains(id)) {
            keep[index] = false;
            removed_count += 1;
            affected_profile_ids.insert(entry.profile_id.clone());
            continue;
        }
        seen.extend(terminal_ids);
    }

    if removed_count > 0 {
        let mut index = 0;
        entries.retain(|_| {
            let should_keep = keep[index];
            index += 1;
            should_keep
        });
    }

    (affected_profile_ids, removed_count)
}

pub fn profile_windows(entries: &[WindowEntry], profile_id: &str) -> Vec<WindowSnapshot> {
    let mut matching = entries
        .iter()
        .filter(|entry| {
            entry.profile_id == profile_id
                && entry.detached_workspace_id.is_none()
                && snapshot_has_content(&entry.snapshot)
        })
        .collect::<Vec<_>>();
    // Stale duplicate window entries can survive crashes or old profile bugs.
    // When snapshots overlap by terminal ids, keep the most recently active
    // entry so a fresh save cannot be overwritten by an older duplicate.
    matching.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    let snapshots = matching
        .into_iter()
        .map(|entry| entry.snapshot.clone())
        .collect();
    dedupe_snapshots_by_terminal_ids(snapshots)
}

pub fn latest_profile_workspace_value(entries: &[WindowEntry], profile_id: &str) -> Option<Value> {
    entries
        .iter()
        .filter(|entry| {
            entry.profile_id == profile_id
                && entry.detached_workspace_id.is_none()
                && snapshot_has_content(&entry.snapshot)
        })
        .max_by_key(|entry| entry.last_active_at)
        .map(|entry| workspace_value_from_snapshot(&entry.snapshot))
}

pub fn snapshot_has_content(snapshot: &WindowSnapshot) -> bool {
    !value_array(&snapshot.workspaces).is_empty()
        || !value_array(&snapshot.terminals).is_empty()
        || snapshot.active_workspace_id.is_some()
        || snapshot.active_terminal_id.is_some()
        || snapshot.active_group.is_some()
}

pub fn snapshot_terminal_ids(snapshot: &WindowSnapshot) -> HashSet<String> {
    value_array(&snapshot.terminals)
        .into_iter()
        .filter_map(|terminal| value_id(&terminal).map(str::to_string))
        .collect()
}

pub fn dedupe_snapshots_by_terminal_ids(snapshots: Vec<WindowSnapshot>) -> Vec<WindowSnapshot> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for snapshot in snapshots {
        let terminal_ids = snapshot_terminal_ids(&snapshot);
        if !terminal_ids.is_empty() && terminal_ids.iter().any(|id| seen.contains(id)) {
            continue;
        }
        seen.extend(terminal_ids);
        deduped.push(snapshot);
    }
    deduped
}

pub fn best_existing_profile_entry(entries: &[WindowEntry]) -> Option<WindowEntry> {
    entries
        .iter()
        .filter(|entry| {
            entry.detached_workspace_id.is_none() && snapshot_has_content(&entry.snapshot)
        })
        .max_by_key(|entry| entry.last_active_at)
        .cloned()
}

pub fn bounds_tuple(value: &Value) -> Option<(f64, f64, f64, f64)> {
    Some((
        value.get("x")?.as_f64()?,
        value.get("y")?.as_f64()?,
        value.get("width")?.as_f64()?,
        value.get("height")?.as_f64()?,
    ))
    .filter(|(_, _, width, height)| *width >= 100.0 && *height >= 100.0)
}

pub fn remove_profile_window_entries(entries: &mut Vec<WindowEntry>, profile_id: &str) {
    let safe_ids = profile_safe_id_map([profile_id.to_string()]);
    entries.retain(|entry| {
        if entry.detached_workspace_id.is_some() {
            return true;
        }
        if entry.profile_id == profile_id {
            return false;
        }
        infer_profile_id_from_window_id(&entry.id, &safe_ids).as_deref() != Some(profile_id)
    });
}

pub fn remove_profile_window_entry_from_entries(
    entries: &mut Vec<WindowEntry>,
    window_id: &str,
) -> Option<String> {
    let index = entries
        .iter()
        .position(|entry| entry.id == window_id && entry.detached_workspace_id.is_none())?;
    Some(entries.remove(index).profile_id)
}

pub fn make_window_id(profile_id: &str, index: usize) -> String {
    let safe = safe_profile_id(profile_id);
    format!("profile-{safe}-{}-{index}", now_millis())
}

pub fn make_detached_window_id(workspace_id: &str) -> String {
    let safe = workspace_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    format!("detached-{safe}-{}", now_millis())
}

pub fn latest_live_window_id_for_entries(
    entries: &[WindowEntry],
    live_window_ids: &HashSet<String>,
) -> Option<String> {
    entries
        .iter()
        .filter(|entry| live_window_ids.contains(&entry.id))
        .max_by_key(|entry| entry.last_active_at)
        .map(|entry| entry.id.clone())
}

pub fn window_index_for_entries(
    entries: &[WindowEntry],
    live_window_ids: &HashSet<String>,
    entry: &WindowEntry,
) -> u32 {
    entries
        .iter()
        .filter(|candidate| {
            candidate.profile_id == entry.profile_id
                && candidate.detached_workspace_id.is_none()
                && live_window_ids.contains(&candidate.id)
        })
        .position(|candidate| candidate.id == entry.id)
        .map(|idx| idx as u32 + 1)
        .unwrap_or_else(|| {
            entries
                .iter()
                .filter(|candidate| {
                    candidate.profile_id == entry.profile_id
                        && candidate.detached_workspace_id.is_none()
                })
                .position(|candidate| candidate.id == entry.id)
                .map(|idx| idx as u32 + 1)
                .unwrap_or(1)
        })
}
pub fn load_entries_at(path: &Path) -> Vec<WindowEntry> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn known_profile_safe_ids_at(path: Option<&Path>) -> HashMap<String, Option<String>> {
    let profile_ids = path
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| {
            value.get("profiles")?.as_array().map(|profiles| {
                profiles
                    .iter()
                    .filter_map(|profile| profile.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
        })
        .filter(|profile_ids| !profile_ids.is_empty())
        .unwrap_or_else(|| vec![DEFAULT_PROFILE_ID.into()]);
    profile_safe_id_map(profile_ids)
}

pub fn persist_entries_at(path: &Path, entries: &[WindowEntry]) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let persistent = entries
        .iter()
        .filter(|entry| entry.detached_workspace_id.is_none())
        .collect::<Vec<_>>();
    let _ = fs::write(
        path,
        serde_json::to_string_pretty(&persistent).unwrap_or_else(|_| "[]".into()),
    );
}

pub fn read_global_workspace_snapshot_at(path: &Path) -> WindowSnapshot {
    Some(path)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(snapshot_from_workspace_value)
        .unwrap_or_else(empty_snapshot)
}

pub fn write_global_workspace_at(path: &Path, snapshot: &WindowSnapshot) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        path,
        serde_json::to_string_pretty(&workspace_value_from_snapshot(snapshot))
            .unwrap_or_else(|_| "{}".into()),
    );
}

pub fn read_profile_snapshot_at(path: &Path) -> Vec<WindowSnapshot> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    if value.get("version").and_then(Value::as_i64) == Some(1) {
        let snapshot = snapshot_from_workspace_value(value);
        return if snapshot_has_content(&snapshot) {
            vec![snapshot]
        } else {
            Vec::new()
        };
    }
    let snapshots = value
        .get("windows")
        .and_then(Value::as_array)
        .map(|windows| {
            windows
                .iter()
                .cloned()
                .map(snapshot_from_workspace_value)
                .filter(snapshot_has_content)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    dedupe_snapshots_by_terminal_ids(snapshots)
}

pub fn write_profile_snapshot_at(
    path: &Path,
    profile_id: &str,
    name: &str,
    windows: &[WindowSnapshot],
) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let windows = dedupe_snapshots_by_terminal_ids(windows.to_vec());
    let payload = json!({
        "id": profile_id,
        "name": name,
        "version": 2,
        "windows": windows,
    });
    let _ = fs::write(
        path,
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".into()),
    );
}

pub fn read_profile_name_at(path: &Path, profile_id: &str) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    value
        .get("profiles")?
        .as_array()?
        .iter()
        .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
        .and_then(|profile| profile.get("name").and_then(Value::as_str))
        .map(str::to_string)
}
/// Legacy workspace payloads remain opaque text to the host IPC.
pub fn read_workspace_text_at(path: &Path) -> io::Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some)
}
pub fn write_workspace_text_at(path: &Path, data: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, data)
}
#[cfg(test)]
mod tests {
    use super::*;

    struct TempStore(std::path::PathBuf);

    impl TempStore {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "bat-window-store-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            )))
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn registry_persistence_excludes_detached_windows() {
        let store = TempStore::new();
        let path = store.0.join("windows.json");
        let regular = WindowEntry {
            id: "main".into(),
            profile_id: "default".into(),
            snapshot: snapshot_from_workspace_value(
                json!({"workspaces": [{"id": "w1"}], "terminals": [{"id": "t1", "workspaceId": "w1"}]}),
            ),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: 123,
        };
        let detached = WindowEntry {
            id: "detached-w1".into(),
            detached_workspace_id: Some("w1".into()),
            detached_parent_window_id: Some("main".into()),
            ..regular.clone()
        };
        persist_entries_at(&path, &[regular, detached]);
        let entries = load_entries_at(&path);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "main");
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw[0]["profileId"], "default");
        assert_eq!(raw[0]["lastActiveAt"], 123);
        assert_eq!(raw[0]["terminals"][0]["id"], "t1");
        assert!(
            raw[0].get("snapshot").is_none(),
            "snapshot fields remain flattened"
        );
    }

    #[test]
    fn profile_snapshot_storage_preserves_migration_and_deduplication() {
        let store = TempStore::new();
        let path = store.0.join("profiles/default.json");
        assert!(read_profile_snapshot_at(&path).is_empty());
        write_workspace_text_at(&path, r#"{"version":1,"workspaces":[{"id":"w1"}],"terminals":[{"id":"t1"}],"activeWorkspaceId":"w1"}"#).unwrap();
        let migrated = read_profile_snapshot_at(&path);
        assert_eq!(migrated.len(), 1);
        assert_eq!(migrated[0].active_workspace_id.as_deref(), Some("w1"));
        write_profile_snapshot_at(
            &path,
            "default",
            "My profile",
            &[migrated[0].clone(), migrated[0].clone()],
        );
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["version"], 2);
        assert_eq!(raw["id"], "default");
        assert_eq!(raw["name"], "My profile");
        assert_eq!(raw["windows"].as_array().unwrap().len(), 1);
        assert_eq!(read_profile_snapshot_at(&path).len(), 1);
        fs::write(&path, "invalid JSON").unwrap();
        assert!(read_profile_snapshot_at(&path).is_empty());
    }

    #[test]
    fn legacy_workspace_text_roundtrips_and_reports_io_failure() {
        let store = TempStore::new();
        let path = store.0.join("workspaces.json");
        assert_eq!(read_workspace_text_at(&path).unwrap(), None);
        let raw = "  {\"custom\":[1,2]}\n";
        write_workspace_text_at(&path, raw).unwrap();
        assert_eq!(read_workspace_text_at(&path).unwrap().as_deref(), Some(raw));
        let blocked = store.0.join("blocked");
        fs::write(&blocked, "file").unwrap();
        assert!(write_workspace_text_at(&blocked.join("workspaces.json"), raw).is_err());
    }

    #[test]
    fn workspace_snapshot_round_trips_shape() {
        let snapshot = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "w1"}],
            "activeWorkspaceId": "w1",
            "activeGroup": "g1",
            "terminals": [{"id": "t1"}],
            "activeTerminalId": "t1",
        }));
        let value = workspace_value_from_snapshot(&snapshot);
        assert_eq!(value["workspaces"][0]["id"], "w1");
        assert_eq!(value["activeWorkspaceId"], "w1");
        assert_eq!(value["terminals"][0]["id"], "t1");
    }

    #[test]
    fn window_ids_are_profile_scoped() {
        let id = make_window_id("my profile", 1);
        assert!(id.starts_with("profile-my-profile-"));
        assert!(id.ends_with("-1"));
    }

    #[test]
    fn infers_profile_id_from_profile_window_id() {
        let safe_ids = profile_safe_id_map(vec![
            "default".into(),
            "bat".into(),
            "hyper".into(),
            "tonyq.org".into(),
        ]);

        assert_eq!(
            infer_profile_id_from_window_id("profile-bat-1779344644785-23", &safe_ids).as_deref(),
            Some("bat")
        );
        assert_eq!(
            infer_profile_id_from_window_id("profile-hyper-1778574296888-2", &safe_ids).as_deref(),
            Some("hyper")
        );
        assert_eq!(
            infer_profile_id_from_window_id("profile-tonyq-org-1778574296888-1", &safe_ids)
                .as_deref(),
            Some("tonyq.org")
        );
        assert_eq!(
            infer_profile_id_from_window_id("main", &safe_ids).as_deref(),
            None
        );
    }

    #[test]
    fn ambiguous_safe_profile_ids_are_not_inferred() {
        let safe_ids = profile_safe_id_map(vec!["a/b".into(), "a:b".into()]);

        assert_eq!(
            infer_profile_id_from_window_id("profile-a-b-1779344644785-1", &safe_ids).as_deref(),
            None
        );
    }

    #[test]
    fn normalize_window_entry_profile_ids_repairs_migrated_profile_mismatch() {
        let safe_ids = profile_safe_id_map(vec!["default".into(), "bat".into()]);
        let mut entries = vec![
            WindowEntry {
                id: "main".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-bat-1779344644785-23".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-bat-detached".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: Some("w1".into()),
                detached_parent_window_id: Some("profile-bat-1779344644785-23".into()),
                last_active_at: 0,
            },
        ];

        let affected = normalize_window_entry_profile_ids(&mut entries, &safe_ids);
        assert!(affected.contains("default"));
        assert!(affected.contains("bat"));
        assert_eq!(entries[0].profile_id, "default");
        assert_eq!(entries[1].profile_id, "bat");
        assert_eq!(entries[2].profile_id, "default");
    }

    #[test]
    fn prune_overlapping_profile_window_entries_removes_stale_duplicates() {
        let old = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "old"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let recent = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "recent"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let other_profile = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "other-profile"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let unrelated = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "unrelated"}],
            "terminals": [{"id": "t3"}],
        }));
        let mut entries = vec![
            WindowEntry {
                id: "old".into(),
                profile_id: "default".into(),
                snapshot: old,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 10,
            },
            WindowEntry {
                id: "recent".into(),
                profile_id: "default".into(),
                snapshot: recent,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 20,
            },
            WindowEntry {
                id: "other-profile".into(),
                profile_id: "other".into(),
                snapshot: other_profile,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 5,
            },
            WindowEntry {
                id: "unrelated".into(),
                profile_id: "default".into(),
                snapshot: unrelated,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 1,
            },
        ];

        let (affected, removed_count) = prune_overlapping_profile_window_entries(&mut entries);
        let ids = entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(removed_count, 1);
        assert!(affected.contains("default"));
        assert_eq!(ids, vec!["recent", "other-profile", "unrelated"]);
    }

    #[test]
    fn bounds_tuple_rejects_missing_or_tiny_bounds() {
        assert_eq!(
            bounds_tuple(&json!({"x": 10, "y": 20, "width": 1200, "height": 800})),
            Some((10.0, 20.0, 1200.0, 800.0))
        );
        assert_eq!(
            bounds_tuple(&json!({"x": 10, "y": 20, "width": 80, "height": 800})),
            None
        );
        assert_eq!(bounds_tuple(&json!({"x": 10, "width": 1200})), None);
    }

    #[test]
    fn remove_profile_window_entries_keeps_other_profiles_and_detached_entries() {
        let mut entries = vec![
            WindowEntry {
                id: "profile-a-1".into(),
                profile_id: "a".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "detached-a".into(),
                profile_id: "a".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: Some("w1".into()),
                detached_parent_window_id: Some("profile-a-1".into()),
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-b-1".into(),
                profile_id: "b".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
        ];

        remove_profile_window_entries(&mut entries, "a");

        let ids = entries
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["detached-a", "profile-b-1"]);
    }

    #[test]
    fn remove_profile_window_entry_removes_one_regular_window() {
        let mut entries = vec![
            WindowEntry {
                id: "w1".into(),
                profile_id: "a".into(),
                snapshot: snapshot_from_workspace_value(json!({
                    "workspaces": [{"id": "ws1"}],
                    "terminals": [{"id": "t1", "workspaceId": "ws1"}],
                })),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 1,
            },
            WindowEntry {
                id: "w2".into(),
                profile_id: "a".into(),
                snapshot: snapshot_from_workspace_value(json!({
                    "workspaces": [{"id": "ws2"}],
                    "terminals": [{"id": "t2", "workspaceId": "ws2"}],
                })),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 2,
            },
            WindowEntry {
                id: "d1".into(),
                profile_id: "a".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: Some("ws-detached".into()),
                detached_parent_window_id: Some("w1".into()),
                last_active_at: 3,
            },
        ];

        assert_eq!(
            remove_profile_window_entry_from_entries(&mut entries, "w1").as_deref(),
            Some("a")
        );
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["w2", "d1"]
        );
        assert_eq!(profile_windows(&entries, "a").len(), 1);
    }

    #[test]
    fn profile_windows_ignores_empty_snapshots() {
        let mut filled = empty_snapshot();
        filled.workspaces = json!([{"id": "w1"}]);
        let entries = vec![
            WindowEntry {
                id: "main".into(),
                profile_id: "default".into(),
                snapshot: filled,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-default-stale".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
        ];

        assert_eq!(profile_windows(&entries, "default").len(), 1);
    }

    #[test]
    fn profile_windows_dedupes_overlapping_terminal_snapshots() {
        let first = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "w1"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let duplicate = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "w1-copy"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let second = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "w2"}],
            "terminals": [{"id": "t3"}],
        }));
        let entries = vec![
            WindowEntry {
                id: "first".into(),
                profile_id: "default".into(),
                snapshot: first,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "duplicate".into(),
                profile_id: "default".into(),
                snapshot: duplicate,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "second".into(),
                profile_id: "default".into(),
                snapshot: second,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
        ];

        let windows = profile_windows(&entries, "default");
        assert_eq!(windows.len(), 2);
        assert_eq!(
            value_id(&value_array(&windows[0].workspaces)[0]),
            Some("w1")
        );
        assert_eq!(
            value_id(&value_array(&windows[1].workspaces)[0]),
            Some("w2")
        );
    }

    #[test]
    fn profile_windows_dedupes_overlapping_terminal_snapshots_by_recency() {
        let old = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "old"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let recent = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "recent"}],
            "terminals": [{"id": "t1"}, {"id": "t2"}],
        }));
        let entries = vec![
            WindowEntry {
                id: "old".into(),
                profile_id: "default".into(),
                snapshot: old,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 10,
            },
            WindowEntry {
                id: "recent".into(),
                profile_id: "default".into(),
                snapshot: recent,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 20,
            },
        ];

        let windows = profile_windows(&entries, "default");
        assert_eq!(windows.len(), 1);
        assert_eq!(
            value_id(&value_array(&windows[0].workspaces)[0]),
            Some("recent")
        );
    }

    #[test]
    fn latest_profile_workspace_value_uses_matching_recent_non_empty_window() {
        let older = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "older"}],
            "activeWorkspaceId": "older",
            "terminals": [{"id": "old-term", "workspaceId": "older"}],
            "activeTerminalId": "old-term",
        }));
        let latest = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "latest"}],
            "activeWorkspaceId": "latest",
            "terminals": [{"id": "new-term", "workspaceId": "latest"}],
            "activeTerminalId": "new-term",
        }));
        let other_profile = snapshot_from_workspace_value(json!({
            "workspaces": [{"id": "other"}],
            "terminals": [{"id": "other-term", "workspaceId": "other"}],
        }));
        let entries = vec![
            WindowEntry {
                id: "older".into(),
                profile_id: "n".into(),
                snapshot: older,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 100,
            },
            WindowEntry {
                id: "latest-detached".into(),
                profile_id: "n".into(),
                snapshot: snapshot_from_workspace_value(
                    json!({"workspaces": [{"id": "detached"}]}),
                ),
                detached_workspace_id: Some("detached".into()),
                detached_parent_window_id: Some("older".into()),
                last_active_at: 300,
            },
            WindowEntry {
                id: "other".into(),
                profile_id: "default".into(),
                snapshot: other_profile,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 400,
            },
            WindowEntry {
                id: "latest".into(),
                profile_id: "n".into(),
                snapshot: latest,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 200,
            },
        ];

        let workspace = latest_profile_workspace_value(&entries, "n").unwrap();
        assert_eq!(
            workspace.get("activeWorkspaceId").and_then(Value::as_str),
            Some("latest")
        );
        assert_eq!(
            workspace.get("activeTerminalId").and_then(Value::as_str),
            Some("new-term")
        );
    }

    #[test]
    fn best_existing_profile_entry_uses_latest_non_empty_regular_window() {
        let mut older = empty_snapshot();
        older.workspaces = json!([{"id": "older"}]);
        let mut latest_detached = empty_snapshot();
        latest_detached.workspaces = json!([{"id": "detached"}]);
        let mut latest = empty_snapshot();
        latest.workspaces = json!([{"id": "latest"}]);
        let entries = vec![
            WindowEntry {
                id: "empty".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 100,
            },
            WindowEntry {
                id: "older".into(),
                profile_id: "default".into(),
                snapshot: older,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 200,
            },
            WindowEntry {
                id: "detached".into(),
                profile_id: "default".into(),
                snapshot: latest_detached,
                detached_workspace_id: Some("w-detached".into()),
                detached_parent_window_id: Some("older".into()),
                last_active_at: 400,
            },
            WindowEntry {
                id: "latest".into(),
                profile_id: "lineage".into(),
                snapshot: latest,
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 300,
            },
        ];

        let entry = best_existing_profile_entry(&entries).unwrap();
        assert_eq!(entry.id, "latest");
        assert_eq!(entry.profile_id, "lineage");
    }

    #[test]
    fn window_index_counts_only_live_profile_windows() {
        let entries = vec![
            WindowEntry {
                id: "main".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-default-stale".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
            WindowEntry {
                id: "profile-default-live".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 0,
            },
        ];
        let live_window_ids = ["main".to_string(), "profile-default-live".to_string()]
            .into_iter()
            .collect::<HashSet<_>>();

        assert_eq!(
            window_index_for_entries(&entries, &live_window_ids, &entries[2]),
            2
        );
    }

    #[test]
    fn latest_live_window_id_uses_most_recent_live_entry() {
        let entries = vec![
            WindowEntry {
                id: "main".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 100,
            },
            WindowEntry {
                id: "profile-default-live".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 300,
            },
            WindowEntry {
                id: "profile-default-stale".into(),
                profile_id: "default".into(),
                snapshot: empty_snapshot(),
                detached_workspace_id: None,
                detached_parent_window_id: None,
                last_active_at: 900,
            },
        ];
        let live_window_ids = ["main".to_string(), "profile-default-live".to_string()]
            .into_iter()
            .collect::<HashSet<_>>();

        assert_eq!(
            latest_live_window_id_for_entries(&entries, &live_window_ids).as_deref(),
            Some("profile-default-live")
        );
    }

    #[test]
    fn move_workspace_between_entries_moves_workspace_and_terminals() {
        let mut source = WindowEntry {
            id: "source".into(),
            profile_id: "default".into(),
            snapshot: snapshot_from_workspace_value(json!({
                "workspaces": [
                    {"id": "w1", "focusedTerminalId": "t1"},
                    {"id": "w2", "focusedTerminalId": "t3"}
                ],
                "activeWorkspaceId": "w1",
                "terminals": [
                    {"id": "t1", "workspaceId": "w1"},
                    {"id": "t2", "workspaceId": "w1"},
                    {"id": "t3", "workspaceId": "w2"}
                ],
                "activeTerminalId": "t1"
            })),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: 0,
        };
        let mut target = WindowEntry {
            id: "target".into(),
            profile_id: "default".into(),
            snapshot: snapshot_from_workspace_value(json!({
                "workspaces": [{"id": "w3"}],
                "activeWorkspaceId": "w3",
                "terminals": [{"id": "t4", "workspaceId": "w3"}],
                "activeTerminalId": "t4"
            })),
            detached_workspace_id: None,
            detached_parent_window_id: None,
            last_active_at: 0,
        };

        assert!(move_workspace_between_entries(
            &mut source,
            &mut target,
            "w1",
            0
        ));

        assert_eq!(source.snapshot.workspaces[0]["id"], "w2");
        assert_eq!(source.snapshot.active_workspace_id.as_deref(), Some("w2"));
        assert_eq!(source.snapshot.active_terminal_id.as_deref(), Some("t3"));
        assert_eq!(source.snapshot.terminals.as_array().unwrap().len(), 1);
        assert_eq!(target.snapshot.workspaces[0]["id"], "w1");
        assert_eq!(target.snapshot.workspaces[1]["id"], "w3");
        assert_eq!(target.snapshot.active_workspace_id.as_deref(), Some("w1"));
        assert_eq!(target.snapshot.active_terminal_id.as_deref(), Some("t1"));
        assert_eq!(target.snapshot.terminals.as_array().unwrap().len(), 3);
    }
}
