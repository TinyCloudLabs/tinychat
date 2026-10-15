import { expect, test } from "bun:test";
import { newIdbEnv } from "./web/testing/idb";
import { createHeldResultStore } from "./heldResults";
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
