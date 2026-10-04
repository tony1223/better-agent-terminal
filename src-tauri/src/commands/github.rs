// github:* — wrappers around the `gh` CLI.
//
// The user's installed `gh` binary handles authentication and API requests.
// Rust runs it with bounded execution time and routes remote-profile calls
// to the owning host.
//
// Read commands return the JSON gh emits as an opaque
// `serde_json::Value` so the renderer can reuse its existing
// schema-derived types. Write commands (pr-comment, issue-comment)
// return `{success: true}` or `{error: msg}` under the existing host contract.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

// Remote-profile plumbing + #[tauri::command] wrappers are desktop-only; the
// remote dispatch calls the pure github_*_native cores, which stay.
#[cfg(feature = "desktop")]
use crate::commands::profile as profile_cmd;
#[cfg(feature = "desktop")]
use crate::remote_client::RustRemoteClientState;
use crate::subprocess::hide_console_window;
#[cfg(feature = "desktop")]
use crate::window_registry;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, WebviewWindow};

const READ_TIMEOUT: Duration = Duration::from_secs(15);
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const REMOTE_GITHUB_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    pub authenticated: bool,
}

#[cfg(feature = "desktop")]
fn is_remote_profile_window(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Some(profile_id) = window_registry::profile_id_for_window(app, window.label()) else {
        return false;
    };
    profile_cmd::profile_get(app.clone(), profile_id)
        .map(|profile| profile.kind == "remote")
        .unwrap_or(false)
}

#[cfg(feature = "desktop")]
async fn remote_invoke_for_window(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &'static str,
    args: Vec<Value>,
) -> Option<Result<Value, String>> {
    if !is_remote_profile_window(app, window) {
        return None;
    }
    let remote_client = app.state::<RustRemoteClientState>().inner().clone();
    let window_label = window.label().to_string();
    let result = crate::async_rt::spawn_blocking(move || {
        remote_client.invoke(&window_label, channel, args, REMOTE_GITHUB_TIMEOUT)
    })
    .await
    .map_err(|err| format!("remote.invoke {channel} worker failed: {err}"));
    Some(match result {
        Ok(value) => value,
        Err(err) => Err(err),
    })
}

fn from_remote_value<T>(value: Value) -> Result<T, String>
where
    T: DeserializeOwned,
{
    serde_json::from_value(value).map_err(|err| err.to_string())
}

// Resolve an absolute `gh` binary path. macOS .app launched from Finder /
// Dock inherits a minimal PATH that often excludes `/opt/homebrew/bin` and
// `/usr/local/bin`, so `Command::new("gh")` fails even when the user has
// gh installed. Mirror the node resolver in codex_app_server.rs: walk the
// inherited PATH, then fall back to common install dirs.
fn resolve_gh_binary() -> PathBuf {
    let exe_names: &[&str] = if cfg!(windows) {
        &["gh.exe", "gh.cmd", "gh"]
    } else {
        &["gh"]
    };
    if let Some(path_env) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_env) {
            for name in exe_names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    let fallbacks: &[&str] = &["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
    #[cfg(target_os = "linux")]
    let fallbacks: &[&str] = &["/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"];
    #[cfg(windows)]
    let fallbacks: &[&str] = &[];
    for f in fallbacks {
        let p = PathBuf::from(f);
        if p.is_file() {
            return p;
        }
    }
    // Last resort: bare name so the error message stays meaningful.
    PathBuf::from("gh")
}

// Run `gh` with the given args, optionally in a cwd. Returns
// (stdout_string, success_flag).
fn run_gh(cwd: Option<&str>, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new(resolve_gh_binary());
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        if dir.trim().is_empty() {
            return Err("cwd is empty".into());
        }
        if !Path::new(dir).is_dir() {
            return Err(format!("cwd does not exist: {dir}"));
        }
        cmd.current_dir(dir);
    }
    hide_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn gh: {e}"))?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("gh timed out".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait_with_output: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        return Err(if trimmed.is_empty() {
            format!("gh exited with status {}", output.status)
        } else {
            trimmed.to_string()
        });
    }
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return Err("gh output exceeds 5 MiB cap".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn run_gh_blocking(
    cwd: Option<String>,
    args: Vec<String>,
    timeout: Duration,
) -> Result<String, String> {
    crate::async_rt::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_gh(cwd.as_deref(), &refs, timeout)
    })
    .await
    .map_err(|e| format!("gh worker failed: {e}"))?
}

