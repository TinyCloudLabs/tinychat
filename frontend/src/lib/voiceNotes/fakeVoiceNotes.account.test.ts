import { expect, test } from "bun:test";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes } from "./nativeVoiceNotes";
import { associateLegacyNotes, migrateLegacyDiscardLedger } from "./legacyMigration";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { advanceAccountGeneration, currentAccountGeneration } from "./accountContext";
import { saveNoteForAccount } from "./recorderSaves";

const did = "did:example:owner";
test("durable account acknowledgement fails closed and keeps the transitioning owner", async () => {
  const fake = createFakeVoiceNotes();
  fake.controls.failNextAccountState();
  await expect(fake.plugin.setAccountState({ status: "signed_in", accountDid: did, transitionGen: 1 })).rejects.toMatchObject({ code: "account_state_write_failed" });
  expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_out");
  await fake.plugin.setAccountState({ status: "transitioning", accountDid: did, transitionGen: 1 });
  const start = await fake.plugin.start();
  expect((await fake.plugin.status()).owner).toBe(did);
  expect((await fake.plugin.stop()).owner).toBe(did);
  const claimed = await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 2,
    transcriber: "private-cloud", identifySpeakers: false });
  expect(claimed.claimed).toEqual([]);
  expect((await fake.plugin.listPending()).recordings[0]?.id).toBe(start.id);
  expect((await fake.plugin.listPending()).recordings[0]?.owner).toBe(did);
  await expect(fake.plugin.setAccountState({ status: "signed_out", accountDid: null, transitionGen: 1 })).rejects.toMatchObject({ code: "stale_transition" });
});

