// Host-wide Claude subscription usage poller (5h / 7d windows).
//
// Lives in Rust ON PURPOSE rather than the node sidecar:
//   - it survives sidecar deaths/restarts (the poller's host process IS the
//     most stable layer we have), and
//   - it works before the node runtime exists at all (lightweight first boot,
//     where the sidecar cannot even spawn until runtime auto-install runs).
//
// ONE thread per host, keyed to the ACTIVE account: every cycle re-reads
// <CLAUDE_CONFIG_DIR|~/.claude>/.credentials.json, so an account switch is
// picked up on the next tick. Renderer windows never poll — they consume the
// `claude:usage` runtime event, which the event hub also relays to remote
// clients (host-owned data per the remote state ownership policy).
//
// Data source is the same endpoint the CLI's /usage command uses
// (api.anthropic.com/api/oauth/usage). It is UNDOCUMENTED: parsing is
// defensive, every failure degrades to "no update this tick", and HTTP errors
// back off exponentially (up to 15 min). Machines with no Claude login (e.g.
// remote-client-only boxes) stay quiet on a slow retry.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::app_data;
use crate::event_hub::publish_runtime_event;
use crate::log_file::append_line;

// Persisted diagnostics follow the project convention: append to
// <app-data>/logs/debug.log (same file the renderer logger uses).
fn warn(app: &AppHandle, message: &str) {
    eprintln!("[claude-usage] {message}");
    if let Some(dir) = app_data::app_data_dir_opt(app) {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let _ = append_line(
            &dir.join("logs").join("debug.log"),
            &format!("{millis} [claude-usage] {message}\n"),
        );
    }
}

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const POLL_INTERVAL: Duration = Duration::from_secs(150); // requested 2-3 min cadence
const CREDS_MISSING_RETRY: Duration = Duration::from_secs(600);
const BACKOFF_MAX: Duration = Duration::from_secs(900);
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const FIRST_POLL_DELAY: Duration = Duration::from_secs(3);

fn claude_config_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    app.path().home_dir().ok().map(|home| home.join(".claude"))
}

enum TokenError {
    Missing,
    Invalid,
}

fn token_from_credentials_json(raw: &str) -> Result<String, TokenError> {
    let parsed: Value = serde_json::from_str(raw).map_err(|_| TokenError::Invalid)?;
    match parsed
        .get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(Value::as_str)
    {
        Some(token) if !token.is_empty() => Ok(token.to_string()),
        _ => Err(TokenError::Invalid),
    }
}

fn read_access_token(app: &AppHandle) -> Result<String, TokenError> {
    // account_store::read_cli_credentials handles the platform differences
    // (file on Windows/Linux, Keychain on macOS). Fall back to the config-dir
    // file for CLAUDE_CONFIG_DIR overrides in dev/tests.
    if let Some(raw) = crate::account_store::read_cli_credentials() {
        if let Ok(token) = token_from_credentials_json(&raw) {
            return Ok(token);
        }
    }
    let path = claude_config_dir(app)
        .ok_or(TokenError::Missing)?
        .join(".credentials.json");
    let raw = std::fs::read_to_string(path).map_err(|_| TokenError::Missing)?;
    token_from_credentials_json(&raw)
}

fn normalize_window(bucket: Option<&Value>) -> Option<Value> {
    let obj = bucket?.as_object()?;
    // Endpoint reports utilization as 0-100; the SDK's rate_limit_event uses
    // 0-1. Normalize to 0-1 so both sources feed the same renderer state.
    let utilization = obj
        .get("utilization")
        .and_then(Value::as_f64)
        .map(|u| u / 100.0);
    // resets_at stays an ISO string — the renderer parses it (Date.parse),
    // which spares us a Rust datetime dependency.
    let resets_at = obj.get("resets_at").and_then(Value::as_str);
    if utilization.is_none() && resets_at.is_none() {
        return None;
    }
    Some(json!({
        "utilization": utilization,
        "resetsAt": resets_at,
    }))
}

/// Pure; unit-tested. Returns None when the (undocumented) response carries
/// no usable windows so schema drift degrades to "no update" silently.
pub fn normalize_usage_response(data: &Value) -> Option<Value> {
    let five_hour = normalize_window(data.get("five_hour"));
    let seven_day = normalize_window(data.get("seven_day"));
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    let extra = data
        .get("extra_usage")
        .and_then(Value::as_object)
        .map(|extra| {
            json!({
                "isEnabled": extra.get("is_enabled").and_then(Value::as_bool).unwrap_or(false),
                "monthlyLimit": extra.get("monthly_limit").and_then(Value::as_f64),
                "usedCredits": extra.get("used_credits").and_then(Value::as_f64),
                "currency": extra.get("currency").and_then(Value::as_str),
            })
        });
    Some(json!({
        "fiveHour": five_hour,
        "sevenDay": seven_day,
        "extraUsage": extra,
    }))
}

