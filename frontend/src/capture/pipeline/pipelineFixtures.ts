// Pipelines built through the selector, for the component tests.
import { notePipeline, type NotePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";

export function pipelineOf(patch: Partial<NotePipelineInput> = {}): NotePipeline {
  return notePipeline({
    device: "phone",
    route: "private-cloud",
    hasNotesOrMoments: true,
    online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: false, pending: {} },
    transcript: { inSpace: null, onDevice: null, cloud: null },
    notes: { state: "idle" },
    ...patch,
  });
}

export const uploading = (bytes: number, total = 100) =>
  pipelineOf({ space: { saved: false, pending: { upload: { state: "uploading", bytes, total } } } });
export const signedOut = () => pipelineOf({ space: { saved: false, pending: { held: "signed-out" } } });
export const privateRunning = (completed: number, total: number) =>
  pipelineOf({ space: { saved: true, pending: null }, transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "processing", completed, total } } } });
export const allDone = () =>
  pipelineOf({ space: { saved: true, pending: null }, transcript: { inSpace: "transcribed", onDevice: null, cloud: null }, notes: { state: "synced" } });
