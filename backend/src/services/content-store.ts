import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import * as serverPackage from "@tinyboilerplate/server";
import type {
  PurgeLedger,
  PurgeLedgerRead,
} from "../routes/connector-webhooks.js";
import { BackendStorageLane } from "./backend-storage-lane.js";
import { isTombstoned } from "./connector-drain.js";
import type {
  ContentSink,
  ContentUpsertInput,
  ContentUpsertResult,
  RetentionGuard,
} from "./fetch-worker.js";
import {
  assertStrongSecret,
  assertNewContentMaster,
  isValidMeetingId,
  isValidSource,
  keyedLogHash,
  normalizeWebhookAddress,
} from "./webhook-tokens.js";
import { recordReconcileLag } from "./ingest-observability.js";

const { assertKvResult, withSessionRefresh } = serverPackage;
const { isKvMissingKeyResult } = serverPackage as typeof serverPackage & {
  isKvMissingKeyResult: (result: unknown, key: string) => boolean;
};

/**
 * W4 — the SERVER CONTENT STORE (backend-ingest plan §8.1 W4; §8.2 delta items 6, 8, 10;
 * §9 anti-patterns 4, 6).
 *
 * THIS FILE IS THE SECOND HALF OF A CONSCIOUS, OPERATOR-AUTHORIZED REVERSAL (plan §11). Under
 * the shipped Option C the backend never receives the meeting itself; for cohort addresses
 * behind the dark `CONNECTOR_BACKEND_INGEST_ENABLED` flag it now keeps a bounded, encrypted,
 * retained copy — because a device that has never opened the app cannot read a meeting that
 * only ever existed in another device's vault. Everything the old invariant made unnecessary is
 * re-established here explicitly:
 *
 *  - **Only ciphertext leaves the TEE.** Nothing but a sealed blob and its wrapped DEK reaches
 *    the substrate — not the transcript, not the summary, not the meeting TITLE, not the
 *    per-user metadata index. App-layer AES-256-GCM envelope encryption under a DEDICATED env
 *    master (`CONNECTOR_CONTENT_MASTER`), separate from both `WEBHOOK_HMAC_MASTER` and
 *    `CONNECTOR_CREDENTIAL_MASTER`, with the same refuse-boot-on-weak-master posture. At-rest
 *    encryption is a control we apply, never a substrate property we assume (plan §7). Every
 *    envelope is AAD-bound to `(source, address, sourceId)`, so a blob relabelled into another
 *    tenant's slot does not decrypt: cross-tenant reuse fails closed rather than leaking.
 *  - **Tenant-scoped by construction.** Every method takes `(source, address)`; there is no
 *    scan, no enumerate-all-users, no "list every meeting" surface anywhere in the class or in
 *    the blob-store port beneath it. One user's overflow can only ever evict that user's rows.
 *  - **Partial rows are LEGAL (delta 6).** Upsert identity is `(source, source_id)` scoped by
 *    address, and a summary that arrives before — or entirely without — a transcript is a
 *    complete, readable row, not an error. Either arrival order merges into the same row.
 *  - **Bounded, with an explicit overflow policy (delta 8).** A single meeting over
 *    {@link MAX_MEETING_CONTENT_BYTES} is REJECTED and logged (never truncated: half a
 *    transcript is worse than none, and silently storing 2 MB of a 9 MB meeting is the kind of
 *    lie that only surfaces months later). Per-user caps drop the OLDEST rows, counted and
 *    logged. No silent caps.
 *  - **Fail closed (delta 10).** Every substrate call is result-checked; a read that fails is
 *    never read as "this user has no meetings" (that reading disables every cap, makes the
 *    retention sweep a no-op and lets a replay re-store swept content). `upsert` answers the
 *    worker's Result type, and the ONLY success arm is a literal `{ok:true, stored}`.
 *  - **Retention (up to 14 days).** Each blob has an authenticated UTC expiry day, set at first
 *    storage to the storage day plus 13 days. Five-minute sweeps leave a day of scheduling slack.
 *    Keyed replay markers contain no meeting IDs and expire 14 days after deletion; provider
 *    source times older than 14 days are refused even after the marker expires.
 *  - **Purge tombstones (W7, delta 12).** {@link ContentStoreOptions.purgeLedger} is the second
 *    tombstone input: the SHIPPED §6.2 purge ledger (`purgedThrough` + `recentIds`), applied
 *    through connector-drain's `isTombstoned` — the rule is IMPORTED, never re-implemented, so
 *    the server store and the browser drain cannot drift on what "purged" means. A teardown
 *    (or a user purge) writes the watermark; from then on a replayed delivery for that tenant
 *    is refused instead of re-stored, and the worker's guard reports it before any upstream
 *    call. An unreadable ledger is a FAILURE, never "nothing was ever purged".
 *
 * SUBSTRATE (DECISIONS D3 = off-node). {@link ContentBlobStore} is that seam: it sees sealed
 * blobs and key paths, never a plaintext meeting, so the content and the master both stay inside
 * the CVM whichever adapter is bound. {@link KvContentBlobStore} (the backend's OWN TinyCloud
 * KV, one sequential lane) is the interim binding available today and uses PER-ITEM content keys
 * — plan §7: "KV RMW arrays are not a content store." The off-node adapter implements the same
 * six methods. Note the KV binding writes to the BACKEND's own space: the KV-never-SQL rule
 * governs *user-space* connector writes (the W6 reconcile), which this is not.
 *
 * SEQUENTIAL + SERIALIZED (§9.3, D4 single-instance). Each `(source, address)` runs its
 * read-modify-write under a per-tenant lane, so two deliveries for one user cannot interleave
 * and lose an index update; the KV adapter additionally serialises every node call, because
 * TinyCloud drops concurrent responses on one space.
 */

// ── Tunables (plan §8.1 W4 proposals + DECISIONS D2a) ────────────────

/** The dedicated content master. Separate from the HMAC and credential masters by requirement. */
export const CONTENT_MASTER_ENV = "CONNECTOR_CONTENT_MASTER";

/** Meeting IDs and content are retained for no longer than 14 days after first storage. */
export const RETENTION_WINDOW_DAYS = 14;

/** Plan §8.1 W4: per-meeting content cap — reject-and-log over, never truncate. */
export const MAX_MEETING_CONTENT_BYTES = 2 * 1024 * 1024;

/** Plan §8.1 W4: per-user caps — oldest-drop, counted. */
export const MAX_USER_MEETINGS = 500;
export const MAX_USER_CONTENT_BYTES = 200 * 1024 * 1024;

/**
 * Retention markers are bounded at the meeting cap and expire no later than their row's 14-day
 * boundary. If a user exceeds the cap, the oldest remaining marker may stop suppressing replay
 * sooner; it never extends retention of the corresponding content row.
 */
export const MAX_USER_TOMBSTONES = MAX_USER_MEETINGS;

const KEK_HKDF_SALT = "tinychat-content-v1";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEK_BYTES = 32;

const CONTENT_KEY_PREFIX = "connector-content";
const CONTENT_INDEX_KEY_PREFIX = "connector-content-index";
const CONTENT_KEY_FAILURE_PREFIX = "connector-content-key-failure";
const REPLAY_TOMBSTONE_KEY_PREFIX = "connector-content-replay-tombstone/v1";

// ── Result / row shapes ──────────────────────────────────────────────

/** What the substrate holds. There is no field here a breach could read as a meeting. */
export interface SealedBlob {
  ciphertext: string;
  wrappedDEK: string;
  /** Original storage time, kept outside encryption for index-independent expiry. */
  storedAt?: string;
  /** UTC day expiry, authenticated as part of the per-meeting envelope AAD. */
  expiresAt?: string;
  /** Detect a rotated content master before attempting destructive maintenance. */
  keyFingerprint?: string;
  /** ISO time of the most recent write. */
  updatedAt: string;
}

/** Row metadata (plan §8.1 W4's schema). `title` rides the sealed body, never the substrate. */
export interface ContentMeta {
  sourceId: string;
  title?: string;
  /** The provider's meeting timestamp when it gave one. */
  ts?: string;
  participantNames?: string[];
  participantEmails?: string[];
  organizerEmail?: string;
  transcriptStoredAt?: string;
  summaryStoredAt?: string;
  /** Bytes of the merged, serialized content — the number the per-user cap counts. */
  sizeBytes: number;
  storedAt: string;
  /** Immutable UTC-day expiry set by the backend on first storage. */
  expiresAt?: string;
  updatedAt: string;
  /** Stamped by W5's reconcile-ack after the browser wrote the user's OWN space (W6). */
  reconciledAt?: string;
}
export interface ReplayTombstoneRecord {
  expiresAt: string;
  mac: string;
}

/** Both provider halves. Either may be absent — a partial row is legal (delta 6). */
export interface MeetingContent {
  transcript?: unknown;
  summary?: unknown;
}

export interface StoredMeeting {
  meta: ContentMeta;
  content: MeetingContent;
}

/** A retention-swept id, remembered only until the stored meeting's 14-day expiry. */
export interface RetentionTombstone {
  sourceId: string;
  sweptAt: string;
  expiresAt: string;
}

export interface RetentionSweepResult {
  swept: number;
  bytesFreed: number;
  /** How many tombstones this tenant now carries, after the cap. */
  tombstones: number;
}

export interface ContentStoreStats {
  created: number;
  merged: number;
  /** Per-user cap evictions (oldest-drop). */
  droppedOverflow: number;
  /** Per-meeting cap rejections. */
  rejectedTooLarge: number;
  /** Upserts refused because the id is retention-tombstoned. */
  tombstoneRefusals: number;
  /** W7: upserts refused because the §6.2 purge ledger tombstones the identity. */
  purgeRefusals: number;
  /** Substrate/crypto failures on the upsert path — every one of them retried, none reported ok. */
  writeFailures: number;
  /** Failed index/master reads during cleanup or sync-off deletion. */
  unreadableIndexes: number;
  swept: number;
  reconciled: number;
}

/**
 * The D3 substrate seam. Every content operation is keyed by `(source, address)`; the retention
 * directory may enumerate sealed index keys, but it never reads or returns content globally.
 */

export async function assertNoContentKey(storage: ContentContinuityStorage): Promise<void> {
  try {
    if (await storage.readCanary() !== null || await storage.findIndex() !== null || await storage.hasContent()) throw new Error();
  } catch {
    throw new Error("connector content continuity failed; refusing startup and writes");
  }
}

