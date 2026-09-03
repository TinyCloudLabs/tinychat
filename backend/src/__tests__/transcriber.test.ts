// The TRANSCRIBER surface (routes/transcriber.ts): a per-address proxy over the private
// transcription API. Rules pinned here:
//   1. the tenant is the session address — another address's meeting id is `not_found`;
//   2. a bad meeting URL is refused BEFORE upstream is called;
//   3. create records the meeting only in the private owner index, never upstream metadata;
//   4. transcript passes upstream's 202/200 through; stop and delete are owner-only;
//   5. upstream text never reaches the caller — only our own error codes;
//   6. the api client speaks the SPEC.md contract (paths, bearer, 202 handling).

import { describe, expect, test } from "bun:test";
import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { createCsrfMiddleware } from "@tinyboilerplate/server";

import * as transcriberRoutes from "../routes/transcriber.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import {
  createTranscriptionApiClient,
  isTransientTransportError,
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
    recovery: {
      eligible: false,
      code: null,
      phase: null,
      next_eligible_at: null,
      manual_remaining: null,
      automatic_enabled: false,
    },
    transcript_revision: 0,
    ...patch,
  };
}

function fakeApi() {
  const calls: { method: string; args: unknown[] }[] = [];
  const store = new Map<string, TranscriptionMeeting>();
  let nextId = 1;
  const api: TranscriptionApiClient = {
    async createMeeting(input) {
      calls.push({ method: "createMeeting", args: [input] });
      const m = meeting(`mtg_${nextId++}`, {
        meeting_url: input.meeting_url,
        bot: { name: input.bot_name ?? "" },
        metadata: input.metadata ?? {},
      });
      store.set(m.id, m);
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
    async getCapabilities() {
      calls.push({ method: "getCapabilities", args: [] });
      return { available: true, contractVersion: "space-save-v2" };
    },
    async recoverMeeting(id, idempotencyKey) {
      calls.push({ method: "recoverMeeting", args: [id, idempotencyKey] });
      const m = store.get(id);
      if (!m) throw new TranscriptionApiError(404, "not_found");
      m.status = "processing";
      return {
        httpStatus: 202 as const,
        status: "processing" as const,
        recovery: {
          disposition: "started" as const,
          phase: "queued" as const,
          next_eligible_at: null,
        },
      };
    },
  };
  return { api, calls, store };
}

function harness(
  address: string | null = ADDRESS_A,
  recovery: { enabled: boolean; ready: boolean } = { enabled: false, ready: false },
) {
  const { api, calls, store } = fakeApi();
  const index = new MemoryTranscriberIndexStore();
  const session: { address: string | null } = { address };
  const limiterCalls: string[] = [];
  const recoveryLimiter = {
    consume(rawAddress: string) {
      limiterCalls.push(rawAddress);
      return { allowed: true, correlation: "0123456789abcdef", retryAfterSeconds: null };
    },
  };
  const recoveryLogs: unknown[] = [];
  const app = express();
  const jsonParser = express.json();
  const shouldBypassRecoveryParser = (transcriberRoutes as {
    shouldBypassGlobalJsonParserForTranscriberRecovery?: (method: string, path: string) => boolean;
  }).shouldBypassGlobalJsonParserForTranscriberRecovery;
  app.use((req, res, next) => {
    if ((req.method === "POST" && /^\/api\/transcriber\/meetings\/[^/]+\/recover$/.test(req.path))
      || shouldBypassRecoveryParser?.(req.method, req.path) === true) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });
  app.use(createCsrfMiddleware());
  app.use((req, _res, next) => {
    if (session.address !== null) req.user = { address: session.address };
    next();
  });
  app.use("/api/transcriber/meetings", transcriberRoutes.createTranscriberRouter({
    api,
    index,
    recovery,
    recoveryLimiter,
    recoveryLogger: (event: unknown) => recoveryLogs.push(event),
  } as any));
  return { app, api, calls, store, index, session, limiterCalls, recoveryLimiter, recoveryLogs };
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = await new Promise<import("http").Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}

async function call(
  base: string,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
  includeCsrf = true,
) {
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(unsafe && includeCsrf ? { "X-Requested-With": "XMLHttpRequest" } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

async function malformedJsonPost(
  base: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{malformed-json",
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON parser response */
  }
  return { status: response.status, body, text };
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

  test("creates upstream without address metadata, indexes it, returns 201", async () => {
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
    expect(h.calls[0]).toEqual({
      method: "createMeeting",
      args: [
        {
          meeting_url: "https://meet.jit.si/tinycloud-demo",
          bot_name: "Notetaker",
        },
      ],
    });
    expect(await h.index.list(ADDRESS_A)).toEqual(["mtg_1"]);
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
});

describe("POST /api/transcriber/meetings/:id/recover — C2 owner proxy", () => {
  async function seedOwned(h: ReturnType<typeof harness>, id = "mtg_owned") {
    h.store.set(id, meeting(id, { status: "failed" }));
    await h.index.add(ADDRESS_A, id);
  }

  test("case and trailing-slash aliases keep malformed JSON behind CSRF, auth, and ownership", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    await withServer(h.app, async (base) => {
      for (const suffix of ["RECOVER", "recover/"]) {
        h.session.address = ADDRESS_A;
        const csrf = await malformedJsonPost(
          base,
          `/api/transcriber/meetings/mtg_owned/${suffix}`,
        );
        expect(csrf.status).toBe(403);
        expect(csrf.body?.error).toBe("csrf_rejected");
        expect(csrf.text).not.toContain("SyntaxError");

        h.session.address = null;
        const unsigned = await malformedJsonPost(
          base,
          `/api/transcriber/meetings/mtg_owned/${suffix}`,
          { "X-Requested-With": "XMLHttpRequest" },
        );
        expect(unsigned.status).toBe(401);
        expect(unsigned.text).not.toContain("SyntaxError");

        h.session.address = ADDRESS_A;
        const unowned = await malformedJsonPost(
          base,
          `/api/transcriber/meetings/mtg_missing/${suffix}`,
          { "X-Requested-With": "XMLHttpRequest" },
        );
        expect(unowned.status).toBe(404);
        expect(unowned.body).toEqual({ error: "not_found" });
        expect(unowned.text).not.toContain("SyntaxError");
      }
    });
    expect(h.calls).toEqual([]);
  });

  test("real global CSRF and session rejection happen before any route activity", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    await withServer(h.app, async (base) => {
      const missing = await call(
        base,
        "/api/transcriber/meetings/mtg_owned/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-1" },
        false,
      );
      expect(missing.status).toBe(403);
      expect(missing.body.error).toBe("csrf_rejected");
      const wrong = await call(
        base,
        "/api/transcriber/meetings/mtg_owned/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-1", "X-Requested-With": "wrong" },
        false,
      );
      expect(wrong.status).toBe(403);
      h.session.address = null;
      const unsigned = await call(
        base,
        "/api/transcriber/meetings/mtg_owned/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-1" },
      );
      expect(unsigned.status).toBe(401);
    });
    expect(h.calls).toEqual([]);
  });

  test("invalid, non-owner, and no-index identifiers return identical 404 before every upstream call", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    await withServer(h.app, async (base) => {
      for (const path of [
        "/api/transcriber/meetings/bad%20id/recover",
        "/api/transcriber/meetings/mtg_missing/recover",
      ]) {
        const r = await call(base, path, "POST", undefined, { "Idempotency-Key": "action-1" });
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ error: "not_found" });
      }
      h.session.address = ADDRESS_B;
      const other = await call(
        base,
        "/api/transcriber/meetings/mtg_owned/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-1" },
      );
      expect(other.status).toBe(404);
      expect(other.body).toEqual({ error: "not_found" });
    });
    expect(h.calls).toEqual([]);
  });

  test("owner lookup precedes strict bodyless request and action-key validation", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    await withServer(h.app, async (base) => {
      for (const [body, key] of [
        [undefined, undefined],
        [undefined, "contains space"],
        [undefined, "x".repeat(129)],
        [{}, "action-1"],
        [null, "action-1"],
        [{ kind: "manual" }, "action-1"],
        [{ project_id: "project-sentinel" }, "action-1"],
      ] as const) {
        const r = await call(
          base,
          "/api/transcriber/meetings/mtg_owned/recover",
          "POST",
          body,
          key === undefined ? {} : { "Idempotency-Key": key },
        );
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ error: "invalid_request" });
      }
    });
    expect(h.calls).toEqual([]);
  });

  test("default-off and incomplete config fail closed with zero capability or recovery calls", async () => {
    for (const recovery of [
      { enabled: false, ready: false },
      { enabled: true, ready: false },
    ]) {
      const h = harness(ADDRESS_A, recovery);
      await seedOwned(h);
      await withServer(h.app, async (base) => {
        const r = await call(
          base,
          "/api/transcriber/meetings/mtg_owned/recover",
          "POST",
          undefined,
          { "Idempotency-Key": "action-1" },
        );
        expect(r.status).toBe(503);
        expect(r.body).toEqual({ error: "transcriber_recovery_unavailable" });
      });
      expect(h.calls).toEqual([]);
    }
  });

  test("old or unavailable capability fails closed before recover", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    h.api.getCapabilities = async () => {
      h.calls.push({ method: "getCapabilities", args: [] });
      return { available: false, contractVersion: "space-save-v1" };
    };
    await withServer(h.app, async (base) => {
      const r = await call(
        base,
        "/api/transcriber/meetings/mtg_owned/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-1" },
      );
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: "transcriber_recovery_unavailable" });
    });
    expect(h.calls).toEqual([{ method: "getCapabilities", args: [] }]);
  });

  test("preserves 202 start and 200 same-key/active convergence while returning only the safe subset", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    let recoveryCalls = 0;
    h.api.recoverMeeting = async (id, key) => {
      h.calls.push({ method: "recoverMeeting", args: [id, key] });
      recoveryCalls++;
      return {
        httpStatus: recoveryCalls === 1 ? 202 : 200,
        status: "processing",
        recovery: {
          disposition: recoveryCalls === 1 ? "started" : "already_active",
          phase: recoveryCalls === 1 ? "queued" : "transcribing",
          next_eligible_at: null,
        },
      };
    };
    await withServer(h.app, async (base) => {
      const first = await call(
        base,
        "/api/transcriber/meetings/mtg_owned/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "same-action" },
      );
      expect(first.status).toBe(202);
      expect(first.body).toEqual({
        status: "processing",
        recovery: { disposition: "started", phase: "queued", next_eligible_at: null },
      });
      const replay = await call(
        base,
        "/api/transcriber/meetings/mtg_owned/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "same-action" },
      );
      expect(replay.status).toBe(200);
      expect(replay.body.recovery.disposition).toBe("already_active");
      const active = await call(
        base,
        "/api/transcriber/meetings/mtg_owned/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "different-action" },
      );
      expect(active.status).toBe(200);
      expect(active.body.recovery.disposition).toBe("already_active");
      expect(JSON.stringify([first.body, replay.body, active.body])).not.toMatch(
        /operation_id|project_id|kind|attempt|credential|provider/,
      );
    });
    expect(h.calls.map((entry) => entry.method)).toEqual([
      "getCapabilities", "recoverMeeting",
      "getCapabilities", "recoverMeeting",
      "getCapabilities", "recoverMeeting",
    ]);
    expect(h.calls.filter((entry) => entry.method === "recoverMeeting").map((entry) => entry.args[1])).toEqual([
      "same-action",
      "same-action",
      "different-action",
    ]);
  });

  test("maps bounded recovery errors and Retry-After without upstream text", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    h.api.recoverMeeting = async () => {
      throw new TranscriptionApiError(429, "recovery_cooldown", 30);
    };
    await withServer(h.app, async (base) => {
      const r = await call(
        base,
        "/api/transcriber/meetings/mtg_owned/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-1" },
      );
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ error: "recovery_cooldown" });
      expect(r.headers.get("Retry-After")).toBe("30");
      expect(r.text).not.toContain("Transcription API request failed");
    });
  });

  test("an upstream credential response emits one bounded incident signal with no hostile text", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const api = createTranscriptionApiClient({
        baseUrl: "https://url-sentinel.invalid",
        apiKey: "bearer-sentinel",
        fetchImpl: (async () => new Response(JSON.stringify({
          error: { code: "authentication_failed", message: "provider-body-sentinel" },
        }), { status: 401 })) as typeof fetch,
        sleep: async () => {},
      });
      await expect(api.recoverMeeting("meeting-sentinel", "action-sentinel")).rejects.toMatchObject({
        status: 503,
        code: null,
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([
      ["[transcriber-recovery] op=upstream-auth result=error status_class=credential"],
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(
      /url-sentinel|meeting-sentinel|bearer-sentinel|action-sentinel|provider-body-sentinel/,
    );
  });
});

describe("GET /api/transcriber/meetings/:id/transcript — C2 stale-client fence", () => {
  async function recoveryTranscriptHarness(
    meetingRevision: number,
    transcriptRevision: number,
    phase: "completed" | "queued" | "failed" | null = "completed",
  ) {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    h.store.set("mtg_recovered", meeting("mtg_recovered", {
      status: "completed",
      transcript_revision: meetingRevision,
      recovery: {
        eligible: false,
        code: null,
        phase,
        next_eligible_at: null,
        manual_remaining: 0,
        automatic_enabled: false,
      },
    }));
    await h.index.add(ADDRESS_A, "mtg_recovered");
    h.api.getTranscript = async (id) => {
      h.calls.push({ method: "getTranscript", args: [id] });
      return {
        pending: false,
        transcript: {
          meeting_id: id,
          status: "completed",
          transcript_revision: transcriptRevision,
          text: "transcript-content-sentinel",
          segments: [],
        },
      };
    };
    return h;
  }

  test("fetches transcript then matching meeting and withholds recovered content from stale clients", async () => {
    const h = await recoveryTranscriptHarness(2, 2);
    await withServer(h.app, async (base) => {
      const stale = await call(base, "/api/transcriber/meetings/mtg_recovered/transcript");
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ error: "client_upgrade_required" });
      expect(stale.text).not.toContain("transcript-content-sentinel");
    });
    expect(h.calls.map((entry) => entry.method)).toEqual(["getTranscript", "getMeeting"]);
  });

  test("positive revisions require the client contract regardless of current recovery phase", async () => {
    for (const phase of [null, "queued", "failed"] as const) {
      const h = await recoveryTranscriptHarness(1, 1, phase);
      await withServer(h.app, async (base) => {
        const response = await call(base, "/api/transcriber/meetings/mtg_recovered/transcript");
        expect({ phase, status: response.status }).toEqual({ phase, status: 409 });
        expect(response.body).toEqual({ error: "client_upgrade_required" });
        expect(response.text).not.toContain("transcript-content-sentinel");
      });
    }
  });

  test("positive revision mismatches fail closed regardless of current recovery phase", async () => {
    for (const phase of [null, "queued", "failed"] as const) {
      const h = await recoveryTranscriptHarness(2, 1, phase);
      await withServer(h.app, async (base) => {
        const response = await call(
          base,
          "/api/transcriber/meetings/mtg_recovered/transcript",
          "GET",
          undefined,
          { "X-TinyChat-Transcriber-Contract": "space-save-v2" },
        );
        expect({ phase, status: response.status }).toEqual({ phase, status: 503 });
        expect(response.body).toEqual({ error: "transcriber_unavailable" });
        expect(response.text).not.toContain("transcript-content-sentinel");
      });
    }
  });

  test("returns recovered content only with the exact contract header and equal positive revisions", async () => {
    const h = await recoveryTranscriptHarness(3, 3);
    await withServer(h.app, async (base) => {
      const accepted = await call(
        base,
        "/api/transcriber/meetings/mtg_recovered/transcript",
        "GET",
        undefined,
        { "X-TinyChat-Transcriber-Contract": "space-save-v2" },
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.transcript_revision).toBe(3);
      expect(accepted.body.text).toBe("transcript-content-sentinel");
    });
  });

  test("revision mismatch fails closed without transcript content", async () => {
    const h = await recoveryTranscriptHarness(4, 3);
    await withServer(h.app, async (base) => {
      const mismatch = await call(
        base,
        "/api/transcriber/meetings/mtg_recovered/transcript",
        "GET",
        undefined,
        { "X-TinyChat-Transcriber-Contract": "space-save-v2" },
      );
      expect(mismatch.status).toBe(503);
      expect(mismatch.body).toEqual({ error: "transcriber_unavailable" });
      expect(mismatch.text).not.toContain("transcript-content-sentinel");
    });
  });

  test("fails closed when a completed meeting omits a current transcript fence field", async () => {
    for (const missing of ["transcript_revision", "recovery"] as const) {
      const h = await recoveryTranscriptHarness(2, 2);
      delete h.store.get("mtg_recovered")![missing];
      await withServer(h.app, async (base) => {
        const response = await call(
          base,
          "/api/transcriber/meetings/mtg_recovered/transcript",
          "GET",
          undefined,
          { "X-TinyChat-Transcriber-Contract": "space-save-v2" },
        );
        expect({ missing, status: response.status }).toEqual({ missing, status: 503 });
        expect(response.text).not.toContain("transcript-content-sentinel");
      });
    }
  });
});

