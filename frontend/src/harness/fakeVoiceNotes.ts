// A stand-in for the native VoiceNotes plugin (TC-761), for the browser
// harnesses: installed with __setVoiceNotesForTests, it lets the real recorder
// views run on the web. It counts listeners (added, and active now) so the
// shell invariants can prove there is only ever one recorder listening, it
// can emit `level` and `micState` like the shells do, and it lists the
// recordings deleted from the "phone".
import type {
  CaptureDefaults,
  CaptureOptions,
  CaptureStatus,
  MicState,
  MicStateEvent,
  VoiceNoteAutoStopEvent,
  VoiceNoteRecording,
  RecoveryFailedEvent,
  WriteFailureEvent,
  VoiceNotesPlugin,
} from "@/lib/voiceNotes/nativeVoiceNotes";

type Listener = (event: never) => void;

export interface FakeVoiceNotes {
  plugin: VoiceNotesPlugin;
  /** Listeners added since creation, listeners not yet removed, and the ids deleteAudio was given. */
  stats(): { adds: number; active: number; recording: boolean; deleted: string[] };
  emit(event: "level", payload: { level: number }): void;
  emit(event: "micState", payload: MicStateEvent): void;
  emit(event: "recoveryFailed", payload: RecoveryFailedEvent): void;
  emit(event: "writeFailure", payload: WriteFailureEvent): void;
  emit(event: "recovered" | "committed", payload: { id: string }): void;
  emit(event: "autoStopped", payload: VoiceNoteAutoStopEvent): void;
  /** Capacitor hands a retained presentRecorder event to the first listener only. */
  retainPresentRecorder(payload: { id: string | null; reason?: string }): void;
}

export function createFakeVoiceNotes(): FakeVoiceNotes {
  const listeners = new Map<string, Set<Listener>>();
  let retainedPresent: { id: string | null; reason?: string } | null = null;
  let adds = 0;
  let active = 0;
  let current: { id: string; startedAt: number; options: CaptureOptions } | null = null;
  let state: MicState = "idle";
  let counter = 0;
  let maxDurationMs = 10_800_000;
  let defaults: CaptureDefaults = { accountDid: null, transitionGen: 0, transcriber: "on-device", identifySpeakers: false };
  const deleted: string[] = [];
  const unsupported = async (): Promise<never> => {
    throw Object.assign(new Error("This action is not implemented in the browser harness"), { code: "not_implemented_in_harness" });
  };

  const plugin: VoiceNotesPlugin = {
    openSettings: unsupported,
    dismissShortcutRecovery: unsupported,
    consumeShortcutRecord: unsupported,
    async start(options?: Parameters<VoiceNotesPlugin["start"]>[0]) {
      if (current) throw Object.assign(new Error("Already recording"), { code: "already_recording" });
      counter += 1;
      current = { id: `fake-${counter}`, startedAt: Date.now(), options: {
        transcriber: defaults.accountDid ? (options?.transcriber ?? defaults.transcriber) : "on-device",
        identifySpeakers: options?.identifySpeakers ?? defaults.identifySpeakers,
      } };
      maxDurationMs = options?.maxDurationMs ?? 10_800_000;
      state = "recording";
      return { ...current, maxDurationMs };
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
        version: 2,
        owner: defaults.accountDid,
        rev: 1,
        options: current.options,
      };
      current = null;
      state = "idle";
      return recording;
    },
    async status(): Promise<CaptureStatus> {
      const elapsedMs = current ? Date.now() - current.startedAt : 0;
      return {
        state,
        reason: null,
        id: current?.id ?? null,
        intent: current ? "recording" : "stopped",
        availability: "available",
        startedAt: current?.startedAt ?? null,
        elapsedMs,
        audioMs: elapsedMs,
        pausedMs: 0,
        maxDurationMs,
        spans: [],
        openSpan: null,
        options: current?.options,
        transitionGen: defaults.transitionGen,
      };
    },
    async readAudioChunk({ id, offset, length }: Parameters<VoiceNotesPlugin["readAudioChunk"]>[0]) {
      const size = 4;
      const bytesRead = Math.max(0, Math.min(length, size - offset));
      return { id, offset, base64: btoa("\u0000".repeat(bytesRead)), bytesRead, size, eof: offset + bytesRead >= size };
    },
    async deleteAudio({ id }: Parameters<VoiceNotesPlugin["deleteAudio"]>[0]) {
      deleted.push(id);
    },
    async listPending() {
      return { recordings: [] };
    },
    pause: unsupported,
    resume: unsupported,
    async discard() {
      const id = current?.id ?? null;
      if (id) {
        current = null;
        state = "idle";
        deleted.push(id);
      }
      return { id };
    },
    async setRecordingOptions(changed) {
      if (!current) throw Object.assign(new Error("Not recording"), { code: "not_recording" });
      current.options = { ...current.options, ...changed,
        transcriber: defaults.accountDid ? (changed.transcriber ?? current.options.transcriber) : "on-device" };
    },
    async getCaptureDefaults() { return { ...defaults, status: defaults.accountDid ? "signed_in" as const : "signed_out" as const }; },
    async setCaptureDefaults(next) {
      if (next.transitionGen < defaults.transitionGen) throw Object.assign(new Error("Stale transition"), { code: "stale_transition" });
      defaults = { ...next };
      return { claimed: [] };
    },
    setAccountState: unsupported,
    beginRemoteOp: unsupported,
    recordRemoteResult: unsupported,
    claim: unsupported,
    updateLedger: unsupported,
    localAudioUrl: unsupported,
    putTranscript: unsupported,
    getTranscript: unsupported,
    listInputs: unsupported,
    selectInput: unsupported,
    listQuarantine: unsupported,
    deleteQuarantined: unsupported,
    listOutbox: unsupported,
    completeOutbox: unsupported,
    addListener(event: string, listener: Listener) {
      adds += 1;
      active += 1;
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      if (event === "presentRecorder" && retainedPresent) {
        const retained = retainedPresent;
        retainedPresent = null;
        (listener as (value: typeof retained) => void)(retained);
      }
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
  };

  return {
    plugin,
    stats: () => ({ adds, active, recording: current !== null, deleted: [...deleted] }),
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) (listener as (value: unknown) => void)(payload);
    },
    retainPresentRecorder(payload) { retainedPresent = payload; },
  };
}
