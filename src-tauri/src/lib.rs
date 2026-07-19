// Tauri shell entrypoint for Better Agent Terminal.
//
// This file is intentionally small: the Electron preload still owns most of
// the host surface during the migration. Each new command lands here behind
// a strongly typed signature, and the renderer reaches it via the
// host-api adapter (renderer/src/host-api.ts). See plans/tauri-migration-plan.md.

mod account_store;
mod app_data;
#[cfg(feature = "desktop")]
mod app_menu;
mod async_rt;
#[cfg(feature = "desktop")]
mod claude_usage;
mod codex_account_store;
mod codex_app_server;
mod codex_auth;
mod commands;
mod electron_safe_storage;
mod event_hub;
mod host_context;
mod linux_wayland;
mod log_file;
mod network_addresses;
mod panic_log;
mod path_guard;
mod remote_client;
pub mod remote_core;
mod remote_server;
mod runtime_catalog;
// Tauri-free managed-runtime install core, shared by the desktop installer
// (commands/runtime.rs delegates the codex download/extract/place to it) and
// the headless bat-server, which self-provisions codex from it on startup.
mod runtime_install;
mod sidecar;
mod subprocess;
#[cfg(feature = "desktop")]
mod window_registry;

// The command aliases, json helpers and tauri re-exports are only used by the
// desktop shell entry (`run`/`app_builder`) and the Tauri-backed headless
// server. The GUI-free (`--no-default-features`) build provides its own
// tauri-free `run_headless_server`, so gate these to keep that build clean.
#[cfg(feature = "desktop")]
use commands::{
    agent as agent_cmd, app as app_cmd, claude as claude_cmd, claude_channel as claude_channel_cmd,
    claude_cli as claude_cli_cmd, clipboard as clipboard_cmd, debug as debug_cmd,
    dialog as dialog_cmd, fs as fs_cmd, fugu as fugu_cmd, git as git_cmd, github as github_cmd,
    image as image_cmd, notification as notification_cmd, profile as profile_cmd, pty as pty_cmd,
    remote as remote_cmd, runtime as runtime_cmd, settings, shell as shell_cmd,
    snippet as snippet_cmd, tunnel as tunnel_cmd, update as update_cmd,
    worker_buffer as worker_buffer_cmd, workspace as workspace_cmd, worktree as worktree_cmd,
};
use serde_json::{json, Value};
use std::path::PathBuf;
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};

const SYSTEMD_TOKEN_CREDENTIAL: &str = "bat-server-token";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeadlessTokenSource {
    CommandLine,
    Environment,
    TokenFile,
    SystemdCredential,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HeadlessTokenInput {
    Value(String, HeadlessTokenSource),
    File(PathBuf, HeadlessTokenSource),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HeadlessServerArgs {
    port: u16,
    bind_interface: String,
    data_dir: Option<PathBuf>,
    token: Option<String>,
    token_source: Option<HeadlessTokenSource>,
}

#[derive(Debug)]
enum HeadlessCliAction {
    Run(HeadlessServerArgs),
    Help,
}

/// Run any display-server compatibility shims before GTK / GLib / WebKit start.
///
/// On Linux this fixes the AppImage libwayland skew that blanks the window on
/// newer distros (GitHub issue #112) by re-exec'ing with the system
/// libwayland-client preloaded. It is strictly gated (AppImage + Wayland only,
/// at most once) and a no-op everywhere else. Must be called as early as
/// possible in `main`, before any windowing toolkit is touched.
#[cfg(target_os = "linux")]
pub fn ensure_display_server_compat() {
    linux_wayland::preload_system_libwayland();
}

#[cfg(not(target_os = "linux"))]
pub fn ensure_display_server_compat() {}

pub fn is_headless_server_invocation() -> bool {
    std::env::args().any(|arg| arg == "--bat-server")
}

fn execute_headless_server_cli<F>(run_server: F) -> i32
where
    F: FnOnce(HeadlessServerArgs) -> Result<(), String>,
{
    match parse_headless_server_args(std::env::args().skip(1)) {
        Ok(HeadlessCliAction::Help) => {
            print_headless_server_help();
            0
        }
        Ok(HeadlessCliAction::Run(args)) => {
            if let Some(warning) = legacy_headless_token_warning(args.token_source) {
                eprintln!("[bat-server] warning: {warning}");
            }
            match run_server(args) {
                Ok(()) => 0,
                Err(err) => {
                    eprintln!("bat-server failed to start: {err}");
                    1
                }
            }
        }
        Err(err) => {
            eprintln!("bat-server: {err}");
            eprintln!("Try `bat-server --help` for usage.");
            1
        }
    }
}

#[cfg(not(feature = "desktop"))]
pub fn run_headless_server_cli() -> i32 {
    execute_headless_server_cli(run_headless_server)
}

#[cfg(feature = "desktop")]
pub fn run_headless_server_cli(context: tauri::Context<tauri::Wry>) -> i32 {
    execute_headless_server_cli(|args| run_headless_server(args, context))
}

#[cfg(feature = "desktop")]
pub fn run(context: tauri::Context<tauri::Wry>) {
    let app = app_builder(false)
        .build(context)
        .expect("error while building better-agent-terminal");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // Capture refreshed Codex tokens / memory back to the active
            // account's store before exit (no-op unless unified mode is ON).
            codex_app_server::snapshot_active_identity_on_exit(
                &crate::host_context::HostContext::from_app(app_handle.clone()),
            );
        }
    });
}

