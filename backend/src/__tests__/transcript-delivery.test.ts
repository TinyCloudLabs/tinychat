import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { DelegatedAccess, type TinyCloudNode } from "@tinycloud/node-sdk";
import { activateSessionWithHost } from "@tinycloud/sdk-core";
import { generatePrivateKey } from "viem/accounts";
import { CONNECTOR_SCHEMA, transcriptKvKey, TRANSCRIBER_MEETING_SOURCE, type StoredDelegation } from "@tinyboilerplate/core";
import { DelegationCache, type DelegationMetadata } from "@tinyboilerplate/server";
import { verificationCacheKey } from "../delegation-verify.js";
import { createDelegationRouter } from "../routes/delegations.js";
import { createTranscriberRouter } from "../routes/transcriber.js";
import { TenantCoordinator } from "../services/calendar-autojoin-store.js";
import type { JsonKv } from "../services/transcriber-index.js";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import { KvTranscriptDeliveryStore, TranscriptDeliveryWorker, WriteGovernor, type DeliveryState, type TranscriptDeliveryOptions } from "../services/transcript-delivery.js";
import { TranscriptionApiError, type TranscriptionApiClient, type TranscriptionMeeting } from "../services/transcription-api.js";
import { makeSignedTranscriptGrant, type SignedTranscriptGrant } from "./helpers/transcript-grant.js";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

class MemoryJson implements JsonKv {
  readonly values = new Map<string, unknown>();
  readonly puts: string[] = [];
  reads = 0;
  onPut?: (key: string) => void;
  async get<T>(key: string): Promise<T | null> {
    this.reads++;
    return (this.values.get(key) as T | undefined) ?? null;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.puts.push(key);
    this.onPut?.(key);
    this.values.set(key, structuredClone(value));
  }
  async remove(key: string): Promise<void> { this.values.delete(key); }
  async keys(prefix: string): Promise<string[]> { return [...this.values.keys()].filter((key) => key.startsWith(prefix)); }
}

const notFound = (key: string) => ({ ok: false as const, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } });

interface Fixture {
  grant: SignedTranscriptGrant;
  index: MemoryTranscriberIndexStore;
  meetings: Map<string, TranscriptionMeeting>;
  backend: MemoryJson;
  bodies: Map<string, string>;
  db: Database;
  node: TinyCloudNode;
  api: TranscriptionApiClient;
  meeting: (id: string, address?: string) => TranscriptionMeeting;
  events: string[];
  counts: { meeting: number; transcript: number; activation: number; removal: number; execute: number; put: number };
  records: Map<string, StoredDelegation>;
  worker: (options?: Partial<TranscriptDeliveryOptions>) => TranscriptDeliveryWorker;
  state: (address?: string) => DeliveryState;
}

async function fixture(schema = true): Promise<Fixture> {
  const grant = await makeSignedTranscriptGrant();
  const backend = new MemoryJson();
  const index = new MemoryTranscriberIndexStore();
  const bodies = new Map<string, string>();
  const db = new Database(":memory:");
  databases.push(db);
  if (schema) for (const table of CONNECTOR_SCHEMA) db.exec(table.sql);
  const events: string[] = [];
  backend.onPut = (key) => { if (key.startsWith("transcriber/delivery/")) events.push("state-put"); };
  const counts = { meeting: 0, transcript: 0, activation: 0, removal: 0, execute: 0, put: 0 };
  const records = new Map<string, StoredDelegation>();
  records.set(grant.address.toLowerCase(), {
    serialized: grant.envelope, expiresAt: grant.expiresAt.toISOString(), grantedAt: new Date().toISOString(),
    actions: [], path: "connectors",
  });
  const meetings = new Map<string, TranscriptionMeeting>();
  const meeting = (id: string, address = grant.address): TranscriptionMeeting => ({
    id, status: "completed", platform: "jitsi", meeting_url: "https://meet.example/room", created_at: new Date().toISOString(),
    metadata: { tinychat_address: address },
  });
  const api: TranscriptionApiClient = {
    async getMeeting(id) {
      counts.meeting++;
      const value = meetings.get(id);
      if (!value) throw new TranscriptionApiError(404, "meeting_not_found", "Not found");
      return value;
    },
    async getTranscript(id) {
      counts.transcript++;
      return { pending: false, transcript: {
        meeting_id: id, status: "completed", segments: [{ id: "seg", speaker_id: "sp", speaker_name: "Alice", start: 1, end: 3, text: "hello" }],
      } };
    },
    async lookupMeetingByIdempotencyKey() { return null; },
    async createMeeting() { throw new Error("unused"); },
    async stopMeeting() { throw new Error("unused"); },
    async deleteMeeting() { throw new Error("unused"); },
  };
  const sql = { db: (_name: string) => ({
    async query(text: string, params: unknown[]) {
      events.push("query");
      try { return { ok: true, data: { rows: db.query(text).all(...params as (string | number | null)[]).map((row) => Object.values(row as object)) } }; }
      catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
    },
    async execute(text: string, params: unknown[] = []) {
      counts.execute++; events.push("execute");
      if (/\b(?:CREATE|ALTER|DROP|PRAGMA)\b/i.test(text)) throw new Error("Backend attempted DDL");
      try { db.query(text).run(...params as (string | number | null)[]); return { ok: true, data: {} }; }
      catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
    },
  }) };
  const kv = {
    async get(key: string) { return bodies.has(key) ? { ok: true, data: bodies.get(key) } : notFound(key); },
    async put(key: string, value: string) {
      counts.put++; events.push("put");
      if (bodies.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "exists" } };
      bodies.set(key, value); return { ok: true, data: {} };
    },
  };
  const node = {
    computeDelegationCid: grant.computeDelegationCid,
    async useDelegation() { counts.activation++; events.push("activation"); return { sql, kv }; },
  } as unknown as TinyCloudNode;
  const storageLane = new BackendStorageLane();
  const worker = (options: Partial<TranscriptDeliveryOptions> = {}) =>
    new TranscriptDeliveryWorker({
      api, index, node, backendDid: grant.backendDid, configuredHost: grant.configuredHost,
      eligibility: () => true, storageLane, sweepMs: 60_000,
      delegationStore: {
        async load(address) { return records.get(address) ?? null; },
        async remove(address) { counts.removal++; events.push("remove"); records.delete(address); },
      },
      deliveryStore: new KvTranscriptDeliveryStore(backend, storageLane),
      governor: { take: async () => { events.push("take"); } } as WriteGovernor,
      ...options,
    });
  const state = (address = grant.address): DeliveryState =>
    backend.values.get(`transcriber/delivery/${address.toLowerCase()}`) as DeliveryState;
  return { grant, index, backend, bodies, db, node, api, meeting, meetings, events, counts, records, worker, state };
}

async function admit(f: Fixture, id: string, meeting = f.meeting(id), owner = f.grant.address): Promise<void> {
  await f.index.add(owner, id);
  f.meetings.set(id, meeting);
}

async function wakeAndDrain(worker: TranscriptDeliveryWorker, address: string, id: string): Promise<void> {
  await worker.wake(address, id, "completed");
  await worker.sweep();
}

async function withServer<T>(app: express.Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0);
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

function delegationApp(f: Fixture, worker: TranscriptDeliveryWorker, coordinator: TenantCoordinator, configuredHost = f.grant.configuredHost): express.Express {
  const app = express();
  app.use("/api/delegations", createDelegationRouter({
    backendDid: f.grant.backendDid, configuredHost,
    eligibility: () => true, node: f.node, coordinator,
    store: {
      load: async (address) => f.records.get(address) ?? null,
      remove: async (address) => { f.counts.removal++; f.records.delete(address); },
      store: async (address: string, serialized: string, metadata: DelegationMetadata) => {
        f.records.set(address, { serialized, grantedAt: new Date().toISOString(), ...metadata });
      },
    },
    authMiddleware: (req, _res, next) => { req.user = { address: f.grant.address }; next(); },
    onGrantChanged: (address, previous) => worker.invalidateGrant(address, previous),
  }));
  return app;
}

/**
 * A real node activation endpoint. The fixture node's `useDelegation` runs the SDK's own
 * `activateSessionWithHost` against it and, on failure, throws exactly what the pinned SDK throws
 * — a plain Error whose message carries the response body and no status. The stored grant is
 * re-signed without a bundle host so it verifies against this server as the configured host.
 */
