// agent.* — read-only host capability metadata.

// The renderer-facing #[tauri::command] wrappers (and the remote-client /
// window plumbing they use) are desktop-only; the remote dispatch calls the
// pure `agent_supported_*` cores directly, which compile in the headless build.
#[cfg(feature = "desktop")]
use crate::commands::profile as profile_cmd;
#[cfg(feature = "desktop")]
use crate::remote_client::RustRemoteClientState;
#[cfg(feature = "desktop")]
use crate::window_registry;
use serde_json::{json, Value};
#[cfg(feature = "desktop")]
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, WebviewWindow};

fn bat_debug_enabled() -> bool {
    matches!(
        std::env::var("BAT_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn agent_get_supported_session_types(app: AppHandle, window: WebviewWindow) -> Value {
    if let Some(remote_result) = remote_supported_session_types(&app, &window).await {
        return remote_result.unwrap_or_else(|_| agent_supported_session_type_ids());
    }
    agent_supported_session_type_ids()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn agent_list_presets(app: AppHandle, window: WebviewWindow) -> Value {
    if let Some(remote_result) = remote_agent_presets(&app, &window).await {
        return remote_result.unwrap_or_else(|_| agent_supported_session_presets());
    }
    agent_supported_session_presets()
}

/// Response-time samples for the statistics page, in `[from_ms, to_ms]`.
///
/// Raw records rather than aggregates: the page shows a per-sample list, and
/// bucketing by hour needs the local UTC offset, which only the renderer knows.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn agent_latency_samples(
    app: AppHandle,
    window: WebviewWindow,
    from_ms: i64,
    to_ms: i64,
) -> Result<Value, String> {
    // Host-owned, like usage: in remote mode the host is the machine that made
    // the API calls, so its files are the only ones with anything in them.
    if let Some(remote) = remote_agent_invoke(
        &app,
        &window,
        "agent:latency-samples",
        vec![json!(from_ms), json!(to_ms)],
    )
    .await
    {
        return remote;
    }
    let data_dir = crate::app_data::app_data_dir(&app)?;
    Ok(crate::latency_store::latency_samples_core(
        &data_dir, from_ms, to_ms,
    ))
}

#[cfg(feature = "desktop")]
async fn remote_supported_session_types(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Option<Result<Value, String>> {
    remote_agent_invoke(app, window, "agent:get-supported-session-types", Vec::new()).await
}

#[cfg(feature = "desktop")]
async fn remote_agent_presets(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Option<Result<Value, String>> {
    remote_agent_invoke(app, window, "agent:list-presets", Vec::new()).await
}

/// Forward a host-owned read to the remote host this window is attached to, or
/// `None` when the window is local and the caller should answer it itself.
///
/// `args` is positional (legacy v1); the host maps it back onto named params via
/// the key list registered for the channel in remote_core::remote_channel_keys.
#[cfg(feature = "desktop")]
async fn remote_agent_invoke(
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
    Some(
        crate::async_rt::spawn_blocking(move || {
            remote_client.invoke(&window_label, channel, args, Duration::from_secs(10))
        })
        .await
        .map_err(|err| format!("remote.invoke {channel} worker failed: {err}"))
        .and_then(|value| value),
    )
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

pub fn agent_supported_session_type_ids() -> Value {
    json!(agent_supported_session_type_ids_for_debug(
        bat_debug_enabled()
    ))
}

pub fn agent_supported_session_presets() -> Value {
    json!(agent_supported_session_presets_for_debug(
        bat_debug_enabled()
    ))
}

fn agent_supported_session_type_ids_for_debug(debug_enabled: bool) -> Vec<&'static str> {
    crate::providers::offered_preset_ids(debug_enabled)
}

fn agent_supported_session_presets_for_debug(debug_enabled: bool) -> Vec<Value> {
    agent_supported_session_type_ids_for_debug(debug_enabled)
        .into_iter()
        .filter_map(crate::providers::preset_metadata)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_list_matches_supported_runtime_ids() {
        let all = agent_supported_session_type_ids_for_debug(true);
        assert!(all.contains(&"claude-code"));
        assert!(all.contains(&"claude-channel"));
        assert!(!all.contains(&"claude-code-v2"));
        assert!(all.contains(&"codex-agent"));
        assert!(all.contains(&"codex-agent-worktree"));
        assert!(!all.contains(&"openai-agent"));
    }

    #[test]
    fn supported_session_types_hide_debug_only_presets_without_debug() {
        let regular = agent_supported_session_type_ids_for_debug(false);
        assert!(regular.contains(&"claude-code"));
        assert!(!regular.contains(&"claude-channel"));
        assert!(!regular.contains(&"claude-cli-agent"));

        let debug = agent_supported_session_type_ids_for_debug(true);
        assert!(debug.contains(&"claude-channel"));
        assert!(debug.contains(&"claude-cli-agent"));
    }

    #[test]
    fn claude_cli_agent_preset_metadata_present_in_debug() {
        let presets = agent_supported_session_presets_for_debug(true);
        assert!(presets.iter().any(|preset| {
            preset.get("id").and_then(Value::as_str) == Some("claude-cli-agent")
                && preset.get("backend").and_then(Value::as_str) == Some("cli")
        }));
    }

    /// Golden list captured from the renderer's AGENT_PRESETS before presets
    /// moved to shared/providers.json. The host must keep serving exactly
    /// these objects (minus the hidden claude-code-v2) to remote clients.
    fn legacy_fixture() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/legacy-agent-presets.json"
        )))
        .expect("legacy preset fixture parses")
    }

    fn legacy_presets_for(ids: &Value) -> Vec<Value> {
        let fixture = legacy_fixture();
        let presets = fixture["presets"].as_array().unwrap();
        ids.as_array()
            .unwrap()
            .iter()
            .map(|id| {
                presets
                    .iter()
                    .find(|preset| preset["id"] == *id)
                    .cloned()
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn preset_metadata_matches_legacy_fixture() {
        let fixture = legacy_fixture();
        assert_eq!(
            agent_supported_session_presets_for_debug(false),
            legacy_presets_for(&fixture["visible"])
        );
        assert_eq!(
            agent_supported_session_presets_for_debug(true),
            legacy_presets_for(&fixture["visibleDebug"])
        );
    }

    #[test]
    fn preset_metadata_contains_names_for_supported_ids() {
        let presets = agent_supported_session_presets_for_debug(false);
        assert!(presets.iter().any(|preset| {
            preset.get("id").and_then(Value::as_str) == Some("codex-agent")
                && preset.get("name").and_then(Value::as_str) == Some("Codex Agent")
        }));
        assert!(!presets
            .iter()
            .any(|preset| { preset.get("id").and_then(Value::as_str) == Some("claude-channel") }));
    }
}
