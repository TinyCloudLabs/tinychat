// Exo private cloud transcription (routes/private-cloud-transcription.ts; plan §4.4 P4).
// Pinned here:
//   1. dark: flag unset/false ⇒ nothing mounted; a non-cohort address gets the byte-identical 404;
//   2. armed config is validated (bad/missing/weak ⇒ throw, never a silent default);
//   3. session auth, CSRF and the /api/transcriber rate-limit bucket guard every route;
//   4. PTX sees an HMAC tenant_ref, never the address; the PTX key never reaches the caller;
//   5. per-tenant admission is PTX's atomic decision, relayed unchanged under concurrency;
//   6. only a relative `/uploads/<id>` path is returned — anything else is upstream_bad_response;
//   7. upstream failures map to stable public codes with a correlation id, and PTX 401/403 is an
//      operator fault logged with alert=true; logs are content-free;
//   8. no route accepts audio.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import express from "express";
import { load as loadYaml } from "js-yaml";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";

import { createAuthMiddleware } from "../middleware/auth.js";
import { applyRateLimiters, TRANSCRIBER_LIMIT, TRANSCRIBER_PATHS } from "../rate-limits.js";
import { createPrivateCloudTranscriptionRouter } from "../routes/private-cloud-transcription.js";
import {
  MAX_RECORDING_BYTES,
  PRIVATE_CLOUD_TRANSCRIPTION_MOUNT,
  PUBLIC_ERRORS,
  createPtxClient,
  privateCloudTranscriptionConfigFromEnv,
  tenantRefFor,
  type PrivateCloudTranscriptionConfig,
} from "../services/private-cloud-transcription.js";
import { runPrivateCloudE2E } from "../../scripts/e2e-private-cloud-transcription.js";