#[cfg(feature = "desktop")]
fn app_builder(headless: bool) -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .menu(app_menu::build)
        .on_menu_event(app_menu::handle_event)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty_cmd::PtyState::default())
        .manage(notification_cmd::NotificationState::default())
        .manage(notification_cmd::AgentNotificationState::default())
        .manage(fs_cmd::FsWatcherState::default())
        .manage(fs_cmd::FsUploadState::default())
        .manage(snippet_cmd::SnippetState::default())
        .manage(worker_buffer_cmd::WorkerBufferState::default())
        .manage(worktree_cmd::WorktreeState::default())
        .manage(event_hub::RuntimeEventHubState::default())
        .manage(remote_client::RustRemoteClientState::default())
        .manage(remote_server::RustRemoteServerState::default())
        .manage(codex_app_server::CodexAppServerState::default())
        .manage(window_registry::WindowRegistryState::default())
        .manage(sidecar::SidecarState::new())
        .setup(move |app| {
            if let Some(data_dir) = app_data::app_data_dir_opt(app.handle()) {
                panic_log::install(data_dir);
            }
            if !headless {
                // Tier 2 is the default: recover from an interrupted swap and
                // auto-migrate legacy multi-HOME Codex accounts into the unified
                // model on first run. Runs off the UI thread (copy-only, idempotent;
                // no-op when the user has explicitly disabled unified mode).
                {
                    let codex_state = app
                        .state::<codex_app_server::CodexAppServerState>()
                        .inner()
                        .clone();
                    let handle = crate::host_context::HostContext::from_app(app.handle().clone());
                    std::thread::spawn(move || codex_state.init_unified_on_startup(&handle));
                }
                if let Some(window) = app.get_webview_window("main") {
                    app_cmd::attach_window_lifecycle(&window);
                }
                remote_cmd::spawn_auto_start_remote_server(app.handle().clone());
                // Host-wide 5h/7d subscription usage poller (one thread per
                // host, active account per tick). Rust-side so it survives
                // sidecar restarts and works before the node runtime exists.
                claude_usage::start(app.handle().clone());
                if let Ok(token) = std::env::var("BAT_TAURI_DYNAMIC_WINDOW_SMOKE_TOKEN") {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1200));
                        for _ in 0..12 {
                            let _ = handle.emit_to("main", "bat:smoke-new-window", token.clone());
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::settings_load,
            settings::settings_save,
            settings::settings_get_shell_path,
            settings::settings_clear_terminal_history,
            settings::settings_detect_cx,
            fugu_cmd::codex_fugu_status,
            fugu_cmd::codex_fugu_set_key,
            runtime_cmd::runtime_get_status,
            runtime_cmd::runtime_install,
            runtime_cmd::runtime_open_runtime_folder,
            runtime_cmd::runtime_clear_managed,
            shell_cmd::shell_open_external,
            shell_cmd::shell_open_path,
            dialog_cmd::dialog_confirm,
            dialog_cmd::dialog_select_folder,
            dialog_cmd::dialog_select_files,
            dialog_cmd::dialog_select_images,
            fs_cmd::fs_read_file,
            fs_cmd::fs_home,
            fs_cmd::fs_readdir,
            fs_cmd::fs_is_directory,
            fs_cmd::fs_list_dirs,
            fs_cmd::fs_mkdir,
            fs_cmd::fs_delete_path,
            fs_cmd::fs_quick_locations,
            fs_cmd::fs_resolve_path_links,
            fs_cmd::fs_search,
            fs_cmd::fs_watch,
            fs_cmd::fs_unwatch,
            fs_cmd::remote_upload_file_to_host,
            fs_cmd::fs_upload_to_dir,
            fs_cmd::fs_download_file,
            clipboard_cmd::clipboard_save_image,
            clipboard_cmd::clipboard_write_text,
            clipboard_cmd::clipboard_write_image,
            image_cmd::image_read_as_data_url,
            image_cmd::image_save_data_url,
            pty_cmd::pty_create,
            pty_cmd::pty_write,
            pty_cmd::pty_read_buffer,
            pty_cmd::pty_resize,
            pty_cmd::pty_get_viewport_state,
            pty_cmd::pty_set_viewport_mode,
            pty_cmd::pty_set_viewport_size,
            pty_cmd::pty_kill,
            pty_cmd::pty_restart,
            pty_cmd::pty_get_cwd,
            workspace_cmd::workspace_load,
            workspace_cmd::workspace_save,
            workspace_cmd::workspace_detach,
            workspace_cmd::workspace_reattach,
            workspace_cmd::workspace_move_to_window,
            update_cmd::update_get_version,
            update_cmd::update_check,
            update_cmd::update_get_bundle_mode,
            update_cmd::update_check_native,
            update_cmd::update_install,
            debug_cmd::debug_is_debug_mode,
            debug_cmd::debug_is_pty_input_trace,
            debug_cmd::debug_log,
            debug_cmd::debug_open_logs_folder,
            git_cmd::git_get_github_url,
            git_cmd::git_get_branch,
            git_cmd::git_get_log,
            git_cmd::git_get_diff,
            git_cmd::git_get_diff_files,
            git_cmd::git_get_root,
            git_cmd::git_get_status,
            app_cmd::app_get_window_id,
            app_cmd::app_get_window_index,
            app_cmd::app_get_launch_profile,
            app_cmd::app_get_window_profile,
            app_cmd::app_set_title,
            app_cmd::app_resolve_profile_window_close,
            app_cmd::app_new_window,
            app_cmd::app_take_fresh_window_flag,
            app_cmd::app_focus_next_window,
            app_cmd::app_open_new_instance,
            app_cmd::app_restore_active_profiles,
            app_cmd::app_set_dock_badge,
            notification_cmd::notification_list,
            notification_cmd::notification_mark_read,
            notification_cmd::notification_mark_all_read,
            notification_cmd::notification_mark_window_read,
            notification_cmd::notification_clear,
            notification_cmd::notification_focus_latest_unread,
            notification_cmd::notification_focus_entry,
            github_cmd::github_check_cli,
            github_cmd::github_pr_list,
            github_cmd::github_issue_list,
            github_cmd::github_pr_view,
            github_cmd::github_issue_view,
            github_cmd::github_pr_comment,
            github_cmd::github_issue_comment,
            snippet_cmd::snippet_get_all,
            snippet_cmd::snippet_get_by_id,
            snippet_cmd::snippet_get_favorites,
            snippet_cmd::snippet_search,
            snippet_cmd::snippet_get_by_workspace,
            snippet_cmd::snippet_get_categories,
            snippet_cmd::snippet_create,
            snippet_cmd::snippet_update,
            snippet_cmd::snippet_delete,
            snippet_cmd::snippet_toggle_favorite,
            profile_cmd::profile_list,
            profile_cmd::profile_list_local,
            profile_cmd::profile_get,
            profile_cmd::profile_get_active_ids,
            profile_cmd::profile_create,
            profile_cmd::profile_save,
            profile_cmd::profile_load,
            profile_cmd::profile_delete,
            profile_cmd::profile_rename,
            profile_cmd::profile_update,
            profile_cmd::profile_duplicate,
            profile_cmd::profile_activate,
            profile_cmd::profile_deactivate,
            claude_cmd::claude_ping,
            claude_cmd::claude_auth_status,
            claude_cmd::claude_account_list,
            claude_cmd::claude_start_session,
            claude_cmd::claude_send_message,
            claude_cmd::claude_stop_session,
            claude_cmd::claude_abort_session,
            claude_cmd::claude_interrupt_turn,
            claude_cmd::claude_stop_task,
            claude_cmd::claude_auth_login,
            claude_cmd::claude_auth_logout,
            claude_cmd::claude_auth_login_start,
            claude_cmd::claude_auth_login_submit_code,
            claude_cmd::claude_auth_login_cancel,
            claude_cmd::claude_account_import_current,
            claude_cmd::claude_account_login_new,
            claude_cmd::claude_account_switch,
            claude_cmd::claude_account_remove,
            claude_cmd::claude_account_mark_warning_shown,
            claude_cmd::codex_account_info,
            claude_cmd::codex_account_list,
            claude_cmd::codex_account_switch,
            claude_cmd::codex_unified_status,
            claude_cmd::codex_unified_migrate,
            claude_cmd::codex_account_capture_current,
            claude_cmd::codex_account_remove_unified,
            claude_cmd::codex_account_login,
            claude_cmd::codex_account_login_cancel,
            claude_cmd::codex_account_login_device_start,
            claude_cmd::codex_account_login_device_poll,
            claude_cmd::codex_account_login_device_cancel,
            claude_cmd::claude_get_cli_path,
            claude_cmd::claude_prepare_cli_session,
            claude_cmd::claude_list_sessions,
            claude_cmd::claude_get_supported_models,
            claude_cmd::claude_get_supported_efforts,
            claude_cmd::claude_get_supported_codex_sandbox_modes,
            claude_cmd::claude_get_supported_codex_approval_policies,
            claude_cmd::claude_get_supported_commands,
            claude_cmd::claude_get_supported_agents,
            claude_cmd::claude_get_account_info,
            claude_cmd::claude_get_session_state,
            claude_cmd::claude_get_session_meta,
            claude_cmd::claude_get_context_usage,
            claude_cmd::claude_get_worktree_status,
            claude_cmd::claude_scan_skills,
            claude_cmd::claude_cleanup_worktree,
            claude_cmd::claude_set_auto_continue,
            claude_cmd::claude_get_auto_continue,
            claude_cmd::claude_set_permission_mode,
            claude_cmd::claude_set_codex_sandbox_mode,
            claude_cmd::claude_set_codex_approval_policy,
            claude_cmd::claude_set_model,
            claude_cmd::claude_set_effort,
            claude_cmd::claude_reset_session,
            claude_cmd::claude_resume_session,
            claude_cmd::claude_client_resume,
            claude_cmd::claude_fork_session,
            claude_cmd::claude_fetch_subagent_messages,
            claude_cmd::claude_rest_session,
            claude_cmd::claude_wake_session,
            claude_cmd::claude_is_resting,
            claude_cmd::claude_archive_messages,
            claude_cmd::claude_load_archived,
            claude_cmd::claude_clear_archive,
            claude_cmd::claude_rewind_to_prompt,
            claude_cmd::claude_resolve_permission,
            claude_cmd::claude_resolve_ask_user,
            claude_cmd::claude_check_mcp_json_status,
            claude_cmd::claude_enable_all_project_mcp,
            claude_channel_cmd::claude_channel_get_capabilities,
            claude_channel_cmd::claude_channel_start_session,
            claude_channel_cmd::claude_channel_send_message,
            claude_channel_cmd::claude_channel_stop_session,
            claude_channel_cmd::claude_channel_get_status,
            claude_cli_cmd::claude_cli_get_capabilities,
            claude_cli_cmd::claude_cli_start_session,
            claude_cli_cmd::claude_cli_stop_session,
            claude_cli_cmd::claude_cli_get_status,
            worktree_cmd::worktree_create,
            worktree_cmd::worktree_remove,
            worktree_cmd::worktree_status,
            worktree_cmd::worktree_merge,
            worktree_cmd::worktree_rehydrate,
            agent_cmd::agent_get_supported_session_types,
            agent_cmd::agent_list_presets,
            claude_usage::agent_usage_snapshot,
            claude_usage::agent_usage_peek,
            worker_buffer_cmd::worker_buffer_init,
            worker_buffer_cmd::worker_buffer_append,
            worker_buffer_cmd::worker_buffer_read_all,
            worker_buffer_cmd::worker_buffer_clear,
            worker_buffer_cmd::worker_procfile_load,
            worker_buffer_cmd::worker_procfile_start,
            worker_buffer_cmd::worker_procfile_stop,
            remote_cmd::remote_start_server,
            remote_cmd::remote_stop_server,
            remote_cmd::remote_server_status,
            remote_cmd::remote_rotate_token,
            remote_cmd::remote_connect,
            remote_cmd::remote_disconnect,
            remote_cmd::remote_client_status,
            remote_cmd::remote_test_connection,
            remote_cmd::remote_list_profiles,
            tunnel_cmd::tunnel_get_connection,
        ])
}

