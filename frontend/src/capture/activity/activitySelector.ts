import { deviceName, type AppPlatform } from "@/lib/platform";
export { deviceName } from "@/lib/platform";
import type { NotePipeline, PipelineStep } from "@/lib/voiceNotes/notePipeline";
import { pipelineTranscriptStatus } from "../pipeline/PipelineTrackSummary";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { UploadState } from "@/lib/audioUpload";
import type { PausedUpload } from "@/capture/upload/pausedUpload";
import { STORAGE_FULL_SAVE_MESSAGE, isStorageFullError, storageSaveMessage } from "@/lib/storageStatus";
import { LOCAL_COPY } from "@/lib/voiceNotes/notePipelineCopy";

export type ActivityKind = "finish" | "transcribe" | "sync" | "upload-audio";
export type ActivityState = "running" | "retrying" | "waiting" | "needs-attention";
export interface ActivityJob {
  kind: ActivityKind;
  state: ActivityState;
  label: string;
  destination: string;
  detail: string;
  progress?: number;
  retry?: () => void;
  action?: { label: string; run: () => void };
  diagnostics?: string;
  /** Failure code for classification by notifications; never persist this raw provider value. */
  failureCode?: string;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const stateOf = (step: PipelineStep): ActivityState => step.state === "failed" ? "needs-attention" : step.state === "active" ? "running" : "waiting";
const retryFor = (view: NotePipelineView, step: PipelineStep): (() => void) | undefined => step.blocker?.action?.kind === "retry"
  ? view.onRetryStep ? () => view.onRetryStep?.(step.key) : view.pipeline.current === step.key ? () => view.onAction("retry") : undefined
  : undefined;
const actionFor = (view: NotePipelineView, step: PipelineStep): ActivityJob["action"] => {
  const action = step.blocker?.action;
  if (!action) return undefined;
  const run = action.kind === "retry" ? retryFor(view, step) : () => view.onAction(action.kind);
  return run ? { label: action.label, run } : undefined;
};
const retryCaption = (retryAt: number, now: number): string => `Your TinyCloud space is slow to answer · trying again in ${Math.max(1, Math.ceil((retryAt - now) / 1000))} s`;

/** Details copy. A storage-full failure shows the approved copy, never the raw quota code or message. */
function failureDetails(failure: { kind: string; message: string }): string {
  if (failure.kind === "quota" || isStorageFullError(failure.message)) return storageSaveMessage(failure.message) ?? STORAGE_FULL_SAVE_MESSAGE;
  return `${failure.kind}: ${failure.message}`;
}

/** One projection for Activity, Library and note detail. The shared space lane is never mistaken for a queue position. */
export function activityForNote(view: NotePipelineView | undefined, platform: AppPlatform, now = Date.now()): ActivityJob[] {
  if (!view) return [];
  // A receipt may have its pipeline before the native input read has settled. Its known step captions and actions
  // still come through this selector; it must never flash an unrelated saved route in that gap.
  if (!view.input) return view.pipeline.steps.filter((step) => step.state !== "done" && step.state !== "skipped" && step.state !== "upcoming")
    .map((step): ActivityJob => ({ kind: step.key === "phone" ? "finish" : step.key === "transcript" ? "transcribe" : "sync",
      state: stateOf(step), label: step.key === "phone" ? "Finish" : step.key === "transcript" ? "Transcribe" : "Sync",
      destination: step.key === "phone" ? deviceName(platform) : "your TinyCloud space",
      detail: step.blocker?.cause ?? step.caption ?? "Waiting to start", progress: step.progress, retry: retryFor(view, step), action: actionFor(view, step), failureCode: step.state === "failed" ? "failed" : undefined }));
  const { input } = view;
  const steps = new Map(view.pipeline.steps.map((step) => [step.key, step]));
  const jobs: ActivityJob[] = [];
  const device = deviceName(platform);
  const finish = steps.get("phone");
  if (finish && finish.state !== "done" && finish.state !== "skipped") jobs.push({
    kind: "finish", state: stateOf(finish), label: "Finish", destination: device,
    detail: finish.state === "failed" ? `Couldn't finish this recording. Its pieces are kept on ${device}.`
      : finish.blocker?.cause ?? (finish.state === "active" ? "Finishing the recording…" : "Waiting to finish the recording"),
    action: actionFor(view, finish), retry: retryFor(view, finish),
    diagnostics: input.capture.issue ?? input.capture.readError ?? undefined,
    failureCode: input.capture.issue ?? (input.capture.readError ? "read-error" : undefined),
  });
  const transcribe = steps.get("transcript");
  const provider = view.provider ?? (input.route === "on-device" ? "local" : "unknown");
  const local = provider === "local";
  if (transcribe && input.route !== "off" && transcribe.state !== "done" && transcribe.state !== "skipped") {
    const destination = local ? device : provider === "powerful" ? "Powerful (AssemblyAI)" : provider === "private" ? "Private transcription" : "transcription service";
    const cloud = input.transcript.cloud;
    const phase = cloud?.kind === "active" ? cloud.status.kind : null;
    const od = input.transcript.onDevice;
    const syncOnly = local && (od?.stt?.state === "done" || od?.sync?.state === "syncing" || od?.sync?.state === "failed" || od?.sync?.state === "held");
    if (!syncOnly) {
      let detail: string;
      if (transcribe.state === "failed") detail = transcribe.blocker?.cause ?? (local ? `Couldn't transcribe on ${device}.` : `${provider === "powerful" ? "Powerful" : provider === "private" ? "Private" : "Cloud"} transcription didn't finish.`);
      else if (transcribe.state === "blocked") detail = transcribe.blocker?.cause ?? "Waiting to start";
      else if (transcribe.state === "waiting") {
        if (od?.stt?.state === "waiting_for_model") detail = od.download === "waiting_for_network" ? "Waiting for Wi-Fi to get the speech model" : "Waiting for the speech model";
        else if (od?.stt?.state === "queued") { const ahead = od.queue?.position == null ? null : Math.max(0, od.queue.position - 1); detail = ahead === null ? "Waiting to transcribe" : ahead === 0 ? "Next to transcribe" : `Waiting to transcribe · ${ahead} note${ahead === 1 ? "" : "s"} ahead`; }
        else if (phase === "waiting") detail = provider === "powerful" ? "Waiting for Powerful to start" : provider === "private" ? "Waiting for your other Private transcription to finish" : "Waiting for transcription to start";
        else if (phase === "queued") detail = provider === "powerful" ? "Queued with Powerful" : provider === "private" ? "Queued for Private transcription" : "Queued for transcription";
        else detail = transcribe.caption ?? "Waiting to start";
      } else if (local) detail = `Transcribing on ${device}${transcribe.progress == null ? "…" : ` · ${percent(transcribe.progress)}`}`;
      else if (phase === "uploading") detail = `Sending to ${destination}${transcribe.progress == null ? "…" : ` · ${percent(transcribe.progress)}`}`;
      else if (phase === "preparing") detail = `Preparing for ${destination}…`;
      else if (phase === "saving") detail = "Saving the transcript to your TinyCloud space…";
      else detail = provider === "powerful" ? "Transcribing with Powerful…" : provider === "private" ? "Transcribing privately…" : "Transcribing…";
      const diagnostics = cloud?.kind === "failed" ? `${storageSaveMessage(cloud) ?? `${cloud.code}: ${cloud.message}`}${cloud.reference ? ` · ${cloud.reference}` : ""}` : od?.stt?.error ?? undefined;
      jobs.push({ kind: "transcribe", state: stateOf(transcribe), label: "Transcribe", destination, detail,
        progress: transcribe.progress, retry: retryFor(view, transcribe), action: actionFor(view, transcribe), diagnostics,
        failureCode: cloud?.kind === "failed" ? cloud.code : od?.stt?.state === "failed" ? "on-device-stt" : undefined });
    }
  }
  const space = steps.get("space");
  const upload = input.space.pending?.upload;
  if (space && space.state !== "done" && space.state !== "skipped") {
    const state = stateOf(space);
    const retryAt = input.space.pending?.retryAt;
    const reason = space.blocker?.cause ?? (retryAt && retryAt > now ? retryCaption(retryAt, now)
      : !input.online ? "Waiting for a connection · syncs by itself"
      : space.caption ?? "Waiting to start");
    jobs.push({ kind: "sync", state: retryAt && retryAt > now ? "retrying" : upload && state === "running" ? "waiting" : state, label: "Sync", destination: "your TinyCloud space",
      detail: state === "running" && !upload ? "Syncing to your TinyCloud space…" : reason,
      retry: retryFor(view, space), action: retryAt && retryAt > now ? { label: "Try now", run: () => view.onRetryStep ? view.onRetryStep("space") : view.onAction("retry") } : actionFor(view, space),
      diagnostics: input.space.pending?.failed ? failureDetails(input.space.pending.failed) : undefined,
      failureCode: input.space.pending?.failed?.kind });
    if (upload && input.audioUploadIntent !== false) {
      const progress = upload.total > 0 ? Math.min(1, upload.bytes / upload.total) : undefined;
      const uploadFailure = input.space.pending?.failed && input.space.pending.failed.kind !== "offline" ? input.space.pending.failed : null;
      jobs.push({ kind: "upload-audio", state: uploadFailure ? "needs-attention" : upload.state === "retrying" ? "retrying" : upload.state === "uploading" || upload.state === "preparing" ? "running" : "waiting",
        label: "Upload audio", destination: "your TinyCloud space",
        detail: uploadFailure ? `Couldn't upload the audio. It's safe on ${device}.` : !input.online ? "Waiting for a connection · syncs by itself" : upload.state === "preparing" ? "Preparing audio upload…"
          : upload.state === "uploading" ? `Uploading audio to your TinyCloud space${progress === undefined ? "…" : ` · ${percent(progress)}`}` : upload.state === "retrying" ? "Retrying audio upload…" : "Waiting to upload audio",
        progress, retry: uploadFailure ? retryFor(view, space) : undefined, action: uploadFailure ? actionFor(view, space) : undefined,
        diagnostics: uploadFailure ? failureDetails(uploadFailure) : undefined, failureCode: uploadFailure?.kind });
    }
  }
  const notes = steps.get("notes");
  if (notes && (notes.state === "active" || notes.state === "failed" || notes.state === "blocked") && !jobs.some((job) => job.kind === "sync")) {
    jobs.push({ kind: "sync", state: stateOf(notes), label: "Sync", destination: "your TinyCloud space",
      detail: notes.blocker?.cause ?? "Syncing to your TinyCloud space…", retry: retryFor(view, notes), action: actionFor(view, notes), diagnostics: input.notes.state === "unreadable" ? input.notes.cause : undefined,
      failureCode: notes.state === "failed" ? input.notes.state : undefined });
  }
  const transcriptSync = input.transcript.onDevice?.sync;
  const existingSync = jobs.findIndex((job) => job.kind === "sync");
  if (transcriptSync?.state === "unrecorded" && existingSync >= 0) jobs[existingSync] = { ...jobs[existingSync]!, state: "needs-attention", detail: "The transcript is in your space, but this device couldn't record that.", diagnostics: transcriptSync.message, failureCode: "transcript-unrecorded", action: view.pipeline.blocker?.action ? { label: view.pipeline.blocker.action.label, run: () => view.onAction(view.pipeline.blocker!.action!.kind) } : undefined };
  if (transcriptSync && (transcriptSync.state === "syncing" || transcriptSync.state === "failed" || transcriptSync.state === "unrecorded" || transcriptSync.state === "held") && !jobs.some((job) => job.kind === "sync")) {
    jobs.push({ kind: "sync", state: transcriptSync.state === "syncing" ? "running" : "needs-attention", label: "Sync", destination: "your TinyCloud space",
      detail: transcriptSync.state === "unrecorded" ? "The transcript is in your space, but this device couldn't record that." : transcriptSync.state === "held" ? LOCAL_COPY.transcriptStorageFull : transcriptSync.state === "failed" ? "Couldn't sync to your TinyCloud space." : "Syncing to your TinyCloud space…",
      retry: transcribe ? retryFor(view, transcribe) : undefined, action: transcriptSync.state === "unrecorded" && view.pipeline.blocker?.action ? { label: view.pipeline.blocker.action.label, run: () => view.onAction(view.pipeline.blocker!.action!.kind) } : transcribe ? actionFor(view, transcribe) : undefined,
      diagnostics: transcriptSync.state === "unrecorded" || transcriptSync.state === "failed" ? transcriptSync.message : undefined,
      failureCode: transcriptSync.state === "unrecorded" ? "transcript-unrecorded" : transcriptSync.state === "failed" ? "transcript-sync-failed" : undefined });
  }
  return jobs;
}

/** File imports use the upload runner, which is separate from voice-note stores. */
export function activityForFileUpload(upload: UploadState | null, paused: PausedUpload | null, actions: { open: () => void; continue: () => void; retry: () => void }): { title: string; jobs: ActivityJob[] } | null {
  if (!upload && !paused) return null;
  const title = upload?.fileName ?? paused!.fileName;
  if (!upload) return { title, jobs: [{ kind: "upload-audio", state: "waiting", label: "Upload audio", destination: "your TinyCloud space", detail: "Upload paused · Continue", action: { label: "Continue", run: actions.continue } }] };
  if (upload.stage === "saved" && upload.audio.stage === "stored") return null;
  const destination = upload.engine === "assemblyai" ? "Powerful (AssemblyAI)" : "Private transcription";
  const failed = upload.stage === "failed";
  const transcribing = upload.stage === "queued" || upload.stage === "transcribing";
  const kind: ActivityKind = transcribing ? "transcribe" : upload.stage === "saving" ? "sync" : "upload-audio";
  const detail = failed ? "Couldn't finish this file upload." : upload.stage === "elsewhere" ? "Running in another browser tab" : upload.stage === "queued" ? `Queued with ${upload.engine === "assemblyai" ? "Powerful" : "Private transcription"}` : upload.stage === "transcribing" ? `Transcribing with ${upload.engine === "assemblyai" ? "Powerful" : "Private transcription"}…` : upload.stage === "saving" ? "Saving to your TinyCloud space…" : upload.stage === "preparing" ? "Preparing file upload…" : upload.stage === "saved" ? "Audio couldn't be stored in your TinyCloud space." : "Uploading file audio…";
  return { title, jobs: [{ kind, state: failed || upload.stage === "saved" ? "needs-attention" : upload.stage === "elsewhere" || upload.stage === "queued" ? "waiting" : "running", label: kind === "transcribe" ? "Transcribe" : kind === "sync" ? "Sync" : "Upload audio", destination: kind === "sync" || upload.stage === "saved" ? "your TinyCloud space" : destination, detail, progress: upload.stage === "uploading" && upload.uploadPct != null ? upload.uploadPct / 100 : undefined, diagnostics: upload.error ? `${upload.error.message}${upload.error.reference ? ` · ${upload.error.reference}` : ""}` : undefined, action: failed && upload.error?.retry ? { label: "Retry", run: actions.retry } : { label: "Open upload", run: actions.open } }] };
}

export function noteStatus(jobs: readonly ActivityJob[], pipeline?: NotePipeline, includeTranscriptFailureReason = true): string | null {
  const transcriptStatus = pipeline ? pipelineTranscriptStatus(pipeline, includeTranscriptFailureReason) : null;
  const failed = jobs.find((job) => job.state === "needs-attention");
  if (failed) return [ `Needs attention · ${failed.detail}`, transcriptStatus ].filter(Boolean).join(" · ");
  const running = jobs.filter((job) => job.state === "running");
  const status = running.length > 1
    ? running.map((job) => job.kind === "transcribe" ? "Transcribing" : job.kind === "upload-audio" ? "Uploading audio" : job.label).join(" · ")
    : running[0]?.detail ?? jobs.find((job) => job.state === "retrying")?.detail ?? jobs[0]?.detail ?? null;
  return [status, transcriptStatus].filter(Boolean).join(" · ") || null;
}
