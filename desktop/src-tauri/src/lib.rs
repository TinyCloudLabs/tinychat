pub fn run() {
    let builder = tauri::Builder::default();

    // anarlog (MIT) transcription stack: local capture + on-device Whisper.
    // See desktop/README.md for how to enable and call these from the frontend.
    #[cfg(feature = "transcription")]
    let builder = builder
        .plugin(tauri_plugin_transcription::init())
        .plugin(tauri_plugin_local_stt::init(
            tauri_plugin_local_stt::InitOptions::default(),
        ));

    builder
        .run(tauri::generate_context!())
        .expect("error while running Exo");
}
