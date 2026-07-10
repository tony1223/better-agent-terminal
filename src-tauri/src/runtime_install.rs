// runtime_install — tauri-free managed-runtime install core.
//
// The desktop Setup UI installs managed runtimes through commands/runtime.rs
// (AppHandle-bound, desktop-only). The headless bat-server has no Setup UI and
// no AppHandle, but still needs to self-provision the codex binary so remote
// clients can run codex sessions against the host. This module factors the
// codex download / verify / extract / place logic into a function that takes a
// plain `runtimes` directory, so the headless startup (lib.rs) can call it
// directly. Versions and per-platform integrity come from runtime_catalog, the
// same single source the desktop installer and the Node sidecar read from.

use crate::runtime_catalog;
use crate::subprocess::hide_console_window;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha512};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn runtime_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.into()
    }
}

fn codex_target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        _ => None,
    }
}

fn codex_catalog_entry() -> Option<&'static runtime_catalog::CodexPlatform> {
    runtime_catalog::codex_platform(runtime_key()?)
}

fn managed_codex_runtime_dir(runtimes: &Path) -> Option<PathBuf> {
    Some(
        runtimes
            .join("codex")
            .join(runtime_catalog::codex_version())
            .join(runtime_key()?),
    )
}

/// Final on-disk path of the managed codex binary under `runtimes`, matching the
/// layout `codex_app_server::managed_codex_candidate` resolves from at runtime.
///
/// The managed install mirrors the npm platform package's `vendor/<triple>/`
/// tree (`bin/codex`, `bin/codex-code-mode-host`, `codex-path/rg`,
/// `codex-resources/…`, `codex-package.json`). Codex only recognizes its
/// package layout — and therefore only finds the code-mode host and sandbox
/// helper binaries — when the executable sits in a `bin/` directory whose
/// parent carries `codex-package.json`. Legacy installs that placed a lone
/// `codex` at the key root are deliberately NOT resolved anymore so they get
/// reinstalled with the full layout.
pub fn managed_codex_cli_path(runtimes: &Path) -> Option<PathBuf> {
    Some(
        managed_codex_runtime_dir(runtimes)?
            .join("bin")
            .join(exe_name("codex")),
    )
}

/// True when a working managed codex binary already exists under `runtimes`.
/// Only the headless bat-server startup consults this; the desktop installer
/// relies on install_codex's own idempotence check.
#[cfg(not(feature = "desktop"))]
pub fn codex_is_installed(runtimes: &Path) -> bool {
    managed_codex_cli_path(runtimes)
        .map(|path| candidate_is_ready(&path, &["--version"]))
        .unwrap_or(false)
}

