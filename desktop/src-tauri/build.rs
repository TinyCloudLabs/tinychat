fn main() {
    let production_env = include_str!("../../frontend/.env.production");
    let origin = std::env::var("VITE_EXO_PTX_UPLOAD_ORIGIN")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            production_env.lines().find_map(|line| {
                line.strip_prefix("VITE_EXO_PTX_UPLOAD_ORIGIN=")
                    .map(str::to_owned)
            })
        })
        .expect("VITE_EXO_PTX_UPLOAD_ORIGIN is required for the Mac uploader");
    println!("cargo:rustc-env=EXO_PTX_UPLOAD_ORIGIN={origin}");
    println!("cargo:rerun-if-env-changed=VITE_EXO_PTX_UPLOAD_ORIGIN");
    println!("cargo:rerun-if-changed=../../frontend/.env.production");
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

    // Declaring the app's commands puts every one of them behind the capability
    // ACL (instead of Tauri's default of allowing all app commands), so each
    // command is callable only where a capability grants it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "exo_desktop_smoke",
            "append_dev_log",
            "debug_logging_enabled",
            "google_oauth_listen",
            "google_oauth_wait",
            "google_oauth_cancel",
            "google_oauth_open_browser",
            "append_audio_chunk",
            "ptx_audio_metadata",
            "ptx_upload_audio",
            "ptx_cancel_audio_upload",
            "audio_file_size",
            "read_audio_chunk",
            "finalize_audio_file",
            "recorder_whisper_stage_audio",
            "recorder_whisper_start",
            "recorder_whisper_cleanup_stages",
            "delete_audio_file",
            "recorder_start",
            "recorder_pause",
            "recorder_resume",
            "recorder_stop",
            "recorder_stop_durable",
            "recorder_finish",
            "recorder_quit_anyway",
            "recorder_status",
            "recorder_list_inputs",
            "recorder_select_input",
            "recorder_recover",
            "recorder_stopped_list",
            "recorder_acknowledge",
            "recorder_failed_list",
            "recorder_failed_retry",
            "recorder_failed_delete",
            "recorder_models_list",
            "recorder_models_get",
            "recorder_models_select",
            "recorder_models_download",
            "recorder_models_progress",
            "recorder_system_audio_get",
            "recorder_system_audio_set",
            "recorder_system_audio_consent_get",
            "recorder_system_audio_consent_set",
        ]),
    ))
    .expect("failed to run tauri-build");
}
