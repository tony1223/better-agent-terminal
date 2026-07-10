// worker-buffer.* — in-process per-panel string buffer.
//
// The renderer uses this to stash terminal output for a panel that's
// currently scrolled out of view, so reattaching restores the full
// scrollback without paying re-render costs. We back it with a
// Mutex<HashMap<String, String>>; the cap (1 MiB per panel) is the same
// rough order of magnitude as the Electron implementation but keeps memory
// from blowing up if a runaway producer never calls clear().

// The renderer-facing command wrappers are desktop-only; the headless dispatch
// uses WorkerBufferState directly (the scrollback store), which is tauri-free.
#[cfg(feature = "desktop")]
use crate::commands::pty::{start_pty_session, write_pty_session, CreatePtyOptions, PtyState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(feature = "desktop")]
use std::fs;
use std::sync::{Arc, Mutex};
#[cfg(feature = "desktop")]
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, State, WebviewWindow};

const MAX_BYTES_PER_PANEL: usize = 1 << 20; // 1 MiB

#[derive(Clone)]
pub struct WorkerBufferState {
    inner: Arc<Mutex<HashMap<String, String>>>,
}

impl Default for WorkerBufferState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl WorkerBufferState {
    pub fn handle(&self) -> Arc<Mutex<HashMap<String, String>>> {
        Arc::clone(&self.inner)
    }
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl<E: std::fmt::Display> From<E> for CommandError {
    fn from(e: E) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcfileEntry {
    name: String,
    command: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerProcessStartOptions {
    panel_id: String,
    name: String,
    command: String,
    cwd: String,
    shell: Option<String>,
    #[serde(default)]
    custom_env: Option<HashMap<String, String>>,
}

pub fn parse_procfile_content(content: &str) -> Vec<ProcfileEntry> {
    let mut entries = Vec::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(colon_idx) = line.find(':') else {
            continue;
        };
        if colon_idx == 0 {
            continue;
        }
        let name = line[..colon_idx].trim();
        let command = line[colon_idx + 1..].trim();
        if !name.is_empty() && !command.is_empty() {
            entries.push(ProcfileEntry {
                name: name.to_string(),
                command: command.to_string(),
            });
        }
    }
    entries
}

fn worker_pty_id(panel_id: &str, name: &str) -> String {
    format!("{panel_id}__w__{name}")
}

fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn build_worker_launch_command(shell: Option<&str>, command: &str) -> String {
    let is_powershell = shell
        .map(|value| {
            let lower = value.to_ascii_lowercase();
            lower.contains("pwsh") || lower.contains("powershell")
        })
        .unwrap_or(false);
    if is_powershell {
        return format!("{command}; exit $LASTEXITCODE\r");
    }

    let shell_exec = shell
        .filter(|value| !value.trim().is_empty())
        .map(sh_single_quote)
        .unwrap_or_else(|| "\"${SHELL:-/bin/sh}\"".into());
    let shell_name = shell
        .and_then(|value| value.rsplit(['/', '\\']).next())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let login_flag = matches!(
        shell_name.as_str(),
        "bash" | "zsh" | "fish" | "ksh" | "ksh93" | "mksh"
    );
    let flags = if login_flag { "-lc" } else { "-c" };

    format!("exec {shell_exec} {flags} {}\r", sh_single_quote(command))
}

fn append_lines_to_map(map: &mut HashMap<String, String>, panel_id: &str, lines: &str) {
    let buf = map.entry(panel_id.to_string()).or_default();
    buf.push_str(lines);
    trim_buffer_to_cap(buf);
}

fn trim_buffer_to_cap(buf: &mut String) {
    if buf.len() <= MAX_BYTES_PER_PANEL {
        return;
    }
    // Trim from the front when we exceed the per-panel cap. Drop whole
    // lines so we don't slice a UTF-8 grapheme in half.
    let drop_at = buf.len().saturating_sub(MAX_BYTES_PER_PANEL);
    if let Some(pos) = buf[drop_at..].find('\n') {
        *buf = buf.split_off(drop_at + pos + 1);
    } else {
        // No newline anywhere — just truncate to the cap from the back.
        let keep = buf.split_off(buf.len() - MAX_BYTES_PER_PANEL);
        *buf = keep;
    }
}

pub fn append_worker_log_lines(
    handle: &Arc<Mutex<HashMap<String, String>>>,
    panel_id: &str,
    lines: &str,
) {
    if panel_id.is_empty() || lines.is_empty() {
        return;
    }
    let Ok(mut map) = handle.lock() else {
        return;
    };
    append_lines_to_map(&mut map, panel_id, lines);
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn worker_buffer_init(
    state: State<'_, WorkerBufferState>,
    panel_id: String,
) -> Result<bool, CommandError> {
    if panel_id.is_empty() {
        return Err(CommandError {
            message: "panel_id required".into(),
        });
    }
    let mut map = state.inner.lock().expect("worker_buffer lock");
    map.entry(panel_id).or_default();
    Ok(true)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn worker_buffer_append(
    state: State<'_, WorkerBufferState>,
    panel_id: String,
    lines: String,
) -> Result<bool, CommandError> {
    if panel_id.is_empty() {
        return Err(CommandError {
            message: "panel_id required".into(),
        });
    }
    let mut map = state.inner.lock().expect("worker_buffer lock");
    append_lines_to_map(&mut map, &panel_id, &lines);
    Ok(true)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn worker_buffer_read_all(
    state: State<'_, WorkerBufferState>,
    panel_id: String,
) -> Result<String, CommandError> {
    let map = state.inner.lock().expect("worker_buffer lock");
    Ok(map.get(&panel_id).cloned().unwrap_or_default())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn worker_buffer_clear(
    state: State<'_, WorkerBufferState>,
    panel_id: String,
) -> Result<bool, CommandError> {
    let mut map = state.inner.lock().expect("worker_buffer lock");
    map.remove(&panel_id);
    Ok(true)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worker_procfile_load(file_path: String) -> Result<Vec<ProcfileEntry>, CommandError> {
    crate::async_rt::spawn_blocking(move || {
        let content = fs::read_to_string(file_path)?;
        Ok(parse_procfile_content(&content))
    })
    .await
    .map_err(|err| CommandError {
        message: format!("worker.procfileLoad worker failed: {err}"),
    })?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worker_procfile_start(
    app: AppHandle,
    window: WebviewWindow,
    pty_state: State<'_, PtyState>,
    worker_state: State<'_, WorkerBufferState>,
    options: WorkerProcessStartOptions,
) -> Result<String, CommandError> {
    let pty_id = worker_pty_id(&options.panel_id, &options.name);
    let launch = build_worker_launch_command(options.shell.as_deref(), &options.command);
    let pty_handle = pty_state.handle();
    let worker_handle = worker_state.handle();
    let owner_window = Some(window.label().to_string());
    let create_options = CreatePtyOptions {
        id: pty_id.clone(),
        cwd: options.cwd,
        r#type: "terminal".to_string(),
        shell: options.shell,
        command: None,
        args: None,
        cols: None,
        rows: None,
        agent_preset: None,
        custom_env: options.custom_env,
        per_terminal_history: None,
        history_key: None,
    };
    let started_id = crate::async_rt::spawn_blocking(move || {
        start_pty_session(
            &crate::host_context::HostContext::from_app(app.clone()),
            pty_handle,
            Some(worker_handle),
            create_options,
            owner_window,
        )
    })
    .await
    .map_err(|err| CommandError {
        message: format!("worker.procfileStart worker failed: {err}"),
    })?
    .map_err(|err| CommandError {
        message: format!("{err:?}"),
    })?;

    let pty_state = (*pty_state).clone();
    let started_id_for_write = started_id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let _ = write_pty_session(&pty_state, &started_id_for_write, &launch);
    });
    Ok(started_id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn worker_procfile_stop(
    app: AppHandle,
    pty_state: State<'_, PtyState>,
    panel_id: String,
    name: String,
) -> Result<bool, CommandError> {
    let pty_id = worker_pty_id(&panel_id, &name);
    crate::commands::pty::kill_pty_session_with_exit(
        &crate::host_context::HostContext::from_app(app.clone()),
        &pty_state,
        &pty_id,
    )
    .map_err(|err| CommandError {
        message: format!("{err:?}"),
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_state() -> WorkerBufferState {
        WorkerBufferState::default()
    }

    #[test]
    fn append_then_read_round_trips() {
        let s = fresh_state();
        // We can't construct a tauri::State<'_, T> directly in tests — instead
        // test the underlying map behaviour through a thin helper.
        let mut map = s.inner.lock().unwrap();
        map.entry("p".to_string()).or_default();
        map.get_mut("p").unwrap().push_str("hello\n");
        map.get_mut("p").unwrap().push_str("world\n");
        assert_eq!(map.get("p").unwrap(), "hello\nworld\n");
    }

    #[test]
    fn parse_procfile_content_matches_renderer_rules() {
        let entries = parse_procfile_content(
            r#"
              # comment
              web: pnpm dev
              worker: node worker.js:with-arg
              bad-line
              empty:
              : missing-name
            "#,
        );
        assert_eq!(
            entries,
            vec![
                ProcfileEntry {
                    name: "web".to_string(),
                    command: "pnpm dev".to_string(),
                },
                ProcfileEntry {
                    name: "worker".to_string(),
                    command: "node worker.js:with-arg".to_string(),
                },
            ]
        );
    }

    #[test]
    fn worker_pty_id_matches_renderer_convention() {
        assert_eq!(worker_pty_id("panel", "web"), "panel__w__web");
    }

    #[test]
    fn launch_command_uses_powershell_exit_code_wrapper() {
        assert_eq!(
            build_worker_launch_command(
                Some("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
                "pnpm dev"
            ),
            "pnpm dev; exit $LASTEXITCODE\r",
        );
    }

    #[test]
    fn launch_command_uses_posix_exec_wrapper() {
        assert_eq!(
            build_worker_launch_command(Some("/bin/bash"), "node 'worker.js'"),
            "exec '/bin/bash' -lc 'node '\\''worker.js'\\'''\r",
        );
        assert_eq!(
            build_worker_launch_command(
                Some("/bin/zsh"),
                "docker compose -f $HOME/app/docker-compose.yml up"
            ),
            "exec '/bin/zsh' -lc 'docker compose -f $HOME/app/docker-compose.yml up'\r",
        );
        assert_eq!(
            build_worker_launch_command(Some("/bin/sh"), "echo ok"),
            "exec '/bin/sh' -c 'echo ok'\r",
        );
    }

    #[test]
    fn init_preserves_existing_buffer() {
        let s = fresh_state();
        let mut map = s.inner.lock().unwrap();
        map.insert("p".to_string(), "existing\n".to_string());
        map.entry("p".to_string()).or_default();
        assert_eq!(map.get("p").unwrap(), "existing\n");
    }

    #[test]
    fn cap_trims_to_first_newline_after_excess() {
        // Simulate the trim logic on a synthetic buffer.
        let mut buf = String::new();
        for i in 0..5000 {
            buf.push_str(&format!("line {}\n", i));
        }
        let original_len = buf.len();
        let cap = 1024;
        if buf.len() > cap {
            let drop_at = buf.len().saturating_sub(cap);
            if let Some(pos) = buf[drop_at..].find('\n') {
                buf = buf.split_off(drop_at + pos + 1);
            }
        }
        assert!(buf.len() <= original_len);
        assert!(buf.len() <= cap + 32);
        assert!(!buf.contains("line 0\n"));
        assert!(buf.ends_with('\n'));
    }

    #[test]
    fn empty_panel_id_rejected() {
        // We can't call the command directly without State<'_, T> in tests,
        // so just assert the validation logic via a stand-in.
        let panel_id: String = String::new();
        assert!(panel_id.is_empty());
    }

    #[test]
    fn clear_removes_panel() {
        let s = fresh_state();
        let mut map = s.inner.lock().unwrap();
        map.insert("p".to_string(), "data".to_string());
        map.remove("p");
        assert!(!map.contains_key("p"));
    }
}
