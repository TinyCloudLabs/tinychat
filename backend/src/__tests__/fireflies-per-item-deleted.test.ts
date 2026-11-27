import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { ConnectorControlStore, createConnectorPurgeRouter, deletedMeetingKey } from "../routes/connector-webhooks.js";
import { FirefliesDirectImporter, defaultWriteMeeting } from "../services/fireflies-import-executor.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ID = "ff-sensitive-meeting-id";
const NOW = Date.UTC(2026, 10, 22, 17, 30);

function fixture() {
  const data = new Map<string, unknown>();
  let failGet = false;
  let failList: "none" | "reject" | "truncate" = "none";
  let cursorOnly = false;
  const node = { kv: {
    async get(key: string) {
      if (failGet) return { ok: false, error: { message: "read rejected" } };
      return { ok: true, data: data.has(key) ? { data: data.get(key) } : null };
    },
    async put(key: string, value: unknown) { data.set(key, value); return { ok: true }; },
    async delete(key: string) { data.delete(key); return { ok: true }; },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      if (failList === "reject") return { ok: false, error: { message: "list rejected" } };
      if (failList === "truncate") return { ok: true, data: { keys: [], truncated: true } };
      const keys = [...data.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = cursor === undefined ? 0 : Number(cursor);
      return { ok: true, data: { keys: keys.slice(start, start + 1), truncated: cursorOnly ? false : start + 1 < keys.length,
        nextCursor: start + 1 < keys.length ? String(start + 1) : undefined } };
    },
  } } as unknown as TinyCloudNode;
  const control = new ConnectorControlStore(node, () => NOW);
  return { data, control, setFailGet: (failed: boolean) => { failGet = failed; }, setFailList: (mode: "none" | "reject" | "truncate") => { failList = mode; }, setCursorOnly: () => { cursorOnly = true; } };
}