// Best-effort label: which account do these percentages belong to. Reads the
// sidecar-maintained account index from the app data dir; any failure simply
// drops the label.
fn active_account_email(app: &AppHandle) -> Option<String> {
    let data_dir = crate::sidecar::resolve_spawn_config(app).ok()?.data_dir?;
    let raw = std::fs::read_to_string(data_dir.join("claude-accounts.json")).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let active_id = parsed.get("activeAccountId")?.as_str()?;
    parsed
        .get("accounts")?
        .as_array()?
        .iter()
        .find(|a| a.get("id").and_then(Value::as_str) == Some(active_id))
        .and_then(|a| a.get("email"))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
}

fn poll_once(app: &AppHandle, client: &reqwest::blocking::Client) -> Duration {
    let token = match read_access_token(app) {
        Ok(token) => token,
        Err(_) => return CREDS_MISSING_RETRY, // not logged in here: stay quiet
    };

    let response = client
        .get(USAGE_URL)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(FETCH_TIMEOUT)
        .send();

    let data: Value = match response
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
    {
        Ok(data) => data,
        Err(err) => {
            // 401 self-heals: the CLI refreshes credentials and the next tick
            // re-reads the file. 429/5xx/network: back off.
            warn(app, &format!("poll failed: {err}"));
            return BACKOFF_MAX.min(POLL_INTERVAL * 4);
        }
    };

    let Some(mut snapshot) = normalize_usage_response(&data) else {
        warn(app, "response had no usable windows (schema drift?)");
        return BACKOFF_MAX.min(POLL_INTERVAL * 4);
    };

    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert("provider".into(), json!("claude"));
        obj.insert(
            "accountEmail".into(),
            active_account_email(app)
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        obj.insert("fetchedAt".into(), json!(now_ms()));
    }

    store_and_publish(app, "claude", snapshot);
    POLL_INTERVAL
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Last published snapshot per provider. The broadcast alone is lossy: the
// first poll fires ~3s after Rust setup, BEFORE the webview has subscribed,
// so without a pull path a freshly started app shows nothing until the next
// tick (150s). The renderer cache pulls this once on startup.
fn snapshot_store() -> &'static Mutex<HashMap<String, Value>> {
    static STORE: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn store_and_publish(app: &AppHandle, provider: &str, snapshot: Value) {
    let first = {
        let Ok(mut store) = snapshot_store().lock() else {
            return;
        };
        store
            .insert(provider.to_string(), snapshot.clone())
            .is_none()
    };
    if first {
        // One success line per provider per app run, so logs can distinguish
        // "polled fine but nobody was listening" from "never ran".
        warn(app, &format!("first {provider} usage snapshot published"));
    }
    publish_runtime_event(
        &crate::host_context::HostContext::from_app(app.clone()),
        "agent:usage",
        json!({ "payload": snapshot }),
        "rust-usage-poller",
    );
}

/// Pull path for the renderer cache: last snapshot per provider, or empty.
#[tauri::command]
pub fn agent_usage_snapshot() -> Value {
    match snapshot_store().lock() {
        Ok(store) => json!(store.clone()),
        Err(_) => json!({}),
    }
}

// Lazy per-account usage peek for the account dropdown: NON-active Claude
// accounts are only queried when the menu opens (never on a recurring poll),
// with a short cache so rapid menu reopens don't hammer the endpoint. Tokens
// for inactive accounts are NEVER refreshed — if one has expired we simply
// return null and the row shows no usage.
const PEEK_CACHE_TTL: Duration = Duration::from_secs(60);

fn peek_cache() -> &'static Mutex<HashMap<String, (std::time::Instant, Value)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (std::time::Instant, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn agent_usage_peek(account_id: String) -> Value {
    if let Ok(cache) = peek_cache().lock() {
        if let Some((at, value)) = cache.get(&account_id) {
            if at.elapsed() < PEEK_CACHE_TTL {
                return value.clone();
            }
        }
    }
    let id_for_task = account_id.clone();
    let result = crate::async_rt::spawn_blocking(move || -> Value {
        let Some(raw) = crate::account_store::peek_account_credential(&id_for_task) else {
            return Value::Null;
        };
        let Ok(token) = token_from_credentials_json(&raw) else {
            return Value::Null;
        };
        let Ok(client) = reqwest::blocking::Client::builder().build() else {
            return Value::Null;
        };
        let response = client
            .get(USAGE_URL)
            .bearer_auth(token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .timeout(Duration::from_secs(10))
            .send();
        let data: Value = match response
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
        {
            Ok(data) => data,
            Err(_) => return Value::Null, // expired token / network — best effort
        };
        let Some(mut snapshot) = normalize_usage_response(&data) else {
            return Value::Null;
        };
        if let Some(obj) = snapshot.as_object_mut() {
            obj.insert("provider".into(), json!("claude"));
            obj.insert("fetchedAt".into(), json!(now_ms()));
        }
        snapshot
    })
    .await
    .unwrap_or(Value::Null);

    if let Ok(mut cache) = peek_cache().lock() {
        cache.insert(account_id, (std::time::Instant::now(), result.clone()));
    }
    result
}

// ---- Codex (one account, one poll — same principle) ------------------------
//
// Codex exposes an OFFICIAL v2 app-server RPC, `account/rateLimits/read`,
// returning { rateLimits: { primary, secondary, planType, ... } } where
// primary is the 5h window and secondary the weekly window, each
// { usedPercent (0-100), windowDurationMins, resetsAt }. The same snapshot
// also arrives as the account/rateLimits/updated notification during turns.
// Both shapes funnel through publish_codex_usage.

// resetsAt units are not spelled out in the schema; epoch SECONDS is the
// codex-rs convention. Anything that already looks like milliseconds (>=1e12)
// passes through untouched.
fn epoch_to_ms(value: f64) -> u64 {
    if value >= 1e12 {
        value as u64
    } else {
        (value * 1000.0) as u64
    }
}

fn normalize_codex_window(window: Option<&Value>) -> Option<Value> {
    let obj = window?.as_object()?;
    let used_percent = obj.get("usedPercent").and_then(Value::as_f64)?;
    let resets_at = obj.get("resetsAt").and_then(Value::as_f64).map(epoch_to_ms);
    Some(json!({
        "utilization": used_percent / 100.0,
        "resetsAt": resets_at,
    }))
}

/// Pure; unit-tested. Accepts either the read response or the updated
/// notification params — both wrap the snapshot under `rateLimits`.
pub fn normalize_codex_rate_limits(raw: &Value) -> Option<Value> {
    let snapshot = raw.get("rateLimits").unwrap_or(raw);
    let obj = snapshot.as_object()?;
    let five_hour = normalize_codex_window(obj.get("primary"));
    let seven_day = normalize_codex_window(obj.get("secondary"));
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(json!({
        "provider": "codex",
        "fiveHour": five_hour,
        "sevenDay": seven_day,
        "planType": obj.get("planType").and_then(Value::as_str),
    }))
}

/// Publish a codex rate-limit snapshot (from poll or push notification) as an
/// agent:usage event. Quietly drops unusable payloads.
pub fn publish_codex_usage(app: &AppHandle, raw: &Value) {
    let Some(mut snapshot) = normalize_codex_rate_limits(raw) else {
        return;
    };
    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert("fetchedAt".into(), json!(now_ms()));
    }
    store_and_publish(app, "codex", snapshot);
}

