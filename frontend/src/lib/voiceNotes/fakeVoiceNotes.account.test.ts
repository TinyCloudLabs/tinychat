import { expect, test } from "bun:test";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes } from "./nativeVoiceNotes";
import { associateLegacyNotes, migrateLegacyDiscardLedger } from "./legacyMigration";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { advanceAccountGeneration, currentAccountGeneration } from "./accountContext";
import { saveNoteForAccount } from "./recorderSaves";

const did = "did:example:owner";
test("durable account acknowledgement fails closed and claims only signed-out v2 notes", async () => {
  const fake = createFakeVoiceNotes();
  fake.controls.failNextAccountState();
  await expect(fake.plugin.setAccountState({ status: "signed_in", accountDid: did, transitionGen: 1 })).rejects.toMatchObject({ code: "account_state_write_failed" });
  expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_out");
  await fake.plugin.setAccountState({ status: "transitioning", accountDid: did, transitionGen: 1 });
  const start = await fake.plugin.start();
  expect((await fake.plugin.status()).owner).toBeNull();
  expect((await fake.plugin.stop()).owner).toBeNull();
  const claimed = await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 2,
    transcriber: "private-cloud", identifySpeakers: false });
  expect(claimed.claimed).toEqual([start.id]);
  expect((await fake.plugin.listPending()).recordings[0]?.owner).toBe(did);
  await expect(fake.plugin.setAccountState({ status: "signed_out", accountDid: null, transitionGen: 1 })).rejects.toMatchObject({ code: "stale_transition" });
});

test("a preference write at the current generation keeps the transitioning account closed", async () => {
  const fake = createFakeVoiceNotes();
  await fake.plugin.setAccountState({ status: "transitioning", accountDid: did, transitionGen: 1 });
  expect((await fake.plugin.getCaptureDefaults()).accountDid).toBeNull();
  await fake.plugin.setCaptureDefaults({ accountDid: null, transitionGen: 1,
    transcriber: "private-cloud", identifySpeakers: true });
  expect(await fake.plugin.getCaptureDefaults()).toMatchObject({ status: "transitioning",
    accountDid: null, transcriber: "on-device" });
  const { id } = await fake.plugin.start();
  expect((await fake.plugin.status()).owner).toBeNull();
  await fake.plugin.discard();
  await expect(fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1,
    transcriber: "private-cloud", identifySpeakers: true })).rejects.toMatchObject({ code: "stale_transition" });
  expect(id).toBeTruthy();
});

test("a late provider result for a tombstoned note reaches its owner's outbox", async () => {
  const fake = createFakeVoiceNotes();
  await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1, transcriber: "assemblyai", identifySpeakers: false });
  const { id } = await fake.plugin.start();
  await fake.plugin.stop();
  const receipt = { id, did, opId: "submit-1", provider: "assemblyai" as const, mode: "hosted" as const,
    kind: "hosted_submit" as const, fingerprint: "sha256:abc", startedAt: 10 };
  await fake.plugin.beginRemoteOp(receipt);
  await fake.plugin.deleteAudio({ id });
  expect(await fake.plugin.recordRemoteResult({ id, did, opId: receipt.opId,
    result: { outcome: "created", handle: "remote-handle", handleExpiresAt: 123 } })).toEqual({ destination: "outbox" });
  const entries = (await fake.plugin.listOutbox({ did })).entries;
  expect(entries).toEqual([expect.objectContaining({ entryId: `${id}:submit-1`, handle: "remote-handle",
    state: "pending", handleExpiresAt: 123 })]);
  await fake.plugin.completeOutbox({ entryId: entries[0]!.entryId, result: "authority_expired" });
  expect((await fake.plugin.listOutbox({ did })).entries[0]?.state).toBe("authority_expired");
});