export interface ContentContinuityStorage {
  readCanary(): Promise<SealedBlob | null>;
  writeCanary(blob: SealedBlob): Promise<void>;
  findIndex(): Promise<{ source: string; address: string } | null>;
  hasContent(): Promise<boolean>;
}

export interface ContentBlobStore {
  readIndex(source: string, address: string): Promise<SealedBlob | null>;
  writeIndex(
    source: string,
    address: string,
    blob: SealedBlob,
  ): Promise<void>;
  listContentIds(source: string, address: string): Promise<Array<{
    sourceId: string;
    storedAt?: string;
    updatedAt: string;
  }>>;
  read(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<SealedBlob | null>;
  write(
    source: string,
    address: string,
    sourceId: string,
    blob: SealedBlob,
  ): Promise<void>;
  remove(source: string, address: string, sourceId: string): Promise<void>;
  readReplayTombstone(digest: string): Promise<ReplayTombstoneRecord | null>;
  writeReplayTombstone(
    digest: string,
    marker: ReplayTombstoneRecord,
  ): Promise<void>;
  removeReplayTombstone(digest: string): Promise<void>;
  listReplayTombstones(): Promise<Array<{
    digest: string;
    marker: ReplayTombstoneRecord | null;
  }>>;
  removeIndex(source: string, address: string): Promise<void>;
  readKeyFailureSince(source: string, address: string): Promise<string | null>;
  writeKeyFailureSince(
    source: string,
    address: string,
    firstFailureAt: string,
  ): Promise<void>;
  clearKeyFailureSince(source: string, address: string): Promise<void>;
  /** W7's teardown primitive: every blob and the index for ONE tenant. */
  removeAll(source: string, address: string): Promise<void>;
}

/**
 * W7 — the read half of the SHIPPED §6.2 purge ledger, as this store sees it. Read-only by
 * construction: writing the watermark belongs to the teardown and to `POST …/purged`, never to
 * the store that is gated by it. `ConnectorControl` satisfies it structurally.
 */
export interface ContentPurgeLedgerReader {
  readLedger(source: string, address: string): Promise<PurgeLedgerRead>;
}

/** The instance lease that owns archive mutations for this process. */
export interface ContentMutationGuard {
  isHolder(): boolean;
}


export interface ContentStoreOptions {

  now?: () => number;
  /** Injectable so a test pins the master without mutating the process env. */
  master?: () => string;
  /**
   * W7 (delta 12). ABSENT means no purge ledger is consulted — the shape a harness uses to prove
   * the retention half alone. Production wires the companions' `ConnectorControlStore`, which is
   * the same ledger the drain and `POST …/purged` already read and write.
   */
  purgeLedger?: ContentPurgeLedgerReader;
  /** Production always supplies the continuity-claimed ingest/retention lease. */
  mutationGuard?: ContentMutationGuard;
  retentionMs?: number;
  maxMeetingBytes?: number;
  maxUserMeetings?: number;
  maxUserBytes?: number;
  maxUserTombstones?: number;
}

/** Fixed, short codes. A provider payload or a title must never become one. */
const INVALID_TARGET = "invalid_target";
const CONTENT_TOO_LARGE = "content_too_large";
const MEETING_TOO_OLD = "meeting_too_old";
const RETENTION_TOMBSTONED = "retention_tombstoned";
const CONTENT_STORE_FAILED = "content_store_failed";
/** W7: distinct from the retention code so an operator can tell a purge from an aged-out sweep. */
export const PURGE_TOMBSTONED = "purge_tombstoned";

// ── Master key ───────────────────────────────────────────────────────

const validatedContentMasters = new Set<string>();

/**
 * Boot-time gate for the content master. `index.ts` validates it when backend ingestion is enabled
 * and whenever stored indexes remain while ingestion is off, because the independent retention
 * sweep must still decrypt and delete expired rows. Returns a Result rather than throwing so the
 * boot path can print and exit(1). The error text NEVER contains a key value.
 *
 * The master must SURVIVE redeploys (DECISIONS D3 substrate note): a deploy that strips it
 * orphans every stored meeting, which is why it rides the four-place `allowed_envs` dance in
 * `webhook-deploy-env.test.ts`.
 */
export function validateContentCustodyConfig(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; error: string } {
  const value = env[CONTENT_MASTER_ENV];
  try {
    assertStrongSecret(CONTENT_MASTER_ENV, value, { quiet: true });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const trimmed = (value as string).trim();
  for (const [name, other] of [
    ["WEBHOOK_HMAC_MASTER", env.WEBHOOK_HMAC_MASTER],
    ["CONNECTOR_CREDENTIAL_MASTER", env.CONNECTOR_CREDENTIAL_MASTER],
  ] as const) {
    if (typeof other === "string" && sameSecret(other.trim(), trimmed)) {
      return {
        ok: false,
        error:
          `[startup] FATAL: ${CONTENT_MASTER_ENV} must not reuse ${name} — ` +
          "one compromise must not be both the content archive and " +
          (name === "WEBHOOK_HMAC_MASTER"
            ? "delivery authentication"
            : "credential custody"),
      };
    }
  }
  return { ok: true };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
export function contentMasterFingerprint(master: string): string {
  return createHash("sha256").update(master, "utf8").digest("hex");
}

/** The current content master. Throws when unset or weak — never a fallback that hides it. */
export function currentContentMaster(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[CONTENT_MASTER_ENV];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!validatedContentMasters.has(trimmed)) {
    const config = validateContentCustodyConfig(env);
    if (!config.ok) throw new Error(config.error);
    validatedContentMasters.add(trimmed);
  }
  return trimmed;
}

/** Test hook (house convention). */
export function _resetContentMasterCache(): void {
  validatedContentMasters.clear();
}

// ── Envelope encryption ──────────────────────────────────────────────

/** `sourceId` is part of the AAD, so a blob cannot be moved between meetings either. */
function envelopeAad(
  source: string,
  address: string,
  scope: string,
  expiresAt?: string,
): Buffer {
  return Buffer.from(
    expiresAt === undefined
      ? `${source}:${address}:${scope}`
      : `${source}:${address}:${scope}:expiry:${expiresAt}`,
    "utf8",
  );
}

function keyEncryptionKey(
  master: string,
  source: string,
  address: string,
): Buffer {
  return Buffer.from(
    hkdfSync("sha256", master, KEK_HKDF_SALT, `${source}:${address}`, 32),
  );
}

/** `base64(iv | tag | ciphertext)` — AES-256-GCM, AAD-bound to the tenant and the scope. */
function seal(key: Buffer, plaintext: Buffer, aad: Buffer): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function open(key: Buffer, sealed: string, aad: Buffer): Buffer {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length <= GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error("content envelope is unreadable");
  }
  const iv = raw.subarray(0, GCM_IV_BYTES);
  const tag = raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const body = raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  // A wrong tenant, a wrong master and a tampered blob all land here as the SAME failure with
  // no detail: an "unreadable envelope" diagnostic must not become an oracle.
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
const CONTENT_DAY_MS = 86_400_000;
const REPLAY_TOMBSTONE_HKDF_INFO = "tinychat-content-replay-tombstone-v1";

function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function expiryDateForStoredAt(storedAt: string, retentionMs: number): string {
  const parsed = Date.parse(storedAt);
  if (!Number.isFinite(parsed)) throw new Error("content storage date is unreadable");
  const date = new Date(parsed);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const retentionDays = Math.max(0, Math.ceil(retentionMs / CONTENT_DAY_MS) - 1);
  return new Date(day + retentionDays * CONTENT_DAY_MS).toISOString().slice(0, 10);
}

function expiryDeadline(expiresAt: string): number | null {
  if (!isUtcDate(expiresAt)) return null;
  return Date.parse(`${expiresAt}T00:00:00.000Z`);
}

function replayTombstoneKey(master: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", master, KEK_HKDF_SALT, REPLAY_TOMBSTONE_HKDF_INFO, 32),
  );
}

function replayTombstoneDigest(
  master: string,
  source: string,
  address: string,
  sourceId: string,
): string {
  return createHmac("sha256", replayTombstoneKey(master))
    .update(`object:${source}:${normalizeWebhookAddress(address)}:${sourceId}`)
    .digest("hex");
}

function replayTombstoneMac(master: string, digest: string, expiresAt: string): string {
  return createHmac("sha256", replayTombstoneKey(master))
    .update(`marker:${digest}:${expiresAt}`)
    .digest("hex");
}

// ── Logging (ops + hashed ids + fixed codes; never content) ──────────

function hashed(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unavailable";
  }
}

function logContent(fields: string): void {
  console.log(`[connector-content] ${fields} t=${new Date().toISOString()}`);
}

function warnContent(fields: string): void {
  console.warn(`[connector-content] ${fields} t=${new Date().toISOString()}`);
}

function errorContent(fields: string): void {
  console.error(`[connector-content] ${fields} t=${new Date().toISOString()}`);
}

// ── The store ────────────────────────────────────────────────────────

/** The sealed per-tenant index: metadata for every live row plus the retention tombstones. */
interface ContentIndex {
  meetings: ContentMeta[];
  tombstones: RetentionTombstone[];
}

class ContentIndexUnreadableError extends Error {
  constructor() {
    super("content index is unreadable");
    this.name = "ContentIndexUnreadableError";
  }
}

class ContentBlobUnparseableError extends Error {
  constructor() {
    super("content blob is unparseable");
    this.name = "ContentBlobUnparseableError";
  }
}


class ContentMasterUnavailableError extends Error {
  constructor() {
    super("content master is unavailable");
    this.name = "ContentMasterUnavailableError";
  }
}

export class ContentStore implements ContentSink, RetentionGuard {
  private readonly now: () => number;
  private readonly master: () => string;
  private readonly retentionMs: number;
  private readonly maxMeetingBytes: number;
  private readonly maxUserMeetings: number;
  private readonly maxUserBytes: number;
  private readonly maxUserTombstones: number;
  private readonly purgeLedger: ContentPurgeLedgerReader | null;
  private readonly mutationGuard: ContentMutationGuard | null;
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly counters: ContentStoreStats = {
    created: 0,
    merged: 0,
    droppedOverflow: 0,
    rejectedTooLarge: 0,
    tombstoneRefusals: 0,
    purgeRefusals: 0,
    writeFailures: 0,
    unreadableIndexes: 0,
    swept: 0,
    reconciled: 0,
  };

