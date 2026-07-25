use keyring::use_native_store;
use keyring_core::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

const STORE_FILE: &str = "claude-accounts.json";
const KEYRING_SERVICE: &str = "better-agent-terminal:claude-account";
#[cfg(target_os = "macos")]
const CLI_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

#[derive(Debug, Error)]
pub enum AccountStoreError {
    #[error("account IO error: {0}")]
    Io(#[from] io::Error),
    #[error("account JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("safe storage error: {0}")]
    SafeStorage(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccount {
    pub id: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_type: Option<String>,
    pub is_default: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIndex {
    pub accounts: Vec<ClaudeAccount>,
    pub active_account_id: Option<String>,
    pub switch_warning_shown: bool,
}

impl Default for AccountIndex {
    fn default() -> Self {
        Self {
            accounts: Vec::new(),
            active_account_id: None,
            switch_warning_shown: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub email: Option<String>,
    pub subscription_type: Option<String>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn account_index_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(STORE_FILE)
}

fn normalize_index(mut index: AccountIndex) -> AccountIndex {
    index
        .accounts
        .retain(|account| !account.id.is_empty() && !account.email.is_empty());
    if let Some(active_id) = &index.active_account_id {
        if !index
            .accounts
            .iter()
            .any(|account| &account.id == active_id)
        {
            index.active_account_id = None;
        }
    }
    index
}

pub fn read_index(app_data_dir: &Path) -> AccountIndex {
    let Ok(raw) = fs::read_to_string(account_index_path(app_data_dir)) else {
        return AccountIndex::default();
    };
    let parsed = serde_json::from_str::<AccountIndex>(&raw).unwrap_or_default();
    normalize_index(parsed)
}

pub fn write_index(app_data_dir: &Path, index: &AccountIndex) -> Result<(), AccountStoreError> {
    fs::create_dir_all(app_data_dir)?;
    let path = account_index_path(app_data_dir);
    let clean = normalize_index(index.clone());
    // Write-then-rename: a torn write here would leave unparseable JSON, and
    // read_index falls back to an empty index on a parse error, so the next
    // mutation would persist "no accounts" over the real list. The credentials
    // live in the OS keyring under ids that only this file records, so losing it
    // strands them. fs::rename replaces the destination on both Windows and unix.
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_string_pretty(&clean)?)?;
    if let Err(err) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&temp);
        return Err(err.into());
    }
    Ok(())
}

static SAFE_STORE_INIT: OnceLock<Result<(), String>> = OnceLock::new();

fn ensure_safe_store() -> Result<(), AccountStoreError> {
    let result =
        SAFE_STORE_INIT.get_or_init(|| use_native_store(false).map_err(|err| format!("{err:?}")));
    result.clone().map_err(AccountStoreError::SafeStorage)
}

fn safe_entry(account_id: &str) -> Result<Entry, AccountStoreError> {
    ensure_safe_store()?;
    Entry::new(KEYRING_SERVICE, account_id).map_err(|err| {
        AccountStoreError::SafeStorage(format!("could not create keyring entry: {err:?}"))
    })
}

fn save_account_credential(
    account_id: &str,
    credential_json: &str,
) -> Result<(), AccountStoreError> {
    safe_entry(account_id)?
        .set_password(credential_json)
        .map_err(|err| {
            AccountStoreError::SafeStorage(format!("could not save credential: {err:?}"))
        })
}

fn load_account_credential(account_id: &str) -> Result<String, AccountStoreError> {
    safe_entry(account_id)?.get_password().map_err(|err| {
        AccountStoreError::SafeStorage(format!("could not load credential: {err:?}"))
    })
}

fn delete_account_credential(account_id: &str) {
    if let Ok(entry) = safe_entry(account_id) {
        let _ = entry.delete_credential();
    }
}

/// Read-only peek at a stored account credential (for usage lookups on
/// NON-active accounts). Never refreshes or mutates the stored value.
pub fn peek_account_credential(account_id: &str) -> Option<String> {
    load_account_credential(account_id).ok()
}

fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        return Some(PathBuf::from(home));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return Some(PathBuf::from(profile));
    }
    None
}

fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".claude")))
}

#[cfg(target_os = "macos")]
fn keychain_account() -> String {
    std::env::var("USER")
        .unwrap_or_else(|_| std::env::var("LOGNAME").unwrap_or_else(|_| "default".into()))
}

pub fn read_cli_credentials() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-a",
                &keychain_account(),
                "-s",
                CLI_KEYCHAIN_SERVICE,
                "-w",
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
        return (!value.is_empty()).then_some(value);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let path = claude_config_dir()?.join(".credentials.json");
        fs::read_to_string(path)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }
}

