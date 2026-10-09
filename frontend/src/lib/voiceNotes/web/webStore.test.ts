import { describe, expect, test as bunTest } from "bun:test";
import type { RemoteOpReceipt } from "../nativeVoiceNotes";
import { base64ToBytes } from "../voiceNoteAudio";
import { createIdbAudioBlobStore } from "./audioBlobStore";
import { openWebDb } from "./idb";
import { newIdbEnv } from "./testing/idb";
import { FakeClock, slowTest } from "./webTestKit";
import {
  MAX_READ_CHUNK_BYTES, MAX_RECOVERY_ATTEMPTS, memoryLocks, openWebStore, recordingFromSession, sessionLock, type StoreOp,
  type WebStore, type WebStoreOptions,
} from "./webStore";

const test = slowTest(bunTest);

const code = (value: string) => expect.objectContaining({ code: value });
const bytesOf = (length: number, seed = 1) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 255);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

function harness(initial: Partial<WebStoreOptions> = {}) {
  const env = newIdbEnv();
  const clock = new FakeClock();
  const locks = memoryLocks();
  const open = (options: Partial<WebStoreOptions> = {}) => openWebStore({ env, locks, now: clock.now, ...initial, ...options });
  return { env, clock, locks, open };
}

const init = (id: string, owner: string | null = null) => ({
  id, startedAt: 1000, source: "in_app" as const, owner, transitionGen: 0, options: { transcriber: "on-device" as const, identifySpeakers: false },
  mimeType: "audio/webm;codecs=opus", input: null, maxDurationMs: 3 * 60 * 60 * 1000,
});

/** A session with the given chunks journaled; returns the bytes in order. */
async function record(store: WebStore, id: string, chunks: Uint8Array[], owner: string | null = null) {
  await store.beginSession(init(id, owner));
  let audioMs = 0;
  for (const chunk of chunks) {
    audioMs += 1000;
    await store.appendChunk(id, chunk, { audioMs, firstAudioAt: 1500 });
  }
  return concat(...chunks);
}

const commit = (store: WebStore, id: string) =>
  store.commitSession(id, (session, size) => recordingFromSession(session, size, {
    endedAt: 9000, durationMs: session.audioMs, recovered: false, endedUnexpectedly: false, exitReason: null,
  }));

async function noteWith(store: WebStore, id: string, chunks = [bytesOf(10)], owner: string | null = null) {
  await record(store, id, chunks, owner);
  return (await commit(store, id))!;
}

async function readAll(store: WebStore, id: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let offset = 0;;) {
    const chunk = await store.readAudioChunk({ id, offset, length: MAX_READ_CHUNK_BYTES });
    parts.push(base64ToBytes(chunk.base64));
    offset += chunk.bytesRead;
    if (chunk.eof) return concat(...parts);
  }
}

