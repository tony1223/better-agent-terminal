// debug:* — renderer logging surface.
//
// Electron exposes `debug.log(...args)` over `ipcRenderer.send('debug:log',
// ...args)` so the main process can persist the message to disk via the
// shared logger. Under Tauri, we mirror that with a best-effort append to
// <app-data>/logs/debug.log and still print to stderr for dev sessions.
//
// `isDebugMode` is exposed synchronously from the JS side, not through a
// command — the adapter reads BAT_DEBUG out of process.env at startup.
// This file only handles the runtime log call.

use crate::app_data;
use crate::log_file::append_line;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_plugin_opener::OpenerExt;

fn bat_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn pty_input_trace_enabled() -> bool {
    matches!(
        std::env::var("BAT_TRACE_PTY_INPUT").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

#[tauri::command]
pub fn debug_is_debug_mode() -> bool {
    bat_debug_enabled()
}

#[tauri::command]
pub fn debug_is_pty_input_trace() -> bool {
    pty_input_trace_enabled()
}

#[tauri::command]
pub async fn debug_log(app: tauri::AppHandle, args: Vec<Value>) {
    let message = format_args(args);
    eprintln!("[renderer] {message}");
    let path = app_data::app_data_dir_opt(&app).map(|dir| dir.join("logs").join("debug.log"));
    if let Some(path) = path {
        let line = debug_log_line(&message);
        let _ = crate::async_rt::spawn_blocking(move || append_line(&path, &line)).await;
    }
}

#[tauri::command]
pub async fn debug_open_logs_folder(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = app_data::app_data_dir(&app).map(|dir| logs_dir(&dir))?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| err.to_string())?;
    Ok(true)
}

fn logs_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("logs")
}

fn format_args(args: Vec<Value>) -> String {
    let parts: Vec<String> = args
        .into_iter()
        .map(|v| match v {
            Value::String(s) => s,
            other => other.to_string(),
        })
        .collect();
    parts.join(" ")
}

fn debug_log_line(message: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{millis} [renderer] {message}\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strings_pass_through_untouched() {
        assert_eq!(
            format_args(vec![json!("hello"), json!("world")]),
            "hello world"
        );
    }

    #[test]
    fn non_strings_serialize_as_json_text() {
        assert_eq!(
            format_args(vec![json!(42), json!({"a": 1})]),
            r#"42 {"a":1}"#
        );
        assert_eq!(format_args(vec![json!([1, 2, 3])]), "[1,2,3]");
        assert_eq!(format_args(vec![json!(null), json!(true)]), "null true");
    }

    #[test]
    fn log_line_has_renderer_prefix() {
        let line = debug_log_line("hello");
        assert!(line.contains(" [renderer] hello\n"));
    }

    #[test]
    fn logs_dir_lives_under_app_data_logs() {
        assert_eq!(
            logs_dir(Path::new("app-data")),
            PathBuf::from("app-data").join("logs")
        );
    }
}
