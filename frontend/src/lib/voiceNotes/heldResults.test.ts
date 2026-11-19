import { expect, test } from "bun:test";
import { newIdbEnv } from "./web/testing/idb";
import { createHeldResultStore as createStore, MAX_HELD_DID_BYTES, MAX_HELD_TOTAL_BYTES } from "./heldResults";
import { transcriptHash } from "./voiceNoteRows";
import { localStorageVoiceNotePendingStore } from "./voiceNoteTranscription";
const createHeldResultStore = (did: string, options: Parameters<typeof createStore>[1] = {}) =>
  createStore(did, { isSignedIn: async () => true, ...options });
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
  let identityChecks = 0;
  const writer = createHeldResultStore("did:a", { env });
  const store = createHeldResultStore("did:a", {
    env,
    // Let readHeld check its owner before and after reading; pause the delete authorization.
    isSignedIn: async () => {
      if (++identityChecks <= 2) return true;
      reachedAuthorize(); await authGate; return true;
    },
  });
  const original = await writer.hold(heldInput("did:a", 1, "original"));
  const tcw = { did: "did:a", spaceId: "space-a" } as never;
  const deleting = store.discard(tcw, "note-a", original.holdId, "user_discarded");
  await authorizing;
  const newer = await writer.hold(heldInput("did:a", 2, "newer"));
  authorize();
  await deleting;
  expect(await store.readHeld("note-a")).toMatchObject({ holdId: newer.holdId, transcript: { sentences: [{ text: "newer" }] } });
});
// TC-2785 Naomi ruling: signed-out public reads hide the retained row; verify persistence directly in IDB.
test("persisted sign-out blocks a held commit and leaves its row intact", async () => {
  let signedIn = true;
  const env = newIdbEnv();
  const store = createHeldResultStore("did:a", { env, isSignedIn: async () => signedIn });
  await store.hold(heldInput("did:a", 1, "still held"));
  signedIn = false;
  const tcw = { did: "did:a", spaceId: "space-a" } as never;
  await expect(store.saveHeldFirst(tcw, "note-a", {
    save: async () => { throw new Error("save must not run after sign-out"); },
    afterCommit: async () => {},
  }, "automatic")).rejects.toMatchObject({ code: "voice_note_account_mismatch" });
  // TC-2785: the durable row survives this failed commit, but the signed-out API cannot read it.
  expect(await store.readHeld("note-a")).toBeNull();
  const { request, transact } = await import("./web/idb");
  const db = await request(env.factory.open("exo-held-results", 2));
  const persisted = await transact(db, ["held"], "readonly", (tx) => request(tx.objectStore("held").get(["did:a", "note-a"])));
  expect(persisted).toMatchObject({ transcript: { sentences: [{ text: "still held" }] } });
  db.close();
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

test("TC-2785 sign-out deletes held rows and fences existing stores from repopulating them", async () => {
  const { clearHeldResultsForSignOut } = await import("./heldResults");
  const env = newIdbEnv();
  const a = createHeldResultStore("did:a", { env });
  const b = createHeldResultStore("did:b", { env });
  await a.hold(heldInput("did:a", 1, "held a"));
  await b.hold(heldInput("did:b", 1, "held b"));
  await clearHeldResultsForSignOut("did:a", env);
  expect(await a.readHeld("note-a")).toBeNull();
  expect(a.heldHint("note-a")).toBe(false);
  await expect(a.hold(heldInput("did:a", 2, "late"))).rejects.toMatchObject({ code: "held_result_persistence_failed" });
  const signedBackIn = createHeldResultStore("did:a", { env });
  expect(await signedBackIn.listHeld()).toEqual([]);
  await signedBackIn.hold(heldInput("did:a", 3, "new sign-in"));
  expect((await signedBackIn.listHeld())).toHaveLength(1);
  expect(await createHeldResultStore("did:b", { env }).listHeld()).toHaveLength(1);
});

test("TC-2785 another tab fences a pending hold and preserves other accounts and unassigned legacy rows", async () => {
  const otherTab = await import("./heldResults.ts" + "?atomic-other-tab");
  const { request, transact } = await import("./web/idb");
  const env = newIdbEnv();
  const a = createHeldResultStore("did:a", { env });
  const b = createHeldResultStore("did:b", { env });
  await a.hold(heldInput("did:a", 1, "first"));
  await b.hold(heldInput("did:b", 1, "other account"));
  const db = await request(env.factory.open("exo-held-results", 2));
  await transact(db, ["held"], "readwrite", (tx) => request(tx.objectStore("held").put({ did: "", sourceId: "legacy", value: "unassigned" })));
  db.close();
  const hashingStarted = Promise.withResolvers<void>();
  const releaseHash = Promise.withResolvers<void>();
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  const { spyOn } = await import("bun:test");
  const hashing = spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    hashingStarted.resolve();
    await releaseHash.promise;
    return originalDigest(algorithm, data);
  });
  try {
    const pending = a.hold(heldInput("did:a", 2, "late result"));
    await hashingStarted.promise;
    await otherTab.clearHeldResultsForSignOut("did:a", env);
    releaseHash.resolve();
    await expect(pending).rejects.toMatchObject({ code: "held_result_persistence_failed" });
  } finally { releaseHash.resolve(); hashing.mockRestore(); }
  expect(await createHeldResultStore("did:a", { env }).listHeld()).toEqual([]);
  expect(await b.readHeld("note-a")).toMatchObject({ transcript: { sentences: [{ text: "other account" }] } });
  const reopened = await request(env.factory.open("exo-held-results", 2));
  const legacy = await transact(reopened, ["held"], "readonly", (tx) => request(tx.objectStore("held").get(["", "legacy"])));
  expect(legacy).toEqual({ did: "", sourceId: "legacy", value: "unassigned" });
  reopened.close();
});

