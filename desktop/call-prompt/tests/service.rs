//! The watcher with a fake app and a fake CoreAudio: the setting, the buttons, failures.

use call_prompt::apps::Kind;
use call_prompt::mic::{AudioProcesses, ScanError};
use call_prompt::service::{spawn_with, Clock, Host, Report, Watcher, PANIC_REST};
use call_prompt::session::{Action, Phase, Stage, TICK};
use call_prompt::status::StatusFile;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
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

/// The gate: what the one input device answers.
const GATE_OPEN: u8 = 0;
const GATE_CLOSED: u8 = 1;
const GATE_FAILS: u8 = 2;

/// One input device, and Zoom capturing or nothing; counts the gate's reads and the scans. The
/// gate is open unless a test closes it.
#[derive(Clone, Default)]
struct FakeAudio {
    zoom: Arc<AtomicBool>,
    gate: Arc<AtomicU8>,
    gate_reads: Arc<AtomicUsize>,
    scans: Arc<AtomicUsize>,
    fail: Arc<AtomicBool>,
    blocker: Arc<Blocker>,
}

/// Holds a scan inside the process list until the test lets it go.
#[derive(Default)]
struct Blocker {
    /// (armed, inside, released)
    state: Mutex<(bool, bool, bool)>,
    changed: std::sync::Condvar,
}

impl Blocker {
    fn arm(&self) {
        *self.state.lock().unwrap() = (true, false, false);
    }

    /// Called by the scan: when armed, say so and wait for the release.
    fn hold(&self) {
        let mut state = self.state.lock().unwrap();
        if !state.0 {
            return;
        }
        state.1 = true;
        self.changed.notify_all();
        let _released = self.changed.wait_while(state, |state| !state.2).unwrap();
    }

    fn wait_inside(&self) {
        let state = self.state.lock().unwrap();
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(5), |state| !state.1)
            .unwrap();
        assert!(!timeout.timed_out() && state.1, "the scan never started");
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = false;
        state.2 = true;
        self.changed.notify_all();
    }
}

impl AudioProcesses for FakeAudio {
    fn input_devices(&mut self, list: &mut Vec<u32>) -> Result<(), ScanError> {
        list.clear();
        list.push(1);
        Ok(())
    }

    fn device_running(&mut self, _device: u32) -> Result<bool, ScanError> {
        self.gate_reads.fetch_add(1, Ordering::SeqCst);
        match self.gate.load(Ordering::SeqCst) {
            GATE_OPEN => Ok(true),
            GATE_CLOSED => Ok(false),
            _ => Err(ScanError::InputFailed(-2)),
        }
    }

