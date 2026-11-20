// TC-2131: what happens when AssemblyAI refuses the hosted path (routes/assemblyai-hosted.ts submit,
// services/assemblyai-hosted-monitor.ts, routes/assemblyai-status.ts). Pinned here:
//   1. refusals are classified from status AND body (insufficient funds is a 400 with a balance message;
//      403 is the HTTP rate limit unless it speaks of the credential; any other 400 is request_rejected);
//   2. a refusal that did no work makes the job WAIT (state `delayed`, spool kept) and send the same request
//      again on a backoff, never failing it and never uploading the audio again; an outcome that could hide
//      a created transcript is never retried; the wait ends after 24 h or on a shutdown;
//   3. the four events: provider_blocked (first of a spell), provider_recovered, jobs_failed_in_a_row, heartbeat;
//   4. the status route: gated like the credential count, its own buckets, exact shape, no leakage;
//   5. nothing AssemblyAI sends reaches the caller, the logs, the events or the status.

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
  SUBMIT_RETRY_MAX_MS,
  SUBMIT_RETRY_SCHEDULE_MS,
  type AssemblyAiHostedConfig,
} from "../services/assemblyai-hosted.js";
import { FAILED_IN_A_ROW, HostedProviderMonitor, classifyProviderRefusal } from "../services/assemblyai-hosted-monitor.js";

const SESSION_KEY = "synthetic-session-signing-key";
const API_KEY = "synthetic0assemblyai0server0key0abcdef";
const HANDLE_KEY = "Zk3Jm8V0t6n0bqK1i2Xz7cP4sWf9YhR5uLd2eA8gT1kM=";
const ADDRESS_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRANSCRIPT_ID = "6ca36708-a9e5-4195-b97c-2dbd098babbf";
const UPLOAD_URL = "https://cdn.assemblyai.com/upload/synthetic-upload-ref";
const UPSTREAM_DETAIL = "UPSTREAM-DETAIL account and audio info";
const BALANCE_BODY = { error: "Your current account balance is negative. Please top up to continue using the API." };
const T0 = Date.parse("2026-10-26T12:00:00Z");
const ADMIN_KEY = "synthetic-admin-key-0123456789ab";
const HOUR_MS = 3_600_000;

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
const hangsUntilAborted = (call: Call) => new Promise<Response>((_resolve, reject) => call.signal!.addEventListener("abort", () => reject(call.signal!.reason)));

