// Contract parity: the same scenarios run against the repo's fake plugin (the reference the
// controller, saves pipeline and recorder UI were built against) and against the web engine.
// Both must pass, so the web engine cannot drift from what the app already relies on.

import { describe, expect, test as bunTest } from "bun:test";
import { createFakeVoiceNotes } from "../fakeVoiceNotes";
import type { RemoteOpReceipt, VoiceNoteRecording, VoiceNotesPlugin } from "../nativeVoiceNotes";
import { base64ToBytes } from "../voiceNoteAudio";
import { FakeClock, createRig, slowTest } from "./webTestKit";

const test = slowTest(bunTest);

const code = (value: string) => expect.objectContaining({ code: value });
const HOUR = 60 * 60 * 1000;

interface Subject {
  plugin: VoiceNotesPlugin;
  clock: FakeClock;
  /** `ms` of recorded audio arrive and become durable. */
  capture(ms: number): Promise<void>;
  settle(): Promise<void>;
}

const makers: [string, () => Promise<Subject>][] = [
  ["fake plugin", async () => {
    const clock = new FakeClock();
    const fake = createFakeVoiceNotes(clock.now);
    return {
      plugin: fake.plugin, clock,
      capture: async (ms) => { clock.advance(ms); fake.controls.tick(ms); },
      settle: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); },
    };
  }],
  ["web engine", async () => {
    const rig = await createRig();
    return {
      plugin: rig.engine.plugin, clock: rig.clock,
      capture: (ms) => rig.chunk(Array.from({ length: Math.max(4, Math.round(ms / 100)) }, (_, i) => i & 255), ms),
      settle: () => rig.settle(),
    };
  }],
];

async function readAll(plugin: VoiceNotesPlugin, id: string): Promise<{ total: number; reads: number }> {
  let total = 0;
  let reads = 0;
  for (let offset = 0;;) {
    const chunk = await plugin.readAudioChunk({ id, offset, length: 64 * 1024 });
    expect(chunk).toMatchObject({ id, offset });
    expect(base64ToBytes(chunk.base64).length).toBe(chunk.bytesRead);
    total += chunk.bytesRead;
    offset += chunk.bytesRead;
    reads++;
    if (chunk.eof) return { total, reads };
    expect(chunk.bytesRead).toBeGreaterThan(0);
  }
}

const isSubsequence = (wanted: string[], actual: string[]) => {
  let at = 0;
  for (const item of actual) if (item === wanted[at]) at++;
  return at === wanted.length;
};

const signIn = (plugin: VoiceNotesPlugin, did = "did:A", transitionGen = 1) =>
  plugin.setCaptureDefaults({ accountDid: did, transitionGen, transcriber: "assemblyai", identifySpeakers: false });
const receipt = (id: string, over: Partial<RemoteOpReceipt> = {}): RemoteOpReceipt =>
  ({ id, did: "did:A", opId: "op1", provider: "assemblyai", mode: "hosted", kind: "hosted_create", fingerprint: "fp", startedAt: 5, ...over });

async function note(s: Subject, ms = 1000): Promise<VoiceNoteRecording> {
  await s.plugin.start();
  await s.capture(ms);
  return s.plugin.stop();
}

