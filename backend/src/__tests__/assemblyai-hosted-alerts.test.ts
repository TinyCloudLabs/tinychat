// TC-2131: what operators see when AssemblyAI refuses the hosted path (routes/assemblyai-hosted.ts submit,
// services/assemblyai-hosted-monitor.ts, routes/assemblyai-status.ts). Pinned here:
//   1. refusals are classified from status AND body (insufficient funds is a 400 with a balance message;
//      403 is the HTTP rate limit unless it speaks of the credential; any other 400 is request_rejected);
//   2. the four events: provider_blocked (first of a spell), provider_recovered, jobs_failed_in_a_row, heartbeat;
//   3. the status route: gated like the credential count, its own buckets, exact shape, no leakage;
//   4. nothing AssemblyAI sends reaches the caller, the logs, the events or the status.

import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import express from "express";
import { issueSessionToken } from "@tinyboilerplate/server";

// Never touch a real home; every temp path is recorded for exact cleanup.
const tmp = mkdtempSync("/var/tmp/TC-2131.");
appendFileSync("/var/tmp/tc-2131-mktemp-list.txt", `${tmp}\n`);
const savedHome = process.env.HOME;
const savedCache = process.env.BUN_INSTALL_CACHE_DIR;
process.env.HOME = tmp;
process.env.BUN_INSTALL_CACHE_DIR = tmp;
if (!process.env.HOME.startsWith("/var/tmp/TC-2131.")) throw new Error("unsafe HOME");
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedCache === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
  else process.env.BUN_INSTALL_CACHE_DIR = savedCache;
  rmSync(tmp, { recursive: true, force: true });
});

import { createAuthMiddleware } from "../middleware/auth.js";
import {
  ASSEMBLYAI_STATUS_FAILURE_LIMIT,
  ASSEMBLYAI_STATUS_SUCCESS_LIMIT,
  CREDENTIAL_COUNT_PATHS,
  bucketFor,
} from "../rate-limits.js";
import { ASSEMBLYAI_HOSTED_MOUNT, createAssemblyAiHostedRouter, isHostedPartPath } from "../routes/assemblyai-hosted.js";
import { ASSEMBLYAI_STATUS_ROUTE_PATH, createAssemblyAiStatusRouter } from "../routes/assemblyai-status.js";
import {
  DEFAULT_DAILY_BYTES,
  HOSTED_PART_SIZE,
  HostedUploadStore,
  SUBMIT_DEADLINE_MS,
  type AssemblyAiHostedConfig,
} from "../services/assemblyai-hosted.js";
import { FAILED_IN_A_ROW, HostedProviderMonitor, classifyProviderRefusal } from "../services/assemblyai-hosted-monitor.js";

const SESSION_KEY = "synthetic-session-signing-key";
const API_KEY = "synthetic0assemblyai0server0key0abcdef";
const HANDLE_KEY = "Zk3Jm8V0t6n0bqK1i2Xz7cP4sWf9YhR5uLd2eA8gT1kM=";
const ADDRESS_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRANSCRIPT_ID = "6ca36708-a9e5-4195-b97c-2dbd098babbf";
const UPLOAD_URL = "https://cdn.assemblyai.com/upload/synthetic-upload-ref";
const UPSTREAM_DETAIL = "UPSTREAM-DETAIL account and audio info";
const BALANCE_BODY = { error: "Your current account balance is negative. Please top up to continue using the API." };
const T0 = Date.parse("2026-10-26T12:00:00Z");
const ADMIN_KEY = "synthetic-admin-key-0123456789ab";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

type Call = { method: string; url: string; signal: AbortSignal | null };
type Answer = (call: Call) => Response | Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const healthy: Answer = (call) => {
  if (call.url.endsWith("/v2/upload")) return json(200, { upload_url: UPLOAD_URL });
  return json(200, { id: TRANSCRIPT_ID, status: "queued", audio_url: UPLOAD_URL });
};
/** Healthy except for the one call (`/v2/upload` or `/v2/transcript`) that answers `refusal`. */
const refusing = (path: "/v2/upload" | "/v2/transcript", refusal: () => Response | Promise<Response>): Answer => (call) =>
  call.url.endsWith(path) ? refusal() : healthy(call);

