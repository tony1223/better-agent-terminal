use bat_host_support::subprocess::hide_console_window;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

// Hard upper bound for log/status/diff output. Mirrors the Electron
// maxBuffer (5 MiB) so a runaway repo can't OOM the renderer.
const MAX_OUTPUT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct GitLogEntry {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct GitFileEntry {
    pub status: String,
    pub file: String,
}

// Run git with the given args in `cwd`, returning stdout as a UTF-8
// string with a wall-clock timeout. Any failure (non-zero exit,
// missing binary, timeout, oversized output) collapses to None so
// callers can apply their own default.
pub fn run_git(cwd: &str, args: &[&str], timeout: Duration) -> Option<String> {
    if cwd.trim().is_empty() {
        return None;
    }
    if !Path::new(cwd).is_dir() {
        return None;
    }
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    let mut child = command.spawn().ok()?;

    // Cheap timeout: poll try_wait every 25 ms.
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

// `git remote get-url origin` returns the remote URL; we only
// translate github.com remotes so the GitHubPanel / Sidebar links
// resolve to a browsable HTTPS URL.
pub fn parse_github_url(remote: &str) -> Option<String> {
    let s = remote.trim();
    // git@github.com:owner/repo(.git)?
    if let Some(rest) = s.strip_prefix("git@github.com:") {
        let owner_repo = rest.strip_suffix(".git").unwrap_or(rest);
        if owner_repo.is_empty() {
            return None;
        }
        return Some(format!("https://github.com/{owner_repo}"));
    }
    // https?://github.com/owner/repo(.git)?
    for prefix in ["https://github.com/", "http://github.com/"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            let owner_repo = rest.strip_suffix(".git").unwrap_or(rest);
            if owner_repo.is_empty() {
                return None;
            }
            return Some(format!("https://github.com/{owner_repo}"));
        }
    }
    None
}

// `git log --pretty=format:%H||%an||%aI||%s` — keep the delimiter
// in sync with the Electron handler so the parser is bit-for-bit
// the same. Use strict ISO-8601 dates so WebViews can parse them
// consistently across platforms.
pub fn parse_log(raw: &str) -> Vec<GitLogEntry> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    trimmed
        .lines()
        .map(|line| {
            let parts: Vec<&str> = line.splitn(4, "||").collect();
            GitLogEntry {
                hash: parts.first().copied().unwrap_or("").to_string(),
                author: parts.get(1).copied().unwrap_or("").to_string(),
                date: parts.get(2).copied().unwrap_or("").to_string(),
                message: parts.get(3).copied().unwrap_or("").to_string(),
            }
        })
        .collect()
}

// Parse `git diff --name-status [range]`: each line is
// "<status>\t<file>" (renames use a longer two-tab form, but the
// Electron handler also flattens that to the first segment).
pub fn parse_diff_files(raw: &str) -> Vec<GitFileEntry> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    trimmed
        .lines()
        .map(|line| {
            if let Some(tab_idx) = line.find('\t') {
                GitFileEntry {
                    status: line[..tab_idx].trim().to_string(),
                    file: line[tab_idx + 1..].to_string(),
                }
            } else {
                let status = line
                    .chars()
                    .next()
                    .map(|c| c.to_string())
                    .unwrap_or_default();
                let file = if line.len() > 2 {
                    line[2..].to_string()
                } else {
                    String::new()
                };
                GitFileEntry { status, file }
            }
        })
        .collect()
}

// Parse `git status --porcelain --untracked-files=all`: each line begins with two
// status chars followed by a space and the path. Mirrors the
// Electron parser (which trims the status field).
pub fn parse_status(raw: &str) -> Vec<GitFileEntry> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    raw.split('\n')
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let status_end = line.len().min(2);
            let status = line[..status_end].trim().to_string();
            let file = if line.len() > 3 {
                line[3..].to_string()
            } else {
                String::new()
            };
            GitFileEntry { status, file }
        })
        .collect()
}

// Build the argv for `git diff` based on optional commit hash + path.
// "working" is a magic string the renderer uses to mean "uncommitted
// changes vs HEAD" — we map that to `git diff HEAD`.
pub fn build_diff_args<'a>(
    commit_hash: Option<&'a str>,
    file_path: Option<&'a str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["diff".into()];
    match commit_hash {
        Some(hash) if !hash.is_empty() && hash != "working" => {
            args.push(format!("{hash}~1..{hash}"));
        }
        _ => args.push("HEAD".into()),
    }
    if let Some(p) = file_path {
        if !p.is_empty() {
            args.push("--".into());
            args.push(p.to_string());
        }
    }
    args
}

pub fn build_diff_files_args<'a>(commit_hash: Option<&'a str>) -> Vec<String> {
    match commit_hash {
        Some(hash) if !hash.is_empty() && hash != "working" => {
            vec![
                "diff".into(),
                "--name-status".into(),
                format!("{hash}~1..{hash}"),
            ]
        }
        _ => vec!["diff".into(), "--name-status".into(), "HEAD".into()],
    }
}

