//! One call at a time: when the tile shows, when it hides, and what "Start", "Not now" and
//! "Stop" do.
//!
//! Stages:
//! - [`Stage::Idle`]: no call app captures.
//! - [`Stage::Hearing`]: a call app captures, but its rule has not held long enough
//!   ([`crate::apps`]: capturing for 8 s, or for a browser capturing and playing for 15 s).
//! - [`Stage::Offered`]: the tile shows "Record this call", "Start" and "Not now".
//! - [`Stage::Starting`]: "Start" was pressed; the app waits up to [`START_TIMEOUT`] for the
//!   recording to exist.
//! - [`Stage::Recording`]: a recording is in progress, and the tile is its bar: a red dot, the
//!   recorder's own time ([`RecordingState`], sent every [`RECORDING_TICK`]) and "Stop".
//! - [`Stage::Started`]: "Start" was pressed but no recording came within [`START_TIMEOUT`]; the
//!   tile is hidden and the main window shows what is needed. A recording that comes gets its
//!   bar.
//! - [`Stage::Dismissed`]: "Not now", or [`UNANSWERED`] without an answer; the tile is hidden.
//!
//! The bar, whatever started the recording (the tile, the app's button, the menu-bar item, the
//! shortcut):
//! - While a call is followed and a recording is in progress, the tile is the recording's bar. A
//!   recording in progress when a call app starts to capture takes the call at once: never an
//!   offer while recording.
//! - When that recording is over (stopped from the tile or in the app, stopped by its limit, or
//!   discarded: the recorder has no recording) and the call goes on, the offer comes back, unless
//!   the user pressed "Not now" in this call. Another recording between two ticks keeps the bar.
//! - A recording with no call followed gets no tile, except one started from the tile: its bar
//!   stays until it is over, also when the call ends meanwhile (its app gone quiet, the Mac
//!   asleep); the call then ends with the recording. When the call of any other recording ends,
//!   its bar hides.
//! - "Not now" hides the offer for the rest of the call; a recording later in that call still
//!   gets its bar.
//!
//! The call belongs to the first app whose rule holds; other apps wait until it ends. A call ends
//! when its app has not captured for [`CALL_END`], or when no tick came for [`CALL_END`] (the Mac
//! slept). Then the session is idle again and the next call gets a new offer. There is no
//! cool-down per app: it would miss back-to-back calls.
//!
//! The session is pure: times are given (`now`, from any monotonic clock that keeps counting
//! while the Mac sleeps), and it answers with [`Action`]s for the app to carry out in order.

use crate::apps::{AppId, Kind};
use crate::mic::Heard;
use crate::tile::TileState;
use serde::Serialize;
use std::time::Duration;

/// The watcher's pace.
pub const TICK: Duration = Duration::from_secs(2);
/// The pace while waiting for a started recording to capture.
pub const STARTING_TICK: Duration = Duration::from_millis(500);
/// A call ends when its app has not captured for this long, or when no tick came for this long.
pub const CALL_END: Duration = Duration::from_secs(30);
/// An offer without an answer hides after this long and counts as "Not now".
pub const UNANSWERED: Duration = Duration::from_secs(120);
/// How long "Start" waits for the recorder to capture before it brings the main window forward.
pub const START_TIMEOUT: Duration = Duration::from_secs(8);
/// The pace while the tile shows a recording: its time goes to the tile at least once a second.
pub const RECORDING_TICK: Duration = Duration::from_millis(500);

/// What the tile shows. The tile's page gets it as `{ "phase": … }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Nothing; the tile is hidden.
    Hidden,
    /// "Record this call", "Start" and "Not now".
    Offered,
    /// "Start" was pressed: the buttons are disabled.
    Starting,
    /// The recording started from the tile runs: a bar with its time and "Stop".
    Recording,
}

/// The recording the tile shows, from the recorder's own clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordingState {
    /// Recorded time: it does not move while the recording is paused.
    pub elapsed_ms: u64,
    pub paused: bool,
}

