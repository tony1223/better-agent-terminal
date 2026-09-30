// Codex auth fallback key resolution.
//
// OpenAI Direct runtime and renderer-facing openai.* IPC have been removed.
// Codex still accepts OPENAI_API_KEY, a previously stored key, or a Codex
// OAuth token, so keep this as an internal Rust helper rather than a host API.

use crate::native_keyring::use_native_store;
use keyring_core::Entry;
#[cfg(test)]
use serde_json::Value;
use std::fs;
#[cfg(test)]
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::app_data;
use crate::host_context::HostContext;

const OPENAI_KEY_FILE: &str = "openai-api-key.bin";
const KEYRING_SERVICE: &str = "better-agent-terminal:openai-api-key";
const KEYRING_ACCOUNT: &str = "default";

static SAFE_STORE_INIT: OnceLock<Result<(), String>> = OnceLock::new();

fn ensure_safe_store() -> Result<(), String> {
    SAFE_STORE_INIT
        .get_or_init(|| use_native_store().map_err(|err| format!("{err:?}")))
        .clone()
}

fn safe_entry() -> Result<Entry, String> {
    ensure_safe_store()?;
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|err| format!("could not create keyring entry: {err:?}"))
}

fn key_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(OPENAI_KEY_FILE)
}

fn load_keyring_key() -> Option<String> {
    let key = safe_entry().ok()?.get_password().ok()?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn load_legacy_file_key(data_dir: &Path) -> Option<String> {
    let raw = fs::read(key_file_path(data_dir)).ok()?;
    let text = String::from_utf8(raw).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn configured_openai_key_for_runtime(app: &HostContext) -> Option<String> {
    if let Some(key) = load_keyring_key() {
        return Some(key);
    }
    if let Some(data_dir) = app.data_dir_opt() {
        if let Some(key) = load_legacy_file_key(&data_dir) {
            return Some(key);
        }
    }
    std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|key| !key.is_empty())
}

#[cfg(test)]
fn save_legacy_file_key(data_dir: &Path, api_key: &str) -> io::Result<()> {
    fs::create_dir_all(data_dir)?;
    let path = key_file_path(data_dir);
    fs::write(&path, api_key.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
fn delete_legacy_file_key(data_dir: &Path) {
    let _ = fs::remove_file(key_file_path(data_dir));
}

#[cfg(test)]
fn load_codex_oauth_token_from_home(home: &Path) -> Option<String> {
    let raw = fs::read_to_string(home.join(".codex").join("auth.json")).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("tokens")
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(String::from)
}

#[cfg(test)]
fn has_openai_key_in(
    data_dir: &Path,
    home: Option<&Path>,
    env_key: Option<&str>,
    check_keyring: bool,
) -> bool {
    if check_keyring && load_keyring_key().is_some() {
        return true;
    }
    if load_legacy_file_key(data_dir).is_some() {
        return true;
    }
    if home.and_then(load_codex_oauth_token_from_home).is_some() {
        return true;
    }
    env_key.is_some_and(|key| !key.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        std::env::temp_dir().join(format!(
            "bat-codex-auth-{name}-{}-{stamp}",
            std::process::id()
        ))
    }

    #[test]
    fn legacy_file_key_counts_as_configured() {
        let dir = temp_dir("legacy");
        save_legacy_file_key(&dir, "sk-test").expect("save legacy key");
        assert!(has_openai_key_in(&dir, None, None, false));
        delete_legacy_file_key(&dir);
        assert!(!has_openai_key_in(&dir, None, None, false));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_oauth_token_counts_as_configured() {
        let home = temp_dir("oauth-home");
        let codex_dir = home.join(".codex");
        fs::create_dir_all(&codex_dir).expect("mkdir");
        fs::write(
            codex_dir.join("auth.json"),
            r#"{"tokens":{"access_token":"oauth-token","account_id":"acct"}}"#,
        )
        .expect("write auth");
        assert!(has_openai_key_in(
            &temp_dir("empty-data"),
            Some(&home),
            None,
            false
        ));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn env_key_counts_as_configured() {
        let dir = temp_dir("env");
        assert!(has_openai_key_in(&dir, None, Some("sk-env"), false));
        assert!(!has_openai_key_in(&dir, None, Some(""), false));
    }
}
