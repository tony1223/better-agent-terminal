use bat_host_support::native_keyring::use_native_store;
use keyring_core::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
        SAFE_STORE_INIT.get_or_init(|| use_native_store().map_err(|err| format!("{err:?}")));
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
    // MCP connector tokens are host-local and can exceed Windows Credential
    // Manager's 2560-byte limit. Store only the account's compact OAuth value.
    let credential_json = account_credential(credential_json)?;
    safe_entry(account_id)?
        .set_password(&credential_json)
        .map_err(|err| {
            AccountStoreError::SafeStorage(format!("could not save credential: {err:?}"))
        })
}

fn account_credential(raw: &str) -> Result<String, AccountStoreError> {
    let value: Value = serde_json::from_str(raw)?;
    let oauth = value
        .get("claudeAiOauth")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            AccountStoreError::SafeStorage("Claude credential has no claudeAiOauth object".into())
        })?;
    Ok(serde_json::to_string(
        &serde_json::json!({ "claudeAiOauth": oauth }),
    )?)
}

fn merge_account_credential(
    current: Option<&str>,
    account: &str,
) -> Result<String, AccountStoreError> {
    // Also accepts legacy keyring entries containing the entire credentials
    // file, without copying their stale MCP values back over the live ones.
    let account: Value = serde_json::from_str(&account_credential(account)?)?;
    let mut current: Value = match current {
        Some(raw) => serde_json::from_str(raw)?,
        None => serde_json::json!({}),
    };
    let object = current.as_object_mut().ok_or_else(|| {
        AccountStoreError::SafeStorage("Claude credentials must be a JSON object".into())
    })?;
    object.insert("claudeAiOauth".into(), account["claudeAiOauth"].clone());
    Ok(serde_json::to_string(&current)?)
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
    let Ok(merged) = merge_account_credential(read_cli_credentials().as_deref(), credential_json)
    else {
        return false;
    };
    replace_cli_credentials(&merged)
}

fn replace_cli_credentials(credential_json: &str) -> bool {
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

/// An interactive login writes both the credential store and oauthAccount.
/// Keep the rollback in memory, including when BAT has no indexed account yet.
struct CliLoginSnapshot {
    credential: Option<String>,
    #[cfg(not(target_os = "macos"))]
    credential_path: PathBuf,
    config_path: PathBuf,
    oauth_account: Option<Value>,
    started: Instant,
}

fn read_optional_file(path: &Path) -> Result<Option<String>, AccountStoreError> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn read_config(path: &Path) -> Result<Value, AccountStoreError> {
    let config = match read_optional_file(path)? {
        Some(raw) => serde_json::from_str::<Value>(&raw)?,
        None => serde_json::json!({}),
    };
    if !config.is_object() {
        return Err(AccountStoreError::SafeStorage(
            "Claude config must be a JSON object".into(),
        ));
    }
    Ok(config)
}

impl CliLoginSnapshot {
    fn capture(credential_path: PathBuf, config_path: PathBuf) -> Result<Self, AccountStoreError> {
        #[cfg(target_os = "macos")]
        let credential = {
            let _ = credential_path;
            read_cli_credentials()
        };
        #[cfg(not(target_os = "macos"))]
        let credential = read_optional_file(&credential_path)?;
        let config = read_config(&config_path)?;
        Ok(Self {
            credential,
            #[cfg(not(target_os = "macos"))]
            credential_path,
            config_path,
            oauth_account: config.get("oauthAccount").cloned(),
            started: Instant::now(),
        })
    }

    fn restore(&self) -> Result<(), AccountStoreError> {
        #[cfg(not(target_os = "macos"))]
        match &self.credential {
            Some(raw) => {
                fs::write(&self.credential_path, raw)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&self.credential_path, fs::Permissions::from_mode(0o600))?;
                }
            }
            None => match fs::remove_file(&self.credential_path) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err.into()),
            },
        }
        #[cfg(target_os = "macos")]
        {
            let restored = match &self.credential {
                Some(raw) => replace_cli_credentials(raw),
                None if read_cli_credentials().is_none() => true,
                None => Command::new("/usr/bin/security")
                    .args([
                        "delete-generic-password",
                        "-a",
                        &keychain_account(),
                        "-s",
                        CLI_KEYCHAIN_SERVICE,
                    ])
                    .status()
                    .map(|status| status.success())
                    .unwrap_or(false),
            };
            if !restored {
                return Err(AccountStoreError::SafeStorage(
                    "could not restore Claude CLI keychain credential".into(),
                ));
            }
        }
        // Restore only account identity; retain unrelated CLI config updates.
        if self.config_path.exists() || self.oauth_account.is_some() {
            let mut config = read_config(&self.config_path)?;
            let object = config.as_object_mut().expect("validated config object");
            match &self.oauth_account {
                Some(account) => {
                    object.insert("oauthAccount".into(), account.clone());
                }
                None => {
                    object.remove("oauthAccount");
                }
            }
            fs::write(&self.config_path, serde_json::to_string_pretty(&config)?)?;
        }
        Ok(())
    }
}

static LOGIN_SNAPSHOT: Mutex<Option<CliLoginSnapshot>> = Mutex::new(None);

