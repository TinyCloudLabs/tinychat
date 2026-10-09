import { HOME_COPY } from "../../home/homeCopy";
import { FINALIZATION_PENDING } from "../recorderCopy";
import type { RecorderState } from "../recorderReducer";

type Source = Pick<RecorderState, "error" | "captureIssues" | "finalizationPendingId">;

/**
 * The recorder's error line. "Exo will finish it automatically" is only true
 * while native is still finishing the recording whose stop timed out
 * (`finalizationPendingId`); once native reports `recoveryFailed` or
 * `write_failed` for that recording, the line says that instead. Only
 * FINALIZATION_PENDING is replaced, and an issue's `detail` is never read.
 */
export function honestRecorderError(recorder: Source): string | null {
  if (recorder.error !== FINALIZATION_PENDING) return recorder.error;
  const id = recorder.finalizationPendingId;
  const kind = id ? recorder.captureIssues[id]?.kind : undefined;
  if (kind === "recoveryFailed") return HOME_COPY.recoveryFailedError;
  if (kind === "write_failed") return HOME_COPY.writeFailedError;
  return recorder.error;
}

/**
 * The informational line under a receipt: the recording that just saved is
 * missing some audio. It is not an error, and the receipt never carries it
 * beside "Exo will finish it automatically" (that promise outranks it, as on
 * the "on this phone" card).
 */
export function receiptPartialNotice(recorder: Source, id: string | undefined): string | null {
  if (id === undefined || recorder.captureIssues[id]?.kind !== "partial_audio") return null;
  return honestRecorderError(recorder) === FINALIZATION_PENDING ? null : HOME_COPY.partialAudioMeta;
}
