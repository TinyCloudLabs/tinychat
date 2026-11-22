import { expect, test } from "bun:test";
import { ConnectorQueue } from "../services/connector-queue.js";

const source = "fireflies";
const address = "0x1111111111111111111111111111111111111111";
const now = Date.parse("2026-11-12T12:00:00Z");

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
