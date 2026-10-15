import { expect, test } from "bun:test";
import { newIdbEnv } from "./web/testing/idb";
import { createHeldResultStore, MAX_HELD_DID_BYTES, MAX_HELD_TOTAL_BYTES } from "./heldResults";
import { transcriptHash } from "./voiceNoteRows";
import { localStorageVoiceNotePendingStore } from "./voiceNoteTranscription";
const heldInput = (did: string, rev: number, text: string) => ({
  version: 1 as const,
  did,
  spaceId: "space-a",
  sourceId: "note-a",
  engine: "private-cloud" as const,
  transcript: { rev, sentences: [{ index: 0, text, speaker_name: "Speaker 1", start_time: 0, end_time: 1 }], metadata: {}, speakers: [] },
  provider: null,
  intent: { kind: "unknown" as const },
});

test("equal-rev different-content hold keeps the stored row; equal content returns its holdId", async () => {
  const store = createHeldResultStore("did:a", { env: newIdbEnv(), newId: (() => { let n = 0; return () => `hold-${++n}`; })() });
  const first = await store.hold(heldInput("did:a", 2, "first"));
  const same = await store.hold(heldInput("did:a", 2, "first"));
  expect(same.holdId).toBe(first.holdId);
  await expect(store.hold(heldInput("did:a", 2, "different"))).rejects.toMatchObject({
    code: "held_result_persistence_failed", reason: "held_rev_conflict",
  });
  expect(await store.readHeld("note-a")).toMatchObject({ holdId: first.holdId, transcript: { sentences: [{ text: "first" }] } });
});

test("hold refuses a missing space identity without creating a row", async () => {
  const store = createHeldResultStore("did:a", { env: newIdbEnv() });
  await expect(store.hold({ ...heldInput("did:a", 1, "text"), spaceId: "" })).rejects.toMatchObject({
    code: "held_result_persistence_failed", reason: "no_space",
  });
  expect(await store.listHeld()).toEqual([]);
});
test("concurrent stores preserve independent per-note holds", async () => {
  const env = newIdbEnv();
  const first = createHeldResultStore("did:a", { env });
  const second = createHeldResultStore("did:a", { env });
  await Promise.all([
    first.hold({ ...heldInput("did:a", 1, "first"), sourceId: "note-1" }),
    second.hold({ ...heldInput("did:a", 1, "second"), sourceId: "note-2" }),
  ]);
  expect((await first.listHeld()).map((row) => row.sourceId).sort()).toEqual(["note-1", "note-2"]);
});

test("overlapping public holds preserve both independently acknowledged records", async () => {
  const env = newIdbEnv();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = createHeldResultStore("did:a", {
    env: {
      ...env,
      storage: { persisted: async () => {
        reached.resolve();
        await release.promise;
        return false;
      } } as StorageManager,
    },
  });
  const second = createHeldResultStore("did:a", {
    env: { ...env, storage: { persisted: async () => false } as StorageManager },
  });
  const inputA = { ...heldInput("did:a", 1, "first"), sourceId: "note-1" };
  const inputB = { ...heldInput("did:a", 1, "second"), sourceId: "note-2" };
  const firstHold = first.hold(inputA);
  let firstSettled = false;
  void firstHold.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  try {
    await Promise.race([
      reached.promise,
      firstHold.then(() => { throw new Error("first hold settled before its durability gate"); }),
    ]);
    expect(firstSettled).toBe(false);
    const secondHold = second.hold(inputB);
    expect(firstSettled).toBe(false);
    const receiptB = await secondHold;
    expect(firstSettled).toBe(false);
    release.resolve();
    const receiptA = await firstHold;
    expect((await first.listHeld()).map((row) => row.sourceId).sort()).toEqual(["note-1", "note-2"]);
    expect(await first.readHeld("note-1")).toMatchObject({
      sourceId: "note-1", holdId: receiptA.holdId,
      hash: await transcriptHash(inputA.transcript.sentences),
      transcript: { rev: 1, sentences: [{ text: "first" }] },
    });
    expect(await second.readHeld("note-2")).toMatchObject({
      sourceId: "note-2", holdId: receiptB.holdId,
      hash: await transcriptHash(inputB.transcript.sentences),
      transcript: { rev: 1, sentences: [{ text: "second" }] },
    });
  } finally {
    release.resolve();
    await firstHold;
  }
});

