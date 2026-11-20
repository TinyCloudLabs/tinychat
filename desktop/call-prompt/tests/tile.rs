//! The contract with the frontend, and where the tile docks.

use call_prompt::session::Phase;
use call_prompt::tile::{
    dock, Area, Setting, TileState, EDGE_MARGIN, EVENT, HEIGHT, PAGE, WIDTH, WINDOW_LABEL,
};
use serde_json::json;

#[test]
fn the_names_are_the_ones_agreed_with_the_frontend() {
    assert_eq!(WINDOW_LABEL, "call-prompt");
    assert_eq!(PAGE, "call-prompt.html");
    assert_eq!(EVENT, "exo://call-prompt");
}

#[test]
fn the_tile_state_is_one_phase() {
    for (phase, text) in [
        (Phase::Hidden, "hidden"),
        (Phase::Offered, "offered"),
        (Phase::Starting, "starting"),
        (Phase::Recording, "recording"),
    ] {
        assert_eq!(
            serde_json::to_value(TileState::of(phase)).unwrap(),
            json!({ "phase": text })
        );
    }
}

#[test]
fn the_setting_has_enabled_and_supported() {
    assert_eq!(
        serde_json::to_value(Setting {
            enabled: true,
            supported: false
        })
        .unwrap(),
        json!({ "enabled": true, "supported": false })
    );
}

#[test]
fn the_tile_docks_at_the_right_edge_vertically_centred() {
    // A 1512 x 982 screen with a 33 px menu bar, the usable area below it.
    let area = Area {
        x: 0.0,
        y: 33.0,
        width: 1512.0,
        height: 949.0,
    };
    let (x, y) = dock(area);
    assert_eq!(x, 1512.0 - WIDTH - EDGE_MARGIN);
    assert_eq!(y, 33.0 + (949.0 - HEIGHT) / 2.0);
}

#[test]
fn on_a_second_screen_it_docks_on_that_screen() {
    // A screen to the left of the main one, and one above it.
    let left = Area {
        x: -1920.0,
        y: -200.0,
        width: 1920.0,
        height: 1080.0,
    };
    let (x, y) = dock(left);
    assert_eq!(x, -WIDTH - EDGE_MARGIN);
    assert_eq!(y, -200.0 + (1080.0 - HEIGHT) / 2.0);
    let above = Area {
        x: 100.0,
        y: -1440.0,
        width: 2560.0,
        height: 1440.0,
    };
    let (x, y) = dock(above);
    assert!(x + WIDTH <= 100.0 + 2560.0 && x >= 100.0);
    assert!(y >= -1440.0 && y + HEIGHT <= 0.0);
}

#[test]
fn a_tiny_screen_keeps_the_tile_inside() {
    let (x, y) = dock(Area {
        x: 10.0,
        y: 20.0,
        width: 100.0,
        height: 100.0,
    });
    assert_eq!((x, y), (10.0, 20.0));
}

#[test]
fn the_recording_state_has_its_time_and_pause() {
    use call_prompt::session::RecordingState;
    assert_eq!(
        serde_json::to_value(TileState::recording(RecordingState {
            elapsed_ms: 3_725_000,
            paused: false
        }))
        .unwrap(),
        json!({ "phase": "recording", "elapsedMs": 3_725_000, "paused": false })
    );
}

#[test]
fn the_bar_docks_at_the_same_place() {
    use call_prompt::tile::{dock_sized, BAR_HEIGHT, BAR_WIDTH};
    let area = Area {
        x: 0.0,
        y: 33.0,
        width: 1512.0,
        height: 949.0,
    };
    let (x, y) = dock_sized(area, BAR_WIDTH, BAR_HEIGHT);
    assert_eq!(x + BAR_WIDTH, 1512.0 - EDGE_MARGIN, "the same right edge");
    assert_eq!(y + BAR_HEIGHT / 2.0, 33.0 + 949.0 / 2.0, "the same middle");
    assert_eq!((BAR_WIDTH, BAR_HEIGHT), (180.0, 52.0));
}
