import { afterEach, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectorControlStore, mergePurgeLedgerIds, purgeLedgerKey } from "../routes/connector-webhooks.js";
import { isTombstoned } from "../services/connector-drain.js";
import { ConnectorKeyStore, utcDay } from "../services/connector-key-store.js";
import { ConnectorQueue, deadLetterKey, pendingQueueKey } from "../services/connector-queue.js";
import { useRealConnectorStorageInTests } from "./connector-real-storage-test-setup.js";

useRealConnectorStorageInTests();

const SOURCE = "fireflies";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const OLD_ID = "legacy-meeting-fixture";
const NEW_ID = "new-meeting-fixture";
const DAY = 86_400_000;
const ADDED_AT = Date.parse("2026-11-01T18:00:00.000Z");
const EXACT_EXPIRY = ADDED_AT + 14 * DAY;
const FLOOR_END = Date.parse("2026-11-15T00:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();
const release: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of release.splice(0)) cleanup();
});

function fixture() {
  let time = ADDED_AT;
  const now = () => time;
  const dir = mkdtempSync("/var/tmp/tc2778-sealed-retention-");
  let keys = ConnectorKeyStore.open(dir, now);
  release.push(() => { keys.close(); rmSync(dir, { recursive: true, force: true }); });
  const data = new Map<string, unknown>();
  const node = { kv: {
    async get(key: string) { return { ok: true, data: data.has(key) ? { data: data.get(key) } : null }; },
    async put(key: string, value: unknown) { data.set(key, structuredClone(value)); return { ok: true }; },
    async delete(key: string) { data.delete(key); return { ok: true }; },
  } } as unknown as TinyCloudNode;
  const queue = () => new ConnectorQueue(node, { now, flushWindowMs: 0, retentionKeys: keys });
  const control = () => new ConnectorControlStore(node, now, keys);
  const pending = pendingQueueKey(SOURCE, ADDRESS);
  const dead = deadLetterKey(SOURCE, ADDRESS);
  const ledger = purgeLedgerKey(SOURCE, ADDRESS);
  const plain = {
    purgedThrough: iso(ADDED_AT), recentIds: [OLD_ID], recentIdsAddedAt: { [OLD_ID]: iso(ADDED_AT) },
    updatedAt: iso(ADDED_AT),
  };
  return { data, queue, control, pending, dead, ledger, plain, now,
    seedQueue() {
      data.set(pending, [{ meetingId: OLD_ID, kind: "summary", receivedAt: iso(ADDED_AT), attempts: 0, nextAttemptAt: iso(ADDED_AT) }]);
    },
    setTime(ms: number) { time = ms; },
    restart(loseFile = false) {
      keys.close();
      if (loseFile) unlinkSync(join(dir, "connector-keys.json"));
      keys = ConnectorKeyStore.open(dir, now);
    },
  };
}

const newEntry = { meetingId: NEW_ID, kind: "summary" } as const;

async function merge(f: ReturnType<typeof fixture>, ids: string[]) {
  const control = f.control();
  const read = await control.readLedger(SOURCE, ADDRESS);
  if (read.status !== "ok") throw new Error("Expected readable fixture ledger");
  await control.writeLedger(SOURCE, ADDRESS, {
    ...mergePurgeLedgerIds(read.ledger, ids, iso(f.now())),
    purgedThrough: read.ledger.purgedThrough,
    updatedAt: iso(f.now()),
  });
}

test("the mixed queue rewrite seals old and new IDs and uses the midnight cutoff for an 18:00 legacy receipt", async () => {
  const f = fixture();
  f.seedQueue();
  const queue = f.queue();
  expect((await queue.list(SOURCE, ADDRESS)).map(item => item.meetingId)).toEqual([OLD_ID]);
  f.setTime(ADDED_AT + DAY);
  expect((await queue.enqueue(SOURCE, ADDRESS, newEntry)).status).toBe("queued");
  const raw = JSON.stringify(f.data.get(f.pending));
  expect(raw.includes(OLD_ID) || raw.includes(NEW_ID)).toBe(false);
  expect((f.data.get(f.pending) as Array<{ slot: number }>).map(entry => entry.slot)).toEqual([
    utcDay(FLOOR_END) - 1, utcDay(FLOOR_END),
  ]);

  f.restart();
  const restarted = f.queue();
  f.setTime(FLOOR_END - 1);
  expect((await restarted.list(SOURCE, ADDRESS)).map(item => item.meetingId)).toEqual([OLD_ID, NEW_ID]);
  f.setTime(FLOOR_END);
  expect((await restarted.list(SOURCE, ADDRESS)).map(item => item.meetingId)).toEqual([NEW_ID]);
  expect(FLOOR_END).toBeLessThan(EXACT_EXPIRY);
});