/// Reserve the host-global login and capture rollback BEFORE spawning the CLI.
/// False means another desktop or remote login already owns the reservation.
pub fn begin_login_snapshot(app_data_dir: &Path) -> Result<bool, AccountStoreError> {
    let mut pending = LOGIN_SNAPSHOT
        .lock()
        .map_err(|_| AccountStoreError::SafeStorage("Claude login state is unavailable".into()))?;
    if let Some(snapshot) = pending.as_ref() {
        // The sidecar kills abandoned logins after 180 seconds. Leave extra
        // time for account finalization, then recover before a new attempt.
        if snapshot.started.elapsed() < Duration::from_secs(300) {
            return Ok(false);
        }
        snapshot.restore()?;
        *pending = None;
    }
    let dir = claude_config_dir().ok_or_else(|| {
        AccountStoreError::SafeStorage("could not resolve Claude config directory".into())
    })?;
    let config_path = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(|dir| PathBuf::from(dir).join(".claude.json"))
        .or_else(|| home_dir().map(|home| home.join(".claude.json")))
        .ok_or_else(|| {
            AccountStoreError::SafeStorage("could not resolve Claude config path".into())
        })?;
    let snapshot = CliLoginSnapshot::capture(dir.join(".credentials.json"), config_path)?;
    snapshot_active_account_credential(app_data_dir)?;
    *pending = Some(snapshot);
    Ok(true)
}

pub fn finish_login_snapshot(restore: bool) -> Result<(), AccountStoreError> {
    let mut pending = LOGIN_SNAPSHOT
        .lock()
        .map_err(|_| AccountStoreError::SafeStorage("Claude login state is unavailable".into()))?;
    if restore {
        if let Some(snapshot) = pending.as_ref() {
            snapshot.restore()?;
        }
    }
    *pending = None;
    Ok(())
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

    #[test]
    fn account_storage_omits_large_mcp_credentials() {
        let raw = serde_json::json!({
            "claudeAiOauth": { "accessToken": "access", "refreshToken": "refresh", "expiresAt": 123 },
            "mcpOAuth": (0..88).map(|i| (format!("connector-{i}"), serde_json::json!({ "token": "x".repeat(400) })))
                .collect::<serde_json::Map<String, Value>>(),
        }).to_string();
        assert!(raw.len() > 34_000);
        let stored = account_credential(&raw).unwrap();
        assert!(stored.encode_utf16().count() * 2 < 2560);
        let value: Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(value["claudeAiOauth"]["refreshToken"], "refresh");
        assert!(value.get("mcpOAuth").is_none());
    }

    #[test]
    fn account_switch_preserves_live_mcp_even_for_legacy_keyring_entries() {
        let current = r#"{"claudeAiOauth":{"accessToken":"old"},"mcpOAuth":{"connector":"live"},"other":true}"#;
        for account in [
            r#"{"claudeAiOauth":{"accessToken":"new"}}"#,
            r#"{"claudeAiOauth":{"accessToken":"new"},"mcpOAuth":{"connector":"stale"}}"#,
        ] {
            let merged: Value =
                serde_json::from_str(&merge_account_credential(Some(current), account).unwrap())
                    .unwrap();
            assert_eq!(merged["claudeAiOauth"]["accessToken"], "new");
            assert_eq!(merged["mcpOAuth"]["connector"], "live");
            assert_eq!(merged["other"], true);
            let without_current: Value =
                serde_json::from_str(&merge_account_credential(None, account).unwrap()).unwrap();
            assert_eq!(without_current["claudeAiOauth"]["accessToken"], "new");
            assert!(without_current.get("mcpOAuth").is_none());
        }
        assert!(merge_account_credential(Some("invalid"), current).is_err());
        assert!(account_credential(r#"{"mcpOAuth":{}}"#).is_err());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn failed_first_login_restores_unindexed_cli_identity() {
        let dir = temp_dir("first-login-rollback");
        assert!(read_index(&dir).active_account_id.is_none());
        let credential_path = dir.join(".credentials.json");
        let config_path = dir.join(".claude.json");
        let original =
            r#"{"claudeAiOauth":{"accessToken":"original"},"mcpOAuth":{"connector":"host"}}"#;
        fs::write(&credential_path, original).unwrap();
        fs::write(
            &config_path,
            r#"{"oauthAccount":{"emailAddress":"old@example.com"},"theme":"dark"}"#,
        )
        .unwrap();
        let snapshot =
            CliLoginSnapshot::capture(credential_path.clone(), config_path.clone()).unwrap();
        fs::write(
            &credential_path,
            r#"{"claudeAiOauth":{"accessToken":"new"}}"#,
        )
        .unwrap();
        fs::write(
            &config_path,
            r#"{"oauthAccount":{"emailAddress":"new@example.com"},"theme":"light"}"#,
        )
        .unwrap();
        snapshot.restore().unwrap();
        assert_eq!(fs::read_to_string(&credential_path).unwrap(), original);
        let config = read_config(&config_path).unwrap();
        assert_eq!(config["oauthAccount"]["emailAddress"], "old@example.com");
        assert_eq!(config["theme"], "light");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn cancelled_login_restores_absent_credentials_and_account() {
        let dir = temp_dir("no-credential-rollback");
        let credential_path = dir.join(".credentials.json");
        let config_path = dir.join(".claude.json");
        let snapshot =
            CliLoginSnapshot::capture(credential_path.clone(), config_path.clone()).unwrap();
        fs::write(
            &credential_path,
            r#"{"claudeAiOauth":{"accessToken":"new"}}"#,
        )
        .unwrap();
        fs::write(
            &config_path,
            r#"{"oauthAccount":{"emailAddress":"new@example.com"},"other":true}"#,
        )
        .unwrap();
        snapshot.restore().unwrap();
        assert!(!credential_path.exists());
        let config = read_config(&config_path).unwrap();
        assert!(config.get("oauthAccount").is_none());
        assert_eq!(config["other"], true);
        fs::remove_dir_all(dir).unwrap();
    }

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
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
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
