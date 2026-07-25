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
use std::collections::{HashMap, HashSet};
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
const MAX_ENV_DISCOVERY_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENV_COPY_ERRORS: usize = 8;
const PNPM_LOG_TAIL_CHARS: usize = 4000;
const WORKTREE_DIR: &str = ".bat-worktrees";

/// The platforms pnpm resolution has to differ across.
///
/// Deliberately a runtime value rather than `#[cfg]`: it keeps every
/// platform's rules compiling — and unit-testable — on every host, so the
/// macOS and Linux behaviour is not left to whoever next builds on those
/// machines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PnpmHost {
    Windows,
    MacOs,
    Linux,
}

impl PnpmHost {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }

    /// File names pnpm can have inside an install directory.
    ///
    /// Windows is the awkward one: `npm install -g pnpm` writes `pnpm.cmd`,
    /// the standalone installer writes `pnpm.exe`, and the extensionless
    /// `pnpm` npm drops alongside them is an sh script that CreateProcess
    /// rejects with "not a valid Win32 application". Command does not apply
    /// PATHEXT, so the extension has to be part of the path we hand it.
    fn executable_names(self) -> &'static [&'static str] {
        match self {
            Self::Windows => &["pnpm.cmd", "pnpm.exe", "pnpm.bat"],
            Self::MacOs | Self::Linux => &["pnpm"],
        }
    }
}

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

#[derive(Debug, Default)]
struct EnvCopyReport {
    copied: usize,
    preserved: usize,
    errors: Vec<String>,
}

fn record_env_copy_error(report: &mut EnvCopyReport, message: impl Into<String>) {
    if report.errors.len() < MAX_ENV_COPY_ERRORS {
        report.errors.push(message.into());
    }
}

fn is_local_env_file_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    name == ".env" || name.starts_with(".env.")
}

fn is_safe_repo_relative_path(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

/// Use the tracked tree as a cheap directory index. Walking the whole source
/// repository would descend into ignored node_modules/target directories and
/// make worktree creation noticeably slower. Every useful project directory
/// has a tracked descendant, so its ancestors form a bounded search space for
/// adjacent ignored/untracked `.env` files.
fn tracked_repo_directories(git_root: &Path) -> Result<Vec<PathBuf>, String> {
    let stdout = run_git(
        git_root,
        &["ls-files", "-z"],
        DEFAULT_TIMEOUT,
        MAX_ENV_DISCOVERY_BYTES,
    )?;
    let mut directories = HashSet::from([PathBuf::new()]);
    for raw in stdout.split('\0').filter(|entry| !entry.is_empty()) {
        let tracked_path = Path::new(raw);
        if !is_safe_repo_relative_path(tracked_path) {
            continue;
        }
        let mut parent = tracked_path.parent();
        while let Some(directory) = parent {
            directories.insert(directory.to_path_buf());
            parent = directory.parent();
        }
    }
    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort();
    Ok(directories)
}

/// Copy a local secret/config file without ever replacing an existing target.
/// On Unix the destination starts at mode 0600 before we apply the source
/// permissions, so there is no window where a private `.env` is world-readable.
fn copy_file_without_overwrite(src: &Path, dst: &Path) -> std::io::Result<bool> {
    let mut source = fs::File::open(src)?;
    let source_permissions = source.metadata()?.permissions();
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut destination = match options.open(dst) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(err) => return Err(err),
    };
    if let Err(err) = std::io::copy(&mut source, &mut destination) {
        drop(destination);
        let _ = fs::remove_file(dst);
        return Err(err);
    }
    drop(destination);
    if let Err(err) = fs::set_permissions(dst, source_permissions) {
        let _ = fs::remove_file(dst);
        return Err(err);
    }
    Ok(true)
}

