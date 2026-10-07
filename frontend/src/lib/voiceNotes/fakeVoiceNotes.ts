import type { PluginListenerHandle } from "@capacitor/core";
import type {
  AudioInput, CaptureDefaults, CaptureOptions, CaptureSource, CaptureStatus, LocalTranscript, MicState,
  MicStateReason, MissingAudioSpan, NoteLedger, OutboxEntry, VoiceNoteRecording, VoiceNotesPlugin,
} from "./nativeVoiceNotes";

type EventName = "micState" | "level" | "autoStopped" | "presentRecorder" | "recovered" | "committed" | "inputs";
type Listener = (value: unknown) => void;
type Intent = NonNullable<CaptureStatus["intent"]>;
type Availability = NonNullable<CaptureStatus["availability"]>;
type Session = {
  id: string; startedAt: number; audioMs: number; pausedMs: number; pauseStarted: number | null;
  intent: Intent; availability: Availability; reason: MicStateReason; gen: number; source: CaptureSource;
  owner: string | null; transitionGen: number; options: CaptureOptions; spans: MissingAudioSpan[];
  openSpan: MissingAudioSpan | null; maxDurationMs: number; backoffAttempt: number; nextRetryMs: number | null;
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
    interruptionBegins(reason?: MicStateReason): void;
    interruptionEnds(success?: boolean): void;
    backoffExhausted(): void;
    backoffDelayMs(): number | null;
    retryAutomatic(success?: boolean): void;
    routeChange(): void;
    mediaReset(): void;
    stall(): void;
    silence(active: boolean): void;
    appActive(success?: boolean): void;
    appSuspended(): void;
    permissionRevoked(): void;
    /** A delayed native start result; false means it failed. Stale generations never change state. */
    completeRestart(gen: number, success: boolean): void;
    pendingNotification(): { id: string; gen: number } | null;
    deliverNotification(id: string, gen: number): void;
    tick(ms: number): void;
    commitLegacy(recording: VoiceNoteRecording): void;
    quarantine(id: string, reason: string, sizeBytes: number): void;
    addRemote(id: string, resource: NoteLedger["remote"][number]): void;
    tombstoned(id: string): boolean;
    startFromSource(source: CaptureSource): Promise<string>;
  };
}

