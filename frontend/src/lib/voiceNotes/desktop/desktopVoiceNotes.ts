import { readableError } from "@/lib/readableError";
import type { PluginListenerHandle } from "@capacitor/core";
import type {
  AudioInput, CaptureOptions, CaptureStatus, LevelEvent, MicStateEvent, MissingAudioSpan, VoiceNoteRecording, VoiceNotesPlugin,
} from "../nativeVoiceNotes";
import { VOICE_NOTE_MAX_DURATION_MS, VOICE_NOTE_MIN_DURATION_LIMIT_MS } from "../nativeVoiceNotes";
import { notifyCaptureCapabilitiesChanged, registerCaptureEngine, type CaptureCapabilities, type CaptureEngine } from "../captureEngine";
import { refreshEffectiveTranscriber } from "../transcriberPreference";
import { registerDesktopCaptureExtras } from "../desktopCaptureExtras";
import { createFileAudioBlobStore, type CommandBridge } from "./fileAudioBlobStore";
import { installFinishingQuitGuard } from "./finishingQuitGuard";
import { PrivateCloudError } from "../../privateCloud";
import { VoiceNoteAudioError } from "../voiceNoteAudio";
import { createDesktopWhisperQueue, getDesktopWhisperQueue, loadDesktopWhisperBridge, registerDesktopWhisperQueue,
  type DesktopWhisperBridge, type DesktopWhisperQueue } from "./desktopWhisper";
import { failure, memoryLocks, recordingFromSession, RECORDING_LOCK, sessionLock, type RecoveryResult, type SessionRecord,
  type WebStore, openWebStore, type WebStoreOptions } from "../web/webStore";

type EventName = "micState" | "level" | "autoStopped" | "committed" | "recovered" | "recoveryFailed" | "audioUploadProgress"
  | "writeFailure" | "inputs" | "captureAlert" | "presentRecorder";
type Listener = (event: never) => void;
type NativeStatus = Omit<CaptureStatus, "spans" | "openSpan" | "transitionGen"> & {
  at: number; elapsedAt: number; spans?: MissingAudioSpan[] };
type NativeAutoStop = { id: string; reason: "max_duration"; maxDurationMs: number; at: number; elapsedMs: number; pausedMs: number;
  channels: 1 | 2; spans?: MissingAudioSpan[] };
type NativeJournal = { id: string; startedAt: number; recordedMs: number; pausedMs: number; maxDurationMs: number;
  spans?: MissingAudioSpan[]; layout?: "mono" | "stereo" };
type NativeFailed = { id: string; segmentId: string; reason: string; error: string; journal: NativeJournal };
type NativeRecoveryReport = { journal: NativeJournal | null; stopped?: NativeJournal[]; quarantined: NativeFailed[] };

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
  desktopWhisper: false,
  offlineRecorder: true,
  nativeFileUpload: true,
};

let refreshSelectedWhisper: (() => Promise<void>) | null = null;
/** D7b can await this after models.select; the controller also uses it before accepting Local. */
export async function refreshDesktopWhisperCapability(): Promise<void> {
  await refreshSelectedWhisper?.();
}

export interface DesktopVoiceNotes {
  plugin: CaptureEngine;
  whisper: DesktopWhisperQueue | null;
  recoverInterrupted(): Promise<RecoveryResult>;
  dispose(): void;
}

export interface DesktopVoiceNotesOptions {
  bridge: DesktopBridge;
  whisper?: DesktopWhisperBridge;
  store?: WebStore;
  storeOptions?: Omit<WebStoreOptions, "audio">;
  /** The selected Whisper model became ready or went away; the installed engine rewrites its default choice. */
  onWhisperReadyChanged?: () => Promise<void>;
  now?: () => number;
  newId?: () => string;
}

const copy = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => readableError(error);
function ptxCommandError(error: unknown, correlationId?: string): PrivateCloudError | VoiceNoteAudioError {
  const code = errorText(error);
  if (code === "audio_read_failed" || code === "audio_not_ready" || code === "audio_size_mismatch" || code === "not_found") {
    return new VoiceNoteAudioError(code, code === "audio_size_mismatch"
      ? "The recording changed on disk before upload." : "Could not read this note's local audio.");
  }
  const mapped = code === "origin_not_configured" || code === "invalid_upload_url" || code === "invalid_capability"
    || code === "upload_client_failed" ? "service_misconfigured"
    : code === "upload_response_too_large" ? "upstream_bad_response"
      : code === "upload_idle_timeout" ? "request_timeout"
        : code === "upload_cancelled" ? "cancelled"
          : code === "upload_outcome_unknown" ? code : "transcription_error";
  return new PrivateCloudError(mapped, code, { correlationId });
}
const mergeSpans = (existing: MissingAudioSpan[], native: MissingAudioSpan[] = []): MissingAudioSpan[] => {
  const merged = [...existing];
  for (const span of native) if (!merged.some((item) => item.kind === span.kind && item.reason === span.reason
    && item.startedAt === span.startedAt && item.endedAt === span.endedAt)) merged.push(span);
  return merged.sort((a, b) => a.startedAt - b.startedAt);
};

