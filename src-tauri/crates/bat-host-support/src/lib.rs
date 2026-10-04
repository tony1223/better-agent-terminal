//! Cross-platform storage, logging and system helpers, independent of the app shell.

#[cfg(feature = "secret-storage")]
pub mod electron_safe_storage;
#[cfg(feature = "native-keyring")]
pub mod native_keyring;
pub mod path_guard;
pub mod subprocess;
#[cfg(feature = "network")]
pub mod network_addresses;
pub mod linux_wayland;
pub mod log_file;