// GUI-free build: serve the RemoteServer on a tauri-free HostContext backed by
// a HeadlessHost. Links no tauri/wry/webkit. States are registered up-front so
// the dispatch's `ctx.state::<T>()` lookups resolve; runtime events are routed
// straight to connected remote clients via the emit sink (there are no local
// webviews to receive them).
#[cfg(not(feature = "desktop"))]
fn run_headless_server(args: HeadlessServerArgs) -> Result<(), String> {
    use crate::host_context::{HeadlessHost, HostContext};

    let data_dir = args
        .data_dir
        .clone()
        .or_else(app_data::app_data_dir_opt)
        .ok_or_else(|| "bat-server: could not resolve app data dir".to_string())?;
    panic_log::install(data_dir.clone());

    let remote_state = remote_server::RustRemoteServerState::default();
    let sidecar_state = sidecar::SidecarState::new();

    // ctx.emit() on headless has no local webview; route every runtime event to
    // the connected remote clients through the RemoteServer broadcast.
    let emit_sink: crate::sidecar::EventSink = {
        let broadcast_state = remote_state.clone();
        std::sync::Arc::new(move |topic: &str, payload: &Value| {
            broadcast_state.broadcast_event(topic, payload);
        })
    };

    let mut host = HeadlessHost::new(Some(data_dir.clone()), emit_sink);
    host.manage(remote_state.clone());
    host.manage(sidecar_state.clone());
    host.manage(crate::commands::pty::PtyState::default());
    host.manage(crate::commands::notification::NotificationState::default());
    host.manage(crate::commands::notification::AgentNotificationState::default());
    host.manage(crate::commands::fs::FsWatcherState::default());
    host.manage(crate::commands::fs::FsUploadState::default());
    host.manage(crate::commands::snippet::SnippetState::default());
    host.manage(crate::commands::worker_buffer::WorkerBufferState::default());
    host.manage(crate::commands::worktree::WorktreeState::default());
    host.manage(event_hub::RuntimeEventHubState::default());
    host.manage(remote_client::RustRemoteClientState::default());
    host.manage(codex_app_server::CodexAppServerState::default());

    let ctx = HostContext::from_headless(std::sync::Arc::new(host));

    let mut options = json!({
        "port": args.port,
        "bindInterface": args.bind_interface,
    });
    if let Some(token) = &args.token {
        options["token"] = Value::String(token.clone());
    }

    let result = remote_state.start(ctx, sidecar_state, Some(options))?;
    print_headless_server_banner_headless(&data_dir, &result)?;

    // Self-provision the codex runtime so remote clients can start codex
    // sessions against this host. Runs off-thread: the ~100MB download must not
    // block the accept loop, and a failure (offline, unsupported arch) leaves
    // the server fully usable for claude. Idempotent — a no-op once installed.
    ensure_codex_runtime_async(data_dir.join("runtimes"));

    // The accept loop runs on its own thread; keep the process alive.
    loop {
        std::thread::park();
    }
}

