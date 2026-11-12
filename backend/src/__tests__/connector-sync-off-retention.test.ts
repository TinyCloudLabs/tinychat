import { expect, test } from "bun:test";
import { ContentStore, InMemoryContentBlobStore } from "../services/content-store.js";
import { ConnectorQueue } from "../services/connector-queue.js";

const source = "fireflies";
const address = "0x1111111111111111111111111111111111111111";
const master = "R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9";
const now = Date.parse("2026-11-12T12:00:00Z");

function fixture() {
  let held = true;
  const blobs = new InMemoryContentBlobStore();
  const store = new ContentStore(blobs, {
    master: () => master, now: () => now,
    mutationGuard: { isHolder: () => held },
  });
  const put = (sourceId: string) => store.upsert({
    source, address, sourceId, kind: "summary", content: { text: "summary" },
    fetchedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(),
    ts: new Date(now).toISOString(),
  });
  return { store, blobs, put, loseLease: () => { held = false; } };
}

test("sync-off deletes only reconciled copies and preserves unreconciled summaries", async () => {
  const f = fixture();
  expect((await f.put("saved")).ok).toBe(true);
  expect((await f.put("pending")).ok).toBe(true);
  await f.store.markReconciled(source, address, "saved");
  expect(await f.store.deleteReconciled(source, address)).toEqual({ removed: 1 });
  expect(await f.blobs.read(source, address, "saved")).toBeNull();
  expect(await f.blobs.read(source, address, "pending")).not.toBeNull();
});

test("sync-off fails closed on unreadable index and refuses mutations after lease loss", async () => {
  const f = fixture();
  await f.put("saved");
  await f.store.markReconciled(source, address, "saved");
  f.loseLease();
  await expect(f.store.deleteReconciled(source, address)).rejects.toThrow();
  expect(await f.blobs.read(source, address, "saved")).not.toBeNull();
  const index = await f.blobs.readIndex(source, address);
  await f.blobs.writeIndex(source, address, { ...index!, ciphertext: "invalid" });
  await expect(f.store.deleteReconciled(source, address)).rejects.toThrow();
  expect(await f.blobs.read(source, address, "saved")).not.toBeNull();
});

test("sync-off preserves a reconciled index entry when its blob is unreadable", async () => {
  const f = fixture();
  await f.put("saved");
  await f.store.markReconciled(source, address, "saved");
  const blob = await f.blobs.read(source, address, "saved");
  await f.blobs.write(source, address, "saved", { ...blob!, ciphertext: "invalid" });
  expect(await f.store.deleteReconciled(source, address)).toEqual({ removed: 0 });
  expect(await f.blobs.read(source, address, "saved")).not.toBeNull();
});

test("clear waits for an in-flight flush and leaves no resurrected queue IDs", async () => {
  const stored = new Map<string, unknown>();
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = true;
  const node = { kv: {
    async get(key: string) { return stored.has(key) ? { ok: true, data: { data: stored.get(key) } } : null; },
    async put(key: string, value: unknown) {
      if (hold && key.startsWith("webhooks/pending/")) {
        hold = false;
        writing.resolve();
        await release.promise;
      }
      stored.set(key, value);
      return { ok: true };
    },
    async delete(key: string) { stored.delete(key); return { ok: true }; },
  } };
  const queue = new ConnectorQueue(node as any, { now: () => now, flushWindowMs: 0 });
  const enqueue = queue.enqueue(source, address, { meetingId: "in-flight", kind: "summary" });
  await writing.promise;
  const clear = queue.clear(source, address);
  release.resolve();
  await enqueue;
  await clear;
  expect(await queue.list(source, address)).toEqual([]);
  expect(await queue.dead(source, address)).toEqual([]);
});

test("sync-off preserves a new summary after its final index write fails", async () => {
  let failFinalIndex = false;
  let indexWrites = 0;
  class FailingIndex extends InMemoryContentBlobStore {
    override async writeIndex(...args: Parameters<InMemoryContentBlobStore["writeIndex"]>) {
      if (failFinalIndex && ++indexWrites === 2) throw new Error("index write failed");
      return super.writeIndex(...args);
    }
  }
  const blobs = new FailingIndex();
  const store = new ContentStore(blobs, { master: () => master, now: () => now });
  const input = { source, address, sourceId: "overwritten", kind: "summary" as const,
    content: { text: "first" }, ts: new Date(now).toISOString(),
    fetchedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString() };
  await store.upsert(input);
  await store.markReconciled(source, address, input.sourceId);
  failFinalIndex = true;
  expect(await store.upsert({ ...input, content: { text: "new summary" } })).toEqual({ ok: false, code: "content_store_failed" });
  expect(await store.deleteReconciled(source, address)).toEqual({ removed: 0 });
  expect((await store.get(source, address, input.sourceId))?.content.summary).toEqual({ text: "new summary" });
});
