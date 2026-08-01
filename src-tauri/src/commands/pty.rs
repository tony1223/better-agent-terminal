// pty:* — first cut of the cross-platform PTY surface for the Tauri shell.
//
// We mirror the renderer host contract from renderer/src/types/index.ts so the
// renderer doesn't have to branch on host:
//   pty.create({ id, cwd, type, shell?, customEnv?, … })
//   pty.write(id, data)
//   pty.resize(id, cols, rows)
//   pty.kill(id)
// Plus two event streams emitted from a per-session reader thread:
//   pty:output  -> { id, data }
//   pty:exit    -> { id, exitCode }
//
// portable-pty handles the cross-platform side (forkpty on Unix, ConPTY on
// Windows). We keep one PtySession per id, hold the writer + master in a
// shared map behind Arc<Mutex<…>>, and use background threads to pump
// bytes into Tauri events and to wait on the child exit.

use crate::app_data;
use crate::commands::profile as profile_cmd;
use crate::commands::settings::resolve_shell_path;
use crate::commands::worker_buffer::{append_worker_log_lines, WorkerBufferState};
use crate::host_context::HostContext;
use crate::log_file::append_line;
use crate::remote_client::RustRemoteClientState;
#[cfg(feature = "desktop")]
use crate::window_registry;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, State, WebviewWindow};

const REMOTE_PTY_TIMEOUT: Duration = Duration::from_secs(30);

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

#[cfg(feature = "desktop")]
fn is_remote_profile_window(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Some(profile_id) = window_registry::profile_id_for_window(app, window.label()) else {
        return false;
    };
    profile_cmd::profile_get(app.clone(), profile_id)
        .map(|profile| profile.kind == "remote")
        .unwrap_or(false)
}

#[cfg(feature = "desktop")]
fn remote_invoke_for_window(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &str,
    args: Vec<Value>,
) -> Option<Result<Value, CommandError>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    Some(
        remote_client
            .invoke(window.label(), channel, args, REMOTE_PTY_TIMEOUT)
            .map_err(CommandError::from),
    )
}

#[cfg(feature = "desktop")]
fn remote_value_for_window<T>(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &str,
    args: Vec<Value>,
) -> Option<Result<T, CommandError>>
where
    T: DeserializeOwned,
{
    remote_invoke_for_window(app, window, channel, args).map(|result| {
        result.and_then(|value| serde_json::from_value(value).map_err(CommandError::from))
    })
}

