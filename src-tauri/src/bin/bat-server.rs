#[cfg(feature = "desktop")]
fn main() {
    std::process::exit(better_agent_terminal_lib::run_headless_server_cli(
        tauri::generate_context!(),
    ));
}

#[cfg(not(feature = "desktop"))]
fn main() {
    std::process::exit(better_agent_terminal_lib::run_headless_server_cli());
}