#[cfg(not(feature = "desktop"))]
fn ensure_codex_runtime_async(runtimes_dir: std::path::PathBuf) {
    if crate::runtime_install::codex_is_installed(&runtimes_dir) {
        eprintln!("[bat-server] codex runtime already present");
        return;
    }
    std::thread::spawn(move || {
        eprintln!("[bat-server] codex runtime missing; installing in background…");
        match crate::runtime_install::install_codex(&runtimes_dir) {
            Ok(path) => eprintln!("[bat-server] codex runtime ready at {}", path.display()),
            Err(err) => eprintln!("[bat-server] codex runtime install failed: {err}"),
        }
    });
}

#[cfg(not(feature = "desktop"))]
fn print_headless_server_banner_headless(
    data_dir: &std::path::Path,
    result: &Value,
) -> Result<(), String> {
    let field = |key: &str| -> Result<String, String> {
        result
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("remote server result missing {key}"))
    };
    let port = result
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| "remote server result missing port".to_string())?;
    let bound_host = field("boundHost")?;
    let bind_interface = field("bindInterface")?;
    let token = field("token")?;
    let fingerprint = field("fingerprint")?;

    println!();
    println!("bat-server ready");
    println!("  url:         wss://{bound_host}:{port}");
    println!("  bind:        {bind_interface}");
    println!("  token:       {token}");
    println!("  fingerprint: {fingerprint}");
    println!("  data-dir:    {}", data_dir.display());
    println!(
        "  connect:     wss://{bound_host}:{port}?token={}&fp={}",
        encode_query_component(&token),
        encode_query_component(&fingerprint)
    );
    Ok(())
}