const SESSION_KEY = "synthetic-session-signing-key";
const PTX_KEY = "tc_live_synthetic_batch_transcriptions_key";
const TENANT_KEY = "q3Jm8V0t6n0bqK1i2Xz7cP4sWf9YhR5uLd2eA8gT1kM=";
const ADDRESS_A = "0xAaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAA";
const ADDRESS_B = "0xBbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBB";
const ADDRESS_C = "0xCcccCCCCccccCCCCccccCCCCccccCCCCccccCCCC";
const TRANSCRIPT_TEXT = "alice: the quick brown fox";
const BASE = "/api/transcriber/private-cloud";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  closers.push(
    () =>
      new Promise((r) => {
        // Unread request bodies (the 415/404 audio cases) keep a socket busy; drop them all.
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function newId(): string {
  return `trn_${Array.from({ length: 26 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join("")}`;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── Mock PTX batch API (plan §4.2) ──────────────────────────────────

type Job = {
  id: string;
  tenant: string;
  idempotencyKey: string;
  status: string;
  byte_size: number;
  sha256: string;
  capability: string;
  reads: number;
};
type Override = { status: number; body?: unknown; raw?: string; headers?: Record<string, string>; delayMs?: number };

async function startMockPtx() {
  const requests: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
  const jobs = new Map<string, Job>();
  const state: { override: ((path: string) => Override | null) | null } = { override: null };
  const app = express();
  app.use(express.raw({ type: () => true, limit: "10mb" }));
  app.use(async (req, res, next) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    requests.push({ method: req.method, url: req.originalUrl, headers: { ...req.headers }, body: body.toString("utf8") });
    (req as { raw?: Buffer }).raw = body;
    const override = state.override?.(req.path) ?? null;
    if (override) {
      if (override.delayMs) await new Promise((r) => setTimeout(r, override.delayMs));
      for (const [k, v] of Object.entries(override.headers ?? {})) res.setHeader(k, v);
      if (override.raw !== undefined) res.status(override.status).type("text/plain").send(override.raw);
      else if (override.body === undefined) res.status(override.status).end();
      else res.status(override.status).json(override.body);
      return;
    }
    if (req.path.startsWith("/v1/") && req.get("authorization") !== `Bearer ${PTX_KEY}`) {
      res.status(401).json({ error: { type: "authentication_error", code: "invalid_api_key", message: "bad key" } });
      return;
    }
    next();
  });
  const ptxError = (res: express.Response, status: number, code: string, extra: object = {}) =>
    res.status(status).json({ error: { type: "invalid_request_error", code, message: `upstream says ${code}`, ...extra } });
  const view = (job: Job) => ({
    id: job.id,
    status: job.status,
    byte_size: job.byte_size,
    request_id: "req_mock",
    progress: { stage: job.status, queue_position: 0, regions_completed: 0, regions_total: 0 },
    retention: { audio: "stored", audio_deleted_at: null, transcript_expires_at: null },
    error: null,
  });
  const owned = (req: express.Request, res: express.Response): Job | null => {
    const job = jobs.get(String(req.params.id));
    if (!job || job.tenant !== req.get("x-tenant-ref")) {
      ptxError(res, 404, "transcription_not_found");
      return null;
    }
    return job;
  };
  const ACTIVE = new Set(["awaiting_upload", "queued", "processing"]);

  app.get("/v1/transcriptions/capabilities", (_req, res) => {
    res.json({
      max_bytes: MAX_RECORDING_BYTES,
      max_duration_seconds: 7200,
      max_channels: 2,
      content_types: ["audio/mpeg", "audio/wav", "audio/ogg"],
      transcript_ttl_seconds: 86400,
      admission: "open",
    });
  });
  // One synchronous handler: the check-and-insert is atomic, like PTX's partial unique index.
  app.post("/v1/transcriptions", (req, res) => {
    const tenant = req.get("x-tenant-ref") ?? "";
    const key = req.get("idempotency-key") ?? "";
    if (!/^[0-9a-f]{64}$/.test(tenant) || !key) return ptxError(res, 400, "invalid_request");
    const body = JSON.parse((req as { raw?: Buffer }).raw!.toString("utf8"));
    const replay = [...jobs.values()].find((j) => j.tenant === tenant && j.idempotencyKey === key);
    const withUpload = (job: Job) => ({
      ...view(job),
      ...(job.status === "awaiting_upload"
        ? { upload: { path: `/uploads/${job.id}`, capability: job.capability, expires_at: new Date(Date.now() + 3_600_000).toISOString(), max_live: 5 } }
        : {}),
    });
    if (replay) {
      if (replay.sha256 !== body.sha256) return ptxError(res, 409, "idempotency_conflict");
      return res.status(200).json(withUpload(replay));
    }
    const active = [...jobs.values()].find((j) => j.tenant === tenant && ACTIVE.has(j.status));
    if (active) return ptxError(res, 409, "active_transcription_exists", { id: active.id });
    const job: Job = {
      id: newId(),
      tenant,
      idempotencyKey: key,
      status: "awaiting_upload",
      byte_size: body.byte_size,
      sha256: body.sha256,
      capability: `tcu_${randomUUID().replaceAll("-", "")}`,
      reads: 0,
    };
    jobs.set(job.id, job);
    res.status(201).json(withUpload(job));
  });
  app.get("/v1/transcriptions", (req, res) => {
    const tenant = req.get("x-tenant-ref");
    res.json({ transcriptions: [...jobs.values()].filter((j) => j.tenant === tenant).slice(0, Number(req.query.limit)).map(view) });
  });
  app.get("/v1/transcriptions/:id", (req, res) => {
    const job = owned(req, res);
    if (!job) return;
    // Processing advances on reads so the E2E poll loop terminates.
    if (job.status === "queued" || job.status === "processing") {
      job.reads++;
      job.status = job.reads >= 2 ? "completed" : "processing";
    }
    res.json(view(job));
  });
  app.get("/v1/transcriptions/:id/result", (req, res) => {
    const job = owned(req, res);
    if (!job) return;
    if (job.status !== "completed") return res.status(202).json({ id: job.id, status: job.status });
    res.json({
      status: "completed",
      language: "en",
      duration_seconds: 26,
      provider: "tinfoil",
      model: "voxtral-small-24b",
      channels: 2,
      speakers: [{ id: "channel_0", name: "Speaker 1", channel: 0 }],
      segments: [{ id: "seg_1", speaker_id: "channel_0", channel: 0, start: 0, end: 3, text: TRANSCRIPT_TEXT }],
      text: TRANSCRIPT_TEXT,
      stats: { tinfoil_calls: 1, tinfoil_audio_seconds: 3 },
    });
  });
  app.post("/v1/transcriptions/:id/cancel", (req, res) => {
    const job = owned(req, res);
    if (!job) return;
    job.status = "cancelled";
    res.json({ id: job.id, status: job.status });
  });
  app.delete("/v1/transcriptions/:id", (req, res) => {
    const job = owned(req, res);
    if (!job) return;
    jobs.delete(job.id);
    res.status(204).end();
  });
  app.put("/uploads/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    const raw = (req as { raw?: Buffer }).raw!;
    if (!job || req.get("authorization") !== `Bearer ${job.capability}`) return ptxError(res, 401, "upload_capability_invalid");
    if (job.status !== "awaiting_upload") return ptxError(res, 409, "upload_already_received", { status: job.status });
    if (raw.length !== job.byte_size || sha256(raw) !== job.sha256) return ptxError(res, 422, "upload_integrity_failed");
    job.status = "queued";
    res.status(201).json({ status: "queued" });
  });
  const url = await listen(app);
  return { url, requests, jobs, state };
}

// ── TinyChat app, mirroring index.ts's order: JSON parser → CSRF → limiters → auth → router ──

function enabledEnv(ptxUrl: string, extra: Record<string, string> = {}) {
  return {
    PRIVATE_CLOUD_TRANSCRIPTION_ENABLED: "true",
    PRIVATE_CLOUD_TRANSCRIPTION_API_URL: ptxUrl,
    PRIVATE_CLOUD_TRANSCRIPTION_API_KEY: PTX_KEY,
    PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY: TENANT_KEY,
    PRIVATE_CLOUD_TRANSCRIPTION_ACCOUNTS: `${ADDRESS_A},${ADDRESS_B}`,
    ...extra,
  };
}

async function startBackend(config: PrivateCloudTranscriptionConfig, clientOptions: { timeoutMs?: number } = {}) {
  const logs: { line: string; alert: boolean }[] = [];
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createCsrfMiddleware());
  applyRateLimiters(app);
  if (config.enabled) {
    app.use(
      PRIVATE_CLOUD_TRANSCRIPTION_MOUNT,
      createAuthMiddleware(SESSION_KEY),
      createPrivateCloudTranscriptionRouter({
        client: createPtxClient({ ...config, ...clientOptions }),
        tenantKey: config.tenantKey,
        accountAllowed: config.accountAllowed,
        log: (line, alert) => logs.push({ line, alert }),
      }),
    );
  }
  return { url: await listen(app), logs };
}

async function setup(env: Record<string, string> = {}, clientOptions: { timeoutMs?: number } = {}) {
  const ptx = await startMockPtx();
  const backend = await startBackend(privateCloudTranscriptionConfigFromEnv(enabledEnv(ptx.url, env)), clientOptions);
  return { ptx, backend };
}

const tokens = new Map<string, string>();
async function tokenFor(address: string): Promise<string> {
  if (!tokens.has(address)) tokens.set(address, (await issueSessionToken(address, SESSION_KEY)).token);
  return tokens.get(address)!;
}

type Call = { status: number; json: any; text: string; headers: Headers };
async function call(
  base: string,
  method: string,
  path: string,
  options: { as?: string | null; headers?: Record<string, string>; body?: unknown; csrf?: boolean } = {},
): Promise<Call> {
  const headers: Record<string, string> = { ...options.headers };
  const as = options.as === undefined ? ADDRESS_A : options.as;
  if (as !== null) headers.Authorization = `Bearer ${await tokenFor(as)}`;
  if (options.csrf !== false && method !== "GET") headers["X-Requested-With"] = "XMLHttpRequest";
  let body: BodyInit | undefined;
  if (options.body instanceof Uint8Array) body = options.body;
  else if (options.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${base}${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the server's ordinary 404 page.
  }
  return { status: response.status, json, text, headers: response.headers };
}

const AUDIO = new TextEncoder().encode("synthetic mp3 bytes for the private cloud test");
function createBody(bytes: Uint8Array = AUDIO) {
  return {
    content_type: "audio/mpeg",
    byte_size: bytes.byteLength,
    sha256: sha256(bytes),
    language: "en",
    channel_mode: "separate",
    channel_labels: ["Speaker 1", "Speaker 2"],
  };
}
function create(base: string, as: string = ADDRESS_A, key: string = randomUUID(), body: unknown = createBody()) {
  return call(base, "POST", "/transcriptions", { as, headers: { "Idempotency-Key": key }, body });
}

// ── Config ──────────────────────────────────────────────────────────

describe("config", () => {
  test("unset or false is dark; anything but true/false refuses", () => {
    expect(privateCloudTranscriptionConfigFromEnv({})).toEqual({ enabled: false });
    expect(privateCloudTranscriptionConfigFromEnv({ PRIVATE_CLOUD_TRANSCRIPTION_ENABLED: "false" })).toEqual({ enabled: false });
    for (const flag of ["1", "yes", "TRUE", "on"]) {
      expect(() => privateCloudTranscriptionConfigFromEnv({ PRIVATE_CLOUD_TRANSCRIPTION_ENABLED: flag })).toThrow(
        "PRIVATE_CLOUD_TRANSCRIPTION_ENABLED",
      );
    }
  });

  test("armed, every missing or unsafe value refuses without echoing it", () => {
    const good = enabledEnv("https://ptx-batch.example");
    const cases: [Record<string, string>, string][] = [
      [{ PRIVATE_CLOUD_TRANSCRIPTION_API_URL: "" }, "PRIVATE_CLOUD_TRANSCRIPTION_API_URL"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_API_URL: "http://ptx-batch.example" }, "must be https"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_API_URL: "https://ptx-batch.example/v1" }, "bare origin"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_API_URL: "https://user:pw@ptx-batch.example" }, "bare origin"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_API_KEY: "" }, "PRIVATE_CLOUD_TRANSCRIPTION_API_KEY"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY: "" }, "PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY: "short-weak-value" }, "PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY: TENANT_KEY, PRIVATE_CLOUD_TRANSCRIPTION_API_KEY: TENANT_KEY }, "reuse"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_ACCOUNTS: `*,${ADDRESS_A}` }, "only entry"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_ACCOUNTS: "alice.eth" }, "entry 1"],
    ];
    for (const [patch, message] of cases) {
      let thrown: Error | null = null;
      try {
        privateCloudTranscriptionConfigFromEnv({ ...good, ...patch });
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).toContain(message);
      for (const value of [PTX_KEY, TENANT_KEY, "short-weak-value", "user:pw"]) expect(thrown!.message).not.toContain(value);
    }
    const local = privateCloudTranscriptionConfigFromEnv({ ...good, PRIVATE_CLOUD_TRANSCRIPTION_API_URL: "http://127.0.0.1:8080/" });
    expect(local.enabled && local.baseUrl).toBe("http://127.0.0.1:8080");
  });

  test("allowlist: empty admits nobody, `*` everyone, entries are case-insensitive", () => {
    const allowed = (accounts: string, address: string) => {
      const config = privateCloudTranscriptionConfigFromEnv({ ...enabledEnv("https://p.example"), PRIVATE_CLOUD_TRANSCRIPTION_ACCOUNTS: accounts });
      return config.enabled && config.accountAllowed(address);
    };
    expect(allowed("", ADDRESS_A)).toBe(false);
    expect(allowed(" , ", ADDRESS_A)).toBe(false);
    expect(allowed("*", ADDRESS_C)).toBe(true);
    expect(allowed(` ${ADDRESS_A.toUpperCase().replace("0X", "0x")} `, ADDRESS_A.toLowerCase())).toBe(true);
    expect(allowed(ADDRESS_A, ADDRESS_B)).toBe(false);
  });

  test("tenant_ref is a stable, case-insensitive HMAC of the address, never the address", () => {
    const ref = tenantRefFor(TENANT_KEY, ADDRESS_A);
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(tenantRefFor(TENANT_KEY, ADDRESS_A.toLowerCase())).toBe(ref);
    expect(tenantRefFor(TENANT_KEY, ADDRESS_A.toUpperCase())).toBe(ref);
    expect(tenantRefFor(TENANT_KEY, ADDRESS_B)).not.toBe(ref);
    expect(tenantRefFor(`${TENANT_KEY}x`, ADDRESS_A)).not.toBe(ref);
    expect(ref).not.toContain(ADDRESS_A.slice(2).toLowerCase());
  });
});

