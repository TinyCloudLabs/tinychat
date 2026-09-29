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
//   8. no route accepts audio;
//   9. every success body is rebuilt by a strict DTO (unknown fields dropped, off-contract values
//      rejected), PTX bodies are read under per-route size caps, and responses are no-store;
//  10. the served OpenAPI omits the feature while dark; the deploy canary probes the mount.

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
  PRIVATE_CLOUD_TRANSCRIPTION_MOUNT,
  PUBLIC_ERRORS,
  PtxResponseTooLargeError,
  RESPONSE_LIMITS,
  createPtxClient,
  privateCloudTranscriptionConfigFromEnv,
  tenantRefFor,
  withoutPrivateCloudOpenApi,
  type PrivateCloudTranscriptionConfig,
} from "../services/private-cloud-transcription.js";
import { JOB_ERRORS, MAX_RECORDING_BYTES } from "../services/private-cloud-transcription-dto.js";
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

function completedResult() {
  return {
    status: "completed",
    language: "en",
    duration_seconds: 26,
    provider: "tinfoil",
    model: "voxtral-small-24b",
    channels: 2,
    speakers: [
      { id: "channel_0", name: "Speaker 1", channel: 0 },
      { id: "channel_1", name: "Speaker 2", channel: 1 },
    ],
    segments: [
      { id: "seg_1", speaker_id: "channel_0", channel: 0, start: 0, end: 3, text: TRANSCRIPT_TEXT },
      { id: "seg_2", speaker_id: "channel_1", channel: 1, start: 13, end: 15.5, text: "bob: good morning" },
    ],
    text: TRANSCRIPT_TEXT,
    stats: { tinfoil_calls: 2, tinfoil_audio_seconds: 5.5 },
  };
}

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
type Override = {
  status: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Stream `count` chunks with no Content-Length. */
  chunked?: { chunk: string; count: number };
};

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
      if (override.chunked) {
        res.status(override.status).type("application/json");
        for (let i = 0; i < override.chunked.count && !res.destroyed; i++) {
          if (!res.write(override.chunked.chunk)) await new Promise((r) => setTimeout(r, 1));
        }
        res.end();
      } else if (override.raw !== undefined) res.status(override.status).type("text/plain").send(override.raw);
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
  // The full §4.2 status shape, plus fields TinyChat must drop (request_id, tenant_ref, storage_path).
  const view = (job: Job) => ({
    id: job.id,
    status: job.status,
    byte_size: job.byte_size,
    duration_seconds: job.status === "completed" ? 26 : null,
    channels: job.status === "awaiting_upload" ? null : 2,
    progress: { stage: job.status === "processing" ? "transcribe" : "waiting", queue_position: 0, regions_completed: 0, regions_total: 0 },
    retention: { audio: "stored", audio_deleted_at: null, transcript_expires_at: null },
    error: null,
    created_at: "2026-09-29T10:00:00.000Z",
    updated_at: "2026-09-29T10:00:05.000Z",
    request_id: "req_mock",
    tenant_ref: job.tenant,
    storage_path: `/data/uploads/${job.id}.mp3`,
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
    res.json(completedResult());
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
  type PrivateCloudClass = "client" | "transient" | "operator_fault";
  type Route = "capabilities" | "create" | "list" | "get" | "result" | "cancel" | "delete";
  const JOB = "trn_0123456789ABCDEFGHJKMNPQRS";
  const ERR = (code: string, extra: object = {}) => ({ error: { type: "x", code, ...extra } });
  // [name, route, upstream answer, our status, our code, class]. Relayed only as an exact
  // (route, status, code) contract tuple; everything else is classified, never trusted by code.
  const TABLE: [string, Route, Override, number, string, PrivateCloudClass][] = [
    ["key refused (401)", "get", { status: 401, body: ERR("invalid_api_key") }, 503, "service_misconfigured", "operator_fault"],
    ["scope refused (403)", "create", { status: 403, body: ERR("insufficient_scope") }, 503, "service_misconfigured", "operator_fault"],
    ["route missing (404, no code)", "get", { status: 404, raw: "Not Found" }, 503, "service_misconfigured", "operator_fault"],
    ["not-found on a route that has no job", "capabilities", { status: 404, body: ERR("transcription_not_found") }, 503, "service_misconfigured", "operator_fault"],
    ["not-found on list", "list", { status: 404, body: ERR("transcription_not_found") }, 503, "service_misconfigured", "operator_fault"],
    ["method not allowed", "cancel", { status: 405, raw: "Method Not Allowed" }, 503, "service_misconfigured", "operator_fault"],
    ["redirect", "get", { status: 302, headers: { Location: "https://elsewhere.example/" } }, 503, "service_misconfigured", "operator_fault"],
    ["job not found", "get", { status: 404, body: ERR("transcription_not_found") }, 404, "transcription_not_found", "client"],
    ["job not found (result)", "result", { status: 404, body: ERR("transcription_not_found") }, 404, "transcription_not_found", "client"],
    ["job not found (cancel)", "cancel", { status: 404, body: ERR("transcription_not_found") }, 404, "transcription_not_found", "client"],
    ["job not found (delete)", "delete", { status: 404, body: ERR("transcription_not_found") }, 404, "transcription_not_found", "client"],
    ["paused", "create", { status: 503, body: ERR("service_paused"), headers: { "Retry-After": "120" } }, 503, "service_paused", "transient"],
    ["unavailable", "get", { status: 503, body: ERR("service_unavailable") }, 503, "service_unavailable", "transient"],
    ["unavailable (capabilities)", "capabilities", { status: 503, body: ERR("service_unavailable") }, 503, "service_unavailable", "transient"],
    ["busy", "create", { status: 429, body: ERR("service_busy", { retry_after_seconds: 30 }) }, 429, "service_busy", "transient"],
    ["quota", "create", { status: 429, body: ERR("quota_exceeded", { retry_after_seconds: 3600 }) }, 429, "quota_exceeded", "transient"],
    ["too large", "create", { status: 413, body: ERR("recording_too_large") }, 413, "recording_too_large", "client"],
    ["invalid", "create", { status: 400, body: ERR("invalid_request") }, 400, "invalid_request", "client"],
    ["idempotency conflict", "create", { status: 409, body: ERR("idempotency_conflict") }, 409, "idempotency_conflict", "client"],
    ["500 internal_error", "get", { status: 500, body: ERR("internal_error") }, 503, "service_unavailable", "transient"],
    ["502 from the gateway", "list", { status: 502, raw: "Bad Gateway" }, 503, "service_unavailable", "transient"],
    // Impossible pairings: a known code on the wrong route or status is off-contract.
    ["400 service_paused", "create", { status: 400, body: ERR("service_paused") }, 502, "upstream_bad_response", "transient"],
    ["paused on a read", "get", { status: 503, body: ERR("service_paused") }, 502, "upstream_bad_response", "transient"],
    ["quota on a read", "result", { status: 429, body: ERR("quota_exceeded") }, 502, "upstream_bad_response", "transient"],
    ["too large on a read", "get", { status: 413, body: ERR("recording_too_large") }, 502, "upstream_bad_response", "transient"],
    ["503 carrying a client code", "get", { status: 503, body: ERR("transcription_not_found") }, 502, "upstream_bad_response", "transient"],
    ["bare 429", "create", { status: 429, raw: "slow down", headers: { "Retry-After": "7" } }, 502, "upstream_bad_response", "transient"],
    ["active job without an id", "create", { status: 409, body: ERR("active_transcription_exists") }, 502, "upstream_bad_response", "transient"],
    ["active job with a bad id", "create", { status: 409, body: ERR("active_transcription_exists", { id: "../x" }) }, 502, "upstream_bad_response", "transient"],
    ["unexpected 4xx", "delete", { status: 418, body: ERR("teapot") }, 502, "upstream_bad_response", "transient"],
    ["unexpected 409 on delete", "delete", { status: 409, body: ERR("idempotency_conflict") }, 502, "upstream_bad_response", "transient"],
    ["unexpected 2xx", "get", { status: 201, body: { id: JOB, status: "queued" } }, 502, "upstream_bad_response", "transient"],
  ];

  function hit(base: string, route: Route, cid: string) {
    const headers = { "X-Correlation-Id": cid };
    switch (route) {
      case "capabilities": return call(base, "GET", "/capabilities", { headers });
      case "create": return call(base, "POST", "/transcriptions", { headers: { ...headers, "Idempotency-Key": randomUUID() }, body: createBody() });
      case "list": return call(base, "GET", "/transcriptions", { headers });
      case "get": return call(base, "GET", `/transcriptions/${JOB}`, { headers });
      case "result": return call(base, "GET", `/transcriptions/${JOB}/result`, { headers });
      case "cancel": return call(base, "POST", `/transcriptions/${JOB}/cancel`, { headers });
      case "delete": return call(base, "DELETE", `/transcriptions/${JOB}`, { headers });
    }
  }

  test.each(TABLE)("%s", async (_name, route, override, status, code, klass) => {
    const { ptx, backend } = await setup();
    ptx.state.override = () => ({ ...override, body: override.body === undefined ? undefined : withSecretMessage(override.body) });
    const cid = randomUUID();
    const r = await hit(backend.url, route, cid);
    expect(r.status).toBe(status);
    expect(r.json.error.code).toBe(code);
    expect(r.json.error.message).toBe(PUBLIC_ERRORS[code as keyof typeof PUBLIC_ERRORS].message);
    expect(r.json.error.correlation_id).toBe(cid);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.text).not.toContain("UPSTREAM-DETAIL");
    expect(PUBLIC_ERRORS[code as keyof typeof PUBLIC_ERRORS].class).toBe(klass);
    const log = backend.logs.at(-1)!;
    expect(log.line).toContain(`route=${route}`);
    expect(log.line).toContain(`code=${code}`);
    expect(log.line).toContain(`class=${klass}`);
    expect(log.line).toContain(`cid=${cid}`);
    expect(log.alert).toBe(klass === "operator_fault");
    expect(log.line.includes("alert=true")).toBe(klass === "operator_fault");
  });

  test("active_transcription_exists relays the valid job id it names", async () => {
    const { ptx, backend } = await setup();
    ptx.state.override = () => ({ status: 409, body: ERR("active_transcription_exists", { id: JOB }) });
    const r = await create(backend.url);
    expect([r.status, r.json.error.code, r.json.error.id]).toEqual([409, "active_transcription_exists", JOB]);
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
    expect(spec.components.schemas.PrivateCloudJobError.properties.code.enum.sort()).toEqual(Object.keys(JOB_ERRORS).sort());
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
    expect(result.segments).toBe(2);
    expect(ptx.jobs.size).toBe(0);
    // The audio went to PTX's /uploads path, never through the backend.
    expect(ptx.requests.filter((q) => q.method === "PUT").map((q) => q.url)).toEqual([`/uploads/${result.id}`]);
    const output = lines.join("\n");
    expect(output).not.toContain(bearer);
    expect(output).not.toContain("tcu_");
    expect(output).not.toContain(TRANSCRIPT_TEXT);
  });
});

