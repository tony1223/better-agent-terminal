// Deny-list guard for filesystem reads.
//
// Mirrors electron/path-guard.ts: a deliberately narrow blocklist of
// well-known credential stores so an authenticated remote client (or an
// unintended renderer call site) can't trivially exfiltrate secrets via
// fs_read_file / image_read_as_data_url. This is harm reduction, not a
// sandbox — legitimate uses (~/.bashrc, /etc/hosts, etc.) still work.

use std::path::{Component, Path, PathBuf};

fn home_dir() -> PathBuf {
    // Match Node's os.homedir() across platforms. dirs::home_dir is the
    // standard helper — but we don't want a new dep here, so use the env
    // approach the std lib also uses internally.
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn denied_paths() -> Vec<PathBuf> {
    let home = home_dir();
    let join = |segments: &[&str]| {
        let mut p = home.clone();
        for s in segments {
            p.push(s);
        }
        p
    };
    vec![
        // SSH keys
        join(&[".ssh"]),
        // AWS credentials
        join(&[".aws", "credentials"]),
        join(&[".aws", "config"]),
        // GCP service account keys
        join(&[".config", "gcloud"]),
        // GitHub / gh CLI
        join(&[".config", "gh", "hosts.yml"]),
        // Generic secrets
        join(&[".netrc"]),
        join(&[".pgpass"]),
        // Kubernetes contexts
        join(&[".kube", "config"]),
        // macOS Keychain
        join(&["Library", "Keychains"]),
        // Browser credential stores
        join(&["Library", "Application Support", "Google", "Chrome"]),
        join(&["Library", "Application Support", "BraveSoftware"]),
        join(&["Library", "Application Support", "Microsoft Edge"]),
        join(&["Library", "Application Support", "Firefox"]),
        // BAT's own secrets — current Electron/Tauri build uses
        // productName `BetterAgentTerminal`; the lowercase paths cover the
        // legacy package-name folder users may still have on disk.
        join(&[
            "Library",
            "Application Support",
            "BetterAgentTerminal",
            "server-cert.enc.json",
        ]),
        join(&[
            "Library",
            "Application Support",
            "BetterAgentTerminal",
            "server-token.enc.json",
        ]),
        join(&[
            "Library",
            "Application Support",
            "BetterAgentTerminal",
            "claude-account-creds.enc.json",
        ]),
        join(&[
            "Library",
            "Application Support",
            "better-agent-terminal",
            "server-cert.enc.json",
        ]),
        join(&[
            "Library",
            "Application Support",
            "better-agent-terminal",
            "server-token.enc.json",
        ]),
        join(&[
            "Library",
            "Application Support",
            "better-agent-terminal",
            "claude-account-creds.enc.json",
        ]),
        // Linux / XDG
        join(&[".config", "BetterAgentTerminal", "server-cert.enc.json"]),
        join(&[".config", "BetterAgentTerminal", "server-token.enc.json"]),
        join(&[".config", "better-agent-terminal", "server-cert.enc.json"]),
        join(&[".config", "better-agent-terminal", "server-token.enc.json"]),
        join(&[".mozilla"]),
        // Claude Code CLI state
        join(&[".claude", ".credentials.json"]),
        // Windows credential store
        PathBuf::from("C:\\Windows\\System32\\config"),
        // System-wide
        PathBuf::from("/etc/shadow"),
        PathBuf::from("/etc/sudoers"),
        PathBuf::from("/etc/ssh/ssh_host_rsa_key"),
        PathBuf::from("/etc/ssh/ssh_host_ed25519_key"),
        PathBuf::from("/root"),
        PathBuf::from("/private/etc/master.passwd"),
    ]
}

// std::path::Path doesn't have a public "normalize that doesn't touch the
// filesystem" — we roll our own that resolves `.` and `..` lexically so
// the deny check sees a comparable shape no matter how the caller spelled
// the path.
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    #[cfg(windows)]
    {
        // canonicalize returns verbatim paths on Windows. Compare those against
        // ordinary drive/UNC paths with Windows' usual case-insensitive spelling.
        let text = out.to_string_lossy().replace('/', "\\").to_lowercase();
        if let Some(unc) = text.strip_prefix(r"\\?\unc\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text));
    }
    #[cfg(not(windows))]
    out
}

fn starts_with_denied(absolute: &Path, denied: &Path) -> bool {
    if absolute == denied {
        return true;
    }
    // Directory containment: a/b matches a/b/c but not a/bcd.
    absolute.starts_with(denied)
}

fn is_private_key_filename(absolute: &Path) -> bool {
    let Some(file_name) = absolute.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let parent_str = absolute.to_string_lossy();
    // ssh-style identity keys (id_rsa, id_ed25519.pub, ...) under .ssh/
    let id_re = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
    let in_ssh_dir = parent_str.contains(&format!(
        "{}.ssh{}",
        std::path::MAIN_SEPARATOR,
        std::path::MAIN_SEPARATOR
    ));
    if in_ssh_dir {
        for stem in id_re {
            if file_name == stem || file_name == &format!("{}.pub", stem) {
                return true;
            }
        }
    }
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".pem")
        && (in_ssh_dir
            || parent_str.contains(&format!(
                "{}keys{}",
                std::path::MAIN_SEPARATOR,
                std::path::MAIN_SEPARATOR
            )))
    {
        return true;
    }
    false
}

