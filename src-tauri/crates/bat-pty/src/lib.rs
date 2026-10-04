//! PTY and worker runtimes with explicit host-owned event routing.
pub mod pty;
pub mod worker_buffer;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// Optional target window, existing event channel, and its unchanged JSON payload.
pub type PtyEventSink = Arc<dyn Fn(Option<&str>, &str, Value) + Send + Sync + 'static>;

#[derive(Clone)]
pub struct PtyContext {
    data_dir: Option<PathBuf>,
    event_sink: PtyEventSink,
}
impl PtyContext {
    pub fn new(data_dir: Option<PathBuf>, event_sink: PtyEventSink) -> Self {
        Self {
            data_dir,
            event_sink,
        }
    }
    pub(crate) fn data_dir_opt(&self) -> Option<PathBuf> {
        self.data_dir.clone()
    }
    pub(crate) fn emit(&self, window: Option<&str>, channel: &str, payload: Value) {
        (self.event_sink)(window, channel, payload);
    }
}
