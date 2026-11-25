//! The service over the embedded rules and the two-person Meet captures: what the names file
//! holds for the note. This is the 1:1 case from the meeting window to the file, without a Mac.
//!
//! The frontend suggests a name for "Them" only when the file marks one person as the user and
//! exactly one other person remains. The tiles of a call mark nobody, so with the People panel
//! closed the mark has to come from a name the app knows to be the user's.

use call_names::ax::{NoNames, Permission, RunningApp, TickReport};
use call_names::rules::{App, Rules};
use call_names::service::{Host, Live, Pace, Service, Store, Window, STEREO};
use call_names::session::{read_tick, Budget, Meter, Target};
use call_names::tree::{flat, Node, NodeSource};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const TILES: &str = "meet-two-people-tiles";
const PANEL: &str = "meet-two-people-panel";
const FIRST: &str = "5f0c2a9e-41d7-4c3b-9a56-0e8d7b1f2a34";
const SECOND: &str = "c81e6b07-9d2f-4a15-b3e8-64a0f5d9c712";

/// The only root of a scrubbed capture.
fn capture(name: &str) -> Node {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format!("{name}.jsonl"));
    let text = std::fs::read_to_string(&path).unwrap();
    let mut roots = flat::roots_from_jsonl(&text).unwrap();
    assert_eq!(roots.len(), 1, "{name}: expected one root");
    roots.remove(0).1
}

/// The meeting window as it was captured: each reading sees the next capture, and the last one
/// stays. The embedded rules read it, as they read the live window.
struct Captures(Vec<Node>);

impl Captures {
    fn of(names: &[&str]) -> Self {
        Captures(names.iter().map(|name| capture(name)).collect())
    }
}

impl Window for Captures {
    fn permission(&self) -> Permission {
        Permission::Granted
    }

    fn read(&mut self, rules: &Rules, _apps: &[RunningApp], budget: Budget) -> TickReport {
        let root = if self.0.len() > 1 {
            self.0.remove(0)
        } else {
            self.0[0].clone()
        };
        let clock = || Duration::ZERO;
        let mut meter = Meter::new(budget, &clock);
        let target = Target {
            app: App::GoogleMeet,
            root: &root,
        };
        let outcome =
            read_tick(rules, &mut NodeSource::new(), &[target], &mut meter).map_err(NoNames::from);
        TickReport {
            outcome,
            nodes: meter.nodes(),
            elapsed: Duration::ZERO,
        }
    }

    fn stop(&mut self) {}
}

/// The recorder: one live recording of both sides at a time.
struct Recorder(RefCell<Option<Live>>);

impl Recorder {
    fn recording(id: &str) -> Self {
        let recorder = Recorder(RefCell::new(None));
        recorder.record(id);
        recorder
    }

    fn record(&self, id: &str) {
        *self.0.borrow_mut() = Some(Live {
            id: id.to_owned(),
            channels: STEREO,
            recorded_ms: 5_000,
        });
    }
}

impl Host for Recorder {
    fn live(&self) -> Option<Live> {
        self.0.borrow().clone()
    }

    fn running(&self, _bundle_id: &str) -> Vec<RunningApp> {
        Vec::new()
    }
}

/// A store in a folder of its own, with the setting on. The folder is removed afterwards.
struct Folder(PathBuf);

impl Folder {
    fn new() -> (Folder, Store) {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "call-names-captures-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(dir.join("call-names"));
        store.set_enabled(true).unwrap();
        (Folder(dir), store)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The names file of a recording, as the frontend gets it.
fn file(store: &Store, id: &str) -> String {
    serde_json::to_string(&store.read(id).unwrap().unwrap()).unwrap()
}

const GUEST_AND_USER: &str = r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Test Guest A"},{"id":"p2","name":"Alex Example","self":true}],"truncated":false}"#;

#[test]
fn with_the_people_panel_closed_the_account_name_marks_the_user() {
    let (_folder, store) = Folder::new();
    let recorder = Recorder::recording(FIRST);
    let mut service = Service::with_account(
        store.clone(),
        Captures::of(&[TILES]),
        Pace::default(),
        || Some("Alex Example".to_owned()),
    );
    service.tick(&recorder);
    service.tick(&recorder);
    // One person is the user and one other remains: the frontend can suggest "Test Guest A".
    assert_eq!(file(&store, FIRST), GUEST_AND_USER);
    // The account's name is not stored, and a guess is not remembered.
    assert!(store.self_names().is_empty());
}

#[test]
fn with_the_people_panel_closed_and_no_known_name_nobody_is_the_user() {
    let no_name: fn() -> Option<String> = || None;
    let another_name: fn() -> Option<String> = || Some("Somebody Else".to_owned());
    for account in [no_name, another_name] {
        let (_folder, store) = Folder::new();
        let recorder = Recorder::recording(FIRST);
        let mut service = Service::with_account(
            store.clone(),
            Captures::of(&[TILES]),
            Pace::default(),
            account,
        );
        service.tick(&recorder);
        assert_eq!(
            file(&store, FIRST),
            GUEST_AND_USER.replace(r#","self":true"#, "")
        );
    }
}

#[test]
fn the_people_panel_teaches_the_name_for_the_next_recording() {
    let (_folder, store) = Folder::new();
    let recorder = Recorder::recording(FIRST);
    // The first recording: tiles, then the People panel opens and shows "(You)".
    let mut service = Service::with_account(
        store.clone(),
        Captures::of(&[TILES, PANEL]),
        Pace::default(),
        || None,
    );
    service.tick(&recorder);
    assert_eq!(
        file(&store, FIRST),
        GUEST_AND_USER.replace(r#","self":true"#, "")
    );
    service.tick(&recorder);
    assert_eq!(file(&store, FIRST), GUEST_AND_USER);
    let remembered: Vec<String> = store
        .self_names()
        .iter()
        .map(|name| name.as_str().to_owned())
        .collect();
    assert_eq!(remembered, ["Alex Example"]);

    // The next recording, after the app was started again, never shows the panel.
    let mut service = Service::with_account(
        store.clone(),
        Captures::of(&[TILES]),
        Pace::default(),
        || None,
    );
    recorder.record(SECOND);
    service.tick(&recorder);
    assert_eq!(file(&store, SECOND), GUEST_AND_USER);
}
