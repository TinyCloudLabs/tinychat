// The TRANSCRIBER surface (routes/transcriber.ts): a per-address proxy over the private
// transcription API. Rules pinned here:
//   1. the tenant is the session address — another address's meeting id is `not_found`;
//   2. a bad meeting URL is refused BEFORE upstream is called;
//   3. create attributes the meeting to the address (metadata) and records it in the index;
//   4. transcript passes upstream's 202/200 through; stop and delete are owner-only;
//   5. upstream text never reaches the caller — only our own error codes;
//   6. the api client speaks the SPEC.md contract (paths, bearer, 202 handling).

import { describe, expect, test } from "bun:test";
import { request as httpRequest, type Server } from "node:http";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

import { createTranscriberRouter, type TranscriberRouterOptions } from "../routes/transcriber.js";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { KvTranscriberIndexStore, MemoryTranscriberIndexStore, resolvePendingCreates, type TranscriberIndexStore } from "../services/transcriber-index.js";
import {
  createTranscriptionApiClient,
  computeCreateRequestHash,
  transcriptDeliveryConfigFromEnv,
  TranscriptionApiError,
  type TranscriptionApiClient,
  type TranscriptionMeeting,
} from "../services/transcription-api.js";

const ADDRESS_A = "0xAaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAA";
const ADDRESS_B = "0xBbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBB";

function meeting(id: string, patch: Partial<TranscriptionMeeting> = {}): TranscriptionMeeting {
  return {
    id,
    object: "meeting",
    status: "queued",
    platform: "jitsi",
    meeting_url: "https://meet.jit.si/tinycloud-demo",
    created_at: "2026-08-18T10:00:00.000Z",
    metadata: {},
    ...patch,
  };
}

function fakeApi() {
  const calls: { method: string; args: unknown[] }[] = [];
  const store = new Map<string, TranscriptionMeeting>();
  const lookup = new Map<string, { id: string; hash: string }>();
  let nextId = 1;
  const api: TranscriptionApiClient = {
    async lookupMeetingByIdempotencyKey(key) {
      const found = lookup.get(key);
      const m = found && store.get(found.id);
      return m && found ? { meeting: m, requestHash: found.hash } : null;
    },
    async createMeeting(input, options) {
      calls.push({ method: "createMeeting", args: [input, options] });
      const m = meeting(`mtg_${nextId++}`, {
        meeting_url: input.meeting_url,
        bot: { name: input.bot_name ?? "" },
        metadata: input.metadata ?? {},
      });
      store.set(m.id, m);
      if (options?.idempotencyKey) lookup.set(options.idempotencyKey, {
        id: m.id, hash: computeCreateRequestHash(input),
      });
      return m;
    },
    async getMeeting(id) {
      calls.push({ method: "getMeeting", args: [id] });
      const m = store.get(id);
      if (!m) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
      return m;
    },
    async stopMeeting(id) {
      calls.push({ method: "stopMeeting", args: [id] });
      const m = store.get(id);
      if (!m) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
      m.status = "processing";
      return { id, status: m.status };
    },
    async getTranscript(id) {
      calls.push({ method: "getTranscript", args: [id] });
      const m = store.get(id);
      if (!m) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
      if (m.status !== "completed") return { pending: true, status: m.status };
      return {
        pending: false,
        transcript: {
          meeting_id: id,
          status: "completed",
          language: "en",
          duration_seconds: 3,
          speakers: [{ id: "speaker_0", name: "Sam" }],
          segments: [
            { id: "seg_001", speaker_id: "speaker_0", speaker_name: "Sam", start: 0, end: 3, text: "hello" },
          ],
          text: "Sam: hello",
        },
      };
    },
    async deleteMeeting(id) {
      calls.push({ method: "deleteMeeting", args: [id] });
      if (!store.delete(id)) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
    },
  };
  return { api, calls, store };
}

function harness(address: string | null = ADDRESS_A, index: TranscriberIndexStore = new MemoryTranscriberIndexStore(),
  options: Pick<TranscriberRouterOptions, "webhookUrl" | "onObservedCompletion"> = {}) {
  const { api, calls, store } = fakeApi();
  const session: { address: string | null } = { address };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (session.address !== null) req.user = { address: session.address };
    next();
  });
  app.use("/api/transcriber/meetings", createTranscriberRouter({ api, index, ...options }));
  return { app, api, calls, store, index, session };
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}

async function call(base: string, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: response.status, body: parsed, text };
}

/** A dedicated socket per request, so overlap tests cannot be serialized by fetch pooling. */
async function socketCall(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const request = httpRequest(`${base}${path}`, {
      method: "POST",
      agent: false,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), ...headers },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text), text });
      });
    });
    request.on("error", reject);
    request.end(encoded);
  });
}

