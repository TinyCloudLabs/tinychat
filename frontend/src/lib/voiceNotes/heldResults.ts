import { registerHeldConflictPin, removeHeldConflictPin } from "./heldConflictPins";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PrivateCloudError } from "../privateCloud";
import { VoiceNotes } from "./nativeVoiceNotes";
import { readVoiceNoteForTranscription, type VoiceNoteTranscriptSave } from "./voiceNoteStore";
import { isAccountWorkAllowed } from "./accountContext";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { preserveVoiceNoteTranscriptHistory, transcriptHistoryKvKey } from "./voiceNoteTranscriptHistory";
import { transcriptHash } from "./voiceNoteRows";
import { browserIdbEnv, request, transact, type IdbEnv } from "./web/idb";

export type HeldEngine = "private-cloud" | "assemblyai";
export type HeldIntent = { kind: "rerun"; base: { rev: number; hash: string } } | { kind: "unknown" };
export interface HeldResult {
  version: 1;
  did: string;
  spaceId: string;
  sourceId: string;
  holdId: string;
  engine: HeldEngine;
  transcript: VoiceNoteTranscriptSave;
  hash: string;
  provider: { transcriptionId: string } | { handle: string } | null;
  intent: HeldIntent;
  overrideCommitted?: boolean;
  conflict?: "base_mismatch" | "rerun_lost";
  heldAt: number;
  bytes: number;
}
export type HeldSummary = Pick<HeldResult, "sourceId" | "engine" | "holdId" | "bytes" | "conflict"> & { rev: number };
export type HeldResultInput = Omit<HeldResult, "holdId" | "heldAt" | "bytes" | "hash" | "conflict">;
export type HoldReceipt = { holdId: string; rev: number; durability: "persistent" | "best-effort" };
export type SaveHeldOutcome = "committed" | "already_committed" | "discarded_superseded" | "conflict" | "lock_busy";
export interface HeldResultStore {
  hold(row: HeldResultInput): Promise<HoldReceipt>;
  readHeld(sourceId: string): Promise<HeldResult | null>;
  listHeld(): Promise<HeldSummary[]>;
  saveHeldFirst(tcw: TinyCloudWeb, sourceId: string, ops: {
    save(row: HeldResult): Promise<void>;
    afterCommit(row: HeldResult): Promise<void>;
    stillCurrent?: () => boolean;
  }, mode: "automatic" | "explicit"): Promise<SaveHeldOutcome>;
  discard(tcw: TinyCloudWeb, sourceId: string, holdId: string,
    reason: "note_gone" | "committed_at_or_above" | "user_discarded"): Promise<void>;
  heldHint(sourceId: string): boolean;
  durability(): Promise<"persistent" | "best-effort" | "unavailable">;
}

export const HELD_RESULTS_DB = "exo-held-results";
export const HELD_RESULTS_DB_VERSION = 1;
export const HELD_RESULTS_STORE = "held";
export const MAX_HELD_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_HELD_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_HELD_TOTAL_ENTRIES = 200;
export const MAX_HELD_DID_BYTES = MAX_HELD_TOTAL_BYTES / 4;
export const MAX_HELD_DID_ENTRIES = MAX_HELD_TOTAL_ENTRIES / 4;
const CHANNEL_NAME = "exo-held-results";
const memoryLocks = new Map<string, Promise<void>>();

interface HeldDatabaseEnv extends IdbEnv { storage?: StorageManager }
function openHeldDb(env: IdbEnv): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = env.factory.open(HELD_RESULTS_DB, HELD_RESULTS_DB_VERSION);
    open.onupgradeneeded = () => open.result.createObjectStore(HELD_RESULTS_STORE, { keyPath: ["did", "sourceId"] });
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(Object.assign(new Error("blocked"), { code: "unavailable" }));
  });
}

