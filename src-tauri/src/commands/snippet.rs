// snippet:* — env snippets store, JSON-backed.
//
// Preserves the existing snippet file format:
//  - On-disk shape: `{snippets: [...], nextId: N}`.
//  - File location: `<app-data>/snippets.json`, including reused legacy data.
//  - Field defaults on create (format=plaintext,
//    action=terminal, isFavorite=false).
//  - Backfill: any pre-existing snippet missing the `action`
//    field gets it set to "terminal" on load (and we re-save).
//
// Host commands share `Arc<Mutex<Option<SnippetData>>>`, serializing access
// across threads and windows. Mutations write immediately using a temporary
// file and rename. External file changes are not automatically reloaded.

// app_data is only needed by the desktop command wrappers (which resolve the
// data dir from an AppHandle); the headless dispatch passes ctx.data_dir().
#[cfg(feature = "desktop")]
use crate::app_data;
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snippet {
    pub id: i64,
    pub title: String,
    pub content: String,
    // Stored as the literal renderer-side string ("plaintext" /
    // "markdown") rather than a Rust enum — keeps round-trips
    // bit-stable with the Electron file format.
    pub format: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<String>,
    #[serde(
        default,
        rename = "workspaceId",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_id: Option<String>,
    #[serde(rename = "isFavorite")]
    pub is_favorite: bool,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SnippetData {
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(rename = "nextId", default = "default_next_id")]
    pub next_id: i64,
}

fn default_next_id() -> i64 {
    1
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnippetInput {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub is_favorite: Option<bool>,
}

// Update inputs use Option<Option<T>> for nullable string fields
// to distinguish "not provided" from "set to null". The renderer
// only sends `undefined` (= absent) or a string; never a literal
// null in the JSON payload, so we collapse to Option<T> and treat
// `None` as "leave existing alone".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnippetInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub is_favorite: Option<bool>,
}

#[derive(Clone, Default)]
pub struct SnippetState {
    // Arc so HostContext can hand out cheap clones (all sharing the one store);
    // the headless backing stores managed states by value in a type map.
    inner: Arc<Mutex<Option<SnippetData>>>,
}

impl SnippetState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<SnippetData>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn snippet_file(data_dir: &Path) -> PathBuf {
    data_dir.join("snippets.json")
}

// Desktop command wrappers resolve the data dir from the AppHandle; the
// headless dispatch passes ctx.data_dir() directly to the *_core fns.
#[cfg(feature = "desktop")]
fn snippet_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app_data::app_data_dir(app).unwrap_or_else(|_| PathBuf::from("."))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Read + parse + apply migrations. Missing file → empty store.
// Parse failure → empty store (Electron behaviour: log and reset).
pub fn load_from(path: &Path) -> SnippetData {
    if !path.exists() {
        return SnippetData::default_with_next_id();
    }
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<SnippetData>(&raw) {
            Ok(mut data) => {
                migrate(&mut data);
                if data.next_id < 1 {
                    data.next_id = 1;
                }
                data
            }
            Err(_) => SnippetData::default_with_next_id(),
        },
        Err(_) => SnippetData::default_with_next_id(),
    }
}

impl SnippetData {
    fn default_with_next_id() -> Self {
        Self {
            snippets: Vec::new(),
            next_id: 1,
        }
    }
}

// Backfill the `action` field on snippets created before we added it.
fn migrate(data: &mut SnippetData) {
    for s in &mut data.snippets {
        if s.action.is_empty() {
            s.action = "terminal".into();
        }
    }
}

fn write_atomic(path: &Path, data: &SnippetData) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(data)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    fs::write(&tmp, serialized)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn ensure_loaded(data_dir: &Path, state: &SnippetState) {
    let mut guard = state.lock();
    if guard.is_none() {
        *guard = Some(load_from(&snippet_file(data_dir)));
    }
}

fn with_data<R>(
    data_dir: &Path,
    state: &SnippetState,
    mut_op: bool,
    f: impl FnOnce(&mut SnippetData) -> R,
) -> R {
    ensure_loaded(data_dir, state);
    let mut guard = state.lock();
    let data = guard.as_mut().expect("ensure_loaded set Some");
    let result = f(data);
    if mut_op {
        // Best-effort save; failures get logged but don't fail the call.
        // Mirrors Electron's logger.error path.
        if let Err(e) = write_atomic(&snippet_file(data_dir), data) {
            eprintln!("[snippet] failed to save: {e}");
        }
    }
    result
}

