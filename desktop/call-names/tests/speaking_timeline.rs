//! The speaking timeline: the replay of the three-connection speaking test through the tracker
//! (names ticks, confirmation, intervals), and the timeline file in the store.

mod common;

use call_names::extract::Extraction;
use call_names::names::Name;
use call_names::roster::Roster;
use call_names::rules::{App, Rules};
use call_names::service::Store;
use call_names::session::{read_tick_with_speaking, Budget, Meter, Target};
use call_names::speaking::{Found, Markers, Mode, Tokens, SAMPLE_BUDGET};
use call_names::timeline::{Span, Timeline, Tracker, MAX_TIMELINE_BYTES};
use common::replay::{events, token_rules, turns, Replay, Turn, MEET_CLASS_TOKENS};
use common::*;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

const CAPTURE: &str = "meet-speaking-s56";
const EVENTS: &str = "meet-speaking-s56-events";
const RECORDING: &str = "0b9f6a52-7c1d-4e8a-9f3b-2d5c8e1a4b70";
/// The names tick runs every five seconds of the capture.
const NAMES_EVERY: f64 = 5.0;
/// The capture's sample interval.
const PERIOD_MS: u64 = 250;

fn tokens(rules: &Rules) -> Option<Tokens> {
    let app = rules.app(App::GoogleMeet).unwrap();
    app.speaking[0].classes.as_ref().map(Tokens::of)
}

fn ms(seconds: f64) -> u64 {
    (seconds * 1000.0).round() as u64
}

/// The whole capture through a tracker. `person` may change the roster's answer at a tick.
fn play_with(
    rules: &Rules,
    person: impl Fn(usize, &Roster, &Name) -> Option<String>,
) -> (Timeline, Roster) {
    let mut replay = Replay::load(CAPTURE);
    let mut markers = Markers::new();
    let mut tracker = Tracker::new(App::GoogleMeet, rules.version, PERIOD_MS, tokens(rules));
    let mut roster = Roster::new();
    let mut next_names = 0.0;
    let mut tick = 0;
    let clock = frozen();
    loop {
        let at = ms(replay.t);
        if replay.t >= next_names {
            next_names += NAMES_EVERY;
            let mut meter = Meter::new(Budget::DEFAULT, &clock);
            let root = replay.root();
            let (names, found) = read_tick_with_speaking(
                rules,
                &mut replay,
                &[Target {
                    app: App::GoogleMeet,
                    root,
                }],
                &mut meter,
            );
            let names: Extraction = names.unwrap();
            roster.observe(at, &names);
            let found = found.map(|found| Found {
                tiles: markers.update(&replay, found),
                hidden: false,
            });
            tracker.tick(at, found.as_ref(), |name| person(tick, &roster, name));
            tick += 1;
        } else {
            let slots = tracker.followed();
            if !slots.is_empty() {
                let read = markers.sample(&mut replay, &slots, SAMPLE_BUDGET, &clock);
                tracker.sample(at, PERIOD_MS, read);
            }
        }
        if !replay.advance() {
            break;
        }
    }
    tracker.finish();
    let self_id = roster
        .people()
        .iter()
        .find(|person| person.is_self)
        .map(|person| person.id.clone());
    (tracker.timeline(self_id.as_deref()).unwrap(), roster)
}

fn roster_id(roster: &Roster, name: &Name) -> Option<String> {
    roster
        .people()
        .iter()
        .find(|person| &person.name == name)
        .map(|person| person.id.clone())
}

fn play(rules: &Rules) -> (Timeline, Roster) {
    play_with(rules, |_, roster, name| roster_id(roster, name))
}

/// Milliseconds of `spans` inside `[from, to]`.
fn overlap(spans: &[Span], from: u64, to: u64) -> u64 {
    spans
        .iter()
        .map(|[start, end]| end.min(&to).saturating_sub(*start.max(&from)))
        .sum()
}

fn id_of(roster: &Roster, name: &str) -> String {
    roster_id(roster, &Name::clean(name).unwrap()).unwrap()
}

