import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { createApiBodyParser } from "../body-parsing.js";
import { createTranscriberWebhookRouter } from "../routes/transcriber-webhook.js";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import { KvTranscriptDeliveryStore, TranscriptDeliveryWorker } from "../services/transcript-delivery.js";
import type { TranscriptionApiClient } from "../services/transcription-api.js";
import { PTX_SIGNATURE_HEADER } from "../services/webhook-verify.js";

const PATH = "/api/transcriber/webhooks/ptx";
const ADDRESS = "0xaabbcc0000000000000000000000000000000001";
const MIXED_ADDRESS = "0xAABBcc0000000000000000000000000000000001";
const OTHER_ADDRESS = "0xbbbbcc0000000000000000000000000000000002";
const ID = "mtg_123";
const SECRET = `whsec_${"a".repeat(48)}`;

function event(type = "meeting.completed", address = MIXED_ADDRESS, id = ID): string {
  return JSON.stringify({ type, data: { meeting_id: id, metadata: { tinychat_address: address } } });
}

function signature(raw: string | Buffer): string {
  return `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
}

interface Delivery {
  body?: string | Buffer;
  signature?: string;
  contentType?: string;
  encoding?: string;
  ip?: string;
}

async function post(base: string, input: Delivery = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": input.contentType ?? "application/json",
    "x-forwarded-for": input.ip ?? "203.0.113.10",
  };
  if (input.signature !== undefined) headers[PTX_SIGNATURE_HEADER] = input.signature;
  if (input.encoding !== undefined) headers["content-encoding"] = input.encoding;
  return fetch(`${base}${PATH}`, { method: "POST", headers, body: input.body ?? event() });
}

interface Harness {
  index: MemoryTranscriberIndexStore;
  loads: string[];
  upstreamCalls: string[];
  firstAdmission: Promise<void>;
  secondAdmission: Promise<void>;
  releaseLoads: () => void;
  worker: TranscriptDeliveryWorker;
  app: express.Express;
}

function harness(secret?: string, blockLoads = false): Harness {
  const index = new MemoryTranscriberIndexStore();
  const loads: string[] = [];
  const upstreamCalls: string[] = [];
  const deliveryState = new Map<string, unknown>();
  const deliveryStore = new KvTranscriptDeliveryStore({
    async get<T>(key: string): Promise<T | null> {
      const value = deliveryState.get(key);
      return value === undefined ? null : value as T;
    },
    async put(key: string, value: unknown): Promise<void> { deliveryState.set(key, value); },
    async remove(key: string): Promise<void> { deliveryState.delete(key); },
    async keys(prefix: string): Promise<string[]> {
      return [...deliveryState.keys()].filter((key) => key.startsWith(prefix));
    },
  }, new BackendStorageLane());
  let first!: () => void;
  let second!: () => void;
  let releaseLoads!: () => void;
  const firstAdmission = new Promise<void>((resolve) => { first = resolve; });
  const secondAdmission = new Promise<void>((resolve) => { second = resolve; });
  const loadGate = new Promise<void>((resolve) => { releaseLoads = resolve; });
  const api: Pick<TranscriptionApiClient, "getMeeting" | "getTranscript"> = {
    getMeeting: async () => { upstreamCalls.push("getMeeting"); throw new Error("Unindexed meeting reached ptx"); },
    getTranscript: async () => { upstreamCalls.push("getTranscript"); throw new Error("Unindexed meeting reached ptx"); },
  };
  const worker = new TranscriptDeliveryWorker({
    index,
    delegationStore: {
      load: async (address) => {
        loads.push(address);
        if (loads.length === 1) first();
        if (loads.length === 2) second();
        if (blockLoads) await loadGate;
        return null;
      },
      remove: async () => { throw new Error("Unexpected delegation removal"); },
    },
    api: api as TranscriptionApiClient,
    node: {} as TinyCloudNode,
    backendDid: "did:key:test",
    configuredHost: "https://example.invalid",
    eligibility: (address) => address === ADDRESS,
    deliveryStore,
  });
  worker.start();
  const app = express();
  app.set("trust proxy", 1);
  app.use(PATH, createTranscriberWebhookRouter(worker, secret));
  // The real parser and CSRF middleware run only after the raw webhook mount.
  app.use(createApiBodyParser());
  app.use(createCsrfMiddleware());
  return { index, loads, upstreamCalls, firstAdmission, secondAdmission, releaseLoads, worker, app };
}

async function withWebhook(fn: (h: Harness, base: string) => Promise<void>, secret?: string, blockLoads = false): Promise<void> {
  const h = harness(secret, blockLoads);
  const server = await new Promise<Server>((resolve) => {
    const instance = h.app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const { port } = server.address() as AddressInfo;
  try {
    await fn(h, `http://127.0.0.1:${port}`);
  } finally {
    h.releaseLoads();
    await h.worker.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("private transcription webhook", () => {
  test("a signed raw delivery is accepted without CSRF, but missing, changed and uppercase HMACs grant no authority", async () => {
    await withWebhook(async (h, base) => {
      await h.index.add(ADDRESS, ID);
      const raw = ` {"type":"meeting.completed","data":{"meeting_id":"${ID}","metadata":{"tinychat_address":"${MIXED_ADDRESS}"}}} `;
      expect((await post(base, { body: raw, signature: signature(raw) })).status).toBe(202);
      await h.firstAdmission;
      expect(h.loads).toEqual([ADDRESS]);
      expect((await post(base, { body: raw })).status).toBe(401);
      expect((await post(base, { body: raw, signature: signature(event()) })).status).toBe(401);
      expect((await post(base, { body: raw, signature: `sha256=${signature(raw).slice(7).toUpperCase()}` })).status).toBe(401);
      expect((await post(base, { body: raw, signature: `${signature(raw)}, ${signature(raw)}` })).status).toBe(401);
      expect(h.loads).toEqual([ADDRESS]);
      expect(h.upstreamCalls).toEqual([]);
    }, SECRET);
  });

  test("unsigned mode admits only the indexed address and id, with no ptx or node activation on receipt", async () => {
    await withWebhook(async (h, base) => {
      await h.index.add(ADDRESS, ID);
      expect((await post(base, { body: event("meeting.completed", OTHER_ADDRESS) })).status).toBe(202);
      expect((await post(base, { body: event("meeting.completed", MIXED_ADDRESS, "unknown") })).status).toBe(202);
      expect(h.loads).toEqual([]);
      expect((await post(base)).status).toBe(202);
      await h.firstAdmission;
      expect(h.loads).toEqual([ADDRESS]);
      expect(h.upstreamCalls).toEqual([]);
    });
  });

  test("failed and malformed events cannot wake a worker, even with a valid signature", async () => {
    await withWebhook(async (h, base) => {
      await h.index.add(ADDRESS, ID);
      const failed = event("meeting.failed");
      expect((await post(base, { body: failed, signature: signature(failed) })).status).toBe(202);
      for (const body of ["{", "null", "[]", "{}", event("meeting.started"), event("meeting.completed", "0x123"), event("meeting.completed", MIXED_ADDRESS, "bad/id"), JSON.stringify({ type: "meeting.completed", data: [] })]) {
        expect((await post(base, { body, signature: signature(body) })).status).toBe(400);
      }
      expect(h.loads).toEqual([]);
      expect(h.upstreamCalls).toEqual([]);
    }, SECRET);
  });

  test("raw parser enforces 16 KiB, rejects gzip and wrong content types before any wake", async () => {
    await withWebhook(async (h, base) => {
      await h.index.add(ADDRESS, ID);
      const failed = event("meeting.failed");
      const exact = failed + " ".repeat(16 * 1024 - Buffer.byteLength(failed));
      expect((await post(base, { body: exact, signature: signature(exact) })).status).toBe(202);
      const oversized = `${event()}${" ".repeat(16 * 1024)}`;
      expect((await post(base, { body: oversized, signature: signature(oversized) })).status).toBe(413);
      const compressed = gzipSync(event());
      expect((await post(base, { body: compressed, encoding: "gzip", signature: signature(compressed) })).status).toBe(400);
      expect((await post(base, { body: event(), contentType: "text/plain", signature: signature(event()) })).status).toBe(400);
      expect(h.loads).toEqual([]);
      expect(h.upstreamCalls).toEqual([]);
    }, SECRET);
  });

  test("burst duplicates occupy one pending worker slot while the first delivery is in flight", async () => {
    await withWebhook(async (h, base) => {
      await h.index.add(ADDRESS, ID);
      expect((await post(base)).status).toBe(202);
      await h.firstAdmission;
      for (let i = 0; i < 20; i++) expect((await post(base)).status).toBe(202);
      h.releaseLoads();
      await h.worker.stop();
      expect(h.loads).toEqual([ADDRESS]);
      expect(h.upstreamCalls).toEqual([]);
    }, undefined, true);
  });

  test("a wake the worker cannot record (unreadable index, stopping worker) answers 503 with Retry-After", async () => {
    await withWebhook(async (h, base) => {
      await h.index.add(ADDRESS, ID);
      const entries = h.index.entries.bind(h.index);
      h.index.entries = async () => { throw new Error("transcriber_index_invalid"); };
      const unreadable = await post(base);
      expect(unreadable.status).toBe(503);
      expect(unreadable.headers.get("retry-after")).toBe("60");
      h.index.entries = entries;
      await h.worker.stop();
      expect((await post(base)).status).toBe(503);
      // A deliberately ignored wake is still 202 while stopping: nothing about the id leaks.
      expect((await post(base, { body: event("meeting.completed", OTHER_ADDRESS) })).status).toBe(202);
      expect(h.upstreamCalls).toEqual([]);
    });
  });

  test("the public endpoint enforces 60/min/IP and 600/min across different IPs", async () => {
    await withWebhook(async (h, base) => {
      const failed = event("meeting.failed");
      for (let i = 0; i < 60; i++) expect((await post(base, { body: failed })).status).toBe(202);
      expect((await post(base, { body: failed })).status).toBe(429);
      expect(h.loads).toEqual([]);
    });
    await withWebhook(async (h, base) => {
      const failed = event("meeting.failed");
      for (let ip = 0; ip < 10; ip++) {
        for (let i = 0; i < 60; i++) {
          expect((await post(base, { body: failed, ip: `198.51.100.${ip}` })).status).toBe(202);
        }
      }
      expect((await post(base, { body: failed, ip: "198.51.100.10" })).status).toBe(429);
      expect(h.loads).toEqual([]);
    });
  }, 30_000);
});