pub fn is_sensitive_path(absolute_path: &str) -> bool {
    if absolute_path.is_empty() {
        return true;
    }
    let abs = lexical_normalize(Path::new(absolute_path));
    for denied in denied_paths() {
        let norm_denied = lexical_normalize(&denied);
        if starts_with_denied(&abs, &norm_denied) {
            return true;
        }
    }
    is_private_key_filename(&abs)
}

/// Resolve existing paths before a transfer, then use the returned path for I/O.
/// Check both names: a credential store can itself be a symlink to another disk.
pub fn resolve_transfer_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(path).map_err(|err| format!("bad path: {err}"))?;
    if is_sensitive_path(&absolute.to_string_lossy()) {
        return Err("access denied (sensitive path)".into());
    }
    let resolved =
        std::fs::canonicalize(&absolute).map_err(|err| format!("cannot resolve path: {err}"))?;
    if is_sensitive_path(&resolved.to_string_lossy()) {
        return Err("access denied (sensitive path)".into());
    }
    let normalized = lexical_normalize(&resolved);
    if denied_paths()
        .iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .any(|denied| starts_with_denied(&normalized, &lexical_normalize(&denied)))
    {
        return Err("access denied (sensitive path)".into());
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_paths_are_sensitive() {
        assert!(is_sensitive_path(""));
    }

    #[test]
    fn unrelated_paths_are_not_sensitive() {
        // /etc/hosts and ~/.bashrc are explicitly NOT in the deny list,
        // mirroring the Electron contract.
        assert!(!is_sensitive_path("/etc/hosts"));
        assert!(!is_sensitive_path("/usr/local/bin/node"));
    }

    #[test]
    fn explicit_system_files_blocked() {
        assert!(is_sensitive_path("/etc/shadow"));
        assert!(is_sensitive_path("/etc/sudoers"));
    }

    #[test]
    fn directory_containment_matches() {
        // /root and anything beneath are blocked.
        assert!(is_sensitive_path("/root"));
        assert!(is_sensitive_path("/root/.bashrc"));
        // Sibling directory must NOT match.
        assert!(!is_sensitive_path("/rootless/foo"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_canonical_and_mixed_case_paths_are_guarded() {
        assert!(is_sensitive_path(r"\\?\C:\WINDOWS\system32\CONFIG\SAM"));
        assert!(is_sensitive_path(r"c:\windows\SYSTEM32\config\SAM"));
        assert!(!is_sensitive_path(r"\\?\C:\Windows\System32\config-backup\notes.txt"));
        assert_eq!(lexical_normalize(Path::new(r"\\?\UNC\Server\Share\keys\a.pem")),
            lexical_normalize(Path::new(r"\\server\share\keys\a.pem")));
        let home = home_dir().join(".ssh").join("id_ed25519");
        assert!(is_sensitive_path(&format!(r"\\?\{}", home.display())));
    }
}