/// The recording that exists now, as the recorder tells it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture {
    /// The recording's id, to tell one recording from the next. Kept in memory only.
    pub id: String,
    pub elapsed_ms: u64,
    pub paused: bool,
}

impl Capture {
    pub fn state(&self) -> RecordingState {
        RecordingState {
            elapsed_ms: self.elapsed_ms,
            paused: self.paused,
        }
    }
}

/// Where the session is in the current call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Idle,
    Hearing,
    Offered,
    Starting,
    Recording,
    Started,
    Dismissed,
}

impl Stage {
    /// For the app's log.
    pub const fn as_str(self) -> &'static str {
        match self {
            Stage::Idle => "idle",
            Stage::Hearing => "hearing",
            Stage::Offered => "offered",
            Stage::Starting => "starting",
            Stage::Recording => "recording",
            Stage::Started => "started",
            Stage::Dismissed => "dismissed",
        }
    }
}

/// What the app does, in the order given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Tell the tile its phase (the `exo://call-prompt` event).
    Phase(Phase),
    /// Dock the tile and show it, without taking the keyboard.
    Show,
    /// Hide the tile.
    Hide,
    /// Ask the web app to start a recording, as the menu-bar item does.
    Start,
    /// Bring the main window forward: the recording did not start by itself.
    Present,
    /// Build the tile's window, hidden, so that its page loads; show nothing. The watcher sends
    /// it (`service`), never the session: the tile shows only once its page has asked for its
    /// state.
    Prepare,
    /// Tell the tile the recording's state (`recording`, its time, paused or not). The first one
    /// makes the tile the compact bar.
    Recording(RecordingState),
    /// Ask the web app to stop the recording through its own Stop.
    Stop,
}

/// What the watcher saw in one tick.
#[derive(Clone, Copy, Debug)]
pub struct Observation<'a> {
    /// The call apps that capture now. `None` when the scan failed: nothing is known about them,
    /// so no call starts or ends on this tick.
    pub heard: Option<&'a [Heard]>,
    /// A recording exists (capturing, paused or stopping), however it began.
    pub recording: bool,
    /// The recorder captures now.
    pub live: bool,
    /// The recording that exists now, with its clock; `None` when there is none.
    pub capture: Option<&'a Capture>,
}

/// A call app heard while no app owns the call.
#[derive(Clone, Copy, Debug)]
struct Candidate {
    app: AppId,
    first_heard: Duration,
    last_heard: Duration,
    /// Since when its rule has held without a break.
    held_since: Option<Duration>,
}

/// The state machine of the current call.
#[derive(Clone, Debug)]
pub struct Session {
    stage: Stage,
    /// When the current stage began.
    since: Duration,
    /// Why the stage (or the phase) last changed, for the status file's history.
    reason: &'static str,
    /// The call's app, from the offer (or a recording) until the call ends.
    owner: Option<AppId>,
    owner_last_heard: Duration,
    candidates: Vec<Candidate>,
    phase: Phase,
    /// The user pressed "Not now" in this call: no offer again until it ends.
    not_now: bool,
    /// The recording the tile shows.
    recording_id: Option<String>,
    /// It was started from the tile.
    from_tile: bool,
    /// The call ended while a recording started from the tile went on.
    call_ended: bool,
    clock: RecordingState,
    /// The recording "Stop" was last sent for: one stop per recording, also when its bar comes
    /// back (the setting turned off and on, a new call).
    stopped: Option<String>,
    last_tick: Option<Duration>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether an app's rule holds in one scan.
fn rule_holds(kind: Kind, heard: &Heard) -> bool {
    match kind {
        Kind::Native => true,
        Kind::Browser => heard.playing,
    }
}

impl Session {
    pub fn new() -> Self {
        Session {
            stage: Stage::Idle,
            since: Duration::ZERO,
            reason: "start",
            owner: None,
            owner_last_heard: Duration::ZERO,
            candidates: Vec::new(),
            phase: Phase::Hidden,
            not_now: false,
            recording_id: None,
            from_tile: false,
            call_ended: false,
            clock: RecordingState {
                elapsed_ms: 0,
                paused: false,
            },
            stopped: None,
            last_tick: None,
        }
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    /// Why the stage or the phase last changed: a short code, never an id.
    pub fn reason(&self) -> &'static str {
        self.reason
    }

