//! The speaking marker: rules, finding each tile's marker, classifying samples, and the learned
//! mode, on the replay of the three-connection speaking test (see `speaking_fixture.rs`).

mod common;

use call_names::rules::{App, Rules, EMBEDDED_JSON};
use call_names::session::{read_tick_with_speaking, Budget, Meter, Target};
use call_names::speaking::{
    Classified, Classifier, Confirmed, Mark, Markers, Mode, Tokens, SAMPLE_BUDGET,
};
use common::replay::{events, token_rules, token_rules_json, turns, Replay, MEET_CLASS_TOKENS};
use common::*;

const CAPTURE: &str = "meet-speaking-s56";
const EVENTS: &str = "meet-speaking-s56-events";
const MAIN: &str = "a0w0p0.0.1.0.0.0.1.1";
const MARKER: &str = ".0.0.0.1.0";
/// The speaker of each tile.
const TILE_NAMES: [&str; 3] = ["Test Guest A", "Test Guest B", "Alex Example"];
/// The names tick runs every five seconds of the capture.
const NAMES_EVERY: f64 = 5.0;

fn marker_path(tile: usize) -> String {
    format!("{MAIN}.{tile}{MARKER}")
}

fn tokens(rules: &Rules) -> Option<Tokens> {
    let app = rules.app(App::GoogleMeet).unwrap();
    app.speaking[0].classes.as_ref().map(Tokens::of)
}

/// One names tick with the speaking search on the replay as it is now.
fn names_tick(
    replay: &mut Replay,
    rules: &Rules,
) -> Option<Vec<call_names::speaking::Marker<String>>> {
    let clock = frozen();
    let mut meter = Meter::new(Budget::DEFAULT, &clock);
    let root = replay.root();
    let (names, markers) = read_tick_with_speaking(
        rules,
        replay,
        &[Target {
            app: App::GoogleMeet,
            root,
        }],
        &mut meter,
    );
    assert!(names.is_ok());
    markers
}

/// What the whole capture gives: a names tick every five seconds and a sample at every other
/// step, each tile's reading under the name of its tile, classified.
struct Played {
    samples: Vec<Classified>,
    mode: Option<Mode>,
    /// Names ticks that followed fewer than three tiles.
    short_ticks: usize,
}

fn play(rules: &Rules) -> Played {
    let mut replay = Replay::load(CAPTURE);
    let mut markers = Markers::new();
    let mut classifier = Classifier::new(tokens(rules));
    let mut names: Vec<String> = Vec::new();
    let mut samples = Vec::new();
    let mut next_names = 0.0;
    let mut short_ticks = 0;
    let clock = frozen();
    loop {
        if replay.t >= next_names {
            next_names += NAMES_EVERY;
            let found = names_tick(&mut replay, rules).unwrap_or_default();
            let tiles = markers.update(&replay, found);
            short_ticks += usize::from(tiles.len() < 3);
            names = tiles
                .iter()
                .map(|tile| tile.name.as_str().to_owned())
                .collect();
            samples.extend(classifier.decide(&tiles));
        } else if !markers.is_empty() {
            let slots: Vec<usize> = (0..markers.len()).collect();
            let read = markers.sample(&mut replay, &slots, SAMPLE_BUDGET, &clock);
            let sample = Confirmed {
                at_ms: (replay.t * 1000.0).round() as u64,
                period_ms: 250,
                readings: read
                    .readings
                    .into_iter()
                    .map(|(slot, reading)| (names[slot].clone(), reading))
                    .collect(),
            };
            samples.extend(classifier.push(sample));
        }
        if !replay.advance() {
            break;
        }
    }
    samples.extend(classifier.finish());
    Played {
        samples,
        mode: classifier.mode(),
        short_ticks,
    }
}

fn speaking_samples(played: &Played, name: &str, from: f64, to: f64) -> usize {
    played
        .samples
        .iter()
        .filter(|sample| {
            let t = sample.at_ms as f64 / 1000.0;
            t >= from && t < to
        })
        .filter(|sample| {
            sample
                .marks
                .iter()
                .any(|(person, mark)| person == name && *mark == Mark::Speaking)
        })
        .count()
}

