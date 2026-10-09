// IndexedDB persistence for the whole VoiceNotes protocol on the web: capture sessions
// and their audio, committed recordings and their ledger, account state, remote-op
// receipts, the outbox, transcripts and the recovery quarantine. The semantics mirror
// the Android RecordingLibrary and the repo's fake plugin; webVoiceNotes composes this
// with the browser capture engine into a VoiceNotesPlugin.
//
// Audio bytes sit behind AudioBlobStore (see audioBlobStore.ts), so a build whose
// audio lives in files (Tauri, TC-880) reuses everything else unchanged.

import type {
  AccountStatus, AudioInput, CaptureDefaults, CaptureOptions, CaptureSource, ClaimOptions, LocalTranscript,
  MissingAudioSpan, NoteLedger, OutboxEntry, RemoteOpReceipt, VoiceNoteAudioChunk, VoiceNoteRecording,
  VoiceNotesPlugin,
} from "../nativeVoiceNotes";
import { bytesToBase64 } from "../voiceNoteAudio";
import { createIdbAudioBlobStore, type AudioBlobStore } from "./audioBlobStore";
import { browserIdbEnv, failure, openWebDb, request, STORES, transact, type IdbEnv } from "./idb";

export { failure };
export type { AudioBlobStore };

/** One native call never moves more than this much audio (matches the shells). */
export const MAX_READ_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_RECOVERY_ATTEMPTS = 3;
export const RECORDING_LOCK = "exo-voice-note-recording";
export const sessionLock = (id: string) => `exo-voice-note-session:${id}`;

/** A named persistence step; `hooks.beforeOp` lets tests kill the "tab" at that exact boundary. */
export type StoreOp =
  | "session:begin" | "audio:append" | "session:progress" | "session:update" | "audio:finalize" | "note:commit"
  | "tombstone" | "audio:delete" | "recovery:attempt" | "quarantine:write";

export interface SessionRecord {
  id: string;
  startedAt: number;
  source: CaptureSource;
  owner: string | null;
  transitionGen: number;
  options: CaptureOptions;
  mimeType: string;
  input: AudioInput | null;
  maxDurationMs: number;
  intent: "recording" | "paused";
  /** Recorded time whose bytes were durable when the journal was last written. */
  audioMs: number;
  /** Audio bytes the journal had seen. The audio store is the truth for the size. */
  bytes: number;
  pausedMs: number;
  pauseStartedAt: number | null;
  /** Closed spans plus at most one open one (endedAt null). */
  spans: MissingAudioSpan[];
  firstAudioAt: number | null;
  lastHeartbeatAt: number;
  recoveryAttempts: number;
}

export type SessionInit = Omit<SessionRecord, "audioMs" | "bytes" | "pausedMs" | "pauseStartedAt" | "spans" | "firstAudioAt"
  | "lastHeartbeatAt" | "recoveryAttempts" | "intent">;

/** Lets a tab mark a session live so another tab's recovery does not adopt it. */
export interface SessionLocks {
  /** Resolves a release function, or null when another holder already has `name`. */
  hold(name: string): Promise<(() => void) | null>;
}

export function webLocks(): SessionLocks {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) throw failure("unsupported", "This browser has no Web Locks, so Exo cannot tell which recordings belong to this tab.");
  return {
    hold: (name) => new Promise((resolve, reject) => {
      locks.request(name, { ifAvailable: true }, async (lock) => {
        if (!lock) return void resolve(null);
        await new Promise<void>((release) => resolve(() => release()));
      }).catch(reject);
    }),
  };
}

/** In-memory locks for tests; `releaseAll` models every holder (a tab) dying. */
export function memoryLocks(): SessionLocks & { releaseAll(): void } {
  const held = new Set<string>();
  return {
    async hold(name) {
      if (held.has(name)) return null;
      held.add(name);
      return () => void held.delete(name);
    },
    releaseAll: () => held.clear(),
  };
}

export interface WebStoreOptions {
  dbName?: string;
  env?: IdbEnv;
  /** Replaces the IndexedDB audio store (the Tauri build passes a file-backed one). */
  audio?: (db: IDBDatabase, env: IdbEnv) => AudioBlobStore;
  locks?: SessionLocks;
  now?: () => number;
  hooks?: { beforeOp?(op: StoreOp, id: string): void | Promise<void> };
}

