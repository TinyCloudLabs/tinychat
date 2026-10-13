import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
// Bun exposes libc flock through FFI; the backend's Node typecheck has no Bun declarations.
// @ts-expect-error runtime-provided module
import { dlopen, FFIType } from "bun:ffi";
import type { FileHandle } from "node:fs/promises";

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
 * Upload slots and the daily allowance live in this process. Exo note keys are journaled in the
 * spool directory before paid submission, and must live on a persistent volume. One process owns
 * the directory under flock. Startup discards unsent spools, reconciles the note journal once,
 * and leaves interrupted paid submissions uncertain rather than submitting them twice.
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
  const payload = Buffer.from(parts[1]!, "base64url");
  if (payload.toString("base64url") !== parts[1] || presented.toString("base64url") !== parts[2]) return null;
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(payload.toString("utf8"));
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
export const MAX_SETTLED_OUTCOMES = 10_000;
export const MAX_ACCOUNT_SETTLED_OUTCOMES = 20;
export const SHUTDOWN_DEADLINE_MS = 20_000;
export const MAX_UPLOAD_TOMBSTONES = 50_000;
export const MAX_ACCOUNT_UPLOAD_TOMBSTONES = 100;
/** How long a background submit (stream to AssemblyAI, then create the transcript) may take. */
export const SUBMIT_DEADLINE_MS = 15 * 60 * 1000;
/** Readability window after failure or after a submitted handle is first claimed. */
export const SETTLED_TTL_MS = 60 * 60 * 1000;
/** Give an absent owner a day to collect the handle before deleting the unclaimed transcript. */
export const UNCLAIMED_SUBMITTED_TTL_MS = 24 * 60 * 60 * 1000;

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
  /** Stable Exo note key; absent for legacy and non-note uploads. */
  sourceId?: string;
}

type NoteJob = { address: string; sourceId: string; uploadId: string; bootId: string; state: "receiving" | "submitting" | "submitted" | "uncertain" | "deleted"; handle?: string; expiresAt?: number };
export type NoteJobView = { status: "receiving" | "submitting" | "submitted" | "uncertain" | "deleted"; upload_id: string; id?: string };

/** How a background submit ended. Codes are the router's public error codes. */
export type SubmitOutcome =
  | { status: "submitted"; handle: string; expiresAt?: number }
  | { status: "failed"; code: "assemblyai_unavailable" | "assemblyai_rate_limited" };

