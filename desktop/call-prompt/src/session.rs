//! One call at a time: when the tile shows, when it hides, and what "Start" and "Not now" do.
//!
//! Stages:
//! - [`Stage::Idle`]: no call app captures.
//! - [`Stage::Hearing`]: a call app captures, but its rule has not held long enough
//!   ([`crate::apps`]: capturing for 8 s, or for a browser capturing and playing for 15 s).
//! - [`Stage::Offered`]: the tile shows "Record this call".
//! - [`Stage::Starting`]: "Start" was pressed; the app waits up to [`START_TIMEOUT`] for the
//!   recorder to capture.
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
/// How long the tile shows its red dot once the recording captures.
pub const RECORDING_DOT: Duration = Duration::from_secs(1);

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
    /// The recording captures: a red dot, then the tile hides.
    Recording,
}

/// Where the session is in the current call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Idle,
    Hearing,
    Offered,
    Starting,
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
    /// While the red dot shows: when it hides.
    dot_until: Option<Duration>,
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
            dot_until: None,
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

    /// The call's app, once an app owns the call. A table entry, never a process's own id.
    pub fn app(&self) -> Option<AppId> {
        self.owner
    }

    /// The rule of the call's app, once an app owns the call.
    pub fn kind(&self) -> Option<Kind> {
        self.owner.map(AppId::kind)
    }

    /// How long the watcher may wait before the next tick.
    pub fn next_tick(&self, now: Duration) -> Duration {
        match (self.stage, self.dot_until) {
            (Stage::Starting, _) => STARTING_TICK,
            (Stage::Started, Some(until)) => until
                .saturating_sub(now)
                .clamp(Duration::from_millis(10), TICK),
            _ => TICK,
        }
    }

    /// One scan's worth of news.
    pub fn tick(&mut self, now: Duration, seen: &Observation<'_>) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Some(last) = self.last_tick {
            if now.saturating_sub(last) >= CALL_END {
                self.end_call(&mut actions);
            }
        }
        self.last_tick = Some(now);

        if let (Some(owner), Some(heard)) = (self.owner, seen.heard) {
            if heard.iter().any(|entry| entry.app == owner) {
                self.owner_last_heard = now;
            } else if now.saturating_sub(self.owner_last_heard) >= CALL_END {
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
                if seen.live {
                    self.enter(Stage::Started, now);
                    self.dot_until = Some(now + RECORDING_DOT);
                    self.show(Phase::Recording, &mut actions);
                } else if now.saturating_sub(self.since) >= START_TIMEOUT {
                    // A consent question, a denied microphone or an open receipt: the main
                    // window shows what is needed.
                    self.enter(Stage::Started, now);
                    self.show(Phase::Hidden, &mut actions);
                    actions.push(Action::Present);
                }
            }
            Stage::Started => {
                if self.dot_until.is_some_and(|until| now >= until) {
                    self.dot_until = None;
                    self.show(Phase::Hidden, &mut actions);
                }
            }
            Stage::Dismissed => {}
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
        self.dot_until = None;
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