/// Copy root and monorepo-local `.env` / `.env.*` files into a worktree.
/// Files are copied, never linked, and an existing worktree file always wins.
/// This keeps worktree edits isolated from the source checkout and makes the
/// operation safe to repeat while rehydrating worktrees created by older BATs.
fn copy_local_env_files(git_root: &Path, worktree_path: &Path) -> EnvCopyReport {
    let mut report = EnvCopyReport::default();
    let directories = match tracked_repo_directories(git_root) {
        Ok(directories) => directories,
        Err(err) => {
            record_env_copy_error(
                &mut report,
                format!("could not enumerate project directories: {err}"),
            );
            vec![PathBuf::new()]
        }
    };

    for relative_dir in directories {
        let source_dir = git_root.join(&relative_dir);
        let entries = match fs::read_dir(&source_dir) {
            Ok(entries) => entries,
            Err(err) => {
                record_env_copy_error(
                    &mut report,
                    format!("could not inspect {}: {err}", relative_dir.display()),
                );
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    record_env_copy_error(
                        &mut report,
                        format!(
                            "could not inspect an entry under {}: {err}",
                            relative_dir.display()
                        ),
                    );
                    continue;
                }
            };
            let file_name = entry.file_name();
            if !is_local_env_file_name(&file_name) {
                continue;
            }
            let source = entry.path();
            if !fs::metadata(&source)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false)
            {
                continue;
            }
            let target_dir = worktree_path.join(&relative_dir);
            if let Err(err) = fs::create_dir_all(&target_dir) {
                record_env_copy_error(
                    &mut report,
                    format!("could not create {}: {err}", relative_dir.display()),
                );
                continue;
            }
            let relative_file = relative_dir.join(&file_name);
            match copy_file_without_overwrite(&source, &target_dir.join(&file_name)) {
                Ok(true) => report.copied += 1,
                Ok(false) => report.preserved += 1,
                Err(err) => record_env_copy_error(
                    &mut report,
                    format!("could not copy {}: {err}", relative_file.display()),
                ),
            }
        }
    }
    report
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
    let env_copy = copy_local_env_files(&git_root_path, &worktree_path);
    if env_copy.copied > 0 {
        worktree_debug_log(
            app.as_ref(),
            format!(
                "[worktree] copied local env files cwd={} copied={} preserved={}",
                worktree_path.display(),
                env_copy.copied,
                env_copy.preserved
            ),
        );
    }
    if !env_copy.errors.is_empty() {
        if let Some(app) = app.as_ref() {
            log_tauri(
                app,
                &format!(
                    "[worktree] warning: local env copy was incomplete cwd={} errors={}",
                    worktree_path.display(),
                    env_copy.errors.join(" | ")
                ),
            );
        }
    }

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
        // Bail loudly rather than spawning a bare "pnpm": on Windows that name
        // never resolves (Command does not apply PATHEXT), so the old fallback
        // could only ever produce a confusing `program not found`.
        let Some(pnpm_bin) = resolve_pnpm_binary() else {
            if let Some(app) = app.as_ref() {
                log_tauri(
                    app,
                    &format!(
                        "[worktree] background pnpm install skipped cwd={} reason=pnpm-not-found searched={} path={}",
                        worktree_path.display(),
                        pnpm_search_summary(),
                        std::env::var("PATH").unwrap_or_default()
                    ),
                );
            }
            return;
        };
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
        pnpm_fallback_candidates()
            .into_iter()
            .find(|path| path.is_file())
    })
}

