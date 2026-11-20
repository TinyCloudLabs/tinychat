//! "Record this call": offer to record when a call starts.
//!
//! The logic is in the `call-prompt` crate (`service`, `session`), which is tested without a Mac.
//! This file only connects it to the app: the recorder's state, the setting, the watcher's thread,
//! the tile (`panel`) and the commands. Nothing here can fail, delay or crash a recording: every
//! failure is logged and dropped, the recorder is read with brief locks, the watcher hands all
//! work off without waiting, and the log carries the stage and the kind of call app, never an
//! app's id.
//!
//! "Start" uses the menu-bar item's start request (`record_launch`), so the web app's recorder
//! starts the recording as it does for the shortcut. The main window comes forward first only
//! when the start needs the user: this Mac's audio is on and its consent was never given. When
//! the recording does not capture within 8 s, the watcher brings the main window forward.

use std::time::Duration;

use call_prompt::service::{self, Report, Worker};
use call_prompt::session::{Action, Phase};
use call_prompt::status::StatusFile;
use call_prompt::tile::{self, Setting, TileState};
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
mod panel;

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

    fn act(&self, action: Action) {
        let app = &self.0;
        match action {
            Action::Phase(phase) => {
                if let Err(error) =
                    app.emit_to(tile::WINDOW_LABEL, tile::EVENT, TileState { phase })
                {
                    tracing::warn!(target: "exo_dev::call_prompt", operation = "emit",
                        error = %error);
                }
            }
            Action::Show => show_tile(app),
            Action::Hide => hide_tile(app),
            Action::Prepare => prepare_tile(app),
            Action::Start => start_recording(app),
            Action::Present => {
                let handle = app.clone();
                if let Err(error) =
                    app.run_on_main_thread(move || crate::record_launch::show_main(&handle))
                {
                    tracing::warn!(target: "exo_dev::call_prompt", operation = "present",
                        error = %error);
                }
            }
        }
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

#[cfg(target_os = "macos")]
fn show_tile(app: &tauri::AppHandle) {
    panel::show(app);
}

#[cfg(target_os = "macos")]
fn hide_tile(app: &tauri::AppHandle) {
    panel::hide(app);
}

/// Has the tile's window made, hidden. A new window's page has not asked for its state yet, so
/// the watcher waits for it before it shows the tile.
#[cfg(target_os = "macos")]
fn prepare_tile(app: &tauri::AppHandle) {
    panel::prepare(app, |app| {
        if let Some(prompt) = app.try_state::<Prompt>() {
            prompt.window_created();
        }
    });
}

// No watcher runs elsewhere, so nothing asks for the tile.
#[cfg(not(target_os = "macos"))]
fn show_tile(_app: &tauri::AppHandle) {}

#[cfg(not(target_os = "macos"))]
fn hide_tile(_app: &tauri::AppHandle) {}

#[cfg(not(target_os = "macos"))]
fn prepare_tile(_app: &tauri::AppHandle) {}

/// "Start": the start request of the menu-bar item, on a task, so the watcher never waits. With
/// this Mac's audio on and no consent yet, the main window comes forward first, where the
/// recorder asks for it.
fn start_recording(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ask_first = crate::recorder::extras::system_audio_needs_consent(&app)
            .await
            .unwrap_or(true);
        if ask_first {
            crate::record_launch::show_main(&app);
        }
        crate::record_launch::request_start(&app);
    });
}

/// Starts the watcher's thread, switched off, then turns it on if the setting is on. While the
/// setting is off the thread sleeps and reads nothing. Only macOS can tell which app uses the
/// microphone, so elsewhere there is no thread.
pub fn start(app: &tauri::AppHandle) {
    if !call_prompt::mic::SUPPORTED {
        return;
    }
    match service::spawn(Host(app.clone())) {
        Ok(worker) => {
            // `<app data>/voice-notes/call-prompt/_status.json`, beside the names feature's own:
            // what the watcher last did, for builds without a log.
            match app.path().app_data_dir() {
                Ok(app_data) => worker.keep_status(StatusFile::in_app_data(&app_data)),
                Err(error) => {
                    tracing::warn!(target: "exo_dev::call_prompt", operation = "status_file",
                        error = %error);
                }
            }
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

/// The web app claimed a start request. After a "Start" on the tile, the status file says how
/// long that took.
pub(crate) fn start_claimed(app: &tauri::AppHandle) {
    if let Some(prompt) = app.try_state::<Prompt>() {
        prompt.start_claimed();
    }
}

/// Stops the watcher's thread as the app exits.
pub fn stop(app: &tauri::AppHandle) {
    if let Some(prompt) = app.try_state::<Prompt>() {
        prompt.stop(STOP_WAIT);
    }
}

/// The tile is a second window, so closing the main window would leave the app running with
/// only the hidden tile. Quit as Tauri does when its last window closes, unless a recording is
/// finishing: then the exit is held, as `lib.rs` holds a user's exit.
pub fn main_window_destroyed(app: &tauri::AppHandle) {
    if app.get_webview_window(tile::WINDOW_LABEL).is_none()
        || crate::FINISHING_QUIT.load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    app.exit(0);
}

/// What the tile shows. The tile asks once it listens to `exo://call-prompt`; that first ask is
/// how the watcher knows the page has loaded, so the window shows only after it.
#[tauri::command]
pub async fn call_prompt_state(app: tauri::AppHandle, window: tauri::WebviewWindow) -> TileState {
    let phase = match app.try_state::<Prompt>() {
        Some(prompt) if window.label() == tile::WINDOW_LABEL => prompt.page_asked(),
        Some(prompt) => prompt.phase(),
        None => Phase::Hidden,
    };
    TileState { phase }
}

/// "Start" on the tile. The tile hears a phase back on `exo://call-prompt`; an error turns its
/// buttons back on.
#[tauri::command]
pub async fn call_prompt_start(app: tauri::AppHandle) -> Result<(), String> {
    let prompt = app
        .try_state::<Prompt>()
        .ok_or_else(|| "call_prompt_unavailable".to_string())?;
    prompt.start();
    Ok(())
}

/// "Not now" on the tile: no offer again in this call.
#[tauri::command]
pub async fn call_prompt_dismiss(app: tauri::AppHandle) -> Result<(), String> {
    let prompt = app
        .try_state::<Prompt>()
        .ok_or_else(|| "call_prompt_unavailable".to_string())?;
    prompt.dismiss();
    Ok(())
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
