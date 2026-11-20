//! "Record this call": offer to record when a call starts.
//!
//! The logic is in the `call-prompt` crate (`service`, `session`), which is tested without a Mac.
//! This file only connects it to the app: the recorder's state, the setting, the watcher's thread
//! and the commands. Nothing here can fail, delay or crash a recording: every failure is logged
//! and dropped, the recorder is read with brief locks, and the log carries the stage and the kind
//! of call app, never an app's id.

use std::time::Duration;

use call_prompt::service::{self, Report, Worker};
use call_prompt::session::Action;
use call_prompt::tile::Setting;
use tauri::Manager;

/// The watcher changes nothing outside the app, so quitting hardly waits for it.
const STOP_WAIT: Duration = Duration::from_millis(200);

/// The app, as the watcher sees it.
struct Host(tauri::AppHandle);

impl service::Host for Host {
    fn recording(&self) -> bool {
        crate::recorder::engine::recording_in_progress(&self.0)
    }

    fn live(&self) -> bool {
        crate::recorder::engine::live_capture(&self.0).is_some()
    }

    fn act(&self, _action: Action) {
        // The tile comes with its window.
    }

    // The watcher's thread lives as long as the app; a pool per tick keeps what the system
    // calls autorelease from piling up.
    #[cfg(target_os = "macos")]
    fn scope(&self, tick: &mut dyn FnMut()) {
        objc2::rc::autoreleasepool(|_| tick())
    }

    fn report(&self, report: &Report) {
        tracing::info!(target: "exo_dev::call_prompt", stage = report.stage.as_str(),
            kind = report.kind.map_or("none", |kind| kind.as_str()), error = ?report.error);
    }
}

type Prompt = Worker<Host>;

/// Starts the watcher's thread, switched off, then turns it on if the setting is on. While the
/// setting is off the thread sleeps and reads nothing. Only macOS can tell which app uses the
/// microphone, so elsewhere there is no thread.
pub fn start(app: &tauri::AppHandle) {
    if !call_prompt::mic::SUPPORTED {
        return;
    }
    match service::spawn(Host(app.clone())) {
        Ok(worker) => {
            app.manage(worker);
        }
        Err(error) => {
            tracing::error!(target: "exo_dev::call_prompt", operation = "start", error = %error);
            return;
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::recorder::extras::call_prompt(&app).await {
            Ok(enabled) => {
                if let Some(prompt) = app.try_state::<Prompt>() {
                    prompt.set_enabled(enabled);
                }
            }
            // Unreadable settings: the offer stays off.
            Err(error) => {
                tracing::warn!(target: "exo_dev::call_prompt", operation = "load_setting",
                    error = %error);
            }
        }
    });
}

/// Stops the watcher's thread as the app exits.
pub fn stop(app: &tauri::AppHandle) {
    if let Some(prompt) = app.try_state::<Prompt>() {
        prompt.stop(STOP_WAIT);
    }
}

/// The setting, and whether this Mac can make the offer.
#[tauri::command]
pub async fn call_prompt_get(app: tauri::AppHandle) -> Result<Setting, String> {
    Ok(Setting {
        enabled: crate::recorder::extras::call_prompt(&app).await?,
        supported: call_prompt::mic::SUPPORTED,
    })
}

/// Saves the setting, then turns the watcher on or off. Off hides the tile at once.
#[tauri::command]
pub async fn call_prompt_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    crate::recorder::extras::set_call_prompt(&app, enabled).await?;
    if let Some(prompt) = app.try_state::<Prompt>() {
        prompt.set_enabled(enabled);
    }
    Ok(())
}
