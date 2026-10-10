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

    // Declaring the app's commands puts every one of them behind the capability
    // ACL (instead of Tauri's default of allowing all app commands), so each
    // command is callable only where a capability grants it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "exo_desktop_smoke",
            "append_audio_chunk",
            "audio_file_size",
            "read_audio_chunk",
            "finalize_audio_file",
            "recorder_whisper_stage_audio",
            "recorder_whisper_cleanup_stages",
            "delete_audio_file",
            "recorder_start",
            "recorder_pause",
            "recorder_resume",
            "recorder_stop",
            "recorder_status",
            "recorder_list_inputs",
            "recorder_select_input",
            "recorder_recover",
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
            "recorder_auto_save_to_space_get",
            "recorder_auto_save_to_space_set",
        ]),
    ))
    .expect("failed to run tauri-build");
}
