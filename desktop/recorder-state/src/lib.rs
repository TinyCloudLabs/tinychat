//! Pause, resume, and stop state for the desktop voice-note recorder.
//!
//! Pure: no I/O and no clock. Callers pass a monotonic `now_ms` and report the
//! outcome of each native call; the engine performs the native calls.
//!
//! Invariant: `Paused` is reported only after the listener session is no longer
//! active or finalizing. That is session-finalization evidence, not confirmation
//! that macOS released the input device. An unfinalized stop leaves the segment
//! stalled and retryable; durable Stop can commit after its bounded budget with
//! an explicit `capture_source_unconfirmed` outcome.


#![forbid(unsafe_code)]

/// Maximum number of durable Stop attempts while listener-session finalization remains unconfirmed.
pub const DURABLE_STOP_ATTEMPT_BUDGET: u8 = 3;
/// Resolve the selected input name to one stable device id.
///
/// Missing name lookups and ambiguous matches stay unknown; returning no match
/// is also unknown because the selected device may not have been enumerated.
pub fn resolve_named_devices(selected_name: &str, devices: &[(u32, Option<String>)]) -> Option<Vec<u32>> {
    let mut selected = None;
    for (device_id, name) in devices {
        let name = name.as_deref()?;
        if name == selected_name {
            if selected.replace(*device_id).is_some() {
                return None;
            }
        }
    }
    selected.map(|device_id| vec![device_id])
}

/// Merge a newly unconfirmed source mapping into the devices still being polled.
/// An unknown mapping for a new source poisons the aggregate; retaining only an
/// older known device could incorrectly clear the warning while the new source runs.
pub fn merge_unconfirmed_devices(
    existing: Option<&[u32]>,
    newly_unconfirmed: Option<&[u32]>,
) -> Option<Vec<u32>> {
    let (Some(existing), Some(newly_unconfirmed)) = (existing, newly_unconfirmed) else {
        return None;
    };
    let mut merged = existing.to_vec();
    for device in newly_unconfirmed {
        if !merged.contains(device) {
            merged.push(*device);
        }
    }
    Some(merged)
}

/// True only when an expected recording id still owns the native recorder.
/// Callers must make this decision while holding the lock that protects current ownership.
pub fn is_current_recording(expected_id: &str, current_id: Option<&str>) -> bool {
    current_id == Some(expected_id)
}

/// Why the listener session did not appear finalized before the deadline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stall {
    /// Listener finalization did not complete before the deadline.
    WriterStalled,
    /// The capture session still reports active after stop was requested; this does not prove device release.
    SourceStillRunning,
    /// No usable audio snapshot was available. Pause, Resume, or Stop retries it.
    SourceUnusable,
}

impl Stall {
    /// The status reason shown while the segment is stalled.
    pub fn reason(self) -> &'static str {
        match self {
            Stall::WriterStalled => "writer_stalled",
            Stall::SourceStillRunning => "source_still_running",
            Stall::SourceUnusable => "source_unusable",
        }
    }
}

/// A user request that may need native calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
    Pause,
    Resume,
    Stop,
}

/// The native call a request needs next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Stop the native source, then report the result with `stop_outcome`.
    StopSource,
    /// Start the native source, then report the result with `start_outcome`.
    StartSource,
    /// No native call is needed.
    Done,
}

/// Stop result the engine should use after exhausting the durable Stop budget.
pub const UNCONFIRMED_STOP_REASON: &str = "capture_source_unconfirmed";

/// Outcome of a native stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// The listener session is no longer active or finalizing.
    SessionFinalized,
    /// The session finalized without usable audio; no audio time is counted.
    Empty,
    /// The listener session could not be observed as finalized.
    Stalled(Stall),
}

/// Outcome of a native start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Start {
    Opened,
    /// The start failed; the stable reason code is kept as a blocker.
    Failed(&'static str),
}

/// A rejected or failed transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    NotRecording,
    AlreadyPaused,
    AlreadyRecording,
    /// `finish` was called while the native source may still be capturing.
    StillOpen,
    Stalled(Stall),
    Start(&'static str),
}