test("per-DID shares and hard device cap reject without evicting earlier held rows", async () => {
  const env = newIdbEnv();
  for (const did of ["did:a", "did:b", "did:c", "did:d"]) {
    const store = createHeldResultStore(did, { env });
    for (let index = 0; index < 50; index++)
      await store.hold({ ...heldInput(did, 1, `${did}-${index}`), sourceId: `${did}-note-${index}` });
  }
  const active = createHeldResultStore("did:e", { env });
  await expect(active.hold({ ...heldInput("did:e", 1, "fifth"), sourceId: "fifth-note" })).rejects.toMatchObject({
    code: "held_result_persistence_failed", reason: "store_full",
  });
  expect((await createHeldResultStore("did:a", { env }).listHeld())).toHaveLength(50);
  expect(await active.readHeld("fifth-note")).toBeNull();
});
test("user discard deletes only the selected DID's held row", async () => {
  const env = newIdbEnv();
  const ownerA = createHeldResultStore("did:a", { env, isSignedIn: async () => true });
  const ownerB = createHeldResultStore("did:b", { env, isSignedIn: async () => true });
  const heldA = await ownerA.hold({ ...heldInput("did:a", 1, "a"), sourceId: "shared-note" });
  await ownerB.hold({ ...heldInput("did:b", 1, "b"), sourceId: "shared-note" });
  await expect(ownerA.discard({ did: "did:b", spaceId: "space-a" } as never,
    "shared-note", heldA.holdId, "user_discarded")).rejects.toMatchObject({ code: "voice_note_account_mismatch" });
  await ownerA.discard({ did: "did:a", spaceId: "space-a" } as never, "shared-note", "wrong-hold", "user_discarded");
  expect(await ownerA.readHeld("shared-note")).toMatchObject({ holdId: heldA.holdId, transcript: { sentences: [{ text: "a" }] } });
  expect(await ownerB.readHeld("shared-note")).toMatchObject({ did: "did:b", transcript: { sentences: [{ text: "b" }] } });
  await ownerA.discard({ did: "did:a", spaceId: "space-a" } as never, "shared-note", heldA.holdId, "user_discarded");
  expect(await ownerA.readHeld("shared-note")).toBeNull();
  expect(await ownerB.readHeld("shared-note")).toMatchObject({ did: "did:b", transcript: { sentences: [{ text: "b" }] } });
});
test("unverified same-note clears preserve the raw legacy held value", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const pending = localStorageVoiceNotePendingStore("did:a", storage);
  const raw = { legacy: ["opaque"], rev: "not-validated" };
  pending.write("note-a", { attemptId: "first", transcriptionId: "ptx", held: raw as never });
  pending.write("note-a", { attemptId: "second", transcriptionId: null });
  pending.clear("note-a");
  expect(pending.read("note-a")).toMatchObject({ attemptId: "second", transcriptionId: null, held: raw });
});
test("a same-note terminal marker write carries the raw legacy held payload", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const pending = localStorageVoiceNotePendingStore("did:a", storage);
  const raw = { legacy: ["opaque"], rev: "not-validated" };
  pending.write("note-a", { attemptId: "first", transcriptionId: "ptx", held: raw as never });
  pending.write("note-a", { attemptId: "first", transcriptionId: "ptx", failure: "processing_failed" });
  expect(pending.read("note-a")).toMatchObject({ failure: "processing_failed", held: raw });
});
test("a different-note pending write carries another raw legacy held payload", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const pending = localStorageVoiceNotePendingStore("did:a", storage);
  const raw = { legacy: ["opaque"], rev: "not-validated" };
  pending.write("note-a", { attemptId: "first", transcriptionId: "ptx", held: raw as never });
  pending.write("note-b", { attemptId: "other", transcriptionId: null });
  expect(pending.read("note-a")?.held as unknown).toEqual(raw);
});
test("compare-and-delete cannot remove a newer held row that replaced its holdId", async () => {
  const env = newIdbEnv();
  let authorize!: () => void;
  let reachedAuthorize!: () => void;
  const authGate = new Promise<void>((resolve) => { authorize = resolve; });
  const authorizing = new Promise<void>((resolve) => { reachedAuthorize = resolve; });
  const store = createHeldResultStore("did:a", {
    env,
    isSignedIn: async () => { reachedAuthorize(); await authGate; return true; },
  });
  const original = await store.hold(heldInput("did:a", 1, "original"));
  const tcw = { did: "did:a", spaceId: "space-a" } as never;
  const deleting = store.discard(tcw, "note-a", original.holdId, "user_discarded");
  await authorizing;
  const newer = await store.hold(heldInput("did:a", 2, "newer"));
  authorize();
  await deleting;
  expect(await store.readHeld("note-a")).toMatchObject({ holdId: newer.holdId, transcript: { sentences: [{ text: "newer" }] } });
});
test("persisted sign-out blocks a held commit and leaves its row intact", async () => {
  let signedIn = true;
  const store = createHeldResultStore("did:a", { env: newIdbEnv(), isSignedIn: async () => signedIn });
  await store.hold(heldInput("did:a", 1, "still held"));
  signedIn = false;
  const tcw = { did: "did:a", spaceId: "space-a" } as never;
  await expect(store.saveHeldFirst(tcw, "note-a", {
    save: async () => { throw new Error("save must not run after sign-out"); },
    afterCommit: async () => {},
  }, "automatic")).rejects.toMatchObject({ code: "voice_note_account_mismatch" });
  expect(await store.readHeld("note-a")).not.toBeNull();
});

