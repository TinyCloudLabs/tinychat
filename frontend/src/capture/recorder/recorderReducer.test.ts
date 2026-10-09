// The recorder's phases (plan §4.2): every transition, including the races the
// card's refs used to guard (a Stop losing to the limit's auto-stop).
import { describe, expect, test } from "bun:test";

import { initialRecorderState, recorderReducer, type RecorderEvent, type RecorderState } from "./recorderReducer";

const run = (events: RecorderEvent[], from: RecorderState = initialRecorderState) => events.reduce(recorderReducer, from);
const STARTED: RecorderEvent = { type: "STARTED", id: "rec-1", startedAt: 1000, maxDurationMs: 3_600_000, elapsedAt: 0 };
const recording = () => run([{ type: "START_REQUESTED" }, STARTED]);

describe("recorderReducer", () => {
  test("record: idle → starting → recording, clearing the last error, notice and receipt", () => {
    const stale: RecorderState = { ...initialRecorderState, error: "old", limitNotice: "Stopped at the 60-minute limit.", outcome: "saved" };
    const starting = recorderReducer(stale, { type: "START_REQUESTED" });
    expect(starting).toMatchObject({ phase: "starting", error: null, limitNotice: null, outcome: null });
    expect(recorderReducer(starting, STARTED)).toMatchObject({
      phase: "recording",
      recordingId: "rec-1",
      startedAt: 1000,
      maxDurationMs: 3_600_000,
      mic: { state: "recording", reason: null },
    });
  });

  test("a second Record while busy changes nothing", () => {
    const live = recording();
    expect(recorderReducer(live, { type: "START_REQUESTED" })).toBe(live);
  });

  test("a failed start is told and back to idle", () => {
    expect(run([{ type: "START_REQUESTED" }, { type: "START_FAILED", error: "permission_denied" }])).toMatchObject({
      phase: "idle",
      error: "permission_denied",
    });
  });

  test("a running recording is picked up after a reload, with its mic state and limit", () => {
    const picked = recorderReducer(initialRecorderState, {
      type: "PICKED_UP",
      id: "rec-9",
      startedAt: 500,
      maxDurationMs: 60_000,
      audioMs: 5000,
      elapsedMs: 7000, elapsedAt: 10_000,
      mic: { state: "silenced", reason: "os_silenced" },
    });
    expect(picked).toMatchObject({ phase: "recording", recordingId: "rec-9", startedAt: 500, maxDurationMs: 60_000,
      audioMs: 5000, elapsedMs: 7000, elapsedAt: 10_000, mic: { state: "silenced" } });
    // Never over a save in progress.
    const saving = run([{ type: "STOP_REQUESTED", at: 0 }, { type: "SAVE_PROGRESS", percent: null }], recording());
    expect(recorderReducer(saving, { type: "PICKED_UP", id: "x", startedAt: 0, maxDurationMs: 60_000, audioMs: 0, elapsedMs: 0, elapsedAt: 0, mic: { state: "recording", reason: null } })).toBe(saving);
  });

  test("mic state applies only while recording", () => {
    const silenced = recorderReducer(recording(), { type: "MIC_STATE", mic: { state: "silenced", reason: "os_silenced" } });
    expect(silenced.mic).toEqual({ state: "silenced", reason: "os_silenced" });
    expect(recorderReducer(initialRecorderState, { type: "MIC_STATE", mic: { state: "recording", reason: null } })).toBe(initialRecorderState);
  });

  test("recorded elapsed time freezes across Pause and resumes without counting the pause", () => {
    const live = recorderReducer(recording(), { type: "MIC_STATE", mic: { state: "recording", reason: null }, audioMs: 1200, elapsedMs: 1200, elapsedAt: 0 });
    const paused = recorderReducer(live, { type: "MIC_STATE", mic: { state: "paused", reason: "user" }, audioMs: 1200, elapsedMs: 1250, elapsedAt: 0 });
    expect(paused.elapsedMs).toBe(1250);
    const stillPaused = recorderReducer(paused, { type: "MIC_STATE", mic: { state: "paused", reason: "user" }, audioMs: 1200, elapsedMs: 1250, elapsedAt: 0 });
    expect(stillPaused.elapsedMs).toBe(1250);
    const resumed = recorderReducer(stillPaused, { type: "MIC_STATE", mic: { state: "recording", reason: null }, audioMs: 1400, elapsedMs: 1450, elapsedAt: 0 });
    expect(resumed).toMatchObject({ audioMs: 1400, elapsedMs: 1450, elapsedAt: 0 });
  });

  test("an interruption gap counts toward recorded elapsed time without adding audio", () => {
    const live = recorderReducer(recording(), { type: "MIC_STATE", mic: { state: "recording", reason: null }, audioMs: 2000, elapsedMs: 2000, elapsedAt: 0 });
    const interrupted = recorderReducer(live, { type: "MIC_STATE", mic: { state: "interrupted", reason: "call" }, audioMs: 2000, elapsedMs: 12_000, elapsedAt: 0 });
    expect(interrupted).toMatchObject({ audioMs: 2000, elapsedMs: 12_000, elapsedAt: 0 });
    const resumed = recorderReducer(interrupted, { type: "MIC_STATE", mic: { state: "recording", reason: null }, audioMs: 2500, elapsedMs: 12_500, elapsedAt: 0 });
    expect(resumed.elapsedMs).toBe(12_500);
  });

  test("Stop and auto-stop freeze the elapsed clock at the transition", () => {
    const live = recorderReducer(recording(), { type: "MIC_STATE", mic: { state: "recording", reason: null },
      audioMs: 79_000, elapsedMs: 79_706, elapsedAt: 10_000 });
    const stopping = recorderReducer(live, { type: "STOP_REQUESTED", at: 50_000 });
    expect(stopping).toMatchObject({ phase: "stopping", elapsedMs: 119_706, elapsedAt: 50_000 });
    expect(recorderReducer(stopping, { type: "SAVE_PROGRESS", percent: null }).elapsedMs).toBe(119_706);

    const auto = recorderReducer(live, { type: "AUTO_STOPPED", id: "rec-1", captured: true,
      notice: "limit", at: 50_000, elapsedMs: 119_500 });
    expect(auto).toMatchObject({ phase: "saving", elapsedMs: 119_500, elapsedAt: 50_000 });
  });

  test("pause waits for native confirmation; Resume and a failed reacquisition are surfaced", () => {
    const requested = recorderReducer(recording(), { type: "PAUSE_REQUESTED" });
    expect(requested).toMatchObject({ mic: { state: "recording", reason: null }, controlPending: "pause" });
    expect(recorderReducer(requested, { type: "PAUSE_REQUESTED" })).toBe(requested);
    expect(recorderReducer(requested, { type: "PAUSE_FAILED", error: "busy" })).toMatchObject({ mic: { state: "recording" }, error: "busy" });
    const paused = recorderReducer(requested, { type: "MIC_STATE", mic: { state: "paused", reason: "user" } });
    expect(paused).toMatchObject({ phase: "recording", mic: { state: "paused", reason: "user" }, controlPending: "pause" });
    const confirmed = recorderReducer(paused, { type: "PAUSE_CONFIRMED" });
    expect(confirmed.controlPending).toBeNull();
    const resuming = recorderReducer(confirmed, { type: "RESUME_REQUESTED" });
    expect(resuming).toMatchObject({ controlPending: "resume", error: null });
    expect(recorderReducer(resuming, { type: "RESUME_REQUESTED" })).toBe(resuming);
    const failed = recorderReducer(resuming, { type: "RESUME_FAILED", error: "microphone_busy" });
    expect(failed).toMatchObject({ mic: { state: "needs_user", reason: "resume_blocked" }, error: "microphone_busy" });
    expect(recorderReducer(failed, { type: "MIC_STATE", mic: { state: "needs_user", reason: "resume_blocked" } })).toMatchObject({ error: "microphone_busy" });
    expect(recorderReducer(paused, { type: "STOP_REQUESTED", at: 0 }).phase).toBe("stopping");
    expect(recorderReducer(paused, { type: "DISCARD_REQUESTED", id: "rec-1" }).phase).toBe("discarding");
  });

  test("stop: recording → stopping → saving with progress → idle with the saved receipt", () => {
    const stopping = recorderReducer(recording(), { type: "STOP_REQUESTED", at: 0 });
    expect(stopping.phase).toBe("stopping");
    const saving = run([{ type: "SAVE_PROGRESS", percent: null }, { type: "SAVE_PROGRESS", percent: 42 }], stopping);
    expect(saving).toMatchObject({ phase: "saving", savePercent: 42 });
    const saved = recorderReducer(saving, { type: "SAVED", id: "rec-1", durationMs: 42_000, at: 9 });
    expect(saved).toMatchObject({
      phase: "idle",
      startedAt: null,
      savePercent: null,
      outcome: "saved",
      lastSaved: { id: "rec-1", durationMs: 42_000, at: 9 },
      mic: { state: "idle", reason: null },
    });
    expect(recorderReducer(saved, { type: "DISMISSED" }).outcome).toBeNull();
  });

  test("a shortcut denial during saving keeps the save running behind the access page", () => {
    const saving = run([{ type: "STOP_REQUESTED", at: 0 }, { type: "SAVE_PROGRESS", percent: 42 }], recording());
    const denied = recorderReducer(saving, { type: "PERMISSION_DENIED" });
    expect(denied).toMatchObject({ phase: "saving", permissionDenied: true });
    const committed = recorderReducer(denied, { type: "LOCAL_COMMITTED", id: "rec-1", durationMs: 42_000, at: 9 });
    expect(committed).toMatchObject({ phase: "idle", permissionDenied: true, outcome: "local" });
    const saved = recorderReducer(committed, { type: "SAVED", id: "rec-1", durationMs: 42_000, at: 10 });
    expect(saved).toMatchObject({ permissionDenied: true, outcome: "saved" });
  });

  test("Stop is ignored until the recorder has started", () => {
    const starting = recorderReducer(initialRecorderState, { type: "START_REQUESTED" });
    expect(recorderReducer(starting, { type: "STOP_REQUESTED", at: 0 })).toBe(starting);
  });

  test("a failed save keeps the note on the phone and says so", () => {
    const failed = run([{ type: "STOP_REQUESTED", at: 0 }, { type: "SAVE_PROGRESS", percent: 10 }, { type: "SAVE_FAILED", error: "offline", recording: { id: "rec-1", durationMs: 42_000 } }], recording());
    expect(failed).toMatchObject({ phase: "idle", outcome: "failed", error: "offline" });
    expect(recorderReducer(failed, { type: "DISMISSED" })).toMatchObject({ outcome: null, error: null });
  });

  test("a failed stop uses the checked native status, and unknown remains visible", () => {
    const stopping = recorderReducer(recording(), { type: "STOP_REQUESTED", at: 0 });
    expect(recorderReducer(stopping, { type: "STOP_FAILED", error: "busy", status: "active", mic: { state: "paused", reason: "user" }, audioMs: 41_000, elapsedMs: 45_000, elapsedAt: 0 }))
      .toMatchObject({ phase: "recording", mic: { state: "paused" }, audioMs: 41_000, elapsedMs: 45_000, error: "busy" });
    expect(recorderReducer(stopping, { type: "STOP_FAILED", error: null, status: "idle" })).toMatchObject({ phase: "idle", error: null });
    expect(recorderReducer(stopping, { type: "STOP_FAILED", error: "Could not check", status: "unknown" }))
      .toMatchObject({ phase: "stopping", error: "Could not check" });
  });

  test("AUTO_STOPPED during stopping: the limit's save takes over and a late not_recording cannot reset it", () => {
    const stopping = recorderReducer(recording(), { type: "STOP_REQUESTED", at: 0 });
    const auto = recorderReducer(stopping, { type: "AUTO_STOPPED", at: 0, id: "rec-1", notice: "Stopped at the 60-minute limit.", captured: true });
    expect(auto).toMatchObject({ phase: "saving", autoSaving: true, limitNotice: "Stopped at the 60-minute limit." });
    expect(recorderReducer(auto, { type: "STOP_FAILED", error: null, status: "idle" })).toBe(auto);
    const saved = recorderReducer(auto, { type: "SAVED", id: "rec-1", durationMs: 3_600_000, at: 1 });
    expect(saved).toMatchObject({ phase: "idle", outcome: "saved", autoSaving: false, limitNotice: "Stopped at the 60-minute limit." });
  });

  test("AUTO_STOPPED while recording or idle saves; with nothing captured it says so", () => {
    expect(recorderReducer(recording(), { type: "AUTO_STOPPED", at: 0, id: "rec-1", notice: "n", captured: true }).phase).toBe("saving");
    expect(recorderReducer(initialRecorderState, { type: "AUTO_STOPPED", at: 0, id: "rec-1", notice: "n", captured: true }).phase).toBe("saving");
    expect(recorderReducer(recording(), { type: "AUTO_STOPPED", at: 0, id: null, notice: "Stopped at the 60-minute limit.", captured: false })).toMatchObject({
      phase: "idle",
      limitNotice: "Stopped at the 60-minute limit.",
      error: "Stopped at the 60-minute limit. The recording captured no audio.",
    });
  });

  test("a finalization timeout keeps audio for recovery instead of claiming no audio", () => {
    const stopped = recorderReducer(recording(), {
      type: "AUTO_STOPPED", at: 0, id: null, notice: "Stopped at the 60-minute limit.",
      captured: false, error: "finalization_timed_out",
    });
    expect(stopped).toMatchObject({
      phase: "idle",
      error: "Recording kept on this phone. Exo will finish it automatically.",
    });
    expect(stopped.error).not.toContain("captured no audio");
  });

  test("another recording's auto-stop or save result never touches the one on screen", () => {
    const live = recording();
    expect(recorderReducer(live, { type: "AUTO_STOPPED", at: 0, id: "rec-old", notice: "n", captured: true })).toBe(live);
    expect(recorderReducer(live, { type: "SAVED", id: "rec-old", durationMs: 1, at: 1 })).toBe(live);
    const starting = recorderReducer(initialRecorderState, { type: "START_REQUESTED" });
    expect(recorderReducer(starting, { type: "AUTO_STOPPED", at: 0, id: "rec-old", notice: "n", captured: true })).toBe(starting);
    const saving = run([{ type: "STOP_REQUESTED", at: 0 }, { type: "SAVE_PROGRESS", percent: 10 }], live);
    expect(recorderReducer(saving, { type: "SAVE_FAILED", error: "x", recording: { id: "rec-old", durationMs: 1 } })).toBe(saving);
    expect(recorderReducer(saving, { type: "SAVED", id: "rec-old", durationMs: 1, at: 1 })).toBe(saving);
  });

  test("Record waits until status() and the retained events are heard", () => {
    expect(initialRecorderState.ready).toBe(false);
    expect(recorderReducer(initialRecorderState, { type: "RECONCILED" }).ready).toBe(true);
  });

  test("discard: recording → discarding → idle, with nothing to show", () => {
    const discarding = recorderReducer(recording(), { type: "DISCARD_REQUESTED", id: "rec-1" });
    expect(discarding.phase).toBe("discarding");
    expect(recorderReducer(discarding, { type: "DISCARDED", id: "rec-1" })).toMatchObject({
      phase: "idle",
      recordingId: null,
      startedAt: null,
      outcome: null,
      error: null,
      limitNotice: null,
      mic: { state: "idle", reason: null },
    });
  });

  test("discard only takes a live recording", () => {
    const starting = recorderReducer(initialRecorderState, { type: "START_REQUESTED" });
    expect(recorderReducer(starting, { type: "DISCARD_REQUESTED", id: "rec-1" })).toBe(starting);
    const saving = run([{ type: "STOP_REQUESTED", at: 0 }, { type: "SAVE_PROGRESS", percent: 5 }], recording());
    expect(recorderReducer(saving, { type: "DISCARD_REQUESTED", id: "rec-1" })).toBe(saving);
    expect(recorderReducer(initialRecorderState, { type: "DISCARDED", id: "rec-1" })).toBe(initialRecorderState);
  });

  test("a discard event for another recording never touches the one on screen", () => {
    const live = recording();
    expect(recorderReducer(live, { type: "DISCARD_REQUESTED", id: "rec-old" })).toBe(live);
    const discarding = recorderReducer(live, { type: "DISCARD_REQUESTED", id: "rec-1" });
    expect(recorderReducer(discarding, { type: "DISCARDED", id: "rec-old" })).toBe(discarding);
    expect(recorderReducer(discarding, { type: "DISCARD_FAILED", id: "rec-old", error: "x" })).toBe(discarding);
    // An id the recorder does not know (a pickup without one) matches, as for the save events.
    expect(recorderReducer(discarding, { type: "DISCARDED", id: null }).phase).toBe("idle");
  });

  test("a failed native discard keeps the live recording available for retry", () => {
    const failed = run([{ type: "DISCARD_REQUESTED", id: "rec-1" }, { type: "DISCARD_FAILED", id: "rec-1", error: "Could not discard the recording: busy" }], recording());
    expect(failed).toMatchObject({ phase: "recording", outcome: null, error: "Could not discard the recording: busy" });
    const committedFailure = run([{ type: "DISCARD_REQUESTED", id: "rec-1" }, { type: "DISCARD_FAILED", id: "rec-1", error: "The file is busy", committed: true }], recording());
    expect(committedFailure).toMatchObject({ phase: "idle", error: "The file is busy" });
  });

  test("discard racing the limit's auto-stop: whichever is first wins, and nothing is both", () => {
    // Discard first: the limit's auto-stop, its save and its reset never move the phase.
    const discarding = recorderReducer(recording(), { type: "DISCARD_REQUESTED", id: "rec-1" });
    for (const event of [
      { type: "AUTO_STOPPED", at: 0, id: "rec-1", notice: "Stopped at the 60-minute limit.", captured: true },
      { type: "SAVE_PROGRESS", percent: null },
      { type: "SAVED", id: "rec-1", durationMs: 1, at: 1 },
      { type: "SAVE_FAILED", error: "x", recording: null },
      { type: "RESET" },
      { type: "STOP_FAILED", error: null, status: "idle" },
    ] satisfies RecorderEvent[]) {
      expect(recorderReducer(discarding, event)).toBe(discarding);
    }
    expect(recorderReducer(discarding, { type: "DISCARDED", id: "rec-1" })).toMatchObject({ phase: "idle", outcome: null, limitNotice: null });

    // The limit first: the recording is being saved, and a late Discard changes nothing.
    const auto = recorderReducer(recording(), { type: "AUTO_STOPPED", at: 0, id: "rec-1", notice: "Stopped at the 60-minute limit.", captured: true });
    expect(recorderReducer(auto, { type: "DISCARD_REQUESTED", id: "rec-1" })).toBe(auto);
    expect(recorderReducer(auto, { type: "SAVED", id: "rec-1", durationMs: 3_600_000, at: 1 })).toMatchObject({ phase: "idle", outcome: "saved" });
  });

  test("RESET returns to idle keeping what the user still has to read", () => {
    const saving = run([{ type: "STOP_REQUESTED", at: 0 }, { type: "SAVE_PROGRESS", percent: 5 }], { ...recording(), limitNotice: "n" });
    expect(recorderReducer(saving, { type: "RESET" })).toMatchObject({ phase: "idle", savePercent: null, limitNotice: "n", outcome: null });
  });
});
