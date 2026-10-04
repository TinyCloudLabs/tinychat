// Hosted AssemblyAI for Exo uploads (routes/assemblyai-hosted.ts; contract C10). Pinned here:
//   1. config: off when a key is unset, boot refused when a set value is weak, reused or malformed;
//   2. handles: forged, expired or another address's → 404 with no upstream call;
//   3. parts: bounds, exact lengths, idempotent re-PUT, owner, expiry, the 1 MiB raw cap;
//   4. allowance and concurrency: one upload per account (a new one replaces an unsent one),
//      a global cap, the daily allowance charged at create and refunded when abandoned;
//   5. the spool is gone after every outcome, and the sweep frees expired slots;
//   6. upstream answers map to fixed codes; AssemblyAI text never reaches the caller;
//   7. logs never carry the key, a handle, a transcript id or the address;
//   8. deploy wiring and the rate-limit bucket that one full-size upload fits in.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { load as loadYaml } from "js-yaml";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";

import { createHostedAssemblyAiClient } from "../../../frontend/src/lib/assemblyai.ts";
import { createUploadRunner, type PendingUpload, type UploadDeps } from "../../../frontend/src/lib/audioUpload.ts";

import { localValidationFromEnv } from "../local-validation.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { ASSEMBLYAI_HOSTED_UPLOAD_LIMIT, TRANSCRIBER_LIMIT, applyRateLimiters } from "../rate-limits.js";
import { ASSEMBLYAI_HOSTED_ERRORS, ASSEMBLYAI_HOSTED_MOUNT, createAssemblyAiHostedRouter, isHostedPartPath } from "../routes/assemblyai-hosted.js";
import {
  DEFAULT_DAILY_BYTES,
  HOSTED_PART_SIZE,
  HostedUploadStore,
  MAX_HOSTED_BYTES,
  SETTLED_TTL_MS,
  SUBMIT_DEADLINE_MS,
  UPLOAD_TTL_MS,
  assemblyAiHostedConfigFromEnv,
  issueHandle,
  type AssemblyAiHostedConfig,
} from "../services/assemblyai-hosted.js";

const SESSION_KEY = "synthetic-session-signing-key";
const API_KEY = "synthetic0assemblyai0server0key0abcdef";
const HANDLE_KEY = "Zk3Jm8V0t6n0bqK1i2Xz7cP4sWf9YhR5uLd2eA8gT1kM=";
const ADDRESS_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const TRANSCRIPT_ID = "6ca36708-a9e5-4195-b97c-2dbd098babbf";
const UPLOAD_URL = "https://cdn.assemblyai.com/upload/synthetic-upload-ref";
const UPSTREAM_DETAIL = "UPSTREAM-DETAIL account and audio info";
const T0 = Date.parse("2026-10-04T12:00:00Z");

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

type Upstream = { method: string; url: string; headers: Record<string, string>; body: Uint8Array | null; signal: AbortSignal | null };
type Answer = (call: Upstream) => Response | Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** AssemblyAI as it answers today: upload, create, read, sentences, delete. */
const assemblyAi: Answer = (call) => {
  if (call.url.endsWith("/v2/upload")) return json(200, { upload_url: UPLOAD_URL });
  if (call.url.endsWith("/v2/transcript") && call.method === "POST") return json(200, { id: TRANSCRIPT_ID, status: "queued", audio_url: UPLOAD_URL });
  if (call.url.endsWith("/sentences")) {
    return json(200, {
      sentences: [{ text: "Hello there.", start: 250, end: 1200, confidence: 0.9, speaker: "A", words: [{ text: "Hello" }], channel: null }],
      id: TRANSCRIPT_ID,
      confidence: 0.9,
      audio_duration: 60,
    });
  }
  if (call.method === "DELETE") return json(200, { id: TRANSCRIPT_ID, status: "completed" });
  return json(200, {
    id: TRANSCRIPT_ID,
    status: "completed",
    language_code: "en_us",
    audio_duration: 60,
    text: "Hello there. General Kenobi.",
    utterances: [
      { speaker: "A", start: 250, end: 1200, text: "Hello there.", confidence: 0.9, words: [{ text: "Hello" }] },
      { speaker: "B", start: 1300, end: 2400, text: "General Kenobi.", confidence: 0.9, words: [] },
    ],
    words: [{ text: "Hello" }],
    audio_url: UPLOAD_URL,
    webhook_url: "https://internal.example/hook",
    error: null,
    acoustic_model: "assemblyai_default",
  });
};

function hostedConfig(spoolDir: string, extra: Partial<{ dailyBytes: number }> = {}): AssemblyAiHostedConfig {
  return { hosted: true, apiKey: API_KEY, handleKey: HANDLE_KEY, dailyBytes: extra.dailyBytes ?? DEFAULT_DAILY_BYTES, spoolDir };
}

