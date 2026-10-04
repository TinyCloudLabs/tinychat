import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { assertStrongSecret } from "./webhook-tokens.js";

/**
 * AssemblyAI under TinyCloud's account for Exo uploads ("hosted" mode, contract C10).
 *
 * The browser cannot hold TinyCloud's AssemblyAI key, so in hosted mode the audio passes through
 * this backend: the client PUTs it in ≤1 MiB parts (api.tinycloud.chat's ingress refuses larger
 * bodies) into a spool file, then asks for a transcript; the backend streams the spool to
 * AssemblyAI with the server key, deletes the spool, and hands back a signed HANDLE instead of the
 * AssemblyAI transcript id. Every later read or delete presents the handle, which binds the
 * transcript to the session address that created it.
 *
 * Nothing here is persisted: uploads, slots and the daily allowance live in this process, and a
 * restart forgets them (clients re-upload; the allowance resets). Spool files left by a previous
 * process are removed at start.
 */

export const MAX_HOSTED_BYTES = 120_960_000;
export const HOSTED_PART_SIZE = 1_048_576;
/** The six audio containers Exo uploads (contract C1). */
export const HOSTED_CONTENT_TYPES: readonly string[] = ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm", "audio/flac"];
export const DEFAULT_DAILY_BYTES = 3 * MAX_HOSTED_BYTES;
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
export const UPLOAD_TTL_MS = 60 * 60 * 1000;
export const HANDLE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** AssemblyAI transcript ids (UUIDs today); the same bound the C9 delete proxy accepts. */
export const ASSEMBLYAI_TRANSCRIPT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// ── Config ───────────────────────────────────────────────────────────

export type AssemblyAiHostedConfig =
  | { hosted: false; reason: "api_key_unset" | "handle_key_unset" | "both_unset" }
  | {
      hosted: true;
      apiKey: string;
      handleKey: string;
      dailyBytes: number;
      spoolDir: string;
    };

function fail(message: string): never {
  throw new Error(`[startup] FATAL: ${message}`);
}

/** Names of env vars that hold secrets; the handle key must equal none of them. */
const SECRET_NAME_RE = /(KEY|SECRET|MASTER|TOKEN|PASSWORD)/;

/**
 * Both `ASSEMBLYAI_API_KEY` and `ASSEMBLYAI_HOSTED_HANDLE_KEY` set = hosted mode on; either unset =
 * off (capabilities say `hosted: false`, the hosted routes answer 503). A value that IS set but
 * unusable refuses boot: a weak or reused handle key, a key with whitespace, a bad allowance or
 * spool dir. Error messages name variables, never values (public CVM logs).
 */
export function assemblyAiHostedConfigFromEnv(env: Record<string, string | undefined>): AssemblyAiHostedConfig {
  const apiKey = env.ASSEMBLYAI_API_KEY?.trim() ?? "";
  const handleKey = env.ASSEMBLYAI_HOSTED_HANDLE_KEY?.trim() ?? "";
  if (apiKey && /[^\x21-\x7e]/.test(apiKey)) fail("ASSEMBLYAI_API_KEY must be printable ASCII without whitespace");
  if (handleKey) {
    assertStrongSecret("ASSEMBLYAI_HOSTED_HANDLE_KEY", handleKey, { quiet: true });
    for (const [name, value] of Object.entries(env)) {
      if (name === "ASSEMBLYAI_HOSTED_HANDLE_KEY" || !SECRET_NAME_RE.test(name)) continue;
      if (value?.trim() === handleKey) fail(`ASSEMBLYAI_HOSTED_HANDLE_KEY must not reuse ${name}`);
    }
  }

  const rawDaily = env.ASSEMBLYAI_HOSTED_DAILY_BYTES?.trim() ?? "";
  let dailyBytes = DEFAULT_DAILY_BYTES;
  if (rawDaily) {
    if (!/^\d{1,15}$/.test(rawDaily) || Number(rawDaily) < 1) fail("ASSEMBLYAI_HOSTED_DAILY_BYTES must be a positive integer");
    dailyBytes = Number(rawDaily);
  }
  const spoolDir = env.ASSEMBLYAI_HOSTED_SPOOL_DIR?.trim() || join(tmpdir(), "tinychat-assemblyai");
  if (!isAbsolute(spoolDir)) fail("ASSEMBLYAI_HOSTED_SPOOL_DIR must be an absolute path");

  if (!apiKey || !handleKey) {
    return { hosted: false, reason: !apiKey && !handleKey ? "both_unset" : !apiKey ? "api_key_unset" : "handle_key_unset" };
  }
  return { hosted: true, apiKey, handleKey, dailyBytes, spoolDir };
}

