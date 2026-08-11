// app:* — Tauri window/profile shell.
//
// Electron owns multi-window behaviour in its main process. The Tauri port
// keeps the renderer-facing contract intact, but the window registry and local
// profile restore now live in Rust so profile windows do not need the Node
// sidecar.

use super::profile as profile_cmd;
use crate::app_data;
use crate::host_context::HostContext;
use crate::log_file::append_line;
use crate::remote_client::RustRemoteClientState;
#[cfg(feature = "desktop")]
use crate::window_registry;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct OpenNewInstanceResult {
    #[serde(rename = "alreadyOpen")]
    pub already_open: bool,
    #[serde(rename = "windowIds", skip_serializing_if = "Vec::is_empty")]
    pub window_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileWindowCloseRequest {
    pub window_id: String,
    pub profile_id: String,
    pub window_index: u32,
    pub window_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileWindowCloseAction {
    Temporary,
    RemoveFromProfile,
    Cancel,
}

static ACTIVE_PROFILE_RESTORE_DONE: OnceLock<Mutex<bool>> = OnceLock::new();
static PROFILE_CLOSE_PROMPTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static PROFILE_CLOSE_ALLOWED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
const REMOTE_APP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn active_profile_restore_done() -> &'static Mutex<bool> {
    ACTIVE_PROFILE_RESTORE_DONE.get_or_init(|| Mutex::new(false))
}

fn profile_close_prompts() -> &'static Mutex<HashSet<String>> {
    PROFILE_CLOSE_PROMPTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn profile_close_allowed() -> &'static Mutex<HashSet<String>> {
    PROFILE_CLOSE_ALLOWED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn mark_profile_close_prompt_pending(window_id: &str) -> bool {
    profile_close_prompts()
        .lock()
        .unwrap()
        .insert(window_id.to_string())
}

fn clear_profile_close_prompt_pending(window_id: &str) {
    profile_close_prompts().lock().unwrap().remove(window_id);
}

fn allow_profile_window_close(window_id: &str) {
    profile_close_allowed()
        .lock()
        .unwrap()
        .insert(window_id.to_string());
}

fn take_profile_window_close_allowed(window_id: &str) -> bool {
    profile_close_allowed().lock().unwrap().remove(window_id)
}

fn clear_profile_window_close_state(window_id: &str) {
    clear_profile_close_prompt_pending(window_id);
    profile_close_allowed().lock().unwrap().remove(window_id);
}

fn parse_profile_window_close_action(value: &str) -> Option<ProfileWindowCloseAction> {
    match value {
        "temporary" => Some(ProfileWindowCloseAction::Temporary),
        "removeFromProfile" => Some(ProfileWindowCloseAction::RemoveFromProfile),
        "cancel" => Some(ProfileWindowCloseAction::Cancel),
        _ => None,
    }
}

fn active_profiles_to_restore(
    active_profile_ids: &[String],
    current_profile_id: Option<&str>,
    profiles: &[profile_cmd::ProfileEntry],
) -> Vec<String> {
    let mut seen = Vec::<String>::new();
    for profile_id in active_profile_ids {
        if profile_id.trim().is_empty() {
            continue;
        }
        if current_profile_id == Some(profile_id.as_str()) {
            continue;
        }
        let Some(profile) = profiles.iter().find(|profile| profile.id == *profile_id) else {
            continue;
        };
        if !profile_can_auto_restore(profile) {
            continue;
        }
        if !seen.iter().any(|seen_id| seen_id == profile_id) {
            seen.push(profile_id.clone());
        }
    }
    seen
}

fn has_non_empty(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
}

fn profile_can_auto_restore(profile: &profile_cmd::ProfileEntry) -> bool {
    if profile.kind != "remote" {
        return true;
    }
    has_non_empty(&profile.remote_host)
        && has_non_empty(&profile.remote_token)
        && has_non_empty(&profile.remote_fingerprint)
}

#[cfg(feature = "desktop")]
pub(crate) fn renderer_url(path: &str) -> WebviewUrl {
    WebviewUrl::App(path.into())
}

pub(crate) fn log_tauri(app: &HostContext, message: &str) {
    eprintln!("[tauri] {message}");
    let Some(path) = app
        .data_dir_opt()
        .map(|dir| dir.join("logs").join("debug.log"))
    else {
        return;
    };
    let line = tauri_log_line(message);
    // Synchronous single-line append (like the pty debug loggers): a fire-and-
    // forget tokio spawn_blocking would panic on the headless server's plain
    // OS threads, which run outside any tokio runtime.
    let _ = append_line(&path, &line);
}

fn tauri_log_line(message: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{millis} [tauri] {message}\n")
}

#[cfg(feature = "desktop")]
fn webview_url_debug(url: &WebviewUrl) -> String {
    match url {
        WebviewUrl::App(path) => format!("app:{}", path.to_string_lossy()),
        WebviewUrl::External(url) => format!("external:{url}"),
        other => format!("{other:?}"),
    }
}

// macOS keeps `set_focus` from unhiding or unminimizing a window, so a
// re-open request that lands on an existing window can leave the user
// staring at the same screen while a banner claims the profile is
// already open. show()+unminimize()+set_focus() mirrors the order used
// for notification-driven focus and reliably brings the window forward.
#[cfg(feature = "desktop")]
fn raise_window(win: &WebviewWindow) {
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

#[cfg(feature = "desktop")]
fn build_window(app: &AppHandle, window_id: &str) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(window_id) {
        window_registry::mark_window_active(app, window_id);
        raise_window(&win);
        return Ok(());
    }
    let build_app = app.clone();
    let build_window_id = window_id.to_string();
    log_tauri(
        &HostContext::from_app(app.clone()),
        &format!("[window] queue-build label={build_window_id}"),
    );
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let schedule_app = build_app.clone();
        let schedule_window_id = build_window_id.clone();
        if let Err(error) = build_app.run_on_main_thread(move || {
            if let Err(error) = build_window_now(&schedule_app, &schedule_window_id) {
                log_tauri(
                    &HostContext::from_app(schedule_app.clone()),
                    &format!(
                        "[window] queued-build-failed label={schedule_window_id} error={error}"
                    ),
                );
            }
        }) {
            log_tauri(
                &HostContext::from_app(build_app.clone()),
                &format!("[window] queue-schedule-failed label={build_window_id} error={error}"),
            );
        }
    });
    Ok(())
}

