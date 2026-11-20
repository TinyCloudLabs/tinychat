//! The service with speaking samples: the scheduler, the gates, the slow-call rules, the writes
//! of the timeline and the status counts. The replay of the three-connection speaking test runs
//! through the whole service; scripted windows cover what the replay does not show.

mod common;

use call_names::ax::{NoNames, Permission, RunningApp, TickReport};
use call_names::extract::{Entry, Extraction, SourceNames};
use call_names::names::Name;
use call_names::rules::{App, Rules};
use call_names::service::{
    Due, Host, Live, Pace, Report, SampleReport, Sampling, Schedule, Service, Store, Window,
};
use call_names::session::Budget;
use call_names::speaking::{
    Found, Reading, SampleRead, TileFound, SAMPLE_INTERVAL, SLOW_SAMPLE_INTERVAL,
};
use call_names::timeline::Span;
use call_names::tree::ClassSet;
use common::replay::{events, token_rules, turns, Replay, ReplayWindow, MEET_CLASS_TOKENS};
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

const CAPTURE: &str = "meet-speaking-s56";
const EVENTS: &str = "meet-speaking-s56-events";
const RECORDING: &str = "0b9f6a52-7c1d-4e8a-9f3b-2d5c8e1a4b70";
const NEXT_RECORDING: &str = "7e2d9c14-55aa-4b0f-8c66-91f0a3b2c4d5";

