// The browser VoiceNotes engine: the webStore (IndexedDB) and webCapture (getUserMedia +
// MediaRecorder + level meter) composed into a VoiceNotesPlugin the existing recorder
// controller, saves pipeline and quarantine UI can use unchanged. W1a installs it into
// the VoiceNotes seam; nothing in the app imports this file otherwise.

import type { PluginListenerHandle } from "@capacitor/core";
import type {
  AudioInput, CaptureOptions, CaptureStatus, MicState, MicStateReason, MissingAudioSpan, VoiceNoteRecording,
  VoiceNotesPlugin,
} from "../nativeVoiceNotes";
import {
  browserCaptureEnv, createWebCapture, TIMESLICE_MS, type CaptureEnv, type InputLoss, type WebCapture,
} from "./webCapture";
import {
  durableBytesOf, failure, RECORDING_LOCK, recordingFromSession, sessionLock, type RecoveryResult, type SessionRecord, type WebStore,
} from "./webStore";

export type { RecoveryResult };

export const WEB_CAPABILITIES = {
  nativeShortcuts: false,
  presentRecorder: false,
  openSettings: false,
  background: false,
  localTranscription: false,
} as const;
export type WebCapabilities = typeof WEB_CAPABILITIES;

/** The three-hour note limit and the shortest limit the recorder accepts (same bounds as the native shells). */
export const WEB_MAX_DURATION_MS = 3 * 60 * 60 * 1000;
export const WEB_MIN_DURATION_LIMIT_MS = 1000;

/** Methods with no meaning in a browser reject with this code. */
export const UNSUPPORTED_METHODS = ["dismissShortcutRecovery", "consumeShortcutRecord", "openSettings"] as const;

type EventName = "micState" | "captureAlert" | "level" | "autoStopped" | "presentRecorder" | "recovered"
  | "recoveryFailed" | "writeFailure" | "committed" | "inputs";
type Listener = (value: unknown) => void;
type StopReason = "user" | "max_duration" | "disk_full" | "write_failed" | "permission_revoked";
type Availability = NonNullable<CaptureStatus["availability"]>;

interface Live {
  id: string;
  record: SessionRecord;
  capture: WebCapture;
  availability: Availability;
  reason: MicStateReason;
  detail?: string;
  /** Chunk writes run strictly in order; a chunk counts only after its write resolves. */
  queue: Promise<void>;
  writeFailed: Error | null;
  lastDurableAt: number;
  /** Device picked with selectInput while the capture was held; undefined: keep the one in use. */
  pendingDevice: string | null | undefined;
  releaseLocks: (() => void)[];
  finishing: boolean;
}

export interface WebVoiceNotesOptions {
  store: WebStore;
  captureEnv?: () => CaptureEnv;
  now?: () => number;
  newId?: () => string;
}

export interface WebVoiceNotes {
  plugin: VoiceNotesPlugin;
  capabilities: WebCapabilities;
  /** Commits sessions whose tab died mid-recording and emits recovered / recoveryFailed. W1c calls this at boot. */
  recoverInterrupted(): Promise<RecoveryResult>;
  /** Stops capturing and drops listeners; for tests and teardown. Recordings stay on disk. */
  dispose(): void;
}

const clone = <T>(value: T): T => structuredClone(value);