describe("POST /api/transcriber/meetings", () => {
  test("refuses a bad meeting URL before touching upstream", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      for (const bad of [undefined, "", "not a url", "ftp://x/y", "javascript:alert(1)"]) {
        const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: bad });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe("invalid_meeting_url");
      }
    });
    expect(h.calls).toEqual([]);
  });

  test("reads pasted link forms and sends ptx the meeting link it recognises", async () => {
    const cases: Array<[string, string]> = [
      ["https://google.com/meet/ofj-ahew-paa", "https://meet.google.com/ofj-ahew-paa"],
      ["meet.google.com/wmq-jkvr-rmi", "https://meet.google.com/wmq-jkvr-rmi"],
      ["abc-defg-hij", "https://meet.google.com/abc-defg-hij"],
      ["https://www.google.com/url?q=https://meet.google.com/kmn-pqrs-tuv&sa=D", "https://meet.google.com/kmn-pqrs-tuv"],
    ];
    const h = harness();
    await withServer(h.app, async (base) => {
      for (const [pasted] of cases) {
        expect((await call(base, "/api/transcriber/meetings", "POST", { meeting_url: pasted })).status).toBe(201);
      }
    });
    const created = h.calls.filter(c => c.method === "createMeeting");
    expect(created.map(c => (c.args[0] as { meeting_url: string }).meeting_url)).toEqual(cases.map(([, sent]) => sent));
  });

  test("creates upstream with the address in metadata, indexes it, returns 201", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings", "POST", {
        meeting_url: "https://meet.jit.si/tinycloud-demo",
        bot_name: "  Notetaker ",
      });
      expect(r.status).toBe(201);
      expect(r.body.id).toBe("mtg_1");
      expect(r.body.status).toBe("queued");
    });
    expect(h.calls[0]?.method).toBe("createMeeting");
    expect(h.calls[0]?.args[0]).toEqual({
      meeting_url: "https://meet.jit.si/tinycloud-demo",
      bot_name: "Notetaker",
      metadata: { tinychat_address: ADDRESS_A.toLowerCase() },
    });
    expect(h.calls[0]?.args[1]).toEqual({ idempotencyKey: expect.stringMatching(/^manual-v1-[0-9a-f-]{36}$/), onAttempt: expect.any(Function) });
    expect(await h.index.list(ADDRESS_A)).toEqual(["mtg_1"]);
  });

  test("forwards a valid client key and rejects invalid keys before ptx", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      const valid = "manual-v1-11111111-1111-4111-8111-111111111111";
      expect((await call(base, "/api/transcriber/meetings", "POST", {
        meeting_url: " https://MEET.jit.si/room/?b=2&a=1#fragment ",
      }, { "Idempotency-Key": valid })).status).toBe(201);
      // Canonicalization is comparison-only; signed/capability URL bytes go upstream intact.
      expect((h.calls[0]!.args[0] as { meeting_url: string }).meeting_url).toBe("https://MEET.jit.si/room/?b=2&a=1#fragment");
      expect((h.calls[0]!.args[1] as { idempotencyKey: string }).idempotencyKey).toBe(valid);
      for (const invalid of ["", "has a space", "x".repeat(129)]) {
        const response = await call(base, "/api/transcriber/meetings", "POST", {
          meeting_url: "https://meet.jit.si/other",
        }, { "Idempotency-Key": invalid });
        expect(response).toMatchObject({ status: 400, body: { error: "invalid_idempotency_key" } });
      }
    });
    expect(h.calls.filter(call => call.method === "createMeeting")).toHaveLength(1);
  });

  test("coalesces concurrent same-user normalized URLs into one ptx create", async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = h.api.createMeeting;
    h.api.createMeeting = async (input, options) => {
      await held;
      return original(input, options);
    };
    await withServer(h.app, async (base) => {
      const one = socketCall(base, "/api/transcriber/meetings", { meeting_url: "https://meet.jit.si/room/" },
        { "Idempotency-Key": "manual-v1-11111111-1111-4111-8111-111111111111" });
      // Keep the first request inside create long enough for the second request to enter the
      // router. Without in-flight coalescing this produces two upstream creates.
      await Bun.sleep(100);
      const two = socketCall(base, "/api/transcriber/meetings", { meeting_url: "https://MEET.jit.si/room#x" },
        { "Idempotency-Key": "manual-v1-22222222-2222-4222-8222-222222222222" });
      await Bun.sleep(100);
      release();
      const responses = await Promise.all([one, two]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
      expect(responses[0]!.body.id).toBe(responses[1]!.body.id);
    });
    expect(h.calls.filter(call => call.method === "createMeeting")).toHaveLength(1);
  });

  test("concurrent sends for different owners never share an in-flight result", async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    const original = h.api.createMeeting;
    let creates = 0;
    h.api.createMeeting = async (input, options) => {
      if (++creates === 1) entered();
      await held;
      return original(input, options);
    };
    await withServer(h.app, async (base) => {
      const one = socketCall(base, "/api/transcriber/meetings", { meeting_url: "https://meet.jit.si/shared" });
      await firstEntered;
      h.session.address = ADDRESS_B;
      const two = socketCall(base, "/api/transcriber/meetings", { meeting_url: "https://meet.jit.si/shared" });
      await Bun.sleep(100);
      release();
      const responses = await Promise.all([one, two]);
      expect(responses.map(response => response.status)).toEqual([201, 201]);
      expect(responses[0]!.body.id).not.toBe(responses[1]!.body.id);
    });
    expect(creates).toBe(2);
  });

  test("dedup scans only the newest candidates with bounded parallelism and skips unreadable rows", async () => {
    const index = new MemoryTranscriberIndexStore();
    const h = harness(ADDRESS_A, index);
    for (let i = 39; i >= 0; i--) {
      const id = `mtg_history_${i}`;
      h.store.set(id, meeting(id, {
        status: i === 35 ? "joining" : "completed",
        meeting_url: i === 35 ? "https://meet.jit.si/bounded" : `https://meet.jit.si/history-${i}`,
        metadata: { tinychat_address: ADDRESS_A.toLowerCase() },
      }));
      await index.add(ADDRESS_A, id);
    }
    const original = h.api.getMeeting;
    let reads = 0;
    let activeReads = 0;
    let maxActiveReads = 0;
    h.api.getMeeting = async (id) => {
      reads++;
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        await Bun.sleep(5);
        if (id === "mtg_history_3") throw new TranscriptionApiError(503, null, "old row unavailable");
        return await original(id);
      } finally {
        activeReads--;
      }
    };
    await withServer(h.app, async (base) => {
      const response = await call(base, "/api/transcriber/meetings", "POST", {
        meeting_url: "https://meet.jit.si/bounded",
      });
      expect(response.status).toBe(201);
    });
    expect(reads).toBe(32);
    expect(maxActiveReads).toBeGreaterThan(1);
    expect(maxActiveReads).toBeLessThanOrEqual(8);
    expect(h.calls.filter(call => call.method === "createMeeting")).toHaveLength(1);
  });

  test("idempotency conflicts are a distinct 409 for local and upstream conflicts", async () => {
    const h = harness();
    const key = "manual-v1-11111111-1111-4111-8111-111111111111";
    await h.index.beginCreate(ADDRESS_A.toLowerCase(), { key, hash: "a".repeat(64), createdAt: Date.now() });
    await withServer(h.app, async (base) => {
      const local = await call(base, "/api/transcriber/meetings", "POST", {
        meeting_url: "https://meet.jit.si/local-conflict",
      }, { "Idempotency-Key": key });
      expect(local).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });

      await h.index.abandonCreate(ADDRESS_A.toLowerCase(), key);
      h.api.createMeeting = async () => {
        throw new TranscriptionApiError(409, "idempotency_conflict", "upstream detail");
      };
      const upstream = await call(base, "/api/transcriber/meetings", "POST", {
        meeting_url: "https://meet.jit.si/upstream-conflict",
      }, { "Idempotency-Key": key });
      expect(upstream).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });
      expect(upstream.text).not.toContain("upstream detail");
    });
  });

  test("a cold router finds a preexisting owned active meeting without an initial list", async () => {
    const index = new MemoryTranscriberIndexStore();
    const h = harness(ADDRESS_A, index);
    h.store.set("mtg_existing", meeting("mtg_existing", {
      status: "in_progress",
      meeting_url: "https://meet.jit.si/existing/",
      metadata: { tinychat_address: ADDRESS_A.toLowerCase() },
    }));
    await index.add(ADDRESS_A, "mtg_existing");
    await withServer(h.app, async (base) => {
      const response = await call(base, "/api/transcriber/meetings", "POST", {
        meeting_url: "https://MEET.jit.si/existing#browser-only",
      }, { "Idempotency-Key": "manual-v1-11111111-1111-4111-8111-111111111111" });
      expect(response.status).toBe(200);
      expect(response.body.id).toBe("mtg_existing");
    });
    expect(h.calls.filter(call => call.method === "createMeeting")).toEqual([]);
    expect(await index.listPending(ADDRESS_A)).toEqual([]);
  });

  test("an old terminal row cannot hide a newer active row for the same URL", async () => {
    const index = new MemoryTranscriberIndexStore();
    const h = harness(ADDRESS_A, index);
    const url = "https://meet.jit.si/repeated";
    h.store.set("mtg_old", meeting("mtg_old", {
      status: "failed", meeting_url: url, metadata: { tinychat_address: ADDRESS_A.toLowerCase() },
    }));
    h.store.set("mtg_new", meeting("mtg_new", {
      status: "joining", meeting_url: url, metadata: { tinychat_address: ADDRESS_A.toLowerCase() },
    }));
    await index.add(ADDRESS_A, "mtg_old");
    await index.add(ADDRESS_A, "mtg_new");
    const realGet = h.api.getMeeting;
    h.api.getMeeting = async (id) => {
      if (id === "mtg_old") await Bun.sleep(5);
      return realGet(id);
    };
    await withServer(h.app, async (base) => {
      expect((await call(base, "/api/transcriber/meetings")).status).toBe(200);
      const response = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: `${url}/` });
      expect(response.status).toBe(200);
      expect(response.body.id).toBe("mtg_new");
    });
    expect(h.calls.filter(call => call.method === "createMeeting")).toEqual([]);
  });

  test("a stuck-joining meeting blocks a repeat send to its link, like a joining one", async () => {
    for (const status of ["joining", "needs_help"] as const) {
      const index = new MemoryTranscriberIndexStore();
      const h = harness(ADDRESS_A, index);
      const url = "https://meet.jit.si/stuck";
      h.store.set("mtg_live", meeting("mtg_live", {
        status, meeting_url: url, metadata: { tinychat_address: ADDRESS_A.toLowerCase() },
      }));
      await index.add(ADDRESS_A, "mtg_live");
      await withServer(h.app, async (base) => {
        expect((await call(base, "/api/transcriber/meetings")).status).toBe(200);
        const response = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: url });
        expect(response.status).toBe(200);
        expect(response.body.id).toBe("mtg_live");
      });
      expect(h.calls.filter(call => call.method === "createMeeting")).toEqual([]);
    }
  });

  test("an active row attributed to another owner never dedupes this user's send", async () => {
    const index = new MemoryTranscriberIndexStore();
    const h = harness(ADDRESS_A, index);
    h.store.set("mtg_other", meeting("mtg_other", {
      status: "joining",
      meeting_url: "https://meet.jit.si/ownership",
      metadata: { tinychat_address: ADDRESS_B.toLowerCase() },
    }));
    await index.add(ADDRESS_A, "mtg_other");
    await withServer(h.app, async (base) => {
      const response = await call(base, "/api/transcriber/meetings", "POST", {
        meeting_url: "https://meet.jit.si/ownership",
      });
      expect(response.status).toBe(201);
      expect(response.body.id).toBe("mtg_1");
    });
    expect(h.calls.filter(call => call.method === "createMeeting")).toHaveLength(1);
  });

  test("a retry after the first response was lost returns the active record without a second create", async () => {
    const h = harness();
    const key = "manual-v1-11111111-1111-4111-8111-111111111111";
    await withServer(h.app, async (base) => {
      expect((await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/retry" },
        { "Idempotency-Key": key })).status).toBe(201);
      const retry = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/retry/" },
        { "Idempotency-Key": key });
      expect(retry.status).toBe(200);
      expect(retry.body.id).toBe("mtg_1");
    });
    expect(h.calls.filter(call => call.method === "createMeeting")).toHaveLength(1);
  });

  test("terminal resend creates a new bot, while a different URL is always separate", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/ended" });
      h.store.get("mtg_1")!.status = "failed";
      const replacement = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/ended" });
      const separate = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/other" });
      expect([replacement.status, replacement.body.id, separate.status, separate.body.id]).toEqual([201, "mtg_2", 201, "mtg_3"]);
    });
    expect(h.calls.filter(call => call.method === "createMeeting")).toHaveLength(3);
  });

  test("adds webhook_url only for configured delivery, preserving the hashed create body", async () => {
    const h = harness();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { address: ADDRESS_A }; next(); });
    app.use("/api/transcriber/meetings", createTranscriberRouter({
      api: h.api, index: h.index, webhookUrl: "https://tinychat.example/api/transcriber/webhooks/ptx",
    }));
    await withServer(app, async base => {
      const created = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/x" });
      expect(created.status).toBe(201);
    });
    const body = h.calls[0]?.args[0];
    const options = h.calls[0]?.args[1];
    expect(body).toEqual({
      meeting_url: "https://meet.jit.si/x", bot_name: "TinyCloud Private Notetaker",
      webhook_url: "https://tinychat.example/api/transcriber/webhooks/ptx",
      metadata: { tinychat_address: ADDRESS_A.toLowerCase() },
    });
    expect(options).toEqual({ idempotencyKey: expect.stringMatching(/^manual-v1-/), onAttempt: expect.any(Function) });
    expect(await h.index.listPending(ADDRESS_A)).toEqual([]);
  });

  test("recovers an expired backend KV session and keeps the created meeting", async () => {
    let signedIn = false;
    let signInCalls = 0;
    let ids: string[] = [];
    const node = {
      kv: {
        async get() {
          if (!signedIn) throw new Error("Not signed in. Call signIn() first.");
          return { ok: true, data: { ids } };
        },
        async put(_key: string, value: { ids: string[] }) {
          if (!signedIn) throw new Error("Not signed in. Call signIn() first.");
          ids = value.ids;
          return { ok: true };
        },
      },
      async signIn() {
        signedIn = true;
        signInCalls++;
      },
    } as unknown as TinyCloudNode;
    const index = new KvTranscriberIndexStore(node, new BackendStorageLane());
    const h = harness(ADDRESS_A, index);

    await withServer(h.app, async (base) => {
      const created = await call(base, "/api/transcriber/meetings", "POST", {
        meeting_url: "https://meet.jit.si/tinycloud-demo",
      });
      expect(created.status).toBe(201);
      const listed = await call(base, "/api/transcriber/meetings");
      expect(listed.status).toBe(200);
      expect(listed.body.meetings.map((m: TranscriptionMeeting) => m.id)).toEqual(["mtg_1"]);
    });
    expect(signInCalls).toBe(1);
    expect(ids).toEqual(["mtg_1"]);
  });

  test("uses the default bot name when none is given", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.google.com/abc-defg-hij" });
    });
    expect((h.calls[0]!.args[0] as { bot_name: string }).bot_name).toBe("TinyCloud Private Notetaker");
  });

  test("401 without a session", async () => {
    const h = harness(null);
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/x" });
      expect(r.status).toBe(401);
    });
    expect(h.calls).toEqual([]);
  });
});