test("untouched legacy rows keep the exact 18:00 expiry in both stores", async () => {
  const f = fixture();
  const queue = f.queue();
  const control = f.control();
  f.seedQueue();
  f.data.set(f.ledger, f.plain);
  f.setTime(EXACT_EXPIRY - 1);
  expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);
  expect(await control.readLedger(SOURCE, ADDRESS)).toEqual({ status: "ok", ledger: f.plain });
  expect(f.data.get(f.ledger)).toEqual(f.plain);

  f.setTime(EXACT_EXPIRY);
  expect(await queue.depth(SOURCE, ADDRESS)).toBe(0);
  const read = await control.readLedger(SOURCE, ADDRESS);
  expect(read.status === "ok" && read.ledger.recentIds.length).toBe(0);
  expect(f.data.get(f.ledger)).toMatchObject({ purgedThrough: f.plain.purgedThrough, recentIdCodes: [] });
});

test("queue envelopes moved across tenants or days cannot be opened; dead letters also stay sealed", async () => {
  const f = fixture();
  const queue = f.queue();
  await queue.enqueue(SOURCE, ADDRESS, newEntry);
  const [entry] = f.data.get(f.pending) as Array<{ slot: number; sealed: string }>;
  f.data.set(pendingQueueKey(SOURCE, OTHER), [entry]);
  expect(await queue.depth(SOURCE, OTHER)).toBe(0);
  f.data.set(pendingQueueKey(SOURCE, OTHER), [{ ...entry, slot: entry!.slot - 1 }]);
  expect(await queue.depth(SOURCE, OTHER)).toBe(0);
  f.data.set(f.pending, [{ ...entry, slot: entry!.slot - 1 }]);
  expect(await queue.depth(SOURCE, ADDRESS)).toBe(0);
  f.data.set(f.pending, [entry]);
  await queue.settle(SOURCE, ADDRESS, [{ ...newEntry, status: "failed", terminal: true }]);
  expect(JSON.stringify(f.data.get(f.dead)).includes(NEW_ID)).toBe(false);
  expect((await queue.dead(SOURCE, ADDRESS)).map(item => item.meetingId)).toEqual([NEW_ID]);
});

test("ledger migration stores only codes; the midnight sweep leaves the watermark effective with zero codes", async () => {
  const f = fixture();
  f.data.set(f.ledger, f.plain);
  await merge(f, [NEW_ID]);
  const raw = JSON.stringify(f.data.get(f.ledger));
  expect(raw.includes(OLD_ID) || raw.includes(NEW_ID)).toBe(false);
  f.restart();

  const replay = { meetingId: OLD_ID, sourceTimestamp: iso(ADDED_AT - 1), receivedAt: iso(FLOOR_END) };
  const newerStamp = { ...replay, sourceTimestamp: iso(ADDED_AT + 1) };
  const control = f.control();
  f.setTime(FLOOR_END - 1);
  const before = await control.readLedger(SOURCE, ADDRESS);
  expect(before.status === "ok" && isTombstoned(newerStamp, before.ledger)).toBe(true);

  f.setTime(FLOOR_END);
  // Even a view loaded just before midnight cannot match a code after its key is destroyed.
  expect(before.status === "ok" && before.ledger.matchesRecentIdCode?.(OLD_ID)).toBe(false);
  const after = await control.readLedger(SOURCE, ADDRESS);
  expect(f.data.get(f.ledger)).toMatchObject({ purgedThrough: f.plain.purgedThrough, recentIdCodes: [] });
  expect(after.status === "ok" && after.ledger.recentIds).toEqual([]);
  expect(after.status === "ok" && isTombstoned(replay, after.ledger)).toBe(true);
  expect(after.status === "ok" && isTombstoned({ ...replay, sourceTimestamp: undefined }, after.ledger)).toBe(true);
  expect(after.status === "ok" && isTombstoned({ ...replay, sourceTimestamp: "invalid" }, after.ledger)).toBe(true);
});

test("a tampered ledger code reads as unparseable", async () => {
  const f = fixture();
  f.data.set(f.ledger, f.plain);
  await merge(f, []);
  const raw = f.data.get(f.ledger) as { recentIdCodes: Array<{ mac: string }> };
  raw.recentIdCodes[0]!.mac = "A".repeat(43);
  const control = f.control();
  expect((await control.readLedger(SOURCE, ADDRESS)).status).toBe("unparseable");
});

test("a replaced key file leaves old queue entries unreadable and the live ledger fails closed", async () => {
  const f = fixture();
  f.data.set(f.ledger, f.plain);
  await merge(f, []);
  await f.queue().enqueue(SOURCE, ADDRESS, newEntry);
  f.restart(true);
  expect(await f.queue().depth(SOURCE, ADDRESS)).toBe(0);
  expect((await f.control().readLedger(SOURCE, ADDRESS)).status).toBe("unparseable");
});