    /// A call app is being followed or a call is under way: the watcher scans whatever the
    /// microphone gate says, until the call has ended.
    pub fn tracking(&self) -> bool {
        self.stage != Stage::Idle
    }

    /// What the tile shows now.
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// What the tile shows now, with the recording's time in the `recording` phase.
    pub fn tile(&self) -> TileState {
        match self.phase {
            Phase::Recording => TileState::recording(self.clock),
            phase => TileState::of(phase),
        }
    }

    /// The action that tells the tile what it shows now.
    pub fn tile_action(&self) -> Action {
        match self.phase {
            Phase::Recording => Action::Recording(self.clock),
            phase => Action::Phase(phase),
        }
    }

    /// The call's app, once an app owns the call. A table entry, never a process's own id.
    pub fn app(&self) -> Option<AppId> {
        self.owner
    }

    /// The rule of the call's app, once an app owns the call.
    pub fn kind(&self) -> Option<Kind> {
        self.owner.map(AppId::kind)
    }

    /// The recording the tile shows was started from the tile.
    pub fn from_tile(&self) -> bool {
        self.stage == Stage::Recording && self.from_tile
    }

    /// How long the watcher may wait before the next tick.
    pub fn next_tick(&self, _now: Duration) -> Duration {
        match self.stage {
            Stage::Starting => STARTING_TICK,
            Stage::Recording => RECORDING_TICK,
            _ => TICK,
        }
    }

    /// One scan's worth of news.
    pub fn tick(&mut self, now: Duration, seen: &Observation<'_>) -> Vec<Action> {
        let mut actions = Vec::new();
        // The call ends when its app has been quiet, or no tick came, for CALL_END. A recording
        // started from the tile keeps its bar: the end is noted and acted on when it is over.
        let gap = self
            .last_tick
            .is_some_and(|last| now.saturating_sub(last) >= CALL_END);
        self.last_tick = Some(now);
        let mut quiet = false;
        if let (Some(owner), Some(heard)) = (self.owner, seen.heard) {
            if heard.iter().any(|entry| entry.app == owner) {
                self.owner_last_heard = now;
            } else {
                quiet = now.saturating_sub(self.owner_last_heard) >= CALL_END;
            }
        }
        if gap || quiet {
            let reason = if gap { "sleep" } else { "call_ended" };
            if self.stage == Stage::Recording && self.from_tile {
                self.call_ended = true;
            } else if self.stage != Stage::Idle {
                self.end_call(reason, &mut actions);
            }
        }

        match self.stage {
            Stage::Idle | Stage::Hearing => self.hear(now, seen, &mut actions),
            Stage::Offered => {
                if let Some(capture) = seen.capture {
                    self.enter_recording(capture, false, now, &mut actions);
                } else if now.saturating_sub(self.since) >= UNANSWERED {
                    self.enter(Stage::Dismissed, now, "unanswered");
                    self.show(Phase::Hidden, &mut actions);
                }
            }
            Stage::Starting => {
                if let Some(capture) = seen.capture {
                    // The recording started from the tile exists: the tile becomes its bar.
                    self.enter_recording(capture, true, now, &mut actions);
                } else if now.saturating_sub(self.since) >= START_TIMEOUT {
                    // A consent question, a denied microphone or an open receipt: the main
                    // window shows what is needed. A recording that comes later gets its bar.
                    self.enter(Stage::Started, now, "start_timeout");
                    self.show(Phase::Hidden, &mut actions);
                    actions.push(Action::Present);
                }
            }
            Stage::Started => {
                if let Some(capture) = seen.capture {
                    self.enter_recording(capture, true, now, &mut actions);
                }
            }
            Stage::Dismissed => {
                if let Some(capture) = seen.capture {
                    self.enter_recording(capture, false, now, &mut actions);
                }
            }
            Stage::Recording => self.follow_recording(now, seen.capture, &mut actions),
        }
        actions
    }