/** The app in index.ts's order: JSON parser (parts excluded) → CSRF → limiters → auth → router. */
async function setup(options: { answer?: Answer; config?: AssemblyAiHostedConfig | null; maxConcurrent?: number; dailyBytes?: number; onSubmit?: () => void; removeSpool?: typeof fsPromises.rm } = {}) {
  const spoolDir = mkdtempSync(join(tmpdir(), "tinychat-assemblyai-test-"));
  closers.push(() => rmSync(spoolDir, { recursive: true, force: true }));
  const config = options.config === null ? ({ hosted: false, reason: "both_unset" } as const) : (options.config ?? hostedConfig(spoolDir, { dailyBytes: options.dailyBytes }));
  const store = config.hosted ? new HostedUploadStore(config.spoolDir, config.dailyBytes, options.maxConcurrent ?? 4, options.removeSpool) : null;
  await store?.init();
  const clock = { now: T0 };
  const calls: Upstream[] = [];
  const logs: { line: string; alert: boolean }[] = [];
  const answer = options.answer ?? assemblyAi;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : typeof init?.body === "string" ? new TextEncoder().encode(init.body) : null;
    const call = { method: String(init?.method), url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body, signal: init?.signal ?? null };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  const app = express();
  const jsonParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => (isHostedPartPath(req.path) ? next() : jsonParser(req, res, next)));
  app.use(createCsrfMiddleware());
  applyRateLimiters(app);
  app.use(
    ASSEMBLYAI_HOSTED_MOUNT,
    createAuthMiddleware(SESSION_KEY),
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      if (req.method === "POST" && req.path === "/hosted/transcripts") options.onSubmit?.();
      next();
    },
    createAssemblyAiHostedRouter({ config, store, fetchImpl, now: () => clock.now, log: (line, alert) => logs.push({ line, alert }) }),
  );
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  closers.push(() => new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}${ASSEMBLYAI_HOSTED_MOUNT}`;
  const tokens = new Map<string, string>();
  const tokenFor = async (address: string) => {
    if (!tokens.has(address)) tokens.set(address, (await issueSessionToken(address, SESSION_KEY)).token);
    return tokens.get(address)!;
  };

  async function req(method: string, path: string, opts: { as?: string; body?: unknown; raw?: Uint8Array; contentType?: string } = {}) {
    const headers: Record<string, string> = { Authorization: `Bearer ${await tokenFor(opts.as ?? ADDRESS_A)}`, "X-Requested-With": "XMLHttpRequest" };
    let body: BodyInit | undefined;
    if (opts.raw) {
      headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
      body = opts.raw;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null, headers: response.headers };
  }

  async function createUpload(bytes: number, as = ADDRESS_A, contentType = "audio/mp4") {
    return req("POST", "/hosted/uploads", { as, body: { byte_size: bytes, content_type: contentType } });
  }

  /** Create, PUT every part, return the upload id. */
  async function upload(audio: Uint8Array, as = ADDRESS_A) {
    const created = await createUpload(audio.byteLength, as);
    expect(created.status).toBe(201);
    const id = created.json.upload_id as string;
    for (let i = 0; i * HOSTED_PART_SIZE < audio.byteLength; i++) {
      const part = await req("PUT", `/hosted/uploads/${id}/parts/${i}`, { as, raw: audio.subarray(i * HOSTED_PART_SIZE, (i + 1) * HOSTED_PART_SIZE) });
      expect(part.status).toBe(204);
    }
    return id;
  }

  /** POST the submit (202 at once), let the background settle, return the polled upload view. */
  async function submit(id: string, as = ADDRESS_A, speakerLabels = true) {
    const started = await req("POST", "/hosted/transcripts", { as, body: { upload_id: id, speaker_labels: speakerLabels } });
    expect([started.status, started.json.upload_id]).toEqual([202, id]);
    await store!.idle();
    return (await req("GET", `/hosted/uploads/${id}`, { as })).json;
  }

  return { base, tokenFor, req, createUpload, upload, submit, calls, logs, clock, store, spoolDir, spoolFiles: () => readdirSync(spoolDir) };
}

function audio(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

// ── Config ──────────────────────────────────────────────────────────

describe("config", () => {
  const good = { ASSEMBLYAI_API_KEY: API_KEY, ASSEMBLYAI_HOSTED_HANDLE_KEY: HANDLE_KEY };

  test("both keys set is hosted with the documented defaults; either unset is off", () => {
    const on = assemblyAiHostedConfigFromEnv(good);
    expect(on).toMatchObject({ hosted: true, dailyBytes: 362_880_000, spoolDir: join(tmpdir(), "tinychat-assemblyai") });
    expect(assemblyAiHostedConfigFromEnv({})).toEqual({ hosted: false, reason: "both_unset" });
    expect(assemblyAiHostedConfigFromEnv({ ASSEMBLYAI_API_KEY: API_KEY })).toEqual({ hosted: false, reason: "handle_key_unset" });
    expect(assemblyAiHostedConfigFromEnv({ ASSEMBLYAI_HOSTED_HANDLE_KEY: HANDLE_KEY })).toEqual({ hosted: false, reason: "api_key_unset" });
  });

  test("a set but unusable value refuses boot, naming the variable and never the value", () => {
    const cases: [Record<string, string>, string][] = [
      [{ ASSEMBLYAI_HOSTED_HANDLE_KEY: "short-weak-value" }, "ASSEMBLYAI_HOSTED_HANDLE_KEY"],
      [{ ASSEMBLYAI_HOSTED_HANDLE_KEY: "changeme" }, "ASSEMBLYAI_HOSTED_HANDLE_KEY"],
      [{ ASSEMBLYAI_API_KEY: HANDLE_KEY }, "must not reuse ASSEMBLYAI_API_KEY"],
      [{ PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY: HANDLE_KEY }, "must not reuse PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY"],
      [{ BACKEND_PRIVATE_KEY: HANDLE_KEY }, "must not reuse BACKEND_PRIVATE_KEY"],
      [{ ASSEMBLYAI_API_KEY: "two words" }, "ASSEMBLYAI_API_KEY"],
      [{ ASSEMBLYAI_HOSTED_DAILY_BYTES: "lots" }, "ASSEMBLYAI_HOSTED_DAILY_BYTES"],
      [{ ASSEMBLYAI_HOSTED_DAILY_BYTES: "0" }, "ASSEMBLYAI_HOSTED_DAILY_BYTES"],
      [{ ASSEMBLYAI_HOSTED_SPOOL_DIR: "relative/spool" }, "ASSEMBLYAI_HOSTED_SPOOL_DIR"],
    ];
    for (const [patch, message] of cases) {
      let thrown: Error | null = null;
      try {
        assemblyAiHostedConfigFromEnv({ ...good, ...patch });
      } catch (error) {
        thrown = error as Error;
      }
      expect([Object.keys(patch)[0], thrown?.message ?? ""]).toEqual([Object.keys(patch)[0], expect.stringContaining(message)]);
      for (const value of [API_KEY, HANDLE_KEY, "short-weak-value"]) expect(thrown!.message).not.toContain(value);
    }
    expect(assemblyAiHostedConfigFromEnv({ ...good, ASSEMBLYAI_HOSTED_DAILY_BYTES: "1000" })).toMatchObject({ dailyBytes: 1000 });
  });

  test("local validation refuses to run with either AssemblyAI server secret set", () => {
    const local = { TINYCHAT_LOCAL_VALIDATION: "true", NODE_ENV: "development", FRONTEND_URL: "http://localhost:5173", ELIZA_SERVICE_URL: "http://localhost:9" };
    expect(localValidationFromEnv(local)).toBe(true);
    expect(() => localValidationFromEnv({ ...local, ASSEMBLYAI_API_KEY: API_KEY })).toThrow("ASSEMBLYAI_API_KEY unset");
    expect(() => localValidationFromEnv({ ...local, ASSEMBLYAI_HOSTED_HANDLE_KEY: HANDLE_KEY })).toThrow("ASSEMBLYAI_HOSTED_HANDLE_KEY unset");
  });
});

// ── Capabilities and the off switch ─────────────────────────────────

describe("capabilities", () => {
  test("hosted: limits, the six types and this account's remaining allowance", async () => {
    const h = await setup();
    const caps = await h.req("GET", "/capabilities");
    expect(caps.json).toEqual({
      hosted: true,
      max_bytes: 120_960_000,
      part_size: 1_048_576,
      content_types: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm", "audio/flac"],
      daily_bytes_remaining: 362_880_000,
    });
    expect(caps.headers.get("cache-control")).toBe("no-store");
    await h.createUpload(5_000_000);
    expect((await h.req("GET", "/capabilities")).json.daily_bytes_remaining).toBe(357_880_000);
    expect((await h.req("GET", "/capabilities", { as: ADDRESS_B })).json.daily_bytes_remaining).toBe(362_880_000);
  });

  test("off: capabilities say so and every hosted route is 503 without calling AssemblyAI", async () => {
    const h = await setup({ config: null });
    expect((await h.req("GET", "/capabilities")).json).toMatchObject({ hosted: false, daily_bytes_remaining: null });
    const handle = issueHandle(HANDLE_KEY, TRANSCRIPT_ID, ADDRESS_A, T0);
    for (const [method, path] of [
      ["POST", "/hosted/uploads"],
      ["PUT", "/hosted/uploads/aau_x/parts/0"],
      ["POST", "/hosted/transcripts"],
      ["GET", `/hosted/transcripts/${handle}`],
      ["DELETE", `/hosted/transcripts/${handle}`],
    ] as const) {
      const r = await h.req(method, path, method === "GET" ? {} : { body: {} });
      expect([path, r.status, r.json.error]).toEqual([path, 503, "assemblyai_hosted_unavailable"]);
    }
    expect(h.calls).toHaveLength(0);
  });
});

// ── The happy path, end to end ──────────────────────────────────────

describe("hosted flow", () => {
  test("parts → one streamed upload with the server key → transcript → handle reads and delete", async () => {
    const h = await setup();
    const bytes = audio(2 * HOSTED_PART_SIZE + 12_345);
    const created = await h.createUpload(bytes.byteLength);
    expect(created.status).toBe(201);
    expect(Object.keys(created.json).sort()).toEqual(["expires_at", "part_size", "upload_id"]);
    expect(created.json.part_size).toBe(HOSTED_PART_SIZE);
    expect(created.json.expires_at).toBe(new Date(T0 + UPLOAD_TTL_MS).toISOString());
    // Spool file: 0600 inside a 0700 dir.
    expect(statSync(h.spoolDir).mode & 0o777).toBe(0o700);
    expect(h.spoolFiles()).toHaveLength(1);
    expect(statSync(join(h.spoolDir, h.spoolFiles()[0]!)).mode & 0o777).toBe(0o600);
    const id = created.json.upload_id;
    // Out of order is fine; each part lands at index × part_size.
    for (const i of [2, 0, 1]) {
      const r = await h.req("PUT", `/hosted/uploads/${id}/parts/${i}`, { raw: bytes.subarray(i * HOSTED_PART_SIZE, (i + 1) * HOSTED_PART_SIZE) });
      expect(r.status).toBe(204);
    }
    expect((await h.req("GET", `/hosted/uploads/${id}`)).json).toEqual({ status: "receiving" });
    const started = await h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } });
    expect([started.status, started.json]).toEqual([202, { upload_id: id, status: "submitting" }]);
    await h.store!.idle();
    const polled = await h.req("GET", `/hosted/uploads/${id}`);
    expect(Object.keys(polled.json).sort()).toEqual(["id", "status"]);
    expect(polled.json.status).toBe("submitted");
    const handle = polled.json.id as string;
    expect(handle).toMatch(/^aah1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(handle).not.toContain(TRANSCRIPT_ID);
    // A replay (a reloaded client) answers where it got to, and starts nothing new.
    const replay = await h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } });
    expect([replay.status, replay.json]).toEqual([202, { upload_id: id, status: "submitted", id: handle }]);
    // Another account cannot see it.
    expect((await h.req("GET", `/hosted/uploads/${id}`, { as: ADDRESS_B })).status).toBe(404);
    expect(h.calls.filter((c) => c.url.endsWith("/v2/upload"))).toHaveLength(1);

    const [sent, create] = h.calls;
    expect([sent!.method, sent!.url]).toEqual(["POST", "https://api.assemblyai.com/v2/upload"]);
    expect(sent!.headers.authorization).toBe(API_KEY);
    expect(Buffer.from(sent!.body!).equals(Buffer.from(bytes))).toBe(true);
    expect([create!.method, create!.url]).toEqual(["POST", "https://api.assemblyai.com/v2/transcript"]);
    expect(JSON.parse(new TextDecoder().decode(create!.body!))).toEqual({
      audio_url: UPLOAD_URL,
      speaker_labels: true,
      language_detection: true,
      speech_models: ["universal-3-5-pro", "universal-2"],
    });
    expect(h.spoolFiles()).toEqual([]);

    const read = await h.req("GET", `/hosted/transcripts/${handle}`);
    expect(read.json).toEqual({
      id: handle,
      status: "completed",
      error: null,
      language_code: "en_us",
      audio_duration: 60,
      text: "Hello there. General Kenobi.",
      utterances: [
        { speaker: "A", start: 250, end: 1200, text: "Hello there." },
        { speaker: "B", start: 1300, end: 2400, text: "General Kenobi." },
      ],
    });
    expect(h.calls.at(-1)!.url).toBe(`https://api.assemblyai.com/v2/transcript/${TRANSCRIPT_ID}`);
    expect((await h.req("GET", `/hosted/transcripts/${handle}/sentences`)).json).toEqual({
      sentences: [{ start: 250, end: 1200, text: "Hello there.", speaker: "A" }],
    });
    const del = await h.req("DELETE", `/hosted/transcripts/${handle}`);
    expect([del.status, del.text]).toEqual([204, ""]);
    expect([h.calls.at(-1)!.method, h.calls.at(-1)!.url, h.calls.at(-1)!.headers.authorization]).toEqual([
      "DELETE",
      `https://api.assemblyai.com/v2/transcript/${TRANSCRIPT_ID}`,
      API_KEY,
    ]);
    // The slot is free again: the next upload is accepted.
    expect((await h.createUpload(10)).status).toBe(201);
  });

  test("a failed transcript reports our fixed error text, never AssemblyAI's", async () => {
    const h = await setup({ answer: () => json(200, { id: TRANSCRIPT_ID, status: "error", error: UPSTREAM_DETAIL, text: null, utterances: null }) });
    const handle = issueHandle(HANDLE_KEY, TRANSCRIPT_ID, ADDRESS_A, T0);
    const r = await h.req("GET", `/hosted/transcripts/${handle}`);
    expect(r.json).toMatchObject({ status: "error", error: "AssemblyAI could not transcribe this recording.", text: null, utterances: null });
    expect(r.text).not.toContain("UPSTREAM-DETAIL");
  });
});