function fixedFailure(reason: string): PrivateCloudError {
  const safeReason = ["quota", "store_full", "too_large", "unavailable", "no_space", "io", "corrupt", "held_rev_conflict"].includes(reason)
    ? reason : "io";
  return Object.assign(new PrivateCloudError("held_result_persistence_failed", "The completed transcript could not be kept in this device's held-result store."), {
    reason: safeReason,
  });
}
function mapFailure(error: unknown): PrivateCloudError {
  const code = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  const reason = error && typeof error === "object" && "reason" in error
    ? String((error as { reason: unknown }).reason)
    : error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "QuotaExceededError") return fixedFailure("quota");
  if (["unavailable", "no_space", "store_full", "too_large", "held_rev_conflict", "corrupt"].includes(reason)) return fixedFailure(reason);
  if (code === "NotFoundError" || code === "SecurityError" || code === "InvalidStateError") return fixedFailure("unavailable");
  return fixedFailure("io");
}
function assertIdentity(tcw: TinyCloudWeb, did: string, row: HeldResult): void {
  if (tcw.did !== did || tcw.spaceId !== row.spaceId || !isAccountWorkAllowed(tcw))
    throw new PrivateCloudError("voice_note_account_mismatch", "The active account cannot commit this held transcript.");
}
function recordBytes(row: Omit<HeldResult, "bytes">): number {
  let bytes = 0;
  for (let pass = 0; pass < 3; pass++) {
    const next = new TextEncoder().encode(JSON.stringify({ ...row, bytes })).byteLength;
    if (next === bytes) return bytes;
    bytes = next;
  }
  return new TextEncoder().encode(JSON.stringify({ ...row, bytes })).byteLength;
}
function summarize(row: HeldResult): HeldSummary {
  return { sourceId: row.sourceId, engine: row.engine, holdId: row.holdId, bytes: row.bytes,
    ...(row.conflict ? { conflict: row.conflict } : {}), rev: row.transcript.rev };
}
function isHeldResult(value: unknown): value is HeldResult {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<HeldResult>;
  return row.version === 1 && typeof row.did === "string" && typeof row.spaceId === "string"
    && typeof row.sourceId === "string" && typeof row.holdId === "string" && Number.isSafeInteger(row.transcript?.rev)
    && Array.isArray(row.transcript?.sentences) && typeof row.hash === "string" && Number.isSafeInteger(row.bytes);
}

function historyConfirmsHeldResult(value: unknown, row: HeldResult): boolean {
  let parsed: unknown;
  try {
    const text = typeof value === "string" ? value
      : value instanceof Uint8Array ? new TextDecoder().decode(value) : null;
    if (text === null) return false;
    parsed = JSON.parse(text) as unknown;
  } catch { return false; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as { v?: unknown; rev?: unknown; hash?: unknown };
  return record.v === 1 && record.rev === row.transcript.rev && record.hash === row.hash;
}
async function withFallbackLock<T>(key: string, run: () => Promise<T>, wait: boolean): Promise<T | "busy"> {
  const current = memoryLocks.get(key);
  if (current && !wait) return "busy";
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  memoryLocks.set(key, tail);
  if (current) await current;
  try { return await run(); }
  finally { release(); if (memoryLocks.get(key) === tail) memoryLocks.delete(key); }
}
async function withHeldLock<T>(did: string, sourceId: string, run: () => Promise<T>, wait: boolean): Promise<T | "busy"> {
  const name = `exo-held-result:${did}:${sourceId}`;
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(name, { mode: "exclusive", ...(wait ? {} : { ifAvailable: true }) }, async (lock) => {
      if (!lock) return "busy";
      return run();
    });
  }
  return withFallbackLock(name, run, wait);
}

export interface HeldResultStoreOptions {
  env?: HeldDatabaseEnv;
  now?: () => number;
  newId?: () => string;
  isSignedIn?: (did: string) => Promise<boolean>;
}