/// A folder of its own for one test, removed afterwards.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "call-names-speaking-service-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Folder(dir)
    }

    fn store(&self) -> Store {
        let store = Store::new(self.0.join("call-names"));
        store.set_enabled(true).unwrap();
        store
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct HostState {
    live: Option<Live>,
    samples: Vec<SampleReport>,
    reports: Vec<Report>,
}

#[derive(Clone, Default)]
struct FakeHost(Rc<RefCell<HostState>>);

impl FakeHost {
    fn record(&self, id: &str, channels: u8, recorded_ms: u64) {
        self.0.borrow_mut().live = Some(Live {
            id: id.into(),
            channels,
            recorded_ms,
        });
    }

    fn at(&self, recorded_ms: u64) {
        if let Some(live) = self.0.borrow_mut().live.as_mut() {
            live.recorded_ms = recorded_ms;
        }
    }

    fn pause(&self) {
        self.0.borrow_mut().live = None;
    }

    fn samples(&self) -> Vec<SampleReport> {
        self.0.borrow().samples.clone()
    }
}

impl Host for FakeHost {
    fn live(&self) -> Option<Live> {
        self.0.borrow().live.clone()
    }

    fn running(&self, bundle_id: &str) -> Vec<RunningApp> {
        if bundle_id == "com.google.Chrome" {
            vec![RunningApp {
                pid: 4242,
                bundle_id: bundle_id.into(),
            }]
        } else {
            Vec::new()
        }
    }

    fn report(&self, report: &Report) {
        self.0.borrow_mut().reports.push(report.clone());
    }

    fn sampled(&self, sample: &SampleReport) {
        self.0.borrow_mut().samples.push(sample.clone());
    }
}

fn ms(seconds: f64) -> u64 {
    (seconds * 1000.0).round() as u64
}

fn overlap(spans: &[Span], from: u64, to: u64) -> u64 {
    spans
        .iter()
        .map(|[start, end]| end.min(&to).saturating_sub(*start.max(&from)))
        .sum()
}

/// Every name part and class token that must never reach a file.
fn assert_private(text: &str) {
    // Whole made-up names and their rarer words ("samples" is a key of the status file).
    let lower = text.to_lowercase();
    for part in [
        "alex example",
        "robin sample",
        "test guest",
        "alex",
        "robin",
        "guest",
    ] {
        assert!(!lower.contains(part), "{text}");
    }
    for (class, token) in MEET_CLASS_TOKENS {
        assert!(!text.contains(class) && !text.contains(token), "{text}");
    }
}

#[test]
fn the_schedule_runs_the_names_tick_first_and_samples_in_between() {
    let ms = Duration::from_millis;
    let mut schedule = Schedule::default();
    assert_eq!(schedule.due(ms(0)), Due::Names);
    schedule.ticked(ms(30), ms(5000), Some(SAMPLE_INTERVAL));
    assert_eq!(schedule.due(ms(100)), Due::Wait(ms(130)));
    assert_eq!(schedule.due(ms(230)), Due::Sample);
    schedule.sampled(ms(231), Some(SAMPLE_INTERVAL));
    assert_eq!(schedule.due(ms(431)), Due::Sample);
    // Both due: the names tick goes first.
    schedule.sampled(ms(4950), Some(SAMPLE_INTERVAL));
    assert_eq!(schedule.due(ms(5150)), Due::Names);
    // No samples: wait for the names tick.
    schedule.ticked(ms(5040), ms(2000), None);
    assert_eq!(schedule.due(ms(5100)), Due::Wait(ms(1940)));
    schedule.ticked(ms(7040), ms(5000), Some(SAMPLE_INTERVAL));
    schedule.sampled(ms(7240), None);
    assert_eq!(schedule.due(ms(7500)), Due::Wait(ms(4540)));
}

/// The whole replay through the service, as the reader's thread runs it, on the replay's clock.
/// `each` runs after every names tick.
fn run_replay(
    service: &mut Service<ReplayWindow>,
    host: &FakeHost,
    replay: &Rc<RefCell<Replay>>,
    mut each: impl FnMut(u64, &mut Service<ReplayWindow>),
) {
    let mut schedule = Schedule::default();
    loop {
        let t = ms(replay.borrow().t);
        host.at(t);
        let now = Duration::from_millis(t);
        match schedule.due(now) {
            Due::Names => {
                let delay = service.tick(host);
                schedule.ticked(now, delay, service.sampling());
                each(t, service);
            }
            Due::Sample => {
                let next = service.sample(host);
                schedule.sampled(now, next);
            }
            Due::Wait(_) => {}
        }
        if !replay.borrow_mut().advance() {
            break;
        }
    }
}

fn replay_service(store: &Store) -> (Service<ReplayWindow>, Rc<RefCell<Replay>>, Rc<Cell<usize>>) {
    let replay = Rc::new(RefCell::new(Replay::load(CAPTURE)));
    let window = ReplayWindow::new(replay.clone());
    let samples = window.samples.clone();
    let mut service = Service::with_account(store.clone(), window, Pace::default(), || None);
    service.set_rules(token_rules());
    service.set_sampling(Sampling {
        interval: Duration::from_millis(250),
        write_every: Duration::from_secs(15),
    });
    (service, replay, samples)
}

#[test]
fn the_service_turns_the_replay_into_a_timeline_with_eight_of_eight_turns() {
    let folder = Folder::new("replay");
    let store = folder.store();
    let host = FakeHost::default();
    host.record(RECORDING, 2, 0);
    let (mut service, replay, samples) = replay_service(&store);
    let path = store
        .dir()
        .join("speaking")
        .join(format!("{RECORDING}.json"));
    // The timeline file as it was after each names tick, to see when it was written.
    let mut versions: Vec<(u64, String)> = Vec::new();
    run_replay(&mut service, &host, &replay, |t, _| {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if versions.last().is_none_or(|(_, last)| *last != text) {
                versions.push((t, text));
            }
        }
    });
    // About one sample per step between names ticks: 811 steps, 42 names ticks.
    assert!((700..=780).contains(&samples.get()), "{}", samples.get());
    assert!(host
        .samples()
        .iter()
        .all(|sample| sample.kept && sample.calls == 3));

    // While the capture runs, the file is written at most every 15 s of recording.
    assert!(versions.len() >= 10, "{}", versions.len());
    for pair in versions.windows(2) {
        assert!(
            pair[1].0 - pair[0].0 >= 15_000,
            "{} then {}",
            pair[0].0,
            pair[1].0
        );
    }
    // The status file has the counts, and no name or class.
    let status = std::fs::read_to_string(store.dir().join("_status.json")).unwrap();
    assert_private(&status);
    let value: serde_json::Value = serde_json::from_str(&status).unwrap();
    assert_eq!(value["speaking"]["tiles"], 3, "{status}");
    assert_eq!(value["speaking"]["mode"], "rules", "{status}");
    assert!(
        value["speaking"]["samples"].as_u64().unwrap() > 600,
        "{status}"
    );
    assert_eq!(value["speaking"]["unknown"], 0, "{status}");

    // The capture stops: the timeline is written with everything confirmed.
    host.pause();
    service.tick(&host);
    let timeline = store.read_speaking(RECORDING).unwrap().unwrap();
    assert_private(&timeline.to_json());
    assert_eq!(timeline.self_id.as_deref(), Some("p3"));
    let turns = turns(&events(EVENTS));
    for turn in &turns {
        let owner = &timeline.people[["p1", "p2"][turn.tile]].speaking;
        let other = &timeline.people[["p2", "p1"][turn.tile]].speaking;
        let (start, end) = (ms(turn.start), ms(turn.end));
        assert!(
            overlap(owner, start, end + 1000) * 4 >= (end - start) * 3,
            "turn {}",
            turn.turn
        );
        assert_eq!(overlap(other, start, end + 1000), 0, "turn {}", turn.turn);
    }
    for (index, turn) in turns.iter().enumerate() {
        let next = turns.get(index + 1).map_or(u64::MAX, |next| ms(next.start));
        for person in timeline.people.values() {
            assert_eq!(overlap(&person.speaking, ms(turn.end) + 1000, next), 0);
        }
    }
    // Saving the note clears the names, not the timeline.
    store.clear(RECORDING).unwrap();
    assert!(store.read_speaking(RECORDING).unwrap().is_some());

    // With SPEAKING_DUMP set, the run is written as `snapshot --speaking` writes it, so that
    // tools/speaking-check.py can be tried on it.
    if let Some(path) = std::env::var_os("SPEAKING_DUMP") {
        use serde_json::json;
        let mut lines = vec![json!({ "kind": "meta", "tool": "replay", "startedWall": 0.0 })];
        for sample in host.samples() {
            let tiles: Vec<serde_json::Value> = sample
                .tiles
                .iter()
                .map(|(tile, person, mark)| {
                    let mark = match mark {
                        call_names::speaking::Mark::Speaking => "on",
                        call_names::speaking::Mark::Quiet => "off",
                        call_names::speaking::Mark::Unknown => "unknown",
                    };
                    json!({ "tile": tile, "person": person, "mark": mark })
                })
                .collect();
            lines.push(json!({
                "kind": "sample", "t": sample.at_ms as f64 / 1000.0, "tiles": tiles,
                "calls": sample.calls, "us": 0, "timedOut": sample.timed_out, "kept": sample.kept,
            }));
        }
        let timeline: serde_json::Value = serde_json::from_str(&timeline.to_json()).unwrap();
        lines.push(json!({ "kind": "timeline", "timeline": timeline }));
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        std::fs::write(path, text).unwrap();
    }
}