/// Each turn's owner by the speaking samples from its start to one second after its end, and the
/// speaking samples of anybody in the silence after that.
fn attribution(played: &Played) -> (Vec<Option<&'static str>>, usize) {
    let turns = turns(&events(EVENTS));
    let mut owners = Vec::new();
    let mut silence = 0;
    for (index, turn) in turns.iter().enumerate() {
        let counts: Vec<usize> = TILE_NAMES
            .iter()
            .map(|name| speaking_samples(played, name, turn.start, turn.end + 1.0))
            .collect();
        let lit: Vec<usize> = (0..3).filter(|&tile| counts[tile] > 0).collect();
        owners.push(match lit.as_slice() {
            [tile] if counts[*tile] >= 25 => Some(TILE_NAMES[*tile]),
            _ => None,
        });
        let next = turns
            .get(index + 1)
            .map_or(f64::INFINITY, |next| next.start);
        for name in TILE_NAMES {
            silence += speaking_samples(played, name, turn.end + 1.0, next);
        }
    }
    let before = turns[0].start;
    for name in TILE_NAMES {
        silence += speaking_samples(played, name, 0.0, before);
    }
    (owners, silence)
}

fn expected_owners() -> Vec<Option<&'static str>> {
    turns(&events(EVENTS))
        .iter()
        .map(|turn| Some(TILE_NAMES[turn.tile]))
        .collect()
}

#[test]
fn the_embedded_rules_have_the_meet_speaking_rule_at_version_3() {
    let rules = Rules::embedded().unwrap();
    assert_eq!(rules.version, 3);
    let meet = rules.app(App::GoogleMeet).unwrap();
    assert_eq!(meet.speaking.len(), 1);
    assert_eq!(meet.speaking[0].min_tiles, 3);
    assert!(rules.app(App::Zoom).unwrap().speaking.is_empty());
    // The rules' Debug says how many class tokens there are, never which.
    let shown = format!("{rules:?}");
    for (class, _) in MEET_CLASS_TOKENS {
        assert!(!shown.contains(class), "Debug shows {class}");
    }
    assert!(shown.contains("Classes(<2 all, 1 quiet, 4 speaking>)"));
}

#[test]
fn a_speaking_rule_is_checked_when_it_loads() {
    use serde_json::{json, Value};
    let base: Value = serde_json::from_str(&token_rules_json()).unwrap();
    fn meet(rules: &mut Value) -> &mut Value {
        let apps = rules["apps"].as_array_mut().unwrap();
        apps.iter_mut()
            .find(|app| app["app"] == "google-meet")
            .unwrap()
    }
    fn rule(rules: &mut Value) -> &mut Value {
        &mut meet(rules)["speaking"][0]
    }
    fn classes(rules: &mut Value) -> &mut Value {
        &mut rule(rules)["classes"]
    }
    let refused = |edit: &dyn Fn(&mut Value), why: &str| {
        let mut rules = base.clone();
        edit(&mut rules);
        let error = Rules::from_json(&rules.to_string())
            .unwrap_err()
            .to_string();
        assert!(error.contains(why), "{error} (expected {why:?})");
    };
    // A marker step that would read a label: a sample must read no text.
    refused(
        &|rules| rule(rules)["marker"][4]["label"] = json!(["Speaking"]),
        "marker steps are structure only",
    );
    // With two people the 1:1 rule names the other side: three tiles at least, twelve at most.
    refused(
        &|rules| rule(rules)["min_tiles"] = json!(2),
        "min_tiles must be 3 to 12",
    );
    refused(
        &|rules| rule(rules)["min_tiles"] = json!(13),
        "min_tiles must be 3 to 12",
    );
    refused(
        &|rules| rule(rules)["marker"] = json!([]),
        "marker needs 1 to 8 steps",
    );
    refused(
        &|rules| rule(rules)["tile"] = json!([]),
        "tile needs 1 to 8 steps",
    );
    refused(
        &|rules| rule(rules)["name"]["from"] = json!([]),
        "name.from needs 1 to 3",
    );
    // Class tokens: short words, each once, no empty list.
    refused(
        &|rules| classes(rules)["quiet"] = json!(["md:flex"]),
        "not 1 to 40 letters",
    );
    refused(
        &|rules| classes(rules)["quiet"] = json!(["cace893be"]),
        "appears twice",
    );
    refused(
        &|rules| classes(rules)["quiet"] = json!([]),
        "needs 1 to 16 tokens",
    );
    // Unknown fields are refused, in the rule and in its classes.
    refused(&|rules| rule(rules)["rate"] = json!(5), "unknown field");
    refused(
        &|rules| classes(rules)["loud"] = json!(["x"]),
        "unknown field",
    );
    // Class tokens belong to a speaking rule only.
    refused(
        &|rules| meet(rules)["sources"][1]["classes"] = classes(&mut base.clone()).clone(),
        "unknown field",
    );
    // One speaking rule per app in this build.
    refused(
        &|rules| {
            let mut second = rule(rules).clone();
            second["id"] = json!("meet-tile-speaking-2");
            meet(rules)["speaking"].as_array_mut().unwrap().push(second);
        },
        "speaking: more than 1 entries",
    );
    // Without class tokens a speaking rule still loads: the marker is then learned.
    let mut without = base.clone();
    rule(&mut without)
        .as_object_mut()
        .unwrap()
        .remove("classes");
    let rules = Rules::from_json(&without.to_string()).unwrap();
    assert!(rules.app(App::GoogleMeet).unwrap().speaking[0]
        .classes
        .is_none());
    assert!(EMBEDDED_JSON.contains("\"version\": 3,"));
}

