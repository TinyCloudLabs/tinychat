#[cfg(feature = "transcription")]
mod cloud;
#[cfg(feature = "transcription")]
mod recorder;
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

        let system_audio = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let meter = std::sync::Arc::new(std::sync::Mutex::new(
            recorder::audio_provider::Meter::default(),
        ));
        let builder = builder
            .manage(system_audio.clone())
            .manage(meter.clone())
            .manage(
                std::sync::Arc::new(recorder::audio_provider::SelectableAudio::new(
                    system_audio,
                    meter,
                )) as std::sync::Arc<dyn audio_actual::AudioProvider>,
            )
            .plugin(tauri_plugin_settings::init())
            .plugin(tauri_plugin_transcription::init())
            .plugin(tauri_plugin_local_stt::init(
                tauri_plugin_local_stt::InitOptions::default(),
            ));

        // App commands. build.rs declares them in the app ACL manifest, so each
        // one is callable only where a capability grants it: the private cloud
        // commands by capabilities-transcription/, the debug smoke below.
        #[cfg(not(debug_assertions))]
        let builder = builder.invoke_handler(tauri::generate_handler![
            cloud::commands::cloud_transcription_status,
            cloud::commands::cloud_transcription_submit,
            cloud::commands::cloud_transcription_cancel,
            cloud::commands::cloud_transcription_reopen,
            recorder::files::append_audio_chunk,
            recorder::files::audio_file_size,
            recorder::files::read_audio_chunk,
            recorder::files::finalize_audio_file,
            recorder::files::delete_audio_file,
            recorder::engine::recorder_start,
            recorder::engine::recorder_pause,
            recorder::engine::recorder_resume,
            recorder::engine::recorder_stop,
            recorder::engine::recorder_status,
            recorder::engine::recorder_list_inputs,
            recorder::engine::recorder_select_input,
            recorder::engine::recorder_recover,
            recorder::engine::recorder_acknowledge,
            recorder::engine::recorder_failed_list,
            recorder::engine::recorder_failed_retry,
            recorder::engine::recorder_failed_delete,
            recorder::extras::recorder_models_list,
            recorder::extras::recorder_models_get,
            recorder::extras::recorder_models_select,
            recorder::extras::recorder_models_download,
            recorder::extras::recorder_models_progress,
            recorder::extras::recorder_system_audio_get,
            recorder::extras::recorder_system_audio_set,
            recorder::extras::recorder_auto_save_to_space_get,
            recorder::extras::recorder_auto_save_to_space_set,
        ]);
        // Debug builds add a diagnostic that lets the webview verify the
        // native wiring in one invoke before any recording is attempted.
        #[cfg(debug_assertions)]
        let builder = builder.invoke_handler(tauri::generate_handler![
            cloud::commands::cloud_transcription_status,
            cloud::commands::cloud_transcription_submit,
            cloud::commands::cloud_transcription_cancel,
            cloud::commands::cloud_transcription_reopen,
            recorder::files::append_audio_chunk,
            recorder::files::audio_file_size,
            recorder::files::read_audio_chunk,
            recorder::files::finalize_audio_file,
            recorder::files::delete_audio_file,
            recorder::engine::recorder_start,
            recorder::engine::recorder_pause,
            recorder::engine::recorder_resume,
            recorder::engine::recorder_stop,
            recorder::engine::recorder_status,
            recorder::engine::recorder_list_inputs,
            recorder::engine::recorder_select_input,
            recorder::engine::recorder_recover,
            recorder::engine::recorder_acknowledge,
            recorder::engine::recorder_failed_list,
            recorder::engine::recorder_failed_retry,
            recorder::engine::recorder_failed_delete,
            recorder::extras::recorder_models_list,
            recorder::extras::recorder_models_get,
            recorder::extras::recorder_models_select,
            recorder::extras::recorder_models_download,
            recorder::extras::recorder_models_progress,
            recorder::extras::recorder_system_audio_get,
            recorder::extras::recorder_system_audio_set,
            recorder::extras::recorder_auto_save_to_space_get,
            recorder::extras::recorder_auto_save_to_space_set,
            smoke::exo_desktop_smoke,
        ]);

        builder.setup(|app| {
            app.manage(recorder::engine::Engine::default());
            app.manage(recorder::extras::ExtrasState::default());
            recorder::engine::install(app);
            recorder::extras::install(app);
            tauri::async_runtime::block_on(recorder::extras::load_system_audio(app.handle()))
                .map_err(std::io::Error::other)?;
            app.add_capability(include_str!(
                "../capabilities-transcription/transcription.json"
            ))?;
            // Private cloud engine: inert (no listener, no file access) unless
            // a PTX origin is compiled in.
            cloud::install(app);
            // EXO_SMOKE=1 runs real plugin invokes in the webview (debug only).
            #[cfg(debug_assertions)]
            {
                app.add_capability(smoke::SMOKE_CAPABILITY)?;
                smoke::maybe_run(app);
            }
            Ok(())
        })
    };

    builder
        .run(tauri::generate_context!())
        .expect("error while running Exo");
}