describe("recovery-only abuse and privacy boundary — C3", () => {
  async function seedOwned(h: ReturnType<typeof harness>, id = "meeting-sentinel") {
    h.store.set(id, meeting(id, { status: "failed" }));
    await h.index.add(ADDRESS_A, id);
  }

  test("the limiter runs only after ownership and only for recover POSTs", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings");
      await call(base, "/api/transcriber/meetings/meeting-sentinel");
      await call(base, "/api/transcriber/meetings/meeting-sentinel/stop", "POST");
      await call(base, "/api/transcriber/meetings/meeting-sentinel/transcript");

      h.session.address = ADDRESS_B;
      await call(
        base,
        "/api/transcriber/meetings/meeting-sentinel/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-sentinel" },
      );
      expect(h.limiterCalls).toEqual([]);

      h.session.address = ADDRESS_A;
      const recovered = await call(
        base,
        "/api/transcriber/meetings/meeting-sentinel/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-sentinel" },
      );
      expect(recovered.status).toBe(202);
    });
    expect(h.limiterCalls).toEqual([ADDRESS_A.toLowerCase()]);
  });

  test("a recovery limiter rejection is authored 429 and makes no capability or recover call", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    h.recoveryLimiter.consume = (address: string) => {
      h.limiterCalls.push(address);
      return { allowed: false, correlation: "0123456789abcdef", retryAfterSeconds: 17 };
    };
    await withServer(h.app, async (base) => {
      const response = await call(
        base,
        "/api/transcriber/meetings/meeting-sentinel/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-sentinel" },
      );
      expect(response.status).toBe(429);
      expect(response.body).toEqual({ error: "recovery_rate_limited" });
      expect(response.headers.get("Retry-After")).toBe("17");
    });
    expect(h.calls).toEqual([]);
  });

  test("hostile recovery failures never enter a response or structured log", async () => {
    const h = harness(ADDRESS_A, { enabled: true, ready: true });
    await seedOwned(h);
    h.api.recoverMeeting = async () => {
      throw new Error(
        "https://url-sentinel.invalid address-sentinel meeting-sentinel bearer-sentinel "
        + "action-sentinel provider-body-sentinel transcript-content-sentinel stack-sentinel",
      );
    };
    await withServer(h.app, async (base) => {
      const response = await call(
        base,
        "/api/transcriber/meetings/meeting-sentinel/recover",
        "POST",
        undefined,
        { "Idempotency-Key": "action-sentinel" },
      );
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: "transcriber_recovery_unavailable" });
      const evidence = JSON.stringify({ body: response.body, logs: h.recoveryLogs });
      expect(evidence).not.toMatch(
        /url-sentinel|address-sentinel|meeting-sentinel|bearer-sentinel|action-sentinel|provider-body-sentinel|transcript-content-sentinel|stack-sentinel/,
      );
      expect(h.recoveryLogs).toEqual([
        {
          operation: "recover",
          outcome: "error",
          statusClass: "5xx",
          errorClass: "upstream_unavailable",
          correlation: "0123456789abcdef",
        },
      ]);
    });
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

  test("rejects a meeting response whose id differs from the requested meeting", async () => {
    const api = createTranscriptionApiClient({
      baseUrl: "https://transcribe.example/",
      apiKey: "tc_live_abc",
      fetchImpl: (async () => new Response(JSON.stringify(meeting("mtg_other")))) as typeof fetch,
    });

    await expect(api.getMeeting("mtg_owned")).rejects.toMatchObject({ status: 503, code: null });
  });

  test("meeting reads require HTTP 200", async () => {
    const meetingApi = createTranscriptionApiClient({
      baseUrl: "https://transcribe.example/",
      apiKey: "tc_live_abc",
      fetchImpl: (async () => new Response(JSON.stringify(meeting("mtg_1")), { status: 201 })) as typeof fetch,
    });
    const meetingFailure = meetingApi.getMeeting("mtg_1");
    await expect(meetingFailure).rejects.toMatchObject({ status: 503, code: null });
    await expect(meetingFailure).rejects.toThrow("Transcription API request failed");
  });

  test("transcript reads require HTTP 200 or 202", async () => {
    const transcriptApi = createTranscriptionApiClient({
      baseUrl: "https://transcribe.example/",
      apiKey: "tc_live_abc",
      fetchImpl: (async () => new Response(JSON.stringify({
        meeting_id: "mtg_1",
        status: "completed",
        created_at: "2026-09-03T10:00:00.000Z",
      }), { status: 201 })) as typeof fetch,
    });
    const transcriptFailure = transcriptApi.getTranscript("mtg_1");
    await expect(transcriptFailure).rejects.toMatchObject({ status: 503, code: null });
    await expect(transcriptFailure).rejects.toThrow("Transcription API request failed");
  });
});

