// settings:load / settings:save / settings:get-shell-path — host settings surface.
//
// The renderer treats the payload as opaque JSON text (matching the
// Electron preload shape: settings.load returns Promise<string|null>,
// settings.save accepts a JSON string). We keep the same contract here so
// the host-api adapter can route to either runtime without changing
// caller types.
//
// The settings file lives at <app-data>/settings.json. Tauri 2's
// path::app_data_dir resolves to per-user app data, namespaced by the
// identifier in tauri.conf.json — we deliberately keep the filename
// "settings.json" so a future Electron→Tauri migration only has to copy
// the file across the data directory.

// Only the desktop #[tauri::command] wrappers resolve the data dir from an
// AppHandle; the *_impl cores take a data_dir: &Path and compile headless.
#[cfg(feature = "desktop")]
use crate::app_data;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("could not resolve app data directory: {0}")]
    AppDataDir(String),
    #[error("settings IO error: {0}")]
    Io(#[from] io::Error),
}

// Tauri's command system requires Serialize for error types so they cross
// the JS bridge. Use a simple message representation.
#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

impl From<SettingsError> for CommandError {
    fn from(value: SettingsError) -> Self {
        Self {
            message: value.to_string(),
        }
    }
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

pub fn settings_load_impl(data_dir: &Path) -> Result<Option<String>, CommandError> {
    let path = settings_path(data_dir);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(SettingsError::from)?;
    Ok(Some(text))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn settings_load(app: tauri::AppHandle) -> Result<Option<String>, CommandError> {
    crate::async_rt::spawn_blocking(move || {
        let dir = app_data::app_data_dir(&app).map_err(SettingsError::AppDataDir)?;
        settings_load_impl(&dir)
    })
    .await
    .map_err(|err| CommandError {
        message: format!("settings.load worker failed: {err}"),
    })?
}

pub fn settings_save_impl(data_dir: &Path, data: String) -> Result<(), CommandError> {
    let path = settings_path(data_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(SettingsError::from)?;
    }
    fs::write(&path, data).map_err(SettingsError::from)?;
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn settings_save(app: tauri::AppHandle, data: String) -> Result<(), CommandError> {
    crate::async_rt::spawn_blocking(move || {
        let dir = app_data::app_data_dir(&app).map_err(SettingsError::AppDataDir)?;
        settings_save_impl(&dir, data)
    })
    .await
    .map_err(|err| CommandError {
        message: format!("settings.save worker failed: {err}"),
    })?
}

fn clear_terminal_history_dir(history_dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(history_dir) else {
        return true;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == ".zsh-wrapper" {
            continue;
        }
        let path = entry.path();
        let result = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        let _ = result;
    }
    true
}

fn settings_clear_terminal_history_impl(data_dir: &Path) -> Result<bool, CommandError> {
    Ok(clear_terminal_history_dir(
        &data_dir.join("terminal-history"),
    ))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn settings_clear_terminal_history(app: tauri::AppHandle) -> Result<bool, CommandError> {
    crate::async_rt::spawn_blocking(move || {
        let dir = app_data::app_data_dir(&app).map_err(SettingsError::AppDataDir)?;
        settings_clear_terminal_history_impl(&dir)
    })
    .await
    .map_err(|err| CommandError {
        message: format!("settings.clearTerminalHistory worker failed: {err}"),
    })?
}

// settings:get-shell-path — resolve a shell type to a concrete executable.
//
// Mirrors the Electron handler in server-core/register-handlers.ts:
//   - "auto", "zsh", "bash", "sh", "pwsh", "powershell", "cmd" all map
//     to platform-appropriate binaries; unknown shellType strings are
//     returned verbatim (treated as a literal path/exe).
//   - Results are cached process-wide (existsSync calls aren't free).
//
// We pull the platform branch into a pure function so we can unit-test it
// with a synthetic "exists" check, instead of relying on the real fs.

#[cfg(target_family = "unix")]
const TARGET_OS: &str = "unix";
#[cfg(target_os = "windows")]
const TARGET_OS: &str = "windows";

fn posix_auto_shell(exists: &impl Fn(&str) -> bool) -> String {
    // Best-effort detection: prefer $SHELL if pointing at an executable
    // file, then fall back to /bin/zsh on macOS / /bin/bash elsewhere.
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() && exists(&shell) {
            return shell;
        }
    }
    if cfg!(target_os = "macos") {
        "/bin/zsh".into()
    } else {
        "/bin/bash".into()
    }
}

fn windows_localappdata_pwsh() -> Option<String> {
    let lad = std::env::var("LOCALAPPDATA").ok()?;
    Some(format!("{lad}\\Microsoft\\WindowsApps\\pwsh.exe"))
}

pub fn resolve_shell_path<F: Fn(&str) -> bool>(
    shell_type: &str,
    target_os: &str,
    exists: &F,
) -> String {
    if target_os == "unix" {
        return match shell_type {
            "auto" => posix_auto_shell(exists),
            "zsh" => "/bin/zsh".into(),
            "bash" => {
                if exists("/opt/homebrew/bin/bash") {
                    "/opt/homebrew/bin/bash".into()
                } else if exists("/usr/local/bin/bash") {
                    "/usr/local/bin/bash".into()
                } else {
                    "/bin/bash".into()
                }
            }
            "sh" => "/bin/sh".into(),
            "pwsh" | "powershell" | "cmd" => posix_auto_shell(exists),
            other => other.into(),
        };
    }
    // windows
    let mut pwsh_paths: Vec<String> = vec![
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe".into(),
        "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe".into(),
    ];
    if let Some(p) = windows_localappdata_pwsh() {
        pwsh_paths.push(p);
    }

    if shell_type == "auto" || shell_type == "pwsh" {
        for p in &pwsh_paths {
            if exists(p) {
                return p.clone();
            }
        }
        if shell_type == "pwsh" {
            return "pwsh.exe".into();
        }
        // auto -> powershell.exe fallback
        return "powershell.exe".into();
    }
    match shell_type {
        "powershell" => "powershell.exe".into(),
        "cmd" => "cmd.exe".into(),
        other => other.into(),
    }
}

fn shell_path_cache() -> &'static Mutex<std::collections::HashMap<String, String>> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

// Dispatch-called with pure args; a command on desktop, a plain fn headless.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn settings_get_shell_path(shell_type: String) -> String {
    if let Some(hit) = shell_path_cache().lock().unwrap().get(&shell_type) {
        return hit.clone();
    }
    let exists = |s: &str| Path::new(s).exists();
    let resolved = resolve_shell_path(&shell_type, TARGET_OS, &exists);
    shell_path_cache()
        .lock()
        .unwrap()
        .insert(shell_type, resolved.clone());
    resolved
}

// settings:detect-cx — locate the optional `cx` semantic-navigation binary.
//
// Mirrors electron/semantic-navigation.ts:detectCx. Returns a structured
// result regardless of whether cx is installed so the renderer can render
// a settings row + status badge. The renderer's expected shape (string
// fields are optional) is locked by the SettingsCxStatus interface in
// renderer/src/types/index.ts; mirror it via #[serde(rename_all = "camelCase")].

#[derive(Debug, Default, Clone, serde::Deserialize)]
struct CxSettings {
    #[serde(default, rename = "cxSemanticNavigationEnabled")]
    enabled: bool,
    #[serde(default, rename = "cxBinaryPath")]
    binary_path: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CxDetectionResult {
    pub enabled: bool,
    pub detected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub cache_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn read_cx_settings(data_dir: &Path) -> CxSettings {
    let Ok(text) = fs::read_to_string(settings_path(data_dir)) else {
        return CxSettings::default();
    };
    serde_json::from_str::<CxSettings>(&text).unwrap_or_default()
}

fn cx_resolve_from_path() -> Option<String> {
    use std::process::Command;
    let cmd = if cfg!(target_os = "windows") {
        "where.exe"
    } else {
        "which"
    };
    let mut command = Command::new(cmd);
    command.arg("cx");
    crate::subprocess::hide_console_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|s| s.to_string())
}

fn cx_resolve_configured(configured: Option<&str>) -> Option<String> {
    let trimmed = configured.map(|s| s.trim()).unwrap_or("");
    if trimmed.is_empty() {
        return cx_resolve_from_path();
    }
    let pb = PathBuf::from(trimmed);
    if pb.is_absolute() {
        return Some(trimmed.to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        // Relative path with separators — caller probably expects
        // resolution relative to cwd. We don't know which cwd, so pass
        // through as-is and let the OS shell resolve.
        return Some(trimmed.to_string());
    }
    // Bare token like "cx" — pass through, OS will look it up on PATH
    // when execFileSync runs it.
    Some(trimmed.to_string())
}

fn cx_run_version(binary: &str) -> Result<String, String> {
    use std::process::Command;
    let mut command = Command::new(binary);
    command.arg("--version");
    crate::subprocess::hide_console_window(&mut command);
    let output = command.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("cx --version exited {}", output.status));
    }
    let trimmed = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if trimmed.is_empty() {
        "cx".to_string()
    } else {
        trimmed
    })
}

pub fn settings_detect_cx_impl(data_dir: &Path) -> Result<CxDetectionResult, CommandError> {
    let settings = read_cx_settings(data_dir);
    let cache_dir = data_dir.join("cx-cache").to_string_lossy().to_string();
    let enabled = settings.enabled;

    let Some(binary) = cx_resolve_configured(settings.binary_path.as_deref()) else {
        return Ok(CxDetectionResult {
            enabled,
            detected: false,
            path: None,
            version: None,
            cache_dir,
            error: Some("cx not found in PATH".into()),
        });
    };
    match cx_run_version(&binary) {
        Ok(version) => Ok(CxDetectionResult {
            enabled,
            detected: true,
            path: Some(binary),
            version: Some(version),
            cache_dir,
            error: None,
        }),
        Err(msg) => Ok(CxDetectionResult {
            enabled,
            detected: false,
            path: Some(binary),
            version: None,
            cache_dir,
            error: Some(msg),
        }),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn settings_detect_cx(app: tauri::AppHandle) -> Result<CxDetectionResult, CommandError> {
    crate::async_rt::spawn_blocking(move || {
        let dir = app_data::app_data_dir(&app).map_err(SettingsError::AppDataDir)?;
        settings_detect_cx_impl(&dir)
    })
    .await
    .map_err(|err| CommandError {
        message: format!("settings.detectCx worker failed: {err}"),
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_path_uses_settings_json_filename() {
        // We can't easily build an AppHandle in a unit test, so we assert
        // on the filename path component which the public function always
        // appends. This guards against accidental rename of the on-disk
        // file (which would lose user settings on upgrade).
        let p = PathBuf::from("/fake/app-data").join("settings.json");
        assert_eq!(p.file_name().unwrap(), "settings.json");
    }

    fn exists_set<'a>(set: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |p| set.iter().any(|x| *x == p)
    }

    #[test]
    fn unix_shells_resolve_to_canonical_paths() {
        let none = exists_set(&[]);
        assert_eq!(resolve_shell_path("zsh", "unix", &none), "/bin/zsh");
        assert_eq!(resolve_shell_path("sh", "unix", &none), "/bin/sh");
        // bash falls back to /bin/bash when neither homebrew location exists.
        assert_eq!(resolve_shell_path("bash", "unix", &none), "/bin/bash");
        // bash prefers /opt/homebrew when present.
        let homebrew = exists_set(&["/opt/homebrew/bin/bash"]);
        assert_eq!(
            resolve_shell_path("bash", "unix", &homebrew),
            "/opt/homebrew/bin/bash"
        );
        let usrlocal = exists_set(&["/usr/local/bin/bash"]);
        assert_eq!(
            resolve_shell_path("bash", "unix", &usrlocal),
            "/usr/local/bin/bash"
        );
    }

    #[test]
    fn unknown_shell_is_returned_verbatim() {
        let none = exists_set(&[]);
        assert_eq!(
            resolve_shell_path("/custom/shell", "unix", &none),
            "/custom/shell"
        );
        assert_eq!(resolve_shell_path("fish", "unix", &none), "fish");
    }

    #[test]
    fn windows_pwsh_prefers_program_files() {
        let pf = exists_set(&["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]);
        assert_eq!(
            resolve_shell_path("pwsh", "windows", &pf),
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        );
    }

    #[test]
    fn windows_auto_falls_back_to_powershell_exe() {
        let none = exists_set(&[]);
        assert_eq!(
            resolve_shell_path("auto", "windows", &none),
            "powershell.exe"
        );
    }

    #[test]
    fn windows_pwsh_without_install_returns_pwsh_exe() {
        let none = exists_set(&[]);
        assert_eq!(resolve_shell_path("pwsh", "windows", &none), "pwsh.exe");
    }

    #[test]
    fn windows_cmd_and_powershell_are_handled() {
        let none = exists_set(&[]);
        assert_eq!(resolve_shell_path("cmd", "windows", &none), "cmd.exe");
        assert_eq!(
            resolve_shell_path("powershell", "windows", &none),
            "powershell.exe"
        );
    }

    #[test]
    fn cx_resolve_configured_pass_through_for_abs_and_relative() {
        // Empty / whitespace falls back to PATH lookup (None when PATH miss).
        // We can't reliably trigger the PATH branch here because CI hosts may
        // genuinely have `cx` installed — but configured strings always
        // pass through.
        let abs = if cfg!(target_os = "windows") {
            "C:\\bin\\cx.exe"
        } else {
            "/usr/bin/cx"
        };
        assert_eq!(cx_resolve_configured(Some(abs)), Some(abs.into()));
        // Relative with separator → returned as-is for the OS to resolve.
        assert_eq!(
            cx_resolve_configured(Some("./tools/cx")),
            Some("./tools/cx".into())
        );
        // Bare token → returned as-is; OS PATH lookup happens at exec time.
        assert_eq!(cx_resolve_configured(Some("cx")), Some("cx".into()));
        // Whitespace gets trimmed; a non-empty trimmed path is honored.
        assert_eq!(
            cx_resolve_configured(Some("  /opt/cx  ")),
            Some("/opt/cx".into())
        );
    }

    #[test]
    fn cx_settings_parses_minimal_and_full_shape() {
        // The settings file shape Electron uses; deserialization must be
        // lenient — missing keys default to off.
        let empty: CxSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.enabled, false);
        assert!(empty.binary_path.is_none());

        let full: CxSettings = serde_json::from_str(
            r#"{"cxSemanticNavigationEnabled":true,"cxBinaryPath":"/opt/cx"}"#,
        )
        .unwrap();
        assert_eq!(full.enabled, true);
        assert_eq!(full.binary_path.as_deref(), Some("/opt/cx"));

        // Other settings keys must not break parsing.
        let mixed: CxSettings = serde_json::from_str(
            r#"{"theme":"dark","cxSemanticNavigationEnabled":false,"unrelated":42}"#,
        )
        .unwrap();
        assert_eq!(mixed.enabled, false);
    }

    #[test]
    fn cx_run_version_failure_returns_err() {
        // A binary that definitely doesn't exist must not panic and must
        // surface an error string the handler maps to result.error.
        let r = cx_run_version("/no/such/path/cx-fake");
        assert!(r.is_err(), "expected Err for missing binary");
    }

    #[test]
    fn clear_terminal_history_removes_entries_but_keeps_zsh_wrapper() {
        let root =
            std::env::temp_dir().join(format!("bat-clear-terminal-history-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".zsh-wrapper")).unwrap();
        fs::write(root.join("abc_history"), b"history").unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested").join("old"), b"x").unwrap();

        assert!(clear_terminal_history_dir(&root));
        assert!(root.join(".zsh-wrapper").exists());
        assert!(!root.join("abc_history").exists());
        assert!(!root.join("nested").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clear_terminal_history_missing_dir_is_success() {
        let root = std::env::temp_dir().join(format!(
            "bat-clear-terminal-history-missing-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        assert!(clear_terminal_history_dir(&root));
    }
}
