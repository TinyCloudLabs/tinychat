// A voice note's after-stop Whisper job on this Mac (TC-888's queue): where it stands, and Retry on a failure.
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { TranscriptionStatus } from "../TranscriptionStatus";
import { appPlatform } from "@/lib/platform";
import { getDesktopWhisperQueue, whisperJobNeedsModel, type DesktopWhisperJob } from "@/lib/voiceNotes/desktop/desktopWhisper";
import { useDesktopWhisperJob } from "@/lib/voiceNotes/desktop/useDesktopWhisperJob";
import { ACTION_LABEL, LOCAL_COPY, PHONE_COPY } from "@/lib/voiceNotes/notePipelineCopy";
import { GET_WHISPER_NO_SETTINGS, openCaptureSettings } from "@/capture/recorder/final/desktop/openCaptureSettings";

export const WHISPER_JOB_COPY = {
  queued: "Waiting to transcribe on this Mac…",
  transcribing: (progress: number | null) =>
    progress === null ? "Transcribing on this Mac…" : `Transcribing on this Mac · ${Math.round(progress)}%`,
  failed: "Couldn’t transcribe this note on this Mac. Check Whisper in ⚙︎ Settings, then retry.",
  retryFailed: "Couldn’t start the retry. Try again.",
  checking: "Checking the transcript on this Mac…",
  missing: "Couldn’t read the transcript saved on this Mac.",
  timeout: "Checking the transcript on this Mac took too long.",
  readFailed: "Couldn’t check the transcript on this Mac.",
  recentFailed: "Couldn’t transcribe on this Mac",
} as const;

/** The Recent row's state line for a job that is still going or failed; null once it is done. */
export function whisperJobMeta(job: DesktopWhisperJob): string | null {
  if (whisperJobNeedsModel(job)) return LOCAL_COPY.waitingForModel(null);
  switch (job.state) {
    case "queued": return job.audio === "preparing" ? PHONE_COPY.finishing : "Waiting to transcribe on this Mac";
    case "transcribing": return WHISPER_JOB_COPY.transcribing(job.progress);
    case "failed": return WHISPER_JOB_COPY.recentFailed;
    case "done": return null;
  }
}

export function DesktopWhisperStatusView(props: {
  job: DesktopWhisperJob;
  retryError: boolean;
  onRetry: () => void;
  localRead: "loading" | "missing" | "timeout" | "failed";
  onReadRetry?: () => void;
  durationSecs?: number | null;
  /** Get model for a job that waits for one; ⚙︎ Capture settings by default. */
  onGetModel?: () => void;
}) {
  const { job } = props;
  if (job.state === "done") {
    return props.localRead === "loading"
      ? <p role="status" data-testid="whisper-job-checking" className="text-callout text-muted-foreground">{WHISPER_JOB_COPY.checking}</p>
      : <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="whisper-job-missing">
          <p role="alert" className="text-callout text-destructive">{props.localRead === "timeout" ? WHISPER_JOB_COPY.timeout : props.localRead === "failed" ? WHISPER_JOB_COPY.readFailed : WHISPER_JOB_COPY.missing}</p>
          {props.onReadRetry && <Button type="button" variant="outline" onClick={props.onReadRetry}>Try again</Button>}
        </div>;
  }
  const retry = props.onRetry;
  if (whisperJobNeedsModel(job)) {
    return <TranscriptionStatus testId="whisper-job-needs-model" actionTestId="whisper-job-get-model" durationSecs={props.durationSecs} job={{
      kind: "transcribe", state: "waiting", label: "Transcribe", destination: "this Mac",
      detail: props.retryError ? GET_WHISPER_NO_SETTINGS : LOCAL_COPY.needsModel("mac"),
      action: { label: ACTION_LABEL["get-model"], run: props.onGetModel ?? getWhisperModel } }} />;
  }
  if (job.state === "failed") {
    return <TranscriptionStatus testId="whisper-job-failed" actionTestId="whisper-job-retry" durationSecs={props.durationSecs} job={{
      kind: "transcribe", state: "needs-attention", label: "Transcribe", destination: "this Mac",
      detail: props.retryError ? WHISPER_JOB_COPY.retryFailed : WHISPER_JOB_COPY.failed, action: { label: "Retry", run: retry } }} />;
  }
  return <TranscriptionStatus testId="whisper-job-status" durationSecs={props.durationSecs} job={{
    kind: "transcribe", state: job.state === "queued" ? "waiting" : "running", label: "Transcribe", destination: "this Mac",
    detail: job.state === "queued" ? WHISPER_JOB_COPY.queued : "Transcribing on this Mac…",
    ...(job.state === "transcribing" && job.progress !== null ? { progress: job.progress / 100 } : {}) }} />;
}

/** Get model on the Mac: ⚙︎ Capture settings, where Whisper models are chosen and downloaded. False when it is not mounted. */
export function getWhisperModel(): boolean {
  if (openCaptureSettings()) return true;
  console.error("[desktopWhisper] Capture settings is not mounted, so Get model cannot open it");
  return false;
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

function DesktopWhisperJobStatus(props: { noteId: string; fallback: ReactNode; localRead: "loading" | "missing" | "timeout" | "failed"; onReadRetry?: () => void; rerunOnly?: boolean; durationSecs?: number | null }) {
  const job = useDesktopWhisperJob(props.noteId);
  const [retryError, setRetryError] = useState(false);
  useLogWhisperFailure(props.noteId, job);
  if (props.rerunOnly && (!job?.explicitRerun || job.state === "done")) return null;
  if (!job) return <>{props.fallback}</>;
  const onRetry = () => {
    setRetryError(false);
    retryWhisperJob(props.noteId, () => setRetryError(true));
  };
  const onGetModel = () => setRetryError(!getWhisperModel());
  return <DesktopWhisperStatusView job={job} retryError={retryError} onRetry={onRetry} onGetModel={onGetModel} localRead={props.localRead} onReadRetry={props.onReadRetry} durationSecs={props.durationSecs} />;
}


/** Shows the note's Whisper job when it has one; otherwise `fallback`. Disabled, it is `fallback` and never touches the queue. */
export function DesktopWhisperStatus(props: { noteId: string; fallback: ReactNode; enabled?: boolean; localRead?: "loading" | "missing" | "timeout" | "failed"; onReadRetry?: () => void; rerunOnly?: boolean; durationSecs?: number | null }) {
  const enabled = props.enabled ?? desktopWhisperEnabled();
  if (!enabled) return <>{props.fallback}</>;
  return <DesktopWhisperJobStatus noteId={props.noteId} fallback={props.fallback} localRead={props.localRead ?? "loading"} onReadRetry={props.onReadRetry} rerunOnly={props.rerunOnly} durationSecs={props.durationSecs} />;
}
