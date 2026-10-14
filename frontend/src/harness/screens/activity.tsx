import { ActivityPanel } from "@/capture/activity/ActivityPanel";
import type { LibraryItem } from "@/capture/library/LibraryRow";
import type { UploadState } from "@/lib/audioUpload";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import { PageHeader } from "@/shell/PageHeader";
import type { HarnessScreen } from "../screen";

const base: NotePipelineInput = {
  device: "iphone", route: "on-device", hasNotesOrMoments: false, online: true,
  capture: { finalizing: false, issue: null },
  space: { saved: false, pending: { upload: { state: "uploading", bytes: 1_200_000, total: 4_800_000 } }, lane: { busy: true, depth: 2 } },
  transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "running", error: null }, queue: { position: 1, inLine: 2, percent: 40 }, model: null, download: "idle", sync: null } },
  notes: { state: "idle" },
};
const item: LibraryItem = { id: "note-1", source: "exo-voice-note", sourceId: "rec-1", title: "Product review", startedAt: "2026-10-13T11:14:00Z", durationSecs: 130 };
const saved = { saved: true, pending: null, lane: { busy: false, depth: 0 } } as const;
const local = (state: "queued" | "running" | "failed") => ({ inSpace: null, cloud: null, onDevice: { stt: { state, error: state === "failed" ? "decoder_error" : null }, queue: { position: state === "queued" ? 2 : 1, inLine: 2, percent: state === "running" ? 40 : null }, model: null, download: "idle" as const, sync: null } });
function view(patch: Partial<NotePipelineInput>, platform: "ios" | "tauri" | "web"): NotePipelineView {
  const input: NotePipelineInput = { ...base, device: platform === "tauri" ? "mac" : platform === "web" ? "browser" : "iphone", ...patch };
  return { input, pipeline: notePipeline(input), provider: input.route === "on-device" ? "local" : input.transcriptProvider ?? "private", onAction: () => {}, actionError: null };
}
const panel = (patch: Partial<NotePipelineInput>, platform: "ios" | "tauri" | "web") =>
  <main className="h-full bg-background px-4 py-5"><h1 className="text-headline">Library</h1><ActivityPanel items={[item]} views={new Map([[item.sourceId, view(patch, platform)]])} platform={platform} onOpenNote={() => {}} defaultOpen /></main>;

type Matrix = { id: string; patch: Partial<NotePipelineInput> };
const matrix: Matrix[] = [
  { id: "finish-running", patch: { capture: { finalizing: true, issue: null } } },
  { id: "finish-waiting", patch: { capture: { finalizing: false, issue: "finalization_timed_out" } } },
  { id: "finish-failed", patch: { capture: { finalizing: false, issue: "write_failed" } } },
  { id: "transcribe-running", patch: { space: saved, transcript: local("running") } },
  { id: "transcribe-waiting", patch: { space: saved, transcript: local("queued") } },
  { id: "transcribe-failed", patch: { space: saved, transcript: local("failed") } },
  { id: "sync-running", patch: { route: "off", space: saved, hasNotesOrMoments: true, notes: { state: "syncing" } } },
  { id: "sync-waiting", patch: { route: "off", online: false, space: { saved: false, pending: {}, lane: { busy: false, depth: 0 } } } },
  { id: "sync-failed", patch: { route: "off", space: { saved: false, pending: { failed: { kind: "timeout", message: "diagnostic" } }, lane: { busy: false, depth: 0 } } } },
  { id: "sync-retrying", patch: { route: "off", space: { saved: false, pending: { retryAt: Date.now() + 30_000 }, lane: { busy: false, depth: 0 } } } },
  { id: "upload-audio-running", patch: {} },
  { id: "upload-audio-waiting", patch: { route: "off", space: { saved: false, pending: { upload: { state: "waiting", bytes: 0, total: 100 } }, lane: { busy: false, depth: 0 } } } },
  { id: "upload-audio-failed", patch: { route: "off", space: { saved: false, pending: { upload: { state: "waiting", bytes: 0, total: 100 }, failed: { kind: "server", message: "diagnostic" } }, lane: { busy: false, depth: 0 } } } },
  { id: "upload-audio-retrying", patch: { route: "off", space: { saved: false, pending: { upload: { state: "retrying", bytes: 20, total: 100 } }, lane: { busy: false, depth: 0 } } } },
  { id: "local-sync-unrecorded", patch: { space: saved, transcript: { inSpace: "transcribed", cloud: null, onDevice: { stt: { state: "done", error: null }, queue: null, model: null, download: "idle", sync: { state: "unrecorded", message: "diagnostic" } } } } },
  { id: "device-signed-out", patch: { space: { saved: false, pending: { held: "signed-out" }, lane: { busy: false, depth: 0 } } } },
  { id: "private-queued", patch: { route: "private-cloud", transcriptProvider: "private", space: saved, transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "queued", position: 2 } } } } },
  { id: "powerful-running", patch: { route: "private-cloud", transcriptProvider: "powerful", space: saved, transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "processing", completed: 2, total: 5 } } } } },
];

