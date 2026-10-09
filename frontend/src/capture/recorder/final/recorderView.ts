import type {
  MicState,
  MicStateReason,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { formatDuration } from "../recorderCopy";
import type { RecorderState } from "../recorderReducer";
import { FINAL_COPY } from "./finalCopy";

export type FinalMicReason = MicStateReason;
export type FinalMicState = MicState;

export interface RecorderViewInput {
  nowMs: number;
  /** Native elapsed wall time less user-paused time. Never infer this from audioMs. */
  elapsedMs: number;
  shell: "phone" | "desktop" | "web";
  inputName?: string;
  silencedSinceMs?: number | null;
}

export interface RecorderView {
  ring: "live" | "paused" | "still" | "still-resumable" | "idle";
  flat: boolean;
  pill: { label: string; dot: "red" | "filled-grey" | "hollow" };
  statusLine: string | null;
  timer: { text: string; countdown?: { text: string } };
  controls: {
    pause: boolean;
    resume: boolean;
    stop: boolean;
    discard: boolean;
    busy: boolean;
    openSettings: boolean;
  };
  micDenied: boolean;
  tapRingAction: "pause" | "resume" | null;
}

interface MicPresentation {
  ring: RecorderView["ring"];
  pill: RecorderView["pill"];
  statusLine: string | null;
  tapRingAction: RecorderView["tapRingAction"];
  flat: boolean;
}

const LIMIT_MS = 3 * 60 * 60 * 1000;
const WARNING_AT_MS = LIMIT_MS - 10 * 60 * 1000;

function unreachable(value: never): never {
  throw new Error(`Unhandled recorder state: ${String(value)}`);
}

function interruptedReasonPresentation(
  reason: MicStateReason,
): MicPresentation {
  switch (reason) {
    case "stalled":
    case "call":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.resumesWhenCallEnds,
        tapRingAction: null,
        flat: false,
      };
    case "resume_not_allowed":
      return {
        ring: "still-resumable",
        pill: { label: FINAL_COPY.tapToResume, dot: "hollow" },
        statusLine: null,
        tapRingAction: "resume",
        flat: false,
      };
    case "resume_blocked":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.resumeBlockedReason,
        tapRingAction: null,
        flat: false,
      };
    case "mic_unavailable":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.micUnavailable,
        tapRingAction: null,
        flat: false,
      };
    case null:
    case "user":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.interruptedUnknown,
        tapRingAction: null,
        flat: false,
      };
    case "os_silenced":
    case "input_muted":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.inputMuted,
        tapRingAction: null,
        flat: false,
      };
    case "no_signal":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.noSignal,
        tapRingAction: null,
        flat: false,
      };
    case "interruption":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.interruptionInProgress,
        tapRingAction: null,
        flat: false,
      };
    case "route_change":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.inputChanged,
        tapRingAction: null,
        flat: false,
      };
    case "media_services_reset":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.audioServicesReset,
        tapRingAction: null,
        flat: false,
      };
    case "read_error":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.microphoneReadFailed,
        tapRingAction: null,
        flat: false,
      };
    case "app_suspended":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.appSuspended,
        tapRingAction: null,
        flat: false,
      };
    case "writer_stalled":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.audioWriterStalled,
        tapRingAction: null,
        flat: false,
      };
    case "pause_timeout":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.pauseTimedOut,
        tapRingAction: null,
        flat: false,
      };
    case "max_duration":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.durationLimitReached,
        tapRingAction: null,
        flat: false,
      };
    case "disk_full":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.diskFull,
        tapRingAction: null,
        flat: false,
      };
    case "write_failed":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.audioWriteFailed,
        tapRingAction: null,
        flat: false,
      };
    case "permission_revoked":
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.permissionRevoked,
        tapRingAction: null,
        flat: false,
      };
    default:
      return unreachable(reason);
  }
}

