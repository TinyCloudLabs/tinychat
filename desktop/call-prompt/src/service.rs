//! The watcher: a look at the microphone every two seconds while the setting is on, the session
//! it drives, and the tile's two buttons.
//!
//! A look is the gate first ([`crate::mic::Gate`], one cheap read per input device); the process
//! scan ([`crate::mic::Scanner`]) runs only when an input device is in use, when the gate cannot
//! be read, or while the session follows a call app ([`Session::tracking`]), so that a call is
//! followed until it has ended even if the gate closes for a moment. While the gate is open but
//! the last scan heard no call app (a headset that only plays music keeps it open), and no call
//! is followed, the scan runs every [`QUIET_SCAN`] instead of every tick.
//!
//! How the app hosts it:
//! - [`spawn`] at start-up, with a [`Host`] that knows the recorder and carries out [`Action`]s.
//!   The watcher starts switched off; [`Watcher::set_enabled`] with the saved setting turns it on.
//! - While the setting is off the thread sleeps on a condition variable: no scan, no timer.
//! - [`Watcher::start`] and [`Watcher::dismiss`] are the tile's "Start" and "Not now";
//!   [`Watcher::phase`] is what the tile shows. Each press is answered with a phase, also when
//!   it changes nothing: the tile keeps its buttons disabled until it hears one.
//! - The tile's window is shown only once its page has asked for its state
//!   ([`Watcher::page_asked`], from the `call_prompt_state` command) since the window was made
//!   ([`Watcher::window_created`]). The watcher asks the app to build the window
//!   ([`Action::Prepare`]) when a call app is first heard, so the page has loaded by the time an
//!   offer is due. An offer whose page has not asked within [`PAGE_WAIT`] is never shown and
//!   counts as "Not now" for the call; the report says `tile_page_missing` once.
//! - [`Worker::stop`] on the app's exit path.
//! - [`Watcher::keep_status`] with the status file ([`crate::status`]); [`Watcher::start_claimed`]
//!   when the web app claims a start request, so the file can say how long that took.
//!
//! Nothing here may block, delay or crash a recording or the app:
//! - a tick that panics is caught: the tile hides, the call is forgotten, and the watcher rests
//!   for [`PANIC_REST`] before it scans again;
//! - the CoreAudio scan and the host's recorder reads happen before the session's lock is taken,
//!   so the lock is never held across a system call; the host's reads of the recorder must take
//!   their own locks briefly and release them before they return;
//! - [`Host::act`] runs under the session's lock, so the tile sees the actions in their order. It
//!   must hand work off (to the main thread, to a task) and return at once.

use crate::apps::Kind;
use crate::mic::{AudioProcesses, CoreAudio, Gate, Heard, ScanError, Scanner};
use crate::session::{Action, Observation, Phase, Session, Stage, TICK};
use crate::status::{GateState, LastStart, Status, StatusFile};
use crate::tile::PAGE_WAIT;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// The watcher thread's name.
pub const THREAD_NAME: &str = "call-prompt";
/// After a tick panics, the watcher waits this long before the next one.
pub const PANIC_REST: Duration = Duration::from_secs(60);
/// The scan's pace while the gate is open but no call app was heard and no call is followed.
pub const QUIET_SCAN: Duration = Duration::from_secs(6);

/// The app, as the watcher sees it. Called from the watcher thread and from the commands'
/// threads.
pub trait Host: Send + Sync + 'static {
    /// A recording exists (capturing, paused or stopping), however it began.
    fn recording(&self) -> bool;

    /// The recorder captures now.
    fn live(&self) -> bool;

    /// Carry out one action. Must not block: hand the work off and return.
    fn act(&self, action: Action);

    /// Runs one tick. The macOS app wraps it in an autorelease pool.
    fn scope(&self, tick: &mut dyn FnMut()) {
        tick()
    }

    /// For the app's log, when it differs from the report before. Carries the stage, the kind of
    /// the call's app and a failure, never a bundle id.
    fn report(&self, _report: &Report) {}
}