export function createHeldResultStore(did: string, options: HeldResultStoreOptions = {}): HeldResultStore {
  const env = options.env;
  const storage = env?.storage ?? (typeof navigator === "undefined" ? undefined : navigator.storage);
  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const isSignedIn = options.isSignedIn ?? (async (accountDid) => {
    const state = await VoiceNotes.getCaptureDefaults();
    return state.status === "signed_in" && state.accountDid === accountDid;
  });
  const assertStoreIdentity = async (tcw: TinyCloudWeb, row: HeldResult) => {
    assertIdentity(tcw, did, row);
    if (!await isSignedIn(did))
      throw new PrivateCloudError("voice_note_account_mismatch", "The active account cannot commit this held transcript.");
  };
  let dbPromise: Promise<IDBDatabase> | null = null;
  let channel: BroadcastChannel | null = null;
  const hints = new Set<string>();
  const db = () => dbPromise ??= openHeldDb(env ?? browserIdbEnv()).catch((error: unknown) => { throw mapFailure(error); });
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data as { did?: unknown; sourceId?: unknown } | null;
      if (value?.did === did && typeof value.sourceId === "string") hints.add(value.sourceId);
    };
  }
  const notify = (sourceId: string) => {
    hints.add(sourceId);
    channel?.postMessage({ did, sourceId });
  };
  const read = async (sourceId: string): Promise<HeldResult | null> => {
    try {
      const row = await transact(await db(), [HELD_RESULTS_STORE], "readonly", (tx) => request(tx.objectStore(HELD_RESULTS_STORE).get([did, sourceId])));
      if (row === undefined) { hints.delete(sourceId); return null; }
      if (!isHeldResult(row)) throw fixedFailure("corrupt");
      if (row.conflict) await registerHeldConflictPin(did, sourceId);
      else removeHeldConflictPin(did, sourceId);
      return row;
    } catch (error) { throw mapFailure(error); }
  };
  const removeIf = async (tcw: TinyCloudWeb, row: HeldResult, maxRev: number,
    authorize: (tcw: TinyCloudWeb, row: HeldResult) => Promise<void>): Promise<boolean> => {
    const database = await db();
    await authorize(tcw, row);
    assertIdentity(tcw, did, row);
    const removed = await transact(database, [HELD_RESULTS_STORE], "readwrite", async (tx) => {
      const objectStore = tx.objectStore(HELD_RESULTS_STORE);
      const value = await request(objectStore.get([did, row.sourceId]));
      if (!isHeldResult(value) || value.did !== did || value.spaceId !== row.spaceId
        || value.holdId !== row.holdId || value.transcript.rev > maxRev) return false;
      assertIdentity(tcw, did, row);
      objectStore.delete([did, row.sourceId]);
      return true;
    });
    if (removed) { hints.delete(row.sourceId); removeHeldConflictPin(did, row.sourceId); notify(row.sourceId); }
    return removed;
  };
  const store: HeldResultStore = {
    async hold(input) {
      if (input.did !== did) throw fixedFailure("unavailable");
      if (!input.spaceId) throw fixedFailure("no_space");
      const hash = await transcriptHash(input.transcript.sentences);
      const holdId = newId();
      const base = { ...input, version: 1 as const, holdId, hash, heldAt: now() };
      const bytes = recordBytes(base);
      if (bytes > MAX_HELD_ENTRY_BYTES) throw fixedFailure("too_large");
      const row: HeldResult = { ...base, bytes };
      try {
        const receipt = await transact(await db(), [HELD_RESULTS_STORE], "readwrite", async (tx) => {
          const objectStore = tx.objectStore(HELD_RESULTS_STORE);
          const entries = (await request(objectStore.getAll())) as HeldResult[];
          let totalBytes = 0, didBytes = 0, replacesExisting = false;
          for (const old of entries) {
            if (!isHeldResult(old)) throw fixedFailure("corrupt");
            totalBytes += old.bytes;
            if (old.did === did) didBytes += old.bytes;
            if (old.did === did && old.sourceId === input.sourceId) {
              replacesExisting = true;
              if (old.transcript.rev > input.transcript.rev) return { holdId: old.holdId, rev: old.transcript.rev };
              if (old.transcript.rev === input.transcript.rev) {
                if (old.hash !== hash) throw fixedFailure("held_rev_conflict");
                return { holdId: old.holdId, rev: old.transcript.rev };
              }
              totalBytes -= old.bytes;
              didBytes -= old.bytes;
            }
          }
          const didCount = entries.filter((old) => old.did === did && old.sourceId !== input.sourceId).length;
          if (didBytes + bytes > MAX_HELD_DID_BYTES || didCount >= MAX_HELD_DID_ENTRIES
            || totalBytes + bytes > MAX_HELD_TOTAL_BYTES
            || entries.length - Number(replacesExisting) >= MAX_HELD_TOTAL_ENTRIES)
            throw fixedFailure("store_full");
          objectStore.put(row);
          return { holdId, rev: row.transcript.rev };
        });
        const stored = await read(input.sourceId);
        if (!stored || stored.holdId !== receipt.holdId) throw fixedFailure("io");
        notify(input.sourceId);
        const durability = await store.durability();
        if (durability === "unavailable") throw fixedFailure("unavailable");
        return { ...receipt, durability };
      } catch (error) { throw mapFailure(error); }
    },
    readHeld: read,
    async listHeld() {
      try {
        const keyRange = env?.keyRange ?? browserIdbEnv().keyRange;
        const rows = await transact(await db(), [HELD_RESULTS_STORE], "readonly",
          (tx) => request(tx.objectStore(HELD_RESULTS_STORE).getAll(keyRange.bound([did, ""], [did, "\uffff"]))));
        const summaries: HeldSummary[] = [];
        hints.clear();
        for (const row of rows as unknown[]) {
          if (!isHeldResult(row)) throw fixedFailure("corrupt");
          if (row.did === did) {
            summaries.push(summarize(row));
            if (row.conflict) await registerHeldConflictPin(did, row.sourceId);
            else removeHeldConflictPin(did, row.sourceId);
            hints.add(row.sourceId);
          }
        }
        return summaries;
      } catch (error) { throw mapFailure(error); }
    },
    async saveHeldFirst(tcw, sourceId, ops, mode) {
      const run = async (): Promise<SaveHeldOutcome> => {
        const row = await read(sourceId);
        if (!row) return "discarded_superseded";
        assertIdentity(tcw, did, row);
        if (ops.stillCurrent && !ops.stillCurrent()) throw new PrivateCloudError("account_changed", "The account changed during the held transcript commit.");
        await assertStoreIdentity(tcw, row);
        assertIdentity(tcw, did, row);
        let current = await readTranscriptCommit(tcw, sourceId);
        if (current === null || current.rev < row.transcript.rev) {
          if (row.intent.kind === "rerun") {
            if (current?.rev !== row.intent.base.rev || current.hash !== row.intent.base.hash) {
              await replaceConflict(row, "base_mismatch");
              return "conflict";
            }
            await preserveVoiceNoteTranscriptHistory(tcw, current, () => assertIdentity(tcw, did, row));
          } else if (current !== null) {
            await preserveVoiceNoteTranscriptHistory(tcw, current, () => assertIdentity(tcw, did, row));
          }
          await ops.save(row);
          assertIdentity(tcw, did, row);
          await assertStoreIdentity(tcw, row);
          assertIdentity(tcw, did, row);
          current = await readTranscriptCommit(tcw, sourceId);
          if (!current || current.rev < row.transcript.rev || current.rev === row.transcript.rev && current.hash !== row.hash)
            throw new PrivateCloudError("transcript_save_failed", "The held transcript commit could not be verified.");
          await removeIf(tcw, row, current.rev, assertStoreIdentity);
          await ops.afterCommit(row);
          return "committed";
        }
        if (current.rev === row.transcript.rev && current.hash === row.hash) {
          assertIdentity(tcw, did, row);
          await removeIf(tcw, row, current.rev, assertStoreIdentity);
          await ops.afterCommit(row);
          return "already_committed";
        }
        if (row.intent.kind === "rerun" && (current.rev > row.transcript.rev || current.rev === row.transcript.rev && current.hash !== row.hash)) {
          assertIdentity(tcw, did, row);
          await assertStoreIdentity(tcw, row);
          assertIdentity(tcw, did, row);
          let historyExists = false;
          try {
            const history = await tcw.kv.get(transcriptHistoryKvKey(sourceId, row.transcript.rev, row.hash));
            historyExists = history.ok && historyConfirmsHeldResult(history.data.data, row);
          } catch { /* A failed KV read is absent, never proof of commit. */ }
          if (historyExists) {
            assertIdentity(tcw, did, row);
            await removeIf(tcw, row, current.rev, assertStoreIdentity);
            await ops.afterCommit(row);
            return "discarded_superseded";
          }
          await replaceConflict(row, "rerun_lost");
          return "conflict";
        }
        if (row.intent.kind === "unknown" && (current.rev > row.transcript.rev || current.rev === row.transcript.rev)) {
          assertIdentity(tcw, did, row);
          await removeIf(tcw, row, current.rev, assertStoreIdentity);
          await ops.afterCommit(row);
          return "discarded_superseded";
        }
        return "conflict";
      };
      const outcome = await withHeldLock(did, sourceId, run, mode === "explicit");
      return outcome === "busy" ? "lock_busy" : outcome;
    },
    async discard(tcw, sourceId, holdId, reason) {
      await withHeldLock(did, sourceId, async () => {
        const row = await read(sourceId);
        if (!row || row.holdId !== holdId) return;
        assertIdentity(tcw, did, row);
        if (reason === "note_gone") {
          await assertStoreIdentity(tcw, row);
          assertIdentity(tcw, did, row);
          const note = await readVoiceNoteForTranscription(tcw, sourceId);
          if (!note.ok) throw new PrivateCloudError("note_unreadable", note.error.message);
          assertIdentity(tcw, did, row);
          if (note.data !== null) return;
        } else if (reason === "committed_at_or_above") {
          await assertStoreIdentity(tcw, row);
          assertIdentity(tcw, did, row);
          const winner = await readTranscriptCommit(tcw, sourceId);
          assertIdentity(tcw, did, row);
          if (!winner) return;
          let provesHeldCommit = winner.rev === row.transcript.rev && winner.hash === row.hash;
          if (!provesHeldCommit && winner.rev > row.transcript.rev) {
            assertIdentity(tcw, did, row);
            try {
              const history = await tcw.kv.get(transcriptHistoryKvKey(sourceId, row.transcript.rev, row.hash));
              provesHeldCommit = history.ok && historyConfirmsHeldResult(history.data.data, row);
            } catch { /* A failed history read is not proof that the held result committed. */ }
            assertIdentity(tcw, did, row);
          }
          if (!provesHeldCommit) return;
        }
        assertIdentity(tcw, did, row);
        await removeIf(tcw, row, reason === "user_discarded" ? row.transcript.rev : Number.MAX_SAFE_INTEGER, assertStoreIdentity);
      }, false);
    },
    heldHint: (sourceId) => hints.has(sourceId),
    async durability() {
      try { return await storage?.persisted?.() ? "persistent" : "best-effort"; }
      catch { return "best-effort"; }
    },
  };
  async function replaceConflict(row: HeldResult, conflict: NonNullable<HeldResult["conflict"]>): Promise<void> {
    await transact(await db(), [HELD_RESULTS_STORE], "readwrite", async (tx) => {
      const objectStore = tx.objectStore(HELD_RESULTS_STORE);
      const current = await request(objectStore.get([did, row.sourceId]));
      if (!isHeldResult(current) || current.holdId !== row.holdId) return;
      objectStore.put({ ...current, conflict });
    });
    await registerHeldConflictPin(did, row.sourceId);
    notify(row.sourceId);
  }
  return store;
}
