// Provider registry for the Rust host.
//
// shared/providers.json is the single source of truth for which providers and
// agent presets exist. The renderer and the node sidecar read the same file
// through shared/providers.mjs; this module embeds it at compile time. Code in
// the host looks presets up here instead of comparing id literals.
// See docs/providers.md.

use serde::Deserialize;
use serde_json::{Map, Value};
use std::sync::OnceLock;

const PROVIDER_MANIFEST_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../shared/providers.json"
));

/// Registry-only preset keys. They are stripped from the metadata served to
/// renderers and remote clients (`agent:list-presets`), which predates them.
const REGISTRY_ONLY_PRESET_KEYS: &[&str] = &["provider", "panel", "hidden"];

// Every field is part of the manifest contract: deserializing it is what
// rejects a malformed shared/providers.json on first use, even before a call site
// reads the field.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDefinition {
    pub id: String,
    pub label: String,
    pub auth: String,
    pub usage: String,
    pub default_enabled: bool,
    #[serde(default)]
    pub debug_only: bool,
}

#[allow(dead_code)] // see ProviderDefinition
#[derive(Debug, Deserialize)]
pub struct PresetDefinition {
    pub id: String,
    pub provider: Option<String>,
    pub panel: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub debug: bool,
    /// The full JSON object, used to build the renderer-facing metadata.
    #[serde(skip)]
    raw: Map<String, Value>,
}

#[allow(dead_code)] // see ProviderDefinition
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderManifest {
    pub schema_version: u32,
    pub providers: Vec<ProviderDefinition>,
    pub presets: Vec<PresetDefinition>,
}

fn parse_manifest(json: &str) -> Result<ProviderManifest, String> {
    let raw: Value = serde_json::from_str(json).map_err(|err| format!("invalid JSON: {err}"))?;
    let mut manifest: ProviderManifest =
        serde_json::from_value(raw.clone()).map_err(|err| format!("invalid manifest: {err}"))?;
    let raw_presets = raw
        .get("presets")
        .and_then(Value::as_array)
        .ok_or("presets must be an array")?;
    for (preset, raw_preset) in manifest.presets.iter_mut().zip(raw_presets) {
        preset.raw = raw_preset.as_object().cloned().unwrap_or_default();
    }
    Ok(manifest)
}

/// The embedded manifest. shared/providers.json is validated by the JS test
/// suite and by this module's tests, so a parse failure here is a build bug.
pub fn manifest() -> &'static ProviderManifest {
    static MANIFEST: OnceLock<ProviderManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        parse_manifest(PROVIDER_MANIFEST_JSON)
            .unwrap_or_else(|err| panic!("shared/providers.json: {err}"))
    })
}

pub fn preset(id: &str) -> Option<&'static PresetDefinition> {
    manifest().presets.iter().find(|preset| preset.id == id)
}

/// Preset ids offered to users, in manifest order. Hidden presets are never
/// offered; debug-only presets only when `debug_enabled`.
pub fn offered_preset_ids(debug_enabled: bool) -> Vec<&'static str> {
    manifest()
        .presets
        .iter()
        .filter(|preset| !preset.hidden && (debug_enabled || !preset.debug))
        .map(|preset| preset.id.as_str())
        .collect()
}

/// Renderer-facing metadata for a preset (the `agent:list-presets` shape).
pub fn preset_metadata(id: &str) -> Option<Value> {
    let preset = preset(id)?;
    let mut object = preset.raw.clone();
    for key in REGISTRY_ONLY_PRESET_KEYS {
        object.remove(*key);
    }
    Some(Value::Object(object))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_parses_and_is_consistent() {
        let manifest = manifest();
        assert_eq!(manifest.schema_version, 1);
        let provider_ids: Vec<&str> = manifest.providers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(provider_ids, ["claude", "codex", "fugu"]);
        for preset in &manifest.presets {
            if let Some(provider) = &preset.provider {
                assert!(
                    provider_ids.contains(&provider.as_str()),
                    "preset {} references unknown provider {provider}",
                    preset.id
                );
            }
        }
    }

    #[test]
    fn provider_lookup() {
        assert_eq!(
            preset("codex-fugu").and_then(|p| p.provider.as_deref()),
            Some("fugu")
        );
        assert_eq!(preset("none").map(|p| p.provider.is_none()), Some(true));
        assert!(preset("nope").is_none());
        assert_eq!(
            preset("codex-fugu").map(|p| p.panel.as_str()),
            Some("codex-agent")
        );
    }

    #[test]
    fn metadata_strips_registry_only_keys() {
        let metadata = preset_metadata("codex-fugu").unwrap();
        for key in REGISTRY_ONLY_PRESET_KEYS {
            assert!(metadata.get(*key).is_none(), "{key} leaked into metadata");
        }
        assert_eq!(metadata["name"], "Codex Fugu Agent");
        assert_eq!(preset_metadata("nope"), None);
    }

    #[test]
    fn hidden_presets_are_never_offered() {
        assert!(!offered_preset_ids(true).contains(&"claude-code-v2"));
        assert!(!offered_preset_ids(false).contains(&"codex-fugu"));
        assert!(offered_preset_ids(true).contains(&"codex-fugu"));
    }
}
