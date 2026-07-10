fn main() {
    // Bundle mode is resolved from packaged resources at runtime. Keeping it
    // out of rustc's environment lets all-in-one and lightweight releases
    // share the same compiled application library.
    ensure_bundle_mode_marker();
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

fn ensure_bundle_mode_marker() {
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let marker = manifest_dir.join("target").join("bundle-mode.txt");
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
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let manifest = manifest_dir.join("windows-common-controls.manifest");
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
