//! Bounded, read-only agent replay. The epoch changes on host restart and every
//! eviction advances a floor: a gap can never be silently reported as complete.
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

pub const RETENTION_MS: u64 = 10 * 60 * 1000;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_EVENTS: usize = 20_000;
const MAX_SESSIONS: usize = 512;
const MAX_REPLY_BYTES: usize = 512 * 1024;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct Event {
    session: String,
    seq: u64,
    at: u64,
    bytes: usize,
    value: Value,
}
struct Session {
    generation: String,
    head: u64,
    floor: u64,
    touched: u64,
}
impl Default for Session {
    fn default() -> Self {
        Self {
            generation: format!("{:032x}", rand::random::<u128>()),
            head: 0,
            floor: 0,
            touched: 0,
        }
    }
}

pub struct SessionReplay {
    epoch: String,
    events: VecDeque<Event>,
    sessions: HashMap<String, Session>,
    bytes: usize,
}
impl Default for SessionReplay {
    fn default() -> Self {
        Self {
            epoch: format!("{:032x}", rand::random::<u128>()),
            events: VecDeque::new(),
            sessions: HashMap::new(),
            bytes: 0,
        }
    }
}
impl SessionReplay {
    fn ensure_session(&mut self, id: &str) {
        if !self.sessions.contains_key(id) && self.sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, value)| value.touched)
                .map(|(key, _)| key.clone())
            {
                self.sessions.remove(&oldest);
                self.events.retain(|event| event.session != oldest);
                self.bytes = self.events.iter().map(|event| event.bytes).sum();
            }
        }
    }
    fn trim(&mut self, now: u64) {
        while self
            .events
            .front()
            .is_some_and(|event| now.saturating_sub(event.at) > RETENTION_MS)
            || self.bytes > MAX_BYTES
            || self.events.len() > MAX_EVENTS
        {
            let Some(event) = self.events.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(event.bytes);
            if let Some(session) = self.sessions.get_mut(&event.session) {
                session.floor = session.floor.max(event.seq);
            }
        }
    }
    pub fn record(&mut self, channel: &str, params: &Value, now: u64) -> Option<Value> {
        if !channel.starts_with("claude:") || channel == "claude:sync-event" {
            return None;
        }
        let id = params.get("sessionId").and_then(Value::as_str)?;
        self.ensure_session(id);
        let session = self.sessions.entry(id.into()).or_default();
        session.head += 1;
        session.touched = now;
        let seq = session.head;
        let mut value = json!({"seq":seq,"at":now,"channel":channel,"params":params});
        let bytes = value.to_string().len();
        // Large history frames are deliberately not retained. Their sequence
        // still advances the floor so reconnect falls back to a snapshot.
        if bytes > MAX_REPLY_BYTES {
            session.floor = seq;
            // Full history still travels through the existing idempotent
            // history channel. Do not duplicate a multi-megabyte transcript
            // into a live replay wrapper / event buffer too.
            if channel == "claude:history" {
                value = json!({"seq":seq,"at":now,"channel":"claude:history-checkpoint","params":{"sessionId":id}});
            }
        } else {
            self.bytes += bytes;
            self.events.push_back(Event {
                session: id.into(),
                seq,
                at: now,
                bytes,
                value: value.clone(),
            });
        }
        self.trim(now);
        Some(json!({"sessionId":id,"epoch":self.cursor(id, now)["epoch"],"events":[value]}))
    }
    pub fn cursor(&mut self, id: &str, now: u64) -> Value {
        self.trim(now);
        self.ensure_session(id);
        let session = self.sessions.entry(id.into()).or_default();
        session.touched = now;
        json!({"epoch":format!("{}-{}",self.epoch,session.generation),"seq":session.head})
    }
    pub fn read(&mut self, id: &str, cursor: &Value, now: u64) -> Value {
        self.trim(now);
        let Some(session) = self.sessions.get(id) else {
            return json!({"mode":"snapshot","reason":"unknown-session"});
        };
        let after = cursor.get("seq").and_then(Value::as_u64);
        let epoch = format!("{}-{}", self.epoch, session.generation);
        if cursor["epoch"] != epoch
            || after.is_none_or(|seq| seq < session.floor || seq > session.head)
        {
            return json!({"mode":"snapshot","reason":"expired-or-restarted"});
        }
        let mut events = Vec::new();
        let mut bytes = 0;
        let mut seq = after.unwrap();
        for event in self
            .events
            .iter()
            .filter(|event| event.session == id && event.seq > after.unwrap())
        {
            if bytes + event.bytes > MAX_REPLY_BYTES && !events.is_empty() {
                break;
            }
            bytes += event.bytes;
            seq = event.seq;
            events.push(event.value.clone());
        }
        json!({"mode":"delta","sessionId":id,"events":events,"cursor":{"epoch":epoch,"seq":seq},"hasMore":seq < session.head})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replays_in_order_without_crossing_sessions() {
        let mut journal = SessionReplay::default();
        let cursor = journal.cursor("a", 0);
        journal.record(
            "claude:stream",
            &json!({"sessionId":"a","data":{"text":"one"}}),
            1,
        );
        journal.record(
            "claude:stream",
            &json!({"sessionId":"b","data":{"text":"private"}}),
            2,
        );
        journal.record("claude:turn-end", &json!({"sessionId":"a"}), 3);
        let result = journal.read("a", &cursor, 4);
        assert_eq!(result["mode"], "delta");
        assert_eq!(result["events"].as_array().unwrap().len(), 2);
        assert_eq!(result["cursor"]["seq"], 2);
        assert!(!result.to_string().contains("private"));
        assert_eq!(journal.read("a", &result["cursor"], 5)["events"], json!([]));
    }
    #[test]
    fn expiry_restart_and_oversized_history_require_snapshot() {
        let mut journal = SessionReplay::default();
        let cursor = journal.cursor("a", 0);
        journal.record("claude:message", &json!({"sessionId":"a","message":{}}), 1);
        assert_eq!(
            journal.read("a", &cursor, RETENTION_MS + 2)["mode"],
            "snapshot"
        );
        assert_eq!(
            SessionReplay::default().read("a", &cursor, 2)["mode"],
            "snapshot"
        );
        let cursor = journal.cursor("a", RETENTION_MS + 3);
        let live = journal
            .record(
                "claude:history",
                &json!({"sessionId":"a","items":["x".repeat(MAX_REPLY_BYTES)]}),
                RETENTION_MS + 4,
            )
            .unwrap();
        assert!(live.to_string().len() < 1024);
        assert_eq!(
            journal.read("a", &cursor, RETENTION_MS + 5)["mode"],
            "snapshot"
        );
    }
    #[test]
    fn session_and_event_memory_are_bounded() {
        let mut journal = SessionReplay::default();
        for index in 0..MAX_SESSIONS + 10 {
            journal.record(
                "claude:status",
                &json!({"sessionId":index.to_string(),"meta":{}}),
                index as u64,
            );
        }
        assert_eq!(journal.sessions.len(), MAX_SESSIONS);
        assert!(journal.events.len() <= MAX_SESSIONS);
        assert!(journal.bytes <= MAX_BYTES);
    }

    #[test]
    fn pagination_and_memory_eviction_never_silently_skip_text() {
        let mut journal = SessionReplay::default();
        let cursor = journal.cursor("a", 0);
        for index in 1..4 {
            journal.record(
                "claude:stream",
                &json!({"sessionId":"a","data":{"text":"x".repeat(200_000)}}),
                index,
            );
        }
        let page = journal.read("a", &cursor, 4);
        assert_eq!(page["events"].as_array().unwrap().len(), 2);
        assert_eq!(page["hasMore"], true);
        let next = journal.read("a", &page["cursor"], 5);
        assert_eq!(next["events"][0]["seq"], 3);
        assert_eq!(next["hasMore"], false);
        for index in 4..100 {
            journal.record(
                "claude:stream",
                &json!({"sessionId":"a","data":{"text":"x".repeat(200_000)}}),
                index,
            );
        }
        assert!(journal.bytes <= MAX_BYTES);
        assert_eq!(journal.read("a", &cursor, 101)["mode"], "snapshot");
    }

    #[test]
    fn evicted_session_id_gets_a_new_epoch_even_if_sequence_matches() {
        let mut journal = SessionReplay::default();
        let old = journal.cursor("a", 0);
        for index in 1..=MAX_SESSIONS {
            journal.cursor(&index.to_string(), index as u64);
        }
        let new = journal.cursor("a", MAX_SESSIONS as u64 + 1);
        assert_ne!(old["epoch"], new["epoch"]);
        assert_eq!(
            journal.read("a", &old, MAX_SESSIONS as u64 + 2)["mode"],
            "snapshot"
        );
        assert_eq!(journal.sessions.len(), MAX_SESSIONS);
    }
}