// ── Dark launch, cohort, auth, CSRF, limiter ────────────────────────

describe("dark launch and access", () => {
  const ROUTES: [string, string][] = [
    ["GET", "/capabilities"],
    ["POST", "/transcriptions"],
    ["GET", "/transcriptions"],
    ["GET", "/transcriptions/trn_0123456789ABCDEFGHJKMNPQRS"],
    ["GET", "/transcriptions/trn_0123456789ABCDEFGHJKMNPQRS/result"],
    ["POST", "/transcriptions/trn_0123456789ABCDEFGHJKMNPQRS/cancel"],
    ["DELETE", "/transcriptions/trn_0123456789ABCDEFGHJKMNPQRS"],
  ];

  test("flag off: every route 404s, even for a signed-in cohort address, and PTX is never called", async () => {
    const ptx = await startMockPtx();
    // Every other var is fully configured: the flag alone keeps the routes unmounted.
    for (const flag of [undefined, "", "false"]) {
      const dark = await startBackend(
        privateCloudTranscriptionConfigFromEnv({ ...enabledEnv(ptx.url), PRIVATE_CLOUD_TRANSCRIPTION_ENABLED: flag }),
      );
      for (const [method, path] of ROUTES) {
        const r = await call(dark.url, method, path, { headers: { "Idempotency-Key": randomUUID() }, body: method === "POST" ? createBody() : undefined });
        expect(r.status).toBe(404);
      }
    }
    expect(ptx.requests).toHaveLength(0);
  });

  test("a non-cohort address gets the same 404 as the flag being off", async () => {
    const { ptx, backend } = await setup();
    const dark = await startBackend({ enabled: false });
    for (const [method, path] of ROUTES) {
      const body = method === "POST" ? createBody() : undefined;
      const hidden = await call(backend.url, method, path, { as: ADDRESS_C, headers: { "Idempotency-Key": randomUUID() }, body });
      const off = await call(dark.url, method, path, { as: ADDRESS_C, headers: { "Idempotency-Key": randomUUID() }, body });
      expect(hidden.status).toBe(404);
      expect(hidden.text).toBe(off.text);
      expect(hidden.headers.get("x-correlation-id")).toBeNull();
    }
    expect(ptx.requests).toHaveLength(0);
    expect((await call(backend.url, "GET", "/capabilities", { as: ADDRESS_B })).status).toBe(200);
  });

  test("`*` admits any signed-in address", async () => {
    const { backend } = await setup({ PRIVATE_CLOUD_TRANSCRIPTION_ACCOUNTS: "*" });
    expect((await call(backend.url, "GET", "/capabilities", { as: ADDRESS_C })).status).toBe(200);
  });

  test("no bearer or a bad bearer is 401 before PTX is asked anything", async () => {
    const { ptx, backend } = await setup();
    const missing = await call(backend.url, "GET", "/capabilities", { as: null });
    expect(missing.status).toBe(401);
    expect(missing.json.error).toBe("missing_token");
    const forged = await call(backend.url, "GET", "/capabilities", { as: null, headers: { Authorization: "Bearer forged.token.value" } });
    expect(forged.status).toBe(401);
    const other = (await issueSessionToken(ADDRESS_A, "another-backend-key")).token;
    expect((await call(backend.url, "GET", "/transcriptions", { as: null, headers: { Authorization: `Bearer ${other}` } })).status).toBe(401);
    expect(ptx.requests).toHaveLength(0);
  });

  test("POST and DELETE need X-Requested-With (CSRF); GET does not", async () => {
    const { ptx, backend } = await setup();
    const post = await call(backend.url, "POST", "/transcriptions", { csrf: false, headers: { "Idempotency-Key": randomUUID() }, body: createBody() });
    expect(post.status).toBe(403);
    expect(post.json.error).toBe("csrf_rejected");
    const del = await call(backend.url, "DELETE", "/transcriptions/trn_0123456789ABCDEFGHJKMNPQRS", { csrf: false });
    expect(del.status).toBe(403);
    const cancel = await call(backend.url, "POST", "/transcriptions/trn_0123456789ABCDEFGHJKMNPQRS/cancel", { csrf: false });
    expect(cancel.status).toBe(403);
    expect(ptx.requests).toHaveLength(0);
    expect((await call(backend.url, "GET", "/transcriptions")).status).toBe(200);
  });

  test("the mount sits in the /api/transcriber bucket, not the global one", async () => {
    expect(PRIVATE_CLOUD_TRANSCRIPTION_MOUNT.startsWith(`${TRANSCRIBER_PATHS[0]}/`)).toBe(true);
    const { backend } = await setup();
    const r = await call(backend.url, "GET", "/capabilities");
    expect(r.headers.get("ratelimit-policy")).toContain(`${TRANSCRIBER_LIMIT};w=900`);
  });
});