function audio(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

async function setup(answer: Answer = healthy) {
  const spoolDir = mkdtempSync(join(tmp, "spool-"));
  const config: AssemblyAiHostedConfig = { hosted: true, apiKey: API_KEY, handleKey: HANDLE_KEY, dailyBytes: DEFAULT_DAILY_BYTES, spoolDir };
  const identity = new Map<string, unknown>();
  const store = new HostedUploadStore(spoolDir, DEFAULT_DAILY_BYTES, 4, undefined, undefined, undefined, {
    get: async <T>(key: string): Promise<T | null> => (identity.get(key) as T | undefined) ?? null,
    putIfAbsent: async (key: string, value: unknown) => (identity.has(key) ? false : (identity.set(key, value), true)),
  }, "test-install-id");
  await store.init();
  closers.push(() => store.close());
  const clock = { now: T0 };
  const events: Record<string, unknown>[] = [];
  const logs: { line: string; alert: boolean }[] = [];
  const monitor = new HostedProviderMonitor((event) => events.push(event), () => clock.now);
  monitor.attach(store);
  let current = answer;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => current({ method: String(init?.method), url: String(url), signal: init?.signal ?? null })) as typeof fetch;
  const app = express();
  const jsonParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => (isHostedPartPath(req.path) ? next() : jsonParser(req, res, next)));
  app.use(ASSEMBLYAI_HOSTED_MOUNT, createAuthMiddleware(SESSION_KEY),
    createAssemblyAiHostedRouter({ config, store, fetchImpl, now: () => clock.now, log: (line, alert) => logs.push({ line, alert }), monitor }));
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}${ASSEMBLYAI_HOSTED_MOUNT}`;
  const token = (await issueSessionToken(ADDRESS_A, SESSION_KEY)).token;

  async function req(method: string, path: string, body?: unknown, raw?: Uint8Array) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (raw) headers["Content-Type"] = "application/octet-stream";
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${path}`, { method, headers, ...(raw ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  }

  /** Create, PUT every part, POST the submit, let the background settle, return the polled upload view. */
  async function run(bytes = 50) {
    const data = audio(bytes);
    const created = await req("POST", "/hosted/uploads", { byte_size: bytes, content_type: "audio/mp4" });
    expect(created.status).toBe(201);
    const id = created.json.upload_id as string;
    for (let i = 0; i * HOSTED_PART_SIZE < bytes; i++) {
      expect((await req("PUT", `/hosted/uploads/${id}/parts/${i}`, undefined, data.subarray(i * HOSTED_PART_SIZE, (i + 1) * HOSTED_PART_SIZE))).status).toBe(204);
    }
    expect((await req("POST", "/hosted/transcripts", { upload_id: id, speaker_labels: true })).status).toBe(202);
    await store.idle();
    return (await req("GET", `/hosted/uploads/${id}`)).json;
  }

  return { req, run, store, monitor, events, logs, clock, spoolDir, answer: (next: Answer) => { current = next; },
    spoolFiles: () => readdirSync(spoolDir).filter((name) => name.endsWith(".part")) };
}

describe("refusal classification", () => {
  const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  test.each([
    ["insufficient funds, as AssemblyAI documents it: 400 + balance message", 400, BALANCE_BODY, "billing_blocked"],
    ["a 402, harmlessly", 402, {}, "billing_blocked"],
    ["401 key rejected on the upload route", 401, { error: "Invalid API key" }, "key_rejected"],
    ["401 key rejected on the transcript route", 401, { error: "Authentication error, API token missing/invalid" }, "key_rejected"],
    ["403 about the credential", 403, { error: "Authentication error, API token missing/invalid." }, "key_rejected"],
    ["403 with no explanation is the safer page", 403, null, "key_rejected"],
    ["403 that is AssemblyAI's HTTP rate limit", 403, { error: "Rate limit exceeded: too many requests" }, "rate_limited"],
    ["429", 429, {}, "rate_limited"],
    ["any other 400 is not a refusal", 400, { error: "Transcript creation error, audio_url not found" }, null],
    ["a 500 is not a refusal", 500, { error: UPSTREAM_DETAIL }, null],
  ] as const)("%s", (_name, status, answer, expected) => {
    expect(classifyProviderRefusal(status, answer === null ? null : body(answer))).toBe(expected);
  });
});