// ── Handles ──────────────────────────────────────────────────────────

const HANDLE_PREFIX = "aah1";
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_HANDLE_LENGTH = 512;

function sign(handleKey: string, signed: string): Buffer {
  return createHmac("sha256", handleKey).update(signed).digest();
}

/** `aah1.<b64url(json{t, a, e})>.<b64url(HMAC-SHA256(key, "aah1.<payload>"))>`. */
export function issueHandle(handleKey: string, transcriptId: string, address: string, nowMs: number): string {
  const payload = Buffer.from(
    JSON.stringify({ t: transcriptId, a: address.toLowerCase(), e: Math.floor(nowMs / 1000) + HANDLE_TTL_SECONDS }),
  ).toString("base64url");
  const signed = `${HANDLE_PREFIX}.${payload}`;
  return `${signed}.${sign(handleKey, signed).toString("base64url")}`;
}

/**
 * The AssemblyAI transcript id behind a handle, or null when the handle is malformed, forged,
 * expired, or was issued to a different address. Callers answer every null the same (404).
 */
export function openHandle(handleKey: string, handle: string, address: string, nowMs: number): string | null {
  if (handle.length > MAX_HANDLE_LENGTH) return null;
  const parts = handle.split(".");
  if (parts.length !== 3 || parts[0] !== HANDLE_PREFIX || !B64URL_RE.test(parts[1]!) || !B64URL_RE.test(parts[2]!)) return null;
  const expected = sign(handleKey, `${parts[0]}.${parts[1]}`);
  const presented = Buffer.from(parts[2]!, "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { t, a, e } = claims as Record<string, unknown>;
  if (typeof t !== "string" || !ASSEMBLYAI_TRANSCRIPT_ID_RE.test(t)) return null;
  if (typeof a !== "string" || !ADDRESS_RE.test(a) || a !== address.toLowerCase()) return null;
  if (typeof e !== "number" || !Number.isSafeInteger(e) || e * 1000 <= nowMs) return null;
  return t;
}

// ── Uploads: spool, slots, daily allowance ───────────────────────────

const UPLOAD_ID_RE = /^aau_[A-Za-z0-9_-]{32}$/;
const SPOOL_FILE_RE = /^aau_[A-Za-z0-9_-]{32}\.part$/;
/** An expired upload answers 410 (not 404) to its owner for this long after the sweep. */
const TOMBSTONE_MS = 60 * 60 * 1000;
/** How long a background submit (stream to AssemblyAI, then create the transcript) may take. */
export const SUBMIT_DEADLINE_MS = 15 * 60 * 1000;
/** A settled outcome (the handle, or the failure) stays readable this long after it settles. */
export const SETTLED_TTL_MS = 60 * 60 * 1000;

export interface HostedUpload {
  id: string;
  owner: string;
  byteSize: number;
  contentType: string;
  partCount: number;
  received: boolean[];
  path: string;
  expiresAt: number;
  /** The allowance key this upload was charged to (refunded if it is abandoned unsent). */
  dayKey: string;
  /** `receiving` takes parts; `submitting` is being sent to AssemblyAI (no parts, no abandon). */
  state: "receiving" | "submitting";
  /** Aborts the background submit (deadline, sweep, shutdown). Set while submitting. */
  abort: AbortController | null;
  submitDeadline: number;
}

/** How a background submit ended. Codes are the router's public error codes. */
export type SubmitOutcome =
  | { status: "submitted"; handle: string }
  | { status: "failed"; code: "assemblyai_unavailable" | "assemblyai_rate_limited" };

export type CreateUploadResult =
  | { ok: true; upload: HostedUpload }
  | { ok: false; code: "assemblyai_quota_exceeded" | "assemblyai_busy"; retryAfterSeconds: number };

export type LookupResult =
  | { kind: "active"; upload: HostedUpload }
  | { kind: "settled"; outcome: SubmitOutcome }
  | { kind: "expired" }
  | { kind: "missing" };

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function secondsToUtcMidnight(nowMs: number): number {
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - nowMs) / 1000));
}

