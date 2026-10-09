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
import {
  browserDecodeCheck, DECODE_WINDOW_MAX_BYTES, DECODE_WINDOW_MS, DECODE_WINDOW_SOFT_BYTES, DecodeCheckError, type DecodeCheck,
} from "./decodeCheck";
import { browserIdbEnv, failure, openWebDb, request, STORES, transact, type IdbEnv } from "./idb";

export { failure, DecodeCheckError };
export type { AudioBlobStore, DecodeCheck };

/** One native call never moves more than this much audio (matches the shells). */
export const MAX_READ_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_RECOVERY_ATTEMPTS = 3;
/** Quarantine reason of a recovered prefix the browser cannot decode. */
export const UNDECODABLE_REASON = "undecodable_audio";
/** Recovery could not run its decoder; the recording is untouched and recovery is retried. */
export const DECODER_UNAVAILABLE_REASON = "decoder_unavailable";
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
  /**
   * Where the prefix decode of a long recording ends: the first chunk boundary at which the recording
   * reached DECODE_WINDOW_MS of audio (or DECODE_WINDOW_SOFT_BYTES). Set once, in the same transaction as
   * the chunk that closes it. Absent while the recording is still shorter than that.
   */
  decodeWindow?: { bytes: number; audioMs: number };
}

export type SessionInit = Omit<SessionRecord, "audioMs" | "bytes" | "pausedMs" | "pauseStartedAt" | "spans" | "firstAudioAt"
  | "lastHeartbeatAt" | "recoveryAttempts" | "intent" | "decodeWindow">;

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
  /** Validates a bounded window of a recovered recording before it is published. Default: the browser's decoder; null skips validation (tests). */
  decodeCheck?: DecodeCheck | null;
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
  /**
   * Appends the chunk and journals `progress` (plus the new byte total); both are durable when this
   * resolves. With a transactional blob store they commit as one transaction: a failure leaves neither.
   * With any other store the bytes are durable first; if the journal write then fails, the error carries
   * `durableBytes` (see journalFailure) and the bytes are kept: the blob store's size is the truth.
   */
  appendChunk(id: string, bytes: Uint8Array, progress: Partial<SessionRecord>): Promise<void>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;
  /**
   * Seals the audio and turns the session into a pending recording in one transaction. `build` runs inside
   * that transaction on the session as journaled right then (so an owner claimed by another tab is kept);
   * `progress` is what the caller knows to be durable and the journal may lag behind on. Null if the id was
   * discarded meanwhile.
   */
  commitSession(id: string, build: (session: SessionRecord, sizeBytes: number) => VoiceNoteRecording,
    progress?: Pick<SessionRecord, "audioMs" | "bytes" | "firstAudioAt">): Promise<VoiceNoteRecording | null>;
  /** The whole audio of a pending recording, for playback. */
  readNoteAudio(id: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** Drops a session that captured nothing (no tombstone: there is nothing to protect). Rejects `audio_not_empty` rather than delete durable bytes. */
  dropEmptySession(id: string): Promise<void>;
  /** Durably marks a live session discarded before native capture is stopped. */
  tombstoneSession(id: string): Promise<void>;
  hasTombstone(id: string): Promise<boolean>;
  /** Discards a session and its audio and tombstones the id. */
  discardSession(id: string): Promise<void>;
  /** Quarantines a native segment failure while retaining every durable byte. */
  quarantineInterrupted(id: string, reason: string, error: string): Promise<RecoveryResult["failed"][number]>;
  /** Commits every session whose tab died before it was committed. */
  recoverInterruptedSessions(): Promise<RecoveryResult>;
  /** Finishes audio deletes a crash interrupted. */
  sweepTombstones(): Promise<void>;
  /** Moves a quarantined (or decoder_unavailable) recording back to the recovery queue; call recoverInterruptedSessions after. */
  rearmQuarantined(id: string): Promise<void>;
  /** Who owns a recording that failed recovery (a session or a quarantine row): its owner DID, null if unclaimed, undefined if it is gone. */
  recoveryOwner(id: string): Promise<string | null | undefined>;
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

/** A journal write failed after the blob store had already made `durableBytes` durable. */
export function journalFailure(error: unknown, durableBytes: number): Error & { durableBytes: number } {
  const base = error instanceof Error ? error : new Error(String(error));
  return Object.assign(base, { durableBytes });
}
export const durableBytesOf = (error: unknown): number | null =>
  typeof (error as { durableBytes?: unknown } | null)?.durableBytes === "number" ? (error as { durableBytes: number }).durableBytes : null;

/**
 * The duration of a recovered recording whose audio is `actualBytes` long. The duration is never
 * measured by decoding (a long recording is decoded only as a prefix); it comes from the
 * session journal, which counted audioMs and bytes together.
 *  - Transactional blob store (the IndexedDB one): bytes and journal commit as one transaction, so
 *    `actualBytes === session.bytes` and the journal's audioMs is exact.
 *  - A store that cannot join the journal's transaction (TC-880's files): the bytes can be ahead of the
 *    journal by at most the last appended chunk (a failed journal write stops the recording, and the tab
 *    dying between the two leaves one chunk). That tail's duration is estimated at the recording's own
 *    average rate, audioMs * actualBytes / session.bytes. The only error is that chunk's bitrate
 *    variance, at most one timeslice (about 1 s), and the estimate never moves a duration backwards.
 *  - A journal that never saw a byte has nothing to scale. The recording is then one chunk, so it is
 *    decoded whole and the decoder's measurement is exact.
 */
function reconciledDurationMs(session: SessionRecord, actualBytes: number, decodedMs: number): number {
  if (actualBytes === session.bytes) return session.audioMs;
  if (session.bytes > 0) return Math.round(session.audioMs * actualBytes / session.bytes);
  if (decodedMs === 0) console.warn("[webStore] A recovered recording has no journaled duration and no decoder measured it", session.id);
  return decodedMs;
}

function outboxEntryFor(
  receipt: RemoteOpReceipt,
  result: { handle?: string; uploadId?: string; uploadUrl?: string; jobId?: string; handleExpiresAt?: number;
    outcome: "created" | "failed" | "unknown" },
  old: OutboxEntry | undefined,
): OutboxEntry | null {
  if (result.outcome === "failed") return null;
  const entryId = `${receipt.id}:${receipt.opId}`;
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
  return { entryId, did: receipt.did, provider: receipt.provider, mode: receipt.mode, kind, receiptKind: receipt.kind, handle,
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
  const decodeCheck = options.decodeCheck === undefined ? browserDecodeCheck() : options.decodeCheck;

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
      const journalIn = async (tx: IDBTransaction, bytesNow: number) => {
        const row = await get<SessionRecord>(tx, STORES.sessions, id);
        if (!row) throw failure("not_found", `Session ${id} is gone.`);
        const closesWindow = row.decodeWindow === undefined
          && ((progress.audioMs ?? row.audioMs) >= DECODE_WINDOW_MS || bytesNow >= DECODE_WINDOW_SOFT_BYTES);
        await put(tx, STORES.sessions, { ...row, ...clone(progress), id, bytes: bytesNow, lastHeartbeatAt: now(),
          ...(closesWindow ? { decodeWindow: { bytes: bytesNow, audioMs: progress.audioMs ?? row.audioMs } } : {}) });
      };
      const joint = audio.transactional;
      if (joint) {
        await transact(db, [STORES.sessions, ...joint.stores], "readwrite", async (tx) => {
          const bytesNow = await joint.appendIn(tx, id, bytes);
          await before("session:progress", id);
          await journalIn(tx, bytesNow);
        });
        return;
      }
      const bytesNow = await audio.append(id, bytes);
      try {
        await before("session:progress", id);
        await transact(db, [STORES.sessions], "readwrite", (tx) => journalIn(tx, bytesNow));
      } catch (error) {
        throw journalFailure(error, bytesNow);
      }
    },

    async updateSession(id, patch) {
      await before("session:update", id);
      await transact(db, [STORES.sessions], "readwrite", async (tx) => {
        const row = await get<SessionRecord>(tx, STORES.sessions, id);
        if (!row) throw failure("not_found", `Session ${id} is gone.`);
        await put(tx, STORES.sessions, { ...row, ...clone(patch), id });
      });
    },

    async commitSession(id, build, progress) {
      await before("audio:finalize", id);
      const sizeBytes = await audio.finalize(id);
      await before("note:commit", id);
      const recording = await transact(db, [STORES.sessions, STORES.notes, STORES.tombstones], "readwrite", async (tx) => {
        const session = await get<SessionRecord>(tx, STORES.sessions, id);
        if (!session) return null;
        const tombstoned = await get(tx, STORES.tombstones, id);
        await del(tx, STORES.sessions, id);
        if (tombstoned) return null;
        const built = build(clone({ ...session, ...progress }), sizeBytes);
        await put(tx, STORES.notes, built);
        return built;
      });
      return recording ? clone(recording) : null;
    },

    async readNoteAudio(id) {
      const note = await transact(db, [STORES.notes, STORES.tombstones], "readonly", (tx) => checkedNote(tx, id));
      return { bytes: await audio.read(id, 0, await audio.size(id)), mimeType: note.mimeType };
    },

    async dropEmptySession(id) {
      if ((await audio.size(id)) > 0) throw failure("audio_not_empty", `Recording ${id} has durable audio; it is not dropped.`);
      await before("audio:delete", id);
      await audio.delete(id);
      await transact(db, [STORES.sessions], "readwrite", (tx) => del(tx, STORES.sessions, id));
    },

    async tombstoneSession(id) {
      await before("tombstone", id);
      await transact(db, [STORES.sessions, STORES.tombstones, STORES.notes, STORES.transcripts], "readwrite", async (tx) => {
        await put(tx, STORES.tombstones, { id, at: now(), audioPending: true } satisfies TombstoneRow);
        await del(tx, STORES.sessions, id);
        await del(tx, STORES.notes, id);
        await del(tx, STORES.transcripts, id);
      });
    },

    hasTombstone: (id) => transact(db, [STORES.tombstones], "readonly", async (tx) =>
      !!(await get(tx, STORES.tombstones, id))),

    async discardSession(id) {
      await store.tombstoneSession(id);
      await finishAudioDelete(id);
    },

    quarantineInterrupted: (id, reason, error) => quarantine(id, reason, error),

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
        if (row) {
          await put(tx, STORES.sessions, { ...row.session, recoveryAttempts: 0 });
          await del(tx, STORES.quarantine, id);
          return;
        }
        // A recording whose recovery could not run (decoder_unavailable) is still a session; retry resets its budget.
        const session = await get<SessionRecord>(tx, STORES.sessions, id);
        if (!session) throw failure("not_found");
        await put(tx, STORES.sessions, { ...session, recoveryAttempts: 0 });
      });
    },

    recoveryOwner: (id) => transact(db, [STORES.sessions, STORES.quarantine], "readonly", async (tx) => {
      const session = await get<SessionRecord>(tx, STORES.sessions, id) ?? (await get<QuarantineRow>(tx, STORES.quarantine, id))?.session;
      return session ? session.owner : undefined;
    }),

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
          // A tombstone means an earlier delete already queued its remote cleanup, and completed
          // outbox entries are gone: walking the ledger and receipts again would resurrect them.
          const existing = await get<TombstoneRow>(tx, STORES.tombstones, id);
          if (existing) return;
          const note = await get<VoiceNoteRecording>(tx, STORES.notes, id);
          await put(tx, STORES.tombstones, { id, at: now(), audioPending: true } satisfies TombstoneRow);
          const outbox = await all<OutboxEntry>(tx, STORES.outbox);
          const receipts = await all<ReceiptRow>(tx, STORES.receipts);
          if (note?.owner) for (const remote of note.ledger?.remote ?? []) {
            if (remote.cleanup === "done" || remote.opId) continue;
            const add = async (kind: OutboxEntry["kind"], handle: string) => {
              const settled = receipts.find((row) => row.result?.handle === handle)?.result;
              await enqueueOutbox(tx, { entryId: `${id}:cleanup:${kind}:${handle}`, did: note.owner!, provider: remote.provider,
                mode: remote.mode, kind, receiptKind: null, handle, handleExpiresAt: settled?.handleExpiresAt ?? null, state: "pending",
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
            const stored = note?.ledger?.remote.find((entry) => entry.opId === receipt.opId);
            const entry = outboxEntryFor(receipt, { outcome: result?.outcome ?? "unknown", handleExpiresAt: result?.handleExpiresAt ?? undefined,
              uploadId: stored?.uploadId ?? undefined, uploadUrl: stored?.uploadUrl ?? undefined, jobId: stored?.jobId ?? undefined },
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
      return transact(db, [STORES.kv, STORES.notes, STORES.sessions, STORES.tombstones, STORES.quarantine], "readwrite", async (tx) => {
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
          for (const parked of await all<QuarantineRow>(tx, STORES.quarantine)) {
            if (!parked.session.owner) await put(tx, STORES.quarantine, { ...parked, session: { ...parked.session, owner: next.accountDid } });
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
        const handle = result.handle ?? result.jobId ?? result.uploadId ?? result.uploadUrl ?? null;
        const previous = row.result;
        if (previous?.outcome === result.outcome && previous.handle === handle &&
            previous.handleExpiresAt === (result.handleExpiresAt ?? null)) {
          return { destination: (tombstoned ? "outbox" : previous.destination) as "ledger" | "outbox" };
        }
        const note = await get<VoiceNoteRecording>(tx, STORES.notes, id);
        if (!note || tombstoned || note.owner !== did) {
          const old = await get<OutboxEntry>(tx, STORES.outbox, key);
          const entry = outboxEntryFor(receipt, result, old);
          if (entry) await enqueueOutbox(tx, entry); else await del(tx, STORES.outbox, key);
          await put(tx, STORES.receipts, { ...row, result: { destination: "outbox", handle: handle ?? previous?.handle ?? null,
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
        await put(tx, STORES.receipts, { ...row, result: { destination: "ledger", handle: handle ?? previous?.handle ?? null,
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
        items: (await all<QuarantineRow>(tx, STORES.quarantine)).map(({ id, reason, sizeBytes, session }) => ({ id, reason, sizeBytes, owner: session.owner })),
      })),

    async discardFailedRecording({ id }) {
      const { found, healthy } = await transact(db, [STORES.quarantine, STORES.notes], "readonly", async (tx) => ({
        found: await get(tx, STORES.quarantine, id), healthy: await get(tx, STORES.notes, id) }));
      if (!found) throw failure(healthy ? "not_failed_recording" : "not_found");
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
    if (attempt.recoveryAttempts > MAX_RECOVERY_ATTEMPTS) return { failed: await quarantine(id, "recovery_failed", "recovery kept failing") };
    try {
      const size = await audio.size(id);
      if (size === 0) {
        await store.dropEmptySession(id);
        return {};
      }
      let decodedMs = 0;
      if (decodeCheck) {
        // Up to the cap the whole recording is decoded, so a failure is a verdict on all of its bytes.
        // Above it only a prefix is decoded, and a prefix is not a file (see decodeCheck.ts): its success
        // proves the recording plays, its failure proves nothing.
        const whole = size <= DECODE_WINDOW_MAX_BYTES;
        const window = await audio.read(id, 0, whole ? size : decodePrefixBytes(attempt));
        try {
          const decoded = await decodeCheck(window, attempt.mimeType);
          if (whole) decodedMs = decoded.durationMs;
        } catch (error) {
          if (!(error instanceof DecodeCheckError)) throw error;
          if (error.kind === "resource") {
            // The decoder could not run; that is not evidence about the bytes. Keep the session, give the
            // attempt back (the budget is for recoveries that fail on the recording), and say so.
            console.error("[webStore] The decoder could not check a recovered recording; it stays recoverable", id, error);
            await refundAttempt(id);
            return { failed: { id, reason: DECODER_UNAVAILABLE_REASON, error: error.message } };
          }
          if (whole) {
            console.error("[webStore] A recovered recording does not decode; quarantining it", id, error);
            return { failed: await quarantine(id, UNDECODABLE_REASON, error.message) };
          }
          console.warn("[webStore] The decoder rejected the leading bytes of a long recovered recording; that is inconclusive, publishing it as recovered", id, error);
        }
      }
      const recording = await store.commitSession(id, (session, sizeBytes) => recordingFromSession(session, sizeBytes, {
        endedAt: Math.max(session.startedAt, session.lastHeartbeatAt), durationMs: reconciledDurationMs(session, sizeBytes, decodedMs),
        recovered: true, endedUnexpectedly: true, exitReason: null,
      }));
      return recording ? { recovered: recording } : {};
    } catch (error) {
      console.error("[webStore] Recovering an interrupted recording failed", id, error);
      if (attempt.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        return { failed: await quarantine(id, "recovery_failed", error instanceof Error ? error.message : String(error)) };
      }
      return { failed: { id, reason: "recovery_failed", error: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * The prefix of a recording larger than the decode cap that the check may see: through the journaled
   * window boundary (a chunk boundary), never more than the cap.
   */
  function decodePrefixBytes(session: SessionRecord): number {
    return Math.min(session.decodeWindow?.bytes ?? DECODE_WINDOW_MAX_BYTES, DECODE_WINDOW_MAX_BYTES);
  }

  async function refundAttempt(id: string) {
    await transact(db, [STORES.sessions], "readwrite", async (tx) => {
      const row = await get<SessionRecord>(tx, STORES.sessions, id);
      if (row && row.recoveryAttempts > 0) await put(tx, STORES.sessions, { ...row, recoveryAttempts: row.recoveryAttempts - 1 });
    });
  }

  /** Moves the session, as journaled right now, to the quarantine queue; its audio stays. */
  async function quarantine(id: string, reason: string, error: string) {
    await before("quarantine:write", id);
    const sizeBytes = await audio.size(id);
    await transact(db, [STORES.quarantine, STORES.sessions], "readwrite", async (tx) => {
      const session = await get<SessionRecord>(tx, STORES.sessions, id);
      if (!session) return;
      await put(tx, STORES.quarantine, { id, reason, error, sizeBytes, session } satisfies QuarantineRow);
      await del(tx, STORES.sessions, id);
    });
    return { id, reason, error };
  }

  return store;
}
