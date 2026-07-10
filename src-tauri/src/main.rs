// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The headless server never opens a webview, so it doesn't need (and
    // shouldn't pay for) the display-server shim — check it first.
    if better_agent_terminal_lib::is_headless_server_invocation() {
        std::process::exit(better_agent_terminal_lib::run_headless_server_cli(
            tauri::generate_context!(),
        ));
    }

    // Must run before anything touches GTK/GLib/WebKit (Linux AppImage libwayland
    // skew workaround; no-op elsewhere). See GitHub issue #112.
    better_agent_terminal_lib::ensure_display_server_compat();
    better_agent_terminal_lib::run(tauri::generate_context!());
}