test("a preference write at the current generation keeps the transitioning account closed", async () => {
  const fake = createFakeVoiceNotes();
  await fake.plugin.setAccountState({ status: "transitioning", accountDid: did, transitionGen: 1 });
  expect((await fake.plugin.getCaptureDefaults()).accountDid).toBe(did);
  await fake.plugin.setCaptureDefaults({ accountDid: null, transitionGen: 1,
    transcriber: "private-cloud", identifySpeakers: true });
  expect(await fake.plugin.getCaptureDefaults()).toMatchObject({ status: "transitioning",
    accountDid: did, transcriber: "on-device" });
  const { id } = await fake.plugin.start();
  expect((await fake.plugin.status()).owner).toBe(did);
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
  expect(await fake.plugin.getCaptureDefaults()).toMatchObject({ status: "transitioning", accountDid: did });
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

test("discard migration preserves a marker written during native deletion", async () => {
  const original = VoiceNotes;
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const note = { id: "old-discard", startedAt: 1, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4,
    silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
  fake.controls.commitLegacy(note);
  const storage = { value: JSON.stringify([note.id]), getItem() { return this.value; },
    setItem(_key: string, value: string) { this.value = value; }, removeItem() { this.value = ""; } };
  const native = fake.plugin.deleteAudio;
  fake.plugin.deleteAudio = async (options) => {
    storage.value = JSON.stringify([note.id, "new-discard"]);
    await native(options);
  };
  try {
    await migrateLegacyDiscardLedger(storage as never);
    expect(JSON.parse(storage.value)).toEqual(["new-discard"]);
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

// TC-2785 Naomi test ruling: sign-in never claims unowned notes; user_choice requires the active account.
test("unowned v2 notes require an explicit claim from the active account", async () => {
  const { plugin } = createFakeVoiceNotes();
  const { id } = await plugin.start();
  await plugin.stop();
  await expect(plugin.claim({ id, did, evidence: "user_choice" })).rejects.toMatchObject({ code: "owner_mismatch" });
  await plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
  expect((await plugin.listPending()).recordings[0]?.owner).toBeNull();
  await expect(plugin.claim({ id, did, evidence: "signed_out_v2" })).rejects.toMatchObject({ code: "claim_evidence_invalid" });
  await expect(plugin.claim({ id, did: "did:example:other", evidence: "user_choice" })).rejects.toMatchObject({ code: "owner_mismatch" });
  expect(await plugin.claim({ id, did, evidence: "user_choice" })).toEqual({ owner: did });
});

test("unsynced account audio is unreadable while signed out or under another account and returns to its owner", async () => {
  const fake = createFakeVoiceNotes();
  const { plugin } = fake;
  await plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
  const { id } = await plugin.start();
  await plugin.stop();
  const transcript = { version: 1, noteId: id, transcriber: "on-device", rev: 1, engine: "parakeet-tdt-0.6b-v3", model: null,
    language: "en", outcome: "transcribed", diarized: false, segments: [], createdAt: "2026-10-07T00:00:00Z" } as const;
  await plugin.putTranscript({ id, transcript });
  fake.controls.quarantine(id, "bad journal", 4);
  await plugin.beginRemoteOp({ id, did, opId: "held", provider: "assemblyai", mode: "hosted", kind: "hosted_create", fingerprint: "one", startedAt: 10 });
  await plugin.setAccountState({ status: "signed_out", accountDid: null, transitionGen: 2 });
  for (const accountDid of [null, "did:example:B"]) {
    if (accountDid) await plugin.setCaptureDefaults({ accountDid, transitionGen: 3, transcriber: "on-device", identifySpeakers: false });
    expect((await plugin.listPending()).recordings).toEqual([]);
    expect((await plugin.listQuarantine()).items).toEqual([]);
    expect((await plugin.listOutbox({ did })).entries).toEqual([]);
    for (const read of [() => plugin.localAudioUrl({ id }), () => plugin.localAudioSize({ id }),
      () => plugin.readAudioChunk({ id, offset: 0, length: 4 }), () => plugin.audioMetadata({ id }),
      () => plugin.getTranscript({ id }), () => plugin.claim({ id, did: accountDid ?? did, evidence: "user_choice" })]) {
      await expect(read()).rejects.toMatchObject({ code: "owner_mismatch" });
    }
  }
  await plugin.setCaptureDefaults({ accountDid: did, transitionGen: 4, transcriber: "on-device", identifySpeakers: false });
  expect((await plugin.listPending()).recordings[0]?.owner).toBe(did);
  expect((await plugin.localAudioSize({ id })).size).toBeGreaterThan(0);
  expect(await plugin.getTranscript({ id })).toEqual({ transcript });
  expect((await plugin.listQuarantine()).items[0]?.id).toBe(id);
});

test("sign-out deletes verified synced notes and their transcripts but keeps unverified audio", async () => {
  const { plugin } = createFakeVoiceNotes();
  await plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
  const synced = await plugin.start();
  await plugin.stop();
  await plugin.putTranscript({ id: synced.id, transcript: { version: 1, noteId: synced.id, transcriber: "on-device", rev: 1,
    engine: "parakeet-tdt-0.6b-v3", model: null, language: "en", outcome: "transcribed", diarized: false,
    segments: [], createdAt: "2026-10-07T00:00:00Z" } });
  await plugin.updateLedger({ id: synced.id, did, rev: 1, patch: { audio: { state: "saved", rowId: "space-row", at: 1,
    verifiedInSpace: { sha256: "a".repeat(64), size: 4 } }, transcriptSync: { state: "saved", rev: 1, at: 1 } } });
  const unverified = await plugin.start();
  await plugin.stop();
  await plugin.updateLedger({ id: unverified.id, did, rev: 1, patch: { audio: { state: "saved", rowId: "old-row", at: 1 } } });
  await plugin.setAccountState({ status: "signed_out", accountDid: null, transitionGen: 2 });
  await plugin.setCaptureDefaults({ accountDid: did, transitionGen: 3, transcriber: "on-device", identifySpeakers: false });
  expect((await plugin.listPending()).recordings.map((note) => note.id)).toEqual([unverified.id]);
  await expect(plugin.localAudioUrl({ id: synced.id })).rejects.toMatchObject({ code: "tombstoned" });
  await expect(plugin.getTranscript({ id: synced.id })).rejects.toMatchObject({ code: "tombstoned" });
});


test("sign-out finalizes handoff audio for A before clearing session and retained events", async () => {
  const { plugin, controls } = createFakeVoiceNotes();
  await plugin.setAccountState({ status: "transitioning", accountDid: did, transitionGen: 1 });
  const { id } = await plugin.start();
  controls.tick(1000);
  expect((await plugin.status()).owner).toBe(did);
  await plugin.setAccountState({ status: "signed_out", accountDid: null, transitionGen: 2 });
  expect(await plugin.status()).toMatchObject({ state: "idle", id: null });
  expect((await plugin.listPending()).recordings).toEqual([]);
  await plugin.setCaptureDefaults({ accountDid: "did:example:B", transitionGen: 3, transcriber: "on-device", identifySpeakers: false });
  const committed: string[] = [];
  const mic: string[] = [];
  await plugin.addListener("committed", (event) => committed.push(event.id));
  await plugin.addListener("micState", (event) => { if (event.id) mic.push(event.id); });
  await Promise.resolve();
  expect(committed).toEqual([]);
  expect(mic).toEqual([]);
  expect((await plugin.listPending()).recordings).toEqual([]);
  await plugin.setCaptureDefaults({ accountDid: did, transitionGen: 4, transcriber: "on-device", identifySpeakers: false });
  expect((await plugin.listPending()).recordings).toMatchObject([{ id, owner: did, durationMs: 1000 }]);
});

test("TC-2785 fake retains mismatched receipts and unsynced local transcripts", async () => {
  for (const variant of ["pending-transcript", "wrong-rev", "wrong-size", "missing-row", "preparing-audio", "saved-transcript"]) {
    const { plugin } = createFakeVoiceNotes();
    await plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
    const { id } = await plugin.start();
    const note = await plugin.stop();
    await plugin.putTranscript({ id, transcript: { version: 1, noteId: id, transcriber: "on-device", rev: 1,
      engine: "test", model: null, language: "en", outcome: "transcribed", diarized: false, segments: [], createdAt: "2026-11-11T00:00:00Z" } });
    await plugin.updateLedger({ id, did, rev: note.rev!, patch: {
      audio: { state: "saved", rowId: variant === "missing-row" ? null : "row", at: 1,
        verifiedInSpace: { sha256: "a".repeat(64), size: variant === "wrong-size" ? note.sizeBytes + 1 : note.sizeBytes } },
      transcriptSync: { state: variant === "pending-transcript" ? "pending" : "saved", rev: variant === "wrong-rev" ? 2 : 1, at: 1 },
      ...(variant === "preparing-audio" ? { localAudio: { state: "preparing" as const, error: null } } : {}),
    } });
    await plugin.setAccountState({ status: "signed_out", accountDid: null, transitionGen: 2 });
    await plugin.setCaptureDefaults({ accountDid: did, transitionGen: 3, transcriber: "on-device", identifySpeakers: false });
    expect((await plugin.listPending()).recordings).toHaveLength(variant === "saved-transcript" ? 0 : 1);
    if (variant !== "saved-transcript") expect((await plugin.getTranscript({ id })).transcript?.rev).toBe(1);
  }
});