#[cfg(feature = "desktop")]
fn remote_unit_for_window(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &str,
    args: Vec<Value>,
) -> Option<Result<(), CommandError>> {
    remote_invoke_for_window(app, window, channel, args).map(|result| result.map(|_| ()))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatePtyOptions {
    pub id: String,
    pub cwd: String,
    #[allow(dead_code)] // accepted for API compat with Electron contract
    pub r#type: String,
    pub shell: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[allow(dead_code)]
    pub agent_preset: Option<String>,
    #[serde(default)]
    pub custom_env: Option<HashMap<String, String>>,
    #[serde(default)]
    #[allow(dead_code)]
    pub per_terminal_history: Option<bool>,
    #[serde(default)]
    #[allow(dead_code)]
    pub history_key: Option<String>,
}

pub struct PtySession {
    generation: u64,
    write_tx: Sender<String>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer_done: Receiver<()>,
    reader_done: Receiver<()>,
    output_done: Receiver<()>,
    exit_done: Receiver<()>,
    cwd: String,
    kind: String,
    viewport: TerminalViewportState,
    output_buffer: VecDeque<String>,
    output_buffer_bytes: usize,
    owner_window: Option<String>,
}

pub(crate) enum PtyEntry {
    Starting { generation: u64 },
    Active(PtySession),
}

impl PtyEntry {
    #[cfg(test)]
    fn generation(&self) -> u64 {
        match self {
            Self::Starting { generation } => *generation,
            Self::Active(session) => session.generation,
        }
    }

    fn active(&self) -> Option<&PtySession> {
        match self {
            Self::Active(session) => Some(session),
            Self::Starting { .. } => None,
        }
    }

    fn active_mut(&mut self) -> Option<&mut PtySession> {
        match self {
            Self::Active(session) => Some(session),
            Self::Starting { .. } => None,
        }
    }
}

#[derive(Clone)]
pub struct PtyState {
    inner: Arc<Mutex<HashMap<String, PtyEntry>>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl PtyState {
    pub(crate) fn handle(&self) -> Arc<Mutex<HashMap<String, PtyEntry>>> {
        Arc::clone(&self.inner)
    }

    pub(crate) fn with_session<R>(
        &self,
        id: &str,
        f: impl FnOnce(&mut PtySession) -> Result<R, CommandError>,
    ) -> Result<R, CommandError> {
        let mut map = self.inner.lock().map_err(|e| CommandError {
            message: e.to_string(),
        })?;
        let session = match map.get_mut(id) {
            Some(PtyEntry::Active(session)) => session,
            Some(PtyEntry::Starting { .. }) => {
                return Err(CommandError {
                    message: format!("pty session {id} is still starting"),
                });
            }
            None => {
                return Err(CommandError {
                    message: format!("pty session {id} not found"),
                });
            }
        };
        f(session)
    }
}

struct PtyStartReservation {
    sessions: Arc<Mutex<HashMap<String, PtyEntry>>>,
    id: String,
    generation: u64,
    committed: bool,
}

impl PtyStartReservation {
    fn reserve(
        sessions: Arc<Mutex<HashMap<String, PtyEntry>>>,
        id: &str,
    ) -> Result<Self, CommandError> {
        let generation = NEXT_PTY_GENERATION.fetch_add(1, Ordering::Relaxed);
        {
            let mut map = sessions.lock().map_err(|e| CommandError {
                message: e.to_string(),
            })?;
            if map.contains_key(id) {
                return Err(CommandError {
                    message: format!("pty session {id} already exists"),
                });
            }
            map.insert(id.to_string(), PtyEntry::Starting { generation });
        }
        Ok(Self {
            sessions,
            id: id.to_string(),
            generation,
            committed: false,
        })
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for PtyStartReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let Ok(mut map) = self.sessions.lock() else {
            return;
        };
        let reserved_by_self = matches!(
            map.get(&self.id),
            Some(PtyEntry::Starting { generation }) if *generation == self.generation
        );
        if reserved_by_self {
            map.remove(&self.id);
        }
    }
}

struct PtyThreadDone(Sender<()>);

enum PtyExitPoll {
    Running,
    Exited(i32),
    Failed(String),
}

impl Drop for PtyThreadDone {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

fn pty_thread_completion() -> (PtyThreadDone, Receiver<()>) {
    let (tx, rx) = mpsc::channel();
    (PtyThreadDone(tx), rx)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyOutputEvent {
    id: String,
    data: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    id: String,
    exit_code: i32,
}

#[derive(Debug, Serialize)]
struct WorkerLogEntry<'a> {
    name: &'a str,
    color: &'a str,
    data: &'a str,
}

// Pure, host-agnostic "is this id safe to use as a key?" check we can
// unit-test without touching the OS. The renderer generates short string
// ids, but we still defend against empty / overly long inputs.
pub fn is_valid_pty_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 256 {
        return false;
    }
    // No control chars / null bytes.
    !id.chars().any(|c| c.is_control())
}

// Pure helper used to decide which shell we should hand to portable-pty.
// Matches the Electron rule: explicit option wins, otherwise resolve via
// settings::resolve_shell_path("auto", …) for the running OS.
pub fn select_shell<F: Fn(&str) -> bool>(
    requested: Option<&str>,
    target_os: &str,
    exists: &F,
) -> String {
    if let Some(s) = requested {
        if !s.trim().is_empty() {
            return s.to_string();
        }
    }
    resolve_shell_path("auto", target_os, exists)
}

#[cfg(target_family = "unix")]
const TARGET_OS: &str = "unix";
#[cfg(target_os = "windows")]
const TARGET_OS: &str = "windows";
const INTERACTIVE_OUTPUT_FLUSH_MS: u64 = 16;
const WORKER_OUTPUT_FLUSH_MS: u64 = 33;
const PTY_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const PTY_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);
// Cap per emit so a fast producer (e.g. `cat hugefile`) cannot push a
// single multi-megabyte event into the renderer's event queue. The
// coalescer flushes early once `pending` crosses this threshold instead
// of growing until the time deadline.
const OUTPUT_FRAME_MAX_BYTES: usize = 64 * 1024;
const OUTPUT_REPLAY_MAX_BYTES: usize = 1024 * 1024;
const WORKER_PTY_SEPARATOR: &str = "__w__";
const DEFAULT_PTY_COLS: u16 = 100;
const DEFAULT_PTY_ROWS: u16 = 30;
pub const MOBILE_TERMINAL_COLS: u16 = 56;
pub const MOBILE_TERMINAL_ROWS: u16 = 24;

static NEXT_PTY_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalViewportMode {
    Desktop,
    Mobile,
}

impl Default for TerminalViewportMode {
    fn default() -> Self {
        Self::Desktop
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalViewportSource {
    Desktop,
    Mobile,
}

impl Default for TerminalViewportSource {
    fn default() -> Self {
        Self::Desktop
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalViewportState {
    pub mode: TerminalViewportMode,
    pub cols: u16,
    pub rows: u16,
    pub updated_by: TerminalViewportSource,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetViewportModeOptions {
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub source: TerminalViewportSource,
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn env_flag_enabled(name: &str) -> bool {
    matches!(
        std::env::var(name).as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn pty_input_debug_enabled() -> bool {
    env_flag_enabled("BAT_DEBUG")
}

fn pty_output_debug_enabled() -> bool {
    env_flag_enabled("BAT_PTY_OUTPUT_DEBUG")
}

pub(crate) fn pty_input_trace_required(data: &str) -> bool {
    pty_input_bytes_trace_required(data.as_bytes())
}

fn pty_input_bytes_trace_required(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    bytes.len() <= 256
        || bytes.iter().any(|byte| matches!(*byte, 8 | 32 | 127))
        || bytes == b"\x1b[3~"
}

fn pty_output_bytes_trace_required(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    bytes.len() <= 256 || bytes.iter().any(|byte| matches!(*byte, 8 | 127))
}

fn pty_input_byte_label(byte: u8) -> &'static str {
    match byte {
        8 => "BS",
        10 => "LF",
        13 => "CR",
        27 => "ESC",
        32 => "SPACE",
        127 => "DEL",
        _ => ".",
    }
}

pub(crate) fn describe_pty_bytes(bytes: &[u8]) -> String {
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    let labels = bytes
        .iter()
        .map(|byte| pty_input_byte_label(*byte))
        .collect::<Vec<_>>()
        .join(" ");
    format!("len={} bytes=[{}] labels=[{}]", bytes.len(), hex, labels)
}

pub(crate) fn describe_pty_input(data: &str) -> String {
    describe_pty_bytes(data.as_bytes())
}

pub(crate) fn pty_input_debug_log(app: &HostContext, message: impl AsRef<str>) {
    if !pty_input_debug_enabled() {
        return;
    }
    let message = format!("[pty-input] {}", message.as_ref());
    eprintln!("{message}");
    let Some(path) = app
        .data_dir_opt()
        .map(|dir| dir.join("logs").join("debug.log"))
    else {
        return;
    };
    let line = format!("{} [rust] {message}\n", unix_ms());
    let _ = append_line(&path, &line);
}

fn pty_lifecycle_log(app: &HostContext, message: impl AsRef<str>) {
    let message = format!("[pty-lifecycle] {}", message.as_ref());
    eprintln!("{message}");
    let Some(path) = app
        .data_dir_opt()
        .map(|dir| dir.join("logs").join("debug.log"))
    else {
        return;
    };
    let line = format!("{} [rust] {message}\n", unix_ms());
    let _ = append_line(&path, &line);
}

fn pty_output_debug_log(app: &HostContext, message: impl AsRef<str>) {
    if !pty_output_debug_enabled() {
        return;
    }
    let message = format!("[pty-output] {}", message.as_ref());
    eprintln!("{message}");
    let Some(path) = app
        .data_dir_opt()
        .map(|dir| dir.join("logs").join("debug.log"))
    else {
        return;
    };
    let line = format!("{} [rust] {message}\n", unix_ms());
    let _ = append_line(&path, &line);
}

#[cfg(target_family = "unix")]
fn pty_termios_debug_log(app: &HostContext, message: impl AsRef<str>) {
    if !pty_input_debug_enabled() {
        return;
    }
    let message = format!("[pty-termios] {}", message.as_ref());
    eprintln!("{message}");
    let Some(path) = app
        .data_dir_opt()
        .map(|dir| dir.join("logs").join("debug.log"))
    else {
        return;
    };
    let line = format!("{} [rust] {message}\n", unix_ms());
    let _ = append_line(&path, &line);
}

#[cfg(target_family = "unix")]
fn termios_flag(flags: libc::tcflag_t, flag: libc::tcflag_t) -> bool {
    flags & flag != 0
}

#[cfg(target_family = "unix")]
fn describe_termios(termios: &libc::termios) -> String {
    let erase = termios.c_cc[libc::VERASE];
    format!(
        "erase={erase:02X} echo={} echoe={} echok={} echonl={} icanon={} isig={}",
        termios_flag(termios.c_lflag, libc::ECHO),
        termios_flag(termios.c_lflag, libc::ECHOE),
        termios_flag(termios.c_lflag, libc::ECHOK),
        termios_flag(termios.c_lflag, libc::ECHONL),
        termios_flag(termios.c_lflag, libc::ICANON),
        termios_flag(termios.c_lflag, libc::ISIG)
    )
}

#[cfg(target_family = "unix")]
fn configure_initial_pty_termios(app: &HostContext, id: &str, master: &dyn MasterPty) {
    let Some(fd) = master.as_raw_fd() else {
        pty_termios_debug_log(app, format!("id={id} raw-fd=unavailable"));
        return;
    };

    let mut termios: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(fd, &mut termios) } != 0 {
        pty_termios_debug_log(
            app,
            format!(
                "id={id} tcgetattr=error {}",
                std::io::Error::last_os_error()
            ),
        );
        return;
    }

    pty_termios_debug_log(
        app,
        format!("id={id} before {}", describe_termios(&termios)),
    );
    termios.c_cc[libc::VERASE] = 0x7f;
    termios.c_lflag |= libc::ECHOE;

    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &termios) } != 0 {
        pty_termios_debug_log(
            app,
            format!(
                "id={id} tcsetattr=error {}",
                std::io::Error::last_os_error()
            ),
        );
        return;
    }

    let mut updated: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(fd, &mut updated) } == 0 {
        pty_termios_debug_log(app, format!("id={id} after {}", describe_termios(&updated)));
    } else {
        pty_termios_debug_log(app, format!("id={id} after tcgetattr=error"));
    }
}

fn desktop_viewport_state(cols: u16, rows: u16) -> TerminalViewportState {
    TerminalViewportState {
        mode: TerminalViewportMode::Desktop,
        cols,
        rows,
        updated_by: TerminalViewportSource::Desktop,
        updated_at: unix_ms(),
    }
}

fn positive_size(value: Option<u16>, fallback: u16) -> u16 {
    value.filter(|value| *value > 0).unwrap_or(fallback)
}

fn validate_pty_size(cols: u16, rows: u16) -> Result<(), CommandError> {
    if cols == 0 || rows == 0 {
        return Err(CommandError {
            message: format!("invalid pty size: {cols}x{rows}"),
        });
    }
    Ok(())
}

fn resize_session(session: &mut PtySession, cols: u16, rows: u16) -> Result<(), CommandError> {
    validate_pty_size(cols, rows)?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| CommandError {
            message: e.to_string(),
        })?;
    Ok(())
}

fn emit_viewport_state(
    app: &HostContext,
    sessions: &PtyState,
    id: &str,
    state: &TerminalViewportState,
) {
    let payload = json!({
        "id": id,
        "state": state,
    });
    let owner_window = sessions.inner.lock().ok().and_then(|map| {
        map.get(id)
            .and_then(PtyEntry::active)
            .and_then(|session| session.owner_window.clone())
    });
    match owner_window {
        Some(window) => crate::event_hub::publish_runtime_event_to_window(
            app,
            &window,
            "pty:viewport-state",
            payload,
            "rust-pty",
        ),
        None => {
            crate::event_hub::publish_runtime_event(app, "pty:viewport-state", payload, "rust-pty")
        }
    }
}

fn worker_parts_from_pty_id(id: &str) -> Option<(&str, &str)> {
    let (panel_id, process_name) = id.split_once(WORKER_PTY_SEPARATOR)?;
    if panel_id.is_empty() || process_name.is_empty() {
        return None;
    }
    Some((panel_id, process_name))
}

fn hash_history_key(id: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:012x}")
}

fn sanitize_history_key(raw: &str) -> String {
    let safe = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .chars()
        .take(80)
        .collect::<String>();
    if safe.is_empty() {
        "terminal".into()
    } else {
        safe
    }
}

fn history_file_name(opts: &CreatePtyOptions) -> String {
    let key = opts
        .history_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .map(sanitize_history_key)
        .unwrap_or_else(|| hash_history_key(&opts.id));
    format!("{key}_history")
}

fn is_zsh_shell(shell: &str) -> bool {
    Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell)
        .contains("zsh")
}

fn source_zsh_file(file: &str) -> String {
    format!("[ -f \"${{_BAT_ZDOTDIR:-$HOME}}/{file}\" ] && source \"${{_BAT_ZDOTDIR:-$HOME}}/{file}\"\n")
}

fn ensure_zsh_wrapper(wrapper_dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(wrapper_dir)?;
    fs::write(wrapper_dir.join(".zshenv"), source_zsh_file(".zshenv"))?;
    fs::write(wrapper_dir.join(".zprofile"), source_zsh_file(".zprofile"))?;
    fs::write(
        wrapper_dir.join(".zshrc"),
        [
            source_zsh_file(".zshrc").trim_end().to_string(),
            "export HISTFILE=\"$_BAT_HISTFILE\"".into(),
            "setopt INC_APPEND_HISTORY".into(),
            "ZDOTDIR=\"${_BAT_ZDOTDIR:-$HOME}\"".into(),
            String::new(),
        ]
        .join("\n"),
    )?;
    fs::write(wrapper_dir.join(".zlogin"), source_zsh_file(".zlogin"))?;
    Ok(())
}

fn configure_per_terminal_history(
    cmd: &mut CommandBuilder,
    shell: &str,
    opts: &CreatePtyOptions,
    app_data_dir: Option<&Path>,
) {
    if opts.per_terminal_history != Some(true) {
        return;
    }
    let Some(app_data_dir) = app_data_dir else {
        return;
    };
    let history_dir = app_data_dir.join("terminal-history");
    if fs::create_dir_all(&history_dir).is_err() {
        return;
    }
    let hist_file = history_dir.join(history_file_name(opts));
    let hist_file_text = hist_file.to_string_lossy().to_string();
    cmd.env("HISTFILE", &hist_file_text);

    if is_zsh_shell(shell) {
        let wrapper_dir = history_dir.join(".zsh-wrapper");
        if ensure_zsh_wrapper(&wrapper_dir).is_ok() {
            let original_zdotdir = std::env::var("ZDOTDIR")
                .ok()
                .or_else(|| std::env::var("HOME").ok())
                .unwrap_or_default();
            cmd.env("ZDOTDIR", wrapper_dir.to_string_lossy().as_ref());
            cmd.env("_BAT_ZDOTDIR", original_zdotdir);
            cmd.env("_BAT_HISTFILE", hist_file_text);
        }
    }
}

fn configure_terminal_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
}

