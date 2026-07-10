// Work around the AppImage libwayland skew that blanks the window on newer
// Linux distros (GitHub issue #112).
//
// Our AppImage is built on an older base (Ubuntu 22.04) and therefore bundles
// its own older `libwayland-client.so.0`. It does NOT bundle libEGL/libgbm, so
// those come from the host's (newer) Mesa. On a recent Wayland desktop
// (e.g. Ubuntu 26.04 + Mesa 26) the bundled-old `wl_display` and the system-new
// `wayland-egl` platform disagree on the interface, so `eglGetPlatformDisplay`
// returns `EGL_BAD_PARAMETER` and WebKitGTK aborts -> blank window.
//
// The fix verified by the reporter is to load the *system* libwayland-client
// ahead of the bundled one. The dynamic linker only reads `LD_PRELOAD` at
// process start, so the only way to influence our own process is to set it and
// re-exec. This runs before any GTK / GLib / WebKit initialization.
//
// Strictly gated: it only acts when we are launched from an AppImage on a
// Wayland session, and a guard env var makes the re-exec happen at most once.
// On every other platform / packaging / session it is a no-op.

#![allow(dead_code)] // helpers are only wired up on Linux; tests exercise them everywhere.

/// Env var set on the re-exec'd child so we never re-exec more than once.
const REEXEC_GUARD_ENV: &str = "BAT_WAYLAND_PRELOAD_DONE";

/// Canonical system locations for `libwayland-client.so.0`, tried in order when
/// `ldconfig` is unavailable or yields nothing usable. Covers the multiarch
/// layouts of the Linux targets we ship (x86_64 and aarch64) plus arch-agnostic
/// fallbacks.
const FALLBACK_LIBWAYLAND_PATHS: &[&str] = &[
    "/usr/lib/x86_64-linux-gnu/libwayland-client.so.0",
    "/lib/x86_64-linux-gnu/libwayland-client.so.0",
    "/usr/lib/aarch64-linux-gnu/libwayland-client.so.0",
    "/lib/aarch64-linux-gnu/libwayland-client.so.0",
    "/usr/lib64/libwayland-client.so.0",
    "/usr/lib/libwayland-client.so.0",
];

/// True when this process was launched from an AppImage (either a mounted
/// AppImage, which sets `APPIMAGE`, or an extracted `--appimage-extract-and-run`
/// run, which sets `APPDIR`).
fn is_appimage(appimage: Option<&str>, appdir: Option<&str>) -> bool {
    has_value(appimage) || has_value(appdir)
}

fn has_value(value: Option<&str>) -> bool {
    matches!(value, Some(v) if !v.is_empty())
}

/// Extract the resolved paths for a given soname out of `ldconfig -p` output.
/// Lines look like:
///   `\tlibwayland-client.so.0 (libc6,x86-64) => /lib/x86_64-linux-gnu/libwayland-client.so.0`
fn parse_ldconfig_paths<'a>(soname: &str, ldconfig_output: &'a str) -> Vec<&'a str> {
    let mut paths = Vec::new();
    for line in ldconfig_output.lines() {
        // Match the soname as the leading token, not a substring, so a versioned
        // entry like `libwayland-client.so.0.1` can't masquerade as `.so.0`.
        if line.trim_start().split_whitespace().next() != Some(soname) {
            continue;
        }
        if let Some(idx) = line.find("=> ") {
            let path = line[idx + 3..].trim();
            if !path.is_empty() {
                paths.push(path);
            }
        }
    }
    paths
}

/// Choose the system `libwayland-client.so.0`, preferring `ldconfig` (the system
/// ld cache never contains AppImage-bundled libs, which are only visible via the
/// `LD_LIBRARY_PATH` that AppRun sets) and falling back to canonical locations.
/// Any candidate inside `APPDIR` (i.e. the bundled copy) is rejected, and the
/// file must exist.
fn pick_system_libwayland(
    appdir: Option<&str>,
    ldconfig_output: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    let outside_appdir = |path: &str| match appdir {
        Some(dir) if !dir.is_empty() => {
            // Inside APPDIR means the path equals it or sits under it as a real
            // path component — so `/tmp/.mount_x` does NOT swallow a sibling like
            // `/tmp/.mount_x_backup/...`.
            let dir = dir.trim_end_matches('/');
            match path.strip_prefix(dir) {
                Some(rest) => !(rest.is_empty() || rest.starts_with('/')),
                None => true,
            }
        }
        _ => true,
    };

    if let Some(output) = ldconfig_output {
        for path in parse_ldconfig_paths("libwayland-client.so.0", output) {
            if outside_appdir(path) && exists(path) {
                return Some(path.to_string());
            }
        }
    }

    for &candidate in FALLBACK_LIBWAYLAND_PATHS {
        if outside_appdir(candidate) && exists(candidate) {
            return Some(candidate.to_string());
        }
    }

    None
}