// ── Create: validation, privacy, the relative upload path ───────────

describe("create", () => {
  test("returns the job with a relative upload path; PTX gets tenant_ref + namespaced key, never the address", async () => {
    const { ptx, backend } = await setup();
    const key = randomUUID();
    const r = await create(backend.url, ADDRESS_A, key, { ...createBody(), address: ADDRESS_A, tenant_ref: "attacker-chosen", metadata: { x: 1 } });
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^trn_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.json.status).toBe("awaiting_upload");
    expect(r.json.upload.path).toBe(`/uploads/${r.json.id}`);
    expect(r.json.upload.capability).toMatch(/^tcu_/);
    expect(Object.keys(r.json).sort()).toEqual(["byte_size", "id", "status", "upload"]);
    expect(r.text).not.toContain("://");

    const upstream = ptx.requests.find((q) => q.method === "POST")!;
    expect(upstream.url).toBe("/v1/transcriptions");
    expect(upstream.headers["x-tenant-ref"]).toBe(tenantRefFor(TENANT_KEY, ADDRESS_A));
    expect(upstream.headers["idempotency-key"]).toBe(`tc:${key}`);
    expect(upstream.headers.authorization).toBe(`Bearer ${PTX_KEY}`);
    // Only the whitelisted metadata is forwarded — no address, no caller-chosen tenant_ref.
    expect(JSON.parse(upstream.body)).toEqual(createBody());
    const everything = JSON.stringify(ptx.requests).toLowerCase();
    expect(everything).not.toContain(ADDRESS_A.toLowerCase());
    expect(everything).not.toContain(ADDRESS_A.slice(2).toLowerCase());
    // The PTX key never reaches the caller.
    expect(r.text).not.toContain(PTX_KEY);
    expect(JSON.stringify([...r.headers.entries()])).not.toContain(PTX_KEY);
  });

  test("rejects bad input before PTX is called", async () => {
    const { ptx, backend } = await setup();
    const valid = createBody();
    const cases: [Record<string, string> | null, unknown, number, string][] = [
      [null, { ...valid, content_type: "audio/flac" }, 400, "invalid_request"],
      [null, { ...valid, byte_size: 0 }, 400, "invalid_request"],
      [null, { ...valid, byte_size: 1.5 }, 400, "invalid_request"],
      [null, { ...valid, byte_size: MAX_RECORDING_BYTES + 1 }, 413, "recording_too_large"],
      [null, { ...valid, sha256: "ABC" }, 400, "invalid_request"],
      [null, { ...valid, language: "english" }, 400, "invalid_request"],
      [null, { ...valid, channel_mode: "stereo" }, 400, "invalid_request"],
      [null, { ...valid, channel_labels: ["a", "b", "c"] }, 400, "invalid_request"],
      [null, [valid], 400, "invalid_request"],
      [{}, valid, 400, "invalid_idempotency_key"],
      [{ "Idempotency-Key": "attempt-1" }, valid, 400, "invalid_idempotency_key"],
    ];
    for (const [headers, body, status, code] of cases) {
      const r = await call(backend.url, "POST", "/transcriptions", { headers: headers ?? { "Idempotency-Key": randomUUID() }, body });
      expect([r.status, r.json.error.code]).toEqual([status, code]);
      expect(r.json.error.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const max = await create(backend.url, ADDRESS_A, randomUUID(), { ...valid, byte_size: MAX_RECORDING_BYTES });
    expect(max.status).toBe(201);
    expect(ptx.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  test("no route accepts audio: a non-JSON create is 415 and there is no upload route", async () => {
    const { ptx, backend } = await setup();
    const audio = await call(backend.url, "POST", "/transcriptions", {
      headers: { "Idempotency-Key": randomUUID(), "Content-Type": "audio/mpeg" },
      body: AUDIO,
    });
    expect([audio.status, audio.json.error.code]).toEqual([415, "unsupported_media_type"]);
    const id = (await create(backend.url)).json.id;
    for (const method of ["PUT", "POST"]) {
      const r = await call(backend.url, method, `/transcriptions/${id}/upload`, { headers: { "Content-Type": "audio/mpeg" }, body: AUDIO });
      expect(r.status).toBe(404);
    }
    expect((await call(backend.url, "PUT", `/uploads/${id}`, { body: AUDIO })).status).toBe(404);
    expect(ptx.requests.every((q) => !q.url.startsWith("/uploads"))).toBe(true);
    expect(ptx.requests.every((q) => q.body.length < 1024)).toBe(true);
  });

  test("an upload path that is absolute, foreign or malformed is upstream_bad_response", async () => {
    const { ptx, backend } = await setup();
    const id = newId();
    const job = { id, status: "awaiting_upload", byte_size: AUDIO.byteLength };
    const upload = { path: `/uploads/${id}`, capability: "tcu_abcdefghijklmnopqrstuvwxyz012345", expires_at: new Date().toISOString() };
    const bad: unknown[] = [
      { ...job, upload: { ...upload, path: `https://evil.example/uploads/${id}` } },
      { ...job, upload: { ...upload, path: `//evil.example/uploads/${id}` } },
      { ...job, upload: { ...upload, path: `/uploads/${newId()}` } },
      { ...job, upload: { ...upload, path: `/uploads/${id}?next=https://evil.example` } },
      { ...job, upload: { ...upload, path: `/uploads/../v1/${id}` } },
      { ...job, upload: { ...upload, capability: "" } },
      { ...job, upload: undefined },
      { ...job, status: "queued", upload },
      { ...job, byte_size: AUDIO.byteLength + 1, upload },
      { ...job, id: "../trn", upload },
      { ...job, status: "exploded", upload },
    ];
    for (const body of bad) {
      ptx.state.override = (path) => (path === "/v1/transcriptions" ? { status: 201, body } : null);
      const r = await create(backend.url);
      expect([r.status, r.json.error.code]).toEqual([502, "upstream_bad_response"]);
      expect(r.text).not.toContain("evil.example");
      expect(r.text).not.toContain("tcu_");
    }
    ptx.state.override = () => ({ status: 201, raw: "<html>not json</html>" });
    expect((await create(backend.url)).json.error.code).toBe("upstream_bad_response");
  });
});

// ── Admission: PTX decides atomically; TinyChat relays under concurrency ──

describe("admission", () => {
  test("10 concurrent creates for one account: exactly one 201, nine 409 naming the winner", async () => {
    const { ptx, backend } = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => create(backend.url)));
    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    for (const r of conflicts) {
      expect(r.json.error.code).toBe("active_transcription_exists");
      expect(r.json.error.id).toBe(created[0]!.json.id);
    }
    // TinyChat holds no reservation of its own: every attempt reached PTX's atomic check.
    expect(ptx.requests.filter((q) => q.method === "POST")).toHaveLength(10);
    expect(ptx.jobs.size).toBe(1);
  });

  test("concurrent replays of one Idempotency-Key converge on one job (lost-response recovery)", async () => {
    const { ptx, backend } = await setup();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => create(backend.url, ADDRESS_A, key)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
    expect(results.every((r) => r.json.upload.path === `/uploads/${r.json.id}`)).toBe(true);
    expect(ptx.jobs.size).toBe(1);
    const conflict = await create(backend.url, ADDRESS_A, key, createBody(new TextEncoder().encode("other")));
    expect([conflict.status, conflict.json.error.code]).toEqual([409, "idempotency_conflict"]);
  });

  test("different accounts are admitted independently and cannot see each other's jobs", async () => {
    const { backend } = await setup();
    const [a, b] = await Promise.all([create(backend.url, ADDRESS_A), create(backend.url, ADDRESS_B)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    for (const [method, path] of [
      ["GET", `/transcriptions/${a.json.id}`],
      ["GET", `/transcriptions/${a.json.id}/result`],
      ["POST", `/transcriptions/${a.json.id}/cancel`],
      ["DELETE", `/transcriptions/${a.json.id}`],
    ] as const) {
      const r = await call(backend.url, method, path, { as: ADDRESS_B });
      expect([r.status, r.json.error.code]).toEqual([404, "transcription_not_found"]);
    }
    const listB = await call(backend.url, "GET", "/transcriptions", { as: ADDRESS_B });
    expect(listB.json.transcriptions.map((j: { id: string }) => j.id)).toEqual([b.json.id]);
    expect((await call(backend.url, "GET", `/transcriptions/${a.json.id}`)).status).toBe(200);
  });
});

// ── Relay routes ────────────────────────────────────────────────────

describe("status, result, list, cancel, delete", () => {
  test("the job lifecycle relays through, and a malformed id never reaches PTX", async () => {
    const { ptx, backend } = await setup();
    const caps = await call(backend.url, "GET", "/capabilities");
    expect(caps.json).toMatchObject({ max_bytes: MAX_RECORDING_BYTES, admission: "open" });
    expect(ptx.requests[0]!.headers["x-tenant-ref"]).toBeUndefined();

    const id = (await create(backend.url)).json.id;
    const pending = await call(backend.url, "GET", `/transcriptions/${id}/result`);
    expect([pending.status, pending.json]).toEqual([202, { id, status: "awaiting_upload" }]);
    expect((await call(backend.url, "GET", `/transcriptions/${id}`)).json).toMatchObject({ id, status: "awaiting_upload" });
    const list = await call(backend.url, "GET", "/transcriptions?limit=5");
    expect(list.json.transcriptions).toHaveLength(1);
    expect(ptx.requests.at(-1)!.url).toBe("/v1/transcriptions?limit=5");
    for (const limit of ["0", "51", "abc", "-1"]) {
      expect((await call(backend.url, "GET", `/transcriptions?limit=${limit}`)).json.error.code).toBe("invalid_request");
    }
    const cancelled = await call(backend.url, "POST", `/transcriptions/${id}/cancel`);
    expect(cancelled.json).toEqual({ id, status: "cancelled" });
    const deleted = await call(backend.url, "DELETE", `/transcriptions/${id}`);
    expect([deleted.status, deleted.text]).toEqual([204, ""]);
    expect((await call(backend.url, "GET", `/transcriptions/${id}`)).json.error.code).toBe("transcription_not_found");

    const before = ptx.requests.length;
    for (const bad of ["trn_short", "mtg_123", "..%2Fcapabilities", "trn_0123456789abcdefghjkmnpqrs"]) {
      expect((await call(backend.url, "GET", `/transcriptions/${bad}`)).status).toBe(404);
    }
    expect(ptx.requests.length).toBe(before);
  });

  test("a status or result for a different id or an unknown status is upstream_bad_response", async () => {
    const { ptx, backend } = await setup();
    const id = newId();
    const cases: [string, Override][] = [
      [`/transcriptions/${id}`, { status: 200, body: { id: newId(), status: "queued" } }],
      [`/transcriptions/${id}`, { status: 200, body: { id, status: "done" } }],
      [`/transcriptions/${id}/result`, { status: 202, body: { id, status: "later" } }],
      [`/transcriptions/${id}/result`, { status: 200, body: { status: "completed", text: TRANSCRIPT_TEXT } }],
      ["/transcriptions", { status: 200, body: { transcriptions: [{ id: "bad", status: "queued" }] } }],
      ["/capabilities", { status: 200, body: { admission: "open" } }],
    ];
    for (const [path, override] of cases) {
      ptx.state.override = () => override;
      const r = await call(backend.url, "GET", path);
      expect([path, r.status, r.json.error.code]).toEqual([path, 502, "upstream_bad_response"]);
    }
  });
});

// ── Error mapping, correlation ids, logs ────────────────────────────

describe("error mapping", () => {
  const TABLE: [string, Override, number, string, PrivateCloudClass][] = [
    ["key refused (401)", { status: 401, body: { error: { code: "invalid_api_key" } } }, 503, "service_misconfigured", "operator_fault"],
    ["scope refused (403)", { status: 403, body: { error: { code: "insufficient_scope" } } }, 503, "service_misconfigured", "operator_fault"],
    ["route missing (404, no code)", { status: 404, raw: "Not Found" }, 503, "service_misconfigured", "operator_fault"],
    ["redirect", { status: 302, headers: { Location: "https://elsewhere.example/" } }, 503, "service_misconfigured", "operator_fault"],
    ["paused", { status: 503, body: { error: { code: "service_paused" } }, headers: { "Retry-After": "120" } }, 503, "service_paused", "transient"],
    ["unavailable", { status: 503, body: { error: { code: "service_unavailable" } } }, 503, "service_unavailable", "transient"],
    ["busy", { status: 429, body: { error: { code: "service_busy", retry_after_seconds: 30 } } }, 429, "service_busy", "transient"],
    ["quota", { status: 429, body: { error: { code: "quota_exceeded", retry_after_seconds: 3600 } } }, 429, "quota_exceeded", "transient"],
    ["bare 429", { status: 429, raw: "slow down", headers: { "Retry-After": "7" } }, 429, "service_busy", "transient"],
    ["500", { status: 500, body: { error: { code: "internal_error" } } }, 503, "service_unavailable", "transient"],
    ["502 from the gateway", { status: 502, raw: "Bad Gateway" }, 503, "service_unavailable", "transient"],
    ["unexpected 4xx", { status: 418, body: { error: { code: "teapot" } } }, 502, "upstream_bad_response", "transient"],
    ["too large", { status: 413, body: { error: { code: "recording_too_large" } } }, 413, "recording_too_large", "client"],
    ["not found", { status: 404, body: { error: { code: "transcription_not_found" } } }, 404, "transcription_not_found", "client"],
  ];
  type PrivateCloudClass = "client" | "transient" | "operator_fault";

  test.each(TABLE)("%s", async (_name, override, status, code, klass) => {
    const { ptx, backend } = await setup();
    ptx.state.override = () => ({ ...override, body: override.body === undefined ? undefined : withSecretMessage(override.body) });
    const cid = randomUUID();
    const r = await call(backend.url, "GET", `/transcriptions/${newId()}`, { headers: { "X-Correlation-Id": cid } });
    expect(r.status).toBe(status);
    expect(r.json.error.code).toBe(code);
    expect(r.json.error.message).toBe(PUBLIC_ERRORS[code as keyof typeof PUBLIC_ERRORS].message);
    expect(r.json.error.correlation_id).toBe(cid);
    expect(r.text).not.toContain("UPSTREAM-DETAIL");
    expect(PUBLIC_ERRORS[code as keyof typeof PUBLIC_ERRORS].class).toBe(klass);
    const log = backend.logs.at(-1)!;
    expect(log.line).toContain(`code=${code}`);
    expect(log.line).toContain(`class=${klass}`);
    expect(log.line).toContain(`cid=${cid}`);
    expect(log.alert).toBe(klass === "operator_fault");
    expect(log.line.includes("alert=true")).toBe(klass === "operator_fault");
  });

  function withSecretMessage(body: unknown) {
    const error = (body as { error?: object }).error;
    return error ? { error: { ...error, message: "UPSTREAM-DETAIL for 0xabc" } } : body;
  }

  test("retry_after_seconds is relayed as a body field and a Retry-After header", async () => {
    const { ptx, backend } = await setup();
    ptx.state.override = () => ({ status: 429, body: { error: { code: "quota_exceeded", retry_after_seconds: 90 } } });
    const quota = await create(backend.url);
    expect(quota.json.error.retry_after_seconds).toBe(90);
    expect(quota.headers.get("retry-after")).toBe("90");
    ptx.state.override = () => ({ status: 503, body: { error: { code: "service_paused" } }, headers: { "Retry-After": "120" } });
    const paused = await create(backend.url);
    expect([paused.json.error.code, paused.json.error.retry_after_seconds]).toEqual(["service_paused", 120]);
  });

  test("PTX unreachable or slow is a transient service_unavailable", async () => {
    const closed = express();
    const url = await listen(closed);
    await closers.pop()!();
    const down = await startBackend(privateCloudTranscriptionConfigFromEnv(enabledEnv(url)));
    const r = await call(down.url, "GET", "/capabilities");
    expect([r.status, r.json.error.code]).toEqual([503, "service_unavailable"]);

    const { ptx, backend } = await setup({}, { timeoutMs: 50 });
    ptx.state.override = () => ({ status: 200, body: { max_bytes: 1 }, delayMs: 300 });
    const slow = await call(backend.url, "GET", "/capabilities");
    expect([slow.status, slow.json.error.code]).toEqual([503, "service_unavailable"]);
  });

  test("the openapi error enum is exactly the public code table", () => {
    const spec = loadYaml(readFileSync(resolve(import.meta.dir, "../../openapi.yaml"), "utf8")) as any;
    expect(spec.components.schemas.PrivateCloudError.properties.error.properties.code.enum.sort()).toEqual(
      Object.keys(PUBLIC_ERRORS).sort(),
    );
    for (const [path, methods] of [
      ["/capabilities", ["get"]],
      ["/transcriptions", ["get", "post"]],
      ["/transcriptions/{id}", ["get", "delete"]],
      ["/transcriptions/{id}/result", ["get"]],
      ["/transcriptions/{id}/cancel", ["post"]],
    ] as const) {
      for (const method of methods) {
        expect(spec.paths[`${BASE}${path}`][method].security).toEqual([{ bearerAuth: [] }]);
      }
    }
  });
});

describe("correlation ids and logs", () => {
  test("a caller's UUID round-trips to PTX and back; otherwise one is minted and used throughout", async () => {
    const { ptx, backend } = await setup();
    const cid = randomUUID();
    const r = await create(backend.url, ADDRESS_A, randomUUID());
    const minted = r.headers.get("x-correlation-id")!;
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    expect(ptx.requests.at(-1)!.headers["x-correlation-id"]).toBe(minted);

    const own = await call(backend.url, "GET", "/capabilities", { headers: { "X-Correlation-Id": cid.toUpperCase() } });
    expect(own.headers.get("x-correlation-id")).toBe(cid);
    expect(ptx.requests.at(-1)!.headers["x-correlation-id"]).toBe(cid);

    const injected = await call(backend.url, "GET", "/capabilities", { headers: { "X-Correlation-Id": "x\" alert=true" } });
    expect(injected.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("logs carry route, status, code and correlation id — never address, tenant_ref, capability, key or text", async () => {
    const { ptx, backend } = await setup();
    const created = await create(backend.url);
    const id = created.json.id;
    await fetch(`${ptx.url}${created.json.upload.path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${created.json.upload.capability}` },
      body: AUDIO,
    });
    for (let i = 0; i < 3; i++) await call(backend.url, "GET", `/transcriptions/${id}`);
    expect((await call(backend.url, "GET", `/transcriptions/${id}/result`)).json.text).toBe(TRANSCRIPT_TEXT);
    await call(backend.url, "DELETE", `/transcriptions/${id}`);
    ptx.state.override = () => ({ status: 401, body: { error: { code: "invalid_api_key" } } });
    await create(backend.url);

    const all = backend.logs.map((l) => l.line).join("\n");
    expect(all).toContain("route=create status=201");
    expect(all).toContain("route=delete status=204");
    expect(all).toContain("code=service_misconfigured class=operator_fault upstream_status=401");
    for (const secret of [
      ADDRESS_A.toLowerCase(),
      ADDRESS_A.slice(2).toLowerCase(),
      tenantRefFor(TENANT_KEY, ADDRESS_A),
      created.json.upload.capability,
      PTX_KEY,
      TENANT_KEY,
      TRANSCRIPT_TEXT,
    ]) {
      expect(all.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    // Successful polls are not logged.
    expect(all).not.toContain("route=get");
  });
});

// ── Deploy plumbing (the four places) ───────────────────────────────

describe("Phala deploy environment", () => {
  const root = resolve(import.meta.dir, "../../..");
  const KEYS = [
    "PRIVATE_CLOUD_TRANSCRIPTION_ENABLED",
    "PRIVATE_CLOUD_TRANSCRIPTION_ACCOUNTS",
    "PRIVATE_CLOUD_TRANSCRIPTION_API_URL",
    "PRIVATE_CLOUD_TRANSCRIPTION_API_KEY",
    "PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY",
  ] as const;
  type Step = { name?: string; env?: Record<string, string>; run?: string };
  const workflow = loadYaml(readFileSync(resolve(root, ".github/workflows/deploy-backend-phala.yml"), "utf8")) as {
    jobs: { deploy: { steps: Step[] } };
  };
  const deploy = workflow.jobs.deploy.steps.find((s) => s.name === "Deploy to Phala Cloud")!;
  const sync = workflow.jobs.deploy.steps.find((s) => s.name === "Sync CVM allowed_envs")!;

  test("workflow env, printf writer, compose and .env.example all carry every var; flag defaults off", () => {
    const compose = loadYaml(readFileSync(resolve(root, "docker-compose.phala.yml"), "utf8")) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    const example = readFileSync(resolve(root, "backend/.env.example"), "utf8");
    for (const key of KEYS) {
      expect(Object.hasOwn(deploy.env ?? {}, key)).toBe(true);
      expect(deploy.run).toContain(`"${key}=`);
      expect(compose.services["tinychat-backend"]!.environment[key]).toStartWith(`\${${key}:-`);
      expect(example).toMatch(new RegExp(`^${key}=`, "m"));
    }
    expect(deploy.env!.PRIVATE_CLOUD_TRANSCRIPTION_ENABLED).toBe("${{ vars.PRIVATE_CLOUD_TRANSCRIPTION_ENABLED || 'false' }}");
    expect(compose.services["tinychat-backend"]!.environment.PRIVATE_CLOUD_TRANSCRIPTION_ENABLED).toBe(
      "${PRIVATE_CLOUD_TRANSCRIPTION_ENABLED:-false}",
    );
    expect(example).toMatch(/^PRIVATE_CLOUD_TRANSCRIPTION_ENABLED=false$/m);
    expect(deploy.env!.PRIVATE_CLOUD_TRANSCRIPTION_API_KEY).toContain("secrets.PRIVATE_CLOUD_TRANSCRIPTION_API_KEY");
    expect(deploy.env!.PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY).toContain("secrets.PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY");
    expect(deploy.env!.PRIVATE_CLOUD_TRANSCRIPTION_API_URL).toContain("vars.PRIVATE_CLOUD_TRANSCRIPTION_API_URL");
  });

  test("the writer emits them into the one file both the deploy and the allowed_envs sync read", () => {
    const temp = mkdtempSync(resolve(tmpdir(), "tinychat-private-cloud-env-"));
    try {
      const writer = deploy.run!.split('echo "::group::Deploy environment keys"')[0]!;
      const result = Bun.spawnSync(["/bin/bash", "-c", writer], { cwd: temp, env: { RUNNER_TEMP: temp } });
      expect(result.exitCode).toBe(0);
      const env = readFileSync(resolve(temp, "phala-prod.env"), "utf8");
      expect(env).toContain("PRIVATE_CLOUD_TRANSCRIPTION_ENABLED=false\n");
      for (const key of KEYS) expect(env).toMatch(new RegExp(`^${key}=`, "m"));
      expect(deploy.run).toContain('-e "$ENV_FILE"');
      expect(sync.env?.ENV_FILE).toBe("${{ runner.temp }}/phala-prod.env");
      expect(sync.run).toContain("node phala-sync-allowed-envs.mjs");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

// ── E2E script against the mock (V4 dry run) ────────────────────────

describe("e2e script", () => {
  test("runs capabilities → create → direct PUT → poll → result → delete → 404 without printing secrets", async () => {
    const { ptx, backend } = await setup();
    const lines: string[] = [];
    const bearer = await tokenFor(ADDRESS_A);
    const result = await runPrivateCloudE2E({
      backendUrl: backend.url,
      bearer,
      ptxOrigin: ptx.url,
      audio: AUDIO,
      contentType: "audio/mpeg",
      pollIntervalMs: 1,
      log: (line) => lines.push(line),
    });
    expect(result.segments).toBe(1);
    expect(ptx.jobs.size).toBe(0);
    // The audio went to PTX's /uploads path, never through the backend.
    expect(ptx.requests.filter((q) => q.method === "PUT").map((q) => q.url)).toEqual([`/uploads/${result.id}`]);
    const output = lines.join("\n");
    expect(output).not.toContain(bearer);
    expect(output).not.toContain("tcu_");
    expect(output).not.toContain(TRANSCRIPT_TEXT);
  });
});
