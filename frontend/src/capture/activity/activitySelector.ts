import type { AppPlatform } from "@/lib/platform";
import type { PipelineStep } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";

export type ActivityKind = "finish" | "transcribe" | "sync" | "upload-audio";
export type ActivityState = "running" | "waiting" | "needs-attention";
export interface ActivityJob {
  kind: ActivityKind;
  state: ActivityState;
  label: string;
  destination: string;
  detail: string;
  progress?: number;
  retry?: () => void;
  diagnostics?: string;
}

export const deviceName = (platform: AppPlatform): string =>
  platform === "tauri" ? "this Mac" : platform === "ios" ? "this iPhone" : platform === "android" ? "this Android phone" : "this browser";
const percent = (value: number) => `${Math.round(value * 100)}%`;
const stateOf = (step: PipelineStep): ActivityState => step.state === "failed" || step.state === "blocked" ? "needs-attention" : step.state === "active" ? "running" : "waiting";
const retryFor = (view: NotePipelineView, step: PipelineStep): (() => void) | undefined => step.blocker?.action?.kind === "retry"
  ? view.onRetryStep ? () => view.onRetryStep?.(step.key) : view.pipeline.current === step.key ? () => view.onAction("retry") : undefined
  : undefined;

/** One projection for Activity, Library and note detail. The shared space lane is never mistaken for a queue position. */
export function activityForNote(view: NotePipelineView | undefined, platform: AppPlatform): ActivityJob[] {
  if (!view?.input) return [];
  const { input } = view;
  const steps = new Map(view.pipeline.steps.map((step) => [step.key, step]));
  const jobs: ActivityJob[] = [];
  const device = deviceName(platform);
  const finish = steps.get("phone");
  if (finish && finish.state !== "done" && finish.state !== "skipped") jobs.push({
    kind: "finish", state: stateOf(finish), label: "Finish", destination: device,
    detail: finish.state === "active" ? "Finishing the recording…" : finish.state === "waiting" ? "Waiting to finish the recording" : `Couldn't finish this recording. Its pieces are kept on ${device}.`,
    diagnostics: input.capture.issue ?? input.capture.readError ?? undefined,
  });
  const transcribe = steps.get("transcript");
  const provider = view.provider ?? (input.route === "on-device" ? "local" : "private");
  const local = provider === "local";
  if (transcribe && input.route !== "off" && transcribe.state !== "done" && transcribe.state !== "skipped") {
    const destination = local ? device : provider === "powerful" ? "Powerful (AssemblyAI)" : "Private transcription";
    const cloud = input.transcript.cloud;
    const phase = cloud?.kind === "active" ? cloud.status.kind : null;
    const od = input.transcript.onDevice;
    const syncOnly = local && (od?.stt?.state === "done" || od?.sync?.state === "syncing" || od?.sync?.state === "failed");
    if (!syncOnly) {
      let detail: string;
      if (transcribe.state === "failed") detail = local ? `Couldn't transcribe on ${device}.` : `${provider === "powerful" ? "Powerful" : "Private"} transcription didn't finish.`;
      else if (transcribe.state === "blocked") detail = transcribe.blocker?.action?.kind === "sign-in" ? "Sign in to use Private transcription" : "Waiting to start";
      else if (transcribe.state === "waiting") {
        if (od?.stt?.state === "waiting_for_model") detail = od.download === "waiting_for_network" ? "Waiting for Wi-Fi to get the speech model" : "Waiting for the speech model";
        else if (od?.stt?.state === "queued") detail = od.queue?.position && od.queue.position > 0 ? `Waiting to transcribe · ${od.queue.position} note${od.queue.position === 1 ? "" : "s"} ahead` : "Waiting to transcribe";
        else if (phase === "waiting") detail = "Waiting for your other Private transcription to finish";
        else detail = "Waiting to start";
      } else if (local) detail = `Transcribing on ${device}${transcribe.progress == null ? "…" : ` · ${percent(transcribe.progress)}`}`;
      else if (phase === "uploading") detail = `Sending to ${destination}${transcribe.progress == null ? "…" : ` · ${percent(transcribe.progress)}`}`;
      else detail = `Transcribing ${provider === "powerful" ? "with Powerful" : "privately"}…`;
      const diagnostics = cloud?.kind === "failed" ? `${cloud.code}: ${cloud.message}${cloud.reference ? ` · ${cloud.reference}` : ""}` : od?.stt?.error ?? undefined;
      jobs.push({ kind: "transcribe", state: stateOf(transcribe), label: "Transcribe", destination, detail,
        progress: transcribe.progress, retry: retryFor(view, transcribe), diagnostics });
    }
  }
  const space = steps.get("space");
  const upload = input.space.pending?.upload;
  if (space && space.state !== "done" && space.state !== "skipped") {
    const state = stateOf(space);
    const reason = input.space.pending?.held === "other-account" ? "Recorded on another account"
      : input.space.pending?.held === "signed-out" ? "Sign in to sync to your TinyCloud space"
      : !input.online ? "Waiting for a connection · syncs by itself"
      : state === "needs-attention" ? "Couldn't sync to your TinyCloud space." : "Waiting to start";
    jobs.push({ kind: "sync", state: upload && state === "running" ? "waiting" : state, label: "Sync", destination: "your TinyCloud space",
      detail: state === "running" && !upload ? "Syncing to your TinyCloud space…" : reason,
      retry: retryFor(view, space), diagnostics: input.space.pending?.failed ? `${input.space.pending.failed.kind}: ${input.space.pending.failed.message}` : undefined });
    if (upload) {
      const progress = upload.total > 0 ? Math.min(1, upload.bytes / upload.total) : undefined;
      jobs.push({ kind: "upload-audio", state: upload.state === "uploading" || upload.state === "preparing" ? "running" : "waiting",
        label: "Upload audio", destination: "your TinyCloud space",
        detail: !input.online ? "Waiting for a connection · syncs by itself" : upload.state === "preparing" ? "Preparing audio upload…"
          : upload.state === "uploading" ? `Uploading audio to your TinyCloud space${progress === undefined ? "…" : ` · ${percent(progress)}`}` : "Waiting to upload audio",
        progress });
    }
  }
  const notes = steps.get("notes");
  if (notes && (notes.state === "active" || notes.state === "failed" || notes.state === "blocked") && !jobs.some((job) => job.kind === "sync")) {
    jobs.push({ kind: "sync", state: stateOf(notes), label: "Sync", destination: "your TinyCloud space",
      detail: notes.state === "active" ? "Syncing to your TinyCloud space…" : "Couldn't sync to your TinyCloud space.", retry: retryFor(view, notes), diagnostics: notes.blocker?.cause });
  }
  const transcriptSync = input.transcript.onDevice?.sync;
  if (transcriptSync && (transcriptSync.state === "syncing" || transcriptSync.state === "failed") && !jobs.some((job) => job.kind === "sync")) {
    jobs.push({ kind: "sync", state: transcriptSync.state === "failed" ? "needs-attention" : "running", label: "Sync", destination: "your TinyCloud space",
      detail: transcriptSync.state === "failed" ? "Couldn't sync to your TinyCloud space." : "Syncing to your TinyCloud space…",
      retry: transcribe ? retryFor(view, transcribe) : undefined });
  }
  return jobs;
}

export function noteStatus(jobs: readonly ActivityJob[]): string | null {
  if (jobs.some((job) => job.state === "needs-attention")) return "Needs attention";
  const running = jobs.filter((job) => job.state === "running");
  if (running.length > 1) return running.map((job) => job.kind === "transcribe" ? "Transcribing" : job.kind === "upload-audio" ? "Uploading audio" : job.label).join(" · ");
  return running[0]?.detail ?? jobs[0]?.detail ?? null;
}
