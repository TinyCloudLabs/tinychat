//! The contract with the tile's page and the main window's setting, and where the tile docks.
//!
//! Fixed with the frontend (`frontend/call-prompt.html`, `frontend/src/callPrompt/`):
//! - window label [`WINDOW_LABEL`], page [`PAGE`];
//! - one shape for the `call_prompt_state` command and the [`EVENT`] event: [`TileState`],
//!   `{ "phase": "hidden" | "offered" | "starting" | "recording" }`;
//! - `call_prompt_start` and `call_prompt_dismiss` from the tile: no arguments, no answer;
//! - `call_prompt_get` from the main window: [`Setting`], `{ "enabled", "supported" }`;
//!   `call_prompt_set` takes `{ "enabled": boolean }`.

use crate::session::Phase;
use serde::Serialize;

/// The tile window's label.
pub const WINDOW_LABEL: &str = "call-prompt";
/// The tile's page, a second entry of the frontend build.
pub const PAGE: &str = "call-prompt.html";
/// Native to tile: the tile's new [`TileState`].
pub const EVENT: &str = "exo://call-prompt";
/// The tile's size, in logical pixels.
pub const WIDTH: f64 = 200.0;
pub const HEIGHT: f64 = 150.0;
/// The gap between the tile and the right edge of the screen's usable area.
pub const EDGE_MARGIN: f64 = 16.0;

/// What the tile shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct TileState {
    pub phase: Phase,
}

/// The setting, as the main window reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Setting {
    pub enabled: bool,
    /// The offer exists on this platform (macOS).
    pub supported: bool,
}

/// A screen's usable area (without the menu bar and the Dock), in logical pixels, in the
/// windowing system's coordinates: x to the right, y down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The tile's top-left corner: at the right edge of `area`, [`EDGE_MARGIN`] from it, and
/// vertically centred. On a screen smaller than the tile it stays inside the area's top-left
/// corner.
pub fn dock(area: Area) -> (f64, f64) {
    let x = area.x + (area.width - WIDTH - EDGE_MARGIN).max(0.0);
    let y = area.y + ((area.height - HEIGHT) / 2.0).max(0.0);
    (x, y)
}