#[test]
fn a_pause_is_a_break_and_a_new_recording_starts_its_own_timeline() {
    let folder = Folder::new("pause");
    let store = folder.store();
    let host = FakeHost::default();
    host.record(RECORDING, 2, 0);
    let (mut service, replay, _) = replay_service(&store);
    let mut paused_at = None;
    run_replay(&mut service, &host, &replay, |t, service| {
        // At 60 s the capture pauses for a names tick, then resumes where it stopped.
        if t >= 60_000 && paused_at.is_none() {
            paused_at = Some(t);
            let live = host.live();
            host.pause();
            service.tick(&host);
            assert_eq!(service.sampling(), None, "no samples while paused");
            if let Some(live) = live {
                host.record(&live.id, live.channels, live.recorded_ms);
            }
        }
    });
    host.pause();
    service.tick(&host);
    let timeline = store.read_speaking(RECORDING).unwrap().unwrap();
    assert_eq!(timeline.breaks.len(), 1);
    assert!(timeline.breaks[0] >= paused_at.unwrap());

    // Another recording: the first one's timeline stays as it was.
    let before = std::fs::read_to_string(
        store
            .dir()
            .join("speaking")
            .join(format!("{RECORDING}.json")),
    )
    .unwrap();
    host.record(NEXT_RECORDING, 2, 0);
    service.tick(&host);
    let after = std::fs::read_to_string(
        store
            .dir()
            .join("speaking")
            .join(format!("{RECORDING}.json")),
    )
    .unwrap();
    assert_eq!(before, after);
}