#[cfg(feature = "desktop")]
fn build_window_now(app: &AppHandle, window_id: &str) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(window_id) {
        window_registry::mark_window_active(app, window_id);
        raise_window(&win);
        return Ok(());
    }
    let url = renderer_url("index.html");
    log_tauri(
        &HostContext::from_app(app.clone()),
        &format!(
            "[window] create label={window_id} url={}",
            webview_url_debug(&url)
        ),
    );
    let nav_app = app.clone();
    let nav_label = window_id.to_string();
    let load_label = window_id.to_string();
    let mut builder = WebviewWindowBuilder::new(app, window_id, url)
        .title("Better Agent Terminal")
        .min_inner_size(800.0, 600.0)
        .on_navigation(move |url| {
            log_tauri(
                &HostContext::from_app(nav_app.clone()),
                &format!("[window] navigation label={nav_label} url={url}"),
            );
            true
        })
        .on_page_load(move |window, payload| {
            log_tauri(
                &HostContext::from_app(window.app_handle().clone()),
                &format!(
                    "[window] page-load label={load_label} event={:?} url={}",
                    payload.event(),
                    payload.url()
                ),
            );
        });
    if let Some((x, y, width, height)) = window_registry::window_bounds(app, window_id) {
        builder = builder.inner_size(width, height).position(x, y);
    } else {
        builder = builder.inner_size(1280.0, 800.0);
    }
    let window = builder.build().map_err(|err| {
        let error = err.to_string();
        log_tauri(
            &HostContext::from_app(app.clone()),
            &format!("[window] build-failed label={window_id} error={error}"),
        );
        error
    })?;
    log_tauri(
        &HostContext::from_app(app.clone()),
        &format!("[window] created label={window_id}"),
    );
    attach_window_lifecycle(&window);
    Ok(())
}

#[cfg(feature = "desktop")]
fn active_webview_window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| {
            window_registry::latest_live_window_id(app)
                .and_then(|window_id| app.get_webview_window(&window_id))
        })
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| windows.values().next().cloned())
}