/// Directories pnpm installs into, most authoritative first.
///
/// Pure in its environment, and selected with `cfg!` rather than `#[cfg]`, so
/// the macOS and Linux lists compile and can be asserted from any host. That
/// matters more than it looks: nothing in CI runs `cargo test`, so a branch
/// behind `#[cfg(target_os = "macos")]` is only ever checked by whoever
/// happens to build on a Mac.
///
/// The lists exist because PATH is least trustworthy exactly where we need it.
/// A macOS app opened from Finder inherits launchd's
/// `/usr/bin:/bin:/usr/sbin:/sbin` and never the PATH a shell rc builds, and
/// a Windows app started before `npm install -g pnpm` keeps the older
/// registry PATH until the user signs out. In both cases pnpm is installed and
/// working in a terminal while being invisible to us.
fn pnpm_search_dirs<F>(host: PnpmHost, env: F) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    let mut dirs = Vec::<PathBuf>::new();
    let var = |name: &str| {
        env(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };

    // PNPM_HOME is pnpm telling us where it put itself; trust it over guesses.
    if let Some(home) = var("PNPM_HOME") {
        push_unique_path(&mut dirs, home);
    }

    match host {
        PnpmHost::Windows => {
            // `npm install -g pnpm` writes into npm's global prefix.
            if let Some(appdata) = var("APPDATA") {
                push_unique_path(&mut dirs, appdata.join("npm"));
            }
            // The standalone installer's default home.
            if let Some(local) = var("LOCALAPPDATA") {
                push_unique_path(&mut dirs, local.join("pnpm"));
            }
            if let Some(program_files) = var("ProgramFiles") {
                push_unique_path(&mut dirs, program_files.join("nodejs"));
            }
        }
        PnpmHost::MacOs => {
            if let Some(home) = var("HOME") {
                // The standalone installer's default home on macOS.
                push_unique_path(&mut dirs, home.join("Library").join("pnpm"));
            }
            push_unique_path(&mut dirs, PathBuf::from("/opt/homebrew/bin"));
            push_unique_path(&mut dirs, PathBuf::from("/usr/local/bin"));
            push_unique_path(&mut dirs, PathBuf::from("/usr/bin"));
        }
        PnpmHost::Linux => {
            // The standalone installer follows the XDG data dir.
            if let Some(data) = var("XDG_DATA_HOME") {
                push_unique_path(&mut dirs, data.join("pnpm"));
            } else if let Some(home) = var("HOME") {
                push_unique_path(&mut dirs, home.join(".local").join("share").join("pnpm"));
            }
            push_unique_path(&mut dirs, PathBuf::from("/usr/local/bin"));
            push_unique_path(&mut dirs, PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
            push_unique_path(&mut dirs, PathBuf::from("/usr/bin"));
            push_unique_path(&mut dirs, PathBuf::from("/bin"));
        }
    }

    // Volta keeps stable shims outside its per-version directories.
    if let Some(volta) = var("VOLTA_HOME") {
        push_unique_path(&mut dirs, volta.join("bin"));
    } else if let Some(home) = var("HOME") {
        push_unique_path(&mut dirs, home.join(".volta").join("bin"));
    }

    // nvm, fnm, asdf and mise all put node in a per-version directory no fixed
    // list can predict, and a global pnpm install lands beside it. Following
    // node covers every one of them with a single rule.
    if let Some(node_dir) = env("PATH")
        .and_then(|path| find_node_on_path(&path))
        .and_then(|node| node.parent().map(Path::to_path_buf))
    {
        push_unique_path(&mut dirs, node_dir);
    }

    dirs
}

/// Every path pnpm could be at on `host`, as full file paths ready to spawn.
fn pnpm_candidates<F>(host: PnpmHost, env: F) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    let names = host.executable_names();
    pnpm_search_dirs(host, env)
        .into_iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .collect()
}

fn pnpm_fallback_candidates() -> Vec<PathBuf> {
    pnpm_candidates(PnpmHost::current(), |name| std::env::var_os(name))
}