describe("IDB audio blob store", () => {
  test("every (offset, length) read is byte-exact across chunk boundaries", async () => {
    const env = newIdbEnv();
    const db = await openWebDb(env, "audio-test");
    const audio = createIdbAudioBlobStore(db, env);
    const chunks = [bytesOf(3, 1), bytesOf(5, 2), bytesOf(1, 3), bytesOf(7, 4)];
    let total = 0;
    for (const chunk of chunks) total = await audio.append("a", chunk);
    expect(total).toBe(16);
    expect(await audio.size("a")).toBe(16);
    const whole = concat(...chunks);
    for (let offset = 0; offset <= 18; offset++) {
      for (let length = 1; length <= 18; length++) {
        const expected = whole.subarray(Math.min(offset, 16), Math.min(offset + length, 16));
        expect(Array.from(await audio.read("a", offset, length))).toEqual(Array.from(expected));
      }
    }
    expect(await audio.size("missing")).toBe(0);
    expect((await audio.read("missing", 0, 10)).length).toBe(0);
  });

  test("appends survive an empty chunk, a sealed recording refuses more, and delete removes every byte", async () => {
    const env = newIdbEnv();
    const audio = createIdbAudioBlobStore(await openWebDb(env, "audio-test"), env);
    await audio.append("a", bytesOf(4));
    expect(await audio.append("a", new Uint8Array(0))).toBe(4);
    expect(await audio.finalize("a")).toBe(4);
    expect(await audio.finalize("a")).toBe(4);
    await expect(audio.append("a", bytesOf(1))).rejects.toEqual(code("audio_finalized"));
    await audio.delete("a");
    expect(await audio.size("a")).toBe(0);
    await audio.delete("a");
    await audio.append("a", bytesOf(2));
    expect(await audio.size("a")).toBe(2);
  });

  test("recordings do not see each other's bytes", async () => {
    const env = newIdbEnv();
    const audio = createIdbAudioBlobStore(await openWebDb(env, "audio-test"), env);
    await audio.append("a", bytesOf(6, 1));
    await audio.append("b", bytesOf(6, 9));
    expect(Array.from(await audio.read("a", 0, 100))).toEqual(Array.from(bytesOf(6, 1)));
    expect(Array.from(await audio.read("b", 4, 100))).toEqual(Array.from(bytesOf(6, 9).subarray(4)));
    await audio.delete("a");
    expect(await audio.size("b")).toBe(6);
  });
});

describe("readAudioChunk", () => {
  test("returns the exact bytes in order, flags eof, and never moves more than 4 MiB per call", async () => {
    const { open } = harness();
    const store = await open();
    const big = [bytesOf(2_200_000, 1), bytesOf(2_200_000, 2), bytesOf(100_000, 4)];
    const sent = await record(store, "n", big);
    const note = (await commit(store, "n"))!;
    expect(note.sizeBytes).toBe(sent.length);
    const first = await store.readAudioChunk({ id: "n", offset: 0, length: 100 * 1024 * 1024 });
    expect(first).toMatchObject({ id: "n", offset: 0, bytesRead: MAX_READ_CHUNK_BYTES, size: sent.length, eof: false });
    expect(same(base64ToBytes(first.base64), sent.subarray(0, MAX_READ_CHUNK_BYTES))).toBe(true);
    expect(same(await readAll(store, "n"), sent)).toBe(true);
    const tail = await store.readAudioChunk({ id: "n", offset: sent.length - 10, length: 100 });
    expect(tail).toMatchObject({ bytesRead: 10, eof: true });
    expect(await store.readAudioChunk({ id: "n", offset: sent.length, length: 5 })).toMatchObject({ bytesRead: 0, base64: "", eof: true });
  }, 60_000);

  test("rejects bad arguments, unknown ids and deleted recordings with contract codes", async () => {
    const { open } = harness();
    const store = await open();
    await noteWith(store, "n");
    await expect(store.readAudioChunk({ id: "n", offset: -1, length: 5 })).rejects.toEqual(code("invalid_argument"));
    await expect(store.readAudioChunk({ id: "n", offset: 0, length: 0 })).rejects.toEqual(code("invalid_argument"));
    await expect(store.readAudioChunk({ id: "n", offset: 0.5, length: 5 })).rejects.toEqual(code("invalid_argument"));
    await expect(store.readAudioChunk({ id: "nope", offset: 0, length: 5 })).rejects.toEqual(code("not_found"));
    await store.deleteAudio({ id: "n" });
    await expect(store.readAudioChunk({ id: "n", offset: 0, length: 5 })).rejects.toEqual(code("tombstoned"));
  });
});

