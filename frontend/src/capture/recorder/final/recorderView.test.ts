import { describe, expect, test } from "bun:test";
import type { MicState, MicStateReason } from "@/lib/voiceNotes/nativeVoiceNotes";
import { initialRecorderState, type RecorderState } from "../recorderReducer";
import { selectRecorderView } from "./recorderView";

const reasons: MicStateReason[] = [null, "os_silenced", "no_signal", "input_muted", "call", "user", "interruption", "route_change", "media_services_reset", "read_error", "stalled", "app_suspended", "writer_stalled", "resume_blocked", "resume_not_allowed", "mic_unavailable", "pause_timeout", "max_duration", "disk_full", "write_failed", "permission_revoked"];
const micStates: MicState[] = ["idle", "recording", "silenced", "paused", "interrupted", "needs_user"];
const base: RecorderState = { ...initialRecorderState, phase: "recording", recordingId: "test", ready: true };
const input = { nowMs: 10_000, elapsedMs: 12_345, shell: "phone" as const };

describe("selectRecorderView", () => {
  test.each(micStates.flatMap((micState) => reasons.map((reason) => [micState, reason] as const)))("maps %s / %s", (micState, reason) => {
    const view = selectRecorderView({ ...base, mic: { state: micState, reason } }, input);
    expect(["live", "paused", "still", "still-resumable", "idle"]).toContain(view.ring);
    expect(["red", "filled-grey", "hollow"]).toContain(view.pill.dot);
    expect(view.timer.text).toBe("0:12");
    if (micState === "silenced") expect(view.ring).toBe("live");
    if (micState === "paused") expect(view.ring).toBe("paused");
    if (micState === "needs_user" || micState === "interrupted" && reason === "resume_not_allowed") expect(view.tapRingAction).toBe("resume");
  });
  test("red is exclusive to live recording; silence is flat and appears at five seconds", () => {
    expect(selectRecorderView({ ...base, mic: { state: "silenced", reason: "call" } }, { ...input, nowMs: 4_999, silencedSinceMs: 0 }).statusLine).toBeNull();
    const view = selectRecorderView({ ...base, mic: { state: "silenced", reason: "call" } }, { ...input, nowMs: 5_000, silencedSinceMs: 0, inputName: "AirPods" });
    expect(view).toMatchObject({ ring: "live", flat: true, pill: { dot: "red" }, statusLine: "No sound from AirPods" });
    expect(selectRecorderView({ ...base, mic: { state: "paused", reason: "user" } }, input).pill.dot).toBe("filled-grey");
  });
  test("elapsedMs drives timer and ten-minute countdown, independently of audioMs", () => {
    const early = selectRecorderView({ ...base, audioMs: 10_799_000 }, { ...input, elapsedMs: 10_000 });
    const late = selectRecorderView({ ...base, audioMs: 0 }, { ...input, elapsedMs: 2 * 60 * 60 * 1000 + 50 * 60 * 1000 });
    expect(early.timer).toEqual({ text: "0:10" });
    expect(late.timer).toEqual({ text: "2:50:00", countdown: { text: "Stops at 3:00:00" } });
  });
  test.each(["starting", "stopping", "saving", "discarding"] as const)("disables controls while %s", (phase) => {
    const view = selectRecorderView({ ...base, phase }, input);
    expect(view.controls).toMatchObject({ pause: false, resume: false, stop: false, discard: false, busy: true });
  });
  test("pending calls disable their matching action and denied permission exposes Open Settings", () => {
    expect(selectRecorderView({ ...base, controlPending: "pause" }, input).controls.pause).toBe(false);
    const denied = selectRecorderView({ ...initialRecorderState, permissionDenied: true }, input);
    expect(denied).toMatchObject({ micDenied: true, controls: { openSettings: true }, statusLine: expect.any(String) });
  });
});