impl Error {
    /// The stable error code the frontend receives.
    pub fn code(self) -> &'static str {
        match self {
            Error::NotRecording => "not_recording",
            Error::AlreadyPaused => "already_paused",
            Error::AlreadyRecording => "already_recording",
            Error::StillOpen => "segment_still_open",
            Error::Stalled(Stall::WriterStalled) => "capture_stop_timeout",
            Error::Stalled(Stall::SourceStillRunning) => "source_still_running",
            Error::Stalled(Stall::SourceUnusable) => "source_unusable",
            Error::Start(code) => code,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Recording,
    Paused,
    NeedsUser,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Recording => "recording",
            State::Paused => "paused",
            State::NeedsUser => "needs_user",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status {
    pub state: State,
    pub reason: Option<&'static str>,
    /// Audio time recorded so far. Paused time is excluded.
    pub elapsed_ms: u64,
    /// Total time spent paused in this recording.
    pub paused_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Segment {
    /// No listener session is open; this does not prove the input device was released.
    Closed { paused_since_ms: u64 },
    /// A listener session has been open since `since_ms`.
    Open { since_ms: u64 },
    /// Listener-session finalization is unconfirmed. Time since `since_ms` still counts.
    Stalled { since_ms: u64, stall: Stall },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Session {
    segment: Segment,
    /// Audio time from completed segments, including a budgeted unconfirmed stop.
    recorded_ms: u64,
    paused_ms: u64,
    unfinalized_stop_attempts: u8,
}


#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Recorder {
    session: Option<Session>,
    /// Reason of the last failed start. Cleared by the next successful start or by finish.
    blocker: Option<&'static str>,
}

impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The native call `request` needs, or why it is rejected. A stalled segment
    /// is retried by Pause, Resume, and Stop.
    pub fn request(&self, request: Request) -> Result<Step, Error> {
        let Some(session) = self.session else {
            return Err(Error::NotRecording);
        };
        match (request, session.segment) {
            (Request::Pause, Segment::Open { .. } | Segment::Stalled { .. }) => Ok(Step::StopSource),
            (Request::Pause, Segment::Closed { .. }) => Err(Error::AlreadyPaused),
            (Request::Resume, Segment::Closed { .. }) => Ok(Step::StartSource),
            (Request::Resume, Segment::Stalled { .. }) => Ok(Step::StopSource),
            (Request::Resume, Segment::Open { .. }) => Err(Error::AlreadyRecording),
            (Request::Stop, Segment::Open { .. } | Segment::Stalled { .. }) => Ok(Step::StopSource),
            (Request::Stop, Segment::Closed { .. }) => Ok(Step::Done),
        }
    }

    /// Records a native stop outcome. Time waiting for session finalization is
    /// not counted as audio; an unfinalized session stays stalled and retryable.
    pub fn stop_outcome(&mut self, now_ms: u64, outcome: Stop) -> Result<(), Error> {
        let Some(session) = self.session.as_mut() else {
            return Err(Error::NotRecording);
        };
        let since_ms = match session.segment {
            Segment::Open { since_ms } | Segment::Stalled { since_ms, .. } => since_ms,
            Segment::Closed { .. } => return Err(Error::AlreadyPaused),
        };
        match outcome {
            Stop::SessionFinalized | Stop::Empty => {
                if outcome == Stop::SessionFinalized {
                    session.recorded_ms += now_ms.saturating_sub(since_ms);
                }
                session.segment = Segment::Closed { paused_since_ms: now_ms };
                session.unfinalized_stop_attempts = 0;
                self.blocker = None;
                Ok(())
            }
            Stop::Stalled(stall) => {
                session.unfinalized_stop_attempts = session.unfinalized_stop_attempts.saturating_add(1);
                session.segment = Segment::Stalled { since_ms, stall };
                Err(Error::Stalled(stall))
            }
        }
    }

    /// Number of consecutive native stop attempts without observed session finalization.
    pub fn unfinalized_stop_attempts(&self) -> u8 {
        self.session.map_or(0, |session| session.unfinalized_stop_attempts)
    }

    /// Whether durable Stop may commit the captured source without release confirmation.
    pub fn can_finish_unconfirmed(&self) -> bool {
        matches!(
            self.session,
            Some(Session {
                segment: Segment::Stalled { .. },
                unfinalized_stop_attempts,
                ..
            }) if unfinalized_stop_attempts >= DURABLE_STOP_ATTEMPT_BUDGET
        )
    }


    /// Finish after listener-session finalization remains unconfirmed through
    /// the durable Stop budget. Elapsed time is retained with an uncertainty reason.
    pub fn finish_unconfirmed(&mut self, now_ms: u64) -> Result<u64, Error> {
        if !self.can_finish_unconfirmed() {
            return Err(Error::StillOpen);
        }
        let Some(session) = self.session.as_mut() else {
            return Err(Error::NotRecording);
        };
        let since_ms = match session.segment {
            Segment::Stalled { since_ms, .. } => since_ms,
            _ => return Err(Error::StillOpen),
        };
        session.recorded_ms += now_ms.saturating_sub(since_ms);
        session.segment = Segment::Closed { paused_since_ms: now_ms };
        self.blocker = Some(UNCONFIRMED_STOP_REASON);
        Ok(session.recorded_ms)
    }

    /// Records the outcome of a native start: a new recording when none exists, or
    /// a resume from paused. A failed start keeps the recording paused, with the
    /// failure reason as its blocker until a start succeeds.
    pub fn start_outcome(&mut self, now_ms: u64, outcome: Start) -> Result<(), Error> {
        match &mut self.session {
            None => match outcome {
                Start::Opened => {
                    self.session = Some(Session {
                        segment: Segment::Open { since_ms: now_ms },
                        recorded_ms: 0,
                        paused_ms: 0,
                        unfinalized_stop_attempts: 0,
                    });
                    self.blocker = None;

                    Ok(())
                }
                Start::Failed(reason) => {
                    self.blocker = Some(reason);
                    Err(Error::Start(reason))
                }
            },
            Some(session) => match (session.segment, outcome) {
                (Segment::Closed { paused_since_ms }, Start::Opened) => {
                    session.paused_ms += now_ms.saturating_sub(paused_since_ms);
                    session.segment = Segment::Open { since_ms: now_ms };
                    self.blocker = None;
                    Ok(())
                }
                (Segment::Closed { .. }, Start::Failed(reason)) => {
                    self.blocker = Some(reason);
                    Err(Error::Start(reason))
                }
                (Segment::Open { .. } | Segment::Stalled { .. }, _) => Err(Error::AlreadyRecording),
            },
        }
    }

    /// Ends the recording after the listener session is finalized. Returns total
    /// recorded time; this does not assert that macOS released the input device.
    pub fn finish(&mut self) -> Result<u64, Error> {
        match self.session {
            None => Err(Error::NotRecording),
            Some(Session { segment: Segment::Closed { .. }, recorded_ms, .. }) => {
                self.session = None;
                self.blocker = None;
                Ok(recorded_ms)
            }
            Some(_) => Err(Error::StillOpen),
        }
    }

    /// True only while the native source is capturing with no blocker. The
    /// auto-stop limit fires only here, so it never retries a stalled stop.
    pub fn is_live(&self) -> bool {
        matches!(self.session, Some(Session { segment: Segment::Open { .. }, .. }))
    }

    /// Audio time from confirmed segments only; the open segment is excluded.
    pub fn recorded_ms(&self) -> u64 {
        self.session.map_or(0, |session| session.recorded_ms)
    }

    /// Milliseconds the current native segment has been open. Zero when none is open.
    pub fn segment_ms(&self, now_ms: u64) -> u64 {
        match self.session {
            Some(Session { segment: Segment::Open { since_ms } | Segment::Stalled { since_ms, .. }, .. }) => {
                now_ms.saturating_sub(since_ms)
            }
            _ => 0,
        }
    }

    /// True while a native source may still be capturing (open or stalled).
    pub fn is_native_open(&self) -> bool {
        matches!(self.session, Some(Session { segment: Segment::Open { .. } | Segment::Stalled { .. }, .. }))
    }

    pub fn status(&self, now_ms: u64) -> Status {
        let Some(session) = self.session else {
            return Status {
                state: if self.blocker.is_some() { State::NeedsUser } else { State::Idle },
                reason: self.blocker,
                elapsed_ms: 0,
                paused_ms: 0,
            };
        };
        let (live_ms, paused_now_ms) = match session.segment {
            Segment::Closed { paused_since_ms } => (0, now_ms.saturating_sub(paused_since_ms)),
            Segment::Open { since_ms } | Segment::Stalled { since_ms, .. } => {
                (now_ms.saturating_sub(since_ms), 0)
            }
        };
        let (state, reason) = match session.segment {
            Segment::Stalled { stall, .. } => (State::NeedsUser, Some(stall.reason())),
            _ if self.blocker.is_some() => (State::NeedsUser, self.blocker),
            Segment::Open { .. } => (State::Recording, None),
            Segment::Closed { .. } => (State::Paused, Some("user")),
        };
        Status {
            state,
            reason,
            elapsed_ms: session.recorded_ms + live_ms,
            paused_ms: session.paused_ms + paused_now_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn selected_device_mapping_fails_closed_on_partial_name_resolution() {
        assert_eq!(
            resolve_named_devices("USB Mic", &[(1, Some("USB Mic".into())), (2, None)]),
            None,
        );
    }

    #[test]
    fn selected_device_mapping_fails_closed_on_duplicate_names() {
        assert_eq!(
            resolve_named_devices("USB Mic", &[(1, Some("USB Mic".into())), (2, Some("USB Mic".into()))]),
            None,
        );
    }

    #[test]
    fn selected_device_mapping_returns_the_unique_matching_id() {
        assert_eq!(
            resolve_named_devices("USB Mic", &[(1, Some("Internal Mic".into())), (2, Some("USB Mic".into()))]),
            Some(vec![2]),
        );
    }

    #[test]
    fn unknown_new_source_keeps_unconfirmed_aggregate_unknown_after_old_device_releases() {
        let old = Some(vec![7]);
        let after_new_unknown = merge_unconfirmed_devices(old.as_deref(), None);
        assert_eq!(after_new_unknown, None);
        let after_old_released = after_new_unknown
            .as_deref()
            .map(|devices| devices.iter().any(|device| *device == 7));
        assert_eq!(after_old_released, None);
    }

    #[test]
    fn discard_owner_match_rejects_a_stale_or_missing_recording() {
        assert!(is_current_recording("old", Some("old")));
        assert!(!is_current_recording("old", Some("new")));
        assert!(!is_current_recording("old", None));
    }
    fn recording_at(now_ms: u64) -> Recorder {
        let mut recorder = Recorder::new();
        recorder.start_outcome(now_ms, Start::Opened).unwrap();
        recorder
    }

    #[test]
    fn paused_only_after_session_finalization_and_paused_time_is_excluded_from_elapsed() {
        let mut recorder = recording_at(0);
        assert_eq!(recorder.request(Request::Pause), Ok(Step::StopSource));
        recorder.stop_outcome(1_000, Stop::SessionFinalized).unwrap();

        let paused = recorder.status(1_000);
        assert_eq!((paused.state, paused.elapsed_ms, paused.paused_ms), (State::Paused, 1_000, 0));

        let later = recorder.status(5_000);
        assert_eq!((later.state, later.elapsed_ms, later.paused_ms), (State::Paused, 1_000, 4_000));
    }

    #[test]
    fn unconfirmed_source_never_reports_paused_and_keeps_counting_time() {
        let mut recorder = recording_at(0);
        assert_eq!(
            recorder.stop_outcome(1_000, Stop::Stalled(Stall::SourceStillRunning)),
            Err(Error::Stalled(Stall::SourceStillRunning))
        );

        let stalled = recorder.status(2_000);
        assert_eq!((stalled.state, stalled.reason), (State::NeedsUser, Some("source_still_running")));
        assert_eq!(stalled.elapsed_ms, 2_000);
        assert!(!recorder.is_live());
    }

    #[test]
    fn never_stopping_source_finishes_unconfirmed_after_final_stop_budget_attempt() {
        let mut recorder = recording_at(0);

        for attempt in 1..=DURABLE_STOP_ATTEMPT_BUDGET as u64 {
            assert_eq!(recorder.request(Request::Stop), Ok(Step::StopSource));
            assert_eq!(
                recorder.stop_outcome(
                    attempt * 1_000,
                    Stop::Stalled(Stall::SourceStillRunning)
                ),
                Err(Error::Stalled(Stall::SourceStillRunning))
            );
            if attempt < DURABLE_STOP_ATTEMPT_BUDGET as u64 {
                assert!(!recorder.can_finish_unconfirmed());
                assert_ne!(recorder.status(attempt * 1_000).state, State::Paused);
            }
        }
        assert_eq!(
            recorder.unfinalized_stop_attempts(),
            DURABLE_STOP_ATTEMPT_BUDGET
        );
        assert!(recorder.can_finish_unconfirmed());
        assert_eq!(
            recorder.status(3_000).reason,
            Some("source_still_running")
        );
        assert_eq!(recorder.finish_unconfirmed(3_000), Ok(3_000));
        assert_eq!(
            recorder.status(3_000).reason,
            Some(UNCONFIRMED_STOP_REASON)
        );
        assert_eq!(recorder.finish(), Ok(3_000));
    }

    #[test]
    fn writer_stall_keeps_segment_and_stop_retries_the_native_stop() {
        let mut recorder = recording_at(0);
        let stalled = recorder.stop_outcome(1_000, Stop::Stalled(Stall::WriterStalled));
        assert_eq!(stalled.map_err(Error::code), Err("capture_stop_timeout"));
        assert_eq!(recorder.status(1_000).reason, Some("writer_stalled"));

        assert_eq!(recorder.request(Request::Resume), Ok(Step::StopSource));
        assert_eq!(recorder.request(Request::Stop), Ok(Step::StopSource));
        recorder.stop_outcome(2_000, Stop::SessionFinalized).unwrap();
        assert_eq!(recorder.finish(), Ok(2_000));
    }

    #[test]
    fn resume_after_stall_retries_stop_then_starts() {
        let mut recorder = recording_at(0);
        let _ = recorder.stop_outcome(1_000, Stop::Stalled(Stall::WriterStalled));

        assert_eq!(recorder.request(Request::Resume), Ok(Step::StopSource));
        recorder.stop_outcome(1_500, Stop::SessionFinalized).unwrap();
        assert_eq!(recorder.request(Request::Resume), Ok(Step::StartSource));
        recorder.start_outcome(2_000, Start::Opened).unwrap();

        let resumed = recorder.status(2_000);
        assert_eq!((resumed.state, resumed.elapsed_ms, resumed.paused_ms), (State::Recording, 1_500, 500));
        assert!(recorder.is_live());
    }

    #[test]
    fn explicit_rejections_have_stable_codes() {
        let mut recorder = recording_at(0);
        let resume = recorder.request(Request::Resume);
        assert_eq!(resume.map_err(Error::code), Err("already_recording"));

        recorder.stop_outcome(1_000, Stop::SessionFinalized).unwrap();
        let pause_again = recorder.request(Request::Pause);
        assert_eq!(pause_again.map_err(Error::code), Err("already_paused"));

        let mut idle = Recorder::new();
        assert_eq!(idle.request(Request::Stop).map_err(Error::code), Err("not_recording"));
        assert_eq!(idle.finish().map_err(Error::code), Err("not_recording"));
    }

    #[test]
    fn failed_resume_stays_paused_with_reason_and_next_resume_retries_start() {
        let mut recorder = recording_at(0);
        recorder.stop_outcome(1_000, Stop::SessionFinalized).unwrap();

        assert_eq!(
            recorder.start_outcome(2_000, Start::Failed("mic_unavailable")),
            Err(Error::Start("mic_unavailable"))
        );
        let blocked = recorder.status(2_000);
        assert_eq!((blocked.state, blocked.reason, blocked.paused_ms), (State::NeedsUser, Some("mic_unavailable"), 1_000));

        assert_eq!(recorder.request(Request::Resume), Ok(Step::StartSource));
        recorder.start_outcome(3_000, Start::Opened).unwrap();
        let resumed = recorder.status(3_000);
        assert_eq!((resumed.state, resumed.reason, resumed.paused_ms), (State::Recording, None, 2_000));
    }

    #[test]
    fn start_failure_blocks_idle_until_a_start_succeeds() {
        let mut recorder = Recorder::new();
        assert_eq!(
            recorder.start_outcome(0, Start::Failed("mic_unavailable")),
            Err(Error::Start("mic_unavailable"))
        );
        let blocked = recorder.status(0);
        assert_eq!((blocked.state, blocked.reason), (State::NeedsUser, Some("mic_unavailable")));

        recorder.start_outcome(100, Start::Opened).unwrap();
        assert_eq!(recorder.status(100).state, State::Recording);
        assert_eq!(recorder.status(100).reason, None);
    }

    #[test]
    fn stop_from_paused_needs_no_native_call_and_returns_total_audio() {
        let mut recorder = recording_at(0);
        recorder.stop_outcome(1_000, Stop::SessionFinalized).unwrap();

        assert_eq!(recorder.request(Request::Stop), Ok(Step::Done));
        assert_eq!(recorder.finish(), Ok(1_000));
        assert_eq!(recorder.request(Request::Stop).map_err(Error::code), Err("not_recording"));
    }

    #[test]
    fn empty_stop_closes_without_counting_audio() {
        let mut recorder = recording_at(0);
        recorder.stop_outcome(1_000, Stop::Empty).unwrap();
        assert_eq!(recorder.status(1_000).state, State::Paused);
        assert_eq!(recorder.recorded_ms(), 0);
        assert_eq!(recorder.finish(), Ok(0));
    }

    #[test]
    fn unusable_source_stalls_and_a_retried_stop_can_still_confirm() {
        let mut recorder = recording_at(0);
        let stalled = recorder.stop_outcome(1_000, Stop::Stalled(Stall::SourceUnusable));
        assert_eq!(stalled.map_err(Error::code), Err("source_unusable"));
        assert_eq!(recorder.status(1_000).reason, Some("source_unusable"));
        assert!(recorder.is_native_open());
        assert_eq!(recorder.segment_ms(1_500), 1_500);

        assert_eq!(recorder.request(Request::Stop), Ok(Step::StopSource));
        recorder.stop_outcome(2_000, Stop::SessionFinalized).unwrap();
        assert_eq!(recorder.finish(), Ok(2_000));
    }
}