// ── Handles ─────────────────────────────────────────────────────────

describe("handles", () => {
  test("forged, tampered, expired or another address's handle is 404 and AssemblyAI is never asked", async () => {
    const h = await setup();
    const good = issueHandle(HANDLE_KEY, TRANSCRIPT_ID, ADDRESS_A, T0);
    const [prefix, payload, signature] = good.split(".");
    const otherPayload = Buffer.from(JSON.stringify({ t: "11111111-2222-3333-4444-555555555555", a: ADDRESS_A, e: T0 / 1000 + 3600 })).toString("base64url");
    const flipped = `${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;
    const bad = [
      issueHandle("another-handle-key-that-is-long-enough-000", TRANSCRIPT_ID, ADDRESS_A, T0),
      `${prefix}.${otherPayload}.${signature}`,
      `${prefix}.${payload}.${flipped}`,
      `aah2.${payload}.${signature}`,
      `${prefix}.${payload}`,
      "not-a-handle",
      TRANSCRIPT_ID,
      `${prefix}.${payload}.${signature}.extra`,
      "a".repeat(600),
    ];
    for (const handle of bad) {
      for (const [method, suffix] of [["GET", ""], ["GET", "/sentences"], ["DELETE", ""]] as const) {
        const r = await h.req(method, `/hosted/transcripts/${encodeURIComponent(handle)}${suffix}`);
        expect([handle.slice(0, 24), r.status, r.json?.error]).toEqual([handle.slice(0, 24), 404, "assemblyai_transcript_not_found"]);
      }
    }
    // Issued to A: B gets the same 404.
    expect((await h.req("GET", `/hosted/transcripts/${good}`, { as: ADDRESS_B })).status).toBe(404);
    // Seven days later it has expired, even for A.
    h.clock.now = T0 + 7 * 24 * 3600 * 1000;
    expect((await h.req("GET", `/hosted/transcripts/${good}`)).status).toBe(404);
    expect(h.calls).toHaveLength(0);
    h.clock.now = T0 + 7 * 24 * 3600 * 1000 - 1000;
    expect((await h.req("GET", `/hosted/transcripts/${good}`)).status).toBe(200);
  });
});

// ── Uploads and parts ───────────────────────────────────────────────

describe("uploads and parts", () => {
  test("create validates size and type before reserving anything", async () => {
    const h = await setup();
    const cases: [unknown, number, string][] = [
      [{ byte_size: MAX_HOSTED_BYTES + 1, content_type: "audio/mp4" }, 413, "recording_too_large"],
      [{ byte_size: 10, content_type: "video/mp4" }, 415, "unsupported_audio"],
      [{ byte_size: 10, content_type: "audio/aac" }, 415, "unsupported_audio"],
      [{ byte_size: 0, content_type: "audio/mp4" }, 400, "invalid_request"],
      [{ byte_size: 1.5, content_type: "audio/mp4" }, 400, "invalid_request"],
      [{ byte_size: "10", content_type: "audio/mp4" }, 400, "invalid_request"],
      [[], 400, "invalid_request"],
    ];
    for (const [body, status, code] of cases) {
      const r = await h.req("POST", "/hosted/uploads", { body });
      expect([JSON.stringify(body), r.status, r.json]).toEqual([JSON.stringify(body), status, { error: code, message: ASSEMBLYAI_HOSTED_ERRORS[code as keyof typeof ASSEMBLYAI_HOSTED_ERRORS].message }]);
    }
    expect(h.spoolFiles()).toEqual([]);
    expect((await h.createUpload(MAX_HOSTED_BYTES)).status).toBe(201);
  });

  test("part index and length are exact; a re-PUT of the same index is fine", async () => {
    const h = await setup();
    const size = HOSTED_PART_SIZE + 100;
    const bytes = audio(size);
    const id = (await h.createUpload(size)).json.upload_id;
    const put = (index: string, raw: Uint8Array, contentType?: string) => h.req("PUT", `/hosted/uploads/${id}/parts/${index}`, { raw, ...(contentType ? { contentType } : {}) });
    const cases: [string, Uint8Array, string | undefined][] = [
      ["2", bytes.subarray(0, 100), undefined], // past the last part
      ["-1", bytes.subarray(0, 100), undefined],
      ["1.0", bytes.subarray(0, 100), undefined],
      ["01x", bytes.subarray(0, 100), undefined],
      ["0", bytes.subarray(0, 100), undefined], // a short non-final part
      ["1", bytes.subarray(0, 101), undefined], // the last part one byte long
      ["1", bytes.subarray(0, 100), "application/json"], // not a raw body
      ["0", audio(HOSTED_PART_SIZE + 1), undefined], // over the 1 MiB cap
    ];
    for (const [index, raw, type] of cases) {
      const r = await put(index, raw, type);
      expect([index, raw.byteLength, r.status, r.json.error]).toEqual([index, raw.byteLength, 400, "invalid_request"]);
    }
    expect((await put("0", bytes.subarray(0, HOSTED_PART_SIZE))).status).toBe(204);
    expect((await put("0", bytes.subarray(0, HOSTED_PART_SIZE))).status).toBe(204);
    // Not every part yet.
    const early = await h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: false } });
    expect([early.status, early.json.error]).toEqual([409, "assemblyai_upload_incomplete"]);
    expect((await put("1", bytes.subarray(HOSTED_PART_SIZE))).status).toBe(204);
    expect((await h.submit(id)).status).toBe("submitted");
    expect(Buffer.from(h.calls[0]!.body!).equals(Buffer.from(bytes))).toBe(true);
    // Sent: no more parts, and nothing to abandon.
    const late = await put("0", bytes.subarray(0, HOSTED_PART_SIZE));
    expect([late.status, late.json.error]).toEqual([409, "assemblyai_upload_in_progress"]);
  });

  test("another account's or an unknown upload is 404; an expired one is 410, then the sweep frees it", async () => {
    const h = await setup();
    const id = (await h.createUpload(100)).json.upload_id;
    const part = audio(100);
    for (const [as, upload] of [[ADDRESS_B, id], [ADDRESS_A, "aau_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"], [ADDRESS_A, "..%2F..%2Fetc"]] as const) {
      const r = await h.req("PUT", `/hosted/uploads/${upload}/parts/0`, { as, raw: part });
      expect([r.status, r.json.error]).toEqual([404, "assemblyai_upload_not_found"]);
      const t = await h.req("POST", "/hosted/transcripts", { as, body: { upload_id: upload, speaker_labels: true } });
      expect([t.status, t.json.error]).toEqual([404, "assemblyai_upload_not_found"]);
      expect((await h.req("DELETE", `/hosted/uploads/${upload}`, { as })).status).toBe(404);
    }
    h.clock.now = T0 + UPLOAD_TTL_MS;
    expect((await h.req("PUT", `/hosted/uploads/${id}/parts/0`, { raw: part })).status).toBe(410);
    expect(h.spoolFiles()).toHaveLength(1);
    expect(await h.store!.sweep(h.clock.now)).toBe(1);
    expect(h.spoolFiles()).toEqual([]);
    expect(h.store!.activeCount).toBe(0);
    // Still 410 to its owner after the sweep; still 404 to anyone else.
    expect((await h.req("PUT", `/hosted/uploads/${id}/parts/0`, { raw: part })).status).toBe(410);
    expect((await h.req("PUT", `/hosted/uploads/${id}/parts/0`, { as: ADDRESS_B, raw: part })).status).toBe(404);
    expect(h.calls).toHaveLength(0);
  });

  test("a restart's leftovers are removed when the store starts", async () => {
    const h = await setup();
    await h.createUpload(100);
    expect(h.spoolFiles()).toHaveLength(1);
    await new HostedUploadStore(h.spoolDir, DEFAULT_DAILY_BYTES, 4).init();
    expect(h.spoolFiles()).toEqual([]);
  });
});

// ── Allowance and concurrency ───────────────────────────────────────

describe("allowance and concurrency", () => {
  test("a new upload replaces the account's unsent one (refunded); DELETE abandons one", async () => {
    const h = await setup({ dailyBytes: 1000 });
    const first = (await h.createUpload(600)).json.upload_id;
    const second = await h.createUpload(600);
    expect(second.status).toBe(201);
    expect(h.spoolFiles()).toHaveLength(1);
    expect((await h.req("PUT", `/hosted/uploads/${first}/parts/0`, { raw: audio(600) })).status).toBe(404);
    expect((await h.req("GET", "/capabilities")).json.daily_bytes_remaining).toBe(400);
    const del = await h.req("DELETE", `/hosted/uploads/${second.json.upload_id}`);
    expect([del.status, del.text]).toEqual([204, ""]);
    expect(h.spoolFiles()).toEqual([]);
    expect((await h.req("GET", "/capabilities")).json.daily_bytes_remaining).toBe(1000);
  });

  test("the daily allowance is charged at create and resets at UTC midnight", async () => {
    const h = await setup({ dailyBytes: 1000 });
    const id = await h.upload(audio(700));
    expect((await h.submit(id)).status).toBe("submitted");
    const over = await h.createUpload(301);
    expect([over.status, over.json.error]).toEqual([429, "assemblyai_quota_exceeded"]);
    // 12:00 UTC → 12 h to midnight.
    expect([over.json.retry_after_seconds, over.headers.get("retry-after")]).toEqual([43_200, "43200"]);
    expect((await h.createUpload(300)).status).toBe(201);
    expect((await h.createUpload(10, ADDRESS_B)).status).toBe(201);
    h.clock.now = T0 + 12 * 3600 * 1000;
    await h.store!.sweep(h.clock.now);
    expect((await h.req("GET", "/capabilities")).json.daily_bytes_remaining).toBe(1000);
  });

  test("a global cap on concurrent uploads, and none beside one being sent", async () => {
    const sendStarted = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const h = await setup({
      maxConcurrent: 2,
      answer: async (call) => {
        if (call.url.endsWith("/v2/upload")) {
          sendStarted.resolve();
          await gate.promise;
        }
        return assemblyAi(call);
      },
    });
    expect((await h.createUpload(10, ADDRESS_A)).status).toBe(201);
    expect((await h.createUpload(10, ADDRESS_B)).status).toBe(201);
    const third = await h.createUpload(10, ADDRESS_C);
    expect([third.status, third.json.error, Number(third.headers.get("retry-after")) > 0]).toEqual([429, "assemblyai_busy", true]);
    // Replacing one's own unsent upload takes no new slot.
    expect((await h.createUpload(10, ADDRESS_B)).status).toBe(201);
    expect(h.store!.activeCount).toBe(2);

    // While A's upload is being sent, A cannot start another; a repeated submit just reports it.
    const a = (await h.createUpload(10, ADDRESS_A)).json.upload_id;
    expect((await h.req("PUT", `/hosted/uploads/${a}/parts/0`, { raw: audio(10) })).status).toBe(204);
    const started = await h.req("POST", "/hosted/transcripts", { body: { upload_id: a, speaker_labels: true } });
    expect([started.status, started.json]).toEqual([202, { upload_id: a, status: "submitting" }]);
    await sendStarted.promise;
    expect((await h.req("GET", `/hosted/uploads/${a}`)).json).toEqual({ status: "submitting" });
    const blocked = await h.createUpload(10, ADDRESS_A);
    expect([blocked.status, blocked.json.error, blocked.headers.get("retry-after")]).toEqual([429, "assemblyai_busy", "30"]);
    const twice = await h.req("POST", "/hosted/transcripts", { body: { upload_id: a, speaker_labels: true } });
    expect([twice.status, twice.json]).toEqual([202, { upload_id: a, status: "submitting" }]);
    const abandon = await h.req("DELETE", `/hosted/uploads/${a}`);
    expect([abandon.status, abandon.json.error]).toEqual([409, "assemblyai_upload_in_progress"]);
    gate.resolve();
    await h.store!.idle();
    expect((await h.req("GET", `/hosted/uploads/${a}`)).json.status).toBe("submitted");
    expect(h.calls.filter((c) => c.url.endsWith("/v2/upload"))).toHaveLength(1);
    expect((await h.createUpload(10, ADDRESS_A)).status).toBe(201);
  });
});

// ── Upstream mapping and the spool on every outcome ─────────────────

describe("upstream failures", () => {
  // [name, answer for the upload call, the failed outcome's code, alert]
  const UPLOAD_FAILURES: [string, Answer, string, boolean][] = [
    ["server key refused (401)", () => json(401, { error: UPSTREAM_DETAIL }), "assemblyai_unavailable", true],
    ["server key refused (403)", () => json(403, { error: UPSTREAM_DETAIL }), "assemblyai_unavailable", true],
    ["rate limited", () => json(429, { error: UPSTREAM_DETAIL }, { "Retry-After": "17" }), "assemblyai_rate_limited", false],
    ["server error", () => json(500, { error: UPSTREAM_DETAIL }), "assemblyai_unavailable", false],
    ["off-contract success", () => json(200, { upload_url: "http://plain.example/x" }), "assemblyai_unavailable", false],
    ["network error", () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_DETAIL}`)), "assemblyai_unavailable", false],
  ];

  test.each(UPLOAD_FAILURES)("background upload: %s → failed outcome, spool deleted, slot freed", async (_name, failing, code, alert) => {
    const h = await setup({ answer: (call) => (call.url.endsWith("/v2/upload") ? failing(call) : assemblyAi(call)) });
    const id = await h.upload(audio(50));
    const outcome = await h.submit(id);
    expect(outcome).toEqual({ status: "failed", error: { code, message: ASSEMBLYAI_HOSTED_ERRORS[code as keyof typeof ASSEMBLYAI_HOSTED_ERRORS].message } });
    expect(JSON.stringify(outcome)).not.toContain("UPSTREAM-DETAIL");
    expect(h.spoolFiles()).toEqual([]);
    expect(h.store!.activeCount).toBe(0);
    const last = h.logs.at(-1)!;
    expect(last.line).toStartWith("[assemblyai-hosted] route=submit ");
    expect([last.alert, last.line.includes("alert=true")]).toEqual([alert, alert]);
    // A failed upload is settled: a replay reports the failure; a new upload is the retry.
    expect((await h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } })).json.status).toBe("failed");
    expect((await h.createUpload(50)).status).toBe(201);
  });

  test("a submit past its deadline is aborted by the sweep and settles failed, spool deleted", async () => {
    const h = await setup({
      answer: (call) =>
        call.url.endsWith("/v2/upload")
          ? new Promise<Response>((_resolve, reject) => call.signal!.addEventListener("abort", () => reject(call.signal!.reason)))
          : assemblyAi(call),
    });
    const id = await h.upload(audio(50));
    expect((await h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } })).status).toBe(202);
    h.clock.now = T0 + SUBMIT_DEADLINE_MS - 1;
    await h.store!.sweep(h.clock.now);
    expect((await h.req("GET", `/hosted/uploads/${id}`)).json).toEqual({ status: "submitting" });
    h.clock.now = T0 + SUBMIT_DEADLINE_MS;
    await h.store!.sweep(h.clock.now);
    await h.store!.idle();
    expect((await h.req("GET", `/hosted/uploads/${id}`)).json).toMatchObject({ status: "failed", error: { code: "assemblyai_unavailable" } });
    expect(h.spoolFiles()).toEqual([]);
    expect(h.logs.at(-1)!.line).toContain("reason=aborted");
  });

  test("the claimed outcome stays readable for an hour, then becomes a tombstone", async () => {
    const h = await setup();
    const id = await h.upload(audio(50));
    expect((await h.submit(id)).status).toBe("submitted");
    h.clock.now = T0 + SETTLED_TTL_MS - 1;
    expect((await h.req("GET", `/hosted/uploads/${id}`)).json.status).toBe("submitted");
    h.clock.now = T0 + SETTLED_TTL_MS;
    await h.store!.sweep(h.clock.now);
    expect((await h.req("GET", `/hosted/uploads/${id}`)).status).toBe(410);
  });

  test("a refused transcript create settles failed (an AssemblyAI 400 is our drift: alert) and the spool is still gone", async () => {
    for (const [answer, code, alert] of [
      [json(400, { error: UPSTREAM_DETAIL }), "assemblyai_unavailable", true],
      [json(401, { error: UPSTREAM_DETAIL }), "assemblyai_unavailable", true],
      [json(429, { error: UPSTREAM_DETAIL }), "assemblyai_rate_limited", false],
      [json(200, { id: "../x", status: "queued" }), "assemblyai_unavailable", false],
    ] as const) {
      const h = await setup({ answer: (call) => (call.url.endsWith("/v2/transcript") ? answer.clone() : assemblyAi(call)) });
      const id = await h.upload(audio(50));
      const outcome = await h.submit(id);
      const submitLog = h.logs.find((l) => l.line.includes("route=submit"))!;
      expect([outcome.status, outcome.error?.code, submitLog.alert]).toEqual(["failed", code, alert]);
      expect(h.spoolFiles()).toEqual([]);
      expect(h.store!.activeCount).toBe(0);
    }
  });

  test("reads and delete: AssemblyAI's not-found answers, a refused key, off-contract bodies", async () => {
    const handle = issueHandle(HANDLE_KEY, TRANSCRIPT_ID, ADDRESS_A, T0);
    const notFound400 = () => json(400, { error: "Transcript lookup error, transcript id not found" });
    const cases: [string, string, Answer, number, string | null][] = [
      ["GET", "", notFound400, 404, "assemblyai_transcript_not_found"],
      ["GET", "", () => json(404, {}), 404, "assemblyai_transcript_not_found"],
      ["GET", "/sentences", notFound400, 404, "assemblyai_transcript_not_found"],
      ["GET", "", () => json(401, {}), 502, "assemblyai_unavailable"],
      ["GET", "", () => json(429, {}, { "Retry-After": "5" }), 429, "assemblyai_rate_limited"],
      ["GET", "", () => json(400, { error: UPSTREAM_DETAIL }), 502, "assemblyai_unavailable"],
      ["GET", "", () => json(200, { status: "exploded" }), 502, "assemblyai_unavailable"],
      ["GET", "", () => json(200, { status: "completed", utterances: [{ speaker: "A", start: 9, end: 2, text: "x" }] }), 502, "assemblyai_unavailable"],
      ["GET", "/sentences", () => json(200, { sentences: "nope" }), 502, "assemblyai_unavailable"],
      ["DELETE", "", notFound400, 204, null],
      ["DELETE", "", () => json(404, {}), 204, null],
      ["DELETE", "", () => json(403, {}), 502, "assemblyai_unavailable"],
      ["DELETE", "", () => json(500, { error: UPSTREAM_DETAIL }), 502, "assemblyai_unavailable"],
    ];
    for (const [method, suffix, answer, status, code] of cases) {
      const h = await setup({ answer });
      const r = await h.req(method, `/hosted/transcripts/${handle}${suffix}`);
      expect([method, suffix, r.status, r.json?.error ?? null]).toEqual([method, suffix, status, code]);
      expect(r.text).not.toContain("UPSTREAM-DETAIL");
    }
  });
});