describe("submit refusals are alerted with a coded reason and the upstream status", () => {
  // [name, which call refuses, answer, event reason, upstream status, text-log alert, outcome code]
  const REFUSALS = [
    ["balance 400 on the upload", "/v2/upload", () => json(400, BALANCE_BODY), "billing_blocked", 400, true, "assemblyai_unavailable"],
    ["balance 400 on the create", "/v2/transcript", () => json(400, BALANCE_BODY), "billing_blocked", 400, true, "assemblyai_unavailable"],
    ["402 on the create", "/v2/transcript", () => json(402, { error: UPSTREAM_DETAIL }), "billing_blocked", 402, true, "assemblyai_unavailable"],
    ["401 on the upload", "/v2/upload", () => json(401, { error: UPSTREAM_DETAIL }), "key_rejected", 401, true, "assemblyai_unavailable"],
    ["bodiless 403 on the create", "/v2/transcript", () => new Response(null, { status: 403 }), "key_rejected", 403, true, "assemblyai_unavailable"],
    ["403 rate limit on the upload", "/v2/upload", () => json(403, { error: "Too many requests, rate limit exceeded" }), "rate_limited", 403, false, "assemblyai_rate_limited"],
    ["429 on the create", "/v2/transcript", () => json(429, { error: UPSTREAM_DETAIL }, { "Retry-After": "17" }), "rate_limited", 429, false, "assemblyai_rate_limited"],
  ] as const;

  test.each(REFUSALS)("%s", async (_name, path, refusal, reason, status, alert, code) => {
    const h = await setup(refusing(path, refusal));
    const outcome = await h.run();
    expect(outcome).toMatchObject({ status: "failed", error: { code } });
    expect(h.events).toEqual([{ event: "assemblyai_provider_blocked", reason, http_status: status, delayed_jobs: 0, alert: true }]);
    const submitLog = h.logs.find((l) => l.line.includes("route=submit"))!;
    expect(submitLog.line).toContain(`upstream_status=${status}`);
    expect(submitLog.alert).toBe(alert);
    expect(submitLog.line.includes("alert=true")).toBe(alert);
    if (alert) expect(submitLog.line).toContain(`reason=${reason}`);
    expect(h.monitor.status()).toMatchObject({ provider_state: "blocked", blocked_reason: reason, blocked_http_status: status });
    // Never AssemblyAI's text or our key, in any answer, log line or event.
    const everything = JSON.stringify([outcome, h.logs, h.events, h.monitor.status()]);
    expect(everything).not.toContain("UPSTREAM-DETAIL");
    expect(everything).not.toContain("balance is negative");
    expect(everything).not.toContain(API_KEY);
    expect(h.spoolFiles()).toEqual([]);
  });

  test("any other 400 is alerted as request_rejected (create: create_rejected) and never as blocked", async () => {
    for (const [path, reason] of [["/v2/upload", "request_rejected"], ["/v2/transcript", "create_rejected"]] as const) {
      const h = await setup(refusing(path, () => json(400, { error: UPSTREAM_DETAIL })));
      expect(await h.run()).toMatchObject({ status: "failed" });
      const submitLog = h.logs.find((l) => l.line.includes("route=submit"))!;
      expect([submitLog.alert, submitLog.line.includes(`upstream_status=400 reason=${reason}`)]).toEqual([true, true]);
      expect(h.events).toEqual([]);
      expect(h.monitor.status()).toMatchObject({ provider_state: "healthy", blocked_reason: null, consecutive_failed_jobs: 1 });
    }
  });

  test("a spell alerts once: the next refusal with the same reason is silent, a different reason alerts again", async () => {
    const h = await setup(refusing("/v2/upload", () => json(400, BALANCE_BODY)));
    await h.run();
    await h.run();
    expect(h.events.filter((e) => e.event === "assemblyai_provider_blocked")).toHaveLength(1);
    h.answer(refusing("/v2/upload", () => json(401, {})));
    await h.run();
    expect(h.events.filter((e) => e.event === "assemblyai_provider_blocked").map((e) => e.reason)).toEqual(["billing_blocked", "key_rejected"]);
    expect(h.monitor.status()).toMatchObject({ blocked_reason: "key_rejected", blocked_http_status: 401 });
  });

  test("the first success after a spell is the recovery: the event once, the state clears, the next success is silent", async () => {
    const h = await setup(refusing("/v2/upload", () => json(400, BALANCE_BODY)));
    await h.run();
    h.clock.now = T0 + 90_000;
    h.answer(healthy);
    expect((await h.run()).status).toBe("submitted");
    expect(h.events.map((e) => e.event)).toEqual(["assemblyai_provider_blocked", "assemblyai_provider_recovered"]);
    expect(h.events[1]).toEqual({ event: "assemblyai_provider_recovered", delayed_jobs: 0 });
    expect(h.monitor.status()).toMatchObject({ provider_state: "healthy", blocked_reason: null, blocked_http_status: null, blocked_since: null, consecutive_failed_jobs: 0 });
    expect((await h.run()).status).toBe("submitted");
    expect(h.events).toHaveLength(2);
  });

  test("blocked_since stays at the first refusal of the spell while last_error_at follows the latest", async () => {
    const h = await setup(refusing("/v2/upload", () => json(400, BALANCE_BODY)));
    await h.run();
    h.clock.now = T0 + 600_000;
    await h.run();
    expect(h.monitor.status()).toMatchObject({ blocked_since: new Date(T0).toISOString(), last_error_at: new Date(T0 + 600_000).toISOString() });
  });
});

