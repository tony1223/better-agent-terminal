use std::path::PathBuf;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};

pub const TAURI_DATA_DIR_ENV: &str = "BAT_TAURI_DATA_DIR";

#[cfg(all(feature = "desktop", windows))]
pub(crate) fn desktop_startup_guard(identifier: &str) -> std::io::Result<std::fs::File> {
    // The native plugin publishes its mutex before its callback window. Serialize
    // setup so simultaneous launches cannot slip through that short interval.
    // Windows temp directories are per-user; the file lock is released by the OS
    // even when a secondary instance exits from inside the plugin.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(std::env::temp_dir().join(format!("bat-startup-{identifier}.lock")))?;
    file.lock()?;
    Ok(file)
}

#[cfg(feature = "desktop")]
pub(crate) fn scope_desktop_instance(
    context: &mut tauri::Context<tauri::Wry>,
) -> std::io::Result<()> {
    let Some(dir) = std::env::var(TAURI_DATA_DIR_ENV)
        .ok()
        .map(|raw| PathBuf::from(raw.trim()))
        .filter(|dir| !dir.as_os_str().is_empty())
    else {
        return Ok(());
    };
    std::fs::create_dir_all(&dir)?;
    let dir = std::fs::canonicalize(dir)?;
    let identifier = scoped_instance_identifier(&context.config().identifier, &dir);
    context.config_mut().identifier = identifier;
    Ok(())
}

#[cfg(feature = "desktop")]
fn scoped_instance_identifier(identifier: &str, data_dir: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    let path = data_dir.to_string_lossy();
    // Windows paths are case insensitive. Canonicalization also resolves relative
    // paths and directory aliases before computing the native lock identity.
    #[cfg(windows)]
    let path = path.to_lowercase();
    let digest = format!("{:x}", Sha256::digest(path.as_bytes()));
    // Keep the macOS Unix socket path under its platform length limit.
    format!("{identifier}.data{}", &digest[..32])
}

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

    #[cfg(feature = "desktop")]
    #[test]
    fn desktop_instance_scope_is_stable_and_separates_data_directories() {
        let first = PathBuf::from("first-data-dir");
        let second = PathBuf::from("second-data-dir");
        let id = "org.tonyq.better-agent-terminal";
        assert_eq!(
            scoped_instance_identifier(id, &first),
            scoped_instance_identifier(id, &first)
        );
        assert_ne!(
            scoped_instance_identifier(id, &first),
            scoped_instance_identifier(id, &second)
        );
        assert_ne!(
            scoped_instance_identifier(id, &first),
            scoped_instance_identifier("another.app", &first)
        );
    }

    #[cfg(all(feature = "desktop", windows))]
    #[test]
    fn desktop_instance_scope_ignores_windows_path_case() {
        let id = "org.tonyq.better-agent-terminal";
        assert_eq!(
            scoped_instance_identifier(id, std::path::Path::new(r"C:\BAT\data")),
            scoped_instance_identifier(id, std::path::Path::new(r"c:\bat\DATA")),
        );
    }

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
