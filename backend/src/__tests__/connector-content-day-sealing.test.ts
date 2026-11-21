import { afterEach, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { ConnectorKeyStore, utcDay } from "../services/connector-key-store.js";
import { ContentStore, KvContentBlobStore } from "../services/content-store.js";
import type { ContentCleanupEntry } from "../services/content-day-sealing.js";
import type { ContentUpsertInput } from "../services/fetch-worker.js";
import { useRealConnectorStorageInTests } from "./connector-real-storage-test-setup.js";

useRealConnectorStorageInTests();

const SOURCE = "fireflies";
const OWNER = "0x1111111111111111111111111111111111111111";
const MASTER = "R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9";
const MEETING = "stage3-private-meeting-fixture";
const RECEIPT = Date.parse("2026-11-18T18:00:00.000Z");
const DEADLINE = Date.parse("2026-12-02T00:00:00.000Z");
const SLOT = utcDay(DEADLINE) - 1;
const PREFIX = `connector-content/${SOURCE}/${OWNER}/`;
const INDEX = `connector-content-index/${SOURCE}/${OWNER}`;
const REPLAY = "connector-content-replay-tombstone";
const iso = (time: number) => new Date(time).toISOString();
const release: Array<() => void> = [];

afterEach(() => { for (const cleanup of release.splice(0)) cleanup(); });

function fixture() {
  let time = RECEIPT;
  const now = () => time;
  const dir = mkdtempSync("/var/tmp/tc2778-content-");
  const keys = ConnectorKeyStore.open(dir, now);
  release.push(() => { keys.close(); rmSync(dir, { recursive: true, force: true }); });
  const data = new Map<string, unknown>();
  const reads: string[] = [];
  const node = { kv: {
    async get(key: string) {
      reads.push(key);
      return { ok: true, data: data.has(key) ? { data: structuredClone(data.get(key)) } : null };
    },
    async put(key: string, value: unknown) { data.set(key, structuredClone(value)); return { ok: true }; },
    async delete(key: string) { data.delete(key); return { ok: true }; },
    async list({ prefix }: { prefix: string }) {
      return { ok: true, data: { keys: [...data.keys()].filter(key => key.startsWith(prefix)), truncated: false } };
    },
  } } as unknown as TinyCloudNode;
  const blobs = new KvContentBlobStore(node);
  const store = new ContentStore(blobs, { now, master: () => MASTER, retentionKeys: keys });
  const put = (override: Partial<ContentUpsertInput> = {}) => store.upsert({
    source: SOURCE, address: OWNER, sourceId: MEETING, kind: "summary", content: { text: "fixture" },
    sourceTimestamp: iso(RECEIPT), ts: iso(RECEIPT - 1000), receivedAt: iso(now()), fetchedAt: iso(now()),
    ...override,
  });
  return { data, reads, keys, store, put, now,
    setTime: (next: number) => { time = next; },
    entries: () => (data.get(INDEX) as { entries: ContentCleanupEntry[] }).entries,
    contentPaths: () => [...data.keys()].filter(key => key.startsWith(PREFIX)),
    markers: () => [...data.keys()].filter(key => key.startsWith(`${REPLAY}/`)),
  };
}

test("an empty archive writes a v2 blob and marker in the same slot, with ID-free KV paths and index", async () => {
  expect(process.env.CONNECTOR_KEY_STORE_TEST_PLAINTEXT).toBeUndefined();
  const f = fixture();
  expect(await f.store.list(SOURCE, OWNER)).toEqual([]);
  expect(await f.put()).toEqual({ ok: true, stored: "created" });
  const [entry] = f.entries();
  expect(entry).toMatchObject({ slot: SLOT, expiresAt: "2026-12-02" });
  expect(entry!.path).toMatch(/^content\/[a-f0-9]{64}$/);
  expect(f.contentPaths()).toEqual([PREFIX + entry!.path]);
  expect(f.data.get(PREFIX + entry!.path)).toMatchObject({ version: 2, keySlot: SLOT });
  expect(f.markers()).toHaveLength(1);
  expect(f.markers()[0]).toStartWith(`${REPLAY}/v2/${SLOT}/`);
  expect(JSON.stringify([...f.data]).includes(MEETING)).toBe(false);
  expect((await f.store.get(SOURCE, OWNER, MEETING))?.meta.sourceId).toBe(MEETING);
  expect((await f.store.list(SOURCE, OWNER)).map(meta => meta.sourceId)).toEqual([MEETING]);
  f.setTime(RECEIPT + 86_400_000);
  expect(await f.put({ sourceTimestamp: iso(f.now()), kind: "transcript" })).toEqual({ ok: true, stored: "merged" });
  expect(f.contentPaths()).toEqual([PREFIX + entry!.path]);
  expect(f.entries()).toHaveLength(1);
  expect(f.markers()).toHaveLength(1);
});

test("the metadata-only sweep deletes a row after its slot key is already destroyed", async () => {
  const f = fixture();
  expect((await f.put()).ok).toBe(true);
  expect(f.keys.getDayKey(SLOT)?.length).toBe(32);
  f.setTime(DEADLINE);
  f.keys.advance();
  expect(f.keys.getDayKey(SLOT)).toBeNull();
  expect(f.contentPaths()).toHaveLength(1);
  f.reads.length = 0;
  expect(await f.store.sweepRetention({ source: SOURCE, address: OWNER })).toMatchObject({ swept: 1, unreadableIndex: false });
  expect(f.reads.some(key => key.startsWith(PREFIX))).toBe(false);
  expect(f.contentPaths()).toHaveLength(0);
  expect(f.entries()).toEqual([]);
});

test("an edited cleanup entry cannot delete its live row and is kept for investigation", async () => {
  const f = fixture();
  expect((await f.put()).ok).toBe(true);
  const [valid] = f.entries();
  const forged = { ...valid, slot: utcDay(RECEIPT) - 1, expiresAt: "2026-11-18" };
  f.data.set(INDEX, { version: 2, entries: [forged] });
  expect(await f.store.sweepRetention({ source: SOURCE, address: OWNER })).toMatchObject({ swept: 0, unreadableIndex: true });
  expect(f.entries()).toEqual([forged]);
  expect(f.contentPaths()).toEqual([PREFIX + valid!.path]);
});

test("moving a v2 envelope to a different path cannot open it", async () => {
  const f = fixture();
  expect((await f.put()).ok).toBe(true);
  expect((await f.put({ sourceId: "other-meeting" })).ok).toBe(true);
  const [first, second] = f.contentPaths();
  f.data.set(first!, f.data.get(second!));
  await expect(f.store.get(SOURCE, OWNER, MEETING)).rejects.toThrow("Content envelope unreadable");
});

test("a replay a second before the boundary is deduped and a second after is too old", async () => {
  const f = fixture();
  expect((await f.put()).ok).toBe(true);
  expect(await f.store.markReconciled(SOURCE, OWNER, MEETING)).toBe(true);
  expect(await f.store.deleteReconciled(SOURCE, OWNER)).toEqual({ removed: 1 });
  expect(f.contentPaths()).toHaveLength(0);
  f.setTime(DEADLINE - 1000);
  expect(await f.put()).toEqual({ ok: false, code: "retention_tombstoned" });
  f.setTime(DEADLINE + 1000);
  expect(await f.put()).toEqual({ ok: false, code: "meeting_too_old" });
  expect(await f.store.sweepExpiredReplayTombstones()).toBe(1);
  expect(f.markers()).toEqual([]);
  expect(await f.store.tombstoned({ source: SOURCE, address: OWNER, meetingId: MEETING,
    sourceTimestamp: iso(RECEIPT), receivedAt: iso(f.now()) })).toBe(true);
});

test("over-skewed provider timestamps are refused and the timestamp-less basis is receipt time", async () => {
  const f = fixture();
  const sourceTimestamp = iso(RECEIPT + 5 * 60_000 + 1);
  expect(await f.store.tombstoned({ source: SOURCE, address: OWNER, meetingId: MEETING,
    sourceTimestamp, receivedAt: iso(RECEIPT) })).toBe(true);
  expect(await f.put({ sourceTimestamp })).toEqual({ ok: false, code: "meeting_too_old" });
  expect(f.contentPaths()).toEqual([]);
  expect((await f.put({ sourceTimestamp: undefined })).ok).toBe(true);
  expect(f.entries()[0]?.slot).toBe(SLOT);
  expect(f.markers()[0]).toStartWith(`${REPLAY}/v2/${SLOT}/`);
});

test("the first guarded marker sweep removes all v1 rows and preserves live v2 markers", async () => {
  const f = fixture();
  expect((await f.put()).ok).toBe(true);
  for (const digest of ["a".repeat(64), "b".repeat(64)]) {
    f.data.set(`${REPLAY}/v1/${digest}`, { expiresAt: iso(DEADLINE), mac: "example" });
  }
  expect(await f.store.sweepExpiredReplayTombstones()).toBe(2);
  expect(f.markers()).toHaveLength(1);
  expect(f.markers()[0]).toStartWith(`${REPLAY}/v2/${SLOT}/`);
});

test("legacy content indexes and orphan rows are refused and preserved in key-store mode", async () => {
  const f = fixture();
  const legacyBlob = { ciphertext: "v1", wrappedDEK: "v1", updatedAt: iso(RECEIPT) };
  f.data.set(INDEX, legacyBlob);
  await expect(f.store.list(SOURCE, OWNER)).rejects.toThrow();
  expect((await f.put()).ok).toBe(false);
  expect(f.data.get(INDEX)).toEqual(legacyBlob);
  f.data.delete(INDEX);
  f.data.set(PREFIX + MEETING, legacyBlob);
  await expect(f.store.get(SOURCE, OWNER, MEETING)).rejects.toThrow();
  expect(await f.store.sweepRetention({ source: SOURCE, address: OWNER })).toMatchObject({ swept: 0, unreadableIndex: true });
  expect(f.data.get(PREFIX + MEETING)).toEqual(legacyBlob);
});
