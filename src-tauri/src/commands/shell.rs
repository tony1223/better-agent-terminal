// shell:open-external — first OS integration we route through Tauri.
//
// We use tauri-plugin-opener (the recommended replacement for the
// deprecated tauri-plugin-shell::open) so the OS integration stays
// consistent with what Tauri's security model audits. The renderer's
// host-api adapter maps shell.openExternal(url) to this command.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl<E: std::fmt::Display> From<E> for CommandError {
    fn from(value: E) -> Self {
        Self {
            message: value.to_string(),
        }
    }
}

#[tauri::command]
pub async fn shell_open_external(app: tauri::AppHandle, url: String) -> Result<(), CommandError> {
    // Block obvious file:// URLs — those should go through openPath, not
    // openExternal. Mirrors the Electron preload split.
    if url.starts_with("file://") {
        return Err(CommandError {
            message: "shell_open_external refuses file:// URLs; use shell_open_path instead".into(),
        });
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(Into::<CommandError>::into)?;
    Ok(())
}

// Mirror of Electron `shell.openPath` — opens a local path with the OS's
// default handler (Finder/Explorer for folders, default app for files).
// Empty strings are rejected so we don't accidentally open the cwd.
#[tauri::command]
pub async fn shell_open_path(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), CommandError> {
    if path.trim().is_empty() {
        return Err(CommandError {
            message: "shell_open_path requires a non-empty path".into(),
        });
    }
    if crate::commands::fs::is_remote_profile_window(&app, &window) {
        return Err(CommandError {
            message:
                "Cannot open a remote file with this computer's default app. Download it first."
                    .into(),
        });
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(Into::<CommandError>::into)?;
    Ok(())
}

// Where a reveal request should actually land. `reveal_item_in_dir` canonicalizes
// its argument, so a path that is not on this machine — a stale chat citation, a
// path from a remote session, a name the agent got slightly wrong — would just
// error out. Walking up to the nearest existing ancestor means the user still
// lands in the closest real folder instead of getting nothing.
#[derive(Debug)]
enum RevealTarget {
    // The item exists: select it inside its folder, like a native "Show in Folder".
    Item(PathBuf),
    // The item is gone but an ancestor survives: open that folder directly. Note
    // this is `open_path`, not `reveal`, because revealing a directory would
    // select it in its *parent* rather than opening the folder itself.
    Folder(PathBuf),
}

fn resolve_reveal_target(path: &Path) -> Option<RevealTarget> {
    if path.exists() {
        return Some(RevealTarget::Item(path.to_path_buf()));
    }
    let mut candidate = path.parent();
    while let Some(dir) = candidate {
        if dir.exists() {
            return Some(RevealTarget::Folder(dir.to_path_buf()));
        }
        candidate = dir.parent();
    }
    None
}

// Mirror of Electron `shell.showItemInFolder` — opens the containing folder and
// selects the item, which is what a native right-click "Show in Folder" does.
// Distinct from shell_open_path, which hands the file to its default app.
#[tauri::command]
pub async fn shell_reveal_path(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), CommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(CommandError {
            message: "shell_reveal_path requires a non-empty path".into(),
        });
    }
    if crate::commands::fs::is_remote_profile_window(&app, &window) {
        return Err(CommandError {
            message:
                "Cannot show a remote file in this computer's file manager. Download it first."
                    .into(),
        });
    }
    match resolve_reveal_target(Path::new(trimmed)) {
        Some(RevealTarget::Item(item)) => app
            .opener()
            .reveal_item_in_dir(item)
            .map_err(Into::<CommandError>::into)?,
        Some(RevealTarget::Folder(dir)) => app
            .opener()
            .open_path(dir.to_string_lossy().to_string(), None::<&str>)
            .map_err(Into::<CommandError>::into)?,
        None => {
            return Err(CommandError {
                message: format!("Not found on this computer: {trimmed}"),
            })
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Pure-input validation lives here; integration tests run via
    // tauri-driver once that harness is set up.
    fn rejects_file_scheme(url: &str) -> bool {
        url.starts_with("file://")
    }

    fn rejects_empty_path(path: &str) -> bool {
        path.trim().is_empty()
    }

    #[test]
    fn file_urls_are_rejected() {
        assert!(rejects_file_scheme("file:///etc/passwd"));
        assert!(rejects_file_scheme("file://localhost/c:/foo.txt"));
        assert!(!rejects_file_scheme("https://example.com"));
        assert!(!rejects_file_scheme("mailto:hi@example.com"));
    }

    #[test]
    fn empty_paths_are_rejected() {
        assert!(rejects_empty_path(""));
        assert!(rejects_empty_path("   "));
        assert!(rejects_empty_path("\t\n"));
        assert!(!rejects_empty_path("C:/Users"));
        assert!(!rejects_empty_path("/home/user"));
    }

    // Chat citations outlive the files they point at, so the fallback chain is the
    // part most likely to be exercised in practice.
    #[test]
    fn reveal_target_falls_back_to_the_nearest_existing_ancestor() {
        use super::{resolve_reveal_target, RevealTarget};
        use std::path::Path;

        let dir = std::env::temp_dir().join("bat-reveal-target-test");
        let nested = dir.join("nested");
        std::fs::create_dir_all(&nested).expect("create fixture dirs");
        let file = nested.join("real.txt");
        std::fs::write(&file, b"x").expect("write fixture file");

        // An existing file is selected in place.
        match resolve_reveal_target(&file) {
            Some(RevealTarget::Item(p)) => assert_eq!(p, file),
            other => panic!("expected Item for an existing file, got {other:?}"),
        }
        // An existing directory is also an item — the caller decides how to open it.
        match resolve_reveal_target(&nested) {
            Some(RevealTarget::Item(p)) => assert_eq!(p, nested),
            other => panic!("expected Item for an existing dir, got {other:?}"),
        }
        // A missing leaf falls back to the folder that does exist.
        match resolve_reveal_target(&nested.join("gone.txt")) {
            Some(RevealTarget::Folder(p)) => assert_eq!(p, nested),
            other => panic!("expected Folder for a missing leaf, got {other:?}"),
        }
        // Several missing segments still walk up to the deepest real ancestor.
        match resolve_reveal_target(&nested.join("a").join("b").join("c.txt")) {
            Some(RevealTarget::Folder(p)) => assert_eq!(p, nested),
            other => panic!("expected Folder for a deep miss, got {other:?}"),
        }
        // A path with no existing ancestor at all resolves to nothing.
        let bogus = if cfg!(windows) {
            Path::new("Q:\\definitely\\not\\here\\x.txt")
        } else {
            Path::new("/definitely-not-here-bat/x.txt")
        };
        assert!(resolve_reveal_target(bogus).is_none());

        std::fs::remove_dir_all(&dir).ok();
    }
}
