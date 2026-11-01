// What the transcription status says, in one place. Activity and the note render the same job through it.
import type { ActivityJob } from "./activity/activitySelector";

export const TRANSCRIPTION_STATUS_COPY = {
  needsAttention: "Needs attention",
  /** The sentence for a stalled or failed job when the job itself has none. */
  failed: "Couldn’t transcribe this note.",
  minutes: (done: number, total: number) => `${done} of ${total} min`,
  percent: (value: number) => `${value}%`,
  timeLeft: (seconds: number) => seconds < 60 ? "less than a minute left" : `about ${Math.round(seconds / 60)} min left`,
  progressLabel: "Transcription progress",
  audioNotOnDevice: "The audio for this note isn’t on this device.",
} as const;

export interface TranscriptionStatusModel {
  state: ActivityJob["state"];
  /** The plain sentence: what is happening now. */
  sentence: string;
  /** 0..1 while the job reports progress. */
  progress: number | null;
  /** "12 of 56 min" while the job transcribes a recording of known length; "40%" for other phases. */
  amount: string | null;
  action: { label: string; run: () => void } | null;
}

/** The job's own words without the trailing percentage the progress line carries instead. */
function sentenceOf(job: ActivityJob): string {
  return job.detail.replace(/\s·\s\d+%$/, "").trim() || TRANSCRIPTION_STATUS_COPY.failed;
}

export function transcriptionStatus(job: ActivityJob, durationSecs: number | null | undefined): TranscriptionStatusModel {
  const progress = job.progress === undefined ? null : Math.min(1, Math.max(0, job.progress));
  const transcribing = job.state === "running" && /^Transcribing/.test(job.detail);
  const minutes = durationSecs != null && durationSecs > 0 ? Math.max(1, Math.round(durationSecs / 60)) : null;
  const amount = progress === null || job.state !== "running" ? null
    : transcribing && minutes !== null ? TRANSCRIPTION_STATUS_COPY.minutes(Math.min(minutes, Math.floor(progress * durationSecs! / 60)), minutes)
    : TRANSCRIPTION_STATUS_COPY.percent(Math.round(progress * 100));
  const action = job.action ?? (job.retry ? { label: "Try again", run: job.retry } : null);
  return { state: job.state, sentence: sentenceOf(job), progress, amount, action };
}

/** Seconds left, from the first and the latest progress samples; null until the rate is measurable. */
export function secondsLeft(first: { at: number; progress: number }, latest: { at: number; progress: number }): number | null {
  const elapsed = (latest.at - first.at) / 1000;
  const gained = latest.progress - first.progress;
  if (elapsed < 15 || gained < 0.02 || latest.progress >= 1) return null;
  return Math.round(elapsed * (1 - latest.progress) / gained);
}
