// runtime.* — setup-install runtime diagnostics and managed install entrypoints.
//
// This mirrors the Runtime Setup Install Plan without changing renderer-facing
// agent IPC. Status is intentionally shallow: each runtime only needs a
// `--version` check so setup never logs in, calls model APIs, or starts an
// agent protocol session.

use crate::host_context::HostContext;
#[cfg(feature = "desktop")]
use crate::remote_client::RustRemoteClientState;
use crate::runtime_catalog;
use crate::subprocess::hide_console_window;
#[cfg(feature = "desktop")]
use crate::window_registry;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use flate2::read::GzDecoder;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, State, WebviewWindow};
#[cfg(feature = "desktop")]
use tauri_plugin_opener::OpenerExt;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(feature = "desktop")]
const REMOTE_RUNTIME_STATUS_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(feature = "desktop")]
const REMOTE_RUNTIME_MUTATION_TIMEOUT: Duration = Duration::from_secs(300);

static RUNTIME_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn runtime_mutation_lock() -> &'static Mutex<()> {
    RUNTIME_MUTATION_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeItemStatus {
    tool: String,
    state: String,
    source: String,
    path: Option<String>,
    version: Option<String>,
    message: Option<String>,
    can_install_managed: bool,
    /// Version the embedded runtime catalog pins for this tool.
    pinned_version: Option<String>,
    /// `true` when the reported managed install is NOT the catalog-pinned
    /// version. The runtime resolvers only ever use the pinned directory, so
    /// a stale managed install is effectively unused until it is refreshed.
    managed_stale: bool,
}

impl RuntimeItemStatus {
    fn with_catalog_pin(mut self, pinned_version: &str, managed_stale: bool) -> Self {
        self.pinned_version = Some(pinned_version.to_string());
        self.managed_stale = managed_stale;
        self
    }
}

