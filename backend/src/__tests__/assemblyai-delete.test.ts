// AssemblyAI delete proxy (routes/assemblyai-delete.ts; contract C9). Pinned here:
//   1. exactly one upstream call, to the fixed AssemblyAI URL, with the key as `authorization`;
//   2. the upstream status → our status/code table, with fixed messages and no upstream text;
//   3. a bad id or a missing key is answered without any upstream call;
//   4. session auth, CSRF and the /api/transcriber rate-limit bucket guard the route;
//   5. neither the key nor the transcript id reaches a log line or a response.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { load as loadYaml } from "js-yaml";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";

import { createAuthMiddleware } from "../middleware/auth.js";
import { applyRateLimiters, TRANSCRIBER_LIMIT } from "../rate-limits.js";
import { ASSEMBLYAI_DELETE_ERRORS, ASSEMBLYAI_DELETE_MOUNT, createAssemblyAiDeleteRouter } from "../routes/assemblyai-delete.js";

const SESSION_KEY = "synthetic-session-signing-key";
const ADDRESS = "0xAaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAA";
const AAI_KEY = "synthetic0assemblyai0key0value0abcdef";
const TRANSCRIPT_ID = "5551722-f677-48a4-9ad5-fbb0c58fc1a8";
const UPSTREAM_DETAIL = "UPSTREAM-DETAIL transcript text and account info";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

type Upstream = { url: string; init: RequestInit };
type Answer = (init: RequestInit) => Promise<Response>;

/** The app in index.ts's order: JSON parser → CSRF → limiters → auth → router. */
async function setup(answer: Answer = async () => new Response(JSON.stringify({ id: TRANSCRIPT_ID }), { status: 200 }), timeoutMs?: number) {
  const calls: Upstream[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return answer(init!);
  }) as typeof fetch;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createCsrfMiddleware());
  applyRateLimiters(app);
  app.use(
    ASSEMBLYAI_DELETE_MOUNT,
    createAuthMiddleware(SESSION_KEY),
    createAssemblyAiDeleteRouter({ fetchImpl, log: (line) => logs.push(line), ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
  );
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  closers.push(() => new Promise((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bearer = (await issueSessionToken(ADDRESS, SESSION_KEY)).token;

  /** `null` omits a header. */
  async function del(id: string = TRANSCRIPT_ID, overrides: Record<string, string | null> = {}, auth = true) {
    const headers: Record<string, string> = {
      ...(auth ? { Authorization: `Bearer ${bearer}` } : {}),
      "X-Requested-With": "XMLHttpRequest",
      "X-AssemblyAI-Key": AAI_KEY,
    };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) delete headers[name];
      else headers[name] = value;
    }
    const response = await fetch(`${base}${ASSEMBLYAI_DELETE_MOUNT}/transcripts/${id}`, { method: "DELETE", headers });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null, headers: response.headers };
  }
  return { del, calls, logs };
}

const upstream = (status: number, headers: Record<string, string> = {}, body = JSON.stringify({ error: UPSTREAM_DETAIL })): Answer =>
  async () => new Response(body, { status, headers });
/** What api.assemblyai.com really answers for an unknown transcript id (observed 2026-10-03). */
const AAI_NOT_FOUND = JSON.stringify({ error: "Transcript lookup error, transcript id not found" });

describe("upstream call", () => {
  test("one DELETE to the fixed AssemblyAI URL with the key as a bare authorization header", async () => {
    const { del, calls } = await setup();
    const r = await del();
    expect([r.status, r.text]).toEqual([204, ""]);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.assemblyai.com/v2/transcript/${TRANSCRIPT_ID}`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.init.headers).toEqual({ authorization: AAI_KEY });
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.body).toBeUndefined();
  });
});

describe("status mapping", () => {
  // [name, upstream answer, our status, our code (null = 204)]
  const TABLE: [string, Answer, number, keyof typeof ASSEMBLYAI_DELETE_ERRORS | null][] = [
    ["200 deleted", upstream(200), 204, null],
    ["204 deleted", async () => new Response(null, { status: 204 }), 204, null],
    ["404 unknown transcript", upstream(404), 404, "assemblyai_transcript_not_found"],
    // AssemblyAI's real answer for a missing transcript is a 400, recognised by its text.
    ["400 transcript id not found", upstream(400, {}, AAI_NOT_FOUND), 404, "assemblyai_transcript_not_found"],
    ["400 not found, other casing", upstream(400, {}, AAI_NOT_FOUND.toUpperCase()), 404, "assemblyai_transcript_not_found"],
    // The fragment only counts inside the read cap: an oversized body is not read past it.
    ["400 not found beyond the 4 KiB cap", upstream(400, {}, `${" ".repeat(4096)}${AAI_NOT_FOUND}`), 502, "assemblyai_unavailable"],
    ["not-found text on a 500", upstream(500, {}, AAI_NOT_FOUND), 502, "assemblyai_unavailable"],
    // Never 401: the frontend reads 401 as "your session expired".
    ["401 bad key", upstream(401), 422, "assemblyai_key_rejected"],
    ["403 forbidden key", upstream(403), 422, "assemblyai_key_rejected"],
    ["429 rate limited", upstream(429, { "Retry-After": "30" }), 429, "assemblyai_rate_limited"],
    ["400 other client error", upstream(400), 502, "assemblyai_unavailable"],
    ["418 unexpected status", upstream(418), 502, "assemblyai_unavailable"],
    ["302 redirect, not followed", upstream(302, { Location: "https://elsewhere.example/" }), 502, "assemblyai_unavailable"],
    ["500 server error", upstream(500), 502, "assemblyai_unavailable"],
    ["503 unavailable", upstream(503), 502, "assemblyai_unavailable"],
    ["network error", async () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_DETAIL}`)), 502, "assemblyai_unavailable"],
  ];

  test.each(TABLE)("%s", async (_name, answer, status, code) => {
    const { del, logs } = await setup(answer);
    const r = await del();
    expect(r.status).toBe(status);
    expect(r.headers.get("cache-control")).toBe("no-store");
    if (code === null) {
      expect(r.text).toBe("");
    } else {
      expect(r.json).toEqual({ error: code, message: ASSEMBLYAI_DELETE_ERRORS[code].message });
    }
    expect(r.text).not.toContain("UPSTREAM-DETAIL");
    expect(logs.at(-1)).toBe(`[assemblyai-delete] route=delete status=${status}${code ? ` code=${code}` : ""}`);
  });

  test("Retry-After is relayed only when it is a number of seconds", async () => {
    expect((await (await setup(upstream(429, { "Retry-After": "30" }))).del()).headers.get("retry-after")).toBe("30");
    const date = await (await setup(upstream(429, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }))).del();
    expect([date.status, date.headers.get("retry-after")]).toEqual([429, null]);
    // Only the 429 answer carries it: a 502 never invites a retry loop.
    expect((await (await setup(upstream(503, { "Retry-After": "30" }))).del()).headers.get("retry-after")).toBeNull();
    expect((await (await setup(upstream(400, { "Retry-After": "30" }))).del()).headers.get("retry-after")).toBeNull();
  });

  test("an upstream that never answers is cut off and is assemblyai_unavailable", async () => {
    // A real (20 ms) timeout: the abort comes from the route's own AbortSignal.timeout.
    const hang: Answer = (init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
    const { del } = await setup(hang, 20);
    const r = await del();
    expect([r.status, r.json.error]).toEqual([502, "assemblyai_unavailable"]);
  });
});