pub fn write_cli_credentials(credential_json: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        return Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-U",
                "-a",
                &keychain_account(),
                "-s",
                CLI_KEYCHAIN_SERVICE,
                "-w",
                credential_json,
            ])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let Some(dir) = claude_config_dir() else {
            return false;
        };
        if fs::create_dir_all(&dir).is_err() {
            return false;
        }
        let path = dir.join(".credentials.json");
        if fs::write(&path, credential_json).is_err() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        true
    }
}

pub fn auth_status_from_value(value: &Value) -> Option<AuthStatus> {
    Some(AuthStatus {
        logged_in: value
            .get("loggedIn")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        email: value
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
        subscription_type: value
            .get("subscriptionType")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub fn import_current_account(
    app_data_dir: &Path,
    status: AuthStatus,
    credential_json: String,
) -> Result<Option<ClaudeAccount>, AccountStoreError> {
    if !status.logged_in {
        return Ok(None);
    }
    let Some(email) = status.email else {
        return Ok(None);
    };
    let mut index = read_index(app_data_dir);
    if let Some(existing) = index
        .accounts
        .iter_mut()
        .find(|account| account.email == email)
    {
        existing.subscription_type = status.subscription_type;
        save_account_credential(&existing.id, &credential_json)?;
        let account = existing.clone();
        write_index(app_data_dir, &index)?;
        return Ok(Some(account));
    }
    let account = ClaudeAccount {
        id: format!("default-{}", now_millis()),
        email,
        subscription_type: status.subscription_type,
        is_default: true,
        created_at: now_millis(),
    };
    save_account_credential(&account.id, &credential_json)?;
    index.accounts.push(account.clone());
    if index.active_account_id.is_none() {
        index.active_account_id = Some(account.id.clone());
    }
    write_index(app_data_dir, &index)?;
    Ok(Some(account))
}

pub fn upsert_new_login_account(
    app_data_dir: &Path,
    status: AuthStatus,
    credential_json: String,
) -> Result<ClaudeAccount, AccountStoreError> {
    if !status.logged_in {
        return Err(AccountStoreError::SafeStorage(
            "login completed but auth status is not logged in".into(),
        ));
    }
    let Some(email) = status.email else {
        return Err(AccountStoreError::SafeStorage(
            "login completed but auth status had no email".into(),
        ));
    };
    let mut index = read_index(app_data_dir);
    if let Some(existing) = index
        .accounts
        .iter_mut()
        .find(|account| account.email == email)
    {
        existing.subscription_type = status.subscription_type;
        save_account_credential(&existing.id, &credential_json)?;
        let account = existing.clone();
        write_index(app_data_dir, &index)?;
        return Ok(account);
    }
    let account = ClaudeAccount {
        id: format!("account-{}", now_millis()),
        email,
        subscription_type: status.subscription_type,
        is_default: false,
        created_at: now_millis(),
    };
    save_account_credential(&account.id, &credential_json)?;
    index.accounts.push(account.clone());
    write_index(app_data_dir, &index)?;
    Ok(account)
}

/// Preserve the currently active CLI credential before an interactive login
/// overwrites Claude's host-global credential store.
pub fn snapshot_active_account_credential(app_data_dir: &Path) -> Result<(), AccountStoreError> {
    let index = read_index(app_data_dir);
    let Some(active_id) = index.active_account_id else {
        return Ok(());
    };
    let Some(credential) = read_cli_credentials() else {
        return Ok(());
    };
    save_account_credential(&active_id, &credential)
}

/// Register the credential written by a completed login and make it the
/// account BAT reports as active without snapshotting it over the old account.
pub fn activate_new_login_account(
    app_data_dir: &Path,
    status: AuthStatus,
    credential_json: String,
) -> Result<ClaudeAccount, AccountStoreError> {
    let account = upsert_new_login_account(app_data_dir, status, credential_json)?;
    set_active_account_id(app_data_dir, &account.id)?;
    Ok(account)
}

fn set_active_account_id(app_data_dir: &Path, account_id: &str) -> Result<(), AccountStoreError> {
    let mut index = read_index(app_data_dir);
    if !index
        .accounts
        .iter()
        .any(|account| account.id == account_id)
    {
        return Err(AccountStoreError::SafeStorage(format!(
            "unknown account: {account_id}"
        )));
    }
    index.active_account_id = Some(account_id.to_string());
    write_index(app_data_dir, &index)
}

/// Restore the indexed active account after a cancelled or failed login.
pub fn restore_active_account_credential(app_data_dir: &Path) -> Result<bool, AccountStoreError> {
    let index = read_index(app_data_dir);
    let Some(active_id) = index.active_account_id else {
        return Ok(false);
    };
    let credential = load_account_credential(&active_id)?;
    Ok(write_cli_credentials(&credential))
}

pub fn switch_account(app_data_dir: &Path, account_id: &str) -> Result<bool, AccountStoreError> {
    let mut index = read_index(app_data_dir);
    if !index
        .accounts
        .iter()
        .any(|account| account.id == account_id)
    {
        return Ok(false);
    }
    // Refuse the switch rather than swallow this. The snapshot is a no-op when
    // there is no active account or no CLI credential to save, so the only way
    // it errors is "there IS a live credential and the keyring rejected the
    // write" — and the very next step overwrites that credential. Losing it
    // leaves the outgoing account's stored copy stale, which once the CLI has
    // rotated its refresh token means switching back lands on dead credentials
    // and the account silently demands a fresh login.
    snapshot_active_account_credential(app_data_dir)?;
    let Ok(credential) = load_account_credential(account_id) else {
        return Ok(false);
    };
    if !write_cli_credentials(&credential) {
        return Ok(false);
    }
    index.active_account_id = Some(account_id.to_string());
    write_index(app_data_dir, &index)?;
    Ok(true)
}

pub fn remove_account(app_data_dir: &Path, account_id: &str) -> Result<bool, AccountStoreError> {
    let mut index = read_index(app_data_dir);
    let Some(account) = index
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .cloned()
    else {
        return Ok(false);
    };
    if account.is_default {
        return Ok(false);
    }
    index.accounts.retain(|account| account.id != account_id);
    if index.active_account_id.as_deref() == Some(account_id) {
        index.active_account_id = index
            .accounts
            .iter()
            .find(|account| account.is_default)
            .or_else(|| index.accounts.first())
            .map(|account| account.id.clone());
        if let Some(active_id) = &index.active_account_id {
            if let Ok(credential) = load_account_credential(active_id) {
                let _ = write_cli_credentials(&credential);
            }
        }
    }
    write_index(app_data_dir, &index)?;
    // Only after the index no longer references it — dropping the credential
    // first would strand a listed account with nothing to switch to if the
    // index write failed.
    delete_account_credential(account_id);
    Ok(true)
}

pub fn mark_warning_shown(app_data_dir: &Path) -> Result<(), AccountStoreError> {
    let mut index = read_index(app_data_dir);
    index.switch_warning_shown = true;
    write_index(app_data_dir, &index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bat-account-store-{}-{}-{name}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn account_index_strips_invalid_active_id() {
        let dir = temp_dir("index");
        let index = AccountIndex {
            accounts: vec![ClaudeAccount {
                id: "a1".into(),
                email: "a1@example.com".into(),
                subscription_type: Some("pro".into()),
                is_default: true,
                created_at: 1,
            }],
            active_account_id: Some("missing".into()),
            switch_warning_shown: false,
        };
        write_index(&dir, &index).unwrap();
        let read = read_index(&dir);
        assert_eq!(read.accounts.len(), 1);
        assert_eq!(read.active_account_id, None);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn write_index_replaces_an_existing_file_and_leaves_no_temp_behind() {
        let dir = temp_dir("atomic");
        let account = |id: &str| ClaudeAccount {
            id: id.into(),
            email: format!("{id}@example.com"),
            subscription_type: None,
            is_default: false,
            created_at: 1,
        };
        let mut index = AccountIndex {
            accounts: vec![account("a1")],
            active_account_id: Some("a1".into()),
            switch_warning_shown: false,
        };
        write_index(&dir, &index).unwrap();
        // Overwriting an existing index is the common case, and on Windows a
        // rename onto an occupied path only succeeds with replace-existing
        // semantics — pin that down so the write can't regress to a torn one.
        index.accounts.push(account("a2"));
        write_index(&dir, &index).unwrap();
        assert_eq!(read_index(&dir).accounts.len(), 2);

        let leftovers = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn auth_status_parse_matches_cli_json() {
        let status = auth_status_from_value(&serde_json::json!({
            "loggedIn": true,
            "email": "user@example.com",
            "subscriptionType": "pro",
        }))
        .unwrap();
        assert!(status.logged_in);
        assert_eq!(status.email.as_deref(), Some("user@example.com"));
        assert_eq!(status.subscription_type.as_deref(), Some("pro"));
    }

    #[test]
    fn active_account_marker_never_rewrites_credentials() {
        let dir = temp_dir("activate");
        let index = AccountIndex {
            accounts: vec![ClaudeAccount {
                id: "new-account".into(),
                email: "new@example.com".into(),
                subscription_type: Some("max".into()),
                is_default: false,
                created_at: 2,
            }],
            active_account_id: None,
            switch_warning_shown: false,
        };
        write_index(&dir, &index).unwrap();
        set_active_account_id(&dir, "new-account").unwrap();
        assert_eq!(
            read_index(&dir).active_account_id.as_deref(),
            Some("new-account")
        );
        assert!(set_active_account_id(&dir, "missing").is_err());
        fs::remove_dir_all(dir).ok();
    }
}
