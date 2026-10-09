import { describe, expect, test } from "bun:test";
import type {
  MicState,
  MicStateReason,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import {
  initialRecorderState,
  type RecorderPhase,
  type RecorderState,
} from "../recorderReducer";
import { FINAL_COPY } from "./finalCopy";
import { selectRecorderView, type RecorderView } from "./recorderView";

const reasons: MicStateReason[] = [
  null,
  "os_silenced",
  "no_signal",
  "input_muted",
  "call",
  "user",
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
  "max_duration",
  "disk_full",
  "write_failed",
  "permission_revoked",
];
const micStates: MicState[] = [
  "idle",
  "recording",
  "silenced",
  "paused",
  "interrupted",
  "needs_user",
];
const phases: RecorderPhase[] = [
  "idle",
  "starting",
  "recording",
  "stopping",
  "saving",
  "discarding",
];
const base: RecorderState = {
  ...initialRecorderState,
  phase: "recording",
  recordingId: "test",
  ready: true,
};
const input = { nowMs: 10_000, elapsedMs: 12_345, shell: "phone" as const };

type ExpectedMic = Pick<
  RecorderView,
  "ring" | "flat" | "statusLine" | "tapRingAction"
> & {
  pill: RecorderView["pill"];
};

// Each reason has a written expected result. Identical outcomes are still listed
// separately so adding a native reason requires a deliberate product decision.
const interruptedExpected: Record<
  Exclude<MicStateReason, null>,
  ExpectedMic
> = {
  os_silenced: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.inputMuted,
    tapRingAction: null,
  },
  no_signal: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.noSignal,
    tapRingAction: null,
  },
  input_muted: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.inputMuted,
    tapRingAction: null,
  },
  call: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.resumesWhenCallEnds,
    tapRingAction: null,
  },
  user: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.interruptedUnknown,
    tapRingAction: null,
  },
  interruption: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.interruptionInProgress,
    tapRingAction: null,
  },
  route_change: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.inputChanged,
    tapRingAction: null,
  },
  media_services_reset: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.audioServicesReset,
    tapRingAction: null,
  },
  read_error: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.microphoneReadFailed,
    tapRingAction: null,
  },
  stalled: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.resumesWhenCallEnds,
    tapRingAction: null,
  },
  app_suspended: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.appSuspended,
    tapRingAction: null,
  },
  writer_stalled: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.audioWriterStalled,
    tapRingAction: null,
  },
  resume_blocked: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.resumeBlockedReason,
    tapRingAction: null,
  },
  resume_not_allowed: {
    ring: "still-resumable",
    flat: false,
    pill: { label: FINAL_COPY.tapToResume, dot: "hollow" },
    statusLine: null,
    tapRingAction: "resume",
  },
  mic_unavailable: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.micUnavailable,
    tapRingAction: null,
  },
  pause_timeout: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.pauseTimedOut,
    tapRingAction: null,
  },
  max_duration: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.durationLimitReached,
    tapRingAction: null,
  },
  disk_full: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.diskFull,
    tapRingAction: null,
  },
  write_failed: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.audioWriteFailed,
    tapRingAction: null,
  },
  permission_revoked: {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.permissionRevoked,
    tapRingAction: null,
  },
};

function expectedMic(state: MicState, reason: MicStateReason): ExpectedMic {
  switch (state) {
    case "idle":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.interruptedUnknown,
        tapRingAction: null,
      };
    case "recording":
      return {
        ring: "live",
        flat: reason === "no_signal",
        pill: { label: FINAL_COPY.listening, dot: "red" },
        statusLine: null,
        tapRingAction: null,
      };
    case "silenced":
      return {
        ring: "live",
        flat: true,
        pill: { label: FINAL_COPY.listening, dot: "red" },
        statusLine: null,
        tapRingAction: null,
      };
    case "paused":
      return {
        ring: "paused",
        flat: false,
        pill: { label: FINAL_COPY.resting, dot: "filled-grey" },
        statusLine: null,
        tapRingAction: "resume",
      };
    case "interrupted":
      if (reason === null) {
        return {
          ring: "still",
          flat: false,
          pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
          statusLine: FINAL_COPY.interruptedUnknown,
          tapRingAction: null,
        };
      }
      return interruptedExpected[reason];
    case "needs_user":
      if (reason === "resume_blocked" || reason === "mic_unavailable")
        return interruptedExpected[reason];
      if (reason === "resume_not_allowed") return interruptedExpected[reason];
      return {
        ring: "still-resumable",
        flat: false,
        pill: { label: FINAL_COPY.tapToResume, dot: "hollow" },
        statusLine: null,
        tapRingAction: "resume",
      };
    default: {
      const exhaustive: never = state;
      throw new Error(
        `Missing expected microphone state: ${String(exhaustive)}`,
      );
    }
  }
}