/// What the app's log gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Report {
    pub stage: Stage,
    pub kind: Option<Kind>,
    pub error: Option<&'static str>,
}

/// The time on a monotonic clock that keeps counting while the Mac sleeps, so that a sleep ends
/// the call ([`crate::session::CALL_END`]).
pub type Clock = Box<dyn Fn() -> Duration + Send + Sync>;

#[derive(Default)]
struct Flags {
    enabled: bool,
    wake: bool,
    stop: bool,
    done: bool,
}

struct Inner {
    session: Session,
    last_report: Option<Report>,
    /// The tile's page has asked for its state since its window was made.
    page_ready: bool,
    /// The window was asked for ([`Action::Prepare`]) and the page has not asked yet.
    prepared: bool,
    /// An offer is due but its page has not asked yet: since when.
    waiting_since: Option<Duration>,
    /// When "Start" was last pressed, until the web app claims the start request.
    start_pressed_at: Option<Duration>,
    /// The last "Start", for the status file.
    last_start: Option<LastStart>,
}

/// What one look at the microphone found.
struct Look {
    /// The call apps heard; `None` when the scan failed.
    heard: Option<Vec<Heard>>,
    error: Option<ScanError>,
    gate: GateState,
    /// How long the last scan took, also when this look did not scan.
    scan_ms: Option<f64>,
}

/// The CoreAudio reader, the gate, the scan's buffer and the scan's pace.
struct Audio<A> {
    audio: A,
    gate: Gate,
    scanner: Scanner,
    /// When the last scan ran, on the watcher's clock, while the gate stayed open.
    last_scan_at: Option<Duration>,
    /// The last scan heard no call app.
    quiet: bool,
    /// How long the last scan took.
    scan_ms: Option<f64>,
}

