pub mod audio_provider;
pub mod engine;
pub mod extras;
pub mod files;
pub mod journal;
mod silence_sender;

pub struct RecorderRuntime(std::sync::Once);

impl Default for RecorderRuntime {
    fn default() -> Self {
        Self(std::sync::Once::new())
    }
}

pub fn ensure(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.state::<RecorderRuntime>().0.call_once(|| {
        app.manage(engine::Engine::default());
        app.manage(extras::ExtrasState::default());
        engine::install(app);
        extras::install(app);
    });
}

#[cfg(test)]
mod tests {
    use super::RecorderRuntime;

    #[test]
    fn setup_leaves_recorder_runtime_uninitialized() {
        assert!(!RecorderRuntime::default().0.is_completed());
    }

    #[test]
    fn recorder_commands_are_async_and_disk_commands_use_blocking_workers() {
        let files = include_str!("files.rs");
        let engine = include_str!("engine.rs");
        let extras = include_str!("extras.rs");
        for source in [files, engine, extras] {
            for command in source.split("#[tauri::command]").skip(1) {
                assert!(
                    command.trim_start().starts_with("pub async fn "),
                    "synchronous recorder command: {}",
                    command.lines().next().unwrap_or("")
                );
            }
        }
        for (source, names) in [
            (
                files,
                &[
                    "append_audio_chunk",
                    "audio_file_size",
                    "read_audio_chunk",
                    "finalize_audio_file",
                    "recorder_whisper_cleanup_stages",
                    "delete_audio_file",
                ][..],
            ),
            (
                engine,
                &[
                    "recorder_recover",
                    "recorder_acknowledge",
                    "recorder_failed_list",
                    "recorder_failed_retry",
                    "recorder_failed_delete",
                ][..],
            ),
        ] {
            for name in names {
                let body = source
                    .split(&format!("pub async fn {name}"))
                    .nth(1)
                    .unwrap();
                let body = body.split("#[tauri::command]").next().unwrap();
                assert!(
                    body.contains("spawn_blocking(move ||"),
                    "{name} must use a blocking worker"
                );
            }
        }
        let pause = engine
            .split("pub async fn recorder_pause")
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(pause.contains("run_segment_import(move ||"));
        assert!(pause.contains("import_finished_segment(&handle"));
    }
}