describe("GET /api/transcriber/meetings", () => {
  test("listing an owned completed meeting wakes delivery without leaking another owner's row", async () => {
    const wakes: Array<[string, string]> = [];
    const h = harness(ADDRESS_A, new MemoryTranscriberIndexStore(), {
      onObservedCompletion: async (address, id) => { wakes.push([address, id]); },
    });
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      h.store.get("mtg_1")!.status = "completed";
      h.store.set("mtg_other", meeting("mtg_other", { status: "completed" }));
      h.session.address = ADDRESS_B;
      expect((await call(base, "/api/transcriber/meetings")).body.meetings).toEqual([]);
      h.session.address = ADDRESS_A;
      const response = await call(base, "/api/transcriber/meetings");
      expect(response.status).toBe(200);
      expect(response.body.meetings.map((item: TranscriptionMeeting) => item.id)).toEqual(["mtg_1"]);
      expect(wakes).toEqual([[ADDRESS_A.toLowerCase(), "mtg_1"]]);
    });
  });

  test("an upstream completion recorded for another owner, or for none, is not a trusted observation", async () => {
    const wakes: Array<[string, string]> = [];
    const h = harness(ADDRESS_A, new MemoryTranscriberIndexStore(), {
      onObservedCompletion: async (address, id) => { wakes.push([address, id]); },
    });
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      const row = h.store.get("mtg_1")!;
      row.status = "completed";
      for (const metadata of [{ tinychat_address: ADDRESS_B }, {}, { tinychat_address: 7 }]) {
        row.metadata = metadata;
        expect((await call(base, "/api/transcriber/meetings")).status).toBe(200);
      }
      expect(wakes).toEqual([]);
      row.metadata = { tinychat_address: ADDRESS_A.toUpperCase().replace("0X", "0x") };
      expect((await call(base, "/api/transcriber/meetings")).status).toBe(200);
      expect(wakes).toEqual([[ADDRESS_A.toLowerCase(), "mtg_1"]]);
    });
  });

  test("lists only the address's meetings, newest first, refreshed upstream", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/two" });
      // Someone else's meeting exists upstream but not in A's index.
      h.store.set("mtg_other", meeting("mtg_other"));
      h.store.get("mtg_1")!.status = "in_progress";

      const r = await call(base, "/api/transcriber/meetings");
      expect(r.status).toBe(200);
      expect(r.body.meetings.map((m: TranscriptionMeeting) => m.id)).toEqual(["mtg_2", "mtg_1"]);
      expect(r.body.meetings[1].status).toBe("in_progress");
    });
  });

  test("a stuck-joining meeting is listed with its needs_help status", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      h.store.get("mtg_1")!.status = "needs_help";

      const r = await call(base, "/api/transcriber/meetings");
      expect(r.status).toBe(200);
      expect(r.body.meetings[0].status).toBe("needs_help");
    });
  });

  test("a meeting deleted upstream out of band drops out of the list and the index", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      h.store.delete("mtg_1");
      const r = await call(base, "/api/transcriber/meetings");
      expect(r.body.meetings).toEqual([]);
    });
    expect(await h.index.list(ADDRESS_A)).toEqual([]);
  });

  test("an upstream outage on one row is told as unavailable, not dropped", async () => {
    const h = harness();
    const realGet = h.api.getMeeting;
    h.api.getMeeting = async (id) => {
      if (id === "mtg_1") throw new TranscriptionApiError(503, null, "vexa down");
      return realGet(id);
    };
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      const r = await call(base, "/api/transcriber/meetings");
      expect(r.body.meetings).toEqual([{ id: "mtg_1", unavailable: true }]);
      expect(r.text).not.toContain("vexa");
    });
  });
});