/// Build the `LD_PRELOAD` value with `sys_lib` prepended, or `None` when it is
/// already present (so we neither duplicate it nor risk a re-exec loop).
fn compose_ld_preload(sys_lib: &str, existing: Option<&str>) -> Option<String> {
    match existing {
        Some(value) if !value.is_empty() => {
            if value.split(':').any(|entry| entry == sys_lib) {
                None
            } else {
                Some(format!("{sys_lib}:{value}"))
            }
        }
        _ => Some(sys_lib.to_string()),
    }
}

/// Linux entry point: if launched from an AppImage on a Wayland session, prepend
/// the system `libwayland-client` to `LD_PRELOAD` and re-exec this process once.
/// `exec` replaces the image and never returns on success; on any skip/failure
/// we fall through and start normally.
#[cfg(target_os = "linux")]
pub fn preload_system_libwayland() {
    use std::os::unix::process::CommandExt;

    // Already re-exec'd, or not the situation we patch.
    if std::env::var_os(REEXEC_GUARD_ENV).is_some() {
        return;
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return;
    }
    let appimage = std::env::var("APPIMAGE").ok();
    let appdir = std::env::var("APPDIR").ok();
    if !is_appimage(appimage.as_deref(), appdir.as_deref()) {
        return;
    }

    let ldconfig_output = run_ldconfig();
    let sys_lib = match pick_system_libwayland(appdir.as_deref(), ldconfig_output.as_deref(), |p| {
        std::path::Path::new(p).exists()
    }) {
        Some(lib) => lib,
        None => {
            eprintln!(
                "[bat] system libwayland-client.so.0 not found; AppImage may blank on newer Wayland desktops (GitHub issue #112)"
            );
            return;
        }
    };

    let existing = std::env::var("LD_PRELOAD").ok();
    let new_preload = match compose_ld_preload(&sys_lib, existing.as_deref()) {
        Some(value) => value,
        None => return, // system lib already preloaded; nothing to do.
    };

    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return,
    };
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();

    // Re-exec with the system libwayland preloaded. Keep the rest of the
    // environment (APPDIR / LD_LIBRARY_PATH set by AppRun) intact so the bundled
    // libs still resolve; the preload just wins for libwayland-client.
    let err = std::process::Command::new(&exe)
        .args(&args)
        .env(REEXEC_GUARD_ENV, "1")
        .env("LD_PRELOAD", &new_preload)
        .exec();

    // exec() only returns on failure. There is no logger this early in startup,
    // so emit to stderr (where the EGL abort would also surface) and continue.
    eprintln!("[bat] libwayland preload re-exec failed: {err}; starting without it");
}

