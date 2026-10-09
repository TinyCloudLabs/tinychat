import type { PluginListenerHandle } from "@capacitor/core";
import type {
  AudioInput, CaptureOptions, CaptureStatus, MicStateEvent, MissingAudioSpan, VoiceNoteRecording, VoiceNotesPlugin,
} from "../nativeVoiceNotes";
import { VOICE_NOTE_MAX_DURATION_MS, VOICE_NOTE_MIN_DURATION_LIMIT_MS } from "../nativeVoiceNotes";
import { registerCaptureEngine, type CaptureCapabilities, type CaptureEngine } from "../captureEngine";
import { registerDesktopCaptureExtras } from "../desktopCaptureExtras";
import { createFileAudioBlobStore, type CommandBridge } from "./fileAudioBlobStore";
import { failure, memoryLocks, recordingFromSession, RECORDING_LOCK, sessionLock, type RecoveryResult, type SessionRecord,
  type WebStore, openWebStore, type WebStoreOptions } from "../web/webStore";

type EventName = "micState" | "level" | "autoStopped" | "committed" | "recovered" | "recoveryFailed"
  | "writeFailure" | "inputs" | "captureAlert" | "presentRecorder";
type Listener = (event: never) => void;
type NativeStatus = Omit<CaptureStatus, "spans" | "openSpan" | "transitionGen"> & {
  at: number; elapsedAt: number; spans?: MissingAudioSpan[] };
type NativeAutoStop = { id: string; reason: "max_duration"; maxDurationMs: number; at: number; elapsedMs: number; pausedMs: number;
  spans?: MissingAudioSpan[] };
type NativeJournal = { id: string; startedAt: number; recordedMs: number; pausedMs: number; maxDurationMs: number;
  spans?: MissingAudioSpan[] };
type NativeFailed = { id: string; segmentId: string; reason: string; error: string; journal: NativeJournal };
type NativeRecoveryReport = { journal: NativeJournal | null; quarantined: NativeFailed[] };

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
const mergeSpans = (existing: MissingAudioSpan[], native: MissingAudioSpan[] = []): MissingAudioSpan[] => {
  const merged = [...existing];
  for (const span of native) if (!merged.some((item) => item.kind === span.kind && item.reason === span.reason
    && item.startedAt === span.startedAt && item.endedAt === span.endedAt)) merged.push(span);
  return merged.sort((a, b) => a.startedAt - b.startedAt);
};

