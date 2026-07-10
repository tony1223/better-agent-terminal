fn main() {
    // Bundle mode is resolved from packaged resources at runtime. Keeping it
    // out of rustc's environment lets all-in-one and lightweight releases
    // share the same compiled application library.
    ensure_bundle_mode_marker();
    // Tauri's build-time codegen (context, capabilities, resource copy) is only
    // needed for the desktop shell. A headless `--no-default-features` build
    // links no tauri/wry (hence no webkit2gtk), so skip it there.
    #[cfg(feature = "desktop")]
    tauri_build::build();
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
