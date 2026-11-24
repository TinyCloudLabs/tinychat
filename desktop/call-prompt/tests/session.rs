//! The state machine of one call, driven tick by tick with made-up scans.

use call_prompt::apps::lookup;
use call_prompt::mic::Heard;
use call_prompt::session::{
    Action, Capture, Observation, Phase, RecordingState, Session, Stage, CALL_END, RECORDING_TICK,
    START_TIMEOUT, TICK, UNANSWERED,
};
use std::time::Duration;

const ZOOM: &str = "us.zoom.xos";
const CHROME: &str = "com.google.Chrome";
const SLACK: &str = "com.tinyspeck.slackmacgap";

fn app(bundle_id: &str, playing: bool) -> Heard {
    Heard {
        app: lookup(bundle_id).expect("a listed app"),
        playing,
    }
}

/// A session and its clock.
struct Call {
    session: Session,
    now: Duration,
    /// Every action so far, with its time.
    log: Vec<(Duration, Action)>,
    /// The recording that exists while `recording` is given: its id and recorded time.
    recording_id: String,
    elapsed_ms: u64,
}

impl Call {
    fn new() -> Self {
        Call {
            session: Session::new(),
            now: Duration::from_secs(1000),
            log: Vec::new(),
            recording_id: "rec-1".into(),
            elapsed_ms: 0,
        }
    }

    fn record(&mut self, actions: Vec<Action>) -> Vec<Action> {
        for action in &actions {
            self.log.push((self.now, *action));
        }
        actions
    }

    /// One tick at the current time.
    fn tick_with(&mut self, heard: Option<&[Heard]>, recording: bool, live: bool) -> Vec<Action> {
        // A recording that exists but does not capture is paused (or still starting).
        let capture = recording.then(|| Capture {
            id: self.recording_id.clone(),
            elapsed_ms: self.elapsed_ms,
            paused: !live,
        });
        let actions = self.session.tick(
            self.now,
            &Observation {
                heard,
                recording,
                live,
                capture: capture.as_ref(),
            },
        );
        self.record(actions)
    }

    /// Ticks every 2 s for `seconds` (the first one now), with the same scan each time.
    fn run(&mut self, seconds: u64, heard: &[Heard], recording: bool, live: bool) -> Vec<Action> {
        let mut actions = Vec::new();
        let end = self.now + Duration::from_secs(seconds);
        while self.now < end {
            actions.extend(self.tick_with(Some(heard), recording, live));
            self.now += TICK;
        }
        actions
    }

    fn start(&mut self) -> Vec<Action> {
        let actions = self.session.start(self.now);
        self.record(actions)
    }

    fn dismiss(&mut self) -> Vec<Action> {
        let actions = self.session.dismiss(self.now);
        self.record(actions)
    }

    fn shows(&self) -> usize {
        self.log
            .iter()
            .filter(|(_, action)| *action == Action::Show)
            .count()
    }

    fn first(&self, wanted: Action) -> Option<Duration> {
        self.log
            .iter()
            .find(|(_, action)| *action == wanted)
            .map(|(at, _)| *at)
    }
}

#[test]
fn no_listed_app_means_no_offer() {
    let mut call = Call::new();
    assert!(call.run(300, &[], false, false).is_empty());
    assert_eq!(call.session.stage(), Stage::Idle);
    assert_eq!(call.session.phase(), Phase::Hidden);
}

#[test]
fn a_native_app_must_capture_for_eight_seconds() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    let started = call.now;
    assert!(
        call.run(8, &zoom, false, false).is_empty(),
        "nothing before 8 s"
    );
    assert_eq!(call.session.stage(), Stage::Hearing);
    let actions = call.run(2, &zoom, false, false);
    assert_eq!(actions, [Action::Phase(Phase::Offered), Action::Show]);
    assert_eq!(
        call.first(Action::Show),
        Some(started + Duration::from_secs(8))
    );
    assert_eq!(call.session.phase(), Phase::Offered);
}

#[test]
fn a_break_in_the_capture_restarts_the_sustain() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(6, &zoom, false, false);
    call.run(2, &[], false, false);
    assert!(call.run(8, &zoom, false, false).is_empty());
    assert_eq!(
        call.run(2, &zoom, false, false),
        [Action::Phase(Phase::Offered), Action::Show]
    );
}