function mapGetUserMediaError(error: unknown): Error {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return Object.assign(failure("permission_denied", "Microphone access was denied."), { cause: error });
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return Object.assign(failure("mic_unavailable", "That microphone is not available."), { cause: error });
    }
    if (error.name === "NotReadableError" || error.name === "AbortError") {
      return Object.assign(failure("mic_unavailable", "The microphone is busy or could not be opened."), { cause: error });
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

function resumeFailureReason(error: unknown): { reason: "resume_not_allowed" | "resume_blocked" | "mic_unavailable"; detail: string } {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "Error";
  if (name === "NotAllowedError" || name === "SecurityError") return { reason: "resume_not_allowed", detail: name };
  if (name === "NotReadableError" || name === "AbortError") return { reason: "resume_blocked", detail: name };
  return { reason: "mic_unavailable", detail: name };
}

export function createWebVoiceNotes(options: WebVoiceNotesOptions): WebVoiceNotes {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const captureEnv = options.captureEnv ?? (() => ({ ...browserCaptureEnv(), now }));

  const listeners = new Map<EventName, Set<Listener>>();
  const retained = new Map<EventName, unknown[]>();
  const objectUrls = new Map<string, string>();
  let live: Live | null = null;
  let selectedId: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let deviceChangeCleanup: (() => void) | null = null;

  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn);
    chain = result.catch(() => undefined);
    return result;
  };

  const emit = (name: EventName, value: unknown) => {
    const set = listeners.get(name);
    if (retained.get(name)?.length || !set?.size) {
      if (name === "level" || name === "inputs") return;
      const queue = retained.get(name) ?? [];
      queue.push(clone(value));
      retained.set(name, queue);
    } else for (const listener of set) listener(clone(value));
  };

  const openSpanOf = (s: SessionRecord) => s.spans.find((span) => span.endedAt === null) ?? null;
  const closeSpan = (s: SessionRecord) => {
    const span = openSpanOf(s);
    if (!span) return;
    span.endedAt = now();
    if (span.kind === "silenced") span.audioMs = Math.max(0, s.audioMs - span.atAudioMs);
  };
  const openSpan = (s: SessionRecord, kind: MissingAudioSpan["kind"], reason: string) => {
    closeSpan(s);
    s.spans.push({ kind, reason, startedAt: now(), endedAt: null, atAudioMs: s.audioMs, audioMs: 0 });
  };

  const elapsedMs = (l: Live): number => {
    const s = l.record;
    if (s.intent !== "recording" || l.availability !== "available") return s.audioMs;
    return s.audioMs + Math.min(Math.max(0, now() - l.lastDurableAt), 2 * TIMESLICE_MS);
  };
  const pausedMs = (l: Live) => l.record.pausedMs + (l.record.pauseStartedAt === null ? 0 : now() - l.record.pauseStartedAt);

  const mic = (l: Live): { state: MicState; reason: MicStateReason } => {
    const span = openSpanOf(l.record);
    if (l.record.intent === "paused") return { state: "paused", reason: "user" };
    if (l.availability === "interrupted") return { state: "interrupted", reason: l.reason };
    if (l.availability === "blocked") return { state: "needs_user", reason: l.reason };
    if (span?.kind === "silenced") return { state: "silenced", reason: "input_muted" };
    return { state: "recording", reason: null };
  };

  const emitMicState = () => {
    const l = live;
    emit("micState", { ...(l ? mic(l) : { state: "idle", reason: null }), detail: l?.detail, options: l?.record.options,
      input: l?.capture.activeInput ?? l?.record.input ?? null, at: now(), id: l?.id ?? null,
      audioMs: l?.record.audioMs ?? 0, elapsedMs: l ? elapsedMs(l) : 0, pausedMs: l ? pausedMs(l) : 0,
      openSpan: l ? openSpanOf(l.record) : null });
  };

  const journal = (l: Live, patch: Partial<SessionRecord>) => store.updateSession(l.id, patch);

  const releaseLive = (l: Live) => {
    for (const release of l.releaseLocks.splice(0)) release();
    if (live === l) live = null;
  };

  const onWriteFailure = (l: Live, error: unknown) => {
    if (l.writeFailed) return;
    l.writeFailed = error instanceof Error ? error : new Error(String(error));
    console.error("[webVoiceNotes] A recording chunk could not be stored", error);
    emit("writeFailure", { id: l.id, error: l.writeFailed.message });
    const reason: StopReason = error instanceof DOMException && error.name === "QuotaExceededError" ? "disk_full" : "write_failed";
    scheduleAutoStop(l, reason);
  };

  const scheduleAutoStop = (l: Live, reason: StopReason) => {
    queueMicrotask(() => {
      void run(async () => {
        if (live !== l || l.finishing) return;
        await finish(l, reason);
      }).catch((error: unknown) => console.error("[webVoiceNotes] Auto-stop failed", error));
    });
  };

  const enqueueChunk = (l: Live, blob: Blob, durationMs: number) => {
    if (l.writeFailed) return;
    l.queue = l.queue.then(async () => {
      if (l.writeFailed) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const audioMs = l.record.audioMs + durationMs;
      const firstAudioAt = l.record.firstAudioAt ?? now();
      const count = () => {
        l.record.audioMs = audioMs;
        l.record.firstAudioAt = firstAudioAt;
        l.record.bytes += bytes.byteLength;
        l.lastDurableAt = now();
      };
      try {
        await store.appendChunk(l.id, bytes, { audioMs, firstAudioAt });
      } catch (error) {
        // A blob store that cannot join the journal's transaction made the bytes durable before the
        // journal failed: they count, and finish() commits them (the blob store's size is the truth).
        if (durableBytesOf(error) !== null) count();
        throw error;
      }
      count();
      if (audioMs >= l.record.maxDurationMs && !l.finishing) scheduleAutoStop(l, "max_duration");
    }).catch((error: unknown) => onWriteFailure(l, error));
  };

  /** Ends the live session: stops capture, drains writes, commits what is durable. Never throws for an empty recording. */
  async function finish(l: Live, reason: StopReason): Promise<{ recording: VoiceNoteRecording | null; error: string | null }> {
    l.finishing = true;
    const s = l.record;
    let outcome: { recording: VoiceNoteRecording | null; error: string | null };
    try {
      await l.capture.stop();
      await l.queue;
      // The blob store, not the in-memory count, says whether anything is durable: a write that
      // reported failure may still have landed, and durable audio is never dropped.
      if ((await store.audio.size(l.id)) === 0) {
        await store.dropEmptySession(l.id);
        outcome = { recording: null, error: "no_audio_captured" };
      } else {
        // Built from the session as journaled inside the commit transaction, so an owner another tab
        // claimed meanwhile is kept; only the durable progress counters come from this tab.
        const recording = await store.commitSession(l.id, (journaled, sizeBytes) =>
          recordingFromSession(journaled, sizeBytes, {
            endedAt: now(), durationMs: journaled.audioMs, recovered: false, endedUnexpectedly: reason === "permission_revoked", exitReason: null,
          }), { audioMs: s.audioMs, bytes: s.bytes, firstAudioAt: s.firstAudioAt });
        outcome = { recording, error: recording ? null : "tombstoned" };
      }
    } catch (error) {
      releaseLive(l);
      emitMicState();
      if (reason !== "user") {
        emit("autoStopped", { id: l.id, reason, maxDurationMs: s.maxDurationMs, at: now(), recording: null,
          error: (error as { code?: string }).code ?? "finalization_failed" });
      }
      throw error;
    }
    releaseLive(l);
    if (outcome.recording) emit("committed", { id: outcome.recording.id, recording: outcome.recording });
    emitMicState();
    if (reason !== "user") {
      emit("autoStopped", { id: l.id, reason, maxDurationMs: s.maxDurationMs, at: now(), recording: outcome.recording, error: outcome.error });
    }
    return outcome;
  }

  const requireLive = (): Live => {
    if (!live) throw failure("not_recording");
    return live;
  };

  const snapshotInputs = async (): Promise<{ inputs: AudioInput[]; labelsAvailable: boolean }> => {
    const devices = (await captureEnv().mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    const labelsAvailable = devices.some((device) => device.label !== "");
    return {
      labelsAvailable,
      inputs: devices.map((device, index) => ({ id: device.deviceId, name: device.label || `Microphone ${index + 1}`, kind: inputKind(device.label) })),
    };
  };

  const inputsState = async () => {
    const { inputs, labelsAvailable } = await snapshotInputs();
    return { inputs, labelsAvailable, selectedId, activeId: live?.capture.activeInput?.id ?? null };
  };

  const callbacksFor = (holder: { live: Live | null }) => ({
    onChunk: ({ blob, durationMs }: { blob: Blob; durationMs: number }) => { if (holder.live) enqueueChunk(holder.live, blob, durationMs); },
    onLevel: (sample: { level: number; peak: number; active: boolean }) => {
      const l = holder.live;
      if (l && live === l && l.record.intent === "recording") emit("level", sample);
    },
    onInputLost: (loss: InputLoss) => {
      const l = holder.live;
      if (!l) return;
      void run(async () => {
        if (live !== l || l.record.intent !== "recording") return;
        l.availability = "blocked";
        l.reason = loss.reason;
        l.detail = loss.detail;
        openSpan(l.record, "omitted", loss.reason);
        await l.queue;
        await journal(l, { spans: l.record.spans });
        emitMicState();
      }).catch((error: unknown) => console.error("[webVoiceNotes] Could not record the lost microphone", error));
    },
    onMute: (muted: boolean) => {
      const l = holder.live;
      if (!l) return;
      void run(async () => {
        if (live !== l || l.record.intent !== "recording" || l.availability !== "available") return;
        if (muted) openSpan(l.record, "silenced", "input_muted");
        else if (openSpanOf(l.record)?.kind === "silenced") closeSpan(l.record);
        await journal(l, { spans: l.record.spans });
        emitMicState();
      }).catch((error: unknown) => console.error("[webVoiceNotes] Could not record the muted microphone", error));
    },
    onRecorderError: (error: unknown) => {
      const l = holder.live;
      if (l) onWriteFailure(l, error);
    },
    onFlushStalled: () => {
      const l = holder.live;
      if (!l) return;
      console.error("[webVoiceNotes] The recorder did not deliver its last slice before the microphone was released", l.id);
      emit("writeFailure", { id: l.id, error: "pause_flush_timeout" });
    },
  });

  const plugin: VoiceNotesPlugin = {
    async start(startOptions) {
      return run(async () => {
        if (live) throw failure("already_recording");
        const holder: { live: Live | null } = { live: null };
        const capture = createWebCapture(captureEnv(), callbacksFor(holder));
        const releaseRecording = await store.locks.hold(RECORDING_LOCK);
        if (!releaseRecording) throw failure("already_recording", "Another tab is already recording.");
        const releases: (() => void)[] = [releaseRecording];
        let id = "";
        let began = false;
        try {
          const defaults = await store.getCaptureDefaults();
          id = newId();
          const releaseSession = await store.locks.hold(sessionLock(id));
          if (releaseSession) releases.push(releaseSession);
          const signedIn = defaults.status === "signed_in" && !!defaults.accountDid;
          const opts: CaptureOptions = {
            transcriber: signedIn ? (startOptions?.transcriber ?? defaults.transcriber) : "on-device",
            identifySpeakers: startOptions?.identifySpeakers ?? defaults.identifySpeakers,
          };
          const maxDurationMs = Math.min(WEB_MAX_DURATION_MS, Math.max(WEB_MIN_DURATION_LIMIT_MS, startOptions?.maxDurationMs ?? WEB_MAX_DURATION_MS));
          const begun = await store.beginSession({ id, startedAt: now(), source: "in_app", owner: signedIn ? defaults.accountDid : null,
            transitionGen: defaults.transitionGen, options: opts, mimeType: capture.mimeType, input: null, maxDurationMs });
          began = true;
          const l: Live = { id, record: begun, capture, availability: "available", reason: null, queue: Promise.resolve(),
            writeFailed: null, lastDurableAt: now(), pendingDevice: undefined, releaseLocks: releases, finishing: false };
          holder.live = l;
          let input: AudioInput;
          try {
            input = await capture.start(await knownDeviceOrNull(selectedId));
          } catch (error) {
            throw mapGetUserMediaError(error);
          }
          const startedAt = now();
          begun.startedAt = startedAt;
          begun.input = input;
          l.lastDurableAt = startedAt;
          await store.updateSession(id, { startedAt, input });
          live = l;
          emitMicState();
          return { id, startedAt, maxDurationMs };
        } catch (error) {
          capture.abort();
          if (began) await store.dropEmptySession(id);
          for (const release of releases) release();
          throw error;
        }
      });
    },

    async stop() {
      return run(async () => {
        const l = requireLive();
        const { recording, error } = await finish(l, "user");
        if (!recording) throw failure(error ?? "no_audio_captured");
        return clone(recording);
      });
    },

    async status() {
      const l = live;
      const s = l?.record;
      return clone({
        ...(l ? mic(l) : { state: "idle" as const, reason: null }), detail: l?.detail, id: l?.id ?? null,
        intent: s?.intent ?? "stopped", availability: l?.availability ?? "available", startedAt: s?.startedAt ?? null,
        elapsedMs: l ? elapsedMs(l) : 0, audioMs: s?.audioMs ?? 0, pausedMs: l ? pausedMs(l) : 0,
        maxDurationMs: s?.maxDurationMs ?? WEB_MAX_DURATION_MS, spans: s?.spans ?? [], openSpan: s ? openSpanOf(s) : null,
        source: s?.source, options: s?.options, owner: s?.owner, input: l?.capture.activeInput ?? s?.input ?? null,
        transitionGen: s?.transitionGen ?? (await store.getCaptureDefaults()).transitionGen,
      }) as CaptureStatus;
    },

    async pause() {
      return run(async () => {
        const l = requireLive();
        if (l.record.intent === "paused") return;
        try {
          await l.capture.pause();
        } catch (error) {
          throw Object.assign(failure("pause_failed"), { cause: error });
        }
        await l.queue;
        closeSpan(l.record);
        l.record.intent = "paused";
        l.record.pauseStartedAt = now();
        l.availability = "available";
        l.reason = null;
        l.detail = undefined;
        await journal(l, { intent: "paused", pauseStartedAt: l.record.pauseStartedAt, spans: l.record.spans });
        emitMicState();
      });
    },

    async resume() {
      return run(async () => {
        const l = requireLive();
        const wasPaused = l.record.intent === "paused";
        if (!wasPaused && l.availability === "available") return;
        const at = now();
        if (wasPaused) {
          l.record.pausedMs += at - (l.record.pauseStartedAt ?? at);
          l.record.pauseStartedAt = null;
          l.record.intent = "recording";
        }
        try {
          await l.capture.resume(l.pendingDevice);
        } catch (error) {
          const { reason, detail } = resumeFailureReason(error);
          l.availability = "blocked";
          l.reason = reason;
          l.detail = detail;
          if (!openSpanOf(l.record)) openSpan(l.record, "omitted", reason);
          await journal(l, { intent: "recording", pausedMs: l.record.pausedMs, pauseStartedAt: null, spans: l.record.spans });
          emitMicState();
          throw Object.assign(failure(reason === "resume_blocked" ? "resume_failed" : reason), { cause: error });
        }
        l.pendingDevice = undefined;
        closeSpan(l.record);
        l.availability = "available";
        l.reason = null;
        l.detail = undefined;
        l.lastDurableAt = now();
        await journal(l, { intent: "recording", pausedMs: l.record.pausedMs, pauseStartedAt: null, spans: l.record.spans });
        emitMicState();
      });
    },

    async discard() {
      return run(async () => {
        const l = live;
        if (!l) return { id: null };
        l.finishing = true;
        l.capture.abort();
        await l.queue;
        try {
          await store.discardSession(l.id);
        } finally {
          releaseLive(l);
        }
        revokeUrl(l.id);
        emitMicState();
        return { id: l.id };
      });
    },

    async setRecordingOptions(next) {
      return run(async () => {
        const l = requireLive();
        const merged: CaptureOptions = { ...l.record.options, ...next,
          transcriber: l.record.owner ? (next.transcriber ?? l.record.options.transcriber) : "on-device" };
        l.record.options = merged;
        await journal(l, { options: merged });
        emitMicState();
      });
    },

    async setCaptureDefaults(next) {
      const result = await store.setCaptureDefaults(next);
      const l = live;
      if (l && result.claimed.includes(l.id)) l.record.owner = next.accountDid;
      return result;
    },

    async deleteAudio({ id }) {
      if (live?.id === id) throw failure("recording_in_progress");
      await store.deleteAudio({ id });
      revokeUrl(id);
    },

    async localAudioUrl({ id }) {
      const cached = objectUrls.get(id);
      if (cached) return { url: cached };
      const { bytes, mimeType } = await store.readNoteAudio(id);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
      objectUrls.set(id, url);
      return { url };
    },

    async listInputs() {
      return clone(await inputsState());
    },

    async selectInput({ id }) {
      return run(async () => {
        const { inputs } = await snapshotInputs();
        if (id !== null && !inputs.some((input) => input.id === id)) throw failure("input_not_found");
        const l = live;
        if (l?.record.intent === "recording" && l.availability === "available") {
          let input: AudioInput;
          try {
            input = await l.capture.switchInput(id);
          } catch (error) {
            throw mapGetUserMediaError(error);
          }
          l.record.input = input;
          await journal(l, { input });
        } else if (l) l.pendingDevice = id;
        selectedId = id;
        emit("inputs", await inputsState());
        if (l) emitMicState();
      });
    },

    async retryRecovery({ id }) {
      if (live?.id === id) throw failure("recording_in_progress");
      await store.rearmQuarantined(id);
      await recoverInterrupted();
    },

    async discardFailedRecording({ id }) {
      if (live?.id === id) throw failure("recording_in_progress");
      await store.discardFailedRecording({ id });
      revokeUrl(id);
    },

    async deleteQuarantined({ id }) {
      if (live?.id === id) throw failure("recording_in_progress");
      await store.deleteQuarantined({ id });
    },

    async dismissShortcutRecovery() { throw failure("unsupported", "App shortcuts do not exist on the web."); },
    async consumeShortcutRecord() { throw failure("unsupported", "App shortcuts do not exist on the web."); },
    async openSettings() { throw failure("unsupported", "A web page cannot open the browser's microphone settings."); },

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
      if (event === "inputs") watchDevices();
      if (retained.get(event)?.length) queueMicrotask(() => {
        if (!set?.has(listener)) return;
        for (const payload of retained.get(event) ?? []) listener(clone(payload));
        retained.delete(event);
      });
      return Promise.resolve({
        remove: async () => {
          set?.delete(listener);
          if (event === "inputs" && !set?.size) deviceChangeCleanup?.();
        },
      });
    }) as VoiceNotesPlugin["addListener"],
  };

  async function knownDeviceOrNull(id: string | null): Promise<string | null> {
    if (id === null) return null;
    const { inputs } = await snapshotInputs();
    if (inputs.some((input) => input.id === id)) return id;
    selectedId = null;
    emit("inputs", await inputsState());
    return null;
  }

  function revokeUrl(id: string) {
    const url = objectUrls.get(id);
    if (!url) return;
    URL.revokeObjectURL(url);
    objectUrls.delete(id);
  }

  function watchDevices() {
    if (deviceChangeCleanup) return;
    const devices = captureEnv().mediaDevices as MediaDevices;
    const onChange = () => void inputsState().then((state) => emit("inputs", state))
      .catch((error: unknown) => console.error("[webVoiceNotes] Could not list audio inputs", error));
    devices.addEventListener("devicechange", onChange);
    deviceChangeCleanup = () => {
      devices.removeEventListener("devicechange", onChange);
      deviceChangeCleanup = null;
    };
  }

  async function recoverInterrupted(): Promise<RecoveryResult> {
    await store.sweepTombstones();
    const result = await store.recoverInterruptedSessions();
    for (const recording of result.recovered) emit("recovered", { id: recording.id, recording });
    for (const failed of result.failed) emit("recoveryFailed", failed);
    return result;
  }

  return {
    plugin,
    capabilities: WEB_CAPABILITIES,
    recoverInterrupted,
    dispose() {
      deviceChangeCleanup?.();
      const l = live;
      if (l) { l.finishing = true; l.capture.abort(); releaseLive(l); }
      for (const id of [...objectUrls.keys()]) revokeUrl(id);
      listeners.clear();
      retained.clear();
    },
  };
}

function inputKind(label: string): AudioInput["kind"] {
  return /bluetooth|airpods|hands-?free/i.test(label) ? "bluetooth"
    : /usb/i.test(label) ? "usb"
    : /built-?in|internal|macbook/i.test(label) ? "built_in"
    : "other";
}