describe("jobs failing in a row", () => {
  const serverError = refusing("/v2/upload", () => json(500, { error: UPSTREAM_DETAIL }));

  test(`${FAILED_IN_A_ROW} terminal failures page once; a success resets the count`, async () => {
    const h = await setup(serverError);
    for (let i = 1; i <= FAILED_IN_A_ROW + 1; i++) {
      await h.run();
      expect(h.monitor.status().consecutive_failed_jobs).toBe(i);
    }
    expect(h.events).toEqual([{ event: "assemblyai_jobs_failed_in_a_row", count: FAILED_IN_A_ROW, alert: true }]);
    h.answer(healthy);
    await h.run();
    expect(h.monitor.status().consecutive_failed_jobs).toBe(0);
    h.answer(serverError);
    for (let i = 0; i < FAILED_IN_A_ROW; i++) await h.run();
    expect(h.events.filter((e) => e.event === "assemblyai_jobs_failed_in_a_row")).toHaveLength(2);
  });

  test("a job aborted by the sweep deadline or a shutdown is not AssemblyAI failing jobs", async () => {
    const hangsUntilAborted = (call: Call) => new Promise<Response>((_resolve, reject) => call.signal!.addEventListener("abort", () => reject(call.signal!.reason)));
    const h = await setup((call) => (call.url.endsWith("/v2/upload") ? hangsUntilAborted(call) : healthy(call)));
    const created = await h.req("POST", "/hosted/uploads", { byte_size: 50, content_type: "audio/mp4" });
    const id = created.json.upload_id as string;
    await h.req("PUT", `/hosted/uploads/${id}/parts/0`, undefined, audio(50));
    await h.req("POST", "/hosted/transcripts", { upload_id: id, speaker_labels: true });
    // The hanging fetch never answers, so the abort is the only way out: it surfaces as a transport failure.
    h.clock.now = T0 + SUBMIT_DEADLINE_MS;
    await h.store.sweep(h.clock.now);
    await h.store.idle();
    // The job did fail, so it is the latest error, but it is not part of the streak and pages nobody.
    expect(h.monitor.status()).toMatchObject({ consecutive_failed_jobs: 0, last_error_at: new Date(T0 + SUBMIT_DEADLINE_MS).toISOString() });
    expect(h.events).toEqual([]);
  });

  test("last_error_at follows every failed job, blocked or not", async () => {
    const h = await setup(serverError);
    expect(h.monitor.status().last_error_at).toBeNull();
    await h.run();
    expect(h.monitor.status()).toMatchObject({ provider_state: "healthy", last_error_at: new Date(T0).toISOString() });
    h.clock.now = T0 + 5_000;
    await h.run();
    expect(h.monitor.status().last_error_at).toBe(new Date(T0 + 5_000).toISOString());
    h.answer(refusing("/v2/transcript", () => json(400, { error: UPSTREAM_DETAIL })));
    h.clock.now = T0 + 9_000;
    await h.run();
    expect(h.monitor.status()).toMatchObject({ provider_state: "healthy", last_error_at: new Date(T0 + 9_000).toISOString() });
  });
});