describe("sessions and commit", () => {
  test("a committed note carries the audio size, journaled duration and a first revision", async () => {
    const { open } = harness();
    const store = await open();
    const sent = await record(store, "n", [bytesOf(100), bytesOf(50)]);
    const note = (await commit(store, "n"))!;
    expect(note).toMatchObject({ id: "n", sizeBytes: 150, durationMs: 2000, rev: 1, version: 2, recovered: false, owner: null,
      mimeType: "audio/webm;codecs=opus" });
    expect(await store.getSession("n")).toBeNull();
    expect((await store.listPending()).recordings.map((r) => r.id)).toEqual(["n"]);
    const { bytes, mimeType } = await store.readNoteAudio("n");
    expect(Array.from(bytes)).toEqual(Array.from(sent));
    expect(mimeType).toBe("audio/webm;codecs=opus");
  });

  test("snapshots: callers cannot change stored state through returned objects", async () => {
    const { open } = harness();
    const store = await open();
    await noteWith(store, "n");
    const listed = (await store.listPending()).recordings[0]!;
    listed.owner = "did:evil";
    expect((await store.listPending()).recordings[0]!.owner).toBeNull();
  });

  test("a discarded or deleted id can never be begun again and commit returns null", async () => {
    const { open } = harness();
    const store = await open();
    await record(store, "n", [bytesOf(4)]);
    await store.discardSession("n");
    expect(await store.getSession("n")).toBeNull();
    expect(await store.audio.size("n")).toBe(0);
    await expect(store.beginSession(init("n"))).rejects.toEqual(code("tombstoned"));
    expect(await commit(store, "n")).toBeNull();
    expect((await store.listPending()).recordings).toEqual([]);
  });

  test("dropEmptySession leaves no session and no tombstone", async () => {
    const { open } = harness();
    const store = await open();
    await store.beginSession(init("e"));
    await store.dropEmptySession("e");
    expect(await store.getSession("e")).toBeNull();
    await store.beginSession(init("e"));
  });
});