#[test]
fn each_tile_gets_its_marker_and_class_lists_are_read_only_on_marker_candidates() {
    let rules = token_rules();
    let mut replay = Replay::load(CAPTURE);
    let found = names_tick(&mut replay, &rules).expect("markers");
    let markers: Vec<(String, String, bool, bool)> = found
        .iter()
        .map(|marker| {
            (
                marker.marker.clone(),
                marker.name.as_str().to_owned(),
                marker.rules_ok,
                marker.single,
            )
        })
        .collect();
    let expected: Vec<(String, String, bool, bool)> = (0..3)
        .map(|tile| (marker_path(tile), TILE_NAMES[tile].to_owned(), true, true))
        .collect();
    assert_eq!(markers, expected);
    // The tick read one class list per tile, each on its one candidate, and no other.
    let candidates: Vec<String> = (0..3).map(marker_path).collect();
    assert_eq!(replay.reads.class_lists, candidates);
    // No text of a marker candidate was read.
    assert!(replay
        .reads
        .texts
        .iter()
        .all(|(node, _)| !candidates.contains(node)));

    // Without class tokens that match, the only candidate of each tile is still the marker.
    let mut replay = Replay::load(CAPTURE);
    let found = names_tick(&mut replay, &Rules::embedded().unwrap()).expect("markers");
    assert_eq!(found.len(), 3);
    assert!(found.iter().all(|marker| !marker.rules_ok && marker.single));
}

#[test]
fn a_sample_reads_one_class_list_per_followed_marker_and_nothing_else() {
    let rules = token_rules();
    let mut replay = Replay::load(CAPTURE);
    let found = names_tick(&mut replay, &rules).unwrap();
    let mut markers = Markers::new();
    let tiles = markers.update(&replay, found);
    assert!(tiles.iter().all(|tile| tile.previous.is_none()));
    let before = replay.reads.clone();
    let clock = frozen();
    for _ in 0..50 {
        replay.advance();
        let read = markers.sample(&mut replay, &[0, 1, 2], SAMPLE_BUDGET, &clock);
        assert_eq!(read.calls, 3);
        assert!(!read.timed_out && !read.resting);
    }
    assert_eq!(
        replay.reads.structure, before.structure,
        "no structure read"
    );
    assert_eq!(replay.reads.texts, before.texts, "no text read");
    let sampled = &replay.reads.class_lists[before.class_lists.len()..];
    assert_eq!(sampled.len(), 150);
    assert!(sampled.iter().all(|node| node.ends_with(MARKER)));

    // What a tick and a sample hand on shows no class token, no class name and no name.
    let read = markers.sample(&mut replay, &[0, 1, 2], SAMPLE_BUDGET, &clock);
    let shown = format!("{read:?} {tiles:?} {:?}", Classifier::new(tokens(&rules)));
    for (class, token) in MEET_CLASS_TOKENS {
        assert!(!shown.contains(class) && !shown.contains(token), "{shown}");
    }
    for part in ["Test", "Guest", "Alex", "Example"] {
        assert!(!shown.contains(part), "{shown}");
    }

    // The next names tick knows each tile again: the same element with the same marker.
    let found = names_tick(&mut replay, &rules).unwrap();
    let again = markers.update(&replay, found);
    let previous: Vec<Option<usize>> = again.iter().map(|tile| tile.previous).collect();
    assert_eq!(previous, [Some(0), Some(1), Some(2)]);
}