test("receipt stages and failed outcomes match the native outbox contract", async () => {
  const fake = createFakeVoiceNotes();
  await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1, transcriber: "assemblyai", identifySpeakers: false });
  const { id } = await fake.plugin.start();
  await fake.plugin.stop();
  const receipt = (opId: string, kind: "hosted_create" | "hosted_submit") => ({
    id, did, opId, provider: "assemblyai" as const, mode: "hosted" as const, kind,
    fingerprint: opId, startedAt: 10,
  });
  await fake.plugin.beginRemoteOp(receipt("upload", "hosted_create"));
  expect((await fake.plugin.listPending()).recordings[0]?.ledger?.remote.find((r) => r.opId === "upload")?.stage).toBe("create_unknown");
  await fake.plugin.recordRemoteResult({ id, did, opId: "upload", result: { outcome: "created", uploadId: "up-1" } });
  expect((await fake.plugin.listPending()).recordings[0]?.ledger?.remote.find((r) => r.opId === "upload")?.stage).toBe("uploading");
  await fake.plugin.beginRemoteOp(receipt("submit", "hosted_submit"));
  await fake.plugin.recordRemoteResult({ id, did, opId: "submit", result: { outcome: "failed" } });
  expect((await fake.plugin.listPending()).recordings[0]?.ledger?.remote.some((r) => r.opId === "submit")).toBe(false);
  await fake.plugin.deleteAudio({ id });
  expect((await fake.plugin.listOutbox({ did })).entries).toMatchObject([{ entryId: `${id}:upload`, kind: "hosted_upload", handle: "up-1", state: "pending" }]);
});

test("own-key create keeps its receipt kind through URL lookup and a late job handle", async () => {
  const fake = createFakeVoiceNotes();
  await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1,
    transcriber: "assemblyai", identifySpeakers: false });
  const { id } = await fake.plugin.start();
  await fake.plugin.stop();
  await fake.plugin.beginRemoteOp({ id, did, opId: "create", provider: "assemblyai", mode: "own",
    kind: "own_create", fingerprint: "one", startedAt: 10 });
  await fake.plugin.deleteAudio({ id });
  await fake.plugin.recordRemoteResult({ id, did, opId: "create",
    result: { outcome: "unknown", uploadUrl: "https://example.test/audio" } });
  expect((await fake.plugin.listOutbox({ did })).entries[0]).toMatchObject({
    kind: "own_upload_lookup", receiptKind: "own_create", handle: "https://example.test/audio", state: "lookup",
  });
  await fake.plugin.recordRemoteResult({ id, did, opId: "create", result: { outcome: "unknown" } });
  expect((await fake.plugin.listOutbox({ did })).entries[0]?.kind).toBe("own_upload_lookup");
  await fake.plugin.recordRemoteResult({ id, did, opId: "create",
    result: { outcome: "created", handle: "job-42" } });
  expect((await fake.plugin.listOutbox({ did })).entries[0]).toMatchObject({
    kind: "transcript", receiptKind: "own_create", handle: "job-42", state: "pending",
  });
});

test("own-key lookup survives an unchanged result before deleting the note", async () => {
  const fake = createFakeVoiceNotes();
  await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1,
    transcriber: "assemblyai", identifySpeakers: false });
  const { id } = await fake.plugin.start();
  await fake.plugin.stop();
  await fake.plugin.beginRemoteOp({ id, did, opId: "create", provider: "assemblyai", mode: "own",
    kind: "own_create", fingerprint: "one", startedAt: 10 });
  await fake.plugin.recordRemoteResult({ id, did, opId: "create",
    result: { outcome: "unknown", uploadUrl: "https://example.test/audio" } });
  await fake.plugin.recordRemoteResult({ id, did, opId: "create", result: { outcome: "unknown" } });
  await fake.plugin.deleteAudio({ id });
  expect((await fake.plugin.listOutbox({ did })).entries).toContainEqual(expect.objectContaining({
    kind: "own_upload_lookup", receiptKind: "own_create", handle: "https://example.test/audio", state: "lookup",
  }));
});