// ── Logs ────────────────────────────────────────────────────────────

describe("logs", () => {
  test("carry route, status, code and correlation id: never the key, a handle, a transcript id or the address", async () => {
    const h = await setup();
    const id = await h.upload(audio(HOSTED_PART_SIZE + 10));
    const handle = (await h.submit(id)).id as string;
    await h.req("GET", `/hosted/transcripts/${handle}`);
    await h.req("DELETE", `/hosted/transcripts/${handle}`);
    await h.req("GET", `/hosted/transcripts/${handle}`, { as: ADDRESS_B });
    await h.req("PUT", `/hosted/uploads/${id}/parts/9`, { raw: audio(1) });
    const all = h.logs.map((l) => l.line).join("\n");
    expect(all).toContain("route=create_upload status=201");
    expect(all).toContain("route=create_transcript status=202");
    expect(all).toContain("route=submit status=201 bytes=");
    expect(all).toContain("route=delete_transcript status=204");
    expect(all).toContain("code=assemblyai_transcript_not_found");
    for (const secret of [API_KEY, HANDLE_KEY, handle, handle.split(".")[1]!, TRANSCRIPT_ID, ADDRESS_A, ADDRESS_B.slice(2), id, UPLOAD_URL]) {
      expect(all.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    for (const { line } of h.logs) expect(line).toMatch(/^\[assemblyai-hosted\] route=[a-z_]+ status=\d{3}( [a-z_]+=[A-Za-z0-9_]+)* cid=[0-9a-f-]{36}$/);
  });
});

// ── Rate limits and deploy wiring ───────────────────────────────────

describe("rate limits", () => {
  test("one full-size upload fits the parts bucket, which is not the polling bucket", async () => {
    const parts = Math.ceil(MAX_HOSTED_BYTES / HOSTED_PART_SIZE);
    expect(parts).toBe(116);
    // Create + every part, for more than one upload per window.
    expect(ASSEMBLYAI_HOSTED_UPLOAD_LIMIT).toBeGreaterThanOrEqual(3 * (parts + 1));
    const h = await setup();
    const id = (await h.createUpload(10)).json.upload_id;
    const part = await h.req("PUT", `/hosted/uploads/${id}/parts/0`, { raw: audio(10) });
    expect(part.headers.get("ratelimit-policy")).toContain(`${ASSEMBLYAI_HOSTED_UPLOAD_LIMIT};w=900`);
    expect((await h.req("GET", "/capabilities")).headers.get("ratelimit-policy")).toContain(`${TRANSCRIBER_LIMIT};w=900`);
  });
});

describe("Phala deploy environment", () => {
  const KEYS = ["ASSEMBLYAI_API_KEY", "ASSEMBLYAI_HOSTED_HANDLE_KEY"] as const;
  const repoRoot = resolve(import.meta.dir, "../../..");

  test("the deploy workflow writes both secrets, compose passes them through, .env.example documents all four vars", () => {
    const workflow = loadYaml(readFileSync(resolve(repoRoot, ".github/workflows/deploy-backend-phala.yml"), "utf8")) as {
      jobs?: { deploy?: { steps?: { env?: Record<string, unknown>; run?: string }[] } };
    };
    const writer = workflow.jobs?.deploy?.steps?.find((s) => typeof s.run === "string" && s.run.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'));
    const compose = loadYaml(readFileSync(resolve(repoRoot, "docker-compose.phala.yml"), "utf8")) as {
      services?: Record<string, { environment?: Record<string, string> }>;
    };
    const env = compose.services?.["tinychat-backend"]?.environment ?? {};
    const example = readFileSync(resolve(repoRoot, "backend/.env.example"), "utf8");
    for (const key of KEYS) {
      expect(String(writer?.env?.[key])).toBe(`\${{ secrets.${key} }}`);
      expect(writer?.run).toContain(`"${key}=$${key}"`);
      expect(env[key]).toBe(`\${${key}:-}`);
    }
    for (const key of [...KEYS, "ASSEMBLYAI_HOSTED_DAILY_BYTES", "ASSEMBLYAI_HOSTED_SPOOL_DIR"]) expect(example).toMatch(new RegExp(`^${key}=$`, "m"));
  });
});

describe("openapi", () => {
  test("the documented error codes are exactly the route's, and every hosted operation needs a session", () => {
    const spec = loadYaml(readFileSync(resolve(import.meta.dir, "../../openapi.yaml"), "utf8")) as {
      paths: Record<string, Record<string, { security?: unknown }>>;
      components: { schemas: { AssemblyAiHostedError: { properties: { error: { enum: string[] } } } } };
    };
    expect(spec.components.schemas.AssemblyAiHostedError.properties.error.enum.sort()).toEqual(Object.keys(ASSEMBLYAI_HOSTED_ERRORS).sort());
    const operations: [string, string][] = [
      ["/capabilities", "get"],
      ["/hosted/uploads", "post"],
      ["/hosted/uploads/{upload_id}", "get"],
      ["/hosted/uploads/{upload_id}", "delete"],
      ["/hosted/uploads/{upload_id}/parts/{index}", "put"],
      ["/hosted/transcripts", "post"],
      ["/hosted/transcripts/{handle}", "get"],
      ["/hosted/transcripts/{handle}", "delete"],
      ["/hosted/transcripts/{handle}/sentences", "get"],
    ];
    for (const [path, method] of operations) {
      expect(spec.paths[`${ASSEMBLYAI_HOSTED_MOUNT}${path}`]?.[method]?.security).toEqual([{ bearerAuth: [] }]);
    }
  });
});


function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("TC-592 review regressions", () => {
  test("submission and abandonment cannot both win while completeness awaits stat", async () => {
    for (const replacement of [false, true]) {
      const h = await setup();
      const id = await h.upload(audio(3));
      const entered = gate(), resume = gate();
      const complete = h.store!.complete.bind(h.store);
      const claims: boolean[] = [];
      const start = h.store!.startSubmit.bind(h.store);
      h.store!.startSubmit = (...args) => {
        claims.push(h.store!.lookup(args[0].id, ADDRESS_A, T0).kind === "active");
        return start(...args);
      };
      h.store!.complete = async (upload) => {
        const result = await complete(upload);
        entered.resolve();
        await resume.promise;
        return result;
      };
      const submit = h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } });
      await entered.promise;
      // The old code refunds synchronously before its first await; fixed code queues this mutation.
      const found = h.store!.lookup(id, ADDRESS_A, T0);
      if (found.kind !== "active") throw new Error("missing upload");
      const abandon = replacement ? h.store!.create(ADDRESS_A, 3, "audio/wav", T0) : h.store!.abandon(found.upload);
      resume.resolve();
      await Promise.all([submit, abandon]);
      await h.store!.idle();
      expect(claims).not.toContain(false);
      const view = h.store!.lookup(id, ADDRESS_A, T0);
      const sent = view.kind === "settled" && view.outcome.status === "submitted";
      // A claimed submit must retain its charge; an abandoned upload must never call upstream.
      expect(h.store!.dailyBytesRemaining(ADDRESS_A, T0)).toBe(sent ? DEFAULT_DAILY_BYTES - 3 : DEFAULT_DAILY_BYTES - (replacement ? 3 : 0));
      if (!sent) expect(h.calls).toHaveLength(0);
    }
  });

  test("concurrent replacements keep one account in one of the four slots", async () => {
    const h = await setup();
    await h.createUpload(3);
    const entered = gate(), resume = gate();
    const release = h.store!.release.bind(h.store);
    let first = true;
    h.store!.release = async (upload) => {
      await release(upload);
      if (first) { first = false; entered.resolve(); await resume.promise; }
    };
    const a = h.store!.create(ADDRESS_A, 3, "audio/wav", T0);
    await entered.promise;
    const b = h.store!.create(ADDRESS_A, 3, "audio/wav", T0);
    resume.resolve();
    await Promise.all([a, b]);
    expect(h.store!.activeCount).toBe(1);
    expect(h.store!.dailyBytesRemaining(ADDRESS_A, T0)).toBe(DEFAULT_DAILY_BYTES - 3);
    for (const address of [ADDRESS_B, ADDRESS_C, "0xdddddddddddddddddddddddddddddddddddddddd"]) {
      expect((await h.createUpload(3, address)).status).toBe(201);
    }
    expect(h.store!.activeCount).toBe(4);
  });

  test("submission drains part writes and refuses writes after the claim", async () => {
    const requested = gate();
    const h = await setup({ onSubmit: requested.resolve });
    const id = await h.upload(audio(3));
    const found = h.store!.lookup(id, ADDRESS_A, T0);
    if (found.kind !== "active") throw new Error("missing upload");
    const entered = gate(), resume = gate();
    let written = false;
    const originalOpen = fsPromises.open;
    const spy = spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (args[1] === "r+") {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); written = true; };
        entered.resolve();
        await resume.promise;
      }
      return handle;
    });
    let checkedDuringWrite = false;
    const complete = h.store!.complete.bind(h.store);
    h.store!.complete = async (upload) => {
      checkedDuringWrite = !written;
      return complete(upload);
    };
    const writing = h.store!.writePart(found.upload, 0, audio(3));
    await entered.promise;
    const submitting = h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } });
    // The request has entered the route while file IO is held at a deterministic barrier.
    await requested.promise;
    resume.resolve();
    await writing;
    spy.mockRestore();
    await submitting;
    await h.store!.idle();
    expect(checkedDuringWrite).toBe(false);
    expect(await h.store!.writePart(found.upload, 0, audio(3)).catch(() => "threw")).toBe(false);
  });

  test("shutdown drains active writes, removes receiving spools, refunds and closes mutations", async () => {
    const h = await setup();
    const id = await h.upload(audio(3));
    const found = h.store!.lookup(id, ADDRESS_A, T0);
    if (found.kind !== "active") throw new Error("missing upload");
    const entered = gate(), resume = gate();
    const originalOpen = fsPromises.open;
    const spy = spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (args[1] === "r+") { entered.resolve(); await resume.promise; }
      return handle;
    });
    const writing = h.store!.writePart(found.upload, 0, audio(3));
    await entered.promise;
    let stopped = false;
    const shutdown = h.store!.shutdown().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const stoppedEarly = stopped;
    resume.resolve();
    await writing;
    spy.mockRestore();
    await shutdown;
    expect(stoppedEarly).toBe(false);
    expect(h.spoolFiles()).toEqual([]);
    expect(h.store!.activeCount).toBe(0);
    expect(h.store!.dailyBytesRemaining(ADDRESS_A, T0)).toBe(DEFAULT_DAILY_BYTES);
    expect((await h.store!.create(ADDRESS_A, 3, "audio/wav", T0)).ok).toBe(false);
  });

  test("non-canonical signature trailing bits are rejected with 404", async () => {
    const h = await setup();
    const handle = issueHandle(HANDLE_KEY, TRANSCRIPT_ID, ADDRESS_A, T0);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alternate = handle.slice(0, -1) + alphabet[alphabet.indexOf(handle.at(-1)!) ^ 1];
    expect(Buffer.from(alternate.split(".")[2]!, "base64url")).toEqual(Buffer.from(handle.split(".")[2]!, "base64url"));
    expect((await h.req("GET", `/hosted/transcripts/${alternate}`)).status).toBe(404);
    expect(h.calls).toHaveLength(0);
  });
});