#[test]
fn a_timeout_makes_the_rest_of_the_sample_unknown_and_a_gone_marker_is_dropped() {
    use call_names::speaking::Reading;
    use call_names::tree::ReadError;
    let rules = token_rules();
    let mut replay = Replay::load(CAPTURE);
    let found = names_tick(&mut replay, &rules).unwrap();
    let mut markers = Markers::new();
    markers.update(&replay, found);
    let clock = frozen();

    replay.failing.insert(marker_path(1), ReadError::Timeout);
    let read = markers.sample(&mut replay, &[0, 1, 2], SAMPLE_BUDGET, &clock);
    assert!(read.timed_out);
    assert_eq!(read.calls, 2, "nothing is read after the timeout");
    assert!(matches!(read.readings[0].1, Reading::Classes(_)));
    assert_eq!(read.readings[1].1, Reading::Unknown);
    assert_eq!(read.readings[2].1, Reading::Unknown);

    replay.failing.insert(marker_path(1), ReadError::Gone);
    let read = markers.sample(&mut replay, &[0, 1, 2], SAMPLE_BUDGET, &clock);
    assert_eq!(read.readings[1].1, Reading::Gone);
    assert!(markers.marker(1).is_none());
    replay.failing.clear();
    let read = markers.sample(&mut replay, &[0, 1, 2], SAMPLE_BUDGET, &clock);
    assert_eq!(read.calls, 2, "a gone marker is not read again");
    assert_eq!(read.readings[1].1, Reading::Gone);

    // Out of budget before a read: that read and the rest are unknown, never quiet.
    let late = std::cell::Cell::new(std::time::Duration::ZERO);
    let clock = || {
        let now = late.get();
        late.set(now + std::time::Duration::from_millis(25));
        now
    };
    let read = markers.sample(&mut replay, &[0, 2], SAMPLE_BUDGET, &clock);
    assert_eq!(read.calls, 1);
    assert_eq!(read.readings[1].1, Reading::Unknown);
}

#[test]
fn the_replay_attributes_eight_of_eight_turns_and_nothing_lights_up_in_the_silences() {
    let played = play(&token_rules());
    assert_eq!(played.mode, Some(Mode::Rules));
    assert_eq!(
        played.short_ticks, 0,
        "three tiles followed at every names tick"
    );
    let (owners, silence) = attribution(&played);
    assert_eq!(owners, expected_owners(), "8 of 8 turns");
    // One lone sample: the second connection's microphone turning on, before turn 4. The
    // timeline drops a lone sample.
    assert_eq!(silence, 1);
    // The user's own tile never lights up: the user was muted throughout.
    assert_eq!(speaking_samples(&played, "Alex Example", 0.0, 1e9), 0);
    let unknown: usize = played
        .samples
        .iter()
        .flat_map(|sample| &sample.marks)
        .filter(|(_, mark)| *mark == Mark::Unknown)
        .count();
    assert_eq!(unknown, 0, "every marker read was quiet or speaking");
}

#[test]
fn with_wrong_class_tokens_the_learned_mode_gives_the_same_turns() {
    // The embedded rules name Meet's own classes; the fixture holds the scrubber's tokens, so
    // no marker matches, as when Meet renames its classes.
    let rules = Rules::embedded().unwrap();
    let learned = play(&rules);
    assert_eq!(learned.mode, Some(Mode::Learned));
    let (owners, silence) = attribution(&learned);
    assert_eq!(owners, expected_owners(), "8 of 8 turns");
    assert_eq!(silence, 1);
    // Sample for sample, the same marks as the rules.
    let ruled = play(&token_rules());
    assert_eq!(learned.samples, ruled.samples);
}
