// Shared subprocess helpers. Windows flashes a console window for every
// child process that the launcher inherits stdio from, unless we set the
// CREATE_NO_WINDOW creation flag. Every Command spawned from the host
// (git, gh, claude, codex, pnpm, the sidecar, cx detect, …) must route
// through `hide_console_window` so users don't see a black flash when BAT
// shells out.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
pub fn hide_console_window(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console_window(_command: &mut std::process::Command) {}
