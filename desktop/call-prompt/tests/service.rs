//! The watcher with a fake app and a fake CoreAudio: the setting, the buttons, failures.

use call_prompt::apps::Kind;
use call_prompt::mic::{AudioProcesses, ScanError};
use call_prompt::service::{spawn_with, Clock, Host, Report, Watcher, PANIC_REST};
use call_prompt::session::{Action, Phase, Stage, TICK};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What the fake app saw and what it answers.
#[derive(Default)]
struct App {
    recording: AtomicBool,
    live: AtomicBool,
    panic_on_recording: AtomicBool,
    actions: Mutex<Vec<Action>>,
    reports: Mutex<Vec<Report>>,
}

#[derive(Clone, Default)]
struct FakeHost(Arc<App>);

impl Host for FakeHost {
    fn recording(&self) -> bool {
        if self.0.panic_on_recording.load(Ordering::SeqCst) {
            panic!("a failure in the host");
        }
        self.0.recording.load(Ordering::SeqCst)
    }

    fn live(&self) -> bool {
        self.0.live.load(Ordering::SeqCst)
    }

    fn act(&self, action: Action) {
        self.0.actions.lock().unwrap().push(action);
    }

    fn report(&self, report: &Report) {
        self.0.reports.lock().unwrap().push(*report);
    }
}

impl App {
    fn take(&self) -> Vec<Action> {
        std::mem::take(&mut *self.actions.lock().unwrap())
    }
}

/// Zoom capturing, or nothing; counts the scans.
#[derive(Clone, Default)]
struct FakeAudio {
    zoom: Arc<AtomicBool>,
    scans: Arc<AtomicUsize>,
    fail: Arc<AtomicBool>,
}

impl AudioProcesses for FakeAudio {
    fn processes(&mut self) -> Result<Vec<u32>, ScanError> {
        self.scans.fetch_add(1, Ordering::SeqCst);
        if self.fail.load(Ordering::SeqCst) {
            return Err(ScanError::Failed(-1));
        }
        Ok(if self.zoom.load(Ordering::SeqCst) {
            vec![7]
        } else {
            Vec::new()
        })
    }

    fn capturing(&mut self, _process: u32) -> Option<bool> {
        Some(true)
    }

    fn playing(&mut self, _process: u32) -> Option<bool> {
        Some(false)
    }

    fn pid(&mut self, _process: u32) -> Option<i32> {
        Some(1)
    }

    fn bundle_id(&mut self, _process: u32) -> Option<String> {
        Some("us.zoom.xos".into())
    }
}

/// A clock the test moves.
#[derive(Clone, Default)]
struct FakeClock(Arc<AtomicU64>);

impl FakeClock {
    fn clock(&self) -> Clock {
        let millis = self.0.clone();
        Box::new(move || Duration::from_millis(millis.load(Ordering::SeqCst)))
    }

    fn advance(&self, by: Duration) {
        self.0.fetch_add(by.as_millis() as u64, Ordering::SeqCst);
    }
}

struct Rig {
    app: Arc<App>,
    audio: FakeAudio,
    clock: FakeClock,
    watcher: Watcher<FakeHost, FakeAudio>,
}

impl Rig {
    fn new() -> Self {
        let host = FakeHost::default();
        let audio = FakeAudio::default();
        let clock = FakeClock::default();
        clock.advance(Duration::from_secs(100));
        Rig {
            app: host.0.clone(),
            audio: audio.clone(),
            watcher: Watcher::new(host, audio, clock.clock()),
            clock,
        }
    }

    /// Ticks for `seconds` at the pace the watcher asks for.
    fn run(&self, seconds: u64) {
        let end = self.clock.0.load(Ordering::SeqCst) + seconds * 1000;
        while self.clock.0.load(Ordering::SeqCst) < end {
            let delay = self.watcher.tick();
            self.clock.advance(delay);
        }
    }

    fn offer(&self) {
        self.watcher.set_enabled(true);
        self.audio.zoom.store(true, Ordering::SeqCst);
        self.run(10);
        assert_eq!(self.watcher.phase(), Phase::Offered);
        assert_eq!(
            self.app.take(),
            [Action::Phase(Phase::Offered), Action::Show]
        );
    }
}

#[test]
fn nothing_is_scanned_while_the_setting_is_off() {
    let rig = Rig::new();
    rig.audio.zoom.store(true, Ordering::SeqCst);
    assert!(!rig.watcher.enabled(), "off until the app turns it on");
    rig.run(60);
    assert_eq!(rig.audio.scans.load(Ordering::SeqCst), 0);
    assert!(rig.app.take().is_empty());
}

