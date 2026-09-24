//! Connection-owned profile routing. The wire contract never exposes target credentials.
use crate::commands::profile::{profile_entry_for_context, ProfileEntry};
use crate::commands::remote_tunnel::{
    ensure_context_tunnel, normalize_ssh_target, RemoteTunnelEndpoint, RemoteTunnelSpec,
};
use crate::host_context::HostContext;
use crate::remote_client::{RemoteEventSink, RustRemoteClientState};
use crate::remote_core::{
    canonical_remote_channel, remote_agent_channel, remote_event_params_for_clients,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_CONTEXTS: usize = 8;
const BINDING: &str = "profile-client";
const TARGET_UNAVAILABLE: &str = "Profile unavailable. Check its connection in BAT.";

pub type ContextSink = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Default)]
struct Interests {
    sessions: HashSet<String>,
    ptys: HashSet<String>,
}

pub struct ProfileContext {
    pub id: String,
    profile: ProfileEntry,
    target_profile: String,
    client: Option<RustRemoteClientState>,
    connect_lock: Mutex<()>,
    interests: Arc<Mutex<Interests>>,
    closed: Arc<AtomicBool>,
    sink: ContextSink,
}

impl Drop for ProfileContext {
    fn drop(&mut self) {
        self.close();
    }
}

fn same_target(a: &ProfileEntry, b: &ProfileEntry) -> bool {
    a.id == b.id
        && a.kind == b.kind
        && a.remote_host == b.remote_host
        && a.remote_port == b.remote_port
        && a.remote_token == b.remote_token
        && a.remote_fingerprint == b.remote_fingerprint
        && a.remote_profile_id == b.remote_profile_id
        && a.ssh_target == b.ssh_target
}

fn dial_endpoint(
    profile: &ProfileEntry,
    tunnel: impl FnOnce() -> RemoteTunnelEndpoint,
) -> Result<(String, u16), String> {
    if profile
        .ssh_target
        .as_deref()
        .and_then(normalize_ssh_target)
        .is_some()
    {
        let endpoint = tunnel();
        if !endpoint.ready || !endpoint.tunneled || endpoint.port == 0 {
            // SSH diagnostics stay on the host, not in the client wire contract.
            return Err(TARGET_UNAVAILABLE.into());
        }
        return Ok((endpoint.host, endpoint.port));
    }
    Ok((
        profile.remote_host.clone().ok_or(TARGET_UNAVAILABLE)?,
        u16::try_from(profile.remote_port.unwrap_or(9876)).map_err(|_| TARGET_UNAVAILABLE)?,
    ))
}

fn scoped_event(
    id: &str,
    alias: &str,
    target: &str,
    interests: &Mutex<Interests>,
    channel: &str,
    mut params: Value,
) -> Option<Value> {
    let channel = canonical_remote_channel(channel);
    if channel == "profile:changed" {
        let exists = params
            .get("profiles")
            .and_then(Value::as_array)
            .map(|profiles| {
                profiles
                    .iter()
                    .any(|p| p["id"] == target && p["type"] != "remote")
            })?;
        return Some(if exists {
            json!({"type":"event", "channel":"workspace:reload", "contextId":id,
                "params":{"profileId":alias,"refresh":true}})
        } else {
            json!({"type":"event", "channel":"profile:status", "contextId":id,
                "params":{"status":"unavailable"}})
        });
    }
    if channel == "workspace:reload" {
        if params
            .get("profileId")
            .and_then(Value::as_str)
            .is_some_and(|p| p != target)
        {
            return None;
        }
        // Unstamped legacy reloads cannot be trusted to belong to this profile.
        if params.get("profileId").is_none() {
            params = json!({"profileId":alias, "refresh":true});
        } else {
            params["profileId"] = json!(alias);
        }
    } else if matches!(
        channel.as_str(),
        "agent:usage"
            | "claude:account-changed"
            | "fs:changed"
            | "runtime:changed"
            | "system:resume"
    ) {
        // These events belong to the execution host, not an individual session.
    } else if channel.starts_with("claude:") || channel.starts_with("pty:") {
        let interests = interests.lock().ok()?;
        let matches = if channel.starts_with("claude:") {
            params
                .get("sessionId")
                .and_then(Value::as_str)
                .is_some_and(|id| interests.sessions.contains(id))
        } else {
            params
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| interests.ptys.contains(id))
        };
        if !matches {
            return None;
        }
    } else if channel != "profile:status" {
        return None;
    }
    let params = remote_event_params_for_clients(&channel, &params);
    Some(
        json!({"type":"event", "channel":remote_agent_channel(&channel),
        "contextId":id, "params":params}),
    )
}