#[derive(Debug, Serialize)]
pub struct RuntimeStatus {
    node: RuntimeItemStatus,
    codex: RuntimeItemStatus,
    claude: RuntimeItemStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallResult {
    tool: String,
    ok: bool,
    status: RuntimeItemStatus,
    message: Option<String>,
}

#[cfg(feature = "desktop")]
fn is_remote_profile_window(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Some(profile_id) = window_registry::profile_id_for_window(app, window.label()) else {
        return false;
    };
    super::profile::profile_get(app.clone(), profile_id)
        .map(|profile| profile.kind == "remote")
        .unwrap_or(false)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn runtime_get_status(
    app: AppHandle,
    window: WebviewWindow,
    client_state: State<'_, RustRemoteClientState>,
) -> Result<Value, String> {
    let client = (*client_state).clone();
    if is_remote_profile_window(&app, &window) {
        let window_label = window.label().to_string();
        return crate::async_rt::spawn_blocking(move || {
            client.invoke(
                &window_label,
                "runtime:get-status",
                Vec::new(),
                REMOTE_RUNTIME_STATUS_TIMEOUT,
            )
        })
        .await
        .map_err(|err| format!("remote runtime.getStatus worker failed: {err}"))?;
    }

    let ctx = HostContext::from_app(app);
    crate::async_rt::spawn_blocking(move || {
        runtime_status_core(&ctx).and_then(|status| {
            serde_json::to_value(status)
                .map_err(|err| format!("runtime.getStatus serialization failed: {err}"))
        })
    })
    .await
    .map_err(|err| format!("runtime.getStatus worker failed: {err}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn runtime_install(
    app: AppHandle,
    window: WebviewWindow,
    client_state: State<'_, RustRemoteClientState>,
    tool: String,
) -> Result<Value, String> {
    let client = (*client_state).clone();
    if is_remote_profile_window(&app, &window) {
        let window_label = window.label().to_string();
        return crate::async_rt::spawn_blocking(move || {
            client.invoke(
                &window_label,
                "runtime:install",
                vec![json!({ "tool": tool })],
                REMOTE_RUNTIME_MUTATION_TIMEOUT,
            )
        })
        .await
        .map_err(|err| format!("remote runtime.install worker failed: {err}"))?;
    }

    let ctx = HostContext::from_app(app);
    crate::async_rt::spawn_blocking(move || {
        runtime_install_core(&ctx, &tool).and_then(|result| {
            serde_json::to_value(result)
                .map_err(|err| format!("runtime.install serialization failed: {err}"))
        })
    })
    .await
    .map_err(|err| format!("runtime.install worker failed: {err}"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn runtime_open_runtime_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    if is_remote_profile_window(&app, &window) {
        return Err("Opening the runtime folder is unavailable for a remote host".to_string());
    }
    let dir = runtimes_dir(&HostContext::from_app(app.clone()))?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn runtime_clear_managed(
    app: AppHandle,
    window: WebviewWindow,
    client_state: State<'_, RustRemoteClientState>,
    tool: Option<String>,
) -> Result<(), String> {
    let client = (*client_state).clone();
    if is_remote_profile_window(&app, &window) {
        let window_label = window.label().to_string();
        crate::async_rt::spawn_blocking(move || {
            client.invoke(
                &window_label,
                "runtime:clear-managed",
                vec![json!({ "tool": tool })],
                REMOTE_RUNTIME_MUTATION_TIMEOUT,
            )
        })
        .await
        .map_err(|err| format!("remote runtime.clearManaged worker failed: {err}"))??;
        return Ok(());
    }

    let ctx = HostContext::from_app(app);
    crate::async_rt::spawn_blocking(move || runtime_clear_managed_core(&ctx, tool.as_deref()))
        .await
        .map_err(|err| format!("runtime.clearManaged worker failed: {err}"))?
}

pub(crate) fn runtime_status_core(app: &HostContext) -> Result<RuntimeStatus, String> {
    Ok(RuntimeStatus {
        node: resolve_node_status(app)?,
        codex: resolve_codex_status(app)?,
        claude: resolve_claude_status(app)?,
    })
}

pub(crate) fn runtime_install_core(
    app: &HostContext,
    tool: &str,
) -> Result<RuntimeInstallResult, String> {
    let _mutation = runtime_mutation_lock()
        .lock()
        .map_err(|_| "runtime mutation lock is poisoned".to_string())?;
    let result = match normalize_tool(tool).as_deref() {
        Some("node") => {
            let result = install_managed_node(app);
            let status = resolve_node_status(app)?;
            match result {
                Ok(path) => Ok(RuntimeInstallResult {
                    tool: "node".into(),
                    ok: true,
                    status,
                    message: Some(format!("Installed Node runtime at {}", path.display())),
                }),
                Err(err) => Ok(RuntimeInstallResult {
                    tool: "node".into(),
                    ok: false,
                    status,
                    message: Some(err),
                }),
            }
        }
        Some("codex") => {
            let result = install_managed_codex(app);
            let status = resolve_codex_status(app)?;
            match result {
                Ok(path) => Ok(RuntimeInstallResult {
                    tool: "codex".into(),
                    ok: true,
                    status,
                    message: Some(format!("Installed Codex runtime at {}", path.display())),
                }),
                Err(err) => Ok(RuntimeInstallResult {
                    tool: "codex".into(),
                    ok: false,
                    status,
                    message: Some(err),
                }),
            }
        }
        Some("claude") => {
            let result = install_managed_claude_cli(app);
            let status = resolve_claude_status(app)?;
            match result {
                Ok(path) => Ok(RuntimeInstallResult {
                    tool: "claude".into(),
                    ok: true,
                    status,
                    message: Some(format!("Installed Claude runtime at {}", path.display())),
                }),
                Err(err) => Ok(RuntimeInstallResult {
                    tool: "claude".into(),
                    ok: false,
                    status,
                    message: Some(err),
                }),
            }
        }
        Some(other) => Err(format!("unsupported runtime tool: {other}")),
        None => Err(format!("unsupported runtime tool: {tool}")),
    }?;
    if let Ok(payload) = serde_json::to_value(&result) {
        app.emit("runtime:changed", payload);
    }
    Ok(result)
}

pub(crate) fn runtime_clear_managed_core(
    app: &HostContext,
    tool: Option<&str>,
) -> Result<(), String> {
    let _mutation = runtime_mutation_lock()
        .lock()
        .map_err(|_| "runtime mutation lock is poisoned".to_string())?;
    let runtimes = runtimes_dir(app)?;
    let normalized_tool = match tool {
        Some(tool) => {
            Some(normalize_tool(tool).ok_or_else(|| format!("unsupported runtime tool: {tool}"))?)
        }
        None => None,
    };
    match normalized_tool.as_deref() {
        Some(tool) => {
            let dir_name = match tool {
                "claude" => "claude-agent-sdk",
                other => other,
            };
            let path = runtimes.join(dir_name);
            if path.exists() {
                fs::remove_dir_all(&path).map_err(|err| err.to_string())?;
            }
        }
        None => {
            for dir_name in ["node", "codex", "claude-agent-sdk"] {
                let path = runtimes.join(dir_name);
                if path.exists() {
                    fs::remove_dir_all(&path).map_err(|err| err.to_string())?;
                }
            }
        }
    }
    clear_runtime_manifest(app, normalized_tool.as_deref())?;
    app.emit(
        "runtime:changed",
        json!({ "action": "clear", "tool": normalized_tool }),
    );
    Ok(())
}

fn runtimes_dir(app: &HostContext) -> Result<PathBuf, String> {
    Ok(app
        .data_dir()
        .map_err(|err| format!("could not resolve app data dir: {err}"))?
        .join("runtimes"))
}

fn normalize_tool(tool: &str) -> Option<String> {
    match tool.trim().to_ascii_lowercase().as_str() {
        "node" => Some("node".into()),
        "codex" => Some("codex".into()),
        "claude" | "claude-agent-sdk" => Some("claude".into()),
        _ => None,
    }
}

fn runtime_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.into()
    }
}

fn command_version(path: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start {}: {err}", path.display()))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= Duration::from_secs(5) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} --version timed out", path.display()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed waiting for {}: {err}", path.display()));
            }
        }
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if !status.success() {
        let message = stderr
            .trim()
            .lines()
            .next()
            .unwrap_or("version check failed");
        return Err(format!("{}: {message}", path.display()));
    }
    Ok(stdout
        .trim()
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn ready_status(
    tool: &str,
    source: &str,
    path: PathBuf,
    version_args: &[&str],
    can_install_managed: bool,
) -> RuntimeItemStatus {
    match command_version(&path, version_args) {
        Ok(version) => RuntimeItemStatus {
            tool: tool.into(),
            state: "ready".into(),
            source: source.into(),
            path: Some(path.to_string_lossy().to_string()),
            version: (!version.is_empty()).then_some(version),
            message: None,
            can_install_managed,
            pinned_version: None,
            managed_stale: false,
        },
        Err(err) => RuntimeItemStatus {
            tool: tool.into(),
            state: "broken".into(),
            source: source.into(),
            path: Some(path.to_string_lossy().to_string()),
            version: None,
            message: Some(err),
            can_install_managed,
            pinned_version: None,
            managed_stale: false,
        },
    }
}

fn missing_status(
    tool: &str,
    can_install_managed: bool,
    message: Option<String>,
) -> RuntimeItemStatus {
    RuntimeItemStatus {
        tool: tool.into(),
        state: "missing".into(),
        source: "missing".into(),
        path: None,
        version: None,
        message,
        can_install_managed,
        pinned_version: None,
        managed_stale: false,
    }
}

fn candidate_is_ready(path: &Path, version_args: &[&str]) -> bool {
    path.is_file() && command_version(path, version_args).is_ok()
}

fn path_candidates(exe_names: &[String]) -> Vec<PathBuf> {
    let mut dirs = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]);
    } else if cfg!(target_os = "linux") {
        dirs.extend([
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
    }
    dirs.into_iter()
        .flat_map(|dir| exe_names.iter().map(move |name| dir.join(name)))
        .collect()
}

fn first_ready(paths: Vec<PathBuf>, version_args: &[&str]) -> Option<PathBuf> {
    paths
        .into_iter()
        .find(|path| candidate_is_ready(path, version_args))
}

/// Numeric sort key for a version directory name ("0.144.0" -> [0, 144, 0]).
/// Non-digit runs just split segments, so odd suffixes still order
/// deterministically instead of falling back to filesystem order.
fn version_dir_sort_key(name: &str) -> Vec<u64> {
    name.split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

/// `layers` lists the subdirectories (relative to `<version>/<key>/`) probed
/// for the executable; `""` means directly inside the key dir. Codex passes
/// only `["bin"]` on purpose: legacy flat installs (codex.exe at the key root)
/// are missing the code-mode-host / sandbox helper binaries, and hiding them
/// here flips the status to `missing` so the auto-installer replaces them with
/// the full package layout.
fn scan_managed_runtime(
    app: &HostContext,
    family: &str,
    pinned_version: &str,
    exe_names: &[String],
    layers: &[&str],
    version_args: &[&str],
) -> Option<PathBuf> {
    let root = runtimes_dir(app).ok()?.join(family);
    let runtime_key = runtime_key()?;
    let alt_keys = if runtime_key == "darwin-arm64" {
        vec![runtime_key.to_string(), "darwin-aarch64".into()]
    } else if runtime_key == "darwin-x64" {
        vec![runtime_key.to_string(), "darwin-x86_64".into()]
    } else {
        vec![runtime_key.to_string()]
    };
    // Catalog-pinned version first, then newest-to-oldest. read_dir order is
    // filesystem-dependent (lexicographic on NTFS), which made this report
    // the OLDEST leftover install (e.g. codex 0.135.0) after every upgrade.
    let mut version_dirs: Vec<(String, PathBuf)> = fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            path.is_dir().then_some((name, path))
        })
        .collect();
    version_dirs.sort_by(|a, b| {
        let a_pinned = a.0 == pinned_version;
        let b_pinned = b.0 == pinned_version;
        b_pinned
            .cmp(&a_pinned)
            .then_with(|| version_dir_sort_key(&b.0).cmp(&version_dir_sort_key(&a.0)))
    });
    for (_, version_path) in version_dirs {
        for key in &alt_keys {
            for name in exe_names {
                let base = version_path.join(key);
                for layer in layers {
                    let candidate = if layer.is_empty() {
                        base.join(name)
                    } else {
                        base.join(layer).join(name)
                    };
                    if candidate_is_ready(&candidate, version_args) {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    None
}

fn managed_runtime_is_current(
    app: &HostContext,
    family: &str,
    pinned_version: &str,
    path: &Path,
) -> bool {
    runtimes_dir(app)
        .ok()
        .map(|root| path.starts_with(root.join(family).join(pinned_version)))
        .unwrap_or(false)
}

fn resolve_node_status(app: &HostContext) -> Result<RuntimeItemStatus, String> {
    let exe = exe_name("node");
    let exe_names = vec![exe.clone()];
    let can_install = node_catalog_entry().is_some();
    if let Some(path) = scan_managed_runtime(
        app,
        "node",
        runtime_catalog::node_version(),
        &exe_names,
        &["", "bin"],
        &["--version"],
    ) {
        let stale =
            !managed_runtime_is_current(app, "node", runtime_catalog::node_version(), &path);
        return Ok(
            ready_status("node", "managed", path, &["--version"], can_install && stale)
                .with_catalog_pin(runtime_catalog::node_version(), stale),
        );
    }
    if let Some(path) = bundled_node_candidate(app) {
        return Ok(
            ready_status("node", "bundled", path, &["--version"], can_install)
                .with_catalog_pin(runtime_catalog::node_version(), false),
        );
    }
    if let Some(path) = first_ready(path_candidates(&exe_names), &["--version"]) {
        return Ok(
            ready_status("node", "system", path, &["--version"], can_install)
                .with_catalog_pin(runtime_catalog::node_version(), false),
        );
    }
    Ok(missing_status("node", can_install, None)
        .with_catalog_pin(runtime_catalog::node_version(), false))
}

fn bundled_node_candidate(app: &HostContext) -> Option<PathBuf> {
    app.resource_dir()
        .and_then(|dir| bundled_node_candidate_in_base(&dir))
        .or_else(|| {
            let cwd = std::env::current_dir().ok()?;
            bundled_node_candidate_in_base(&cwd)
        })
}

fn bundled_node_candidate_in_base(base: &Path) -> Option<PathBuf> {
    let runtime = base.join("node-runtime");
    let exe = exe_name("node");
    let key = runtime_key()?;
    let arch_key = key
        .replace("darwin-arm64", "darwin-aarch64")
        .replace("darwin-x64", "darwin-x86_64")
        .replace("linux-arm64", "linux-aarch64")
        .replace("linux-x64", "linux-x86_64");
    for subkey in [key.to_string(), arch_key] {
        for candidate in [
            runtime.join(&subkey).join(&exe),
            runtime.join(&subkey).join("bin").join(&exe),
        ] {
            if candidate_is_ready(&candidate, &["--version"]) {
                return Some(candidate);
            }
        }
    }
    let flat = runtime.join(exe);
    candidate_is_ready(&flat, &["--version"]).then_some(flat)
}

fn resolve_codex_status(app: &HostContext) -> Result<RuntimeItemStatus, String> {
    let exe = exe_name("codex");
    let exe_names = vec![exe.clone()];
    let can_install = codex_catalog_entry().is_some();
    if let Some(path) = scan_managed_runtime(
        app,
        "codex",
        runtime_catalog::codex_version(),
        &exe_names,
        &["bin"],
        &["--version"],
    ) {
        let stale =
            !managed_runtime_is_current(app, "codex", runtime_catalog::codex_version(), &path);
        return Ok(
            ready_status("codex", "managed", path, &["--version"], can_install && stale)
                .with_catalog_pin(runtime_catalog::codex_version(), stale),
        );
    }
    if let Some(path) = first_ready(path_candidates(&exe_names), &["--version"]) {
        return Ok(
            ready_status("codex", "system", path, &["--version"], can_install)
                .with_catalog_pin(runtime_catalog::codex_version(), false),
        );
    }
    if let Some(path) = bundled_codex_candidate(app) {
        return Ok(
            ready_status("codex", "bundled", path, &["--version"], can_install)
                .with_catalog_pin(runtime_catalog::codex_version(), false),
        );
    }
    Ok(missing_status("codex", can_install, None)
        .with_catalog_pin(runtime_catalog::codex_version(), false))
}

fn codex_target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        _ => None,
    }
}

fn codex_platform_package() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("codex-linux-x64"),
        ("linux", "aarch64") => Some("codex-linux-arm64"),
        ("macos", "x86_64") => Some("codex-darwin-x64"),
        ("macos", "aarch64") => Some("codex-darwin-arm64"),
        ("windows", "x86_64") => Some("codex-win32-x64"),
        ("windows", "aarch64") => Some("codex-win32-arm64"),
        _ => None,
    }
}

fn bundled_codex_candidate(app: &HostContext) -> Option<PathBuf> {
    let resource = app.resource_dir();
    let cwd = std::env::current_dir().ok();
    resource
        .iter()
        .chain(cwd.iter())
        .find_map(|base| bundled_codex_candidate_in_base(base))
}

fn bundled_codex_candidate_in_base(base: &Path) -> Option<PathBuf> {
    let triple = codex_target_triple()?;
    let platform_pkg = codex_platform_package()?;
    let exe = exe_name("codex");
    let vendor_roots = [
        base.join("node-sidecar")
            .join("node_modules")
            .join("@openai")
            .join(platform_pkg)
            .join("vendor")
            .join(triple),
        base.join("node-sidecar")
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("vendor")
            .join(triple),
        base.join("node_modules")
            .join("@openai")
            .join(platform_pkg)
            .join("vendor")
            .join(triple),
        base.join("node_modules")
            .join("@openai")
            .join("codex")
            .join("vendor")
            .join(triple),
    ];
    // codex-runtime/bin/<exe> is the package layout current bundles ship;
    // codex-runtime/<exe> is the legacy flat layout of older bundles.
    let candidates: Vec<PathBuf> = [
        base.join("codex-runtime").join("bin").join(&exe),
        base.join("codex-runtime").join(&exe),
    ]
    .into_iter()
    .chain(
        vendor_roots
            .iter()
            .flat_map(|root| [root.join("bin").join(&exe), root.join("codex").join(&exe)]),
    )
    .collect();
    first_ready(candidates, &["--version"])
}

fn resolve_claude_status(app: &HostContext) -> Result<RuntimeItemStatus, String> {
    let exe = exe_name("claude");
    let exe_names = vec![exe.clone()];
    let pinned = runtime_catalog::claude_version();
    if let Some(path) = managed_claude_cli_path(app) {
        if candidate_is_ready(&path, &["--version"]) {
            return Ok(ready_status("claude", "managed", path, &["--version"], false)
                .with_catalog_pin(pinned, false));
        }
    }
    // A managed install from a previous catalog pin. The Claude resolvers only
    // look at the pinned directory, so surface it as stale/updatable instead of
    // silently falling through to whatever the sidecar bundles.
    if let Some(path) = scan_managed_runtime(
        app,
        "claude-agent-sdk",
        pinned,
        &exe_names,
        &[""],
        &["--version"],
    ) {
        return Ok(ready_status("claude", "managed", path, &["--version"], true)
            .with_catalog_pin(pinned, true));
    }
    if let Some(path) = first_ready(path_candidates(&exe_names), &["--version"]) {
        return Ok(ready_status("claude", "system", path, &["--version"], true)
            .with_catalog_pin(pinned, false));
    }
    if let Some(path) = bundled_claude_candidate(app) {
        return Ok(ready_status("claude", "bundled", path, &["--version"], true)
            .with_catalog_pin(pinned, false));
    }
    Ok(missing_status("claude", true, None).with_catalog_pin(pinned, false))
}

fn managed_claude_cli_path(app: &HostContext) -> Option<PathBuf> {
    Some(
        runtimes_dir(app)
            .ok()?
            .join("claude-agent-sdk")
            .join(runtime_catalog::claude_version())
            .join(runtime_key()?)
            .join(exe_name("claude")),
    )
}

fn bundled_claude_candidate(app: &HostContext) -> Option<PathBuf> {
    let resource = app.resource_dir();
    let cwd = std::env::current_dir().ok();
    resource
        .iter()
        .chain(cwd.iter())
        .find_map(|base| bundled_claude_candidate_in_base(app, base))
}

fn bundled_claude_candidate_in_base(app: &HostContext, base: &Path) -> Option<PathBuf> {
    let package = &claude_catalog_entry()?.package_name;
    let exe = exe_name("claude");
    let candidates = [
        base.join("node-sidecar")
            .join("node_modules")
            .join("@anthropic-ai")
            .join(package)
            .join(&exe),
        base.join("node-sidecar")
            .join("dist-node_modules")
            .join("@anthropic-ai")
            .join(package)
            .join(&exe),
    ];
    for candidate in candidates {
        if candidate_is_ready(&candidate, &["--version"]) {
            return Some(candidate);
        }
        let compressed = PathBuf::from(format!("{}.gz", candidate.to_string_lossy()));
        if let Some(path) = extract_compressed_claude_cli(app, &compressed, &exe) {
            return Some(path);
        }
    }
    None
}

fn extract_compressed_claude_cli(
    app: &HostContext,
    compressed: &Path,
    exe: &str,
) -> Option<PathBuf> {
    if !compressed.is_file() {
        return None;
    }
    let bytes = fs::read(compressed).ok()?;
    let cache_key = sha512_hex_prefix(&bytes);
    let out_dir = app
        .data_dir()
        .ok()?
        .join("bin")
        .join("claude-agent-sdk")
        .join(cache_key);
    let out_path = out_dir.join(exe);
    if candidate_is_ready(&out_path, &["--version"]) {
        return Some(out_path);
    }
    let decoded = gunzip(&bytes).ok()?;
    fs::create_dir_all(&out_dir).ok()?;
    fs::write(&out_path, decoded).ok()?;
    #[cfg(unix)]
    {
        fs::set_permissions(&out_path, fs::Permissions::from_mode(0o700)).ok()?;
    }
    candidate_is_ready(&out_path, &["--version"]).then_some(out_path)
}

fn sha512_hex_prefix(bytes: &[u8]) -> String {
    Sha512::digest(bytes)
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn node_catalog_entry() -> Option<&'static runtime_catalog::NodePlatform> {
    runtime_catalog::node_platform(runtime_key()?)
}

fn managed_node_runtime_dir(app: &HostContext) -> Option<PathBuf> {
    Some(
        runtimes_dir(app)
            .ok()?
            .join("node")
            .join(runtime_catalog::node_version())
            .join(runtime_key()?),
    )
}

fn managed_node_cli_path(app: &HostContext) -> Option<PathBuf> {
    let entry = node_catalog_entry()?;
    Some(managed_node_runtime_dir(app)?.join(&entry.exe_path))
}

fn install_managed_node(app: &HostContext) -> Result<PathBuf, String> {
    let entry = node_catalog_entry().ok_or_else(|| {
        format!(
            "Node managed install is not available for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let final_dir = managed_node_runtime_dir(app)
        .ok_or_else(|| "could not resolve Node runtime dir".to_string())?;
    let final_path = managed_node_cli_path(app)
        .ok_or_else(|| "could not resolve Node runtime path".to_string())?;
    if candidate_is_ready(&final_path, &["--version"]) {
        return Ok(final_path);
    }

    let dist_version = format!("v{}", runtime_catalog::node_version());
    let archive_name = format!(
        "node-{dist_version}-{}-{}.{}",
        entry.node_platform, entry.node_arch, entry.archive_ext
    );
    let url = format!("https://nodejs.org/dist/{dist_version}/{archive_name}");
    let archive = download_runtime_archive(&url)?;
    verify_sha256_hex(&archive, &entry.sha256, "Node runtime archive")?;

    let tmp_root = runtimes_dir(app)?
        .join(".tmp")
        .join(format!("node-{}", install_nonce()));
    let archive_path = tmp_root.join(&archive_name);
    let extract_dir = tmp_root.join("extract");
    let tmp_final = tmp_root.join("final");
    let tmp_path = tmp_final.join(&entry.exe_path);
    let _ = fs::remove_dir_all(&tmp_root);
    fs::create_dir_all(&tmp_root).map_err(|err| err.to_string())?;
    fs::write(&archive_path, archive).map_err(|err| err.to_string())?;
    extract_archive_with_tar(&archive_path, &extract_dir)?;
    let extracted_root = first_extracted_dir(&extract_dir)?;
    copy_file_with_parent(&extracted_root.join(&entry.exe_path), &tmp_path)?;
    make_executable(&tmp_path)?;
    for license_name in ["LICENSE", "LICENSE.txt"] {
        let src = extracted_root.join(license_name);
        if src.is_file() {
            let _ = copy_file_with_parent(&src, &tmp_final.join("LICENSE"));
            break;
        }
    }
    fs::write(
        tmp_final.join(".node-version"),
        format!("v{}\n", runtime_catalog::node_version()),
    )
    .map_err(|err| err.to_string())?;
    if !candidate_is_ready(&tmp_path, &["--version"]) {
        let _ = fs::remove_dir_all(&tmp_root);
        return Err("installed Node binary failed --version check".into());
    }
    replace_runtime_dir(&tmp_final, &final_dir)?;
    let _ = fs::remove_dir_all(&tmp_root);
    write_runtime_manifest(app, "node", runtime_catalog::node_version(), &url)?;
    crate::runtime_install::prune_stale_runtime_versions(
        &runtimes_dir(app)?.join("node"),
        runtime_catalog::node_version(),
    );
    Ok(final_path)
}

fn codex_catalog_entry() -> Option<&'static runtime_catalog::CodexPlatform> {
    runtime_catalog::codex_platform(runtime_key()?)
}

fn install_managed_codex(app: &HostContext) -> Result<PathBuf, String> {
    let entry = codex_catalog_entry().ok_or_else(|| {
        format!(
            "Codex managed install is not available for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    // Download / verify / extract / place lives in the tauri-free core so the
    // desktop installer and the headless bat-server can never drift apart
    // again (both used to extract only codex + rg and miss the code-mode-host
    // and sandbox helper binaries the 0.144+ packages ship).
    let final_path = crate::runtime_install::install_codex(&runtimes_dir(app)?)?;
    let url = format!(
        "https://registry.npmjs.org/@openai/codex/-/codex-{}.tgz",
        entry.npm_version
    );
    write_runtime_manifest(app, "codex", runtime_catalog::codex_version(), &url)?;
    Ok(final_path)
}

fn claude_catalog_entry() -> Option<&'static runtime_catalog::ClaudePlatform> {
    runtime_catalog::claude_platform(runtime_key()?)
}

fn install_managed_claude_cli(app: &HostContext) -> Result<PathBuf, String> {
    let entry = claude_catalog_entry().ok_or_else(|| {
        format!(
            "Claude managed install is not available for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let final_path = managed_claude_cli_path(app)
        .ok_or_else(|| "could not resolve Claude runtime path".to_string())?;
    if candidate_is_ready(&final_path, &["--version"]) {
        return Ok(final_path);
    }

    let url = format!(
        "https://registry.npmjs.org/@anthropic-ai/{}/-/{}-{}.tgz",
        entry.package_name,
        entry.package_name,
        runtime_catalog::claude_version()
    );
    let archive = download_runtime_archive(&url)?;
    verify_sri_sha512(&archive, &entry.integrity)?;
    let tar = gunzip(&archive)?;
    let exe = exe_name("claude");
    let exe_bytes = read_tar_entry(&tar, &format!("package/{exe}"))
        .ok_or_else(|| format!("Claude native package missing package/{exe}"))?;

    let tmp_dir = runtimes_dir(app)?
        .join(".tmp")
        .join(format!("claude-agent-sdk-{}", install_nonce()));
    let tmp_path = tmp_dir.join(&exe);
    let final_dir = final_path
        .parent()
        .ok_or_else(|| "invalid Claude runtime path".to_string())?
        .to_path_buf();
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).map_err(|err| err.to_string())?;
    fs::write(&tmp_path, exe_bytes).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o700))
            .map_err(|err| err.to_string())?;
    }
    if !candidate_is_ready(&tmp_path, &["--version"]) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err("installed Claude native binary failed --version check".into());
    }

    replace_runtime_dir(&tmp_dir, &final_dir)?;
    write_runtime_manifest(app, "claude", runtime_catalog::claude_version(), &url)?;
    crate::runtime_install::prune_stale_runtime_versions(
        &runtimes_dir(app)?.join("claude-agent-sdk"),
        runtime_catalog::claude_version(),
    );
    Ok(final_path)
}

fn replace_runtime_dir(tmp_final: &Path, final_dir: &Path) -> Result<(), String> {
    let parent = final_dir
        .parent()
        .ok_or_else(|| "invalid runtime parent".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let name = final_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("runtime");
    let backup = parent.join(format!(".{name}.backup-{}", install_nonce()));
    let mut had_existing = false;
    if final_dir.exists() {
        fs::rename(final_dir, &backup).map_err(|err| err.to_string())?;
        had_existing = true;
    }
    match fs::rename(tmp_final, final_dir) {
        Ok(()) => {
            if had_existing {
                let _ = fs::remove_dir_all(&backup);
            }
            Ok(())
        }
        Err(err) => {
            if had_existing {
                let _ = fs::rename(&backup, final_dir);
            }
            Err(err.to_string())
        }
    }
}

fn copy_file_with_parent(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_file() {
        return Err(format!("missing file: {}", src.display()));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::copy(src, dst).map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn extract_archive_with_tar(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|err| err.to_string())?;
    let tar_bin = if cfg!(windows) {
        let system_tar = PathBuf::from(r"C:\Windows\System32\tar.exe");
        if system_tar.is_file() {
            system_tar
        } else {
            PathBuf::from("tar")
        }
    } else {
        PathBuf::from("tar")
    };
    let mut command = Command::new(&tar_bin);
    command
        .arg("-xf")
        .arg(archive_path)
        .arg("-C")
        .arg(dest_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console_window(&mut command);
    let output = command.output().map_err(|err| {
        format!(
            "failed to start archive extractor {}: {err}",
            tar_bin.display()
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{} failed to extract {}: {}",
            tar_bin.display(),
            archive_path.display(),
            stderr.trim()
        ));
    }
    Ok(())
}

fn first_extracted_dir(parent: &Path) -> Result<PathBuf, String> {
    let entries = fs::read_dir(parent).map_err(|err| err.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            return Ok(path);
        }
    }
    Err(format!(
        "no extracted directory found under {}",
        parent.display()
    ))
}

fn download_runtime_archive(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("better-agent-terminal-runtime-installer")
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client.get(url).send().map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "download failed: {url} -> HTTP {}",
            response.status()
        ));
    }
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|err| err.to_string())
}

fn verify_sri_sha512(bytes: &[u8], integrity: &str) -> Result<(), String> {
    let expected = integrity
        .strip_prefix("sha512-")
        .ok_or_else(|| "missing runtime package sha512 integrity".to_string())?;
    let actual = B64.encode(Sha512::digest(bytes));
    if actual != expected {
        return Err("runtime package integrity mismatch".into());
    }
    Ok(())
}

fn verify_sha256_hex(bytes: &[u8], expected: &str, label: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        return Err(format!("{label} integrity mismatch"));
    }
    Ok(())
}

fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = GzDecoder::new(bytes);
    let mut decoded = Vec::new();
    decoder
        .read_to_end(&mut decoded)
        .map_err(|err| err.to_string())?;
    Ok(decoded)
}

fn read_tar_entry(tar: &[u8], wanted_name: &str) -> Option<Vec<u8>> {
    let mut offset = 0usize;
    while offset + 512 <= tar.len() {
        let header = &tar[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            return None;
        }
        let name = tar_string(&header[0..100]);
        let prefix = tar_string(&header[345..500]);
        let full_name = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let size_text = tar_string(&header[124..136]);
        let size = usize::from_str_radix(size_text.trim().trim_matches('\0'), 8).ok()?;
        offset += 512;
        if offset + size > tar.len() {
            return None;
        }
        if full_name == wanted_name {
            return Some(tar[offset..offset + size].to_vec());
        }
        offset += size.div_ceil(512) * 512;
    }
    None
}

fn tar_string(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).to_string()
}

fn install_nonce() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{}-{millis}", std::process::id())
}