/// The watcher without its thread: one [`Watcher::tick`] is one look at the microphone.
/// [`Worker`] runs it.
pub struct Watcher<H: Host, A: AudioProcesses> {
    host: H,
    audio: Mutex<Audio<A>>,
    clock: Clock,
    own_pid: i32,
    inner: Mutex<Inner>,
    flags: Mutex<Flags>,
    changed: Condvar,
    status: Mutex<Option<StatusFile>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl<H: Host, A: AudioProcesses> Watcher<H, A> {
    /// A watcher that is switched off.
    pub fn new(host: H, audio: A, clock: Clock) -> Self {
        Watcher {
            host,
            audio: Mutex::new(Audio {
                audio,
                gate: Gate::new(),
                scanner: Scanner::new(),
                last_scan_at: None,
                quiet: false,
                scan_ms: None,
            }),
            clock,
            own_pid: std::process::id() as i32,
            inner: Mutex::new(Inner {
                session: Session::new(),
                last_report: None,
                page_ready: false,
                prepared: false,
                waiting_since: None,
                start_pressed_at: None,
                last_start: None,
            }),
            flags: Mutex::new(Flags::default()),
            changed: Condvar::new(),
            status: Mutex::new(None),
        }
    }

    /// Keep the status file up to date from now on.
    pub fn keep_status(&self, file: StatusFile) {
        *lock(&self.status) = Some(file);
    }

    /// The web app claimed a start request (`recorder_take_start_request`). When it follows a
    /// "Start" on the tile, the status file says how long after the press that was.
    pub fn start_claimed(&self) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let now = (self.clock)();
            let mut inner = lock(&self.inner);
            if let Some(pressed) = inner.start_pressed_at.take() {
                let after = now.saturating_sub(pressed).as_millis() as u64;
                if let Some(last) = inner.last_start.as_mut() {
                    last.claimed_after_ms = Some(after);
                }
            }
        }));
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn enabled(&self) -> bool {
        lock(&self.flags).enabled
    }

    /// What the tile shows now.
    pub fn phase(&self) -> Phase {
        lock(&self.inner).session.phase()
    }

    pub fn stage(&self) -> Stage {
        lock(&self.inner).session.stage()
    }

    /// The setting. Turning it off hides the tile and forgets the call.
    pub fn set_enabled(&self, enabled: bool) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let now = (self.clock)();
            let mut inner = lock(&self.inner);
            lock(&self.flags).enabled = enabled;
            if !enabled {
                let actions = inner.session.reset();
                self.carry_out(&mut inner, actions, None, now);
            }
            // Off: say so at once. On: the next tick says what it finds.
            if !enabled {
                let status = Self::status(&inner, false, GateState::Off, None, None);
                drop(inner);
                self.write_status(now, &status);
            }
        }));
        self.changed.notify_all();
    }

    /// The tile's page asked for its state (`call_prompt_state`): it has loaded. An offer that
    /// waited for it shows now. Returns what the tile shows.
    pub fn page_asked(&self) -> Phase {
        catch_unwind(AssertUnwindSafe(|| {
            let mut inner = lock(&self.inner);
            inner.page_ready = true;
            if inner.waiting_since.take().is_some() && inner.session.phase() != Phase::Hidden {
                self.host.act(Action::Show);
            }
            inner.session.phase()
        }))
        .unwrap_or(Phase::Hidden)
    }

    /// The app has just made the tile's window: its page has not asked yet.
    pub fn window_created(&self) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            lock(&self.inner).page_ready = false;
        }));
    }

    /// "Start" on the tile. The tile always gets a phase back: `starting`, or what it should show
    /// when there was nothing to start (the offer had already gone).
    pub fn start(&self) {
        self.answer(Session::start);
        // A faster pace while the recording starts.
        self.wake();
    }

    /// "Not now" on the tile. The tile always gets a phase back.
    pub fn dismiss(&self) {
        self.answer(Session::dismiss);
    }

    /// One scan and the session's answer, when the setting is on. Returns how long to wait before
    /// the next. Never panics.
    pub fn tick(&self) -> Duration {
        if !self.enabled() {
            return TICK;
        }
        match catch_unwind(AssertUnwindSafe(|| self.tick_inner())) {
            Ok(delay) => delay,
            Err(_) => {
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    let now = (self.clock)();
                    let mut inner = lock(&self.inner);
                    let actions = inner.session.reset();
                    self.carry_out(&mut inner, actions, Some("panicked"), now);
                }));
                PANIC_REST
            }
        }
    }

    fn tick_inner(&self) -> Duration {
        let tracking = lock(&self.inner).session.tracking();
        let look = self.look(tracking, (self.clock)());
        let recording = self.host.recording();
        let live = self.host.live();
        let now = (self.clock)();
        let mut inner = lock(&self.inner);
        if !self.enabled() {
            // Turned off during the scan: nothing shows.
            return TICK;
        }
        let mut error = look.error.map(ScanError::as_str);
        let mut actions = Vec::new();
        // An offer whose page never asked: never shown, and "Not now" for this call.
        if inner
            .waiting_since
            .is_some_and(|since| now.saturating_sub(since) >= PAGE_WAIT)
        {
            inner.waiting_since = None;
            actions.extend(inner.session.dismiss(now));
            error = Some("tile_page_missing");
        }
        let seen = Observation {
            heard: look.heard.as_deref(),
            recording,
            live,
        };
        actions.extend(inner.session.tick(now, &seen));
        // A call app is heard: have the window made now, so its page has loaded when an offer is
        // due.
        if !inner.page_ready && !inner.prepared && inner.session.stage() == Stage::Hearing {
            inner.prepared = true;
            actions.push(Action::Prepare);
        }
        self.carry_out(&mut inner, actions, error, now);
        let delay = inner.session.next_tick(now);
        let status = Self::status(&inner, true, look.gate, look.scan_ms, error);
        drop(inner);
        self.write_status(now, &status);
        delay
    }

    fn status(
        inner: &Inner,
        enabled: bool,
        gate: GateState,
        scan_ms: Option<f64>,
        error: Option<&'static str>,
    ) -> Status {
        Status {
            enabled,
            phase: inner.session.phase(),
            stage: inner.session.stage().as_str(),
            kind: inner.session.kind().map(Kind::as_str),
            gate,
            scan_ms,
            last_start: inner.last_start,
            error,
        }
    }

    /// The status file, when one is kept. A failed write is dropped; the next tries again.
    fn write_status(&self, now: Duration, status: &Status) {
        if let Some(file) = lock(&self.status).as_mut() {
            let _ = file.offer(now, status);
        }
    }

    /// The gate, then the scan when the gate is open, when it cannot be read, or while a call
    /// is followed. A closed gate and no call: nothing captures on any input device. An open gate
    /// after a scan that heard no call app, with no call followed: the next scan waits until
    /// [`QUIET_SCAN`] after it.
    fn look(&self, tracking: bool, now: Duration) -> Look {
        let mut guard = lock(&self.audio);
        let Audio {
            audio,
            gate,
            scanner,
            last_scan_at,
            quiet,
            scan_ms,
        } = &mut *guard;
        let gate = gate.open(audio, now);
        let gate_state = match gate {
            Ok(true) => GateState::Open,
            Ok(false) => GateState::Closed,
            Err(_) => GateState::Failed,
        };
        let mut look = Look {
            heard: Some(Vec::new()),
            error: gate.err(),
            gate: gate_state,
            scan_ms: *scan_ms,
        };
        if gate == Ok(false) && !tracking {
            *last_scan_at = None;
            return look;
        }
        let resting = !tracking
            && *quiet
            && last_scan_at.is_some_and(|at| now.saturating_sub(at) < QUIET_SCAN);
        if resting {
            return look;
        }
        *last_scan_at = Some(now);
        let started = Instant::now();
        let scanned = scanner.scan(audio, self.own_pid);
        let took = started.elapsed().as_secs_f64() * 1000.0;
        *scan_ms = Some((took * 100.0).round() / 100.0);
        look.scan_ms = *scan_ms;
        match scanned {
            Ok(heard) => {
                *quiet = heard.is_empty();
                look.heard = Some(heard);
            }
            Err(error) => {
                *quiet = false;
                look.heard = None;
                look.error = Some(error);
            }
        }
        look
    }

    fn answer(&self, answer: fn(&mut Session, Duration) -> Vec<Action>) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let now = (self.clock)();
            let mut inner = lock(&self.inner);
            let mut actions = answer(&mut inner.session, now);
            // The tile keeps its buttons disabled until it hears a phase.
            if !actions
                .iter()
                .any(|action| matches!(action, Action::Phase(_)))
            {
                actions.push(Action::Phase(inner.session.phase()));
            }
            let error = inner.last_report.and_then(|report| report.error);
            self.carry_out(&mut inner, actions, error, now);
        }));
    }

    /// Carry out the actions in order. A show waits for the tile's page: until it has asked, the
    /// window is only made ([`Action::Prepare`]) and the offer waits up to [`PAGE_WAIT`].
    fn carry_out(
        &self,
        inner: &mut Inner,
        actions: Vec<Action>,
        error: Option<&'static str>,
        now: Duration,
    ) {
        for action in actions {
            match action {
                Action::Show if !inner.page_ready => {
                    inner.waiting_since.get_or_insert(now);
                    inner.prepared = true;
                    self.host.act(Action::Prepare);
                }
                Action::Hide => {
                    inner.waiting_since = None;
                    self.host.act(Action::Hide);
                }
                Action::Start => {
                    inner.start_pressed_at = Some(now);
                    inner.last_start = Some(LastStart {
                        claimed_after_ms: None,
                        timed_out: false,
                    });
                    self.host.act(Action::Start);
                }
                Action::Present => {
                    if let Some(last) = inner.last_start.as_mut() {
                        last.timed_out = true;
                    }
                    self.host.act(Action::Present);
                }
                action => self.host.act(action),
            }
        }
        let report = Report {
            stage: inner.session.stage(),
            kind: inner.session.kind(),
            error,
        };
        if inner.last_report != Some(report) {
            inner.last_report = Some(report);
            self.host.report(&report);
        }
    }

    fn wake(&self) {
        lock(&self.flags).wake = true;
        self.changed.notify_all();
    }

    /// Wait for `delay`, for a wake-up or for a stop; while the setting is off, until it is on
    /// again or a stop. True when a stop was asked.
    fn sleep(&self, delay: Duration) -> bool {
        let mut flags = lock(&self.flags);
        if flags.enabled && !flags.wake {
            flags = self
                .changed
                .wait_timeout_while(flags, delay, |flags| {
                    !flags.stop && !flags.wake && flags.enabled
                })
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        flags = self
            .changed
            .wait_while(flags, |flags| !flags.stop && !flags.enabled)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        flags.wake = false;
        flags.stop
    }
}