#[test]
fn the_offer_shows_once_per_call() {
    let mut call = Call::new();
    call.run(600, &[app(ZOOM, true)], false, false);
    assert_eq!(call.shows(), 1);
}

#[test]
fn a_browser_needs_both_streams() {
    let mut call = Call::new();
    // Dictation in a browser: capturing, never playing.
    call.run(120, &[app(CHROME, false)], false, false);
    assert_eq!(call.shows(), 0);
    assert_eq!(call.session.stage(), Stage::Hearing);

    let started = call.now;
    call.run(20, &[app(CHROME, true)], false, false);
    assert_eq!(call.shows(), 1);
    assert_eq!(
        call.first(Action::Show),
        Some(started + Duration::from_secs(16))
    );
}

#[test]
fn a_chrome_helper_counts_as_chrome() {
    let mut call = Call::new();
    call.run(20, &[app("com.google.Chrome.helper", true)], false, false);
    assert_eq!(call.shows(), 1);
    assert_eq!(call.session.kind(), Some(call_prompt::apps::Kind::Browser));
}

#[test]
fn not_now_lasts_the_call() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    assert_eq!(call.dismiss(), [Action::Hide, Action::Phase(Phase::Hidden)]);
    assert_eq!(call.session.stage(), Stage::Dismissed);
    assert!(call.run(1200, &zoom, false, false).is_empty());
    assert_eq!(call.shows(), 1);
}

#[test]
fn a_twenty_second_drop_is_the_same_call() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.dismiss();
    call.run(20, &[], false, false);
    call.run(60, &zoom, false, false);
    assert_eq!(call.shows(), 1);
    assert_eq!(call.session.stage(), Stage::Dismissed);
}

#[test]
fn a_forty_second_drop_is_a_new_call() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.dismiss();
    call.run(40, &[], false, false);
    assert_eq!(call.session.stage(), Stage::Idle);
    call.run(10, &zoom, false, false);
    assert_eq!(call.shows(), 2);
}

#[test]
fn a_call_that_ends_while_offered_hides_the_tile() {
    let mut call = Call::new();
    call.run(10, &[app(ZOOM, false)], false, false);
    let actions = call.run(32, &[], false, false);
    assert_eq!(actions, [Action::Hide, Action::Phase(Phase::Hidden)]);
    assert_eq!(call.session.stage(), Stage::Idle);
}

#[test]
fn a_recording_at_call_start_gets_the_bar_and_never_an_offer() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    let actions = call.run(60, &zoom, true, true);
    assert_eq!(&actions[..2], [bar(0, false), Action::Show]);
    assert!(!actions.contains(&Action::Phase(Phase::Offered)));
    assert_eq!(call.session.stage(), Stage::Recording);
    // The recording stops mid-call: the offer comes, at once.
    assert_eq!(
        call.run(2, &zoom, false, false),
        [Action::Phase(Phase::Offered)]
    );
    assert_eq!(call.session.stage(), Stage::Offered);
}

#[test]
fn a_recording_begun_by_the_shortcut_while_offered_turns_the_offer_into_the_bar() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    assert_eq!(call.session.phase(), Phase::Offered);
    let actions = call.run(2, &zoom, true, false);
    assert_eq!(actions, [bar(0, true)], "the visible tile becomes the bar");
    assert_eq!(call.session.stage(), Stage::Recording);
    assert!(!call.session.from_tile());
    // Over, the call goes on: the offer again.
    assert_eq!(
        call.run(2, &zoom, false, false),
        [Action::Phase(Phase::Offered)]
    );
    assert_eq!(call.shows(), 1, "the tile never left the screen");
}

