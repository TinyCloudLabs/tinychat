import { describe, expect, spyOn, test } from "bun:test";
import type {
  MicState,
  MicStateReason,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { initialRecorderState, type RecorderState } from "../recorderReducer";
import { FINAL_COPY } from "./finalCopy";
import { selectRecorderView, type RecorderViewInput } from "./recorderView";

const input: RecorderViewInput = {
  nowMs: 20_000,
  elapsedMs: 30_000,
  inputName: null,
  silencedSinceMs: null,
  isDevelopmentOrTest: true,
};
const base: RecorderState = {
  ...initialRecorderState,
  phase: "recording",
  recordingId: "recording-id",
};

function recordingView(
  state: MicState,
  reason: MicStateReason,
  overrides: Partial<RecorderViewInput> = {},
) {
  return selectRecorderView(
    { ...base, mic: { state, reason } },
    { ...input, ...overrides },
  );
}

describe("selectRecorderView: native interrupted reasons", () => {
  test.each([
    ["call", "Resumes when the call ends"],
    ["stalled", "The microphone stopped sending sound. Reconnecting…"],
    ["interruption", "Paused by a call or Siri. Resumes when it ends."],
    [
      "route_change",
      "The microphone input changed. Waiting for capture to recover.",
    ],
    [
      "media_services_reset",
      "Audio services restarted. Waiting for capture to recover.",
    ],
    [
      "read_error",
      "The microphone could not be read. Waiting for capture to recover.",
    ],
    ["app_suspended", "Recording was interrupted while the app was inactive."],
  ] as const)("interrupted/%s", (reason, statusLine) => {
    expect(recordingView("interrupted", reason)).toMatchObject({
      ring: "still",
      flat: false,
      pill: { label: "Interrupted", dot: "hollow" },
      statusLine,
      tapRingAction: null,
      controls: {
        pause: false,
        resume: false,
        stop: true,
        discard: true,
        busy: false,
        openSettings: false,
      },
    });
  });

  test.each([
    "os_silenced",
    "no_signal",
    "input_muted",
    "user",
    "writer_stalled",
    "resume_blocked",
    "mic_unavailable",
    "resume_not_allowed",
    "pause_timeout",
    "max_duration",
    "disk_full",
    "write_failed",
    "permission_revoked",
  ] as const)(
    "throws for interrupted/%s, which native does not emit",
    (reason) => {
      expect(() => recordingView("interrupted", reason)).toThrow(
        `Unexpected recorder mic combination: interrupted/${reason}`,
      );
    },
  );
});

describe("selectRecorderView: needs_user reason decisions", () => {
  test.each([
    [
      "resume_blocked",
      "The microphone could not resume because the audio session is blocked.",
      "still-resumable",
      "Tap to try again",
      true,
      true,
      false,
    ],
    [
      "mic_unavailable",
      "The microphone is unavailable. Choose another input or reconnect it.",
      "still-resumable",
      "Tap to try again",
      true,
      true,
      false,
    ],
    [
      "stalled",
      "The microphone stopped sending sound.",
      "still-resumable",
      "Tap to resume",
      true,
      true,
      false,
    ],
    [
      "resume_not_allowed",
      null,
      "still-resumable",
      "Tap to resume",
      true,
      true,
      false,
    ],
    [
      "write_failed",
      "Stop and save what's recorded.",
      "still",
      "Interrupted",
      false,
      true,
      false,
    ],
    [
      "permission_revoked",
      "Microphone permission was revoked. Open Settings to allow access.",
      "still",
      "Microphone off",
      false,
      true,
      true,
    ],
  ] as const)(
    "needs_user/%s",
    (reason, statusLine, ring, label, resume, stop, openSettings) => {
      expect(recordingView("needs_user", reason)).toMatchObject({
        ring,
        flat: false,
        pill: { label, dot: "hollow" },
        statusLine,
        tapRingAction: resume ? "resume" : null,
        controls: {
          pause: false,
          resume,
          stop,
          discard: true,
          busy: false,
          openSettings,
        },
        micDenied: openSettings,
      });
    },
  );

  test.each([
    null,
    "os_silenced",
    "no_signal",
    "input_muted",
    "call",
    "interruption",
    "route_change",
    "media_services_reset",
    "read_error",
    "app_suspended",
    "writer_stalled",
    "pause_timeout",
    "max_duration",
    "disk_full",
  ] as const)("throws for unsupported needs_user/%s", (reason) => {
    expect(() => recordingView("needs_user", reason)).toThrow(
      `Unexpected recorder mic combination: needs_user/${String(reason)}`,
    );
  });
});

describe("selectRecorderView: idle reason decisions", () => {
  test.each([
    ["max_duration", "Saving at the limit…", "Saving…", true, false, false],
    [null, null, "Saving…", true, false, false],
    [
      "disk_full",
      "Saving the audio captured before storage ran out…",
      "Saving…",
      true,
      false,
      false,
    ],
    [
      "write_failed",
      "The recording could not be saved.",
      "Interrupted",
      false,
      false,
      true,
    ],
    [
      "permission_revoked",
      "Microphone permission was revoked. Open Settings to allow access.",
      "Microphone off",
      false,
      true,
      true,
    ],
  ] as const)(
    "idle/%s while phase is recording",
    (reason, statusLine, label, busy, openSettings, stop) => {
      expect(recordingView("idle", reason)).toMatchObject({
        ring: "idle",
        flat: false,
        pill: { label, dot: "hollow" },
        statusLine,
        tapRingAction: null,
        controls: {
          pause: false,
          resume: false,
          stop,
          discard: !busy,
          busy,
          openSettings,
        },
        micDenied: openSettings,
      });
    },
  );

  test.each([
    "os_silenced",
    "no_signal",
    "input_muted",
    "call",
    "interruption",
    "route_change",
    "media_services_reset",
    "read_error",
    "stalled",
    "app_suspended",
    "writer_stalled",
    "resume_blocked",
    "resume_not_allowed",
    "mic_unavailable",
    "pause_timeout",
  ] as const)("logs/throws for unsupported idle/%s", (reason) => {
    expect(() => recordingView("idle", reason)).toThrow(
      `Unexpected recorder mic combination: idle/${reason}`,
    );
  });
});

describe("selectRecorderView: live, paused and transient phases", () => {
  test("recording read_error uses the interrupted read-error presentation", () => {
    expect(recordingView("recording", "read_error")).toMatchObject({
      ring: "still",
      flat: false,
      pill: { label: "Interrupted", dot: "hollow" },
      statusLine:
        "The microphone could not be read. Waiting for capture to recover.",
      emphasis: null,
    });
  });

  test("recording write_failed uses the stop-and-save presentation", () => {
    expect(recordingView("recording", "write_failed")).toMatchObject({
      ring: "still",
      statusLine: "Stop and save what's recorded.",
      controls: { resume: false, stop: true },
      emphasis: "stop",
    });
  });

  test("raw Android reasons throw as contract violations in dev", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const reason of [
        "read_failed:9",
        "write_failed: disk unavailable",
      ]) {
        expect(() =>
          recordingView("recording", reason as MicStateReason, {
            isDevelopmentOrTest: true,
          }),
        ).toThrow(`Unexpected recorder mic combination: recording/${reason}`);
      }
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("production logs impossible combinations and returns generic copy", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        recordingView("recording", "call", {
          isDevelopmentOrTest: false,
        }),
      ).toMatchObject({
        ring: "still",
        statusLine: "The microphone state is unexpected. Check the recording.",
        emphasis: null,
      });
      expect(
        recordingView("recording", "read_failed:9" as MicStateReason, {
          isDevelopmentOrTest: false,
        }),
      ).toMatchObject({
        ring: "still",
        statusLine: "The microphone state is unexpected. Check the recording.",
      });
      expect(consoleError).toHaveBeenCalledWith(
        "Unexpected recorder mic combination: recording/call",
        { state: "recording", reason: "call" },
      );
      expect(consoleError).toHaveBeenCalledWith(
        "Unexpected recorder mic combination: recording/read_failed:9",
        { state: "recording", reason: "read_failed:9" },
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("idle/user after user Stop or Discard uses the saving view", () => {
    expect(recordingView("idle", "user")).toMatchObject({
      ring: "idle",
      pill: { label: "Saving…", dot: "hollow" },
      statusLine: null,
      controls: { busy: true, stop: false, discard: false },
    });
  });

  test("recording and writer_stalled remain live; no_signal is flat", () => {
    expect(recordingView("recording", null)).toMatchObject({
      ring: "live",
      flat: false,
      pill: { label: "Listening", dot: "red" },
      statusLine: null,
    });
    expect(recordingView("recording", "writer_stalled")).toMatchObject({
      ring: "live",
      flat: false,
      pill: { label: "Listening", dot: "red" },
      statusLine: null,
    });
    expect(
      recordingView("recording", "no_signal", {
        nowMs: 5_000,
        silencedSinceMs: 0,
        inputName: null,
      }),
    ).toMatchObject({
      ring: "live",
      flat: true,
      statusLine: "No sound from the microphone",
    });
  });

  test.each(["os_silenced", "input_muted"] as const)(
    "silenced/%s stays live, red and flat",
    (reason) => {
      expect(
        recordingView("silenced", reason, {
          nowMs: 5_000,
          silencedSinceMs: 0,
          inputName: "AirPods",
        }),
      ).toMatchObject({
        ring: "live",
        flat: true,
        pill: { label: "Listening", dot: "red" },
        statusLine: "No sound from AirPods",
      });
    },
  );

  test("paused/user is the only breathing treatment and remains resumable", () => {
    expect(recordingView("paused", "user")).toMatchObject({
      ring: "paused",
      flat: false,
      pill: { label: "Resting · tap to continue", dot: "filled-grey" },
      controls: { pause: false, resume: true, stop: true, discard: true },
      tapRingAction: "resume",
    });
  });

  test.each([
    ["starting", "Starting…", true],
    ["stopping", "Saving…", true],
    ["saving", "Saving…", true],
    ["discarding", "Discarding…", true],
  ] as const)("phase %s disables controls", (phase, label, busy) => {
    const view = selectRecorderView({ ...base, phase }, input);
    expect(view).toMatchObject({
      ring: "idle",
      flat: false,
      pill: { label, dot: "hollow" },
      controls: {
        pause: false,
        resume: false,
        stop: false,
        discard: false,
        busy,
        openSettings: false,
      },
    });
  });

  test("mic denial and phase-idle permission revocation open Settings", () => {
    expect(
      selectRecorderView(
        { ...initialRecorderState, permissionDenied: true },
        input,
      ),
    ).toMatchObject({
      ring: "idle",
      pill: { label: "Microphone off", dot: "hollow" },
      statusLine: FINAL_COPY.denied,
      micDenied: true,
      controls: { openSettings: true },
    });
  });

  test("pending pause and resume disable their respective controls", () => {
    expect(
      selectRecorderView({ ...base, controlPending: "pause" }, input).controls
        .pause,
    ).toBe(false);
    expect(
      selectRecorderView(
        {
          ...base,
          mic: { state: "paused", reason: "user" },
          controlPending: "resume",
        },
        input,
      ).controls.resume,
    ).toBe(false);
  });
});

describe("selectRecorderView: elapsed time and limit", () => {
  test("uses elapsedMs and the configured max duration, including the inclusive warning boundary", () => {
    expect(
      selectRecorderView(base, {
        ...input,
        elapsedMs: 2 * 60 * 60 * 1000 + 49 * 60 * 1000 + 59_000,
      }).timer,
    ).toEqual({ text: "2:49:59" });
    expect(
      selectRecorderView(base, {
        ...input,
        elapsedMs: 2 * 60 * 60 * 1000 + 50 * 60 * 1000,
      }).timer,
    ).toEqual({
      text: "2:50:00",
      countdown: {
        text: "Stops at 3:00:00",
        remainingMs: 10 * 60 * 1000,
        remainingText: "10:00",
      },
    });
    expect(
      selectRecorderView(
        { ...base, audioMs: 10_799_000 },
        {
          ...input,
          elapsedMs: 10_000,
        },
      ).timer,
    ).toEqual({ text: "0:10" });
  });

  test("supports a non-default maxDurationMs and clamps remaining time", () => {
    const oneHour = { ...base, maxDurationMs: 60 * 60 * 1000 };
    expect(
      selectRecorderView(oneHour, {
        ...input,
        elapsedMs: 50 * 60 * 1000,
      }).timer,
    ).toEqual({
      text: "50:00",
      countdown: {
        text: "Stops at 1:00:00",
        remainingMs: 10 * 60 * 1000,
        remainingText: "10:00",
      },
    });
    expect(
      selectRecorderView(oneHour, {
        ...input,
        elapsedMs: 61 * 60 * 1000,
      }).timer.countdown,
    ).toEqual({
      text: "Stops at 1:00:00",
      remainingMs: 0,
      remainingText: "0:00",
    });
  });
});