#[test]
fn turning_the_setting_off_hides_the_tile_and_stops_scanning() {
    let rig = Rig::new();
    rig.offer();
    rig.watcher.set_enabled(false);
    assert_eq!(rig.app.take(), [Action::Hide, Action::Phase(Phase::Hidden)]);
    assert_eq!(rig.watcher.phase(), Phase::Hidden);
    let scans = rig.audio.scans.load(Ordering::SeqCst);
    rig.run(60);
    assert_eq!(rig.audio.scans.load(Ordering::SeqCst), scans);
    assert!(rig.app.take().is_empty());
}

#[test]
fn start_through_the_watcher() {
    let rig = Rig::new();
    rig.offer();
    rig.watcher.start();
    rig.watcher.start();
    assert_eq!(
        rig.app.take(),
        [Action::Phase(Phase::Starting), Action::Start]
    );
    assert_eq!(rig.watcher.phase(), Phase::Starting);
    assert_eq!(rig.watcher.tick(), Duration::from_millis(500));
    rig.app.recording.store(true, Ordering::SeqCst);
    rig.app.live.store(true, Ordering::SeqCst);
    rig.watcher.tick();
    assert_eq!(rig.app.take(), [Action::Phase(Phase::Recording)]);
    rig.run(4);
    assert_eq!(rig.app.take(), [Action::Hide, Action::Phase(Phase::Hidden)]);
    assert_eq!(rig.watcher.stage(), Stage::Started);
}

#[test]
fn not_now_through_the_watcher() {
    let rig = Rig::new();
    rig.offer();
    rig.watcher.dismiss();
    assert_eq!(rig.app.take(), [Action::Hide, Action::Phase(Phase::Hidden)]);
    rig.run(300);
    assert!(rig.app.take().is_empty());
}

#[test]
fn a_panic_in_a_tick_hides_the_tile_and_rests() {
    let rig = Rig::new();
    rig.offer();
    rig.app.panic_on_recording.store(true, Ordering::SeqCst);
    assert_eq!(rig.watcher.tick(), PANIC_REST);
    assert_eq!(rig.app.take(), [Action::Hide, Action::Phase(Phase::Hidden)]);
    assert_eq!(rig.watcher.stage(), Stage::Idle);
    let last = *rig.app.reports.lock().unwrap().last().unwrap();
    assert_eq!(last.error, Some("panicked"));
    // The watcher goes on once the failure is gone.
    rig.app.panic_on_recording.store(false, Ordering::SeqCst);
    rig.run(10);
    assert_eq!(rig.watcher.phase(), Phase::Offered);
}

#[test]
fn a_failed_scan_is_reported_and_changes_nothing() {
    let rig = Rig::new();
    rig.offer();
    rig.watcher.dismiss();
    rig.app.take();
    rig.audio.fail.store(true, Ordering::SeqCst);
    rig.run(120);
    assert!(rig.app.take().is_empty());
    assert_eq!(rig.watcher.stage(), Stage::Dismissed);
    let last = *rig.app.reports.lock().unwrap().last().unwrap();
    assert_eq!(last.error, Some("process_list_failed"));
}

#[test]
fn reports_carry_the_stage_and_the_kind_and_come_on_change_only() {
    let rig = Rig::new();
    rig.offer();
    rig.run(20);
    let reports = rig.app.reports.lock().unwrap().clone();
    let stages: Vec<Stage> = reports.iter().map(|report| report.stage).collect();
    assert_eq!(stages, [Stage::Hearing, Stage::Offered]);
    assert_eq!(reports[1].kind, Some(Kind::Native));
    assert_eq!(reports[0].kind, None);
}

#[test]
fn the_thread_sleeps_while_off_scans_while_on_and_stops() {
    let host = FakeHost::default();
    let audio = FakeAudio::default();
    let scans = audio.scans.clone();
    let worker = spawn_with(host, audio, Box::new(call_prompt::service::now)).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(scans.load(Ordering::SeqCst), 0, "no scan while off");

    worker.set_enabled(true);
    let deadline = Instant::now() + Duration::from_secs(5);
    while scans.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        scans.load(Ordering::SeqCst),
        1,
        "turning it on scans at once"
    );

    // "Start" wakes the thread: with no offer it changes nothing, but it scans again now.
    worker.start();
    let deadline = Instant::now() + Duration::from_secs(1);
    while scans.load(Ordering::SeqCst) < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(scans.load(Ordering::SeqCst), 2);

    worker.set_enabled(false);
    std::thread::sleep(Duration::from_millis(50));
    let scans_off = scans.load(Ordering::SeqCst);
    assert!(worker.stop(Duration::from_secs(2)), "the thread ends");
    assert!(
        TICK > Duration::from_millis(500),
        "no timed scan came while this test ran"
    );
    assert_eq!(scans.load(Ordering::SeqCst), scans_off);
}
