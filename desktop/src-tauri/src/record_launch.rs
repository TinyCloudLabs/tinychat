//! Start a recording from outside the window: a global keyboard shortcut and
//! the menu-bar (tray) item. Both bring the main window forward and ask the web
//! app to start recording through its own Record action (RecorderProvider), so
//! there is one recording path. Both are registered here in Rust: no capability
//! grants the global-shortcut or tray commands to the webview.
//!
//! A request is held here until the web app claims it with
//! `recorder_take_start_request`. The event only prompts the claim, so a press
//! made while the webview is still loading (or reloading) is not lost, and a
//! press is acted on at most once.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// ⌘⇧⌥R on macOS, Ctrl+Shift+Alt+R elsewhere. A global shortcut fires in every
/// app, so it takes three modifiers: Cmd+Shift+R is a browser's hard reload,
/// Cmd+Shift+5 the system screen recorder.
pub const RECORD_SHORTCUT: &str = "CommandOrControl+Shift+Alt+R";
/// Prompts the web app to claim the request (`recorder_take_start_request`).
pub const START_REQUESTED_EVENT: &str = "exo://recorder-start-requested";

/// Long enough for a webview still loading at launch to subscribe and claim a
/// request; short enough that a reload minutes later never starts a recording
/// nobody just asked for.
const START_REQUEST_TTL: Duration = Duration::from_secs(15);

/// The latest unclaimed Start recording request.
#[derive(Default)]
pub struct StartRequest(Mutex<Option<Instant>>);

impl StartRequest {
    fn request(&self, at: Instant) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(at);
    }

    fn take(&self, now: Instant) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .is_some_and(|at| now.saturating_duration_since(at) <= START_REQUEST_TTL)
    }
}

/// True once per request: the web app then starts (or shows) the recorder.
#[tauri::command]
pub fn recorder_take_start_request(request: tauri::State<'_, StartRequest>) -> bool {
    request.take(Instant::now())
}

const MENU_RECORD: &str = "record";
const MENU_OPEN: &str = "open";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Launch {
    Record,
    Open,
}

fn menu_launch(id: &str) -> Option<Launch> {
    match id {
        MENU_RECORD => Some(Launch::Record),
        MENU_OPEN => Some(Launch::Open),
        _ => None,
    }
}

/// One recording per press: the key's release does nothing.
fn shortcut_launch(state: ShortcutState) -> Option<Launch> {
    (state == ShortcutState::Pressed).then_some(Launch::Record)
}

fn launch<R: Runtime>(app: &AppHandle<R>, launch: Launch) {
    if let Some(window) = app.get_webview_window("main") {
        for (operation, result) in [
            ("show", window.show()),
            ("unminimize", window.unminimize()),
            ("set_focus", window.set_focus()),
        ] {
            if let Err(error) = result {
                tracing::warn!(target: "exo_dev::record_launch", operation, error = %error);
            }
        }
    }
    if launch == Launch::Record {
        app.state::<StartRequest>().request(Instant::now());
        if let Err(error) = app.emit(START_REQUESTED_EVENT, ()) {
            tracing::warn!(target: "exo_dev::record_launch", operation = "emit", error = %error);
        }
    }
}

/// Registers the shortcut and the menu-bar item. A shortcut another app already
/// owns is logged and skipped: the menu-bar item still starts a recording.
pub fn install<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    app.handle()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
    if let Err(error) =
        app.global_shortcut()
            .on_shortcut(RECORD_SHORTCUT, |app, _shortcut, event| {
                if let Some(action) = shortcut_launch(event.state) {
                    launch(app, action);
                }
            })
    {
        tracing::warn!(target: "exo_dev::record_launch", operation = "register_shortcut",
            shortcut = RECORD_SHORTCUT, error = %error);
    }

    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(
                app,
                MENU_RECORD,
                "Start recording",
                true,
                Some(RECORD_SHORTCUT),
            )?,
            &MenuItem::with_id(app, MENU_OPEN, "Open TinyCloud Home", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("exo-record")
        .icon(Image::from_bytes(include_bytes!(
            "../icons/tray-record-template.png"
        ))?)
        .icon_as_template(true)
        .tooltip("TinyCloud Home")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            if let Some(action) = menu_launch(event.id().as_ref()) {
                launch(app, action);
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    #[test]
    fn record_shortcut_is_command_or_control_shift_alt_r() {
        let shortcut: Shortcut = RECORD_SHORTCUT.parse().unwrap();
        let primary = if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
        assert_eq!(
            shortcut,
            Shortcut::new(
                Some(primary | Modifiers::SHIFT | Modifiers::ALT),
                Code::KeyR
            )
        );
    }

    #[test]
    fn only_the_press_starts_a_recording() {
        assert_eq!(
            shortcut_launch(ShortcutState::Pressed),
            Some(Launch::Record)
        );
        assert_eq!(shortcut_launch(ShortcutState::Released), None);
    }

    #[test]
    fn menu_items_route_to_record_and_open() {
        assert_eq!(menu_launch(MENU_RECORD), Some(Launch::Record));
        assert_eq!(menu_launch(MENU_OPEN), Some(Launch::Open));
        assert_eq!(menu_launch("quit"), None);
    }

    #[test]
    fn a_request_is_claimed_once_and_only_while_fresh() {
        let request = StartRequest::default();
        let at = Instant::now();
        assert!(!request.take(at));
        request.request(at);
        assert!(request.take(at + START_REQUEST_TTL));
        assert!(!request.take(at + START_REQUEST_TTL));
        request.request(at);
        assert!(!request.take(at + START_REQUEST_TTL + Duration::from_millis(1)));
        assert!(!request.take(at));
    }

    #[test]
    fn the_web_listener_uses_the_event_and_the_claim_command() {
        let listener = include_str!("../../../frontend/src/capture/recorder/recordShortcut.ts");
        assert!(listener.contains(&format!("\"{START_REQUESTED_EVENT}\"")));
        assert!(listener.contains("\"recorder_take_start_request\""));
    }
}