const uploadBase: UploadState = { engine: "assemblyai", fileName: "Interview.m4a", stage: "uploading", uploadPct: 42, detail: null, audio: { stage: "storing", pct: 25 }, error: null, savedTitle: null, cleanupPending: false };
const importScreens: HarnessScreen[] = ([
  { id: "file-import-running", upload: uploadBase, paused: null },
  { id: "file-import-waiting", upload: { ...uploadBase, stage: "queued" as const }, paused: null },
  { id: "file-import-failed", upload: { ...uploadBase, stage: "failed" as const, error: { message: "diagnostic", reference: "ref-3", retry: true } }, paused: null },
  { id: "file-import-paused", upload: null, paused: { fileName: "Interview.m4a" } },
] as const).map(({ id, upload, paused }) => ({ id: "activity-" + id, group: "activity", layout: "pane", platform: "web", readyWhen: '[data-testid="activity-panel"]', viewports: ["phone", "zoom200", "text200-phone"],
  render: () => <main className="h-full bg-background px-4 py-5"><h1 className="text-headline">Library</h1><ActivityPanel items={[]} views={new Map()} platform="web" onOpenNote={() => {}} upload={upload} paused={paused} onOpenUpload={() => {}} onContinueUpload={() => {}} onRetryUpload={() => {}} defaultOpen /></main>,
}));

export const activityScreens: HarnessScreen[] = [
  ...(["ios", "tauri", "web"] as const).map((platform) => ({ id: "activity-panel-" + platform, group: "activity", layout: "pane" as const, platform, readyWhen: '[data-testid="activity-panel"]', render: () => panel(platform === "web" ? { route: "private-cloud", transcriptProvider: "private", space: saved, transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "processing", completed: null, total: null } } } } : {}, platform) })),
  ...matrix.map(({ id, patch }) => ({ id: "activity-" + id, group: "activity", layout: "pane" as const, platform: id === "device-signed-out" ? "ios" as const : "tauri" as const, readyWhen: '[data-testid="activity-panel"]', viewports: ["phone", "zoom200", "text200-phone"], render: () => panel(patch, id === "device-signed-out" ? "ios" : "tauri") })),
  ...importScreens,
  { id: "activity-header-200", group: "activity", layout: "pane", platform: "ios", readyWhen: '[data-testid="activity-button"]', viewports: ["phone", "text200-phone"], render: () => <main className="h-full bg-background"><PageHeader title="Library" back={() => {}} trailing={<div className="flex flex-wrap items-center gap-1"><ActivityPanel items={[item]} views={new Map([[item.sourceId, view({}, "ios")]])} platform="ios" onOpenNote={() => {}} /><button type="button" className="min-h-11 px-2">Refresh</button></div>} /><p className="px-4">A voice note</p></main> },
];
