// Tauri-side host command modules.
//
// Each submodule wraps a logical area of the Electron preload surface.
// As we port more areas, add a new module here and a registration line in
// lib.rs. The renderer reaches these through the host-api adapter
// (renderer/src/host-api.ts), so renaming or replacing a command is a one-place
// edit at this layer plus the adapter route.

// Modules reachable from the remote-server dispatch (and the codex/remote
// state) compile in both the desktop and the GUI-free `headless` build. The
// rest are desktop-only host commands (native dialogs, clipboard,
// window/workspace management, …) and are gated out of the
// headless build, where they are never invoked.
pub mod agent;
pub mod app;
pub mod claude;
#[cfg(feature = "desktop")]
pub mod claude_channel;
#[cfg(feature = "desktop")]
pub mod claude_cli;
#[cfg(feature = "desktop")]
pub mod clipboard;
#[cfg(feature = "desktop")]
pub mod debug;
#[cfg(feature = "desktop")]
pub mod dialog;
pub mod fs;
#[cfg(feature = "desktop")]
pub mod fugu;
pub mod git;
pub mod github;
pub mod image;
pub mod notification;
pub mod profile;
pub mod pty;
#[cfg(feature = "desktop")]
pub mod remote;
pub mod runtime;
pub mod settings;
#[cfg(feature = "desktop")]
pub mod shell;
pub mod snippet;
#[cfg(feature = "desktop")]
pub mod tunnel;
#[cfg(feature = "desktop")]
pub mod update;
pub mod worker_buffer;
#[cfg(feature = "desktop")]
pub mod workspace;
pub mod worktree;