describe("interrupted-session recovery", () => {
  /** Runs `act` on a tab that dies at the nth `op`, then recovers on a fresh tab. */
  async function killedAt(op: StoreOp, act: (store: WebStore) => Promise<unknown>, nth = 1) {
    const h = harness();
    let seen = 0;
    const doomed = await h.open({ hooks: { beforeOp: (current) => { if (current === op && ++seen === nth) throw new Error(`killed at ${op}`); } } });
    await expect(act(doomed)).rejects.toThrow(`killed at ${op}`);
    h.locks.releaseAll();
    doomed.close();
    const fresh = await h.open();
    const result = await fresh.recoverInterruptedSessions();
    return { ...h, fresh, result };
  }

  test("a session with chunks but no commit becomes a recovered pending recording with the exact bytes", async () => {
    const h = harness();
    const dying = await h.open();
    const sent = await record(dying, "n", [bytesOf(300, 1), bytesOf(200, 2)]);
    h.clock.advance(60_000);
    h.locks.releaseAll();
    const tab = await h.open();
    const { recovered, failed } = await tab.recoverInterruptedSessions();
    expect(failed).toEqual([]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: "n", recovered: true, endedUnexpectedly: true, sizeBytes: 500, durationMs: 2000, rev: 1 });
    expect(Array.from(await readAll(tab, "n"))).toEqual(Array.from(sent));
    expect((await tab.listPending()).recordings.map((r) => r.id)).toEqual(["n"]);
    expect((await tab.recoverInterruptedSessions()).recovered).toEqual([]);
  });

  test("a live session held by another tab is not adopted", async () => {
    const h = harness();
    const live = await h.open();
    await record(live, "n", [bytesOf(10)]);
    const release = await h.locks.hold(sessionLock("n"));
    expect(release).not.toBeNull();
    const other = await h.open();
    expect(await other.recoverInterruptedSessions()).toEqual({ recovered: [], failed: [] });
    expect(await other.getSession("n")).not.toBeNull();
    release!();
    expect((await other.recoverInterruptedSessions()).recovered).toHaveLength(1);
  });

  test("a session that never captured a byte is dropped, not recovered", async () => {
    const h = harness();
    const dying = await h.open();
    await dying.beginSession(init("empty"));
    const { recovered, failed } = await (await h.open()).recoverInterruptedSessions();
    expect({ recovered, failed }).toEqual({ recovered: [], failed: [] });
    expect(await (await h.open()).getSession("empty")).toBeNull();
  });

  test("kill at session:begin leaves nothing to recover", async () => {
    const { result, fresh } = await killedAt("session:begin", (s) => s.beginSession(init("n")));
    expect(result).toEqual({ recovered: [], failed: [] });
    expect(await fresh.getSession("n")).toBeNull();
  });

  test("kill at audio:append keeps every earlier chunk", async () => {
    const first = bytesOf(40, 1);
    const { result, fresh } = await killedAt("audio:append", async (s) => { await record(s, "n", [first, bytesOf(40, 2)]); }, 2);
    expect(result.recovered).toMatchObject([{ id: "n", sizeBytes: 40, durationMs: 1000 }]);
    expect(Array.from(await readAll(fresh, "n"))).toEqual(Array.from(first));
  });

  test("kill between the audio write and its journal keeps the bytes and under-counts duration by at most that chunk", async () => {
    const a = bytesOf(40, 1);
    const b = bytesOf(30, 2);
    const { result, fresh } = await killedAt("session:progress", async (s) => { await record(s, "n", [a, b]); }, 2);
    expect(result.recovered).toMatchObject([{ id: "n", sizeBytes: 70, durationMs: 1000 }]);
    expect(Array.from(await readAll(fresh, "n"))).toEqual(Array.from(concat(a, b)));
  });

  test("kill at session:update still recovers the durable chunks", async () => {
    const { result } = await killedAt("session:update", async (s) => { await record(s, "n", [bytesOf(8)]); await s.updateSession("n", { intent: "paused" }); });
    expect(result.recovered).toMatchObject([{ id: "n", sizeBytes: 8 }]);
  });

  test("kill at audio:finalize and at note:commit each recover exactly one note with intact audio", async () => {
    for (const op of ["audio:finalize", "note:commit"] as const) {
      const sent = bytesOf(64, 7);
      const { result, fresh } = await killedAt(op, async (s) => { await record(s, "n", [sent]); await commit(s, "n"); });
      expect(result.recovered).toMatchObject([{ id: "n", sizeBytes: 64, recovered: true }]);
      expect((await fresh.listPending()).recordings).toHaveLength(1);
      expect(Array.from(await readAll(fresh, "n"))).toEqual(Array.from(sent));
    }
  });

  test("kill before a discard's tombstone leaves the recording recoverable; kill after it never resurrects it", async () => {
    const before = await killedAt("tombstone", async (s) => { await record(s, "n", [bytesOf(8)]); await s.discardSession("n"); });
    expect(before.result.recovered).toHaveLength(1);

    const h = harness();
    let armed = false;
    const doomed = await h.open({ hooks: { beforeOp: (op) => { if (armed && op === "audio:delete") throw new Error("killed at audio:delete"); } } });
    await record(doomed, "n", [bytesOf(8)]);
    armed = true;
    await expect(doomed.discardSession("n")).rejects.toThrow("killed at audio:delete");
    h.locks.releaseAll();
    const fresh = await h.open();
    expect(await fresh.audio.size("n")).toBe(8);
    expect((await fresh.recoverInterruptedSessions()).recovered).toEqual([]);
    await fresh.sweepTombstones();
    expect(await fresh.audio.size("n")).toBe(0);
    expect((await fresh.listPending()).recordings).toEqual([]);
  });

  test("kill during deleteAudio's audio delete is finished by the next sweep", async () => {
    const h = harness();
    let armed = false;
    const doomed = await h.open({ hooks: { beforeOp: (op) => { if (armed && op === "audio:delete") throw new Error("killed"); } } });
    await noteWith(doomed, "n", [bytesOf(9)]);
    armed = true;
    await expect(doomed.deleteAudio({ id: "n" })).rejects.toThrow("killed");
    const fresh = await h.open();
    expect(await fresh.audio.size("n")).toBe(9);
    await expect(fresh.readAudioChunk({ id: "n", offset: 0, length: 4 })).rejects.toEqual(code("tombstoned"));
    await fresh.sweepTombstones();
    expect(await fresh.audio.size("n")).toBe(0);
  });

  test("kill at recovery:attempt is retried by the next recovery without losing the recording", async () => {
    const h = harness();
    await record(await h.open(), "n", [bytesOf(12)]);
    h.locks.releaseAll();
    const dying = await h.open({ hooks: { beforeOp: (op) => { if (op === "recovery:attempt") throw new Error("killed"); } } });
    await expect(dying.recoverInterruptedSessions()).rejects.toThrow("killed");
    h.locks.releaseAll();
    const fresh = await h.open();
    expect((await fresh.getSession("n"))?.recoveryAttempts).toBe(0);
    expect((await fresh.recoverInterruptedSessions()).recovered).toHaveLength(1);
  });

  test("three failed recoveries quarantine the recording; retry re-arms it and Delete tombstones it", async () => {
    const h = harness();
    const original = await record(await h.open(), "n", [bytesOf(21)]);
    h.locks.releaseAll();
    let failing = true;
    const store = await h.open({ hooks: { beforeOp: (op) => { if (failing && op === "note:commit") throw new Error("disk says no"); } } });
    const errors: unknown[][] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      for (let attempt = 1; attempt < MAX_RECOVERY_ATTEMPTS; attempt++) {
        const { recovered, failed } = await store.recoverInterruptedSessions();
        expect(recovered).toEqual([]);
        expect(failed).toMatchObject([{ id: "n", reason: "recovery_failed", error: "disk says no" }]);
        expect((await store.listQuarantine()).items).toEqual([]);
      }
      const last = await store.recoverInterruptedSessions();
      expect(last.failed).toMatchObject([{ id: "n", reason: "recovery_failed" }]);
    } finally {
      console.error = log;
    }
    expect(errors).toHaveLength(MAX_RECOVERY_ATTEMPTS);
    expect(await store.listQuarantine()).toEqual({ items: [{ id: "n", reason: "recovery_failed", sizeBytes: 21 }] });
    expect(await store.getSession("n")).toBeNull();
    expect((await store.recoverInterruptedSessions()).recovered).toEqual([]);

    failing = false;
    await store.rearmQuarantined("n");
    expect((await store.listQuarantine()).items).toEqual([]);
    const { recovered } = await store.recoverInterruptedSessions();
    expect(recovered).toHaveLength(1);
    expect(Array.from(await readAll(store, "n"))).toEqual(Array.from(original));
    await expect(store.rearmQuarantined("n")).rejects.toEqual(code("not_found"));
  });

  test("a quarantined recording can be deleted or discarded and then stays gone", async () => {
    const h = harness({ hooks: { beforeOp: (op) => { if (op === "note:commit") throw new Error("no"); } } });
    const store = await h.open();
    const log = console.error;
    console.error = () => {};
    try {
      for (const id of ["a", "b"]) {
        await record(store, id, [bytesOf(5)]);
        for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) await store.recoverInterruptedSessions();
      }
    } finally {
      console.error = log;
    }
    expect((await store.listQuarantine()).items.map((i) => i.id).sort()).toEqual(["a", "b"]);
    await store.discardFailedRecording({ id: "a" });
    await store.deleteQuarantined({ id: "b" });
    expect((await store.listQuarantine()).items).toEqual([]);
    expect(await store.audio.size("a")).toBe(0);
    expect(await store.audio.size("b")).toBe(0);
    await expect(store.discardFailedRecording({ id: "a" })).rejects.toEqual(code("not_found"));
    await expect(store.beginSession(init("a"))).rejects.toEqual(code("tombstoned"));
  });
});