fn new_shell_command(shell: &str) -> CommandBuilder {
    #[cfg(target_family = "unix")]
    {
        let mut cmd = CommandBuilder::new_default_prog();
        cmd.env("SHELL", shell);
        cmd
    }
    #[cfg(not(target_family = "unix"))]
    {
        CommandBuilder::new(shell)
    }
}

fn build_command(opts: &CreatePtyOptions, app_data_dir: Option<&Path>) -> CommandBuilder {
    let cwd = if Path::new(&opts.cwd).is_dir() {
        PathBuf::from(&opts.cwd)
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };
    if let Some(program) = opts
        .command
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let mut cmd = CommandBuilder::new(program);
        if let Some(args) = &opts.args {
            for arg in args {
                cmd.arg(arg);
            }
        }
        cmd.cwd(cwd);
        configure_terminal_env(&mut cmd);
        if let Some(env) = &opts.custom_env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        return cmd;
    }

    let exists = |s: &str| Path::new(s).exists();
    let shell = select_shell(opts.shell.as_deref(), TARGET_OS, &exists);
    let mut cmd = new_shell_command(&shell);
    cmd.cwd(cwd);
    configure_terminal_env(&mut cmd);
    if let Some(env) = &opts.custom_env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    configure_per_terminal_history(&mut cmd, &shell, opts, app_data_dir);
    cmd
}

fn persist_worker_output(
    worker_buffer: &Arc<Mutex<HashMap<String, String>>>,
    id: &str,
    data: &str,
) {
    let Some((panel_id, process_name)) = worker_parts_from_pty_id(id) else {
        return;
    };
    let Ok(line) = serde_json::to_string(&WorkerLogEntry {
        name: process_name,
        color: "",
        data,
    }) else {
        return;
    };
    append_worker_log_lines(worker_buffer, panel_id, &(line + "\n"));
}

fn append_pty_output_buffer(
    sessions: &Arc<Mutex<HashMap<String, PtyEntry>>>,
    id: &str,
    generation: u64,
    data: &str,
) -> Option<Option<String>> {
    let Ok(mut map) = sessions.lock() else {
        return None;
    };
    let Some(session) = map.get_mut(id).and_then(PtyEntry::active_mut) else {
        return None;
    };
    if session.generation != generation {
        return None;
    }
    session.output_buffer_bytes = session.output_buffer_bytes.saturating_add(data.len());
    session.output_buffer.push_back(data.to_string());
    while session.output_buffer_bytes > OUTPUT_REPLAY_MAX_BYTES {
        let Some(removed) = session.output_buffer.pop_front() else {
            session.output_buffer_bytes = 0;
            break;
        };
        session.output_buffer_bytes = session.output_buffer_bytes.saturating_sub(removed.len());
    }
    Some(session.owner_window.clone())
}

fn emit_pty_output(
    app: &HostContext,
    sessions: &Arc<Mutex<HashMap<String, PtyEntry>>>,
    worker_buffer: Option<&Arc<Mutex<HashMap<String, String>>>>,
    id: &str,
    generation: u64,
    data: String,
) {
    let Some(owner_window) = append_pty_output_buffer(sessions, id, generation, &data) else {
        return;
    };
    if let Some(worker_buffer) = worker_buffer {
        persist_worker_output(worker_buffer, id, &data);
    }
    let payload = json!(PtyOutputEvent {
        id: id.to_string(),
        data,
    });
    match owner_window {
        Some(window) => crate::event_hub::publish_runtime_event_to_window(
            app,
            &window,
            "pty:output",
            payload,
            "rust-pty",
        ),
        None => crate::event_hub::publish_runtime_event(app, "pty:output", payload, "rust-pty"),
    }
}

fn emit_pty_exit(app: &HostContext, id: &str, exit_code: i32, owner_window: Option<String>) {
    let payload = json!(PtyExitEvent {
        id: id.to_string(),
        exit_code,
    });
    match owner_window {
        Some(window) => crate::event_hub::publish_runtime_event_to_window(
            app, &window, "pty:exit", payload, "rust-pty",
        ),
        None => crate::event_hub::publish_runtime_event(app, "pty:exit", payload, "rust-pty"),
    }
}

fn output_flush_interval_ms(id: &str) -> u64 {
    if worker_parts_from_pty_id(id).is_some() {
        WORKER_OUTPUT_FLUSH_MS
    } else {
        INTERACTIVE_OUTPUT_FLUSH_MS
    }
}

fn spawn_output_coalescer(
    app: HostContext,
    id: String,
    generation: u64,
    sessions: Arc<Mutex<HashMap<String, PtyEntry>>>,
    worker_buffer: Option<Arc<Mutex<HashMap<String, String>>>>,
) -> (Sender<String>, Receiver<()>) {
    let (tx, rx) = mpsc::channel::<String>();
    let (done, done_rx) = pty_thread_completion();
    std::thread::spawn(move || {
        let _done = done;
        while let Ok(first) = rx.recv() {
            let mut pending = first;
            let deadline = Instant::now() + Duration::from_millis(output_flush_interval_ms(&id));
            loop {
                if pending.len() >= OUTPUT_FRAME_MAX_BYTES {
                    emit_pty_output(
                        &app,
                        &sessions,
                        worker_buffer.as_ref(),
                        &id,
                        generation,
                        std::mem::take(&mut pending),
                    );
                }
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(chunk) => {
                        pending.push_str(&chunk);
                        if pending.len() >= OUTPUT_FRAME_MAX_BYTES {
                            emit_pty_output(
                                &app,
                                &sessions,
                                worker_buffer.as_ref(),
                                &id,
                                generation,
                                std::mem::take(&mut pending),
                            );
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if !pending.is_empty() {
                            emit_pty_output(
                                &app,
                                &sessions,
                                worker_buffer.as_ref(),
                                &id,
                                generation,
                                pending,
                            );
                        }
                        return;
                    }
                }
            }

            if !pending.is_empty() {
                emit_pty_output(
                    &app,
                    &sessions,
                    worker_buffer.as_ref(),
                    &id,
                    generation,
                    pending,
                );
            }
        }
    });
    (tx, done_rx)
}