// ── Strict response DTOs (Sol #1) ───────────────────────────────────

describe("response DTOs", () => {
  const ID = "trn_0123456789ABCDEFGHJKMNPQRS";
  const JOB_KEYS = ["byte_size", "channels", "created_at", "duration_seconds", "error", "id", "progress", "retention", "status", "updated_at"];
  const job = (patch: Record<string, unknown> = {}) => ({
    id: ID,
    status: "processing",
    byte_size: 1000,
    duration_seconds: 26,
    channels: 2,
    progress: { stage: "transcribe", queue_position: null, regions_completed: 3, regions_total: 7, internal_worker: "w-1" },
    retention: { audio: "stored", audio_deleted_at: null, transcript_expires_at: null, volume: "/data" },
    error: null,
    created_at: "2026-09-29T10:00:00Z",
    updated_at: "2026-09-29T10:00:05.123Z",
    ...patch,
  });
  const LEAKS = { tenant_ref: "f".repeat(64), storage_path: "/data/uploads/x.mp3", capability: "tcu_leakleakleakleakleak", provider_diagnostics: "UPSTREAM-DETAIL" };

  test("status and list are rebuilt: exact contract keys, unknown and sensitive fields dropped", async () => {
    const { ptx, backend } = await setup();
    ptx.state.override = () => ({ status: 200, body: { ...job(), ...LEAKS } });
    const status = await call(backend.url, "GET", `/transcriptions/${ID}`);
    expect(status.status).toBe(200);
    expect(Object.keys(status.json).sort()).toEqual(JOB_KEYS);
    expect(status.json.progress).toEqual({ stage: "transcribe", queue_position: null, regions_completed: 3, regions_total: 7 });
    expect(status.json.retention).toEqual({ audio: "stored", audio_deleted_at: null, transcript_expires_at: null });
    ptx.state.override = () => ({ status: 200, body: { transcriptions: [{ ...job(), ...LEAKS }], cursor: "UPSTREAM-DETAIL" } });
    const list = await call(backend.url, "GET", "/transcriptions");
    expect(Object.keys(list.json)).toEqual(["transcriptions"]);
    expect(Object.keys(list.json.transcriptions[0]).sort()).toEqual(JOB_KEYS);
    // Absent nullable fields come back as explicit nulls.
    ptx.state.override = () => ({ status: 200, body: { id: ID, status: "queued", byte_size: 5, retention: job().retention, created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" } });
    const sparse = await call(backend.url, "GET", `/transcriptions/${ID}`);
    expect(sparse.json).toMatchObject({ duration_seconds: null, channels: null, progress: null, error: null });
    for (const r of [status, list, sparse]) {
      for (const leak of Object.values(LEAKS)) expect(r.text).not.toContain(leak);
      expect(r.text).not.toContain("internal_worker");
      expect(r.text).not.toContain("/data");
    }
  });

  test("a job error is rebuilt as { code, our message }; the upstream message never passes", async () => {
    const { ptx, backend } = await setup();
    const upstreamError = { type: "processing_error", code: "no_speech", message: "UPSTREAM-DETAIL at /data/x", detail: { region: 4 } };
    ptx.state.override = () => ({ status: 200, body: job({ status: "failed", error: upstreamError }) });
    const status = await call(backend.url, "GET", `/transcriptions/${ID}`);
    expect(status.json.error).toEqual({ code: "no_speech", message: JOB_ERRORS.no_speech });
    ptx.state.override = () => ({ status: 200, body: { status: "failed", error: upstreamError, ...LEAKS } });
    const result = await call(backend.url, "GET", `/transcriptions/${ID}/result`);
    expect(result.json).toEqual({ id: ID, status: "failed", error: { code: "no_speech", message: JOB_ERRORS.no_speech } });
    ptx.state.override = () => ({ status: 200, body: { status: "cancelled", error: null } });
    expect((await call(backend.url, "GET", `/transcriptions/${ID}/result`)).json).toEqual({ id: ID, status: "cancelled", error: null });
    expect(status.text + result.text).not.toContain("UPSTREAM-DETAIL");
  });

  test("capabilities and a completed result are rebuilt exactly", async () => {
    const { ptx, backend } = await setup();
    ptx.state.override = () => ({
      status: 200,
      body: { max_bytes: 1000, max_duration_seconds: 7200, max_channels: 2, content_types: ["audio/mpeg"], transcript_ttl_seconds: 86400, admission: "drain", tinfoil_key_id: "UPSTREAM-DETAIL" },
    });
    const caps = await call(backend.url, "GET", "/capabilities");
    expect(caps.json).toEqual({ max_bytes: 1000, max_duration_seconds: 7200, max_channels: 2, content_types: ["audio/mpeg"], transcript_ttl_seconds: 86400, admission: "drain" });
    const leaky = completedResult() as any;
    leaky.provider_request_ids = ["UPSTREAM-DETAIL"];
    leaky.speakers[0].address = ADDRESS_A;
    leaky.segments[0].audio_path = "/data/regions/1.wav";
    leaky.stats.tinfoil_key = "UPSTREAM-DETAIL";
    ptx.state.override = () => ({ status: 200, body: leaky });
    const result = await call(backend.url, "GET", `/transcriptions/${ID}/result`);
    const expected = completedResult();
    expect(result.json).toEqual({ id: ID, ...expected });
    expect(result.text).not.toContain("UPSTREAM-DETAIL");
    expect(result.text.toLowerCase()).not.toContain(ADDRESS_A.toLowerCase());
    expect(result.text).not.toContain("/data");
  });

  test("an off-contract value anywhere in a success body is upstream_bad_response", async () => {
    const { ptx, backend } = await setup();
    const done = completedResult();
    const cases: [string, number, unknown][] = [
      // status
      [`/transcriptions/${ID}`, 200, job({ id: newId() })],
      [`/transcriptions/${ID}`, 200, job({ status: "done" })],
      [`/transcriptions/${ID}`, 200, job({ status: "failed" })],
      [`/transcriptions/${ID}`, 200, job({ error: { code: "no_speech" } })],
      [`/transcriptions/${ID}`, 200, job({ status: "failed", error: { code: "disk_full" } })],
      [`/transcriptions/${ID}`, 200, job({ byte_size: "1000" })],
      [`/transcriptions/${ID}`, 200, job({ byte_size: MAX_RECORDING_BYTES + 1 })],
      [`/transcriptions/${ID}`, 200, job({ channels: 3 })],
      [`/transcriptions/${ID}`, 200, job({ progress: { stage: "transcribe", queue_position: 0, regions_completed: 8, regions_total: 7 } })],
      [`/transcriptions/${ID}`, 200, job({ progress: { stage: "../x", queue_position: 0, regions_completed: 0, regions_total: 0 } })],
      [`/transcriptions/${ID}`, 200, job({ retention: { audio: "archived", audio_deleted_at: null, transcript_expires_at: null } })],
      [`/transcriptions/${ID}`, 200, job({ retention: undefined })],
      [`/transcriptions/${ID}`, 200, job({ created_at: "yesterday" })],
      [`/transcriptions/${ID}`, 200, [job()]],
      // list
      ["/transcriptions?limit=1", 200, { transcriptions: [job(), job({ id: newId() })] }],
      ["/transcriptions", 200, { transcriptions: [job({ status: "done" })] }],
      ["/transcriptions", 200, { data: [job()] }],
      // capabilities
      ["/capabilities", 200, { max_bytes: 1, max_duration_seconds: 1, max_channels: 2, content_types: ["audio/mpeg"], transcript_ttl_seconds: 1, admission: "maybe" }],
      ["/capabilities", 200, { max_bytes: 1, max_duration_seconds: 1, max_channels: 3, content_types: ["audio/mpeg"], transcript_ttl_seconds: 1, admission: "open" }],
      ["/capabilities", 200, { max_bytes: 1, max_duration_seconds: 1, max_channels: 2, content_types: ["video/mp4"], transcript_ttl_seconds: 1, admission: "open" }],
      ["/capabilities", 200, { max_bytes: 1, max_duration_seconds: 1, max_channels: 2, content_types: ["audio/mpeg"], admission: "open" }],
      // result
      [`/transcriptions/${ID}/result`, 202, { id: ID, status: "completed" }],
      [`/transcriptions/${ID}/result`, 202, { id: newId(), status: "queued" }],
      [`/transcriptions/${ID}/result`, 200, { ...done, provider: "openai" }],
      [`/transcriptions/${ID}/result`, 200, { ...done, status: "processing" }],
      [`/transcriptions/${ID}/result`, 200, { ...done, text: undefined }],
      [`/transcriptions/${ID}/result`, 200, { ...done, stats: undefined }],
      [`/transcriptions/${ID}/result`, 200, { ...done, channels: 1 }],
      [`/transcriptions/${ID}/result`, 200, { ...done, speakers: [{ id: "channel_1", name: "Speaker 1", channel: 0 }] }],
      [`/transcriptions/${ID}/result`, 200, { ...done, segments: [{ ...done.segments[0], speaker_id: "channel_9" }] }],
      [`/transcriptions/${ID}/result`, 200, { ...done, segments: [{ ...done.segments[0], channel: 1 }] }],
      [`/transcriptions/${ID}/result`, 200, { ...done, segments: [{ ...done.segments[0], start: 5, end: 4 }] }],
      [`/transcriptions/${ID}/result`, 200, { status: "failed", error: null }],
      [`/transcriptions/${ID}/result`, 200, { status: "cancelled", error: { code: "made_up" } }],
    ];
    for (const [path, status, body] of cases) {
      ptx.state.override = () => ({ status, body });
      const r = await call(backend.url, "GET", path);
      expect([path, JSON.stringify(body).slice(0, 60), r.status, r.json.error.code]).toEqual([path, JSON.stringify(body).slice(0, 60), 502, "upstream_bad_response"]);
    }
    for (const body of [{ id: ID, status: "processing" }, { id: newId(), status: "cancelled" }, { id: ID }]) {
      ptx.state.override = () => ({ status: 200, body });
      const r = await call(backend.url, "POST", `/transcriptions/${ID}/cancel`);
      expect([r.status, r.json.error.code]).toEqual([502, "upstream_bad_response"]);
    }
    expect(backend.logs.every((l) => !l.line.includes("reason=") || l.line.includes("reason=off_contract"))).toBe(true);
  });
});

// ── Bounded upstream reads (Sol #2) ─────────────────────────────────

describe("bounded upstream reads", () => {
  test("a declared or streamed body over the route limit is upstream_bad_response; a transcript-sized result passes", async () => {
    const { ptx, backend } = await setup();
    const ID = "trn_0123456789ABCDEFGHJKMNPQRS";
    // Declared (express sets Content-Length) and just over the metadata limit.
    ptx.state.override = () => ({ status: 200, raw: "x".repeat(RESPONSE_LIMITS.get + 1) });
    const declared = await call(backend.url, "GET", `/transcriptions/${ID}`);
    expect([declared.status, declared.json.error.code]).toEqual([502, "upstream_bad_response"]);
    expect(backend.logs.at(-1)!.line).toContain("reason=body_too_large");
    // Streamed without Content-Length, past the result limit.
    ptx.state.override = () => ({ status: 200, chunked: { chunk: "y".repeat(64 * 1024), count: 128 } });
    const streamed = await call(backend.url, "GET", `/transcriptions/${ID}/result`);
    expect([streamed.status, streamed.json.error.code]).toEqual([502, "upstream_bad_response"]);
    expect(backend.logs.at(-1)!.line).toContain("reason=body_too_large");
    // An error body is capped the same way.
    ptx.state.override = () => ({ status: 503, chunked: { chunk: "z".repeat(64 * 1024), count: 4 } });
    expect((await call(backend.url, "GET", "/capabilities")).json.error.code).toBe("upstream_bad_response");
    // A ~1 MB two-hour transcript is well inside the result limit.
    const big = completedResult();
    big.segments = Array.from({ length: 4000 }, (_, i) => ({ id: `seg_${i}`, speaker_id: "channel_0", channel: 0, start: i, end: i + 1, text: "w".repeat(120) }));
    big.text = "w".repeat(500_000);
    ptx.state.override = () => ({ status: 200, body: big });
    const ok = await call(backend.url, "GET", `/transcriptions/${ID}/result`);
    expect(ok.status).toBe(200);
    expect(ok.json.segments).toHaveLength(4000);
  });

  test("the client refuses an oversized Content-Length unread and stops an endless stream at the cap", async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const client = createPtxClient({ baseUrl: "https://ptx.invalid", apiKey: PTX_KEY, fetchImpl: (async () => new Response(endless, { status: 200 })) as unknown as typeof fetch });
    await expect(client.request({ method: "GET", path: "/x", correlationId: randomUUID(), maxBytes: 64 * 1024 })).rejects.toBeInstanceOf(PtxResponseTooLargeError);
    expect(pulls).toBeLessThan(10);

    let read = false;
    // highWaterMark 0: nothing is pulled until someone actually reads.
    const guarded = new ReadableStream<Uint8Array>(
      {
        pull() {
          read = true;
          throw new Error("must not be read");
        },
      },
      { highWaterMark: 0 },
    );
    const declared = createPtxClient({
      baseUrl: "https://ptx.invalid",
      apiKey: PTX_KEY,
      fetchImpl: (async () => new Response(guarded, { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } })) as unknown as typeof fetch,
    });
    await expect(declared.request({ method: "GET", path: "/x", correlationId: randomUUID(), maxBytes: 64 * 1024 })).rejects.toBeInstanceOf(PtxResponseTooLargeError);
    expect(read).toBe(false);
    expect(RESPONSE_LIMITS.result).toBeGreaterThan(RESPONSE_LIMITS.list);
    expect(RESPONSE_LIMITS.list).toBeGreaterThan(RESPONSE_LIMITS.get);
  });
});

// ── Cache-Control, auth/CSRF exception, key separation, OpenAPI, canary (Sol #3–#7) ──

describe("no-store", () => {
  test("every answer under the mount is no-store; the hidden 404 stays identical to dark", async () => {
    const { ptx, backend } = await setup();
    const created = await create(backend.url);
    const id = created.json.id;
    await fetch(`${ptx.url}${created.json.upload.path}`, { method: "PUT", headers: { Authorization: `Bearer ${created.json.upload.capability}` }, body: AUDIO });
    const responses = [
      created,
      await call(backend.url, "GET", "/capabilities"),
      await call(backend.url, "GET", "/transcriptions"),
      await call(backend.url, "GET", `/transcriptions/${id}`),
      await call(backend.url, "GET", `/transcriptions/${id}`),
      await call(backend.url, "GET", `/transcriptions/${id}/result`),
      await call(backend.url, "GET", `/transcriptions/${newId()}`),
      await call(backend.url, "POST", "/transcriptions", { headers: { "Idempotency-Key": "nope" }, body: createBody() }),
      await call(backend.url, "DELETE", `/transcriptions/${id}`),
    ];
    expect(responses[5]!.json.text).toBe(TRANSCRIPT_TEXT);
    for (const r of responses) expect(r.headers.get("cache-control")).toBe("no-store");
    const hidden = await call(backend.url, "GET", "/capabilities", { as: ADDRESS_C });
    expect(hidden.headers.get("cache-control")).toBeNull();
  });
});

describe("auth and CSRF (documented exception to the error shape)", () => {
  test("401 and 403 csrf_rejected keep the backend-wide { error, message } shape, before the caller is known", async () => {
    const { backend } = await setup();
    const unauth = await call(backend.url, "GET", "/transcriptions", { as: null });
    expect(unauth.status).toBe(401);
    expect(Object.keys(unauth.json).sort()).toEqual(["error", "message"]);
    expect(typeof unauth.json.error).toBe("string");
    const csrf = await call(backend.url, "POST", "/transcriptions", { csrf: false, headers: { "Idempotency-Key": randomUUID() }, body: createBody() });
    expect([csrf.status, csrf.json.error]).toEqual([403, "csrf_rejected"]);
    for (const r of [unauth, csrf]) expect(r.headers.get("x-correlation-id")).toBeNull();
    const source = readFileSync(resolve(import.meta.dir, "../routes/private-cloud-transcription.ts"), "utf8");
    expect(source).toContain("Documented exception to the error shape");
    const spec = loadYaml(readFileSync(resolve(import.meta.dir, "../../openapi.yaml"), "utf8")) as any;
    expect(spec.paths[`${BASE}/capabilities`].get.description).toContain("EXCEPT 401");
  });
});

describe("credential separation", () => {
  test("armed, the batch key and tenant key must differ from the meeting TRANSCRIPTION_API_KEY", () => {
    const env = enabledEnv("https://ptx-batch.example");
    expect(() => privateCloudTranscriptionConfigFromEnv({ ...env, TRANSCRIPTION_API_KEY: PTX_KEY })).toThrow("distinct key from TRANSCRIPTION_API_KEY");
    expect(() => privateCloudTranscriptionConfigFromEnv({ ...env, TRANSCRIPTION_API_KEY: ` ${PTX_KEY} ` })).toThrow("TRANSCRIPTION_API_KEY");
    expect(() => privateCloudTranscriptionConfigFromEnv({ ...env, TRANSCRIPTION_API_KEY: TENANT_KEY })).toThrow("must not reuse TRANSCRIPTION_API_KEY");
    expect(privateCloudTranscriptionConfigFromEnv({ ...env, TRANSCRIPTION_API_KEY: "tc_live_meeting_key" }).enabled).toBe(true);
    expect(privateCloudTranscriptionConfigFromEnv({ ...env, TRANSCRIPTION_API_KEY: "" }).enabled).toBe(true);
  });
});

describe("served OpenAPI while dark", () => {
  test("drops every private-cloud path and PrivateCloud component, leaves no dangling $ref, and does not mutate the source", () => {
    const spec = loadYaml(readFileSync(resolve(import.meta.dir, "../../openapi.yaml"), "utf8")) as any;
    const before = JSON.stringify(spec);
    const dark = withoutPrivateCloudOpenApi(spec) as any;
    expect(JSON.stringify(spec)).toBe(before);
    const text = JSON.stringify(dark);
    expect(text).not.toContain("private-cloud");
    expect(text).not.toContain("PrivateCloud");
    const refs: string[] = [];
    (function walk(o: unknown) {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (k === "$ref") refs.push(v as string);
        else walk(v);
      }
    })(dark);
    for (const ref of refs) {
      const [, , section, name] = ref.split("/");
      expect(dark.components[section!][name!]).toBeDefined();
    }
    expect(Object.keys(dark.paths).length).toBe(Object.keys(spec.paths).filter((p: string) => !p.startsWith(BASE)).length);
    const index = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    expect(index).toContain("privateCloudTranscription.enabled ? fullSpec : withoutPrivateCloudOpenApi(fullSpec)");
  });
});

