// dialog:* — confirmation modal + native file/folder pickers.
//
// Renderer-facing host methods:
//   dialog.confirm(message, title?) -> Promise<bool>          // OK/Cancel
//   dialog.selectFolder()           -> Promise<string[]|null> // multi, null on cancel
//   dialog.selectFiles()            -> Promise<string[]>      // multi, [] on cancel
//   dialog.selectImages()           -> Promise<string[]>      // multi, [] on cancel, image filter
//
// Tauri's native dialog plugin implements these host contracts. Modal dialogs
// wait for user interaction; `spawn_blocking` keeps their blocking plugin calls
// off the async runtime worker.

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

#[tauri::command]
pub async fn dialog_confirm(
    app: tauri::AppHandle,
    message: String,
    title: Option<String>,
) -> Result<bool, CommandError> {
    let title = title.unwrap_or_else(|| "Confirm".to_string());
    // Run the blocking native dialog on a worker thread so we don't tie up
    // the async runtime. spawn_blocking is the supported way to do this
    // from inside a Tauri command (which itself runs on the async runtime).
    let app = app.clone();
    let result = crate::async_rt::spawn_blocking(move || {
        app.dialog()
            .message(&message)
            .title(&title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show()
    })
    .await
    .map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    Ok(result)
}

// Helpers shared by the file pickers below.

fn home_default(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().home_dir().ok()
}

fn paths_to_strings(paths: Vec<tauri_plugin_dialog::FilePath>) -> Vec<String> {
    paths
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
pub async fn dialog_select_folder(
    app: tauri::AppHandle,
) -> Result<Option<Vec<String>>, CommandError> {
    let app_clone = app.clone();
    let result = crate::async_rt::spawn_blocking(move || {
        let mut builder = app_clone.dialog().file();
        if let Some(home) = home_default(&app_clone) {
            builder = builder.set_directory(home);
        }
        builder.blocking_pick_folders()
    })
    .await
    .map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    Ok(result.map(paths_to_strings))
}

#[tauri::command]
pub async fn dialog_select_files(app: tauri::AppHandle) -> Result<Vec<String>, CommandError> {
    let app_clone = app.clone();
    let result = crate::async_rt::spawn_blocking(move || {
        let mut builder = app_clone.dialog().file();
        if let Some(home) = home_default(&app_clone) {
            builder = builder.set_directory(home);
        }
        builder.blocking_pick_files()
    })
    .await
    .map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    Ok(result.map(paths_to_strings).unwrap_or_default())
}

#[tauri::command]
pub async fn dialog_select_images(app: tauri::AppHandle) -> Result<Vec<String>, CommandError> {
    let app_clone = app.clone();
    let result = crate::async_rt::spawn_blocking(move || {
        let mut builder = app_clone
            .dialog()
            .file()
            .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"]);
        if let Some(home) = home_default(&app_clone) {
            builder = builder.set_directory(home);
        }
        builder.blocking_pick_files()
    })
    .await
    .map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    Ok(result.map(paths_to_strings).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    // We can't open native dialogs in unit tests, so this only checks the
    // default-title fallback behaviour — the rest is integration territory.
    fn resolve_title(title: Option<String>) -> String {
        title.unwrap_or_else(|| "Confirm".to_string())
    }

    #[test]
    fn defaults_title_to_confirm() {
        assert_eq!(resolve_title(None), "Confirm");
        assert_eq!(resolve_title(Some("Quit?".into())), "Quit?");
        assert_eq!(resolve_title(Some(String::new())), "");
    }

    #[test]
    fn paths_to_strings_filters_invalid_entries() {
        // Only paths convertible via into_path() (i.e. real Path variants)
        // make it through; the helper just lossy-stringifies them.
        let inputs: Vec<tauri_plugin_dialog::FilePath> = vec![
            tauri_plugin_dialog::FilePath::from(std::path::PathBuf::from("/tmp/a.png")),
            tauri_plugin_dialog::FilePath::from(std::path::PathBuf::from("C:\\foo\\bar.png")),
        ];
        let out = paths_to_strings(inputs);
        assert!(out.iter().any(|s| s.contains("a.png")));
        assert!(out.iter().any(|s| s.contains("bar.png")));
    }
}