#[cfg(feature = "desktop")]
fn run_headless_server(
    args: HeadlessServerArgs,
    mut context: tauri::Context<tauri::Wry>,
) -> Result<(), String> {
    if let Some(data_dir) = &args.data_dir {
        std::env::set_var(app_data::TAURI_DATA_DIR_ENV, data_dir);
    }

    context.config_mut().app.windows.clear();

    let app = app_builder(true)
        .build(context)
        .map_err(|err| format!("headless Tauri runtime build failed: {err}"))?;
    start_headless_remote_server(app.handle(), &args)?;
    app.run(|_app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
        }
    });
    Ok(())
}

#[cfg(feature = "desktop")]
fn start_headless_remote_server(
    app: &tauri::AppHandle,
    args: &HeadlessServerArgs,
) -> Result<(), String> {
    let remote_state = app.state::<remote_server::RustRemoteServerState>();
    let sidecar_state = app.state::<sidecar::SidecarState>().inner().clone();
    let mut options = json!({
        "port": args.port,
        "bindInterface": args.bind_interface,
    });
    if let Some(token) = &args.token {
        options["token"] = Value::String(token.clone());
    }

    let result = remote_state.start(
        crate::host_context::HostContext::from_app(app.clone()),
        sidecar_state,
        Some(options),
    )?;
    print_headless_server_banner(app, &result)?;
    Ok(())
}