export interface RecoveryResult {
  recovered: VoiceNoteRecording[];
  failed: { id: string; reason: string; error: string }[];
}

type KvRow = { key: string };
type CaptureRow = KvRow & { key: "capture"; defaults: CaptureDefaults; status: AccountStatus };
type TombstoneRow = { id: string; at: number; audioPending: boolean };
type ReceiptResult = { destination: "ledger" | "outbox"; handle: string | null; handleExpiresAt: number | null;
  outcome: "created" | "failed" | "unknown" };
type ReceiptRow = { key: string; receipt: RemoteOpReceipt; result: ReceiptResult | null };
type QuarantineRow = { id: string; reason: string; error: string; sizeBytes: number; session: SessionRecord };

type PluginProtocol = Pick<VoiceNotesPlugin,
  "readAudioChunk" | "deleteAudio" | "listPending" | "getCaptureDefaults" | "setCaptureDefaults" | "setAccountState"
  | "beginRemoteOp" | "recordRemoteResult" | "claim" | "updateLedger" | "putTranscript" | "getTranscript"
  | "listQuarantine" | "discardFailedRecording" | "deleteQuarantined" | "listOutbox" | "completeOutbox">;

export interface WebStore extends PluginProtocol {
  readonly audio: AudioBlobStore;
  readonly locks: SessionLocks;
  beginSession(init: SessionInit): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** Appends the chunk, then journals `progress`; both are durable when this resolves. */
  appendChunk(id: string, bytes: Uint8Array, progress: Partial<SessionRecord>): Promise<void>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;
  /** Seals the audio and atomically turns the session into a pending recording. Null if the id was discarded meanwhile. */
  commitSession(id: string, finish: (session: SessionRecord, sizeBytes: number) => VoiceNoteRecording): Promise<VoiceNoteRecording | null>;
  /** The whole audio of a pending recording, for playback. */
  readNoteAudio(id: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** Drops a session that captured nothing (no tombstone: there is nothing to protect). */
  dropEmptySession(id: string): Promise<void>;
  /** Discards a session and its audio and tombstones the id. */
  discardSession(id: string): Promise<void>;
  /** Commits every session whose tab died before it was committed. */
  recoverInterruptedSessions(): Promise<RecoveryResult>;
  /** Finishes audio deletes a crash interrupted. */
  sweepTombstones(): Promise<void>;
  /** Moves a quarantined recording back to the recovery queue; call recoverInterruptedSessions after. */
  rearmQuarantined(id: string): Promise<void>;
  close(): void;
}

export const emptyLedger = (): NoteLedger => ({
  spaceId: null,
  audio: { state: "pending", rowId: null, at: null },
  transcript: { state: "pending", outcome: null, reason: null, attempts: 0, nextAttemptAt: null },
  transcriptSync: { state: "pending", rev: 0, at: null },
  landed: { state: "none", eventId: null },
  remote: [],
});

const INITIAL_CAPTURE: Omit<CaptureRow, "key"> = {
  defaults: { accountDid: null, transitionGen: 0, transcriber: "on-device", identifySpeakers: false },
  status: "signed_out",
};

/** The recording a session becomes at `endedAt`. Spans still open are closed there. */
export function recordingFromSession(
  s: SessionRecord,
  sizeBytes: number,
  o: { endedAt: number; durationMs: number; recovered: boolean; endedUnexpectedly: boolean; exitReason: string | null },
): VoiceNoteRecording {
  const spans = s.spans.map((span) => span.endedAt === null
    ? { ...span, endedAt: o.endedAt, audioMs: span.kind === "silenced" ? Math.max(0, o.durationMs - span.atAudioMs) : 0 }
    : { ...span });
  const silenced = spans.filter((span) => span.kind === "silenced");
  return {
    id: s.id, startedAt: s.startedAt, durationMs: o.durationMs, mimeType: s.mimeType, sizeBytes,
    silencedMs: silenced.reduce((total, span) => total + span.audioMs, 0), silencedEvents: silenced.length, noSignalMs: 0,
    version: 2, rev: 1, wallMs: Math.max(0, o.endedAt - s.startedAt),
    pausedMs: s.pausedMs + (s.pauseStartedAt === null ? 0 : Math.max(0, o.endedAt - s.pauseStartedAt)),
    spans, firstAudioAt: s.firstAudioAt, captureStoppedAt: o.endedAt,
    recovered: o.recovered, endedUnexpectedly: o.endedUnexpectedly, lastHeartbeatAt: s.lastHeartbeatAt, exitReason: o.exitReason,
    legacyImport: false, ownerUnknown: false, source: s.source, owner: s.owner, transitionGen: s.transitionGen,
    options: s.options, input: s.input, ledger: emptyLedger(),
    stt: { state: "waiting_for_model", pack: null, engine: null, segmentsDone: 0, windowsDone: 0, error: null },
  };
}

const clone = <T>(value: T): T => structuredClone(value);

function outboxEntryFor(
  receipt: RemoteOpReceipt,
  result: { handle?: string; uploadId?: string; uploadUrl?: string; jobId?: string; handleExpiresAt?: number;
    outcome: "created" | "failed" | "unknown" },
  old: OutboxEntry | undefined,
): OutboxEntry | null {
  if (result.outcome === "failed") return null;
  const entryId = `${receipt.id}:${receipt.opId}`;
  const job = result.jobId ?? (receipt.kind === "hosted_submit" || receipt.kind === "own_create" || receipt.kind === "ptx_create" ? result.handle : undefined);
  const upload = result.uploadId ?? (receipt.kind === "hosted_create" ? result.handle : undefined);
  const url = result.uploadUrl ?? (receipt.kind === "own_upload" ? result.handle : undefined);
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
  return { entryId, did: receipt.did, provider: receipt.provider, mode: receipt.mode, kind, handle,
    handleExpiresAt: result.handleExpiresAt ?? old?.handleExpiresAt ?? null, state, createdAt: receipt.startedAt,
    attempts: old?.attempts ?? 0 };
}

function sameReceipt(a: RemoteOpReceipt, b: RemoteOpReceipt): boolean {
  return a.id === b.id && a.did === b.did && a.opId === b.opId && a.provider === b.provider && a.mode === b.mode
    && a.kind === b.kind && a.fingerprint === b.fingerprint && a.startedAt === b.startedAt;
}

export async function openWebStore(options: WebStoreOptions = {}): Promise<WebStore> {
  const env = options.env ?? browserIdbEnv();
  const now = options.now ?? (() => Date.now());
  const hooks = options.hooks;
  const before = async (op: StoreOp, id: string) => { await hooks?.beforeOp?.(op, id); };
  const db = await openWebDb(env, options.dbName ?? "exo-voice-notes");
  const audio = options.audio ? options.audio(db, env) : createIdbAudioBlobStore(db, env);
  const locks = options.locks ?? webLocks();

  const get = async <T>(tx: IDBTransaction, store: string, key: IDBValidKey): Promise<T | undefined> =>
    (await request(tx.objectStore(store).get(key))) as T | undefined;
  const put = (tx: IDBTransaction, store: string, value: unknown) => request(tx.objectStore(store).put(value));
  const del = (tx: IDBTransaction, store: string, key: IDBValidKey) => request(tx.objectStore(store).delete(key));
  const all = async <T>(tx: IDBTransaction, store: string): Promise<T[]> =>
    (await request(tx.objectStore(store).getAll())) as T[];

  const capture = async (tx: IDBTransaction): Promise<CaptureRow> =>
    (await get<CaptureRow>(tx, STORES.kv, "capture")) ?? { key: "capture", ...clone(INITIAL_CAPTURE) };

  const checkedNote = async (tx: IDBTransaction, id: string): Promise<VoiceNoteRecording> => {
    if (await get(tx, STORES.tombstones, id)) throw failure("tombstoned");
    const note = await get<VoiceNoteRecording>(tx, STORES.notes, id);
    if (!note) throw failure("not_found");
    return note;
  };

  const claimInTx = async (tx: IDBTransaction, opts: ClaimOptions): Promise<{ owner: string | null }> => {
    const { id, did, evidence } = opts;
    const note = await checkedNote(tx, id);
    if (note.owner && note.owner !== did) throw failure("owner_mismatch");
    if (evidence === "space_row" && (typeof opts.rowId !== "string" || !opts.rowId.trim())) throw failure("row_id_required");
    const legacy = note.version !== 2 || note.ownerUnknown === true || note.legacyImport === true;
    if (legacy && evidence === "signed_out_v2") throw failure("claim_evidence_required");
    if (!legacy && evidence !== "signed_out_v2") throw failure("claim_evidence_invalid");
    if (note.owner === did) {
      if (evidence === "space_row" && (note.ledger?.audio.rowId !== opts.rowId || note.ledger.audio.state !== "saved")) {
        note.ledger ??= emptyLedger();
        note.ledger.audio = { state: "saved", rowId: opts.rowId, at: now() };
        note.rev = (note.rev ?? 0) + 1;
        await put(tx, STORES.notes, note);
      }
      return { owner: did };
    }
    note.owner = did;
    note.ownerUnknown = false;
    note.rev = (note.rev ?? 0) + 1;
    if (evidence === "space_row") {
      note.ledger ??= emptyLedger();
      note.ledger.audio = { state: "saved", rowId: opts.rowId, at: now() };
    }
    await put(tx, STORES.notes, note);
    return { owner: note.owner };
  };

  const enqueueOutbox = async (tx: IDBTransaction, entry: OutboxEntry) => {
    await put(tx, STORES.outbox, entry);
  };

  const finishAudioDelete = async (id: string) => {
    await before("audio:delete", id);
    await audio.delete(id);
    await transact(db, [STORES.tombstones], "readwrite", async (tx) => {
      const row = await get<TombstoneRow>(tx, STORES.tombstones, id);
      if (row) await put(tx, STORES.tombstones, { ...row, audioPending: false });
    });
  };

  const readSession = (id: string) =>
    transact(db, [STORES.sessions], "readonly", (tx) => get<SessionRecord>(tx, STORES.sessions, id));

  const store: WebStore = {
    audio,
    locks,

    async beginSession(init) {
      await before("session:begin", init.id);
      const record: SessionRecord = { ...clone(init), intent: "recording", audioMs: 0, bytes: 0, pausedMs: 0,
        pauseStartedAt: null, spans: [], firstAudioAt: null, lastHeartbeatAt: now(), recoveryAttempts: 0 };
      await transact(db, [STORES.sessions, STORES.tombstones], "readwrite", async (tx) => {
        if (await get(tx, STORES.tombstones, init.id)) throw failure("tombstoned");
        await put(tx, STORES.sessions, record);
      });
      return clone(record);
    },

    async getSession(id) {
      const row = await readSession(id);
      return row ? clone(row) : null;
    },

    async appendChunk(id, bytes, progress) {
      await before("audio:append", id);
      const bytesNow = await audio.append(id, bytes);
      await before("session:progress", id);
      await transact(db, [STORES.sessions], "readwrite", async (tx) => {
        const row = await get<SessionRecord>(tx, STORES.sessions, id);
        if (!row) throw failure("not_found", `Session ${id} is gone.`);
        await put(tx, STORES.sessions, { ...row, ...clone(progress), id, bytes: bytesNow, lastHeartbeatAt: now() });
      });
    },

    async updateSession(id, patch) {
      await before("session:update", id);
      await transact(db, [STORES.sessions], "readwrite", async (tx) => {
        const row = await get<SessionRecord>(tx, STORES.sessions, id);
        if (!row) throw failure("not_found", `Session ${id} is gone.`);
        await put(tx, STORES.sessions, { ...row, ...clone(patch), id });
      });
    },

    async commitSession(id, finish) {
      await before("audio:finalize", id);
      const sizeBytes = await audio.finalize(id);
      const session = await readSession(id);
      if (!session) return null;
      const recording = finish(clone(session), sizeBytes);
      await before("note:commit", id);
      const committed = await transact(db, [STORES.sessions, STORES.notes, STORES.tombstones], "readwrite", async (tx) => {
        const tombstoned = await get(tx, STORES.tombstones, id);
        await del(tx, STORES.sessions, id);
        if (tombstoned) return false;
        await put(tx, STORES.notes, recording);
        return true;
      });
      return committed ? clone(recording) : null;
    },

    async readNoteAudio(id) {
      const note = await transact(db, [STORES.notes, STORES.tombstones], "readonly", (tx) => checkedNote(tx, id));
      return { bytes: await audio.read(id, 0, await audio.size(id)), mimeType: note.mimeType };
    },

    async dropEmptySession(id) {
      await before("audio:delete", id);
      await audio.delete(id);
      await transact(db, [STORES.sessions], "readwrite", (tx) => del(tx, STORES.sessions, id));
    },

    async discardSession(id) {
      await before("tombstone", id);
      await transact(db, [STORES.sessions, STORES.tombstones, STORES.notes, STORES.transcripts], "readwrite", async (tx) => {
        await put(tx, STORES.tombstones, { id, at: now(), audioPending: true } satisfies TombstoneRow);
        await del(tx, STORES.sessions, id);
        await del(tx, STORES.notes, id);
        await del(tx, STORES.transcripts, id);
      });
      await finishAudioDelete(id);
    },

    async sweepTombstones() {
      const pending = await transact(db, [STORES.tombstones], "readonly", async (tx) =>
        (await all<TombstoneRow>(tx, STORES.tombstones)).filter((row) => row.audioPending));
      for (const row of pending) await finishAudioDelete(row.id);
    },

    async recoverInterruptedSessions() {
      const sessions = await transact(db, [STORES.sessions], "readonly", (tx) => all<SessionRecord>(tx, STORES.sessions));
      const result: RecoveryResult = { recovered: [], failed: [] };
      for (const listed of sessions) {
        const release = await locks.hold(sessionLock(listed.id));
        if (!release) continue;
        try {
          const outcome = await recoverOne(listed.id);
          if (outcome.recovered) result.recovered.push(outcome.recovered);
          if (outcome.failed) result.failed.push(outcome.failed);
        } finally {
          release();
        }
      }
      return result;
    },

    async rearmQuarantined(id) {
      await transact(db, [STORES.quarantine, STORES.sessions], "readwrite", async (tx) => {
        const row = await get<QuarantineRow>(tx, STORES.quarantine, id);
        if (!row) throw failure("not_found");
        await put(tx, STORES.sessions, { ...row.session, recoveryAttempts: 0 });
        await del(tx, STORES.quarantine, id);
      });
    },

    close() { db.close(); },

    async readAudioChunk({ id, offset, length }): Promise<VoiceNoteAudioChunk> {
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) throw failure("invalid_argument");
      await transact(db, [STORES.notes, STORES.tombstones], "readonly", (tx) => checkedNote(tx, id));
      const size = await audio.size(id);
      const bytes = await audio.read(id, offset, Math.min(length, MAX_READ_CHUNK_BYTES));
      return { id, offset, base64: bytesToBase64(bytes), bytesRead: bytes.byteLength, size, eof: offset + bytes.byteLength >= size };
    },

    async deleteAudio({ id }) {
      await before("tombstone", id);
      await transact(db, [STORES.sessions, STORES.notes, STORES.tombstones, STORES.transcripts, STORES.receipts, STORES.outbox],
        "readwrite", async (tx) => {
          const note = await get<VoiceNoteRecording>(tx, STORES.notes, id);
          await put(tx, STORES.tombstones, { id, at: now(), audioPending: true } satisfies TombstoneRow);
          const outbox = await all<OutboxEntry>(tx, STORES.outbox);
          const receipts = await all<ReceiptRow>(tx, STORES.receipts);
          if (note?.owner) for (const remote of note.ledger?.remote ?? []) {
            if (remote.cleanup === "done" || remote.opId) continue;
            const add = async (kind: OutboxEntry["kind"], handle: string) => {
              const settled = receipts.find((row) => row.result?.handle === handle)?.result;
              await enqueueOutbox(tx, { entryId: `${id}:cleanup:${kind}:${handle}`, did: note.owner!, provider: remote.provider,
                mode: remote.mode, kind, handle, handleExpiresAt: settled?.handleExpiresAt ?? null, state: "pending",
                createdAt: now(), attempts: 0 });
            };
            if (remote.provider === "ptx") {
              if (remote.jobId) await add("ptx_job", remote.jobId);
            } else {
              if (remote.mode === "own" && remote.stage === "submit_unknown" && remote.uploadUrl && !remote.jobId) {
                await add("own_upload_lookup", remote.uploadUrl);
              } else if (remote.jobId) await add("transcript", remote.jobId);
              if (remote.mode === "hosted" && remote.uploadId) await add("hosted_upload", remote.uploadId);
            }
          }
          await del(tx, STORES.notes, id);
          await del(tx, STORES.transcripts, id);
          const outboxNow = [...outbox];
          for (const row of receipts) {
            const { receipt, result } = row;
            if (receipt.id !== id) continue;
            if (outboxNow.some((entry) => entry.entryId === `${id}:${receipt.opId}`)) continue;
            if (result?.outcome === "failed") continue;
            if (result?.handle && outboxNow.some((entry) => entry.did === receipt.did && entry.handle === result.handle)) continue;
            const handle = result?.handle ?? undefined;
            const entry = outboxEntryFor(receipt, { outcome: result?.outcome ?? "unknown", handleExpiresAt: result?.handleExpiresAt ?? undefined,
              ...(receipt.kind === "hosted_create" ? { uploadId: handle } : receipt.kind === "own_upload" ? { uploadUrl: handle } : { jobId: handle }) },
            undefined);
            if (entry) { await enqueueOutbox(tx, entry); outboxNow.push(entry); }
          }
        });
      await finishAudioDelete(id);
    },

    async listPending() {
      const notes = await transact(db, [STORES.notes], "readonly", (tx) => all<VoiceNoteRecording>(tx, STORES.notes));
      return { recordings: clone(notes) };
    },

    async getCaptureDefaults() {
      const row = await transact(db, [STORES.kv], "readonly", capture);
      return { ...clone(row.defaults),
        accountDid: row.status === "signed_in" ? row.defaults.accountDid : null,
        transcriber: row.status === "signed_in" ? row.defaults.transcriber : "on-device",
        status: row.status };
    },

    async setCaptureDefaults(next) {
      return transact(db, [STORES.kv, STORES.notes, STORES.sessions, STORES.tombstones], "readwrite", async (tx) => {
        const row = await capture(tx);
        if (next.transitionGen < row.defaults.transitionGen) throw failure("stale_transition");
        const sameGeneration = next.transitionGen === row.defaults.transitionGen;
        const effectiveDid = row.status === "signed_in" ? row.defaults.accountDid : null;
        if (sameGeneration && next.accountDid !== effectiveDid) throw failure("stale_transition");
        if (!sameGeneration) row.status = next.accountDid ? "signed_in" : "signed_out";
        row.defaults = { ...next, accountDid: sameGeneration ? row.defaults.accountDid : next.accountDid,
          transcriber: row.status === "signed_in" ? next.transcriber : "on-device" };
        await put(tx, STORES.kv, row);
        const claimed: string[] = [];
        if (row.status === "signed_in" && next.accountDid) {
          for (const session of await all<SessionRecord>(tx, STORES.sessions)) {
            if (!session.owner) { await put(tx, STORES.sessions, { ...session, owner: next.accountDid }); claimed.push(session.id); }
          }
          for (const note of await all<VoiceNoteRecording>(tx, STORES.notes)) {
            if (note.version === 2 && !note.owner && !note.ownerUnknown) {
              await claimInTx(tx, { id: note.id, did: next.accountDid, evidence: "signed_out_v2" });
              claimed.push(note.id);
            }
          }
        }
        return { claimed };
      });
    },

    async setAccountState(next) {
      try {
        await transact(db, [STORES.kv], "readwrite", async (tx) => {
          const row = await capture(tx);
          if (next.transitionGen < row.defaults.transitionGen) throw failure("stale_transition");
          row.defaults = { ...row.defaults, accountDid: next.accountDid, transitionGen: next.transitionGen,
            transcriber: next.status === "signed_in" ? row.defaults.transcriber : "on-device" };
          row.status = next.status;
          await put(tx, STORES.kv, row);
        });
      } catch (error) {
        if ((error as { code?: string }).code === "stale_transition") throw error;
        throw Object.assign(failure("account_state_write_failed"), { cause: error });
      }
    },

    async beginRemoteOp(receipt) {
      await transact(db, [STORES.kv, STORES.notes, STORES.tombstones, STORES.receipts, STORES.outbox], "readwrite", async (tx) => {
        const key = `${receipt.id}:${receipt.opId}`;
        const existing = await get<ReceiptRow>(tx, STORES.receipts, key);
        if (existing && !sameReceipt(existing.receipt, receipt)) throw failure("receipt_conflict");
        await put(tx, STORES.receipts, { key, receipt: clone(receipt), result: existing?.result ?? null } satisfies ReceiptRow);
        const row = await capture(tx);
        const note = await get<VoiceNoteRecording>(tx, STORES.notes, receipt.id);
        const tombstoned = await get(tx, STORES.tombstones, receipt.id);
        if (tombstoned || !note || note.owner !== receipt.did || row.status !== "signed_in" || row.defaults.accountDid !== receipt.did) {
          if (!(await get(tx, STORES.outbox, key))) {
            const entry = outboxEntryFor(receipt, { outcome: "unknown" }, undefined);
            if (entry) await enqueueOutbox(tx, entry);
          }
        } else if (!(note.ledger?.remote ?? []).some((entry) => entry.opId === receipt.opId)) {
          note.ledger ??= emptyLedger();
          note.ledger.remote.push({ opId: receipt.opId, provider: receipt.provider, mode: receipt.mode,
            kind: receipt.kind, fingerprint: receipt.fingerprint, startedAt: receipt.startedAt,
            stage: receipt.kind === "hosted_submit" ? "submit_unknown" : "create_unknown",
            uploadId: null, uploadUrl: null, jobId: null, handleExpiresAt: null, cleanup: "none" });
          note.rev = (note.rev ?? 0) + 1;
          await put(tx, STORES.notes, note);
        }
      });
    },

    async recordRemoteResult({ id, did, opId, result }) {
      return transact(db, [STORES.notes, STORES.tombstones, STORES.receipts, STORES.outbox], "readwrite", async (tx) => {
        const key = `${id}:${opId}`;
        const row = await get<ReceiptRow>(tx, STORES.receipts, key);
        if (!row || row.receipt.did !== did) throw failure("receipt_not_found");
        const { receipt } = row;
        const tombstoned = !!(await get(tx, STORES.tombstones, id));
        if (row.result) return { destination: (tombstoned ? "outbox" : row.result.destination) as "ledger" | "outbox" };
        const note = await get<VoiceNoteRecording>(tx, STORES.notes, id);
        const handle = result.handle ?? result.jobId ?? result.uploadId ?? result.uploadUrl ?? null;
        if (!note || tombstoned || note.owner !== did) {
          const old = await get<OutboxEntry>(tx, STORES.outbox, key);
          const entry = outboxEntryFor(receipt, result, old);
          if (entry) await enqueueOutbox(tx, entry); else await del(tx, STORES.outbox, key);
          await put(tx, STORES.receipts, { ...row, result: { destination: "outbox", handle,
            handleExpiresAt: result.handleExpiresAt ?? null, outcome: result.outcome } } satisfies ReceiptRow);
          return { destination: "outbox" as const };
        }
        note.ledger ??= emptyLedger();
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
        await put(tx, STORES.notes, note);
        await put(tx, STORES.receipts, { ...row, result: { destination: "ledger", handle,
          handleExpiresAt: result.handleExpiresAt ?? null, outcome: result.outcome } } satisfies ReceiptRow);
        return { destination: "ledger" as const };
      });
    },

    claim: (opts) => transact(db, [STORES.notes, STORES.tombstones], "readwrite", (tx) => claimInTx(tx, opts)),

    updateLedger: ({ id, did, rev, patch }) =>
      transact(db, [STORES.notes, STORES.tombstones], "readwrite", async (tx) => {
        const note = await checkedNote(tx, id);
        if (note.owner !== did) throw failure("owner_mismatch");
        if (note.rev !== rev) throw failure("rev_conflict");
        note.ledger = { ...note.ledger ?? emptyLedger(), ...clone(patch) };
        note.rev = rev + 1;
        await put(tx, STORES.notes, note);
        return { rev: note.rev };
      }),

    putTranscript: ({ id, transcript }) =>
      transact(db, [STORES.notes, STORES.tombstones, STORES.transcripts], "readwrite", async (tx) => {
        await checkedNote(tx, id);
        if (transcript.noteId !== id) throw failure("transcript_note_mismatch");
        await put(tx, STORES.transcripts, { id, transcript: clone(transcript) });
      }),

    getTranscript: ({ id }) =>
      transact(db, [STORES.notes, STORES.tombstones, STORES.transcripts], "readonly", async (tx) => {
        await checkedNote(tx, id);
        const row = await get<{ id: string; transcript: LocalTranscript }>(tx, STORES.transcripts, id);
        return { transcript: row ? clone(row.transcript) : null };
      }),

    listQuarantine: () =>
      transact(db, [STORES.quarantine], "readonly", async (tx) => ({
        items: (await all<QuarantineRow>(tx, STORES.quarantine)).map(({ id, reason, sizeBytes }) => ({ id, reason, sizeBytes })),
      })),

    async discardFailedRecording({ id }) {
      const found = await transact(db, [STORES.quarantine], "readonly", (tx) => get(tx, STORES.quarantine, id));
      if (!found) throw failure("not_found");
      await removeQuarantined(id);
    },

    async deleteQuarantined({ id }) { await removeQuarantined(id); },

    listOutbox: ({ did }) =>
      transact(db, [STORES.outbox], "readonly", async (tx) => ({
        entries: clone((await all<OutboxEntry>(tx, STORES.outbox)).filter((entry) => entry.did === did)),
      })),

    completeOutbox: ({ entryId, result }) =>
      transact(db, [STORES.outbox], "readwrite", async (tx) => {
        const entry = await get<OutboxEntry>(tx, STORES.outbox, entryId);
        if (!entry) throw failure("not_found");
        if (result === "done") await del(tx, STORES.outbox, entryId);
        else await put(tx, STORES.outbox, { ...entry, state: result === "retry" ? "pending" : result, attempts: entry.attempts + 1 });
      }),
  };

