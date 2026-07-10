// worktree:* — Rust native port of electron/worktree-manager.ts.
//
// This surface is pure git + filesystem state. Keeping it in Rust avoids
// waking the Node sidecar for local worktree creation/status/cleanup while
// preserving the renderer-facing worktree.* result shapes.

use super::app::log_tauri;
use crate::commands::profile as profile_cmd;
use crate::host_context::HostContext;
use crate::remote_client::RustRemoteClientState;
use crate::sidecar::BridgeError;
use crate::subprocess::hide_console_window;
#[cfg(feature = "desktop")]
use crate::window_registry;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, State, WebviewWindow};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
// Remote round-trips for create/merge/remove/rehydrate cover several git
// commands on the host (worktree add can checkout a large tree), so they get
// a much longer budget than the per-command local timeout. Status polling
// keeps the short timeout — it runs on an interval and must fail fast.
const REMOTE_MUTATION_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
const PNPM_LOG_TAIL_CHARS: usize = 4000;
const WORKTREE_DIR: &str = ".bat-worktrees";

#[derive(Clone, Default)]
pub struct WorktreeState {
    inner: Arc<Mutex<HashMap<String, WorktreeInfo>>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorktreeInfo {
    session_id: String,
    worktree_path: String,
    branch_name: String,
    git_root: String,
    original_cwd: String,
    source_branch: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    fork_head: String,
    created_at: u64,
    // Cache for merged-status lookups. We keep these on WorktreeInfo so the
    // existing `state.set` / `state.get` round-trip transparently preserves
    // them. They're skipped during serde because the renderer doesn't need
    // the cache, only the resolved status from worktree.status.
    #[serde(skip)]
    cached_host_head: String,
    #[serde(skip)]
    cached_worktree_head: String,
    #[serde(skip)]
    cached_merged: Option<MergedKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergedKind {
    Ancestor,
    PatchEquivalent,
    Ahead,
    Diverged,
}

impl MergedKind {
    fn as_str(self) -> &'static str {
        match self {
            MergedKind::Ancestor => "ancestor",
            MergedKind::PatchEquivalent => "patch-equivalent",
            MergedKind::Ahead => "ahead",
            MergedKind::Diverged => "diverged",
        }
    }

    fn is_merged(self) -> bool {
        matches!(self, MergedKind::Ancestor | MergedKind::PatchEquivalent)
    }
}

impl WorktreeState {
    fn get(&self, session_id: &str) -> Option<WorktreeInfo> {
        self.inner
            .lock()
            .expect("worktree state lock")
            .get(session_id)
            .cloned()
    }

    fn set(&self, info: WorktreeInfo) {
        self.inner
            .lock()
            .expect("worktree state lock")
            .insert(info.session_id.clone(), info);
    }