describe("account and owner isolation", () => {
  const defaults = (accountDid: string | null, transitionGen: number) =>
    ({ accountDid, transitionGen, transcriber: "assemblyai" as const, identifySpeakers: false });

  test("signed-out notes are claimed by the first account only; another account cannot touch them", async () => {
    const { open } = harness();
    const store = await open();
    await noteWith(store, "n");
    expect(await store.getCaptureDefaults()).toMatchObject({ accountDid: null, status: "signed_out", transcriber: "on-device" });
    const claimedByA = await store.setCaptureDefaults(defaults("did:A", 1));
    expect(claimedByA.claimed).toEqual(["n"]);
    expect((await store.listPending()).recordings[0]).toMatchObject({ owner: "did:A", rev: 2 });
    expect(await store.getCaptureDefaults()).toMatchObject({ accountDid: "did:A", status: "signed_in", transcriber: "assemblyai" });

    await store.setCaptureDefaults(defaults("did:B", 2));
    expect((await store.setCaptureDefaults(defaults("did:B", 3))).claimed).toEqual([]);
    expect((await store.listPending()).recordings[0]!.owner).toBe("did:A");
    await expect(store.claim({ id: "n", did: "did:B", evidence: "signed_out_v2" })).rejects.toEqual(code("owner_mismatch"));
    await expect(store.updateLedger({ id: "n", did: "did:B", rev: 2, patch: {} })).rejects.toEqual(code("owner_mismatch"));
    expect((await store.listPending()).recordings[0]!.rev).toBe(2);
  });

  test("stale transitions are rejected and a signed-out device reports no account", async () => {
    const { open } = harness();
    const store = await open();
    await store.setCaptureDefaults(defaults("did:A", 5));
    await expect(store.setCaptureDefaults(defaults("did:B", 4))).rejects.toEqual(code("stale_transition"));
    await expect(store.setCaptureDefaults(defaults("did:B", 5))).rejects.toEqual(code("stale_transition"));
    await expect(store.setAccountState({ accountDid: "did:B", transitionGen: 4, status: "signed_in" })).rejects.toEqual(code("stale_transition"));
    await store.setAccountState({ accountDid: null, transitionGen: 6, status: "signed_out" });
    expect(await store.getCaptureDefaults()).toMatchObject({ accountDid: null, status: "signed_out", transcriber: "on-device", transitionGen: 6 });
  });

  test("a session in flight when the account signs in is claimed with the notes", async () => {
    const { open } = harness();
    const store = await open();
    await store.beginSession(init("live"));
    expect((await store.setCaptureDefaults(defaults("did:A", 1))).claimed).toEqual(["live"]);
    expect((await store.getSession("live"))?.owner).toBe("did:A");
  });

  test("claim evidence rules: legacy notes need a space row or a user choice, v2 notes only signed_out_v2", async () => {
    const { open } = harness();
    const store = await open();
    await noteWith(store, "v2");
    await expect(store.claim({ id: "v2", did: "did:A", evidence: "space_row", rowId: "x" })).rejects.toEqual(code("claim_evidence_invalid"));
    await expect(store.claim({ id: "nope", did: "did:A", evidence: "signed_out_v2" })).rejects.toEqual(code("not_found"));
    expect(await store.claim({ id: "v2", did: "did:A", evidence: "signed_out_v2" })).toEqual({ owner: "did:A" });
    expect(await store.claim({ id: "v2", did: "did:A", evidence: "signed_out_v2" })).toEqual({ owner: "did:A" });
    await expect(store.claim({ id: "v2", did: "did:A", evidence: "space_row", rowId: "someone-elses" })).rejects.toEqual(code("claim_evidence_invalid"));
    expect((await store.listPending()).recordings[0]!.ledger?.audio.rowId).toBeNull();
  });

  test("outbox entries are only visible to the account that owns them", async () => {
    const { open } = harness();
    const store = await open();
    const receipt: RemoteOpReceipt = { id: "gone", did: "did:A", opId: "op1", provider: "assemblyai", mode: "hosted", kind: "hosted_create",
      fingerprint: "fp", startedAt: 1 };
    await store.beginRemoteOp(receipt);
    expect((await store.listOutbox({ did: "did:A" })).entries).toMatchObject([{ entryId: "gone:op1", kind: "hosted_upload", handle: null, state: "unknown" }]);
    expect((await store.listOutbox({ did: "did:B" })).entries).toEqual([]);
  });
});

