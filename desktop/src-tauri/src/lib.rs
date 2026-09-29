#[cfg(all(feature = "transcription", debug_assertions))]
mod smoke;

pub fn run() {
    let builder = tauri::Builder::default();

    // anarlog (MIT) transcription stack: local capture + on-device Whisper.
    // Ordering is load-bearing:
    //   1. `manage(Arc<dyn AudioProvider>)` — tauri-plugin-transcription's setup
    //      calls `app.state::<Arc<dyn AudioProvider>>()` and panics without it.
    //   2. `tauri_plugin_settings` — `vault_base()` (session audio dir) reads the
    //      StartupSnapshot this plugin manages, and local-stt resolves the models
    //      dir through it.
    // The transcription permissions live in `capabilities-transcription/` and are
    // injected at runtime below, so a build without the feature never fails
    // permission validation for commands it does not have.
    #[cfg(feature = "transcription")]
    let builder = {
        use tauri::Manager;

        let builder = builder
            .manage(std::sync::Arc::new(audio_actual::ActualAudio)
                as std::sync::Arc<dyn audio_actual::AudioProvider>)
            .plugin(tauri_plugin_settings::init())
            .plugin(tauri_plugin_transcription::init())
            .plugin(tauri_plugin_local_stt::init(
                tauri_plugin_local_stt::InitOptions::default(),
            ));

        // Debug-only diagnostic: lets the webview verify the native wiring
        // in one invoke before any recording is attempted.
        #[cfg(debug_assertions)]
        let builder = builder.invoke_handler(tauri::generate_handler![smoke::exo_desktop_smoke]);

        builder.setup(|app| {
            app.add_capability(include_str!(
                "../capabilities-transcription/transcription.json"
            ))?;
            // EXO_SMOKE=1 runs real plugin invokes in the webview (debug only).
            #[cfg(debug_assertions)]
            smoke::maybe_run(app);
            Ok(())
        })
    };

    builder
        .run(tauri::generate_context!())
        .expect("error while running Exo");
}