describe("heartbeat and the one snapshot", () => {
  test("counts the jobs being sent and the age of the oldest; the status route serves the same numbers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await setup((call) => (call.url.endsWith("/v2/upload") ? gate.then(() => healthy(call)) : healthy(call)));
    h.monitor.heartbeat();
    expect(h.events.at(-1)).toEqual({ event: "assemblyai_worker_heartbeat", pending_jobs: 0, delayed_jobs: 0, oldest_pending_age_s: 0, consecutive_failed_jobs: 0 });
    const created = await h.req("POST", "/hosted/uploads", { byte_size: 50, content_type: "audio/mp4" });
    const id = created.json.upload_id as string;
    await h.req("PUT", `/hosted/uploads/${id}/parts/0`, undefined, audio(50));
    await h.req("POST", "/hosted/transcripts", { upload_id: id, speaker_labels: true });
    h.clock.now = T0 + 125_500;
    h.monitor.heartbeat();
    expect(h.events.at(-1)).toEqual({ event: "assemblyai_worker_heartbeat", pending_jobs: 1, delayed_jobs: 0, oldest_pending_age_s: 125, consecutive_failed_jobs: 0 });
    expect(h.events.at(-1)).not.toHaveProperty("alert");
    expect(h.monitor.status()).toMatchObject({ pending_jobs: 1, delayed_jobs: 0, oldest_pending_age_s: 125 });
    release();
    await h.store.idle();
    h.monitor.heartbeat();
    expect(h.events.at(-1)).toMatchObject({ pending_jobs: 0, oldest_pending_age_s: 0 });
  });

  test("worker_heartbeat_age_s grows while the heartbeat tick is silent and resets on the next tick", async () => {
    const h = await setup();
    h.clock.now = T0 + 200_000;
    expect(h.monitor.status().worker_heartbeat_age_s).toBe(200);
    h.monitor.heartbeat();
    expect(h.monitor.status().worker_heartbeat_age_s).toBe(0);
  });

  test("hosted on and idle: every count is a number (never null), and a stale heartbeat reports its true age", async () => {
    const h = await setup();
    const idle = h.monitor.status();
    for (const field of ["pending_jobs", "delayed_jobs", "consecutive_failed_jobs", "oldest_pending_age_s", "worker_heartbeat_age_s"] as const) {
      expect([field, idle[field]]).toEqual([field, 0]);
    }
    // No iteration yet: the age is time since the monitor started, however long ago that was.
    h.clock.now = T0 + 3 * 3_600_000;
    expect(h.monitor.status().worker_heartbeat_age_s).toBe(10_800);
    h.monitor.heartbeat();
    h.clock.now += 90_000;
    expect(h.monitor.status().worker_heartbeat_age_s).toBe(90);
  });

  test("a failure count in the heartbeat is the one the route reports", async () => {
    const h = await setup(refusing("/v2/upload", () => json(500, {})));
    await h.run();
    await h.run();
    h.monitor.heartbeat();
    expect(h.events.at(-1)).toMatchObject({ consecutive_failed_jobs: 2 });
    expect(h.monitor.status().consecutive_failed_jobs).toBe(2);
  });
});

