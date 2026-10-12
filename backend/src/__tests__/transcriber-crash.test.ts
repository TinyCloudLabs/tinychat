import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { CONNECTOR_SCHEMA, transcriptKvKey, TRANSCRIBER_MEETING_SOURCE } from "@tinyboilerplate/core";
import { createTranscriberRouter } from "../routes/transcriber.js";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { KvTranscriptDeliveryStore, TranscriptDeliveryWorker, WriteGovernor } from "../services/transcript-delivery.js";
import { JsonTranscriberIndexStore, resolvePendingCreates, type JsonKv, type TranscriberIndexStore } from "../services/transcriber-index.js";
import { computeCreateRequestHash, createTranscriptionApiClient, TranscriptionApiError, type CreateMeetingInput, type TranscriptionApiClient, type TranscriptionMeeting } from "../services/transcription-api.js";
import { makeSignedTranscriptGrant } from "./helpers/transcript-grant.js";
import { FileJsonKv } from "./fixtures/transcriber-crash-child.js";

const GRANT = await makeSignedTranscriptGrant();
const ADDRESS = GRANT.address;
const OWNER = ADDRESS.toLowerCase();
const MEETINGS_PATH = "/api/transcriber/meetings";
const CREATE_BODY = { meeting_url: "https://meet.jit.si/crash-window" };

type RecordRow = { meeting: TranscriptionMeeting; hash: string };

