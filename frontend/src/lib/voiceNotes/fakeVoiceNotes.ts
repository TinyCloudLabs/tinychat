import type { PluginListenerHandle } from "@capacitor/core";
import type {
  AccountStatus, AudioInput, CaptureDefaults, CaptureOptions, CaptureSource, CaptureStatus, ClaimOptions, LocalTranscript, MicState,
  MicStateReason, MissingAudioSpan, NoteLedger, OutboxEntry, RemoteOpReceipt, VoiceNoteRecording, VoiceNotesPlugin,
} from "./nativeVoiceNotes";

type EventName = "micState" | "captureAlert" | "level" | "autoStopped" | "presentRecorder" | "recovered" | "recoveryFailed" | "writeFailure" | "committed" | "inputs";
type Listener = (value: unknown) => void;
type Intent = NonNullable<CaptureStatus["intent"]>;
type Availability = NonNullable<CaptureStatus["availability"]>;
type Session = {
  id: string; startedAt: number; audioMs: number; pausedMs: number; pauseStarted: number | null;
  intent: Intent; availability: Availability; reason: MicStateReason; detail?: string; gen: number; source: CaptureSource;
  owner: string | null; transitionGen: number; options: CaptureOptions; spans: MissingAudioSpan[];
  openSpan: MissingAudioSpan | null; maxDurationMs: number; backoffAttempt: number; nextRetryMs: number | null;
  osSilenced: boolean; pendingCapturedMs: number;
};

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function ledger(): NoteLedger {
  return {
    spaceId: null,
    audio: { state: "pending", rowId: null, at: null },
    transcript: { state: "pending", outcome: null, reason: null, attempts: 0, nextAttemptAt: null },
    transcriptSync: { state: "pending", rev: 0, at: null },
    landed: { state: "none", eventId: null }, remote: [],
  };
}

export interface FakeVoiceNotes {
  plugin: VoiceNotesPlugin;
  /** These controls model OS events and delayed callbacks; the app uses plugin only. */
  controls: {
    interruptionBegins(reason?: MicStateReason, detail?: string): void;
    interruptionEnds(success?: boolean): void;
    backoffExhausted(): void;
    backoffDelayMs(): number | null;
    retryAutomatic(success?: boolean): void;
    /** Audio captured before input stop, delivered from the OS during Pause drain. */
    queueCapturedBuffer(ms: number): void;
    failNextPause(): void;
    failNextPauseTimeout(): void;
    failNextRelease(): void;
    releaseFailureCount(): number;
    failNextResume(reason?: "resume_blocked" | "resume_not_allowed" | "mic_unavailable"): void;
    routeChange(): void;
    mediaReset(): void;
    stall(): void;
    writeFailure(error: string): void;
    recoveryFailed(id: string | null, reason: string): void;
    silence(active: boolean): void;
    appActive(success?: boolean): void;
    appSuspended(): void;
    permissionRevoked(): void;
    /** A delayed native start result; false means it failed. Stale generations never change state. */
    completeRestart(gen: number, success: boolean): void;
    pendingNotification(): { id: string; gen: number } | null;
    deliverNotification(id: string, gen: number): Promise<void>;
    tick(ms: number): void;
    commitLegacy(recording: VoiceNoteRecording): void;
    quarantine(id: string, reason: string, sizeBytes: number): void;
    addRemote(id: string, resource: NoteLedger["remote"][number]): void;
    tombstoned(id: string): boolean;
    startFromSource(source: CaptureSource): Promise<string>;
    failNextAccountState(): void;
    failNextRemoteBegin(): void;
    failNextRemoteResult(): void;
  };
}