#[test]
fn start_sends_one_request_and_the_tile_stays_as_the_recording_runs() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    assert_eq!(
        call.start(),
        [Action::Phase(Phase::Starting), Action::Start]
    );
    assert!(call.start().is_empty(), "a second press sends nothing");
    assert!(
        call.dismiss().is_empty(),
        "Not now does nothing while starting"
    );
    assert_eq!(call.session.stage(), Stage::Starting);
    assert_eq!(call.session.next_tick(call.now), Duration::from_millis(500));

    // The recorder captures: the tile becomes the bar and stays, with the recorder's time.
    call.elapsed_ms = 300;
    let actions = call.tick_with(Some(&zoom), true, true);
    assert_eq!(
        actions,
        [Action::Recording(RecordingState {
            elapsed_ms: 300,
            paused: false
        })]
    );
    assert_eq!(call.session.stage(), Stage::Recording);
    assert_eq!(call.session.phase(), Phase::Recording);
    assert_eq!(call.session.next_tick(call.now), RECORDING_TICK);
    assert!(RECORDING_TICK <= Duration::from_secs(1));
    for second in 1..=600u64 {
        call.now += RECORDING_TICK;
        call.elapsed_ms = 300 + second * 500;
        let actions = call.tick_with(Some(&zoom), true, true);
        assert_eq!(
            actions,
            [Action::Recording(RecordingState {
                elapsed_ms: call.elapsed_ms,
                paused: false
            })]
        );
    }
    let starts = call.log.iter().filter(|(_, a)| *a == Action::Start).count();
    assert_eq!(starts, 1);
    assert_eq!(call.shows(), 1);
}

/// A call whose offer was started and whose recording runs, with the tile as the bar.
fn recording_call() -> (Call, [Heard; 1]) {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.start();
    call.tick_with(Some(&zoom), true, true);
    assert_eq!(call.session.stage(), Stage::Recording);
    (call, zoom)
}

fn bar(elapsed_ms: u64, paused: bool) -> Action {
    Action::Recording(RecordingState { elapsed_ms, paused })
}

fn hidden() -> [Action; 2] {
    [Action::Hide, Action::Phase(Phase::Hidden)]
}

#[test]
fn a_recording_over_during_the_call_brings_the_offer_back() {
    // Stopped in the app, stopped by its limit or discarded: the recorder has no recording.
    let (mut call, zoom) = recording_call();
    call.now += RECORDING_TICK;
    assert_eq!(
        call.tick_with(Some(&zoom), false, false),
        [Action::Phase(Phase::Offered)]
    );
    assert_eq!(call.session.stage(), Stage::Offered);
    // Recorded again from the offer, stopped again: the offer again.
    call.start();
    call.recording_id = "rec-2".into();
    call.tick_with(Some(&zoom), true, true);
    assert!(call.session.from_tile());
    call.now += RECORDING_TICK;
    assert_eq!(
        call.tick_with(Some(&zoom), false, false),
        [Action::Phase(Phase::Offered)]
    );
}

#[test]
fn not_now_keeps_the_offer_away_but_a_later_recording_gets_its_bar() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.dismiss();
    // Recorded from the app later in the call: the bar.
    let actions = call.run(2, &zoom, true, true);
    assert_eq!(actions, [bar(0, false), Action::Show]);
    // Over: hidden, not offered.
    assert_eq!(call.run(2, &zoom, false, false), hidden());
    assert_eq!(call.session.stage(), Stage::Dismissed);
    call.run(300, &zoom, false, false);
    assert!(!call
        .log
        .iter()
        .skip(1)
        .any(|(_, action)| *action == Action::Phase(Phase::Offered)));
}

#[test]
fn an_unanswered_offer_comes_back_after_a_recording() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.run(130, &zoom, false, false);
    assert_eq!(call.session.stage(), Stage::Dismissed, "unanswered");
    call.run(10, &zoom, true, true);
    // The bar was on screen: it becomes the offer.
    assert_eq!(
        call.run(2, &zoom, false, false),
        [Action::Phase(Phase::Offered)]
    );
}

#[test]
fn a_recording_without_a_call_gets_no_tile() {
    let mut call = Call::new();
    assert!(call.run(120, &[], true, true).is_empty());
    assert_eq!(call.session.stage(), Stage::Idle);
}

#[test]
fn the_bar_of_a_recording_not_started_from_the_tile_hides_when_the_call_ends() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, true, true);
    assert_eq!(call.session.phase(), Phase::Recording);
    // Zoom goes quiet; the recording goes on.
    let actions = call.run(40, &[], true, true);
    assert!(
        actions.ends_with(&hidden()) || actions.contains(&Action::Hide),
        "{actions:?}"
    );
    assert_eq!(call.session.stage(), Stage::Idle);
    assert_eq!(call.session.phase(), Phase::Hidden);
}