/// Says that the thread has ended, however it ended.
struct Done<H: Host, A: AudioProcesses>(Arc<Watcher<H, A>>);

impl<H: Host, A: AudioProcesses> Drop for Done<H, A> {
    fn drop(&mut self) {
        lock(&self.0.flags).done = true;
        self.0.changed.notify_all();
    }
}

/// The watcher's thread, as the app holds it.
pub struct Worker<H: Host, A: AudioProcesses = CoreAudio> {
    watcher: Arc<Watcher<H, A>>,
}

impl<H: Host, A: AudioProcesses> std::ops::Deref for Worker<H, A> {
    type Target = Watcher<H, A>;

    fn deref(&self) -> &Watcher<H, A> {
        &self.watcher
    }
}

impl<H: Host, A: AudioProcesses> Worker<H, A> {
    /// Ask the thread to stop and wait up to `wait` for it to end. True when it ended in time.
    pub fn stop(&self, wait: Duration) -> bool {
        let flags = {
            let mut flags = lock(&self.watcher.flags);
            flags.stop = true;
            flags
        };
        self.watcher.changed.notify_all();
        let (flags, _) = self
            .watcher
            .changed
            .wait_timeout_while(flags, wait, |flags| !flags.done)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        flags.done
    }
}

/// Start the watcher's thread with the system's CoreAudio, switched off.
pub fn spawn<H: Host>(host: H) -> io::Result<Worker<H, CoreAudio>> {
    spawn_with(host, CoreAudio, Box::new(now))
}

