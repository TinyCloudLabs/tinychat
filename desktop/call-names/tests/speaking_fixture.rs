//! The speaking test of a real Meet call with three connections, as a fixture with its diffs.
//!
//! The capture (`meet-speaking-s56.jsonl`) is the observer's window, sampled about four times a
//! second for 206 seconds, scrubbed by `tools/scrub.py` with its diffs kept. Its three tiles are,
//! in order: the host ("Test Guest A"), a second connection ("Test Guest B") and the observer, the
//! local user ("Alex Example"). In the call both remote connections showed one display name; the
//! fixture gives each its own made-up name so that the two can be told apart. The class names are
//! the scrubber's stable tokens.
//!
//! The events (`meet-speaking-s56-events.json`) are the tester's: eight turns of about ten seconds
//! of speech, host and second connection taking turns, each followed by at least ten seconds of
//! silence. Times are seconds since the capture's `full` line, speakers are tile numbers. The
//! People panel was opened before turn 5.

mod common;

use call_names::rules::App;
use call_names::session::{Budget, Target};
use common::replay::{events, turns, Capture, Replay};
use common::*;
use serde_json::Value;
use std::rc::Rc;

pub const CAPTURE: &str = "meet-speaking-s56";
pub const EVENTS: &str = "meet-speaking-s56-events";
/// The main landmark; the tiles are its first three children.
const MAIN: &str = "a0w0p0.0.1.0.0.0.1.1";
/// Below a tile: first child three times, the child that has children, its first child.
const MARKER: &str = ".0.0.0.1.0";
/// The scrubber's tokens of the marker's quiet class and of its four speaking classes.
const QUIET: &str = "c9ffe0173";
const SPEAKING: [&str; 4] = ["c1edf03cb", "c524b0d6f", "cc8a7d408", "c18c9959b"];

fn marker(tile: usize) -> String {
    format!("{MAIN}.{tile}{MARKER}")
}

fn speaking(classes: &[String]) -> bool {
    classes
        .iter()
        .any(|class| SPEAKING.contains(&class.as_str()))
}

#[test]
fn the_replay_starts_as_the_full_line_and_plays_every_diff() {
    let mut replay = Replay::load(CAPTURE);
    // The first sample reads as the fixture's own tree does.
    let root = replay.root();
    let from_replay = read_with(
        &mut replay,
        &[Target {
            app: App::GoogleMeet,
            root,
        }],
        Budget::DEFAULT,
    )
    .unwrap();
    assert_eq!(
        from_replay,
        read(App::GoogleMeet, &fixture(CAPTURE)).unwrap()
    );

    assert_eq!(replay.steps(), 811);
    let mut last = 0.0;
    while replay.advance() {
        assert!(replay.t > last, "times rise: {} after {last}", replay.t);
        assert!(replay.t - last < 0.3, "no sample is missing near {last}");
        last = replay.t;
    }
    assert_eq!(replay.step(), 811);
    assert!((205.0..206.0).contains(&last), "{last}");
}

#[test]
fn the_tiles_name_three_people_and_the_panel_marks_the_user_after_it_opens() {
    let mut replay = Replay::load(CAPTURE);
    let read_now = |replay: &mut Replay| {
        let root = replay.root();
        read_with(
            replay,
            &[Target {
                app: App::GoogleMeet,
                root,
            }],
            Budget::DEFAULT,
        )
        .unwrap()
    };
    let first = read_now(&mut replay);
    assert_eq!(
        names(&first, "meet-tiles"),
        named(&[
            ("Test Guest A", false),
            ("Test Guest B", false),
            ("Alex Example", false)
        ])
    );
    assert_eq!(names(&first, "meet-people-panel"), named(&[]));
    while replay.advance() {}
    let last = read_now(&mut replay);
    assert_eq!(
        names(&last, "meet-people-panel"),
        named(&[
            ("Alex Example", true),
            ("Test Guest A", false),
            ("Test Guest B", false)
        ])
    );
    assert_eq!(
        names(&last, "meet-tiles"),
        named(&[
            ("Test Guest A", false),
            ("Test Guest B", false),
            ("Alex Example", false)
        ])
    );
}