async function serve(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const location = server.address();
  if (!location || typeof location === "string") throw new Error("test server has no port");
  return {
    base: `http://127.0.0.1:${location.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tc-641-crash-"));
  const file = join(directory, "index.json");
  const records = new Map<string, RecordRow>();
  const deleted: string[] = [];
  const posts: string[] = [];
  let failDelete = false;
  const upstream = express();
  upstream.use(express.json());
  upstream.post("/v1/meetings", (req, res) => {
    const body = req.body as CreateMeetingInput;
    const key = req.get("Idempotency-Key");
    if (!key) return void res.status(400).json({ error: { code: "missing_idempotency_key" } });
    posts.push(key);
    if (!records.has(key)) {
      records.set(key, {
        meeting: {
          id: `mtg_${records.size + 1}`, object: "meeting", status: "completed", platform: "jitsi",
          meeting_url: body.meeting_url, created_at: new Date().toISOString(),
          metadata: body.metadata,
        },
        hash: computeCreateRequestHash(body),
      });
    }
    res.status(201).json(records.get(key)!.meeting);
  });
  upstream.get("/v1/meetings/by-idempotency-key", (req, res) => {
    const row = records.get(req.get("Idempotency-Key") ?? "");
    if (!row) return void res.status(404).json({ error: { code: "meeting_not_found" } });
    res.json({ meeting: row.meeting, request_hash: row.hash });
  });
  upstream.get("/v1/meetings/:id/transcript", (req, res) => {
    if (![...records.values()].some(row => row.meeting.id === req.params.id)) {
      return void res.status(404).json({ error: { code: "meeting_not_found" } });
    }
    res.json({ meeting_id: req.params.id, status: "completed", language: "en", duration_seconds: 3,
      speakers: [{ id: "speaker_0", name: "Sam" }], segments: [{ id: "seg_1", speaker_id: "speaker_0",
        speaker_name: "Sam", start: 0, end: 3, text: "Recovered after the crash" }], text: "Recovered after the crash" });
  });
  upstream.get("/v1/meetings/:id", (req, res) => {
    const row = [...records.values()].find(item => item.meeting.id === req.params.id);
    if (!row) return void res.status(404).json({ error: { code: "meeting_not_found" } });
    res.json(row.meeting);
  });
  upstream.delete("/v1/meetings/:id", (req, res) => {
    deleted.push(req.params.id);
    if (failDelete) return void res.status(503).json({ error: { code: "unavailable" } });
    const row = [...records.entries()].find(([, item]) => item.meeting.id === req.params.id);
    if (!row) return void res.status(404).json({ error: { code: "meeting_not_found" } });
    records.delete(row[0]);
    res.status(204).end();
  });
  const ptx = await serve(upstream);
  const api = createTranscriptionApiClient({ baseUrl: ptx.base, apiKey: "fixture-only" });
  const index = new JsonTranscriberIndexStore(new FileJsonKv(file), new BackendStorageLane());
  const cleanup = async () => { await ptx.close(); rmSync(directory, { recursive: true, force: true }); };
  return { file, records, posts, deleted, ptx, api, index, cleanup, setDeleteFailure(value: boolean) { failDelete = value; } };
}

async function routerFor(api: TranscriptionApiClient, index: TranscriberIndexStore) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { address: ADDRESS }; next(); });
  app.use(MEETINGS_PATH, createTranscriberRouter({ api, index }));
  return serve(app);
}

async function request(base: string, method: string, body?: object) {
  const response = await fetch(`${base}${MEETINGS_PATH}`, {
    method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

/** Reject selected durable writes *before* committing, as a node outage would. */
function failingKv(base: JsonKv, fails: { complete?: boolean; abandon?: boolean; begin?: boolean }): JsonKv {
  let began = false;
  return {
    get: key => base.get(key),
    keys: prefix => base.keys(prefix),
    remove: key => base.remove(key),
    async put(key, value) {
      if (value && typeof value === "object" && "pending" in value && Array.isArray(value.pending)) {
        if (!began && fails.begin) throw new Error("begin write refused");
        if (began && value.pending.length === 0 && "ids" in value && Array.isArray(value.ids)
          && value.ids.length && fails.complete) throw new Error("complete write refused");
        if (began && value.pending.length === 0 && fails.abandon) throw new Error("abandon write refused");
        if (value.pending.length > 0) began = true;
      }
      await base.put(key, value);
    },
  };
}

async function deliverRecovered(api: TranscriptionApiClient, index: TranscriberIndexStore, id: string) {
  const db = new Database(":memory:");
  const bodies = new Map<string, string>();
  const stateRows = new Map<string, unknown>();
  try {
    // The signed-in browser prepares schema before mint; server delivery has only read/write rights.
    for (const { sql } of CONNECTOR_SCHEMA) db.run(sql);
    const sql = { db: (_name: string) => ({
      async query(text: string, params: unknown[]) {
        return { ok: true, data: { rows: db.query(text).all(...params as (string | number | null)[])
          .map(row => Object.values(row as object)) } };
      },
      async execute(text: string, params: unknown[] = []) {
        if (/\b(?:CREATE|ALTER|DROP|PRAGMA)\b/i.test(text)) throw new Error("Backend attempted DDL");
        db.query(text).run(...params as (string | number | null)[]);
        return { ok: true, data: {} };
      },
    }) };
    const kv = {
      async get(key: string) {
        return bodies.has(key) ? { ok: true, data: bodies.get(key) }
          : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      },
      async put(key: string, value: string) {
        if (bodies.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "exists" } };
        bodies.set(key, value);
        return { ok: true, data: {} };
      },
    };
    const node = {
      computeDelegationCid: GRANT.computeDelegationCid,
      async useDelegation() { return { sql, kv }; },
    } as unknown as TinyCloudNode;
    const stateJson: JsonKv = {
      async get<T>(key: string) { return structuredClone(stateRows.get(key) ?? null) as T | null; },
      async put(key, value) { stateRows.set(key, structuredClone(value)); },
      async remove(key) { stateRows.delete(key); },
      async keys(prefix) { return [...stateRows.keys()].filter(key => key.startsWith(prefix)); },
    };
    const worker = new TranscriptDeliveryWorker({
      api, index, node, backendDid: GRANT.backendDid, configuredHost: GRANT.configuredHost,
      eligibility: address => address === OWNER,
      delegationStore: {
        async load(address) {
          if (address !== OWNER) return null;
          return { serialized: GRANT.envelope, expiresAt: GRANT.expiresAt.toISOString(),
            grantedAt: new Date().toISOString(), path: "connectors", actions: [] };
        },
        async remove() { throw new Error("Valid grant was rejected"); },
      },
      deliveryStore: new KvTranscriptDeliveryStore(stateJson, new BackendStorageLane()),
      governor: { take: async () => {} } as WriteGovernor,
    });
    expect(await index.list(ADDRESS)).toContain(id);
    await worker.wake(OWNER, id, "completed");
    await worker.sweep();
    await worker.stop();
    const rows = db.query("SELECT source_id FROM connector_meeting").all() as { source_id: string }[];
    expect(rows).toEqual([{ source_id: id }]);
    expect(bodies.get(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, id))).toContain("Recovered after the crash");
    const delivered = stateRows.get(`transcriber/delivery/${OWNER}`);
    if (!delivered || typeof delivered !== "object" || !("done" in delivered)
      || !delivered.done || typeof delivered.done !== "object" || !(id in delivered.done)) {
      throw new Error("Delivery worker did not persist completion");
    }
    expect(delivered.done).toEqual(expect.objectContaining({ [id]: expect.objectContaining({ how: "written" }) }));
  } finally { db.close(); }
}

describe("manual create crash recovery", () => {
  test("legacy ids survive durable intent writes and negative reads are cached", async () => {
    const rows = new Map<string, unknown>([[`transcriber/index/${OWNER}`, { ids: ["legacy"] }]]);
    let reads = 0;
    const json: JsonKv = {
      async get<T>(key: string) { reads++; return structuredClone(rows.get(key) ?? null) as T | null; },
      async put(key, value) { rows.set(key, structuredClone(value)); },
      async remove(key) { rows.delete(key); },
      async keys(prefix) { return [...rows.keys()].filter(key => key.startsWith(prefix)); },
    };
    const index = new JsonTranscriberIndexStore(json, new BackendStorageLane());
    expect(await index.list("0x0000000000000000000000000000000000000001")).toEqual([]);
    expect(await index.list("0x0000000000000000000000000000000000000001")).toEqual([]);
    expect(reads).toBe(1);
    const intent = { key: "manual-v1-legacy", hash: "a".repeat(64), createdAt: Date.now() };
    await index.beginCreate(OWNER, intent);
    await index.add(OWNER, "another");
    expect(await index.listPending(OWNER)).toEqual([intent]);
    await index.completeCreate(OWNER, intent.key, "recovered");
    expect(await index.list(OWNER)).toEqual(["recovered", "another", "legacy"]);
    expect(await index.listPending(OWNER)).toEqual([]);
    expect(await index.listAddresses()).toContain(OWNER);
    const restarted = new JsonTranscriberIndexStore(json, new BackendStorageLane());
    expect(await restarted.list(OWNER)).toEqual(["recovered", "another", "legacy"]);
  });

  test("SIGKILL after ptx commit but before index completion leaves a recoverable intent", async () => {
    const f = await fixture();
    try {
      const child = spawn(process.execPath, [new URL("./fixtures/transcriber-crash-child.ts", import.meta.url).pathname], {
        env: { ...process.env, CRASH_INDEX_FILE: f.file, CRASH_PTX_URL: f.ptx.base,
          CRASH_OWNER_ADDRESS: ADDRESS, CRASH_AT: "complete" },
        stdio: "ignore",
      });
      const death = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        // External SIGKILL needs a real watchdog; fake timers cannot bound a stuck child process.
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Child did not hit completion write")); }, 15_000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      expect(death.signal).toBe("SIGKILL");
      expect(f.posts).toHaveLength(1);
      expect(f.deleted).toEqual([]);
      const durable = JSON.parse(readFileSync(f.file, "utf8")) as Record<string, { ids: string[]; pending: unknown[] }>;
      expect(durable[`transcriber/index/${OWNER}`]?.ids).toEqual([]);
      expect(durable[`transcriber/index/${OWNER}`]?.pending).toHaveLength(1);
      expect(f.records.size).toBe(1);
      const fresh = new JsonTranscriberIndexStore(new FileJsonKv(f.file), new BackendStorageLane());
      const route = await routerFor(f.api, fresh);
      try {
        const listed = await request(route.base, "GET");
        expect(listed.status).toBe(200);
        expect((listed.body as { meetings: TranscriptionMeeting[] }).meetings.map(m => m.id)).toEqual(["mtg_1"]);
      } finally { await route.close(); }
      expect(await fresh.listPending(OWNER)).toEqual([]);
      expect(f.records.size).toBe(1);
      await deliverRecovered(f.api, fresh, "mtg_1");
    } finally { await f.cleanup(); }
  });

  test("begin failure never sends a ptx POST; a 21st intent is rate limited", async () => {
    const f = await fixture();
    try {
      const failing = new JsonTranscriberIndexStore(failingKv(new FileJsonKv(f.file), { begin: true }), new BackendStorageLane());
      const route = await routerFor(f.api, failing);
      try { expect((await request(route.base, "POST", CREATE_BODY)).status).toBe(503); }
      finally { await route.close(); }
      expect(f.posts).toEqual([]);
      for (let i = 0; i < 20; i++) await f.index.beginCreate(OWNER, { key: `manual-v1-${i}`, hash: "a".repeat(64), createdAt: Date.now() });
      const capped = await routerFor(f.api, f.index);
      try { expect((await request(capped.base, "POST", CREATE_BODY))).toEqual({ status: 429, body: { error: "too_many_pending_creates" } }); }
      finally { await capped.close(); }
      expect(f.posts).toEqual([]);
    } finally { await f.cleanup(); }
  });

  for (const abandonFails of [false, true]) {
    test(`caught completion failure: successful deletion ${abandonFails ? "with failed abandon" : "clears intent"}`, async () => {
      const f = await fixture();
      try {
        const failing = new JsonTranscriberIndexStore(failingKv(new FileJsonKv(f.file), { complete: true, abandon: abandonFails }), new BackendStorageLane());
        const route = await routerFor(f.api, failing);
        try { expect((await request(route.base, "POST", CREATE_BODY)).status).toBe(503); }
        finally { await route.close(); }
        expect(f.deleted).toEqual(["mtg_1"]);
        expect(f.records.size).toBe(0);
        expect(await failing.list(OWNER)).toEqual([]);
        const fresh = new JsonTranscriberIndexStore(new FileJsonKv(f.file), new BackendStorageLane());
        expect(await fresh.listPending(OWNER)).toHaveLength(abandonFails ? 1 : 0);
        await resolvePendingCreates(OWNER, f.api, fresh, { now: () => Date.now() + 16 * 60_000 });
        expect(await fresh.listPending(OWNER)).toEqual([]);
        expect(await fresh.list(OWNER)).toEqual([]);
      } finally { await f.cleanup(); }
    });
  }

  test("failed compensation retains intent; lookup verifies ownership/hash then delivers", async () => {
    const f = await fixture();
    try {
      f.setDeleteFailure(true);
      const failing = new JsonTranscriberIndexStore(failingKv(new FileJsonKv(f.file), { complete: true }), new BackendStorageLane());
      const route = await routerFor(f.api, failing);
      try { expect((await request(route.base, "POST", CREATE_BODY)).status).toBe(503); }
      finally { await route.close(); }
      expect(f.records.size).toBe(1);
      const fresh = new JsonTranscriberIndexStore(new FileJsonKv(f.file), new BackendStorageLane());
      expect(await fresh.listPending(OWNER)).toHaveLength(1);
      expect(await resolvePendingCreates(OWNER, f.api, fresh)).toBe(1);
      expect(await fresh.listPending(OWNER)).toEqual([]);
      await deliverRecovered(f.api, fresh, "mtg_1");
    } finally { await f.cleanup(); }
  });

  test("a lost create response after ptx commit retains the intent for recovery", async () => {
    const f = await fixture();
    try {
      const api: TranscriptionApiClient = {
        ...f.api,
        async createMeeting(input, options) {
          await f.api.createMeeting(input, options);
          throw new Error("transport closed after commit");
        },
      };
      const route = await routerFor(api, f.index);
      try { expect((await request(route.base, "POST", CREATE_BODY)).status).toBe(503); }
      finally { await route.close(); }
      expect(f.posts).toHaveLength(1);
      expect(await f.index.listPending(OWNER)).toHaveLength(1);
      const fresh = new JsonTranscriberIndexStore(new FileJsonKv(f.file), new BackendStorageLane());
      await resolvePendingCreates(OWNER, f.api, fresh);
      await deliverRecovered(f.api, fresh, "mtg_1");
    } finally { await f.cleanup(); }
  });

  test("non-retryable create error abandons its intent", async () => {
    const f = await fixture();
    try {
      const api: TranscriptionApiClient = {
        ...f.api,
        async createMeeting() { throw new TranscriptionApiError(422, "invalid_meeting_url", "Unsupported meeting URL"); },
      };
      const route = await routerFor(api, f.index);
      try { expect((await request(route.base, "POST", CREATE_BODY)).status).toBe(400); }
      finally { await route.close(); }
      expect(f.posts).toEqual([]);
      expect(await f.index.listPending(OWNER)).toEqual([]);
    } finally { await f.cleanup(); }
  });

  test("successful POST completes without a lookup (lookup may briefly return 404)", async () => {
    const f = await fixture();
    try {
      const api: TranscriptionApiClient = {
        ...f.api,
        async lookupMeetingByIdempotencyKey() { throw new TranscriptionApiError(404, "meeting_not_found", "Not yet visible"); },
      };
      const route = await routerFor(api, f.index);
      try { expect((await request(route.base, "POST", CREATE_BODY)).status).toBe(201); }
      finally { await route.close(); }
      expect(await f.index.list(OWNER)).toEqual(["mtg_1"]);
      expect(await f.index.listPending(OWNER)).toEqual([]);
    } finally { await f.cleanup(); }
  });

  test("404 waits for the grace period; wrong owner or hash is never indexed", async () => {
    const f = await fixture();
    try {
      const createdAt = Date.now();
      await f.index.beginCreate(OWNER, { key: "manual-v1-lost", hash: "a".repeat(64), createdAt });
      await resolvePendingCreates(OWNER, f.api, f.index, { now: () => createdAt + 14 * 60_000 });
      expect(await f.index.listPending(OWNER)).toHaveLength(1);
      await resolvePendingCreates(OWNER, f.api, f.index, { now: () => createdAt + 16 * 60_000 });
      expect(await f.index.listPending(OWNER)).toEqual([]);
      const route = await routerFor(f.api, f.index);
      try { expect((await request(route.base, "POST", CREATE_BODY)).status).toBe(201); }
      finally { await route.close(); }
      await f.index.remove(OWNER, "mtg_1");
      const [key] = f.posts;
      const row = f.records.get(key!)!;
      await f.index.beginCreate(OWNER, { key: key!, hash: row.hash, createdAt });
      row.meeting.metadata = { tinychat_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
      await resolvePendingCreates(OWNER, f.api, f.index);
      expect(await f.index.list(OWNER)).toEqual([]);
      expect(await f.index.listPending(OWNER)).toEqual([]);
      row.meeting.metadata = { tinychat_address: OWNER };
      await f.index.beginCreate(OWNER, { key: key!, hash: "b".repeat(64), createdAt });
      await resolvePendingCreates(OWNER, f.api, f.index);
      expect(await f.index.list(OWNER)).toEqual([]);
      expect(await f.index.listPending(OWNER)).toEqual([]);
    } finally { await f.cleanup(); }
  });
});