    fn remove(&self, session_id: &str) -> Option<WorktreeInfo> {
        self.inner
            .lock()
            .expect("worktree state lock")
            .remove(session_id)
    }
}

fn worktree_info_value(info: WorktreeInfo) -> Value {
    let mut value = serde_json::to_value(info).unwrap_or(Value::Null);
    value["success"] = Value::Bool(true);
    value
}

fn bridge_error(message: impl Into<String>) -> BridgeError {
    BridgeError {
        message: message.into(),
    }
}

fn bat_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn worktree_debug_log(app: Option<&HostContext>, message: impl AsRef<str>) {
    if bat_debug_enabled() {
        if let Some(app) = app {
            log_tauri(app, message.as_ref());
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn run_git(
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
    max_bytes: usize,
) -> Result<String, String> {
    if !cwd.is_dir() {
        return Err("cwd is not a directory".into());
    }
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_window(&mut command);
    let mut child = command.spawn().map_err(|err| err.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("git command timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => return Err(err.to_string()),
        }
    }
    let output = child.wait_with_output().map_err(|err| err.to_string())?;
    if output.stdout.len() > max_bytes {
        return Err("git output exceeded buffer limit".into());
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            output.status.to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_ok(cwd: &Path, args: &[&str]) -> bool {
    run_git(cwd, args, DEFAULT_TIMEOUT, MAX_OUTPUT_BYTES).is_ok()
}

/// Allocate a free worktree folder + branch under `worktree_base`. The folder
/// name is host-owned — it is no longer derived from the client session id,
/// whose first 8 chars aren't guaranteed unique across remote clients. The hex
/// token matches the renderer's `[0-9a-f]+` worktree-folder regex; a
/// same-millisecond clash or a pre-existing folder/branch bumps a counter until
/// a free slot is found.
fn allocate_worktree_slot(worktree_base: &Path, git_root: &Path) -> (PathBuf, String) {
    let base = now_ms();
    let mut counter: u64 = 0;
    loop {
        let token = base.wrapping_add(counter) & 0xffff_ffff;
        let short_id = format!("{token:08x}");
        let worktree_path = worktree_base.join(&short_id);
        let branch_name = format!("bat/worktree-{short_id}");
        if !worktree_path.exists()
            && !run_git_ok(git_root, &["rev-parse", "--verify", &branch_name])
        {
            return (worktree_path, branch_name);
        }
        counter += 1;
    }
}

fn get_git_root(cwd: &str) -> Option<String> {
    run_git(
        Path::new(cwd),
        &["rev-parse", "--show-toplevel"],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )
    .ok()
}

fn get_branch(cwd: &Path) -> String {
    run_git(
        cwd,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )
    .unwrap_or_else(|_| "HEAD".into())
}

fn worktree_git_root_from_path(worktree_path: &str) -> Option<PathBuf> {
    Path::new(worktree_path)
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn add_worktree_to_git_exclude(git_root: &Path) {
    let exclude_file = git_root.join(".git").join("info").join("exclude");
    let patterns = [format!("/{WORKTREE_DIR}/"), "/.bat-cache/".to_string()];
    if let Some(parent) = exclude_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut content = fs::read_to_string(&exclude_file).unwrap_or_default();
    for pattern in patterns {
        if content.contains(&pattern) {
            continue;
        }
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&pattern);
        content.push('\n');
    }
    let _ = fs::write(exclude_file, content);
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let source = entry.path();
        let target = dst.join(entry.file_name());
        let meta = entry.metadata()?;
        if meta.is_dir() {
            copy_dir_recursive(&source, &target)?;
        } else if meta.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let _ = fs::copy(source, target)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn link_or_copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(src, dst).or_else(|_| copy_dir_recursive(src, dst))
}

#[cfg(not(windows))]
fn link_or_copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst).or_else(|_| copy_dir_recursive(src, dst))
}

#[cfg(windows)]
fn link_or_copy_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::copy(src, dst).map(|_| ())
}

#[cfg(not(windows))]
fn link_or_copy_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst).or_else(|_| fs::copy(src, dst).map(|_| ()))
}

fn link_claude_untracked(git_root: &Path, worktree_path: &Path) {
    let claude_dir = git_root.join(".claude");
    if !claude_dir.is_dir() {
        return;
    }
    let Ok(stdout) = run_git(
        git_root,
        &["ls-files", "--others", "--exclude-standard", ".claude/"],
        DEFAULT_TIMEOUT,
        5 * 1024 * 1024,
    ) else {
        return;
    };
    let mut top_entries = Vec::<String>::new();
    for item in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let rel = item.trim().strip_prefix(".claude/").unwrap_or(item.trim());
        if let Some(first) = rel.split('/').next().filter(|value| !value.is_empty()) {
            if !top_entries.iter().any(|entry| entry == first) {
                top_entries.push(first.to_string());
            }
        }
    }
    if top_entries.is_empty() {
        return;
    }
    let worktree_claude_dir = worktree_path.join(".claude");
    let _ = fs::create_dir_all(&worktree_claude_dir);
    for item in top_entries {
        let src = claude_dir.join(&item);
        let dst = worktree_claude_dir.join(&item);
        if dst.exists() {
            continue;
        }
        let Ok(meta) = fs::metadata(&src) else {
            continue;
        };
        let _ = if meta.is_dir() {
            link_or_copy_dir(&src, &dst)
        } else {
            link_or_copy_file(&src, &dst)
        };
    }
}

fn create_worktree_native(
    app: Option<HostContext>,
    state: &WorktreeState,
    session_id: String,
    cwd: String,
    install_pnpm: bool,
) -> Result<Value, BridgeError> {
    if session_id.trim().is_empty() || cwd.trim().is_empty() {
        return Ok(
            json!({ "success": false, "error": "worktree.create: missing sessionId or cwd" }),
        );
    }
    let Some(git_root) = get_git_root(&cwd) else {
        return Ok(json!({ "success": false, "error": "Not a git repository" }));
    };
    let git_root_path = PathBuf::from(&git_root);
    let worktree_base = git_root_path.join(WORKTREE_DIR);
    let source_branch = get_branch(&git_root_path);
    let fork_head = rev_parse(&git_root_path, &source_branch);

    fs::create_dir_all(&worktree_base).map_err(|err| bridge_error(err.to_string()))?;
    add_worktree_to_git_exclude(&git_root_path);

    // The host owns the filesystem, so it — not the client — picks the worktree
    // folder and branch. The name used to be the client session id's first 8
    // chars, but remote clients use id formats whose first 8 chars aren't unique
    // (e.g. a shared "session-" prefix), so every worktree resolved to the same
    // path and only the first one could be created. Allocate a free,
    // collision-proof slot here instead.
    let (worktree_path, branch_name) = allocate_worktree_slot(&worktree_base, &git_root_path);

    let worktree_path_arg = worktree_path.to_string_lossy().to_string();
    run_git(
        &git_root_path,
        &["worktree", "add", &worktree_path_arg, "-b", &branch_name],
        DEFAULT_TIMEOUT,
        MAX_OUTPUT_BYTES,
    )
    .map_err(bridge_error)?;
    write_worktree_fork_head(&git_root_path, &branch_name, &fork_head);
    link_claude_untracked(&git_root_path, &worktree_path);

    let info = WorktreeInfo {
        session_id,
        worktree_path: worktree_path.to_string_lossy().to_string(),
        branch_name,
        git_root,
        original_cwd: cwd,
        source_branch,
        fork_head,
        created_at: now_ms(),
        cached_host_head: String::new(),
        cached_worktree_head: String::new(),
        cached_merged: None,
    };
    state.set(info.clone());
    if install_pnpm {
        spawn_pnpm_install_for_worktree(app, git_root_path, worktree_path);
    } else {
        worktree_debug_log(
            app.as_ref(),
            format!(
                "[worktree] background pnpm install skipped cwd={} reason=installPnpm-false",
                info.worktree_path
            ),
        );
    }
    Ok(worktree_info_value(info))
}

