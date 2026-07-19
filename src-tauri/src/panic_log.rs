use crate::log_file::append_line;
use std::any::Any;
use std::path::PathBuf;
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

static INSTALL_PANIC_LOGGER: Once = Once::new();

/// Persist Rust panics before the normal hook prints them. This is especially
/// important on Windows: a panic that crosses a non-unwinding FFI boundary is
/// converted into FAST_FAIL_FATAL_APP_EXIT (0xc0000409), and WER otherwise
/// records only the native abort offset rather than the Rust source location.
pub fn install(data_dir: PathBuf) {
    let log_path = data_dir.join("logs").join("debug.log");
    INSTALL_PANIC_LOGGER.call_once(move || {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default();
            let thread = std::thread::current();
            let thread_name = sanitize(thread.name().unwrap_or("unnamed"));
            let location = info
                .location()
                .map(|location| {
                    format!(
                        "{}:{}:{}",
                        location.file(),
                        location.line(),
                        location.column()
                    )
                })
                .unwrap_or_else(|| "unknown".into());
            let message = sanitize(panic_payload_message(info.payload()));
            let line = format!(
                "{millis} [rust-panic] thread={thread_name} location={location} message={message}\n"
            );
            let _ = append_line(&log_path, &line);
            previous_hook(info);
        }));
    });
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(message) = payload.downcast_ref::<&str>() {
        message
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.as_str()
    } else {
        "non-string panic payload"
    }
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|ch| if matches!(ch, '\r' | '\n') { ' ' } else { ch })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_log_fields_stay_on_one_line() {
        assert_eq!(sanitize("first\r\nsecond"), "first  second");
    }

    #[test]
    fn extracts_common_panic_payloads() {
        let borrowed: Box<dyn Any + Send> = Box::new("borrowed");
        let owned: Box<dyn Any + Send> = Box::new(String::from("owned"));
        assert_eq!(panic_payload_message(borrowed.as_ref()), "borrowed");
        assert_eq!(panic_payload_message(owned.as_ref()), "owned");
    }
}
