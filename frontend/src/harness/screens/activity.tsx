import { ActivityPanel } from "@/capture/activity/ActivityPanel";
import type { LibraryItem } from "@/capture/library/LibraryRow";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { HarnessScreen } from "../screen";

const input: NotePipelineInput = {
  device: "phone", route: "on-device", hasNotesOrMoments: false, online: true,
  capture: { finalizing: false, issue: null },
  space: { saved: false, pending: { upload: { state: "uploading", bytes: 1200000, total: 4800000 } }, lane: { busy: true, depth: 2 } },
  transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "running", error: null }, queue: { position: 0, inLine: 0, percent: 40 }, model: null, download: "idle", sync: null } },
  notes: { state: "idle" },
};
const item: LibraryItem = { id: "note-1", source: "exo-voice-note", sourceId: "rec-1", title: "Product review", startedAt: "2026-10-13T11:14:00Z", durationSecs: 130 };
function activityView(platform: "ios" | "tauri" | "web"): NotePipelineView {
  const facts: NotePipelineInput = platform === "web" ? {
    ...input, device: "browser", route: "private-cloud", space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "processing", completed: null, total: null } } },
  } : { ...input, device: platform === "tauri" ? "mac" : "iphone" };
  return { input: facts, pipeline: notePipeline(facts), provider: platform === "web" ? "private" : "local", onAction: () => {}, actionError: null };
}

export const activityScreens: HarnessScreen[] = (["ios", "tauri", "web"] as const).map((platform) => ({
  id: `activity-panel-${platform}`, group: "activity", layout: "pane", platform, readyWhen: '[data-testid="activity-panel"]',
  render: () => <main className="h-full bg-background px-4 py-5"><h1 className="text-headline">Library</h1><ActivityPanel items={[item]} views={new Map([[item.sourceId, activityView(platform)]])} platform={platform} onOpenNote={() => {}} defaultOpen /></main>,
}));
