import type { RecorderValue } from "../../RecorderProvider";

/** Which recording the notes UI state belongs to; null when none is in progress. */
export function recordingKey(
  recorder: Pick<RecorderValue, "recordingId">,
): string | null {
  return recorder.recordingId;
}
