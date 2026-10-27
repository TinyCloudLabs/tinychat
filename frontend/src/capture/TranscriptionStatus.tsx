// The one transcription status: a plain sentence, real progress and the one action that works for the state.
// Activity and the note render it from the same job.
import { useRef } from "react";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ActivityJob } from "./activity/activitySelector";
import { secondsLeft, TRANSCRIPTION_STATUS_COPY, transcriptionStatus } from "./transcriptionStatusCopy";

/** Time left, measured from the first progress this component saw for the job. */
function useTimeLeft(progress: number | null, now: number): number | null {
  const first = useRef<{ at: number; progress: number } | null>(null);
  if (progress === null) {
    first.current = null;
    return null;
  }
  if (first.current === null || progress < first.current.progress) first.current = { at: now, progress };
  return secondsLeft(first.current, { at: now, progress });
}

export function TranscriptionStatus(props: { job: ActivityJob; durationSecs?: number | null; testId?: string; actionTestId?: string; now?: number }) {
  const status = transcriptionStatus(props.job, props.durationSecs);
  const left = useTimeLeft(status.state === "running" ? status.progress : null, props.now ?? Date.now());
  const attention = status.state === "needs-attention";
  const details = [status.amount, left === null ? null : TRANSCRIPTION_STATUS_COPY.timeLeft(left)].filter(Boolean).join(" · ");
  return (
    <div role={attention ? "alert" : "status"} data-testid={props.testId ?? "transcription-status"} data-state={status.state}
      className="flex w-full max-w-[68ch] flex-col gap-2 rounded-xl bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className={`flex min-w-0 flex-1 items-center gap-2 text-callout ${attention ? "text-amber-700 dark:text-amber-300" : "text-foreground"}`}>
          {attention ? <AlertCircleIcon className="size-4 shrink-0" aria-hidden />
            : status.state === "running" ? <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> : null}
          <span className="min-w-0 [overflow-wrap:anywhere]">{status.sentence}</span>
        </p>
        {status.action && <Button type="button" variant={attention ? "default" : "outline"} onClick={status.action.run}
          data-testid={props.actionTestId ?? "transcription-status-action"}>{status.action.label}</Button>}
      </div>
      {status.progress !== null && status.state === "running" && (
        <progress className="h-1 w-full accent-primary" max={1} value={status.progress} aria-label={TRANSCRIPTION_STATUS_COPY.progressLabel} />
      )}
      {details && <p className="tnum text-meta text-muted-foreground" data-testid="transcription-status-progress">{details}</p>}
    </div>
  );
}