#[test]
fn another_recording_between_two_ticks_keeps_the_bar() {
    let (mut call, zoom) = recording_call();
    assert!(call.session.from_tile());
    // The recording stopped and the user started another one in the app between two ticks.
    call.recording_id = "rec-2".into();
    call.elapsed_ms = 0;
    call.now += RECORDING_TICK;
    assert_eq!(call.tick_with(Some(&zoom), true, true), [bar(0, false)]);
    assert_eq!(call.session.stage(), Stage::Recording);
    assert!(
        !call.session.from_tile(),
        "the new one did not come from the tile"
    );
    // Stop works for it too, once.
    assert_eq!(call.session.stop(call.now), [Action::Stop]);
}

#[test]
fn stop_on_the_tile_sends_one_stop_and_the_bar_goes_when_the_recorder_has_stopped() {
    let (mut call, zoom) = recording_call();
    assert_eq!(call.session.stop(call.now), [Action::Stop]);
    assert!(
        call.session.stop(call.now).is_empty(),
        "one click, one stop"
    );
    // The app stops and saves: the recording still exists while it closes.
    call.elapsed_ms = 4_000;
    for _ in 0..4 {
        call.now += RECORDING_TICK;
        assert_eq!(
            call.tick_with(Some(&zoom), true, false),
            [Action::Recording(RecordingState {
                elapsed_ms: 4_000,
                paused: true
            })]
        );
    }
    call.now += RECORDING_TICK;
    assert_eq!(
        call.tick_with(Some(&zoom), false, false),
        [Action::Phase(Phase::Offered)]
    );
    assert!(
        call.session.stop(call.now).is_empty(),
        "nothing to stop any more"
    );
}

#[test]
fn stop_does_nothing_outside_a_recording_the_tile_shows() {
    let mut call = Call::new();
    assert!(call.session.stop(call.now).is_empty());
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    assert!(call.session.stop(call.now).is_empty(), "offered");
    call.start();
    assert!(call.session.stop(call.now).is_empty(), "starting");
}

#[test]
fn a_pause_keeps_the_tile_with_the_time_standing_still() {
    let (mut call, zoom) = recording_call();
    call.elapsed_ms = 60_000;
    for _ in 0..10 {
        call.now += RECORDING_TICK;
        assert_eq!(
            call.tick_with(Some(&zoom), true, false),
            [Action::Recording(RecordingState {
                elapsed_ms: 60_000,
                paused: true
            })]
        );
    }
    // Resumed.
    call.elapsed_ms = 60_500;
    call.now += RECORDING_TICK;
    assert_eq!(
        call.tick_with(Some(&zoom), true, true),
        [Action::Recording(RecordingState {
            elapsed_ms: 60_500,
            paused: false
        })]
    );
    assert_eq!(call.session.stage(), Stage::Recording);
}

#[test]
fn the_call_ending_first_keeps_the_tile_until_the_recording_is_over() {
    let (mut call, _zoom) = recording_call();
    // Zoom goes quiet for minutes, the Mac sleeps for one: the recording goes on, so does the bar.
    for _ in 0..240 {
        call.now += RECORDING_TICK;
        let actions = call.tick_with(Some(&[]), true, true);
        assert!(
            matches!(actions.as_slice(), [Action::Recording(_)]),
            "{actions:?}"
        );
    }
    call.now += Duration::from_secs(60);
    let actions = call.tick_with(Some(&[]), true, true);
    assert!(
        matches!(actions.as_slice(), [Action::Recording(_)]),
        "{actions:?}"
    );
    // The recording ends: the tile hides, and the call that ended meanwhile ends too.
    call.now += RECORDING_TICK;
    assert_eq!(call.tick_with(Some(&[]), false, false), hidden());
    call.now += TICK;
    call.tick_with(Some(&[]), false, false);
    assert_eq!(call.session.stage(), Stage::Idle);
    // A new call gets a new offer.
    call.run(10, &[app(ZOOM, false)], false, false);
    assert_eq!(call.shows(), 2);
}

#[test]
fn the_tile_state_carries_the_time_only_while_recording() {
    let (mut call, zoom) = recording_call();
    call.elapsed_ms = 65_000;
    call.now += RECORDING_TICK;
    call.tick_with(Some(&zoom), true, false);
    let state = serde_json::to_value(call.session.tile()).unwrap();
    assert_eq!(
        state,
        serde_json::json!({ "phase": "recording", "elapsedMs": 65_000, "paused": true })
    );
    call.now += RECORDING_TICK;
    call.tick_with(Some(&zoom), false, false);
    assert_eq!(
        serde_json::to_value(call.session.tile()).unwrap(),
        serde_json::json!({ "phase": "offered" })
    );
}