test("a fifty-first hold for one DID refuses without evicting any existing result", async () => {
  const env = newIdbEnv();
  const store = createHeldResultStore("did:a", { env });
  const receipts = new Map<string, string>();
  for (let index = 0; index < 50; index++) {
    const sourceId = `note-${index}`;
    const receipt = await store.hold({ ...heldInput("did:a", 1, `original-${index}`), sourceId });
    receipts.set(sourceId, receipt.holdId);
  }
  await expect(store.hold({ ...heldInput("did:a", 1, "overflow"), sourceId: "note-50" }))
    .rejects.toMatchObject({ code: "held_result_persistence_failed", reason: "store_full" });
  expect(await store.readHeld("note-50")).toBeNull();
  for (const [sourceId, holdId] of receipts) {
    expect(await store.readHeld(sourceId)).toMatchObject({
      holdId, transcript: { sentences: [{ text: `original-${sourceId.slice(5)}` }] },
    });
  }
  expect(await store.listHeld()).toHaveLength(50);
  const other = createHeldResultStore("did:b", { env });
  expect(await other.hold({ ...heldInput("did:b", 1, "other"), sourceId: "other-note" })).toMatchObject({ rev: 1 });
});

test("UTF-8 byte shares reserve each DID and the hard device budget without eviction", async () => {
  const env = newIdbEnv();
  const dense = "x".repeat(Math.floor(MAX_HELD_DID_BYTES / 2) - 480_000);
  const accepted: { did: string; sourceId: string; holdId: string; hash: string }[] = [];
  for (const did of ["did:a", "did:b", "did:c", "did:d"]) {
    const store = createHeldResultStore(did, { env });
    for (let index = 0; index < 2; index++) {
      const sourceId = `${did}-note-${index}`;
      const receipt = await store.hold({ ...heldInput(did, 1, dense), sourceId });
      const row = await store.readHeld(sourceId);
      expect(row).not.toBeNull();
      accepted.push({ did, sourceId, holdId: receipt.holdId, hash: row!.hash });
    }
    const rows = await store.listHeld();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((bytes, row) => bytes + row.bytes, 0)).toBeLessThanOrEqual(MAX_HELD_DID_BYTES);
    if (did === "did:a") {
      await expect(store.hold({ ...heldInput(did, 1, "y".repeat(1_000_000)), sourceId: "did:a-overflow" }))
        .rejects.toMatchObject({ code: "held_result_persistence_failed", reason: "store_full" });
      expect(await store.readHeld("did:a-overflow")).toBeNull();
    }
  }
  const fifth = createHeldResultStore("did:e", { env });
  await expect(fifth.hold({ ...heldInput("did:e", 1, "🪐".repeat(1_000_000)), sourceId: "did:e-overflow" }))
    .rejects.toMatchObject({ code: "held_result_persistence_failed", reason: "store_full" });
  expect(await fifth.readHeld("did:e-overflow")).toBeNull();
  let totalBytes = 0;
  for (const did of ["did:a", "did:b", "did:c", "did:d"]) {
    const store = createHeldResultStore(did, { env });
    totalBytes += (await store.listHeld()).reduce((bytes, row) => bytes + row.bytes, 0);
  }
  expect(totalBytes).toBeLessThanOrEqual(MAX_HELD_TOTAL_BYTES);
  for (const { did, sourceId, holdId, hash } of accepted) {
    const row = await createHeldResultStore(did, { env }).readHeld(sourceId);
    expect(row).toMatchObject({ holdId, hash, transcript: { sentences: [{ text: dense }] } });
  }
});