export type CreateUploadResult =
  | { ok: true; upload: HostedUpload }
  | { ok: true; job: NoteJobView }
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
  private readonly settled = new Map<string, { owner: string; until: number; expiresAt: number; claimed: boolean; outcome: SubmitOutcome }>();
  private expireDelete: ((handle: string, owner: string, signal?: AbortSignal) => Promise<void>) | null = null;
  /** Expired outcomes contain only the id, owner and original handle expiry. */
  private readonly tombstones = new Map<string, { owner: string; until: number }>();
  /** Bounded index for oldest-first per-owner eviction without scanning every tombstone. */
  private readonly ownerTombstones = new Map<string, Set<string>>();
  /** `${utcDay}|${address}` → bytes charged today. */
  private readonly charged = new Map<string, number>();
  /** Background submits in flight. */
  private readonly inFlight = new Set<Promise<void>>();
  private readonly noteJobs = new Map<string, NoteJob>();
  private readonly quarantinedKeys = new Set<string>();
  private readonly bootId = randomUUID();
  private spoolLock: FileHandle | null = null;

  /** Serialize account mutations, including file IO, so a claim cannot overtake a part or cleanup. */
  private readonly mutations = new Map<string, Promise<void>>();
  private stopping = false;

  private noteKey(address: string, sourceId: string): string {
    return createHash("sha256").update(JSON.stringify([address, sourceId])).digest("hex");
  }

  private noteFile(key: string): string { return join(this.spoolDir, `note-${key}.json`); }

  private viewNoteJob(job: NoteJob): NoteJobView {
    return { status: job.state, upload_id: job.uploadId, ...(job.handle ? { id: job.handle } : {}) };
  }

  private async saveNoteJob(key: string, job: NoteJob): Promise<void> {
    const file = this.noteFile(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(job)); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await rename(temporary, file);
      const directory = await open(this.spoolDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { await rm(temporary, { force: true }); throw error; }
    this.noteJobs.set(key, job);
  }

  private async removeNoteJob(key: string): Promise<void> {
    await rm(this.noteFile(key), { force: true });
    this.noteJobs.delete(key);
  }

  noteJob(address: string, sourceId: string): NoteJobView | null {
    const job = this.noteJobs.get(this.noteKey(address, sourceId));
    return job ? this.viewNoteJob(job) : null;
  }

  /** A transcript request crosses the paid boundary only after this marker is durable. */
  async markNoteSubmitting(upload: HostedUpload): Promise<void> {
    if (!upload.sourceId) return;
    const key = this.noteKey(upload.owner, upload.sourceId);
    const job = this.noteJobs.get(key);
    if (job?.uploadId === upload.id && job.state === "receiving") await this.saveNoteJob(key, { ...job, state: "submitting" });
  }

  async settleNote(upload: HostedUpload, outcome: SubmitOutcome): Promise<void> {
    if (!upload.sourceId) return;
    const key = this.noteKey(upload.owner, upload.sourceId);
    const job = this.noteJobs.get(key);
    if (job?.uploadId === upload.id) await this.saveNoteJob(key, outcome.status === "submitted"
      ? { ...job, state: "submitted", handle: outcome.handle, expiresAt: outcome.expiresAt } : { ...job, state: "uncertain" });
  }

  async deleteNoteHandle(address: string, handle: string): Promise<void> {
    for (const [key, job] of this.noteJobs) {
      if (job.address === address && job.handle === handle) await this.saveNoteJob(key, { ...job, state: "deleted" });
    }
  }

  private withAccount<T>(address: string, action: () => Promise<T>): Promise<T> {
    const result = (this.mutations.get(address) ?? Promise.resolve()).then(action);
    const drained = result.then(() => {}, () => {});
    this.mutations.set(address, drained);
    void drained.then(() => {
      if (this.mutations.get(address) === drained) this.mutations.delete(address);
    });
    return result;
  }

  private receiving(upload: HostedUpload): boolean {
    return !this.stopping && this.uploads.get(upload.id) === upload && upload.state === "receiving";
  }

  constructor(
    private readonly spoolDir: string,
    private readonly dailyBytes: number,
    private readonly maxConcurrent: number,
    private readonly removeSpool: typeof rm = rm,
    private readonly tombstoneLimits = { global: MAX_UPLOAD_TOMBSTONES, account: MAX_ACCOUNT_UPLOAD_TOMBSTONES },
    private readonly outcomeLimits = { global: MAX_SETTLED_OUTCOMES, account: MAX_ACCOUNT_SETTLED_OUTCOMES },
  ) {}

  /** Take the process-wide writer lock before reading or changing any spool state. */
  async init(): Promise<void> {
    if (this.spoolLock) throw new Error("[assemblyai-hosted] spool already initialized");
    await mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
    await chmod(this.spoolDir, 0o700);
    const lock = await open(join(this.spoolDir, ".hosted-writer.lock"), "a+", 0o600);
    const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    // LOCK_EX | LOCK_NB. The open descriptor retains the kernel lock until close or process exit.
    if (libc.symbols.flock(lock.fd, 2 | 4) !== 0) {
      await lock.close();
      libc.close();
      throw new Error(`[startup] FATAL: hosted spool writer lock is held: ${this.spoolDir}; refusing hosted routes`);
    }
    this.spoolLock = lock;
    libc.close();
    try {
      const marker = await open(join(this.spoolDir, ".hosted-boot-id"), "w", 0o600);
      try { await marker.writeFile(this.bootId); await marker.sync(); }
      finally { await marker.close(); }
      const directory = await open(this.spoolDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      await this.recover();
    }
    catch (error) { await this.close(); throw error; }
  }

  async close(): Promise<void> {
    if (this.spoolLock) {
      await this.spoolLock.close();
      this.spoolLock = null;
    }
  }

  /** Run once at boot, under the writer lock. Never retry an interrupted paid submission. */
  private async recover(): Promise<void> {
    const names = await readdir(this.spoolDir);
    for (const name of names) {
      const quarantined = /^note-([0-9a-f]{64})(?:-[^.]+)?\.json(?:\..+)?\.quarantine$/.exec(name);
      if (quarantined) this.quarantinedKeys.add(quarantined[1]!);
    }
    // Legacy two-file records are read once and folded into the canonical single-file journal.
    for (const name of names) {
      if (/^note-[0-9a-f]{64}\.json$/.test(name)) {
        const key = name.slice(5, -5);
        let raw: unknown;
        try { raw = JSON.parse(await readFile(this.noteFile(key), "utf8")); }
        catch { this.quarantinedKeys.add(key); await this.quarantine(name); continue; }
        if (!this.validNoteJob(key, raw)) { this.quarantinedKeys.add(key); await this.quarantine(name); continue; }
        let job = raw;
        const legacy = `note-${key}-${job.uploadId}.json`;
        if (names.includes(legacy)) {
          try {
            const state: unknown = JSON.parse(await readFile(join(this.spoolDir, legacy), "utf8"));
            if (!this.validNoteJob(key, state) || state.uploadId !== job.uploadId) throw new Error("invalid state");
            job = state;
          } catch { this.quarantinedKeys.add(key); await this.quarantine(legacy); await this.quarantine(name); continue; }
        }
        // A previous boot's receiving spool cannot prove which parts were durable. It is safe
        // to restart the upload, but never to infer that a paid transcript POST was absent.
        if (job.bootId !== this.bootId && (job.state === "receiving" || job.state === "submitting"))
          job = { ...job, state: "uncertain" };
        job = { ...job, bootId: this.bootId };
        await this.saveNoteJob(key, job);
        if (names.includes(legacy)) await rm(join(this.spoolDir, legacy), { force: true });
      }
    }
    for (const name of names) {
      const match = /^note-([0-9a-f]{64})-.+\.json$/.exec(name);
      if (match && !this.noteJobs.has(match[1]!)) {
        this.quarantinedKeys.add(match[1]!);
        await this.quarantine(name);
      }
    }
    for (const name of names) {
      const partial = /^note-([0-9a-f]{64})\.json\..+\.tmp$/.exec(name);
      if (partial) {
        this.quarantinedKeys.add(partial[1]!);
        await this.quarantine(name);
      }
    }
    for (const name of names) if (SPOOL_FILE_RE.test(name)) await rm(join(this.spoolDir, name), { force: true });
  }

  private validNoteJob(key: string, value: unknown): value is NoteJob {
    if (!value || typeof value !== "object") return false;
    const job = value as Partial<NoteJob>;
    return typeof job.address === "string" && ADDRESS_RE.test(job.address)
      && typeof job.sourceId === "string" && job.sourceId.length > 0 && job.sourceId.length <= 256
      && this.noteKey(job.address, job.sourceId) === key
      && typeof job.uploadId === "string" && UPLOAD_ID_RE.test(job.uploadId)
      && ["receiving", "submitting", "submitted", "uncertain", "deleted"].includes(job.state ?? "")
      && (job.handle === undefined || typeof job.handle === "string");
  }

  private async quarantine(name: string): Promise<void> {
    await rename(join(this.spoolDir, name), join(this.spoolDir, `${name}.${randomUUID()}.quarantine`));
    console.error(`[assemblyai-hosted] quarantined invalid spool record ${name} alert=true`);
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
  async create(address: string, byteSize: number, contentType: string, nowMs: number, sourceId?: string): Promise<CreateUploadResult> {
    return this.withAccount(address, async () => {
      if (sourceId && this.noteJob(address, sourceId)) {
        const job = this.noteJob(address, sourceId)!;
        const upload = this.uploads.get(job.upload_id);
        if (upload && upload.owner === address && upload.state === "receiving" && upload.expiresAt <= nowMs)
          await this.abandonLocked(upload);
        else if (upload && upload.owner === address) return { ok: true, upload };
        else if (["uncertain", "submitting"].includes(this.noteJob(address, sourceId)!.status)) return { ok: false, code: "assemblyai_busy", retryAfterSeconds: 30 };
        else return { ok: true, job: this.noteJob(address, sourceId)! };
      }
      if (sourceId && this.quarantinedKeys.has(this.noteKey(address, sourceId)))
        return { ok: false, code: "assemblyai_busy", retryAfterSeconds: 30 };
      return this.createLocked(address, byteSize, contentType, nowMs, sourceId);
    });
  }

  private async createLocked(address: string, byteSize: number, contentType: string, nowMs: number, sourceId?: string): Promise<CreateUploadResult> {
    if (this.stopping) return { ok: false, code: "assemblyai_busy", retryAfterSeconds: 30 };
    const mine = [...this.uploads.values()].find((u) => u.owner === address);
    if (mine?.state === "submitting") return { ok: false, code: "assemblyai_busy", retryAfterSeconds: 30 };
    if (mine) await this.abandonLocked(mine);
    if (this.stopping) return { ok: false, code: "assemblyai_busy", retryAfterSeconds: 30 };
    if (this.uploads.size >= this.maxConcurrent) {
      const soonest = Math.min(...[...this.uploads.values()].map((u) => u.expiresAt));
      return { ok: false, code: "assemblyai_busy", retryAfterSeconds: Math.min(60, Math.max(1, Math.ceil((soonest - nowMs) / 1000))) };
    }
    // Every active upload reserves room for its eventual outcome. Retained failures must
    // never be evicted to admit more work, even when upstream cleanup keeps failing.
    const retainedForAccount = [...this.settled.values()].filter((entry) => entry.owner === address).length;
    const reserved = [...this.uploads.keys()].filter((id) => !this.settled.has(id)).length;
    if (retainedForAccount >= this.outcomeLimits.account || this.settled.size + reserved >= this.outcomeLimits.global) {
      return { ok: false, code: "assemblyai_busy", retryAfterSeconds: 30 };
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
      sourceId,
    };
    // Reserve the slot and charge the allowance before the first await, so concurrent creates
    // cannot both pass the checks above.
    this.uploads.set(id, upload);
    this.charged.set(dayKey, used + byteSize);
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      if (sourceId) {
        const key = this.noteKey(address, sourceId);
        const job: NoteJob = { address, sourceId, uploadId: id, state: "receiving", bootId: this.bootId };
        await this.saveNoteJob(key, job);
      }
    } catch (error) {
      this.uploads.delete(id);
      this.charged.set(dayKey, used);
      await rm(path, { force: true });
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
    if (settled && settled.owner === address) return { kind: "settled", outcome: settled.outcome };
    const tombstone = this.tombstones.get(id);
    if (tombstone && tombstone.owner === address && tombstone.until > nowMs) return { kind: "expired" };
    return { kind: "missing" };
  }

  async writePart(upload: HostedUpload, index: number, bytes: Uint8Array): Promise<boolean> {
    return this.withAccount(upload.owner, async () => {
      if (!this.receiving(upload)) return false;
      await this.writePartLocked(upload, index, bytes);
      return true;
    });
  }

  private async writePartLocked(upload: HostedUpload, index: number, bytes: Uint8Array): Promise<void> {
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

  /** Validate and claim under the same lock as parts, replacement and abandonment. */
  async submitIfComplete(upload: HostedUpload, now: () => number, submit: (signal: AbortSignal) => Promise<SubmitOutcome>): Promise<boolean> {
    return this.withAccount(upload.owner, async () => {
      if (!this.receiving(upload) || upload.expiresAt <= now()) return true;
      if (!(await this.complete(upload))) return false;
      await this.markNoteSubmitting(upload);
      this.startSubmit(upload, now, submit);
      return true;
    });
  }

  /**
   * Move a complete upload to `submitting` and run `submit` in the background with an abort
   * signal (its own deadline, the sweep, or shutdown). Whatever happens, the spool is deleted,
   * the slot freed, and the outcome kept for the owner to read.
   */
  startSubmit(upload: HostedUpload, now: () => number, submit: (signal: AbortSignal) => Promise<SubmitOutcome>): void {
    if (!this.receiving(upload)) return;
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
      // An unpersisted result must remain uncertain rather than permit a second paid job.
      await this.settleNote(upload, outcome).catch(() => {});
      // Publish the outcome before release removes the active entry; no lookup can see a gap
      // while the spool deletion is pending (or if deleting the file fails).
      const settledAt = now();
      const expiresAt = outcome.status === "submitted" && outcome.expiresAt !== undefined
        ? outcome.expiresAt : (Math.floor(settledAt / 1000) + HANDLE_TTL_SECONDS) * 1000;
      this.settled.set(upload.id, {
        owner: upload.owner,
        until: upload.sourceId && outcome.status === "submitted" ? expiresAt
          : settledAt + (outcome.status === "submitted" ? UNCLAIMED_SUBMITTED_TTL_MS : SETTLED_TTL_MS),
        expiresAt,
        claimed: false, outcome,
      });
      await this.release(upload).catch(() => {});
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
    await this.removeSpool(upload.path, { force: true });
  }

  /** Drop an upload that was never sent: spool deleted, slot freed, its bytes refunded. */
  async abandon(upload: HostedUpload): Promise<boolean> {
    return this.withAccount(upload.owner, () => this.abandonLocked(upload));
  }

  private async abandonLocked(upload: HostedUpload): Promise<boolean> {
    if (this.uploads.get(upload.id) !== upload || upload.state !== "receiving") return false;
    const used = this.charged.get(upload.dayKey);
    if (used !== undefined) this.charged.set(upload.dayKey, Math.max(0, used - upload.byteSize));
    await this.release(upload);
    if (upload.sourceId) {
      const key = this.noteKey(upload.owner, upload.sourceId);
      if (this.noteJobs.get(key)?.uploadId === upload.id) await this.removeNoteJob(key);
    }
    return true;
  }

  /** The router supplies the same authenticated upstream delete used by the handle route. */
  onExpireDelete(remove: (handle: string, owner: string, signal?: AbortSignal) => Promise<void>): void {
    this.expireDelete = remove;
  }

  private removeTombstone(id: string): void {
    const entry = this.tombstones.get(id);
    if (!entry) return;
    this.tombstones.delete(id);
    const mine = this.ownerTombstones.get(entry.owner)!;
    mine.delete(id);
    if (mine.size === 0) this.ownerTombstones.delete(entry.owner);
  }

  private tombstone(id: string, owner: string, until: number): void {
    this.tombstones.set(id, { owner, until });
    const mine = this.ownerTombstones.get(owner) ?? new Set<string>();
    mine.add(id);
    this.ownerTombstones.set(owner, mine);
    while (mine.size > this.tombstoneLimits.account) this.removeTombstone(mine.values().next().value!);
    while (this.tombstones.size > this.tombstoneLimits.global) this.removeTombstone(this.tombstones.keys().next().value!);
  }

  private async expireOutcome(id: string, signal?: AbortSignal): Promise<void> {
    const settled = this.settled.get(id);
    if (!settled) return;
    const uploadJob = [...this.noteJobs.values()].find((job) => job.uploadId === id && job.address === settled.owner);
    if (settled.outcome.status === "submitted" && (!settled.claimed || uploadJob)) {
      // Never advertise terminal cleanup until upstream deletion succeeds. A failed delete
      // keeps the handle for the next sweep (and uses the router's fixed, redacted logging).
      if (!this.expireDelete) throw new Error("Hosted expiry deletion is not configured");
      await this.expireDelete(settled.outcome.handle, settled.owner, signal);
      if (uploadJob) await this.deleteNoteHandle(settled.owner, settled.outcome.handle);
    }
    this.tombstone(id, settled.owner, settled.expiresAt);
    this.settled.delete(id);
  }

  /** Expire an outcome atomically with sweep/shutdown for this owner. Reading is not a claim. */
  async resolve(id: string, address: string, nowMs: number): Promise<LookupResult> {
    return this.withAccount(address, async () => {
      const settled = this.settled.get(id);
      if (settled?.owner === address && settled.until <= nowMs) await this.expireOutcome(id);
      return this.lookup(id, address, nowMs);
    });
  }

  /** Only an authenticated request using the handle proves the owner received it. */
  async claimHandle(handle: string, address: string, nowMs: number): Promise<void> {
    await this.withAccount(address, async () => {
      for (const [id, settled] of this.settled) {
        if (settled.owner !== address || settled.outcome.status !== "submitted" || settled.outcome.handle !== handle) continue;
        if (settled.until <= nowMs) await this.expireOutcome(id);
        else if (!settled.claimed) {
          settled.claimed = true;
          if (![...this.noteJobs.values()].some((job) => job.uploadId === id && job.address === address))
            settled.until = Math.min(settled.until, nowMs + SETTLED_TTL_MS);
        }
      }
    });
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
      if (!(await this.abandon(upload))) continue;
      this.tombstone(upload.id, upload.owner, upload.expiresAt - UPLOAD_TTL_MS + HANDLE_TTL_SECONDS * 1000);
      removed++;
    }
    for (const [id, tombstone] of this.tombstones) if (tombstone.until <= nowMs) this.removeTombstone(id);
    for (const [id, settled] of this.settled) {
      if (settled.until <= nowMs) await this.resolve(id, settled.owner, nowMs).catch(() => {});
    }
    for (const job of [...this.noteJobs.values()]) {
      if (job.state !== "submitted" || !job.handle || !job.expiresAt || job.expiresAt > nowMs) continue;
      if (!this.expireDelete) throw new Error("Hosted expiry deletion is not configured");
      await this.expireDelete(job.handle, job.address).then(() => this.deleteNoteHandle(job.address, job.handle!), () => {});
    }
    const today = utcDay(nowMs);
    for (const key of this.charged.keys()) if (!key.startsWith(`${today}|`)) this.charged.delete(key);
    return removed;
  }

  /** Close mutations and attempt every cleanup, bounded by one total shutdown deadline. */
  async shutdown(timeoutMs = SHUTDOWN_DEADLINE_MS): Promise<void> {
    this.stopping = true;
    const controller = new AbortController();
    const deadline = new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    for (const upload of this.uploads.values()) upload.abort?.abort();
    const cleanup = (async () => {
      await Promise.allSettled([...this.mutations.values()]);
      await Promise.allSettled([...this.uploads.values()]
        .filter((upload) => upload.state === "receiving").map((upload) => this.abandonLocked(upload)));
      await this.idle();
      await Promise.allSettled([...this.settled].filter(([id, entry]) =>
        ![...this.noteJobs.values()].some((job) => job.uploadId === id && job.address === entry.owner)).map(([id, entry]) => this.withAccount(entry.owner, async () => {
        if (!controller.signal.aborted) await this.expireOutcome(id, controller.signal);
      })));
    })();
    // Even a stuck local IO or a transport ignoring abort cannot hold shutdown forever.
    await Promise.race([Promise.allSettled([cleanup]), deadline]);
    clearTimeout(timer);
    for (const entry of this.settled.values()) {
      const handle = entry.outcome.status === "submitted" ? entry.outcome.handle : null;
      if (handle && !entry.claimed &&
        ![...this.noteJobs.values()].some((job) => job.handle === handle && job.address === entry.owner)) {
        console.error(`[assemblyai-hosted] route=shutdown status=502 code=assemblyai_cleanup_incomplete cid=${randomUUID()}`);
      }
    }
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