/** Expected length of part `index` of an upload of `byteSize` bytes. */
export function partLength(byteSize: number, index: number): number {
  return Math.min(HOSTED_PART_SIZE, byteSize - index * HOSTED_PART_SIZE);
}

export class HostedUploadStore {
  /** Uploads holding a slot: receiving parts, or being submitted. */
  private readonly uploads = new Map<string, HostedUpload>();
  /** Submitted or failed uploads: their outcome, readable by the owner until `until`. */
  private readonly settled = new Map<string, { owner: string; until: number; outcome: SubmitOutcome }>();
  /** Expired unsent uploads: id → { owner, until }. */
  private readonly tombstones = new Map<string, { owner: string; until: number }>();
  /** `${utcDay}|${address}` → bytes charged today. */
  private readonly charged = new Map<string, number>();
  /** Background submits in flight. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly spoolDir: string,
    private readonly dailyBytes: number,
    private readonly maxConcurrent: number,
  ) {}

  /** Create the spool dir (0700) and remove whatever a previous process left in it. */
  async init(): Promise<void> {
    await mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
    await chmod(this.spoolDir, 0o700);
    for (const name of await readdir(this.spoolDir)) {
      if (SPOOL_FILE_RE.test(name)) await rm(join(this.spoolDir, name), { force: true });
    }
  }

  dailyBytesRemaining(address: string, nowMs: number): number {
    return Math.max(0, this.dailyBytes - (this.charged.get(`${utcDay(nowMs)}|${address}`) ?? 0));
  }

  get activeCount(): number {
    return this.uploads.size;
  }