describe.each(makers)("VoiceNotes contract parity: %s", (_name, make) => {
  test("record, pause with the mic off, resume, and commit recorded time", async () => {
    const s = await make();
    const { plugin } = s;
    const states: string[] = [];
    await plugin.addListener("micState", (event) => states.push(event.state));
    const start = await plugin.start();
    expect(start).toMatchObject({ id: expect.any(String), startedAt: expect.any(Number), maxDurationMs: 3 * HOUR });
    expect(await plugin.status()).toMatchObject({ state: "recording", reason: null, id: start.id, intent: "recording", availability: "available", audioMs: 0 });
    await s.capture(2000);
    await plugin.pause();
    expect(await plugin.status()).toMatchObject({ state: "paused", reason: "user", intent: "paused", availability: "available", audioMs: 2000, elapsedMs: 2000 });
    s.clock.advance(5000);
    expect(await plugin.status()).toMatchObject({ elapsedMs: 2000, pausedMs: 5000 });
    await plugin.resume();
    await s.capture(2000);
    const saved = await plugin.stop();
    expect(saved).toMatchObject({ id: start.id, durationMs: 4000, wallMs: 9000, pausedMs: 5000, owner: null, version: 2, rev: 1, spans: [] });
    expect(saved.mimeType).toEqual(expect.any(String));
    expect(await plugin.status()).toMatchObject({ state: "idle", reason: null, id: null, intent: "stopped" });
    await s.settle();
    expect(isSubsequence(["recording", "paused", "recording", "idle"], states)).toBe(true);
    expect((await plugin.listPending()).recordings.map((r) => r.id)).toEqual([start.id]);
  });

  test("the reported size is exactly the bytes readAudioChunk serves, ending in eof", async () => {
    const s = await make();
    const saved = await note(s, 3000);
    expect(saved.sizeBytes).toBeGreaterThan(0);
    const { total } = await readAll(s.plugin, saved.id);
    expect(total).toBe(saved.sizeBytes);
    expect(await s.plugin.readAudioChunk({ id: saved.id, offset: saved.sizeBytes, length: 16 })).toMatchObject({ bytesRead: 0, size: saved.sizeBytes, eof: true });
    await expect(s.plugin.readAudioChunk({ id: "nope", offset: 0, length: 16 })).rejects.toEqual(code("not_found"));
  });

  test("the limit counts recorded time, auto-stops and announces the committed note", async () => {
    const s = await make();
    const { plugin } = s;
    const stops: { reason: string; recording: VoiceNoteRecording | null; maxDurationMs: number }[] = [];
    await plugin.addListener("autoStopped", (event) => stops.push(event));
    expect((await plugin.start({ maxDurationMs: 4000 })).maxDurationMs).toBe(4000);
    await s.capture(2000);
    await plugin.pause();
    s.clock.advance(5 * HOUR);
    await plugin.resume();
    await s.capture(1000);
    expect((await plugin.status()).state).toBe("recording");
    await s.capture(1000);
    await s.settle();
    expect(stops).toMatchObject([{ reason: "max_duration", maxDurationMs: 4000, recording: { durationMs: 4000 } }]);
    expect(await plugin.status()).toMatchObject({ state: "idle" });
    expect((await plugin.listPending()).recordings).toHaveLength(1);
  });

  test("the limit is clamped to [1 s, 3 h]", async () => {
    const s = await make();
    expect((await s.plugin.start({ maxDurationMs: 5 })).maxDurationMs).toBe(1000);
    await s.plugin.discard();
    expect((await s.plugin.start({ maxDurationMs: 99 * HOUR })).maxDurationMs).toBe(3 * HOUR);
  });

  test("controls with nothing recording reject not_recording; double start and live deletion are refused", async () => {
    const s = await make();
    const { plugin } = s;
    await expect(plugin.stop()).rejects.toEqual(code("not_recording"));
    await expect(plugin.pause()).rejects.toEqual(code("not_recording"));
    await expect(plugin.resume()).rejects.toEqual(code("not_recording"));
    await expect(plugin.setRecordingOptions({ identifySpeakers: true })).rejects.toEqual(code("not_recording"));
    expect(await plugin.discard()).toEqual({ id: null });
    const { id } = await plugin.start();
    await expect(plugin.start()).rejects.toEqual(code("already_recording"));
    await expect(plugin.deleteAudio({ id })).rejects.toEqual(code("recording_in_progress"));
    await expect(plugin.retryRecovery({ id })).rejects.toEqual(code("recording_in_progress"));
    await expect(plugin.discardFailedRecording({ id })).rejects.toEqual(code("recording_in_progress"));
  });

  test("discard throws the recording away and reports its id", async () => {
    const s = await make();
    const { id } = await s.plugin.start();
    await s.capture(1000);
    expect(await s.plugin.discard()).toEqual({ id });
    expect(await s.plugin.status()).toMatchObject({ state: "idle", id: null });
    expect((await s.plugin.listPending()).recordings).toEqual([]);
  });

  test("signed-out notes are claimed by the first account; stale transitions and other accounts are refused", async () => {
    const s = await make();
    const { plugin } = s;
    const first = await note(s);
    const second = await note(s);
    expect(await plugin.getCaptureDefaults()).toMatchObject({ accountDid: null, transcriber: "on-device" });
    const { claimed } = await plugin.setCaptureDefaults({ accountDid: "did:A", transitionGen: 5, transcriber: "assemblyai", identifySpeakers: false });
    expect([...claimed].sort()).toEqual([first.id, second.id].sort());
    const pending = (await plugin.listPending()).recordings;
    expect(pending.map((r) => r.owner)).toEqual(["did:A", "did:A"]);
    expect(await plugin.getCaptureDefaults()).toMatchObject({ accountDid: "did:A", transcriber: "assemblyai" });
    await expect(plugin.setCaptureDefaults({ accountDid: "did:B", transitionGen: 4, transcriber: "assemblyai", identifySpeakers: false })).rejects.toEqual(code("stale_transition"));
    await expect(plugin.claim({ id: first.id, did: "did:B", evidence: "signed_out_v2" })).rejects.toEqual(code("owner_mismatch"));
    await expect(plugin.claim({ id: first.id, did: "did:A", evidence: "space_row", rowId: "r" })).rejects.toEqual(code("claim_evidence_invalid"));
    const third = await plugin.start({ transcriber: "assemblyai" });
    expect(await plugin.status()).toMatchObject({ id: third.id, owner: "did:A", options: { transcriber: "assemblyai" } });
    await s.capture(1000);
    expect(await plugin.stop()).toMatchObject({ owner: "did:A" });
  });

  test("a signed-out recording keeps on-device transcription whatever is asked", async () => {
    const s = await make();
    await s.plugin.start({ transcriber: "assemblyai" });
    expect((await s.plugin.status()).options?.transcriber).toBe("on-device");
    await s.plugin.discard();
  });

  test("ledger updates are compare-and-swap on rev and owner-checked; deleted notes are tombstoned", async () => {
    const s = await make();
    const { plugin } = s;
    await signIn(plugin);
    const { id } = await note(s);
    await expect(plugin.updateLedger({ id, did: "did:B", rev: 1, patch: {} })).rejects.toEqual(code("owner_mismatch"));
    expect(await plugin.updateLedger({ id, did: "did:A", rev: 1, patch: { audio: { state: "saved", rowId: `vn-${id}`, at: 1 } } })).toEqual({ rev: 2 });
    await expect(plugin.updateLedger({ id, did: "did:A", rev: 1, patch: {} })).rejects.toEqual(code("rev_conflict"));
    expect((await plugin.listPending()).recordings[0]).toMatchObject({ rev: 2, ledger: { audio: { state: "saved", rowId: `vn-${id}` } } });
    await plugin.deleteAudio({ id });
    expect((await plugin.listPending()).recordings).toEqual([]);
    await expect(plugin.updateLedger({ id, did: "did:A", rev: 2, patch: {} })).rejects.toEqual(code("tombstoned"));
    await expect(plugin.claim({ id, did: "did:A", evidence: "signed_out_v2" })).rejects.toEqual(code("tombstoned"));
    await expect(plugin.readAudioChunk({ id, offset: 0, length: 4 })).rejects.toEqual(code("tombstoned"));
  });

  test("remote-op receipts land in the ledger, and deleting the note queues cleanup in the owner's outbox", async () => {
    const s = await make();
    const { plugin } = s;
    await signIn(plugin);
    const { id } = await note(s);
    const create = receipt(id);
    await plugin.beginRemoteOp(create);
    await plugin.beginRemoteOp(create);
    await expect(plugin.beginRemoteOp({ ...create, fingerprint: "other" })).rejects.toEqual(code("receipt_conflict"));
    await expect(plugin.recordRemoteResult({ id, did: "did:A", opId: "missing", result: { outcome: "created" } })).rejects.toEqual(code("receipt_not_found"));
    expect(await plugin.recordRemoteResult({ id, did: "did:A", opId: "op1", result: { outcome: "created", handle: "up-1" } })).toEqual({ destination: "ledger" });
    expect(await plugin.recordRemoteResult({ id, did: "did:A", opId: "op1", result: { outcome: "created", handle: "up-1" } })).toEqual({ destination: "ledger" });
    await plugin.beginRemoteOp(receipt(id, { opId: "op2", kind: "hosted_submit" }));
    await plugin.recordRemoteResult({ id, did: "did:A", opId: "op2", result: { outcome: "created", jobId: "job-1" } });
    expect((await plugin.listPending()).recordings[0]!.ledger?.remote).toMatchObject([
      { opId: "op1", stage: "uploading", uploadId: "up-1" }, { opId: "op2", stage: "submitted", jobId: "job-1" },
    ]);
    await plugin.deleteAudio({ id });
    const entries = (await plugin.listOutbox({ did: "did:A" })).entries;
    expect(entries.map((e) => [e.kind, e.handle]).sort()).toEqual([["hosted_upload", "up-1"], ["transcript", "job-1"]]);
    expect((await plugin.listOutbox({ did: "did:B" })).entries).toEqual([]);
    await plugin.completeOutbox({ entryId: entries[0]!.entryId, result: "retry" });
    expect((await plugin.listOutbox({ did: "did:A" })).entries.find((e) => e.entryId === entries[0]!.entryId)).toMatchObject({ attempts: 1, state: "pending" });
    for (const entry of entries) await plugin.completeOutbox({ entryId: entry.entryId, result: "done" });
    expect((await plugin.listOutbox({ did: "did:A" })).entries).toEqual([]);
    await expect(plugin.completeOutbox({ entryId: "gone", result: "done" })).rejects.toEqual(code("not_found"));
  });

  test("a receipt for a note this device does not have goes straight to the outbox", async () => {
    const s = await make();
    const { plugin } = s;
    await signIn(plugin);
    await plugin.beginRemoteOp(receipt("ghost"));
    expect((await plugin.listOutbox({ did: "did:A" })).entries).toMatchObject([{ state: "unknown", handle: null }]);
    expect(await plugin.recordRemoteResult({ id: "ghost", did: "did:A", opId: "op1", result: { outcome: "created", handle: "up-9" } })).toEqual({ destination: "outbox" });
    expect((await plugin.listOutbox({ did: "did:A" })).entries).toMatchObject([{ kind: "hosted_upload", handle: "up-9", state: "pending" }]);
  });

  test("returned values are snapshots, and putTranscript alone leaves rev unchanged", async () => {
    const s = await make();
    const { plugin } = s;
    const saved = await note(s);
    await signIn(plugin);
    expect(saved).toMatchObject({ owner: null, rev: 1 });
    const listed = (await plugin.listPending()).recordings[0]!;
    listed.owner = "did:B";
    expect((await plugin.listPending()).recordings[0]).toMatchObject({ owner: "did:A", rev: 2 });
    const transcript = { version: 1, noteId: saved.id, transcriber: "on-device", rev: 1, engine: "parakeet-tdt-0.6b-v3", model: null, language: "en",
      outcome: "transcribed", diarized: false, segments: [], createdAt: "2026-10-07T00:00:00Z" } as const;
    await expect(plugin.putTranscript({ id: saved.id, transcript: { ...transcript, noteId: "other" } })).rejects.toEqual(code("transcript_note_mismatch"));
    await plugin.putTranscript({ id: saved.id, transcript });
    expect(await plugin.getTranscript({ id: saved.id })).toEqual({ transcript });
    expect((await plugin.listPending()).recordings[0]!.rev).toBe(2);
    expect(await plugin.updateLedger({ id: saved.id, did: "did:A", rev: 2, patch: {} })).toEqual({ rev: 3 });
  });

  test("the quarantine API answers an empty queue and refuses unknown ids", async () => {
    const { plugin } = await make();
    expect(await plugin.listQuarantine()).toEqual({ items: [] });
    await expect(plugin.retryRecovery({ id: "x" })).rejects.toEqual(code("not_found"));
    await expect(plugin.discardFailedRecording({ id: "x" })).rejects.toEqual(code("not_found"));
    await plugin.deleteQuarantined({ id: "x" });
  });

  test("committed events are retained and delivered to a late listener in order", async () => {
    const s = await make();
    const first = await note(s);
    const second = await note(s);
    const received: (string | undefined)[] = [];
    await s.plugin.addListener("committed", (event) => received.push(event.id));
    await s.settle();
    expect(received).toEqual([first.id, second.id]);
    const later: (string | undefined)[] = [];
    await s.plugin.addListener("committed", (event) => later.push(event.id));
    await s.settle();
    expect(later).toEqual([]);
  });

  test("mic-state events carry the contract fields", async () => {
    const s = await make();
    const events: { state: string; reason: string | null; at: number; id?: string | null }[] = [];
    await s.plugin.addListener("micState", (event) => events.push(event));
    const { id } = await s.plugin.start();
    await s.settle();
    expect(events.at(-1)).toMatchObject({ state: "recording", reason: null, at: expect.any(Number), id });
    await s.plugin.discard();
  });
});
