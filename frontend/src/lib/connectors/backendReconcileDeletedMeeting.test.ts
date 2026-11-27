import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { reconcileBackendMeetings, type BackendReconcileMeetingsClient } from "./backendReconcile";
import { CONNECTORS_KV_PREFIX, meetingKvKey, transcriptKvKey } from "./connectorStore";

const sourceId = "fireflies-42";
const meta = { sourceId, title: "Planning", ts: "2026-11-01T12:00:00Z", storedAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z", sizeBytes: 42, hasTranscript: true, hasSummary: false };

async function fixture() {
  const entries = new Map<string, string>();
  const puts: string[] = [];
  let reads = 0;
  let markerFailure = false;
  let markDuringWrite = false;
  let acks = 0;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceId)));
  const markerKey = `${CONNECTORS_KV_PREFIX}/fireflies/deleted/${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const tcw = { kv: {
    async get(key: string) {
      if (key === markerKey) {
        reads += 1;
        if (markerFailure) return { ok: false, error: { code: "KV_UNAVAILABLE", message: "offline" } };
      }
      const data = entries.get(key);
      return data === undefined ? { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } } : { ok: true, data: { data } };
    },
    async put(key: string, value: string) {
      puts.push(key);
      entries.set(key, value);
      if (markDuringWrite && key === meetingKvKey("fireflies", sourceId)) entries.set(markerKey, JSON.stringify({ v: 1, deleted_at: "2026-11-02T00:00:00Z" }));
      return { ok: true, data: undefined };
    },
    async delete(key: string) { entries.delete(key); return { ok: true, data: undefined }; },
  } } as unknown as TinyCloudWeb;
  const meetings: BackendReconcileMeetingsClient = {
    async list() { return { status: "ok", value: { source: "fireflies", meetings: [meta], hasMore: false, nextCursor: null } }; },
    async read() { return { status: "ok", value: { source: "fireflies", sourceId, meta, content: { transcript: [{ text: "private" }] } } }; },
    async markReconciled() { acks += 1; return { status: "ok", value: { reconciled: true, source: "fireflies", sourceId } }; },
  };
  const run = () => reconcileBackendMeetings({ tcw, meetings, secrets: { isUnlocked: () => true } });
  return { run, entries, puts, markerKey, reads: () => reads, acks: () => acks, failReads: () => { markerFailure = true; }, markDuringWrite: () => { markDuringWrite = true; } };
}

test("a marked Fireflies meeting is skipped without a user-space copy or ack", async () => {
  const f = await fixture();
  f.entries.set(f.markerKey, JSON.stringify({ v: 1, deleted_at: "2026-11-02T00:00:00Z" }));
  const result = await f.run();
  expect(result).toMatchObject({ ok: true, data: { written: 0, skipped: 1, failures: [] } });
  expect(f.puts).toEqual([]);
  expect(f.acks()).toBe(0);
});

test("an unavailable owner-space marker read prevents reconcile writes", async () => {
  const f = await fixture();
  f.failReads();
  const result = await f.run();
  expect(result).toMatchObject({ ok: true, data: { written: 0, failures: [{ sourceId, stage: "storage" }] } });
  expect(f.puts).toEqual([]);
  expect(f.acks()).toBe(0);
});

test("a marker appearing during Fireflies reconcile removes the copy and body", async () => {
  const f = await fixture();
  f.markDuringWrite();
  const result = await f.run();
  expect(result).toMatchObject({ ok: true, data: { written: 0, skipped: 1, failures: [] } });
  expect(f.entries.has(meetingKvKey("fireflies", sourceId))).toBe(false);
  expect(f.entries.has(transcriptKvKey("fireflies", sourceId))).toBe(false);
  expect(f.acks()).toBe(0);
  expect(f.reads()).toBe(2);
});
