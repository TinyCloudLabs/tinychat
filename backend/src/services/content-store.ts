import {
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
 *  - **Retention with tombstones (D2a = 90 days; delta 5's server half).** The sweep deletes
 *    aged-out content AND records the swept ids as retention tombstones — the same
 *    redelivery-proof marker the shipped purge ledger is (routes/connector-webhooks.ts's
 *    `PurgeLedger` / connector-drain's `isTombstoned`), kept here per-item and per-tenant so a
 *    provider that can replay an old delivery indefinitely (findings §2.1) cannot silently
 *    re-store content the retention window already aged out.
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

/** DECISIONS `D2a-retention-days`. Rolling window, independent of reconcile status. */
export const RETENTION_WINDOW_DAYS = 90;

/** Plan §8.1 W4: per-meeting content cap — reject-and-log over, never truncate. */
export const MAX_MEETING_CONTENT_BYTES = 2 * 1024 * 1024;

/** Plan §8.1 W4: per-user caps — oldest-drop, counted. */
export const MAX_USER_MEETINGS = 500;
export const MAX_USER_CONTENT_BYTES = 200 * 1024 * 1024;

/**
 * Retention tombstones are tiny (an id + a stamp) but not free, so they are bounded too — at the
 * meeting cap, which is the most ids a user can ever have had live at once. Eviction is LOGGED:
 * past this many, the oldest tombstone stops protecting its id from a replay.
 */
export const MAX_USER_TOMBSTONES = MAX_USER_MEETINGS;

const KEK_HKDF_SALT = "tinychat-content-v1";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEK_BYTES = 32;

/** The one key path prefix. Backend-own keys are auto-prefixed under `ops.tinychat.backend`. */
const CONTENT_KEY_PREFIX = "connector-content";
const CONTENT_INDEX_KEY_PREFIX = "connector-content-index";

// ── Result / row shapes ──────────────────────────────────────────────

/** What the substrate holds. There is no field here a breach could read as a meeting. */
export interface SealedBlob {
  ciphertext: string;
  wrappedDEK: string;
  /** ISO. Plaintext on purpose: an operator needs *when*, never *what*. */
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

/** A retention-swept id, remembered so a provider replay cannot silently re-store it. */
export interface RetentionTombstone {
  sourceId: string;
  sweptAt: string;
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
 * The D3 substrate seam. Six methods, all keyed by `(source, address)` — deliberately NO
 * global list: an enumeration method that does not name a tenant is how a tenant-scoped store
 * stops being one.
 */
export interface ContentBlobStore {
  readIndex(source: string, address: string): Promise<SealedBlob | null>;
  writeIndex(source: string, address: string, blob: SealedBlob): Promise<void>;
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
  retentionMs?: number;
  maxMeetingBytes?: number;
  maxUserMeetings?: number;
  maxUserBytes?: number;
  maxUserTombstones?: number;
}

/** Fixed, short codes. A provider payload or a title must never become one. */
const INVALID_TARGET = "invalid_target";
const CONTENT_TOO_LARGE = "content_too_large";
const RETENTION_TOMBSTONED = "retention_tombstoned";
const CONTENT_STORE_FAILED = "content_store_failed";
/** W7: distinct from the retention code so an operator can tell a purge from an aged-out sweep. */
export const PURGE_TOMBSTONED = "purge_tombstoned";

// ── Master key ───────────────────────────────────────────────────────

const validatedContentMasters = new Set<string>();

/**
 * Boot-time gate, gated on the dark ingest flag by `index.ts` exactly like W2's credential
 * master. Returns a Result rather than throwing so the boot path can print and exit(1). The
 * error text NEVER contains a key value.
 *
 * The master must also SURVIVE redeploys (DECISIONS D3 substrate note): a deploy that strips it
 * orphans every stored meeting, which is why it rides the four-place `allowed_envs` dance in
 * `webhook-deploy-env.test.ts` before anyone can turn the feature on.
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

// ── The store ────────────────────────────────────────────────────────

/** The sealed per-tenant index: metadata for every live row plus the retention tombstones. */
interface ContentIndex {
  meetings: ContentMeta[];
  tombstones: RetentionTombstone[];
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
    this.purgeLedger = options.purgeLedger ?? null;
  }

  stats(): ContentStoreStats {
    return { ...this.counters };
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
   * server copy is RETAINED (D2a): reconcile does not shorten retention, because a second
   * device still has to be able to read the meeting.
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
   * The D2a retention sweep. Deletes content past the window and RECORDS the swept ids as
   * retention tombstones (see the file header): the shipped purge ledger's redelivery-proof
   * marker, kept per-tenant here. Age is the provider's timestamp when there is one, and
   * otherwise when we stored it — an undated meeting must still age out.
   *
   * Reconcile status is NOT an input (D2a `retain`): a meeting one device already copied into
   * the user's own space stays readable for the next device until the window ends.
   */
  async sweepRetention(input: {
    source: string;
    address: string;
  }): Promise<RetentionSweepResult> {
    const target = normalizeTarget(input.source, input.address);
    return this.lane(target.source, target.address, async () => {
      const index = await this.openIndex(target.source, target.address);
      const now = this.now();
      const cutoff = now - this.retentionMs;
      const stamp = new Date(now).toISOString();

      const keep: ContentMeta[] = [];
      const swept: ContentMeta[] = [];
      for (const meta of index.meetings) {
        (retentionAgeOf(meta, now) < cutoff ? swept : keep).push(meta);
      }
      if (swept.length === 0) {
        return { swept: 0, bytesFreed: 0, tombstones: index.tombstones.length };
      }

      let bytesFreed = 0;
      for (const meta of swept) {
        // Sequential, one node call at a time — never Promise.all across meetings (§9.3).
        await this.blobs.remove(target.source, target.address, meta.sourceId);
        bytesFreed += meta.sizeBytes;
      }

      const tombstones = this.capTombstones(
        target.source,
        target.address,
        [
          ...index.tombstones,
          ...swept.map((meta) => ({ sourceId: meta.sourceId, sweptAt: stamp })),
        ],
      );
      await this.writeIndex(target.source, target.address, {
        meetings: keep,
        tombstones,
      });

      this.counters.swept += swept.length;
      logContent(
        `op=retention-sweep result=ok source=${target.source} ` +
          `aid=${hashed(target.address)} swept=${swept.length} ` +
          `bytes=${bytesFreed} tombstones=${tombstones.length}`,
      );
      return { swept: swept.length, bytesFreed, tombstones: tombstones.length };
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
    // ABSENT is a legitimate empty archive — a user who has never had a meeting stored. Only a
    // PRESENT-but-unreadable index fails closed, and a failing READ throws from the port.
    if (blob === null) return { meetings: [], tombstones: [] };
    const plaintext = this.unseal(source, address, "index", blob);
    return parseIndex(plaintext);
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
      ),
    );
  }

  private sealBlob(
    source: string,
    address: string,
    scope: string,
    plaintext: string,
  ): SealedBlob {
    const aad = envelopeAad(source, address, scope);
    const dek = randomBytes(DEK_BYTES);
    return {
      ciphertext: seal(dek, Buffer.from(plaintext, "utf8"), aad),
      wrappedDEK: seal(keyEncryptionKey(this.master(), source, address), dek, aad),
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
    const kek = keyEncryptionKey(this.master(), source, address);
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

function parseIndex(plaintext: string): ContentIndex {
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
    // Reading a malformed index as empty would disable every cap and un-tombstone every swept
    // id. It is a failure, not an empty archive.
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
    if (!isValidMeetingId(t.sourceId) || typeof t.sweptAt !== "string") continue;
    tombstones.push({ sourceId: t.sourceId, sweptAt: t.sweptAt });
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
 * Retention-age reference. The provider ts is attacker-influenced surface (a re-uploaded old
 * recording, or a broken clock at the source), so retention MUST NOT use it verbatim: a back-dated
 * ts sweeps a freshly-stored meeting on the very next pass and tombstones its id permanently, and
 * a future-dated ts is immune to retention forever (audit finding W4/D2a/delta-5). The clamp is
 * to `storedAt` — the timestamp the backend itself owns — whenever ts is missing, in the future,
 * or older than the backend's own record of first storage.
 *
 * SORT ORDER USES A DIFFERENT REFERENCE — see {@link sortKey} — because a re-uploaded old
 * recording is legitimately older to the user and should list under recent captures.
 */
function retentionAgeOf(meta: ContentMeta, nowMs?: number): number {
  const stored = Date.parse(meta.storedAt);
  const storedMs = Number.isFinite(stored) ? stored : 0;
  const provider = meta.ts === undefined ? NaN : Date.parse(meta.ts);
  if (!Number.isFinite(provider)) return storedMs;
  if (provider < storedMs) return storedMs;
  if (nowMs !== undefined && provider > nowMs) return storedMs;
  return provider;
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

  async removeAll(source: string, address: string): Promise<void> {
    const prefix = `${contentSlot(source, address, "")}`;
    for (const key of [...this.blobs.keys()]) {
      if (key === indexSlot(source, address) || key.startsWith(prefix)) {
        this.blobs.delete(key);
      }
    }
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
              return null;
            }
          })()
        : raw;
    if (typeof value !== "object" || value === null) return null;
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
