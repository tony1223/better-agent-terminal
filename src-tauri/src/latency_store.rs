//! Storage for server-side response-time samples.
//!
//! The sidecar emits one `agent:latency-sample` per completed turn and one per
//! compaction (node-sidecar/src/lib/latency-sample.mjs). This module is the only
//! thing that writes them down, and the only thing that reads them back.
//!
//! **Shape:** one JSON object per line in `<data-dir>/metrics/latency-<UTC day>.jsonl`.
//! Line-delimited because appending is the only write we ever do, and a corrupt
//! or truncated tail costs exactly one sample. Sharded per day because the
//! retention rule ("keep 60 days") then reduces to deleting whole files — no
//! rewriting a single growing file under a lock, which is the operation that
//! tends to lose data when it is interrupted.
//!
//! **Timezone:** files are sharded by UTC day, records store UTC epoch millis,
//! and nothing here knows about local time. The question being asked — "is the
//! API slower at 3pm?" — is about the *local* clock, so the hour bucketing is
//! the renderer's job, where the machine's real offset and DST are already
//! handled. A UTC shard is just a filing cabinet, deliberately not the
//! statistics unit; readers get a widened file range and filter by `at`.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use crate::sidecar::EventSink;

/// The one channel this module cares about. The sidecar picks the name; the tap
/// below matches it exactly rather than by prefix, so no future `agent:*` event
/// starts silently landing in the metrics directory.
pub const LATENCY_SAMPLE_CHANNEL: &str = "agent:latency-sample";

/// How many days of samples to keep. Days, not bytes: the promise made to the
/// user is about how far back the data goes, and a byte cap would quietly make
/// that promise depend on how busy they were.
pub const RETENTION_DAYS: i64 = 60;

const MILLIS_PER_DAY: i64 = 86_400_000;
const FILE_PREFIX: &str = "latency-";
const FILE_SUFFIX: &str = ".jsonl";

fn metrics_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("metrics")
}

fn day_file(data_dir: &Path, day: &str) -> PathBuf {
    metrics_dir(data_dir).join(format!("{FILE_PREFIX}{day}{FILE_SUFFIX}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Whole days since the epoch. `div_euclid`, not `/`: a pre-1970 timestamp
/// (a clock that has not been set yet, which does happen on fresh VMs) must
/// floor rather than truncate towards zero, or two different days collapse
/// onto day 0.
fn day_index(ms: i64) -> i64 {
    ms.div_euclid(MILLIS_PER_DAY)
}

/// `YYYY-MM-DD` for a day index. Hinnant's civil-from-days, the inverse of
/// `days_from_civil` in codex_app_server.rs — proleptic Gregorian, exact for
/// every date we can reach, and no date crate in the dependency tree.
fn civil_from_days(day: i64) -> (i64, u32, u32) {
    let z = day + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day_of_month = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    (year + i64::from(month <= 2), month, day_of_month)
}

fn day_label(day: i64) -> String {
    let (year, month, day_of_month) = civil_from_days(day);
    format!("{year:04}-{month:02}-{day_of_month:02}")
}

/// Appends samples and prunes expired day files. One per host; the desktop and
/// headless sinks each build exactly one.
pub struct LatencyStore {
    data_dir: PathBuf,
    /// The day label most recently written. Rolling over to a new one is the
    /// cue to prune — see `append`.
    last_day: Mutex<Option<String>>,
}

impl LatencyStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            last_day: Mutex::new(None),
        }
    }

    /// Record one sample. Errors are swallowed on purpose: this sits on the
    /// sidecar's event path, and a full disk or a locked file must not take down
    /// agent output. Statistics are the feature that can afford to lose a row.
    pub fn append(&self, sample: &Value) {
        let at = sample.get("at").and_then(Value::as_i64).unwrap_or_else(now_ms);
        let day = day_label(day_index(at));

        // Pruning rides on the day rollover rather than a timer thread: the only
        // moment a file can newly fall outside the window is when a later day
        // exists, and that is exactly when this fires. First write after launch
        // also counts as a rollover, so a restart always sweeps.
        let rolled = match self.last_day.lock() {
            Ok(mut last) => {
                let rolled = last.as_deref() != Some(day.as_str());
                if rolled {
                    *last = Some(day.clone());
                }
                rolled
            }
            // Poisoned only if a previous append panicked. Prune anyway — worst
            // case is one redundant directory scan.
            Err(_) => true,
        };

        let mut line = match serde_json::to_string(sample) {
            Ok(line) => line,
            Err(_) => return,
        };
        line.push('\n');
        let _ = append_line(&day_file(&self.data_dir, &day), &line);

        if rolled {
            prune(&metrics_dir(&self.data_dir), day_index(at), RETENTION_DAYS);
        }
    }
}

