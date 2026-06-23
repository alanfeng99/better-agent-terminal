fn main() {
    // Bake the bundle mode into the binary so the running app can tell whether
    // it is the "all-in-one" or "lightweight" build (the auto-updater picks the
    // matching update channel). The CI/build scripts export BAT_BUNDLE_MODE;
    // default to all-in-one for plain `cargo`/dev builds.
    let mode = std::env::var("BAT_BUNDLE_MODE").unwrap_or_else(|_| "all-in-one".to_string());
    println!("cargo:rustc-env=BAT_BUNDLE_MODE={mode}");
    println!("cargo:rerun-if-env-changed=BAT_BUNDLE_MODE");
    // Tauri's build-time codegen (context, capabilities, resource copy) is only
    // needed for the desktop shell. A headless `--no-default-features` build
    // links no tauri/wry (hence no webkit2gtk), so skip it there.
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