#[cfg(feature = "desktop")]
fn print_headless_server_banner(app: &tauri::AppHandle, result: &Value) -> Result<(), String> {
    let port = result
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| "remote server result missing port".to_string())?;
    let bound_host = result
        .get("boundHost")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote server result missing boundHost".to_string())?;
    let bind_interface = result
        .get("bindInterface")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote server result missing bindInterface".to_string())?;
    let token = result
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote server result missing token".to_string())?;
    let fingerprint = result
        .get("fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote server result missing fingerprint".to_string())?;
    let data_dir = app_data::app_data_dir(app)?;
    let connect_url = format!(
        "wss://{bound_host}:{port}?token={}&fp={}",
        encode_query_component(token),
        encode_query_component(fingerprint)
    );

    println!();
    println!("bat-server ready");
    println!("  url:         wss://{bound_host}:{port}");
    println!("  bind:        {bind_interface}");
    println!("  token:       {token}");
    println!("  fingerprint: {fingerprint}");
    println!("  data-dir:    {}", data_dir.display());
    println!("  connect:     {connect_url}");
    println!();
    Ok(())
}

fn encode_query_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn parse_headless_server_args<I>(args: I) -> Result<HeadlessCliAction, String>
where
    I: IntoIterator<Item = String>,
{
    let mut port = parse_env_port()?.unwrap_or(9876);
    let mut bind_interface = std::env::var("BAT_BIND").unwrap_or_else(|_| "localhost".into());
    let mut data_dir = std::env::var_os("BAT_DATA_DIR")
        .or_else(|| std::env::var_os(app_data::TAURI_DATA_DIR_ENV))
        .map(PathBuf::from)
        .or_else(default_headless_data_dir);
    let mut token_input = default_headless_token_input();
    let mut iter = args.into_iter().peekable();

    while let Some(arg) = iter.next() {
        if arg == "--bat-server" {
            continue;
        }
        if arg == "--help" || arg == "-h" {
            return Ok(HeadlessCliAction::Help);
        }
        if arg == "--debug" {
            std::env::set_var("BAT_DEBUG", "1");
            continue;
        }
        if let Some(value) = arg.strip_prefix("--port=") {
            port = parse_port(value)?;
            continue;
        }
        if arg == "--port" {
            let value = iter
                .next()
                .ok_or_else(|| "--port requires a value".to_string())?;
            port = parse_port(&value)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--bind=") {
            bind_interface = value.to_string();
            continue;
        }
        if arg == "--bind" {
            bind_interface = iter
                .next()
                .ok_or_else(|| "--bind requires a value".to_string())?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--data-dir=") {
            data_dir = Some(PathBuf::from(value));
            continue;
        }
        if arg == "--data-dir" {
            data_dir = Some(PathBuf::from(
                iter.next()
                    .ok_or_else(|| "--data-dir requires a value".to_string())?,
            ));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--token=") {
            token_input = Some(HeadlessTokenInput::Value(
                value.to_string(),
                HeadlessTokenSource::CommandLine,
            ));
            continue;
        }
        if arg == "--token" {
            token_input = Some(HeadlessTokenInput::Value(
                iter.next()
                    .ok_or_else(|| "--token requires a value".to_string())?,
                HeadlessTokenSource::CommandLine,
            ));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--token-file=") {
            if value.is_empty() {
                return Err("--token-file requires a path".to_string());
            }
            token_input = Some(HeadlessTokenInput::File(
                PathBuf::from(value),
                HeadlessTokenSource::TokenFile,
            ));
            continue;
        }
        if arg == "--token-file" {
            let value = iter
                .next()
                .ok_or_else(|| "--token-file requires a path".to_string())?;
            token_input = Some(HeadlessTokenInput::File(
                PathBuf::from(value),
                HeadlessTokenSource::TokenFile,
            ));
            continue;
        }
        if arg.starts_with('-') {
            return Err(format!("unknown flag: {arg}"));
        }
        return Err(format!("unexpected argument: {arg}"));
    }

    let bind_interface = normalize_headless_bind(&bind_interface)?;
    let (token, token_source) = match token_input {
        Some(HeadlessTokenInput::Value(token, source)) => (Some(token), Some(source)),
        Some(HeadlessTokenInput::File(path, source)) => {
            (Some(read_headless_token_file(&path)?), Some(source))
        }
        None => (None, None),
    };
    Ok(HeadlessCliAction::Run(HeadlessServerArgs {
        port,
        bind_interface,
        data_dir,
        token,
        token_source,
    }))
}

