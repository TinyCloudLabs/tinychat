import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { ConnectorControlStore, deletedMeetingKey } from "../routes/connector-webhooks.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ID = "private-meeting-id";
const NOW = Date.UTC(2026, 10, 22, 17, 30);
const CURRENT = "current master with at least 32 bytes of independent entropy abcdefghijklmnop";
const PREVIOUS = "previous master with at least 32 bytes of independent entropy zyxwvutsrqponmlk";
const savedCurrent = process.env.WEBHOOK_HMAC_MASTER;
const savedPrevious = process.env.WEBHOOK_HMAC_MASTER_PREV;

afterEach(() => {
  if (savedCurrent === undefined) delete process.env.WEBHOOK_HMAC_MASTER;
  else process.env.WEBHOOK_HMAC_MASTER = savedCurrent;
  if (savedPrevious === undefined) delete process.env.WEBHOOK_HMAC_MASTER_PREV;
  else process.env.WEBHOOK_HMAC_MASTER_PREV = savedPrevious;
});

function fixture() {
  const data = new Map<string, unknown>();
  const node = { kv: {
    async get(key: string) { return { ok: true, data: data.has(key) ? { data: data.get(key) } : null }; },
    async put(key: string, value: unknown) { data.set(key, value); return { ok: true }; },
    async delete(key: string) { data.delete(key); return { ok: true }; },
    async list({ prefix }: { prefix: string }) {
      return { ok: true, data: { keys: [...data.keys()].filter(key => key.startsWith(prefix)), truncated: false } };
    },
  } } as unknown as TinyCloudNode;
  return { data, control: new ConnectorControlStore(node, () => NOW) };
}

test("a deleted marker remains readable after webhook master rotation", async () => {
  process.env.WEBHOOK_HMAC_MASTER = PREVIOUS;
  delete process.env.WEBHOOK_HMAC_MASTER_PREV;
  const { data, control } = fixture();
  await control.markDeleted("fireflies", ADDRESS, ID);
  const key = deletedMeetingKey("fireflies", ADDRESS, ID);
  expect(key).toBe(`webhooks/deleted/fireflies/${ADDRESS}/${createHash("sha256").update(ID).digest("hex")}`);
  expect(data.get(key)).toEqual({ v: 1, deleted_at: new Date(NOW).toISOString() });

  process.env.WEBHOOK_HMAC_MASTER = CURRENT;
  process.env.WEBHOOK_HMAC_MASTER_PREV = PREVIOUS;
  expect(await control.readDeleted("fireflies", ADDRESS, ID)).toBe(true);
  delete process.env.WEBHOOK_HMAC_MASTER_PREV;
  expect(await control.readDeleted("fireflies", ADDRESS, ID)).toBe(true);
  expect(await control.readDeleted("fireflies", ADDRESS, "another-id")).toBe(false);
});

test("allow-back clears only owner's 64-hex marker keys", async () => {
  const { data, control } = fixture();
  await control.markDeleted("fireflies", ADDRESS, ID);
  await control.markDeleted("fireflies", OTHER, ID);
  await control.markDeleted("granola", ADDRESS, ID);
  await control.clearDeleted("fireflies", ADDRESS);
  expect(data.has(deletedMeetingKey("fireflies", ADDRESS, ID))).toBe(false);
  expect(data.has(deletedMeetingKey("fireflies", OTHER, ID))).toBe(true);
  expect(data.has(deletedMeetingKey("granola", ADDRESS, ID))).toBe(true);
});

test("allow-back refuses an unrecognized key without clearing a valid marker", async () => {
  const { data, control } = fixture();
  await control.markDeleted("fireflies", ADDRESS, ID);
  data.set(`webhooks/deleted/fireflies/${ADDRESS}/not-a-64-hex-key`, { v: 1 });
  await expect(control.clearDeleted("fireflies", ADDRESS)).rejects.toThrow("Invalid deleted-meeting key");
  expect(data.has(deletedMeetingKey("fireflies", ADDRESS, ID))).toBe(true);
});