  /**
   * A new upload for `address`. The account's previous upload, if it was never sent (a closed tab,
   * a failed part), is abandoned and refunded so a retry never waits out its hour; one that is
   * being sent to AssemblyAI right now still makes this `assemblyai_busy`.
   */
  async create(address: string, byteSize: number, contentType: string, nowMs: number): Promise<CreateUploadResult> {
    const mine = [...this.uploads.values()].find((u) => u.owner === address);
    if (mine?.state === "submitting") return { ok: false, code: "assemblyai_busy", retryAfterSeconds: 30 };
    if (mine) await this.abandon(mine);
    if (this.uploads.size >= this.maxConcurrent) {
      const soonest = Math.min(...[...this.uploads.values()].map((u) => u.expiresAt));
      return { ok: false, code: "assemblyai_busy", retryAfterSeconds: Math.min(60, Math.max(1, Math.ceil((soonest - nowMs) / 1000))) };
    }
    const dayKey = `${utcDay(nowMs)}|${address}`;
    const used = this.charged.get(dayKey) ?? 0;
    if (used + byteSize > this.dailyBytes) {
      return { ok: false, code: "assemblyai_quota_exceeded", retryAfterSeconds: secondsToUtcMidnight(nowMs) };
    }
    const id = `aau_${randomBytes(24).toString("base64url")}`;
    const path = join(this.spoolDir, `${id}.part`);
    const upload: HostedUpload = {
      id,
      owner: address,
      byteSize,
      contentType,
      partCount: Math.ceil(byteSize / HOSTED_PART_SIZE),
      received: [],
      path,
      expiresAt: nowMs + UPLOAD_TTL_MS,
      dayKey,
      state: "receiving",
      abort: null,
      submitDeadline: 0,
    };
    // Reserve the slot and charge the allowance before the first await, so concurrent creates
    // cannot both pass the checks above.
    this.uploads.set(id, upload);
    this.charged.set(dayKey, used + byteSize);
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
    } catch (error) {
      this.uploads.delete(id);
      this.charged.set(dayKey, used);
      throw error;
    }
    return { ok: true, upload };
  }

  /** The caller's upload in whatever state it is in; another account's is `missing`. */
  lookup(id: string, address: string, nowMs: number): LookupResult {
    if (!UPLOAD_ID_RE.test(id)) return { kind: "missing" };
    const upload = this.uploads.get(id);
    if (upload && upload.owner === address) {
      // A submit in flight outlives the upload's hour; it is bounded by its own deadline.
      return upload.state === "receiving" && upload.expiresAt <= nowMs ? { kind: "expired" } : { kind: "active", upload };
    }
    const settled = this.settled.get(id);
    if (settled && settled.owner === address && settled.until > nowMs) return { kind: "settled", outcome: settled.outcome };
    const tombstone = this.tombstones.get(id);
    if (tombstone && tombstone.owner === address && tombstone.until > nowMs) return { kind: "expired" };
    return { kind: "missing" };
  }

  async writePart(upload: HostedUpload, index: number, bytes: Uint8Array): Promise<void> {
    const handle = await open(upload.path, "r+");
    try {
      await handle.write(bytes, 0, bytes.byteLength, index * HOSTED_PART_SIZE);
    } finally {
      await handle.close();
    }
    upload.received[index] = true;
  }

  /** Every part arrived and the spool is exactly the declared size. */
  async complete(upload: HostedUpload): Promise<boolean> {
    for (let i = 0; i < upload.partCount; i++) if (!upload.received[i]) return false;
    return (await stat(upload.path)).size === upload.byteSize;
  }

  /**
   * Move a complete upload to `submitting` and run `submit` in the background with an abort
   * signal (its own deadline, the sweep, or shutdown). Whatever happens, the spool is deleted,
   * the slot freed, and the outcome kept for the owner to read.
   */
  startSubmit(upload: HostedUpload, now: () => number, submit: (signal: AbortSignal) => Promise<SubmitOutcome>): void {
    const controller = new AbortController();
    upload.state = "submitting";
    upload.abort = controller;
    upload.submitDeadline = now() + SUBMIT_DEADLINE_MS;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SUBMIT_DEADLINE_MS)]);
    const run = (async () => {
      let outcome: SubmitOutcome;
      try {
        outcome = await submit(signal);
      } catch {
        outcome = { status: "failed", code: "assemblyai_unavailable" };
      }
      await this.release(upload).catch(() => {});
      this.settled.set(upload.id, { owner: upload.owner, until: now() + SETTLED_TTL_MS, outcome });
    })();
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
  }

  /** Resolves when every background submit started so far has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Delete the spool and free the slot. Safe to call more than once. */
  async release(upload: HostedUpload): Promise<void> {
    this.uploads.delete(upload.id);
    await rm(upload.path, { force: true });
  }

  /** Drop an upload that was never sent: spool deleted, slot freed, its bytes refunded. */
  async abandon(upload: HostedUpload): Promise<void> {
    if (!this.uploads.has(upload.id) || upload.state !== "receiving") return;
    const used = this.charged.get(upload.dayKey);
    if (used !== undefined) this.charged.set(upload.dayKey, Math.max(0, used - upload.byteSize));
    await this.release(upload);
  }

  /** Forget a settled outcome (the owner has read it). */
  forget(id: string): void {
    this.settled.delete(id);
  }

  /**
   * Delete expired unsent spools and free their slots; abort submits past their deadline (they
   * then settle as failed and delete their own spool); forget old outcomes and old days.
   */
  async sweep(nowMs: number): Promise<number> {
    let removed = 0;
    for (const upload of [...this.uploads.values()]) {
      if (upload.state === "submitting") {
        if (nowMs >= upload.submitDeadline) upload.abort?.abort();
        continue;
      }
      if (upload.expiresAt > nowMs) continue;
      await this.release(upload);
      this.tombstones.set(upload.id, { owner: upload.owner, until: nowMs + TOMBSTONE_MS });
      removed++;
    }
    for (const [id, tombstone] of this.tombstones) if (tombstone.until <= nowMs) this.tombstones.delete(id);
    for (const [id, settled] of this.settled) if (settled.until <= nowMs) this.settled.delete(id);
    const today = utcDay(nowMs);
    for (const key of this.charged.keys()) if (!key.startsWith(`${today}|`)) this.charged.delete(key);
    return removed;
  }

  /** Shutdown: abort every submit in flight and wait for them to delete their spools. */
  async shutdown(): Promise<void> {
    for (const upload of this.uploads.values()) upload.abort?.abort();
    await this.idle();
  }
}

// ── AssemblyAI ───────────────────────────────────────────────────────

export const ASSEMBLYAI_API = "https://api.assemblyai.com";
export const SPEECH_MODELS = ["universal-3-5-pro", "universal-2"] as const;
/**
 * AssemblyAI answers an unknown transcript id with `400 {"error": "Transcript lookup error,
 * transcript id not found"}`, not 404 (observed 2026-10-03); this fragment tells it apart.
 */