async function withActivationNode(f: Fixture, answer: { status: number }, run: (host: string) => Promise<void>): Promise<void> {
  const app = express();
  const requests: string[] = [];
  app.post("/delegate", (req, res) => {
    requests.push(String(req.headers.authorization));
    if (answer.status < 300) res.status(answer.status).json({ activated: [] });
    else res.status(answer.status).send("delegation revoked");
  });
  const hostless = await makeSignedTranscriptGrant({ host: null });
  f.records.set(hostless.address.toLowerCase(), {
    serialized: hostless.envelope, expiresAt: hostless.expiresAt.toISOString(), grantedAt: new Date().toISOString(),
    actions: [], path: "connectors",
  });
  const node = f.node as unknown as { useDelegation: (delegation: { host: string }) => Promise<unknown> };
  const access = node.useDelegation;
  let session = 0;
  node.useDelegation = async (delegation) => {
    const result = await activateSessionWithHost(delegation.host, { Authorization: `Bearer invoker-session-${++session}` });
    if (!result.success) throw sdkActivationFailure(result);
    return access.call(node, delegation);
  };
  try { await withServer(app, run); } finally { node.useDelegation = access; }
  expect(requests.length).toBeGreaterThan(0);
}

/** Verbatim from @tinycloud/node-sdk 3.1.0 `TinyCloudNode.useDelegation`: the host result is the cause. */
function sdkActivationFailure(result: { success: boolean; status: number; error?: string }): Error {
  const text = result.error?.trim();
  return Object.assign(
    new Error(`Failed to activate delegated session: ${text ? `${result.status} - ${text}` : `${result.status}`}`),
    { cause: result },
  );
}

/**
 * A TinyCloud node behind the REAL SDK: activation is `activateSessionWithHost` on `POST /delegate`
 * (failing exactly as `useDelegation` does), and storage is a real `DelegatedAccess`, so every
 * storage failure is mapped by the SDK's own (3.1) services, each with meta.status: SQL 403 →
 * SQL_PERMISSION_DENIED, KV put 403 → AUTH_UNAUTHORIZED, 402 → STORAGE_QUOTA_EXCEEDED, SQL 429 →
 * SQL_QUOTA_EXCEEDED.
 * The stub `invoke` puts the service in the header so this node can answer SQL and KV apart.
 * `delegate: 0` drops the activation connection (a network failure, no status). The stored grant
 * is re-signed without a bundle host so it verifies against this node as the configured host.
 */
interface NodeAnswers { delegate: number; sql: number; kv: number }
async function withStorageNode(f: Fixture, answers: NodeAnswers, run: (host: string) => Promise<void>): Promise<void> {
  const app = express();
  app.post("/delegate", (_req, res) => {
    if (answers.delegate === 0) { res.socket?.destroy(); return; }
    if (answers.delegate < 300) res.status(answers.delegate).json({ activated: [] });
    else res.status(answers.delegate).send("delegation refused");
  });
  app.post("/invoke", express.raw({ type: () => true }), (req, res) => {
    const service = String(req.headers.authorization).split(" ")[1]!.split(":")[0];
    const status = service === "sql" ? answers.sql : answers.kv;
    if (status >= 300) { res.status(status).send("capability refused"); return; }
    if (service === "kv") { res.status(200).end(); return; }
    const body = JSON.parse(req.body.toString("utf8")) as { sql?: string };
    if (/sqlite_master/.test(body.sql ?? "")) res.json({ columns: ["name"], rows: [["connector_meeting"]] });
    else if (/^\s*SELECT/i.test(body.sql ?? "")) res.json({ columns: ["id"], rows: [] });
    else res.json({ changes: 1, lastInsertRowId: 1 });
  });
  const hostless = await makeSignedTranscriptGrant({ host: null });
  f.records.set(hostless.address.toLowerCase(), {
    serialized: hostless.envelope, expiresAt: hostless.expiresAt.toISOString(), grantedAt: new Date().toISOString(),
    actions: [], path: "connectors",
  });
  await withServer(app, async (host) => {
    const node = f.node as unknown as { useDelegation: (delegation: { spaceId: string; host: string }) => Promise<unknown> };
    const original = node.useDelegation;
    let session = 0;
    node.useDelegation = async (delegation) => {
      f.counts.activation++;
      const result = await activateSessionWithHost(delegation.host, { Authorization: `Bearer invoker-session-${++session}` });
      if (!result.success) throw sdkActivationFailure(result);
      const sessionData = { delegationHeader: { Authorization: "Bearer session" }, delegationCid: "cid", spaceId: delegation.spaceId, verificationMethod: "did:key:z#z", jwk: {} };
      const invoke = (_session: unknown, service: string, _path: string, action: string) => ({ Authorization: `Bearer ${service}:${action}` });
      return new (DelegatedAccess as unknown as new (...args: unknown[]) => unknown)(sessionData, { path: "", spaceId: delegation.spaceId }, delegation.host, invoke, invoke, undefined);
    };
    try { await run(host); } finally { node.useDelegation = original; }
  });
}

