use std::path::PathBuf;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};

pub const TAURI_DATA_DIR_ENV: &str = "BAT_TAURI_DATA_DIR";

// Keep existing Electron users on the Electron build's userData directory
// so accounts/snippets/terminal-history migrate cleanly. Fresh Tauri installs
// use Tauri's default app_data_dir(), which follows the bundle identifier.
const ELECTRON_PRODUCT_NAME: &str = "BetterAgentTerminal";

// Shared, tauri-free resolution: explicit env override, then the migrated
// Electron userData dir, then a caller-provided fallback (Tauri's app_data_dir
// on desktop; none in the headless server, which always has the env set).
fn resolve_app_data_dir(tauri_fallback: Result<PathBuf, String>) -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var(TAURI_DATA_DIR_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    select_app_data_dir(electron_user_data_dir(), tauri_fallback)
}

#[cfg(feature = "desktop")]
pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_app_data_dir(
        app.path()
            .app_data_dir()
            .map_err(|err| format!("could not resolve Tauri app data dir: {err}")),
    )
}

#[cfg(feature = "desktop")]
pub fn app_data_dir_opt(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).ok()
}

// Headless server: the data dir is pinned via BAT_TAURI_DATA_DIR (set from the
// --data-dir arg before the server starts), so the env branch always resolves;
// the Electron fallback covers an existing install with the env unset.
#[cfg(not(feature = "desktop"))]
pub fn app_data_dir() -> Result<PathBuf, String> {
    resolve_app_data_dir(Err(
        "headless: app data dir not configured (set BAT_DATA_DIR)".into(),
    ))
}

#[cfg(not(feature = "desktop"))]
#[allow(dead_code)]
pub fn app_data_dir_opt() -> Option<PathBuf> {
    app_data_dir().ok()
}

fn electron_user_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(ELECTRON_PRODUCT_NAME),
        );
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        return Some(PathBuf::from(appdata).join(ELECTRON_PRODUCT_NAME));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            return Some(PathBuf::from(xdg).join(ELECTRON_PRODUCT_NAME));
        }
        let home = std::env::var_os("HOME")?;
        return Some(
            PathBuf::from(home)
                .join(".config")
                .join(ELECTRON_PRODUCT_NAME),
        );
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

fn select_app_data_dir(
    electron_dir: Option<PathBuf>,
    tauri_dir: Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    if let Some(dir) = electron_dir {
        if dir.exists() {
            return Ok(dir);
        }
    }
    tauri_dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("bat-app-data-{name}-{}", std::process::id()))
    }

    #[test]
    fn selects_existing_electron_user_data_dir() {
        let electron = tmp_dir("electron-existing");
        let tauri = tmp_dir("tauri-default");
        let _ = fs::remove_dir_all(&electron);
        let _ = fs::remove_dir_all(&tauri);
        fs::create_dir_all(&electron).unwrap();

        let selected = select_app_data_dir(Some(electron.clone()), Ok(tauri.clone())).unwrap();

        assert_eq!(selected, electron);
        let _ = fs::remove_dir_all(&selected);
        let _ = fs::remove_dir_all(&tauri);
    }

    #[test]
    fn selects_tauri_default_when_electron_user_data_dir_is_missing() {
        let electron = tmp_dir("electron-missing");
        let tauri = tmp_dir("tauri-default");
        let _ = fs::remove_dir_all(&electron);
        let _ = fs::remove_dir_all(&tauri);

        let selected = select_app_data_dir(Some(electron), Ok(tauri.clone())).unwrap();

        assert_eq!(selected, tauri);
        let _ = fs::remove_dir_all(&selected);
    }
}