describe("per-meeting routes", () => {
  test("another address's meeting is not_found for get/stop/transcript/delete", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      h.session.address = ADDRESS_B;
      expect((await call(base, "/api/transcriber/meetings/mtg_1")).status).toBe(404);
      expect((await call(base, "/api/transcriber/meetings/mtg_1/stop", "POST")).status).toBe(404);
      expect((await call(base, "/api/transcriber/meetings/mtg_1/transcript")).status).toBe(404);
      expect((await call(base, "/api/transcriber/meetings/mtg_1", "DELETE")).status).toBe(404);
    });
    // Ownership was checked before upstream: none of these reached the API.
    expect(h.calls.filter((c) => c.method !== "createMeeting")).toEqual([]);
    expect(h.store.has("mtg_1")).toBe(true);
  });

  test("transcript is 202 while pending and 200 with segments once completed", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      const pending = await call(base, "/api/transcriber/meetings/mtg_1/transcript");
      expect(pending.status).toBe(202);
      expect(pending.body).toEqual({ meeting_id: "mtg_1", status: "queued" });

      h.store.get("mtg_1")!.status = "completed";
      const done = await call(base, "/api/transcriber/meetings/mtg_1/transcript");
      expect(done.status).toBe(200);
      expect(done.body.segments[0].speaker_name).toBe("Sam");
      expect(done.body.text).toBe("Sam: hello");
    });
  });

  test("stop proxies to upstream for the owner", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      const r = await call(base, "/api/transcriber/meetings/mtg_1/stop", "POST");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ id: "mtg_1", status: "processing" });
    });
  });

  test("delete removes upstream and from the index; a second delete is not_found", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      expect((await call(base, "/api/transcriber/meetings/mtg_1", "DELETE")).status).toBe(204);
      expect(h.store.has("mtg_1")).toBe(false);
      expect(await h.index.list(ADDRESS_A)).toEqual([]);
      expect((await call(base, "/api/transcriber/meetings/mtg_1", "DELETE")).status).toBe(404);
    });
  });

  test("upstream failures surface as our own codes, never upstream text", async () => {
    const h = harness();
    h.api.createMeeting = async () => {
      throw new TranscriptionApiError(400, "unsupported_platform", "Vexa cannot join webex");
    };
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://webex.com/m/1" });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("unsupported_platform");
    });
    h.api.createMeeting = async () => {
      throw new Error("ECONNREFUSED 10.0.0.7:8056");
    };
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/x" });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: "transcriber_unavailable" });
      expect(r.text).not.toContain("ECONNREFUSED");
    });
  });

  test("TC-907: a ptx capacity 429 passes its busy message and Retry-After through", async () => {
    const h = harness();
    const busy = "All 2 meeting notetakers are busy right now. Try again when one of the current meetings ends.";
    h.api.createMeeting = async () => {
      throw new TranscriptionApiError(429, "capacity_exhausted", busy, 60_000);
    };
    await withServer(h.app, async (base) => {
      const response = await fetch(`${base}/api/transcriber/meetings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meeting_url: "https://meet.google.com/abc-defg-hij" }),
      });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.json()).toEqual({ error: "capacity_exhausted", message: busy, retry_after_seconds: 60 });
    });
    // Any other 429 keeps its own code and never relays upstream text.
    h.api.createMeeting = async () => {
      throw new TranscriptionApiError(429, "rate_limited", "upstream detail");
    };
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/x" });
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ error: "upstream_rate_limited" });
    });
    expect(await h.index.list(ADDRESS_A.toLowerCase())).toEqual([]);
  });
});

describe("transcription api client", () => {
  test("speaks the SPEC.md contract: bearer key, /v1 paths, 202 = pending", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const answers: Record<string, { status: number; body: unknown }> = {
      "POST /v1/meetings": { status: 201, body: meeting("mtg_9") },
      "GET /v1/meetings/mtg_9": { status: 200, body: meeting("mtg_9", { status: "in_progress" }) },
      "GET /v1/meetings/mtg_9/transcript": { status: 202, body: { meeting_id: "mtg_9", status: "processing" } },
      "POST /v1/meetings/mtg_9/stop": { status: 200, body: { id: "mtg_9", status: "processing" } },
      "DELETE /v1/meetings/mtg_9": { status: 204, body: "" },
    };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      const key = `${init?.method} ${new URL(String(url)).pathname}`;
      const a = answers[key];
      if (!a) return new Response(JSON.stringify({ error: { code: "meeting_not_found", message: "x" } }), { status: 404 });
      return new Response(a.body === "" ? null : JSON.stringify(a.body), { status: a.status });
    }) as typeof fetch;

    const api = createTranscriptionApiClient({ baseUrl: "https://transcribe.example/", apiKey: "tc_live_abc", fetchImpl });
    const created = await api.createMeeting({ meeting_url: "https://meet.jit.si/x" });
    expect(created.id).toBe("mtg_9");
    expect((await api.getMeeting("mtg_9")).status).toBe("in_progress");
    expect(await api.getTranscript("mtg_9")).toEqual({ pending: true, status: "processing" });
    // Live upstream answers 200 + {meeting_id, status} (no segments) for failed/cancelled.
    answers["GET /v1/meetings/mtg_9/transcript"] = { status: 200, body: { meeting_id: "mtg_9", status: "failed" } };
    expect(await api.getTranscript("mtg_9")).toEqual({ pending: true, status: "failed" });
    expect(await api.stopMeeting("mtg_9")).toEqual({ id: "mtg_9", status: "processing" });
    await api.deleteMeeting("mtg_9");
    await expect(api.getMeeting("mtg_missing")).rejects.toMatchObject({ status: 404, code: "meeting_not_found" });

    expect(seen[0]!.url).toBe("https://transcribe.example/v1/meetings");
    for (const s of seen) {
      expect((s.init.headers as Record<string, string>).Authorization).toBe("Bearer tc_live_abc");
    }
  });
});

describe("wiring", () => {
  test("index.ts mounts /api/transcriber/meetings behind authMiddleware, gated on the env config", () => {
    const src = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    expect(src).toMatch(/app\.use\(\s*\n?\s*"\/api\/transcriber\/meetings",\s*\n?\s*authMiddleware,/);
    expect(src).toContain("transcriptionApiConfigFromEnv()");
  });

  test("rate-limits gives the transcriber its own bucket", async () => {
    const limits = await import("../rate-limits.js");
    expect(limits.TRANSCRIBER_PATHS).toEqual(["/api/transcriber"]);
    expect(limits.TRANSCRIBER_LIMIT).toBeGreaterThan(limits.GLOBAL_LIMIT);
  });
});

describe("Phala deploy environment", () => {
  // Same four-place rule as webhook-deploy-env.test.ts: `allowed_envs` is derived from the
  // ENV_FILE the workflow writes and frozen at CVM creation, so a var missing from any place is
  // silently dropped at injection and the transcriber stays 404 with the repo secret set.
  const KEYS = ["TRANSCRIPTION_API_URL", "TRANSCRIPTION_API_KEY", "TRANSCRIPTION_BOT_NAME"] as const;
  const repoRoot = resolve(import.meta.dir, "../../..");

  test("deploy workflow declares and writes every transcriber var; compose passes it through", () => {
    const workflow = loadYaml(
      readFileSync(resolve(repoRoot, ".github/workflows/deploy-backend-phala.yml"), "utf8"),
    ) as { jobs?: { deploy?: { steps?: { env?: Record<string, unknown>; run?: string }[] } } };
    const writer = workflow.jobs?.deploy?.steps?.find(
      (s) => typeof s.run === "string" && s.run.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'),
    );
    expect(writer).toBeTruthy();
    const compose = loadYaml(readFileSync(resolve(repoRoot, "docker-compose.phala.yml"), "utf8")) as {
      services?: Record<string, { environment?: Record<string, string> }>;
    };
    const env = compose.services?.["tinychat-backend"]?.environment ?? {};
    const example = readFileSync(resolve(repoRoot, "backend/.env.example"), "utf8");
    for (const key of KEYS) {
      expect(Object.hasOwn(writer?.env ?? {}, key)).toBe(true);
      expect(writer?.run).toContain(`"${key}=`);
      expect(String(env[key])).toContain(`\${${key}`);
      expect(example).toContain(`${key}=`);
    }
    // The key is a secret, the URL a public variable.
    expect(String(writer?.env?.TRANSCRIPTION_API_KEY)).toContain("secrets.TRANSCRIPTION_API_KEY");
    expect(String(writer?.env?.TRANSCRIPTION_API_URL)).toContain("vars.TRANSCRIPTION_API_URL");
  });
});