test("DELETE preserves a submitted handle when completion wins the discard race", async () => {
  const h = await setup();
  const id = await h.upload(audio(3));
  expect((await h.req("GET", `/hosted/uploads/${id}`)).json.status).toBe("receiving");
  const outcome = await h.submit(id);
  expect(outcome.status).toBe("submitted");
  expect((await h.req("DELETE", `/hosted/uploads/${id}`)).status).toBe(409);
  expect((await h.req("GET", `/hosted/uploads/${id}`)).json).toEqual(outcome);
  expect((await h.req("DELETE", `/hosted/transcripts/${outcome.id}`)).status).toBe(204);
});

describe("TC-592 settling visibility", () => {
  for (const action of ["polling", "Discard"] as const) {
    test(`${action} retains the submitted handle while spool deletion is paused`, async () => {
      const deleting = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const h = await setup({ removeSpool: async (path, options) => {
        deleting.resolve();
        await gate.promise;
        await fsPromises.rm(path, options);
      } });
      const id = await h.upload(audio(10));
      await h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } });
      await deleting.promise;
      const token = await h.tokenFor(ADDRESS_A);
      const client = createHostedAssemblyAiClient({
        backendUrl: h.base.replace(ASSEMBLYAI_HOSTED_MOUNT, ""),
        sessionStore: { getToken: () => token, isExpired: () => false },
        sleep: async () => {},
      });
      try {
        expect(h.spoolFiles()).toHaveLength(1);
        if (action === "polling") {
          const result = await client.createTranscript(id, { speakerLabels: true });
          expect(result.id).toStartWith("aah1.");
          expect((await client.getTranscript(result.id)).status).toBe("completed");
        } else {
          await client.deleteUpload!(id);
          expect(h.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
        }
        expect((await h.req("GET", `/hosted/uploads/${id}`)).json.status).toBe("submitted");
      } finally {
        gate.resolve();
        await h.store!.idle();
      }
      expect(h.spoolFiles()).toEqual([]);
    });
  }
});

