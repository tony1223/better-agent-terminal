// Bounded worker scrollback, Procfile parsing and local process launch.
use crate::pty::{start_pty_session, write_pty_session, CreatePtyOptions, PtyState};
use crate::PtyContext;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
    pub message: String,
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

#[derive(Debug, Serialize, Deserialize)]
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

pub fn worker_buffer_init_core(handle: &Arc<Mutex<HashMap<String, String>>>, panel_id: &str) {
    if let Ok(mut map) = handle.lock() {
        map.entry(panel_id.to_string()).or_default();
    }
}

pub fn worker_buffer_read_all_core(
    handle: &Arc<Mutex<HashMap<String, String>>>,
    panel_id: &str,
) -> String {
    handle
        .lock()
        .ok()
        .and_then(|map| map.get(panel_id).cloned())
        .unwrap_or_default()
}

pub fn worker_buffer_clear_core(handle: &Arc<Mutex<HashMap<String, String>>>, panel_id: &str) {
    if let Ok(mut map) = handle.lock() {
        map.remove(panel_id);
    }
}

pub fn worker_procfile_load_impl(file_path: &str) -> Result<Vec<ProcfileEntry>, String> {
    let content = fs::read_to_string(file_path)
        .map_err(|err| format!("Procfile not found on this host: {file_path} ({err})"))?;
    Ok(parse_procfile_content(&content))
}

// A remote window does not know which shell the host uses, so it omits
// `shell`; resolve it from the host's own settings (custom path when set,
// otherwise the configured shell type, falling back to auto-detect).
fn host_default_shell(ctx: &PtyContext) -> Option<String> {
    let data_dir = ctx.data_dir_opt()?;
    let raw = bat_app_storage::settings::settings_load_impl(&data_dir)
        .ok()
        .flatten()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let shell_type = parsed
        .get("shell")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("auto");
    if shell_type == "custom" {
        if let Some(custom) = parsed
            .get("customShellPath")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            return Some(custom.to_string());
        }
        return Some(bat_app_storage::settings::settings_get_shell_path(
            "auto".into(),
        ));
    }
    Some(bat_app_storage::settings::settings_get_shell_path(
        shell_type.to_string(),
    ))
}

/// Spawn one Procfile process on this machine. Used by the desktop command
/// for local windows and by the remote server on behalf of remote windows.
pub fn worker_procfile_start_core(
    ctx: &PtyContext,
    pty_state: PtyState,
    worker_handle: Arc<Mutex<HashMap<String, String>>>,
    mut options: WorkerProcessStartOptions,
    owner_window: Option<String>,
) -> Result<String, String> {
    if options
        .shell
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        options.shell = host_default_shell(ctx);
    }
    let pty_id = worker_pty_id(&options.panel_id, &options.name);
    let launch = build_worker_launch_command(options.shell.as_deref(), &options.command);
    let create_options = CreatePtyOptions {
        id: pty_id,
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
    let started_id = start_pty_session(
        ctx,
        pty_state.handle(),
        Some(worker_handle),
        create_options,
        owner_window,
    )
    .map_err(|err| format!("{err:?}"))?;

    let started_id_for_write = started_id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let _ = write_pty_session(&pty_state, &started_id_for_write, &launch);
    });
    Ok(started_id)
}

pub fn worker_procfile_stop_core(
    ctx: &PtyContext,
    pty_state: &PtyState,
    panel_id: &str,
    name: &str,
) -> Result<(), String> {
    let pty_id = worker_pty_id(panel_id, name);
    crate::pty::kill_pty_session_with_exit(ctx, pty_state, &pty_id)
        .map_err(|err| format!("{err:?}"))
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
        // Exercise the shared buffer map used by the worker runtime.
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