export function createFakeVoiceNotes(now: () => number = () => Date.now()): FakeVoiceNotes {
  const listeners = new Map<EventName, Set<Listener>>();
  const retained = new Map<EventName, unknown>();
  const notes = new Map<string, VoiceNoteRecording>();
  const transcripts = new Map<string, LocalTranscript>();
  const tombstones = new Set<string>();
  const outbox = new Map<string, OutboxEntry>();
  const quarantine = new Map<string, { id: string; reason: string; sizeBytes: number }>();
  const inputs: AudioInput[] = [{ id: "built-in", name: "Built-in microphone", kind: "built_in" }];
  let defaults: CaptureDefaults = { accountDid: null, transitionGen: 0, transcriber: "on-device", identifySpeakers: false };
  let session: Session | null = null;
  let counter = 0;
  let generation = 0;
  let pendingNotification: { id: string; gen: number } | null = null;
  let selectedId: string | null = null;

  const emit = (name: EventName, value: unknown) => {
    if (name !== "level" && name !== "inputs") retained.set(name, value);
    for (const listener of listeners.get(name) ?? []) listener(value);
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
    if (s.openSpan?.kind === "silenced") return { state: "silenced", reason: s.reason };
    return { state: "recording", reason: s.reason === "no_signal" ? "no_signal" : null };
  };
  const stateChanged = () => {
    const s = session;
    emit("micState", { ...(s ? mic(s) : { state: "idle", reason: null }), at: now(), id: s?.id ?? null,
      audioMs: s?.audioMs ?? 0, openSpan: s?.openSpan ?? null });
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
  const applyRestartResult = (s: Session, success: boolean) => {
    if (success) {
      s.availability = "available";
      s.reason = null;
      closeSpan(s);
      pendingNotification = null;
      s.backoffAttempt = 0;
      s.nextRetryMs = null;
    } else {
      s.availability = "blocked";
      s.reason = "resume_blocked";
    }
    stateChanged();
  };
  const restart = (s: Session, success: boolean) => {
    s.gen = ++generation;
    applyRestartResult(s, success);
  };
  const automaticRestart = (s: Session, success: boolean) => {
    s.gen = ++generation;
    if (success) { applyRestartResult(s, true); return; }
    const delays = [500, 1000, 2000, 5000, 10_000, 30_000];
    s.availability = "interrupted";
    s.reason = "resume_blocked";
    s.nextRetryMs = delays[Math.min(s.backoffAttempt, delays.length - 1)];
    s.backoffAttempt++;
    stateChanged();
  };
  const stop = (reason: "user" | "max_duration" | "disk_full" | "write_failed" | "permission_revoked") => {
    const s = session;
    if (!s) throw failure("not_recording");
    generation++;
    pendingNotification = null;
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
    return note;
  };
  const claim = (id: string, did: string, evidence: "signed_out_v2" | "space_row" | "user_choice") => {
    const note = checked(id);
    if (note.owner && note.owner !== did) throw failure("owner_mismatch");
    if (note.owner === did) return { owner: did };
    const legacy = note.version !== 2 || note.ownerUnknown === true || note.legacyImport === true;
    if (legacy && evidence === "signed_out_v2") throw failure("claim_evidence_required");
    if (!legacy && evidence !== "signed_out_v2") throw failure("claim_evidence_invalid");
    note.owner = did;
    note.ownerUnknown = false;
    note.rev = (note.rev ?? 0) + 1;
    if (evidence === "space_row") {
      note.ledger ??= ledger();
      note.ledger.audio = { state: "saved", rowId: note.ledger.audio.rowId ?? `vn-${id}`, at: now() };
    }
    return { owner: note.owner };
  };

  const plugin: VoiceNotesPlugin = {
    async start(options) {
      if (session) throw failure("already_recording");
      const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
      if (tombstones.has(id)) throw failure("tombstoned");
      const opts: CaptureOptions = { transcriber: defaults.accountDid ? (options?.transcriber ?? defaults.transcriber) : "on-device",
        identifySpeakers: options?.identifySpeakers ?? defaults.identifySpeakers };
      session = { id, startedAt: now(), audioMs: 0, pausedMs: 0, pauseStarted: null, intent: "recording", availability: "available",
        reason: null, gen: ++generation, source: "in_app", owner: defaults.accountDid, transitionGen: defaults.transitionGen,
        options: opts, spans: [], openSpan: null, maxDurationMs: Math.min(10_800_000, Math.max(1000, options?.maxDurationMs ?? 10_800_000)),
        backoffAttempt: 0, nextRetryMs: null };
      stateChanged();
      return { id, startedAt: session.startedAt, maxDurationMs: session.maxDurationMs };
    },
    async stop() { return stop("user"); },
    async status() {
      const s = session;
      return { ...(s ? mic(s) : { state: "idle" as const, reason: null }), id: s?.id ?? null,
        intent: s?.intent ?? "stopped", availability: s?.availability ?? "available", startedAt: s?.startedAt ?? null,
        elapsedMs: s ? Math.max(0, now() - s.startedAt - s.pausedMs - (s.pauseStarted === null ? 0 : now() - s.pauseStarted)) : 0,
        audioMs: s?.audioMs ?? 0, pausedMs: s ? s.pausedMs + (s.pauseStarted === null ? 0 : now() - s.pauseStarted) : 0,
        maxDurationMs: s?.maxDurationMs ?? 10_800_000, spans: s?.spans ?? [], openSpan: s?.openSpan ?? null,
        source: s?.source, options: s?.options, owner: s?.owner, input: s ? inputs[0] : null,
        transitionGen: s?.transitionGen ?? defaults.transitionGen };
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
        const handle = remote.jobId ?? remote.uploadId ?? remote.uploadUrl;
        if (!handle) continue;
        const entryId = `${id}:${outbox.size + 1}`;
        outbox.set(entryId, { entryId, did: note.owner, provider: remote.provider, mode: remote.mode,
          kind: remote.provider === "ptx" ? "ptx_job" : remote.stage === "create_unknown" ? "own_upload_lookup"
            : remote.mode === "hosted" && !remote.jobId ? "hosted_upload" : "transcript",
          handle, createdAt: now(), attempts: 0 });
      }
      notes.delete(id);
      transcripts.delete(id);
    },
    async listPending() { return { recordings: [...notes.values()] }; },
    async pause() {
      const s = session;
      if (!s) throw failure("not_recording");
      if (s.intent === "paused") return;
      s.intent = "paused"; s.pauseStarted = now(); s.gen = ++generation;
      s.backoffAttempt = 0; s.nextRetryMs = null;
      closeSpan(s); pendingNotification = null; stateChanged();
    },
    async resume() {
      const s = session;
      if (!s) throw failure("not_recording");
      if (s.intent === "paused") {
        s.pausedMs += now() - (s.pauseStarted ?? now()); s.pauseStarted = null; s.intent = "recording";
        if (s.availability !== "available") restart(s, true);
        else { s.gen = ++generation; stateChanged(); }
      } else if (s.availability !== "available") { s.backoffAttempt = 0; s.nextRetryMs = null; restart(s, true); }
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
    },
    async getCaptureDefaults() { return { ...defaults }; },
    async setCaptureDefaults(next) {
      if (next.transitionGen < defaults.transitionGen) throw failure("stale_transition");
      defaults = { ...next, transcriber: next.accountDid ? next.transcriber : "on-device" };
      const claimed: string[] = [];
      if (next.accountDid) {
        if (session && !session.owner) { session.owner = next.accountDid; claimed.push(session.id); }
        for (const note of notes.values()) {
          if (note.version === 2 && !note.owner && !note.ownerUnknown) {
            claim(note.id, next.accountDid, "signed_out_v2"); claimed.push(note.id);
          }
        }
      }
      return { claimed };
    },
    async claim({ id, did, evidence }) { return claim(id, did, evidence); },
    async updateLedger({ id, did, rev, patch }) {
      const note = checked(id);
      if (note.owner !== did) throw failure("owner_mismatch");
      if (note.rev !== rev) throw failure("rev_conflict");
      note.ledger = { ...note.ledger ?? ledger(), ...patch };
      note.rev = rev + 1;
      return { rev: note.rev };
    },
    async localAudioUrl({ id }) { checked(id); return { url: `fake://voice-notes/${id}.m4a` }; },
    async putTranscript({ id, transcript }) {
      const note = checked(id);
      if (transcript.noteId !== id) throw failure("transcript_note_mismatch");
      transcripts.set(id, transcript);
      note.rev = (note.rev ?? 0) + 1;
    },
    async getTranscript({ id }) { checked(id); return { transcript: transcripts.get(id) ?? null }; },
    async listInputs() { return { inputs, selectedId, activeId: session ? inputs[0].id : null }; },
    async selectInput({ id }) {
      if (id !== null && !inputs.some((input) => input.id === id)) throw failure("input_not_found");
      selectedId = id;
      if (session?.intent === "recording") { openSpan(session, "omitted", "route_change"); restart(session, true); }
      emit("inputs", { inputs, selectedId, activeId: session ? inputs[0].id : null });
    },
    async listQuarantine() { return { items: [...quarantine.values()] }; },
    async deleteQuarantined({ id }) { quarantine.delete(id); },
    async listOutbox({ did }) { return { entries: [...outbox.values()].filter((entry) => entry.did === did) }; },
    async completeOutbox({ entryId, result }) {
      const entry = outbox.get(entryId);
      if (!entry) throw failure("not_found");
      if (result === "done") outbox.delete(entryId);
      else entry.attempts++;
    },
    addListener: ((event: EventName, listener: Listener): Promise<PluginListenerHandle> => {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(listener);
      if (retained.has(event)) queueMicrotask(() => { if (set?.has(listener)) listener(retained.get(event)); });
      return Promise.resolve({ remove: async () => { set?.delete(listener); } });
    }) as VoiceNotesPlugin["addListener"],
  };

  return { plugin, controls: {
    interruptionBegins(reason = "interruption") {
      const s = session; if (!s) return;
      s.backoffAttempt = 0; s.nextRetryMs = null;
      if (s.intent === "recording") { openSpan(s, "omitted", "interruption"); pendingNotification = { id: s.id, gen: s.gen }; }
      s.availability = "interrupted"; s.reason = reason; stateChanged();
    },
    interruptionEnds(success = true) { const s = session; if (s) { if (s.intent === "paused") { s.availability = "available"; s.reason = null; stateChanged(); } else automaticRestart(s, success); } },
    backoffExhausted() { const s = session; if (s) { s.availability = "blocked"; s.reason = "resume_blocked"; s.nextRetryMs = null; stateChanged(); } },
    backoffDelayMs: () => session?.nextRetryMs ?? null,
    retryAutomatic(success = true) { const s = session; if (s?.intent === "recording" && s.nextRetryMs !== null) automaticRestart(s, success); },
    routeChange() { const s = session; if (s) { if (s.intent === "recording") { openSpan(s, "omitted", "route_change"); restart(s, true); } } },
    mediaReset() { const s = session; if (s) { if (s.intent === "recording") { openSpan(s, "omitted", "media_services_reset"); restart(s, true); } } },
    stall() { const s = session; if (s) { if (s.intent === "recording") { openSpan(s, "omitted", "stalled"); restart(s, true); } } },
    silence(active) {
      const s = session; if (!s) return;
      if (active) { s.reason = "os_silenced"; openSpan(s, "silenced", "os_silenced"); }
      else { closeSpan(s); s.reason = null; }
      stateChanged();
    },
    appActive(success = true) { const s = session; if (s?.intent === "recording" && s.availability !== "available") automaticRestart(s, success); },
    appSuspended() { const s = session; if (s?.intent === "recording") { openSpan(s, "omitted", "app_suspended"); s.availability = "interrupted"; stateChanged(); } },
    permissionRevoked() { if (session) stop("permission_revoked"); },
    completeRestart(gen, success) { const s = session; if (s && s.gen === gen && s.intent === "recording") applyRestartResult(s, success); },
    pendingNotification: () => pendingNotification && { ...pendingNotification },
    deliverNotification(id, gen) { const s = session; if (s?.id === id && s.gen === gen && s.intent === "recording" && s.availability !== "available") restart(s, true); },
    tick(ms) { const s = session; if (!s || s.intent !== "recording" || s.availability !== "available") return;
      s.audioMs += Math.max(0, ms);
      if (now() - s.startedAt - s.pausedMs - (s.pauseStarted === null ? 0 : now() - s.pauseStarted) >= s.maxDurationMs) stop("max_duration");
    },
    commitLegacy(recording) { if (tombstones.has(recording.id)) throw failure("tombstoned");
      notes.set(recording.id, { ...recording, ownerUnknown: true, owner: null }); },
    quarantine(id, reason, sizeBytes) { quarantine.set(id, { id, reason, sizeBytes }); },
    addRemote(id, resource) { const note = checked(id); note.ledger ??= ledger(); note.ledger.remote.push(resource); },
    tombstoned: (id) => tombstones.has(id),
    async startFromSource(source) {
      const { id } = await plugin.start();
      if (session) session.source = source;
      emit("presentRecorder", { id });
      return id;
    },
  } };
}
