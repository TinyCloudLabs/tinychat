//! The watcher: a scan every two seconds while the setting is on, the session it drives, and the
//! tile's two buttons.
//!
//! How the app hosts it:
//! - [`spawn`] at start-up, with a [`Host`] that knows the recorder and carries out [`Action`]s.
//!   The watcher starts switched off; [`Worker::set_enabled`] with the saved setting turns it on.
//! - While the setting is off the thread sleeps on a condition variable: no scan, no timer.
//! - [`Worker::start`] and [`Worker::dismiss`] are the tile's "Start" and "Not now";
//!   [`Worker::phase`] is what the tile shows.
//! - [`Worker::stop`] on the app's exit path.
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
use crate::mic::{self, AudioProcesses, CoreAudio};
use crate::session::{Action, Observation, Phase, Session, Stage, TICK};
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

/// The watcher thread's name.
pub const THREAD_NAME: &str = "call-prompt";
/// After a tick panics, the watcher waits this long before the next one.
pub const PANIC_REST: Duration = Duration::from_secs(60);

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
}

/// The watcher without its thread: one [`Watcher::tick`] is one scan. [`Worker`] runs it.
pub struct Watcher<H: Host, A: AudioProcesses> {
    host: H,
    audio: Mutex<A>,
    clock: Clock,
    own_pid: i32,
    inner: Mutex<Inner>,
    flags: Mutex<Flags>,
    changed: Condvar,
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
            audio: Mutex::new(audio),
            clock,
            own_pid: std::process::id() as i32,
            inner: Mutex::new(Inner {
                session: Session::new(),
                last_report: None,
            }),
            flags: Mutex::new(Flags::default()),
            changed: Condvar::new(),
        }
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
            let mut inner = lock(&self.inner);
            lock(&self.flags).enabled = enabled;
            if !enabled {
                let actions = inner.session.reset();
                self.carry_out(&mut inner, actions, None);
            }
        }));
        self.changed.notify_all();
    }

    /// "Start" on the tile.
    pub fn start(&self) {
        self.answer(Session::start);
        // A faster pace while the recording starts.
        self.wake();
    }

    /// "Not now" on the tile.
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
                    let mut inner = lock(&self.inner);
                    let actions = inner.session.reset();
                    self.carry_out(&mut inner, actions, Some("panicked"));
                }));
                PANIC_REST
            }
        }
    }

    fn tick_inner(&self) -> Duration {
        let scanned = mic::scan(&mut *lock(&self.audio), self.own_pid);
        let recording = self.host.recording();
        let live = self.host.live();
        let now = (self.clock)();
        let mut inner = lock(&self.inner);
        if !self.enabled() {
            // Turned off during the scan: nothing shows.
            return TICK;
        }
        let seen = Observation {
            heard: scanned.as_deref().ok(),
            recording,
            live,
        };
        let actions = inner.session.tick(now, &seen);
        self.carry_out(
            &mut inner,
            actions,
            scanned.err().map(|error| error.as_str()),
        );
        inner.session.next_tick(now)
    }

    fn answer(&self, answer: fn(&mut Session, Duration) -> Vec<Action>) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let now = (self.clock)();
            let mut inner = lock(&self.inner);
            let actions = answer(&mut inner.session, now);
            let error = inner.last_report.and_then(|report| report.error);
            self.carry_out(&mut inner, actions, error);
        }));
    }

    fn carry_out(&self, inner: &mut Inner, actions: Vec<Action>, error: Option<&'static str>) {
        for action in actions {
            self.host.act(action);
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