function expectedPhase(
  phase: RecorderPhase,
  mic: ExpectedMic,
): Pick<
  RecorderView,
  | "ring"
  | "flat"
  | "pill"
  | "statusLine"
  | "tapRingAction"
  | "controls"
  | "micDenied"
> {
  if (phase === "recording") {
    const resume = mic.ring === "paused" || mic.ring === "still-resumable";
    const pause = mic.ring === "live";
    return {
      ...mic,
      controls: {
        pause,
        resume,
        stop: true,
        discard: true,
        busy: false,
        openSettings: false,
      },
      micDenied: false,
      tapRingAction: resume ? "resume" : pause ? "pause" : null,
    };
  }

  if (phase === "idle") {
    return {
      ring: "idle",
      flat: false,
      pill: { label: FINAL_COPY.idle, dot: "hollow" },
      statusLine: null,
      controls: {
        pause: false,
        resume: false,
        stop: false,
        discard: false,
        busy: false,
        openSettings: false,
      },
      micDenied: false,
      tapRingAction: null,
    };
  }

  const label =
    phase === "starting"
      ? FINAL_COPY.starting
      : phase === "discarding"
        ? FINAL_COPY.discarding
        : FINAL_COPY.saving;
  return {
    ring: "idle",
    flat: false,
    pill: { label, dot: "hollow" },
    statusLine: null,
    controls: {
      pause: false,
      resume: false,
      stop: false,
      discard: false,
      busy: true,
      openSettings: false,
    },
    micDenied: false,
    tapRingAction: null,
  };
}

const fullExpectedTable = phases.flatMap((phase) =>
  micStates.flatMap((micState) =>
    reasons.map((reason) => {
      const mic = expectedMic(micState, reason);
      const presentation = expectedPhase(phase, mic);
      return {
        name: `${phase} / ${micState} / ${String(reason)}`,
        phase,
        micState,
        reason,
        expected: {
          ...presentation,
          timer: { text: "0:12" },
        },
      };
    }),
  ),
);

describe("selectRecorderView expected state table", () => {
  test.each(fullExpectedTable)(
    "$name",
    ({ phase, micState, reason, expected }) => {
      const state: RecorderState = {
        ...base,
        phase,
        permissionDenied: false,
        controlPending: null,
        mic: { state: micState, reason },
      };
      expect(selectRecorderView(state, input)).toEqual(expected);
    },
  );

  test("silence line appears exactly five seconds after the supplied start time", () => {
    const state = {
      ...base,
      mic: { state: "silenced" as const, reason: "call" as const },
    };
    expect(
      selectRecorderView(state, { ...input, nowMs: 4_999, silencedSinceMs: 0 })
        .statusLine,
    ).toBeNull();
    expect(
      selectRecorderView(state, {
        ...input,
        nowMs: 5_000,
        silencedSinceMs: 0,
        inputName: "AirPods",
      }).statusLine,
    ).toBe("No sound from AirPods");
    expect(
      selectRecorderView(
        { ...base, mic: { state: "recording", reason: "no_signal" } },
        { ...input, nowMs: 5_000, silencedSinceMs: 0, inputName: "AirPods" },
      ).statusLine,
    ).toBe("No sound from AirPods");
  });

  test("elapsedMs drives timer and countdown at the exact ten-minute warning boundary", () => {
    const beforeBoundary = selectRecorderView(base, {
      ...input,
      elapsedMs: 2 * 60 * 60 * 1000 + 49 * 60 * 1000 + 59_000,
    });
    const atBoundary = selectRecorderView(base, {
      ...input,
      elapsedMs: 2 * 60 * 60 * 1000 + 50 * 60 * 1000,
    });
    expect(beforeBoundary.timer).toEqual({ text: "2:49:59" });
    expect(atBoundary.timer).toEqual({
      text: "2:50:00",
      countdown: { text: "Stops at 3:00:00" },
    });
    expect(
      selectRecorderView(
        { ...base, audioMs: 10_799_000 },
        { ...input, elapsedMs: 10_000 },
      ).timer,
    ).toEqual({ text: "0:10" });
  });

  test("pending pause and resume requests disable the matching controls", () => {
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

  test("mic denial gives the neutral idle view and Open Settings action", () => {
    expect(
      selectRecorderView(
        { ...initialRecorderState, permissionDenied: true },
        input,
      ),
    ).toEqual({
      ring: "idle",
      flat: false,
      pill: { label: FINAL_COPY.microphoneOff, dot: "hollow" },
      statusLine: FINAL_COPY.denied,
      timer: { text: "0:12" },
      controls: {
        pause: false,
        resume: false,
        stop: false,
        discard: false,
        busy: false,
        openSettings: true,
      },
      micDenied: true,
      tapRingAction: null,
    });
  });
});