function audio(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

/** Lets the server and the background submit run until `condition` holds: event-loop turns, not wall-clock time. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 20_000 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

async function setup(answer: Answer = healthy) {
  const spoolDir = mkdtempSync(join(tmp, "spool-"));
  const config: AssemblyAiHostedConfig = { hosted: true, apiKey: API_KEY, handleKey: HANDLE_KEY, dailyBytes: DEFAULT_DAILY_BYTES, spoolDir };
  const identity = new Map<string, unknown>();
  const makeStore = () => new HostedUploadStore(spoolDir, DEFAULT_DAILY_BYTES, 4, undefined, undefined, undefined, {
    get: async <T>(key: string): Promise<T | null> => (identity.get(key) as T | undefined) ?? null,
    putIfAbsent: async (key: string, value: unknown) => (identity.has(key) ? false : (identity.set(key, value), true)),
  }, "test-install-id");
  const store = makeStore();
  await store.init();
  closers.push(() => store.close());
  const clock = { now: T0 };
  const events: Record<string, unknown>[] = [];
  const logs: { line: string; alert: boolean }[] = [];
  const calls: Call[] = [];
  /** Every wait a job went into; `release` ends it as if its time had passed. */
  const sleeps: { ms: number; release: () => void }[] = [];
  const monitor = new HostedProviderMonitor((event) => events.push(event), () => clock.now);
  monitor.attach(store);
  let current = answer;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { method: String(init?.method), url: String(url), signal: init?.signal ?? null };
    calls.push(call);
    return current(call);
  }) as typeof fetch;
  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    sleeps.push({ ms, release: resolve });
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const app = express();
  const jsonParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => (isHostedPartPath(req.path) ? next() : jsonParser(req, res, next)));
  app.use(ASSEMBLYAI_HOSTED_MOUNT, createAuthMiddleware(SESSION_KEY),
    createAssemblyAiHostedRouter({ config, store, fetchImpl, now: () => clock.now, log: (line, alert) => logs.push({ line, alert }), monitor, sleep }));
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}${ASSEMBLYAI_HOSTED_MOUNT}`;
  const tokens = new Map<string, string>();

  async function req(method: string, path: string, body?: unknown, raw?: Uint8Array, as = ADDRESS_A) {
    if (!tokens.has(as)) tokens.set(as, (await issueSessionToken(as, SESSION_KEY)).token);
    const headers: Record<string, string> = { Authorization: `Bearer ${tokens.get(as)}` };
    if (raw) headers["Content-Type"] = "application/octet-stream";
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${path}`, { method, headers, ...(raw ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  }

  /** Create, PUT every part and POST the submit (202 at once); the background carries on. Returns the upload id. */
  async function start(options: { bytes?: number; as?: string; sourceId?: string } = {}) {
    const { bytes = 50, as = ADDRESS_A, sourceId } = options;
    const data = audio(bytes);
    const created = await req("POST", "/hosted/uploads", { byte_size: bytes, content_type: "audio/mp4", ...(sourceId ? { source_id: sourceId } : {}) }, undefined, as);
    expect(created.status).toBe(201);
    const id = created.json.upload_id as string;
    for (let i = 0; i * HOSTED_PART_SIZE < bytes; i++) {
      expect((await req("PUT", `/hosted/uploads/${id}/parts/${i}`, undefined, data.subarray(i * HOSTED_PART_SIZE, (i + 1) * HOSTED_PART_SIZE), as)).status).toBe(204);
    }
    expect((await req("POST", "/hosted/transcripts", { upload_id: id, speaker_labels: true, ...(sourceId ? { source_id: sourceId } : {}) }, undefined, as)).status).toBe(202);
    return id;
  }
  const view = async (id: string, as = ADDRESS_A) => (await req("GET", `/hosted/uploads/${id}`, undefined, undefined, as)).json;
  /** A job that settles (submitted or failed) without waiting: start it, let the background finish, read the view. */
  async function run(options: { bytes?: number; as?: string; sourceId?: string } = {}) {
    const id = await start(options);
    await store.idle();
    return view(id, options.as);
  }
  /** A job the provider refuses: start it and return once it has gone into its `n`th wait. */
  async function runToDelay(options: { bytes?: number; as?: string; sourceId?: string } = {}, n = sleeps.length + 1) {
    const id = await start(options);
    await until(() => sleeps.length >= n, "the job to wait");
    return id;
  }

  return {
    req, start, run, runToDelay, view, store, monitor, events, logs, clock, spoolDir, calls, sleeps, makeStore,
    answer: (next: Answer) => { current = next; },
    uploads: () => calls.filter((c) => c.url.endsWith("/v2/upload")).length,
    creates: () => calls.filter((c) => c.url.endsWith("/v2/transcript")).length,
    spoolFiles: () => readdirSync(spoolDir).filter((name) => name.endsWith(".part")),
  };
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

describe("a refused submission waits instead of failing", () => {
  // [name, which call refuses, answer, event reason, upstream status, wait in ms]
  const REFUSALS = [
    ["balance 400 on the upload", "/v2/upload", () => json(400, BALANCE_BODY), "billing_blocked", 400, 60_000],
    ["balance 400 on the create", "/v2/transcript", () => json(400, BALANCE_BODY), "billing_blocked", 400, 60_000],
    ["402 on the create", "/v2/transcript", () => json(402, { error: UPSTREAM_DETAIL }), "billing_blocked", 402, 60_000],
    ["401 on the upload", "/v2/upload", () => json(401, { error: UPSTREAM_DETAIL }), "key_rejected", 401, 60_000],
    ["bodiless 403 on the create", "/v2/transcript", () => new Response(null, { status: 403 }), "key_rejected", 403, 60_000],
    ["403 rate limit on the upload", "/v2/upload", () => json(403, { error: "Too many requests, rate limit exceeded" }), "rate_limited", 403, 60_000],
    ["429 on the create", "/v2/transcript", () => json(429, { error: UPSTREAM_DETAIL }, { "Retry-After": "17" }), "rate_limited", 429, 60_000],
    ["429 with a longer Retry-After", "/v2/transcript", () => json(429, {}, { "Retry-After": "300" }), "rate_limited", 429, 300_000],
    ["429 with an absurd Retry-After is capped at the last backoff step", "/v2/transcript", () => json(429, {}, { "Retry-After": "86400" }), "rate_limited", 429, 600_000],
  ] as const;

  test.each(REFUSALS)("%s: delayed, alerted once, no failure to the client, then submitted once the provider is back", async (_name, path, refusal, reason, status, waitMs) => {
    const h = await setup(refusing(path, refusal));
    const id = await h.runToDelay();
    expect(await h.view(id)).toEqual({ status: "delayed", retry_after_seconds: waitMs / 1000 });
    expect(h.sleeps.map((s) => s.ms)).toEqual([waitMs]);
    expect(h.events).toEqual([{ event: "assemblyai_provider_blocked", reason, http_status: status, delayed_jobs: 1, alert: true }]);
    const delayedLog = h.logs.find((l) => l.line.includes("route=submit"))!;
    expect(delayedLog.line).toContain(`delayed=true upstream_status=${status} reason=${reason} attempt=1`);
    expect([delayedLog.alert, delayedLog.line.includes("alert=true")]).toEqual([false, false]);
    expect(h.monitor.status()).toMatchObject({ provider_state: "blocked", blocked_reason: reason, blocked_http_status: status, pending_jobs: 1, delayed_jobs: 1, consecutive_failed_jobs: 0 });
    expect(h.spoolFiles()).toHaveLength(1);
    // Never AssemblyAI's text or our key, in any answer, log line or event.
    const everything = JSON.stringify([await h.view(id), h.logs, h.events, h.monitor.status()]);
    for (const secret of ["UPSTREAM-DETAIL", "balance is negative", API_KEY]) expect(everything).not.toContain(secret);

    h.answer(healthy);
    h.sleeps[0]!.release();
    await h.store.idle();
    expect(await h.view(id)).toMatchObject({ status: "submitted" });
    // The submission went through once; the audio reached AssemblyAI once when only the create was refused.
    expect(h.calls.filter((c) => c.url.endsWith("/v2/transcript") && c.method === "POST").length).toBe(path === "/v2/transcript" ? 2 : 1);
    expect(h.uploads()).toBe(path === "/v2/upload" ? 2 : 1);
    expect(h.events.map((e) => e.event)).toEqual(["assemblyai_provider_blocked", "assemblyai_provider_recovered"]);
    expect(h.monitor.status()).toMatchObject({ provider_state: "healthy", delayed_jobs: 0, pending_jobs: 0 });
    expect(h.spoolFiles()).toEqual([]);
  });

  test("a 5xx on the upload (no paid work yet) waits too, without a blocked alert", async () => {
    const h = await setup(refusing("/v2/upload", () => json(503, { error: UPSTREAM_DETAIL })));
    const id = await h.runToDelay();
    expect(await h.view(id)).toMatchObject({ status: "delayed" });
    expect(h.events).toEqual([]);
    expect(h.monitor.status()).toMatchObject({ provider_state: "healthy", delayed_jobs: 1 });
    expect(h.logs.find((l) => l.line.includes("delayed=true"))!.line).toContain("reason=provider_unavailable");
    h.answer(healthy);
    h.sleeps[0]!.release();
    await h.store.idle();
    expect(await h.view(id)).toMatchObject({ status: "submitted" });
  });

  test("the waits follow 1, 2, 5, 10 minutes and then every 10", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    const id = await h.runToDelay();
    for (let i = 1; i < 7; i++) {
      h.sleeps[i - 1]!.release();
      await until(() => h.sleeps.length > i, "the next wait");
    }
    expect(h.sleeps.map((s) => s.ms)).toEqual([...SUBMIT_RETRY_SCHEDULE_MS, 600_000, 600_000, 600_000].slice(0, 7));
    expect(SUBMIT_RETRY_SCHEDULE_MS).toEqual([60_000, 120_000, 300_000, 600_000]);
    // Still one job, one upload to AssemblyAI, and one alert for the whole spell.
    expect(h.uploads()).toBe(1);
    expect(h.events.filter((e) => e.event === "assemblyai_provider_blocked")).toHaveLength(1);
    expect(await h.view(id)).toMatchObject({ status: "delayed" });
  });

  test("retry_after_seconds counts down to the next attempt", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    const id = await h.runToDelay();
    h.clock.now = T0 + 25_000;
    expect(await h.view(id)).toEqual({ status: "delayed", retry_after_seconds: 35 });
    h.clock.now = T0 + 90_000;
    expect(await h.view(id)).toEqual({ status: "delayed", retry_after_seconds: 1 });
  });

  test("the wait is bounded: after 24 hours the job fails for good, nothing is left to reconcile, the spool is gone", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    const id = await h.runToDelay({ sourceId: "note-1" });
    expect((await h.req("GET", "/hosted/jobs/note-1")).json).toMatchObject({ status: "delayed", upload_id: id });
    h.clock.now = T0 + SUBMIT_RETRY_MAX_MS - 1;
    h.sleeps[0]!.release();
    await until(() => h.sleeps.length === 2, "the second wait");
    h.clock.now = T0 + SUBMIT_RETRY_MAX_MS;
    h.sleeps[1]!.release();
    await h.store.idle();
    expect(await h.view(id)).toMatchObject({ status: "failed", error: { code: "assemblyai_unavailable" } });
    expect(h.sleeps).toHaveLength(2);
    expect(h.spoolFiles()).toEqual([]);
    expect((await h.req("GET", "/hosted/jobs/note-1")).json).toEqual({ status: "missing" });
    const last = h.logs.at(-1)!;
    expect([last.alert, last.line]).toEqual([true, expect.stringContaining("reason=billing_blocked")]);
    expect(h.monitor.status()).toMatchObject({ consecutive_failed_jobs: 1, pending_jobs: 0, delayed_jobs: 0 });
    // The same note can be sent again.
    h.answer(healthy);
    expect(await h.run({ sourceId: "note-1" })).toMatchObject({ status: "submitted" });
  });

  test("an AMBIGUOUS outcome (sent, no definite answer) is never retried: one call, terminal, the note left to reconcile, no second submit", async () => {
    // [name, answer, AssemblyAI calls expected in total]: the upload is 1 call, an upload plus a create is 2.
    const cases: [string, Answer, number][] = [
      ["a network error on the upload", refusing("/v2/upload", () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_DETAIL}`))), 1],
      ["a network error on the create", refusing("/v2/transcript", () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_DETAIL}`))), 2],
      ["a timeout on the create", refusing("/v2/transcript", () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))), 2],
      ["a 500 on the create", refusing("/v2/transcript", () => json(500, { error: UPSTREAM_DETAIL })), 2],
      ["a 502 on the create", refusing("/v2/transcript", () => json(502, {})), 2],
      ["a 503 on the create", refusing("/v2/transcript", () => json(503, {})), 2],
      ["a 504 on the create", refusing("/v2/transcript", () => json(504, {})), 2],
      ["an unparseable create", refusing("/v2/transcript", () => json(200, { id: "../x", status: "queued" })), 2],
      ["an off-contract upload answer", refusing("/v2/upload", () => json(200, { upload_url: "http://plain.example/x" })), 1],
    ];
    for (const [name, answer, expectedCalls] of cases) {
      const h = await setup(answer);
      const id = await h.start({ sourceId: "note-1" });
      await h.store.idle();
      const outcome = await h.view(id);
      expect([name, outcome.status]).toEqual([name, "failed"]);
      expect([name, h.sleeps.length]).toEqual([name, 0]);
      expect([name, h.calls.length]).toEqual([name, expectedCalls]);
      // The journal stays conservative: the note needs reconciling, so a second paid submit cannot follow.
      expect((await h.req("GET", "/hosted/jobs/note-1")).json).toMatchObject({ status: "needs_reconciliation" });
      expect(h.spoolFiles()).toEqual([]);
      // A repeat of the submit, or a new upload for the same note, is refused without calling AssemblyAI.
      const again = await h.req("POST", "/hosted/transcripts", { upload_id: id, speaker_labels: true, source_id: "note-1" });
      expect([name, again.status, again.json.error]).toEqual([name, 409, "assemblyai_needs_reconciliation"]);
      const fresh = await h.req("POST", "/hosted/uploads", { byte_size: 50, content_type: "audio/mp4", source_id: "note-1" });
      expect([name, fresh.status, fresh.json.error]).toEqual([name, 409, "assemblyai_needs_reconciliation"]);
      expect([name, h.calls.length]).toEqual([name, expectedCalls]);
    }
  });

  test("any other 400 stays terminal: alerted as request_rejected (create: create_rejected), never blocked or retried", async () => {
    for (const [path, reason] of [["/v2/upload", "request_rejected"], ["/v2/transcript", "create_rejected"]] as const) {
      const h = await setup(refusing(path, () => json(400, { error: UPSTREAM_DETAIL })));
      expect(await h.run()).toMatchObject({ status: "failed" });
      const submitLog = h.logs.find((l) => l.line.includes("route=submit"))!;
      expect([submitLog.alert, submitLog.line.includes(`upstream_status=400 reason=${reason}`)]).toEqual([true, true]);
      expect(h.events).toEqual([]);
      expect(h.sleeps).toEqual([]);
      expect(h.monitor.status()).toMatchObject({ provider_state: "healthy", blocked_reason: null, consecutive_failed_jobs: 1 });
    }
  });

  test("a spell alerts once across retries; a different reason alerts again", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(400, BALANCE_BODY)));
    await h.runToDelay();
    h.sleeps[0]!.release();
    await until(() => h.sleeps.length === 2, "the second wait");
    expect(h.events.filter((e) => e.event === "assemblyai_provider_blocked")).toHaveLength(1);
    h.answer(refusing("/v2/transcript", () => json(401, {})));
    h.sleeps[1]!.release();
    await until(() => h.sleeps.length === 3, "the third wait");
    expect(h.events.filter((e) => e.event === "assemblyai_provider_blocked").map((e) => e.reason)).toEqual(["billing_blocked", "key_rejected"]);
    expect(h.monitor.status()).toMatchObject({ blocked_reason: "key_rejected", blocked_http_status: 401 });
  });

  test("blocked_since stays at the first refusal of the spell while last_error_at follows the latest", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(400, BALANCE_BODY)));
    await h.runToDelay();
    h.clock.now = T0 + 600_000;
    h.sleeps[0]!.release();
    await until(() => h.sleeps.length === 2, "the second wait");
    expect(h.monitor.status()).toMatchObject({ blocked_since: new Date(T0).toISOString(), last_error_at: new Date(T0 + 600_000).toISOString() });
  });

  test("the first success ends the spell and wakes every other waiting job at once", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    const a = await h.runToDelay({ as: ADDRESS_A });
    const b = await h.runToDelay({ as: ADDRESS_B });
    expect(h.monitor.status()).toMatchObject({ pending_jobs: 2, delayed_jobs: 2 });
    h.answer(healthy);
    // Only A's wait is released: B must not need its own.
    h.sleeps[0]!.release();
    await h.store.idle();
    expect([(await h.view(a)).status, (await h.view(b, ADDRESS_B)).status]).toEqual(["submitted", "submitted"]);
    expect(h.events.at(-1)).toEqual({ event: "assemblyai_provider_recovered", delayed_jobs: 1 });
    expect(h.monitor.status()).toMatchObject({ provider_state: "healthy", pending_jobs: 0, delayed_jobs: 0 });
  });

  test("while it waits the account has no second upload; other accounts are not held back by it", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    await h.runToDelay({ as: ADDRESS_A });
    const second = await h.req("POST", "/hosted/uploads", { byte_size: 50, content_type: "audio/mp4" });
    expect([second.status, second.json.error]).toEqual([429, "assemblyai_busy"]);
    const other = await h.req("POST", "/hosted/uploads", { byte_size: 50, content_type: "audio/mp4" }, undefined, ADDRESS_B);
    expect(other.status).toBe(201);
  });

  test("the sweep neither expires nor aborts a waiting job, however long it waits", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    const id = await h.runToDelay();
    h.clock.now = T0 + 6 * HOUR_MS;
    await h.store.sweep(h.clock.now);
    expect(await h.view(id)).toMatchObject({ status: "delayed" });
    expect(h.spoolFiles()).toHaveLength(1);
  });

  test("a restart while a note waits recovers it like an unsent upload: the same upload id, resent parts, nothing reconciled", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    const id = await h.runToDelay({ sourceId: "note-1" });
    await h.store.close();
    const restarted = h.makeStore();
    await restarted.init();
    closers.push(() => restarted.close());
    expect(restarted.noteJob(ADDRESS_A, "note-1")).toMatchObject({ status: "receiving", upload_id: id });
    expect(restarted.pendingStats(T0)).toEqual({ pending: 0, delayed: 0, oldestAgeSeconds: 0 });
  });

  test("a shutdown while a note waits ends the wait: nothing was sent, so nothing is left to reconcile", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    const id = await h.runToDelay({ sourceId: "note-1" });
    await h.store.shutdown(2_000);
    // Shutdown forgets the unclaimed outcome along with the process state; the upload is no longer there to poll.
    expect((await h.req("GET", `/hosted/uploads/${id}`)).status).toBe(410);
    expect((await h.req("GET", "/hosted/jobs/note-1")).json).toEqual({ status: "missing" });
    expect(h.spoolFiles()).toEqual([]);
    // A shutdown is not AssemblyAI failing jobs.
    expect(h.monitor.status().consecutive_failed_jobs).toBe(0);
    expect(h.events.map((e) => e.event)).toEqual(["assemblyai_provider_blocked"]);
  });

  test("time spent blocked does not age the job: oldest_pending_age_s restarts when the job resumes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    const id = await h.runToDelay();
    h.clock.now = T0 + 10 * 60_000;
    expect(h.monitor.status()).toMatchObject({ pending_jobs: 1, delayed_jobs: 1, oldest_pending_age_s: 0 });
    h.answer((call) => (call.url.endsWith("/v2/transcript") ? gate.then(() => healthy(call)) : healthy(call)));
    h.sleeps[0]!.release();
    await until(() => h.creates() === 2, "the retry to reach AssemblyAI");
    expect(h.monitor.status()).toMatchObject({ pending_jobs: 1, delayed_jobs: 0, oldest_pending_age_s: 0 });
    h.clock.now += 30_000;
    expect(h.monitor.status().oldest_pending_age_s).toBe(30);
    release();
    await h.store.idle();
    expect(await h.view(id)).toMatchObject({ status: "submitted" });
  });
});

