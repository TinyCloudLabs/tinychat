import { expect, test } from "bun:test";
import { dayContentPath } from "../services/content-day-sealing.js";
import { slotFor } from "../services/connector-retention-keys.js";
import { ContentStore, InMemoryContentBlobStore } from "../services/content-store.js";

test("the day-key sweep removes expired content and reports unreadable indexes separately from overdue rows", async () => {
  const source = "fireflies";
  const address = "0x1111111111111111111111111111111111111111";
  const sourceId = "day-sweep-fixture";
  const receivedAt = "2026-11-18T18:00:00.000Z";
  const deadline = Date.parse("2026-12-02T00:00:00.000Z");
  const dayKey = Buffer.alloc(32, 1);
  const blobs = new InMemoryContentBlobStore();
  let now = Date.parse(receivedAt);
  const store = new ContentStore(blobs, {
    now: () => now,
    master: () => Buffer.alloc(32, 2).toString("base64"),
    retentionKeys: {
      getLiveDayKeys: () => now < deadline ? [{ day: slotFor(deadline), key: dayKey }] : [],
    },
  });

  expect(await store.upsert({
    source, address, sourceId, kind: "summary", content: { text: "fixture" },
    sourceTimestamp: receivedAt, receivedAt, fetchedAt: receivedAt,
  })).toEqual({ ok: true, stored: "created" });
  const path = dayContentPath(dayKey, sourceId);
  expect(await blobs.read(source, address, path)).not.toBeNull();

  now = deadline;
  const noOverdue = { overdue: 0, oldestOverdueAgeMs: 0 };
  expect(await store.sweepRetention({ source, address })).toMatchObject({
    swept: 1, unreadableIndex: false, ...noOverdue,
  });
  expect(await blobs.read(source, address, path)).toBeNull();

  await blobs.writeIndex(source, address, {
    version: 1, wrappedDEK: "legacy", ciphertext: "legacy", updatedAt: receivedAt,
  });
  expect(await store.sweepRetention({ source, address })).toMatchObject({
    swept: 0, unreadableIndex: true, ...noOverdue,
  });
});
