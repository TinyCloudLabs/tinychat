import type {
  MicState,
  MicStateReason,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { formatDuration } from "../recorderCopy";
import type { RecorderState } from "../recorderReducer";
import { FINAL_COPY } from "./finalCopy";

export interface RecorderViewInput {
  nowMs: number;
  /** Native elapsed wall time less user-paused time. Never infer this from audioMs. */
  elapsedMs: number;
  inputName: string | null;
  silencedSinceMs: number | null;
}

export interface RecorderView {
  ring: "live" | "paused" | "still" | "still-resumable" | "idle";
  flat: boolean;
  pill: { label: string; dot: "red" | "filled-grey" | "hollow" };
  statusLine: string | null;
  timer: {
    text: string;
    countdown?: { text: string; remainingMs: number; remainingText: string };
  };
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
  flat: boolean;
  busy?: boolean;
  openSettings?: boolean;
  stopEnabled?: boolean;
}

const WARNING_WINDOW_MS = 10 * 60 * 1000;

function unreachable(value: never): never {
  throw new Error(`Unhandled recorder state: ${String(value)}`);
}

function unexpectedCombination(
  state: MicState,
  reason: MicStateReason,
): MicPresentation {
  const message = `Unexpected recorder mic combination: ${state}/${String(reason)}`;
  if (
    import.meta.env.DEV ||
    import.meta.env.MODE === "test" ||
    (typeof process !== "undefined" && process.env.NODE_ENV === "test")
  ) {
    throw new Error(message);
  }

  console.error(message, { state, reason });
  return {
    ring: "still",
    flat: false,
    pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
    statusLine: FINAL_COPY.unexpectedMicState,
  };
}

function silenceLine(input: RecorderViewInput): string | null {
  if (
    input.silencedSinceMs === null ||
    input.nowMs - input.silencedSinceMs < 5000
  ) {
    return null;
  }

  return input.inputName === null
    ? FINAL_COPY.noSoundFromMicrophone
    : FINAL_COPY.noSoundFrom(input.inputName);
}

function interruptedPresentation(reason: MicStateReason): MicPresentation {
  switch (reason) {
    case "call":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.resumesWhenCallEnds,
      };
    case "stalled":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.stalledReconnecting,
      };
    case "interruption":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.callOrSiriPause,
      };
    case "route_change":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.inputChanged,
      };
    case "media_services_reset":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.audioServicesReset,
      };
    case "read_error":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.microphoneReadFailed,
      };
    case "app_suspended":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.appSuspended,
      };
    case null:
    case "os_silenced":
    case "no_signal":
    case "input_muted":
    case "user":
    case "writer_stalled":
    case "resume_blocked":
    case "mic_unavailable":
    case "resume_not_allowed":
    case "pause_timeout":
    case "max_duration":
    case "disk_full":
    case "write_failed":
    case "permission_revoked":
      return unexpectedCombination("interrupted", reason);
    default:
      return unreachable(reason);
  }
}

function retryPresentation(statusLine: string | null): MicPresentation {
  return {
    ring: "still-resumable",
    flat: false,
    pill: { label: FINAL_COPY.tapToTryAgain, dot: "hollow" },
    statusLine,
  };
}

function livePresentation(
  flat: boolean,
  statusLine: string | null,
): MicPresentation {
  return {
    ring: "live",
    flat,
    pill: { label: FINAL_COPY.listening, dot: "red" },
    statusLine,
  };
}

function needsUserPresentation(reason: MicStateReason): MicPresentation {
  switch (reason) {
    case "resume_blocked":
      return retryPresentation(FINAL_COPY.resumeBlockedReason);
    case "mic_unavailable":
      return retryPresentation(FINAL_COPY.micUnavailable);
    case "stalled":
      return {
        ring: "still-resumable",
        flat: false,
        pill: { label: FINAL_COPY.tapToResume, dot: "hollow" },
        statusLine: FINAL_COPY.stalledNeedsUser,
      };
    case "resume_not_allowed":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.resumeNotAllowed,
      };
    case "permission_revoked":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.microphoneOff, dot: "hollow" },
        statusLine: FINAL_COPY.permissionRevoked,
        openSettings: true,
      };
    case "write_failed":
      return {
        ring: "still",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.stopAndSaveRecorded,
        stopEnabled: true,
      };
    case null:
    case "os_silenced":
    case "no_signal":
    case "input_muted":
    case "call":
    case "user":
    case "interruption":
    case "route_change":
    case "media_services_reset":
    case "read_error":
    case "app_suspended":
    case "writer_stalled":
    case "pause_timeout":
    case "max_duration":
    case "disk_full":
      return unexpectedCombination("needs_user", reason);
    default:
      return unreachable(reason);
  }
}