describe("input validation", () => {
  test("a malformed id or a missing, empty or malformed key is invalid_request, before any upstream call", async () => {
    const { del, calls } = await setup();
    const cases: [string, Record<string, string | null>][] = [
      ["short", {}],
      ["a".repeat(65), {}],
      ["abc_defgh_123", {}],
      ["abcdefgh.json", {}],
      ["..%2F..%2Fv2%2Faccount", {}],
      [`${TRANSCRIPT_ID}%3Fx%3D1`, {}],
      [TRANSCRIPT_ID, { "X-AssemblyAI-Key": null }],
      [TRANSCRIPT_ID, { "X-AssemblyAI-Key": "" }],
      [TRANSCRIPT_ID, { "X-AssemblyAI-Key": "   " }],
      [TRANSCRIPT_ID, { "X-AssemblyAI-Key": "two words" }],
      [TRANSCRIPT_ID, { "X-AssemblyAI-Key": "k".repeat(257) }],
    ];
    for (const [id, headers] of cases) {
      const r = await del(id, headers);
      expect([id.slice(0, 20), r.status, r.json]).toEqual([id.slice(0, 20), 400, { error: "invalid_request", message: ASSEMBLYAI_DELETE_ERRORS.invalid_request.message }]);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("access", () => {
  test("no session is 401 and no X-Requested-With is 403, both before AssemblyAI is asked", async () => {
    const { del, calls } = await setup();
    expect((await del(TRANSCRIPT_ID, {}, false)).status).toBe(401);
    expect((await del(TRANSCRIPT_ID, { "X-Requested-With": null })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("the route sits in the /api/transcriber rate-limit bucket", async () => {
    const { del } = await setup();
    const r = await del();
    expect(r.headers.get("ratelimit-policy")).toContain(`${TRANSCRIBER_LIMIT};w=900`);
  });
});

describe("logs", () => {
  test("carry route, status and code only: never the key or the transcript id", async () => {
    const answers = [upstream(200), upstream(401), upstream(404), upstream(500), upstream(429, { "Retry-After": "5" })];
    const all: string[] = [];
    for (const answer of answers) {
      const { del, logs } = await setup(answer);
      await del();
      await del("short");
      all.push(...logs);
    }
    expect(all.length).toBeGreaterThanOrEqual(10);
    const text = all.join("\n");
    expect(text).not.toContain(AAI_KEY);
    expect(text).not.toContain(TRANSCRIPT_ID);
    expect(text).not.toContain("UPSTREAM-DETAIL");
    for (const line of all) expect(line).toMatch(/^\[assemblyai-delete\] route=delete status=\d{3}( code=[a-z_]+)?$/);
  });
});

describe("openapi", () => {
  test("the documented error enum and statuses are exactly the route's table", () => {
    const spec = loadYaml(readFileSync(resolve(import.meta.dir, "../../openapi.yaml"), "utf8")) as {
      paths: Record<string, { delete: { responses: Record<string, unknown> } }>;
      components: { schemas: { AssemblyAiDeleteError: { properties: { error: { enum: string[] } } } } };
    };
    expect(spec.components.schemas.AssemblyAiDeleteError.properties.error.enum.sort()).toEqual(Object.keys(ASSEMBLYAI_DELETE_ERRORS).sort());
    const responses = Object.keys(spec.paths[`${ASSEMBLYAI_DELETE_MOUNT}/transcripts/{id}`]!.delete.responses);
    for (const { status } of Object.values(ASSEMBLYAI_DELETE_ERRORS)) expect(responses).toContain(String(status));
  });
});
