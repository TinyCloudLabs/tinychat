import {
  createHash,
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
 *  - **Retention (14 days).** A stored row is deleted at its backend-observed `storedAt` plus
 *    {@link RETENTION_WINDOW_DAYS}. Retention markers expire at that same instant; they cannot
 *    outlive the row. A provider replay after the window may be accepted again, so the browser
 *    checks the user's own space before delivering an ID.
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

/** Backend-owned ContentStore keys. */
const CONTENT_KEY_PREFIX = "connector-content";
const CONTENT_INDEX_KEY_PREFIX = "connector-content-index";
const CONTENT_KEY_FAILURE_PREFIX = "connector-content-key-failure";

// ── Result / row shapes ──────────────────────────────────────────────

/** What the substrate holds. There is no field here a breach could read as a meeting. */
export interface SealedBlob {
  ciphertext: string;
  wrappedDEK: string;
  /** Original storage time, kept outside encryption for index-independent expiry. */
  storedAt?: string;
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
  updatedAt: string;
  /** Stamped by W5's reconcile-ack after the browser wrote the user's OWN space (W6). */
  reconciledAt?: string;
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
  swept: number;
  reconciled: number;
}

/**
 * The D3 substrate seam. Every content operation is keyed by `(source, address)`; the retention
 * directory may enumerate sealed index keys, but it never reads or returns content globally.
 */
export function contentMasterFingerprint(master: string): string {
  return createHash("sha256").update(master, "utf8").digest("hex");
}

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
  /** Sync-off gate, backed by the connector's durable disabled marker. */
  isDisabled?: (address: string) => Promise<boolean>;
  retentionMs?: number;
  maxMeetingBytes?: number;
  maxUserMeetings?: number;
  maxUserBytes?: number;
  maxUserTombstones?: number;
}

