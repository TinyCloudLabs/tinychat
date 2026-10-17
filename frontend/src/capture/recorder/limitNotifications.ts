// System notifications around a recording's automatic stop (TC-1352): one five minutes before the limit and one when
// the limit stopped it, sent only while Exo is in the background and the user allows notifications (Mac and web; the
// phones' local notifications are TC-1371). A manual Stop sends nothing.
import { useEffect, useRef } from "react";

import { showSystemNotification } from "@/capture/activity/systemNotification";
import { formatLimit } from "./recorderCopy";
import type { RecorderState } from "./recorderReducer";

/** How long before an automatic stop Exo warns. */
export const LIMIT_WARNING_LEAD_MS = 5 * 60_000;
/** A checkpoint can land just after the warning was due; past this, "in 5 minutes" would no longer be true. */
const LATE_WARNING_MS = 60_000;
const NOTIFICATION_TITLE = "Exo";
/** The stop replaces its warning in the notification centre. */
const NOTIFICATION_TAG = "exo-recording-limit";

export const LIMIT_WARNING_TEXT = "Exo will stop recording in 5 minutes.";

export function limitStoppedText(limitMs: number): string {
  return `Exo stopped recording at the ${formatLimit(limitMs)} limit. Your recording is saved.`;
}

export function useLimitNotifications(
  state: Pick<RecorderState, "phase" | "mic" | "recordingId" | "maxDurationMs" | "elapsedMs" | "elapsedAt" | "limitStopMs">,
  openRecorder: () => void,
): void {
  const { recordingId, maxDurationMs, elapsedMs, elapsedAt, limitStopMs } = state;
  // Pause freezes recorded time, so the warning waits; an interruption still counts (recordedElapsedAt).
  const running = state.phase === "recording" && state.mic.state !== "paused";
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (!running || recordingId === null || warned.current === recordingId || maxDurationMs <= LIMIT_WARNING_LEAD_MS) return;
    const recorded = elapsedMs + (elapsedAt === null ? 0 : Math.max(0, Date.now() - elapsedAt));
    const untilWarning = maxDurationMs - LIMIT_WARNING_LEAD_MS - recorded;
    if (untilWarning < -LATE_WARNING_MS) return;
    const timer = setTimeout(() => {
      warned.current = recordingId;
      showSystemNotification(NOTIFICATION_TITLE, { body: LIMIT_WARNING_TEXT, tag: NOTIFICATION_TAG }, openRecorder);
    }, Math.max(0, untilWarning));
    return () => clearTimeout(timer);
  }, [running, recordingId, maxDurationMs, elapsedMs, elapsedAt, openRecorder]);

  const stoppedAt = useRef(limitStopMs);
  useEffect(() => {
    const before = stoppedAt.current;
    stoppedAt.current = limitStopMs;
    if (before !== null || limitStopMs === null) return;
    showSystemNotification(NOTIFICATION_TITLE, { body: limitStoppedText(limitStopMs), tag: NOTIFICATION_TAG });
  }, [limitStopMs]);
}
