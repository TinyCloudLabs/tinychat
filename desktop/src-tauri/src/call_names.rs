//! Names in the call: runs the `call-names` reader beside the recorder and serves its commands.
//!
//! The logic is in the `call-names` crate (`service`), which is tested without a Mac. This file
//! only connects it to the app: the live capture, the running meeting apps, the reader's thread
//! and six commands. Nothing here can fail or delay a recording, and no name is logged.
//!
//! The speaking timeline of a recording (who spoke when, as person ids and times) is read by
//! `call_names_speaking_read`. Saving the note (`call_names_clear`) leaves it, for a new
//! transcription; it goes with the recording's audio (`forget`) or after 30 days.

use std::time::Duration;

use call_names::ax::{self, Permission, RunningApp};
use call_names::roster::CallParticipants;
use call_names::service::{self, Live, Report, Store, Worker};
use call_names::timeline::Timeline;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// Privacy & Security > Accessibility in System Settings. Fixed here, so the webview cannot
/// choose what opens.
const ACCESSIBILITY_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
/// How long quitting waits for the reader to put back what it changed in a browser.
const STOP_WAIT: Duration = Duration::from_secs(2);

/// The app, as the reader's service sees it.
struct Host(tauri::AppHandle);

impl service::Host for Host {
    fn live(&self) -> Option<Live> {
        let (id, channels, recorded_ms) = crate::recorder::engine::live_capture(&self.0)?;
        Some(Live {
            id,
            channels,
            recorded_ms,
        })
    }

    fn running(&self, bundle_id: &str) -> Vec<RunningApp> {
        running(bundle_id)
    }

    // The reader's thread lives as long as the app; without a pool per tick, what the system
    // calls autorelease would pile up until the app quits.
    #[cfg(target_os = "macos")]
    fn scope(&self, tick: &mut dyn FnMut()) {
        objc2::rc::autoreleasepool(|_| tick())
    }

    fn report(&self, report: &Report) {
        tracing::info!(target: "exo_dev::call_names", outcome = %report.outcome,
            nodes = report.nodes, elapsed_ms = report.elapsed_ms, sources = %report.sources,
            people = report.people, guessed = report.guessed, saved = report.saved,
            error = ?report.error);
    }
}

/// The running apps with this bundle id. The process id and the bundle id of each come from the
/// same `NSRunningApplication`, as the reader requires.
#[cfg(target_os = "macos")]
fn running(bundle_id: &str) -> Vec<RunningApp> {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;

    NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id))
        .to_vec()
        .into_iter()
        .filter(|app| !app.isTerminated())
        .filter_map(|app| {
            Some(RunningApp {
                pid: app.processIdentifier(),
                bundle_id: app.bundleIdentifier()?.to_string(),
            })
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn running(_bundle_id: &str) -> Vec<RunningApp> {
    Vec::new()
}

/// `<app data>/voice-notes/call-names`: one names file per recording, and the setting.
fn store(app: &tauri::AppHandle) -> Result<Store, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(Store::in_app_data(&app_data))
}

/// Starts the reader's thread. It reads nothing until a recording of both sides is live and the
/// setting is on. Only macOS can read a meeting window, so elsewhere there is no thread.
pub fn start(app: &tauri::AppHandle) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let worker = store(app).and_then(|store| {
        service::spawn(store, Host(app.clone())).map_err(|error| error.to_string())
    });
    match worker {
        Ok(worker) => {
            app.manage(worker);
        }
        Err(error) => {
            tracing::error!(target: "exo_dev::call_names", operation = "start", error = %error);
        }
    }
}

/// Stops the reader's thread as the app exits, so that a browser gets its accessibility flag
/// back.
pub fn stop(app: &tauri::AppHandle) {
    if let Some(worker) = app.try_state::<Worker>() {
        worker.stop(STOP_WAIT);
    }
}

/// The names and the speaking timeline of a recording go with its audio. A failure is logged,
/// never returned.
pub(crate) fn forget(app: &tauri::AppHandle, id: &str) {
    let cleared = store(app).and_then(|store| store.forget(id).map_err(|error| error.to_string()));
    if let Err(error) = cleared {
        tracing::warn!(target: "exo_dev::call_names", operation = "forget", error = %error);
    }
}

/// Runs a call on the store on a blocking worker, as the recorder's disk commands do: a write
/// waits for the disk.
async fn with_store<T: Send + 'static>(
    app: tauri::AppHandle,
    call: impl FnOnce(Store) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || call(store(&app)?))
        .await
        .map_err(|error| error.to_string())?
}

/// The setting, and whether macOS lets the app read other apps' windows. Never prompts.
#[tauri::command]
pub async fn call_names_get(app: tauri::AppHandle) -> Result<service::State, String> {
    with_store(app, |store| Ok(service::state(&store))).await
}

#[tauri::command]
pub async fn call_names_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    with_store(app, move |store| {
        store
            .set_enabled(enabled)
            .map_err(|error| error.to_string())?;
        // Turning it on has macOS show its Accessibility prompt when the permission is missing.
        if enabled && ax::permission() == Permission::Missing {
            ax::request_permission();
        }
        Ok(())
    })
    .await
}

/// Opens System Settings at Accessibility, never a place the webview names.
#[tauri::command]
pub async fn call_names_open_settings(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(ACCESSIBILITY_SETTINGS_URL, None::<&str>)
        .map_err(|_| "Could not open System Settings".into())
}

/// The `call_participants` object of the recording `id`, or null when nobody was read.
#[tauri::command]
pub async fn call_names_read(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<CallParticipants>, String> {
    with_store(app, move |store| {
        store.read(&id).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn call_names_clear(app: tauri::AppHandle, id: String) -> Result<(), String> {
    with_store(app, move |store| {
        store.clear(&id).map_err(|error| error.to_string())
    })
    .await
}

/// The speaking timeline of the recording `id` (person ids and times on the recording's clock),
/// or null when there is none. Saving the note does not remove it.
#[tauri::command]
pub async fn call_names_speaking_read(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<Timeline>, String> {
    with_store(app, move |store| {
        store.read_speaking(&id).map_err(|error| error.to_string())
    })
    .await
}
