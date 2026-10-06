// A stand-in for the native VoiceNotes plugin (TC-761), for the browser
// harnesses: installed with __setVoiceNotesForTests, it lets the real recorder
// views run on the web. It counts listeners (added, and active now) so the
// shell invariants can prove there is only ever one recorder listening, and it
// can emit `level` and `micState` like the shells do.
import type {
  MicState,
  MicStateEvent,
  VoiceNoteAutoStopEvent,
  VoiceNoteRecording,
  VoiceNotesPlugin,
} from "@/lib/voiceNotes/nativeVoiceNotes";

type Listener = (event: never) => void;

export interface FakeVoiceNotes {
  plugin: VoiceNotesPlugin;
  /** Listeners added since creation, and listeners not yet removed. */
  stats(): { adds: number; active: number; recording: boolean };
  emit(event: "level", payload: { level: number }): void;
  emit(event: "micState", payload: MicStateEvent): void;
  emit(event: "autoStopped", payload: VoiceNoteAutoStopEvent): void;
}

export function createFakeVoiceNotes(): FakeVoiceNotes {
  const listeners = new Map<string, Set<Listener>>();
  let adds = 0;
  let active = 0;
  let current: { id: string; startedAt: number } | null = null;
  let state: MicState = "idle";
  let counter = 0;

  const plugin: VoiceNotesPlugin = {
    async start(options) {
      if (current) throw Object.assign(new Error("Already recording"), { code: "already_recording" });
      counter += 1;
      current = { id: `fake-${counter}`, startedAt: Date.now() };
      state = "recording";
      return { ...current, maxDurationMs: options?.maxDurationMs };
    },
    async stop() {
      if (!current) throw Object.assign(new Error("Not recording"), { code: "not_recording" });
      const recording: VoiceNoteRecording = {
        id: current.id,
        startedAt: current.startedAt,
        durationMs: Date.now() - current.startedAt,
        mimeType: "audio/mp4",
        sizeBytes: 4,
        silencedMs: 0,
        silencedEvents: 0,
        noSignalMs: 0,
      };
      current = null;
      state = "idle";
      return recording;
    },
    async status() {
      return {
        state,
        reason: null,
        id: current?.id ?? null,
        elapsedMs: current ? Date.now() - current.startedAt : 0,
      };
    },
    async readAudioChunk({ id, offset, length }) {
      const size = 4;
      const bytesRead = Math.max(0, Math.min(length, size - offset));
      return { id, offset, base64: btoa("\u0000".repeat(bytesRead)), bytesRead, size, eof: offset + bytesRead >= size };
    },
    async deleteAudio() {},
    async listPending() {
      return { recordings: [] };
    },
    addListener(event: string, listener: Listener) {
      adds += 1;
      active += 1;
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      let removed = false;
      return Promise.resolve({
        remove: async () => {
          if (removed) return;
          removed = true;
          active -= 1;
          set.delete(listener);
        },
      });
    },
  } as VoiceNotesPlugin;

  return {
    plugin,
    stats: () => ({ adds, active, recording: current !== null }),
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) (listener as (value: unknown) => void)(payload);
    },
  };
}