fn spawn_pty_input_writer(
    app: HostContext,
    id: String,
    mut writer: Box<dyn Write + Send>,
) -> (Sender<String>, Receiver<()>) {
    let (tx, rx) = mpsc::channel::<String>();
    let (done, done_rx) = pty_thread_completion();
    std::thread::spawn(move || {
        let _done = done;
        let mut trace_seq = 0u64;
        while let Ok(mut data) = rx.recv() {
            while let Ok(next) = rx.try_recv() {
                data.push_str(&next);
            }
            let trace_input = pty_input_trace_required(&data);
            if trace_input {
                trace_seq += 1;
                pty_input_debug_log(
                    &app,
                    format!(
                        "writer-thread seq={trace_seq} id={id} {}",
                        describe_pty_input(&data)
                    ),
                );
            }
            let write_result = writer
                .write_all(data.as_bytes())
                .and_then(|_| writer.flush());
            match write_result {
                Ok(()) if trace_input => {
                    pty_input_debug_log(
                        &app,
                        format!("writer-thread seq={trace_seq} id={id} write=ok"),
                    );
                }
                Ok(()) => {}
                Err(err) => {
                    pty_input_debug_log(&app, format!("writer-thread id={id} write=error {err}"));
                    break;
                }
            }
        }
        drop(writer);
    });
    (tx, done_rx)
}

fn wait_for_pty_thread(
    app: &HostContext,
    id: &str,
    generation: u64,
    thread_name: &str,
    done: &Receiver<()>,
    deadline: Instant,
) {
    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
        pty_lifecycle_log(
            app,
            format!("shutdown timeout id={id} generation={generation} thread={thread_name}"),
        );
        return;
    };
    match done.recv_timeout(remaining) {
        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {}
        Err(mpsc::RecvTimeoutError::Timeout) => pty_lifecycle_log(
            app,
            format!("shutdown timeout id={id} generation={generation} thread={thread_name}"),
        ),
    }
}

fn terminate_pty_child(
    app: &HostContext,
    id: &str,
    generation: u64,
    child: &mut (dyn Child + Send + Sync),
    deadline: Instant,
) {
    if let Err(err) = child.kill() {
        pty_lifecycle_log(
            app,
            format!("child kill failed id={id} generation={generation} error={err}"),
        );
    }
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(PTY_EXIT_POLL_INTERVAL);
            }
            Ok(None) => {
                pty_lifecycle_log(
                    app,
                    format!("child exit timeout id={id} generation={generation}"),
                );
                return;
            }
            Err(err) => {
                pty_lifecycle_log(
                    app,
                    format!("child wait failed id={id} generation={generation} error={err}"),
                );
                return;
            }
        }
    }
}

fn shutdown_pty_session(
    app: &HostContext,
    id: &str,
    session: PtySession,
    terminate_child: bool,
    wait_for_exit_watcher: bool,
) {
    let deadline = Instant::now() + PTY_SHUTDOWN_TIMEOUT;
    let PtySession {
        generation,
        write_tx,
        master,
        mut child,
        writer_done,
        reader_done,
        output_done,
        exit_done,
        ..
    } = session;

    pty_lifecycle_log(
        app,
        format!("shutdown start id={id} generation={generation}"),
    );

    // Once the map entry has been removed, the old watcher must observe that
    // fact before a same-id replacement is allowed to appear. Otherwise it can
    // accidentally poll or remove the replacement (an ABA race).
    if wait_for_exit_watcher {
        wait_for_pty_thread(app, id, generation, "exit", &exit_done, deadline);
    }

    if terminate_child {
        terminate_pty_child(app, id, generation, child.as_mut(), deadline);
    }

    // Close input first and let its owner thread release the pipe. Keep the
    // output reader alive while ClosePseudoConsole runs so ConPTY can drain its
    // final output, then wait for both reader and coalescer to finish before a
    // same-id session is created.
    drop(write_tx);
    wait_for_pty_thread(app, id, generation, "writer", &writer_done, deadline);
    drop(master);
    wait_for_pty_thread(app, id, generation, "reader", &reader_done, deadline);
    wait_for_pty_thread(app, id, generation, "output", &output_done, deadline);
    drop(child);

    pty_lifecycle_log(
        app,
        format!("shutdown done id={id} generation={generation}"),
    );
}

fn take_active_pty_session(state: &PtyState, id: &str) -> Result<Option<PtySession>, CommandError> {
    let entry = state
        .inner
        .lock()
        .map_err(|e| CommandError {
            message: e.to_string(),
        })?
        .remove(id);
    Ok(match entry {
        Some(PtyEntry::Active(session)) => Some(session),
        Some(PtyEntry::Starting { .. }) | None => None,
    })
}

fn take_active_pty_session_for_generation(
    sessions: &Arc<Mutex<HashMap<String, PtyEntry>>>,
    id: &str,
    generation: u64,
) -> Option<PtySession> {
    let Ok(mut map) = sessions.lock() else {
        return None;
    };
    let is_current = matches!(
        map.get(id),
        Some(PtyEntry::Active(session)) if session.generation == generation
    );
    if !is_current {
        return None;
    }
    match map.remove(id) {
        Some(PtyEntry::Active(session)) => Some(session),
        _ => None,
    }
}

