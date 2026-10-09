import { HOME_COPY } from "../../home/homeCopy";
import { FINALIZATION_PENDING } from "../recorderCopy";
import type { RecorderState } from "../recorderReducer";

/** `RecorderValue` carries `lastSaved` only; the reducer state also has `recordingId` and `failedRecording`. */
type Source = Pick<RecorderState, "error" | "lastSaved" | "captureIssues"> &
  Partial<Pick<RecorderState, "recordingId" | "failedRecording">>;

/**
 * The recorder's error line. "Exo will finish it automatically" is only true
 * while native is still finishing the recording; once native reports
 * `recoveryFailed` or `write_failed` for it, the line says that instead. Only
 * FINALIZATION_PENDING is replaced, and an issue's `detail` is never read.
 */
export function honestRecorderError(recorder: Source): string | null {
  if (recorder.error !== FINALIZATION_PENDING) return recorder.error;
  const ids = [
    recorder.recordingId,
    recorder.failedRecording?.id,
    recorder.lastSaved?.id,
  ];
  for (const id of ids) {
    const kind = id ? recorder.captureIssues[id]?.kind : undefined;
    if (kind === "recoveryFailed") return HOME_COPY.recoveryFailedError;
    if (kind === "write_failed") return HOME_COPY.writeFailedError;
  }
  return recorder.error;
}