test("TC-2785 retained held results are unreadable through another account's store", async () => {
  const env = newIdbEnv();
  let active = "did:b";
  const isSignedIn = async (did: string) => did === active;
  const b = createStore("did:b", { env, isSignedIn });
  await b.hold(heldInput("did:b", 1, "only B reads this"));
  active = "did:c";
  const impersonatedB = createStore("did:b", { env, isSignedIn });
  expect(await impersonatedB.readHeld("note-a")).toBeNull();
  expect(await impersonatedB.listHeld()).toEqual([]);
  await expect(impersonatedB.hold(heldInput("did:b", 2, "wrong account"))).rejects.toMatchObject({ code: "held_result_persistence_failed" });
  active = "did:b";
  expect(await b.readHeld("note-a")).toMatchObject({ transcript: { sentences: [{ text: "only B reads this" }] } });
});

test("TC-2785 adding held epoch metadata preserves version-one results", async () => {
  const { request, transact } = await import("./web/idb");
  const env = newIdbEnv();
  const opening = env.factory.open("exo-held-results", 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("held", { keyPath: ["did", "sourceId"] });
  const original = await request(opening);
  const row = { ...heldInput("did:a", 1, "before upgrade"), holdId: "v1", heldAt: 1, bytes: 123, hash: "old-hash" };
  await transact(original, ["held"], "readwrite", (tx) => request(tx.objectStore("held").put(row)));
  original.close();
  expect(await createHeldResultStore("did:a", { env }).readHeld("note-a")).toMatchObject({ holdId: "v1", transcript: { sentences: [{ text: "before upgrade" }] } });
});

test("TC-2785 an unused or signed-out held store does not open IndexedDB", async () => {
  const { spyOn } = await import("bun:test");
  const env = newIdbEnv();
  const opening = spyOn(env.factory, "open");
  try {
    const inactive = createStore("did:a", { env, isSignedIn: async () => false });
    expect(opening).not.toHaveBeenCalled();
    expect(await inactive.readHeld("note-a")).toBeNull();
    expect(await inactive.listHeld()).toEqual([]);
    await expect(inactive.hold(heldInput("did:a", 1, "inactive"))).rejects.toMatchObject({ code: "held_result_persistence_failed" });
    expect(opening).not.toHaveBeenCalled();
  } finally { opening.mockRestore(); }
});

test("TC-2785 clearing an account invalidates a store created before its first operation", async () => {
  const { clearHeldResultsForSignOut } = await import("./heldResults");
  const env = newIdbEnv();
  const unused = createHeldResultStore("did:a", { env });
  await clearHeldResultsForSignOut("did:a", env);
  await expect(unused.hold(heldInput("did:a", 1, "stale instance"))).rejects.toMatchObject({ code: "held_result_persistence_failed" });
  expect(await unused.readHeld("note-a")).toBeNull();
});