describe("transcription api client — transient upstream blips", () => {
  test("retries once on a closed socket, sends the SAME Idempotency-Key, and does not retry HTTP errors", async () => {
    let calls = 0;
    const keys: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      if (calls === 1) throw new Error("The socket connection was closed unexpectedly");
      return new Response(JSON.stringify(meeting("mtg_r")), { status: 201 });
    }) as typeof fetch;
    const api = createTranscriptionApiClient({
      baseUrl: "https://t.example",
      apiKey: "tc_live_x",
      fetchImpl,
      sleep: async () => {},
      idempotencyKey: () => "idem-1",
    });
    expect((await api.createMeeting({ meeting_url: "https://meet.jit.si/x" })).id).toBe("mtg_r");
    expect(calls).toBe(2);
    expect(keys).toEqual(["idem-1", "idem-1"]);

    // A second transport failure in a row surfaces (one retry only).
    calls = 0;
    const dead = (async () => {
      calls++;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const api2 = createTranscriptionApiClient({ baseUrl: "https://t.example", apiKey: "k", fetchImpl: dead, sleep: async () => {} });
    await expect(api2.getMeeting("mtg_1")).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(2);

    // The upstream stop contract is idempotent, so it is also safe to retry once.
    calls = 0;
    const stopAfterBlip = (async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ id: "mtg_1", status: "processing" }));
    }) as unknown as typeof fetch;
    const apiStop = createTranscriptionApiClient({
      baseUrl: "https://t.example",
      apiKey: "k",
      fetchImpl: stopAfterBlip,
      sleep: async () => {},
    });
    await expect(apiStop.stopMeeting("mtg_1")).resolves.toEqual({ id: "mtg_1", status: "processing" });
    expect(calls).toBe(2);

    // An HTTP error is NOT a transport blip: one call, thrown as TranscriptionApiError.
    calls = 0;
    const http503 = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: "provider_unavailable", message: "x" } }), { status: 503 });
    }) as unknown as typeof fetch;
    const api3 = createTranscriptionApiClient({ baseUrl: "https://t.example", apiKey: "k", fetchImpl: http503, sleep: async () => {} });
    await expect(api3.getMeeting("mtg_1")).rejects.toMatchObject({ status: 503, code: "provider_unavailable" });
    expect(calls).toBe(1);
  });
});

describe("TC-581 shared index provenance", () => {
  const prov = (title = "Team sync") => ({ ownerTenant: ADDRESS_A.toLowerCase(), ownerOccurrenceId: "owner-occ", recipientOccurrenceId: "recipient-occ",
    checkedAt: 1, title, scheduledStart: "2026-09-25T12:00:00.000Z" });

  function fakeKvNode() {
    const docs = new Map<string, unknown>();
    const node = {
      kv: {
        async get(key: string) { return docs.has(key) ? { ok: true, data: structuredClone(docs.get(key)) } : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } }; },
        async put(key: string, value: unknown) { docs.set(key, structuredClone(value)); return { ok: true }; },
      },
      async signIn() {},
    } as unknown as TinyCloudNode;
    return { node, docs };
  }

  for (const kind of ["memory", "kv"] as const) {
    const make = () => {
      if (kind === "memory") return { index: new MemoryTranscriberIndexStore() as TranscriberIndexStore, docs: null };
      const { node, docs } = fakeKvNode();
      return { index: new KvTranscriberIndexStore(node, new BackendStorageLane()) as TranscriberIndexStore, docs };
    };

    test(`${kind}: addShared is idempotent and overwrites provenance`, async () => {
      const { index } = make();
      await index.addShared(ADDRESS_B, "mtg_a", prov("first"));
      await index.addShared(ADDRESS_B, "mtg_a", prov("second"));
      expect(await index.list(ADDRESS_B)).toEqual(["mtg_a"]);
      expect(await index.shares(ADDRESS_B)).toEqual({ mtg_a: prov("second") });
      expect(await index.shares(ADDRESS_A)).toEqual({});
    });

    test(`${kind}: add and remove preserve other shares; remove deletes the id's provenance`, async () => {
      const { index } = make();
      await index.addShared(ADDRESS_B, "mtg_a", prov());
      await index.addShared(ADDRESS_B, "mtg_c", prov());
      await index.add(ADDRESS_B, "mtg_own");
      await index.remove(ADDRESS_B, "mtg_c");
      expect(await index.list(ADDRESS_B)).toEqual(["mtg_own", "mtg_a"]);
      expect(await index.shares(ADDRESS_B)).toEqual({ mtg_a: prov() });
      await index.remove(ADDRESS_B, "mtg_own");
      expect(await index.shares(ADDRESS_B)).toEqual({ mtg_a: prov() });
    });
  }

  test("kv: a legacy { ids } document still reads, with no shares, and keeps its ids on the next write", async () => {
    const { node, docs } = fakeKvNode();
    const key = `transcriber/index/${ADDRESS_B.toLowerCase()}`;
    docs.set(key, { ids: ["mtg_legacy"] });
    const index = new KvTranscriberIndexStore(node, new BackendStorageLane());
    expect(await index.list(ADDRESS_B)).toEqual(["mtg_legacy"]);
    expect(await index.shares(ADDRESS_B)).toEqual({});
    await index.addShared(ADDRESS_B, "mtg_a", prov());
    expect(docs.get(key)).toEqual({ ids: ["mtg_a", "mtg_legacy"], shared: { mtg_a: prov() } });
  });
});