describe("deploy canary", () => {
  const root = resolve(import.meta.dir, "../../..");
  const workflow = loadYaml(readFileSync(resolve(root, ".github/workflows/deploy-backend-phala.yml"), "utf8")) as {
    jobs: { deploy: { steps: { name?: string; env?: Record<string, string>; run?: string }[] } };
  };
  const verify = workflow.jobs.deploy.steps.find((s) => s.name === "Verify public API")!;
  const run = verify.run!;
  const block = run.slice(run.indexOf("# >>> private-cloud canary"), run.indexOf("# <<< private-cloud canary"));

  test("the probe expects what this deploy shipped", () => {
    expect(verify.env!.PRIVATE_CLOUD_TRANSCRIPTION_ENABLED).toBe("${{ vars.PRIVATE_CLOUD_TRANSCRIPTION_ENABLED || 'false' }}");
    expect(block).toContain("/api/transcriber/private-cloud/capabilities");
  });

  test.each([
    ["true", "401", 0],
    ["true", "404", 1],
    ["false", "404", 0],
    ["false", "401", 1],
    ["", "404", 0],
  ])("flag=%p answered %s → exit %d", (flag, status, exit) => {
    const script = `curl() { printf '%s' "$STUB_STATUS"; }\nsleep() { :; }\n${block}`;
    const result = Bun.spawnSync(["/bin/bash", "-c", script], {
      env: { PRODUCTION_API_URL: "https://api.example", PRIVATE_CLOUD_TRANSCRIPTION_ENABLED: flag, STUB_STATUS: status },
    });
    expect(result.exitCode).toBe(exit);
  });
});