describe("jobs failing in a row", () => {
  // A 500 on the create could hide a created transcript, so it is terminal, not a wait.
  const serverError = refusing("/v2/transcript", () => json(500, { error: UPSTREAM_DETAIL }));

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

  test("a job aborted by the sweep deadline is not AssemblyAI failing jobs", async () => {
    const h = await setup((call) => (call.url.endsWith("/v2/upload") ? hangsUntilAborted(call) : healthy(call)));
    await h.start();
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
    await h.start();
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

  test("delayed jobs are pending and delayed in the heartbeat", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(402, {})));
    await h.runToDelay();
    h.monitor.heartbeat();
    expect(h.events.at(-1)).toEqual({ event: "assemblyai_worker_heartbeat", pending_jobs: 1, delayed_jobs: 1, oldest_pending_age_s: 0, consecutive_failed_jobs: 0 });
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
    h.clock.now = T0 + 3 * HOUR_MS;
    expect(h.monitor.status().worker_heartbeat_age_s).toBe(10_800);
    h.monitor.heartbeat();
    h.clock.now += 90_000;
    expect(h.monitor.status().worker_heartbeat_age_s).toBe(90);
  });

  test("a failure count in the heartbeat is the one the route reports", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(500, {})));
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

  test("a blocked provider reads as blocked with its delayed jobs, then healthy again once a retry succeeds; counts and tokens only", async () => {
    const h = await setup(refusing("/v2/transcript", () => json(400, { error: `${BALANCE_BODY.error} ${UPSTREAM_DETAIL}` })));
    const { get } = await statusApp({ CREDENTIAL_COUNT_ADMIN_KEY: ADMIN_KEY }, h.monitor);
    await h.runToDelay();
    h.clock.now = T0 + 30_000;
    const blocked = await (await get(ADMIN_KEY)).json();
    expect(blocked).toEqual({
      hosted_enabled: true, provider_state: "blocked", blocked_reason: "billing_blocked", blocked_http_status: 400,
      blocked_since: new Date(T0).toISOString(), last_error_at: new Date(T0).toISOString(), consecutive_failed_jobs: 0,
      pending_jobs: 1, delayed_jobs: 1, oldest_pending_age_s: 0, worker_heartbeat_age_s: 30, generated_at: new Date(T0 + 30_000).toISOString(),
    });
    h.answer(healthy);
    h.sleeps[0]!.release();
    await h.store.idle();
    const recovered = await (await get(ADMIN_KEY)).json();
    expect(recovered).toMatchObject({ provider_state: "healthy", blocked_reason: null, blocked_http_status: null, blocked_since: null, consecutive_failed_jobs: 0, pending_jobs: 0, delayed_jobs: 0 });
    const everything = JSON.stringify([blocked, recovered]);
    for (const secret of ["UPSTREAM-DETAIL", "balance is negative", API_KEY, ADMIN_KEY, ADDRESS_A, TRANSCRIPT_ID, UPLOAD_URL]) expect(everything).not.toContain(secret);
  });
});