  constructor(
    private readonly blobs: ContentBlobStore,
    options: ContentStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.master = options.master ?? (() => currentContentMaster());
    this.retentionMs =
      options.retentionMs ?? RETENTION_WINDOW_DAYS * 86_400_000;
    this.maxMeetingBytes = options.maxMeetingBytes ?? MAX_MEETING_CONTENT_BYTES;
    this.maxUserMeetings = options.maxUserMeetings ?? MAX_USER_MEETINGS;
    this.maxUserBytes = options.maxUserBytes ?? MAX_USER_CONTENT_BYTES;
    this.maxUserTombstones = options.maxUserTombstones ?? MAX_USER_TOMBSTONES;
    this.purgeLedger = options.purgeLedger ?? null;
    this.mutationGuard = options.mutationGuard ?? null;
  }

  private assertMutationAllowed(): void {
    if (this.mutationGuard && !this.mutationGuard.isHolder()) {
      throw new Error("content continuity lease is not held");
    }
  }

  /** Read-only proof: no missing index is treated as a successful decrypt. */
  async probeIndex(target: { source: string; address: string } | null): Promise<{ ok: boolean; id: string | null }> {
    if (!target) return { ok: false, id: null };
    const id = createHash("sha256").update(`${target.source}:${target.address}`).digest("hex");
    try {
      const blob = await this.blobs.readIndex(target.source, target.address);
      if (!blob) return { ok: false, id };
      parseIndex(this.unseal(target.source, target.address, "index", blob), this.now());
      return { ok: true, id };
    } catch {
      return { ok: false, id };
    }
  }

  async assertContinuity(
    storage: ContentContinuityStorage,
    env: NodeJS.ProcessEnv,
    guard?: { claim(): Promise<{ status: string }> },
  ): Promise<void> {
    try {
      if (!this.master()) {
        await assertNoContentKey(storage);
        return;
      }
      if (guard && (await guard.claim()).status !== "held") throw new Error();
      const digest = contentMasterFingerprint(this.master());
      const pin = env.CONNECTOR_CONTENT_EXPECTED_SHA256?.trim();
      if (pin !== undefined && pin !== digest) throw new Error();
      const canary = await storage.readCanary();
      if (canary !== null) {
        if (this.unseal("continuity", "backend", "canary", canary) !== "tinychat-content-canary-v1") throw new Error();
        return;
      }
      assertNewContentMaster(this.master());
      const target = await storage.findIndex();
      if (target) {
        if (pin !== digest || !(await this.probeIndex(target)).ok) throw new Error();
      } else {
        if (await storage.hasContent()) throw new Error();
        if (env.CONNECTOR_CONTENT_ENROLL_FRESH !== "true" || (pin !== undefined && pin !== digest)) throw new Error();
      }
      // Recheck after archive I/O as well as taking the singleton seat before the first read.
      // A delayed boot must never replace a canary enrolled while it was inspecting archives.
      if (await storage.readCanary() !== null) throw new Error();
      this.assertMutationAllowed();
      await storage.writeCanary(this.sealBlob("continuity", "backend", "canary", "tinychat-content-canary-v1"));
      const saved = await storage.readCanary();
      if (!saved || this.unseal("continuity", "backend", "canary", saved) !== "tinychat-content-canary-v1") throw new Error();
    } catch {
      throw new Error("connector content continuity failed; refusing startup and writes");
    }
  }

  stats(): ContentStoreStats {
    return { ...this.counters };
  }
  private contentMaster(): string {
    try {
      return this.master();
    } catch {
      throw new ContentMasterUnavailableError();
    }
  }
  private async noteRetentionFailure(
    source: string,
    address: string,
  ): Promise<void> {
    try {
      const existing = await this.blobs.readKeyFailureSince(source, address);
      const recorded = existing === null ? NaN : Date.parse(existing);
      if (Number.isFinite(recorded)) return;
      this.assertMutationAllowed();
      await this.blobs.writeKeyFailureSince(
        source,
        address,
        new Date(this.now()).toISOString(),
      );
      errorContent(
        `op=retention result=content_index_unavailable first_failure=true ` +
          `alert=true source=${source} aid=${hashed(address)}`,
      );
    } catch {
      errorContent(
        `op=retention result=failure_marker_unavailable alert=true source=${source} ` +
          `aid=${hashed(address)}`,
      );
    }
  }

  private async clearRetentionFailure(
    source: string,
    address: string,
  ): Promise<void> {
    try {
      this.assertMutationAllowed();
      await this.blobs.clearKeyFailureSince(source, address);
    } catch {
      warnContent(
        `op=retention result=failure_marker_clear_failed source=${source} ` +
          `aid=${hashed(address)}`,
      );
    }
  }

  private warnUnreadableExpiry(
    source: string,
    address: string,
    sourceId: string,
  ): void {
    warnContent(
      `op=retention-sweep result=expiry_unreadable source=${source} ` +
        `mid=${hashed(sourceId)} aid=${hashed(address)}`,
    );
  }
  private replayMarkerMacValid(
    digest: string,
    marker: ReplayTombstoneRecord,
  ): boolean {
    if (!/^[a-f0-9]{64}$/.test(digest)) return false;
    const parsed = Date.parse(marker.expiresAt);
    if (
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString() !== marker.expiresAt
    ) {
      return false;
    }
    return sameSecret(
      marker.mac,
      replayTombstoneMac(this.contentMaster(), digest, marker.expiresAt),
    );
  }

