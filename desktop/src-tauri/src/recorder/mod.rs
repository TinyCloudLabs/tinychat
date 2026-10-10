pub mod audio_provider;
pub mod engine;
pub mod extras;
pub mod files;
pub mod journal;

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
}