async function withServer(run: (base: string) => Promise<void>, control: ConnectorControlStore, address: string | null = ADDRESS, onRequest?: () => void) {
  const app = express();
  app.use(express.json());
  if (address) app.use((req, _res, next) => { req.user = { address }; next(); });
  if (onRequest) app.use((_req, _res, next) => { onRequest(); next(); });
  app.use("/api/connectors/webhooks", createConnectorPurgeRouter({ control }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    await run(`http://127.0.0.1:${port}/api/connectors/webhooks`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function request(base: string, method: string, body: unknown) {
  return fetch(`${base}/deleted`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("authenticated single-item deletion persists an ID-free marker without changing the broad watermark", async () => {
  const f = fixture();
  await withServer(async base => {
    expect((await request(base, "POST", { source: "fireflies", meetingId: ID })).status).toBe(204);
    expect((await request(base, "POST", { source: "fireflies", meetingId: ID })).status).toBe(204);
  }, f.control);
  const expectedHash = createHash("sha256").update(ID).digest("hex");
  const key = deletedMeetingKey("fireflies", ADDRESS, ID);
  expect(key).toContain(expectedHash);
  expect(f.data.get(key)).toEqual({ v: 1, deleted_at: new Date(NOW).toISOString() });
  expect(JSON.stringify([...f.data])).not.toContain(ID);
  expect(await f.control.readDeleted("fireflies", ADDRESS, ID)).toBe(true);
  expect(await f.control.readDeleted("fireflies", ADDRESS, "another-id")).toBe(false);
  expect(await f.control.readDeleted("fireflies", OTHER, ID)).toBe(false);
  expect(await f.control.readLedger("fireflies", ADDRESS)).toEqual({ status: "absent" });
});

test("deletion route rejects unauthenticated, invalid ID and other sources without writing", async () => {
  const f = fixture();
  await withServer(async base => {
    expect((await request(base, "POST", { source: "fireflies", meetingId: ID })).status).toBe(401);
  }, f.control, null);
  await withServer(async base => {
    expect((await request(base, "POST", { source: "fireflies", meetingId: "../bad" })).status).toBe(400);
    expect((await request(base, "POST", { source: "granola", meetingId: ID })).status).toBe(400);
    expect((await request(base, "DELETE", { source: "granola" })).status).toBe(400);
  }, f.control);
  expect(f.data.size).toBe(0);
});

test("allow-back clears every per-item marker for Fireflies, including paginated keys, without touching another source", async () => {
  const f = fixture();
  await f.control.markDeleted("fireflies", ADDRESS, ID);
  await f.control.markDeleted("fireflies", ADDRESS, "second-id");
  await f.control.markDeleted("fireflies", OTHER, ID);
  await f.control.markDeleted("granola", ADDRESS, ID);
  await withServer(async base => {
    expect((await request(base, "DELETE", { source: "fireflies" })).status).toBe(204);
  }, f.control);
  expect(await f.control.readDeleted("fireflies", ADDRESS, ID)).toBe(false);
  expect(await f.control.readDeleted("fireflies", ADDRESS, "second-id")).toBe(false);
  expect(await f.control.readDeleted("fireflies", OTHER, ID)).toBe(true);
  expect(await f.control.readDeleted("granola", ADDRESS, ID)).toBe(true);
});

test("allow-back follows a nextCursor even when the SDK page has no truncation flag", async () => {
  const f = fixture();
  await f.control.markDeleted("fireflies", ADDRESS, ID);
  await f.control.markDeleted("fireflies", ADDRESS, "second-id");
  f.setCursorOnly();
  await f.control.clearDeleted("fireflies", ADDRESS);
  expect(await f.control.readDeleted("fireflies", ADDRESS, ID)).toBe(false);
  expect(await f.control.readDeleted("fireflies", ADDRESS, "second-id")).toBe(false);
});

test("failed marker reads and truncated allow-back listings fail closed", async () => {
  const f = fixture();
  await f.control.markDeleted("fireflies", ADDRESS, ID);
  f.setFailGet(true);
  await expect(f.control.readDeleted("fireflies", ADDRESS, ID)).rejects.toThrow();
  f.setFailGet(false);
  f.setFailList("truncate");
  await withServer(async base => {
    expect((await request(base, "DELETE", { source: "fireflies" })).status).toBe(503);
  }, f.control);
  f.setFailList("reject");
  await withServer(async base => {
    expect((await request(base, "DELETE", { source: "fireflies" })).status).toBe(503);
  }, f.control);
  expect(await f.control.readDeleted("fireflies", ADDRESS, ID)).toBe(true);
  f.data.set(deletedMeetingKey("fireflies", ADDRESS, ID), { v: 7, deleted_at: "not-a-date" });
  await expect(f.control.readDeleted("fireflies", ADDRESS, ID)).rejects.toThrow();
});

function importer(control: ConnectorControlStore | undefined, writes: string[], fetchMeeting?: () => Promise<unknown>, onWrite?: () => Promise<void>) {
  const scopedNode = {} as TinyCloudNode;
  return new FirefliesDirectImporter({
    delegate: { node: { computeDelegationCid: () => "cid" }, createScopedNode: () => scopedNode } as never,
    grantStore: { loadActive: async () => ({ state: "active", verified: {} }), markState: async () => {} } as never,
    configuredHost: "https://example.test",
    ...(control ? { control } : {}),
    checkMeetingsGrant: async () => ({ status: "ok" }),
    readSecretKey: async () => ({ status: "ok", value: "secret" }),
    fetchMeeting: (fetchMeeting ?? (async () => ({ ok: true, data: { meeting: { sourceId: ID }, sentences: [], bytes: 1 } }))) as never,
    writeMeeting: async (_node, _verified, normalized) => {
      await onWrite?.();
      writes.push(normalized.meeting.sourceId);
      return { status: "written" };
    },
    perUserSpacingMs: 0,
    now: () => NOW,
    log: () => {},
  });
}

const delivery = { address: ADDRESS, meetingId: ID, receivedAt: new Date(NOW).toISOString() };

test("direct importer without a deleted-marker reader refuses the write", async () => {
  const writes: string[] = [];
  const worker = importer(undefined, writes);
  const result = await worker.handleWebhook(delivery);
  expect(result).toMatchObject({ outcome: "node_error", httpStatus: 503 });
  expect(writes).toEqual([]);
});

test("direct importer skips marked IDs even with a newer provider timestamp", async () => {
  const f = fixture();
  await f.control.markDeleted("fireflies", ADDRESS, ID);
  const writes: string[] = [];
  let fetches = 0;
  const worker = importer(f.control, writes, async () => { fetches++; return { ok: true }; });
  const result = await worker.handleWebhook({ ...delivery, sourceTimestamp: new Date(NOW + 60_000).toISOString() });
  expect(result).toMatchObject({ outcome: "tombstoned", body: { status: "ignored" } });
  expect(fetches).toBe(0);
  expect(writes).toEqual([]);
});

test("a marker recorded during fetch blocks the guarded write; a rejected read returns node_error", async () => {
  const f = fixture();
  const writes: string[] = [];
  const { promise: fetched, resolve: started } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const worker = importer(f.control, writes, async () => {
    started();
    await gate;
    return { ok: true, data: { meeting: { sourceId: ID }, sentences: [], bytes: 1 } };
  });
  const underway = worker.handleWebhook(delivery);
  await fetched;
  await f.control.markDeleted("fireflies", ADDRESS, ID);
  release();
  expect(await underway).toMatchObject({ outcome: "tombstoned" });
  expect(writes).toEqual([]);
  f.setFailGet(true);
  const failed = await importer(f.control, []).handleWebhook({ ...delivery, meetingId: "different-id" });
  expect(failed).toMatchObject({ outcome: "node_error", httpStatus: 503 });
});

test("deletion waits for an in-flight owner write and blocks the next delivery", async () => {
  const f = fixture();
  const writes: string[] = [];
  const { promise: writing, resolve: begun } = Promise.withResolvers<void>();
  const { promise: canFinish, resolve: release } = Promise.withResolvers<void>();
  const { promise: arrived, resolve: routeEntered } = Promise.withResolvers<void>();
  const worker = importer(f.control, writes, undefined, async () => { begun(); await canFinish; });
  await withServer(async base => {
    const first = worker.handleWebhook(delivery);
    await writing;
    const marking = request(base, "POST", { source: "fireflies", meetingId: ID });
    await arrived;
    expect(f.data.has(deletedMeetingKey("fireflies", ADDRESS, ID))).toBe(false);
    release();
    expect(await first).toMatchObject({ outcome: "imported" });
    expect((await marking).status).toBe(204);
    expect(await worker.handleWebhook(delivery)).toMatchObject({ outcome: "tombstoned" });
  }, f.control, ADDRESS, routeEntered);
  expect(writes).toEqual([ID]);
});

test("the default G2 writer checks again between transcript and meeting puts", async () => {
  const f = fixture();
  const written: string[] = [];
  const node = { useDelegation: async () => ({ kv: { put: async (key: string) => {
    written.push(key);
    if (written.length === 1) await f.control.markDeleted("fireflies", ADDRESS, ID);
    return { ok: true };
  } } }) } as unknown as TinyCloudNode;
  const result = await defaultWriteMeeting(node, { meetings: { resources: [{ path: "meeting", actions: [] }] } } as never,
    { meeting: { sourceId: ID }, transcriptBody: "body", meetingRecord: {} } as never,
    "https://example.test", async writeOp => {
      if (await f.control.readDeleted("fireflies", ADDRESS, ID)) return { guarded: false, status: "tombstoned" };
      return { guarded: true, result: await writeOp() };
    });
  expect(result.status).toBe("tombstoned");
  expect(written).toHaveLength(1);
});