impl ProfileContext {
    fn new(profile: ProfileEntry, sink: ContextSink) -> Self {
        let id = format!("pc-{:032x}", rand::random::<u128>());
        let target_profile = if profile.kind == "remote" {
            profile
                .remote_profile_id
                .clone()
                .filter(|p| !p.is_empty())
                .unwrap_or("default".into())
        } else {
            profile.id.clone()
        };
        let interests = Arc::new(Mutex::new(Interests::default()));
        let closed = Arc::new(AtomicBool::new(false));
        let client = if profile.kind == "remote" {
            let (id, alias, target, interests, closed, sink) = (
                id.clone(),
                profile.id.clone(),
                target_profile.clone(),
                interests.clone(),
                closed.clone(),
                sink.clone(),
            );
            let events: RemoteEventSink = Arc::new(move |channel, params| {
                if closed.load(Ordering::Acquire) {
                    return;
                }
                if let Some(frame) = scoped_event(&id, &alias, &target, &interests, channel, params)
                {
                    if channel == "profile:changed" && frame["params"]["status"] == "unavailable" {
                        closed.store(true, Ordering::Release);
                    }
                    sink(frame);
                }
            });
            Some(RustRemoteClientState::with_event_sink(events))
        } else {
            None
        };
        Self {
            id,
            profile,
            target_profile,
            client,
            connect_lock: Mutex::new(()),
            interests,
            closed,
            sink,
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(client) = &self.client {
            client.disconnect(BINDING);
        }
    }

    pub fn validate(&self, ctx: &HostContext) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("Profile context closed".into());
        }
        if !profile_entry_for_context(ctx, &self.profile.id)
            .is_some_and(|p| same_target(&p, &self.profile))
        {
            self.close();
            return Err("Profile changed or was removed. Select it again.".into());
        }
        Ok(())
    }

    fn ensure_connected(&self, ctx: &HostContext) -> Result<(), String> {
        self.validate(ctx)?;
        let Some(client) = &self.client else {
            return Ok(());
        };
        let _guard = self.connect_lock.lock().map_err(|_| TARGET_UNAVAILABLE)?;
        if client.status(BINDING)["connected"] == true {
            return Ok(());
        }
        let p = &self.profile;
        let (host, port) = dial_endpoint(p, || {
            ensure_context_tunnel(
                ctx,
                &self.id,
                &self.closed,
                &RemoteTunnelSpec {
                    profile_id: Some(p.id.clone()),
                    ssh_target: None,
                    remote_host: None,
                    remote_port: None,
                },
            )
        })?;
        // Tunnel setup can block; do not dial after a close or profile edit.
        self.validate(ctx)?;
        let result = client
            .connect(
                ctx.clone(),
                host,
                port,
                p.remote_token.clone().ok_or(TARGET_UNAVAILABLE)?,
                p.remote_fingerprint.clone().ok_or(TARGET_UNAVAILABLE)?,
                Some("BAT Profile".into()),
                Some(BINDING.into()),
            )
            .map_err(|_| TARGET_UNAVAILABLE)?;
        if result["protocol"] != "bat-remote/v2" {
            client.disconnect(BINDING);
            return Err("Profile requires an updated BAT host".into());
        }
        let profiles = client
            .invoke(BINDING, "profile:list", vec![], Duration::from_secs(15))
            .map_err(|_| TARGET_UNAVAILABLE)?;
        if !profiles["profiles"].as_array().is_some_and(|ps| {
            ps.iter()
                .any(|p| p["id"] == self.target_profile && p["type"] != "remote")
        }) {
            client.disconnect(BINDING);
            return Err("Target profile unavailable or unsupported".into());
        }
        if self.closed.load(Ordering::Acquire) {
            client.disconnect(BINDING);
            return Err("Profile context closed".into());
        }
        Ok(())
    }

    pub fn info(&self) -> Value {
        let ready = !self.closed.load(Ordering::Acquire)
            && self
                .client
                .as_ref()
                .map(|c| c.status(BINDING)["connected"] == true)
                .unwrap_or(true);
        // Stable opaque identity lets a client reject caches after alias retargeting.
        let mut key = format!(
            "{}|{}|{}|{}|{}",
            self.profile.id,
            self.profile
                .remote_fingerprint
                .as_deref()
                .unwrap_or("local"),
            self.profile.remote_host.as_deref().unwrap_or(""),
            self.profile.remote_port.unwrap_or(9876),
            self.target_profile
        );
        // Keep existing direct-profile cache identities; distinguish SSH hosts
        // that share the same remote loopback address and target profile.
        if let Some(target) = &self.profile.ssh_target {
            key.push_str(&format!("|ssh:{target}"));
        }
        let binding_key = format!("{:x}", Sha256::digest(key.as_bytes()));
        json!({"contextId":self.id, "profileId":self.profile.id, "name":self.profile.name,
            "bindingKey":binding_key, "status":if ready { "ready" } else { "unavailable" }})
    }

    pub fn prepare(
        &self,
        ctx: &HostContext,
        channel: &str,
        mut params: Value,
    ) -> Result<Value, String> {
        self.ensure_connected(ctx)?;
        if channel.starts_with("profile:") || channel.starts_with("app:") {
            return Err("Operation is not available in a profile context".into());
        }
        if !params.is_object() {
            params = json!({});
        }
        if channel == "workspace:load" || channel == "workspace:save" {
            if let Some(requested) = params.get("profileId").and_then(Value::as_str) {
                if requested != self.profile.id {
                    return Err("Profile context mismatch".into());
                }
            }
            params["profileId"] = json!(self.target_profile);
            params.as_object_mut().unwrap().remove("windowId");
        }
        let mut interests = self
            .interests
            .lock()
            .map_err(|_| "Profile subscription unavailable")?;
        if let Some(id) = params.get("sessionId").and_then(Value::as_str) {
            interests.sessions.insert(id.into());
        }
        if channel.starts_with("pty:") {
            if let Some(id) = params
                .get("id")
                .or_else(|| params.get("options").and_then(|v| v.get("id")))
                .and_then(Value::as_str)
            {
                interests.ptys.insert(id.into());
            }
        }
        Ok(params)
    }

    pub fn invoke_remote(
        &self,
        channel: &str,
        params: Value,
        timeout: Duration,
    ) -> Option<Result<Value, String>> {
        self.client
            .as_ref()
            .map(|client| client.invoke_params(BINDING, channel, vec![], Some(params), timeout))
    }

    pub fn observe_result(&self, channel: &str, result: &Value) {
        if channel == "workspace:load" {
            let parsed = result
                .as_str()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
            let state = parsed.as_ref().unwrap_or(result);
            if let Some(terminals) = state.get("terminals").and_then(Value::as_array) {
                if let Ok(mut interests) = self.interests.lock() {
                    for terminal in terminals {
                        if let Some(id) = terminal.get("id").and_then(Value::as_str) {
                            interests.sessions.insert(id.into());
                            interests.ptys.insert(id.into());
                        }
                    }
                }
            }
        } else if channel == "pty:create" {
            if let Some(id) = result.as_str() {
                if let Ok(mut interests) = self.interests.lock() {
                    interests.ptys.insert(id.into());
                }
            }
        }
    }

    pub fn local_event(&self, channel: &str, params: &Value) {
        if self.client.is_some() || self.closed.load(Ordering::Acquire) {
            return;
        }
        if let Some(frame) = scoped_event(
            &self.id,
            &self.profile.id,
            &self.target_profile,
            &self.interests,
            channel,
            params.clone(),
        ) {
            (self.sink)(frame);
        }
    }
}