/// The fallback list, for the log line that fires when pnpm cannot be found —
/// so the log says where we looked instead of just that we failed.
fn pnpm_search_summary() -> String {
    pnpm_fallback_candidates()
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(";")
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

    for dir in pnpm_runtime_dirs(PnpmHost::current(), |name| std::env::var_os(name)) {
        if dir.is_dir() {
            push_unique_path(&mut dirs, dir);
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

/// Directories to prepend to the child's PATH so pnpm can reach node.
///
/// Narrower than [`pnpm_search_dirs`] on purpose. These land *ahead* of the
/// inherited PATH, so adding a general system directory here would let it
/// shadow the node a version manager put earlier — finding pnpm somewhere is
/// harmless, running it against the wrong node is not.
fn pnpm_runtime_dirs<F>(host: PnpmHost, env: F) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    let mut dirs = Vec::<PathBuf>::new();
    let var = |name: &str| {
        env(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };

    match host {
        PnpmHost::Windows => {
            // pnpm.cmd shells out to node, so the child needs node reachable
            // even when we found pnpm somewhere PATH does not mention.
            if let Some(appdata) = var("APPDATA") {
                push_unique_path(&mut dirs, appdata.join("npm"));
            }
            if let Some(program_files) = var("ProgramFiles") {
                push_unique_path(&mut dirs, program_files.join("nodejs"));
            }
        }
        PnpmHost::MacOs => {
            push_unique_path(&mut dirs, PathBuf::from("/opt/homebrew/bin"));
            push_unique_path(&mut dirs, PathBuf::from("/usr/local/bin"));
        }
        PnpmHost::Linux => {
            push_unique_path(&mut dirs, PathBuf::from("/usr/local/bin"));
            push_unique_path(&mut dirs, PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
        }
    }

    dirs
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
        if !git_root.is_empty() {
            let _ = copy_local_env_files(Path::new(&git_root), path_ref);
        }
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
        let _ = copy_local_env_files(git_root_path, &expected_path);
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
    if !git_root.is_empty() && Path::new(&worktree_path).is_dir() {
        let _ = copy_local_env_files(Path::new(&git_root), Path::new(&worktree_path));
    }
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

    /// The contract worktree auto-install rests on: when pnpm is installed the
    /// normal way, the background installer can actually run it.
    ///
    /// Resolving a path is not enough to assert. On Windows `npm install -g
    /// pnpm` drops three shims in the same directory and only some are
    /// spawnable — the extensionless one fails with "not a valid Win32
    /// application" — so this drives the real Command the installer builds.
    #[test]
    fn resolved_pnpm_binary_actually_runs() {
        let Some(pnpm_bin) = resolve_pnpm_binary() else {
            eprintln!("skipping: pnpm is not installed on this machine");
            return;
        };

        let mut command = Command::new(&pnpm_bin);
        command
            .arg("--version")
            // Away from the repo so a workspace pnpm config cannot colour the result.
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = augmented_path_for_pnpm(&pnpm_bin) {
            command.env("PATH", path);
        }
        hide_console_window(&mut command);

        let output = command
            .output()
            .unwrap_or_else(|err| panic!("could not spawn {}: {err}", pnpm_bin.display()));
        assert!(
            output.status.success(),
            "{} --version exited {} stderr={}",
            pnpm_bin.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );

        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert!(
            version
                .split('.')
                .next()
                .is_some_and(|major| major.parse::<u32>().is_ok()),
            "expected a version from {}, got {version:?}",
            pnpm_bin.display()
        );
        // Surfaced under --nocapture so a failure elsewhere shows which pnpm
        // this machine actually resolved.
        eprintln!("pnpm resolved to {} reporting {version}", pnpm_bin.display());
    }

    /// A stand-in environment, so each platform's rules can be asserted from
    /// any host. That is the whole point of resolving pnpm through `PnpmHost`
    /// instead of `#[cfg]`: CI builds on macOS and Linux but never runs
    /// `cargo test`, so these branches would otherwise go unchecked until a
    /// user hit them.
    fn fake_env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |name| map.get(name).map(OsString::from)
    }

    const EVERY_HOST: [PnpmHost; 3] = [PnpmHost::Windows, PnpmHost::MacOs, PnpmHost::Linux];

    /// `npm install -g pnpm` is the install these fallbacks exist to rescue,
    /// and the one the user actually runs. Its prefix differs per platform.
    #[test]
    fn candidates_cover_the_npm_global_prefix_on_every_host() {
        let windows = pnpm_candidates(
            PnpmHost::Windows,
            fake_env(&[("APPDATA", r"C:\Users\dev\AppData\Roaming")]),
        );
        assert!(
            windows.contains(&PathBuf::from(r"C:\Users\dev\AppData\Roaming").join("npm").join("pnpm.cmd")),
            "windows candidates missed npm's global prefix: {windows:?}"
        );

        // Homebrew is npm's global prefix for most Mac users, and it is
        // invisible to a Finder-launched app because launchd's PATH is only
        // /usr/bin:/bin:/usr/sbin:/sbin.
        let macos = pnpm_candidates(PnpmHost::MacOs, fake_env(&[("HOME", "/Users/dev")]));
        assert!(
            macos.contains(&PathBuf::from("/opt/homebrew/bin").join("pnpm")),
            "macos candidates missed Homebrew: {macos:?}"
        );
        assert!(
            macos.contains(&PathBuf::from("/usr/local/bin").join("pnpm")),
            "macos candidates missed the Intel Homebrew prefix: {macos:?}"
        );

        let linux = pnpm_candidates(PnpmHost::Linux, fake_env(&[("HOME", "/home/dev")]));
        assert!(
            linux.contains(&PathBuf::from("/usr/local/bin").join("pnpm")),
            "linux candidates missed /usr/local/bin: {linux:?}"
        );
    }

    /// The standalone installer picks a different home on each platform, and
    /// on Linux follows XDG rather than a fixed path.
    #[test]
    fn candidates_cover_the_standalone_installer_home() {
        let macos = pnpm_candidates(PnpmHost::MacOs, fake_env(&[("HOME", "/Users/dev")]));
        assert!(
            macos.contains(&PathBuf::from("/Users/dev").join("Library").join("pnpm").join("pnpm")),
            "macos candidates missed ~/Library/pnpm: {macos:?}"
        );

        let linux = pnpm_candidates(PnpmHost::Linux, fake_env(&[("HOME", "/home/dev")]));
        assert!(
            linux.contains(
                &PathBuf::from("/home/dev")
                    .join(".local")
                    .join("share")
                    .join("pnpm")
                    .join("pnpm")
            ),
            "linux candidates missed ~/.local/share/pnpm: {linux:?}"
        );

        let xdg = pnpm_candidates(
            PnpmHost::Linux,
            fake_env(&[("HOME", "/home/dev"), ("XDG_DATA_HOME", "/home/dev/.data")]),
        );
        assert!(
            xdg.contains(&PathBuf::from("/home/dev/.data").join("pnpm").join("pnpm")),
            "linux candidates ignored XDG_DATA_HOME: {xdg:?}"
        );
    }

    /// PNPM_HOME is pnpm naming its own location, so it must win over the
    /// guesses on every platform.
    #[test]
    fn pnpm_home_is_searched_first_on_every_host() {
        for host in EVERY_HOST {
            let candidates = pnpm_candidates(host, fake_env(&[("PNPM_HOME", "/opt/pnpm-home")]));
            let first = candidates.first().expect("at least one candidate");
            assert!(
                first.starts_with(PathBuf::from("/opt/pnpm-home")),
                "{host:?} searched {} before PNPM_HOME",
                first.display()
            );
        }
    }

    /// `Command` does not apply PATHEXT, so a Windows candidate without an
    /// extension can never be spawned however plausible the path looks. The
    /// converse matters too: a `.cmd` suffix on Unix would match nothing.
    #[test]
    fn only_windows_candidates_carry_an_executable_extension() {
        for host in EVERY_HOST {
            for candidate in pnpm_candidates(host, fake_env(&[("PNPM_HOME", "/opt/pnpm-home")])) {
                let extension = candidate
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase);
                match host {
                    PnpmHost::Windows => assert!(
                        matches!(extension.as_deref(), Some("cmd" | "exe" | "bat")),
                        "{} is not spawnable on Windows",
                        candidate.display()
                    ),
                    PnpmHost::MacOs | PnpmHost::Linux => assert_eq!(
                        extension, None,
                        "{} would not exist on {host:?}",
                        candidate.display()
                    ),
                }
            }
        }
    }

    /// nvm, fnm, asdf and mise put node in a per-version directory that no
    /// fixed list predicts. Following node is the single rule that covers all
    /// of them, so it has to actually fire.
    #[test]
    fn candidates_follow_node_for_version_managers() {
        let version_dir = std::env::temp_dir().join(format!(
            "bat-worktree-nodedir-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&version_dir).expect("create fake version manager bin dir");
        // find_node_on_path looks for whatever this host calls node.
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        fs::write(version_dir.join(node_name), b"").expect("create fake node");

        let path = version_dir.to_string_lossy().into_owned();
        let candidates = pnpm_candidates(PnpmHost::current(), fake_env(&[("PATH", &path)]));
        let expected = version_dir.join(PnpmHost::current().executable_names()[0]);

        let _ = fs::remove_dir_all(&version_dir);
        assert!(
            candidates.contains(&expected),
            "expected {} among {candidates:?}",
            expected.display()
        );
    }

    /// Runtime dirs are prepended *ahead* of the inherited PATH, so a general
    /// system directory here would shadow the node a version manager put
    /// earlier. Searching those directories for pnpm is fine; running pnpm
    /// against the wrong node is not.
    #[test]
    fn runtime_dirs_never_shadow_the_system_node() {
        for host in EVERY_HOST {
            for dir in pnpm_runtime_dirs(host, fake_env(&[("HOME", "/home/dev")])) {
                assert!(
                    !matches!(dir.to_str(), Some("/usr/bin" | "/bin" | "/usr/sbin")),
                    "{host:?} would prepend {} ahead of the inherited PATH",
                    dir.display()
                );
            }
        }
    }

    #[test]
    fn local_env_matcher_excludes_similarly_named_files() {
        assert!(is_local_env_file_name(OsStr::new(".env")));
        assert!(is_local_env_file_name(OsStr::new(".env.local")));
        assert!(is_local_env_file_name(OsStr::new(".env.production")));
        assert!(!is_local_env_file_name(OsStr::new(".envrc")));
        assert!(!is_local_env_file_name(OsStr::new("environment.env")));
    }

    #[test]
    fn worktree_copies_local_env_files_without_overwriting_them() {
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

        let repo = std::env::temp_dir().join(format!(
            "bat-worktree-env-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let service_dir = repo.join("apps").join("service");
        fs::create_dir_all(&service_dir).expect("create fixture directories");
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
        fs::write(repo.join(".gitignore"), ".env\n.env.*\n").expect("write gitignore");
        fs::write(repo.join("README.md"), "# fixture\n").expect("write readme");
        fs::write(service_dir.join("package.json"), "{}\n").expect("write package file");
        run_git(&repo, &["add", "."], DEFAULT_TIMEOUT, MAX_OUTPUT_BYTES).expect("git add");
        run_git(
            &repo,
            &["commit", "-m", "init"],
            DEFAULT_TIMEOUT,
            MAX_OUTPUT_BYTES,
        )
        .expect("git commit");

        fs::write(repo.join(".env"), "ROOT_SECRET=source\n").expect("write root env");
        fs::write(service_dir.join(".env.local"), "SERVICE_SECRET=source\n")
            .expect("write nested env");
        fs::write(repo.join(".envrc"), "not-an-env-file\n").expect("write envrc");

        let state = WorktreeState::default();
        let session_id = "session-env-copy".to_string();
        let created = create_worktree_native(
            None,
            &state,
            session_id.clone(),
            repo.to_string_lossy().to_string(),
            false,
        )
        .expect("create worktree");
        assert_eq!(created["success"], true);
        let info = state.get(&session_id).expect("stored worktree");
        let worktree_path = PathBuf::from(&info.worktree_path);
        let root_target = worktree_path.join(".env");
        let nested_target = worktree_path
            .join("apps")
            .join("service")
            .join(".env.local");
        assert_eq!(
            fs::read_to_string(&root_target).expect("read copied root env"),
            "ROOT_SECRET=source\n"
        );
        assert_eq!(
            fs::read_to_string(&nested_target).expect("read copied nested env"),
            "SERVICE_SECRET=source\n"
        );
        assert!(!worktree_path.join(".envrc").exists());
        assert!(!fs::symlink_metadata(&root_target)
            .expect("root env metadata")
            .file_type()
            .is_symlink());

        fs::write(&root_target, "ROOT_SECRET=worktree\n").expect("customize worktree env");
        fs::write(repo.join(".env"), "ROOT_SECRET=updated-source\n").expect("update source env");
        let repeated = copy_local_env_files(&repo, &worktree_path);
        assert_eq!(repeated.copied, 0);
        assert_eq!(repeated.preserved, 2);
        assert!(repeated.errors.is_empty());
        assert_eq!(
            fs::read_to_string(&root_target).expect("read preserved env"),
            "ROOT_SECRET=worktree\n"
        );

        fs::remove_file(&nested_target).expect("remove nested env before rehydrate");
        let rehydrated = WorktreeState::default();
        assert_eq!(
            rehydrate_worktree_native(
                &rehydrated,
                "session-env-rehydrated".into(),
                repo.to_string_lossy().to_string(),
                info.worktree_path.clone(),
                info.branch_name.clone(),
            )["success"],
            true
        );
        assert_eq!(
            fs::read_to_string(&nested_target).expect("read rehydrated nested env"),
            "SERVICE_SECRET=source\n"
        );
        assert_eq!(
            fs::read_to_string(&root_target).expect("read rehydrated preserved env"),
            "ROOT_SECRET=worktree\n"
        );

        assert_eq!(
            remove_worktree_native(&state, session_id, true)["success"],
            true
        );
        fs::remove_dir_all(repo).ok();
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