function idlePresentation(reason: MicStateReason): MicPresentation {
  switch (reason) {
    case "max_duration":
      return {
        ring: "idle",
        flat: false,
        pill: { label: FINAL_COPY.saving, dot: "hollow" },
        statusLine: FINAL_COPY.savingAtLimit,
        busy: true,
      };
    case null:
      return {
        ring: "idle",
        flat: false,
        pill: { label: FINAL_COPY.saving, dot: "hollow" },
        statusLine: null,
        busy: true,
      };
    case "disk_full":
      return {
        ring: "idle",
        flat: false,
        pill: { label: FINAL_COPY.saving, dot: "hollow" },
        statusLine: FINAL_COPY.savingAfterDiskFull,
        busy: true,
      };
    case "write_failed":
      return {
        ring: "idle",
        flat: false,
        pill: { label: FINAL_COPY.interrupted, dot: "hollow" },
        statusLine: FINAL_COPY.writeFailed,
      };
    case "permission_revoked":
      return {
        ring: "idle",
        flat: false,
        pill: { label: FINAL_COPY.microphoneOff, dot: "hollow" },
        statusLine: FINAL_COPY.permissionRevoked,
        openSettings: true,
      };
    case "os_silenced":
    case "no_signal":
    case "input_muted":
    case "call":
    case "user":
    case "interruption":
    case "route_change":
    case "media_services_reset":
    case "read_error":
    case "stalled":
    case "app_suspended":
    case "writer_stalled":
    case "resume_blocked":
    case "resume_not_allowed":
    case "mic_unavailable":
    case "pause_timeout":
      return unexpectedCombination("idle", reason);
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
      return idlePresentation(reason);
    case "recording":
      switch (reason) {
        case null:
        case "writer_stalled":
          return livePresentation(false, null);
        case "no_signal":
        case "os_silenced":
        case "input_muted":
          return livePresentation(true, silenceLine(input));
        case "call":
        case "user":
        case "interruption":
        case "route_change":
        case "media_services_reset":
        case "read_error":
        case "stalled":
        case "app_suspended":
        case "resume_blocked":
        case "resume_not_allowed":
        case "mic_unavailable":
        case "pause_timeout":
        case "max_duration":
        case "disk_full":
        case "write_failed":
        case "permission_revoked":
          return unexpectedCombination("recording", reason);
        default:
          return unreachable(reason);
      }
    case "silenced":
      switch (reason) {
        case "os_silenced":
        case "input_muted":
        case "no_signal":
          return livePresentation(true, silenceLine(input));
        case null:
        case "call":
        case "user":
        case "interruption":
        case "route_change":
        case "media_services_reset":
        case "read_error":
        case "stalled":
        case "app_suspended":
        case "writer_stalled":
        case "resume_blocked":
        case "resume_not_allowed":
        case "mic_unavailable":
        case "pause_timeout":
        case "max_duration":
        case "disk_full":
        case "write_failed":
        case "permission_revoked":
          return unexpectedCombination("silenced", reason);
        default:
          return unreachable(reason);
      }
    case "paused":
      if (reason !== "user") return unexpectedCombination("paused", reason);
      return {
        ring: "paused",
        flat: false,
        pill: { label: FINAL_COPY.resting, dot: "filled-grey" },
        statusLine: null,
      };
    case "interrupted":
      return interruptedPresentation(reason);
    case "needs_user":
      return needsUserPresentation(reason);
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
  if (!Number.isFinite(state.maxDurationMs) || state.maxDurationMs <= 0) {
    throw new RangeError("maxDurationMs must be a positive finite number");
  }

  let presentation: MicPresentation = {
    ring: "idle",
    flat: false,
    pill: { label: FINAL_COPY.idle, dot: "hollow" },
    statusLine: null,
  };
  let permissionDenied = false;

  switch (state.phase) {
    case "idle":
      if (state.permissionDenied) {
        permissionDenied = true;
        presentation = {
          ...presentation,
          pill: { label: FINAL_COPY.microphoneOff, dot: "hollow" },
          statusLine: FINAL_COPY.denied,
          openSettings: true,
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
      permissionDenied = presentation.openSettings ?? false;
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

  const busy =
    ["starting", "stopping", "saving", "discarding"].includes(state.phase) ||
    presentation.busy === true;
  const controls = {
    pause: presentation.ring === "live" && !busy && !state.controlPending,
    resume:
      (presentation.ring === "paused" ||
        presentation.ring === "still-resumable") &&
      !busy &&
      !state.controlPending,
    stop:
      (state.phase === "recording" || presentation.stopEnabled === true) &&
      !busy,
    discard: state.phase === "recording" && !busy,
    busy,
    openSettings: presentation.openSettings ?? permissionDenied,
  };
  const remainingMs = Math.max(0, state.maxDurationMs - input.elapsedMs);
  const warningAtMs = Math.max(0, state.maxDurationMs - WARNING_WINDOW_MS);
  const countdown =
    input.elapsedMs >= warningAtMs
      ? {
          text: FINAL_COPY.stopAt(formatDuration(state.maxDurationMs)),
          remainingMs,
          remainingText: formatDuration(remainingMs),
        }
      : undefined;

  return {
    ring: presentation.ring,
    flat: presentation.flat,
    pill: presentation.pill,
    statusLine: presentation.statusLine,
    timer: {
      text: formatDuration(input.elapsedMs),
      ...(countdown ? { countdown } : {}),
    },
    controls,
    micDenied: permissionDenied,
    tapRingAction: controls.resume ? "resume" : controls.pause ? "pause" : null,
  };
}
