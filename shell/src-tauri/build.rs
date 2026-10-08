fn main() {
    // The app's one command gets its own permission (allow-open-lightbox), granted to the main window's page in
    // capabilities/default.json. With an app manifest, no app command is reachable without such a grant.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["open_lightbox"])))
        .expect("failed to run tauri-build");
}
