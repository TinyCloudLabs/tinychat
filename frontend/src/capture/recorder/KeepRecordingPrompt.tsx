// "Keep recording?": five minutes before a desktop recording's limit, ask whether to go on. Keep going adds one hour (and
// asks again five minutes before the new limit); Stop at {time}, closing the prompt, or no answer all leave the limit as
// it is, so a recording never runs past its limit without a yes. It is not shown at the phone layout, under the silent
// safety cap, while paused, or where the engine cannot change a running recording's limit.
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { LIMIT_WARNING_LEAD_MS } from "./limitNotifications";
import { useRecorder } from "./RecorderProvider";
import { useRecorderLayout } from "./useRecorderLayout";
import {
  KEEP_GOING, KEEP_RECORDING_TITLE, clockTime, keepRecordingBody, recordingContinuesUntil, stopAtButton,
} from "./recorderCopy";

/** How long "Recording continues until …" stays up. */
const CONFIRMATION_MS = 6000;

export function KeepRecordingPrompt() {
  const recorder = useRecorder();
  const layout = useRecorderLayout();
  const { phase, autoStop, extendLimit, maxDurationMs, elapsedMs, elapsedAt, mic } = recorder;
  const extend = extendLimit;
  const live = phase === "recording" && autoStop !== false && extend !== undefined && layout !== "phone";
  const [now, setNow] = useState(() => Date.now());
  // The limit the user answered (Stop at, closed) or extended; each new limit is asked about again.
  const [answeredLimit, setAnsweredLimit] = useState<number | null>(null);
  // The limit a Keep going raised: its confirmation shows while the recording's limit is past it.
  const [extendedFrom, setExtendedFrom] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (extendedFrom === null) return;
    const timer = setTimeout(() => setExtendedFrom(null), CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [extendedFrom]);

  // A new recording starts with a clean slate.
  useEffect(() => {
    if (phase !== "recording") {
      setAnsweredLimit(null);
      setExtendedFrom(null);
    }
  }, [phase]);

  if (!live || extend === undefined) return null;
  const recordedMs = elapsedMs + (elapsedAt === null ? 0 : Math.max(0, now - elapsedAt));
  const remainingMs = maxDurationMs - recordedMs;
  const stopAt = clockTime(now + Math.max(0, remainingMs));

  const due = mic.state !== "paused" && remainingMs <= LIMIT_WARNING_LEAD_MS && remainingMs > 0 && answeredLimit !== maxDurationMs;
  // The question outranks the confirmation of the last answer.
  if (!due) {
    if (extendedFrom === null || maxDurationMs <= extendedFrom) return null;
    return (
      <div
        role="status"
        data-testid="keep-recording-confirmation"
        className="fixed bottom-4 right-4 z-[70] max-w-sm rounded-lg border border-border bg-card px-4 py-3 text-sm text-card-foreground shadow-lg"
      >
        {recordingContinuesUntil(stopAt)}
      </div>
    );
  }

  const keepGoing = async () => {
    setPending(true);
    try {
      await extend();
      setExtendedFrom(maxDurationMs);
    } catch (caught) {
      console.warn("[KeepRecordingPrompt] The recording's limit could not be raised", caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-labelledby="keep-recording-title"
      aria-describedby="keep-recording-body"
      data-testid="keep-recording-prompt"
      onKeyDown={(event) => {
        if (event.key === "Escape") setAnsweredLimit(maxDurationMs);
      }}
      className="fixed bottom-4 right-4 z-[70] flex max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg"
    >
      <div className="flex flex-col gap-1">
        <h2 id="keep-recording-title" className="text-base font-semibold">{KEEP_RECORDING_TITLE}</h2>
        <p id="keep-recording-body" className="text-sm text-muted-foreground">{keepRecordingBody(stopAt)}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => setAnsweredLimit(maxDurationMs)}>
          {stopAtButton(stopAt)}
        </Button>
        <Button type="button" disabled={pending} onClick={() => void keepGoing()}>
          {KEEP_GOING}
        </Button>
      </div>
    </div>
  );
}