/// Accumulates PTY reader bytes across `read()` calls so a UTF-8 codepoint
/// split across a chunk boundary decodes correctly instead of turning into
/// U+FFFD. Bytes that are genuinely invalid UTF-8 (not just an incomplete
/// trailing sequence) are still replaced with U+FFFD immediately, matching
/// `String::from_utf8_lossy`'s behavior, so `pending` never grows past the
/// handful of bytes a valid UTF-8 sequence can leave incomplete.
struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// Decode a newly read chunk, prefixed with any bytes held back from the
    /// previous call. Bytes that look like the start of a still-incomplete
    /// UTF-8 sequence at the end of the combined buffer are kept in
    /// `self.pending` for the next call instead of being lossy-replaced.
    fn decode(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(bytes);
        let mut out = String::with_capacity(buf.len());
        let mut remaining: &[u8] = &buf;
        loop {
            match std::str::from_utf8(remaining) {
                Ok(valid) => {
                    out.push_str(valid);
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    out.push_str(
                        std::str::from_utf8(&remaining[..valid_up_to])
                            .expect("valid_up_to always points at a valid UTF-8 boundary"),
                    );
                    match err.error_len() {
                        Some(bad_len) => {
                            // Genuinely invalid bytes: replace immediately so
                            // pending never accumulates them.
                            out.push('\u{FFFD}');
                            remaining = &remaining[valid_up_to + bad_len..];
                        }
                        None => {
                            // Trailing bytes look like the start of a valid
                            // sequence that the next read will complete.
                            self.pending = remaining[valid_up_to..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// Flush any bytes still held back once the reader hits EOF or an error,
    /// so a truncated trailing sequence is surfaced (lossily) instead of
    /// silently dropped.
    fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        Some(String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned())
    }
}

pub(crate) fn start_pty_session(
    app: &HostContext,
    map_handle: Arc<Mutex<HashMap<String, PtyEntry>>>,
    worker_buffer_handle: Option<Arc<Mutex<HashMap<String, String>>>>,
    options: CreatePtyOptions,
    owner_window: Option<String>,
) -> Result<String, CommandError> {
    if !is_valid_pty_id(&options.id) {
        return Err(CommandError {
            message: format!("invalid pty id: {:?}", options.id),
        });
    }
    let mut reservation = PtyStartReservation::reserve(Arc::clone(&map_handle), &options.id)?;
    let generation = reservation.generation;
    let pty_system = native_pty_system();
    let cols = options
        .cols
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_PTY_COLS);
    let rows = options
        .rows
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_PTY_ROWS);
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| CommandError {
            message: e.to_string(),
        })?;
    #[cfg(target_family = "unix")]
    configure_initial_pty_termios(app, &options.id, pair.master.as_ref());
    let app_data_dir = app.data_dir_opt();
    let cmd = build_command(&options, app_data_dir.as_deref());
    pty_input_debug_log(
        app,
        format!(
            "session-start id={} generation={} term={:?} colorterm={:?}",
            options.id,
            generation,
            cmd.get_env("TERM").and_then(|value| value.to_str()),
            cmd.get_env("COLORTERM").and_then(|value| value.to_str())
        ),
    );
    let child = pair.slave.spawn_command(cmd).map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    let (write_tx, writer_done) = spawn_pty_input_writer(app.clone(), options.id.clone(), writer);
    let mut reader = pair.master.try_clone_reader().map_err(|e| CommandError {
        message: e.to_string(),
    })?;

    // Reader thread: pump bytes from PTY → coalesced pty:output events.
    // PTYs can split a UTF-8 codepoint across reads, so decode through
    // Utf8ChunkDecoder to stitch valid split sequences back together;
    // only genuinely invalid bytes become U+FFFD.
    let id_for_reader = options.id.clone();
    let app_for_reader = app.clone();
    let (output_tx, output_done) = spawn_output_coalescer(
        app.clone(),
        id_for_reader.clone(),
        generation,
        Arc::clone(&map_handle),
        worker_buffer_handle.clone(),
    );
    let (reader_thread_done, reader_done) = pty_thread_completion();
    let (exit_thread_done, exit_done) = pty_thread_completion();
    let map_for_exit = Arc::clone(&map_handle);

    let session = PtySession {
        generation,
        write_tx,
        master: pair.master,
        child,
        writer_done,
        reader_done,
        output_done,
        exit_done,
        cwd: options.cwd.clone(),
        kind: options.r#type.clone(),
        viewport: desktop_viewport_state(cols, rows),
        output_buffer: VecDeque::new(),
        output_buffer_bytes: 0,
        owner_window,
    };

    // Commit only if our reservation is still present. A stop arriving while
    // CreateProcessW was running removes the reservation and cancels this
    // start instead of allowing a just-closed panel to leak a new PTY.
    let mut map = map_handle.lock().map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    let reservation_is_current = matches!(
        map.get(&options.id),
        Some(PtyEntry::Starting { generation: current }) if *current == generation
    );
    if !reservation_is_current {
        drop(map);
        drop(output_tx);
        drop(reader);
        drop(reader_thread_done);
        drop(exit_thread_done);
        shutdown_pty_session(app, &options.id, session, true, false);
        return Err(CommandError {
            message: format!("pty session {} start was cancelled", options.id),
        });
    }
    map.insert(options.id.clone(), PtyEntry::Active(session));
    reservation.commit();

    std::thread::spawn(move || {
        let _done = reader_thread_done;
        let mut buf = [0u8; 4096];
        let mut decoder = Utf8ChunkDecoder::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if let Some(tail) = decoder.flush() {
                        let _ = output_tx.send(tail);
                    }
                    break;
                }
                Ok(n) => {
                    if pty_output_debug_enabled() && pty_output_bytes_trace_required(&buf[..n]) {
                        pty_output_debug_log(
                            &app_for_reader,
                            format!(
                                "reader id={id_for_reader} generation={generation} {}",
                                describe_pty_bytes(&buf[..n])
                            ),
                        );
                    }
                    let chunk = decoder.decode(&buf[..n]);
                    if !chunk.is_empty() && output_tx.send(chunk).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    if let Some(tail) = decoder.flush() {
                        let _ = output_tx.send(tail);
                    }
                    break;
                }
            }
        }
        drop(output_tx);
        drop(reader);
    });

    // Exit watcher: poll try_wait on the session's child every 100ms,
    // emit pty:exit, and tear down only the generation that it owns.
    let id_for_exit = options.id.clone();
    let app_for_exit = app.clone();
    std::thread::spawn(move || {
        let _done = exit_thread_done;
        loop {
            let poll = {
                let mut map = match map_for_exit.lock() {
                    Ok(m) => m,
                    Err(err) => {
                        pty_lifecycle_log(
                            &app_for_exit,
                            format!(
                                "exit watcher lock failed id={id_for_exit} generation={generation} error={err}"
                            ),
                        );
                        break;
                    }
                };
                let session = match map.get_mut(&id_for_exit).and_then(PtyEntry::active_mut) {
                    Some(session) if session.generation == generation => session,
                    _ => break,
                };
                match session.child.try_wait() {
                    Ok(Some(status)) => PtyExitPoll::Exited(status.exit_code() as i32),
                    Ok(None) => PtyExitPoll::Running,
                    Err(err) => PtyExitPoll::Failed(err.to_string()),
                }
            };
            match poll {
                PtyExitPoll::Running => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                PtyExitPoll::Exited(code) => {
                    if let Some(session) = take_active_pty_session_for_generation(
                        &map_for_exit,
                        &id_for_exit,
                        generation,
                    ) {
                        let owner_window = session.owner_window.clone();
                        emit_pty_exit(&app_for_exit, &id_for_exit, code, owner_window);
                        shutdown_pty_session(&app_for_exit, &id_for_exit, session, false, false);
                    }
                    break;
                }
                PtyExitPoll::Failed(err) => {
                    pty_lifecycle_log(
                        &app_for_exit,
                        format!(
                            "exit watcher failed id={id_for_exit} generation={generation} error={err}"
                        ),
                    );
                    if let Some(session) = take_active_pty_session_for_generation(
                        &map_for_exit,
                        &id_for_exit,
                        generation,
                    ) {
                        let owner_window = session.owner_window.clone();
                        emit_pty_exit(&app_for_exit, &id_for_exit, 1, owner_window);
                        shutdown_pty_session(&app_for_exit, &id_for_exit, session, true, false);
                    }
                    break;
                }
            }
        }
    });
    drop(map);

    pty_lifecycle_log(
        app,
        format!("session started id={} generation={generation}", options.id),
    );

    Ok(options.id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn pty_create(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    worker_buffer: State<'_, WorkerBufferState>,
    options: CreatePtyOptions,
) -> Result<String, CommandError> {
    if let Some(result) =
        remote_value_for_window(&app, &window, "pty:create", vec![json!(options.clone())])
    {
        return result;
    }
    let handle = state.handle();
    let worker_buffer_handle = worker_buffer.handle();
    let owner_window = Some(window.label().to_string());
    crate::async_rt::spawn_blocking(move || {
        start_pty_session(
            &crate::host_context::HostContext::from_app(app.clone()),
            handle,
            Some(worker_buffer_handle),
            options,
            owner_window,
        )
    })
    .await
    .map_err(|e| CommandError {
        message: format!("pty.create worker failed: {e}"),
    })?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_write(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), CommandError> {
    let trace_input = pty_input_trace_required(&data);
    if let Some(result) = remote_unit_for_window(
        &app,
        &window,
        "pty:write",
        vec![json!(id.clone()), json!(data.clone())],
    ) {
        if trace_input {
            pty_input_debug_log(
                &crate::host_context::HostContext::from_app(app.clone()),
                format!("route=remote id={id} {}", describe_pty_input(&data)),
            );
        }
        return result;
    }
    if trace_input {
        pty_input_debug_log(
            &crate::host_context::HostContext::from_app(app.clone()),
            format!("route=local id={id} {}", describe_pty_input(&data)),
        );
    }
    claim_pty_session(&state, &id, window.label())?;
    let result = write_pty_session(&state, &id, &data);
    if trace_input {
        match &result {
            Ok(()) => pty_input_debug_log(
                &crate::host_context::HostContext::from_app(app.clone()),
                format!("route=local id={id} enqueue=ok"),
            ),
            Err(err) => pty_input_debug_log(
                &crate::host_context::HostContext::from_app(app.clone()),
                format!("route=local id={id} enqueue=error {}", err.message),
            ),
        }
    }
    result
}

pub(crate) fn write_pty_session(
    state: &PtyState,
    id: &str,
    data: &str,
) -> Result<(), CommandError> {
    state.with_session(&id, |s| {
        s.write_tx
            .send(data.to_string())
            .map_err(|_| CommandError {
                message: format!("pty session {id} input writer closed"),
            })?;
        Ok(())
    })
}

fn claim_pty_session(state: &PtyState, id: &str, window_label: &str) -> Result<(), CommandError> {
    state.with_session(id, |session| {
        session.owner_window = Some(window_label.to_string());
        Ok(())
    })
}

fn pty_output_buffer_text(session: &PtySession) -> String {
    let mut output = String::with_capacity(session.output_buffer_bytes);
    for chunk in &session.output_buffer {
        output.push_str(chunk);
    }
    output
}

pub(crate) fn read_pty_output_buffer(state: &PtyState, id: &str) -> Result<String, CommandError> {
    let map = state.inner.lock().map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    map.get(id)
        .and_then(PtyEntry::active)
        .map(pty_output_buffer_text)
        .ok_or_else(|| CommandError {
            message: format!("pty session {id} not found"),
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_read_buffer(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
) -> Result<String, CommandError> {
    if let Some(result) =
        remote_value_for_window(&app, &window, "pty:read-buffer", vec![json!(id.clone())])
    {
        return result;
    }
    state.with_session(&id, |session| {
        session.owner_window = Some(window.label().to_string());
        Ok(pty_output_buffer_text(session))
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_resize(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    if let Some(result) = remote_unit_for_window(
        &app,
        &window,
        "pty:resize",
        vec![json!(id.clone()), json!(cols), json!(rows)],
    ) {
        return result;
    }
    claim_pty_session(&state, &id, window.label())?;
    resize_pty_session_from_desktop(
        &crate::host_context::HostContext::from_app(app.clone()),
        &state,
        &id,
        cols,
        rows,
    )
    .map(|_| ())
}

pub(crate) fn get_pty_viewport_state(
    state: &PtyState,
    id: &str,
) -> Result<TerminalViewportState, CommandError> {
    let map = state.inner.lock().map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    map.get(id)
        .and_then(PtyEntry::active)
        .map(|session| session.viewport.clone())
        .ok_or_else(|| CommandError {
            message: format!("pty session {id} not found"),
        })
}

fn set_pty_viewport_size_for_source(
    app: &HostContext,
    state: &PtyState,
    id: &str,
    cols: u16,
    rows: u16,
    source: TerminalViewportSource,
) -> Result<(TerminalViewportState, bool), CommandError> {
    validate_pty_size(cols, rows)?;
    let (viewport, applied) = state.with_session(id, |session| {
        if session.viewport.mode == TerminalViewportMode::Desktop
            && source == TerminalViewportSource::Mobile
        {
            return Ok((session.viewport.clone(), false));
        }

        session.viewport.cols = cols;
        session.viewport.rows = rows;
        session.viewport.updated_by = source;
        session.viewport.updated_at = unix_ms();
        let next = session.viewport.clone();
        resize_session(session, cols, rows)?;
        Ok((next, true))
    })?;
    if applied {
        emit_viewport_state(app, state, id, &viewport);
    }
    Ok((viewport, applied))
}

pub(crate) fn resize_pty_session_from_desktop(
    app: &HostContext,
    state: &PtyState,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<bool, CommandError> {
    let (_, applied) = set_pty_viewport_size_for_source(
        app,
        state,
        id,
        cols,
        rows,
        TerminalViewportSource::Desktop,
    )?;
    Ok(applied)
}

pub(crate) fn resize_pty_session_from_mobile_view(
    app: &HostContext,
    state: &PtyState,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<bool, CommandError> {
    let (_, applied) = set_pty_viewport_size_for_source(
        app,
        state,
        id,
        cols,
        rows,
        TerminalViewportSource::Mobile,
    )?;
    Ok(applied)
}

pub(crate) fn set_pty_viewport_mode(
    app: &HostContext,
    state: &PtyState,
    id: &str,
    mode: TerminalViewportMode,
    options: Option<SetViewportModeOptions>,
) -> Result<TerminalViewportState, CommandError> {
    let opts = options.unwrap_or_default();
    let next = state.with_session(id, |session| {
        let now = unix_ms();
        match mode {
            TerminalViewportMode::Mobile => {
                let cols = positive_size(opts.cols, MOBILE_TERMINAL_COLS);
                let rows = positive_size(opts.rows, MOBILE_TERMINAL_ROWS);
                validate_pty_size(cols, rows)?;
                session.viewport = TerminalViewportState {
                    mode,
                    cols,
                    rows,
                    updated_by: opts.source,
                    updated_at: now,
                };
                let next = session.viewport.clone();
                resize_session(session, cols, rows)?;
                Ok(next)
            }
            TerminalViewportMode::Desktop => {
                let cols = if opts.source == TerminalViewportSource::Desktop {
                    positive_size(opts.cols, session.viewport.cols)
                } else {
                    session.viewport.cols
                };
                let rows = if opts.source == TerminalViewportSource::Desktop {
                    positive_size(opts.rows, session.viewport.rows)
                } else {
                    session.viewport.rows
                };
                validate_pty_size(cols, rows)?;
                let resize_now = opts.source == TerminalViewportSource::Desktop
                    && (opts.cols.is_some() || opts.rows.is_some());
                session.viewport = TerminalViewportState {
                    mode,
                    cols,
                    rows,
                    updated_by: opts.source,
                    updated_at: now,
                };
                let next = session.viewport.clone();
                if resize_now {
                    resize_session(session, cols, rows)?;
                }
                Ok(next)
            }
        }
    })?;
    emit_viewport_state(app, state, id, &next);
    Ok(next)
}

pub(crate) fn set_pty_viewport_size(
    app: &HostContext,
    state: &PtyState,
    id: &str,
    cols: u16,
    rows: u16,
    source: TerminalViewportSource,
) -> Result<TerminalViewportState, CommandError> {
    let (viewport, _) = set_pty_viewport_size_for_source(app, state, id, cols, rows, source)?;
    Ok(viewport)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_get_viewport_state(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
) -> Result<TerminalViewportState, CommandError> {
    if let Some(result) = remote_value_for_window(
        &app,
        &window,
        "pty:get-viewport-state",
        vec![json!(id.clone())],
    ) {
        return result;
    }
    claim_pty_session(&state, &id, window.label())?;
    get_pty_viewport_state(&state, &id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_set_viewport_mode(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    mode: TerminalViewportMode,
    options: Option<SetViewportModeOptions>,
) -> Result<TerminalViewportState, CommandError> {
    if let Some(result) = remote_value_for_window(
        &app,
        &window,
        "pty:set-viewport-mode",
        vec![
            json!(id.clone()),
            json!(mode.clone()),
            json!(options.clone()),
        ],
    ) {
        return result;
    }
    claim_pty_session(&state, &id, window.label())?;
    set_pty_viewport_mode(
        &crate::host_context::HostContext::from_app(app.clone()),
        &state,
        &id,
        mode,
        options,
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_set_viewport_size(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    source: TerminalViewportSource,
) -> Result<TerminalViewportState, CommandError> {
    if let Some(result) = remote_value_for_window(
        &app,
        &window,
        "pty:set-viewport-size",
        vec![
            json!(id.clone()),
            json!(cols),
            json!(rows),
            json!(source.clone()),
        ],
    ) {
        return result;
    }
    claim_pty_session(&state, &id, window.label())?;
    set_pty_viewport_size(
        &crate::host_context::HostContext::from_app(app.clone()),
        &state,
        &id,
        cols,
        rows,
        source,
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_kill(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
) -> Result<(), CommandError> {
    if let Some(result) = remote_unit_for_window(&app, &window, "pty:kill", vec![json!(id.clone())])
    {
        return result;
    }
    kill_pty_session_with_exit(
        &crate::host_context::HostContext::from_app(app.clone()),
        &state,
        &id,
    )
}

pub(crate) fn kill_pty_session(
    app: &HostContext,
    state: &PtyState,
    id: &str,
) -> Result<(), CommandError> {
    if let Some(session) = take_active_pty_session(state, id)? {
        shutdown_pty_session(app, id, session, true, true);
    }
    Ok(())
}

pub(crate) fn kill_pty_session_with_exit(
    app: &HostContext,
    state: &PtyState,
    id: &str,
) -> Result<(), CommandError> {
    if let Some(session) = take_active_pty_session(state, id)? {
        let owner_window = session.owner_window.clone();
        shutdown_pty_session(app, id, session, true, true);
        emit_pty_exit(app, id, 0, owner_window);
    }
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn pty_restart(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    cwd: String,
    shell: Option<String>,
) -> Result<bool, CommandError> {
    if let Some(result) = remote_value_for_window(
        &app,
        &window,
        "pty:restart",
        vec![json!(id.clone()), json!(cwd.clone()), json!(shell.clone())],
    ) {
        return result;
    }
    let state = (*state).clone();
    crate::async_rt::spawn_blocking(move || {
        pty_restart_impl(
            crate::host_context::HostContext::from_app(app),
            state,
            id,
            cwd,
            shell,
        )
    })
    .await
    .map_err(|e| CommandError {
        message: format!("pty.restart worker failed: {e}"),
    })?
}

pub(crate) async fn pty_restart_native(
    app: HostContext,
    state: PtyState,
    id: String,
    cwd: String,
    shell: Option<String>,
) -> Result<bool, CommandError> {
    crate::async_rt::spawn_blocking(move || pty_restart_impl(app, state, id, cwd, shell))
        .await
        .map_err(|e| CommandError {
            message: format!("pty.restart worker failed: {e}"),
        })?
}

fn pty_restart_impl(
    app: HostContext,
    state: PtyState,
    id: String,
    cwd: String,
    shell: Option<String>,
) -> Result<bool, CommandError> {
    let Some(session) = take_active_pty_session(&state, &id)? else {
        return Ok(false);
    };
    let kind = session.kind.clone();
    let viewport = session.viewport.clone();
    let owner_window = session.owner_window.clone();
    shutdown_pty_session(&app, &id, session, true, true);

    start_pty_session(
        &app,
        state.handle(),
        None,
        CreatePtyOptions {
            id: id.clone(),
            cwd,
            r#type: kind,
            shell,
            command: None,
            args: None,
            cols: Some(viewport.cols),
            rows: Some(viewport.rows),
            agent_preset: None,
            custom_env: None,
            per_terminal_history: None,
            history_key: None,
        },
        owner_window,
    )?;
    {
        let mut map = state.inner.lock().map_err(|e| CommandError {
            message: e.to_string(),
        })?;
        if let Some(session) = map.get_mut(&id).and_then(PtyEntry::active_mut) {
            session.viewport = viewport;
        }
    }
    Ok(true)
}

pub(crate) fn get_pty_cwd(state: &PtyState, id: &str) -> Result<Option<String>, CommandError> {
    let map = state.inner.lock().map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    Ok(map
        .get(id)
        .and_then(PtyEntry::active)
        .map(|session| session.cwd.clone()))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn pty_get_cwd(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
) -> Result<Option<String>, CommandError> {
    if let Some(result) =
        remote_value_for_window(&app, &window, "pty:get-cwd", vec![json!(id.clone())])
    {
        return result;
    }
    get_pty_cwd(&state, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{ChildKiller, ExitStatus};
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    struct FakeMasterPty {
        registry: Option<Arc<Mutex<HashMap<String, PtyEntry>>>>,
        dropped_outside_registry_lock: Option<Arc<AtomicBool>>,
    }

    impl FakeMasterPty {
        fn plain() -> Self {
            Self {
                registry: None,
                dropped_outside_registry_lock: None,
            }
        }

        fn with_drop_probe(
            registry: Arc<Mutex<HashMap<String, PtyEntry>>>,
            dropped_outside_registry_lock: Arc<AtomicBool>,
        ) -> Self {
            Self {
                registry: Some(registry),
                dropped_outside_registry_lock: Some(dropped_outside_registry_lock),
            }
        }
    }

    impl Drop for FakeMasterPty {
        fn drop(&mut self) {
            let (Some(registry), Some(dropped_outside_registry_lock)) =
                (&self.registry, &self.dropped_outside_registry_lock)
            else {
                return;
            };
            dropped_outside_registry_lock
                .store(registry.try_lock().is_ok(), AtomicOrdering::SeqCst);
        }
    }

    impl MasterPty for FakeMasterPty {
        fn resize(&self, _size: PtySize) -> anyhow::Result<()> {
            Ok(())
        }

        fn get_size(&self) -> anyhow::Result<PtySize> {
            Ok(PtySize {
                rows: DEFAULT_PTY_ROWS,
                cols: DEFAULT_PTY_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
        }

        fn try_clone_reader(&self) -> anyhow::Result<Box<dyn Read + Send>> {
            Ok(Box::new(std::io::Cursor::new(Vec::<u8>::new())))
        }

        fn take_writer(&self) -> anyhow::Result<Box<dyn Write + Send>> {
            Ok(Box::new(std::io::sink()))
        }

        #[cfg(unix)]
        fn process_group_leader(&self) -> Option<libc::pid_t> {
            None
        }

        #[cfg(unix)]
        fn as_raw_fd(&self) -> Option<std::os::fd::RawFd> {
            None
        }
    }

    #[derive(Debug, Clone)]
    struct FakeChild {
        killed: Arc<AtomicBool>,
    }

    impl FakeChild {
        fn new() -> Self {
            Self {
                killed: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    impl ChildKiller for FakeChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed.store(true, AtomicOrdering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl Child for FakeChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            Ok(self
                .killed
                .load(AtomicOrdering::SeqCst)
                .then(|| ExitStatus::with_exit_code(0)))
        }

        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            self.killed.store(true, AtomicOrdering::SeqCst);
            Ok(ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            Some(1)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    fn disconnected_completion() -> Receiver<()> {
        let (tx, rx) = mpsc::channel();
        drop(tx);
        rx
    }

    fn fake_session(generation: u64, master: FakeMasterPty) -> PtySession {
        let (write_tx, write_rx) = mpsc::channel::<String>();
        drop(write_rx);
        PtySession {
            generation,
            write_tx,
            master: Box::new(master),
            child: Box::new(FakeChild::new()),
            writer_done: disconnected_completion(),
            reader_done: disconnected_completion(),
            output_done: disconnected_completion(),
            exit_done: disconnected_completion(),
            cwd: ".".into(),
            kind: "terminal".into(),
            viewport: desktop_viewport_state(DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS),
            output_buffer: VecDeque::new(),
            output_buffer_bytes: 0,
            owner_window: None,
        }
    }

    #[test]
    fn start_reservation_is_atomic_and_released_on_drop() {
        let state = PtyState::default();
        let first = PtyStartReservation::reserve(state.handle(), "same-id").unwrap();

        let duplicate = PtyStartReservation::reserve(state.handle(), "same-id");
        assert!(duplicate.is_err());
        assert_eq!(
            state
                .inner
                .lock()
                .unwrap()
                .get("same-id")
                .map(PtyEntry::generation),
            Some(first.generation)
        );

        drop(first);
        assert!(!state.inner.lock().unwrap().contains_key("same-id"));
    }

    #[test]
    fn stale_generation_cannot_append_to_or_remove_replacement() {
        let state = PtyState::default();
        state.inner.lock().unwrap().insert(
            "same-id".into(),
            PtyEntry::Active(fake_session(2, FakeMasterPty::plain())),
        );

        assert_eq!(
            append_pty_output_buffer(&state.inner, "same-id", 1, "stale"),
            None
        );
        assert!(take_active_pty_session_for_generation(&state.inner, "same-id", 1).is_none());
        assert_eq!(
            append_pty_output_buffer(&state.inner, "same-id", 2, "current"),
            Some(None)
        );

        let current = take_active_pty_session_for_generation(&state.inner, "same-id", 2)
            .expect("current generation should still be registered");
        assert_eq!(
            current.output_buffer.into_iter().collect::<String>(),
            "current"
        );
    }

    #[test]
    fn taking_session_releases_registry_lock_before_resource_drop() {
        let state = PtyState::default();
        let dropped_outside_registry_lock = Arc::new(AtomicBool::new(false));
        state.inner.lock().unwrap().insert(
            "restart-id".into(),
            PtyEntry::Active(fake_session(
                3,
                FakeMasterPty::with_drop_probe(
                    state.handle(),
                    Arc::clone(&dropped_outside_registry_lock),
                ),
            )),
        );

        let session = take_active_pty_session(&state, "restart-id")
            .unwrap()
            .expect("active session should be removed");
        drop(session);

        assert!(dropped_outside_registry_lock.load(AtomicOrdering::SeqCst));
    }

    #[cfg(all(target_os = "windows", not(feature = "desktop")))]
    #[test]
    fn rapid_windows_conpty_restart_reuses_id_safely() {
        use crate::event_hub::RuntimeEventHubState;
        use crate::host_context::HeadlessHost;

        let sink: crate::sidecar::EventSink = Arc::new(|_, _| {});
        let mut host = HeadlessHost::new(None, sink);
        host.manage(RuntimeEventHubState::default());
        let app = HostContext::from_headless(Arc::new(host));
        let state = PtyState::default();

        for iteration in 0..8 {
            let id = "rapid-restart";
            start_pty_session(
                &app,
                state.handle(),
                None,
                CreatePtyOptions {
                    id: id.into(),
                    cwd: ".".into(),
                    r#type: "terminal".into(),
                    shell: None,
                    command: Some("cmd.exe".into()),
                    args: Some(vec!["/Q".into(), "/K".into()]),
                    cols: Some(80),
                    rows: Some(24),
                    agent_preset: None,
                    custom_env: None,
                    per_terminal_history: None,
                    history_key: None,
                },
                None,
            )
            .unwrap_or_else(|err| panic!("iteration {iteration} failed to start: {err:?}"));
            kill_pty_session(&app, &state, id)
                .unwrap_or_else(|err| panic!("iteration {iteration} failed to stop: {err:?}"));
            assert!(state.inner.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn ids_must_be_non_empty_and_non_control() {
        assert!(is_valid_pty_id("term-1"));
        assert!(is_valid_pty_id("a"));
        assert!(!is_valid_pty_id(""));
        assert!(!is_valid_pty_id("with\nnewline"));
        assert!(!is_valid_pty_id("with\0null"));
        // Length cap: 256 chars is fine, 257 is not.
        let long = "a".repeat(256);
        assert!(is_valid_pty_id(&long));
        let too_long = "a".repeat(257);
        assert!(!is_valid_pty_id(&too_long));
    }

    #[test]
    fn worker_pty_id_parts_are_detected() {
        assert_eq!(
            worker_parts_from_pty_id("terminal-1__w__typecheck"),
            Some(("terminal-1", "typecheck"))
        );
        assert_eq!(worker_parts_from_pty_id("terminal-1"), None);
        assert_eq!(worker_parts_from_pty_id("__w__typecheck"), None);
        assert_eq!(worker_parts_from_pty_id("terminal-1__w__"), None);
    }

    #[test]
    fn worker_output_batches_more_aggressively_than_interactive_output() {
        assert_eq!(output_flush_interval_ms("terminal-1"), 16);
        assert_eq!(output_flush_interval_ms("terminal-1__w__typecheck"), 33);
    }

    #[test]
    fn select_shell_uses_explicit_option_when_provided() {
        let none = |_: &str| false;
        assert_eq!(select_shell(Some("/bin/zsh"), "unix", &none), "/bin/zsh");
        // Empty / whitespace falls back to auto-resolve.
        let auto = select_shell(None, "unix", &none);
        assert_eq!(select_shell(Some("   "), "unix", &none), auto);
        assert_eq!(select_shell(Some(""), "unix", &none), auto);
    }

    #[test]
    fn select_shell_auto_falls_back_per_platform() {
        let none = |_: &str| false;
        // posix_auto_shell returns /bin/bash on Linux when $SHELL is unset
        // (or the existing value isn't on disk per `exists`).
        let unix = select_shell(None, "unix", &none);
        assert!(unix.starts_with("/bin/"));

        // On Windows with no PowerShell installs detected, auto returns
        // powershell.exe (matches settings::resolve_shell_path).
        let win = select_shell(None, "windows", &none);
        assert_eq!(win, "powershell.exe");
    }

    #[test]
    fn history_file_name_prefers_sanitized_history_key() {
        let opts = CreatePtyOptions {
            id: "term-1".into(),
            cwd: ".".into(),
            r#type: "terminal".into(),
            shell: None,
            command: None,
            args: None,
            cols: None,
            rows: None,
            agent_preset: None,
            custom_env: None,
            per_terminal_history: Some(true),
            history_key: Some("workspace:one/term".into()),
        };
        assert_eq!(history_file_name(&opts), "workspace_one_term_history");
    }

    #[test]
    fn history_file_name_hashes_id_without_key() {
        let opts = CreatePtyOptions {
            id: "term-1".into(),
            cwd: ".".into(),
            r#type: "terminal".into(),
            shell: None,
            command: None,
            args: None,
            cols: None,
            rows: None,
            agent_preset: None,
            custom_env: None,
            per_terminal_history: Some(true),
            history_key: None,
        };
        assert!(history_file_name(&opts).ends_with("_history"));
        assert_ne!(history_file_name(&opts), "term-1_history");
    }

    #[test]
    fn viewport_state_defaults_to_desktop_layout() {
        let state = desktop_viewport_state(120, 40);
        assert_eq!(state.mode, TerminalViewportMode::Desktop);
        assert_eq!(state.cols, 120);
        assert_eq!(state.rows, 40);
        assert_eq!(state.updated_by, TerminalViewportSource::Desktop);
    }

    #[test]
    fn viewport_size_rejects_zero_dimensions() {
        assert!(validate_pty_size(56, 24).is_ok());
        assert!(validate_pty_size(0, 24).is_err());
        assert!(validate_pty_size(56, 0).is_err());
    }

    #[test]
    fn zsh_wrapper_files_match_electron_shape() {
        let root = std::env::temp_dir().join(format!(
            "bat-zsh-wrapper-test-{}-{}",
            std::process::id(),
            hash_history_key("wrapper")
        ));
        let _ = fs::remove_dir_all(&root);
        ensure_zsh_wrapper(&root).unwrap();
        let zshrc = fs::read_to_string(root.join(".zshrc")).unwrap();
        assert!(zshrc.contains("source \"${_BAT_ZDOTDIR:-$HOME}/.zshrc\""));
        assert!(zshrc.contains("export HISTFILE=\"$_BAT_HISTFILE\""));
        assert!(zshrc.contains("setopt INC_APPEND_HISTORY"));
        assert!(root.join(".zshenv").exists());
        assert!(root.join(".zprofile").exists());
        assert!(root.join(".zlogin").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn build_command_uses_login_shell_on_unix() {
        let opts = CreatePtyOptions {
            id: "term-login".into(),
            cwd: ".".into(),
            r#type: "terminal".into(),
            shell: Some("/bin/zsh".into()),
            command: None,
            args: None,
            cols: None,
            rows: None,
            agent_preset: None,
            custom_env: None,
            per_terminal_history: None,
            history_key: None,
        };
        let cmd = build_command(&opts, None);
        assert!(cmd.is_default_prog());
        assert_eq!(
            cmd.get_env("SHELL").and_then(|v| v.to_str()),
            Some("/bin/zsh")
        );
        assert_eq!(
            cmd.get_env("TERM").and_then(|value| value.to_str()),
            Some("xterm-256color")
        );
        assert_eq!(
            cmd.get_env("COLORTERM").and_then(|value| value.to_str()),
            Some("truecolor")
        );
    }

    #[test]
    fn build_command_uses_direct_program_when_provided() {
        let opts = CreatePtyOptions {
            id: "term-direct".into(),
            cwd: ".".into(),
            r#type: "terminal".into(),
            shell: Some("ignored-shell".into()),
            command: Some("claude".into()),
            args: Some(vec![
                "--settings".into(),
                "settings.json".into(),
                "--session-id".into(),
                "abc".into(),
            ]),
            cols: Some(132),
            rows: Some(36),
            agent_preset: None,
            custom_env: Some(HashMap::from([(
                "CLAUDE_CODE_NO_FLICKER".into(),
                "1".into(),
            )])),
            per_terminal_history: Some(true),
            history_key: Some("should-not-matter".into()),
        };
        let cmd = build_command(&opts, None);
        assert!(!cmd.is_default_prog());
        assert_eq!(
            cmd.get_argv()
                .iter()
                .map(|value| value.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
            vec![
                "claude",
                "--settings",
                "settings.json",
                "--session-id",
                "abc"
            ]
        );
        assert_eq!(
            cmd.get_env("CLAUDE_CODE_NO_FLICKER")
                .and_then(|value| value.to_str()),
            Some("1")
        );
        assert_eq!(
            cmd.get_env("TERM").and_then(|value| value.to_str()),
            Some("xterm-256color")
        );
    }

    #[test]
    fn custom_env_can_override_terminal_env() {
        let opts = CreatePtyOptions {
            id: "term-env".into(),
            cwd: ".".into(),
            r#type: "terminal".into(),
            shell: Some("/bin/zsh".into()),
            command: None,
            args: None,
            cols: None,
            rows: None,
            agent_preset: None,
            custom_env: Some(HashMap::from([
                ("TERM".into(), "ansi".into()),
                ("COLORTERM".into(), "false".into()),
            ])),
            per_terminal_history: None,
            history_key: None,
        };
        let cmd = build_command(&opts, None);
        assert_eq!(
            cmd.get_env("TERM").and_then(|value| value.to_str()),
            Some("ansi")
        );
        assert_eq!(
            cmd.get_env("COLORTERM").and_then(|value| value.to_str()),
            Some("false")
        );
    }

    #[test]
    fn utf8_chunk_decoder_stitches_three_byte_codepoint_split_1_2() {
        // "中" = E4 B8 AD, split after the first byte.
        let mut decoder = Utf8ChunkDecoder::new();
        let mut out = String::new();
        out.push_str(&decoder.decode(b"\xE4"));
        out.push_str(&decoder.decode(b"\xB8\xAD"));
        assert_eq!(out, "中");
        assert!(!out.contains('\u{FFFD}'), "unexpected replacement char in {out:?}");
    }

    #[test]
    fn utf8_chunk_decoder_stitches_three_byte_codepoint_split_2_1() {
        // "中" = E4 B8 AD, split after the second byte.
        let mut decoder = Utf8ChunkDecoder::new();
        let mut out = String::new();
        out.push_str(&decoder.decode(b"\xE4\xB8"));
        out.push_str(&decoder.decode(b"\xAD"));
        assert_eq!(out, "中");
        assert!(!out.contains('\u{FFFD}'), "unexpected replacement char in {out:?}");
    }

    #[test]
    fn utf8_chunk_decoder_stitches_four_byte_emoji_split_2_2() {
        // "😀" = F0 9F 98 80, split down the middle.
        let mut decoder = Utf8ChunkDecoder::new();
        let mut out = String::new();
        out.push_str(&decoder.decode(b"\xF0\x9F"));
        out.push_str(&decoder.decode(b"\x98\x80"));
        assert_eq!(out, "😀");
        assert!(!out.contains('\u{FFFD}'), "unexpected replacement char in {out:?}");
    }

    #[test]
    fn utf8_chunk_decoder_stitches_mixed_ascii_and_split_codepoint() {
        let mut decoder = Utf8ChunkDecoder::new();
        let mut out = String::new();
        out.push_str(&decoder.decode(b"abc\xE4"));
        out.push_str(&decoder.decode(b"\xB8\xAD def"));
        assert_eq!(out, "abc中 def");
        assert!(!out.contains('\u{FFFD}'), "unexpected replacement char in {out:?}");
    }

    #[test]
    fn utf8_chunk_decoder_replaces_genuinely_invalid_byte() {
        // 0xFF is never a valid UTF-8 lead byte; it must still lossy-decode
        // to U+FFFD instead of being held in `pending` forever.
        let mut decoder = Utf8ChunkDecoder::new();
        let out = decoder.decode(b"ab\xFFcd");
        assert_eq!(out, "ab\u{FFFD}cd");
        assert!(decoder.flush().is_none(), "invalid bytes must not linger in pending");
    }

    #[test]
    fn utf8_chunk_decoder_flushes_pending_tail_on_eof() {
        let mut decoder = Utf8ChunkDecoder::new();
        let out = decoder.decode(b"abc\xE4");
        assert_eq!(out, "abc");
        let flushed = decoder.flush().expect("incomplete tail must be flushed");
        assert_eq!(flushed, "\u{FFFD}");
        assert!(decoder.flush().is_none(), "pending must be empty after flush");
    }
}