describe("TC-592 expiry regressions", () => {
  const day = 24 * 60 * 60 * 1000;
  async function unclaimed() {
    const h = await setup();
    const id = await h.upload(audio(10));
    await h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } });
    await h.store!.idle();
    return { h, id };
  }

  test("unclaimed expiry deletes once and leaves an owner-only tombstone until handle expiry", async () => {
    const { h, id } = await unclaimed();
    h.clock.now = T0 + SETTLED_TTL_MS;
    await h.store!.sweep(h.clock.now);
    expect(h.store!.lookup(id, ADDRESS_A, h.clock.now).kind).toBe("settled");
    h.clock.now = T0 + day;
    await Promise.all([h.store!.sweep(h.clock.now), h.store!.sweep(h.clock.now)]);
    expect(h.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(h.logs.some((l) => l.line.includes("route=expire_delete status=204"))).toBe(true);
    expect((await h.req("GET", `/hosted/uploads/${id}`)).status).toBe(410);
    expect((await h.req("GET", `/hosted/uploads/${id}`, { as: ADDRESS_B })).status).toBe(404);
    expect((await h.req("GET", "/hosted/uploads/aau_unknown")).status).toBe(404);
    h.clock.now = T0 + 7 * day - 1;
    expect((await h.req("GET", `/hosted/uploads/${id}`)).json.error).toBe("assemblyai_upload_expired");
    h.clock.now++;
    await h.store!.sweep(h.clock.now);
    expect((await h.req("GET", `/hosted/uploads/${id}`)).status).toBe(404);
  });

  for (const via of ["GET", "POST"] as const) {
    test(`claimed via ${via} expiry leaves a tombstone without deleting the client's transcript`, async () => {
      const { h, id } = await unclaimed();
      const claimed = via === "GET" ? await h.req("GET", `/hosted/uploads/${id}`)
        : await h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } });
      expect(claimed.json.status).toBe("submitted");
      h.clock.now = T0 + SETTLED_TTL_MS;
      await h.store!.sweep(h.clock.now);
      expect((await h.req("GET", `/hosted/uploads/${id}`)).status).toBe(410);
      expect(h.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    });
  }

  test("reload then Discard after settlement expiry resolves through the hosted client", async () => {
    const { h, id } = await unclaimed();
    h.clock.now = T0 + day;
    const token = await h.tokenFor(ADDRESS_A);
    const client = createHostedAssemblyAiClient({
      backendUrl: h.base.replace(ASSEMBLYAI_HOSTED_MOUNT, ""),
      sessionStore: { getToken: () => token, isExpired: () => false }, sleep: async () => {},
    });
    let pending: PendingUpload | null = {
      engine: "assemblyai", assemblyAiMode: "hosted", meetingId: "m-reload", attemptId: "a-reload",
      jobId: null, uploadRef: id, uploadSubmitting: true, diarize: true,
      file: { name: "reload.wav", type: "audio/wav", size: 10, lastModified: T0 }, owner: ADDRESS_A, saved: false,
    };
    const deps: UploadDeps = {
      tcw: { did: ADDRESS_A, kv: {} } as never, privateCloud: null, assemblyAiClient: async () => client,
      pending: { read: () => pending, write: (value) => { pending = value; }, clear: () => { pending = null; } },
      lock: async () => () => {}, clock: { now: () => h.clock.now, sleep: async () => {}, random: () => 0.5 },
      audio: { manifest: async () => null, remove: async () => {}, put: async () => { throw new Error("No original file after reload"); } },
      save: async () => { throw new Error("An expired upload must not save"); },
    };
    const runner = createUploadRunner();
    const failed = new Promise<void>((resolve) => {
      const unsubscribe = runner.subscribe(() => { if (runner.snapshot()?.stage === "failed") { unsubscribe(); resolve(); } });
    });
    runner.resume(deps);
    await failed;
    expect(pending?.uploadRef).toBeUndefined();
    await runner.dismiss(deps);
    expect(pending).toBeNull();
    expect(runner.snapshot()).toBeNull();
    expect(h.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect((await h.req("GET", `/hosted/uploads/${id}`)).status).toBe(410);
  });

  test("shutdown deletes unclaimed transcripts before forgetting process state", async () => {
    const { h, id } = await unclaimed();
    await h.store!.shutdown();
    expect(h.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect((await h.req("GET", `/hosted/uploads/${id}`)).status).toBe(410);
  });
});