#[test]
fn a_start_that_does_not_record_brings_the_main_window_forward_and_a_late_recording_gets_its_bar() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.start();
    let pressed = call.now;
    // A consent question in the main window: no recording yet.
    while call.now < pressed + START_TIMEOUT {
        assert!(call.tick_with(Some(&zoom), false, false).is_empty());
        call.now += Duration::from_millis(500);
    }
    let actions = call.tick_with(Some(&zoom), false, false);
    assert_eq!(
        actions,
        [Action::Hide, Action::Phase(Phase::Hidden), Action::Present]
    );
    assert_eq!(call.session.stage(), Stage::Started);
    assert!(
        call.run(30, &zoom, false, false).is_empty(),
        "no offer meanwhile"
    );
    // The user answers; the recording starts: its bar, as one started from the tile.
    assert_eq!(
        call.run(2, &zoom, true, true),
        [bar(0, false), Action::Show]
    );
    assert!(call.session.from_tile());
}

#[test]
fn two_apps_give_one_tile() {
    let mut call = Call::new();
    call.run(
        300,
        &[app(ZOOM, true), app(SLACK, true), app(CHROME, true)],
        false,
        false,
    );
    assert_eq!(call.shows(), 1);
    assert_eq!(call.session.kind(), Some(call_prompt::apps::Kind::Native));
}

#[test]
fn the_second_app_waits_until_the_first_call_ends() {
    let mut call = Call::new();
    call.run(10, &[app(ZOOM, false)], false, false);
    call.dismiss();
    // Slack joins while the Zoom call goes on: no second tile.
    call.run(60, &[app(ZOOM, false), app(SLACK, false)], false, false);
    assert_eq!(call.shows(), 1);
    // Zoom ends; Slack goes on and gets its own offer.
    call.run(60, &[app(SLACK, false)], false, false);
    assert_eq!(call.shows(), 2);
    assert_eq!(call.session.stage(), Stage::Offered);
}

#[test]
fn two_minutes_unanswered_hides_the_offer_for_the_call() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    let offered = call.first(Action::Show).unwrap();
    call.run(300, &zoom, false, false);
    let hidden = call
        .log
        .iter()
        .find(|(_, action)| *action == Action::Hide)
        .map(|(at, _)| *at)
        .unwrap();
    assert_eq!(hidden - offered, UNANSWERED);
    assert_eq!(call.session.stage(), Stage::Dismissed);
    assert_eq!(call.shows(), 1);
}

#[test]
fn turning_the_setting_off_hides_the_tile_and_forgets_the_call() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    let actions = call.session.reset();
    assert_eq!(actions, [Action::Hide, Action::Phase(Phase::Hidden)]);
    assert_eq!(call.session.stage(), Stage::Idle);
    assert!(call.session.reset().is_empty(), "nothing to hide twice");
}

#[test]
fn a_sleep_ends_the_call() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.dismiss();
    // The Mac sleeps for a minute with the call app still open.
    call.now += Duration::from_secs(60);
    call.tick_with(Some(&zoom), false, false);
    assert_eq!(call.session.stage(), Stage::Hearing);
    call.run(10, &zoom, false, false);
    assert_eq!(call.shows(), 2);
}

#[test]
fn a_gap_just_under_the_call_end_keeps_the_call() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.dismiss();
    let last_tick = call.now - TICK;
    call.now = last_tick + CALL_END - Duration::from_secs(1);
    call.tick_with(Some(&zoom), false, false);
    assert_eq!(call.session.stage(), Stage::Dismissed);
    call.now += CALL_END;
    call.tick_with(Some(&zoom), false, false);
    assert_eq!(call.session.stage(), Stage::Hearing, "a full gap ends it");
}

#[test]
fn a_failed_scan_neither_starts_nor_ends_a_call() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.dismiss();
    for _ in 0..40 {
        call.tick_with(None, false, false);
        call.now += TICK;
    }
    assert_eq!(call.session.stage(), Stage::Dismissed);

    let mut idle = Call::new();
    for _ in 0..40 {
        idle.tick_with(None, false, false);
        idle.now += TICK;
    }
    assert_eq!(idle.session.stage(), Stage::Idle);
}

