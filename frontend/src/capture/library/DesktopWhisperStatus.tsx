// A voice note's after-stop Whisper job on this Mac (TC-888's queue): where it stands, and Retry on a failure.
import { useEffect, useState, type ReactNode } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { appPlatform } from "@/lib/platform";
import { getDesktopWhisperQueue, type DesktopWhisperJob } from "@/lib/voiceNotes/desktop/desktopWhisper";
import { useDesktopWhisperJob } from "@/lib/voiceNotes/desktop/useDesktopWhisperJob";

export const WHISPER_JOB_COPY = {
  queued: "Waiting to transcribe on this Mac…",
  transcribing: (progress: number | null) =>
    progress === null ? "Transcribing on this Mac…" : `Transcribing on this Mac · ${Math.round(progress)}%`,
  failed: "Couldn’t transcribe this note on this Mac. Check Whisper in ⚙︎ Settings, then retry.",
  retryFailed: "Couldn’t start the retry. Try again.",
  done: "Transcript saved.",
  recentFailed: "Couldn’t transcribe on this Mac",
} as const;

/** The Recent row's state line for a job that is still going or failed; null once it is done. */
export function whisperJobMeta(job: DesktopWhisperJob): string | null {
  switch (job.state) {
    case "queued": return "Waiting to transcribe on this Mac";
    case "transcribing": return WHISPER_JOB_COPY.transcribing(job.progress);
    case "failed": return WHISPER_JOB_COPY.recentFailed;
    case "done": return null;
  }
}

export function DesktopWhisperStatusView(props: {
  job: DesktopWhisperJob;
  retryError: boolean;
  onRetry: () => void;
}) {
  const { job } = props;
  if (job.state === "done") {
    return <p data-testid="whisper-job-done" className="text-callout text-muted-foreground">{WHISPER_JOB_COPY.done}</p>;
  }
  if (job.state === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="whisper-job-failed">
        <p role="alert" className="min-w-0 flex-1 text-callout text-destructive">
          {props.retryError ? WHISPER_JOB_COPY.retryFailed : WHISPER_JOB_COPY.failed}
        </p>
        <Button type="button" variant="outline" onClick={props.onRetry} data-testid="whisper-job-retry">
          <RefreshCwIcon aria-hidden /> Retry
        </Button>
      </div>
    );
  }
  return (
    <p role="status" data-testid="whisper-job-status" className="flex items-center gap-2 text-callout text-muted-foreground">
      <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
      {job.state === "queued" ? WHISPER_JOB_COPY.queued : WHISPER_JOB_COPY.transcribing(job.progress)}
    </p>
  );
}

/** Logs a failed job's raw error once; the UI shows generic copy only. */
export function useLogWhisperFailure(noteId: string, job: DesktopWhisperJob | null): void {
  const failure = job?.state === "failed" ? job.error : null;
  useEffect(() => {
    if (failure) console.error("[desktopWhisper] Transcription failed", noteId, failure);
  }, [noteId, failure]);
}

/** Retries a failed job through the queue; `onError` runs when it could not be started (the cause is logged). */
export function retryWhisperJob(id: string, onError: () => void): void {
  const queue = getDesktopWhisperQueue();
  if (!queue) {
    console.error("[desktopWhisper] Retry without a Whisper queue", id);
    onError();
    return;
  }
  queue.retry(id).catch((caught: unknown) => {
    console.error("[desktopWhisper] Retry failed", id, caught);
    onError();
  });
}

/** The after-stop Whisper path exists only in the Tauri shell; elsewhere nothing reads the queue. */
export function desktopWhisperEnabled(): boolean {
  return appPlatform() === "tauri";
}

function DesktopWhisperJobStatus(props: { noteId: string; fallback: ReactNode }) {
  const job = useDesktopWhisperJob(props.noteId);
  const [retryError, setRetryError] = useState(false);
  useLogWhisperFailure(props.noteId, job);
  if (!job) return <>{props.fallback}</>;
  const onRetry = () => {
    setRetryError(false);
    retryWhisperJob(props.noteId, () => setRetryError(true));
  };
  return <DesktopWhisperStatusView job={job} retryError={retryError} onRetry={onRetry} />;
}

/** Shows the note's Whisper job when it has one; otherwise `fallback`. Disabled, it is `fallback` and never touches the queue. */
export function DesktopWhisperStatus(props: { noteId: string; fallback: ReactNode; enabled?: boolean }) {
  const enabled = props.enabled ?? desktopWhisperEnabled();
  if (!enabled) return <>{props.fallback}</>;
  return <DesktopWhisperJobStatus noteId={props.noteId} fallback={props.fallback} />;
}