#[test]
fn the_events_are_eight_alternating_turns_inside_the_capture() {
    let events = events(EVENTS);
    let turns = turns(&events);
    assert_eq!(turns.len(), 8);
    for (index, turn) in turns.iter().enumerate() {
        assert_eq!(turn.turn as usize, index + 1);
        assert_eq!(
            turn.tile,
            index % 2,
            "host and second connection take turns"
        );
        let length = turn.end - turn.start;
        assert!(
            (10.0..11.5).contains(&length),
            "turn {}: {length} s",
            turn.turn
        );
        if let Some(next) = turns.get(index + 1) {
            assert!(
                next.start - turn.end >= 10.0,
                "silence after turn {}",
                turn.turn
            );
        }
    }
    assert!(turns[0].start > 5.0 && turns[7].end < 200.0);
    let panel: Vec<f64> = events
        .iter()
        .filter(|event| event.kind == "panel_open")
        .map(|event| event.t)
        .collect();
    assert_eq!(panel.len(), 1);
    assert!(turns[3].end < panel[0] && panel[0] < turns[4].start);
}

#[test]
fn the_speakers_marker_follows_the_speech_and_the_others_stay_quiet() {
    let turns = turns(&events(EVENTS));
    let mut replay = Replay::load(CAPTURE);
    // Per turn: samples of the speaker inside the speech, and of each tile with speech classes.
    let mut inside = vec![(0usize, 0usize); turns.len()];
    let mut others_on = 0;
    // Samples with speech classes in the silence well after each turn (two seconds of decay).
    let mut silence_on = vec![0usize; turns.len()];
    while replay.advance() {
        let t = replay.t;
        for (index, turn) in turns.iter().enumerate() {
            let next = turns
                .get(index + 1)
                .map_or(f64::INFINITY, |next| next.start);
            for tile in 0..3 {
                let on = speaking(&replay.classes(&marker(tile)));
                let marker = replay.node(&marker(tile)).unwrap();
                assert!(
                    marker.cls.iter().any(|class| class == QUIET) || on,
                    "the marker is always quiet or speaking"
                );
                if t >= turn.start + 1.0 && t <= turn.end {
                    if tile == turn.tile {
                        inside[index].0 += 1;
                        inside[index].1 += usize::from(on);
                    } else {
                        others_on += usize::from(on);
                    }
                }
                if t >= turn.end + 2.0 && t < next {
                    silence_on[index] += usize::from(on);
                }
            }
        }
    }
    for (index, (samples, on)) in inside.iter().enumerate() {
        assert!(*samples >= 35, "turn {}: {samples} samples", index + 1);
        assert!(
            on * 10 >= samples * 7,
            "turn {}: {on} of {samples} on",
            index + 1
        );
    }
    assert_eq!(others_on, 0, "nobody else lights up during a turn");
    // One lone sample before turn 4, when the second connection's microphone was turned on.
    assert!(silence_on.iter().all(|&on| on <= 1), "{silence_on:?}");
    assert_eq!(silence_on.iter().sum::<usize>(), 1, "{silence_on:?}");
}

#[test]
fn the_events_fixture_holds_times_kinds_turns_and_tiles_only() {
    let path = fixture_dir().join(format!("{EVENTS}.json"));
    let text = std::fs::read_to_string(path).unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["events", "kind", "v"]);
    let kinds = [
        "turn_begin",
        "turn_end",
        "speech_start",
        "speech_end",
        "microphone_on",
        "microphone_off",
        "panel_open",
    ];
    for event in value["events"].as_array().unwrap() {
        for (key, item) in event.as_object().unwrap() {
            match key.as_str() {
                "t" => assert!(item.is_f64() || item.is_u64()),
                "kind" => assert!(kinds.contains(&item.as_str().unwrap()), "{item}"),
                "turn" | "tile" => assert!(item.is_null() || item.as_u64().is_some_and(|n| n < 16)),
                other => panic!("unexpected event key {other}"),
            }
        }
    }
    // No tool output, no wall-clock time, no machine.
    let lower = text.to_lowercase();
    for word in [
        "walltime", "output", "macos", "title", "who", "speaker", "@", "://",
    ] {
        assert!(!lower.contains(word), "the events fixture holds {word:?}");
    }
}

#[test]
fn the_capture_keeps_its_diffs_as_structure_texts_and_class_tokens() {
    let capture = Capture::load(CAPTURE);
    assert_eq!(capture.full.len(), 178);
    assert_eq!(capture.diffs.len(), 811);
    let text = std::fs::read_to_string(fixture_dir().join(format!("{CAPTURE}.jsonl"))).unwrap();
    for key in [
        "\"domId\"",
        "\"AXEnabled\"",
        "\"AXFocused\"",
        "\"AXExpanded\"",
        "\"wallTime\"",
    ] {
        assert!(!text.contains(key), "the capture keeps {key}");
    }
    // Every class token is the scrubber's: "c" and eight hex digits, and the marker's are there.
    let replay = Replay::new(Rc::new(capture));
    let classes = replay.classes(&marker(0));
    assert_eq!(classes.len(), 3);
    assert!(classes.iter().any(|class| class == QUIET));
}