/// Per turn: the owner's onset (first interval start after the speech start, in ms), the share of
/// the speech its intervals cover, and the time anybody else speaks during it. Then the speaking
/// time of anybody in the silences, from one second after a turn to the next turn.
fn check_turns(timeline: &Timeline, roster: &Roster) -> (Vec<(u64, f64, u64)>, u64) {
    let turns: Vec<Turn> = turns(&events(EVENTS));
    let ids = [id_of(roster, "Test Guest A"), id_of(roster, "Test Guest B")];
    let mut out = Vec::new();
    let mut silence = 0;
    for (index, turn) in turns.iter().enumerate() {
        let (start, end) = (ms(turn.start), ms(turn.end));
        let owner = &timeline.people[&ids[turn.tile]].speaking;
        let other = &timeline.people[&ids[1 - turn.tile]].speaking;
        let onset = owner
            .iter()
            .find(|span| span[1] > start)
            .map_or(u64::MAX, |span| span[0].saturating_sub(start));
        let covered = overlap(owner, start, end + 1000) as f64 / (end - start) as f64;
        out.push((onset, covered, overlap(other, start, end + 1000)));
        let next = turns.get(index + 1).map_or(u64::MAX, |next| ms(next.start));
        for person in timeline.people.values() {
            silence += overlap(&person.speaking, end + 1000, next);
        }
        silence += overlap(&timeline.self_speaking, start, next);
    }
    for person in timeline.people.values() {
        silence += overlap(&person.speaking, 0, ms(turns[0].start));
    }
    (out, silence)
}

#[test]
fn the_replay_gives_each_turn_to_its_speaker_and_nothing_in_the_silences() {
    let (timeline, roster) = play(&token_rules());
    assert_eq!(timeline.mode, Mode::Rules);
    assert_eq!(timeline.rules_version, 3);
    // Tiles in order: Test Guest A, Test Guest B, then the user, whom the People panel marks.
    assert_eq!(id_of(&roster, "Test Guest A"), "p1");
    assert_eq!(id_of(&roster, "Test Guest B"), "p2");
    assert_eq!(timeline.self_id.as_deref(), Some("p3"));
    assert_eq!(timeline.people.keys().collect::<Vec<_>>(), ["p1", "p2"]);
    assert!(timeline.self_speaking.is_empty(), "the user was muted");
    let (turns, silence) = check_turns(&timeline, &roster);
    for (index, (onset, covered, other)) in turns.iter().enumerate() {
        println!(
            "turn {}: onset {onset} ms, {:.0}% of the speech covered, other speaker {other} ms",
            index + 1,
            covered * 100.0
        );
        assert!(*onset <= 1_200, "turn {}: onset {onset} ms", index + 1);
        // Pauses of more than a second inside a turn stay out of its intervals.
        assert!(*covered >= 0.75, "turn {}: {covered}", index + 1);
        assert_eq!(*other, 0, "turn {}: somebody else speaks", index + 1);
    }
    assert_eq!(silence, 0, "nothing in the silences");
    // Four turns each, one or two intervals per turn: pauses up to a second are merged.
    for id in ["p1", "p2"] {
        let intervals = timeline.people[id].speaking.len();
        println!("{id}: {intervals} intervals");
        assert!((4..=8).contains(&intervals), "{id}: {intervals}");
        // Seen from the first sample to the last names tick (205 s), without a hole. The samples
        // after the last tick have no tick to confirm them.
        let seen = &timeline.people[id].seen;
        assert_eq!(seen.len(), 1, "{id}: {seen:?}");
        assert!(seen[0][0] <= 500 && seen[0][1] >= 204_500, "{id}: {seen:?}");
    }
    assert!(timeline.breaks.is_empty() && timeline.hidden.is_empty() && !timeline.truncated);
}

#[test]
fn with_wrong_class_tokens_the_learned_timeline_is_the_same() {
    let (learned, _) = play(&Rules::embedded().unwrap());
    let (ruled, _) = play(&token_rules());
    assert_eq!(learned.mode, Mode::Learned);
    assert_eq!(learned.people, ruled.people);
    assert_eq!(learned.self_speaking, ruled.self_speaking);
}

#[test]
fn samples_count_only_when_the_next_names_tick_shows_the_same_person_in_the_tile() {
    // At the third tick (10 s) the roster answers with the other remote person for each remote
    // tile: the samples since the tick before and until the tick after do not count.
    let (timeline, roster) = play_with(&token_rules(), |tick, roster, name| {
        let id = roster_id(roster, name)?;
        Some(match (tick, id.as_str()) {
            (2, "p1") => "p2".to_owned(),
            (2, "p2") => "p1".to_owned(),
            _ => id,
        })
    });
    for id in ["p1", "p2"] {
        let seen = &timeline.people[id].seen;
        assert_eq!(overlap(seen, 5_500, 14_500), 0, "{id}: {seen:?}");
        assert!(overlap(seen, 15_500, 200_000) > 180_000, "{id}");
    }
    // Turn 1 (7.2 s to 17.7 s) is kept only from the fourth tick on, and never for anybody else.
    let first = &timeline.people[&id_of(&roster, "Test Guest A")].speaking;
    assert!(first[0][0] >= 15_000, "{first:?}");
    assert_eq!(
        overlap(
            &timeline.people[&id_of(&roster, "Test Guest B")].speaking,
            7_000,
            18_000
        ),
        0
    );
}

