// shell:open-external — first OS integration we route through Tauri.
//
// We use tauri-plugin-opener (the recommended replacement for the
// deprecated tauri-plugin-shell::open) so the OS integration stays
// consistent with what Tauri's security model audits. The renderer's
// host-api adapter maps shell.openExternal(url) to this command.

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
}