describe("TC-581 shared meetings in the router", () => {
  const provenance = { ownerTenant: ADDRESS_A.toLowerCase(), ownerOccurrenceId: "owner-occ", recipientOccurrenceId: "recipient-occ",
    checkedAt: 1, title: "Team sync (B's title)", scheduledStart: "2026-09-25T12:00:00.000Z" };

  /** A's calendar capture, shared into B's index. */
  async function sharedHarness() {
    const index = new MemoryTranscriberIndexStore();
    const h = harness(ADDRESS_B, index);
    h.store.set("mtg_shared", meeting("mtg_shared", {
      status: "completed", platform: "google_meet", meeting_url: "https://meet.google.com/abc-defg-hij",
      started_at: "2026-09-25T12:00:10.000Z", ended_at: "2026-09-25T12:30:00.000Z", transcript: { status: "completed", version: 2 },
      completed_at: "2026-09-25T12:30:00.000Z", capture: { private: true },
      bot: { name: "A's bot" },
      metadata: { tinychat_address: ADDRESS_A.toLowerCase(), source: "google-calendar-autojoin", calendar_occurrence_id: "owner-occ",
        calendar_title: "A's private title", scheduled_start: "2026-09-25T12:00:00.000Z" },
    }));
    h.store.set("mtg_own", meeting("mtg_own", { metadata: { tinychat_address: ADDRESS_B.toLowerCase() } }));
    await index.add(ADDRESS_A, "mtg_shared");
    await index.addShared(ADDRESS_B, "mtg_shared", provenance);
    await index.add(ADDRESS_B, "mtg_own");
    return h;
  }

  const scrubbed = {
    id: "mtg_shared", status: "completed", platform: "google_meet", meeting_url: "https://meet.google.com/abc-defg-hij",
    created_at: "2026-08-18T10:00:00.000Z", started_at: "2026-09-25T12:00:10.000Z", ended_at: "2026-09-25T12:30:00.000Z",
    transcript: { status: "completed", version: 2 },
    metadata: { source: "google-calendar-autojoin", calendar_title: "Team sync (B's title)", scheduled_start: "2026-09-25T12:00:00.000Z", shared: true },
  };

  test("list and get return a whitelisted shared meeting with scrubbed metadata", async () => {
    const h = await sharedHarness();
    await withServer(h.app, async (base) => {
      const listed = await call(base, "/api/transcriber/meetings");
      expect(listed.status).toBe(200);
      const shared = listed.body.meetings.find((m: { id: string }) => m.id === "mtg_shared");
      expect(shared).toEqual(scrubbed);
      expect(shared.transcript.version).toBe(2);
      expect(shared).not.toHaveProperty("completed_at");
      expect(shared).not.toHaveProperty("capture");
      expect(listed.body.meetings.find((m: { id: string }) => m.id === "mtg_own").metadata).toEqual({ tinychat_address: ADDRESS_B.toLowerCase() });
      const one = await call(base, "/api/transcriber/meetings/mtg_shared");
      expect(one.status).toBe(200);
      expect(one.body).toEqual(scrubbed);
      for (const text of [listed.text, one.text]) {
        expect(text.toLowerCase()).not.toContain(ADDRESS_A.toLowerCase());
        expect(text).not.toContain("owner-occ");
        expect(text).not.toContain("A's private title");
        expect(text).not.toContain("recipient-occ");
      }
    });
  });

  test("stop on a shared meeting is 403 shared_meeting and never reaches upstream", async () => {
    const h = await sharedHarness();
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings/mtg_shared/stop", "POST");
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: "shared_meeting" });
    });
    expect(h.calls.filter(c => c.method === "stopMeeting")).toEqual([]);
  });

  test("delete on a shared meeting is 204, only removes it from this list, and leaves A's index and the recording alone", async () => {
    const h = await sharedHarness();
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings/mtg_shared", "DELETE");
      expect(r.status).toBe(204);
    });
    expect(h.calls.filter(c => c.method === "deleteMeeting")).toEqual([]);
    expect(h.store.has("mtg_shared")).toBe(true);
    expect(await h.index.list(ADDRESS_B)).toEqual(["mtg_own"]);
    expect(await h.index.shares(ADDRESS_B)).toEqual({});
    expect(await h.index.list(ADDRESS_A)).toEqual(["mtg_shared"]);
  });

  test("the shared transcript is served", async () => {
    const h = await sharedHarness();
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings/mtg_shared/transcript");
      expect(r.status).toBe(200);
      expect(r.body.text).toBe("Sam: hello");
    });
  });

  test("a shared meeting the owner deleted upstream drops out of the recipient's list and provenance", async () => {
    const h = await sharedHarness();
    h.store.delete("mtg_shared");
    await withServer(h.app, async (base) => {
      const listed = await call(base, "/api/transcriber/meetings");
      expect(listed.body.meetings.map((m: { id: string }) => m.id)).toEqual(["mtg_own"]);
    });
    expect(await h.index.shares(ADDRESS_B)).toEqual({});
  });
});

describe("TC-581 sharing flag deploy environment", () => {
  test("CALENDAR_AUTOJOIN_SHARING is declared in all four places and defaults off", () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const workflow = loadYaml(readFileSync(resolve(repoRoot, ".github/workflows/deploy-backend-phala.yml"), "utf8")) as {
      jobs?: { deploy?: { steps?: { env?: Record<string, unknown>; run?: string }[] } };
    };
    const writer = workflow.jobs?.deploy?.steps?.find(
      (s) => typeof s.run === "string" && s.run.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'),
    );
    const compose = loadYaml(readFileSync(resolve(repoRoot, "docker-compose.phala.yml"), "utf8")) as {
      services?: Record<string, { environment?: Record<string, string> }>;
    };
    const example = readFileSync(resolve(repoRoot, "backend/.env.example"), "utf8");
    expect(String(writer?.env?.CALENDAR_AUTOJOIN_SHARING)).toContain("vars.CALENDAR_AUTOJOIN_SHARING");
    expect(writer?.run).toContain('"CALENDAR_AUTOJOIN_SHARING=${CALENDAR_AUTOJOIN_SHARING:-false}"');
    expect(compose.services?.["tinychat-backend"]?.environment?.CALENDAR_AUTOJOIN_SHARING).toBe("${CALENDAR_AUTOJOIN_SHARING:-false}");
    expect(example).toContain("\nCALENDAR_AUTOJOIN_SHARING=false\n");
  });
});

describe("TC-581 review 6a: ownership fails closed", () => {
  function countingKv(doc: unknown, address = ADDRESS_B) {
    const docs = new Map<string, unknown>([[`transcriber/index/${address.toLowerCase()}`, doc]]);
    const counter = { gets: 0 };
    const node = {
      kv: {
        async get(key: string) {
          counter.gets++;
          return docs.has(key) ? { ok: true, data: structuredClone(docs.get(key)) } : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
        },
        async put(key: string, value: unknown) { docs.set(key, structuredClone(value)); return { ok: true }; },
      },
      async signIn() {},
    } as unknown as TinyCloudNode;
    return { index: new KvTranscriberIndexStore(node, new BackendStorageLane()), counter, docs };
  }
  const aMeeting = () => meeting("mtg_shared", { status: "completed", metadata: { tinychat_address: ADDRESS_A.toLowerCase(),
    source: "google-calendar-autojoin", calendar_occurrence_id: "owner-occ", calendar_title: "A's private title" } });

  test("GET /:id reads ids and shares in exactly one kv.get", async () => {
    const { index, counter } = countingKv({ ids: ["mtg_shared"], shared: { mtg_shared: { ownerTenant: "x", ownerOccurrenceId: "o",
      recipientOccurrenceId: "r", checkedAt: 1, title: "Mine", scheduledStart: "2026-09-25T12:00:00.000Z" } } });
    const h = harness(ADDRESS_B, index);
    h.store.set("mtg_shared", aMeeting());
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings/mtg_shared");
      expect(r.status).toBe(200);
      expect(r.body.metadata).toEqual({ source: "google-calendar-autojoin", calendar_title: "Mine", scheduled_start: "2026-09-25T12:00:00.000Z", shared: true });
    });
    expect(counter.gets).toBe(1);
  });

  test("a share map that is not an object makes the list unavailable, never owned", async () => {
    const { index } = countingKv({ ids: ["mtg_shared"], shared: ["mtg_shared"] });
    const h = harness(ADDRESS_B, index);
    h.store.set("mtg_shared", aMeeting());
    await withServer(h.app, async (base) => {
      expect((await call(base, "/api/transcriber/meetings")).status).toBe(503);
      expect((await call(base, "/api/transcriber/meetings/mtg_shared/stop", "POST")).status).toBe(503);
    });
    expect(h.calls.filter(c => c.method === "stopMeeting")).toEqual([]);
  });

  test("a null provenance entry still marks the id shared: scrubbed view, stop refused", async () => {
    const { index } = countingKv({ ids: ["mtg_shared"], shared: { mtg_shared: null } });
    const h = harness(ADDRESS_B, index);
    h.store.set("mtg_shared", aMeeting());
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings/mtg_shared");
      expect(r.status).toBe(200);
      expect(r.body.metadata).toEqual({ source: "google-calendar-autojoin", calendar_title: "Calendar meeting", shared: true });
      expect(r.text).not.toContain(ADDRESS_A.toLowerCase());
      expect((await call(base, "/api/transcriber/meetings/mtg_shared/stop", "POST")).status).toBe(403);
    });
    expect(h.calls.filter(c => c.method === "stopMeeting")).toEqual([]);
  });

  test("an id in this index without provenance but created by another address is never stopped or deleted upstream", async () => {
    const h = harness(ADDRESS_B);
    h.store.set("mtg_shared", aMeeting());
    await h.index.add(ADDRESS_B, "mtg_shared");
    await withServer(h.app, async (base) => {
      const stop = await call(base, "/api/transcriber/meetings/mtg_shared/stop", "POST");
      expect(stop.status).toBe(403);
      expect(stop.body).toEqual({ error: "shared_meeting" });
      expect((await call(base, "/api/transcriber/meetings/mtg_shared", "DELETE")).status).toBe(204);
    });
    expect(h.calls.filter(c => c.method === "stopMeeting" || c.method === "deleteMeeting")).toEqual([]);
    expect(h.store.has("mtg_shared")).toBe(true);
    expect(await h.index.list(ADDRESS_B)).toEqual([]);
  });
});