pub fn clamp_log_count(count: Option<i64>) -> u32 {
    let raw = count.unwrap_or(50);
    raw.clamp(1, 500) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_github_ssh_url() {
        assert_eq!(
            parse_github_url("git@github.com:owner/repo.git"),
            Some("https://github.com/owner/repo".into()),
        );
        assert_eq!(
            parse_github_url("git@github.com:owner/repo"),
            Some("https://github.com/owner/repo".into()),
        );
    }

    #[test]
    fn parse_github_https_url() {
        assert_eq!(
            parse_github_url("https://github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".into()),
        );
        assert_eq!(
            parse_github_url("http://github.com/owner/repo"),
            Some("https://github.com/owner/repo".into()),
        );
    }

    #[test]
    fn parse_github_url_rejects_non_github() {
        assert_eq!(parse_github_url("git@gitlab.com:owner/repo.git"), None);
        assert_eq!(parse_github_url("https://bitbucket.org/owner/repo"), None);
        assert_eq!(parse_github_url(""), None);
    }

    #[test]
    fn parse_log_handles_empty() {
        assert_eq!(parse_log(""), Vec::<GitLogEntry>::new());
        assert_eq!(parse_log("   \n  "), Vec::<GitLogEntry>::new());
    }

    #[test]
    fn parse_log_handles_messages_with_delimiter() {
        // The 4-way splitn means everything after the third "||" is
        // considered part of the message — preserving message
        // segments that contain "||".
        let raw = "abc123||Alice||2024-01-01 10:00||fix(pty): handle || edge case";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].hash, "abc123");
        assert_eq!(entries[0].author, "Alice");
        assert_eq!(entries[0].date, "2024-01-01 10:00");
        assert_eq!(entries[0].message, "fix(pty): handle || edge case");
    }

    #[test]
    fn parse_log_multiple_lines() {
        let raw = "h1||a||d1||m1\nh2||b||d2||m2";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].hash, "h2");
        assert_eq!(entries[1].message, "m2");
    }

    #[test]
    fn parse_diff_files_basic() {
        let raw = "M\tsrc/foo.rs\nA\tsrc/bar.rs\nD\told/baz.rs";
        let entries = parse_diff_files(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries[0],
            GitFileEntry {
                status: "M".into(),
                file: "src/foo.rs".into()
            }
        );
        assert_eq!(
            entries[2],
            GitFileEntry {
                status: "D".into(),
                file: "old/baz.rs".into()
            }
        );
    }

    #[test]
    fn parse_diff_files_no_tab_fallback() {
        // Defensive: if the line lacks a tab, take first char as
        // status and skip a couple chars for the file. Mirrors the
        // Electron substring(2) fallback.
        let raw = "M  some/odd/file.rs";
        let entries = parse_diff_files(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "M");
    }

    #[test]
    fn parse_status_porcelain() {
        let raw = " M src/foo.rs\n?? new.txt\nMM both.rs\n";
        let entries = parse_status(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries[0],
            GitFileEntry {
                status: "M".into(),
                file: "src/foo.rs".into()
            }
        );
        assert_eq!(
            entries[1],
            GitFileEntry {
                status: "??".into(),
                file: "new.txt".into()
            }
        );
        assert_eq!(
            entries[2],
            GitFileEntry {
                status: "MM".into(),
                file: "both.rs".into()
            }
        );
    }

    #[test]
    fn parse_status_keeps_untracked_folder_files() {
        let raw = "?? generated/output.txt\n?? generated/nested/file.log\n";
        let entries = parse_status(raw);
        assert_eq!(
            entries,
            vec![
                GitFileEntry {
                    status: "??".into(),
                    file: "generated/output.txt".into(),
                },
                GitFileEntry {
                    status: "??".into(),
                    file: "generated/nested/file.log".into(),
                },
            ]
        );
    }

    #[test]
    fn parse_status_empty_returns_empty() {
        assert_eq!(parse_status(""), Vec::<GitFileEntry>::new());
        assert_eq!(parse_status("\n\n"), Vec::<GitFileEntry>::new());
    }

    #[test]
    fn build_diff_args_default() {
        assert_eq!(
            build_diff_args(None, None),
            vec!["diff".to_string(), "HEAD".into()]
        );
    }

    #[test]
    fn build_diff_args_working_keyword() {
        // "working" is the renderer's sentinel for HEAD/uncommitted.
        assert_eq!(
            build_diff_args(Some("working"), None),
            vec!["diff".to_string(), "HEAD".into()],
        );
    }

    #[test]
    fn build_diff_args_with_commit_and_path() {
        assert_eq!(
            build_diff_args(Some("abc123"), Some("src/foo.rs")),
            vec![
                "diff".to_string(),
                "abc123~1..abc123".into(),
                "--".into(),
                "src/foo.rs".into(),
            ],
        );
    }

    #[test]
    fn build_diff_args_empty_commit_falls_back_to_head() {
        assert_eq!(
            build_diff_args(Some(""), None),
            vec!["diff".to_string(), "HEAD".into()],
        );
    }

    #[test]
    fn build_diff_files_args_variants() {
        assert_eq!(
            build_diff_files_args(None),
            vec!["diff".to_string(), "--name-status".into(), "HEAD".into()],
        );
        assert_eq!(
            build_diff_files_args(Some("abc")),
            vec![
                "diff".to_string(),
                "--name-status".into(),
                "abc~1..abc".into()
            ],
        );
        assert_eq!(
            build_diff_files_args(Some("working")),
            vec!["diff".to_string(), "--name-status".into(), "HEAD".into()],
        );
    }

    #[test]
    fn clamp_log_count_bounds() {
        assert_eq!(clamp_log_count(None), 50);
        assert_eq!(clamp_log_count(Some(0)), 1);
        assert_eq!(clamp_log_count(Some(-5)), 1);
        assert_eq!(clamp_log_count(Some(10)), 10);
        assert_eq!(clamp_log_count(Some(99999)), 500);
    }

    #[test]
    fn run_git_rejects_invalid_cwd() {
        assert!(run_git("", &["status"], Duration::from_secs(1)).is_none());
        assert!(run_git(
            "C:/this/path/should/never/exist/abc123",
            &["status"],
            Duration::from_secs(1),
        )
        .is_none());
    }
}