export async function openDesktopVoiceNotes(options: DesktopVoiceNotesOptions): Promise<DesktopVoiceNotes> {
  const { bridge } = options;
  let desktopWhisper = false;
  try {
    const selected = await bridge.invoke<string | null>("recorder_models_get");
    if (selected) {
      const models = await bridge.invoke<{ id: string; downloaded: boolean }[]>("recorder_models_list");
      desktopWhisper = models.some((model) => model.id === selected && model.downloaded);
    }
  } catch (error) { console.warn("[desktopVoiceNotes] Could not read the selected Whisper model", error); }
  const capabilities: CaptureCapabilities = { ...DESKTOP_CAPABILITIES, desktopWhisper };
  const refreshWhisperCapability = async () => {
    const selected = await bridge.invoke<string | null>("recorder_models_get");
    const models = selected ? await bridge.invoke<{ id: string; downloaded: boolean }[]>("recorder_models_list") : [];
    const ready = !!selected && models.some((model) => model.id === selected && model.downloaded);
    const changed = ready !== capabilities.desktopWhisper;
    capabilities.desktopWhisper = ready;
    notifyCaptureCapabilitiesChanged();
    // The shown choice and the default a new recording journals both follow the capability.
    if (changed) await options.onWhisperReadyChanged?.();
  };
  refreshSelectedWhisper = refreshWhisperCapability;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const store = options.store ?? await openWebStore({ locks: memoryLocks(), ...options.storeOptions,
    audio: () => createFileAudioBlobStore(bridge) });
  let pendingNativeDiscardId: string | null = null;
  const uncertainDiscardStatus = (native: NativeStatus): NativeStatus => ({
    ...native,
    state: "needs_user",
    reason: "status_unknown",
    id: null,
    intent: "stopped",
    availability: "blocked",
    captureSourceUnconfirmed: true,
    discardCleanupPending: true,
  });
  const retryTombstonedNativeDiscard = async (native: NativeStatus): Promise<NativeStatus> => {
    const id = native.id;
    if (!id || (pendingNativeDiscardId !== id && !await store.hasTombstone(id))) return native;
    pendingNativeDiscardId = id;
    try {
      const retired = await bridge.invoke<NativeStatus>("recorder_discard_durable");
      pendingNativeDiscardId = retired.id === id ? id : null;
      return retired;
    } catch (error) {
      console.warn("[VoiceNotes] Retrying durable Discard for a tombstoned native session", error);
      let current: NativeStatus;
      try { current = await bridge.invoke<NativeStatus>("recorder_status"); }
      catch (statusError) {
        console.warn("[VoiceNotes] Could not confirm tombstoned native session status", statusError);
        current = native;
      }
      pendingNativeDiscardId = current.id === id ? id : null;
      return current;
    }
  };
  const ensureNativeDiscardRetired = async (): Promise<void> => {
    const native = await bridge.invoke<NativeStatus>("recorder_status");
    const id = native.id;
    if (!id) {
      pendingNativeDiscardId = null;
      return;
    }
    if (pendingNativeDiscardId !== id && !await store.hasTombstone(id)) {
      if (pendingNativeDiscardId) pendingNativeDiscardId = null;
      return;
    }
    await retryTombstonedNativeDiscard(native);
    if (pendingNativeDiscardId === id) {
      throw failure("discard_pending", "A discarded recording is still being retired. Try again.");
    }
  };
  // Native capture survives a WebView reload. Resolve a tombstoned native owner
  // before any recovery path can adopt it as a live recording.
  let initialNative = await bridge.invoke<NativeStatus>("recorder_status");
  if (initialNative.id && (pendingNativeDiscardId === initialNative.id || await store.hasTombstone(initialNative.id))) {
    const discardedId = initialNative.id;
    initialNative = await retryTombstonedNativeDiscard(initialNative);
    if (pendingNativeDiscardId === discardedId) initialNative = uncertainDiscardStatus(initialNative);
    if (!initialNative.captureSourceUnconfirmed && !initialNative.discardCleanupPending && !pendingNativeDiscardId) {
      await store.sweepTombstones();
    }
  }
  const listeners = new Map<EventName, Set<Listener>>();
  const retained = new Map<EventName, unknown[]>();
  const urls = new Map<string, string>();
  const unlisten: (() => void)[] = [];
  let live: { session: SessionRecord; release: (() => void)[] } | null = null;
  let whisperQueue: DesktopWhisperQueue | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const finishJobs = new Map<string, Promise<void>>();
  let disposed = false;

  const adopt = async (native: NativeStatus) => {
    if (!native.id || live) return;
    if (pendingNativeDiscardId === native.id || await store.hasTombstone(native.id)) {
      const discarded = await retryTombstonedNativeDiscard(native);
      if (pendingNativeDiscardId === native.id) {
        throw failure("discard_pending", "A discarded recording is still being retired. Try again.");
      }
      if (!discarded.id) return;
      if (await store.hasTombstone(discarded.id)) throw failure("discard_pending");
      return adopt(discarded);
    }
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
          options: { transcriber: capabilities.desktopWhisper ? "on-device" : "off", identifySpeakers: false,
            uploadAudio: defaults.uploadAudio ?? false }, mimeType: "audio/mpeg",
          input: null, maxDurationMs: native.maxDurationMs });
      }
      if (native.channels && session.channels !== native.channels) {
        await store.updateSession(session.id, { channels: native.channels });
        session.channels = native.channels;
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
  const visibleNativeStatus = (native: NativeStatus): NativeStatus =>
    pendingNativeDiscardId !== null && pendingNativeDiscardId === native.id
      ? uncertainDiscardStatus(native) : native;
  const status = async (): Promise<CaptureStatus> => {
    let native = await bridge.invoke<NativeStatus>("recorder_status");
    if (pendingNativeDiscardId && pendingNativeDiscardId !== native.id) pendingNativeDiscardId = null;
    native = visibleNativeStatus(native);
    const session = live?.session ?? (native.id ? await store.getSession(native.id) : null);
    const defaults = session ? null : await store.getCaptureDefaults();
    return {
      ...native,
      spans: session?.spans ?? [],
      openSpan: session?.spans.find((span) => span.endedAt === null) ?? null,
      input: session?.input ?? null,
      options: session?.options,
      owner: session?.owner,
      transitionGen: session?.transitionGen ?? defaults!.transitionGen,
      discardCleanupPending: native.discardCleanupPending ?? false,
      captureSourceUnconfirmed: native.captureSourceUnconfirmed ?? false,
    };
  };
  const emitMic = (native: NativeStatus) => {
    const visible = visibleNativeStatus(native);
    const session = live?.session;
    emit("micState", {
      state: visible.state, reason: visible.reason, at: visible.at, id: visible.id,
      audioMs: visible.audioMs, elapsedMs: visible.elapsedMs, pausedMs: visible.pausedMs,
      options: session?.options, input: session?.input ?? null,
      openSpan: session?.spans.find((span) => span.endedAt === null) ?? null,
      captureSourceUnconfirmed: visible.captureSourceUnconfirmed ?? false,
    } satisfies MicStateEvent);
    if (!visible.captureSourceUnconfirmed && !visible.discardCleanupPending) {
      void store.sweepTombstones().catch((error: unknown) =>
        console.warn("[VoiceNotes] Could not finish discarded-session cleanup", error));
    }
  };
  const syncDurable = async (native: NativeStatus): Promise<void> => {
    const current = live;
    if (!current) return;
    const bytes = await store.audio.size(current.session.id);
    const firstAudioAt = bytes > 0 ? current.session.firstAudioAt ?? native.startedAt ?? now() : null;
    const patch: Partial<SessionRecord> = {
      bytes, audioMs: native.audioMs, pausedMs: native.pausedMs, firstAudioAt,
      channels: native.channels ?? current.session.channels,
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
      if (result) {
        emit("committed", { id, recording: result });
        try { await whisperQueue?.noteCommitted(result); }
        catch (error) { console.error("[desktopWhisper] Could not queue a committed note; recovery will retry", error); }
      }
      await bridge.invoke("recorder_acknowledge", { id });
      return result;
    } finally {
      releaseLive();
      whisperQueue?.captureEnded();
      emitMic({ ...native, id: null, startedAt: null, elapsedMs: 0, audioMs: 0, pausedMs: 0 });
    }
  };
  const finishPrepared = (id: string): Promise<void> => {
    const existing = finishJobs.get(id);
    if (existing) return existing;
    const job = (async () => {
      try {
        await bridge.invoke("recorder_finish", { id });
        const ready = await store.completePreparingAudio(id);
        await bridge.invoke("recorder_acknowledge", { id });
        emit("committed", { id, recording: ready });
        try { await whisperQueue?.noteCommitted(ready); }
        catch (error) { console.error("[desktopWhisper] Could not queue a prepared note", error); }
      } catch (error) {
        if (await store.hasTombstone(id)) {
          await bridge.invoke("delete_audio_file", { id });
          return;
        }
        await store.failPreparingAudio(id, errorText(error));
        emit("writeFailure", { id, error: errorText(error) });
        throw error;
      } finally { finishJobs.delete(id); }
    })();
    finishJobs.set(id, job);
    return job;
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
          channels: event.channels,
          spans: event.spans ?? native.spans };
        const failed = await nativeFailures(event.id);
        if (failed.length) {
          await quarantineFailures(failed);
          await bridge.invoke("recorder_acknowledge", { id: event.id });
          releaseLive();
          whisperQueue?.captureEnded();
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
    unlisten.push(await bridge.listen<{ uploadId: string; loaded: number; total: number }>("audioUploadProgress",
      (event) => emit("audioUploadProgress", event)));
    unlisten.push(await bridge.listen<NativeStatus>("exo://recorder-mic-state", emitMic));
    unlisten.push(await bridge.listen<{ inputs: AudioInput[]; selectedId: string | null; activeId: string | null; selectedMissing: string | null }>(
      "exo://recorder-inputs", (snapshot) => emit("inputs", snapshot)));
    unlisten.push(await bridge.listen<LevelEvent>("exo://recorder-level", (event) => emit("level", event)));
    unlisten.push(await bridge.listen<NativeAutoStop>("exo://recorder-auto-stopped", handleAutoStop));
    unlisten.push(await bridge.listen<string>("exo://recorder-model-selection", () => {
      void refreshWhisperCapability().then(() => {
        if (capabilities.desktopWhisper) return whisperQueue?.modelAvailable();
      }).catch((error: unknown) => console.warn("[desktopVoiceNotes] Could not refresh Whisper model", error));
    }));
    if (initialNative.id || initialNative.captureSourceUnconfirmed) emitMic(initialNative);
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
      const channels = item.journal.layout === "stereo" ? 2 : 1;
      if (!await store.getSession(item.id)) {
        const defaults = await store.getCaptureDefaults();
        await store.beginSession({ id: item.id, startedAt: item.journal.startedAt, source: "in_app", owner: null,
          transitionGen: defaults.transitionGen, options: { transcriber: capabilities.desktopWhisper ? "on-device" : "off", identifySpeakers: false,
            uploadAudio: defaults.uploadAudio ?? false },
          mimeType: "audio/mpeg", input: null, maxDurationMs: item.journal.maxDurationMs, channels });
      } else {
        await store.updateSession(item.id, { channels });
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
    let deferTombstoneCleanup: boolean;
    let report: NativeRecoveryReport;
    try {
      let native = await bridge.invoke<NativeStatus>("recorder_status");
      if (native.id && (pendingNativeDiscardId === native.id || await store.hasTombstone(native.id))) {
        const discardedId = native.id;
        native = await retryTombstonedNativeDiscard(native);
        if (pendingNativeDiscardId === discardedId) {
          deferTombstoneCleanup = true;
          emitMic(uncertainDiscardStatus(native));
          const failed = { id: discardedId, reason: "discard_pending",
            error: "Native discard is not yet retired; cleanup remains deferred." };
          emit("recoveryFailed", failed);
          return { recovered: [], failed: [failed] };
        }
      }
      deferTombstoneCleanup = !!native.captureSourceUnconfirmed || !!native.discardCleanupPending;
      if (native.id && (pendingNativeDiscardId === native.id || await store.hasTombstone(native.id))) {
        deferTombstoneCleanup = true;
        const failed = { id: native.id, reason: "discard_pending",
          error: "Native discard is not yet retired; cleanup remains deferred." };
        emit("recoveryFailed", failed);
        return { recovered: [], failed: [failed] };
      }
      if (native.id) await adopt(native);
      if (!live && !deferTombstoneCleanup) for (const id of await bridge.invoke<string[]>("recorder_stopped_list")) {
        if (await store.hasTombstone(id)) await bridge.invoke("delete_audio_file", { id });
      }
      report = live ? { journal: null, quarantined: await nativeFailures() }
        : await bridge.invoke<NativeRecoveryReport>("recorder_recover");
    } catch (error) {
      const failed = { id: live?.session.id ?? "unknown", reason: "recovery_failed", error: errorText(error) };
      emit("recoveryFailed", failed);
      return { recovered: [], failed: [failed] };
    }
    // Native recovery runs first. Do not sweep native files while the source
    // is unconfirmed or its terminal discard is still awaiting safe cleanup.
    if (!deferTombstoneCleanup) await store.sweepTombstones();
    const imported = [...new Map([report.journal, ...(report.stopped ?? [])].filter((entry): entry is NativeJournal => !!entry)
      .map((entry) => [entry.id, entry])).values()];
    const stoppedIds = new Set((report.stopped ?? []).map((entry) => entry.id));
    const existingQuarantine = new Set((await store.listQuarantine()).items.map((item) => item.id));
    const existingNotes = new Set((await store.listPending()).recordings.map((item) => item.id));
    for (const pointer of imported) {
      if (await store.hasTombstone(pointer.id) || await store.getSession(pointer.id)
        || existingQuarantine.has(pointer.id) || existingNotes.has(pointer.id)) continue;
      // A crash between the native start and metadata creation can leave a file whose
      // journal still knows its identity. Give it a conservative, unowned session.
      const defaults = await store.getCaptureDefaults();
      await store.beginSession({ id: pointer.id, startedAt: pointer.startedAt, source: "in_app", owner: null,
        transitionGen: defaults.transitionGen, options: { transcriber: capabilities.desktopWhisper ? "on-device" : "off", identifySpeakers: false,
          uploadAudio: defaults.uploadAudio ?? false },
        mimeType: "audio/mpeg", input: null, maxDurationMs: pointer.maxDurationMs,
        channels: pointer.layout === "stereo" ? 2 : 1 });
    }
    for (const pointer of imported) {
      if (await store.hasTombstone(pointer.id)) continue;
      const session = await store.getSession(pointer.id);
      const size = await store.audio.size(pointer.id);
      if (session) {
        const spans = mergeSpans(session.spans, pointer.spans);
        const channels = pointer.layout === "stereo" ? 2 : 1;
        if (spans.length !== session.spans.length || session.channels !== channels)
          await store.updateSession(pointer.id, { spans, channels });
      }
      if (session && size > session.bytes) {
        const pausedThrough = session.pauseStartedAt === null ? session.pausedMs
          : session.pausedMs + Math.max(0, session.lastHeartbeatAt - session.pauseStartedAt);
        const heartbeatMs = Math.max(0, session.lastHeartbeatAt - session.startedAt - pausedThrough);
        const estimatedMs = Math.min(pointer.maxDurationMs,
          Math.max(session.audioMs, pointer.recordedMs, heartbeatMs));
        await store.updateSession(pointer.id, { bytes: size, audioMs: estimatedMs,
          firstAudioAt: session.firstAudioAt ?? session.startedAt });
      }
    }
    const quarantined = await quarantineFailures(await nativeFailures());
    const result = await store.recoverInterruptedSessions();
    const preparedRecovered: VoiceNoteRecording[] = [];
    for (const pointer of imported) {
      if (await store.hasTombstone(pointer.id)) continue;
      if (stoppedIds.has(pointer.id)) {
        const nativeFailed = await nativeFailures(pointer.id);
        if (nativeFailed.length) {
          const prepared = (await store.listPending()).recordings.find((note) => note.id === pointer.id
            && note.ledger?.localAudio?.state === "preparing");
          if (prepared) await store.failPreparingAudio(pointer.id, nativeFailed[0]!.error);
          continue;
        }
      }
      const prepared = (await store.listPending()).recordings.find((note) => note.id === pointer.id
        && note.ledger?.localAudio?.state === "preparing");
      if (prepared) {
        if (await store.audio.size(pointer.id) > 0) {
          const ready = await store.completePreparingAudio(pointer.id);
          preparedRecovered.push(ready);
          emit("recovered", { id: ready.id, recording: ready });
          try { await whisperQueue?.noteCommitted(ready); }
          catch (error) { console.error("[desktopWhisper] Could not queue recovered audio", error); }
        } else {
          await store.failPreparingAudio(pointer.id, "audio_preparation_failed");
          if (stoppedIds.has(pointer.id)) continue;
        }
      }
      // Recovery has finished. The store now owns any durable bytes, whether it
      // committed, quarantined, retained a session, or dropped an empty note.
      // Leaving the native pointer after an empty drop blocks every future Start.
      await bridge.invoke("recorder_acknowledge", { id: pointer.id });
    }
    for (const recording of result.recovered) emit("recovered", { id: recording.id, recording });
    for (const failed of result.failed) emit("recoveryFailed", failed);
    return { recovered: [...result.recovered, ...preparedRecovered], failed: [...quarantined, ...result.failed] };
  }

  const requireReadyAudio = async (id: string): Promise<void> => {
    const note = (await store.listPending()).recordings.find((recording) => recording.id === id);
    // Native commands still provide the typed not_found/audio_read_failed
    // result for unknown IDs. The ledger only adds the preparing gate.
    if (!note) return;
    if (note.ledger?.localAudio?.state === "preparing") {
      try { await (finishJobs.get(id) ?? finishPrepared(id)); }
      catch (error) { throw new VoiceNoteAudioError("audio_preparation_failed", errorText(error)); }
    }
    if (note.ledger?.localAudio?.state === "failed") {
      throw new VoiceNoteAudioError("audio_preparation_failed", "This recording's audio needs preparation retry.");
    }
  };

  const plugin: CaptureEngine = {
    capabilities,
    async start(startOptions) {
      return run(async () => {
        if (live) throw failure("recording_in_progress");
        await ensureNativeDiscardRetired();
        const releaseRecording = await store.locks.hold(RECORDING_LOCK);
        if (!releaseRecording) throw failure("already_recording");
        const releases = [releaseRecording];
        let id = "";
        let began = false;
        let nativeStarted = false;
        try {
          await whisperQueue?.beforeCapture();
          const defaults = await store.getCaptureDefaults();
          const signedIn = defaults.status === "signed_in" && !!defaults.accountDid;
          const transcriber = signedIn ? startOptions?.transcriber ?? defaults.transcriber
            : capabilities.desktopWhisper ? "on-device" : "off";
          const captureOptions: CaptureOptions = {
            transcriber,
            identifySpeakers: signedIn && (transcriber === "private-cloud" || transcriber === "assemblyai")
              && (startOptions?.identifySpeakers ?? defaults.identifySpeakers),
            uploadAudio: startOptions?.uploadAudio ?? false,
          };
          id = newId();
          const releaseSession = await store.locks.hold(sessionLock(id));
          if (!releaseSession) throw failure("session_locked");
          releases.push(releaseSession);
          const maxDurationMs = Math.min(VOICE_NOTE_MAX_DURATION_MS,
            Math.max(VOICE_NOTE_MIN_DURATION_LIMIT_MS, startOptions?.maxDurationMs ?? VOICE_NOTE_MAX_DURATION_MS));
          const inputState = await bridge.invoke<{ inputs: AudioInput[]; activeId: string | null }>("recorder_list_inputs");
          const input = inputState.inputs.find((candidate) => candidate.id === inputState.activeId) ?? null;
          const session = await store.beginSession({ id, startedAt: now(), source: "in_app",
            owner: signedIn ? defaults.accountDid : null, transitionGen: defaults.transitionGen,
            options: captureOptions, mimeType: "audio/mpeg", input, maxDurationMs });
          began = true;
          const native = await bridge.invoke<NativeStatus>("recorder_start", { id, maxDurationMs });
          nativeStarted = true;
          session.startedAt = native.startedAt ?? session.startedAt;
          session.channels = native.channels;
          await store.updateSession(id, { startedAt: session.startedAt, channels: native.channels });
          live = { session, release: releases };
          emitMic(native);
          return { id, startedAt: session.startedAt, maxDurationMs };
        } catch (error) {
          whisperQueue?.captureEnded();
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
        if (live.session.intent === "paused") {
          const native = await bridge.invoke<NativeStatus>("recorder_stop");
          const failed = await nativeFailures(id);
          if (failed.length) {
            await quarantineFailures(failed);
            await bridge.invoke("recorder_acknowledge", { id });
            releaseLive();
            whisperQueue?.captureEnded();
            throw failure("write_failed", failed[0]!.error);
          }
          const recording = await commit(native);
          if (!recording) throw failure("no_audio_captured");
          return recording;
        }
        const native = await bridge.invoke<NativeStatus>("recorder_stop_durable");
        const failed = await nativeFailures(id);
        if (failed.length) {
          await quarantineFailures(failed);
          await bridge.invoke("recorder_acknowledge", { id });
          releaseLive();
          whisperQueue?.captureEnded();
          throw failure("write_failed", failed[0]!.error);
        }
        if (native.audioMs === 0 && await store.audio.size(id) === 0) {
          await store.dropEmptySession(id);
          await bridge.invoke("recorder_acknowledge", { id });
          releaseLive();
          whisperQueue?.captureEnded();
          throw failure("no_audio_captured");
        }
        const current = live;
        await store.updateSession(id, { bytes: await store.audio.size(id), audioMs: native.audioMs, pausedMs: native.pausedMs,
          channels: native.channels ?? current.session.channels,
          spans: mergeSpans(current.session.spans, native.spans), lastHeartbeatAt: now() });
        const recording = await store.commitPreparingSession(id, (session) => recordingFromSession(session, 0, {
          endedAt: now(), durationMs: native.audioMs, recovered: false, endedUnexpectedly: false, exitReason: null,
        }));
        releaseLive();
        whisperQueue?.captureEnded();
        if (!recording) throw failure("no_audio_captured");
        emit("committed", { id, recording });
        void finishPrepared(id).catch((error: unknown) =>
          console.error("[desktopVoiceNotes] Could not prepare stopped audio", error));
        return recording;
      });
    },
    async awaitAudioReady(id) {
      const note = (await store.listPending()).recordings.find((item) => item.id === id);
      if (!note) throw failure("not_found");
      if (note.ledger?.localAudio?.state === "ready" || !note.ledger?.localAudio) return;
      if (note.ledger.localAudio.state === "failed") throw failure("audio_preparation_failed", note.ledger.localAudio.error ?? undefined);
      await (finishJobs.get(id) ?? finishPrepared(id));
    },
    status,
    async pause() {
      return run(async () => {
        if (!live) throw failure("not_recording");
        if (live.session.intent === "paused") {
          const native = await bridge.invoke<NativeStatus>("recorder_status");
          if (native.state !== "needs_user" || !["writer_stalled", "source_still_running", "source_unusable"].includes(native.reason ?? "")) return;
        }
        const native = await bridge.invoke<NativeStatus>("recorder_pause");
        const failed = await nativeFailures(live.session.id);
        if (failed.length) {
          const id = live.session.id;
          await bridge.invoke<NativeStatus>("recorder_stop");
          await quarantineFailures(failed);
          await bridge.invoke("recorder_acknowledge", { id });
          releaseLive();
          whisperQueue?.captureEnded();
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
        if (live.session.intent === "recording") {
          const native = await bridge.invoke<NativeStatus>("recorder_status");
          if (native.state !== "needs_user" || !["writer_stalled", "source_still_running", "source_unusable"].includes(native.reason ?? "")) return;
        }
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
        let native: NativeStatus | null = null;
        try {
          native = await bridge.invoke<NativeStatus>("recorder_discard_durable");
        } catch (error) {
          console.warn("[VoiceNotes] Native durable Discard did not finish; keeping the tombstone", error);
          try { native = await bridge.invoke<NativeStatus>("recorder_status"); }
          catch (statusError) {
            console.warn("[VoiceNotes] Could not confirm native Discard status", statusError);
          }
        }
        if (!native || native.id === id) pendingNativeDiscardId = id;
        else pendingNativeDiscardId = null;
        const nativeStillOwnsDiscardedSession = !native || native.id === id || pendingNativeDiscardId === id;
        const deferCleanup = nativeStillOwnsDiscardedSession
          || !!native?.captureSourceUnconfirmed || !!native?.discardCleanupPending;
        if (!deferCleanup) {
          try {
            await store.discardSession(id);
            await bridge.invoke("recorder_acknowledge", { id });
          } catch (error) {
            console.warn("[VoiceNotes] Discard tombstone will finish cleanup later", error);
          }
        }
        const session = live.session;
        releaseLive();
        whisperQueue?.captureEnded();
        const url = urls.get(id);
        if (url) { URL.revokeObjectURL(url); urls.delete(id); }
        if (native) {
          emitMic(native);
        } else {
          emit("micState", {
            state: "needs_user", reason: "status_unknown", at: now(), id: null,
            audioMs: session.audioMs, elapsedMs: session.audioMs, pausedMs: session.pausedMs,
            captureSourceUnconfirmed: true,
          } satisfies MicStateEvent);
        }
        return { id };
      });
    },
    async setRecordingOptions(next) {
      return run(async () => {
        if (!live) throw failure("not_recording");
        const options: CaptureOptions = { ...live.session.options, ...next };
        if (!live.session.owner) options.transcriber = capabilities.desktopWhisper ? "on-device" : "off";
        if (options.transcriber === "on-device" || !live.session.owner) options.identifySpeakers = false;
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
      await plugin.awaitAudioReady?.(id);
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
      const prepared = (await store.listPending()).recordings.find((note) => note.id === id
        && note.ledger?.localAudio?.state === "failed");
      if (prepared) {
        await store.retryPreparingAudio(id);
        const nativeFailed = (await nativeFailures(id)).length > 0;
        if (nativeFailed) {
          const remaining = await bridge.invoke<NativeFailed[]>("recorder_failed_retry", { id });
          if (remaining.length) {
            await store.failPreparingAudio(id, remaining[0]!.error);
            throw failure("recovery_failed", remaining[0]!.error);
          }
          const ready = await store.completePreparingAudio(id);
          await bridge.invoke("recorder_acknowledge", { id });
          emit("recovered", { id, recording: ready });
          return;
        }
        await finishPrepared(id);
        return;
      }
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
    readAudioChunk: async (args) => {
      await requireReadyAudio(args.id);
      return store.readAudioChunk(args);
    },
    audioMetadata: async ({ id }) => {
      await requireReadyAudio(id);
      try { return await bridge.invoke("ptx_audio_metadata", { id }); }
      catch (error) { throw ptxCommandError(error); }
    },
    uploadAudio: async (request) => {
      await requireReadyAudio(request.id);
      try { return await bridge.invoke("ptx_upload_audio", {
      id: request.id, uploadId: request.uploadId, url: request.url, capability: request.capability,
      contentType: request.contentType, contentLength: request.contentLength, correlationId: request.correlationId,
      }); } catch (error) { throw ptxCommandError(error, request.correlationId); }
    },
    cancelAudioUpload: ({ uploadId }) => bridge.invoke("ptx_cancel_audio_upload", { uploadId }),
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

  if (options.whisper) {
    whisperQueue = createDesktopWhisperQueue({ store, files: bridge, whisper: options.whisper, captureLive: () => live !== null });
    registerDesktopWhisperQueue(whisperQueue);
  }

  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    unlisten.push(await installFinishingQuitGuard(async () =>
      finishJobs.size > 0 || (await store.listPending()).recordings.some((note) =>
        note.ledger?.localAudio?.state === "preparing"), undefined, undefined,
      (handler) => bridge.listen("exo://recorder-exit-requested", handler),
      () => bridge.invoke("recorder_quit_anyway")));
  }

  return {
    plugin,
    whisper: whisperQueue,
    recoverInterrupted,
    dispose() {
      disposed = true;
      clearInterval(heartbeat);
      for (const stop of unlisten) stop();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      releaseLive();
      whisperQueue?.dispose();
      if (whisperQueue && whisperQueue === getDesktopWhisperQueue()) registerDesktopWhisperQueue(null);
      if (refreshSelectedWhisper === refreshWhisperCapability) refreshSelectedWhisper = null;
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
export async function installDesktopEngine(
  bridge: DesktopBridge,
  storeOptions?: DesktopVoiceNotesOptions["storeOptions"],
  whisper?: DesktopWhisperBridge,
): Promise<CaptureEngine> {
  const engine = await openDesktopVoiceNotes({ bridge, storeOptions, whisper, onWhisperReadyChanged: refreshEffectiveTranscriber });
  registerDesktopCaptureExtras((await import("./tauriDesktopCaptureExtras")).createTauriDesktopCaptureExtras(bridge));
  try { await engine.recoverInterrupted(); }
  catch (error) { console.error("[desktopVoiceNotes] Recovery will retry; recorder stays available", error); }
  try { await engine.whisper?.resume(); }
  catch (error) { console.error("[desktopWhisper] Pending notes will retry on the next launch", error); }
  return engine.plugin;
}

/** Registration is the only desktop engine gate. The main entry imports this module once. */
export function registerDesktopVoiceNotes(): void {
  registerCaptureEngine("tauri", async () => installDesktopEngine(await tauriBridge(), undefined,
    await loadDesktopWhisperBridge()));
}