describe("server transcript delivery configuration", () => {
  const api = { TRANSCRIPTION_API_URL: "https://ptx.example", TRANSCRIPTION_API_KEY: "test-key" };
  test("an empty compose cohort keeps the feature dark; an explicit cohort admits only its addresses", () => {
    const dark = transcriptDeliveryConfigFromEnv({ ...api, TRANSCRIPT_SERVER_DELIVERY_ADDRESSES: "" });
    expect(dark.enabled).toBe(false);
    expect(dark.allowlist).toBeUndefined();
    const address = ADDRESS_A.toLowerCase();
    const enabled = transcriptDeliveryConfigFromEnv({
      ...api, TRANSCRIPT_SERVER_DELIVERY_ENABLED: "true",
      TRANSCRIPT_SERVER_DELIVERY_ADDRESSES: ` ${ADDRESS_A} , ${ADDRESS_B} `,
    });
    expect(enabled.allowlist?.has(address)).toBe(true);
    expect(enabled.allowlist?.has(ADDRESS_B.toLowerCase())).toBe(true);
    expect(enabled.allowlist?.has("0x0000000000000000000000000000000000000000")).toBe(false);
  });

  test("rejects a flag without ptx credentials, untrusted webhooks and invalid governor rates", () => {
    expect(() => transcriptDeliveryConfigFromEnv({ TRANSCRIPT_SERVER_DELIVERY_ENABLED: "true" })).toThrow();
    for (const [key, value] of [
      ["TRANSCRIPT_SERVER_DELIVERY_ENABLED", "yes"],
      ["TRANSCRIPT_SERVER_DELIVERY_ADDRESSES", "0x123"],
      ["TRANSCRIPTION_WEBHOOK_URL", "http://evil.example/webhook"],
      ["TRANSCRIPTION_WEBHOOK_URL", "https://user:pass@ptx.example/webhook"],
      ["TRANSCRIPTION_WEBHOOK_SECRET", "whsec_not_hex"],
      ["TRANSCRIPT_DELIVERY_SWEEP_MS", "59999"],
      ["TRANSCRIPT_DELIVERY_MAX_WRITES_PER_MIN", "0"],
    ]) {
      expect(() => transcriptDeliveryConfigFromEnv({ ...api, [key]: value })).toThrow();
    }
  });
});

describe("TC-581 shares and TC-641 creates share one index document", () => {
  const prov = { ownerTenant: ADDRESS_A.toLowerCase(), ownerOccurrenceId: "owner-occ", recipientOccurrenceId: "recipient-occ",
    checkedAt: 1, title: "Team sync", scheduledStart: "2026-09-25T12:00:00.000Z" };
  const intent = (key: string) => ({ key, hash: `hash-${key}`, createdAt: 1 });

  function kvDocs() {
    const docs = new Map<string, unknown>();
    const node = {
      kv: {
        async get(key: string) { return docs.has(key) ? { ok: true, data: structuredClone(docs.get(key)) } : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } }; },
        async put(key: string, value: unknown) { docs.set(key, structuredClone(value)); return { ok: true }; },
      },
      async signIn() {},
    } as unknown as TinyCloudNode;
    return { node, docs };
  }

  for (const kind of ["memory", "kv"] as const) {
    test(`${kind}: pending creates and shares survive each other's writes`, async () => {
      const index: TranscriberIndexStore = kind === "memory"
        ? new MemoryTranscriberIndexStore() : new KvTranscriberIndexStore(kvDocs().node, new BackendStorageLane());
      expect(await index.beginCreate(ADDRESS_B, intent("manual-v1-a"))).toEqual({ ids: [], shared: {} });
      await index.addShared(ADDRESS_B, "mtg_shared", prov);
      expect(await index.listPending(ADDRESS_B)).toEqual([intent("manual-v1-a")]);
      await index.completeCreate(ADDRESS_B, "manual-v1-a", "mtg_own");
      expect(await index.list(ADDRESS_B)).toEqual(["mtg_own", "mtg_shared"]);
      expect(await index.shares(ADDRESS_B)).toEqual({ mtg_shared: prov });
      expect(await index.listPending(ADDRESS_B)).toEqual([]);
      expect(await index.beginCreate(ADDRESS_B, intent("manual-v1-b"))).toEqual({
        ids: ["mtg_own", "mtg_shared"], shared: { mtg_shared: prov },
      });
      await index.remove(ADDRESS_B, "mtg_own");
      await index.add(ADDRESS_B, "mtg_later");
      expect(await index.listPending(ADDRESS_B)).toEqual([intent("manual-v1-b")]);
      expect(await index.entries(ADDRESS_B)).toEqual({ ids: ["mtg_later", "mtg_shared"], shared: { mtg_shared: prov } });
      await index.abandonCreate(ADDRESS_B, "manual-v1-b");
      await index.remove(ADDRESS_B, "mtg_shared");
      expect(await index.entries(ADDRESS_B)).toEqual({ ids: ["mtg_later"], shared: {} });
      expect(await index.listPending(ADDRESS_B)).toEqual([]);
    });
  }

  test("kv: a stored document with ids, shares and pending reads back whole in a fresh store", async () => {
    const { node, docs } = kvDocs();
    const key = `transcriber/index/${ADDRESS_B.toLowerCase()}`;
    const writer = new KvTranscriberIndexStore(node, new BackendStorageLane());
    await writer.beginCreate(ADDRESS_B, intent("manual-v1-a"));
    await writer.addShared(ADDRESS_B, "mtg_shared", prov);
    expect(docs.get(key)).toEqual({ ids: ["mtg_shared"], shared: { mtg_shared: prov }, pending: [intent("manual-v1-a")] });
    const reader = new KvTranscriberIndexStore(node, new BackendStorageLane());
    expect(await reader.entries(ADDRESS_B)).toEqual({ ids: ["mtg_shared"], shared: { mtg_shared: prov } });
    expect(await reader.listPending(ADDRESS_B)).toEqual([intent("manual-v1-a")]);
  });

  test("the list wakes delivery only for this session's own completed meetings, never a shared one", async () => {
    const wakes: Array<[string, string]> = [];
    const index = new MemoryTranscriberIndexStore();
    const h = harness(ADDRESS_B, index, { onObservedCompletion: async (address, id) => { wakes.push([address, id]); } });
    h.store.set("mtg_shared", meeting("mtg_shared", { status: "completed", metadata: { tinychat_address: ADDRESS_A.toLowerCase() } }));
    // A garbled share whose upstream record names the recipient is still never this session's to deliver.
    h.store.set("mtg_odd", meeting("mtg_odd", { status: "completed", metadata: { tinychat_address: ADDRESS_B.toLowerCase() } }));
    h.store.set("mtg_own", meeting("mtg_own", { status: "completed", metadata: { tinychat_address: ADDRESS_B.toLowerCase() } }));
    await index.addShared(ADDRESS_B, "mtg_shared", prov);
    await index.addShared(ADDRESS_B, "mtg_odd", prov);
    await index.add(ADDRESS_B, "mtg_own");
    await withServer(h.app, async (base) => {
      const listed = await call(base, "/api/transcriber/meetings");
      expect(listed.status).toBe(200);
      expect(listed.body.meetings.map((m: { id: string }) => m.id)).toEqual(["mtg_own", "mtg_odd", "mtg_shared"]);
    });
    expect(wakes).toEqual([[ADDRESS_B.toLowerCase(), "mtg_own"]]);
  });
});