#[test]
fn the_timeline_file_holds_ids_and_times_only() {
    let (timeline, _) = play(&token_rules());
    let json = timeline.to_json();
    for (class, token) in MEET_CLASS_TOKENS {
        assert!(!json.contains(class) && !json.contains(token));
    }
    let lower = json.to_lowercase();
    for part in ["test", "guest", "alex", "example"] {
        assert!(!lower.contains(part), "{json}");
    }
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "app",
            "breaks",
            "hidden",
            "mode",
            "people",
            "rules_version",
            "sample_ms",
            "self",
            "self_speaking",
            "truncated",
            "v"
        ]
    );
    assert_eq!(value["sample_ms"], PERIOD_MS);
    assert!(json.len() < 4 * 1024, "{} bytes", json.len());
}

/// A folder of its own for one test, removed afterwards.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("call-names-timeline-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Folder(dir)
    }

    fn store(&self) -> Store {
        Store::new(self.0.join("call-names"))
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn speaking_file(store: &Store) -> PathBuf {
    store
        .dir()
        .join("speaking")
        .join(format!("{RECORDING}.json"))
}

#[test]
fn the_store_keeps_the_timeline_privately_until_the_audio_goes() {
    let folder = Folder::new("store");
    let store = folder.store();
    let (timeline, _) = play(&token_rules());
    assert_eq!(store.read_speaking(RECORDING), Ok(None));
    store.write_speaking(RECORDING, &timeline).unwrap();
    assert_eq!(store.read_speaking(RECORDING), Ok(Some(timeline.clone())));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode =
            |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&speaking_file(&store)), 0o600);
        assert_eq!(mode(&store.dir().join("speaking")), 0o700);
        assert_eq!(mode(store.dir()), 0o700);
    }
    // Saving the note clears the names, not the timeline: a new transcription needs it.
    store.clear(RECORDING).unwrap();
    assert!(store.read_speaking(RECORDING).unwrap().is_some());
    // Deleting the audio forgets both, and what an interrupted write left behind.
    let leftover = speaking_file(&store).with_extension("json.123.4.tmp");
    std::fs::write(&leftover, "{").unwrap();
    store.forget(RECORDING).unwrap();
    assert_eq!(store.read_speaking(RECORDING), Ok(None));
    assert!(!leftover.exists());
    store.forget(RECORDING).unwrap();
    // A recording id is checked before it becomes a file name.
    assert!(store.read_speaking("../x").is_err());
    assert!(store.write_speaking("a/b", &timeline).is_err());
    assert!(store.forget("").is_err());
}

#[test]
fn a_timeline_that_cannot_be_read_is_removed() {
    let folder = Folder::new("bad");
    let store = folder.store();
    let (timeline, _) = play(&token_rules());
    store.write_speaking(RECORDING, &timeline).unwrap();
    let path = speaking_file(&store);
    for bad in [
        timeline.to_json().replace("\"v\":1", "\"v\":9"),
        "not json".to_owned(),
        format!("{} ", timeline.to_json()).repeat((MAX_TIMELINE_BYTES as usize / 2000) + 1),
    ] {
        std::fs::write(&path, bad).unwrap();
        assert_eq!(store.read_speaking(RECORDING), Ok(None));
        assert!(!path.exists());
    }
}

#[test]
fn the_tidy_removes_old_timelines_and_leftovers_only() {
    let folder = Folder::new("tidy");
    let store = folder.store();
    let (timeline, _) = play(&token_rules());
    store.write_speaking(RECORDING, &timeline).unwrap();
    let leftover = speaking_file(&store).with_extension("json.9.9.tmp");
    std::fs::write(&leftover, "{").unwrap();
    // Today: only the leftover goes.
    assert_eq!(store.tidy(SystemTime::now()), 1);
    assert!(store.read_speaking(RECORDING).unwrap().is_some());
    // In 31 days: the timeline goes too.
    let later = SystemTime::now() + Duration::from_secs(31 * 24 * 60 * 60);
    assert_eq!(store.tidy(later), 1);
    assert_eq!(store.read_speaking(RECORDING), Ok(None));
}