#[cfg(target_os = "linux")]
fn run_ldconfig() -> Option<String> {
    let output = std::process::Command::new("ldconfig")
        .arg("-p")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appimage_detection_requires_a_nonempty_marker() {
        assert!(is_appimage(Some("/x/App.AppImage"), None));
        assert!(is_appimage(None, Some("/tmp/.mount_x")));
        assert!(is_appimage(Some(""), Some("/tmp/.mount_x")));
        assert!(!is_appimage(None, None));
        assert!(!is_appimage(Some(""), Some("")));
        assert!(!is_appimage(Some(""), None));
    }

    #[test]
    fn parse_ldconfig_extracts_resolved_paths() {
        let output = "\tlibfoo.so.1 (libc6,x86-64) => /usr/lib/libfoo.so.1\n\
                      \tlibwayland-client.so.0 (libc6,x86-64) => /lib/x86_64-linux-gnu/libwayland-client.so.0\n\
                      \tlibbar.so (libc6) => /usr/lib/libbar.so\n";
        let paths = parse_ldconfig_paths("libwayland-client.so.0", output);
        assert_eq!(paths, vec!["/lib/x86_64-linux-gnu/libwayland-client.so.0"]);
    }

    #[test]
    fn parse_ldconfig_handles_no_match() {
        let output = "\tlibfoo.so.1 (libc6,x86-64) => /usr/lib/libfoo.so.1\n";
        assert!(parse_ldconfig_paths("libwayland-client.so.0", output).is_empty());
    }

    #[test]
    fn parse_ldconfig_matches_soname_token_not_substring() {
        // A longer versioned soname must NOT be accepted when we asked for .so.0.
        let output =
            "\tlibwayland-client.so.0.1 (libc6,x86-64) => /usr/lib/libwayland-client.so.0.1\n\
             \tlibwayland-client.so.0 (libc6,x86-64) => /lib/x86_64-linux-gnu/libwayland-client.so.0\n";
        let paths = parse_ldconfig_paths("libwayland-client.so.0", output);
        assert_eq!(paths, vec!["/lib/x86_64-linux-gnu/libwayland-client.so.0"]);
    }

    #[test]
    fn pick_prefers_ldconfig_outside_appdir() {
        let output =
            "\tlibwayland-client.so.0 (libc6,x86-64) => /lib/x86_64-linux-gnu/libwayland-client.so.0\n";
        let picked = pick_system_libwayland(Some("/tmp/.mount_x"), Some(output), |_| true);
        assert_eq!(
            picked.as_deref(),
            Some("/lib/x86_64-linux-gnu/libwayland-client.so.0")
        );
    }

    #[test]
    fn pick_rejects_bundled_copy_inside_appdir() {
        // ldconfig should never list the bundled copy, but if some path resolves
        // inside APPDIR we must skip it and fall back to a real system path.
        let output = "\tlibwayland-client.so.0 (libc6,x86-64) => /tmp/.mount_x/usr/lib/libwayland-client.so.0\n";
        let real = "/usr/lib/x86_64-linux-gnu/libwayland-client.so.0";
        let picked = pick_system_libwayland(Some("/tmp/.mount_x"), Some(output), |p| p == real);
        assert_eq!(picked.as_deref(), Some(real));
    }

    #[test]
    fn pick_treats_sibling_prefix_dir_as_outside_appdir() {
        // APPDIR `/tmp/.mount_x` must not swallow a sibling `/tmp/.mount_x_bak`.
        let sibling = "/tmp/.mount_x_bak/usr/lib/libwayland-client.so.0";
        let output = format!("\tlibwayland-client.so.0 (libc6,x86-64) => {sibling}\n");
        let picked = pick_system_libwayland(Some("/tmp/.mount_x"), Some(&output), |p| p == sibling);
        assert_eq!(picked.as_deref(), Some(sibling));
    }

    #[test]
    fn pick_falls_back_when_ldconfig_absent() {
        let real = "/usr/lib64/libwayland-client.so.0";
        let picked = pick_system_libwayland(None, None, |p| p == real);
        assert_eq!(picked.as_deref(), Some(real));
    }

    #[test]
    fn pick_returns_none_when_nothing_exists() {
        assert!(pick_system_libwayland(None, None, |_| false).is_none());
    }

    #[test]
    fn compose_prepends_when_absent() {
        assert_eq!(
            compose_ld_preload("/sys/libwayland-client.so.0", None).as_deref(),
            Some("/sys/libwayland-client.so.0")
        );
        assert_eq!(
            compose_ld_preload("/sys/wl.so", Some("")).as_deref(),
            Some("/sys/wl.so")
        );
        assert_eq!(
            compose_ld_preload("/sys/wl.so", Some("/other/lib.so")).as_deref(),
            Some("/sys/wl.so:/other/lib.so")
        );
    }

    #[test]
    fn compose_is_noop_when_already_present() {
        assert!(compose_ld_preload("/sys/wl.so", Some("/sys/wl.so")).is_none());
        assert!(compose_ld_preload("/sys/wl.so", Some("/a.so:/sys/wl.so:/b.so")).is_none());
    }
}