describe("TC-907 capacity refusals and TC-641 manual-create intents", () => {
  const busy = "All 2 meeting notetakers are busy right now. Try again when one of the current meetings ends.";
  const owner = ADDRESS_A.toLowerCase();

  test("a capacity refusal of the send's only attempt ends it: busy message, intent cleared, never recovered", async () => {
    const h = harness();
    let creates = 0;
    let lookups = 0;
    h.api.createMeeting = async (_input, options) => {
      creates++; options?.onAttempt?.();
      throw new TranscriptionApiError(429, "capacity_exhausted", busy, 60_000);
    };
    const lookup = h.api.lookupMeetingByIdempotencyKey;
    h.api.lookupMeetingByIdempotencyKey = async (key) => { lookups++; return lookup(key); };
    await withServer(h.app, async (base) => {
      const sent = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/busy" });
      expect(sent.status).toBe(429);
      expect(sent.body).toEqual({ error: "capacity_exhausted", message: busy, retry_after_seconds: 60 });
      expect(await h.index.listPending(owner)).toEqual([]);
      expect((await call(base, "/api/transcriber/meetings")).body.meetings).toEqual([]);
    });
    expect({ creates, lookups }).toEqual({ creates: 1, lookups: 0 });
    expect(await h.index.list(owner)).toEqual([]);
  });

  test("busy refusals never pile up as pending intents that would block later sends", async () => {
    const h = harness();
    h.api.createMeeting = async (_input, options) => {
      options?.onAttempt?.();
      throw new TranscriptionApiError(429, "capacity_exhausted", busy, 60_000);
    };
    await withServer(h.app, async (base) => {
      for (let i = 0; i < 25; i++) {
        const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/busy" });
        expect(r.body.error).toBe("capacity_exhausted");
      }
    });
    expect(await h.index.listPending(owner)).toEqual([]);
  });

  /** The real client against a fake ptx: the first create attempt's socket closes, the retry is refused. */
  function retriedCapacityRefusal(options: { firstAttemptFails?: boolean; refusal?: { status: number; code: string } } = {}) {
    const { firstAttemptFails = true, refusal = { status: 429, code: "capacity_exhausted" } } = options;
    const posts: string[] = [];
    const committed = new Map<string, { meeting: TranscriptionMeeting; hash: string }>();
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      if (init?.method === "POST" && path === "/v1/meetings") {
        posts.push(headers.get("idempotency-key")!);
        if (firstAttemptFails && posts.length === 1) throw new TypeError("fetch failed: socket closed unexpectedly");
        return new Response(JSON.stringify({ error: { code: refusal.code, message: busy } }), { status: refusal.status, headers: { "retry-after": "60" } });
      }
      if (path === "/v1/meetings/by-idempotency-key") {
        const found = committed.get(headers.get("idempotency-key")!);
        return found
          ? Response.json({ meeting: found.meeting, request_hash: found.hash })
          : Response.json({ error: { code: "meeting_not_found", message: "Missing" } }, { status: 404 });
      }
      return Response.json({ error: { code: "unexpected" } }, { status: 500 });
    }) as typeof fetch;
    const api = createTranscriptionApiClient({ baseUrl: "https://ptx.example", apiKey: "k", fetchImpl, sleep: async () => {} });
    const index = new MemoryTranscriberIndexStore();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { address: ADDRESS_A }; next(); });
    app.use("/api/transcriber/meetings", createTranscriberRouter({ api, index }));
    return { api, index, app, posts, committed };
  }

  test("after a transport retry the intent stays for lookup-only recovery, which owns a late commit", async () => {
    const f = retriedCapacityRefusal();
    await withServer(f.app, async (base) => {
      const sent = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/late" });
      expect(sent.status).toBe(429);
      expect(sent.body.error).toBe("capacity_exhausted");
    });
    expect(f.posts).toHaveLength(2);
    const [intent] = await f.index.listPending(owner);
    expect(intent?.key).toBe(f.posts[0]!);
    // Not committed yet: recovery only looks up, inside the grace period, and keeps the intent.
    await resolvePendingCreates(owner, f.api, f.index, { now: () => intent!.createdAt + 60_000 });
    expect(await f.index.listPending(owner)).toHaveLength(1);
    // The first attempt commits late: recovery owns it rather than orphaning it.
    f.committed.set(intent!.key, { hash: intent!.hash, meeting: meeting("mtg_late", {
      status: "queued", metadata: { tinychat_address: owner } }) });
    await resolvePendingCreates(owner, f.api, f.index, { now: () => intent!.createdAt + 120_000 });
    expect(await f.index.list(owner)).toEqual(["mtg_late"]);
    expect(await f.index.listPending(owner)).toEqual([]);
    expect(f.posts).toHaveLength(2);
  });

  test("any 4xx clears the intent only when it answered the send's only attempt", async () => {
    // A timeout whose replay meets a 409 while the first attempt may still commit: keep the intent.
    const retried = retriedCapacityRefusal({ refusal: { status: 409, code: "idempotency_conflict" } });
    await withServer(retried.app, async (base) => {
      expect((await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/replay" })).status).toBe(409);
    });
    expect(retried.posts).toHaveLength(2);
    expect(await retried.index.listPending(owner)).toHaveLength(1);
    // The same 409 on a lone attempt is definitive: nothing was created, so the intent goes.
    const lone = retriedCapacityRefusal({ firstAttemptFails: false, refusal: { status: 409, code: "idempotency_conflict" } });
    await withServer(lone.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/replay" });
    });
    expect(lone.posts).toHaveLength(1);
    expect(await lone.index.listPending(owner)).toEqual([]);
  });

  test("after a transport retry with nothing committed, recovery abandons once the grace has passed", async () => {
    const f = retriedCapacityRefusal();
    await withServer(f.app, async (base) => {
      expect((await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/none" })).status).toBe(429);
    });
    const [intent] = await f.index.listPending(owner);
    await resolvePendingCreates(owner, f.api, f.index, { now: () => intent!.createdAt + 15 * 60_000 });
    expect(await f.index.listPending(owner)).toEqual([]);
    expect(await f.index.list(owner)).toEqual([]);
    expect(f.posts).toHaveLength(2);
  });
});
