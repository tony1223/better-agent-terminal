//! Select the OS credential store for `keyring_core::Entry`.
//!
//! This is the one thing the app used the `keyring` 4.x meta-crate for. That
//! crate exists to expose every store behind one CLI-shaped facade, and its
//! dependency closure (db-keystore -> turso + tantivy, clap, rpassword, ...)
//! roughly doubled the number of crates in a cold build. Depending on the
//! native store crates directly keeps the exact same behaviour per platform:
//! Windows Credential Manager, the macOS login keychain, and the Linux kernel
//! keyutils session store, each with default configuration.

use keyring_core::Result;

/// Install the platform's native store as the process-wide default store.
///
/// Idempotence is the caller's job: every call site wraps this in a
/// `OnceLock`, so the store is only ever constructed once.
pub fn use_native_store() -> Result<()> {
    let config = std::collections::HashMap::new();
    #[cfg(target_os = "windows")]
    {
        use windows_native_keyring_store::Store;
        keyring_core::set_default_store(Store::new_with_configuration(&config)?);
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        use apple_native_keyring_store::keychain::Store;
        keyring_core::set_default_store(Store::new_with_configuration(&config)?);
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        use linux_keyutils_keyring_store::Store;
        keyring_core::set_default_store(Store::new_with_configuration(&config)?);
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = config;
        Err(keyring_core::Error::NotSupportedByStore(
            "no native credential store is wired up for this platform".to_string(),
        ))
    }
}
