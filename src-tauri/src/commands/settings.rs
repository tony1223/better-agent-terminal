// settings:* — Tauri adapters for bat-app-storage.

#[cfg(feature = "desktop")]
use crate::app_data;
pub use bat_app_storage::settings::*;

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn settings_get_shell_path(shell_type: String) -> String {
    bat_app_storage::settings::settings_get_shell_path(shell_type)
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