fn write_runtime_manifest(
    app: &HostContext,
    tool: &str,
    version: &str,
    url: &str,
) -> Result<(), String> {
    let path = runtimes_dir(app)?.join("manifest.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let existing = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({ "runtimes": {} }));
    let manifest = merge_runtime_manifest_value(
        existing,
        tool,
        version,
        url,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default(),
    );
    fs::write(
        &path,
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    )
    .map_err(|err| err.to_string())
}

fn merge_runtime_manifest_value(
    mut manifest: Value,
    tool: &str,
    version: &str,
    url: &str,
    installed_at: u128,
) -> Value {
    if !manifest.is_object() {
        manifest = json!({});
    }
    let root = manifest
        .as_object_mut()
        .expect("manifest normalized to object");
    let runtimes = root
        .entry("runtimes".to_string())
        .or_insert_with(|| json!({}));
    if !runtimes.is_object() {
        *runtimes = json!({});
    }
    runtimes
        .as_object_mut()
        .expect("runtimes normalized to object")
        .insert(
            tool.to_string(),
            json!({
                "version": version,
                "source": "managed",
                "url": url,
                "installedAt": installed_at,
            }),
        );
    manifest
}

fn clear_runtime_manifest(app: &HostContext, tool: Option<&str>) -> Result<(), String> {
    let path = runtimes_dir(app)?.join("manifest.json");
    if !path.is_file() {
        return Ok(());
    }
    let existing = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({ "runtimes": {} }));
    let manifest = clear_runtime_manifest_value(existing, tool);
    fs::write(
        &path,
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    )
    .map_err(|err| err.to_string())
}