export const NOT_FOUND_400 = "transcript id not found";

/** Read at most `max` bytes of a body; null when it is longer (not read past the cap). */
export async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > max) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function parseJson(bytes: Uint8Array | null): unknown {
  if (bytes === null || bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** True when an AssemblyAI 400 body is its "transcript id not found" answer. */
export function isNotFound400(bytes: Uint8Array | null): boolean {
  return bytes !== null && new TextDecoder().decode(bytes).toLowerCase().includes(NOT_FOUND_400);
}

// ── Rebuilt transcript views (nothing AssemblyAI sends is relayed by reference) ──

export const TRANSCRIPT_STATUSES: readonly string[] = ["queued", "processing", "completed", "error"];
const STATUSES = TRANSCRIPT_STATUSES as readonly ("queued" | "processing" | "completed" | "error")[];
const LANGUAGE_CODE_RE = /^[a-z]{2,3}(?:_[a-z]{2,4})?$/i;
const SPEAKER_RE = /^[A-Za-z0-9]{1,8}$/;
const MAX_TEXT = 4_000_000;
/** Fixed text for a transcript AssemblyAI failed; its own error text is never relayed. */
export const TRANSCRIPT_FAILED_MESSAGE = "AssemblyAI could not transcribe this recording.";

class Invalid extends Error {}
function check(condition: boolean): asserts condition {
  if (!condition) throw new Invalid();
}
function obj(value: unknown): Record<string, unknown> {
  check(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function ms(value: unknown): number {
  check(typeof value === "number" && Number.isFinite(value) && value >= 0);
  return value as number;
}
function text(value: unknown): string {
  check(typeof value === "string" && value.length <= MAX_TEXT);
  return value as string;
}
function speaker(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  check(typeof value === "string" && SPEAKER_RE.test(value));
  return value as string;
}
function orNull<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch (error) {
    if (error instanceof Invalid) return null;
    throw error;
  }
}

export interface HostedTranscriptView {
  id: string;
  status: (typeof STATUSES)[number];
  error: string | null;
  language_code: string | null;
  audio_duration: number | null;
  text: string | null;
  utterances: { speaker: string | null; start: number; end: number; text: string }[] | null;
}

/** `GET /v2/transcript/{id}` rebuilt to the public subset, or null when off-contract. */
export function rebuildTranscript(body: unknown, handle: string): HostedTranscriptView | null {
  return orNull(() => {
    const o = obj(body);
    check(typeof o.status === "string" && (STATUSES as readonly string[]).includes(o.status));
    const status = o.status as HostedTranscriptView["status"];
    const languageCode = o.language_code === null || o.language_code === undefined ? null : o.language_code;
    check(languageCode === null || (typeof languageCode === "string" && LANGUAGE_CODE_RE.test(languageCode)));
    const duration = o.audio_duration === null || o.audio_duration === undefined ? null : ms(o.audio_duration);
    const utterances =
      o.utterances === null || o.utterances === undefined
        ? null
        : (() => {
            check(Array.isArray(o.utterances));
            return (o.utterances as unknown[]).map((raw) => {
              const u = obj(raw);
              const start = ms(u.start);
              const end = ms(u.end);
              check(end >= start);
              return { speaker: speaker(u.speaker), start, end, text: text(u.text) };
            });
          })();
    return {
      id: handle,
      status,
      error: status === "error" ? TRANSCRIPT_FAILED_MESSAGE : null,
      language_code: languageCode as string | null,
      audio_duration: duration,
      text: o.text === null || o.text === undefined ? null : text(o.text),
      utterances,
    };
  });
}

/** `GET /v2/transcript/{id}/sentences` rebuilt to `{ sentences: [{ start, end, text, speaker }] }`. */
export function rebuildSentences(body: unknown) {
  return orNull(() => {
    const list = obj(body).sentences;
    check(Array.isArray(list));
    return {
      sentences: (list as unknown[]).map((raw) => {
        const s = obj(raw);
        const start = ms(s.start);
        const end = ms(s.end);
        check(end >= start);
        return { start, end, text: text(s.text), speaker: speaker(s.speaker) };
      }),
    };
  });
}