describe("wiring", () => {
  test("index.ts mounts /api/transcriber/meetings behind authMiddleware, gated on the env config", () => {
    const src = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    expect(src).toMatch(/app\.use\(\s*\n?\s*"\/api\/transcriber\/meetings",\s*\n?\s*authMiddleware,/);
    expect(src).toContain("transcriptionApiConfigFromEnv()");
    expect(src).toContain("shouldBypassGlobalJsonParserForTranscriberRecovery(req.method, req.path)");
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

  test("recovery deploy wiring is dark, secret-separated, documented, and digest-pinned", () => {
    const workflowText = readFileSync(
      resolve(repoRoot, ".github/workflows/deploy-backend-phala.yml"),
      "utf8",
    );
    const workflow = loadYaml(workflowText) as {
      jobs?: { deploy?: { steps?: { id?: string; name?: string; env?: Record<string, unknown>; run?: string }[] } };
    };
    const steps = workflow.jobs?.deploy?.steps ?? [];
    const writer = steps.find(
      (step) => typeof step.run === "string" && step.run.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'),
    );
    const pin = steps.find((step) => step.name === "Pin deployed image tag");
    const compose = loadYaml(readFileSync(resolve(repoRoot, "docker-compose.phala.yml"), "utf8")) as {
      services?: Record<string, { image?: string; environment?: Record<string, string> }>;
    };
    const backend = compose.services?.["tinychat-backend"] ?? {};
    const env = backend.environment ?? {};
    const example = readFileSync(resolve(repoRoot, "backend/.env.example"), "utf8");
    const deployment = readFileSync(resolve(repoRoot, "docs/deployment.md"), "utf8");
    const keys = [
      "TRANSCRIBER_RECOVERY_ENABLED",
      "TRANSCRIBER_RECOVERY_CONTRACT_VERSION",
      "TRANSCRIBER_RECOVERY_CAPABILITY_CACHE_MS",
      "TRANSCRIBER_RECOVERY_UPSTREAM_LEASE_MS",
      "TRANSCRIBER_RECOVERY_RATE_LIMIT_MAX",
      "TRANSCRIBER_RECOVERY_RATE_LIMIT_WINDOW_MS",
      "TRANSCRIBER_RECOVERY_PSEUDONYM_KEY",
      "TINYCHAT_BUILD_SHA",
      "TINYCHAT_BACKEND_IMAGE_DIGEST",
    ] as const;

    expect(writer).toBeTruthy();
    for (const key of keys) {
      expect(Object.hasOwn(writer?.env ?? {}, key)).toBe(true);
      expect(writer?.run).toContain(`"${key}=`);
      expect(String(env[key])).toContain(`\${${key}`);
      expect(example).toContain(`${key}=`);
      expect(deployment).toContain(`\`${key}\``);
    }
    expect(writer?.env?.TRANSCRIBER_RECOVERY_ENABLED).toBe("${{ vars.TRANSCRIBER_RECOVERY_ENABLED || 'false' }}");
    expect(String(env.TRANSCRIBER_RECOVERY_ENABLED)).toContain(":-false");
    expect(example).toMatch(/^TRANSCRIBER_RECOVERY_ENABLED=false$/m);
    expect(String(writer?.env?.TRANSCRIBER_RECOVERY_PSEUDONYM_KEY)).toContain(
      "secrets.TRANSCRIBER_RECOVERY_PSEUDONYM_KEY",
    );
    for (const key of keys.filter((key) => key.startsWith("TRANSCRIBER_")
      && key !== "TRANSCRIBER_RECOVERY_PSEUDONYM_KEY")) {
      expect(String(writer?.env?.[key])).toContain("vars.");
      expect(String(writer?.env?.[key])).not.toContain("secrets.");
    }
    expect(String(writer?.env?.TINYCHAT_BUILD_SHA)).toContain("github.sha");
    expect(String(writer?.env?.TINYCHAT_BACKEND_IMAGE_DIGEST)).toContain("steps.build.outputs.digest");
    expect(writer?.run).toContain("TINYCHAT_BACKEND_IMAGE=${DOCKER_IMAGE}@${TINYCHAT_BACKEND_IMAGE_DIGEST}");
    expect(pin?.run).toContain("${DOCKER_IMAGE}@${{ steps.build.outputs.digest }}");
    expect(String(backend.image)).toContain("TINYCHAT_BACKEND_IMAGE");
    expect(workflowText).toContain("steps.build.outputs.digest");
    expect(deployment).toContain("strictly shorter than the upstream capability lease");
    expect(deployment).toContain("bounded positive upstream capability lease in milliseconds");
    expect(deployment).not.toContain("upstream operation lease");
  });
});

describe("transcription api client — transient upstream blips", () => {
  test("recognizes a nested Undici socket code as transient transport evidence", () => {
    const error = Object.assign(new TypeError("body unavailable"), {
      cause: { code: "UND_ERR_SOCKET" },
    });

    expect(isTransientTransportError(error)).toBe(true);
  });

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

describe("transcription api client — recovery C1 contract", () => {
  const supportedCodes = [
    "provider_timeout",
    "provider_unavailable",
    "finalizer_interrupted",
    "recording_fetch_transient",
  ];

  const capability = (patch: Record<string, unknown> = {}) => ({
    recovery: {
      contract_version: "space-save-v2",
      manual_available: true,
      automatic_available: false,
      supported_error_codes: supportedCodes,
      ...patch,
    },
  });

  const recovered = (patch: Record<string, unknown> = {}) => ({
    id: "mtg_recovery_1",
    status: "processing",
    recovery: {
      operation_id: "rcv_operation_1",
      disposition: "started",
      kind: "manual",
      phase: "queued",
      attempt: 1,
      max_attempts: 1,
      next_eligible_at: null,
      ...patch,
    },
  });

  function clientWith(
    fetchImpl: typeof fetch,
    extra: Record<string, unknown> = {},
  ): TranscriptionApiClient & {
    getCapabilities(): Promise<{ available: boolean; contractVersion: string | null }>;
    recoverMeeting(id: string, key: string): Promise<{
      httpStatus: 200 | 202;
      status: string;
      recovery: { disposition: string; phase: string | null; next_eligible_at: string | null };
    }>;
  } {
    const api = createTranscriptionApiClient({
      baseUrl: "https://transcribe.example/",
      apiKey: "credential-sentinel",
      fetchImpl,
      sleep: async () => {},
      recoveryContractVersion: "space-save-v2",
      recoveryCapabilityCacheMs: 1_000,
      ...extra,
    } as any);
    expect(typeof (api as any).getCapabilities).toBe("function");
    expect(typeof (api as any).recoverMeeting).toBe("function");
    return api as ReturnType<typeof clientWith>;
  }

  test("treats missing legacy capability as unavailable, caches it, and refetches after expiry", async () => {
    let now = 10_000;
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify(calls === 1 ? {} : capability()));
    }) as typeof fetch;
    const api = clientWith(fetchImpl, { now: () => now });

    expect(await api.getCapabilities()).toEqual({ available: false, contractVersion: null });
    expect(await api.getCapabilities()).toEqual({ available: false, contractVersion: null });
    expect(calls).toBe(1);
    now += 1_001;
    expect(await api.getCapabilities()).toEqual({ available: true, contractVersion: "space-save-v2" });
    expect(calls).toBe(2);
  });

  test("fails closed for old versions or reordered codes and rejects malformed present capability", async () => {
    for (const body of [
      capability({ contract_version: "space-save-v1" }),
      capability({ supported_error_codes: [...supportedCodes].reverse() }),
      capability({ automatic_available: true }),
    ]) {
      const api = clientWith((async () => new Response(JSON.stringify(body))) as typeof fetch);
      expect((await api.getCapabilities()).available).toBe(false);
    }

    const malformed = clientWith((async () => new Response(JSON.stringify(capability({
      manual_available: "true",
    })))) as typeof fetch);
    await expect(malformed.getCapabilities()).rejects.toMatchObject({ status: 503, code: null });
  });

  test("accepts capability negotiation only from HTTP 200", async () => {
    const api = clientWith((async () => new Response(JSON.stringify(capability()), { status: 202 })) as typeof fetch);

    await expect(api.getCapabilities()).rejects.toMatchObject({ status: 503, code: null });
  });

  test("sends bodyless capabilities and exact encoded manual recover request, returning the safe contract", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/v1/capabilities")) return new Response(JSON.stringify(capability()));
      return new Response(JSON.stringify({
        ...recovered(),
        id: "mtg/slash",
      }), { status: 202 });
    }) as typeof fetch;
    const api = clientWith(fetchImpl);

    expect(await api.getCapabilities()).toEqual({ available: true, contractVersion: "space-save-v2" });
    expect(await api.recoverMeeting("mtg/slash", "action-key-1")).toEqual({
      httpStatus: 202,
      status: "processing",
      recovery: { disposition: "started", phase: "queued", next_eligible_at: null },
    });
    expect(seen.map(({ url, init }) => ({
      url,
      method: init.method,
      body: init.body,
      key: (init.headers as Record<string, string>)["Idempotency-Key"],
    }))).toEqual([
      {
        url: "https://transcribe.example/v1/capabilities",
        method: "GET",
        body: undefined,
        key: undefined,
      },
      {
        url: "https://transcribe.example/v1/meetings/mtg%2Fslash/recover",
        method: "POST",
        body: JSON.stringify({ kind: "manual" }),
        key: "action-key-1",
      },
    ]);
  });

  test("validates the browser action key before transport", async () => {
    let calls = 0;
    const api = clientWith((async () => {
      calls++;
      return new Response(JSON.stringify(recovered()), { status: 202 });
    }) as typeof fetch);
    for (const key of ["", "contains space", "line\nbreak", "x".repeat(129), "é"]) {
      await expect(api.recoverMeeting("mtg_1", key)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    expect(calls).toBe(0);
  });

  test("replays one transport failure with byte-identical request and the same caller key", async () => {
    const traces: { url: string; method: string | undefined; body: BodyInit | null | undefined; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      traces.push({
        url: String(url),
        method: init?.method,
        body: init?.body,
        headers: init?.headers as Record<string, string>,
      });
      if (traces.length === 1) throw new Error("socket closed unexpectedly stack-sentinel");
      return new Response(JSON.stringify({ ...recovered(), id: "mtg_1" }), { status: 202 });
    }) as typeof fetch;
    const api = clientWith(fetchImpl);

    await expect(api.recoverMeeting("mtg_1", "same-action-key")).resolves.toMatchObject({ httpStatus: 202 });
    expect(traces).toHaveLength(2);
    expect(traces[1]).toEqual(traces[0]);
    expect(traces.map((trace) => trace.headers["Idempotency-Key"])).toEqual([
      "same-action-key",
      "same-action-key",
    ]);

    let failedCalls = 0;
    const dead = clientWith((async () => {
      failedCalls++;
      throw new Error("ECONNRESET stack-sentinel");
    }) as unknown as typeof fetch);
    const failure = dead.recoverMeeting("mtg_1", "same-action-key");
    await expect(failure).rejects.toMatchObject({ status: 503, code: null });
    await expect(failure).rejects.not.toThrow(/stack-sentinel|ECONNRESET/);
    expect(failedCalls).toBe(2);
  });

  test("replays a transient recovery response-body failure with the same request", async () => {
    const traces: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      traces.push({ url: String(url), init: init ?? {} });
      if (traces.length === 1) {
        const response = new Response(JSON.stringify({ ...recovered(), id: "mtg_1" }), { status: 202 });
        Object.defineProperty(response, "text", {
          value: async () => {
            throw Object.assign(new Error("response body read ECONNRESET sentinel"), { code: "ECONNRESET" });
          },
        });
        return response;
      }
      return new Response(JSON.stringify({ ...recovered(), id: "mtg_1" }), { status: 202 });
    }) as typeof fetch;
    const api = clientWith(fetchImpl);

    await expect(api.recoverMeeting("mtg_1", "same-action-key")).resolves.toMatchObject({ httpStatus: 202 });
    expect(traces).toHaveLength(2);
    expect(traces[1]).toEqual(traces[0]);
  });

  test("replays a terminated recovery body read with its nested socket cause", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        const response = new Response(JSON.stringify({ ...recovered(), id: "mtg_1" }), { status: 202 });
        Object.defineProperty(response, "text", {
          value: async () => {
            throw Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } });
          },
        });
        return response;
      }
      return new Response(JSON.stringify({ ...recovered(), id: "mtg_1" }), { status: 202 });
    }) as typeof fetch;
    const api = clientWith(fetchImpl);

    await expect(api.recoverMeeting("mtg_1", "same-action-key")).resolves.toMatchObject({ httpStatus: 202 });
    expect(calls).toBe(2);
  });

  test("rejects a newly-started 202 that reports terminal state", async () => {
    const api = clientWith((async () => new Response(JSON.stringify({
      ...recovered({ phase: "completed" }),
      id: "mtg_1",
      status: "completed",
    }), { status: 202 })) as typeof fetch);

    await expect(api.recoverMeeting("mtg_1", "same-action-key")).rejects.toMatchObject({ status: 503, code: null });
  });

  test("rejects extra top-level recovery response fields without reflecting them", async () => {
    const api = clientWith((async () => new Response(JSON.stringify({
      ...recovered(),
      project_id: "project-sentinel",
      credential: "credential-sentinel",
    }), { status: 202 })) as typeof fetch);

    const failure = api.recoverMeeting("mtg_recovery_1", "key-1");
    await expect(failure).rejects.toMatchObject({ status: 503, code: null });
    await expect(failure).rejects.not.toThrow(/project-sentinel|credential-sentinel/);
  });

  test("strictly accepts valid 200/202 recovery shapes and rejects malformed or extra recovery fields", async () => {
    for (const [status, body] of [
      [202, recovered()],
      [200, recovered({ disposition: "already_active", phase: "transcribing" })],
      [200, { ...recovered({ phase: "completed" }), status: "completed" }],
      [200, {
        ...recovered({
          operation_id: null,
          disposition: "already_completed",
          phase: null,
          attempt: null,
          max_attempts: null,
          next_eligible_at: null,
        }),
        status: "completed",
      }],
    ] as const) {
      const api = clientWith((async () => new Response(JSON.stringify(body), { status })) as typeof fetch);
      await expect(api.recoverMeeting("mtg_recovery_1", "key-1")).resolves.toMatchObject({ httpStatus: status });
    }

    for (const body of [
      recovered({ disposition: "new_disposition" }),
      recovered({ phase: "new_phase" }),
      recovered({ next_eligible_at: "tomorrow" }),
      recovered({ unexpected: "field" }),
      { ...recovered(), status: "queued" },
      { ...recovered(), id: "mtg_other" },
      recovered({ disposition: "already_active", phase: "transcribing" }),
      recovered({ operation_id: null, attempt: 1, max_attempts: 1 }),
      recovered({ phase: null, attempt: null, max_attempts: null }),
    ]) {
      const api = clientWith((async () => new Response(JSON.stringify(body), { status: 202 })) as typeof fetch);
      await expect(api.recoverMeeting("mtg_recovery_1", "key-1")).rejects.toMatchObject({ status: 503, code: null });
    }
  });

  test("maps every recovery HTTP row without reflecting upstream body text", async () => {
    const bodySentinel = "provider-body-sentinel";
    const cases: [number, string, number, string | null][] = [
      [400, "anything", 400, "invalid_request"],
      [422, "anything", 400, "invalid_request"],
      [404, "anything", 404, "not_found"],
      [409, "idempotency_conflict", 409, "idempotency_conflict"],
      [409, "unknown", 503, null],
      [410, "recording_absent", 410, "recording_absent"],
      [410, "unknown", 503, null],
      [429, "recovery_cooldown", 429, "recovery_cooldown"],
      [429, "budget_exhausted", 429, "budget_exhausted"],
      [429, "unknown", 503, null],
      [401, "authentication_failed", 503, null],
      [403, "authorization_failed", 503, null],
      [500, "provider_unavailable", 503, null],
    ];
    for (const [upstreamStatus, upstreamCode, status, code] of cases) {
      const api = clientWith((async () => new Response(JSON.stringify({
        error: { code: upstreamCode, message: bodySentinel, stack: "stack-sentinel" },
      }), { status: upstreamStatus })) as typeof fetch);
      const failure = api.recoverMeeting("mtg_1", "key-1");
      await expect(failure).rejects.toMatchObject({ status, code });
      await expect(failure).rejects.not.toThrow(/provider-body-sentinel|stack-sentinel/);
    }
  });

  test("forwards only bounded whole-second Retry-After on allowlisted 429 responses", async () => {
    for (const [raw, expected] of [
      ["1", 1],
      ["86400", 86_400],
      ["0", null],
      ["86401", null],
      ["1.5", null],
      ["tomorrow", null],
    ] as const) {
      const api = clientWith((async () => new Response(JSON.stringify({
        error: { code: "recovery_cooldown", message: "body-sentinel" },
      }), { status: 429, headers: { "Retry-After": raw } })) as typeof fetch);
      await expect(api.recoverMeeting("mtg_1", "key-1")).rejects.toMatchObject({
        status: 429,
        code: "recovery_cooldown",
        retryAfterSeconds: expected,
      });
    }
  });

  test("strictly decodes optional meeting recovery/revision and drops unknown fields and error messages", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      ...meeting("mtg_1", { status: "failed" }),
      recovery: {
        eligible: true,
        code: "provider_timeout",
        phase: "failed",
        next_eligible_at: "2026-09-02T10:00:00.000Z",
        manual_remaining: 1,
        automatic_enabled: false,
      },
      transcript_revision: 2,
      operation_id: "operation-sentinel",
      project_id: "project-sentinel",
      error: { type: "provider", code: "provider_timeout", message: "provider-body-sentinel" },
    }))) as typeof fetch;
    const api = clientWith(fetchImpl);
    const value = await api.getMeeting("mtg_1");
    expect(value.recovery?.eligible).toBe(true);
    expect(value.transcript_revision).toBe(2);
    expect(JSON.stringify(value)).not.toMatch(/operation-sentinel|project-sentinel|provider-body-sentinel/);

    const malformed = clientWith((async () => new Response(JSON.stringify({
      ...meeting("mtg_1"),
      recovery: { eligible: "true" },
    }))) as typeof fetch);
    await expect(malformed.getMeeting("mtg_1")).rejects.toMatchObject({ status: 503, code: null });
  });

  test("rejects calendar-invalid and non-contract timestamps across meeting, transcript, and recovery", async () => {
    const invalidCalendar = "2026-02-31T00:00:00.000Z";
    const missingMilliseconds = "2026-09-03T10:00:00Z";
    const meetingBodies = [
      meeting("mtg_1", { created_at: invalidCalendar }),
      meeting("mtg_1", { started_at: missingMilliseconds }),
      meeting("mtg_1", { ended_at: invalidCalendar }),
      meeting("mtg_1", { bot: { name: "Bot", joined_at: missingMilliseconds } }),
      meeting("mtg_1", {
        recovery: {
          eligible: false,
          code: null,
          phase: null,
          next_eligible_at: invalidCalendar,
          manual_remaining: null,
          automatic_enabled: false,
        },
      }),
    ];
    const operations: Array<() => Promise<unknown>> = meetingBodies.map((body) => () =>
      clientWith((async () => new Response(JSON.stringify(body))) as typeof fetch).getMeeting("mtg_1"));
    operations.push(
      () => clientWith((async () => new Response(JSON.stringify({
        meeting_id: "mtg_1",
        status: "completed",
        created_at: invalidCalendar,
      }))) as typeof fetch).getTranscript("mtg_1"),
      () => clientWith((async () => new Response(JSON.stringify({
        ...recovered({
          operation_id: null,
          disposition: "already_completed",
          phase: null,
          attempt: null,
          max_attempts: null,
          next_eligible_at: missingMilliseconds,
        }),
        status: "completed",
      }), { status: 200 })) as typeof fetch).recoverMeeting("mtg_recovery_1", "key-1"),
    );

    const results = await Promise.allSettled(operations.map((operation) => operation()));
    expect(results.map((result) => result.status)).toEqual(Array(results.length).fill("rejected"));
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ status: 503, code: null });
        expect(String(result.reason)).not.toMatch(/2026-02-31|2026-09-03/);
      }
    }
  });
});
