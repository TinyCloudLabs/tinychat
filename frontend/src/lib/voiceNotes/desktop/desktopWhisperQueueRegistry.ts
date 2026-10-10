import type { VoiceNoteRecording } from "../nativeVoiceNotes";

// The queue type and its one slot, apart from the engine: the eager app reads the slot; the engine chunk fills it.
export type DesktopWhisperJob = { id: string; state: "queued" | "transcribing" | "done" | "failed";
  error: string | null; progress: number | null };

/** D7b can subscribe to per-note status and call retry(id) after a failure. */
export interface DesktopWhisperQueue {
  snapshot(): ReadonlyMap<string, DesktopWhisperJob>;
  subscribe(listener: () => void): () => void;
  onDone(listener: (id: string) => void): () => void;
  resume(): Promise<void>;
  noteCommitted(recording: VoiceNoteRecording): Promise<void>;
  retry(id: string): Promise<void>;
  modelAvailable(): Promise<void>;
  beforeCapture(): Promise<void>;
  captureEnded(): void;
  dispose(): void;
}

let registered: DesktopWhisperQueue | null = null;
let queueReads = 0;
export function getDesktopWhisperQueue(): DesktopWhisperQueue | null { queueReads += 1; return registered; }
/** How many times the queue has been looked up; tests prove the classic paths never do. */
export const __desktopWhisperQueueReadsForTests = () => queueReads;
export function registerDesktopWhisperQueue(queue: DesktopWhisperQueue | null): void { registered = queue; }
