import type { PluginListenerHandle } from "@capacitor/core";
import type {
  AudioInput, CaptureOptions, CaptureStatus, MicStateEvent, VoiceNoteRecording, VoiceNotesPlugin,
} from "../nativeVoiceNotes";
import { VOICE_NOTE_MAX_DURATION_MS, VOICE_NOTE_MIN_DURATION_LIMIT_MS } from "../nativeVoiceNotes";
import { registerCaptureEngine, type CaptureCapabilities, type CaptureEngine } from "../captureEngine";
import { createFileAudioBlobStore, type CommandBridge } from "./fileAudioBlobStore";
import { failure, memoryLocks, recordingFromSession, RECORDING_LOCK, sessionLock, type RecoveryResult, type SessionRecord,
  type WebStore, openWebStore, type WebStoreOptions } from "../web/webStore";

type EventName = "micState" | "level" | "autoStopped" | "committed" | "recovered" | "recoveryFailed"
  | "writeFailure" | "inputs" | "captureAlert" | "presentRecorder";
type Listener = (event: never) => void;
type NativeStatus = Omit<CaptureStatus, "spans" | "openSpan" | "transitionGen"> & { at: number; elapsedAt: number };
type NativeAutoStop = { id: string; reason: "max_duration"; maxDurationMs: number; at: number; elapsedMs: number; pausedMs: number };
type NativeJournal = { id: string; startedAt: number; recordedMs: number; pausedMs: number; maxDurationMs: number };

export interface DesktopBridge extends CommandBridge {
  listen<T>(event: string, callback: (payload: T) => void): Promise<() => void>;
}

export const DESKTOP_CAPABILITIES: CaptureCapabilities = {
  nativeShortcuts: false,
  presentRecorder: false,
  openSettings: false,
  micDeniedPresentation: false,
  background: true,
  // The shared note queue uses mobile OnDeviceStt (Parakeet). Desktop's
  // Whisper localStt bridge is a separate flow, exposed through D4 extras.
  localTranscription: false,
  offlineRecorder: true,
};

export interface DesktopVoiceNotes {
  plugin: CaptureEngine;
  recoverInterrupted(): Promise<RecoveryResult>;
  dispose(): void;
}

export interface DesktopVoiceNotesOptions {
  bridge: DesktopBridge;
  store?: WebStore;
  storeOptions?: Omit<WebStoreOptions, "audio">;
  now?: () => number;
  newId?: () => string;
}

