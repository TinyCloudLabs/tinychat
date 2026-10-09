import type { RecorderValue } from "../../RecorderProvider";

/**
 * Which recording the notes UI state belongs to; null when none is in progress.
 * TODO(#204): key by `recorder.recordingId` once #204 exposes it. The start time is the best this value has today,
 * and two recordings starting in the same millisecond would share state.
 */
export function recordingKey(
  recorder: Pick<RecorderValue, "startedAt">,
): string | null {
  return recorder.startedAt === null ? null : String(recorder.startedAt);
}