// Helper for read commands that shape the response as either parsed
// JSON or `{error: msg}` (Electron parity).
fn json_or_error(result: Result<String, String>) -> Value {
    match result {
        Ok(stdout) => match serde_json::from_str::<Value>(&stdout) {
            Ok(v) => v,
            Err(e) => serde_json::json!({ "error": format!("gh JSON parse failed: {e}") }),
        },
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn github_check_cli(app: AppHandle, window: WebviewWindow) -> CliStatus {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "github:check-cli", Vec::new()).await
    {
        return result.and_then(from_remote_value).unwrap_or(CliStatus {
            installed: false,
            authenticated: false,
        });
    }
    github_check_cli_native().await
}

pub(crate) async fn github_check_cli_native() -> CliStatus {
    let installed = run_gh_blocking(None, vec!["--version".into()], CHECK_TIMEOUT)
        .await
        .is_ok();
    if !installed {
        return CliStatus {
            installed: false,
            authenticated: false,
        };
    }
    // `gh auth status` exits non-zero whenever ANY configured
    // account has problems, even when the active one is fine.
    // `gh auth token` only validates the active account, which is
    // what we actually care about here.
    let authenticated = run_gh_blocking(None, vec!["auth".into(), "token".into()], CHECK_TIMEOUT)
        .await
        .is_ok();
    CliStatus {
        installed: true,
        authenticated,
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn github_pr_list(app: AppHandle, window: WebviewWindow, cwd: String) -> Value {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "github:pr-list", vec![json!(cwd.clone())]).await
    {
        return result.unwrap_or_else(|err| json!({ "error": err }));
    }
    github_pr_list_native(cwd).await
}

pub(crate) async fn github_pr_list_native(cwd: String) -> Value {
    let args = vec![
        "pr",
        "list",
        "--json",
        "number,title,state,author,createdAt,updatedAt,labels,headRefName,isDraft",
        "--limit",
        "50",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    json_or_error(run_gh_blocking(Some(cwd), args, READ_TIMEOUT).await)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn github_issue_list(app: AppHandle, window: WebviewWindow, cwd: String) -> Value {
    if let Some(result) =
        remote_invoke_for_window(&app, &window, "github:issue-list", vec![json!(cwd.clone())]).await
    {
        return result.unwrap_or_else(|err| json!({ "error": err }));
    }
    github_issue_list_native(cwd).await
}

pub(crate) async fn github_issue_list_native(cwd: String) -> Value {
    let args = vec![
        "issue",
        "list",
        "--json",
        "number,title,state,author,createdAt,updatedAt,labels",
        "--limit",
        "50",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    json_or_error(run_gh_blocking(Some(cwd), args, READ_TIMEOUT).await)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn github_pr_view(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
    number: i64,
) -> Value {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "github:pr-view",
        vec![json!(cwd.clone()), json!(number)],
    )
    .await
    {
        return result.unwrap_or_else(|err| json!({ "error": err }));
    }
    github_pr_view_native(cwd, number).await
}

pub(crate) async fn github_pr_view_native(cwd: String, number: i64) -> Value {
    let n = number.to_string();
    let args = vec![
        "pr".into(),
        "view".into(),
        n,
        "--json".into(),
        "number,title,state,author,body,comments,reviews,createdAt,headRefName,baseRefName,additions,deletions,files".into(),
    ];
    json_or_error(run_gh_blocking(Some(cwd), args, READ_TIMEOUT).await)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn github_issue_view(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
    number: i64,
) -> Value {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "github:issue-view",
        vec![json!(cwd.clone()), json!(number)],
    )
    .await
    {
        return result.unwrap_or_else(|err| json!({ "error": err }));
    }
    github_issue_view_native(cwd, number).await
}

pub(crate) async fn github_issue_view_native(cwd: String, number: i64) -> Value {
    let n = number.to_string();
    let args = vec![
        "issue".into(),
        "view".into(),
        n,
        "--json".into(),
        "number,title,state,author,body,comments,createdAt,labels".into(),
    ];
    json_or_error(run_gh_blocking(Some(cwd), args, READ_TIMEOUT).await)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn github_pr_comment(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
    number: i64,
    body: String,
) -> Value {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "github:pr-comment",
        vec![json!(cwd.clone()), json!(number), json!(body.clone())],
    )
    .await
    {
        return result.unwrap_or_else(|err| json!({ "error": err }));
    }
    github_pr_comment_native(cwd, number, body).await
}

pub(crate) async fn github_pr_comment_native(cwd: String, number: i64, body: String) -> Value {
    let n = number.to_string();
    let args = vec!["pr".into(), "comment".into(), n, "--body".into(), body];
    match run_gh_blocking(Some(cwd), args, READ_TIMEOUT).await {
        Ok(_) => serde_json::json!({ "success": true }),
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn github_issue_comment(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
    number: i64,
    body: String,
) -> Value {
    if let Some(result) = remote_invoke_for_window(
        &app,
        &window,
        "github:issue-comment",
        vec![json!(cwd.clone()), json!(number), json!(body.clone())],
    )
    .await
    {
        return result.unwrap_or_else(|err| json!({ "error": err }));
    }
    github_issue_comment_native(cwd, number, body).await
}

pub(crate) async fn github_issue_comment_native(cwd: String, number: i64, body: String) -> Value {
    let n = number.to_string();
    let args = vec!["issue".into(), "comment".into(), n, "--body".into(), body];
    match run_gh_blocking(Some(cwd), args, READ_TIMEOUT).await {
        Ok(_) => serde_json::json!({ "success": true }),
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_or_error_parses_valid_json() {
        let v = json_or_error(Ok(r#"[{"number":1,"title":"hi"}]"#.into()));
        let arr = v.as_array().expect("array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["number"], 1);
    }

    #[test]
    fn json_or_error_wraps_invalid_json() {
        let v = json_or_error(Ok("not json".into()));
        let err = v.get("error").and_then(Value::as_str).unwrap_or_default();
        assert!(err.contains("gh JSON parse failed"), "got: {err}");
    }

    #[test]
    fn json_or_error_wraps_command_error() {
        let v = json_or_error(Err("nope".into()));
        assert_eq!(v.get("error").and_then(Value::as_str), Some("nope"));
    }

    #[test]
    fn cli_status_serializes_camel_case() {
        // The renderer reads `{installed, authenticated}` as
        // camelCase. Both fields are simple booleans, so serde's
        // default rename keeps the wire format intact.
        let s = CliStatus {
            installed: true,
            authenticated: false,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"installed\":true"));
        assert!(json.contains("\"authenticated\":false"));
    }

    #[test]
    fn run_gh_rejects_missing_cwd() {
        // We can't depend on `gh` being installed in CI, so just
        // assert the cwd validation kicks in before we spawn.
        let r = run_gh(Some(""), &["--version"], CHECK_TIMEOUT);
        assert!(r.is_err());
        let r = run_gh(
            Some("C:/this/path/should/never/exist/abc123"),
            &["--version"],
            CHECK_TIMEOUT,
        );
        assert!(r.is_err());
    }
}