describe("TC-592 expiry safety", () => {
  test("failed expiry deletion retains the outcome for retry and maps already-deleted upstream responses", async () => {
    for (const gone of [404, 400]) {
      let fail = true;
      const h = await setup({ answer: (call) => call.method === "DELETE"
        ? fail ? json(503, {}) : json(gone, { error: "Transcript id not found" }) : assemblyAi(call) });
      const id = await h.upload(audio(10));
      await h.req("POST", "/hosted/transcripts", { body: { upload_id: id, speaker_labels: true } });
      await h.store!.idle();
      h.clock.now = T0 + 24 * SETTLED_TTL_MS;
      await h.store!.sweep(h.clock.now);
      expect(h.store!.lookup(id, ADDRESS_A, h.clock.now).kind).toBe("settled");
      expect(h.logs.at(-1)!.line).toContain("route=expire_delete status=502");
      fail = false;
      await h.store!.sweep(h.clock.now);
      expect((await h.req("GET", `/hosted/uploads/${id}`)).status).toBe(410);
      expect(h.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
    }
  });

  test("tombstones evict oldest by account and globally and failed outcomes expire without deleting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tinychat-tombstones-test-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new HostedUploadStore(dir, DEFAULT_DAILY_BYTES, 4, undefined, { global: 3, account: 2 });
    await store.init();
    async function tombstone(owner: string) {
      const created = await store.create(owner, 1, "audio/wav", T0);
      if (!created.ok) throw new Error("create failed");
      store.startSubmit(created.upload, () => T0, async () => ({ status: "failed", code: "assemblyai_unavailable" }));
      await store.idle();
      await store.sweep(T0 + SETTLED_TTL_MS);
      return created.upload.id;
    }
    const a1 = await tombstone(ADDRESS_A);
    const a2 = await tombstone(ADDRESS_A);
    const a3 = await tombstone(ADDRESS_A);
    expect(store.lookup(a1, ADDRESS_A, T0 + SETTLED_TTL_MS).kind).toBe("missing");
    expect(store.lookup(a2, ADDRESS_A, T0 + SETTLED_TTL_MS).kind).toBe("expired");
    const b1 = await tombstone(ADDRESS_B);
    const c1 = await tombstone(ADDRESS_C);
    expect(store.lookup(a2, ADDRESS_A, T0 + SETTLED_TTL_MS).kind).toBe("missing");
    for (const [id, owner] of [[a3, ADDRESS_A], [b1, ADDRESS_B], [c1, ADDRESS_C]]) {
      expect(store.lookup(id!, owner!, T0 + SETTLED_TTL_MS).kind).toBe("expired");
    }
  });
});