fn default_headless_token_input() -> Option<HeadlessTokenInput> {
    if let Some(token) = std::env::var("BAT_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
    {
        return Some(HeadlessTokenInput::Value(
            token,
            HeadlessTokenSource::Environment,
        ));
    }

    if let Some(path) = std::env::var_os("BAT_TOKEN_FILE")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return Some(HeadlessTokenInput::File(
            path,
            HeadlessTokenSource::TokenFile,
        ));
    }

    if let Some(directory) = std::env::var_os("CREDENTIALS_DIRECTORY")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        let path = directory.join(SYSTEMD_TOKEN_CREDENTIAL);
        if path.is_file() {
            return Some(HeadlessTokenInput::File(
                path,
                HeadlessTokenSource::SystemdCredential,
            ));
        }
    }

    None
}

fn read_headless_token_file(path: &std::path::Path) -> Result<String, String> {
    let token = std::fs::read_to_string(path)
        .map_err(|err| format!("could not read token file {}: {err}", path.display()))?;
    #[cfg(unix)]
    if let Ok(metadata) = std::fs::metadata(path) {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            eprintln!(
                "[bat-server] warning: token file {} is accessible beyond its owner; prefer chmod 600",
                path.display()
            );
        }
    }
    let token = token.trim();
    if token.is_empty() {
        return Err(format!("token file is empty: {}", path.display()));
    }
    Ok(token.to_string())
}

fn legacy_headless_token_warning(source: Option<HeadlessTokenSource>) -> Option<&'static str> {
    match source {
        Some(HeadlessTokenSource::CommandLine) => Some(
            "--token is supported for compatibility; prefer --token-file or a systemd credential",
        ),
        Some(HeadlessTokenSource::Environment) => Some(
            "BAT_TOKEN is supported for compatibility; prefer BAT_TOKEN_FILE or a systemd credential",
        ),
        _ => None,
    }
}

fn parse_env_port() -> Result<Option<u16>, String> {
    match std::env::var("BAT_PORT") {
        Ok(value) if !value.trim().is_empty() => parse_port(&value).map(Some),
        _ => Ok(None),
    }
}

fn default_headless_data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    if cfg!(target_os = "macos") {
        return Some(
            home.join("Library")
                .join("Application Support")
                .join("better-agent-terminal"),
        );
    }
    if cfg!(windows) {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        return Some(base.join("better-agent-terminal"));
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    Some(base.join("better-agent-terminal"))
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| format!("invalid port: {value}"))?;
    if port == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    Ok(port)
}