#[derive(Default)]
pub struct ProfileContexts {
    contexts: Mutex<HashMap<String, Arc<ProfileContext>>>,
    closed: AtomicBool,
}

impl std::fmt::Debug for ProfileContexts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileContexts").finish_non_exhaustive()
    }
}

impl ProfileContexts {
    pub fn has_contexts(&self) -> bool {
        self.contexts
            .lock()
            .map(|contexts| !contexts.is_empty())
            .unwrap_or(false)
    }

    pub fn open(
        &self,
        ctx: &HostContext,
        profile_id: &str,
        sink: ContextSink,
    ) -> Result<Value, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("Connection closed".into());
        }
        let profile = profile_entry_for_context(ctx, profile_id).ok_or("Profile not found")?;
        let context = Arc::new(ProfileContext::new(profile, sink));
        {
            let mut contexts = self
                .contexts
                .lock()
                .map_err(|_| "Profile contexts unavailable")?;
            if self.closed.load(Ordering::Acquire) {
                return Err("Connection closed".into());
            }
            if contexts.len() >= MAX_CONTEXTS {
                return Err("Too many open profiles".into());
            }
            contexts.insert(context.id.clone(), context.clone());
        }
        if let Err(error) = context.ensure_connected(ctx) {
            self.close(&context.id);
            return Err(error);
        }
        Ok(context.info())
    }

    pub fn get(&self, id: &str) -> Result<Arc<ProfileContext>, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("Connection closed".into());
        }
        self.contexts
            .lock()
            .map_err(|_| "Profile contexts unavailable")?
            .get(id)
            .cloned()
            .ok_or("Unknown profile context".into())
    }

    pub fn close(&self, id: &str) {
        if let Ok(mut contexts) = self.contexts.lock() {
            if let Some(context) = contexts.remove(id) {
                context.close();
            }
        }
    }

    pub fn close_all(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut contexts) = self.contexts.lock() {
            for (_, context) in contexts.drain() {
                context.close();
            }
        }
    }

    pub fn local_event(&self, channel: &str, params: &Value) {
        if let Ok(contexts) = self.contexts.lock() {
            for context in contexts.values() {
                context.local_event(channel, params);
            }
        }
    }
}