  async function removeQuarantined(id: string) {
    await before("tombstone", id);
    await transact(db, [STORES.quarantine, STORES.sessions, STORES.tombstones], "readwrite", async (tx) => {
      await put(tx, STORES.tombstones, { id, at: now(), audioPending: true } satisfies TombstoneRow);
      await del(tx, STORES.quarantine, id);
      await del(tx, STORES.sessions, id);
    });
    await finishAudioDelete(id);
  }

  async function recoverOne(id: string): Promise<{ recovered?: VoiceNoteRecording; failed?: RecoveryResult["failed"][number] }> {
    await before("recovery:attempt", id);
    const attempt = await transact(db, [STORES.sessions], "readwrite", async (tx) => {
      const row = await get<SessionRecord>(tx, STORES.sessions, id);
      if (!row) return null;
      const next = { ...row, recoveryAttempts: row.recoveryAttempts + 1 };
      await put(tx, STORES.sessions, next);
      return next;
    });
    if (!attempt) return {};
    if (attempt.recoveryAttempts > MAX_RECOVERY_ATTEMPTS) return { failed: await quarantine(attempt, "recovery_failed", "recovery kept failing") };
    try {
      const size = await audio.size(id);
      if (size === 0) {
        await store.dropEmptySession(id);
        return {};
      }
      const recording = await store.commitSession(id, (session, sizeBytes) => recordingFromSession(session, sizeBytes, {
        endedAt: Math.max(session.startedAt, session.lastHeartbeatAt), durationMs: session.audioMs,
        recovered: true, endedUnexpectedly: true, exitReason: null,
      }));
      return recording ? { recovered: recording } : {};
    } catch (error) {
      console.error("[webStore] Recovering an interrupted recording failed", id, error);
      if (attempt.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        return { failed: await quarantine(attempt, "recovery_failed", error instanceof Error ? error.message : String(error)) };
      }
      return { failed: { id, reason: "recovery_failed", error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function quarantine(session: SessionRecord, reason: string, error: string) {
    await before("quarantine:write", session.id);
    const sizeBytes = await audio.size(session.id);
    await transact(db, [STORES.quarantine, STORES.sessions], "readwrite", async (tx) => {
      await put(tx, STORES.quarantine, { id: session.id, reason, error, sizeBytes, session } satisfies QuarantineRow);
      await del(tx, STORES.sessions, session.id);
    });
    return { id: session.id, reason, error };
  }

  return store;
}