function micPresentation(
  micState: MicState,
  reason: MicStateReason,
  input: RecorderViewInput,
): MicPresentation {
  switch (micState) {
    case "idle":
      // MIC_STATE may report native idle before its terminal event moves the reducer phase.
      return {
        ring: "still",
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.interruptedUnknown,
        tapRingAction: null,
        flat: false,
      };
    case "recording":
      if (reason === "no_signal") {
        const showLine =
          input.silencedSinceMs != null &&
          input.nowMs - input.silencedSinceMs >= 5000;
        return {
          ring: "live",
          pill: { label: FINAL_COPY.listening, dot: "red" },
          statusLine: showLine
            ? FINAL_COPY.noSoundFrom(input.inputName ?? "microphone")
            : null,
          tapRingAction: null,
          flat: true,
        };
      }
      return {
        ring: "live",
        pill: { label: FINAL_COPY.listening, dot: "red" },
        statusLine: null,
        tapRingAction: null,
        flat: false,
      };
    case "silenced": {
      const showLine =
        input.silencedSinceMs != null &&
        input.nowMs - input.silencedSinceMs >= 5000;
      return {
        ring: "live",
        pill: { label: FINAL_COPY.listening, dot: "red" },
        statusLine: showLine
          ? FINAL_COPY.noSoundFrom(input.inputName ?? "microphone")
          : null,
        tapRingAction: null,
        flat: true,
      };
    }
    case "paused":
      return {
        ring: "paused",
        pill: { label: FINAL_COPY.resting, dot: "filled-grey" },
        statusLine: null,
        tapRingAction: "resume",
        flat: false,
      };
    case "interrupted":
      return interruptedReasonPresentation(reason);
    case "needs_user":
      if (reason === "resume_blocked" || reason === "mic_unavailable") {
        return interruptedReasonPresentation(reason);
      }
      if (reason === "resume_not_allowed") {
        return interruptedReasonPresentation(reason);
      }
      return {
        ring: "still-resumable",
        pill: { label: FINAL_COPY.tapToResume, dot: "hollow" },
        statusLine: null,
        tapRingAction: "resume",
        flat: false,
      };
    default:
      return unreachable(micState);
  }
}

export function selectRecorderView(
  state: RecorderState,
  input: RecorderViewInput,
): RecorderView {
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) {
    throw new RangeError("elapsedMs must be a non-negative finite number");
  }

  const busy = ["starting", "stopping", "saving", "discarding"].includes(
    state.phase,
  );
  const denied = state.phase === "idle" && state.permissionDenied;
  let presentation: MicPresentation = {
    ring: "idle",
    flat: false,
    pill: { label: FINAL_COPY.idle, dot: "hollow" },
    statusLine: null,
    tapRingAction: null,
  };

  switch (state.phase) {
    case "idle":
      if (denied) {
        presentation = {
          ...presentation,
          pill: { label: FINAL_COPY.microphoneOff, dot: "hollow" },
          statusLine: FINAL_COPY.denied,
        };
      }
      break;
    case "starting":
      presentation = {
        ...presentation,
        pill: { label: FINAL_COPY.starting, dot: "hollow" },
      };
      break;
    case "recording":
      presentation = micPresentation(state.mic.state, state.mic.reason, input);
      break;
    case "stopping":
    case "saving":
      presentation = {
        ...presentation,
        pill: { label: FINAL_COPY.saving, dot: "hollow" },
      };
      break;
    case "discarding":
      presentation = {
        ...presentation,
        pill: { label: FINAL_COPY.discarding, dot: "hollow" },
      };
      break;
    default:
      return unreachable(state.phase);
  }

  const controls = {
    pause: presentation.ring === "live" && !busy && !state.controlPending,
    resume:
      (presentation.ring === "paused" ||
        presentation.ring === "still-resumable") &&
      !busy &&
      !state.controlPending,
    stop: state.phase === "recording" && !busy,
    discard: state.phase === "recording" && !busy,
    busy,
    openSettings: denied,
  };
  const countdown =
    input.elapsedMs >= WARNING_AT_MS
      ? { text: FINAL_COPY.stopAt(formatDuration(LIMIT_MS)) }
      : undefined;

  return {
    ...presentation,
    timer: {
      text: formatDuration(input.elapsedMs),
      ...(countdown ? { countdown } : {}),
    },
    controls,
    micDenied: denied,
    tapRingAction: controls.resume ? "resume" : controls.pause ? "pause" : null,
  };
}