    /// "Start" on the tile. Only an offer can be started, once.
    pub fn start(&mut self, now: Duration) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.stage == Stage::Offered {
            self.enter(Stage::Starting, now, "start");
            self.show(Phase::Starting, &mut actions);
            actions.push(Action::Start);
        }
        actions
    }

    /// "Stop" on the tile: one request to stop, for the recording it shows.
    pub fn stop(&mut self, _now: Duration) -> Vec<Action> {
        if self.stage == Stage::Recording
            && self.recording_id.is_some()
            && self.stopped != self.recording_id
        {
            self.stopped = self.recording_id.clone();
            return vec![Action::Stop];
        }
        Vec::new()
    }

    /// "Not now" on the tile: no offer again in this call. A recording later in the call still
    /// gets its bar.
    pub fn dismiss(&mut self, now: Duration) -> Vec<Action> {
        self.withdraw(now, "not_now")
    }

    /// The tile's page never asked for its state: the offer is never shown, and counts as "Not
    /// now" for the call.
    pub fn page_missing(&mut self, now: Duration) -> Vec<Action> {
        self.withdraw(now, "page_missing")
    }

    /// The setting was turned off (or the watcher failed): hide the tile and forget the call.
    pub fn reset(&mut self) -> Vec<Action> {
        self.reset_because("reset")
    }

    /// As [`Session::reset`], with the reason for the history.
    pub fn reset_because(&mut self, reason: &'static str) -> Vec<Action> {
        let mut actions = Vec::new();
        self.end_call(reason, &mut actions);
        self.last_tick = None;
        actions
    }