/// As [`spawn`], with the audio reader and the clock given.
pub fn spawn_with<H, A>(host: H, audio: A, clock: Clock) -> io::Result<Worker<H, A>>
where
    H: Host,
    A: AudioProcesses + Send + 'static,
{
    let watcher = Arc::new(Watcher::new(host, audio, clock));
    let done = Done(watcher.clone());
    std::thread::Builder::new()
        .name(THREAD_NAME.into())
        .spawn(move || {
            let done = done;
            let watcher = &done.0;
            let mut delay = TICK;
            while !watcher.sleep(delay) {
                watcher.host.scope(&mut || delay = watcher.tick());
            }
        })?;
    Ok(Worker { watcher })
}

/// A monotonic clock that keeps counting while the Mac sleeps (`CLOCK_MONOTONIC` on macOS,
/// where `std::time::Instant` stops during sleep). Elsewhere, the time since the first call.
pub fn now() -> Duration {
    clock::now()
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod clock {
    use std::time::Duration;

    /// `CLOCK_MONOTONIC` in Darwin's `<time.h>`: counts while the system sleeps.
    const CLOCK_MONOTONIC: u32 = 6;

    unsafe extern "C" {
        fn clock_gettime_nsec_np(clock: u32) -> u64;
    }

    pub fn now() -> Duration {
        Duration::from_nanos(unsafe { clock_gettime_nsec_np(CLOCK_MONOTONIC) })
    }
}

#[cfg(not(target_os = "macos"))]
mod clock {
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    pub fn now() -> Duration {
        static START: OnceLock<Instant> = OnceLock::new();
        START.get_or_init(Instant::now).elapsed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_moves_forward() {
        let first = now();
        std::thread::sleep(Duration::from_millis(5));
        let second = now();
        assert!(second > first, "{first:?} then {second:?}");
    }
}
