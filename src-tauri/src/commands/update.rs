// update:* — version + GitHub release polling.
//
// Tauri owns the current app version, and Rust now performs the GitHub
// Releases request directly so update checks do not wake the Node sidecar.

use crate::sidecar::BridgeError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const GITHUB_LATEST_RELEASE: &str =
    "https://api.github.com/repos/tony1223/better-agent-terminal/releases/latest";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    assets: Option<Vec<GithubAsset>>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: Option<String>,
    browser_download_url: Option<String>,
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn update_get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

fn bundle_mode_from_resource_dir(
    resource_dir: Option<&Path>,
    prefer_all_in_one: bool,
) -> &'static str {
    if prefer_all_in_one {
        return "all-in-one";
    }
    match resource_dir {
        Some(dir) => match std::fs::read_to_string(dir.join("bundle-mode.txt")) {
            Ok(marker) if marker.trim() == "lightweight" => "lightweight",
            Ok(marker) if marker.trim() == "all-in-one" => "all-in-one",
            _ if dir.join("node-runtime").is_dir() => "all-in-one",
            _ => "lightweight",
        },
        // Preserve the historical safe default if Tauri cannot resolve its
        // resource directory. An all-in-one update still works everywhere;
        // the inverse could remove runtimes from an existing installation.
        None => "all-in-one",
    }
}

/// Which package was installed: "all-in-one" or "lightweight". The packaged
/// Node runtime is the mode marker, allowing both flavors to share an identical
/// compiled Rust library. Debug/dev builds keep the historical all-in-one
/// default even when no bundle resource directory exists yet.
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn update_get_bundle_mode(app: tauri::AppHandle) -> &'static str {
    let resource_dir = app.path().resource_dir().ok();
    bundle_mode_from_resource_dir(resource_dir.as_deref(), cfg!(debug_assertions))
}

const MANIFEST_BASE: &str =
    "https://github.com/tony1223/better-agent-terminal/releases/download/manifests";

/// Resolve the Tauri-updater manifest URL for the requested channel and the
/// build's own bundle mode (so a lightweight install only ever upgrades to a
/// lightweight build, and vice versa).
fn manifest_endpoint(channel: &str, mode: &str) -> String {
    let ch = if channel == "pre" { "pre" } else { "stable" };
    format!("{MANIFEST_BASE}/latest-{ch}-{mode}.json")
}

fn build_updater(
    app: &tauri::AppHandle,
    channel: &str,
) -> Result<tauri_plugin_updater::Updater, BridgeError> {
    let resource_dir = app.path().resource_dir().ok();
    let mode = bundle_mode_from_resource_dir(resource_dir.as_deref(), cfg!(debug_assertions));
    let endpoint = manifest_endpoint(channel, mode);
    let url = reqwest::Url::parse(&endpoint).map_err(|err| BridgeError {
        message: format!("invalid updater endpoint {endpoint}: {err}"),
    })?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|err| BridgeError {
            message: format!("updater endpoints rejected: {err}"),
        })?
        .build()
        .map_err(|err| BridgeError {
            message: format!("updater build failed: {err}"),
        })
}

/// Check the per-channel/per-mode manifest for a newer build. Returns
/// `{ available, currentVersion, version?, notes? }`. Does not download.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn update_check_native(
    app: tauri::AppHandle,
    channel: String,
) -> Result<Value, BridgeError> {
    let current = app.package_info().version.to_string();
    let updater = build_updater(&app, &channel)?;
    match updater.check().await {
        Ok(Some(update)) => Ok(json!({
            "available": true,
            "currentVersion": current,
            "version": update.version,
            "notes": update.body,
            "channel": channel,
        })),
        Ok(None) => Ok(json!({
            "available": false,
            "currentVersion": current,
            "channel": channel,
        })),
        Err(err) => Err(BridgeError {
            message: format!("update check failed: {err}"),
        }),
    }
}

/// Download + install the latest build for this channel/mode in the
/// background. Emits `update://download-progress` and `update://download-finished`
/// events. Intentionally does NOT relaunch — the swapped bundle applies on the
/// next launch; the UI prompts the user to restart.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, channel: String) -> Result<Value, BridgeError> {
    let updater = build_updater(&app, &channel)?;
    let Some(update) = updater.check().await.map_err(|err| BridgeError {
        message: format!("update check failed: {err}"),
    })?
    else {
        return Ok(json!({ "installed": false, "reason": "up-to-date" }));
    };
    let version = update.version.clone();
    let progress_app = app.clone();
    let mut downloaded: usize = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk;
                let _ = progress_app.emit(
                    "update://download-progress",
                    json!({ "downloaded": downloaded, "total": total }),
                );
            },
            move || {
                let _ = app.emit("update://download-finished", json!({}));
            },
        )
        .await
        .map_err(|err| BridgeError {
            message: format!("update install failed: {err}"),
        })?;
    Ok(json!({ "installed": true, "version": version }))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Value, BridgeError> {
    let current_version = app.package_info().version.to_string();
    crate::async_rt::spawn_blocking(move || check_update_native(&current_version))
        .await
        .map_err(|err| BridgeError {
            message: format!("update.check worker failed: {err}"),
        })
}

