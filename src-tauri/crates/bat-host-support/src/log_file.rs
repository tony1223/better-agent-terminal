use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

const DEFAULT_MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Queue a line for the log at `path`.
///
/// Hot paths call this per event — under `BAT_DEBUG` every PTY keystroke logs
/// two lines. Appending inline costs create_dir_all + metadata + open + write +
/// close *per line*, which on Windows also drags the AV filter driver through
/// every open. Instead a per-file writer thread keeps the handle open and
/// coalesces whatever is already queued into a single write, so a burst of
/// typing costs one write rather than one per keystroke.
pub fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    let Ok(sender) = writer_for(path) else {
        return append_line_blocking(path, line);
    };
    if sender.send(line.to_string()).is_err() {
        // The writer thread gave up (it could not reopen after rotating). Drop
        // it so the next call respawns one, and still land this line inline.
        forget_writer(path);
        return append_line_blocking(path, line);
    }
    Ok(())
}

/// Append synchronously, for callers that cannot outlive the write: the panic
/// hook has to reach disk before the process goes down.
pub fn append_line_blocking(path: &Path, line: &str) -> std::io::Result<()> {
    append_line_with_limit(path, line, DEFAULT_MAX_LOG_BYTES)
}

fn append_line_with_limit(path: &Path, line: &str, max_bytes: u64) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    rotate_if_large(path, max_bytes)?;
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())
}

fn writers() -> &'static Mutex<HashMap<PathBuf, Sender<String>>> {
    static WRITERS: OnceLock<Mutex<HashMap<PathBuf, Sender<String>>>> = OnceLock::new();
    WRITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn writer_for(path: &Path) -> std::io::Result<Sender<String>> {
    let mut writers = writers().lock().unwrap_or_else(|err| err.into_inner());
    if let Some(sender) = writers.get(path) {
        return Ok(sender.clone());
    }
    let sender = spawn_writer(path.to_path_buf())?;
    writers.insert(path.to_path_buf(), sender.clone());
    Ok(sender)
}

fn forget_writer(path: &Path) {
    let mut writers = writers().lock().unwrap_or_else(|err| err.into_inner());
    writers.remove(path);
}

fn spawn_writer(path: PathBuf) -> std::io::Result<Sender<String>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = open_log(&path)?;
    let mut written = current_len(&path);
    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut batch = first;
            while let Ok(next) = receiver.try_recv() {
                batch.push_str(&next);
            }
            let len = batch.len() as u64;
            if written.saturating_add(len) > DEFAULT_MAX_LOG_BYTES {
                let Ok((reopened, size)) = rotate(&path, file, len) else {
                    return;
                };
                file = reopened;
                written = size;
            }
            if file.write_all(batch.as_bytes()).is_err() {
                return;
            }
            // Flush per batch, not per line: the channel is drained as fast as
            // it fills, so a crash loses microseconds of log, not seconds.
            let _ = file.flush();
            written = written.saturating_add(len);
        }
    });
    Ok(sender)
}

/// Rotate when the file really is oversized, returning the handle to keep
/// writing through and the byte count now in it.
///
/// `written` is tracked in memory, so re-stat first — a second process
/// appending to the same log would otherwise make us rotate early.
fn rotate(path: &Path, file: File, incoming: u64) -> std::io::Result<(File, u64)> {
    let actual = current_len(path);
    if actual.saturating_add(incoming) <= DEFAULT_MAX_LOG_BYTES {
        return Ok((file, actual));
    }
    // Windows refuses to rename a file that still has an open handle.
    drop(file);
    let previous = previous_log_path(path);
    let _ = fs::remove_file(&previous);
    let rotated = fs::rename(path, &previous).is_ok();
    let reopened = open_log(path)?;
    Ok((reopened, if rotated { 0 } else { current_len(path) }))
}

fn open_log(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

fn current_len(path: &Path) -> u64 {
    fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0)
}

fn rotate_if_large(path: &Path, max_bytes: u64) -> std::io::Result<()> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() <= max_bytes {
        return Ok(());
    }
    let previous = previous_log_path(path);
    let _ = fs::remove_file(&previous);
    fs::rename(path, previous)
}

fn previous_log_path(path: &Path) -> PathBuf {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return path.with_file_name("log.prev");
    };
    if let Some(stem) = file_name.strip_suffix(".log") {
        path.with_file_name(format!("{stem}.prev.log"))
    } else {
        path.with_file_name(format!("{file_name}.prev"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_until(path: &Path, expected: &str) -> String {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let actual = fs::read_to_string(path).unwrap_or_default();
            if actual == expected || std::time::Instant::now() >= deadline {
                return actual;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn appends_log_lines() {
        let path =
            std::env::temp_dir().join(format!("bat-log-file-{}-append.log", std::process::id()));
        let _ = fs::remove_file(&path);

        append_line_with_limit(&path, "one\n", 1024).unwrap();
        append_line_with_limit(&path, "two\n", 1024).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rotates_oversized_log_before_append() {
        let path =
            std::env::temp_dir().join(format!("bat-log-file-{}-rotate.log", std::process::id()));
        let previous = previous_log_path(&path);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&previous);
        fs::write(&path, "123456").unwrap();

        append_line_with_limit(&path, "new\n", 5).unwrap();

        assert_eq!(fs::read_to_string(&previous).unwrap(), "123456");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(previous);
    }

    #[test]
    fn queued_lines_reach_disk_in_order() {
        let path =
            std::env::temp_dir().join(format!("bat-log-file-{}-queued.log", std::process::id()));
        let _ = fs::remove_file(&path);

        // Far more lines than a burst of typing produces, sent back to back so
        // the writer thread has to coalesce them.
        for index in 0..500 {
            append_line(&path, &format!("line{index}\n")).unwrap();
        }

        let expected: String = (0..500).map(|index| format!("line{index}\n")).collect();
        assert_eq!(read_until(&path, &expected), expected);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn previous_log_path_inserts_prev_before_log_extension() {
        let path = PathBuf::from("debug.log");
        assert_eq!(previous_log_path(&path), PathBuf::from("debug.prev.log"));
    }
}