describe("ledger, receipts, outbox and transcripts (native parity)", () => {
  const signedIn = async (store: WebStore, did = "did:A") => {
    await store.setCaptureDefaults({ accountDid: did, transitionGen: 1, transcriber: "assemblyai", identifySpeakers: false });
  };
  const receipt = (id: string, over: Partial<RemoteOpReceipt> = {}): RemoteOpReceipt =>
    ({ id, did: "did:A", opId: "op1", provider: "assemblyai", mode: "hosted", kind: "hosted_create", fingerprint: "fp", startedAt: 5, ...over });

  test("updateLedger is a compare-and-swap on rev, checks the owner and bumps rev", async () => {
    const { open } = harness();
    const store = await open();
    await signedIn(store);
    await noteWith(store, "n", [bytesOf(4)], "did:A");
    await expect(store.updateLedger({ id: "n", did: "did:A", rev: 7, patch: {} })).rejects.toEqual(code("rev_conflict"));
    expect(await store.updateLedger({ id: "n", did: "did:A", rev: 1, patch: { audio: { state: "saved", rowId: "vn-n", at: 1 } } })).toEqual({ rev: 2 });
    const note = (await store.listPending()).recordings[0]!;
    expect(note.ledger?.audio).toEqual({ state: "saved", rowId: "vn-n", at: 1 });
    expect(note.ledger?.transcript.state).toBe("pending");
  });

  test("begin/record remote op: ledger entry stages, idempotent results, conflicts and unknown receipts", async () => {
    const { open } = harness();
    const store = await open();
    await signedIn(store);
    await noteWith(store, "n", [bytesOf(4)], "did:A");
    const r = receipt("n");
    await store.beginRemoteOp(r);
    await store.beginRemoteOp(r);
    expect((await store.listPending()).recordings[0]!.ledger?.remote).toMatchObject([{ opId: "op1", stage: "create_unknown", cleanup: "none" }]);
    await expect(store.beginRemoteOp({ ...r, fingerprint: "other" })).rejects.toEqual(code("receipt_conflict"));
    await expect(store.recordRemoteResult({ id: "n", did: "did:A", opId: "nope", result: { outcome: "created" } })).rejects.toEqual(code("receipt_not_found"));
    await expect(store.recordRemoteResult({ id: "n", did: "did:B", opId: "op1", result: { outcome: "created" } })).rejects.toEqual(code("receipt_not_found"));
    expect(await store.recordRemoteResult({ id: "n", did: "did:A", opId: "op1", result: { outcome: "created", handle: "up-1" } })).toEqual({ destination: "ledger" });
    expect(await store.recordRemoteResult({ id: "n", did: "did:A", opId: "op1", result: { outcome: "created", handle: "up-1" } })).toEqual({ destination: "ledger" });
    expect((await store.listPending()).recordings[0]!.ledger?.remote).toMatchObject([{ stage: "uploading", uploadId: "up-1" }]);
    expect((await store.listPending()).recordings[0]!.rev).toBe(3);
  });

  test("a failed result removes the ledger entry; a result for a deleted note goes to the outbox", async () => {
    const { open } = harness();
    const store = await open();
    await signedIn(store);
    await noteWith(store, "n", [bytesOf(4)], "did:A");
    await store.beginRemoteOp(receipt("n"));
    await store.recordRemoteResult({ id: "n", did: "did:A", opId: "op1", result: { outcome: "failed" } });
    expect((await store.listPending()).recordings[0]!.ledger?.remote).toEqual([]);

    await store.beginRemoteOp(receipt("n", { opId: "op2", kind: "hosted_submit" }));
    await store.deleteAudio({ id: "n" });
    expect(await store.recordRemoteResult({ id: "n", did: "did:A", opId: "op2", result: { outcome: "created", jobId: "job-9" } })).toEqual({ destination: "outbox" });
    expect((await store.listOutbox({ did: "did:A" })).entries).toMatchObject([{ kind: "transcript", handle: "job-9", state: "pending" }]);
  });

  test("deleteAudio queues durable cleanup for hosted handles, then outbox entries complete, retry and disappear", async () => {
    const { open } = harness();
    const store = await open();
    await signedIn(store);
    await noteWith(store, "n", [bytesOf(4)], "did:A");
    await store.beginRemoteOp(receipt("n"));
    await store.recordRemoteResult({ id: "n", did: "did:A", opId: "op1", result: { outcome: "created", handle: "up-1" } });
    await store.beginRemoteOp(receipt("n", { opId: "op2", kind: "hosted_submit" }));
    await store.recordRemoteResult({ id: "n", did: "did:A", opId: "op2", result: { outcome: "created", jobId: "job-1" } });
    await store.deleteAudio({ id: "n" });
    const entries = (await store.listOutbox({ did: "did:A" })).entries;
    expect(entries.map((entry) => [entry.kind, entry.handle]).sort()).toEqual([["hosted_upload", "up-1"], ["transcript", "job-1"]]);
    const [first] = entries;
    await store.completeOutbox({ entryId: first!.entryId, result: "retry" });
    expect((await store.listOutbox({ did: "did:A" })).entries.find((e) => e.entryId === first!.entryId)).toMatchObject({ attempts: 1, state: "pending" });
    for (const entry of entries) await store.completeOutbox({ entryId: entry.entryId, result: "done" });
    expect((await store.listOutbox({ did: "did:A" })).entries).toEqual([]);
    await expect(store.completeOutbox({ entryId: "gone", result: "done" })).rejects.toEqual(code("not_found"));
    await expect(store.updateLedger({ id: "n", did: "did:A", rev: 2, patch: {} })).rejects.toEqual(code("tombstoned"));
    await expect(store.claim({ id: "n", did: "did:A", evidence: "signed_out_v2" })).rejects.toEqual(code("tombstoned"));
    await expect(store.beginSession(init("n"))).rejects.toEqual(code("tombstoned"));
  });

  test("an unowned (signed-out) note deletes without any outbox entries", async () => {
    const { open } = harness();
    const store = await open();
    await noteWith(store, "n");
    await store.deleteAudio({ id: "n" });
    expect((await store.listPending()).recordings).toEqual([]);
    expect((await store.listOutbox({ did: "did:A" })).entries).toEqual([]);
  });

  test("transcripts round-trip, must match their note, leave rev alone and go with the note", async () => {
    const { open } = harness();
    const store = await open();
    await noteWith(store, "n");
    const transcript = { version: 1, noteId: "n", transcriber: "on-device", rev: 1, engine: "parakeet-tdt-0.6b-v3", model: null, language: "en",
      outcome: "transcribed", diarized: false, segments: [], createdAt: "2026-10-07T00:00:00Z" } as const;
    expect(await store.getTranscript({ id: "n" })).toEqual({ transcript: null });
    await expect(store.putTranscript({ id: "n", transcript: { ...transcript, noteId: "other" } })).rejects.toEqual(code("transcript_note_mismatch"));
    await store.putTranscript({ id: "n", transcript });
    expect(await store.getTranscript({ id: "n" })).toEqual({ transcript });
    expect((await store.listPending()).recordings[0]!.rev).toBe(1);
    await expect(store.putTranscript({ id: "nope", transcript })).rejects.toEqual(code("not_found"));
    await store.deleteAudio({ id: "n" });
    await expect(store.getTranscript({ id: "n" })).rejects.toEqual(code("tombstoned"));
    await expect(store.putTranscript({ id: "n", transcript })).rejects.toEqual(code("tombstoned"));
  });

  test("state persists across a reopen of the database", async () => {
    const h = harness();
    const first = await h.open();
    await signedIn(first);
    await noteWith(first, "n", [bytesOf(4)], "did:A");
    first.close();
    const second = await h.open();
    expect(await second.getCaptureDefaults()).toMatchObject({ accountDid: "did:A", status: "signed_in" });
    expect((await second.listPending()).recordings.map((r) => r.id)).toEqual(["n"]);
  });
});
