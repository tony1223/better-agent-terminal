// snippet:* — Tauri adapters for bat-app-storage.

#[cfg(feature = "desktop")]
use crate::app_data;
pub use bat_app_storage::snippet::*;
#[cfg(feature = "desktop")]
use std::path::PathBuf;
#[cfg(feature = "desktop")]
fn snippet_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app_data::app_data_dir(app).unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_get_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
) -> Vec<Snippet> {
    snippet_get_all_core(&snippet_data_dir(&app), &state)
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

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_get_favorites(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
) -> Vec<Snippet> {
    snippet_get_favorites_core(&snippet_data_dir(&app), &state)
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

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_get_by_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
    workspace_id: Option<String>,
) -> Vec<Snippet> {
    snippet_get_by_workspace_core(&snippet_data_dir(&app), &state, workspace_id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_get_categories(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
) -> Vec<String> {
    snippet_get_categories_core(&snippet_data_dir(&app), &state)
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

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn snippet_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, SnippetState>,
    id: i64,
) -> bool {
    snippet_delete_core(&snippet_data_dir(&app), &state, id)
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