export async function openDesktopVoiceNotes(options: DesktopVoiceNotesOptions): Promise<DesktopVoiceNotes> {
  const { bridge } = options;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const store = options.store ?? await openWebStore({ locks: memoryLocks(), ...options.storeOptions,
    audio: () => createFileAudioBlobStore(bridge) });
  // Native capture survives a WebView reload. Read it before recovery or event
  // subscription so the reopened renderer can adopt and stop the live session.
  let initialNative = await bridge.invoke<NativeStatus>("recorder_status");
  if (initialNative.id && await store.hasTombstone(initialNative.id)) {
    // A previous renderer died after tombstoning Discard. Finish its native
    // stop before sweeping the file, so the recorder cannot recreate it.
    const id = initialNative.id;
    await bridge.invoke("recorder_stop");
    await store.sweepTombstones();
    await bridge.invoke("recorder_acknowledge", { id });
    initialNative = await bridge.invoke<NativeStatus>("recorder_status");
  }
  const listeners = new Map<EventName, Set<Listener>>();
  const retained = new Map<EventName, unknown[]>();
  const urls = new Map<string, string>();
  const unlisten: (() => void)[] = [];
  let live: { session: SessionRecord; release: (() => void)[] } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const adopt = async (native: NativeStatus) => {
    if (!native.id || live) return;
    const releaseRecording = await store.locks.hold(RECORDING_LOCK);
    if (!releaseRecording) throw failure("already_recording");
    const releaseSession = await store.locks.hold(sessionLock(native.id));
    if (!releaseSession) { releaseRecording(); throw failure("session_locked"); }
    try {
      let session = await store.getSession(native.id);
      if (!session) {
        const defaults = await store.getCaptureDefaults();
        session = await store.beginSession({ id: native.id, startedAt: native.startedAt ?? now(), source: "in_app",
          owner: null, transitionGen: defaults.transitionGen,
          options: { transcriber: "on-device", identifySpeakers: false }, mimeType: "audio/mpeg",
          input: null, maxDurationMs: native.maxDurationMs });
      }
      const spans = mergeSpans(session.spans, native.spans);
      if (spans.length !== session.spans.length) {
        await store.updateSession(session.id, { spans });
        session.spans = spans;
      }
      live = { session, release: [releaseSession, releaseRecording] };
    } catch (error) { releaseSession(); releaseRecording(); throw error; }
  };
  await adopt(initialNative);

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
      lastHeartbeatAt: now(), spans: mergeSpans(current.session.spans, native.spans),
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
        await bridge.invoke("recorder_acknowledge", { id });
        return null;
      }
      const result = await store.commitSession(id, (session, sizeBytes) => recordingFromSession(session, sizeBytes, {
        endedAt: at, durationMs: native.audioMs, recovered: false, endedUnexpectedly: false, exitReason: null,
      }), { audioMs: native.audioMs, bytes: size, firstAudioAt: current.session.firstAudioAt });
      if (result) emit("committed", { id, recording: result });
      await bridge.invoke("recorder_acknowledge", { id });
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
          audioMs: event.elapsedMs, elapsedMs: event.elapsedMs, pausedMs: event.pausedMs,
          spans: event.spans ?? native.spans };
        const failed = await nativeFailures(event.id);
        if (failed.length) {
          await quarantineFailures(failed);
          await bridge.invoke("recorder_acknowledge", { id: event.id });
          releaseLive();
          emit("autoStopped", { ...event, recording: null, error: "write_failed" });
          return;
        }
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
    if (initialNative.id) emitMic(initialNative);
  } catch (error) {
    clearInterval(heartbeat);
    for (const stop of unlisten) stop();
    if (!options.store) store.close();
    throw error;
  }

  const nativeFailures = async (id?: string): Promise<NativeFailed[]> => {
    const all = await bridge.invoke<NativeFailed[]>("recorder_failed_list");
    return id ? all.filter((failed) => failed.id === id) : all;
  };
  const quarantineFailures = async (failed: NativeFailed[]): Promise<RecoveryResult["failed"]> => {
    const results: RecoveryResult["failed"] = [];
    const existing = new Set((await store.listQuarantine()).items.map((item) => item.id));
    const committed = new Set((await store.listPending()).recordings.map((item) => item.id));
    for (const item of failed) {
      // A relaunch must neither overwrite captured metadata nor repeat a
      // failure notification for an already quarantined note.
      if (existing.has(item.id) || committed.has(item.id)) continue;
      if (!await store.getSession(item.id)) {
        const defaults = await store.getCaptureDefaults();
        await store.beginSession({ id: item.id, startedAt: item.journal.startedAt, source: "in_app", owner: null,
          transitionGen: defaults.transitionGen, options: { transcriber: "on-device", identifySpeakers: false },
          mimeType: "audio/mpeg", input: null, maxDurationMs: item.journal.maxDurationMs });
      }
      await store.quarantineInterrupted(item.id, item.reason, item.error);
      const event = { id: item.id, reason: item.reason, error: item.error };
      emit("writeFailure", { id: item.id, error: item.error });
      emit("recoveryFailed", event);
      results.push(event);
      existing.add(item.id);
    }
    return results;
  };

  async function recoverInterrupted(): Promise<RecoveryResult> {
    let report: NativeRecoveryReport;
    try {
      const native = await bridge.invoke<NativeStatus>("recorder_status");
      if (native.id) await adopt(native);
      report = live ? { journal: null, quarantined: await nativeFailures() }
        : await bridge.invoke<NativeRecoveryReport>("recorder_recover");
    } catch (error) {
      const failed = { id: live?.session.id ?? "unknown", reason: "recovery_failed", error: errorText(error) };
      emit("recoveryFailed", failed);
      return { recovered: [], failed: [failed] };
    }
    // Native recovery runs first. Sweep old Discard tombstones before turning
    // failures into sessions, since a tombstoned id must never be resurrected.
    await store.sweepTombstones();
    let imported = report.journal;
    if (imported && await store.hasTombstone(imported.id)) {
      await bridge.invoke("recorder_acknowledge", { id: imported.id });
      imported = null;
    }
    const existingQuarantine = new Set((await store.listQuarantine()).items.map((item) => item.id));
    const existingNotes = new Set((await store.listPending()).recordings.map((item) => item.id));
    if (imported && !await store.getSession(imported.id)
      && !existingQuarantine.has(imported.id) && !existingNotes.has(imported.id)) {
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
      if (session) {
        const spans = mergeSpans(session.spans, imported.spans);
        if (spans.length !== session.spans.length) await store.updateSession(imported.id, { spans });
      }
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
    const quarantined = await quarantineFailures(await nativeFailures());
    const result = await store.recoverInterruptedSessions();
    if (imported) {
      // Recovery has finished. The store now owns any durable bytes, whether it
      // committed, quarantined, retained a session, or dropped an empty note.
      // Leaving the native pointer after an empty drop blocks every future Start.
      await bridge.invoke("recorder_acknowledge", { id: imported.id });
    }
    for (const recording of result.recovered) emit("recovered", { id: recording.id, recording });
    for (const failed of result.failed) emit("recoveryFailed", failed);
    return { recovered: result.recovered, failed: [...quarantined, ...result.failed] };
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
            // TODO(TC-888): use on-device when desktopWhisper
            transcriber: signedIn ? startOptions?.transcriber ?? defaults.transcriber : "off",
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
        const id = live.session.id;
        const native = await bridge.invoke<NativeStatus>("recorder_stop");
        const failed = await nativeFailures(id);
        if (failed.length) {
          await quarantineFailures(failed);
          await bridge.invoke("recorder_acknowledge", { id });
          releaseLive();
          throw failure("write_failed", failed[0]!.error);
        }
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
        const failed = await nativeFailures(live.session.id);
        if (failed.length) {
          const id = live.session.id;
          await bridge.invoke<NativeStatus>("recorder_stop");
          await quarantineFailures(failed);
          await bridge.invoke("recorder_acknowledge", { id });
          releaseLive();
          throw failure("write_failed", failed[0]!.error);
        }
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
        await store.tombstoneSession(id);
        // If native Stop fails, the tombstone remains durable. A later launch
        // finishes the Stop before sweeping the file and its sources.
        await bridge.invoke<NativeStatus>("recorder_stop");
        try { await store.discardSession(id); await bridge.invoke("recorder_acknowledge", { id }); }
        finally { releaseLive(); }
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
        const native = await bridge.invoke<NativeStatus>("recorder_status");
        if (live) await syncDurable(native);
        emitMic(native);
      });
    },
    async retryRecovery({ id }) {
      if (live?.session.id === id) throw failure("recording_in_progress");
      const remaining = await bridge.invoke<NativeFailed[]>("recorder_failed_retry", { id });
      if (remaining.length) { await quarantineFailures(remaining); throw failure("recovery_failed", remaining[0]!.error); }
      await store.rearmQuarantined(id);
      await recoverInterrupted();
    },
    async discardFailedRecording({ id }) {
      if (live?.session.id === id) throw failure("recording_in_progress");
      const shared = await store.listQuarantine();
      if (shared.items.some((item) => item.id === id)) await store.discardFailedRecording({ id });
      else if ((await nativeFailures(id)).length) await store.discardSession(id);
      else throw failure("not_found");
      await bridge.invoke("recorder_failed_delete", { id });
    },
    async deleteQuarantined({ id }) {
      if (live?.session.id === id) throw failure("recording_in_progress");
      await store.deleteQuarantined({ id });
      await bridge.invoke("recorder_failed_delete", { id });
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
    async listQuarantine() {
      const shared = await store.listQuarantine();
      const native = await nativeFailures();
      const seen = new Set(shared.items.map((item) => item.id));
      for (const failed of native) if (!seen.has(failed.id)) {
        shared.items.push({ id: failed.id, reason: failed.reason, sizeBytes: await store.audio.size(failed.id) });
        seen.add(failed.id);
      }
      return shared;
    },
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

/** Opens the desktop engine and registers the extras that bind the same bridge. */
export async function installDesktopEngine(bridge: DesktopBridge, storeOptions?: DesktopVoiceNotesOptions["storeOptions"]): Promise<CaptureEngine> {
  const engine = await openDesktopVoiceNotes({ bridge, storeOptions });
  registerDesktopCaptureExtras((await import("./tauriDesktopCaptureExtras")).createTauriDesktopCaptureExtras(bridge));
  try { await engine.recoverInterrupted(); }
  catch (error) { console.error("[desktopVoiceNotes] Recovery will retry; recorder stays available", error); }
  return engine.plugin;
}

/** Registration is the only desktop engine gate. The main entry imports this module once. */
export function registerDesktopVoiceNotes(): void {
  registerCaptureEngine("tauri", async () => installDesktopEngine(await tauriBridge()));
}