fn check_update_native(current_version: &str) -> Value {
    let fallback = update_fallback(current_version);
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Better-Agent-Terminal")
        .build()
    {
        Ok(client) => client,
        Err(_) => return fallback,
    };
    let response = match client
        .get(GITHUB_LATEST_RELEASE)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
    {
        Ok(response) => response,
        Err(_) => return fallback,
    };
    if !response.status().is_success() {
        return fallback;
    }
    let Ok(release) = response.json::<GithubRelease>() else {
        return fallback;
    };
    let Some(tag_name) = release.tag_name.filter(|value| !value.trim().is_empty()) else {
        return fallback;
    };
    let latest_version = tag_name.trim_start_matches('v').to_string();
    let download_url = release.assets.as_ref().and_then(|assets| {
        assets.iter().find_map(|asset| {
            let name = asset.name.as_deref()?;
            if name.ends_with("-win.zip") || name.contains("win") {
                asset.browser_download_url.clone()
            } else {
                None
            }
        })
    });
    json!({
        "hasUpdate": compare_versions(current_version, &latest_version),
        "currentVersion": current_version,
        "latestRelease": {
            "version": latest_version,
            "tagName": tag_name,
            "htmlUrl": release.html_url,
            "downloadUrl": download_url,
            "body": release.body.unwrap_or_default(),
            "publishedAt": release.published_at,
        }
    })
}

fn update_fallback(current_version: &str) -> Value {
    json!({
        "hasUpdate": false,
        "currentVersion": current_version,
        "latestRelease": Value::Null,
    })
}

fn compare_versions(current: &str, latest: &str) -> bool {
    let current_parts = parse_version_parts(current);
    let latest_parts = parse_version_parts(latest);
    let len = current_parts.len().max(latest_parts.len());
    for index in 0..len {
        let current_part = current_parts.get(index).copied().unwrap_or(0);
        let latest_part = latest_parts.get(index).copied().unwrap_or(0);
        if latest_part > current_part {
            return true;
        }
        if latest_part < current_part {
            return false;
        }
    }
    false
}

fn parse_version_parts(version: &str) -> Vec<u64> {
    version
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_pkg_version_is_non_empty() {
        let v = env!("CARGO_PKG_VERSION");
        assert!(!v.is_empty(), "CARGO_PKG_VERSION must not be empty");
        assert!(v.contains('.'), "version should contain a dot: {v}");
    }

    #[test]
    fn compare_versions_matches_sidecar_semantics() {
        assert!(compare_versions("1.2.3", "1.2.4"));
        assert!(compare_versions("v1.2.3", "2.0.0"));
        assert!(!compare_versions("1.2.3", "1.2.3"));
        assert!(!compare_versions("1.2.3", "1.2.2"));
        assert!(!compare_versions("1.2.3", "1.2"));
        assert!(compare_versions("1.2", "1.2.1"));
    }

    #[test]
    fn fallback_keeps_renderer_shape() {
        let value = update_fallback("1.2.3");
        assert_eq!(value["hasUpdate"], false);
        assert_eq!(value["currentVersion"], "1.2.3");
        assert!(value["latestRelease"].is_null());
    }

    #[test]
    fn packaged_node_runtime_marks_all_in_one_bundle() {
        let root =
            std::env::temp_dir().join(format!("bat-update-bundle-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node-runtime")).unwrap();
        assert_eq!(
            bundle_mode_from_resource_dir(Some(&root), false),
            "all-in-one"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn packaged_marker_takes_priority_over_leftover_runtime_files() {
        let root =
            std::env::temp_dir().join(format!("bat-update-bundle-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node-runtime")).unwrap();
        std::fs::write(root.join("bundle-mode.txt"), "lightweight\n").unwrap();
        assert_eq!(
            bundle_mode_from_resource_dir(Some(&root), false),
            "lightweight"
        );
        std::fs::write(root.join("bundle-mode.txt"), "all-in-one\n").unwrap();
        assert_eq!(
            bundle_mode_from_resource_dir(Some(&root), false),
            "all-in-one"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_packaged_runtime_marks_lightweight_bundle() {
        let root = std::env::temp_dir().join(format!(
            "bat-update-lightweight-mode-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(
            bundle_mode_from_resource_dir(Some(&root), false),
            "lightweight"
        );
        assert_eq!(
            bundle_mode_from_resource_dir(Some(&root), true),
            "all-in-one"
        );
        assert_eq!(bundle_mode_from_resource_dir(None, false), "all-in-one");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn updater_manifest_keeps_channel_and_bundle_mode_separate() {
        assert!(
            manifest_endpoint("stable", "all-in-one").ends_with("/latest-stable-all-in-one.json")
        );
        assert!(manifest_endpoint("pre", "lightweight").ends_with("/latest-pre-lightweight.json"));
    }
}