/// A window with scripted tiles: each names tick finds them again, each sample reads them quiet,
/// or times out.
struct Scripted {
    names: Vec<&'static str>,
    ticks: usize,
    samples: Rc<Cell<usize>>,
    timeouts: Rc<Cell<bool>>,
    during: Rc<RefCell<Option<Box<dyn FnMut()>>>>,
}

impl Scripted {
    fn new(names: &[&'static str]) -> Self {
        Scripted {
            names: names.to_vec(),
            ticks: 0,
            samples: Default::default(),
            timeouts: Default::default(),
            during: Default::default(),
        }
    }
}

impl Window for Scripted {
    fn permission(&self) -> Permission {
        Permission::Granted
    }

    fn read(&mut self, _rules: &Rules, _apps: &[RunningApp], _budget: Budget) -> TickReport {
        let entries = self
            .names
            .iter()
            .map(|name| Entry {
                name: Name::clean(name).unwrap(),
                is_self: false,
            })
            .collect();
        TickReport {
            outcome: Ok::<_, NoNames>(Extraction {
                app: App::GoogleMeet,
                sources: vec![SourceNames {
                    id: "meet-tiles".into(),
                    one_per_person: false,
                    entries,
                }],
                truncated: false,
            }),
            nodes: 10,
            elapsed: Duration::ZERO,
        }
    }

    fn stop(&mut self) {}

    fn speaking(&mut self) -> Option<Found> {
        let first = self.ticks == 0;
        self.ticks += 1;
        Some(Found {
            tiles: self
                .names
                .iter()
                .enumerate()
                .map(|(index, name)| TileFound {
                    name: Name::clean(name).unwrap(),
                    previous: (!first).then_some(index),
                    rules_ok: true,
                    single: true,
                })
                .collect(),
            hidden: false,
        })
    }