/// Download, verify, extract and place the catalog-pinned codex runtime under
/// `runtimes/codex/<version>/<key>/`. Idempotent: returns the existing managed
/// binary immediately if it is already present and passes `--version`.
pub fn install_codex(runtimes: &Path) -> Result<PathBuf, String> {
    let entry = codex_catalog_entry().ok_or_else(|| {
        format!(
            "Codex managed install is not available for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let final_dir = managed_codex_runtime_dir(runtimes)
        .ok_or_else(|| "could not resolve Codex runtime dir".to_string())?;
    let final_path = managed_codex_cli_path(runtimes)
        .ok_or_else(|| "could not resolve Codex runtime path".to_string())?;
    if candidate_is_ready(&final_path, &["--version"]) {
        return Ok(final_path);
    }

    let url = format!(
        "https://registry.npmjs.org/@openai/codex/-/codex-{}.tgz",
        entry.npm_version
    );
    let archive = download_runtime_archive(&url)?;
    verify_sri_sha512(&archive, &entry.integrity)?;
    let tar = gunzip(&archive)?;
    let triple =
        codex_target_triple().ok_or_else(|| "could not resolve Codex target triple".to_string())?;
    let exe = exe_name("codex");

    // Mirror the whole vendor/<triple>/ tree. codex resolves codex-code-mode-host
    // next to its own executable and codex-resources/ + codex-path/ via the
    // package layout (bin/ + codex-package.json); extracting only codex + rg
    // left those helpers missing and broke e.g. code-mode file reads.
    let vendor_prefix = format!("package/vendor/{triple}/");
    let entries = tar_entries_under(&tar, &vendor_prefix)?;
    if entries.is_empty() {
        return Err(format!(
            "Codex native package has no files under vendor/{triple}"
        ));
    }

    let tmp_root = runtimes.join(".tmp").join(format!("codex-{}", install_nonce()));
    let tmp_final = tmp_root.join("final");
    let _ = fs::remove_dir_all(&tmp_root);
    for entry in &entries {
        let dest = tmp_final.join(entry.relative_path.split('/').collect::<PathBuf>());
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::write(&dest, &entry.bytes).map_err(|err| err.to_string())?;
        if entry.mode & 0o111 != 0 {
            make_executable(&dest)?;
        }
    }
    let tmp_path = tmp_final.join("bin").join(&exe);
    if !tmp_path.is_file() {
        let _ = fs::remove_dir_all(&tmp_root);
        return Err(format!(
            "Codex native package missing vendor/{triple}/bin/{exe}"
        ));
    }
    if !candidate_is_ready(&tmp_path, &["--version"]) {
        let _ = fs::remove_dir_all(&tmp_root);
        return Err("installed Codex binary failed --version check".into());
    }
    replace_runtime_dir(&tmp_final, &final_dir)?;
    let _ = fs::remove_dir_all(&tmp_root);
    prune_stale_runtime_versions(&runtimes.join("codex"), runtime_catalog::codex_version());
    Ok(final_path)
}

/// Best-effort removal of superseded managed version directories under a
/// runtime family root (`runtimes/<family>/`), keeping only `keep_version`.
/// Errors are ignored on purpose: Windows locks binaries that are still
/// running, and a leftover dir is harmless now that resolution pins the
/// catalog version. Returns the number of directories removed.
pub fn prune_stale_runtime_versions(family_root: &Path, keep_version: &str) -> usize {
    let Ok(entries) = fs::read_dir(family_root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !path.is_dir() || name.starts_with('.') || name == keep_version {
            continue;
        }
        if fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn candidate_is_ready(path: &Path, version_args: &[&str]) -> bool {
    path.is_file() && command_version(path, version_args).is_ok()
}

fn command_version(path: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start {}: {err}", path.display()))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= Duration::from_secs(5) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} --version timed out", path.display()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed waiting for {}: {err}", path.display()));
            }
        }
    };
    if !status.success() {
        return Err(format!("{} exited with failure", path.display()));
    }
    Ok(String::new())
}

fn download_runtime_archive(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("better-agent-terminal-runtime-installer")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client.get(url).send().map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "download failed: {url} -> HTTP {}",
            response.status()
        ));
    }
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|err| err.to_string())
}

fn verify_sri_sha512(bytes: &[u8], integrity: &str) -> Result<(), String> {
    let expected = integrity
        .strip_prefix("sha512-")
        .ok_or_else(|| "missing runtime package sha512 integrity".to_string())?;
    let actual = B64.encode(Sha512::digest(bytes));
    if actual != expected {
        return Err("runtime package integrity mismatch".into());
    }
    Ok(())
}

fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = GzDecoder::new(bytes);
    let mut decoded = Vec::new();
    decoder
        .read_to_end(&mut decoded)
        .map_err(|err| err.to_string())?;
    Ok(decoded)
}

struct TarFileEntry {
    /// Path relative to the requested prefix, '/'-separated.
    relative_path: String,
    /// Permission bits from the tar header (used to restore exec bits).
    mode: u32,
    bytes: Vec<u8>,
}

