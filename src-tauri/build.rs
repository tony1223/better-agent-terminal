fn main() {
    // Bundle mode is resolved from packaged resources at runtime. Keeping it
    // out of rustc's environment lets all-in-one and lightweight releases
    // share the same compiled application library.
    ensure_bundle_mode_marker();
    export_app_version();
    configure_windows_common_controls_manifest();
    // Tauri's build-time codegen (context, capabilities, resource copy) is only
    // needed for the desktop shell. A headless `--no-default-features` build
    // links no tauri/wry (hence no webkit2gtk), so skip it there.
    #[cfg(feature = "desktop")]
    {
        let attributes = tauri_build::Attributes::new();
        // The Common Controls manifest is embedded for every Windows MSVC link
        // target below, so omit Tauri's duplicate RT_MANIFEST resource while
        // retaining its icons and version metadata. Other targets keep Tauri's
        // defaults unchanged.
        let attributes = if is_windows_msvc_target() {
            let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
            attributes.windows_attributes(windows)
        } else {
            attributes
        };
        tauri_build::try_build(attributes).expect("failed to run Tauri build script");
    }
}

// `tauri.conf.json` is the single source of truth for the app version: the
// release pipeline rewrites it from the git tag (scripts/build-version.js) and
// Tauri's generated context feeds it to `package_info()` on desktop. Cargo.toml
// is never touched by that pipeline, so anything reading `CARGO_PKG_VERSION`
// reports a stale "0.1.0" — which is what the headless `bat-server` (no Tauri
// context) sent as `serverVersion`, making every desktop client flag a bogus
// version skew. Export the real version so both backings agree.
fn export_app_version() {
    let config_path = manifest_dir().join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", config_path.display());
    let raw = std::fs::read_to_string(&config_path).expect("read tauri.conf.json");
    let config: serde_json::Value = serde_json::from_str(&raw).expect("parse tauri.conf.json");
    let version = config
        .get("version")
        .and_then(|value| value.as_str())
        .expect("tauri.conf.json must declare a version");
    println!("cargo:rustc-env=BAT_APP_VERSION={version}");
}

fn manifest_dir() -> std::path::PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn ensure_bundle_mode_marker() {
    let marker = manifest_dir().join("target").join("bundle-mode.txt");
    if marker.is_file() {
        return;
    }
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent).expect("create bundle-mode marker directory");
    }
    std::fs::write(marker, "all-in-one\n").expect("write default bundle-mode marker");
}

fn configure_windows_common_controls_manifest() {
    if !is_windows_msvc_target() {
        return;
    }

    // The desktop dependency graph imports comctl32!TaskDialogIndirect. Cargo's
    // lib-test harness is a separate PE and does not inherit Tauri's normal
    // executable resource, so Windows loads legacy common controls and exits
    // before tests run with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). Embed the
    // same Common Controls v6 activation manifest through the linker for every
    // executable; Tauri's duplicate manifest resource is disabled above.
    let manifest = manifest_dir().join("windows-common-controls.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    // Match Tauri's previous resource manifest exactly instead of letting the
    // MSVC linker append an explicit requestedExecutionLevel element.
    println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

fn is_windows_msvc_target() -> bool {
    std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
}