test("preference changes retain transitioning and recovery actions report absent sessions", async () => {
  const fake = createFakeVoiceNotes();
  await fake.plugin.setAccountState({ status: "transitioning", accountDid: did, transitionGen: 1 });
  await fake.plugin.setCaptureDefaults({ accountDid: null, transitionGen: 1, transcriber: "on-device", identifySpeakers: true });
  expect(await fake.plugin.getCaptureDefaults()).toMatchObject({ status: "transitioning", accountDid: null });
  await expect(fake.plugin.retryRecovery({ id: "missing" })).rejects.toMatchObject({ code: "not_found" });
  await expect(fake.plugin.discardFailedRecording({ id: "missing" })).rejects.toMatchObject({ code: "not_found" });
  const { id } = await fake.plugin.start();
  await fake.plugin.stop();
  await expect(fake.plugin.discardFailedRecording({ id })).rejects.toMatchObject({ code: "not_failed_recording" });
  fake.controls.quarantine("retryable", "bad journal", 1024);
  await fake.plugin.retryRecovery({ id: "retryable" });
  fake.controls.quarantine("discardable", "bad journal", 1024);
  await fake.plugin.discardFailedRecording({ id: "discardable" });
  expect((await fake.plugin.listQuarantine()).items).toEqual([]);
});

test("legacy notes require matching space-row evidence; old discard markers become tombstones", async () => {
  const original = VoiceNotes;
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const note = { id: "legacy-note", startedAt: 1, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4,
    silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
  fake.controls.commitLegacy(note);
  const discard = { ...note, id: "discard-legacy" };
  fake.controls.commitLegacy(discard);
  try {
    expect((await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false })).claimed).toEqual([]);
    const tcw = { sql: { db: () => ({ query: async (_sql: string, params: unknown[]) => ({ ok: true,
      data: { rows: params[0] === note.id ? [["old-row-id"]] : [] } }) }) } } as unknown as TinyCloudWeb;
    expect(await associateLegacyNotes(tcw, did, (await fake.plugin.listPending()).recordings)).toEqual([note.id]);
    const associated = (await fake.plugin.listPending()).recordings.find((r) => r.id === note.id);
    expect(associated?.ledger?.audio).toMatchObject({ state: "saved", rowId: "old-row-id" });
    const storage = { value: JSON.stringify([discard.id]), getItem() { return this.value; }, removeItem() { this.value = ""; } };
    await migrateLegacyDiscardLedger(storage as never);
    expect(fake.controls.tombstoned(discard.id)).toBe(true);
    expect(storage.value).toBe("");
  } finally {
    __setVoiceNotesForTests(original, { available: null });
  }
});

test("a stale account context makes no storage or native call", async () => {
  const generation = currentAccountGeneration();
  advanceAccountGeneration();
  let calls = 0;
  const tcw = { did, spaceId: "space", get sql() { calls++; throw new Error("external SQL call"); },
    get kv() { calls++; throw new Error("external KV call"); } } as unknown as TinyCloudWeb;
  await expect(saveNoteForAccount(tcw, { did, spaceId: "space", generation },
    { id: "stale", startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4,
      silencedMs: 0, silencedEvents: 0, noSignalMs: 0, version: 2, owner: did })).rejects.toThrow("account changed");
  expect(calls).toBe(0);
});

test("the fake exposes pause timeout and explicit resume refusal reasons", async () => {
  const fake = createFakeVoiceNotes();
  await fake.plugin.start();
  fake.controls.failNextPauseTimeout();
  await expect(fake.plugin.pause()).rejects.toMatchObject({ code: "pause_timeout" });
  await fake.plugin.pause();
  fake.controls.failNextResume("mic_unavailable");
  await expect(fake.plugin.resume()).rejects.toMatchObject({ code: "mic_unavailable" });
  expect((await fake.plugin.status()).reason).toBe("mic_unavailable");
});

test("failed recovery has explicit retry and discard actions", async () => {
  const fake = createFakeVoiceNotes();
  const { id } = await fake.plugin.start();
  await fake.plugin.stop();
  fake.controls.quarantine(id, "corrupt_journal", 1024);
  await fake.plugin.retryRecovery({ id });
  expect((await fake.plugin.listPending()).recordings.some((note) => note.id === id)).toBe(true);
  fake.controls.quarantine(id, "corrupt_journal", 1024);
  await fake.plugin.discardFailedRecording({ id });
  expect((await fake.plugin.listQuarantine()).items).toEqual([]);
  expect((await fake.plugin.listPending()).recordings.some((note) => note.id === id)).toBe(false);
});