    fn sample(&mut self, slots: &[usize]) -> SampleRead {
        self.samples.set(self.samples.get() + 1);
        if let Some(during) = self.during.borrow_mut().as_mut() {
            during();
        }
        if self.timeouts.get() {
            return SampleRead {
                readings: slots.iter().map(|&slot| (slot, Reading::Unknown)).collect(),
                calls: 1,
                timed_out: true,
                ..SampleRead::default()
            };
        }
        let quiet = ClassSet::from_tokens(["DYfzY", "cYKTje", "gjg47c"]).unwrap();
        SampleRead {
            readings: slots
                .iter()
                .map(|&slot| (slot, Reading::Classes(quiet.clone())))
                .collect(),
            calls: slots.len() as u64,
            ..SampleRead::default()
        }
    }
}

const THREE: [&str; 3] = ["Alex Example", "Robin Sample", "Test Guest A"];

fn scripted(
    store: &Store,
    names: &[&'static str],
) -> (
    Service<Scripted>,
    Rc<Cell<usize>>,
    Rc<Cell<bool>>,
    Rc<RefCell<Option<Box<dyn FnMut()>>>>,
) {
    let window = Scripted::new(names);
    let (samples, timeouts, during) = (
        window.samples.clone(),
        window.timeouts.clone(),
        window.during.clone(),
    );
    let service = Service::with_account(store.clone(), window, Pace::default(), || None);
    (service, samples, timeouts, during)
}

#[test]
fn nothing_is_sampled_with_the_setting_off_without_a_live_stereo_capture_or_with_two_tiles() {
    let folder = Folder::new("gates");
    let store = folder.store();
    let host = FakeHost::default();
    host.record(RECORDING, 2, 1_000);
    let (mut service, samples, _, _) = scripted(&store, &THREE);
    service.tick(&host);
    assert_eq!(service.sampling(), Some(SAMPLE_INTERVAL));
    assert_eq!(service.sample(&host), Some(SAMPLE_INTERVAL));
    assert_eq!(samples.get(), 1);

    // The setting goes off: not one more read, even before the next names tick.
    store.set_enabled(false).unwrap();
    assert_eq!(service.sample(&host), None);
    service.tick(&host);
    assert_eq!(service.sampling(), None);
    assert_eq!(samples.get(), 1);
    store.set_enabled(true).unwrap();

    // Paused: no sample, and no names tick reads either.
    service.tick(&host);
    host.pause();
    assert_eq!(service.sample(&host), None);
    service.tick(&host);
    assert_eq!(service.sampling(), None);
    // Mono.
    host.record(RECORDING, 1, 2_000);
    service.tick(&host);
    assert_eq!(service.sampling(), None);
    assert_eq!(service.sample(&host), None);
    // Another recording went live since the names tick.
    host.record(RECORDING, 2, 3_000);
    service.tick(&host);
    host.record(NEXT_RECORDING, 2, 0);
    assert_eq!(service.sample(&host), None);
    assert_eq!(samples.get(), 1);

    // Two tiles: the 1:1 rule names the other side; nothing is sampled.
    let folder = Folder::new("two");
    let store = folder.store();
    let (mut service, samples, _, _) = scripted(&store, &THREE[..2]);
    host.record(RECORDING, 2, 1_000);
    service.tick(&host);
    assert_eq!(service.sampling(), None);
    assert_eq!(service.sample(&host), None);
    assert_eq!(samples.get(), 0);
    assert!(!store.dir().join("speaking").exists());
}

#[test]
fn three_timeouts_in_a_row_slow_sampling_down_for_thirty_seconds() {
    let folder = Folder::new("slow");
    let store = folder.store();
    let host = FakeHost::default();
    host.record(RECORDING, 2, 1_000);
    let (mut service, samples, timeouts, _) = scripted(&store, &THREE);
    service.tick(&host);
    timeouts.set(true);
    assert_eq!(service.sample(&host), Some(SAMPLE_INTERVAL));
    assert_eq!(service.sample(&host), Some(SAMPLE_INTERVAL));
    assert_eq!(service.sample(&host), Some(SLOW_SAMPLE_INTERVAL));
    timeouts.set(false);
    host.at(20_000);
    assert_eq!(service.sample(&host), Some(SLOW_SAMPLE_INTERVAL));
    assert_eq!(service.sampling(), Some(SLOW_SAMPLE_INTERVAL));
    // Thirty seconds of recording after the third timeout: back to five a second.
    host.at(31_500);
    assert_eq!(service.sample(&host), Some(SAMPLE_INTERVAL));
    assert_eq!(samples.get(), 5);
    // A timed-out sample is counted as unknown, never as quiet.
    let unknown: usize = host
        .samples()
        .iter()
        .filter(|sample| sample.timed_out)
        .count();
    assert_eq!(unknown, 3);
}

#[test]
fn a_sample_is_dropped_when_the_capture_pauses_during_it() {
    let folder = Folder::new("dropped");
    let store = folder.store();
    let host = FakeHost::default();
    host.record(RECORDING, 2, 1_000);
    let (mut service, _, _, during) = scripted(&store, &THREE);
    service.tick(&host);
    service.sample(&host);
    let paused = host.clone();
    *during.borrow_mut() = Some(Box::new(move || paused.pause()));
    service.sample(&host);
    let kept: Vec<bool> = host.samples().iter().map(|sample| sample.kept).collect();
    assert_eq!(kept, [true, false]);
    // Only the first sample waits for the next names tick, which confirms it.
    *during.borrow_mut() = None;
    host.record(RECORDING, 2, 1_400);
    service.tick(&host);
    let timeline = store.read_speaking(RECORDING).unwrap().unwrap();
    assert_eq!(timeline.people.len(), 3);
    assert!(timeline
        .people
        .values()
        .all(|person| person.seen == [[1_000, 1_200]]));
}