describe("GET /api/internal/assemblyai-status", () => {
  async function statusApp(env: Record<string, string | undefined>, monitor = new HostedProviderMonitor(() => {}, () => T0)) {
    const app = express();
    app.use(createAssemblyAiStatusRouter(env, monitor));
    app.get("/other", (_req, res) => res.json({ ok: true }));
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const get = (key?: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${ASSEMBLYAI_STATUS_ROUTE_PATH}`, { headers: { ...(key === undefined ? {} : { "x-admin-key": key }), ...headers } });
    return { get, other: () => fetch(`${base}/other`) };
  }

  test("it is not registered unless the same admin key as the credential count is set and long enough", async () => {
    for (const env of [{}, { CREDENTIAL_COUNT_ADMIN_KEY: "   " }, { CREDENTIAL_COUNT_ADMIN_KEY: "too-short" }]) {
      const { get } = await statusApp(env);
      expect((await get(ADMIN_KEY)).status).toBe(404);
    }
  });

  test("mounted at the app root it adds no header to, and does not answer, any other path", async () => {
    const { other } = await statusApp({ CREDENTIAL_COUNT_ADMIN_KEY: ADMIN_KEY });
    const response = await other();
    expect([response.status, response.headers.get("cache-control")]).toEqual([200, null]);
  });

  test("a wrong or missing key is a bare 401, then 429 once the failure bucket is spent; the right key still works", async () => {
    const { get } = await statusApp({ CREDENTIAL_COUNT_ADMIN_KEY: ADMIN_KEY });
    for (let i = 0; i < ASSEMBLYAI_STATUS_FAILURE_LIMIT; i++) {
      const response = await get(i % 2 === 0 ? "wrong-key-wrong-key-wrong-key-0000" : undefined);
      expect([response.status, await response.text(), response.headers.get("cache-control")]).toEqual([401, "", "no-store"]);
    }
    const spent = await get("wrong-key-wrong-key-wrong-key-0000");
    expect([spent.status, await spent.text()]).toEqual([429, ""]);
    expect((await get(ADMIN_KEY)).status).toBe(200);
  });

  test(`the correct key has its own bucket of ${ASSEMBLYAI_STATUS_SUCCESS_LIMIT} an hour (a 5-minute probe needs 12), then a bare 429`, async () => {
    expect(ASSEMBLYAI_STATUS_SUCCESS_LIMIT).toBeGreaterThanOrEqual(30);
    const { get } = await statusApp({ CREDENTIAL_COUNT_ADMIN_KEY: ADMIN_KEY });
    for (let i = 0; i < ASSEMBLYAI_STATUS_SUCCESS_LIMIT; i++) expect((await get(ADMIN_KEY)).status).toBe(200);
    const spent = await get(ADMIN_KEY);
    expect([spent.status, await spent.text()]).toEqual([429, ""]);
    expect((await get("wrong-key-wrong-key-wrong-key-0000")).status).toBe(401);
  });

  test("the path is outside the global bucket exactly like the credential count's", () => {
    expect(bucketFor("GET", ASSEMBLYAI_STATUS_ROUTE_PATH)).toBe(bucketFor("GET", CREDENTIAL_COUNT_PATHS[0]));
    expect(bucketFor("GET", ASSEMBLYAI_STATUS_ROUTE_PATH)).not.toBe("global");
  });

  test("hosted mode off: hosted_enabled false, healthy, zeros; exactly the documented fields", async () => {
    const { get } = await statusApp({ CREDENTIAL_COUNT_ADMIN_KEY: ADMIN_KEY });
    const response = await get(ADMIN_KEY);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      hosted_enabled: false, provider_state: "healthy", blocked_reason: null, blocked_http_status: null, blocked_since: null,
      last_error_at: null, consecutive_failed_jobs: 0, pending_jobs: 0, delayed_jobs: 0, oldest_pending_age_s: 0,
      worker_heartbeat_age_s: 0, generated_at: new Date(T0).toISOString(),
    });
  });

  test("a blocked provider reads as blocked, then healthy again after a success; counts and tokens only", async () => {
    const h = await setup(refusing("/v2/upload", () => json(400, { error: `${BALANCE_BODY.error} ${UPSTREAM_DETAIL}` })));
    const { get } = await statusApp({ CREDENTIAL_COUNT_ADMIN_KEY: ADMIN_KEY }, h.monitor);
    await h.run();
    h.clock.now = T0 + 30_000;
    const blocked = await (await get(ADMIN_KEY)).json();
    expect(blocked).toEqual({
      hosted_enabled: true, provider_state: "blocked", blocked_reason: "billing_blocked", blocked_http_status: 400,
      blocked_since: new Date(T0).toISOString(), last_error_at: new Date(T0).toISOString(), consecutive_failed_jobs: 1,
      pending_jobs: 0, delayed_jobs: 0, oldest_pending_age_s: 0, worker_heartbeat_age_s: 30, generated_at: new Date(T0 + 30_000).toISOString(),
    });
    h.answer(healthy);
    await h.run();
    const recovered = await (await get(ADMIN_KEY)).json();
    expect(recovered).toMatchObject({ provider_state: "healthy", blocked_reason: null, blocked_http_status: null, blocked_since: null, consecutive_failed_jobs: 0 });
    const everything = JSON.stringify([blocked, recovered]);
    for (const secret of ["UPSTREAM-DETAIL", "balance is negative", API_KEY, ADMIN_KEY, ADDRESS_A, TRANSCRIPT_ID, UPLOAD_URL]) expect(everything).not.toContain(secret);
  });
});