/// A small deterministic generator, so that the test needs no dependency.
struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn over_random_input_a_bar_only_while_recording_never_an_offer_while_recording_and_not_now_holds() {
    let pool = [
        ZOOM,
        CHROME,
        SLACK,
        "com.apple.avconferenced",
        "com.google.Chrome.helper",
    ];
    let (mut offers, mut bars) = (0, 0);
    for seed in 1..=200u64 {
        let mut random = Random(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let mut session = Session::new();
        let mut now = Duration::from_secs(50);
        let mut recording = false;
        // Each recording has its own id; sometimes one ends and the next starts between ticks.
        let mut generation = 0u64;
        let mut stopped = false;
        // An independent model of "Not now": from an effective press until the call may have
        // ended (the setting went off, no tick came for CALL_END, or the call's app was not heard
        // for CALL_END).
        let mut not_now: Option<(call_prompt::apps::AppId, Duration)> = None;
        let mut last_tick: Option<Duration> = None;
        for _ in 0..3000 {
            let mut heard: Vec<Heard> = Vec::new();
            let mut ticked = false;
            let mut scan_failed = false;
            let mut capture = None;
            let actions = match random.below(20) {
                0 => session.start(now),
                1 if random.below(2) == 0 => {
                    let owner = session.app();
                    let actions = session.dismiss(now);
                    if actions.contains(&Action::Hide) {
                        not_now = Some((owner.expect("an offer has an app"), now));
                    }
                    actions
                }
                1 => {
                    let actions = session.stop(now);
                    if actions.contains(&Action::Stop) {
                        assert!(!stopped, "seed {seed}: two stops for one recording");
                        stopped = true;
                    }
                    actions
                }
                2 => {
                    not_now = None;
                    last_tick = None;
                    session.reset()
                }
                _ => {
                    ticked = true;
                    if random.below(30) == 0 {
                        recording = !recording;
                        if recording {
                            generation += 1;
                            stopped = false;
                        }
                    }
                    if recording && random.below(200) == 0 {
                        generation += 1;
                        stopped = false;
                    }
                    for id in pool {
                        if random.below(3) == 0 {
                            continue;
                        }
                        let entry = app(id, random.below(4) != 0);
                        if !heard.iter().any(|seen| seen.app == entry.app) {
                            heard.push(entry);
                        }
                    }
                    if random.below(10) == 0 {
                        heard.clear();
                    }
                    let live = recording && random.below(2) == 0;
                    capture = recording.then(|| Capture {
                        id: format!("rec-{generation}"),
                        elapsed_ms: random.below(10_000_000),
                        paused: !live,
                    });
                    scan_failed = random.below(25) == 0;
                    session.tick(
                        now,
                        &Observation {
                            heard: (!scan_failed).then_some(heard.as_slice()),
                            recording,
                            live,
                            capture: capture.as_ref(),
                        },
                    )
                }
            };
            if ticked {
                if last_tick.is_some_and(|last| now.saturating_sub(last) >= CALL_END) {
                    not_now = None;
                }
                last_tick = Some(now);
                if let Some((owner, last_heard)) = not_now.as_mut() {
                    if !scan_failed {
                        if heard.iter().any(|entry| entry.app == *owner) {
                            *last_heard = now;
                        } else if now.saturating_sub(*last_heard) >= CALL_END {
                            not_now = None;
                        }
                    }
                }
                let phase = session.phase();
                // A bar only while a recording is in progress, and always then while the session
                // follows a call.
                if phase == Phase::Recording {
                    assert!(capture.is_some(), "seed {seed}: a bar with no recording");
                    bars += 1;
                }
                if capture.is_some() && session.stage() != Stage::Idle {
                    assert_eq!(
                        phase,
                        Phase::Recording,
                        "seed {seed}: a recording without its bar"
                    );
                }
            }
            if actions.contains(&Action::Phase(Phase::Offered)) {
                assert!(capture.is_none(), "seed {seed}: an offer while recording");
                assert!(
                    not_now.is_none(),
                    "seed {seed}: an offer after Not now in the call"
                );
                offers += 1;
            }
            // Mostly the watcher's pace; sometimes a long gap (sleep) or a fast tick.
            now += match random.below(40) {
                0 => Duration::from_secs(45),
                1..=4 => Duration::from_millis(500),
                _ => TICK,
            };
        }
    }
    assert!(
        offers > 200 && bars > 1000,
        "the input exercises both: {offers} offers, {bars} bars"
    );
}
