// The recorder's phases (plan §4.2): every transition, including the races the
// card's refs used to guard (a Stop losing to the limit's auto-stop).
import { describe, expect, test } from "bun:test";

import { initialRecorderState, recorderReducer, type RecorderEvent, type RecorderState } from "./recorderReducer";

const run = (events: RecorderEvent[], from: RecorderState = initialRecorderState) => events.reduce(recorderReducer, from);
const STARTED: RecorderEvent = { type: "STARTED", id: "rec-1", startedAt: 1000, maxDurationMs: 3_600_000 };
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
      mic: { state: "silenced", reason: "os_silenced" },
    });
    expect(picked).toMatchObject({ phase: "recording", recordingId: "rec-9", startedAt: 500, maxDurationMs: 60_000, mic: { state: "silenced" } });
    // Never over a save in progress.
    const saving = run([{ type: "STOP_REQUESTED" }, { type: "SAVE_PROGRESS", percent: null }], recording());
    expect(recorderReducer(saving, { type: "PICKED_UP", id: "x", startedAt: 0, mic: { state: "recording", reason: null } })).toBe(saving);
  });

  test("mic state applies only while recording", () => {
    const silenced = recorderReducer(recording(), { type: "MIC_STATE", mic: { state: "silenced", reason: "os_silenced" } });
    expect(silenced.mic).toEqual({ state: "silenced", reason: "os_silenced" });
    expect(recorderReducer(initialRecorderState, { type: "MIC_STATE", mic: { state: "recording", reason: null } })).toBe(initialRecorderState);
  });

  test("stop: recording → stopping → saving with progress → idle with the saved receipt", () => {
    const stopping = recorderReducer(recording(), { type: "STOP_REQUESTED" });
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

  test("Stop is ignored until the recorder has started", () => {
    const starting = recorderReducer(initialRecorderState, { type: "START_REQUESTED" });
    expect(recorderReducer(starting, { type: "STOP_REQUESTED" })).toBe(starting);
  });

  test("a failed save keeps the note on the phone and says so", () => {
    const failed = run([{ type: "STOP_REQUESTED" }, { type: "SAVE_PROGRESS", percent: 10 }, { type: "SAVE_FAILED", error: "offline", recording: { id: "rec-1", durationMs: 42_000 } }], recording());
    expect(failed).toMatchObject({ phase: "idle", outcome: "failed", error: "offline" });
    expect(recorderReducer(failed, { type: "DISMISSED" })).toMatchObject({ outcome: null, error: null });
  });

  test("a failed stop is told; not_recording leaves the error alone", () => {
    const stopping = recorderReducer(recording(), { type: "STOP_REQUESTED" });
    expect(recorderReducer(stopping, { type: "STOP_FAILED", error: "no_audio_captured" })).toMatchObject({ phase: "idle", error: "no_audio_captured" });
    expect(recorderReducer(stopping, { type: "STOP_FAILED", error: null })).toMatchObject({ phase: "idle", error: null });
  });

  test("AUTO_STOPPED during stopping: the limit's save takes over and a late not_recording cannot reset it", () => {
    const stopping = recorderReducer(recording(), { type: "STOP_REQUESTED" });
    const auto = recorderReducer(stopping, { type: "AUTO_STOPPED", id: "rec-1", notice: "Stopped at the 60-minute limit.", captured: true });
    expect(auto).toMatchObject({ phase: "saving", autoSaving: true, limitNotice: "Stopped at the 60-minute limit." });
    expect(recorderReducer(auto, { type: "STOP_FAILED", error: null })).toBe(auto);
    const saved = recorderReducer(auto, { type: "SAVED", id: "rec-1", durationMs: 3_600_000, at: 1 });
    expect(saved).toMatchObject({ phase: "idle", outcome: "saved", autoSaving: false, limitNotice: "Stopped at the 60-minute limit." });
  });

  test("AUTO_STOPPED while recording or idle saves; with nothing captured it says so", () => {
    expect(recorderReducer(recording(), { type: "AUTO_STOPPED", id: "rec-1", notice: "n", captured: true }).phase).toBe("saving");
    expect(recorderReducer(initialRecorderState, { type: "AUTO_STOPPED", id: "rec-1", notice: "n", captured: true }).phase).toBe("saving");
    expect(recorderReducer(recording(), { type: "AUTO_STOPPED", id: null, notice: "Stopped at the 60-minute limit.", captured: false })).toMatchObject({
      phase: "idle",
      limitNotice: "Stopped at the 60-minute limit.",
      error: "Stopped at the 60-minute limit. The recording captured no audio.",
    });
  });

  test("another recording's auto-stop or save result never touches the one on screen", () => {
    const live = recording();
    expect(recorderReducer(live, { type: "AUTO_STOPPED", id: "rec-old", notice: "n", captured: true })).toBe(live);
    expect(recorderReducer(live, { type: "SAVED", id: "rec-old", durationMs: 1, at: 1 })).toBe(live);
    const starting = recorderReducer(initialRecorderState, { type: "START_REQUESTED" });
    expect(recorderReducer(starting, { type: "AUTO_STOPPED", id: "rec-old", notice: "n", captured: true })).toBe(starting);
    const saving = run([{ type: "STOP_REQUESTED" }, { type: "SAVE_PROGRESS", percent: 10 }], live);
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
    const saving = run([{ type: "STOP_REQUESTED" }, { type: "SAVE_PROGRESS", percent: 5 }], recording());
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

  test("a failed discard is told and back to idle", () => {
    const failed = run([{ type: "DISCARD_REQUESTED", id: "rec-1" }, { type: "DISCARD_FAILED", id: "rec-1", error: "Could not discard the recording: busy" }], recording());
    expect(failed).toMatchObject({ phase: "idle", outcome: null, error: "Could not discard the recording: busy" });
  });

  test("discard racing the limit's auto-stop: whichever is first wins, and nothing is both", () => {
    // Discard first: the limit's auto-stop, its save and its reset never move the phase.
    const discarding = recorderReducer(recording(), { type: "DISCARD_REQUESTED", id: "rec-1" });
    for (const event of [
      { type: "AUTO_STOPPED", id: "rec-1", notice: "Stopped at the 60-minute limit.", captured: true },
      { type: "SAVE_PROGRESS", percent: null },
      { type: "SAVED", id: "rec-1", durationMs: 1, at: 1 },
      { type: "SAVE_FAILED", error: "x", recording: null },
      { type: "RESET" },
      { type: "STOP_FAILED", error: null },
    ] satisfies RecorderEvent[]) {
      expect(recorderReducer(discarding, event)).toBe(discarding);
    }
    expect(recorderReducer(discarding, { type: "DISCARDED", id: "rec-1" })).toMatchObject({ phase: "idle", outcome: null, limitNotice: null });

    // The limit first: the recording is being saved, and a late Discard changes nothing.
    const auto = recorderReducer(recording(), { type: "AUTO_STOPPED", id: "rec-1", notice: "Stopped at the 60-minute limit.", captured: true });
    expect(recorderReducer(auto, { type: "DISCARD_REQUESTED", id: "rec-1" })).toBe(auto);
    expect(recorderReducer(auto, { type: "SAVED", id: "rec-1", durationMs: 3_600_000, at: 1 })).toMatchObject({ phase: "idle", outcome: "saved" });
  });

  test("RESET returns to idle keeping what the user still has to read", () => {
    const saving = run([{ type: "STOP_REQUESTED" }, { type: "SAVE_PROGRESS", percent: 5 }], { ...recording(), limitNotice: "n" });
    expect(recorderReducer(saving, { type: "RESET" })).toMatchObject({ phase: "idle", savePercent: null, limitNotice: "n", outcome: null });
  });
});
