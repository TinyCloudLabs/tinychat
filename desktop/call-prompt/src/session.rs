//! One call at a time: when the tile shows, when it hides, and what "Start", "Not now" and
//! "Stop" do.
//!
//! Stages:
//! - [`Stage::Idle`]: no call app captures.
//! - [`Stage::Hearing`]: a call app captures, but its rule has not held long enough
//!   ([`crate::apps`]: capturing for 8 s, or for a browser capturing and playing for 15 s).
//! - [`Stage::Offered`]: the tile shows "Record this call".
//! - [`Stage::Starting`]: "Start" was pressed; the app waits up to [`START_TIMEOUT`] for the
//!   recorder to capture.
//! - [`Stage::Recording`]: the recording started from the tile captures. The tile stays, as a
//!   bar with the recorder's own time ([`RecordingState`], sent every [`RECORDING_TICK`]) and
//!   "Stop", until that recording is over: stopped from the tile or in the app, stopped by its
//!   limit, or discarded, which the recorder tells by having no recording, or another one. The
//!   call ending meanwhile (its app gone quiet, the Mac asleep) does not hide it.
//! - [`Stage::Started`]: the call is recorded, or was asked to be. The offer never comes back in
//!   this call, also when the recording stops before the call ends.
//! - [`Stage::Dismissed`]: "Not now", or [`UNANSWERED`] without an answer. Lasts the call.
//!
//! The call belongs to the first app whose rule holds; other apps wait until it ends. A call ends
//! when its app has not captured for [`CALL_END`], or when no tick came for [`CALL_END`] (the Mac
//! slept). Then the session is idle again and the next call gets a new offer. There is no
//! cool-down per app: it would miss back-to-back calls.
//!
//! A recording that is in progress when a call starts, or that starts while the tile shows (from
//! the shortcut, the menu-bar item or the window), takes the call to `Started` and hides the
//! tile: the offer never shows while a recording runs.
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
    /// The call's app, from `Offered` (or `Started`) until the call ends.
    owner: Option<AppId>,
    owner_last_heard: Duration,
    candidates: Vec<Candidate>,
    phase: Phase,
    /// The recording started from the tile, while the tile shows it.
    recording_id: Option<String>,
    clock: RecordingState,
    /// "Stop" was sent for it.
    stop_sent: bool,
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
            owner: None,
            owner_last_heard: Duration::ZERO,
            candidates: Vec::new(),
            phase: Phase::Hidden,
            recording_id: None,
            clock: RecordingState {
                elapsed_ms: 0,
                paused: false,
            },
            stop_sent: false,
            last_tick: None,
        }
    }

    pub fn stage(&self) -> Stage {
        self.stage
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
        // While the tile shows a recording, the call ending does not hide it: the call's end is
        // only noted, and acted on once the recording is over.
        let recording = self.stage == Stage::Recording;
        if let Some(last) = self.last_tick {
            if !recording && now.saturating_sub(last) >= CALL_END {
                self.end_call(&mut actions);
            }
        }
        self.last_tick = Some(now);

        if let (Some(owner), Some(heard)) = (self.owner, seen.heard) {
            if heard.iter().any(|entry| entry.app == owner) {
                self.owner_last_heard = now;
            } else if !recording && now.saturating_sub(self.owner_last_heard) >= CALL_END {
                self.end_call(&mut actions);
            }
        }

        match self.stage {
            Stage::Idle | Stage::Hearing => self.hear(now, seen, &mut actions),
            Stage::Offered => {
                if seen.recording {
                    self.enter(Stage::Started, now);
                    self.show(Phase::Hidden, &mut actions);
                } else if now.saturating_sub(self.since) >= UNANSWERED {
                    self.enter(Stage::Dismissed, now);
                    self.show(Phase::Hidden, &mut actions);
                }
            }
            Stage::Starting => {
                if let (true, Some(capture)) = (seen.live, seen.capture) {
                    // The recording started from the tile captures: the tile stays, as a bar.
                    self.enter(Stage::Recording, now);
                    self.recording_id = Some(capture.id.clone());
                    self.clock = capture.state();
                    self.stop_sent = false;
                    self.phase = Phase::Recording;
                    actions.push(Action::Recording(self.clock));
                } else if now.saturating_sub(self.since) >= START_TIMEOUT {
                    // A consent question, a denied microphone or an open receipt: the main
                    // window shows what is needed.
                    self.enter(Stage::Started, now);
                    self.show(Phase::Hidden, &mut actions);
                    actions.push(Action::Present);
                }
            }
            Stage::Recording => match seen.capture {
                Some(capture) if self.recording_id.as_deref() == Some(capture.id.as_str()) => {
                    self.clock = capture.state();
                    actions.push(Action::Recording(self.clock));
                }
                // No recording, or another one: this recording is over (stopped from the tile or
                // in the app, stopped by its limit, or discarded). The offer stays spent.
                _ => {
                    self.enter(Stage::Started, now);
                    self.recording_id = None;
                    self.show(Phase::Hidden, &mut actions);
                }
            },
            Stage::Started | Stage::Dismissed => {}
        }
        actions
    }

    /// "Start" on the tile. Only an offer can be started, once.
    pub fn start(&mut self, now: Duration) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.stage == Stage::Offered {
            self.enter(Stage::Starting, now);
            self.show(Phase::Starting, &mut actions);
            actions.push(Action::Start);
        }
        actions
    }

    /// "Stop" on the tile: one request to stop, for the recording it shows.
    pub fn stop(&mut self, _now: Duration) -> Vec<Action> {
        if self.stage == Stage::Recording && !self.stop_sent {
            self.stop_sent = true;
            return vec![Action::Stop];
        }
        Vec::new()
    }

    /// "Not now" on the tile: no offer again in this call.
    pub fn dismiss(&mut self, now: Duration) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.stage == Stage::Offered {
            self.enter(Stage::Dismissed, now);
            self.show(Phase::Hidden, &mut actions);
        }
        actions
    }

    /// The setting was turned off (or the watcher failed): hide the tile and forget the call.
    pub fn reset(&mut self) -> Vec<Action> {
        let mut actions = Vec::new();
        self.end_call(&mut actions);
        self.last_tick = None;
        actions
    }

    fn enter(&mut self, stage: Stage, now: Duration) {
        if self.stage != stage {
            self.stage = stage;
            self.since = now;
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

    fn end_call(&mut self, actions: &mut Vec<Action>) {
        self.stage = Stage::Idle;
        self.owner = None;
        self.candidates.clear();
        self.recording_id = None;
        self.show(Phase::Hidden, actions);
    }

    fn take_call(&mut self, app: AppId, last_heard: Duration, stage: Stage, now: Duration) {
        self.owner = Some(app);
        self.owner_last_heard = last_heard;
        self.candidates.clear();
        self.enter(stage, now);
    }

    /// No app owns a call yet: follow the apps that capture until one qualifies.
    fn hear(&mut self, now: Duration, seen: &Observation<'_>, actions: &mut Vec<Action>) {
        let Some(heard) = seen.heard else {
            return;
        };
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
        if self.candidates.is_empty() {
            self.enter(Stage::Idle, now);
            return;
        }
        self.enter(Stage::Hearing, now);

        if seen.recording {
            // Already recorded: this call is never offered.
            if let Some(first) = self
                .candidates
                .iter()
                .min_by_key(|candidate| (candidate.first_heard, candidate.app))
                .copied()
            {
                self.take_call(first.app, first.last_heard, Stage::Started, now);
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
            self.take_call(app, now, Stage::Offered, now);
            self.show(Phase::Offered, actions);
        }
    }
}
