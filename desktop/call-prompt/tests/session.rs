//! The state machine of one call, driven tick by tick with made-up scans.

use call_prompt::apps::lookup;
use call_prompt::mic::Heard;
use call_prompt::session::{
    Action, Observation, Phase, Session, Stage, CALL_END, RECORDING_DOT, START_TIMEOUT, TICK,
    UNANSWERED,
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
}

impl Call {
    fn new() -> Self {
        Call {
            session: Session::new(),
            now: Duration::from_secs(1000),
            log: Vec::new(),
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
        let actions = self.session.tick(
            self.now,
            &Observation {
                heard,
                recording,
                live,
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
fn a_recording_at_call_start_is_never_offered() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    assert!(call.run(60, &zoom, true, true).is_empty());
    assert_eq!(call.session.stage(), Stage::Started);
    // The recording stops mid-call: the offer does not come back.
    assert!(call.run(300, &zoom, false, false).is_empty());
    assert_eq!(call.shows(), 0);
}

#[test]
fn a_recording_begun_by_the_shortcut_while_offered_hides_the_tile_for_good() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    assert_eq!(call.session.phase(), Phase::Offered);
    let actions = call.run(2, &zoom, true, false);
    assert_eq!(actions, [Action::Hide, Action::Phase(Phase::Hidden)]);
    assert_eq!(call.session.stage(), Stage::Started);
    call.run(300, &zoom, false, false);
    assert_eq!(call.shows(), 1);
}

#[test]
fn start_sends_one_request_and_live_hides_after_the_red_dot() {
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

    // The recorder captures: the red dot, then the tile hides.
    let actions = call.tick_with(Some(&zoom), true, true);
    assert_eq!(actions, [Action::Phase(Phase::Recording)]);
    assert_eq!(call.session.next_tick(call.now), RECORDING_DOT);
    call.now += RECORDING_DOT;
    let actions = call.tick_with(Some(&zoom), true, true);
    assert_eq!(actions, [Action::Hide, Action::Phase(Phase::Hidden)]);
    assert_eq!(call.session.stage(), Stage::Started);

    call.run(300, &zoom, false, false);
    let starts = call.log.iter().filter(|(_, a)| *a == Action::Start).count();
    assert_eq!(starts, 1);
    assert_eq!(call.shows(), 1);
}

#[test]
fn a_start_that_does_not_capture_brings_the_main_window_forward() {
    let mut call = Call::new();
    let zoom = [app(ZOOM, false)];
    call.run(10, &zoom, false, false);
    call.start();
    let pressed = call.now;
    // A consent question in the main window: a recording exists, it does not capture.
    while call.now < pressed + START_TIMEOUT {
        assert!(call.tick_with(Some(&zoom), true, false).is_empty());
        call.now += Duration::from_millis(500);
    }
    let actions = call.tick_with(Some(&zoom), true, false);
    assert_eq!(
        actions,
        [Action::Hide, Action::Phase(Phase::Hidden), Action::Present]
    );
    assert_eq!(call.session.stage(), Stage::Started);
    call.run(300, &zoom, false, false);
    assert_eq!(call.shows(), 1);
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
fn over_random_input_never_a_show_while_recording_and_at_most_one_per_call() {
    let pool = [
        ZOOM,
        CHROME,
        SLACK,
        "com.apple.avconferenced",
        "com.google.Chrome.helper",
    ];
    let mut total_shows = 0;
    for seed in 1..=200u64 {
        let mut random = Random(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let mut session = Session::new();
        let mut now = Duration::from_secs(50);
        let mut recording = false;
        // An independent model of when the offered call may have ended: the setting went off,
        // no tick came for CALL_END, or the offered app was not heard for CALL_END.
        let mut offered: Option<(call_prompt::apps::AppId, Duration)> = None;
        let mut ended = true;
        let mut last_tick: Option<Duration> = None;
        for _ in 0..3000 {
            let mut heard: Vec<Heard> = Vec::new();
            let mut ticked = false;
            let mut scan_failed = false;
            let actions = match random.below(20) {
                0 => session.start(now),
                1 => session.dismiss(now),
                2 => {
                    ended = true;
                    last_tick = None;
                    session.reset()
                }
                _ => {
                    ticked = true;
                    if random.below(30) == 0 {
                        recording = !recording;
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
                    scan_failed = random.below(25) == 0;
                    session.tick(
                        now,
                        &Observation {
                            heard: (!scan_failed).then_some(heard.as_slice()),
                            recording,
                            live,
                        },
                    )
                }
            };
            if ticked {
                if last_tick.is_some_and(|last| now.saturating_sub(last) >= CALL_END) {
                    ended = true;
                }
                last_tick = Some(now);
                if let Some((owner, last_heard)) = offered.as_mut() {
                    if !scan_failed {
                        if heard.iter().any(|entry| entry.app == *owner) {
                            *last_heard = now;
                        } else if now.saturating_sub(*last_heard) >= CALL_END {
                            ended = true;
                        }
                    }
                }
            }
            for action in &actions {
                if *action == Action::Show {
                    assert!(!recording, "seed {seed}: shown while recording");
                    assert!(ended, "seed {seed}: a second offer in one call at {now:?}");
                    ended = false;
                    offered = Some((session.app().expect("an offer has an app"), now));
                    total_shows += 1;
                }
            }
            // Mostly the watcher's pace; sometimes a long gap (sleep) or a fast tick.
            now += match random.below(40) {
                0 => Duration::from_secs(45),
                1..=4 => Duration::from_millis(500),
                _ => TICK,
            };
        }
    }
    assert!(total_shows > 200, "the input makes offers: {total_shows}");
}