fn spawn_pnpm_install_for_worktree(
    app: Option<HostContext>,
    git_root: PathBuf,
    worktree_path: PathBuf,
) {
    let install_dirs = find_pnpm_install_dirs(&worktree_path);
    if install_dirs.is_empty() {
        worktree_debug_log(
            app.as_ref(),
            format!(
                "[worktree] background pnpm install skipped cwd={} reason=missing-pnpm-lock",
                worktree_path.display()
            ),
        );
        return;
    }

    std::thread::spawn(move || {
        let store_dir = git_root.join(".bat-cache").join("pnpm-store");
        let _ = fs::create_dir_all(&store_dir);
        let pnpm_bin = resolve_pnpm_binary().unwrap_or_else(|| PathBuf::from("pnpm"));
        let pnpm_path = augmented_path_for_pnpm(&pnpm_bin);
        let pnpm_path_text = pnpm_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        for install_dir in install_dirs {
            if let Some(app) = app.as_ref() {
                log_tauri(
                    app,
                    &format!(
                        "[worktree] starting background pnpm install cwd={} store={} pnpm={} path={}",
                        install_dir.display(),
                        store_dir.display(),
                        pnpm_bin.display(),
                        pnpm_path_text
                    ),
                );
                worktree_debug_log(
                    Some(app),
                    format!(
                        "[worktree] pnpm install command cwd={} argv=install --frozen-lockfile --prefer-offline --store-dir {} pnpm={}",
                        install_dir.display(),
                        store_dir.display(),
                        pnpm_bin.display()
                    ),
                );
            }

            let mut pnpm_cmd = Command::new(&pnpm_bin);
            pnpm_cmd
                .args([
                    "install",
                    "--frozen-lockfile",
                    "--prefer-offline",
                    "--store-dir",
                ])
                .arg(&store_dir)
                .current_dir(&install_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(path) = pnpm_path.as_ref() {
                pnpm_cmd.env("PATH", path);
            }
            hide_console_window(&mut pnpm_cmd);
            let started = Instant::now();
            let output = pnpm_cmd.output();

            match output {
                Ok(output) if output.status.success() => {
                    if let Some(app) = app.as_ref() {
                        log_tauri(
                            app,
                            &format!(
                                "[worktree] background pnpm install completed cwd={} status={} elapsedMs={}",
                                install_dir.display(),
                                output.status,
                                started.elapsed().as_millis()
                            ),
                        );
                        log_pnpm_output_tail(app, &install_dir, "stdout", &output.stdout);
                        log_pnpm_output_tail(app, &install_dir, "stderr", &output.stderr);
                    }
                }
                Ok(output) => {
                    if let Some(app) = app.as_ref() {
                        log_tauri(
                            app,
                            &format!(
                                "[worktree] background pnpm install failed cwd={} status={} elapsedMs={} pnpm={} path={}",
                                install_dir.display(),
                                output.status,
                                started.elapsed().as_millis(),
                                pnpm_bin.display(),
                                pnpm_path_text
                            ),
                        );
                        log_pnpm_output_tail(app, &install_dir, "stdout", &output.stdout);
                        log_pnpm_output_tail(app, &install_dir, "stderr", &output.stderr);
                    }
                }
                Err(err) => {
                    if let Some(app) = app.as_ref() {
                        log_tauri(
                            app,
                            &format!(
                                "[worktree] failed to start background pnpm install cwd={} pnpm={} path={} error={err}",
                                install_dir.display(),
                                pnpm_bin.display(),
                                pnpm_path_text
                            ),
                        );
                    }
                    break;
                }
            }
        }
    });
}

fn log_pnpm_output_tail(app: &HostContext, cwd: &Path, stream: &str, bytes: &[u8]) {
    let Some(tail) = output_tail_for_log(bytes) else {
        return;
    };
    log_tauri(
        app,
        &format!(
            "[worktree] pnpm install {stream} tail cwd={} {stream}={tail}",
            cwd.display()
        ),
    );
}

fn output_tail_for_log(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let char_count = trimmed.chars().count();
    let tail = if char_count > PNPM_LOG_TAIL_CHARS {
        let start = char_count - PNPM_LOG_TAIL_CHARS;
        trimmed.chars().skip(start).collect::<String>()
    } else {
        trimmed.to_string()
    };
    Some(tail.replace('\n', "\\n").replace('\r', "\\r"))
}

fn find_pnpm_install_dirs(worktree_path: &Path) -> Vec<PathBuf> {
    fn should_skip_dir(name: &str) -> bool {
        matches!(
            name,
            ".git" | ".bat-cache" | ".bat-worktrees" | "node_modules"
        )
    }

    fn visit(dir: &Path, install_dirs: &mut Vec<PathBuf>) {
        if dir.join("pnpm-lock.yaml").is_file() {
            install_dirs.push(dir.to_path_buf());
        }

        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut child_dirs = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if entry.file_name().to_str().is_some_and(should_skip_dir) {
                continue;
            }
            child_dirs.push(path);
        }
        child_dirs.sort();
        for child in child_dirs {
            visit(&child, install_dirs);
        }
    }

    let mut install_dirs = Vec::new();
    if worktree_path.is_dir() {
        visit(worktree_path, &mut install_dirs);
    }
    install_dirs
}

