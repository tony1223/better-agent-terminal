//! Cross-platform storage, logging and system helpers, independent of the app shell.

pub mod electron_safe_storage;
pub mod native_keyring;
pub mod path_guard;
pub mod subprocess;
pub mod network_addresses;
pub mod linux_wayland;
pub mod log_file;