fn clear_runtime_manifest_value(mut manifest: Value, tool: Option<&str>) -> Value {
    if !manifest.is_object() {
        return json!({ "runtimes": {} });
    }
    let root = manifest.as_object_mut().expect("manifest is an object");
    let runtimes = root
        .entry("runtimes".to_string())
        .or_insert_with(|| json!({}));
    if !runtimes.is_object() {
        *runtimes = json!({});
    }
    if let Some(tool) = tool {
        runtimes
            .as_object_mut()
            .expect("runtimes normalized to object")
            .remove(tool);
    } else {
        *runtimes = json!({});
    }
    manifest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_key_matches_setup_layout_on_supported_platforms() {
        let key = runtime_key().unwrap_or("unsupported");
        if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            assert_eq!(key, "darwin-arm64");
        }
    }

    #[test]
    fn sha512_sri_accepts_catalog_integrity() {
        let bytes = b"fixture";
        let integrity = format!("sha512-{}", B64.encode(Sha512::digest(bytes)));
        assert!(verify_sri_sha512(bytes, &integrity).is_ok());
        assert!(verify_sri_sha512(b"other", &integrity).is_err());
    }

    #[test]
    fn runtime_item_status_serializes_catalog_pin_fields() {
        let status = missing_status("codex", true, None).with_catalog_pin("0.153.2", false);
        let value = serde_json::to_value(&status).expect("serialize");
        assert_eq!(value["pinnedVersion"], json!("0.153.2"));
        assert_eq!(value["managedStale"], json!(false));
        assert_eq!(value["canInstallManaged"], json!(true));

        let stale = missing_status("codex", true, None).with_catalog_pin("0.153.2", true);
        assert!(stale.managed_stale);
        assert_eq!(stale.pinned_version.as_deref(), Some("0.153.2"));
    }

    #[test]
    fn runtime_manifest_merge_preserves_other_tools() {
        let manifest = merge_runtime_manifest_value(
            json!({ "runtimes": { "codex": { "version": "1" } } }),
            "claude",
            "2",
            "https://example.test/claude.tgz",
            42,
        );
        assert_eq!(manifest["runtimes"]["codex"]["version"], json!("1"));
        assert_eq!(manifest["runtimes"]["claude"]["version"], json!("2"));
        assert_eq!(manifest["runtimes"]["claude"]["installedAt"], json!(42));
    }

    #[test]
    fn runtime_manifest_clear_is_scoped_or_global() {
        let manifest = json!({
            "runtimes": {
                "codex": { "version": "1" },
                "claude": { "version": "2" },
            }
        });
        let scoped = clear_runtime_manifest_value(manifest.clone(), Some("claude"));
        assert!(scoped["runtimes"].get("claude").is_none());
        assert_eq!(scoped["runtimes"]["codex"]["version"], json!("1"));

        let cleared = clear_runtime_manifest_value(manifest, None);
        assert_eq!(cleared["runtimes"], json!({}));
    }
}