  private async replayMarker(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<ReplayTombstoneRecord | null> {
    const digest = replayTombstoneDigest(
      this.contentMaster(),
      source,
      address,
      sourceId,
    );
    const marker = await this.blobs.readReplayTombstone(digest);
    if (marker === null) return null;
    if (
      typeof marker.expiresAt !== "string" ||
      typeof marker.mac !== "string" ||
      !this.replayMarkerMacValid(digest, marker)
    ) {
      throw new Error("replay tombstone is unreadable");
    }
    if (Date.parse(marker.expiresAt) <= this.now()) {
      this.assertMutationAllowed();
      await this.blobs.removeReplayTombstone(digest);
      return null;
    }
    return marker;
  }

  private async writeReplayMarker(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<void> {
    const master = this.contentMaster();
    const digest = replayTombstoneDigest(master, source, address, sourceId);
    const expiresAt = new Date(this.now() + this.retentionMs).toISOString();
    this.assertMutationAllowed();
    await this.blobs.writeReplayTombstone(digest, {
      expiresAt,
      mac: replayTombstoneMac(master, digest, expiresAt),
    });
  }


  /**
   * The worker's {@link ContentSink}. Upsert identity is `(source, source_id)` SCOPED BY
   * ADDRESS; the two provider kinds merge into one row in either arrival order (delta 6).
   *
   * Returns a Result and never throws: the worker's contract is that anything other than a
   * literal `{ok:true}` means "not stored, retry" (delta 10). Nothing here can report a success
   * it did not get — the success arm is built only after both durable writes resolved.
   */
  async upsert(input: ContentUpsertInput): Promise<ContentUpsertResult> {
    let target: { source: string; address: string; sourceId: string };
    try {
      target = normalizeTarget(input.source, input.address, input.sourceId);
    } catch {
      // Refused BEFORE anything is read or written. The offending value is never echoed —
      // it arrived on a public delivery path.
      warnContent(`op=upsert result=${INVALID_TARGET}`);
      return { ok: false, code: INVALID_TARGET };
    }
    if (input.kind !== "transcript" && input.kind !== "summary") {
      warnContent(
        `op=upsert result=${INVALID_TARGET} source=${target.source} ` +
          `aid=${hashed(target.address)}`,
      );
      return { ok: false, code: INVALID_TARGET };
    }

    const { source, address, sourceId } = target;
    const sourceTimestamp =
      input.ts === undefined ? NaN : Date.parse(input.ts);
    if (
      Number.isFinite(sourceTimestamp) &&
      this.now() - sourceTimestamp > RETENTION_WINDOW_DAYS * CONTENT_DAY_MS
    ) {
      warnContent(
        `op=upsert result=${MEETING_TOO_OLD} source=${source} ` +
          `mid=${hashed(sourceId)} aid=${hashed(address)}`,
      );
      return { ok: false, code: MEETING_TOO_OLD };
    }
    if (!Number.isFinite(sourceTimestamp)) {
      warnContent(
        `op=upsert result=meeting_time_missing source=${source} ` +
          `mid=${hashed(sourceId)} aid=${hashed(address)}`,
      );
    }

    return this.lane(source, address, async () => {
      try {
        const index = await this.openIndex(source, address);
        if (index.tombstones.some((t) => t.sourceId === sourceId)) {
          this.counters.tombstoneRefusals += 1;
          return { ok: false, code: RETENTION_TOMBSTONED };
        }
        const replayMarker = await this.replayMarker(source, address, sourceId);
        if (replayMarker !== null && Date.parse(replayMarker.expiresAt) > this.now()) {
          this.counters.tombstoneRefusals += 1;
          logContent(
            `op=upsert result=${RETENTION_TOMBSTONED} source=${source} ` +
              `mid=${hashed(sourceId)} aid=${hashed(address)}`,
          );
          return { ok: false, code: RETENTION_TOMBSTONED };
        }
        if (await this.purgeTombstoned(source, address, sourceId, input)) {
          this.counters.purgeRefusals += 1;
          logContent(
            `op=upsert result=${PURGE_TOMBSTONED} source=${source} ` +
              `mid=${hashed(sourceId)} aid=${hashed(address)}`,
          );
          return { ok: false, code: PURGE_TOMBSTONED };
        }

        const prior = index.meetings.find((m) => m.sourceId === sourceId);
        const existing = await this.readMeeting(source, address, sourceId);
        if (prior !== undefined && existing === null) {
          if (prior.expiresAt === undefined || !isUtcDate(prior.expiresAt)) {
            throw new Error("missing content has no authenticated expiry");
          }
          await this.writeReplayMarker(source, address, sourceId);
          await this.writeIndex(source, address, {
            meetings: index.meetings.filter((m) => m.sourceId !== sourceId),
            tombstones: index.tombstones,
          });
          this.counters.tombstoneRefusals += 1;
          return { ok: false, code: RETENTION_TOMBSTONED };
        }
        if (
          prior !== undefined &&
          existing !== null &&
          (prior.storedAt !== existing.meta.storedAt ||
            prior.expiresAt !== existing.meta.expiresAt)
        ) {
          throw new Error("content index metadata does not match its blob");
        }

        const priorMeta = prior ?? existing?.meta;
        const stamp = new Date(this.now()).toISOString();
        const storedAt = priorMeta?.storedAt ?? stamp;
        const expiresAt =
          priorMeta?.expiresAt ?? expiryDateForStoredAt(storedAt, this.retentionMs);
        if (!isUtcDate(expiresAt)) throw new Error("content expiry is unreadable");
        if (this.now() >= Date.parse(`${expiresAt}T00:00:00.000Z`)) {
          await this.writeReplayMarker(source, address, sourceId);
          this.counters.tombstoneRefusals += 1;
          return { ok: false, code: RETENTION_TOMBSTONED };
        }

        const content: MeetingContent = { ...(existing?.content ?? {}) };
        content[input.kind] = input.content;
        const body = JSON.stringify(content);
        const sizeBytes = Buffer.byteLength(body, "utf8");
        if (sizeBytes > this.maxMeetingBytes) {
          this.counters.rejectedTooLarge += 1;
          warnContent(
            `op=upsert result=${CONTENT_TOO_LARGE} source=${source} ` +
              `mid=${hashed(sourceId)} aid=${hashed(address)} ` +
              `bytes=${sizeBytes} cap=${this.maxMeetingBytes}`,
          );
          return { ok: false, code: CONTENT_TOO_LARGE };
        }

        const normalizedTs = Number.isFinite(sourceTimestamp)
          ? new Date(sourceTimestamp).toISOString()
          : priorMeta?.ts;
        const meta: ContentMeta = {
          sourceId,
          ...(input.title !== undefined
            ? { title: input.title }
            : priorMeta?.title !== undefined
              ? { title: priorMeta.title }
              : {}),
          ...(normalizedTs !== undefined ? { ts: normalizedTs } : {}),
          ...(input.participantNames !== undefined
            ? { participantNames: input.participantNames }
            : priorMeta?.participantNames !== undefined
              ? { participantNames: priorMeta.participantNames }
              : {}),
          ...(input.participantEmails !== undefined
            ? { participantEmails: input.participantEmails }
            : priorMeta?.participantEmails !== undefined
              ? { participantEmails: priorMeta.participantEmails }
              : {}),
          ...(input.organizerEmail !== undefined
            ? { organizerEmail: input.organizerEmail }
            : priorMeta?.organizerEmail !== undefined
              ? { organizerEmail: priorMeta.organizerEmail }
              : {}),
          ...(input.kind === "transcript"
            ? { transcriptStoredAt: stamp }
            : priorMeta?.transcriptStoredAt !== undefined
              ? { transcriptStoredAt: priorMeta.transcriptStoredAt }
              : {}),
          ...(input.kind === "summary"
            ? { summaryStoredAt: stamp }
            : priorMeta?.summaryStoredAt !== undefined
              ? { summaryStoredAt: priorMeta.summaryStoredAt }
              : {}),
          sizeBytes,
          storedAt,
          expiresAt,
          updatedAt: stamp,
        };

        const others = index.meetings.filter((m) => m.sourceId !== sourceId);
        const { kept, evicted } = this.enforceCaps(source, address, others, meta);
        if (priorMeta?.reconciledAt !== undefined) {
          const unreconciledPrior = { ...priorMeta };
          delete unreconciledPrior.reconciledAt;
          await this.writeIndex(source, address, {
            meetings: index.meetings.map((entry) =>
              entry.sourceId === sourceId ? unreconciledPrior : entry,
            ),
            tombstones: index.tombstones,
          });
        }

        await this.writeMeeting(source, address, meta, content);
        await this.writeIndex(source, address, {
          meetings: [...kept, meta],
          tombstones: index.tombstones,
        });
        for (const victim of evicted) {
          this.assertMutationAllowed();
          await this.blobs.remove(source, address, victim.sourceId);
        }

        const stored = existing === null ? "created" : "merged";
        if (stored === "created") this.counters.created += 1;
        else this.counters.merged += 1;
        logContent(
          `op=upsert result=ok stored=${stored} source=${source} ` +
            `mid=${hashed(sourceId)} aid=${hashed(address)} bytes=${sizeBytes}`,
        );
        return { ok: true, stored };
      } catch {
        this.counters.writeFailures += 1;
        warnContent(
          `op=upsert result=${CONTENT_STORE_FAILED} source=${source} ` +
            `mid=${hashed(sourceId)} aid=${hashed(address)}`,
        );
        return { ok: false, code: CONTENT_STORE_FAILED };
      }
    });
  }

  /**
   * One meeting, decrypted (W5's content GET). Returns null when there is no row; THROWS when a
   * blob exists but cannot be opened as this tenant's — an unreadable meeting is a failure,
   * never a quiet "you have no meetings".
   */
  async get(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<StoredMeeting | null> {
    const target = normalizeTarget(source, address, sourceId);
    return this.lane(target.source, target.address, () =>
      this.readMeeting(target.source, target.address, target.sourceId),
    );
  }

  /**
   * Metadata for every live row, newest first (W5's list GET). Strictly read-only — no counter
   * moves, no stamp, no write (§9 anti-pattern 5). Tombstoned ids are not rows and are absent.
   */
  async list(source: string, address: string): Promise<ContentMeta[]> {
    const target = normalizeTarget(source, address);
    const index = await this.lane(target.source, target.address, () =>
      this.openIndex(target.source, target.address),
    );
    return [...index.meetings].sort((a, b) => sortKey(b) - sortKey(a));
  }

  /**
   * W5's reconcile-ack: the browser wrote the user's OWN space, so stamp `reconciledAt`. The
   * server copy remains available while sync is on; if sync is off, the route deletes this
   * reconciled copy after the acknowledgement.
   *
   * Throws on a failed write — a stamp reported for a write that did not land makes the browser
   * stop re-reconciling a meeting the server still believes is unreconciled.
   */
  async markReconciled(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<boolean> {
    const target = normalizeTarget(source, address, sourceId);
    return this.lane(target.source, target.address, async () => {
      const index = await this.openIndex(target.source, target.address);
      const meta = index.meetings.find((m) => m.sourceId === target.sourceId);
      if (meta === undefined) return false;

      const stamp = new Date(this.now()).toISOString();
      const updated: ContentMeta = { ...meta, reconciledAt: stamp };
      // Blob FIRST, index second — matching `upsert`. A failure between them leaves the INDEX
      // un-stamped, so the row still surfaces in `?reconciled=false` and the browser retries; if
      // the index write itself fails, the throw propagates and the route answers 503 without any
      // half-written state anywhere. The reverse (index first) stamps the row visible-to-`list()`
      // but not to `get()`, and W6's discovery filter would drop it from the retry set.
      const stored = await this.readMeeting(
        target.source,
        target.address,
        target.sourceId,
      );
      if (stored !== null) {
        await this.writeMeeting(
          target.source,
          target.address,
          updated,
          stored.content,
        );
      }
      await this.writeIndex(target.source, target.address, {
        meetings: index.meetings.map((m) =>
          m.sourceId === target.sourceId ? updated : m,
        ),
        tombstones: index.tombstones,
      });
      this.counters.reconciled += 1;
      // W8's reconcile-lag metric (plan §8.1 W8). Recorded HERE because this is the only place
      // that holds both ends of it — the browser's ack does not know when the row was stored.
      // What crosses into the metric is the DURATION alone: no id, no address, no stamp.
      // A malformed storedAt would push NaN through subtraction into the p95 window — dropped
      // rather than recorded so the metric never absorbs a value the p95 computation cannot use.
      const storedAtMs = Date.parse(meta.storedAt);
      if (Number.isFinite(storedAtMs)) {
        recordReconcileLag(this.now() - storedAtMs);
      }
      logContent(
        `op=reconciled result=ok source=${target.source} ` +
          `mid=${hashed(target.sourceId)} aid=${hashed(target.address)}`,
      );
      return true;
    });
  }

  async sweepRetention(input: {
    source: string;
    address: string;
  }): Promise<{
    swept: number;
    bytesFreed: number;
    tombstones: number;
    storedAtBackfilled: number;
    unreadableIndex: boolean;
  }> {
    const target = normalizeTarget(input.source, input.address);
    return this.lane(target.source, target.address, async () => {
      let index: ContentIndex | null = null;
      const now = this.now();
      try {
        this.contentMaster();
        index = await this.openIndex(target.source, target.address);
      } catch (error) {
        if (
          !(error instanceof ContentIndexUnreadableError) &&
          !(error instanceof ContentMasterUnavailableError)
        ) {
          throw error;
        }
        this.counters.unreadableIndexes += 1;
        await this.noteRetentionFailure(target.source, target.address);
      }
      if (index !== null) {
        await this.clearRetentionFailure(target.source, target.address);
      }

      const indexed = new Map(
        (index?.meetings ?? []).map((meta) => [meta.sourceId, meta] as const),
      );
      const ids = new Set([
        ...indexed.keys(),
        ...(await this.blobs.listContentIds(target.source, target.address))
          .map(({ sourceId }) => sourceId),
      ]);
      const expired: Array<{
        sourceId: string;
        meta: ContentMeta;
        missing: boolean;
      }> = [];
      for (const sourceId of ids) {
        const indexMeta = indexed.get(sourceId);
        let stored: StoredMeeting | null;
        try {
          stored = await this.readMeeting(target.source, target.address, sourceId);
        } catch {
          // An unreadable or malformed expiry is not evidence that content may be deleted.
          this.warnUnreadableExpiry(target.source, target.address, sourceId);
          continue;
        }
        if (stored === null) {
          if (
            indexMeta === undefined ||
            indexMeta.expiresAt === undefined ||
            !isUtcDate(indexMeta.expiresAt)
          ) {
            this.warnUnreadableExpiry(target.source, target.address, sourceId);
            continue;
          }
          let expectedExpiry: string;
          try {
            expectedExpiry = expiryDateForStoredAt(
              indexMeta.storedAt,
              this.retentionMs,
            );
          } catch {
            this.warnUnreadableExpiry(target.source, target.address, sourceId);
            continue;
          }
          if (
            expectedExpiry !== indexMeta.expiresAt ||
            Date.parse(indexMeta.storedAt) > now
          ) {
            this.warnUnreadableExpiry(target.source, target.address, sourceId);
            continue;
          }
          // The row is already absent; prune its readable index entry on this pass.
          expired.push({ sourceId, meta: indexMeta, missing: true });
          continue;
        }
        const meta = stored.meta;
        let expectedExpiry: string;
        try {
          expectedExpiry = expiryDateForStoredAt(meta.storedAt, this.retentionMs);
        } catch {
          this.warnUnreadableExpiry(target.source, target.address, sourceId);
          continue;
        }
        if (
          Date.parse(meta.storedAt) > now ||
          meta.expiresAt === undefined ||
          !isUtcDate(meta.expiresAt) ||
          meta.expiresAt !== expectedExpiry
        ) {
          this.warnUnreadableExpiry(target.source, target.address, sourceId);
          continue;
        }
        const deadline = expiryDeadline(meta.expiresAt);
        if (deadline === null) {
          this.warnUnreadableExpiry(target.source, target.address, sourceId);
          continue;
        }
        if (now >= deadline) {
          expired.push({ sourceId, meta, missing: false });
        }
      }

      const confirmed: typeof expired = [];
      for (const candidate of expired) {
        try {
          await this.writeReplayMarker(
            target.source,
            target.address,
            candidate.sourceId,
          );
          confirmed.push(candidate);
        } catch {
          warnContent(
            `op=retention-sweep result=tombstone_write_failed source=${target.source} ` +
              `mid=${hashed(candidate.sourceId)} aid=${hashed(target.address)}`,
          );
        }
      }

      let tombstones = index?.tombstones.length ?? 0;
      if (index !== null) {
        const removedIds = new Set(confirmed.map(({ sourceId }) => sourceId));
        const retainedTombstones = index.tombstones.filter((item) => {
          const legacyExpiry = Math.min(
            Date.parse(item.expiresAt),
            Date.parse(item.sweptAt) + this.retentionMs,
          );
          return Number.isFinite(legacyExpiry) && legacyExpiry > now;
        });
        const nextTombstones = this.capTombstones(
          target.source,
          target.address,
          retainedTombstones,
        );
        tombstones = nextTombstones.length;
        if (
          removedIds.size > 0 ||
          nextTombstones.length !== index.tombstones.length
        ) {
          await this.writeIndex(target.source, target.address, {
            meetings: index.meetings.filter((meta) => !removedIds.has(meta.sourceId)),
            tombstones: nextTombstones,
          });
        }
      }

      let swept = 0;
      let bytesFreed = 0;
      for (const candidate of confirmed) {
        try {
          if (!candidate.missing) {
            this.assertMutationAllowed();
            await this.blobs.remove(
              target.source,
              target.address,
              candidate.sourceId,
            );
            bytesFreed += candidate.meta.sizeBytes;
          }
          swept += 1;
        } catch {
          warnContent(
            `op=retention-sweep result=blob_delete_failed source=${target.source} ` +
              `mid=${hashed(candidate.sourceId)} aid=${hashed(target.address)}`,
          );
        }
      }
      this.counters.swept += swept;
      if (swept > 0 || tombstones !== (index?.tombstones.length ?? 0)) {
        logContent(
          `op=retention-sweep result=ok source=${target.source} ` +
            `aid=${hashed(target.address)} swept=${swept} ` +
            `bytes=${bytesFreed} tombstones=${tombstones}`,
        );
      }
      return {
        swept,
        bytesFreed,
        tombstones,
        storedAtBackfilled: 0,
        unreadableIndex: index === null,
      };
    });
  }
  async sweepExpiredReplayTombstones(): Promise<number> {
    this.contentMaster();
    const now = this.now();
    const markers = await this.blobs.listReplayTombstones();
    let removed = 0;
    for (const { digest, marker } of markers) {
      if (
        marker === null ||
        typeof marker.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(marker.expiresAt)) ||
        typeof marker.mac !== "string" ||
        !this.replayMarkerMacValid(digest, marker)
      ) {
        warnContent("op=replay-tombstone-sweep result=unreadable_marker");
        continue;
      }
      if (now >= Date.parse(marker.expiresAt)) {
        this.assertMutationAllowed();
        await this.blobs.removeReplayTombstone(digest);
        removed += 1;
      }
    }
    if (removed > 0) {
      logContent(`op=replay-tombstone-sweep result=ok removed=${removed}`);
    }
    return removed;
  }


  /**
   * The worker's {@link RetentionGuard}. A check that FAILS propagates — the worker holds the
   * item rather than reading a failure as "not tombstoned" (delta 5).
   */
  async tombstoned(input: {
    source: string;
    address: string;
    meetingId: string;
    kind?: string;
    sourceTimestamp?: string;
  }): Promise<boolean> {
    const target = normalizeTarget(input.source, input.address, input.meetingId);
    return this.lane(target.source, target.address, async () => {
      const index = await this.openIndex(target.source, target.address);
      if (index.tombstones.some((t) => t.sourceId === target.sourceId)) {
        return true;
      }
      if (
        await this.replayMarker(
          target.source,
          target.address,
          target.sourceId,
        )
      ) {
        return true;
      }
      // W7: the same purge verdict the upsert applies, one step earlier — a purged id must cost
      // neither a store nor an upstream FETCH. A ledger this cannot read throws to the worker,
      // which holds the item (its `retention_unavailable` arm) instead of fetching.
      return this.purgeTombstoned(target.source, target.address, target.sourceId, {
        ...(input.sourceTimestamp !== undefined
          ? { ts: input.sourceTimestamp }
          : {}),
      });
    });
  }

  /**
   * W7's teardown primitive: every row, the index and the tombstones for ONE address. Scoped by
   * construction — there is no verb here that can reach another tenant.
   *
   * It deletes; it does NOT tombstone. The redelivery-proof half is the §6.2 purge ledger, which
   * `ConnectorTeardownService` writes BEFORE calling this (a delete without a durable watermark
   * is a delete an at-least-once replay undoes) and {@link purgeTombstoned} then enforces on
   * every later upsert. Keeping the watermark out of the index is deliberate: `removeAll` sweeps
   * the index key itself, so a tombstone stored there would be swept with the rows it protects.
   */
  /** Sync-off only removes copies whose index and authenticated blob both prove reconciliation. */
  async deleteReconciled(source: string, address: string): Promise<{ removed: number }> {
    const target = normalizeTarget(source, address);
    return this.lane(target.source, target.address, async () => {
      this.contentMaster();
      const index = await this.openIndex(target.source, target.address);
      const removed = new Set<string>();
      for (const meta of index.meetings) {
        if (!meta.reconciledAt) continue;
        let stored: StoredMeeting | null;
        try {
          stored = await this.readMeeting(target.source, target.address, meta.sourceId);
        } catch {
          warnContent("op=sync-off result=envelope_refused");
          continue;
        }
        if (!stored || JSON.stringify(stored.meta) !== JSON.stringify(meta)) {
          warnContent("op=sync-off result=metadata_mismatch");
          continue;
        }
        this.assertMutationAllowed();
        await this.blobs.remove(target.source, target.address, meta.sourceId);
        removed.add(meta.sourceId);
      }
      if (removed.size) {
        await this.writeIndex(target.source, target.address, {
          meetings: index.meetings.filter(meta => !removed.has(meta.sourceId)),
          tombstones: index.tombstones,
        });
      }
      return { removed: removed.size };
    });
  }

  async purge(source: string, address: string): Promise<{ removed: number }> {
    const target = normalizeTarget(source, address);
    return this.lane(target.source, target.address, async () => {
      // Even when no index exists, purge may remove orphaned ciphertext. Require the key first
      // so an unavailable master cannot turn an unverified archive into a successful purge.
      this.contentMaster();
      const index = await this.openIndex(target.source, target.address);
      for (const meta of index.meetings) {
        this.assertMutationAllowed();
        await this.blobs.remove(target.source, target.address, meta.sourceId);
      }
      this.assertMutationAllowed();
      await this.blobs.removeAll(target.source, target.address);
      logContent(
        `op=purge result=ok source=${target.source} ` +
          `aid=${hashed(target.address)} removed=${index.meetings.length}`,
      );
      return { removed: index.meetings.length };
    });
  }

  // ── Purge tombstones (W7, delta 12) ────────────────────────────────

  /**
   * The §6.2 verdict for one identity, from the SHIPPED ledger and the SHIPPED rule
   * ({@link isTombstoned}) — recentIds, then the `purgedThrough` watermark against the
   * PROVIDER's timestamp, with an absent or unparseable stamp treated as tombstoned. A second
   * copy of that rule here is how the browser drain and the server store start disagreeing
   * about what a purge covers, so there is none.
   *
   * `receivedAt` is deliberately `now`: the shipped rule ignores it (a redelivery refreshes it,
   * so it is always on the safe side of the watermark) and only `sourceTimestamp` decides.
   */
  private async purgeTombstoned(
    source: string,
    address: string,
    sourceId: string,
    stamps: { ts?: string },
  ): Promise<boolean> {
    if (this.purgeLedger === null) return false;
    const read = await this.purgeLedger.readLedger(source, address);
    if (read.status === "absent") return false;
    if (read.status !== "ok") {
      // Reading an unparseable ledger as empty means "nothing was ever purged", the most
      // dangerous available reading (§6.2). Quarantine belongs to the writers; here it fails.
      warnContent(
        `op=purge-check result=ledger_unreadable source=${source} ` +
          `mid=${hashed(sourceId)} aid=${hashed(address)}`,
      );
      throw new Error("purge ledger is unreadable");
    }
    const ledger: PurgeLedger = read.ledger;
    return isTombstoned(
      {
        meetingId: sourceId,
        receivedAt: new Date(this.now()).toISOString(),
        ...(stamps.ts !== undefined ? { sourceTimestamp: stamps.ts } : {}),
      },
      ledger,
    );
  }

  // ── Caps (delta 8) ─────────────────────────────────────────────────

  /**
   * Oldest-drop until the incoming row fits both per-user caps. Every eviction is counted and
   * logged with a hashed id — a cap that drops data silently reads, months later, as data that
   * never arrived.
   *
   * Eviction writes NO tombstone, and that is a decision, not an omission: the two permanent
   * markers (the D2a retention sweep and the §6.2 purge ledger) both mean "the user no longer has
   * this", while a cap eviction means only "this did not fit today". So a later delivery for an
   * evicted meeting may re-store it and evict the current oldest in turn — under indefinite replay
   * the cap behaves as churn rather than a bound. Recorded, with the cost, in
   * `docs/connector-webhooks-purge-tombstone.md` §5 and pinned by the delta-8 suite.
   */
  private enforceCaps(
    source: string,
    address: string,
    others: ContentMeta[],
    incoming: ContentMeta,
  ): { kept: ContentMeta[]; evicted: ContentMeta[] } {
    // Oldest first, so the drop order is the documented one.
    const kept = [...others].sort((a, b) => sortKey(a) - sortKey(b));
    const evicted: ContentMeta[] = [];
    let bytes = kept.reduce((sum, m) => sum + m.sizeBytes, 0);

    const drop = (reason: string): void => {
      const victim = kept.shift();
      if (victim === undefined) return;
      bytes -= victim.sizeBytes;
      evicted.push(victim);
      this.counters.droppedOverflow += 1;
      warnContent(
        `op=overflow-drop reason=${reason} source=${source} ` +
          `mid=${hashed(victim.sourceId)} aid=${hashed(address)} ` +
          `bytes=${victim.sizeBytes}`,
      );
    };

    while (kept.length + 1 > this.maxUserMeetings && kept.length > 0) {
      drop("user_meeting_cap");
    }
    while (bytes + incoming.sizeBytes > this.maxUserBytes && kept.length > 0) {
      drop("user_byte_cap");
    }
    return { kept, evicted };
  }

  private capTombstones(
    source: string,
    address: string,
    tombstones: RetentionTombstone[],
  ): RetentionTombstone[] {
    const unique = new Map<string, RetentionTombstone>();
    for (const tombstone of tombstones) unique.set(tombstone.sourceId, tombstone);
    const ordered = [...unique.values()].sort(
      (a, b) => Date.parse(a.sweptAt) - Date.parse(b.sweptAt),
    );
    if (ordered.length <= this.maxUserTombstones) return ordered;

    const dropped = ordered.length - this.maxUserTombstones;
    // No silent caps: past this many, the oldest id stops being replay-protected.
    warnContent(
      `op=tombstone-evict reason=tombstone_cap source=${source} ` +
        `aid=${hashed(address)} dropped=${dropped} cap=${this.maxUserTombstones}`,
    );
    return ordered.slice(dropped);
  }

  // ── Sealed I/O ─────────────────────────────────────────────────────

  private async openIndex(
    source: string,
    address: string,
  ): Promise<ContentIndex> {
    let blob: SealedBlob | null;
    try {
      blob = await this.blobs.readIndex(source, address);
    } catch (error) {
      if (error instanceof ContentBlobUnparseableError) {
        throw new ContentIndexUnreadableError();
      }
      throw error;
    }
    if (blob === null) return { meetings: [], tombstones: [] };
    let index: ContentIndex;
    try {
      if (
        blob.keyFingerprint !== undefined &&
        blob.keyFingerprint !== contentMasterFingerprint(this.contentMaster())
      ) {
        throw new ContentIndexUnreadableError();
      }
      const plaintext = this.unseal(source, address, "index", blob);
      index = parseIndex(plaintext, this.now());
    } catch (error) {
      if (error instanceof ContentMasterUnavailableError) throw error;
      throw new ContentIndexUnreadableError();
    }
    const now = this.now();
    const tombstones = index.tombstones.filter(
      (tombstone) => Date.parse(tombstone.expiresAt) > now,
    );
    if (tombstones.length !== index.tombstones.length) {
      await this.writeIndex(source, address, {
        meetings: index.meetings,
        tombstones,
      });
    }
    return { meetings: index.meetings, tombstones };
  }

  private async writeIndex(
    source: string,
    address: string,
    index: ContentIndex,
  ): Promise<void> {
    this.assertMutationAllowed();
    await this.blobs.writeIndex(
      source,
      address,
      this.sealBlob(source, address, "index", JSON.stringify(index)),
    );
  }

  private async readMeeting(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<StoredMeeting | null> {
    const blob = await this.blobs.read(source, address, sourceId);
    if (blob === null) return null;
    if (blob.expiresAt !== undefined && !isUtcDate(blob.expiresAt)) {
      throw new Error("content expiry is unreadable");
    }
    const plaintext = this.unseal(source, address, sourceId, blob);
    const meeting = parseMeeting(plaintext, sourceId);
    if (meeting.meta.expiresAt !== blob.expiresAt) {
      throw new Error("content expiry does not match its envelope");
    }
    return meeting;
  }

  private async writeMeeting(
    source: string,
    address: string,
    meta: ContentMeta,
    content: MeetingContent,
  ): Promise<void> {
    this.assertMutationAllowed();
    await this.blobs.write(
      source,
      address,
      meta.sourceId,
      this.sealBlob(
        source,
        address,
        meta.sourceId,
        JSON.stringify({ meta, content }),
        meta.storedAt,
        meta.expiresAt,
      ),
    );
  }

  private sealBlob(
    source: string,
    address: string,
    scope: string,
    plaintext: string,
    storedAt?: string,
    expiresAt?: string,
  ): SealedBlob {
    const aad = envelopeAad(source, address, scope, expiresAt);
    const dek = randomBytes(DEK_BYTES);
    const master = this.contentMaster();
    return {
      ciphertext: seal(dek, Buffer.from(plaintext, "utf8"), aad),
      wrappedDEK: seal(keyEncryptionKey(master, source, address), dek, aad),
      ...(storedAt === undefined ? {} : { storedAt }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(scope === "index"
        ? { keyFingerprint: contentMasterFingerprint(master) }
        : {}),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }
  private unseal(
    source: string,
    address: string,
    scope: string,
    blob: SealedBlob,
  ): string {
    try {
      const aad = envelopeAad(source, address, scope, blob.expiresAt);
      const kek = keyEncryptionKey(this.contentMaster(), source, address);
      const dek = open(kek, blob.wrappedDEK, aad);
      return open(dek, blob.ciphertext, aad).toString("utf8");
    } catch (error) {
      warnContent("op=decrypt result=envelope_refused");
      throw error;
    }
  }

  /**
   * One read-modify-write at a time per tenant. Without it two deliveries for the same user
   * both read the index, both write it, and one of them silently loses its row — the shipped
   * queue's per-address mutex, one layer down.
   */
  private lane<T>(
    source: string,
    address: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${source} ${address}`;
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(key, tail);
    void tail.then(() => {
      // Keep the map bounded: a tenant that is idle again holds no entry.
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    });
    return next;
  }
}

// ── Parsing (a substrate value is never trusted) ─────────────────────

function parseMeta(raw: unknown): ContentMeta | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isValidMeetingId(value.sourceId)) return null;
  if (typeof value.storedAt !== "string" || typeof value.updatedAt !== "string") {
    return null;
  }
  if (value.expiresAt !== undefined && !isUtcDate(value.expiresAt)) return null;
  const sizeBytes =
    typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)
      ? value.sizeBytes
      : 0;
  const participantNames = parseBoundedStrings(value.participantNames, false);
  const participantEmails = parseBoundedStrings(value.participantEmails, true);
  const organizerEmail = parseBoundedEmail(value.organizerEmail);
  if (participantNames === null || participantEmails === null || organizerEmail === null) return null;
  return {
    sourceId: value.sourceId,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.ts === "string" ? { ts: value.ts } : {}),
    ...(participantNames === undefined ? {} : { participantNames }),
    ...(participantEmails === undefined ? {} : { participantEmails }),
    ...(organizerEmail === undefined ? {} : { organizerEmail }),
    ...(typeof value.transcriptStoredAt === "string"
      ? { transcriptStoredAt: value.transcriptStoredAt }
      : {}),
    ...(typeof value.summaryStoredAt === "string"
      ? { summaryStoredAt: value.summaryStoredAt }
      : {}),
    sizeBytes,
    storedAt: value.storedAt,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as string }),
    updatedAt: value.updatedAt,
    ...(typeof value.reconciledAt === "string"
      ? { reconciledAt: value.reconciledAt }
      : {}),
  };
}

function parseBoundedEmail(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value.toLocaleLowerCase();
}

function parseBoundedStrings(value: unknown, emails: boolean): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 256) return null;
    const normalized = emails ? parseBoundedEmail(item) : item.trim().replace(/\s+/g, " ");
    if (!normalized) return null;
    if (!result.some((existing) => existing.toLocaleLowerCase() === normalized.toLocaleLowerCase())) result.push(normalized);
  }
  return result;
}

function parseIndex(plaintext: string, now: number): ContentIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    throw new Error("content index is unreadable");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("content index is unreadable");
  }
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.meetings) || !Array.isArray(value.tombstones)) {
    throw new Error("content index is unreadable");
  }
  const meetings: ContentMeta[] = [];
  for (const entry of value.meetings) {
    const meta = parseMeta(entry);
    if (meta === null) throw new Error("content index is unreadable");
    meetings.push(meta);
  }
  const tombstones: RetentionTombstone[] = [];
  for (const entry of value.tombstones) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (
      !isValidMeetingId(t.sourceId) ||
      typeof t.sweptAt !== "string" ||
      typeof t.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(t.expiresAt)) ||
      Date.parse(t.expiresAt) <= now
    ) continue;
    tombstones.push({
      sourceId: t.sourceId,
      sweptAt: t.sweptAt,
      expiresAt: t.expiresAt,
    });
  }
  return { meetings, tombstones };
}

function parseMeeting(plaintext: string, sourceId: string): StoredMeeting {
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    throw new Error("content payload is unreadable");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("content payload is unreadable");
  }
  const value = raw as Record<string, unknown>;
  const meta = parseMeta(value.meta);
  if (meta === null || meta.sourceId !== sourceId) {
    // A blob that names a different meeting is not this meeting, whatever key it sits under.
    throw new Error("content payload is unreadable");
  }
  const content =
    typeof value.content === "object" && value.content !== null
      ? (value.content as Record<string, unknown>)
      : {};
  return {
    meta,
    content: {
      ...(content.transcript !== undefined
        ? { transcript: content.transcript }
        : {}),
      ...(content.summary !== undefined ? { summary: content.summary } : {}),
    },
  };
}


/**
 * List-order reference (W5's `list()`). The user cares about the meeting DATE, not the storage
 * stamp — a re-uploaded old recording belongs where the meeting actually happened. Retention
 * cannot use this because the same field is attacker-influenced (see {@link retentionAgeOf}).
 */
function sortKey(meta: ContentMeta): number {
  const provider = meta.ts === undefined ? NaN : Date.parse(meta.ts);
  if (Number.isFinite(provider)) return provider;
  const stored = Date.parse(meta.storedAt);
  return Number.isFinite(stored) ? stored : 0;
}

function normalizeTarget(
  source: unknown,
  address: unknown,
  sourceId?: unknown,
): { source: string; address: string; sourceId: string } {
  if (!isValidSource(source)) throw new Error("Invalid content source");
  const normalizedAddress = normalizeWebhookAddress(address);
  if (sourceId === undefined) {
    return { source, address: normalizedAddress, sourceId: "" };
  }
  if (!isValidMeetingId(sourceId)) throw new Error("Invalid meeting id");
  return { source, address: normalizedAddress, sourceId };
}

// ── Adapters ─────────────────────────────────────────────────────────

/**
 * The dev/test binding. `dump()` exists for one reason: the acceptance tests grep the raw bytes
 * for a plaintext transcript, summary or title. It is NOT a list surface for the store — nothing
 * in {@link ContentStore} calls it and no route can reach it.
 */
export class InMemoryContentBlobStore implements ContentBlobStore {
  private readonly blobs = new Map<string, string>();
  private readonly keyFailures = new Map<string, string>();

  async readIndex(source: string, address: string): Promise<SealedBlob | null> {
    return this.get(indexSlot(source, address));
  }

  async writeIndex(
    source: string,
    address: string,
    blob: SealedBlob,
  ): Promise<void> {
    this.blobs.set(indexSlot(source, address), JSON.stringify(blob));
  }
  async removeIndex(source: string, address: string): Promise<void> {
    this.blobs.delete(indexSlot(source, address));
  }
  async readKeyFailureSince(
    source: string,
    address: string,
  ): Promise<string | null> {
    return this.keyFailures.get(indexSlot(source, address)) ?? null;
  }

  async writeKeyFailureSince(
    source: string,
    address: string,
    firstFailureAt: string,
  ): Promise<void> {
    this.keyFailures.set(indexSlot(source, address), firstFailureAt);
  }

  async clearKeyFailureSince(
    source: string,
    address: string,
  ): Promise<void> {
    this.keyFailures.delete(indexSlot(source, address));
  }

  async read(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<SealedBlob | null> {
    return this.get(contentSlot(source, address, sourceId));
  }

  async write(
    source: string,
    address: string,
    sourceId: string,
    blob: SealedBlob,
  ): Promise<void> {
    this.blobs.set(contentSlot(source, address, sourceId), JSON.stringify(blob));
  }

  async remove(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<void> {
    this.blobs.delete(contentSlot(source, address, sourceId));
  }
  async readReplayTombstone(digest: string): Promise<ReplayTombstoneRecord | null> {
    const raw = this.blobs.get(replayTombstoneSlot(digest));
    if (raw === undefined) return null;
    return JSON.parse(raw) as ReplayTombstoneRecord;
  }

  async writeReplayTombstone(
    digest: string,
    marker: ReplayTombstoneRecord,
  ): Promise<void> {
    this.blobs.set(replayTombstoneSlot(digest), JSON.stringify(marker));
  }

  async removeReplayTombstone(digest: string): Promise<void> {
    this.blobs.delete(replayTombstoneSlot(digest));
  }

  async listReplayTombstones(): Promise<Array<{
    digest: string;
    marker: ReplayTombstoneRecord | null;
  }>> {
    const prefix = "replay:";
    return [...this.blobs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, raw]) => {
        try {
          return {
            digest: key.slice(prefix.length),
            marker: JSON.parse(raw) as ReplayTombstoneRecord,
          };
        } catch {
          return { digest: key.slice(prefix.length), marker: null };
        }
      });
  }
  async listContentIds(
    source: string,
    address: string,
  ): Promise<Array<{ sourceId: string; storedAt?: string; updatedAt: string }>> {
    const prefix = contentSlot(source, address, "");
    return [...this.blobs.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter(isValidMeetingId)
      .map((sourceId) => {
        const blob = this.get(contentSlot(source, address, sourceId));
        const storedAt = blob?.storedAt;
        return {
          sourceId,
          ...(storedAt === undefined
            ? {}
            : { storedAt: typeof storedAt === "string" ? storedAt : "" }),
          updatedAt: blob?.updatedAt ?? "",
        };
      });
  }

  async removeAll(source: string, address: string): Promise<void> {
    const prefix = `${contentSlot(source, address, "")}`;
    for (const key of [...this.blobs.keys()]) {
      if (key === indexSlot(source, address) || key.startsWith(prefix)) {
        this.blobs.delete(key);
      }
    }
    this.keyFailures.delete(indexSlot(source, address));
  }

  /** Every stored byte, exactly as the substrate would hold it. */
  dump(): string {
    return JSON.stringify([...this.blobs.entries()]);
  }

  private get(slot: string): SealedBlob | null {
    const raw = this.blobs.get(slot);
    if (raw === undefined) return null;
    const parsed = JSON.parse(raw) as SealedBlob;
    return parsed;
  }
}

function indexSlot(source: string, address: string): string {
  return `index:${source} ${address}`;
}

function contentSlot(
  source: string,
  address: string,
  sourceId: string,
): string {
  return `content:${source} ${address} ${sourceId}`;
}
function replayTombstoneSlot(digest: string): string {
  return `replay:${digest}`;
}
function replayTombstoneKvKey(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Invalid replay tombstone digest");
  }
  return `${REPLAY_TOMBSTONE_KEY_PREFIX}/${digest}`;
}

function keyFailureKey(source: string, address: string): string {
  if (!isValidSource(source)) throw new Error("Invalid content source");
  return `${CONTENT_KEY_FAILURE_PREFIX}/${source}/${normalizeWebhookAddress(address)}`;
}

/**
 * The interim substrate binding: the backend's OWN TinyCloud KV (auto-prefixed under
 * `ops.tinychat.backend`, never a user space). PER-ITEM content keys — plan §7: a KV RMW array
 * is not a content store — plus ONE sealed metadata index per tenant, which is what makes a list
 * a single read instead of N. One sequential lane (TinyCloud drops concurrent responses on a
 * single space) and every call result-checked inside `withSessionRefresh`, because a `{ok:false}`
 * read cast to `undefined` would read as "this user has no meetings".
 */
export class KvContentBlobStore implements ContentBlobStore {
  private readonly lane: BackendStorageLane;

  /**
   * Optional `storageLane` funnels writes through the SAME lane the queue and credential store
   * use — a fix for the cross-component KV concurrency the code audit flagged. Absent = private
   * per-instance lane (the standalone default). index.ts wires the shared lane in production.
   */
  constructor(
    private readonly node: TinyCloudNode,
    storageLane?: BackendStorageLane,
  ) {
    this.lane = storageLane ?? new BackendStorageLane();
  }

  readCanary(): Promise<SealedBlob | null> {
    return this.run(() => this.readBlob("connector-content-continuity/v1"));
  }

  writeCanary(blob: SealedBlob): Promise<void> {
    return this.run(() => this.writeBlob("connector-content-continuity/v1", blob));
  }

  private async firstKey(prefix: string): Promise<string | null> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = await this.run(() => withSessionRefresh(this.node, async () =>
        assertKvResult(await this.node.kv.list({ prefix, ...(cursor ? { cursor } : {}) })),
      ));
      const data = (result as { data?: { keys?: unknown; truncated?: boolean; nextCursor?: string } })?.data;
      if (!data || !Array.isArray(data.keys)) throw new Error("content listing unavailable");
      const keys = extractKeys(data.keys);
      if (keys.length !== data.keys.length || keys.some(key => !key.startsWith(prefix))) throw new Error("content listing invalid");
      if (keys.length) return keys[0]!;
      const next = data.nextCursor;
      if (!next) {
        if (data.truncated) throw new Error("content listing truncated");
        return null;
      }
      if (seen.has(next)) throw new Error("content listing repeated cursor");
      seen.add(next);
      cursor = next;
    }
    throw new Error("content listing truncated");
  }

  async findIndex(): Promise<{ source: string; address: string } | null> {
    const key = await this.firstKey(`${CONTENT_INDEX_KEY_PREFIX}/`);
    if (!key) return null;
    const parts = key.split("/");
    if (parts.length !== 3 || !isValidSource(parts[1]!)) throw new Error("content index invalid");
    const address = normalizeWebhookAddress(parts[2]!);
    return { source: parts[1]!, address };
  }

  async hasContent(): Promise<boolean> {
    return (await this.firstKey(`${CONTENT_KEY_PREFIX}/`)) !== null;
  }

  readIndex(source: string, address: string): Promise<SealedBlob | null> {
    return this.run(() => this.readBlob(indexKey(source, address)));
  }

  writeIndex(
    source: string,
    address: string,
    blob: SealedBlob,
  ): Promise<void> {
    return this.run(() => this.writeBlob(indexKey(source, address), blob));
  }
  removeIndex(source: string, address: string): Promise<void> {
    return this.run(() => this.deleteKey(indexKey(source, address)));
  }
  async readKeyFailureSince(
    source: string,
    address: string,
  ): Promise<string | null> {
    const key = keyFailureKey(source, address);
    const result = await this.run(() =>
      withSessionRefresh(this.node, async () => {
        const value = await this.node.kv.get(key);
        if (isKvMissingKeyResult(value, key)) return null;
        return assertKvResult(value);
      }),
    );
    let raw: unknown = result;
    while (
      typeof raw === "object" &&
      raw !== null &&
      "data" in raw
    ) {
      raw = (raw as { data: unknown }).data;
    }
    if (raw === null || raw === undefined) return null;
    const value =
      typeof raw === "string"
        ? (() => {
            try {
              return JSON.parse(raw) as unknown;
            } catch {
              return null;
            }
          })()
        : raw;
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { firstFailureAt?: unknown }).firstFailureAt !== "string"
    ) {
      throw new Error("content key failure marker is unreadable");
    }
    return (value as { firstFailureAt: string }).firstFailureAt;
  }

  async writeKeyFailureSince(
    source: string,
    address: string,
    firstFailureAt: string,
  ): Promise<void> {
    const key = keyFailureKey(source, address);
    await this.run(() =>
      withSessionRefresh(this.node, async () => {
        assertKvResult(
          await this.node.kv.put(key, { firstFailureAt }),
        );
      }),
    );
  }

  clearKeyFailureSince(source: string, address: string): Promise<void> {
    return this.run(() => this.deleteKey(keyFailureKey(source, address)));
  }


  read(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<SealedBlob | null> {
    return this.run(() => this.readBlob(contentKey(source, address, sourceId)));
  }

  write(
    source: string,
    address: string,
    sourceId: string,
    blob: SealedBlob,
  ): Promise<void> {
    return this.run(() =>
      this.writeBlob(contentKey(source, address, sourceId), blob),
    );
  }

  remove(source: string, address: string, sourceId: string): Promise<void> {
    return this.run(() =>
      this.deleteKey(contentKey(source, address, sourceId)),
    );
  }
  async readReplayTombstone(
    digest: string,
  ): Promise<ReplayTombstoneRecord | null> {
    const key = replayTombstoneKvKey(digest);
    const result = await this.run(() =>
      withSessionRefresh(this.node, async () => {
        const value = await this.node.kv.get(key);
        if (isKvMissingKeyResult(value, key)) return null;
        return assertKvResult(value);
      }),
    );
    let raw: unknown = result;
    while (typeof raw === "object" && raw !== null && "data" in raw) {
      raw = (raw as { data: unknown }).data;
    }
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw) as unknown;
      } catch {
        throw new ContentBlobUnparseableError();
      }
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ContentBlobUnparseableError();
    }
    return raw as ReplayTombstoneRecord;
  }

  writeReplayTombstone(
    digest: string,
    marker: ReplayTombstoneRecord,
  ): Promise<void> {
    const key = replayTombstoneKvKey(digest);
    return this.run(() =>
      withSessionRefresh(this.node, async () => {
        assertKvResult(await this.node.kv.put(key, marker));
      }),
    );
  }

  removeReplayTombstone(digest: string): Promise<void> {
    return this.run(() => this.deleteKey(replayTombstoneKvKey(digest)));
  }

  async listReplayTombstones(): Promise<Array<{
    digest: string;
    marker: ReplayTombstoneRecord | null;
  }>> {
    const prefix = `${REPLAY_TOMBSTONE_KEY_PREFIX}/`;
    const kv = (
      this.node as unknown as {
        kv?: { list?: (options: unknown) => Promise<unknown> };
      }
    ).kv;
    if (!kv || typeof kv.list !== "function") {
      throw new Error("Replay tombstone listing is unavailable");
    }
    const response = await this.run(() =>
      withSessionRefresh(this.node, async () =>
        assertKvResult(await kv.list!({ prefix })),
      ),
    );
    const keys = extractKeys(response).filter((key) => key.startsWith(prefix));
    const markers: Array<{ digest: string; marker: ReplayTombstoneRecord | null }> = [];
    for (const key of keys) {
      const digest = key.slice(prefix.length);
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        markers.push({ digest, marker: null });
        continue;
      }
      try {
        markers.push({
          digest,
          marker: await this.readReplayTombstone(digest),
        });
      } catch {
        markers.push({ digest, marker: null });
      }
    }
    return markers;
  }

  async listContentIds(
    source: string,
    address: string,
  ): Promise<Array<{ sourceId: string; storedAt?: string; updatedAt: string }>> {
    const prefix =
      `${CONTENT_KEY_PREFIX}/${source}/${normalizeWebhookAddress(address)}/`;
    const kv = (
      this.node as unknown as {
        kv?: { list?: (options: unknown) => Promise<unknown> };
      }
    ).kv;
    if (!kv || typeof kv.list !== "function") {
      throw new Error("Content blob listing is unavailable");
    }
    const response = await this.run(() =>
      withSessionRefresh(this.node, async () =>
        assertKvResult(await kv.list!({ prefix })),
      ),
    );
    const ids = extractKeys(response)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((sourceId) => !sourceId.includes("/") && isValidMeetingId(sourceId));
    const blobs: Array<{ sourceId: string; storedAt?: string; updatedAt: string }> = [];
    for (const sourceId of ids) {
      try {
        const blob = await this.read(source, address, sourceId);
        blobs.push({
          sourceId,
          ...(blob?.storedAt === undefined ? {} : { storedAt: blob.storedAt }),
          updatedAt: blob?.updatedAt ?? "",
        });
      } catch (error) {
        if (!(error instanceof ContentBlobUnparseableError)) throw error;
        warnContentAdapter(
          `op=content-list result=unparseable_blob source=${source} ` +
            `mid=${hashed(sourceId)} aid=${hashed(address)}`,
        );
      }
    }
    return blobs;
  }


  /**
   * Teardown's last sweep. `ContentStore.purge` has already deleted every blob the index named;
   * this drops the index itself and, where the SDK exposes a prefix scan, any ORPHAN left by a
   * crash between a content write and its index write. No scan available means the orphans stay
   * — said out loud in the log rather than reported as a complete teardown.
   */
  async removeAll(source: string, address: string): Promise<void> {
    const prefix = `${CONTENT_KEY_PREFIX}/${source}/${normalizeWebhookAddress(address)}/`;
    const kv = (
      this.node as unknown as {
        kv?: { list?: (options: unknown) => Promise<unknown> };
      }
    ).kv;
    if (kv && typeof kv.list === "function") {
      const response = await this.run(() =>
        withSessionRefresh(this.node, async () =>
          assertKvResult(await kv.list!({ prefix })),
        ),
      );
      for (const key of extractKeys(response)) {
        if (key.startsWith(prefix)) await this.run(() => this.deleteKey(key));
      }
    } else {
      warnContentAdapter(
        `op=purge-scan result=unsupported reason=kv_list_unavailable source=${source}`,
      );
    }
    await this.run(() => this.deleteKey(indexKey(source, address)));
    await this.run(() =>
      this.deleteKey(keyFailureKey(source, address)),
    );
  }

  private async readBlob(key: string): Promise<SealedBlob | null> {
    const result = await withSessionRefresh(this.node, async () => {
      const r = await this.node.kv.get(key);
      if (isKvMissingKeyResult(r, key)) return null;
      return assertKvResult(r);
    });
    // The exact production KV_NOT_FOUND result is converted to null above. Preserve that
    // sentinel through the wrapper before validating a present-value envelope.
    if (result === null) return null;
    if (
      typeof result !== "object" ||
      Array.isArray(result) ||
      !("data" in result)
    ) {
      throw new ContentBlobUnparseableError();
    }
    const response = (result as { data?: unknown }).data;
    // The SDK also represents a missing key as a successful get with data:null.
    if (response === null) return null;
    if (response === undefined) {
      throw new ContentBlobUnparseableError();
    }
    const raw =
      typeof response === "object" &&
      response !== null &&
      "data" in response
        ? (response as { data?: unknown }).data
        : response;
    if (raw === null || raw === undefined) {
      throw new ContentBlobUnparseableError();
    }
    let value: unknown = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        throw new ContentBlobUnparseableError();
      }
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new ContentBlobUnparseableError();
    }
    const blob = value as Record<string, unknown>;
    if (
      typeof blob.ciphertext !== "string" ||
      typeof blob.wrappedDEK !== "string"
    ) {
      // Present but unreadable. Never "absent" — see the class comment.
      throw new ContentBlobUnparseableError();
    }
    return {
      ciphertext: blob.ciphertext,
      wrappedDEK: blob.wrappedDEK,
      ...(blob.storedAt === undefined
        ? {}
        : { storedAt: typeof blob.storedAt === "string" ? blob.storedAt : "" }),
      ...(blob.expiresAt === undefined
        ? {}
        : { expiresAt: typeof blob.expiresAt === "string" ? blob.expiresAt : "" }),
      ...(blob.keyFingerprint === undefined
        ? {}
        : {
            keyFingerprint:
              typeof blob.keyFingerprint === "string"
                ? blob.keyFingerprint
                : "",
          }),
      updatedAt:
        typeof blob.updatedAt === "string"
          ? blob.updatedAt
          : new Date(0).toISOString(),
    };
  }

  private async writeBlob(key: string, blob: SealedBlob): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      assertKvResult(await this.node.kv.put(key, blob));
    });
  }

  private async deleteKey(key: string): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.delete(key);
      if (isKvMissingKeyResult(result, key)) return;
      assertKvResult(result);
    });
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    return this.lane.run(fn);
  }
}

/** The adapter's own log lane — it holds no master and never sees a plaintext meeting. */
function warnContentAdapter(fields: string): void {
  warnContent(fields);
}

/** KV `list` responses have been seen wrapped, doubly wrapped, and as bare arrays. */
function extractKeys(response: unknown): string[] {
  const seen: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === "string") {
      seen.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const field of ["key", "name", "path"]) {
      if (typeof record[field] === "string") {
        seen.push(record[field] as string);
        return;
      }
    }
    visit(record.keys, depth + 1);
    visit(record.data, depth + 1);
  };
  visit(response, 0);
  return seen;
}

export interface ContentIndexLocation {
  source: string;
  address: string;
}

/**
 * Enumerate every existing sealed content index for retention, including users no longer in the
 * active ingest cohort. A failed list is an error, never an empty directory.
 */
export function createContentIndexDirectory(
  node: TinyCloudNode,
): () => Promise<ContentIndexLocation[]> {
  return async () => {
    const kv = (
      node as unknown as {
        kv?: { list?: (options: unknown) => Promise<unknown> };
      }
    ).kv;
    if (!kv || typeof kv.list !== "function") {
      throw new Error("Content index listing is unavailable");
    }

    const entries = new Map<string, ContentIndexLocation>();
    for (const prefix of [
      CONTENT_INDEX_KEY_PREFIX,
      CONTENT_KEY_PREFIX,
      CONTENT_KEY_FAILURE_PREFIX,
    ]) {
      const marker = `${prefix}/`;
      const response = await withSessionRefresh(node, async () =>
        assertKvResult(await kv.list!({ prefix: marker })),
      );
      for (const key of extractKeys(response)) {
        const markerIndex = key.lastIndexOf(marker);
        if (markerIndex < 0) continue;
        const parts = key.slice(markerIndex + marker.length).split("/");
        const isIndex = prefix === CONTENT_INDEX_KEY_PREFIX;
        const isFailure = prefix === CONTENT_KEY_FAILURE_PREFIX;
        if (parts.length !== (isIndex || isFailure ? 2 : 3)) continue;
        const [source, rawAddress, sourceId] = parts;
        if (
          source === undefined ||
          rawAddress === undefined ||
          !isValidSource(source) ||
          (!isIndex &&
            !isFailure &&
            (sourceId === undefined || !isValidMeetingId(sourceId)))
        ) continue;
        let address: string;
        try {
          address = normalizeWebhookAddress(rawAddress);
        } catch {
          continue;
        }
        entries.set(`${source}/${address}`, { source, address });
      }
    }
    return [...entries.values()];
  };
}

function contentKey(
  source: string,
  address: string,
  sourceId: string,
): string {
  if (!isValidSource(source)) throw new Error("Invalid content source");
  if (!isValidMeetingId(sourceId)) throw new Error("Invalid meeting id");
  return `${CONTENT_KEY_PREFIX}/${source}/${normalizeWebhookAddress(address)}/${sourceId}`;
}

function indexKey(source: string, address: string): string {
  if (!isValidSource(source)) throw new Error("Invalid content source");
  return `${CONTENT_INDEX_KEY_PREFIX}/${source}/${normalizeWebhookAddress(address)}`;
}