    fn withdraw(&mut self, now: Duration, reason: &'static str) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.stage == Stage::Offered {
            self.not_now = true;
            self.enter(Stage::Dismissed, now, reason);
            self.show(Phase::Hidden, &mut actions);
        }
        actions
    }

    fn enter(&mut self, stage: Stage, now: Duration, reason: &'static str) {
        if self.stage != stage {
            self.stage = stage;
            self.since = now;
            self.reason = reason;
        }
    }

    /// Change what the tile shows: the phase first, then the window; on hiding, the window first.
    fn show(&mut self, phase: Phase, actions: &mut Vec<Action>) {
        if self.phase == phase {
            return;
        }
        let was_visible = self.phase != Phase::Hidden;
        self.phase = phase;
        if phase == Phase::Hidden {
            actions.push(Action::Hide);
            actions.push(Action::Phase(Phase::Hidden));
        } else {
            actions.push(Action::Phase(phase));
            if !was_visible {
                actions.push(Action::Show);
            }
        }
    }

    /// A recording is in progress while a call is followed (or it was started from the tile):
    /// the tile becomes its bar.
    fn enter_recording(
        &mut self,
        capture: &Capture,
        from_tile: bool,
        now: Duration,
        actions: &mut Vec<Action>,
    ) {
        self.enter(
            Stage::Recording,
            now,
            if from_tile { "live" } else { "recording" },
        );
        self.recording_id = Some(capture.id.clone());
        self.from_tile = from_tile;
        self.call_ended = false;
        self.clock = capture.state();
        let was_visible = self.phase != Phase::Hidden;
        self.phase = Phase::Recording;
        actions.push(Action::Recording(self.clock));
        if !was_visible {
            actions.push(Action::Show);
        }
    }

    /// While the tile shows a recording: its time, or what follows when it is over.
    fn follow_recording(
        &mut self,
        now: Duration,
        capture: Option<&Capture>,
        actions: &mut Vec<Action>,
    ) {
        match capture {
            Some(capture) if self.recording_id.as_deref() == Some(capture.id.as_str()) => {
                self.clock = capture.state();
                actions.push(Action::Recording(self.clock));
            }
            // Another recording, between two ticks. With the call on, the bar shows it; after the
            // call ended (the bar stayed for a recording started from the tile), it gets none.
            Some(capture) if !self.call_ended => {
                self.reason = "next_recording";
                self.recording_id = Some(capture.id.clone());
                self.from_tile = false;
                self.clock = capture.state();
                actions.push(Action::Recording(self.clock));
            }
            // Over: stopped from the tile or in the app, stopped by its limit, or discarded.
            _ => {
                self.recording_id = None;
                if self.call_ended {
                    self.end_call("recording_over", actions);
                } else if self.not_now {
                    self.enter(Stage::Dismissed, now, "recording_over");
                    self.show(Phase::Hidden, actions);
                } else {
                    // The call goes on: the offer comes back.
                    self.enter(Stage::Offered, now, "recording_over");
                    self.show(Phase::Offered, actions);
                }
            }
        }
    }

    fn end_call(&mut self, reason: &'static str, actions: &mut Vec<Action>) {
        if self.stage != Stage::Idle || self.phase != Phase::Hidden {
            self.reason = reason;
        }
        self.stage = Stage::Idle;
        self.owner = None;
        self.candidates.clear();
        self.not_now = false;
        self.recording_id = None;
        self.from_tile = false;
        self.call_ended = false;
        self.show(Phase::Hidden, actions);
    }

    fn take_call(&mut self, app: AppId, last_heard: Duration) {
        self.owner = Some(app);
        self.owner_last_heard = last_heard;
        self.candidates.clear();
    }

    /// No app owns a call yet: follow the apps that capture until one qualifies. A recording in
    /// progress takes the call at once and shows its bar: never an offer while recording.
    fn hear(&mut self, now: Duration, seen: &Observation<'_>, actions: &mut Vec<Action>) {
        if let Some(heard) = seen.heard {
            for candidate in &mut self.candidates {
                match heard.iter().find(|entry| entry.app == candidate.app) {
                    Some(entry) => {
                        candidate.last_heard = now;
                        if rule_holds(candidate.app.kind(), entry) {
                            candidate.held_since.get_or_insert(now);
                        } else {
                            candidate.held_since = None;
                        }
                    }
                    None => candidate.held_since = None,
                }
            }
            for entry in heard {
                if !self
                    .candidates
                    .iter()
                    .any(|candidate| candidate.app == entry.app)
                {
                    self.candidates.push(Candidate {
                        app: entry.app,
                        first_heard: now,
                        last_heard: now,
                        held_since: rule_holds(entry.app.kind(), entry).then_some(now),
                    });
                }
            }
            self.candidates
                .retain(|candidate| now.saturating_sub(candidate.last_heard) < CALL_END);
        }
        if self.candidates.is_empty() {
            self.enter(Stage::Idle, now, "quiet");
            return;
        }
        self.enter(Stage::Hearing, now, "heard");

        if let Some(capture) = seen.capture {
            if let Some(first) = self
                .candidates
                .iter()
                .min_by_key(|candidate| (candidate.first_heard, candidate.app))
                .copied()
            {
                self.take_call(first.app, first.last_heard);
                self.enter_recording(capture, false, now, actions);
            }
            return;
        }

        let qualified = self
            .candidates
            .iter()
            .filter_map(|candidate| {
                let held_since = candidate.held_since?;
                (now.saturating_sub(held_since) >= candidate.app.kind().sustain())
                    .then_some((held_since, candidate.app))
            })
            .min();
        if let Some((_, app)) = qualified {
            self.take_call(app, now);
            self.enter(Stage::Offered, now, "offer");
            self.show(Phase::Offered, actions);
        }
    }
}