/// Collect every regular file under `prefix` from an uncompressed tar stream.
/// Path traversal segments are rejected; non-file entries (dirs, links, PAX
/// headers) are skipped.
fn tar_entries_under(tar: &[u8], prefix: &str) -> Result<Vec<TarFileEntry>, String> {
    let mut entries = Vec::new();
    let mut offset = 0usize;
    while offset + 512 <= tar.len() {
        let header = &tar[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let name = tar_string(&header[0..100]);
        let header_prefix = tar_string(&header[345..500]);
        let full_name = if header_prefix.is_empty() {
            name
        } else {
            format!("{header_prefix}/{name}")
        };
        let size_text = tar_string(&header[124..136]);
        let size = usize::from_str_radix(size_text.trim().trim_matches('\0'), 8)
            .map_err(|err| format!("invalid tar entry size: {err}"))?;
        let type_flag = header[156];
        offset += 512;
        if offset + size > tar.len() {
            return Err("truncated tar entry".into());
        }
        let is_regular_file = type_flag == b'0' || type_flag == 0;
        if is_regular_file {
            if let Some(relative_path) = full_name.strip_prefix(prefix) {
                if relative_path.is_empty()
                    || relative_path
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..")
                {
                    return Err(format!("unsafe tar entry path: {full_name}"));
                }
                let mode_text = tar_string(&header[100..108]);
                let mode =
                    u32::from_str_radix(mode_text.trim().trim_matches('\0'), 8).unwrap_or(0o644);
                entries.push(TarFileEntry {
                    relative_path: relative_path.to_string(),
                    mode,
                    bytes: tar[offset..offset + size].to_vec(),
                });
            }
        }
        offset += size.div_ceil(512) * 512;
    }
    Ok(entries)
}

fn tar_string(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).to_string()
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn replace_runtime_dir(tmp_final: &Path, final_dir: &Path) -> Result<(), String> {
    let parent = final_dir
        .parent()
        .ok_or_else(|| "invalid runtime parent".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let name = final_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("runtime");
    let backup = parent.join(format!(".{name}.backup-{}", install_nonce()));
    let mut had_existing = false;
    if final_dir.exists() {
        fs::rename(final_dir, &backup).map_err(|err| err.to_string())?;
        had_existing = true;
    }
    match fs::rename(tmp_final, final_dir) {
        Ok(()) => {
            if had_existing {
                let _ = fs::remove_dir_all(&backup);
            }
            Ok(())
        }
        Err(err) => {
            if had_existing {
                let _ = fs::rename(&backup, final_dir);
            }
            Err(err.to_string())
        }
    }
}

fn install_nonce() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{}-{millis}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tar_header(name: &str, mode: &str, size: usize, type_flag: u8) -> [u8; 512] {
        let mut header = [0u8; 512];
        header[0..name.len()].copy_from_slice(name.as_bytes());
        header[100..100 + mode.len()].copy_from_slice(mode.as_bytes());
        let size_text = format!("{size:011o}");
        header[124..124 + size_text.len()].copy_from_slice(size_text.as_bytes());
        header[156] = type_flag;
        header
    }

    fn push_entry(tar: &mut Vec<u8>, name: &str, mode: &str, body: &[u8], type_flag: u8) {
        tar.extend_from_slice(&tar_header(name, mode, body.len(), type_flag));
        tar.extend_from_slice(body);
        let padding = body.len().div_ceil(512) * 512 - body.len();
        tar.extend_from_slice(&vec![0u8; padding]);
    }

    #[test]
    fn tar_entries_under_extracts_the_vendor_tree_with_modes() {
        let mut tar = Vec::new();
        // pax global header (npm tarballs carry one) must be skipped.
        push_entry(&mut tar, "pax_global_header", "0000644", b"junk", b'g');
        push_entry(
            &mut tar,
            "package/vendor/t/bin/codex",
            "0000755",
            b"binary",
            b'0',
        );
        push_entry(&mut tar, "package/vendor/t/bin", "0000755", b"", b'5');
        push_entry(
            &mut tar,
            "package/vendor/t/codex-package.json",
            "0000644",
            b"{}",
            b'0',
        );
        push_entry(&mut tar, "package/package.json", "0000644", b"{}", b'0');
        tar.extend_from_slice(&[0u8; 1024]);

        let entries = tar_entries_under(&tar, "package/vendor/t/").expect("parses");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].relative_path, "bin/codex");
        assert_eq!(entries[0].mode & 0o111, 0o111);
        assert_eq!(entries[0].bytes, b"binary");
        assert_eq!(entries[1].relative_path, "codex-package.json");
        assert_eq!(entries[1].mode & 0o111, 0);
    }

    #[test]
    fn tar_entries_under_rejects_path_traversal() {
        let mut tar = Vec::new();
        push_entry(
            &mut tar,
            "package/vendor/t/../../evil",
            "0000644",
            b"nope",
            b'0',
        );
        tar.extend_from_slice(&[0u8; 1024]);
        assert!(tar_entries_under(&tar, "package/vendor/t/").is_err());
    }

    #[test]
    fn prune_stale_runtime_versions_keeps_only_the_pinned_dir() {
        let root = std::env::temp_dir().join(format!("bat-prune-test-{}", install_nonce()));
        for version in ["0.135.0", "0.144.0", ".tmp-marker"] {
            fs::create_dir_all(root.join(version).join("child")).expect("mkdirs");
        }
        let removed = prune_stale_runtime_versions(&root, "0.144.0");
        assert_eq!(removed, 1);
        assert!(root.join("0.144.0").is_dir());
        assert!(root.join(".tmp-marker").is_dir());
        assert!(!root.join("0.135.0").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