describe("durable transcript delivery", () => {
  it("caches both missing and present backend-KV state for sixty seconds, writing through updates", async () => {
    const json = new MemoryJson();
    const store = new KvTranscriptDeliveryStore(json, new BackendStorageLane());
    const owner = "0x0000000000000000000000000000000000000001";
    const key = `transcriber/delivery/${owner}`;
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      expect((await store.read(owner)).done).toEqual({});
      json.values.set(key, { v: 1, done: { old: { at: now, how: "existing" } }, watch: {}, retry: {} });
      expect((await store.read(owner)).done).toEqual({});
      expect(json.reads).toBe(1);
      now += 60_001;
      expect((await store.read(owner)).done.old.how).toBe("existing");
      expect(json.reads).toBe(2);
      await store.write(owner, { v: 1, done: { fresh: { at: now, how: "written" } }, watch: {}, retry: {} });
      expect((await store.read(owner)).done.fresh.how).toBe("written");
      expect(json.reads).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  it("writes a single SQLite row and immutable body, with no DDL, then skips duplicate wakes", async () => {
    const f = await fixture();
    await admit(f, "m-1");
    const worker = f.worker();
    await wakeAndDrain(worker, f.grant.address, "m-1");
    expect(f.db.query("SELECT source_id FROM connector_meeting").all()).toEqual([{ source_id: "m-1" }]);
    expect(JSON.parse(f.bodies.get(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, "m-1"))!)).toHaveLength(1);
    expect(f.state().done["m-1"].how).toBe("written");
    expect(f.counts.activation).toBe(2);
    expect(f.counts.execute).toBe(1);
    await wakeAndDrain(worker, f.grant.address, "m-1");
    expect(f.counts.meeting).toBe(1);
    await worker.stop();
  });

  it("serializes concurrent wakes for one owner without overlapping upstream operations", async () => {
    const f = await fixture();
    for (let i = 0; i < 20; i++) await admit(f, `concurrent-${i}`);
    let active = 0;
    let highWater = 0;
    const getMeeting = f.api.getMeeting.bind(f.api);
    f.api.getMeeting = async (id) => {
      active++;
      highWater = Math.max(highWater, active);
      await Promise.resolve();
      try { return await getMeeting(id); }
      finally { active--; }
    };
    const worker = f.worker();
    await Promise.all(Array.from({ length: 20 }, (_, i) => worker.wake(f.grant.address, `concurrent-${i}`, "completed")));
    await worker.sweep();
    expect(highWater).toBe(1);
    expect(f.db.query("SELECT COUNT(*) AS total FROM connector_meeting").get()).toEqual({ total: 20 });
    await worker.stop();
  });

  it("throttles repeated upstream meeting reads per id for 60 seconds across wake and sweep", async () => {
    const f = await fixture();
    await admit(f, "throttled");
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      const meeting = f.meeting("throttled");
      f.api.getMeeting = async () => {
        f.counts.meeting++;
        return { ...meeting, status: "processing" };
      };
      const worker = f.worker();
      await worker.deliver(f.grant.address, "throttled");
      now += 59_999;
      await worker.wake(f.grant.address, "throttled", "completed");
      await worker.sweep();
      expect(f.counts.meeting).toBe(1);
      now += 2;
      await worker.deliver(f.grant.address, "throttled");
      expect(f.counts.meeting).toBe(2);
      await worker.stop();
    } finally {
      Date.now = originalNow;
    }
  });

  it("recovers a lost webhook on restart and persists pending backoff across restarts", async () => {
    const f = await fixture();
    await admit(f, "lost");
    const initial = f.worker();
    initial.start(); await initial.stop();
    const restarted = f.worker();
    await restarted.sweep();
    expect(f.state().done.lost.how).toBe("written");
    await restarted.stop();
    await admit(f, "pending");
    f.api.getTranscript = async () => ({ pending: true, status: "processing" });
    const pending = f.worker();
    await wakeAndDrain(pending, f.grant.address, "pending");
    expect(f.state().retry.pending.code).toBe("transcript_pending");
    await pending.stop();
    const calls = f.counts.meeting;
    const later = f.worker();
    await later.sweep();
    expect(f.counts.meeting).toBe(calls);
    await later.stop();
  });

  it("keeps retrying after ten pending attempts, moving to a durable daily interval", async () => {
    const f = await fixture();
    await admit(f, "slow");
    f.api.getTranscript = async () => ({ pending: true, status: "processing" });
    for (let attempt = 1; attempt <= 11; attempt++) {
      const worker = f.worker();
      await worker.deliver(f.grant.address, "slow");
      expect(f.state().retry.slow.attempts).toBe(attempt);
      if (attempt >= 10) expect(f.state().retry.slow.nextAt - Date.now()).toBeGreaterThan(23 * 3_600_000);
      await worker.stop();
    }
    expect(f.state().done.slow).toBeUndefined();
  });

  it("refuses no grant, wrong owner, and missing metadata before activating or writing user space", async () => {
    const f = await fixture();
    await admit(f, "absent");
    f.records.clear();
    const worker = f.worker();
    await wakeAndDrain(worker, f.grant.address, "absent");
    expect(f.counts.meeting).toBe(0);
    expect(f.counts.transcript).toBe(0);
    expect(f.counts.activation).toBe(0);
    await worker.stop();
    f.records.set(f.grant.address.toLowerCase(), { serialized: f.grant.envelope, expiresAt: f.grant.expiresAt.toISOString(), actions: [], path: "connectors", grantedAt: "now" });
    await admit(f, "foreign", f.meeting("foreign", "0x0000000000000000000000000000000000000001"));
    await f.index.add(f.grant.address, "foreign");
    await admit(f, "unknown-owner", { ...f.meeting("unknown-owner"), metadata: {} });
    const second = f.worker();
    await second.deliver(f.grant.address, "foreign");
    await second.deliver(f.grant.address, "unknown-owner");
    expect(f.state().done.foreign.how).toBe("owner_mismatch");
    expect(f.state().done["unknown-owner"].how).toBe("owner_mismatch");
    expect(f.counts.activation).toBe(0);
    await second.stop();
  });

  it("marks 404 gone, repairs a legacy row body-only and marks already-present existing", async () => {
    const f = await fixture();
    await f.index.add(f.grant.address, "deleted");
    const worker = f.worker();
    await worker.deliver(f.grant.address, "deleted");
    expect(f.state().done.deleted.how).toBe("gone");
    await admit(f, "legacy");
    f.db.query("INSERT INTO connector_meeting (id, source, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("old-random", TRANSCRIBER_MEETING_SOURCE, "legacy", "now", "now");
    await worker.deliver(f.grant.address, "legacy");
    expect(f.state().done.legacy.how).toBe("written");
    expect(f.db.query("SELECT id FROM connector_meeting WHERE source_id = 'legacy'").get()).toEqual({ id: "old-random" });
    expect(f.counts.execute).toBe(0);
    await admit(f, "present");
    f.db.query("INSERT INTO connector_meeting (id, source, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("existing", TRANSCRIBER_MEETING_SOURCE, "present", "now", "now");
    f.bodies.set(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, "present"), "[]");
    await worker.deliver(f.grant.address, "present");
    expect(f.state().done.present.how).toBe("existing");
    expect(f.counts.transcript).toBe(1);
    await worker.stop();
  });

  it("watches failed meetings, retries on completion wake and on a due watch without a wake", async () => {
    const f = await fixture();
    await admit(f, "failed");
    const completed = f.meeting("failed");
    f.api.getMeeting = async () => ({ ...completed, status: "failed", metadata: {} });
    const first = f.worker();
    await first.deliver(f.grant.address, "failed");
    expect(f.state().watch.failed.checks).toBe(1);
    await first.stop();
    const second = f.worker();
    f.api.getMeeting = async () => completed;
    await wakeAndDrain(second, f.grant.address, "failed");
    expect(f.state().done.failed.how).toBe("written");
    expect(f.state().watch.failed).toBeUndefined();
    await second.stop();
    await admit(f, "watch");
    f.api.getMeeting = async (id) => ({ ...f.meeting(id), status: "failed" });
    const third = f.worker();
    await third.deliver(f.grant.address, "watch");
    await third.stop();
    const persisted = f.state();
    persisted.watch.watch.nextAt = Date.now() - 1;
    f.backend.values.set(`transcriber/delivery/${f.grant.address.toLowerCase()}`, structuredClone(persisted));
    f.api.getMeeting = async (id) => f.meeting(id);
    const fourth = f.worker();
    await fourth.sweep();
    expect(f.state().done.watch.how).toBe("written");
    await fourth.stop();
  });

  it("reopens cancelled upon completion wake and persists schema_missing until browser schema repair", async () => {
    const f = await fixture(false);
    await admit(f, "schema");
    const first = f.worker();
    await first.deliver(f.grant.address, "schema");
    expect(f.state().retry.schema.code).toBe("schema_missing");
    expect(await first.hasSchemaMissing(f.grant.address)).toBe(true);
    expect(f.events).not.toContain("execute");
    await first.stop();
    const second = f.worker();
    expect(await second.hasSchemaMissing(f.grant.address)).toBe(true);
    for (const table of CONNECTOR_SCHEMA) f.db.exec(table.sql);
    await wakeAndDrain(second, f.grant.address, "schema");
    expect(f.state().done.schema.how).toBe("written");
    expect(await second.hasSchemaMissing(f.grant.address)).toBe(false);
    await second.stop();
    await admit(f, "cancel");
    f.api.getMeeting = async () => ({ ...f.meeting("cancel"), status: "cancelled" });
    const third = f.worker();
    await third.deliver(f.grant.address, "cancel");
    await third.stop();
    f.api.getMeeting = async (id) => f.meeting(id);
    const fourth = f.worker();
    await wakeAndDrain(fourth, f.grant.address, "cancel");
    expect(f.state().done.cancel.how).toBe("written");
    await fourth.stop();
  });

  it("an observed completion reopens a cancelled meeting after a restart; a sweep alone does not", async () => {
    const f = await fixture();
    await admit(f, "late");
    f.api.getMeeting = async () => ({ ...f.meeting("late"), status: "cancelled" });
    const first = f.worker();
    await first.deliver(f.grant.address, "late", "observed");
    expect(f.state().done.late.how).toBe("cancelled");
    await first.stop();
    // It completed later and its webhook was lost.
    f.api.getMeeting = async (id) => f.meeting(id);
    const restarted = f.worker();
    await restarted.sweep();
    expect(f.state().done.late.how).toBe("cancelled");
    expect(f.counts.transcript).toBe(0);
    await restarted.wake(f.grant.address, "late", "observed");
    await restarted.sweep();
    expect(f.state().done.late.how).toBe("written");
    expect(f.counts.transcript).toBe(1);
    await restarted.stop();
  });

  it("an observed completion reopens a failed meeting after a restart without waiting out its watch", async () => {
    const f = await fixture();
    await admit(f, "flaky");
    f.api.getMeeting = async () => ({ ...f.meeting("flaky"), status: "failed" });
    const first = f.worker();
    await first.deliver(f.grant.address, "flaky", "observed");
    expect(f.state().watch.flaky.nextAt).toBeGreaterThan(Date.now() + 14 * 60_000);
    await first.stop();
    f.api.getMeeting = async (id) => f.meeting(id);
    const restarted = f.worker();
    await restarted.sweep();
    expect(f.state().watch.flaky).toBeDefined();
    await restarted.wake(f.grant.address, "flaky", "observed");
    await restarted.sweep();
    expect(f.state().done.flaky.how).toBe("written");
    expect(f.state().watch.flaky).toBeUndefined();
    await restarted.stop();
  });

  it("a meeting ptx failed for capacity (TC-907) is terminal: no watch, and the sweep never rechecks it", async () => {
    const f = await fixture();
    await admit(f, "busy");
    let reads = 0;
    const capacityFailed = { ...f.meeting("busy"), status: "failed" as const,
      error: { type: "provider_error", code: "capacity_exhausted", message: "All meeting notetakers were busy." } };
    f.api.getMeeting = async () => { reads++; return capacityFailed; };
    const first = f.worker();
    await first.deliver(f.grant.address, "busy");
    expect(f.state().done.busy.how).toBe("capacity_exhausted");
    expect(f.state().watch.busy).toBeUndefined();
    await first.stop();
    // Long after every watch interval: a restarted worker's sweeps make no upstream read.
    const realNow = Date.now;
    Date.now = () => realNow() + 40 * 86_400_000;
    try {
      const later = f.worker();
      await later.sweep();
      await later.sweep();
      await later.stop();
    } finally { Date.now = realNow; }
    expect(reads).toBe(1);
    expect(f.state().done.busy.how).toBe("capacity_exhausted");
    expect(f.counts.transcript).toBe(0);
  });

  it("only an upstream-confirmed completion reopens a capacity-ended meeting", async () => {
    const f = await fixture();
    await admit(f, "busy");
    let reads = 0;
    let upstream: TranscriptionMeeting = { ...f.meeting("busy"), status: "failed",
      error: { type: "provider_error", code: "capacity_exhausted", message: "All meeting notetakers were busy." } };
    f.api.getMeeting = async () => { reads++; return upstream; };
    const first = f.worker();
    await first.deliver(f.grant.address, "busy");
    await first.stop();
    const marker = f.state().done.busy;
    expect(marker.how).toBe("capacity_exhausted");
    // A completion wake (a webhook, possibly unsigned) and an observation each get one upstream
    // read; upstream still says capacity-failed, so the marker stands unchanged and nothing is written.
    for (const kind of ["completed", "observed"] as const) {
      const worker = f.worker();
      await worker.wake(f.grant.address, "busy", kind);
      await worker.sweep();
      await worker.stop();
      expect(f.state().done.busy).toEqual(marker);
    }
    expect(reads).toBe(3);
    expect(f.counts.transcript).toBe(0);
    // Only once our own read says completed (for this owner) is it reopened and delivered.
    upstream = f.meeting("busy");
    const confirmed = f.worker();
    await confirmed.wake(f.grant.address, "busy", "completed");
    await confirmed.sweep();
    await confirmed.stop();
    expect(f.state().done.busy.how).toBe("written");
    expect(f.counts.transcript).toBe(1);
  });

  it("a meeting shared into this address (TC-581) is never read upstream or written, even if its record names the recipient", async () => {
    const f = await fixture();
    const owner = "0x00000000000000000000000000000000000000aa";
    await f.index.addShared(f.grant.address, "shared", { ownerTenant: owner, ownerOccurrenceId: "o", recipientOccurrenceId: "r",
      checkedAt: 1, title: "Team sync", scheduledStart: "2026-09-25T12:00:00.000Z" });
    // Inconsistent upstream metadata: completed, and naming the recipient as its owner.
    f.meetings.set("shared", f.meeting("shared"));
    await admit(f, "own");
    const reads: string[] = [];
    const getMeeting = f.api.getMeeting.bind(f.api);
    f.api.getMeeting = async (id) => { reads.push(id); return getMeeting(id); };
    const worker = f.worker();
    await worker.sweep();
    await worker.wake(f.grant.address, "shared", "completed");
    await worker.wake(f.grant.address, "shared", "observed");
    await worker.sweep();
    await worker.deliver(f.grant.address, "shared", "completed");
    await worker.stop();
    expect(reads).toEqual(["own"]);
    expect(f.state().done.own.how).toBe("written");
    expect(f.state().done.shared).toBeUndefined();
    expect(f.counts.execute).toBe(1);
    expect(f.counts.put).toBe(1);
    expect([...f.bodies.keys()].some((key) => key.endsWith("/shared"))).toBe(false);
  });

  /** A capacity-ended meeting (TC-907): the first read records the terminal marker. */
  const capacityFailed = (f: Fixture, id: string): TranscriptionMeeting => ({ ...f.meeting(id), status: "failed",
    error: { type: "provider_error", code: "capacity_exhausted", message: "All meeting notetakers were busy." } });
  async function capacityEndedFixture(id: string) {
    const f = await fixture();
    await admit(f, id);
    let upstream: TranscriptionMeeting | Error = capacityFailed(f, id);
    let reads = 0;
    f.api.getMeeting = async () => { reads++; if (upstream instanceof Error) throw upstream; return upstream; };
    const first = f.worker();
    await first.deliver(f.grant.address, id);
    await first.stop();
    expect(f.state().done[id]!.how).toBe("capacity_exhausted");
    return { f, reads: () => reads, answer: (next: TranscriptionMeeting | Error) => { upstream = next; } };
  }
  const later = async <T>(ms: number, run: () => Promise<T>): Promise<T> => {
    const realNow = Date.now;
    Date.now = () => realNow() + ms;
    try { return await run(); } finally { Date.now = realNow; }
  };

  it("a capacity-ended marker survives every completion-wake answer but an owned completion", async () => {
    const { f, answer } = await capacityEndedFixture("busy");
    const own = f.meeting("busy");
    for (const [label, next] of [
      ["404", new TranscriptionApiError(404, "meeting_not_found", "Missing")],
      ["cancelled", { ...own, status: "cancelled" }],
      ["another owner", f.meeting("busy", "0x00000000000000000000000000000000000000bb")],
      ["no owner", { ...own, metadata: {} }],
      ["another id", { ...own, id: "other" }],
      ["failed", { ...own, status: "failed" }],
      ["processing", { ...own, status: "processing" }],
    ] as const) {
      answer(next as TranscriptionMeeting | Error);
      const worker = f.worker();
      await worker.wake(f.grant.address, "busy", "completed");
      await worker.sweep();
      await worker.stop();
      expect({ label, how: f.state().done.busy?.how, pending: f.state().confirm?.busy })
        .toEqual({ label, how: "capacity_exhausted", pending: undefined });
    }
    expect(f.counts.transcript).toBe(0);
    answer(own);
    const confirmed = f.worker();
    await confirmed.wake(f.grant.address, "busy", "completed");
    await confirmed.sweep();
    await confirmed.stop();
    expect(f.state().done.busy.how).toBe("written");
  });

  it("a completion wake inside the read throttle is kept and delivered by the sweep once due, without another wake", async () => {
    const { f, reads, answer } = await capacityEndedFixture("busy");
    // One long-running worker: it reads (capacity), and the genuine completion arrives seconds later.
    const worker = f.worker();
    answer(capacityFailed(f, "busy"));
    await worker.deliver(f.grant.address, "busy", "completed");
    expect(reads()).toBe(2);
    answer(f.meeting("busy"));
    await worker.wake(f.grant.address, "busy", "completed");
    await worker.sweep();
    expect(reads()).toBe(2);
    expect(f.state().done.busy.how).toBe("capacity_exhausted");
    expect(f.state().confirm?.busy?.nextAt).toBeGreaterThan(Date.now());
    // Undelivered 24 h later with no further wake was the bug; the due confirmation is swept.
    await later(86_400_000, () => worker.sweep());
    await worker.stop();
    expect(reads()).toBe(3);
    expect(f.state().done.busy.how).toBe("written");
    expect(f.state().confirm?.busy).toBeUndefined();
  });

  it("a confirmation read that fails is retried by the sweep with backoff, keeping the marker until confirmed", async () => {
    const { f, reads, answer } = await capacityEndedFixture("busy");
    answer(new TranscriptionApiError(503, "provider_unavailable", "Unavailable"));
    const worker = f.worker();
    await worker.wake(f.grant.address, "busy", "completed");
    await worker.sweep();
    await worker.stop();
    expect(reads()).toBe(2);
    expect(f.state().done.busy.how).toBe("capacity_exhausted");
    expect(f.state().confirm?.busy).toMatchObject({ attempts: 1 });
    expect(f.state().confirm!.busy!.nextAt).toBeGreaterThan(Date.now());
    answer(f.meeting("busy"));
    // Not due yet: a restarted worker's sweep leaves it alone.
    const restarted = f.worker();
    await restarted.sweep();
    expect(reads()).toBe(2);
    await later(86_400_000, () => restarted.sweep());
    await restarted.stop();
    expect(reads()).toBe(3);
    expect(f.state().done.busy.how).toBe("written");
  });

  it("an address whose index cannot be read is passed over, so later addresses are still swept", async () => {
    const f = await fixture();
    const broken = "0x00000000000000000000000000000000000000cc";
    await f.index.add(broken, "unreachable");
    await admit(f, "ok");
    for (const method of ["entries", "listPending", "list"] as const) {
      const original = f.index[method].bind(f.index) as (address: string) => Promise<unknown>;
      (f.index as unknown as Record<string, unknown>)[method] = async (address: string) => {
        if (address.toLowerCase() === broken) throw new Error("transcriber_index_invalid");
        return original(address);
      };
    }
    const random = Math.random;
    Math.random = () => 0; // start the pass at the unreadable address
    try {
      const worker = f.worker();
      await worker.sweep();
      await worker.stop();
    } finally { Math.random = random; }
    expect(f.state().done.ok.how).toBe("written");
  });

  it("an observed completion does not bypass a storage-error retry backoff, across a restart", async () => {
    const f = await fixture();
    await admit(f, "backoff");
    const node = f.node as unknown as { useDelegation: () => Promise<unknown> };
    const original = node.useDelegation;
    node.useDelegation = async () => { throw Object.assign(new Error("node unavailable"), { status: 503 }); };
    const first = f.worker();
    await first.deliver(f.grant.address, "backoff", "observed");
    const backoff = structuredClone(f.state().retry.backoff);
    expect(backoff.code).toBe("storage_error");
    expect(backoff.nextAt).toBeGreaterThan(Date.now());
    await first.stop();
    node.useDelegation = original;
    const restarted = f.worker();
    const reads = f.counts.meeting;
    await restarted.wake(f.grant.address, "backoff", "observed");
    await restarted.sweep();
    expect(f.counts.meeting).toBe(reads);
    expect(f.state().retry.backoff).toEqual(backoff);
    expect(f.state().done.backoff).toBeUndefined();
    await restarted.stop();
  });

  it("a sweep removes the grant of an address narrowed out of the cohort, and delivers again once re-widened", async () => {
    const f = await fixture();
    let eligible = true;
    const worker = f.worker({ eligibility: () => eligible });
    const address = f.grant.address.toLowerCase();
    await admit(f, "narrowed");
    eligible = false;
    await worker.sweep();
    expect(f.records.has(address)).toBe(false);
    expect(f.counts.removal).toBe(1);
    expect(f.counts.meeting).toBe(0);
    await worker.sweep();
    expect(f.counts.removal).toBe(1);

    // Re-widened and re-granted (the router's accept signals the change to the worker).
    eligible = true;
    f.records.set(address, {
      serialized: f.grant.envelope, expiresAt: f.grant.expiresAt.toISOString(), grantedAt: new Date().toISOString(), actions: [], path: "connectors",
    });
    worker.invalidateGrant(address);
    await worker.sweep();
    expect(f.state().done.narrowed.how).toBe("written");

    // Narrowed again: the change cleared the "already checked" mark, so it is removed again.
    eligible = false;
    await worker.sweep();
    expect(f.records.has(address)).toBe(false);
    expect(f.counts.removal).toBe(2);
    await worker.stop();
  });

  /** Non-cohort addresses, some holding a stored grant, behind a grant store that logs each read. */
  async function nonCohortSweep(f: Fixture, holders: (index: number) => boolean, count: number) {
    const addresses = Array.from({ length: count }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const stored = new Map(addresses.filter((_, i) => holders(i)).map((address) => [address, `envelope-${address}`]));
    for (const address of addresses) await f.index.add(address, "m");
    const reads: string[] = [];
    const worker = f.worker({
      eligibility: () => false,
      delegationStore: {
        async load(address) {
          reads.push(address);
          const serialized = stored.get(address);
          return serialized ? { serialized, expiresAt: "", grantedAt: "", actions: [], path: "" } : null;
        },
        async remove(address) { stored.delete(address); },
      },
    });
    /** One sweep; returns the reads it made. */
    const sweep = async () => { const before = reads.length; await worker.sweep(); return reads.slice(before); };
    return { addresses, stored, reads, worker, sweep };
  }

  it("spends every scheduled sweep on non-cohort cleanup: 250 holders take three working sweeps", async () => {
    const f = await fixture();
    const { stored, reads, worker, sweep } = await nonCohortSweep(f, () => true, 250);
    // Each holder costs two reads (find, then compare-and-delete): 100 + 100 + 50 holders.
    const perSweep = [(await sweep()).length, (await sweep()).length, (await sweep()).length];
    expect(perSweep).toEqual([200, 200, 100]);
    expect(stored.size).toBe(0);
    // Checked once each: no pass re-reads an address an earlier pass cleared.
    expect(new Set(reads).size).toBe(250);
    expect(reads.length).toBe(500);
    await worker.stop();
  });

  it("never lets a two-read grant check overrun the cap: it waits for the next pass instead", async () => {
    const f = await fixture();
    const random = Math.random;
    Math.random = () => 0;
    try {
      // 199 one-read misses, then a holder, so the holder's check would be reads 200 and 201.
      const { addresses, stored, worker, sweep } = await nonCohortSweep(f, (i) => i === 199 || i >= 250, 300);
      const first = await sweep();
      expect(first.length).toBe(199);
      expect(first).not.toContain(addresses[199]);
      expect(stored.has(addresses[199]!)).toBe(true);
      // The next pass resumes at the deferred holder and still stays within the cap.
      const second = await sweep();
      expect(second.slice(0, 2)).toEqual([addresses[199], addresses[199]]);
      expect(second.length).toBeLessThanOrEqual(200);
      expect(stored.has(addresses[199]!)).toBe(false);
      for (let pass = 0; pass < 3 && stored.size > 0; pass++) expect((await sweep()).length).toBeLessThanOrEqual(200);
      expect(stored.size).toBe(0);
      await worker.stop();
    } finally {
      Math.random = random;
    }
  });

  it("removes foreign stored envelopes under their own owner key, warm and cold, without B activation", async () => {
    for (const warm of [true, false]) {
      const f = await fixture();
      const b = await makeSignedTranscriptGrant({ wallet: "B" });
      await admit(f, "a");
      await f.index.add(b.address, "b");
      const a = f.worker();
      if (warm) await a.deliver(f.grant.address, "a");
      await a.stop();
      f.records.set(b.address.toLowerCase(), { serialized: f.grant.envelope, expiresAt: f.grant.expiresAt.toISOString(), actions: [], path: "connectors", grantedAt: "now" });
      const activations = f.counts.activation;
      const bWorker = f.worker();
      await bWorker.deliver(b.address, "b");
      expect(f.records.has(b.address.toLowerCase())).toBe(false);
      expect(f.counts.activation).toBe(activations);
      expect(f.events.slice(-2)).toEqual(["take", "remove"]);
      expect(f.backend.puts.filter((key) => key.endsWith(b.address.toLowerCase()))).toEqual([]);
      await bWorker.stop();
    }
  });

  it("preserves a replacement grant when removal of a stale envelope is paused", async () => {
    const f = await fixture();
    const replacement = await makeSignedTranscriptGrant({ expiresAt: Math.floor((f.grant.expiresAt.getTime() + 2 * 3_600_000) / 1000) });
    const address = f.grant.address.toLowerCase();
    await admit(f, "stale");
    const node = f.node as unknown as { useDelegation: () => Promise<unknown> };
    const original = node.useDelegation;
    // What the activation boundary throws when the node refuses the grant (its SDK path is tested with a real node).
    node.useDelegation = async () => { throw sdkActivationFailure({ success: false, status: 403, error: "revoked" }); };
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const worker = f.worker({ governor: { take: async () => { entered(); await held; } } as WriteGovernor });
    const delivery = worker.deliver(address, "stale");
    await waiting;
    f.records.set(address, { ...f.records.get(address)!, serialized: replacement.envelope, expiresAt: replacement.expiresAt.toISOString() });
    release();
    await delivery;
    expect(f.records.get(address)?.serialized).toBe(replacement.envelope);
    expect(f.counts.removal).toBe(0);
    node.useDelegation = original;
    await admit(f, "new");
    await worker.deliver(address, "new");
    expect(f.state().done.new.how).toBe("written");
    await worker.stop();
  });

  it("accepting a replacement evicts the warm grant and reloads access from the new envelope", async () => {
    const f = await fixture();
    const coordinator = new TenantCoordinator();
    const cache = new DelegationCache();
    const worker = f.worker({ coordinator, delegationCache: cache });
    const address = f.grant.address.toLowerCase();
    await admit(f, "before");
    await worker.deliver(address, "before");
    const staleKey = verificationCacheKey(address, f.grant.envelope, f.grant.backendDid, f.grant.configuredHost);
    expect(cache.get(staleKey)).not.toBeNull();
    const replacement = await makeSignedTranscriptGrant({ expiresAt: Math.floor((f.grant.expiresAt.getTime() + 2 * 3_600_000) / 1000) });
    await withServer(delegationApp(f, worker, coordinator), async (base) => {
      const response = await fetch(`${base}/api/delegations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(replacement),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).expiresAt).toBe(replacement.expiresAt.toISOString());
    });
    expect(cache.get(staleKey)).toBeNull();
    const activations = f.counts.activation;
    await admit(f, "after");
    await worker.deliver(address, "after");
    expect(f.state().done.after.how).toBe("written");
    expect(f.counts.activation).toBe(activations + 2);
    await worker.stop();
  });

  it("accepting a grant clears a cached absence so the next indexed meeting can deliver", async () => {
    const f = await fixture();
    const coordinator = new TenantCoordinator();
    const worker = f.worker({ coordinator });
    const address = f.grant.address.toLowerCase();
    f.records.delete(address);
    await admit(f, "accepted");
    await worker.deliver(address, "accepted");
    expect(f.counts.meeting).toBe(0);
    await withServer(delegationApp(f, worker, coordinator), async (base) => {
      const response = await fetch(`${base}/api/delegations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(f.grant),
      });
      expect(response.status).toBe(200);
    });
    await worker.deliver(address, "accepted");
    expect(f.state().done.accepted.how).toBe("written");
    await worker.stop();
  });

  it("DELETE revokes a warm worker grant before another meeting can write", async () => {
    const f = await fixture();
    const coordinator = new TenantCoordinator();
    const cache = new DelegationCache();
    const worker = f.worker({ coordinator, delegationCache: cache });
    const address = f.grant.address.toLowerCase();
    await admit(f, "before-delete");
    await worker.deliver(address, "before-delete");
    const key = verificationCacheKey(address, f.grant.envelope, f.grant.backendDid, f.grant.configuredHost);
    expect(cache.get(key)).not.toBeNull();
    await admit(f, "after-delete");
    const calls = f.counts.meeting;
    const writes = f.counts.execute;
    await withServer(delegationApp(f, worker, coordinator), async (base) => {
      const response = await fetch(`${base}/api/delegations`, { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "none", expiresAt: null });
    });
    expect(cache.get(key)).toBeNull();
    await worker.deliver(address, "after-delete");
    expect(f.counts.meeting).toBe(calls);
    expect(f.counts.execute).toBe(writes);
    expect(f.db.query("SELECT source_id FROM connector_meeting WHERE source_id = 'after-delete'").all()).toEqual([]);
    await worker.stop();
  });

  it("GET meetings observes completion without consuming storage quota retry backoff each minute", async () => {
    const f = await fixture();
    const worker = f.worker();
    await admit(f, "quota-observed");
    const node = f.node as unknown as { useDelegation: () => Promise<unknown> };
    const original = node.useDelegation;
    node.useDelegation = async () => { throw Object.assign(new Error("quota"), { status: 402 }); };
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    const app = express();
    app.use((req, _res, next) => { req.user = { address: f.grant.address }; next(); });
    app.use("/api/transcriber/meetings", createTranscriberRouter({
      api: f.api, index: f.index, onObservedCompletion: (address, id) => worker.wake(address, id, "observed"),
    }));
    try {
      await withServer(app, async (base) => {
        const url = `${base}/api/transcriber/meetings`;
        expect((await fetch(url)).status).toBe(200);
        await worker.sweep();
        const backoff = f.state().retry["quota-observed"];
        expect(backoff.code).toBe("storage_quota");
        const attempts = backoff.attempts;
        const nextAt = backoff.nextAt;
        for (let minute = 0; minute < 3; minute++) {
          now += 60_001;
          const response = await fetch(url);
          expect(response.status).toBe(200);
          expect((await response.json()).meetings[0].status).toBe("completed");
          await worker.sweep();
          expect(f.state().retry["quota-observed"]).toEqual({ code: "storage_quota", attempts, nextAt });
        }
        node.useDelegation = original;
        await worker.wake(f.grant.address, "quota-observed", "completed");
        await worker.sweep();
        expect(f.state().done["quota-observed"].how).toBe("written");
      });
    } finally {
      Date.now = originalNow;
      node.useDelegation = original;
      await worker.stop();
    }
  });

  it("drops ten thousand forged and final wakes without contacting ptx", async () => {
    const f = await fixture();
    await f.index.add(f.grant.address, "done");
    await f.backend.put(`transcriber/delivery/${f.grant.address.toLowerCase()}`, {
      v: 1, done: { done: { at: Date.now(), how: "written" } }, watch: {}, retry: {},
    });
    const worker = f.worker();
    for (let i = 0; i < 10_000; i++) await worker.wake(i % 2 ? f.grant.address : `0x${i.toString(16).padStart(40, "0")}`, `forged-${i}`, "completed");
    await worker.wake(f.grant.address, "done", "completed");
    expect(f.counts.meeting).toBe(0);
    expect(f.counts.activation).toBe(0);
    expect(worker.overflow.dropped).toBe(0);
    await worker.stop();
  });

  it("prunes stale delivery markers on a sweep with no due IDs in one state write", async () => {
    const f = await fixture();
    await f.index.add(f.grant.address, "retained");
    const address = f.grant.address.toLowerCase();
    await f.backend.put(`transcriber/delivery/${address}`, {
      v: 1, done: { retained: { at: Date.now(), how: "written" }, removed: { at: Date.now(), how: "gone" } },
      watch: {}, retry: { removed: { attempts: 1, nextAt: Date.now(), code: "transcript_pending" } },
    });
    const worker = f.worker();
    await worker.sweep();
    expect(Object.keys(f.state().done)).toEqual(["retained"]);
    expect(f.state().retry).toEqual({});
    expect(f.counts.meeting).toBe(0);
    expect(f.backend.puts.filter((key) => key === `transcriber/delivery/${address}`)).toHaveLength(2);
    await worker.stop();
  });

  it("deduplicates admitted wakes at a 1,000-item FIFO before any extra upstream call", async () => {
    const f = await fixture();
    for (let i = 0; i < 1002; i++) await admit(f, `queued-${i}`);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.api.getMeeting = async (id) => {
      f.counts.meeting++;
      entered();
      await held;
      return f.meetings.get(id)!;
    };
    const worker = f.worker();
    await worker.wake(f.grant.address, "queued-0", "completed");
    await started;
    for (let i = 1; i < 1002; i++) await worker.wake(f.grant.address, `queued-${i}`, "completed");
    for (let i = 0; i < 100; i++) await worker.wake(f.grant.address, "queued-1", "completed");
    expect(worker.overflow.dropped).toBe(1);
    expect(f.counts.meeting).toBe(1);
    release();
    await worker.stop();
  });

  it("resolves an idempotent pending-create intent with a governed index write before delivery", async () => {
    const f = await fixture();
    const address = f.grant.address.toLowerCase();
    const meeting = f.meeting("recovered", address);
    f.meetings.set(meeting.id, meeting);
    await f.index.beginCreate(address, { key: "manual-v1-crashed", hash: "a".repeat(64), createdAt: Date.now() });
    let lookups = 0;
    f.api.lookupMeetingByIdempotencyKey = async (key) => {
      expect(key).toBe("manual-v1-crashed");
      lookups++;
      return { meeting, requestHash: "a".repeat(64) };
    };
    const worker = f.worker();
    await worker.sweep();
    expect(lookups).toBe(1);
    expect(await f.index.list(address)).toContain("recovered");
    expect(await f.index.listPending(address)).toEqual([]);
    expect(f.state().done.recovered.how).toBe("written");
    expect(f.events.filter((event) => event === "take")).toHaveLength(6);
    await worker.stop();
  });

  it("interleaves one wake with one pending-intent lookup while both sources stay busy", async () => {
    const f = await fixture();
    const address = f.grant.address.toLowerCase();
    for (let i = 0; i < 5; i++) {
      await admit(f, `wake-${i}`);
      await f.index.beginCreate(address, { key: `intent-${i}`, hash: "a".repeat(64), createdAt: Date.now() });
    }
    const sources: string[] = [];
    f.api.lookupMeetingByIdempotencyKey = async () => { sources.push("lookup"); return null; };
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.api.getMeeting = async (id) => {
      sources.push("wake");
      if (id === "wake-0") { entered(); await held; }
      return f.meetings.get(id)!;
    };
    const worker = f.worker();
    await worker.wake(address, "wake-0", "completed");
    await started;
    for (let i = 1; i < 5; i++) await worker.wake(address, `wake-${i}`, "completed");
    const sweep = worker.sweep();
    release();
    await sweep;
    expect(sources.slice(0, 10)).toEqual([
      "wake", "lookup", "wake", "lookup", "wake", "lookup", "wake", "lookup", "wake", "lookup",
    ]);
    expect(await f.index.listPending(address)).toHaveLength(5);
    await worker.stop();
  });

  it("never indexes or delivers a recovered create with a mismatched hash or owner", async () => {
    for (const mismatch of ["hash", "owner"]) {
      const f = await fixture();
      const address = f.grant.address.toLowerCase();
      await f.index.beginCreate(address, { key: `manual-v1-${mismatch}`, hash: "a".repeat(64), createdAt: Date.now() });
      f.api.lookupMeetingByIdempotencyKey = async () => ({
        meeting: f.meeting("foreign-recovery", mismatch === "owner" ? "0x0000000000000000000000000000000000000001" : address),
        requestHash: mismatch === "hash" ? "b".repeat(64) : "a".repeat(64),
      });
      const worker = f.worker();
      await worker.sweep();
      expect(await f.index.list(address)).toEqual([]);
      expect(await f.index.listPending(address)).toEqual([]);
      expect(f.counts.meeting).toBe(0);
      expect(f.counts.activation).toBe(0);
      expect(f.events.filter((event) => event === "take")).toHaveLength(1);
      await worker.stop();
    }
  });


  it("continues a 1,500-meeting sweep across 60 signed owners under wake floods and restarts", async () => {
    const f = await fixture();
    const owners = [f.grant];
    for (let i = 1; i < 60; i++) owners.push(await makeSignedTranscriptGrant({ privateKey: generatePrivateKey() }));
    const ids: { address: string; id: string }[] = [];
    for (let owner = 0; owner < owners.length; owner++) {
      const grant = owners[owner];
      const address = grant.address.toLowerCase();
      f.records.set(address, { serialized: grant.envelope, expiresAt: grant.expiresAt.toISOString(), actions: [], path: "connectors", grantedAt: "now" });
      for (let item = 0; item < 25; item++) {
        const id = `sweep-${owner}-${item}`;
        ids.push({ address, id });
        await admit(f, id, f.meeting(id, address), address);
      }
    }
    const first = f.worker();
    for (let pass = 0; pass < 3; pass++) {
      for (const item of ids.slice(pass * 30, (pass + 1) * 30)) await first.wake(item.address, item.id, "completed");
      await first.sweep();
    }
    await first.stop();
    const second = f.worker();
    for (let pass = 0; pass < 5; pass++) {
      for (const item of ids.slice((pass + 3) * 30, (pass + 4) * 30)) await second.wake(item.address, item.id, "completed");
      await second.sweep();
    }
    expect(f.db.query("SELECT COUNT(*) AS total FROM connector_meeting").get()).toEqual({ total: 1500 });
    expect(f.bodies.size).toBe(1500);
    expect(f.counts.meeting).toBe(1500);
    expect(ids.every(({ address, id }) => f.state(address).done[id]?.how === "written")).toBe(true);
    await second.stop();
  });

  it("batches 50×40 already-imported meetings into activation pair plus state put per owner", async () => {
    const f = await fixture();
    const owners = [f.grant];
    for (let i = 1; i < 50; i++) owners.push(await makeSignedTranscriptGrant({ privateKey: generatePrivateKey() }));
    for (let owner = 0; owner < owners.length; owner++) {
      const grant = owners[owner];
      const address = grant.address.toLowerCase();
      f.records.set(address, { serialized: grant.envelope, expiresAt: grant.expiresAt.toISOString(), actions: [], path: "connectors", grantedAt: "now" });
      for (let item = 0; item < 40; item++) {
        const id = `import-${owner}-${item}`;
        await admit(f, id, f.meeting(id, address), address);
        f.db.query("INSERT INTO connector_meeting (id, source, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(id, TRANSCRIBER_MEETING_SOURCE, id, "now", "now");
        f.bodies.set(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, id), "[]");
      }
    }
    let now = 0;
    const tokens: number[] = [];
    const governor = new WriteGovernor(6, () => now, async (delay) => { now += delay; });
    const metered = { take: async () => { await governor.take(); tokens.push(now); } } as WriteGovernor;
    const worker = f.worker({ governor: metered });
    for (let pass = 0; pass < 10; pass++) await worker.sweep();
    expect(f.counts.meeting).toBe(2000);
    expect(f.counts.transcript).toBe(0);
    expect(f.counts.activation).toBe(100);
    expect(f.backend.puts.filter((key) => key.startsWith("transcriber/delivery/"))).toHaveLength(50);
    expect(tokens).toHaveLength(150);
    expect(tokens.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(tokens.slice(6).every((at, index) => at - tokens[index + 5] >= 10_000)).toBe(true);
    await worker.stop();
  });

  it("persists storage 5xx, quota 402 and upstream Retry-After as distinct retry classes", async () => {
    const f = await fixture();
    for (const id of ["storage", "quota", "upstream"]) await admit(f, id);
    const node = f.node as unknown as { useDelegation: () => Promise<unknown> };
    const original = node.useDelegation;
    node.useDelegation = async () => { throw Object.assign(new Error("temporary"), { status: 503 }); };
    const worker = f.worker();
    await worker.deliver(f.grant.address, "storage");
    expect(f.state().retry.storage.code).toBe("storage_error");
    node.useDelegation = async () => { throw Object.assign(new Error("quota"), { status: 402 }); };
    await worker.deliver(f.grant.address, "quota");
    expect(f.state().retry.quota.code).toBe("storage_quota");
    expect(f.state().retry.quota.nextAt - Date.now()).toBeGreaterThan(23 * 3_600_000);
    node.useDelegation = original;
    f.api.getMeeting = async () => { throw new TranscriptionApiError(429, "slow_down", "slow down", 3_600_000); };
    await worker.deliver(f.grant.address, "upstream");
    expect(f.state().retry.upstream.code).toBe("upstream_unavailable");
    expect(f.state().retry.upstream.nextAt - Date.now()).toBeGreaterThan(3_590_000);
    await worker.stop();
  });

  it("meters rejected-grant removal and leaves the shared user lane free while a take waits", async () => {
    const f = await fixture();
    await admit(f, "rejected");
    await withActivationNode(f, { status: 403 }, async (host) => {
      const worker = f.worker({ configuredHost: host });
      await worker.deliver(f.grant.address, "rejected");
      expect(f.counts.removal).toBe(1);
      expect(f.events.filter((event) => event === "take")).toHaveLength(2);
      expect(f.backend.puts).toEqual([]);
      await worker.stop();
    });
    await admit(f, "lane");
    f.records.set(f.grant.address.toLowerCase(), {
      serialized: f.grant.envelope, expiresAt: f.grant.expiresAt.toISOString(), actions: [], path: "connectors", grantedAt: "now",
    });
    const lane = new BackendStorageLane();
    let waiting!: () => void;
    const reached = new Promise<void>((resolve) => { waiting = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let taken = 0;
    const governor = { async take() { if (++taken === 3) { waiting(); await blocked; } } } as WriteGovernor;
    const second = f.worker({ governor, runInWriteLane: (operation) => lane.run(operation) });
    const delivery = second.deliver(f.grant.address, "lane");
    await reached;
    let independent = false;
    await lane.run(async () => { independent = true; });
    expect(independent).toBe(true);
    release();
    await delivery;
    expect(f.state().done.lane.how).toBe("written");
    await second.stop();
  });

  it("removes a grant the node rejects at activation (401/403), so status reports none and renewal follows", async () => {
    for (const rejected of [401, 403]) {
      const f = await fixture();
      const answer = { status: 200 };
      await withActivationNode(f, answer, async (host) => {
        const coordinator = new TenantCoordinator();
        const cache = new DelegationCache();
        const worker = f.worker({ configuredHost: host, coordinator, delegationCache: cache });
        const address = f.grant.address.toLowerCase();
        const hostless = await makeSignedTranscriptGrant({ host: null });
        await withServer(delegationApp(f, worker, coordinator, host), async (base) => {
          // Accepted while the node still honours it, so status starts active and verified.
          const accepted = await fetch(`${base}/api/delegations`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hostless),
          });
          expect(accepted.status).toBe(200);
          expect(await (await fetch(`${base}/api/delegations/status`)).json()).toMatchObject({ status: "active", verified: true });

          answer.status = rejected;
          await admit(f, "revoked");
          await worker.deliver(address, "revoked");
          // Compare-and-delete removed it, caches are evicted, and no retry was recorded in its place.
          expect(f.records.has(address)).toBe(false);
          expect(cache.get(verificationCacheKey(address, hostless.envelope, f.grant.backendDid, host))).toBeNull();
          expect(f.state()?.retry?.revoked).toBeUndefined();
          expect(f.db.query("SELECT source_id FROM connector_meeting").all()).toEqual([]);

          // The browser reads absence, which `need()` treats as missing and urgent: it mints again.
          expect(await (await fetch(`${base}/api/delegations/status`)).json())
            .toEqual({ status: "none", expiresAt: null, verified: false, delivery: "enabled" });
          answer.status = 200;
          const renewed = await makeSignedTranscriptGrant({ host: null });
          const renewal = await fetch(`${base}/api/delegations`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(renewed),
          });
          expect(renewal.status).toBe(200);
          // A fresh id: "revoked" itself is inside the worker's 60 s per-id upstream throttle.
          await admit(f, "renewed");
          await worker.deliver(address, "renewed");
          expect(f.state().done.renewed.how).toBe("written");
        });
        await worker.stop();
      });
    }
  });

  it("keeps the grant and retries when activation fails with a node 5xx or a network error", async () => {
    const f = await fixture();
    const answer = { status: 503 };
    let host = "";
    await withActivationNode(f, answer, async (url) => {
      host = url;
      const worker = f.worker({ configuredHost: host });
      await admit(f, "outage");
      await worker.deliver(f.grant.address, "outage");
      expect(f.counts.removal).toBe(0);
      expect(f.records.has(f.grant.address.toLowerCase())).toBe(true);
      expect(f.state().retry.outage.code).toBe("storage_error");
      await worker.stop();
    });
    // The node is gone: the SDK's fetch rejects before any status exists.
    const node = f.node as unknown as { useDelegation: (delegation: { host: string }) => Promise<unknown> };
    const access = node.useDelegation;
    node.useDelegation = async (delegation) => {
      const result = await activateSessionWithHost(delegation.host, { Authorization: "Bearer invoker-session-offline" });
      if (!result.success) throw sdkActivationFailure(result);
      return access.call(node, delegation);
    };
    const worker = f.worker({ configuredHost: host });
    await admit(f, "offline");
    await worker.deliver(f.grant.address, "offline");
    node.useDelegation = access;
    expect(f.counts.removal).toBe(0);
    expect(f.records.has(f.grant.address.toLowerCase())).toBe(true);
    expect(f.state().retry.offline.code).toBe("upstream_unavailable");
    await worker.stop();
  });

  it("confirms a storage 403 with a fresh activation: a refused activation (401/403) deletes the grant", async () => {
    for (const [refused, confirmation] of [["sql", 403], ["kv", 403], ["sql", 401]] as const) {
      const f = await fixture();
      const answers: NodeAnswers = { delegate: 200, sql: 200, kv: 200 };
      await withStorageNode(f, answers, async (host) => {
        const cache = new DelegationCache();
        const worker = f.worker({ configuredHost: host, delegationCache: cache });
        const address = f.grant.address.toLowerCase();
        const envelope = f.records.get(address)!.serialized;
        await admit(f, "warm");
        await worker.deliver(address, "warm");
        expect(f.state().done.warm.how).toBe("written");
        const key = verificationCacheKey(address, envelope, f.grant.backendDid, host);
        expect(cache.get(key)).not.toBeNull();
        const activations = f.counts.activation;

        // Revoked upstream: the cached activation is refused, and so is the confirming activation.
        answers[refused] = 403;
        answers.delegate = confirmation;
        await admit(f, "refused");
        await worker.deliver(address, "refused");
        expect(f.counts.activation).toBe(activations + 1);
        expect(f.counts.removal).toBe(1);
        expect(f.records.has(address)).toBe(false);
        expect(cache.get(key)).toBeNull();
        expect(f.state().retry.refused).toBeUndefined();
        await worker.stop();
      });
    }
  });

  it("keeps the grant when the confirming activation succeeds, or fails by 5xx or network, and retries", async () => {
    for (const confirmation of [200, 503, 0]) {
      const f = await fixture();
      const answers: NodeAnswers = { delegate: 200, sql: 200, kv: 200 };
      await withStorageNode(f, answers, async (host) => {
        const cache = new DelegationCache();
        const worker = f.worker({ configuredHost: host, delegationCache: cache });
        const address = f.grant.address.toLowerCase();
        const envelope = f.records.get(address)!.serialized;
        await admit(f, "warm");
        await worker.deliver(address, "warm");
        const key = verificationCacheKey(address, envelope, f.grant.backendDid, host);
        const stale = cache.get(key);
        expect(stale).not.toBeNull();

        // An operational 403 (say, an ingress) on a still-valid grant.
        answers.sql = 403;
        answers.delegate = confirmation;
        await admit(f, "operational");
        await worker.deliver(address, "operational");
        expect({ confirmation, removed: f.counts.removal, kept: f.records.get(address)?.serialized === envelope })
          .toEqual({ confirmation, removed: 0, kept: true });
        expect(f.state().retry.operational.code).toBe("storage_error");
        expect(f.state().retry.operational.nextAt).toBeGreaterThan(Date.now());
        // The refused activation was dropped; a confirmed one replaces it.
        if (confirmation === 200) expect(cache.get(key)).not.toBe(stale);
        if (confirmation === 200) expect(cache.get(key)).not.toBeNull();
        else expect(cache.get(key)).toBeNull();
        await worker.stop();
      });
    }
  });

  it("keeps the grant and retries when the storage node fails transiently (SQL 503, KV-put 500)", async () => {
    for (const [service, status] of [["sql", 503], ["kv", 500]] as const) {
      const f = await fixture();
      const answers: NodeAnswers = { delegate: 200, sql: 200, kv: 200, [service]: status };
      await withStorageNode(f, answers, async (host) => {
        const worker = f.worker({ configuredHost: host });
        await admit(f, "transient");
        await worker.deliver(f.grant.address, "transient");
        expect(f.counts.removal).toBe(0);
        expect(f.records.has(f.grant.address.toLowerCase())).toBe(true);
        expect(f.state().retry.transient.code).toBe("storage_error");
        await worker.stop();
      });
    }
  });

  it("maps a storage 402 or 413 to the day-long quota backoff, whatever code the SDK gives it", async () => {
    for (const [service, status] of [["sql", 402], ["sql", 413], ["kv", 402], ["kv", 413]] as const) {
      const f = await fixture();
      const answers: NodeAnswers = { delegate: 200, sql: 200, kv: 200, [service]: status };
      await withStorageNode(f, answers, async (host) => {
        const worker = f.worker({ configuredHost: host });
        await admit(f, "quota");
        await worker.deliver(f.grant.address, "quota");
        expect({ service, status, code: f.state().retry.quota.code }).toEqual({ service, status, code: "storage_quota" });
        expect(f.state().retry.quota.nextAt - Date.now()).toBeGreaterThan(23 * 3_600_000);
        expect(f.counts.removal).toBe(0);
        await worker.stop();
      });
    }
  });

  it("an SDK 3.1 SQL 429 (SQL_QUOTA_EXCEEDED) takes the short storage retry, not the day-long quota backoff", async () => {
    const f = await fixture();
    await withStorageNode(f, { delegate: 200, sql: 429, kv: 200 }, async (host) => {
      const worker = f.worker({ configuredHost: host });
      await admit(f, "throttled");
      await worker.deliver(f.grant.address, "throttled");
      expect(f.state().retry.throttled.code).toBe("storage_error");
      expect(f.state().retry.throttled.nextAt - Date.now()).toBeLessThan(2 * 60_000);
      expect(f.counts.removal).toBe(0);
      await worker.stop();
    });
  });

  it("governs each of the five fresh-space writes individually at one token per fake minute", async () => {
    const f = await fixture();
    await admit(f, "paced");
    let now = 0;
    const takes: number[] = [];
    const governor = new WriteGovernor(1, () => now, async (ms) => { now += ms; });
    const metered = { take: async () => { await governor.take(); takes.push(now); f.events.push("take"); } } as WriteGovernor;
    let laneReleased = false;
    const worker = f.worker({ governor: metered, runInWriteLane: async (operation) => { laneReleased = true; return operation(); } });
    await worker.deliver(f.grant.address, "paced");
    expect(takes).toEqual([0, 60_000, 120_000, 180_000, 240_000]);
    expect(f.events.filter((event) => event !== "query")).toEqual([
      "take", "activation", "take", "activation", "take", "execute", "take", "put", "take", "state-put",
    ]);
    expect(laneReleased).toBe(true);
    expect(f.state().done.paced.how).toBe("written");
    await worker.stop();
  });
});