fn normalize_headless_bind(value: &str) -> Result<String, String> {
    match value {
        "localhost" | "tailscale" | "all" => Ok(value.to_string()),
        _ => Err(format!(
            "invalid bind interface: {value} (expected localhost|tailscale|all)"
        )),
    }
}

fn print_headless_server_help() {
    println!(
        "bat-server - headless RemoteServer for Better Agent Terminal\n\n\
Usage:\n  bat-server [options]\n\n\
Options:\n  --port=N            TCP port to listen on (default: 9876)\n  \
--bind=IFACE        localhost | tailscale | all (default: localhost)\n  \
--data-dir=PATH     persistent state directory\n  \
--token-file=PATH   read a token from an owner-restricted file (recommended)\n  \
--token=HEX         pin a known token (compatibility; emits a warning)\n  \
--debug             write debug logs inside the app data dir\n  \
-h, --help          show this help\n\n\
Environment variables: BAT_DATA_DIR BAT_TAURI_DATA_DIR BAT_PORT BAT_BIND BAT_TOKEN_FILE BAT_TOKEN BAT_DEBUG\n\n\
systemd credential: $CREDENTIALS_DIRECTORY/bat-server-token"
    );
}

#[cfg(test)]
mod headless_tests {
    use super::*;

    #[test]
    fn parse_headless_args_accepts_stable_flags() {
        let parsed = parse_headless_server_args([
            "--bat-server".to_string(),
            "--port=12345".to_string(),
            "--bind=tailscale".to_string(),
            "--data-dir=/tmp/bat".to_string(),
            "--token=abc123".to_string(),
        ])
        .unwrap();
        let HeadlessCliAction::Run(args) = parsed else {
            panic!("expected run action");
        };
        assert_eq!(args.port, 12345);
        assert_eq!(args.bind_interface, "tailscale");
        assert_eq!(args.data_dir, Some(PathBuf::from("/tmp/bat")));
        assert_eq!(args.token.as_deref(), Some("abc123"));
        assert_eq!(args.token_source, Some(HeadlessTokenSource::CommandLine));
        assert!(legacy_headless_token_warning(args.token_source).is_some());
    }

    #[test]
    fn parse_headless_args_reads_token_file_without_legacy_warning() {
        let path = std::env::temp_dir().join(format!(
            "bat-server-token-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, "file-token\n").unwrap();
        let parsed = parse_headless_server_args([
            "--token-file".to_string(),
            path.to_string_lossy().into_owned(),
        ])
        .unwrap();
        let _ = std::fs::remove_file(&path);

        let HeadlessCliAction::Run(args) = parsed else {
            panic!("expected run action");
        };
        assert_eq!(args.token.as_deref(), Some("file-token"));
        assert_eq!(args.token_source, Some(HeadlessTokenSource::TokenFile));
        assert_eq!(legacy_headless_token_warning(args.token_source), None);
    }

    #[test]
    fn parse_headless_args_keeps_last_token_source_compatibility() {
        let parsed = parse_headless_server_args([
            "--token-file=missing-token-file".to_string(),
            "--token=legacy-override".to_string(),
        ])
        .unwrap();
        let HeadlessCliAction::Run(args) = parsed else {
            panic!("expected run action");
        };
        assert_eq!(args.token.as_deref(), Some("legacy-override"));
        assert_eq!(args.token_source, Some(HeadlessTokenSource::CommandLine));

        assert!(matches!(
            parse_headless_server_args([
                "--token-file=missing-token-file".to_string(),
                "--help".to_string(),
            ]),
            Ok(HeadlessCliAction::Help)
        ));
    }

    #[test]
    fn parse_headless_args_defaults_data_dir_to_history_path() {
        let parsed = parse_headless_server_args(Vec::<String>::new()).unwrap();
        let HeadlessCliAction::Run(args) = parsed else {
            panic!("expected run action");
        };
        let dir = args.data_dir.expect("default data dir");
        assert_eq!(
            dir.file_name().and_then(|name| name.to_str()),
            Some("better-agent-terminal")
        );
    }

    #[test]
    fn parse_headless_args_rejects_invalid_bind() {
        let err = parse_headless_server_args(["--bind=public".to_string()]).unwrap_err();
        assert!(err.contains("invalid bind interface"));
    }

    #[test]
    fn encode_query_component_percent_encodes_fingerprint_colons() {
        assert_eq!(encode_query_component("AA:BB cc"), "AA%3ABB%20cc");
    }
}
