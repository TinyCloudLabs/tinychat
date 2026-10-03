fn main() {
    // The anarlog swift-lib crates emit `-Wl,-rpath,<swift toolchain>` via
    // `cargo:rustc-link-arg`, but Cargo only applies rustc-link-arg to the
    // emitting package's own targets — the final `exo-desktop` binary/test
    // binary never gets them, so dyld can't find libswift_Concurrency at
    // launch. Point it at the OS Swift runtime (present on every macOS the
    // bundle supports, minimumSystemVersion 14.2); never at the build
    // machine's Xcode toolchain, which users don't have.
    #[cfg(all(target_os = "macos", feature = "transcription"))]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        }
    }

    // The private cloud engine only talks to the backend the bundled frontend
    // was built for: the same VITE_BACKEND_URL, read from the environment or
    // else from frontend/.env.production (what `tauri build` bakes in).
    println!("cargo:rustc-env=EXO_BACKEND_URL={}", backend_url());

    // Declaring the app's commands puts every one of them behind the capability
    // ACL (instead of Tauri's default of allowing all app commands), so each
    // command is callable only where a capability grants it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "exo_desktop_smoke",
            "cloud_transcription_status",
            "cloud_transcription_submit",
            "cloud_transcription_cancel",
        ]),
    ))
    .expect("failed to run tauri-build");
}

fn backend_url() -> String {
    println!("cargo:rerun-if-env-changed=VITE_BACKEND_URL");
    if let Ok(url) = std::env::var("VITE_BACKEND_URL") {
        if !url.trim().is_empty() {
            return url.trim().to_string();
        }
    }
    let env_file =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/.env.production");
    println!("cargo:rerun-if-changed={}", env_file.display());
    let contents = std::fs::read_to_string(&env_file)
        .unwrap_or_else(|e| panic!("reading {}: {e}", env_file.display()));
    contents
        .lines()
        .filter_map(|line| line.trim().strip_prefix("VITE_BACKEND_URL="))
        .map(|value| value.trim().trim_matches('"').to_string())
        .next_back()
        .unwrap_or_else(|| panic!("VITE_BACKEND_URL is not set in {}", env_file.display()))
}
