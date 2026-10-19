import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";
import { currentAccountGeneration } from "./accountContext";
import { markVoiceNoteInventoryUnknown, projectVoiceNotePending, readVoiceNotePendingSnapshot,
  writeVoiceNotePendingSnapshot } from "./voiceNotePendingSnapshot";

const note = (id: string, owner: string, startedAt: number, state: "queued" | "done"): VoiceNoteRecording => ({
  id, owner, startedAt, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 10,
  silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
  options: { transcriber: "on-device", identifySpeakers: false, uploadAudio: false },
  stt: { state, pack: null, engine: null, segmentsDone: 0, windowsDone: 0, error: null },
  ledger: { audio: { state: "saved", rowId: `vn-${id}` }, transcript: { state: "pending" } },
} as VoiceNoteRecording);

test("snapshot projects only the signed-in owner's pending row, decode and transcript, with oldest capture time", () => {
  const first = note("a", "did:alice", 1_000, "queued");
  first.ledger!.audio = { state: "pending" };
  const done = note("b", "did:alice", 2_000, "done");
  const other = note("c", "did:bob", 100, "queued");
  const receiptMissing = note("d", "did:alice", 3_000, "done");
  receiptMissing.ledger!.audio = { state: "saved", rowId: null };
  expect(projectVoiceNotePending([first, done, other, receiptMissing], "did:alice")).toEqual({
    pending_row: 2, pending_decode: 1, pending_transcript: 2,
    oldest_started_at: new Date(1_000).toISOString(),
  });
});

test("snapshot CAS keeps newer observations, failure shows unknown rather than healthy zero", async () => {
  const values = new Map<string, { value: string; etag: string }>();
  let sequence = 0;
  const tcw = { did: "did:alice", spaceId: "space:alice", kv: {
    get: async (key: string) => {
      const item = values.get(key);
      return item ? { ok: true, data: { data: item.value, headers: { etag: item.etag } } }
        : { ok: false, error: { code: "KV_NOT_FOUND" } };
    },
    put: async (key: string, value: string, options: { ifMatch?: string; ifNoneMatch?: string }) => {
      const previous = values.get(key);
      if (previous && previous.etag !== options.ifMatch || !previous && options.ifNoneMatch !== "*")
        return { ok: false, error: { code: "KV_PRECONDITION_FAILED" } };
      values.set(key, { value, etag: `etag-${++sequence}` });
      return { ok: true, data: {} };
    },
  } } as unknown as TinyCloudWeb;
  const ctx = { did: tcw.did, spaceId: tcw.spaceId!, generation: currentAccountGeneration() };
  const observedAt = new Date().toISOString();
  const older = new Date(Date.now() - 60_000).toISOString();
  expect(await writeVoiceNotePendingSnapshot(tcw, [note("a", ctx.did, Date.now() - 20_000, "queued")],
    ctx, observedAt, "test-install", () => {})).toBe(true);
  expect(await writeVoiceNotePendingSnapshot(tcw, [], ctx, older, "test-install", () => {})).toBe(false);
  const fresh = await readVoiceNotePendingSnapshot(tcw, ctx, "test-install");
  expect(fresh).toMatchObject({ status: "fresh", snapshot: { pending_decode: 1, pending_row: 0 } });
  expect(fresh.oldestAgeMs).toBeGreaterThan(0);
  markVoiceNoteInventoryUnknown(ctx);
  expect(await readVoiceNotePendingSnapshot(tcw, ctx, "test-install")).toMatchObject({ status: "unknown",
    snapshot: { pending_decode: 1 } });
  const previousWrites = sequence;
  const get = tcw.kv.get.bind(tcw.kv);
  tcw.kv.get = async (...args: Parameters<typeof get>) => {
    const response = await get(...args);
    Object.defineProperty(tcw, "did", { value: "did:bob", configurable: true });
    return response;
  };
  expect(await writeVoiceNotePendingSnapshot(tcw, [], ctx, new Date(Date.now() + 1_000).toISOString(),
    "test-install", () => {})).toBe(false);
  expect(sequence).toBe(previousWrites);
  expect(await readVoiceNotePendingSnapshot(tcw, ctx, "test-install")).toEqual({
    status: "unknown", snapshot: null, oldestAgeMs: null,
  });
});

test("reader distinguishes absent, stale backlog and fresh zero from observation time", async () => {
  const old = new Date(Date.now() - 95 * 60_000).toISOString();
  let raw: string | null = null;
  const tcw = { did: "did:stale", spaceId: "space:stale", kv: {
    get: async () => raw === null ? { ok: false, error: { code: "KV_NOT_FOUND" } }
      : { ok: true, data: { data: raw } },
  } } as unknown as TinyCloudWeb;
  const ctx = { did: tcw.did, spaceId: tcw.spaceId!, generation: currentAccountGeneration() };
  expect((await readVoiceNotePendingSnapshot(tcw, ctx, "stale-install")).status).toBe("absent");
  const snapshot = { version: 1, install_id: "stale-install", observed_at: old, checked_at: new Date().toISOString(),
    changed_at: old, pending_row: 1, pending_transcript: 0, pending_decode: 0, oldest_started_at: old };
  raw = JSON.stringify(snapshot);
  const stale = await readVoiceNotePendingSnapshot(tcw, ctx, "stale-install");
  expect(stale.status).toBe("stale");
  expect(stale.oldestAgeMs).toBeGreaterThan(90 * 60_000);
  raw = JSON.stringify({ ...snapshot, observed_at: new Date().toISOString(), pending_row: 0, oldest_started_at: null });
  expect(await readVoiceNotePendingSnapshot(tcw, ctx, "stale-install")).toMatchObject({
    status: "fresh", snapshot: { pending_row: 0 }, oldestAgeMs: null,
  });
});