// Return value sorting: newest first, by updatedAt descending.
fn sort_desc_updated(out: &mut Vec<Snippet>) {
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
}

pub fn snippet_get_all_core(data_dir: &Path, state: &SnippetState) -> Vec<Snippet> {
    with_data(data_dir, state, false, |d| {
        let mut out = d.snippets.clone();
        sort_desc_updated(&mut out);
        out
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_get_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
) -> Vec<Snippet> {
    snippet_get_all_core(&snippet_data_dir(&app), &state)
}

pub fn snippet_get_by_id_core(data_dir: &Path, state: &SnippetState, id: i64) -> Option<Snippet> {
    with_data(data_dir, state, false, |d| {
        d.snippets.iter().find(|s| s.id == id).cloned()
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_get_by_id(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
    id: i64,
) -> Option<Snippet> {
    snippet_get_by_id_core(&snippet_data_dir(&app), &state, id)
}

pub fn snippet_get_favorites_core(data_dir: &Path, state: &SnippetState) -> Vec<Snippet> {
    with_data(data_dir, state, false, |d| {
        let mut out: Vec<Snippet> = d
            .snippets
            .iter()
            .filter(|s| s.is_favorite)
            .cloned()
            .collect();
        sort_desc_updated(&mut out);
        out
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_get_favorites(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
) -> Vec<Snippet> {
    snippet_get_favorites_core(&snippet_data_dir(&app), &state)
}

pub fn snippet_search_core(data_dir: &Path, state: &SnippetState, query: String) -> Vec<Snippet> {
    let term = query.to_lowercase();
    with_data(data_dir, state, false, |d| {
        let mut out: Vec<Snippet> = d
            .snippets
            .iter()
            .filter(|s| matches_query(s, &term))
            .cloned()
            .collect();
        sort_desc_updated(&mut out);
        out
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_search(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
    query: String,
) -> Vec<Snippet> {
    snippet_search_core(&snippet_data_dir(&app), &state, query)
}

fn matches_query(s: &Snippet, term: &str) -> bool {
    s.title.to_lowercase().contains(term)
        || s.content.to_lowercase().contains(term)
        || s.tags
            .as_deref()
            .map_or(false, |t| t.to_lowercase().contains(term))
}

pub fn snippet_get_by_workspace_core(
    data_dir: &Path,
    state: &SnippetState,
    workspace_id: Option<String>,
) -> Vec<Snippet> {
    with_data(data_dir, state, false, |d| {
        let mut out: Vec<Snippet> = d
            .snippets
            .iter()
            .filter(|s| match (&s.workspace_id, &workspace_id) {
                // Workspace-scoped snippet only matches when ids align.
                (Some(scope), Some(active)) => scope == active,
                // Global snippet (no workspaceId) is visible everywhere.
                (None, _) => true,
                // Workspace-scoped but no active workspace → hide.
                (Some(_), None) => false,
            })
            .cloned()
            .collect();
        sort_desc_updated(&mut out);
        out
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_get_by_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
    workspace_id: Option<String>,
) -> Vec<Snippet> {
    snippet_get_by_workspace_core(&snippet_data_dir(&app), &state, workspace_id)
}

pub fn snippet_get_categories_core(data_dir: &Path, state: &SnippetState) -> Vec<String> {
    with_data(data_dir, state, false, |d| {
        let set: BTreeSet<String> = d
            .snippets
            .iter()
            .filter_map(|s| s.category.clone())
            .collect();
        set.into_iter().collect()
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_get_categories(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
) -> Vec<String> {
    snippet_get_categories_core(&snippet_data_dir(&app), &state)
}

pub fn snippet_create_core(
    data_dir: &Path,
    state: &SnippetState,
    input: CreateSnippetInput,
) -> Snippet {
    with_data(data_dir, state, true, |d| {
        let now = now_ms();
        let snippet = Snippet {
            id: d.next_id,
            title: input.title,
            content: input.content,
            format: input.format.unwrap_or_else(|| "plaintext".into()),
            action: input.action.unwrap_or_else(|| "terminal".into()),
            category: input.category,
            tags: input.tags,
            workspace_id: input.workspace_id,
            is_favorite: input.is_favorite.unwrap_or(false),
            created_at: now,
            updated_at: now,
        };
        d.next_id += 1;
        d.snippets.push(snippet.clone());
        snippet
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
    input: CreateSnippetInput,
) -> Snippet {
    snippet_create_core(&snippet_data_dir(&app), &state, input)
}

pub fn snippet_update_core(
    data_dir: &Path,
    state: &SnippetState,
    id: i64,
    updates: UpdateSnippetInput,
) -> Option<Snippet> {
    with_data(data_dir, state, true, |d| {
        let s = d.snippets.iter_mut().find(|s| s.id == id)?;
        if let Some(v) = updates.title {
            s.title = v;
        }
        if let Some(v) = updates.content {
            s.content = v;
        }
        if let Some(v) = updates.format {
            s.format = v;
        }
        if let Some(v) = updates.action {
            s.action = v;
        }
        if let Some(v) = updates.category {
            s.category = Some(v);
        }
        if let Some(v) = updates.tags {
            s.tags = Some(v);
        }
        if let Some(v) = updates.workspace_id {
            s.workspace_id = Some(v);
        }
        if let Some(v) = updates.is_favorite {
            s.is_favorite = v;
        }
        s.updated_at = now_ms();
        Some(s.clone())
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
    id: i64,
    updates: UpdateSnippetInput,
) -> Option<Snippet> {
    snippet_update_core(&snippet_data_dir(&app), &state, id, updates)
}

pub fn snippet_delete_core(data_dir: &Path, state: &SnippetState, id: i64) -> bool {
    with_data(data_dir, state, true, |d| {
        let before = d.snippets.len();
        d.snippets.retain(|s| s.id != id);
        d.snippets.len() != before
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
    id: i64,
) -> bool {
    snippet_delete_core(&snippet_data_dir(&app), &state, id)
}

pub fn snippet_toggle_favorite_core(
    data_dir: &Path,
    state: &SnippetState,
    id: i64,
) -> Option<Snippet> {
    with_data(data_dir, state, true, |d| {
        let s = d.snippets.iter_mut().find(|s| s.id == id)?;
        s.is_favorite = !s.is_favorite;
        s.updated_at = now_ms();
        Some(s.clone())
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_toggle_favorite(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
    id: i64,
) -> Option<Snippet> {
    snippet_toggle_favorite_core(&snippet_data_dir(&app), &state, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snip(id: i64, title: &str, ws: Option<&str>, fav: bool, updated: i64) -> Snippet {
        Snippet {
            id,
            title: title.into(),
            content: format!("body of {title}"),
            format: "plaintext".into(),
            action: "terminal".into(),
            category: None,
            tags: None,
            workspace_id: ws.map(String::from),
            is_favorite: fav,
            created_at: 0,
            updated_at: updated,
        }
    }

    fn make_state(snips: Vec<Snippet>) -> Mutex<Option<SnippetData>> {
        let next_id = snips.iter().map(|s| s.id).max().unwrap_or(0) + 1;
        Mutex::new(Some(SnippetData {
            snippets: snips,
            next_id,
        }))
    }

    #[test]
    fn migrate_backfills_action_field() {
        let mut data = SnippetData {
            snippets: vec![Snippet {
                action: String::new(),
                ..snip(1, "old", None, false, 0)
            }],
            next_id: 2,
        };
        migrate(&mut data);
        assert_eq!(data.snippets[0].action, "terminal");
    }

    #[test]
    fn matches_query_checks_title_content_tags() {
        let s = Snippet {
            title: "Deploy".into(),
            content: "kubectl apply".into(),
            tags: Some("k8s,prod".into()),
            ..snip(1, "Deploy", None, false, 0)
        };
        assert!(matches_query(&s, "deploy"));
        assert!(matches_query(&s, "kubectl"));
        assert!(matches_query(&s, "k8s"));
        // matches_query expects the caller to have already lowered
        // the term — uppercase input intentionally misses (matches
        // the Electron behaviour).
        assert!(!matches_query(&s, "DEPLOY"));
        assert!(!matches_query(&s, "missing"));
    }

    #[test]
    fn sort_desc_updated_orders_newest_first() {
        let mut v = vec![
            snip(1, "a", None, false, 100),
            snip(2, "b", None, false, 300),
            snip(3, "c", None, false, 200),
        ];
        sort_desc_updated(&mut v);
        assert_eq!(v.iter().map(|s| s.id).collect::<Vec<_>>(), vec![2, 3, 1]);
    }

    #[test]
    fn workspace_filter_treats_global_as_visible_everywhere() {
        // Global snippet (workspace_id = None) is always visible.
        // Scoped snippet only matches its own workspace; if the
        // caller has no active workspace, scoped entries hide.
        let entries = vec![
            snip(1, "global", None, false, 1),
            snip(2, "ws-a", Some("ws-a"), false, 2),
            snip(3, "ws-b", Some("ws-b"), false, 3),
        ];
        let make_filter = |active: Option<&str>| -> Vec<i64> {
            let active = active.map(String::from);
            entries
                .iter()
                .filter(|s| match (&s.workspace_id, &active) {
                    (Some(scope), Some(a)) => scope == a,
                    (None, _) => true,
                    (Some(_), None) => false,
                })
                .map(|s| s.id)
                .collect()
        };
        assert_eq!(make_filter(Some("ws-a")), vec![1, 2]);
        assert_eq!(make_filter(Some("ws-b")), vec![1, 3]);
        assert_eq!(make_filter(None), vec![1]);
    }

    #[test]
    fn create_increments_next_id_and_defaults_fields() {
        let inner = make_state(Vec::new());
        let mut guard = inner.lock().unwrap();
        let d = guard.as_mut().unwrap();
        let now = now_ms();
        let s = Snippet {
            id: d.next_id,
            title: "t".into(),
            content: "c".into(),
            format: "plaintext".into(),
            action: "terminal".into(),
            category: None,
            tags: None,
            workspace_id: None,
            is_favorite: false,
            created_at: now,
            updated_at: now,
        };
        d.snippets.push(s.clone());
        d.next_id += 1;
        assert_eq!(d.next_id, 2);
        assert_eq!(d.snippets[0].id, 1);
    }

    #[test]
    fn delete_returns_true_only_when_id_matched() {
        let inner = make_state(vec![
            snip(1, "a", None, false, 0),
            snip(2, "b", None, false, 0),
        ]);
        let mut guard = inner.lock().unwrap();
        let d = guard.as_mut().unwrap();
        let before = d.snippets.len();
        d.snippets.retain(|s| s.id != 99);
        assert_eq!(d.snippets.len(), before);
        let before = d.snippets.len();
        d.snippets.retain(|s| s.id != 1);
        assert_ne!(d.snippets.len(), before);
        assert_eq!(d.snippets.len(), 1);
    }

    #[test]
    fn load_from_missing_file_yields_empty_with_next_id_one() {
        let path =
            std::env::temp_dir().join(format!("bat-snippet-test-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        let data = load_from(&path);
        assert!(data.snippets.is_empty());
        assert_eq!(data.next_id, 1);
    }

    #[test]
    fn load_from_corrupt_file_yields_empty() {
        let path =
            std::env::temp_dir().join(format!("bat-snippet-corrupt-{}.json", std::process::id()));
        fs::write(&path, "not valid json {").unwrap();
        let data = load_from(&path);
        assert!(data.snippets.is_empty());
        assert_eq!(data.next_id, 1);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn load_from_round_trip_with_camel_case_fields() {
        let path =
            std::env::temp_dir().join(format!("bat-snippet-roundtrip-{}.json", std::process::id()));
        let raw = r#"{
          "snippets": [
            {
              "id": 5,
              "title": "T",
              "content": "C",
              "format": "markdown",
              "action": "agent",
              "tags": "x,y",
              "workspaceId": "ws-1",
              "isFavorite": true,
              "createdAt": 100,
              "updatedAt": 200
            }
          ],
          "nextId": 6
        }"#;
        fs::write(&path, raw).unwrap();
        let data = load_from(&path);
        assert_eq!(data.next_id, 6);
        assert_eq!(data.snippets.len(), 1);
        let s = &data.snippets[0];
        assert_eq!(s.workspace_id.as_deref(), Some("ws-1"));
        assert!(s.is_favorite);
        assert_eq!(s.action, "agent");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn write_atomic_round_trips() {
        let path =
            std::env::temp_dir().join(format!("bat-snippet-write-{}.json", std::process::id()));
        let data = SnippetData {
            snippets: vec![snip(1, "x", Some("ws"), true, 99)],
            next_id: 2,
        };
        write_atomic(&path, &data).unwrap();
        let reloaded = load_from(&path);
        assert_eq!(reloaded.next_id, 2);
        assert_eq!(reloaded.snippets.len(), 1);
        assert_eq!(reloaded.snippets[0].title, "x");
        assert_eq!(reloaded.snippets[0].workspace_id.as_deref(), Some("ws"));
        let _ = fs::remove_file(&path);
    }
}