pub struct ConnectionContextGuard(pub Arc<ProfileContexts>);
impl Drop for ConnectionContextGuard {
    fn drop(&mut self) {
        self.0.close_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote_profile() -> ProfileEntry {
        serde_json::from_value(json!({
            "id":"ap01", "name":"ap01", "type":"remote",
            "remoteHost":"127.0.0.1", "remotePort":9876,
            "remoteToken":"test-only-secret", "remoteFingerprint":"test-fingerprint",
            "remoteProfileId":"default", "sshTarget":"user@ap01",
            "createdAt":0, "updatedAt":0
        }))
        .unwrap()
    }

    fn tunnel_endpoint(ready: bool) -> RemoteTunnelEndpoint {
        RemoteTunnelEndpoint {
            ready,
            tunneled: true,
            host: "127.0.0.1".into(),
            port: 58276,
            spawned: false,
            error: None,
            output: None,
        }
    }

    #[test]
    fn ssh_profile_dials_forwarded_port_not_remote_loopback() {
        let profile = remote_profile();
        assert_eq!(
            dial_endpoint(&profile, || tunnel_endpoint(true)).unwrap(),
            ("127.0.0.1".into(), 58276)
        );
        assert_eq!(profile.remote_port, Some(9876));
        assert_eq!(
            profile.remote_fingerprint.as_deref(),
            Some("test-fingerprint")
        );
    }

    #[test]
    fn failed_tunnel_never_falls_back_to_entry_host_loopback() {
        let error = dial_endpoint(&remote_profile(), || {
            let mut endpoint = tunnel_endpoint(false);
            endpoint.output = Some("private SSH diagnostics".into());
            endpoint
        })
        .unwrap_err();
        assert_eq!(error, TARGET_UNAVAILABLE);
    }

    #[test]
    fn direct_profile_does_not_require_a_tunnel_manager() {
        let mut profile = remote_profile();
        profile.ssh_target = None;
        assert_eq!(
            dial_endpoint(&profile, || panic!("must not spawn SSH")).unwrap(),
            ("127.0.0.1".into(), 9876)
        );
    }

    #[test]
    fn ssh_edits_invalidate_context_and_mobile_cache_identity() {
        let profile = remote_profile();
        let mut changed = profile.clone();
        changed.ssh_target = Some("user@another-host".into());
        assert!(!same_target(&profile, &changed));
        let original = ProfileContext::new(profile, Arc::new(|_| {}));
        let updated = ProfileContext::new(changed, Arc::new(|_| {}));
        assert_ne!(original.info()["bindingKey"], updated.info()["bindingKey"]);
        assert!(!original.info().to_string().contains("test-only-secret"));
    }

    #[test]
    fn context_ids_are_connection_owned() {
        assert!(ProfileContexts::default()
            .get("another-clients-context")
            .is_err());
    }

    #[test]
    fn workspace_events_are_filtered_and_alias_is_restored() {
        let interests = Mutex::new(Interests::default());
        assert!(scoped_event(
            "ctx",
            "alias",
            "target",
            &interests,
            "workspace:reload",
            json!({"profileId":"other", "data":"{}"})
        )
        .is_none());
        let frame = scoped_event(
            "ctx",
            "alias",
            "target",
            &interests,
            "workspace:reload",
            json!({"profileId":"target", "data":"{}"}),
        )
        .unwrap();
        assert_eq!(frame["params"]["profileId"], "alias");
        assert_eq!(frame["contextId"], "ctx");
    }

    #[test]
    fn only_subscribed_resources_are_delivered() {
        let mut interests = Interests::default();
        interests.sessions.insert("session-a".into());
        let interests = Mutex::new(interests);
        assert!(scoped_event(
            "ctx",
            "a",
            "b",
            &interests,
            "claude:stream",
            json!({"sessionId":"session-b"})
        )
        .is_none());
        assert!(scoped_event(
            "ctx",
            "a",
            "b",
            &interests,
            "claude:stream",
            json!({"sessionId":"session-a"})
        )
        .is_some());
    }

    #[test]
    fn downstream_catalog_never_replaces_entry_catalog() {
        let frame = scoped_event(
            "ctx",
            "alias",
            "target",
            &Mutex::new(Interests::default()),
            "profile:changed",
            json!({"profiles":[]}),
        )
        .unwrap();
        assert_eq!(frame["channel"], "profile:status");
        assert_eq!(frame["params"]["status"], "unavailable");
        assert!(frame["params"].get("profiles").is_none());
    }

    #[test]
    fn downstream_profile_updates_refresh_the_view_without_replacing_the_catalog() {
        let frame = scoped_event(
            "ctx",
            "alias",
            "target",
            &Mutex::new(Interests::default()),
            "profile:changed",
            json!({"profiles":[{"id":"target","type":"local"}]}),
        )
        .unwrap();
        assert_eq!(frame["channel"], "workspace:reload");
        assert_eq!(frame["params"]["profileId"], "alias");
        assert_eq!(frame["params"]["refresh"], true);
        assert!(frame["params"].get("profiles").is_none());
    }
}