fn resolve_pnpm_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("BAT_PNPM_BIN").filter(|value| !value.is_empty()) {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    find_binary_on_path("pnpm").or_else(|| {
        [
            "/opt/homebrew/bin/pnpm",
            "/usr/local/bin/pnpm",
            "/usr/bin/pnpm",
            "/bin/pnpm",
        ]
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
    })
}

fn augmented_path_for_pnpm(pnpm_bin: &Path) -> Option<OsString> {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs = Vec::<PathBuf>::new();

    if let Some(parent) = pnpm_bin
        .parent()
        .filter(|path| !path.as_os_str().is_empty() && path.is_dir())
    {
        push_unique_path(&mut dirs, parent.to_path_buf());
    }
    if let Some(node) =
        find_node_on_path(&existing).and_then(|path| path.parent().map(Path::to_path_buf))
    {
        push_unique_path(&mut dirs, node);
    }

    #[cfg(target_os = "macos")]
    let fallbacks: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
    #[cfg(target_os = "linux")]
    let fallbacks: &[&str] = &["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
    #[cfg(windows)]
    let fallbacks: &[&str] = &[];

    for fallback in fallbacks {
        let path = PathBuf::from(fallback);
        if path.is_dir() {
            push_unique_path(&mut dirs, path);
        }
    }

    if dirs.is_empty() {
        return None;
    }
    for entry in std::env::split_paths(&existing) {
        push_unique_path(&mut dirs, entry);
    }
    std::env::join_paths(dirs).ok()
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn find_node_on_path(path_env: &OsStr) -> Option<PathBuf> {
    let exe_names: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd", "node"]
    } else {
        &["node"]
    };
    for dir in std::env::split_paths(path_env) {
        for name in exe_names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    #[cfg(not(windows))]
    {
        for fallback in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            let path = PathBuf::from(fallback);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn find_binary_on_path(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(|ext| ext.to_string())
        .collect();
    #[cfg(not(windows))]
    let extensions: Vec<String> = vec!["".into()];

    for dir in std::env::split_paths(&path_env) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for ext in &extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn ensure_worktree_for_session_native(
    state: &WorktreeState,
    session_id: String,
    cwd: String,
    worktree_path: Option<String>,
    branch_name: Option<String>,
) -> Result<Value, BridgeError> {
    if session_id.trim().is_empty() || cwd.trim().is_empty() {
        return Ok(
            json!({ "success": false, "error": "worktree.ensure: missing sessionId or cwd" }),
        );
    }

    let requested_worktree_path = worktree_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    let inferred_worktree_path = requested_worktree_path.clone().or_else(|| {
        let cwd_path = Path::new(&cwd);
        let is_bat_worktree = cwd_path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some(WORKTREE_DIR);
        (is_bat_worktree && cwd_path.exists()).then(|| cwd.clone())
    });

    if let Some(path) = inferred_worktree_path.filter(|path| Path::new(path).exists()) {
        let path_ref = Path::new(&path);
        let git_root = worktree_git_root_from_path(&path)
            .map(|root| root.to_string_lossy().to_string())
            .unwrap_or_default();
        let branch_name = branch_name
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| get_branch(path_ref));
        let original_cwd = if requested_worktree_path.is_some() {
            cwd
        } else if git_root.is_empty() {
            cwd
        } else {
            git_root.clone()
        };
        let fork_head = if git_root.is_empty() {
            String::new()
        } else {
            load_worktree_fork_head(Path::new(&git_root), &branch_name)
        };
        let info = WorktreeInfo {
            session_id,
            worktree_path: path,
            branch_name,
            git_root,
            original_cwd,
            source_branch: String::new(),
            fork_head,
            created_at: 0,
            cached_host_head: String::new(),
            cached_worktree_head: String::new(),
            cached_merged: None,
        };
        state.set(info.clone());
        return Ok(worktree_info_value(info));
    }

    let Some(git_root) = get_git_root(&cwd) else {
        return Ok(json!({ "success": false, "error": "Not a git repository" }));
    };
    let short_id: String = session_id.chars().take(8).collect();
    let expected_path = PathBuf::from(&git_root).join(WORKTREE_DIR).join(&short_id);
    if expected_path.exists() {
        let path = expected_path.to_string_lossy().to_string();
        let branch_name = branch_name
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| get_branch(&expected_path));
        let git_root_path = Path::new(&git_root);
        let fork_head = load_worktree_fork_head(git_root_path, &branch_name);
        let info = WorktreeInfo {
            session_id,
            worktree_path: path,
            branch_name,
            git_root,
            original_cwd: cwd,
            source_branch: String::new(),
            fork_head,
            created_at: 0,
            cached_host_head: String::new(),
            cached_worktree_head: String::new(),
            cached_merged: None,
        };
        state.set(info.clone());
        return Ok(worktree_info_value(info));
    }

    create_worktree_native(None, state, session_id, cwd, false)
}

fn force_remove_worktree(info: &WorktreeInfo, delete_branch: bool) {
    let git_root = Path::new(&info.git_root);
    let worktree_path = Path::new(&info.worktree_path);
    if worktree_path.is_dir()
        && !run_git_ok(
            git_root,
            &["worktree", "remove", &info.worktree_path, "--force"],
        )
    {
        let _ = fs::remove_dir_all(worktree_path);
        let _ = run_git_ok(git_root, &["worktree", "prune"]);
    }
    if delete_branch {
        let _ = run_git_ok(git_root, &["branch", "-D", &info.branch_name]);
    }
}

fn remove_worktree_native(state: &WorktreeState, session_id: String, delete_branch: bool) -> Value {
    if session_id.trim().is_empty() {
        return json!({ "success": false, "error": "worktree.remove: missing sessionId" });
    }
    if let Some(info) = state.remove(&session_id) {
        force_remove_worktree(&info, delete_branch);
    }
    json!({ "success": true })
}

fn resolve_source_branch(state: &WorktreeState, info: &mut WorktreeInfo) -> String {
    if !info.source_branch.is_empty() {
        return info.source_branch.clone();
    }
    let source_branch = get_branch(Path::new(&info.git_root));
    info.source_branch = source_branch.clone();
    state.set(info.clone());
    source_branch
}

fn rev_parse(git_root: &Path, rev: &str) -> String {
    run_git(
        git_root,
        &["rev-parse", "--verify", "--quiet", rev],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )
    .unwrap_or_default()
}

fn worktree_fork_head_config_key(branch_name: &str) -> Option<String> {
    let branch_name = branch_name.trim();
    (!branch_name.is_empty()).then(|| format!("branch.{branch_name}.bat-fork-head"))
}

fn write_worktree_fork_head(git_root: &Path, branch_name: &str, fork_head: &str) {
    let Some(key) = worktree_fork_head_config_key(branch_name) else {
        return;
    };
    if fork_head.trim().is_empty() {
        return;
    }
    let _ = run_git_ok(git_root, &["config", "--local", &key, fork_head]);
}

fn read_worktree_fork_head(git_root: &Path, branch_name: &str) -> String {
    let Some(key) = worktree_fork_head_config_key(branch_name) else {
        return String::new();
    };
    run_git(
        git_root,
        &["config", "--local", "--get", &key],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )
    .unwrap_or_default()
}

fn read_worktree_reflog_fork_head(git_root: &Path, branch_name: &str) -> String {
    let branch_name = branch_name.trim();
    if branch_name.is_empty() {
        return String::new();
    }
    run_git(
        git_root,
        &["reflog", "show", "--format=%H", "--reverse", branch_name],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )
    .ok()
    .and_then(|stdout| {
        stdout
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_string)
    })
    .unwrap_or_default()
}

fn load_worktree_fork_head(git_root: &Path, branch_name: &str) -> String {
    let fork_head = read_worktree_fork_head(git_root, branch_name);
    if fork_head.is_empty() {
        read_worktree_reflog_fork_head(git_root, branch_name)
    } else {
        fork_head
    }
}

fn resolve_fork_head(state: &WorktreeState, info: &mut WorktreeInfo, git_root: &Path) -> String {
    if !info.fork_head.is_empty() {
        return info.fork_head.clone();
    }
    let fork_head = load_worktree_fork_head(git_root, &info.branch_name);
    if !fork_head.is_empty() {
        info.fork_head = fork_head.clone();
        state.set(info.clone());
    }
    fork_head
}

fn compute_merged_kind(git_root: &Path, source_branch: &str, branch_name: &str) -> MergedKind {
    // Fast path: ancestor check — worktree HEAD is reachable from source HEAD.
    // Covers merge --no-ff and fast-forward merges.
    if run_git_ok(
        git_root,
        &["merge-base", "--is-ancestor", branch_name, source_branch],
    ) {
        return MergedKind::Ancestor;
    }
    // git cherry source branch → lines starting with '-' are patch-equivalent
    // commits already in source (covers squash / rebase merges where the
    // commit hash differs but the patch landed). Lines starting with '+' are
    // commits unique to branch.
    let cherry = run_git(
        git_root,
        &["cherry", source_branch, branch_name],
        DEFAULT_TIMEOUT,
        MAX_OUTPUT_BYTES,
    )
    .unwrap_or_default();
    let mut has_unique = false;
    let mut has_equivalent = false;
    for line in cherry.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('+') {
            has_unique = true;
        } else if trimmed.starts_with('-') {
            has_equivalent = true;
        }
    }
    if !has_unique && has_equivalent {
        return MergedKind::PatchEquivalent;
    }
    // Branch has unique commits. Distinguish "ahead of source" (source HEAD
    // is ancestor of branch HEAD) from "diverged".
    if run_git_ok(
        git_root,
        &["merge-base", "--is-ancestor", source_branch, branch_name],
    ) {
        MergedKind::Ahead
    } else {
        MergedKind::Diverged
    }
}

fn worktree_status_native(state: &WorktreeState, session_id: String) -> Value {
    let Some(mut info) = state.get(&session_id) else {
        return Value::Null;
    };
    let source_branch = resolve_source_branch(state, &mut info);
    let git_root_path = PathBuf::from(&info.git_root);
    let git_root = git_root_path.as_path();
    let diff = if source_branch.is_empty() {
        String::new()
    } else {
        let range = format!("{source_branch}...{}", info.branch_name);
        run_git(
            git_root,
            &["diff", &range],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .unwrap_or_default()
    };

    let mut merged_kind: Option<MergedKind> = None;
    if !source_branch.is_empty() {
        let host_head = rev_parse(git_root, &source_branch);
        let worktree_head = rev_parse(git_root, &info.branch_name);
        if !host_head.is_empty() && !worktree_head.is_empty() {
            let fork_head = resolve_fork_head(state, &mut info, git_root);
            if !fork_head.is_empty() && worktree_head == fork_head {
                merged_kind = None;
            } else {
                let cache_hit = info.cached_merged.is_some()
                    && info.cached_host_head == host_head
                    && info.cached_worktree_head == worktree_head;
                if cache_hit {
                    merged_kind = info.cached_merged;
                } else {
                    let kind = compute_merged_kind(git_root, &source_branch, &info.branch_name);
                    info.cached_host_head = host_head;
                    info.cached_worktree_head = worktree_head;
                    info.cached_merged = Some(kind);
                    state.set(info.clone());
                    merged_kind = Some(kind);
                }
            }
        }
    }

    let (merged, merged_kind_str) = match merged_kind {
        Some(kind) => (kind.is_merged(), kind.as_str()),
        None => (false, "unknown"),
    };

    json!({
        "diff": diff,
        "branchName": info.branch_name,
        "worktreePath": info.worktree_path,
        "sourceBranch": source_branch,
        "merged": merged,
        "mergedKind": merged_kind_str,
    })
}

fn ensure_clean(git_root: &Path) -> Result<(), String> {
    let status = run_git(
        git_root,
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
        1024 * 1024,
    )?;
    if status.trim().is_empty() {
        Ok(())
    } else {
        Err(
            "Host repository has uncommitted changes; commit or stash before merging worktree"
                .into(),
        )
    }
}

fn merge_worktree_native(state: &WorktreeState, session_id: String, strategy: String) -> Value {
    let Some(mut info) = state.get(&session_id) else {
        return json!({ "success": false, "error": "worktree.merge: unknown session" });
    };
    if strategy != "merge" && strategy != "cherry-pick" {
        return json!({ "success": false, "error": format!("worktree.merge: unsupported strategy {strategy}") });
    }
    let source_branch = resolve_source_branch(state, &mut info);
    if source_branch.is_empty() {
        return json!({ "success": false, "error": "worktree.merge: missing source branch" });
    }
    let git_root = Path::new(&info.git_root);
    let result = (|| -> Result<(), String> {
        ensure_clean(git_root)?;
        let current_branch = get_branch(git_root);
        if current_branch != source_branch {
            run_git(
                git_root,
                &["checkout", &source_branch],
                DEFAULT_TIMEOUT,
                MAX_OUTPUT_BYTES,
            )?;
        }
        if strategy == "merge" {
            run_git(
                git_root,
                &["merge", "--no-ff", "--no-edit", &info.branch_name],
                DEFAULT_TIMEOUT,
                MAX_OUTPUT_BYTES,
            )?;
        } else {
            let range = format!("{source_branch}..{}", info.branch_name);
            let commits = run_git(
                git_root,
                &["rev-list", "--reverse", &range],
                DEFAULT_TIMEOUT,
                MAX_OUTPUT_BYTES,
            )?;
            let commits = commits
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            if !commits.is_empty() {
                let mut args = vec!["cherry-pick"];
                let commit_refs = commits.iter().map(String::as_str).collect::<Vec<_>>();
                args.extend(commit_refs);
                run_git(git_root, &args, DEFAULT_TIMEOUT, MAX_OUTPUT_BYTES)?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => json!({
            "success": true,
            "strategy": strategy,
            "branchName": info.branch_name,
            "sourceBranch": source_branch,
        }),
        Err(err) => json!({ "success": false, "error": err }),
    }
}

fn rehydrate_worktree_native(
    state: &WorktreeState,
    session_id: String,
    cwd: String,
    worktree_path: String,
    branch_name: String,
) -> Value {
    if session_id.trim().is_empty() || worktree_path.trim().is_empty() {
        return json!({ "success": false });
    }
    let git_root = worktree_git_root_from_path(&worktree_path)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    if let Some(mut existing) = state.get(&session_id) {
        if existing.worktree_path == worktree_path {
            existing.original_cwd = cwd;
            if !branch_name.trim().is_empty() {
                existing.branch_name = branch_name.clone();
            }
            if existing.fork_head.is_empty() && !existing.git_root.is_empty() {
                let git_root_path = Path::new(&existing.git_root);
                existing.fork_head = load_worktree_fork_head(git_root_path, &existing.branch_name);
            }
            state.set(existing);
            return json!({ "success": true });
        }
    }
    let fork_head = if git_root.is_empty() {
        String::new()
    } else {
        load_worktree_fork_head(Path::new(&git_root), &branch_name)
    };
    state.set(WorktreeInfo {
        session_id,
        worktree_path,
        branch_name,
        git_root,
        original_cwd: cwd,
        source_branch: String::new(),
        fork_head,
        created_at: 0,
        cached_host_head: String::new(),
        cached_worktree_head: String::new(),
        cached_merged: None,
    });
    json!({ "success": true })
}

// Remote-client windows must run worktree git/filesystem work on the HOST
// machine: the workspace folder paths they hold only exist there. Mirror the
// claude.rs / git.rs routing — proxy to the host's worktree:* channels
// (remote_server.rs) when the calling window belongs to a remote profile,
// otherwise fall through to the native local implementation.
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
async fn remote_invoke_for_window(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &'static str,
    args: Vec<Value>,
    timeout: Duration,
) -> Option<Result<Value, BridgeError>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let window_label = window.label().to_string();
    let result = crate::async_rt::spawn_blocking(move || {
        remote_client
            .invoke(&window_label, channel, args, timeout)
            .map_err(BridgeError::from)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("remote.invoke {channel} worker failed: {err}"),
    });
    Some(match result {
        Ok(value) => value,
        Err(err) => Err(err),
    })
}

// _local variants hold the actual implementation. The #[tauri::command]
// wrappers add remote routing; remote_server.rs calls these directly when it
// serves the same channels on the host side (no window context there).
pub async fn worktree_create_local(
    app: HostContext,
    state: WorktreeState,
    session_id: String,
    cwd: String,
    install_pnpm: Option<bool>,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || {
        create_worktree_native(
            Some(app),
            &state,
            session_id,
            cwd,
            install_pnpm.unwrap_or(false),
        )
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("worktree.create worker failed: {err}"),
    })?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_create(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
    cwd: String,
    install_pnpm: Option<bool>,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:create",
        vec![
            json!(session_id.clone()),
            json!(cwd.clone()),
            json!(install_pnpm.unwrap_or(false)),
        ],
        REMOTE_MUTATION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_create_local(
        HostContext::from_app(app),
        (*state).clone(),
        session_id,
        cwd,
        install_pnpm,
    )
    .await
}

pub async fn worktree_remove_local(
    state: WorktreeState,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || {
        remove_worktree_native(&state, session_id, delete_branch)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("worktree.remove worker failed: {err}"),
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_remove(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
    delete_branch: bool,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:remove",
        vec![json!(session_id.clone()), json!(delete_branch)],
        REMOTE_MUTATION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_remove_local((*state).clone(), session_id, delete_branch).await
}

pub async fn worktree_status_local(
    state: WorktreeState,
    session_id: String,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || worktree_status_native(&state, session_id))
        .await
        .map_err(|err| BridgeError {
            message: format!("worktree.status worker failed: {err}"),
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_status(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:status",
        vec![json!(session_id.clone())],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_status_local((*state).clone(), session_id).await
}

pub async fn worktree_merge_local(
    state: WorktreeState,
    session_id: String,
    strategy: String,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || merge_worktree_native(&state, session_id, strategy))
        .await
        .map_err(|err| BridgeError {
            message: format!("worktree.merge worker failed: {err}"),
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_merge(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
    strategy: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:merge",
        vec![json!(session_id.clone()), json!(strategy.clone())],
        REMOTE_MUTATION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_merge_local((*state).clone(), session_id, strategy).await
}

pub async fn worktree_rehydrate_local(
    state: WorktreeState,
    session_id: String,
    cwd: String,
    worktree_path: String,
    branch_name: String,
) -> Result<Value, BridgeError> {
    crate::async_rt::spawn_blocking(move || {
        rehydrate_worktree_native(&state, session_id, cwd, worktree_path, branch_name)
    })
    .await
    .map_err(|err| BridgeError {
        message: format!("worktree.rehydrate worker failed: {err}"),
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn worktree_rehydrate(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorktreeState>,
    session_id: String,
    cwd: String,
    worktree_path: String,
    branch_name: String,
) -> Result<Value, BridgeError> {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "worktree:rehydrate",
        vec![
            json!(session_id.clone()),
            json!(cwd.clone()),
            json!(worktree_path.clone()),
            json!(branch_name.clone()),
        ],
        REMOTE_MUTATION_TIMEOUT,
    )
    .await
    {
        return result;
    }
    worktree_rehydrate_local(
        (*state).clone(),
        session_id,
        cwd,
        worktree_path,
        branch_name,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_root_resolves_from_bat_worktree_path() {
        let root = worktree_git_root_from_path("C:/repo/.bat-worktrees/abc")
            .expect("root from worktree path");
        assert!(root.ends_with(Path::new("C:/repo")));
    }

    #[test]
    fn pnpm_install_dirs_include_nested_lockfiles() {
        let base = std::env::temp_dir().join(format!("bat-pnpm-dirs-{}", now_ms()));
        let frontend = base.join("frontend");
        let docs = base.join("docs");
        fs::create_dir_all(&frontend).expect("create frontend dir");
        fs::create_dir_all(&docs).expect("create docs dir");
        fs::write(base.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
            .expect("write root lockfile");
        fs::write(frontend.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
            .expect("write frontend lockfile");

        let install_dirs = find_pnpm_install_dirs(&base);

        assert_eq!(install_dirs, vec![base.clone(), frontend]);
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn pnpm_install_dirs_skip_generated_cache_dirs() {
        let base = std::env::temp_dir().join(format!("bat-pnpm-skip-{}", now_ms()));
        let frontend = base.join("frontend");
        fs::create_dir_all(&frontend).expect("create frontend dir");
        for generated_dir in [".git", ".bat-cache", ".bat-worktrees", "node_modules"] {
            let dir = base.join(generated_dir).join("pkg");
            fs::create_dir_all(&dir).expect("create generated dir");
            fs::write(dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
                .expect("write generated lockfile");
        }
        fs::write(frontend.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
            .expect("write frontend lockfile");

        let install_dirs = find_pnpm_install_dirs(&base);

        assert_eq!(install_dirs, vec![frontend]);
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn pnpm_path_prepends_resolved_pnpm_dir() {
        let base = std::env::temp_dir().join(format!("bat-pnpm-path-{}", now_ms()));
        fs::create_dir_all(&base).expect("create pnpm bin dir");
        let pnpm = base.join(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" });
        fs::write(&pnpm, "").expect("write fake pnpm");

        let path = augmented_path_for_pnpm(&pnpm).expect("augmented pnpm PATH");
        let first = std::env::split_paths(&path).next();

        assert_eq!(first.as_deref(), Some(base.as_path()));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn rehydrate_stores_worktree_info() {
        let state = WorktreeState::default();
        let result = rehydrate_worktree_native(
            &state,
            "session-1".into(),
            "C:/repo".into(),
            "C:/repo/.bat-worktrees/session-1".into(),
            "bat/worktree-session-1".into(),
        );
        assert_eq!(result["success"], true);
        let info = state.get("session-1").expect("stored worktree");
        assert_eq!(info.original_cwd, "C:/repo");
        assert_eq!(info.branch_name, "bat/worktree-session-1");
    }

    #[test]
    fn ensure_rehydrates_existing_requested_worktree() {
        let state = WorktreeState::default();
        let base = std::env::temp_dir().join(format!("bat-worktree-ensure-{}", now_ms()));
        let worktree_path = base.join(WORKTREE_DIR).join("session-1");
        fs::create_dir_all(&worktree_path).expect("create fake worktree");

        let result = ensure_worktree_for_session_native(
            &state,
            "session-1".into(),
            base.to_string_lossy().to_string(),
            Some(worktree_path.to_string_lossy().to_string()),
            Some("bat/worktree-session-1".into()),
        )
        .expect("ensure worktree");

        assert_eq!(result["success"], true);
        assert_eq!(
            result["worktreePath"].as_str(),
            Some(worktree_path.to_string_lossy().as_ref())
        );
        let info = state.get("session-1").expect("stored worktree");
        assert_eq!(info.branch_name, "bat/worktree-session-1");
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn ensure_infers_existing_worktree_cwd() {
        let state = WorktreeState::default();
        let base = std::env::temp_dir().join(format!("bat-worktree-cwd-{}", now_ms()));
        let worktree_path = base.join(WORKTREE_DIR).join("session-1");
        fs::create_dir_all(&worktree_path).expect("create fake worktree");

        let result = ensure_worktree_for_session_native(
            &state,
            "session-1".into(),
            worktree_path.to_string_lossy().to_string(),
            None,
            Some("bat/worktree-session-1".into()),
        )
        .expect("ensure worktree");

        assert_eq!(result["success"], true);
        assert_eq!(
            result["worktreePath"].as_str(),
            Some(worktree_path.to_string_lossy().as_ref())
        );
        assert_eq!(
            result["originalCwd"].as_str(),
            Some(base.to_string_lossy().as_ref())
        );
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn status_unknown_session_returns_null() {
        let state = WorktreeState::default();
        assert_eq!(
            worktree_status_native(&state, "missing".into()),
            Value::Null
        );
    }

    #[test]
    fn status_does_not_mark_unmodified_fork_as_merged() {
        if !Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return;
        }

        let state = WorktreeState::default();
        let repo = std::env::temp_dir().join(format!("bat-worktree-status-{}", now_ms()));
        fs::create_dir_all(&repo).expect("create repo dir");
        run_git(
            &repo,
            &["init", "-b", "main"],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .expect("init repo");
        run_git(
            &repo,
            &["config", "user.email", "test@example.com"],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .expect("set email");
        run_git(
            &repo,
            &["config", "user.name", "Test"],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .expect("set name");
        fs::write(repo.join("README.md"), "# fixture\n").expect("write readme");
        run_git(&repo, &["add", "."], DEFAULT_TIMEOUT, MAX_OUTPUT_BYTES).expect("git add");
        run_git(
            &repo,
            &["commit", "-m", "init"],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .expect("git commit");

        let session_id = "session-unchanged".to_string();
        let created = create_worktree_native(
            None,
            &state,
            session_id.clone(),
            repo.to_string_lossy().to_string(),
            false,
        )
        .expect("create worktree");
        assert_eq!(created["success"], true);
        assert!(created["forkHead"]
            .as_str()
            .is_some_and(|head| !head.is_empty()));

        let status = worktree_status_native(&state, session_id.clone());
        assert_eq!(status["merged"], false);
        assert_eq!(status["mergedKind"], "unknown");

        let info = state.get(&session_id).expect("stored worktree");
        let rehydrated_state = WorktreeState::default();
        assert_eq!(
            rehydrate_worktree_native(
                &rehydrated_state,
                "session-rehydrated".into(),
                repo.to_string_lossy().to_string(),
                info.worktree_path.clone(),
                info.branch_name.clone(),
            )["success"],
            true
        );
        let rehydrated_status =
            worktree_status_native(&rehydrated_state, "session-rehydrated".into());
        assert_eq!(rehydrated_status["merged"], false);
        assert_eq!(rehydrated_status["mergedKind"], "unknown");

        let worktree_path = PathBuf::from(&info.worktree_path);
        fs::write(
            worktree_path.join("README.md"),
            "# fixture\n\nchanged in worktree\n",
        )
        .expect("write worktree change");
        run_git(
            &worktree_path,
            &["add", "README.md"],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .expect("git add worktree");
        run_git(
            &worktree_path,
            &["commit", "-m", "worktree change"],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .expect("git commit worktree");
        run_git(
            &repo,
            &["merge", "--no-ff", "--no-edit", &info.branch_name],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .expect("merge worktree");

        let merged_status = worktree_status_native(&state, session_id);
        assert_eq!(merged_status["merged"], true);
        assert_eq!(merged_status["mergedKind"], "ancestor");

        fs::remove_dir_all(repo).ok();
    }
}