// Poll codex through the EXISTING shared app-server connection (one process,
// one account). No connection (codex not in use) → cheap no-op; we never spawn
// an app-server just to read usage.
fn poll_codex_once(app: &AppHandle) -> Duration {
    let state = app.state::<crate::codex_app_server::CodexAppServerState>();
    match state.fetch_account_rate_limits(&crate::host_context::HostContext::from_app(app.clone()))
    {
        Some(raw) => publish_codex_usage(app, &raw),
        None => {}
    }
    POLL_INTERVAL
}

/// Spawn the host-wide poll thread. Call once from app setup.
pub fn start(app: AppHandle) {
    if std::env::var("BAT_DISABLE_USAGE_POLL").as_deref() == Ok("1") {
        return;
    }
    std::thread::Builder::new()
        .name("claude-usage-poll".into())
        .spawn(move || {
            let client = match reqwest::blocking::Client::builder().build() {
                Ok(client) => client,
                Err(err) => {
                    warn(&app, &format!("http client init failed: {err}"));
                    return;
                }
            };
            std::thread::sleep(FIRST_POLL_DELAY);
            // Per-provider due times on a coarse scheduler tick, so a Claude
            // backoff (e.g. not logged in → 10 min retry) never starves the
            // codex cadence and vice versa.
            let tick = Duration::from_secs(30);
            let mut claude_due = std::time::Instant::now();
            let mut codex_due = std::time::Instant::now();
            loop {
                let now = std::time::Instant::now();
                if now >= claude_due {
                    claude_due = now + poll_once(&app, &client);
                }
                if now >= codex_due {
                    codex_due = now + poll_codex_once(&app);
                }
                std::thread::sleep(tick);
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_live_endpoint_shape() {
        let out = normalize_usage_response(&json!({
            "five_hour": { "utilization": 46.0, "resets_at": "2026-06-12T22:29:59.744481+08:00" },
            "seven_day": { "utilization": 17.0, "resets_at": "2026-06-15T10:59:59.744501+08:00" },
            "seven_day_sonnet": { "utilization": 0.0 },
            "extra_usage": { "is_enabled": true, "monthly_limit": 1000, "used_credits": 12.5, "currency": "USD" },
            "tangelo": null,
        }))
        .expect("usable windows");
        assert_eq!(out["fiveHour"]["utilization"].as_f64(), Some(0.46));
        assert_eq!(
            out["fiveHour"]["resetsAt"].as_str(),
            Some("2026-06-12T22:29:59.744481+08:00")
        );
        assert_eq!(out["sevenDay"]["utilization"].as_f64(), Some(0.17));
        assert_eq!(out["extraUsage"]["monthlyLimit"].as_f64(), Some(1000.0));
        assert_eq!(out["extraUsage"]["isEnabled"].as_bool(), Some(true));
    }

    #[test]
    fn tolerates_partial_windows() {
        let out = normalize_usage_response(&json!({ "five_hour": { "utilization": 80.0 } }))
            .expect("five_hour present");
        assert_eq!(out["fiveHour"]["utilization"].as_f64(), Some(0.8));
        assert!(out["fiveHour"]["resetsAt"].is_null());
        assert!(out["sevenDay"].is_null());
        assert!(out["extraUsage"].is_null());
    }

    #[test]
    fn schema_drift_degrades_to_none() {
        assert!(normalize_usage_response(&json!(null)).is_none());
        assert!(normalize_usage_response(&json!({})).is_none());
        assert!(
            normalize_usage_response(&json!({ "five_hour": "weird", "seven_day": 42 })).is_none()
        );
    }

    #[test]
    fn normalizes_codex_read_response() {
        let out = normalize_codex_rate_limits(&json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 32.5, "windowDurationMins": 300, "resetsAt": 1781300000 },
                "secondary": { "usedPercent": 8.0, "windowDurationMins": 10080, "resetsAt": 1781700000 },
                "planType": "plus"
            },
            "rateLimitsByLimitId": null
        }))
        .expect("usable snapshot");
        assert_eq!(out["provider"].as_str(), Some("codex"));
        assert_eq!(out["fiveHour"]["utilization"].as_f64(), Some(0.325));
        // epoch seconds -> ms
        assert_eq!(
            out["fiveHour"]["resetsAt"].as_u64(),
            Some(1_781_300_000_000)
        );
        assert_eq!(out["sevenDay"]["utilization"].as_f64(), Some(0.08));
        assert_eq!(out["planType"].as_str(), Some("plus"));
    }

    #[test]
    fn normalizes_codex_updated_notification_and_bare_snapshot() {
        // Notification params wrap the snapshot under rateLimits too.
        let wrapped = normalize_codex_rate_limits(&json!({
            "rateLimits": { "primary": { "usedPercent": 50.0, "resetsAt": 1781300000000_u64 } }
        }))
        .expect("wrapped snapshot");
        // already-ms resetsAt passes through untouched
        assert_eq!(
            wrapped["fiveHour"]["resetsAt"].as_u64(),
            Some(1_781_300_000_000)
        );

        let bare = normalize_codex_rate_limits(&json!({
            "primary": { "usedPercent": 10.0 }
        }))
        .expect("bare snapshot");
        assert_eq!(bare["fiveHour"]["utilization"].as_f64(), Some(0.1));
        assert!(bare["sevenDay"].is_null());
    }

    #[test]
    fn codex_schema_drift_degrades_to_none() {
        assert!(normalize_codex_rate_limits(&json!({})).is_none());
        assert!(normalize_codex_rate_limits(&json!({ "rateLimits": {} })).is_none());
        assert!(
            normalize_codex_rate_limits(&json!({ "rateLimits": { "primary": "weird" } })).is_none()
        );
    }
}