    fn processes(&mut self, list: &mut Vec<u32>) -> Result<(), ScanError> {
        self.scans.fetch_add(1, Ordering::SeqCst);
        self.blocker.hold();
        list.clear();
        if self.fail.load(Ordering::SeqCst) {
            return Err(ScanError::Failed(-1));
        }
        if self.zoom.load(Ordering::SeqCst) {
            list.push(7);
        }
        Ok(())
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
    /// A watcher whose tile page has loaded (it asked for its state once).
    fn new() -> Self {
        let rig = Self::without_page();
        rig.watcher.page_asked();
        rig
    }

    /// A watcher whose tile page has never asked.
    fn without_page() -> Self {
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
    assert_eq!(
        rig.app.take(),
        [Action::Phase(Phase::Starting), Action::Start]
    );
    // A second press sends no second request, but the tile hears its phase again.
    rig.watcher.start();
    assert_eq!(rig.app.take(), [Action::Phase(Phase::Starting)]);
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
    // A call app is heard, so the scan keeps its pace (no quiet back-off).
    audio.zoom.store(true, Ordering::SeqCst);
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

#[test]
fn a_closed_gate_means_no_process_scan() {
    let rig = Rig::new();
    rig.watcher.set_enabled(true);
    rig.audio.gate.store(GATE_CLOSED, Ordering::SeqCst);
    rig.run(60);
    assert_eq!(rig.audio.scans.load(Ordering::SeqCst), 0);
    assert_eq!(
        rig.audio.gate_reads.load(Ordering::SeqCst),
        30,
        "one gate read per tick"
    );
    assert_eq!(rig.watcher.stage(), Stage::Idle);
}

#[test]
fn an_open_gate_means_a_scan() {
    let rig = Rig::new();
    rig.watcher.set_enabled(true);
    rig.audio.gate.store(GATE_CLOSED, Ordering::SeqCst);
    rig.run(10);
    rig.audio.gate.store(GATE_OPEN, Ordering::SeqCst);
    rig.watcher.tick();
    assert_eq!(rig.audio.scans.load(Ordering::SeqCst), 1);
}

#[test]
fn a_gate_that_cannot_be_read_scans_and_is_reported() {
    let rig = Rig::new();
    rig.watcher.set_enabled(true);
    rig.audio.gate.store(GATE_FAILS, Ordering::SeqCst);
    rig.audio.zoom.store(true, Ordering::SeqCst);
    rig.run(10);
    assert_eq!(rig.audio.scans.load(Ordering::SeqCst), 5);
    assert_eq!(rig.watcher.phase(), Phase::Offered);
    let last = *rig.app.reports.lock().unwrap().last().unwrap();
    assert_eq!(last.error, Some("input_device_failed"));
}

#[test]
fn a_followed_call_keeps_scanning_until_it_ends_whatever_the_gate() {
    let rig = Rig::new();
    rig.offer();
    rig.watcher.dismiss();
    rig.app.take();
    // The gate closes for a while (another default device, a flicker); Zoom still captures.
    rig.audio.gate.store(GATE_CLOSED, Ordering::SeqCst);
    let scans = rig.audio.scans.load(Ordering::SeqCst);
    rig.run(60);
    assert_eq!(rig.audio.scans.load(Ordering::SeqCst), scans + 30);
    assert_eq!(rig.watcher.stage(), Stage::Dismissed, "the same call");
    assert!(rig.app.take().is_empty(), "no second offer");
    // Zoom stops: scans go on until the call has ended, then stop.
    rig.audio.zoom.store(false, Ordering::SeqCst);
    rig.run(30);
    assert_eq!(rig.watcher.stage(), Stage::Idle);
    let ended = rig.audio.scans.load(Ordering::SeqCst);
    rig.run(60);
    assert_eq!(rig.audio.scans.load(Ordering::SeqCst), ended);
}

#[test]
fn a_hearing_app_keeps_scanning_while_the_gate_flickers() {
    let rig = Rig::new();
    rig.watcher.set_enabled(true);
    rig.audio.zoom.store(true, Ordering::SeqCst);
    rig.watcher.tick();
    assert_eq!(rig.watcher.stage(), Stage::Hearing);
    rig.clock.advance(TICK);
    // The gate closes for one tick; the app is still followed, and the 8 s still count.
    rig.audio.gate.store(GATE_CLOSED, Ordering::SeqCst);
    rig.watcher.tick();
    rig.clock.advance(TICK);
    rig.audio.gate.store(GATE_OPEN, Ordering::SeqCst);
    rig.run(6);
    assert_eq!(rig.watcher.phase(), Phase::Offered);
}

#[test]
fn every_button_press_gets_a_phase_back() {
    let rig = Rig::new();
    // No offer at all (the tile was left over, or the offer had just gone).
    rig.watcher.start();
    assert_eq!(rig.app.take(), [Action::Phase(Phase::Hidden)]);
    rig.watcher.dismiss();
    assert_eq!(rig.app.take(), [Action::Phase(Phase::Hidden)]);
    // A recording began just before the press: the offer went, the tile hears "hidden".
    rig.offer();
    rig.app.recording.store(true, Ordering::SeqCst);
    rig.watcher.tick();
    assert_eq!(rig.app.take(), [Action::Hide, Action::Phase(Phase::Hidden)]);
    rig.watcher.start();
    assert_eq!(rig.app.take(), [Action::Phase(Phase::Hidden)]);
    // "Not now" while starting changes nothing and says so.
    let rig = Rig::new();
    rig.offer();
    rig.watcher.start();
    rig.app.take();
    rig.watcher.dismiss();
    assert_eq!(rig.app.take(), [Action::Phase(Phase::Starting)]);
}

#[test]
fn an_open_gate_with_no_call_app_scans_every_6_s_and_a_call_app_brings_back_2_s() {
    let rig = Rig::new();
    rig.watcher.set_enabled(true);
    // A headset plays music: the gate is open, nothing captures.
    rig.run(60);
    assert_eq!(
        rig.audio.scans.load(Ordering::SeqCst),
        10,
        "one scan per 6 s"
    );
    assert_eq!(
        rig.audio.gate_reads.load(Ordering::SeqCst),
        30,
        "the gate on every tick"
    );
    // Zoom starts: heard at the next quiet scan, then every tick.
    rig.audio.zoom.store(true, Ordering::SeqCst);
    let before = rig.audio.scans.load(Ordering::SeqCst);
    rig.run(2);
    assert_eq!(rig.watcher.stage(), Stage::Hearing);
    let heard = rig.audio.scans.load(Ordering::SeqCst);
    assert_eq!(heard, before + 1);
    rig.run(20);
    assert_eq!(
        rig.audio.scans.load(Ordering::SeqCst),
        heard + 10,
        "every tick again"
    );
    assert_eq!(rig.watcher.phase(), Phase::Offered);
}

#[test]
fn a_gate_that_closes_and_opens_again_scans_at_once() {
    let rig = Rig::new();
    rig.watcher.set_enabled(true);
    rig.watcher.tick();
    assert_eq!(rig.audio.scans.load(Ordering::SeqCst), 1);
    rig.clock.advance(TICK);
    rig.audio.gate.store(GATE_CLOSED, Ordering::SeqCst);
    rig.watcher.tick();
    rig.clock.advance(TICK);
    rig.audio.gate.store(GATE_OPEN, Ordering::SeqCst);
    rig.watcher.tick();
    assert_eq!(
        rig.audio.scans.load(Ordering::SeqCst),
        2,
        "no wait after a closed gate"
    );
}

fn shows(actions: &[Action]) -> usize {
    actions
        .iter()
        .filter(|action| **action == Action::Show)
        .count()
}

#[test]
fn the_window_is_made_when_a_call_app_is_heard_and_shown_once_the_page_asked() {
    let rig = Rig::without_page();
    rig.watcher.set_enabled(true);
    rig.audio.zoom.store(true, Ordering::SeqCst);
    rig.watcher.tick();
    assert_eq!(rig.watcher.stage(), Stage::Hearing);
    assert_eq!(rig.app.take(), [Action::Prepare], "made at once, hidden");
    // The page loads and asks; the offer comes later and shows as usual.
    rig.watcher.window_created();
    assert_eq!(rig.watcher.page_asked(), Phase::Hidden);
    rig.clock.advance(TICK);
    rig.run(8);
    assert_eq!(
        rig.app.take(),
        [Action::Phase(Phase::Offered), Action::Show]
    );
}

#[test]
fn an_offer_waits_for_the_page_and_shows_when_it_asks() {
    let rig = Rig::without_page();
    rig.watcher.set_enabled(true);
    rig.audio.zoom.store(true, Ordering::SeqCst);
    rig.run(10);
    // The offer is due but the page has not asked: the window is not shown.
    assert_eq!(rig.watcher.phase(), Phase::Offered);
    let actions = rig.app.take();
    assert_eq!(shows(&actions), 0, "{actions:?}");
    assert_eq!(actions.last(), Some(&Action::Prepare));
    // The page asks within the wait: it gets the offer and the window shows.
    assert_eq!(rig.watcher.page_asked(), Phase::Offered);
    assert_eq!(rig.app.take(), [Action::Show]);
    rig.run(20);
    assert_eq!(rig.watcher.phase(), Phase::Offered);
    assert_eq!(shows(&rig.app.take()), 0, "shown once");
}

#[test]
fn an_offer_whose_page_never_asks_is_never_shown_and_counts_as_not_now() {
    let rig = Rig::without_page();
    rig.watcher.set_enabled(true);
    rig.audio.zoom.store(true, Ordering::SeqCst);
    rig.run(10);
    rig.app.take();
    rig.run(2);
    assert_eq!(rig.watcher.stage(), Stage::Dismissed);
    assert_eq!(rig.watcher.phase(), Phase::Hidden);
    assert_eq!(rig.app.take(), [Action::Hide, Action::Phase(Phase::Hidden)]);
    let reports = rig.app.reports.lock().unwrap().clone();
    let missing = reports
        .iter()
        .filter(|report| report.error == Some("tile_page_missing"))
        .count();
    assert_eq!(missing, 1, "logged once: {reports:?}");
    // The rest of the call: nothing, even if the page asks late.
    rig.run(120);
    rig.watcher.page_asked();
    assert_eq!(shows(&rig.app.take()), 0);
    assert_eq!(
        rig.app
            .reports
            .lock()
            .unwrap()
            .iter()
            .filter(|report| report.error == Some("tile_page_missing"))
            .count(),
        1
    );
}

#[test]
fn a_new_window_waits_for_its_own_page() {
    let rig = Rig::new();
    rig.watcher.window_created();
    rig.watcher.set_enabled(true);
    rig.audio.zoom.store(true, Ordering::SeqCst);
    rig.run(10);
    let actions = rig.app.take();
    assert_eq!(shows(&actions), 0, "{actions:?}");
    rig.watcher.page_asked();
    assert_eq!(rig.app.take(), [Action::Show]);
}

#[test]
fn an_offer_withdrawn_while_it_waits_for_the_page_never_shows() {
    let rig = Rig::without_page();
    rig.watcher.set_enabled(true);
    rig.audio.zoom.store(true, Ordering::SeqCst);
    rig.run(8);
    rig.watcher.tick();
    assert_eq!(
        rig.watcher.phase(),
        Phase::Offered,
        "due, waiting for the page"
    );
    // A second later, before the wait is over, a recording starts from the shortcut.
    rig.clock.advance(Duration::from_secs(1));
    rig.app.recording.store(true, Ordering::SeqCst);
    rig.watcher.tick();
    assert_eq!(rig.watcher.stage(), Stage::Started);
    rig.app.take();
    rig.watcher.page_asked();
    rig.run(10);
    assert_eq!(shows(&rig.app.take()), 0);
    assert!(rig
        .app
        .reports
        .lock()
        .unwrap()
        .iter()
        .all(|report| report.error != Some("tile_page_missing")));
}

#[test]
fn turning_the_setting_off_during_a_scan_leaves_nothing_behind() {
    let rig = Arc::new(Rig::new());
    rig.watcher.set_enabled(true);
    rig.audio.zoom.store(true, Ordering::SeqCst);
    rig.run(6);
    assert_eq!(rig.watcher.stage(), Stage::Hearing);
    rig.app.take();
    // The next scan is held inside CoreAudio while the user turns the setting off.
    rig.audio.blocker.arm();
    let ticking = {
        let rig = rig.clone();
        std::thread::spawn(move || rig.watcher.tick())
    };
    rig.audio.blocker.wait_inside();
    rig.watcher.set_enabled(false);
    assert_eq!(rig.watcher.stage(), Stage::Idle);
    rig.audio.blocker.release();
    ticking.join().unwrap();
    // The scan that ends after the switch went off is dropped: no call is followed.
    assert_eq!(rig.watcher.stage(), Stage::Idle);
    assert!(rig.app.take().is_empty());
    let last = *rig.app.reports.lock().unwrap().last().unwrap();
    assert_eq!(last.stage, Stage::Idle);
}

/// The rig's status file, in a folder of its own that goes with the test.
struct StatusFolder(std::path::PathBuf);

impl StatusFolder {
    fn new(rig: &Rig) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "call-prompt-watcher-status-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        rig.watcher.keep_status(StatusFile::new(&dir));
        StatusFolder(dir)
    }

    fn read(&self) -> serde_json::Value {
        let text = std::fs::read_to_string(self.0.join("_status.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }
}

impl Drop for StatusFolder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn the_status_file_follows_the_watcher_without_any_id() {
    let rig = Rig::new();
    let folder = StatusFolder::new(&rig);
    rig.watcher.set_enabled(true);
    rig.watcher.tick();
    let status = folder.read();
    assert_eq!(status["enabled"], true);
    assert_eq!(status["phase"], "hidden");
    assert_eq!(status["gate"], "open");
    assert!(status["scan_ms"].is_number());
    assert_eq!(status["kind"], serde_json::Value::Null);
    rig.clock.advance(TICK);
    rig.audio.zoom.store(true, Ordering::SeqCst);
    // Heard at the next quiet scan (6 s), offered 8 s later.
    rig.run(16);
    let status = folder.read();
    assert_eq!(status["phase"], "offered");
    assert_eq!(status["stage"], "offered");
    assert_eq!(status["kind"], "native");
    let text = std::fs::read_to_string(folder.0.join("_status.json")).unwrap();
    assert!(!text.to_lowercase().contains("zoom"), "{text}");
    // The setting goes off: said at once.
    rig.watcher.set_enabled(false);
    let status = folder.read();
    assert_eq!(status["enabled"], false);
    assert_eq!(status["gate"], "off");
    assert_eq!(status["phase"], "hidden");
}

#[test]
fn the_status_file_says_how_long_the_start_request_took_to_be_claimed() {
    let rig = Rig::new();
    let folder = StatusFolder::new(&rig);
    rig.offer();
    rig.watcher.start();
    rig.clock.advance(Duration::from_millis(1500));
    rig.watcher.start_claimed();
    rig.app.recording.store(true, Ordering::SeqCst);
    rig.app.live.store(true, Ordering::SeqCst);
    rig.watcher.tick();
    assert_eq!(
        folder.read()["last_start"],
        serde_json::json!({ "claimed_after_ms": 1500, "timed_out": false })
    );
    // A claim with no "Start" before it (the shortcut) changes nothing.
    rig.watcher.start_claimed();
    rig.run(4);
    assert_eq!(folder.read()["last_start"]["claimed_after_ms"], 1500);
}

#[test]
fn the_status_file_says_when_the_wait_for_the_recording_ran_out() {
    let rig = Rig::new();
    let folder = StatusFolder::new(&rig);
    rig.offer();
    rig.watcher.start();
    // The web app never claims the request (its window is hidden and slow): the wait runs out.
    rig.run(10);
    assert!(rig.app.take().contains(&Action::Present));
    assert_eq!(
        folder.read()["last_start"],
        serde_json::json!({ "claimed_after_ms": null, "timed_out": true })
    );
    // A late claim is still measured.
    rig.watcher.start_claimed();
    rig.run(32);
    let last = folder.read()["last_start"].clone();
    assert_eq!(last["timed_out"], true);
    assert!(
        last["claimed_after_ms"].as_u64().unwrap() >= 10_000,
        "{last}"
    );
}
