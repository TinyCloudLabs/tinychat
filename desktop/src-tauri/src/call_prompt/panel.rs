//! The tile's window: a small `NSPanel` (tauri-nspanel), built hidden the first time it shows,
//! docked at the right edge of the screen that holds the mouse and vertically centred.
//!
//! It never takes the keyboard: its class cannot become the key or the main window, its style is
//! non-activating, and it accepts the first click without activating the app. So typing in the
//! call goes on while it shows. It floats above full-screen apps on every Space, does not hide
//! when the app is in the background, and asks not to be captured by screen sharing.
//!
//! Two traps of tauri-nspanel 2.1 (`acb3ec1`):
//! - `no_activate(true)` changes the app's activation policy while it builds the window. Not
//!   used: the window is built hidden and never focused instead.
//! - Its `Panel` methods do not go to the main thread by themselves, whatever the docs say. Every
//!   call here runs through `run_on_main_thread`, nothing waits for it, and a panic in it is
//!   caught and logged.
//!
//! The page (`call-prompt.html`) is transparent and fills the window, so the window is the tile.

use std::panic::{catch_unwind, AssertUnwindSafe};

use call_prompt::tile::{self, Area};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewUrl, Wry};
use tauri_nspanel::{
    CollectionBehavior, ManagerExt, PanelBuilder, PanelHandle, PanelLevel, StyleMask,
    WebviewPanelManager,
};

mod class {
    tauri_nspanel::tauri_panel! {
        panel!(CallPromptPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })
    }
}

use class::CallPromptPanel;

/// Docks the tile and shows it, without focus. Builds it the first time.
pub fn show(app: &AppHandle) {
    on_main(app, "show", |app| {
        let Some(panel) = panel(app) else {
            return;
        };
        dock(app);
        panel.show();
    });
}

/// Builds the tile's window, hidden, when it is not built yet, so that its page loads before the
/// tile is shown. `created` runs on the main thread right after a new window is made.
pub fn prepare(app: &AppHandle, created: impl FnOnce(&AppHandle) + Send + 'static) {
    on_main(app, "prepare", |app| {
        if existing(app).is_none() && panel(app).is_some() {
            created(app);
        }
    });
}

/// Hides the tile. It stays built, hidden, for the next call.
pub fn hide(app: &AppHandle) {
    on_main(app, "hide", |app| {
        if let Some(panel) = existing(app) {
            panel.hide();
        }
    });
}

/// Runs `work` on the main thread, later. Never waits; a panic in `work` is caught and logged.
fn on_main(
    app: &AppHandle,
    operation: &'static str,
    work: impl FnOnce(&AppHandle) + Send + 'static,
) {
    let handle = app.clone();
    let dispatched = app.run_on_main_thread(move || {
        if catch_unwind(AssertUnwindSafe(|| work(&handle))).is_err() {
            tracing::error!(target: "exo_dev::call_prompt", operation, phase = "panicked");
        }
    });
    if let Err(error) = dispatched {
        tracing::warn!(target: "exo_dev::call_prompt", operation, error = %error);
    }
}

/// The tile's panel, if it was built. `None` without the nspanel plugin.
fn existing(app: &AppHandle) -> Option<PanelHandle<Wry>> {
    app.try_state::<WebviewPanelManager<Wry>>()?;
    app.get_webview_panel(tile::WINDOW_LABEL).ok()
}

/// The tile's panel, built hidden on first use.
fn panel(app: &AppHandle) -> Option<PanelHandle<Wry>> {
    if let Some(panel) = existing(app) {
        return Some(panel);
    }
    // No plugin, or a window with the tile's label that is not the panel: leave it alone.
    if app.try_state::<WebviewPanelManager<Wry>>().is_none()
        || app.get_webview_window(tile::WINDOW_LABEL).is_some()
    {
        return None;
    }
    match build(app) {
        Ok(panel) => Some(panel),
        Err(error) => {
            tracing::warn!(target: "exo_dev::call_prompt", operation = "build_tile",
                error = %error);
            None
        }
    }
}

fn build(app: &AppHandle) -> tauri::Result<PanelHandle<Wry>> {
    PanelBuilder::<_, CallPromptPanel>::new(app, tile::WINDOW_LABEL)
        .url(WebviewUrl::App(tile::PAGE.into()))
        .title("Record this call")
        .size(Size::Logical(LogicalSize::new(tile::WIDTH, tile::HEIGHT)))
        .resizable(false)
        .level(PanelLevel::Floating)
        .has_shadow(false)
        .hides_on_deactivate(false)
        .collection_behavior(
            CollectionBehavior::new()
                .full_screen_auxiliary()
                .can_join_all_spaces(),
        )
        .transparent(true)
        .with_window(|window| {
            window
                .visible(false)
                .focused(false)
                .decorations(false)
                .transparent(true)
                .accept_first_mouse(true)
                .content_protected(true)
        })
        .style_mask(StyleMask::empty().nonactivating_panel())
        .build()
}

/// Moves the tile to the right edge of the usable area of the screen that holds the mouse (the
/// main screen when that cannot be told), vertically centred.
fn dock(app: &AppHandle) {
    let Some(window) = app.get_webview_window(tile::WINDOW_LABEL) else {
        return;
    };
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let position = monitor.work_area().position.to_logical::<f64>(scale);
    let size = monitor.work_area().size.to_logical::<f64>(scale);
    let (x, y) = tile::dock(Area {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    });
    if let Err(error) = window.set_position(Position::Logical(LogicalPosition::new(x, y))) {
        tracing::warn!(target: "exo_dev::call_prompt", operation = "dock", error = %error);
    }
}