/// Ask the focused window to open the response-time statistics page.
///
/// The only menu item that hands work to the renderer — the other three are
/// answered entirely in Rust. Targeted at one window rather than broadcast so
/// choosing Statistics does not open the page in every window at once.
#[cfg(feature = "desktop")]
pub(crate) fn request_stats_page(app: &AppHandle) {
    let Some(window) = active_webview_window(app) else {
        return;
    };
    let _ = app.emit_to(window.label(), "app:stats-requested", Value::Null);
}

#[cfg(feature = "desktop")]
pub(crate) fn app_new_window_for_active(app: &AppHandle) -> Option<String> {
    let window = active_webview_window(app)?;
    Some(app_new_window(app.clone(), window))
}

#[cfg(feature = "desktop")]
pub(crate) fn app_focus_next_window_from_active(app: &AppHandle) -> bool {
    let Some(window) = active_webview_window(app) else {
        return false;
    };
    app_focus_next_window(app.clone(), window)
}

#[cfg(feature = "desktop")]
fn profile_window_close_request(
    app: &AppHandle,
    window_id: &str,
) -> Option<ProfileWindowCloseRequest> {
    let profile_id = window_registry::profile_id_for_window(app, window_id)?;
    let window_count = window_registry::live_profile_window_count(app, &profile_id);
    if window_count <= 1 {
        return None;
    }
    let window_index = window_registry::window_index(app, window_id);
    if window_index <= 1 {
        return None;
    }
    Some(ProfileWindowCloseRequest {
        window_id: window_id.to_string(),
        profile_id,
        window_index,
        window_count,
    })
}

#[cfg(feature = "desktop")]
fn request_profile_window_close_decision(app: &AppHandle, window_id: &str) {
    let Some(request) = profile_window_close_request(app, window_id) else {
        return;
    };
    if !mark_profile_close_prompt_pending(window_id) {
        return;
    }
    let _ = app.emit_to(window_id, "app:profile-window-close-requested", request);
}

#[cfg(feature = "desktop")]
pub fn attach_window_lifecycle(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let window_id = window.label().to_string();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if take_profile_window_close_allowed(&window_id) {
                return;
            }
            if profile_window_close_request(&app, &window_id).is_some() {
                api.prevent_close();
                request_profile_window_close_decision(&app, &window_id);
            }
        } else if matches!(event, WindowEvent::Focused(true)) {
            window_registry::mark_window_active(&app, &window_id);
        } else if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            if let Some(window) = app.get_webview_window(&window_id) {
                if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
                    window_registry::update_window_bounds(
                        &app,
                        &window_id,
                        position.x as f64,
                        position.y as f64,
                        size.width as f64,
                        size.height as f64,
                    );
                }
            }
        } else if matches!(event, WindowEvent::Destroyed) {
            log_tauri(
                &HostContext::from_app(app.clone()),
                &format!("[window] destroyed label={window_id}"),
            );
            // Release this window's remote connection binding. The shared socket
            // is torn down only if this window was its last referrer, so sibling
            // windows on the same host keep their connection.
            app.state::<RustRemoteClientState>()
                .inner()
                .disconnect(&window_id);
            clear_profile_window_close_state(&window_id);
            if let Some(profile_id) = window_registry::profile_id_for_window(&app, &window_id) {
                if !window_registry::has_other_live_profile_windows(&app, &profile_id, &window_id) {
                    let _ = profile_cmd::deactivate_profile_id(
                        &HostContext::from_app(app.clone()),
                        &profile_id,
                    );
                }
            }
        }
    });
}