test("rewriting legacy state after its slot ends drops old IDs without extending retention", async () => {
  const f = fixture();
  f.seedQueue();
  f.data.set(f.ledger, f.plain);
  f.setTime(FLOOR_END);

  await f.queue().enqueue(SOURCE, ADDRESS, newEntry);
  await merge(f, [NEW_ID]);
  expect((await f.queue().list(SOURCE, ADDRESS)).map(item => item.meetingId)).toEqual([NEW_ID]);
  const result = await f.control().readLedger(SOURCE, ADDRESS);
  expect(result.status === "ok" && result.ledger.recentIdCodes?.length).toBe(1);
  expect(result.status === "ok" && result.ledger.matchesRecentIdCode?.(OLD_ID)).toBe(false);
  expect(result.status === "ok" && result.ledger.matchesRecentIdCode?.(NEW_ID)).toBe(true);
});

test("a stale coded-ledger writer cannot move the watermark backwards", async () => {
  const f = fixture();
  const control = f.control();
  const earlier = f.plain;
  const later = { ...earlier, purgedThrough: iso(f.now() + 1) };
  await control.writeLedger(SOURCE, ADDRESS, later);
  await control.writeLedger(SOURCE, ADDRESS, earlier);
  const result = await control.readLedger(SOURCE, ADDRESS);
  expect(result.status === "ok" && result.ledger.purgedThrough).toBe(later.purgedThrough);
});

test("queue and ledger writes need a configured store or the explicit test flag", async () => {
  const node = { kv: {
    async get() { return { ok: true, data: null }; },
    async put() { throw new Error("Unexpected plaintext write"); },
  } } as unknown as TinyCloudNode;
  const prior = process.env.CONNECTOR_KEY_STORE_TEST_PLAINTEXT;
  delete process.env.CONNECTOR_KEY_STORE_TEST_PLAINTEXT;
  try {
    const queue = new ConnectorQueue(node, { flushWindowMs: 0 });
    await expect(queue.enqueue(SOURCE, ADDRESS, newEntry)).rejects.toThrow("Connector key store required for writes");
    const control = new ConnectorControlStore(node);
    await expect(control.writeLedger(SOURCE, ADDRESS, {
      purgedThrough: iso(ADDED_AT), recentIds: [NEW_ID], updatedAt: iso(ADDED_AT),
    })).rejects.toThrow("Connector key store required for writes");
  } finally {
    if (prior !== undefined) process.env.CONNECTOR_KEY_STORE_TEST_PLAINTEXT = prior;
  }
});

test("persisted queue and ledger payload files omit the meeting ID and tenant address", async () => {
  expect(process.env.CONNECTOR_KEY_STORE_TEST_PLAINTEXT).toBeUndefined();
  const dir = mkdtempSync("/var/tmp/tc2778-connector-payloads-");
  const now = () => ADDED_AT;
  const keys = ConnectorKeyStore.open(join(dir, "keys"), now);
  release.push(() => { keys.close(); rmSync(dir, { recursive: true, force: true }); });
  const file = (key: string) => join(dir, createHash("sha256").update(key).digest("hex"));
  const values = new Set<string>();
  const node = { kv: {
    async get(key: string) {
      return { ok: true, data: values.has(key) ? { data: readFileSync(file(key), "utf8") } : null };
    },
    async put(key: string, value: unknown) {
      writeFileSync(file(key), JSON.stringify(value));
      values.add(key);
      return { ok: true };
    },
  } } as unknown as TinyCloudNode;
  const queue = new ConnectorQueue(node, { now, flushWindowMs: 0, retentionKeys: keys });
  const control = new ConnectorControlStore(node, now, keys);
  await queue.enqueue(SOURCE, ADDRESS, newEntry);
  await control.writeLedger(SOURCE, ADDRESS, {
    purgedThrough: iso(ADDED_AT), recentIds: [NEW_ID],
    recentIdsAddedAt: { [NEW_ID]: iso(ADDED_AT) }, updatedAt: iso(ADDED_AT),
  });
  for (const key of [pendingQueueKey(SOURCE, ADDRESS), purgeLedgerKey(SOURCE, ADDRESS)]) {
    const bytes = readFileSync(file(key), "utf8");
    expect(bytes.includes(NEW_ID) || bytes.includes(ADDRESS)).toBe(false);
  }
  expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);
  const read = await control.readLedger(SOURCE, ADDRESS);
  expect(read.status === "ok" && read.ledger.matchesRecentIdCode?.(NEW_ID)).toBe(true);
});