const copy = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function openDesktopVoiceNotes(options: DesktopVoiceNotesOptions): Promise<DesktopVoiceNotes> {
  const { bridge } = options;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const store = options.store ?? await openWebStore({ locks: memoryLocks(), ...options.storeOptions,
    audio: () => createFileAudioBlobStore(bridge) });
  const listeners = new Map<EventName, Set<Listener>>();
  const retained = new Map<EventName, unknown[]>();
  const urls = new Map<string, string>();
  const unlisten: (() => void)[] = [];
  let live: { session: SessionRecord; release: (() => void)[] } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const result = chain.then(task);
    chain = result.catch(() => undefined);
    return result;
  };
  const emit = (name: EventName, value: unknown) => {
    if (disposed) return;
    const set = listeners.get(name);
    if (!set?.size) {
      if (name !== "level" && name !== "inputs") retained.set(name, [...retained.get(name) ?? [], copy(value)]);
      return;
    }
    for (const listener of set) listener(copy(value) as never);
  };
  const releaseLive = () => {
    if (!live) return;
    for (const release of live.release) release();
    live = null;
  };
  // A native segment is written outside IndexedDB and becomes a file when the mic
  // stops. This heartbeat gives recovery a bounded wall-time estimate if the
  // renderer dies during the first segment, before the session has byte progress.
  const heartbeat = setInterval(() => {
    void run(async () => {
      if (!live) return;
      live.session.lastHeartbeatAt = now();
      await store.updateSession(live.session.id, { lastHeartbeatAt: live.session.lastHeartbeatAt });
    }).catch((error: unknown) => console.error("[desktopVoiceNotes] Could not journal capture heartbeat", error));
  }, 2_000);
  const status = async (): Promise<CaptureStatus> => {
    const native = await bridge.invoke<NativeStatus>("recorder_status");
    const session = live?.session ?? (native.id ? await store.getSession(native.id) : null);
    const defaults = session ? null : await store.getCaptureDefaults();
    return {
      ...native,
      spans: session?.spans ?? [],
      openSpan: session?.spans.find((span) => span.endedAt === null) ?? null,
      source: session?.source,
      options: session?.options,
      owner: session?.owner,
      input: session?.input ?? null,
      transitionGen: session?.transitionGen ?? defaults!.transitionGen,
    };
  };
  const emitMic = (native: NativeStatus) => {
    const session = live?.session;
    emit("micState", {
      state: native.state, reason: native.reason, at: native.at, id: native.id,
      audioMs: native.audioMs, elapsedMs: native.elapsedMs, pausedMs: native.pausedMs,
      options: session?.options, input: session?.input ?? null,
      openSpan: session?.spans.find((span) => span.endedAt === null) ?? null,
    } satisfies MicStateEvent);
  };
  const syncDurable = async (native: NativeStatus): Promise<void> => {
    const current = live;
    if (!current) return;
    const bytes = await store.audio.size(current.session.id);
    const firstAudioAt = bytes > 0 ? current.session.firstAudioAt ?? native.startedAt ?? now() : null;
    const patch: Partial<SessionRecord> = {
      bytes, audioMs: native.audioMs, pausedMs: native.pausedMs, firstAudioAt,
      lastHeartbeatAt: now(),
    };
    await store.updateSession(current.session.id, patch);
    Object.assign(current.session, patch);
  };
  const commit = async (native: NativeStatus, at = now()): Promise<VoiceNoteRecording | null> => {
    const current = live;
    if (!current) return null;
    const id = current.session.id;
    try {
      await syncDurable(native);
      const size = await store.audio.size(id);
      if (size === 0) {
        await store.dropEmptySession(id);
        return null;
      }
      const result = await store.commitSession(id, (session, sizeBytes) => recordingFromSession(session, sizeBytes, {
        endedAt: at, durationMs: native.audioMs, recovered: false, endedUnexpectedly: false, exitReason: null,
      }), { audioMs: native.audioMs, bytes: size, firstAudioAt: current.session.firstAudioAt });
      if (result) emit("committed", { id, recording: result });
      return result;
    } finally {
      releaseLive();
      emitMic({ ...native, id: null, startedAt: null, elapsedMs: 0, audioMs: 0, pausedMs: 0 });
    }
  };
  const handleAutoStop = (event: NativeAutoStop) => {
    void run(async () => {
      if (live?.session.id !== event.id) return;
      try {
        // Native auto-stop already closed the recorder and its file. It emits a terminal
        // event after the file is durable; no second recorder_stop call is needed.
        const native = await bridge.invoke<NativeStatus>("recorder_status");
        const stopped = { ...native, id: event.id, state: "idle" as const, reason: event.reason,
          audioMs: event.elapsedMs, elapsedMs: event.elapsedMs, pausedMs: event.pausedMs };
        const recording = await commit(stopped, event.at);
        emit("autoStopped", { ...event, recording, error: recording ? null : "no_audio_captured" });
      } catch (error) {
        emit("autoStopped", { ...event, recording: null, error: errorText(error) });
        emit("writeFailure", { id: event.id, error: errorText(error) });
      }
    });
  };

  try {
    unlisten.push(await bridge.listen<NativeStatus>("exo://recorder-mic-state", emitMic));
    unlisten.push(await bridge.listen<{ level: number; peak: number }>("exo://recorder-level", (event) => emit("level", event)));
    unlisten.push(await bridge.listen<NativeAutoStop>("exo://recorder-auto-stopped", handleAutoStop));
  } catch (error) {
    clearInterval(heartbeat);
    for (const stop of unlisten) stop();
    if (!options.store) store.close();
    throw error;
  }

  async function recoverInterrupted(): Promise<RecoveryResult> {
    const imported = await bridge.invoke<NativeJournal | null>("recorder_recover");
    if (imported && !await store.getSession(imported.id)) {
      // A crash between the native start and metadata creation can leave a file whose
      // journal still knows its identity. Give it a conservative, unowned session.
      const defaults = await store.getCaptureDefaults();
      await store.beginSession({ id: imported.id, startedAt: imported.startedAt, source: "in_app", owner: null,
        transitionGen: defaults.transitionGen, options: { transcriber: "on-device", identifySpeakers: false },
        mimeType: "audio/mpeg", input: null, maxDurationMs: imported.maxDurationMs });
    }
    if (imported) {
      const session = await store.getSession(imported.id);
      const size = await store.audio.size(imported.id);
      if (session && size > session.bytes) {
        const pausedThrough = session.pauseStartedAt === null ? session.pausedMs
          : session.pausedMs + Math.max(0, session.lastHeartbeatAt - session.pauseStartedAt);
        const heartbeatMs = Math.max(0, session.lastHeartbeatAt - session.startedAt - pausedThrough);
        const estimatedMs = Math.min(imported.maxDurationMs,
          Math.max(session.audioMs, imported.recordedMs, heartbeatMs));
        await store.updateSession(imported.id, { bytes: size, audioMs: estimatedMs,
          firstAudioAt: session.firstAudioAt ?? session.startedAt });
      }
    }
    await store.sweepTombstones();
    const result = await store.recoverInterruptedSessions();
    for (const recording of result.recovered) emit("recovered", { id: recording.id, recording });
    for (const failed of result.failed) emit("recoveryFailed", failed);
    return result;
  }

  const plugin: CaptureEngine = {
    capabilities: DESKTOP_CAPABILITIES,
    async start(startOptions) {
      return run(async () => {
        if (live) throw failure("recording_in_progress");
        const releaseRecording = await store.locks.hold(RECORDING_LOCK);
        if (!releaseRecording) throw failure("already_recording");
        const releases = [releaseRecording];
        let id = "";
        let began = false;
        let nativeStarted = false;
        try {
          const defaults = await store.getCaptureDefaults();
          const signedIn = defaults.status === "signed_in" && !!defaults.accountDid;
          const captureOptions: CaptureOptions = {
            transcriber: signedIn ? startOptions?.transcriber ?? defaults.transcriber : "on-device",
            identifySpeakers: startOptions?.identifySpeakers ?? defaults.identifySpeakers,
          };
          id = newId();
          const releaseSession = await store.locks.hold(sessionLock(id));
          if (!releaseSession) throw failure("session_locked");
          releases.push(releaseSession);
          const maxDurationMs = Math.min(VOICE_NOTE_MAX_DURATION_MS,
            Math.max(VOICE_NOTE_MIN_DURATION_LIMIT_MS, startOptions?.maxDurationMs ?? VOICE_NOTE_MAX_DURATION_MS));
          const inputState = await bridge.invoke<{ inputs: AudioInput[]; selectedId: string | null }>("recorder_list_inputs");
          const input = inputState.inputs.find((candidate) => candidate.id === inputState.selectedId) ?? null;
          const session = await store.beginSession({ id, startedAt: now(), source: "in_app",
            owner: signedIn ? defaults.accountDid : null, transitionGen: defaults.transitionGen,
            options: captureOptions, mimeType: "audio/mpeg", input, maxDurationMs });
          began = true;
          const native = await bridge.invoke<NativeStatus>("recorder_start", { id, maxDurationMs });
          nativeStarted = true;
          session.startedAt = native.startedAt ?? session.startedAt;
          await store.updateSession(id, { startedAt: session.startedAt });
          live = { session, release: releases };
          emitMic(native);
          return { id, startedAt: session.startedAt, maxDurationMs };
        } catch (error) {
          let cleanupError: unknown = null;
          if (nativeStarted) {
            try { await bridge.invoke("recorder_stop"); } catch (caught) { cleanupError = caught; }
          }
          try {
            if (began && cleanupError === null && await store.audio.size(id) === 0) await store.dropEmptySession(id);
          } finally {
            for (const release of releases) release();
          }
          if (cleanupError !== null) throw new AggregateError([error, cleanupError],
            "Could not stop capture after its metadata write failed", { cause: error });
          throw error;
        }
      });
    },
    async stop() {
      return run(async () => {
        if (!live) throw failure("not_recording");
        const native = await bridge.invoke<NativeStatus>("recorder_stop");
        const recording = await commit(native);
        if (!recording) throw failure("no_audio_captured");
        return recording;
      });
    },
    status,
    async pause() {
      return run(async () => {
        if (!live) throw failure("not_recording");
        if (live.session.intent === "paused") return;
        const native = await bridge.invoke<NativeStatus>("recorder_pause");
        await syncDurable(native);
        live.session.intent = "paused";
        live.session.pauseStartedAt = now();
        await store.updateSession(live.session.id, { intent: "paused", pauseStartedAt: live.session.pauseStartedAt });
        emitMic(native);
      });
    },
    async resume() {
      return run(async () => {
        if (!live) throw failure("not_recording");
        if (live.session.intent === "recording") return;
        const native = await bridge.invoke<NativeStatus>("recorder_resume");
        live.session.intent = "recording";
        live.session.pausedMs = native.pausedMs;
        live.session.pauseStartedAt = null;
        await store.updateSession(live.session.id, { intent: "recording", pausedMs: native.pausedMs, pauseStartedAt: null });
        emitMic(native);
      });
    },
    async discard() {
      return run(async () => {
        if (!live) return { id: null };
        const id = live.session.id;
        await bridge.invoke<NativeStatus>("recorder_stop");
        try { await store.discardSession(id); } finally { releaseLive(); }
        const url = urls.get(id);
        if (url) { URL.revokeObjectURL(url); urls.delete(id); }
        emitMic(await bridge.invoke<NativeStatus>("recorder_status"));
        return { id };
      });
    },
    async setRecordingOptions(next) {
      return run(async () => {
        if (!live) throw failure("not_recording");
        const options: CaptureOptions = { ...live.session.options, ...next };
        if (!live.session.owner) options.transcriber = "on-device";
        live.session.options = options;
        await store.updateSession(live.session.id, { options });
        emitMic(await bridge.invoke<NativeStatus>("recorder_status"));
      });
    },
    async setCaptureDefaults(next) {
      const result = await store.setCaptureDefaults(next);
      if (live && result.claimed.includes(live.session.id)) live.session.owner = next.accountDid;
      return result;
    },
    async deleteAudio({ id }) {
      if (live?.session.id === id) throw failure("recording_in_progress");
      await store.deleteAudio({ id });
      const url = urls.get(id);
      if (url) { URL.revokeObjectURL(url); urls.delete(id); }
    },
    async localAudioUrl({ id }) {
      const cached = urls.get(id);
      if (cached) return { url: cached };
      const { bytes, mimeType } = await store.readNoteAudio(id);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
      urls.set(id, url);
      return { url };
    },
    async listInputs() { return bridge.invoke("recorder_list_inputs"); },
    async selectInput({ id }) {
      await run(async () => {
        await bridge.invoke("recorder_select_input", { id });
        const inputs = await bridge.invoke<{ inputs: AudioInput[]; selectedId: string | null; activeId: string | null }>("recorder_list_inputs");
        if (live) {
          live.session.input = inputs.inputs.find((item) => item.id === (inputs.activeId ?? inputs.selectedId)) ?? null;
          await store.updateSession(live.session.id, { input: live.session.input });
        }
        emit("inputs", inputs);
        emitMic(await bridge.invoke<NativeStatus>("recorder_status"));
      });
    },
    async retryRecovery({ id }) {
      if (live?.session.id === id) throw failure("recording_in_progress");
      await store.rearmQuarantined(id);
      await recoverInterrupted();
    },
    async discardFailedRecording({ id }) {
      if (live?.session.id === id) throw failure("recording_in_progress");
      await store.discardFailedRecording({ id });
    },
    async deleteQuarantined({ id }) {
      if (live?.session.id === id) throw failure("recording_in_progress");
      await store.deleteQuarantined({ id });
    },
    async dismissShortcutRecovery() { throw failure("unsupported"); },
    async consumeShortcutRecord() { throw failure("unsupported"); },
    async openSettings() { throw failure("unsupported"); },
    readAudioChunk: (args) => store.readAudioChunk(args),
    listPending: () => store.listPending(),
    getCaptureDefaults: () => store.getCaptureDefaults(),
    setAccountState: (args) => store.setAccountState(args),
    beginRemoteOp: (receipt) => store.beginRemoteOp(receipt),
    recordRemoteResult: (args) => store.recordRemoteResult(args),
    claim: (args) => store.claim(args),
    updateLedger: (args) => store.updateLedger(args),
    putTranscript: (args) => store.putTranscript(args),
    getTranscript: (args) => store.getTranscript(args),
    listQuarantine: () => store.listQuarantine(),
    listOutbox: (args) => store.listOutbox(args),
    completeOutbox: (args) => store.completeOutbox(args),
    addListener: ((event: EventName, listener: Listener): Promise<PluginListenerHandle> => {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(listener);
      if (retained.get(event)?.length) queueMicrotask(() => {
        if (!set?.has(listener)) return;
        for (const payload of retained.get(event) ?? []) listener(copy(payload) as never);
        retained.delete(event);
      });
      return Promise.resolve({ remove: async () => { set?.delete(listener); } });
    }) as VoiceNotesPlugin["addListener"],
  };

  return {
    plugin,
    recoverInterrupted,
    dispose() {
      disposed = true;
      clearInterval(heartbeat);
      for (const stop of unlisten) stop();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      releaseLive();
      listeners.clear();
      retained.clear();
      if (!options.store) store.close();
    },
  };
}

async function tauriBridge(): Promise<DesktopBridge> {
  const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  return {
    invoke<T>(command: string, args?: Record<string, unknown>) { return invoke<T>(command, args); },
    async listen<T>(event: string, callback: (payload: T) => void) {
      return listen<T>(event, (message) => callback(message.payload));
    },
  };
}

/** Registration is the only desktop engine gate. The main entry imports this module once. */
export function registerDesktopVoiceNotes(): void {
  registerCaptureEngine("tauri", async () => {
    const engine = await openDesktopVoiceNotes({ bridge: await tauriBridge() });
    await engine.recoverInterrupted();
    return engine.plugin;
  });
}