fn parse_launch_profile_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let arg = arg.as_ref();
        if let Some(profile_id) = arg.strip_prefix("--profile=") {
            let profile_id = profile_id.trim();
            if !profile_id.is_empty() {
                return Some(profile_id.to_string());
            }
        }
        if arg == "--profile" {
            if let Some(profile_id) = iter.next() {
                let profile_id = profile_id.as_ref().trim();
                if !profile_id.is_empty() {
                    return Some(profile_id.to_string());
                }
            }
        }
    }
    None
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_get_window_id(window: WebviewWindow) -> String {
    window.label().to_string()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_get_window_index(app: AppHandle, window: WebviewWindow) -> u32 {
    window_registry::window_index(&app, window.label())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_get_launch_profile() -> Option<String> {
    parse_launch_profile_args(std::env::args())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_get_window_profile(app: AppHandle, window: WebviewWindow) -> Option<String> {
    Some(window_registry::get_entry(&app, window.label()).profile_id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_set_title(window: WebviewWindow, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|err| err.to_string())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_resolve_profile_window_close(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
) -> bool {
    let Some(action) = parse_profile_window_close_action(&action) else {
        return false;
    };
    let window_id = window.label().to_string();
    clear_profile_close_prompt_pending(&window_id);
    if action == ProfileWindowCloseAction::Cancel {
        return false;
    }
    if action == ProfileWindowCloseAction::RemoveFromProfile {
        let _ = window_registry::remove_profile_window_entry(&app, &window_id);
    }
    allow_profile_window_close(&window_id);
    window.close().is_ok()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_new_window(app: AppHandle, window: WebviewWindow) -> String {
    let current = window_registry::get_entry(&app, window.label());
    if let Some(id) = remote_app_new_window(&app, window.label(), &current.profile_id) {
        let _ =
            window_registry::create_empty_entry_with_id_for_profile(&app, &id, &current.profile_id);
        let _ = build_window(&app, &id);
        return id;
    }
    app_new_window_for_profile(&app, &current.profile_id)
}

#[cfg(feature = "desktop")]
pub(crate) fn app_new_window_for_profile(app: &AppHandle, profile_id: &str) -> String {
    let entry = window_registry::create_empty_entry_for_profile(app, profile_id);
    let id = entry.id;
    let _ = build_window(app, &id);
    id
}

#[cfg(feature = "desktop")]
fn remote_app_new_window(app: &AppHandle, window_label: &str, profile_id: &str) -> Option<String> {
    let profile = profile_cmd::profile_get(app.clone(), profile_id.to_string())?;
    if profile.kind != "remote" {
        return None;
    }
    let target_profile_id = profile
        .remote_profile_id
        .unwrap_or_else(|| "default".to_string());
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let result = remote_client.invoke(
        window_label,
        "app:new-window",
        vec![Value::String(target_profile_id)],
        REMOTE_APP_TIMEOUT,
    );
    match result {
        Ok(Value::String(id)) if !id.trim().is_empty() => Some(id),
        Ok(Value::Object(obj)) => obj
            .get("windowId")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string),
        Ok(other) => {
            log_tauri(
                &HostContext::from_app(app.clone()),
                &format!("[remote-client] app:new-window returned unexpected payload={other}"),
            );
            None
        }
        Err(err) => {
            log_tauri(
                &HostContext::from_app(app.clone()),
                &format!("[remote-client] app:new-window failed: {err}"),
            );
            None
        }
    }
}

// Returns true exactly once for a window that was just created via
// app_new_window (Cmd+N). The renderer reads this on init to skip
// profile.load(), which would otherwise overwrite the empty snapshot
// with the bound profile's saved workspaces.
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_take_fresh_window_flag(app: AppHandle, window: WebviewWindow) -> bool {
    window_registry::take_fresh_window_flag(&app, window.label())
}

fn next_window_label(mut labels: Vec<String>, current: &str) -> Option<String> {
    if labels.is_empty() {
        return None;
    }
    labels.sort();
    labels
        .iter()
        .position(|label| label == current)
        .map(|idx| labels[(idx + 1) % labels.len()].clone())
        .or_else(|| labels.first().cloned())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_focus_next_window(app: AppHandle, window: WebviewWindow) -> bool {
    let windows = app.webview_windows();
    if windows.len() <= 1 {
        return false;
    }
    let current = window.label().to_string();
    let next = next_window_label(windows.keys().cloned().collect(), &current);
    if let Some(label) = next {
        if let Some(win) = app.get_webview_window(&label) {
            raise_window(&win);
            return true;
        }
    }
    false
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_open_new_instance(app: AppHandle, profile_id: String) -> OpenNewInstanceResult {
    let _ = profile_cmd::activate_profile_id(&HostContext::from_app(app.clone()), &profile_id);
    let live = window_registry::entries_for_profile(&app, &profile_id)
        .into_iter()
        .filter(|entry| app.get_webview_window(&entry.id).is_some())
        .collect::<Vec<_>>();
    if let Some(entry) = live.iter().max_by_key(|entry| entry.last_active_at) {
        if let Some(win) = app.get_webview_window(&entry.id) {
            raise_window(&win);
        }
        return OpenNewInstanceResult {
            already_open: true,
            window_ids: live.into_iter().map(|entry| entry.id).collect(),
            error: None,
        };
    }

    let created = window_registry::create_entries_for_profile(&app, &profile_id);
    let mut ids = Vec::new();
    for entry in &created {
        if let Err(error) = build_window(&app, &entry.id) {
            return OpenNewInstanceResult {
                already_open: false,
                window_ids: ids,
                error: Some(error),
            };
        }
        ids.push(entry.id.clone());
    }
    OpenNewInstanceResult {
        already_open: false,
        window_ids: ids,
        error: None,
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_restore_active_profiles(
    app: AppHandle,
    current_profile_id: Option<String>,
) -> Vec<String> {
    {
        let mut done = active_profile_restore_done().lock().unwrap();
        if *done {
            return Vec::new();
        }
        *done = true;
    }

    let response = profile_cmd::profile_list(app.clone());
    let targets = active_profiles_to_restore(
        &response.active_profile_ids,
        current_profile_id.as_deref(),
        &response.profiles,
    );
    let mut restored = Vec::new();
    for profile_id in targets {
        let result = app_open_new_instance(app.clone(), profile_id);
        restored.extend(result.window_ids);
    }
    restored
}

fn badge_count_value(count: i64) -> Option<i64> {
    if count > 0 {
        Some(count)
    } else {
        None
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_set_dock_badge(app: AppHandle, count: i64) {
    let badge = badge_count_value(count);
    for window in app.webview_windows().values() {
        let _ = window.set_badge_count(badge);
    }
}

/// Real OS version string (Windows: `"MAJOR.MINOR.BUILD"`, e.g.
/// `"10.0.26220"`). The renderer uses the build number to decide whether
/// xterm's Windows ConPTY line-wrapping heuristics should apply — they only
/// matter below build 21376, and a caller that cannot resolve a build number
/// must treat that as "unknown", not "old ConPTY".
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn app_get_system_version() -> String {
    os_version_string()
}

/// `GetVersionExW` is deliberately avoided: it is subject to application
/// manifest compatibility shims and can silently report a stale Windows
/// version. `RtlGetVersion` is unaffected by that shim.
#[cfg(all(feature = "desktop", target_os = "windows"))]
fn os_version_string() -> String {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    let status = unsafe { RtlGetVersion(&mut info) };
    if status != 0 {
        return String::new();
    }
    format!(
        "{}.{}.{}",
        info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
    )
}

#[cfg(all(feature = "desktop", not(target_os = "windows")))]
fn os_version_string() -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_new_instance_serializes_camel_case() {
        let r = OpenNewInstanceResult {
            already_open: false,
            window_ids: vec!["w1".into()],
            error: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"alreadyOpen\":false"), "got: {json}");
        assert!(json.contains("\"windowIds\":[\"w1\"]"), "got: {json}");
        assert!(!json.contains("already_open"), "snake_case leaked: {json}");
    }

    #[test]
    fn profile_window_close_request_serializes_camel_case() {
        let request = ProfileWindowCloseRequest {
            window_id: "profile-default-1".into(),
            profile_id: "default".into(),
            window_index: 2,
            window_count: 3,
        };
        let json = serde_json::to_string(&request).unwrap();
        assert!(
            json.contains("\"windowId\":\"profile-default-1\""),
            "got: {json}"
        );
        assert!(json.contains("\"profileId\":\"default\""), "got: {json}");
        assert!(json.contains("\"windowIndex\":2"), "got: {json}");
        assert!(json.contains("\"windowCount\":3"), "got: {json}");
    }

    #[test]
    fn parse_profile_window_close_action_accepts_expected_values() {
        assert_eq!(
            parse_profile_window_close_action("temporary"),
            Some(ProfileWindowCloseAction::Temporary)
        );
        assert_eq!(
            parse_profile_window_close_action("removeFromProfile"),
            Some(ProfileWindowCloseAction::RemoveFromProfile)
        );
        assert_eq!(
            parse_profile_window_close_action("cancel"),
            Some(ProfileWindowCloseAction::Cancel)
        );
        assert_eq!(parse_profile_window_close_action("remove"), None);
    }

    #[test]
    fn badge_count_value_clears_non_positive_counts() {
        assert_eq!(badge_count_value(0), None);
        assert_eq!(badge_count_value(-1), None);
        assert_eq!(badge_count_value(42), Some(42));
    }

    #[test]
    fn parse_launch_profile_supports_equals_and_split_args() {
        assert_eq!(
            parse_launch_profile_args(["bat", "--profile=remote-1"]),
            Some("remote-1".into())
        );
        assert_eq!(
            parse_launch_profile_args(["bat", "--profile", "local-2"]),
            Some("local-2".into())
        );
        assert_eq!(parse_launch_profile_args(["bat", "--profile="]), None);
    }

    #[test]
    fn next_window_label_wraps_and_defaults_to_first_label() {
        let labels = vec![
            "profile-default-300-3".to_string(),
            "main".to_string(),
            "profile-default-100-1".to_string(),
        ];

        assert_eq!(
            next_window_label(labels.clone(), "profile-default-300-3").as_deref(),
            Some("main")
        );
        assert_eq!(
            next_window_label(labels.clone(), "missing").as_deref(),
            Some("main")
        );
        assert_eq!(next_window_label(Vec::new(), "main"), None);
    }

    #[test]
    fn active_profiles_restore_skips_current_and_duplicates() {
        let ids = vec![
            "default".to_string(),
            "work".to_string(),
            "work".to_string(),
            "".to_string(),
            "remote".to_string(),
        ];
        let profiles = vec![
            profile_entry("default", "local"),
            profile_entry("work", "local"),
            profile_entry("remote", "local"),
        ];
        assert_eq!(
            active_profiles_to_restore(&ids, Some("default"), &profiles),
            vec!["work".to_string(), "remote".to_string()]
        );
        assert_eq!(
            active_profiles_to_restore(&ids, Some("work"), &profiles),
            vec!["default".to_string(), "remote".to_string()]
        );
    }

    #[test]
    fn active_profiles_restore_skips_remote_profiles_without_connection_info() {
        let ids = vec![
            "bat".to_string(),
            "remote-missing-token".to_string(),
            "remote-ready".to_string(),
        ];
        let mut missing_token = profile_entry("remote-missing-token", "remote");
        missing_token.remote_host = Some("192.168.1.2".into());
        missing_token.remote_fingerprint = Some("AA:BB".into());
        let mut ready = profile_entry("remote-ready", "remote");
        ready.remote_host = Some("192.168.1.3".into());
        ready.remote_token = Some("token".into());
        ready.remote_fingerprint = Some("CC:DD".into());
        let profiles = vec![profile_entry("bat", "local"), missing_token, ready];

        assert_eq!(
            active_profiles_to_restore(&ids, Some("bat"), &profiles),
            vec!["remote-ready".to_string()]
        );
    }

    fn profile_entry(id: &str, kind: &str) -> profile_cmd::ProfileEntry {
        profile_cmd::ProfileEntry {
            id: id.into(),
            name: id.into(),
            kind: kind.into(),
            remote_host: None,
            remote_port: None,
            remote_token: None,
            remote_fingerprint: None,
            remote_profile_id: None,
            remote_profile_name: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn renderer_url_uses_app_url_for_dynamic_windows() {
        let url = renderer_url("index.html?detached=w1");
        match url {
            WebviewUrl::App(path) => {
                assert_eq!(path.to_string_lossy(), "index.html?detached=w1")
            }
            other => panic!("expected Tauri app URL, got {other:?}"),
        }
    }

    #[test]
    fn tauri_log_line_has_tauri_prefix() {
        let line = tauri_log_line("hello");
        assert!(line.contains(" [tauri] hello\n"));
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn system_version_string_is_well_formed_on_windows() {
        let version = os_version_string();
        #[cfg(target_os = "windows")]
        {
            let parts: Vec<&str> = version.split('.').collect();
            assert_eq!(
                parts.len(),
                3,
                "expected MAJOR.MINOR.BUILD, got: {version:?}"
            );
            for part in &parts {
                assert!(
                    !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()),
                    "non-numeric segment in {version:?}"
                );
            }
            // A manifest-shimmed API (GetVersionExW style) reports builds like
            // 9200/9600; any real Windows 10+ machine is >= 10240 (Win10 RTM).
            let build: u32 = parts[2].parse().expect("numeric build segment");
            assert!(build >= 10240, "expected Windows build >= 10240, got {build}");
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Non-Windows: an empty placeholder is an acceptable "unknown".
            let _ = version;
        }
    }
}