/// Open, append, close, per sample.
///
/// Deliberately not `log_file::append_line`, which is built for per-keystroke
/// traffic and rotates at 5MB into a `.prev` sibling. Rotation is wrong here:
/// a `latency-<day>.prev.jsonl` is a second file for the same day that readers
/// do not look at, so hitting the cap would silently halve a day's history
/// instead of failing visibly. Samples arrive once per turn, so the per-line
/// open costs nothing worth optimising away.
fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new()
        .read(true)
        .create(true)
        .append(true)
        .open(path)?;
    // A process killed mid-write leaves a line with no terminator. Appending
    // straight onto it fuses the two records into one unparseable line, so the
    // interrupted sample takes the *next* one down with it. Close the torn line
    // first and the damage stays at the one record that was actually cut off.
    if ends_mid_line(&mut file)? {
        file.write_all(b"\n")?;
    }
    file.write_all(line.as_bytes())
}

fn ends_mid_line(file: &mut File) -> std::io::Result<bool> {
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(false);
    }
    let mut last = [0u8; 1];
    file.seek(SeekFrom::Start(len - 1))?;
    file.read_exact(&mut last)?;
    Ok(last[0] != b'\n')
}

/// Delete day files older than `retention_days` before `today`.
///
/// Compares the `YYYY-MM-DD` in the filename as a string: zero-padded ISO dates
/// sort lexicographically exactly as they sort chronologically, so this needs no
/// date parsing and cannot mis-parse a file someone else dropped in the
/// directory. Anything not matching the naming scheme is left alone.
fn prune(dir: &Path, today: i64, retention_days: i64) {
    let cutoff = day_label(today - retention_days + 1);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(day) = name
            .strip_prefix(FILE_PREFIX)
            .and_then(|rest| rest.strip_suffix(FILE_SUFFIX))
        else {
            continue;
        };
        if day.len() == cutoff.len() && day < cutoff.as_str() {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Every sample with `at` in `[from_ms, to_ms]`, oldest first.
///
/// Reads one file per UTC day plus a day of slack at each end, because the
/// caller's range is in local time and a local day straddles two UTC ones.
/// Unparseable lines are skipped rather than failing the read: a torn last line
/// from a hard shutdown must not hide the two months in front of it.
pub fn read_range(data_dir: &Path, from_ms: i64, to_ms: i64) -> Vec<Value> {
    if to_ms < from_ms {
        return Vec::new();
    }
    let mut samples = Vec::new();
    for day in (day_index(from_ms) - 1)..=(day_index(to_ms) + 1) {
        let Ok(text) = fs::read_to_string(day_file(data_dir, &day_label(day))) else {
            continue;
        };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(sample) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let at = sample.get("at").and_then(Value::as_i64).unwrap_or(i64::MIN);
            if at >= from_ms && at <= to_ms {
                samples.push(sample);
            }
        }
    }
    samples.sort_by_key(|sample| sample.get("at").and_then(Value::as_i64).unwrap_or(i64::MIN));
    samples
}

/// Wrap an event sink so latency samples are written to disk instead of being
/// forwarded.
///
/// Swallowed, not passed through: nothing downstream consumes this channel. The
/// renderer's statistics page reads the files through a command, and forwarding
/// would put a per-turn frame on the wire to every connected remote client that
/// none of them can do anything with. Turn completion already reaches the
/// renderer as `claude:result`, so no UI depends on seeing this.
///
/// With no data dir the samples are dropped and the sink is otherwise unchanged
/// — statistics are not worth guessing a path for.
pub fn tap_latency_samples(data_dir: Option<PathBuf>, inner: EventSink) -> EventSink {
    let store = data_dir.map(|dir| std::sync::Arc::new(LatencyStore::new(dir)));
    std::sync::Arc::new(move |channel: &str, params: &Value| {
        if channel == LATENCY_SAMPLE_CHANNEL {
            if let Some(store) = store.as_ref() {
                store.append(params);
            }
            return;
        }
        inner(channel, params);
    })
}

/// Pull path for the statistics page: every sample in a window, oldest first.
///
/// Raw records, not aggregates. The page has to show the per-sample list — the
/// honest fallback when an average over four data points looks surprising — and
/// bucketing needs the machine's local offset, which only the renderer knows.
/// Two months of samples is a few thousand rows; small enough that shipping them
/// whole beats maintaining a second, aggregated on-disk format.
pub fn latency_samples_core(data_dir: &Path, from_ms: i64, to_ms: i64) -> Value {
    Value::Array(read_range(data_dir, from_ms, to_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "bat-latency-{}-{tag}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn at(day: i64, hour: i64) -> i64 {
        day * MILLIS_PER_DAY + hour * 3_600_000
    }

    fn sample(at_ms: i64, api_ms: i64) -> Value {
        json!({ "kind": "turn", "at": at_ms, "apiMs": api_ms })
    }

    #[test]
    fn a_day_index_becomes_the_iso_date_it_names() {
        assert_eq!(day_label(0), "1970-01-01");
        assert_eq!(day_label(day_index(1_700_000_000_000)), "2023-11-14");
        // Leap day, and the day after — the case an off-by-one in
        // civil_from_days gets wrong while every other date still passes.
        assert_eq!(day_label(day_index(1_709_164_800_000)), "2024-02-29");
        assert_eq!(day_label(day_index(1_709_251_200_000)), "2024-03-01");
        // Non-leap century, the other classic off-by-one.
        assert_eq!(day_label(day_index(951_868_800_000)), "2000-03-01");
    }

    #[test]
    fn a_clock_stuck_before_the_epoch_does_not_fold_onto_one_day() {
        // A VM whose clock has not synced yet reports 1969. Truncating division
        // would file both of these as day 0.
        assert_eq!(day_label(day_index(-1)), "1969-12-31");
        assert_eq!(day_label(day_index(-MILLIS_PER_DAY - 1)), "1969-12-30");
    }

    #[test]
    fn a_sample_lands_in_the_file_for_its_own_day() {
        let dir = temp_dir("append");
        let store = LatencyStore::new(dir.clone());

        store.append(&sample(at(20_000, 3), 1_111));
        store.append(&sample(at(20_000, 21), 2_222));
        store.append(&sample(at(20_001, 4), 3_333));

        let first = fs::read_to_string(dir.join("metrics/latency-2024-10-04.jsonl")).unwrap();
        assert_eq!(first.lines().count(), 2, "both same-day samples in one file");
        assert!(first.contains("1111") && first.contains("2222"));

        let second = fs::read_to_string(dir.join("metrics/latency-2024-10-05.jsonl")).unwrap();
        assert_eq!(second.lines().count(), 1);
        assert!(second.contains("3333"));
    }

    #[test]
    fn the_retention_window_keeps_the_oldest_day_it_promises_and_drops_the_next() {
        let dir = temp_dir("prune");
        let metrics = metrics_dir(&dir);
        fs::create_dir_all(&metrics).unwrap();

        let today = 20_000;
        // Exactly at the edge: with a 60-day window, `today` counts as day 1, so
        // day-59 is the 60th and stays while day-60 is the 61st and goes.
        let kept = day_label(today - RETENTION_DAYS + 1);
        let expired = day_label(today - RETENTION_DAYS);
        let ancient = day_label(today - 400);
        for day in [&kept, &expired, &ancient] {
            fs::write(metrics.join(format!("latency-{day}.jsonl")), "{}\n").unwrap();
        }
        // Not ours; must survive untouched.
        fs::write(metrics.join("notes.txt"), "keep me").unwrap();

        prune(&metrics, today, RETENTION_DAYS);

        assert!(metrics.join(format!("latency-{kept}.jsonl")).exists(), "day 60 of 60 kept");
        assert!(!metrics.join(format!("latency-{expired}.jsonl")).exists(), "day 61 dropped");
        assert!(!metrics.join(format!("latency-{ancient}.jsonl")).exists());
        assert!(metrics.join("notes.txt").exists(), "foreign files left alone");
    }

    #[test]
    fn writing_into_a_new_day_prunes_the_one_that_just_expired() {
        let dir = temp_dir("rollover");
        let metrics = metrics_dir(&dir);
        fs::create_dir_all(&metrics).unwrap();
        let today = 20_000;
        let expired = day_label(today - RETENTION_DAYS);
        fs::write(metrics.join(format!("latency-{expired}.jsonl")), "{}\n").unwrap();

        LatencyStore::new(dir.clone()).append(&sample(at(today, 12), 500));

        assert!(
            !metrics.join(format!("latency-{expired}.jsonl")).exists(),
            "the append should have swept the expired day"
        );
    }

    #[test]
    fn a_range_read_spans_day_files_and_excludes_what_falls_outside() {
        let dir = temp_dir("read");
        let store = LatencyStore::new(dir.clone());
        store.append(&sample(at(20_000, 22), 100)); // before the range
        store.append(&sample(at(20_001, 2), 200)); // inside, earlier day file
        store.append(&sample(at(20_001, 23), 300)); // inside
        store.append(&sample(at(20_002, 5), 400)); // after the range

        let samples = read_range(&dir, at(20_001, 0), at(20_002, 0));

        let api: Vec<i64> = samples
            .iter()
            .map(|s| s.get("apiMs").and_then(Value::as_i64).unwrap())
            .collect();
        assert_eq!(api, vec![200, 300]);
    }

    // The reader's whole reason for widening by a day: a caller in UTC+13 asking
    // for "today, local" hands us a window that starts in yesterday's UTC file.
    #[test]
    fn a_local_day_that_straddles_utc_midnight_is_read_whole() {
        let dir = temp_dir("tz");
        let store = LatencyStore::new(dir.clone());
        // Local midnight in UTC+13 is 11:00 UTC on the previous day.
        let local_day_start = at(20_001, 0) - 13 * 3_600_000;
        store.append(&sample(local_day_start + 3_600_000, 700)); // 01:00 local, previous UTC day
        store.append(&sample(local_day_start + 20 * 3_600_000, 800)); // 20:00 local, next UTC day

        let samples = read_range(&dir, local_day_start, local_day_start + MILLIS_PER_DAY);

        assert_eq!(samples.len(), 2, "both halves of the local day");
    }

    // A torn line must cost exactly the record that was cut off. Without the
    // tail-healing newline in `append_line`, the following append fuses onto it
    // and the count here comes back as 1 instead of 2.
    #[test]
    fn a_torn_line_costs_only_itself() {
        let dir = temp_dir("torn");
        let store = LatencyStore::new(dir.clone());
        store.append(&sample(at(20_000, 1), 100));
        // A hard shutdown mid-write leaves a partial line with no terminator.
        let path = day_file(&dir, &day_label(20_000));
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"kind\":\"tur").unwrap();
        drop(file);
        store.append(&sample(at(20_000, 2), 200));

        let api: Vec<i64> = read_range(&dir, at(20_000, 0), at(20_001, 0))
            .iter()
            .map(|s| s.get("apiMs").and_then(Value::as_i64).unwrap())
            .collect();
        assert_eq!(api, vec![100, 200], "the sample after the tear survives");
    }

    #[test]
    fn samples_come_back_oldest_first_however_they_were_written() {
        let dir = temp_dir("order");
        let store = LatencyStore::new(dir.clone());
        // Out of order on disk: turns can finish out of order, and `at` is when
        // the request went out, not when we wrote it.
        store.append(&sample(at(20_000, 9), 300));
        store.append(&sample(at(20_000, 4), 100));
        store.append(&sample(at(20_000, 6), 200));

        let api: Vec<i64> = read_range(&dir, at(20_000, 0), at(20_001, 0))
            .iter()
            .map(|s| s.get("apiMs").and_then(Value::as_i64).unwrap())
            .collect();
        assert_eq!(api, vec![100, 200, 300]);
    }

    #[test]
    fn the_tap_stores_latency_samples_and_forwards_nothing_else() {
        let dir = temp_dir("tap");
        let forwarded = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = forwarded.clone();
        let sink = tap_latency_samples(
            Some(dir.clone()),
            Arc::new(move |channel: &str, _params: &Value| {
                seen.lock().unwrap().push(channel.to_string());
            }),
        );

        sink(LATENCY_SAMPLE_CHANNEL, &sample(at(20_000, 1), 1_234));
        // The high-traffic channel: if the gate were a prefix match or missing,
        // this is what would flood the metrics directory.
        sink("pty:output", &json!({ "data": "hello" }));
        sink("agent:latency-sample-v2", &sample(at(20_000, 2), 9_999));

        assert_eq!(
            *forwarded.lock().unwrap(),
            vec!["pty:output".to_string(), "agent:latency-sample-v2".to_string()],
            "only the sample channel is swallowed"
        );
        let stored = fs::read_to_string(day_file(&dir, &day_label(20_000))).unwrap();
        assert!(stored.contains("1234"));
        assert!(!stored.contains("9999"), "a look-alike channel is not stored");
        assert!(!stored.contains("hello"));
    }

    #[test]
    fn a_host_with_no_data_dir_still_forwards_everything_else() {
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let sink = tap_latency_samples(
            None,
            Arc::new(move |_channel: &str, _params: &Value| {
                seen.fetch_add(1, Ordering::Relaxed);
            }),
        );

        sink(LATENCY_SAMPLE_CHANNEL, &sample(at(20_000, 1), 1_234));
        sink("pty:output", &json!({}));

        assert_eq!(count.load(Ordering::Relaxed), 1);
    }
}