/** Fixed, short codes. A provider payload or a title must never become one. */
const INVALID_TARGET = "invalid_target";
const CONTENT_TOO_LARGE = "content_too_large";
const SYNC_DISABLED = "sync_disabled";
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
function contentMasterFingerprint(master: string): string {
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
function envelopeAad(source: string, address: string, scope: string): Buffer {
  return Buffer.from(`${source}:${address}:${scope}`, "utf8");
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
  private readonly isDisabled: ((address: string) => Promise<boolean>) | null;
  private readonly purgeLedger: ContentPurgeLedgerReader | null;
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly counters: ContentStoreStats = {
    created: 0,
    merged: 0,
    droppedOverflow: 0,
    rejectedTooLarge: 0,
    tombstoneRefusals: 0,
    purgeRefusals: 0,
    writeFailures: 0,
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
    this.isDisabled = options.isDisabled ?? null;
    this.purgeLedger = options.purgeLedger ?? null;
  }

  /** Read-only proof: no missing index is treated as a successful decrypt. */
  async probeIndex(target: { source: string; address: string } | null): Promise<{ ok: boolean; id: string | null }> {
    if (!target) return { ok: false, id: null };
    const id = createHash("sha256").update(`${target.source}:${target.address}`).digest("hex");
    try {
      const blob = await this.blobs.readIndex(target.source, target.address);
      if (!blob) return { ok: false, id };
      parseIndex(this.unseal(target.source, target.address, "index", blob));
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
  ): Promise<number | null> {
    try {
      const existing = await this.blobs.readKeyFailureSince(source, address);
      const recorded = existing === null ? NaN : Date.parse(existing);
      if (Number.isFinite(recorded)) return recorded;
      const firstFailureAt = this.now();
      await this.blobs.writeKeyFailureSince(
        source,
        address,
        new Date(firstFailureAt).toISOString(),
      );
      errorContent(
        `op=retention result=content_index_unavailable first_failure=true ` +
          `source=${source} aid=${hashed(address)}`,
      );
      return firstFailureAt;
    } catch {
      errorContent(
        `op=retention result=failure_marker_unavailable source=${source} ` +
          `aid=${hashed(address)}`,
      );
      return null;
    }
  }

  private async clearRetentionFailure(
    source: string,
    address: string,
  ): Promise<void> {
    try {
      await this.blobs.clearKeyFailureSince(source, address);
    } catch {
      warnContent(
        `op=retention result=failure_marker_clear_failed source=${source} ` +
          `aid=${hashed(address)}`,
      );
    }
  }

  private async removeExpiredBlobs(
    source: string,
    address: string,
    cutoff: number,
  ): Promise<number> {
    let removed = 0;
    try {
      for (const blob of await this.blobs.listContentIds(source, address)) {
        const storedAt = Date.parse(blob.storedAt ?? blob.updatedAt);
        if (!Number.isFinite(storedAt) || storedAt <= cutoff) {
          await this.blobs.remove(source, address, blob.sourceId);
          removed += 1;
        }
      }
    } catch {
      errorContent(
        `op=retention result=age_fallback_failed source=${source} ` +
          `aid=${hashed(address)}`,
      );
    }
    return removed;
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
    return this.lane(source, address, async () => {
      try {
        if (this.isDisabled !== null) {
          let disabled: boolean;
          try {
            disabled = await this.isDisabled(address);
          } catch {
            // Failure to read the durable marker must not collect another server copy.
            disabled = true;
          }
          if (disabled) {
            warnContent(
              `op=upsert result=${SYNC_DISABLED} source=${source} ` +
                `mid=${hashed(sourceId)} aid=${hashed(address)}`,
            );
            return { ok: false, code: SYNC_DISABLED };
          }
        }

        const index = await this.openIndex(source, address);

        // Step -1, before any fetch result is believed: the retention tombstone. A provider can
        // replay a timestamp-less delivery indefinitely (findings §2.1); re-storing content the
        // window already aged out would make the retention promise a fiction.
        if (index.tombstones.some((t) => t.sourceId === sourceId)) {
          this.counters.tombstoneRefusals += 1;
          logContent(
            `op=upsert result=${RETENTION_TOMBSTONED} source=${source} ` +
              `mid=${hashed(sourceId)} aid=${hashed(address)}`,
          );
          return { ok: false, code: RETENTION_TOMBSTONED };
        }

        // Step -1's other half (W7, delta 12): the §6.2 PURGE ledger. A disconnect deleted this
        // tenant's rows; an at-least-once provider can replay the delivery that created them for
        // as long as it likes. Re-storing it would hand the user back meetings they tore down.
        // An unreadable ledger throws from here into the catch below — never "not purged".
        if (await this.purgeTombstoned(source, address, sourceId, input)) {
          this.counters.purgeRefusals += 1;
          logContent(
            `op=upsert result=${PURGE_TOMBSTONED} source=${source} ` +
              `mid=${hashed(sourceId)} aid=${hashed(address)}`,
          );
          return { ok: false, code: PURGE_TOMBSTONED };
        }

        const existing = await this.readMeeting(source, address, sourceId);
        const content: MeetingContent = { ...(existing?.content ?? {}) };
        content[input.kind] = input.content;

        const body = JSON.stringify(content);
        const sizeBytes = Buffer.byteLength(body, "utf8");
        if (sizeBytes > this.maxMeetingBytes) {
          // REJECT, never truncate: half a transcript is a silent corruption that surfaces
          // months later, and the operator needs to know the meeting did not land.
          this.counters.rejectedTooLarge += 1;
          warnContent(
            `op=upsert result=${CONTENT_TOO_LARGE} source=${source} ` +
              `mid=${hashed(sourceId)} aid=${hashed(address)} ` +
              `bytes=${sizeBytes} cap=${this.maxMeetingBytes}`,
          );
          return { ok: false, code: CONTENT_TOO_LARGE };
        }

        const stamp = new Date(this.now()).toISOString();
        const prior = index.meetings.find((m) => m.sourceId === sourceId);
        const meta: ContentMeta = {
          sourceId,
          ...(input.title !== undefined
            ? { title: input.title }
            : prior?.title !== undefined
              ? { title: prior.title }
              : {}),
          ...(input.ts !== undefined
            ? { ts: input.ts }
            : prior?.ts !== undefined
              ? { ts: prior.ts }
              : {}),
          ...(input.participantNames !== undefined
            ? { participantNames: input.participantNames }
            : prior?.participantNames !== undefined ? { participantNames: prior.participantNames } : {}),
          ...(input.participantEmails !== undefined
            ? { participantEmails: input.participantEmails }
            : prior?.participantEmails !== undefined ? { participantEmails: prior.participantEmails } : {}),
          ...(input.organizerEmail !== undefined
            ? { organizerEmail: input.organizerEmail }
            : prior?.organizerEmail !== undefined ? { organizerEmail: prior.organizerEmail } : {}),
          ...(input.kind === "transcript"
            ? { transcriptStoredAt: stamp }
            : prior?.transcriptStoredAt !== undefined
              ? { transcriptStoredAt: prior.transcriptStoredAt }
              : {}),
          ...(input.kind === "summary"
            ? { summaryStoredAt: stamp }
            : prior?.summaryStoredAt !== undefined
              ? { summaryStoredAt: prior.summaryStoredAt }
              : {}),
          sizeBytes,
          storedAt: prior?.storedAt ?? stamp,
          updatedAt: stamp,
          // `reconciledAt` is deliberately NOT carried forward: the user-space copy is now
          // stale, so W6 must write it again. Keeping the stamp strands the new half on the
          // server for a browser that already ticked this meeting off.
        };

        const others = index.meetings.filter((m) => m.sourceId !== sourceId);
        const { kept, evicted } = this.enforceCaps(source, address, others, meta);

        // Both writes are result-checked and both must resolve before a success exists.
        await this.writeMeeting(source, address, meta, content);
        await this.writeIndex(source, address, {
          meetings: [...kept, meta],
          tombstones: index.tombstones,
        });
        // Only once the index no longer names them do the evicted blobs go — an orphaned blob
        // is recoverable, an index pointing at a deleted blob is not.
        for (const victim of evicted) {
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
        // A substrate failure, an unreadable index, a failed decrypt — the same disposition.
        // The item is NOT stored and NOT reported stored; the worker retries it.
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
  /**
   * Sync-off cleanup. Reconciled meetings already exist in the owner's space, so remove their
   * server rows and blobs immediately. Unreconciled rows remain available until acknowledgement
   * or the 14-day retention boundary. Tombstones are IDs too and are cleared for this tenant.
   */
  async deleteReconciled(
    source: string,
    address: string,
  ): Promise<{ removed: number }> {
    const target = normalizeTarget(source, address);
    return this.lane(target.source, target.address, async () => {
      let index: ContentIndex;
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
        const firstFailureAt = await this.noteRetentionFailure(
          target.source,
          target.address,
        );
        let removed = 0;
        if (
          firstFailureAt !== null &&
          this.now() - firstFailureAt >= this.retentionMs
        ) {
          removed = await this.removeExpiredBlobs(
            target.source,
            target.address,
            this.now() - this.retentionMs,
          );
        }
        return { removed };
      }
      await this.clearRetentionFailure(target.source, target.address);
      const now = this.now();
      const cutoff = now - this.retentionMs;
      const keep: ContentMeta[] = [];
      const remove = new Set<string>();
      for (const meta of index.meetings) {
        const storedAt = Date.parse(meta.storedAt);
        if (
          meta.reconciledAt !== undefined ||
          !Number.isFinite(storedAt) ||
          storedAt <= cutoff
        ) {
          remove.add(meta.sourceId);
        } else {
          keep.push(meta);
        }
      }

      const indexedIds = new Set(index.meetings.map((meta) => meta.sourceId));
      for (const blob of await this.blobs.listContentIds(
        target.source,
        target.address,
      )) {
        if (remove.has(blob.sourceId)) continue;
        if (indexedIds.has(blob.sourceId)) continue;

        // An orphan can still be the only copy. Keep it only while its sealed metadata proves it
        // is unreconciled and within retention; unreadable or malformed orphans cannot be exposed
        // for reconciliation and must not become unbounded retained IDs.
        try {
          const orphan = await this.readMeeting(
            target.source,
            target.address,
            blob.sourceId,
          );
          const storedAt = Date.parse(orphan?.meta.storedAt ?? "");
          if (
            orphan === null ||
            orphan.meta.reconciledAt !== undefined ||
            !Number.isFinite(storedAt) ||
            storedAt <= cutoff
          ) {
            remove.add(blob.sourceId);
          }
        } catch {
          remove.add(blob.sourceId);
        }
      }
      for (const sourceId of remove) {
        await this.blobs.remove(target.source, target.address, sourceId);
      }
      if (remove.size > 0 || index.tombstones.length > 0) {
        await this.writeIndex(target.source, target.address, {
          meetings: keep,
          tombstones: [],
        });
      }

      if (remove.size > 0 || index.tombstones.length > 0) {
        logContent(
          `op=sync-off-cleanup result=ok source=${target.source} ` +
            `aid=${hashed(target.address)} removed=${remove.size} tombstones=${index.tombstones.length}`,
        );
      }
      return { removed: remove.size };
    });
  }

  async sweepRetention(input: {
    source: string;
    address: string;
    safetyMarginMs?: number;
  }): Promise<{
    swept: number;
    bytesFreed: number;
    tombstones: number;
    storedAtBackfilled: number;
    unreadableIndex: boolean;
  }> {
    const target = normalizeTarget(input.source, input.address);
    return this.lane(target.source, target.address, async () => {
      let index: ContentIndex;
      const now = this.now();
      const safetyMarginMs = Math.max(0, input.safetyMarginMs ?? 0);
      const cutoff = now - Math.max(0, this.retentionMs - safetyMarginMs);
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
        const firstFailureAt = await this.noteRetentionFailure(
          target.source,
          target.address,
        );
        const failureHorizonElapsed =
          firstFailureAt !== null &&
          now - firstFailureAt >= this.retentionMs;
        const swept = failureHorizonElapsed
          ? await this.removeExpiredBlobs(
              target.source,
              target.address,
              cutoff,
            )
          : 0;
        return {
          swept,
          bytesFreed: 0,
          tombstones: 0,
          storedAtBackfilled: 0,
          unreadableIndex: true,
        };
      }
      await this.clearRetentionFailure(target.source, target.address);
      const expirationCutoff = now + safetyMarginMs;
      const stamp = new Date(now).toISOString();

      const keep: ContentMeta[] = [];
      const swept: ContentMeta[] = [];
      for (const meta of index.meetings) {
        const storedAt = Date.parse(meta.storedAt);
        (Number.isFinite(storedAt) && storedAt > cutoff ? keep : swept).push(meta);
      }
      let bytesFreed = 0;
      for (const meta of swept) bytesFreed += meta.sizeBytes;

      const retainedTombstones = index.tombstones.filter(
        (tombstone) => Date.parse(tombstone.expiresAt) > expirationCutoff,
      );
      const newTombstones = swept
        .map((meta) => {
          const storedAt = Date.parse(meta.storedAt);
          if (!Number.isFinite(storedAt)) return null;
          const expiresAt = storedAt + this.retentionMs;
          return expiresAt > expirationCutoff
            ? {
                sourceId: meta.sourceId,
                sweptAt: stamp,
                expiresAt: new Date(expiresAt).toISOString(),
              }
            : null;
        })
        .filter((item): item is RetentionTombstone => item !== null);
      const tombstones = this.capTombstones(
        target.source,
        target.address,
        [...retainedTombstones, ...newTombstones],
      );
      await this.writeIndex(target.source, target.address, {
        meetings: keep,
        tombstones,
      });

      for (const meta of swept) {
        await this.blobs.remove(
          target.source,
          target.address,
          meta.sourceId,
        );
      }
      const retainedById = new Map(
        keep.map((meta) => [meta.sourceId, meta] as const),
      );
      let storedAtBackfilled = 0;
      for (const blob of await this.blobs.listContentIds(
        target.source,
        target.address,
      )) {
        const retainedMeta = retainedById.get(blob.sourceId);
        if (retainedMeta !== undefined && blob.storedAt !== retainedMeta.storedAt) {
          const sealed = await this.blobs.read(
            target.source,
            target.address,
            blob.sourceId,
          );
          if (sealed !== null) {
            await this.blobs.write(
              target.source,
              target.address,
              blob.sourceId,
              { ...sealed, storedAt: retainedMeta.storedAt },
            );
            storedAtBackfilled += 1;
          }
        }
        const storedAt = Date.parse(blob.storedAt ?? blob.updatedAt);
        if (
          retainedMeta === undefined &&
          (!Number.isFinite(storedAt) || storedAt <= cutoff)
        ) {
          await this.blobs.remove(target.source, target.address, blob.sourceId);
        }
      }

      this.counters.swept += swept.length;
      if (swept.length > 0 || retainedTombstones.length !== index.tombstones.length) {
        logContent(
          `op=retention-sweep result=ok source=${target.source} ` +
            `aid=${hashed(target.address)} swept=${swept.length} ` +
            `bytes=${bytesFreed} tombstones=${tombstones.length}`,
        );
      }
      return {
        swept: swept.length,
        bytesFreed,
        tombstones: tombstones.length,
        storedAtBackfilled,
        unreadableIndex: false,
      };

    });
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
    const index = await this.lane(target.source, target.address, () =>
      this.openIndex(target.source, target.address),
    );
    if (index.tombstones.some((t) => t.sourceId === target.sourceId)) return true;
    // W7: the same purge verdict the upsert applies, one step earlier — a purged id must cost
    // neither a store nor an upstream FETCH. A ledger this cannot read throws to the worker,
    // which holds the item (its `retention_unavailable` arm) instead of fetching.
    return this.purgeTombstoned(target.source, target.address, target.sourceId, {
      ...(input.sourceTimestamp !== undefined
        ? { ts: input.sourceTimestamp }
        : {}),
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
  async purge(source: string, address: string): Promise<{ removed: number }> {
    const target = normalizeTarget(source, address);
    return this.lane(target.source, target.address, async () => {
      // The index names every live row, so the ids come from here — the blob-store port holds
      // no master and cannot read them out of the ciphertext. An index we cannot open still
      // tears down: `removeAll` sweeps the tenant's prefix and the index key itself.
      const index = await this.openIndex(target.source, target.address).catch(
        () => ({ meetings: [], tombstones: [] }) satisfies ContentIndex,
      );
      for (const meta of index.meetings) {
        await this.blobs.remove(target.source, target.address, meta.sourceId);
      }
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
    const blob = await this.blobs.readIndex(source, address);
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
    const plaintext = this.unseal(source, address, sourceId, blob);
    return parseMeeting(plaintext, sourceId);
  }

  private async writeMeeting(
    source: string,
    address: string,
    meta: ContentMeta,
    content: MeetingContent,
  ): Promise<void> {
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
      ),
    );
  }

  private sealBlob(
    source: string,
    address: string,
    scope: string,
    plaintext: string,
    storedAt?: string,
  ): SealedBlob {
    const aad = envelopeAad(source, address, scope);
    const dek = randomBytes(DEK_BYTES);
    const master = this.contentMaster();
    return {
      ciphertext: seal(dek, Buffer.from(plaintext, "utf8"), aad),
      wrappedDEK: seal(keyEncryptionKey(master, source, address), dek, aad),
      ...(storedAt === undefined ? {} : { storedAt }),
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
    const aad = envelopeAad(source, address, scope);
    const kek = keyEncryptionKey(this.contentMaster(), source, address);
    const dek = open(kek, blob.wrappedDEK, aad);
    return open(dek, blob.ciphertext, aad).toString("utf8");
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
    if (meta !== null) meetings.push(meta);
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
      const blob = await this.read(source, address, sourceId);
      blobs.push({
        sourceId,
        ...(blob?.storedAt === undefined ? {} : { storedAt: blob.storedAt }),
        updatedAt: blob?.updatedAt ?? "",
      });
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
    const response = (result as { data?: unknown } | null)?.data as
      | { data?: unknown }
      | null
      | undefined;
    if (response === null || response === undefined) return null;
    const raw = (response as { data?: unknown }).data ?? response;
    const value =
      typeof raw === "string"
        ? (() => {
            try {
              return JSON.parse(raw) as unknown;
            } catch {
              throw new Error("content blob is unparseable");
            }
          })()
        : raw;
    if (typeof value !== "object" || value === null) throw new Error("content blob is unparseable");
    const blob = value as Record<string, unknown>;
    if (
      typeof blob.ciphertext !== "string" ||
      typeof blob.wrappedDEK !== "string"
    ) {
      // Present but unreadable. Never "absent" — see the class comment.
      throw new Error("content blob is unparseable");
    }
    return {
      ciphertext: blob.ciphertext,
      wrappedDEK: blob.wrappedDEK,
      ...(blob.storedAt === undefined
        ? {}
        : { storedAt: typeof blob.storedAt === "string" ? blob.storedAt : "" }),
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
