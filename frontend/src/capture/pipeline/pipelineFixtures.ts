// Pipelines built through the selector, for the component tests.
import { notePipeline, type NotePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";

const IDLE_LANE = { busy: false, depth: 0 };
const SAVED = { saved: true, pending: null, lane: IDLE_LANE } as const;
const UNSAVED = (pending: NotePipelineInput["space"]["pending"]) => ({ saved: false, pending, lane: IDLE_LANE });

export function pipelineOf(patch: Partial<NotePipelineInput> = {}): NotePipeline {
  return notePipeline({
    device: "phone",
    route: "private-cloud",
    hasNotesOrMoments: true,
    online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: false, pending: {}, lane: IDLE_LANE },
    transcript: { inSpace: null, onDevice: null, cloud: null },
    notes: { state: "idle" },
    ...patch,
  });
}

export const uploading = (bytes: number, total = 100) =>
  pipelineOf({ space: UNSAVED({ upload: { state: "uploading", bytes, total } }) });
export const signedOut = () => pipelineOf({ space: UNSAVED({ held: "signed-out" }) });
export const privateRunning = (completed: number, total: number) =>
  pipelineOf({ space: SAVED, transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "processing", completed, total } } } });
export const allDone = () =>
  pipelineOf({ space: SAVED, transcript: { inSpace: "transcribed", onDevice: null, cloud: null }, notes: { state: "synced" } });