export function createFakeVoiceNotes(now: () => number = () => Date.now()): FakeVoiceNotes {
  const listeners = new Map<EventName, Set<Listener>>();
  const retained = new Map<EventName, unknown[]>();
  const notes = new Map<string, VoiceNoteRecording>();
  const transcripts = new Map<string, LocalTranscript>();
  const tombstones = new Set<string>();
  const outbox = new Map<string, OutboxEntry>();
  const receipts = new Map<string, RemoteOpReceipt>();
  const receiptResults = new Map<string, { destination: "ledger" | "outbox"; handle: string | null;
    handleExpiresAt: number | null; outcome: "created" | "failed" | "unknown" }>();
  const quarantine = new Map<string, { id: string; reason: string; sizeBytes: number }>();
  const inputs: AudioInput[] = [{ id: "built-in", name: "Built-in microphone", kind: "built_in" }];
  let defaults: CaptureDefaults = { accountDid: null, transitionGen: 0, transcriber: "on-device", identifySpeakers: false };
  let accountStatus: AccountStatus = "signed_out";
  let accountStateFailure = false;
  let remoteBeginFailure = false;
  let remoteResultFailure = false;
  let session: Session | null = null;
  let counter = 0;
  let outboxCounter = 0;
  let generation = 0;
  let pauseShouldFail = false;
  let pauseShouldTimeOut = false;
  let releaseShouldFail = false;
  let releaseFailures = 0;
  let resumeShouldFail: "resume_blocked" | "resume_not_allowed" | "mic_unavailable" | null = null;
  let pendingNotification: { id: string; gen: number } | null = null;
  let selectedId: string | null = null;

  const emit = (name: EventName, value: unknown) => {
    const set = listeners.get(name);
    if (retained.get(name)?.length || !set?.size) {
      if (name === "level" || name === "inputs") return;
      const queue = retained.get(name) ?? [];
      queue.push(structuredClone(value));
      retained.set(name, queue);
    } else for (const listener of set) listener(structuredClone(value));
  };
  const checked = (id: string) => {
    if (tombstones.has(id)) throw failure("tombstoned");
    const note = notes.get(id);
    if (!note) throw failure("not_found");
    return note;
  };
  const mic = (s: Session): { state: MicState; reason: MicStateReason } => {
    if (s.intent === "paused") return { state: "paused", reason: "user" };
    if (s.intent === "stopped") return { state: "idle", reason: null };
    if (s.availability === "interrupted") return { state: "interrupted", reason: s.reason };
    if (s.availability === "blocked") return { state: "needs_user", reason: s.reason };
    if (s.openSpan?.kind === "silenced") return { state: "silenced", reason: "os_silenced" };
    return { state: "recording", reason: s.reason === "no_signal" ? "no_signal" : null };
  };
  const stateChanged = () => {
    const s = session;
    const at = now();
    emit("micState", { ...(s ? mic(s) : { state: "idle", reason: null }), detail: s?.detail, options: s?.options, at, id: s?.id ?? null,
      audioMs: s?.audioMs ?? 0, elapsedMs: s ? Math.max(0, at - s.startedAt - s.pausedMs - (s.pauseStarted === null ? 0 : at - s.pauseStarted)) : 0,
      pausedMs: s ? s.pausedMs + (s.pauseStarted === null ? 0 : at - s.pauseStarted) : 0,
      openSpan: s?.openSpan ?? null });
  };
  const closeSpan = (s: Session) => {
    if (!s.openSpan) return;
    s.openSpan.endedAt = now();
    if (s.openSpan.kind === "silenced") s.openSpan.audioMs = Math.max(0, s.audioMs - s.openSpan.atAudioMs);
    s.openSpan = null;
  };
  const openSpan = (s: Session, kind: MissingAudioSpan["kind"], reason: string) => {
    if (s.intent !== "recording") return;
    closeSpan(s);
    const span: MissingAudioSpan = { kind, reason, startedAt: now(), endedAt: null, atAudioMs: s.audioMs, audioMs: 0 };
    s.spans.push(span);
    s.openSpan = span;
  };
  const drainCapturedBuffers = (s: Session) => {
    s.audioMs += s.pendingCapturedMs;
    s.pendingCapturedMs = 0;
  };
  const applyRestartResult = (s: Session, success: boolean) => {
    if (success) {
      s.availability = "available";
      s.reason = null;
      s.detail = undefined;
      closeSpan(s);
      if (s.osSilenced) { openSpan(s, "silenced", "os_silenced"); s.reason = "os_silenced"; }
      pendingNotification = null;
      s.backoffAttempt = 0;
      s.nextRetryMs = null;
    } else {
      s.availability = "blocked";
      s.reason = "resume_blocked";
      s.detail = undefined;
    }
    stateChanged();
  };
  const restart = (s: Session, success: boolean) => {
    s.gen = ++generation;
    applyRestartResult(s, success);
  };
  const manualRestart = (s: Session) => {
    s.gen = ++generation;
    s.backoffAttempt = 0;
    s.nextRetryMs = null;
    if (resumeShouldFail) {
      const reason = resumeShouldFail;
      resumeShouldFail = null;
      s.availability = "blocked";
      s.reason = reason;
      s.detail = undefined;
      stateChanged();
      throw failure(reason === "resume_blocked" ? "resume_failed" : reason);
    }
    applyRestartResult(s, true);
  };
  const automaticRestart = (s: Session, success: boolean) => {
    s.gen = ++generation;
    if (success) { applyRestartResult(s, true); return; }
    const delays = [500, 1000, 2000, 5000, 10_000, 30_000];
    s.availability = "interrupted";
    // Preserve the call/interruption reason until retries are exhausted.
    s.nextRetryMs = delays[Math.min(s.backoffAttempt, delays.length - 1)];
    s.backoffAttempt++;
    stateChanged();
  };
  const stop = (reason: "user" | "max_duration" | "disk_full" | "write_failed" | "permission_revoked") => {
    const s = session;
    if (!s) throw failure("not_recording");
    generation++;
    pendingNotification = null;
    drainCapturedBuffers(s);
    closeSpan(s);
    if (s.pauseStarted !== null) s.pausedMs += now() - s.pauseStarted;
    s.intent = "stopped";
    session = null;
    const note: VoiceNoteRecording = {
      id: s.id, startedAt: s.startedAt, durationMs: s.audioMs, mimeType: "audio/mp4", sizeBytes: Math.max(4, Math.round(s.audioMs * 8)),
      silencedMs: s.spans.filter((v) => v.kind === "silenced").reduce((total, v) => total + v.audioMs, 0),
      silencedEvents: s.spans.filter((v) => v.kind === "silenced").length, noSignalMs: 0,
      version: 2, rev: 1, wallMs: now() - s.startedAt, pausedMs: s.pausedMs, spans: s.spans,
      recovered: false, endedUnexpectedly: reason === "permission_revoked", lastHeartbeatAt: now(), exitReason: null,
      legacyImport: false, ownerUnknown: false, source: s.source, owner: s.owner, transitionGen: s.transitionGen,
      options: s.options, input: inputs[0], sampleRate: 48000, bitrate: 64000, ledger: ledger(),
      stt: { state: "waiting_for_model", pack: null, engine: null, segmentsDone: 0, windowsDone: 0, error: null },
    };
    if (!tombstones.has(note.id)) {
      notes.set(note.id, note);
      emit("committed", { id: note.id });
    }
    stateChanged();
    if (reason !== "user") emit("autoStopped", { reason, maxDurationMs: s.maxDurationMs, at: now(), recording: note });
    return structuredClone(note);
  };
  const claim = (options: ClaimOptions) => {
    const { id, did, evidence } = options;
    const note = checked(id);
    if (note.owner && note.owner !== did) throw failure("owner_mismatch");
    if (evidence === "space_row" && (typeof options.rowId !== "string" || !options.rowId.trim())) throw failure("row_id_required");
    const legacy = note.version !== 2 || note.ownerUnknown === true || note.legacyImport === true;
    if (legacy && evidence === "signed_out_v2") throw failure("claim_evidence_required");
    if (!legacy && evidence !== "signed_out_v2") throw failure("claim_evidence_invalid");
    if (note.owner === did) {
      if (evidence === "space_row" && (note.ledger?.audio.rowId !== options.rowId || note.ledger.audio.state !== "saved")) {
        note.ledger ??= ledger();
        note.ledger.audio = { state: "saved", rowId: options.rowId, at: now() };
        note.rev = (note.rev ?? 0) + 1;
      }
      return { owner: did };
    }
    note.owner = did;
    note.ownerUnknown = false;
    note.rev = (note.rev ?? 0) + 1;
    if (evidence === "space_row") {
      note.ledger ??= ledger();
      note.ledger.audio = { state: "saved", rowId: options.rowId, at: now() };
    }
    return { owner: note.owner };
  };

  const outboxFor = (receipt: RemoteOpReceipt, result: {
    handle?: string; uploadId?: string; uploadUrl?: string; jobId?: string;
    handleExpiresAt?: number; outcome: "created" | "failed" | "unknown";
  }): OutboxEntry | null => {
    const entryId = `${receipt.id}:${receipt.opId}`;
    if (result.outcome === "failed") { outbox.delete(entryId); return null; }
    const old = outbox.get(entryId);
    const job = result.jobId ?? (receipt.kind === "hosted_submit" || receipt.kind === "own_create" || receipt.kind === "ptx_create" ? result.handle : undefined)
      ?? (old?.kind === "transcript" || old?.kind === "ptx_job" ? old.handle ?? undefined : undefined);
    const upload = result.uploadId ?? (receipt.kind === "hosted_create" ? result.handle : undefined)
      ?? (old?.kind === "hosted_upload" || old?.kind === "hosted_submit" ? old.handle ?? undefined : undefined);
    const url = result.uploadUrl ?? (receipt.kind === "own_upload" ? result.handle : undefined)
      ?? (old?.kind === "own_upload_lookup" ? old.handle ?? undefined : undefined);
    const kind: OutboxEntry["kind"] = receipt.kind === "ptx_create" ? "ptx_job"
      : receipt.kind === "hosted_create" ? "hosted_upload"
      : receipt.kind === "hosted_submit" ? job ? "transcript" : upload ? "hosted_submit" : "unknown"
      : receipt.kind === "own_upload" ? "own_upload_lookup"
      : job ? "transcript" : url ? "own_upload_lookup" : "unknown";
    const handle = kind === "transcript" || kind === "ptx_job" ? job ?? old?.handle ?? null
      : kind === "hosted_upload" || kind === "hosted_submit" ? upload ?? old?.handle ?? null
      : kind === "own_upload_lookup" ? url ?? old?.handle ?? null : null;
    const state: OutboxEntry["state"] = kind === "unknown" ? "unknown"
      : kind === "hosted_submit" || kind === "own_upload_lookup" ? handle ? "lookup" : "unknown"
      : handle ? "pending" : "unknown";
    const entry: OutboxEntry = { entryId, did: receipt.did, provider: receipt.provider, mode: receipt.mode,
      kind, receiptKind: receipt.kind, handle, handleExpiresAt: result.handleExpiresAt ?? old?.handleExpiresAt ?? null,
      state, createdAt: receipt.startedAt, attempts: old?.attempts ?? 0 };
    outbox.set(entryId, entry);
    return entry;
  };

  const plugin: VoiceNotesPlugin = {
    async openSettings() {},
    async dismissShortcutRecovery() {},
    async consumeShortcutRecord() {},
    async start(options) {
      if (session) throw failure("already_recording");
      const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
      if (tombstones.has(id)) throw failure("tombstoned");
      const signedIn = accountStatus === "signed_in" && !!defaults.accountDid;
      const opts: CaptureOptions = { transcriber: signedIn ? (options?.transcriber ?? defaults.transcriber) : "on-device",
        identifySpeakers: options?.identifySpeakers ?? defaults.identifySpeakers };
      session = { id, startedAt: now(), audioMs: 0, pausedMs: 0, pauseStarted: null, intent: "recording", availability: "available",
        reason: null, gen: ++generation, source: "in_app", owner: signedIn ? defaults.accountDid : null, transitionGen: defaults.transitionGen,
        options: opts, spans: [], openSpan: null, maxDurationMs: Math.min(10_800_000, Math.max(1000, options?.maxDurationMs ?? 10_800_000)),
        backoffAttempt: 0, nextRetryMs: null, osSilenced: false, pendingCapturedMs: 0 };
      stateChanged();
      return { id, startedAt: session.startedAt, maxDurationMs: session.maxDurationMs };
    },
    async stop() { return stop("user"); },
    async status() {
      const s = session;
      return structuredClone({ ...(s ? mic(s) : { state: "idle" as const, reason: null }), detail: s?.detail,
        id: s?.id ?? null,
        intent: s?.intent ?? "stopped", availability: s?.availability ?? "available", startedAt: s?.startedAt ?? null,
        elapsedMs: s ? Math.max(0, now() - s.startedAt - s.pausedMs - (s.pauseStarted === null ? 0 : now() - s.pauseStarted)) : 0,
        audioMs: s?.audioMs ?? 0, pausedMs: s ? s.pausedMs + (s.pauseStarted === null ? 0 : now() - s.pauseStarted) : 0,
        maxDurationMs: s?.maxDurationMs ?? 10_800_000, spans: s?.spans ?? [], openSpan: s?.openSpan ?? null,
        source: s?.source, options: s?.options, owner: s?.owner, input: s ? inputs[0] : null,
        transitionGen: s?.transitionGen ?? defaults.transitionGen });
    },
    async readAudioChunk({ id, offset, length }) {
      const note = checked(id);
      const bytesRead = Math.max(0, Math.min(length, note.sizeBytes - offset));
      return { id, offset, base64: btoa("\0".repeat(bytesRead)), bytesRead, size: note.sizeBytes, eof: offset + bytesRead >= note.sizeBytes };
    },
    async deleteAudio({ id }) {
      if (session?.id === id) throw failure("recording_in_progress");
      const note = notes.get(id);
      tombstones.add(id);
      if (note?.owner) for (const remote of note.ledger?.remote ?? []) {
        if (remote.cleanup === "done") continue;
        if (remote.opId) continue;
        const add = (kind: OutboxEntry["kind"], handle: string) => {
          const entryId = `${id}:${++outboxCounter}`;
          const receipt = [...receiptResults.values()].find((item) => item.handle === handle);
          outbox.set(entryId, { entryId, did: note.owner!, provider: remote.provider, mode: remote.mode,
            kind, receiptKind: null, handle, handleExpiresAt: receipt?.handleExpiresAt ?? null,
            state: "pending", createdAt: now(), attempts: 0 });
        };
        if (remote.provider === "ptx") {
          if (remote.jobId) add("ptx_job", remote.jobId);
        } else {
          if (remote.mode === "own" && remote.stage === "submit_unknown" && remote.uploadUrl && !remote.jobId) {
            add("own_upload_lookup", remote.uploadUrl);
          } else if (remote.jobId) add("transcript", remote.jobId);
          if (remote.mode === "hosted" && remote.uploadId) add("hosted_upload", remote.uploadId);
        }
      }
      notes.delete(id);
      transcripts.delete(id);
      for (const receipt of receipts.values()) if (receipt.id === id && !outbox.has(`${id}:${receipt.opId}`)) {
        const settled = receiptResults.get(`${id}:${receipt.opId}`);
        if (settled?.outcome === "failed") continue;
        if (settled?.handle && [...outbox.values()].some((entry) => entry.did === receipt.did && entry.handle === settled.handle)) continue;
        outboxFor(receipt, { outcome: settled?.outcome ?? "unknown", handleExpiresAt: settled?.handleExpiresAt ?? undefined,
          ...(receipt.kind === "hosted_create" ? { uploadId: settled?.handle ?? undefined }
            : receipt.kind === "own_upload" ? { uploadUrl: settled?.handle ?? undefined }
              : { jobId: settled?.handle ?? undefined }) });
      }
    },
    async listPending() { return { recordings: [...notes.values()].map((note) => structuredClone(note)) }; },
    async pause() {
      const s = session;
      if (!s) throw failure("not_recording");
      if (s.intent === "paused") return;
      // A failed input stop leaves the same segment live and every queued buffer intact.
      if (pauseShouldFail) { pauseShouldFail = false; throw failure("pause_failed"); }
      if (pauseShouldTimeOut) { pauseShouldTimeOut = false; throw failure("pause_timeout"); }
      drainCapturedBuffers(s);
      s.intent = "paused"; s.pauseStarted = now(); s.gen = ++generation;
      s.backoffAttempt = 0; s.nextRetryMs = null;
      closeSpan(s); pendingNotification = null; stateChanged();
      // The input is already stopped. A failed deactivate/release cannot undo Pause.
      if (releaseShouldFail) { releaseShouldFail = false; releaseFailures++; }
    },
    async resume() {
      const s = session;
      if (!s) throw failure("not_recording");
      if (s.intent === "paused") {
        s.pausedMs += now() - (s.pauseStarted ?? now()); s.pauseStarted = null; s.intent = "recording";
        manualRestart(s);
      } else if (s.availability !== "available") manualRestart(s);
    },
    async discard() {
      const id = session?.id ?? null;
      if (id) { tombstones.add(id); session = null; generation++; pendingNotification = null; stateChanged(); }
      return { id };
    },
    async setRecordingOptions(options) {
      const s = session;
      if (!s) throw failure("not_recording");
      s.options = { ...s.options, ...options, transcriber: s.owner ? (options.transcriber ?? s.options.transcriber) : "on-device" };
      stateChanged();
    },
    async getCaptureDefaults() { return { ...defaults,
      accountDid: accountStatus === "signed_in" ? defaults.accountDid : null,
      transcriber: accountStatus === "signed_in" ? defaults.transcriber : "on-device",
      status: accountStatus }; },
    async setCaptureDefaults(next) {
      if (next.transitionGen < defaults.transitionGen) throw failure("stale_transition");
      const sameGeneration = next.transitionGen === defaults.transitionGen;
      const effectiveDid = accountStatus === "signed_in" ? defaults.accountDid : null;
      if (sameGeneration && next.accountDid !== effectiveDid) throw failure("stale_transition");
      if (!sameGeneration) accountStatus = next.accountDid ? "signed_in" : "signed_out";
      defaults = { ...next, accountDid: sameGeneration ? defaults.accountDid : next.accountDid,
        transcriber: accountStatus === "signed_in" ? next.transcriber : "on-device" };
      const claimed: string[] = [];
      if (accountStatus === "signed_in" && next.accountDid) {
        if (session && !session.owner) { session.owner = next.accountDid; claimed.push(session.id); }
        for (const note of notes.values()) {
          if (note.version === 2 && !note.owner && !note.ownerUnknown) {
            claim({ id: note.id, did: next.accountDid, evidence: "signed_out_v2" }); claimed.push(note.id);
          }
        }
      }
      return { claimed };
    },
    async setAccountState(next) {
      if (accountStateFailure) { accountStateFailure = false; throw failure("account_state_write_failed"); }
      if (next.transitionGen < defaults.transitionGen) throw failure("stale_transition");
      defaults = { ...defaults, accountDid: next.accountDid, transitionGen: next.transitionGen,
        transcriber: next.status === "signed_in" ? defaults.transcriber : "on-device" };
      accountStatus = next.status;
    },
    async retryRecovery({ id }) {
      if (session?.id === id) throw failure("recording_in_progress");
      if (!quarantine.has(id)) throw failure("not_found");
      quarantine.delete(id);
    },
    async discardFailedRecording({ id }) {
      if (session?.id === id) throw failure("recording_in_progress");
      if (!quarantine.delete(id)) throw failure(notes.has(id) ? "not_failed_recording" : "not_found");
      notes.delete(id); tombstones.add(id);
    },
    async beginRemoteOp(receipt) {
      if (remoteBeginFailure) { remoteBeginFailure = false; throw failure("receipt_begin_failed"); }
      const existing = receipts.get(`${receipt.id}:${receipt.opId}`);
      if (existing && JSON.stringify(existing) !== JSON.stringify(receipt)) throw failure("receipt_conflict");
      receipts.set(`${receipt.id}:${receipt.opId}`, structuredClone(receipt));
      const note = notes.get(receipt.id);
      if (tombstones.has(receipt.id) || !note || note.owner !== receipt.did ||
          accountStatus !== "signed_in" || defaults.accountDid !== receipt.did) {
        if (!outbox.has(`${receipt.id}:${receipt.opId}`)) outboxFor(receipt, { outcome: "unknown" });
      } else if (!(note.ledger?.remote ?? []).some((entry) => entry.opId === receipt.opId)) {
        note.ledger ??= ledger();
        note.ledger.remote.push({ opId: receipt.opId, provider: receipt.provider, mode: receipt.mode,
          kind: receipt.kind, fingerprint: receipt.fingerprint, startedAt: receipt.startedAt,
          stage: receipt.kind === "hosted_submit" ? "submit_unknown" : "create_unknown",
          uploadId: null, uploadUrl: null, jobId: null, handleExpiresAt: null, cleanup: "none" });
        note.rev = (note.rev ?? 0) + 1;
      }
    },
    async recordRemoteResult({ id, did, opId, result }) {
      if (remoteResultFailure) { remoteResultFailure = false; throw failure("receipt_result_failed"); }
      const receipt = receipts.get(`${id}:${opId}`);
      if (!receipt || receipt.did !== did) throw failure("receipt_not_found");
      const previous = receiptResults.get(`${id}:${opId}`);
      const note = notes.get(id);
      const handle = result.handle ?? result.jobId ?? result.uploadId ?? result.uploadUrl ?? null;
      if (previous?.outcome === result.outcome && previous.handle === handle &&
          previous.handleExpiresAt === (result.handleExpiresAt ?? null)) {
        return { destination: tombstones.has(id) ? "outbox" : previous.destination };
      }
      if (!note || tombstones.has(id) || note.owner !== did) {
        outboxFor(receipt, result);
        receiptResults.set(`${id}:${opId}`, { destination: "outbox", handle,
          handleExpiresAt: result.handleExpiresAt ?? null, outcome: result.outcome });
        return { destination: "outbox" };
      }
      note.ledger ??= ledger();
      const entry = note.ledger.remote.find((remote) => remote.opId === opId);
      if (entry) {
        if (result.outcome === "failed") note.ledger.remote.splice(note.ledger.remote.indexOf(entry), 1);
        else {
          entry.stage = result.outcome !== "created"
            ? receipt.kind === "hosted_submit" ? "submit_unknown" : "create_unknown"
            : receipt.kind === "hosted_create" ? "uploading" : receipt.kind === "own_upload" ? "uploaded" : "submitted";
          entry.uploadId = result.uploadId ?? (receipt.kind === "hosted_create" ? result.handle : undefined) ?? entry.uploadId;
          entry.uploadUrl = result.uploadUrl ?? (receipt.kind === "own_upload" ? result.handle : undefined) ?? entry.uploadUrl;
          entry.jobId = result.jobId ?? (["hosted_submit", "own_create", "ptx_create"].includes(receipt.kind) ? result.handle : undefined) ?? entry.jobId;
          entry.handleExpiresAt = result.handleExpiresAt ?? entry.handleExpiresAt ?? null;
        }
      }
      note.rev = (note.rev ?? 0) + 1;
      receiptResults.set(`${id}:${opId}`, { destination: "ledger", handle,
        handleExpiresAt: result.handleExpiresAt ?? null, outcome: result.outcome });
      return { destination: "ledger" };
    },
    async claim(options) { return claim(options); },
    async updateLedger({ id, did, rev, patch }) {
      const note = checked(id);
      if (note.owner !== did) throw failure("owner_mismatch");
      if (note.rev !== rev) throw failure("rev_conflict");
      note.ledger = { ...note.ledger ?? ledger(), ...structuredClone(patch) };
      note.rev = rev + 1;
      return { rev: note.rev };
    },
    async localAudioUrl({ id }) { checked(id); return { url: `fake://voice-notes/${id}.m4a` }; },
    async putTranscript({ id, transcript }) {
      checked(id);
      if (transcript.noteId !== id) throw failure("transcript_note_mismatch");
      transcripts.set(id, structuredClone(transcript));
    },
    async getTranscript({ id }) { checked(id); return { transcript: structuredClone(transcripts.get(id) ?? null) }; },
    async listInputs() { return { inputs: structuredClone(inputs), selectedId, activeId: session ? inputs[0].id : null }; },
    async selectInput({ id }) {
      if (id !== null && !inputs.some((input) => input.id === id)) throw failure("input_not_found");
      selectedId = id;
      if (session?.intent === "recording") { openSpan(session, "omitted", "route_change"); restart(session, true); }
      emit("inputs", { inputs, selectedId, activeId: session ? inputs[0].id : null });
    },
    async listQuarantine() { return { items: [...quarantine.values()].map((item) => structuredClone(item)) }; },
    async deleteQuarantined({ id }) { quarantine.delete(id); },
    async listOutbox({ did }) { return { entries: [...outbox.values()].filter((entry) => entry.did === did).map((entry) => structuredClone(entry)) }; },
    async completeOutbox({ entryId, result }) {
      const entry = outbox.get(entryId);
      if (!entry) throw failure("not_found");
      if (result === "done") outbox.delete(entryId);
      else { entry.state = result === "retry" ? "pending" : result; entry.attempts++; }
    },
    addListener: ((event: EventName, listener: Listener): Promise<PluginListenerHandle> => {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(listener);
      if (retained.get(event)?.length) queueMicrotask(() => {
        if (!set?.has(listener)) return;
        for (const payload of retained.get(event) ?? []) listener(structuredClone(payload));
        retained.delete(event);
      });
      return Promise.resolve({ remove: async () => { set?.delete(listener); } });
    }) as VoiceNotesPlugin["addListener"],
  };

  return { plugin, controls: {
    interruptionBegins(reason = "interruption", detail?: string) {
      const s = session; if (!s) return;
      s.backoffAttempt = 0; s.nextRetryMs = null;
      if (s.intent === "recording") { openSpan(s, "omitted", "interruption"); pendingNotification = { id: s.id, gen: s.gen }; }
      s.availability = "interrupted"; s.reason = reason; s.detail = detail; stateChanged();
    },
    interruptionEnds(success = true) { const s = session; if (s) { if (s.intent === "paused") { s.availability = "available"; s.reason = null; s.detail = undefined; stateChanged(); } else automaticRestart(s, success); } },
    backoffExhausted() { const s = session; if (s?.intent === "recording") { s.availability = "blocked"; s.reason = "resume_blocked"; s.detail = undefined; s.nextRetryMs = null; stateChanged(); } },
    backoffDelayMs: () => session?.nextRetryMs ?? null,
    retryAutomatic(success = true) { const s = session; if (s?.intent === "recording" && s.nextRetryMs !== null) automaticRestart(s, success); },
    queueCapturedBuffer(ms) { const s = session; if (s?.intent === "recording" && s.availability === "available") s.pendingCapturedMs += Math.max(0, ms); },
    failNextPause() { pauseShouldFail = true; },
    failNextPauseTimeout() { pauseShouldTimeOut = true; },
    failNextRelease() { releaseShouldFail = true; },
    releaseFailureCount: () => releaseFailures,
    failNextResume(reason = "resume_blocked") { resumeShouldFail = reason; },
    routeChange() { const s = session; if (s) { if (s.intent === "recording") { openSpan(s, "omitted", "route_change"); restart(s, true); } } },
    mediaReset() { const s = session; if (s) { if (s.intent === "recording") { openSpan(s, "omitted", "media_services_reset"); restart(s, true);
      emit("captureAlert", { id: s.id, reason: "media_services_reset", message: "Recording restarted after an audio system reset" }); } } },
    stall() { const s = session; if (s) { if (s.intent === "recording") { openSpan(s, "omitted", "stalled"); restart(s, true); } } },
    writeFailure(error) { if (session) emit("writeFailure", { id: session.id, error }); },
    recoveryFailed(id, reason) { emit("recoveryFailed", id === null ? { reason } : { id, reason }); },
    silence(active) {
      const s = session; if (!s) return;
      s.osSilenced = active;
      if (active && s.intent === "recording" && s.availability === "available") {
        s.reason = "os_silenced"; s.detail = undefined; openSpan(s, "silenced", "os_silenced");
      } else if (!active && s.openSpan?.kind === "silenced") {
        closeSpan(s); s.reason = null; s.detail = undefined;
      }
      stateChanged();
    },
    appActive(success = true) { const s = session; if (s?.intent === "recording" && s.availability !== "available") automaticRestart(s, success); },
    appSuspended() { const s = session; if (s?.intent === "recording") { openSpan(s, "omitted", "app_suspended"); s.availability = "interrupted"; stateChanged(); } },
    permissionRevoked() { if (session) stop("permission_revoked"); },
    completeRestart(gen, success) { const s = session; if (s && s.gen === gen && s.intent === "recording") applyRestartResult(s, success); },
    pendingNotification: () => pendingNotification && { ...pendingNotification },
    async deliverNotification(id, _gen) { const s = session; if (s?.id === id && s.intent === "recording" && s.availability !== "available") await plugin.resume(); },
    tick(ms) { const s = session; if (!s || s.intent !== "recording") return;
      if (s.availability === "available") s.audioMs += Math.max(0, ms);
      if (now() - s.startedAt - s.pausedMs - (s.pauseStarted === null ? 0 : now() - s.pauseStarted) >= s.maxDurationMs) stop("max_duration");
    },
    commitLegacy(recording) { if (tombstones.has(recording.id)) throw failure("tombstoned");
      notes.set(recording.id, { ...structuredClone(recording), ownerUnknown: true, owner: null }); },
    quarantine(id, reason, sizeBytes) { quarantine.set(id, { id, reason, sizeBytes }); },
    addRemote(id, resource) { const note = checked(id); note.ledger ??= ledger(); note.ledger.remote.push(structuredClone(resource)); },
    tombstoned: (id) => tombstones.has(id),
    failNextAccountState() { accountStateFailure = true; },
    failNextRemoteBegin() { remoteBeginFailure = true; },
    failNextRemoteResult() { remoteResultFailure = true; },
    async startFromSource(source) {
      const { id } = await plugin.start();
      if (session) session.source = source;
      emit("presentRecorder", { id });
      return id;
    },
  } };
}
