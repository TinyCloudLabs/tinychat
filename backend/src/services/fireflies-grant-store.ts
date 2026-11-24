import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { assertKvResult, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import {
  verifyFirefliesImportGrants,
  type FirefliesVerifyDependencies,
  type VerifiedFirefliesImportGrants,
} from "../fireflies-import-verify.js";
import type { BackendStorageLane } from "./backend-storage-lane.js";

/** Where the backend stores each owner's encrypted Fireflies import grant pair in its own space. */
export const FIREFLIES_IMPORT_GRANT_KEY_PREFIX = "delegations/fireflies-import/";
export const FIREFLIES_GRANT_AAD_PURPOSE = "fireflies-import-grant";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** One page lists many owners; this bounds a runaway cursor loop, not the number of owners. */
const GRANT_LIST_MAX_PAGES = 1000;
const DEFINITIVE_PURGE_CODES: ReadonlySet<string> = new Set([
  "expired",
  "wrong_delegatee",
  "bad_signature",
  "bad_session_signature",
  "wrong_delegator",
]);

/** `store` refused the write: the ids the caller named are not the ids held now. */
export class FirefliesGrantReplacesMismatchError extends Error {
  constructor() {
    super("fireflies_grant_replaces_mismatch");
    this.name = "FirefliesGrantReplacesMismatchError";
  }
}

export type FirefliesGrantState = "none" | "active" | "needs_renewal" | "revoked";

export interface FirefliesGrantStatus {
  state: FirefliesGrantState;
  expiresAt: string | null;
}

export interface FirefliesGrantEnvelope {
  v: 1;
  format: "tinychat.fireflies-import-grant";
  secretsGrant: string;
  meetingsGrant: string;
  siwe: string;
  signature: string;
  expiresAt: string;
}

/** The ids of the two stored permissions. Public values kept in plain fields, so they outlive the sealed grant. */
interface StoredGrantCids {
  secrets: string;
  meetings: string;
}

function cidOfSerializedGrant(serialized: string): string | null {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) && typeof parsed.cid === "string" && parsed.cid.length > 0 ? parsed.cid : null;
  } catch {
    return null;
  }
}

function storedGrantCids(payload: { secretsGrant: string; meetingsGrant: string }): StoredGrantCids | null {
  const secrets = cidOfSerializedGrant(payload.secretsGrant);
  const meetings = cidOfSerializedGrant(payload.meetingsGrant);
  return secrets && meetings ? { secrets, meetings } : null;
}

function readStoredGrantCids(record: unknown): StoredGrantCids | null {
  if (!isRecord(record) || !isRecord(record.grantCids)) return null;
  const { secrets, meetings } = record.grantCids;
  return typeof secrets === "string" && typeof meetings === "string" ? { secrets, meetings } : null;
}

interface StoredActiveGrantRecord {
  v: 1;
  alg: "aes-256-gcm";
  state: "active";
  iv: string;
  ciphertext: string;
  tag: string;
  delegateDid: string;
  expiresAt: string;
  updatedAt: string;
  grantCids?: StoredGrantCids;
}

interface StoredInactiveGrantRecord {
  v: 1;
  state: "needs_renewal" | "revoked";
  expiresAt: string | null;
  updatedAt: string;
  grantCids?: StoredGrantCids;
}

type StoredFirefliesGrantRecord = StoredActiveGrantRecord | StoredInactiveGrantRecord;

export interface FirefliesGrantKvPort {
  get(key: string): Promise<StoredFirefliesGrantRecord | null>;
  put(key: string, value: StoredFirefliesGrantRecord): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key under `prefix`, for the lapse sweep and the flag-off cleanup. Absent on ports that cannot list. */
  keys?(prefix: string): Promise<string[]>;
}

export interface FirefliesGrantVerifyOptions {
  configuredHost: string;
  deps: FirefliesVerifyDependencies;
  now?: number;
}

export type LoadedFirefliesGrant =
  | { state: "active"; envelope: FirefliesGrantEnvelope; verified: VerifiedFirefliesImportGrants }
  | { state: "none" | "needs_renewal" | "revoked"; expiresAt: string | null };

function normalizeOwnerAddress(address: string): string {
  if (!ADDRESS_RE.test(address)) {
    throw new Error("fireflies_grant_owner_invalid");
  }
  return address.toLowerCase();
}

function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const byte of bytes) acc |= byte;
  return acc === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adapter binding `FirefliesGrantKvPort` to the backend's own TinyCloud space through the shared
 * `BackendStorageLane` with session-refresh and checked KV results.
 */
export function createKvFirefliesGrantPort(
  node: TinyCloudNode,
  storageLane: BackendStorageLane,
): FirefliesGrantKvPort {
  return {
    async get(key: string): Promise<StoredFirefliesGrantRecord | null> {
      const result = await withSessionRefresh(node, async () => {
        const response = await node.kv.get<StoredFirefliesGrantRecord>(key);
        if (!isKvMissingKeyResult(response, key)) assertKvResult(response);
        return response;
      });
      if (isKvMissingKeyResult(result, key)) return null;
      if (!result || typeof result !== "object" || !("ok" in result) || !result.ok) {
        throw new Error("fireflies_grant_storage_unavailable");
      }
      return result.data.data ?? null;
    },
    async put(key: string, value: StoredFirefliesGrantRecord): Promise<void> {
      await storageLane.run(() =>
        withSessionRefresh(node, async () => {
          assertKvResult(await node.kv.put(key, value));
        }),
      );
    },
    async delete(key: string): Promise<void> {
      await storageLane.run(() =>
        withSessionRefresh(node, async () => {
          const response = await node.kv.delete(key);
          if (!isKvMissingKeyResult(response, key)) assertKvResult(response);
        }),
      );
    },
    async keys(prefix: string): Promise<string[]> {
      const found: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < GRANT_LIST_MAX_PAGES; page += 1) {
        const previous = cursor;
        const result = await withSessionRefresh(node, async () =>
          assertKvResult(await node.kv.list(previous === undefined ? { prefix } : { prefix, cursor: previous })),
        );
        const data = (result as { data?: { keys?: unknown; truncated?: unknown; nextCursor?: unknown } } | null)?.data;
        if (!data || !Array.isArray(data.keys) || !data.keys.every((key) => typeof key === "string")) {
          throw new Error("fireflies_grant_listing_invalid");
        }
        for (const key of data.keys as string[]) found.push(key.startsWith(prefix) ? key : `${prefix}${key}`);
        const next = typeof data.nextCursor === "string" && data.nextCursor.length > 0 ? data.nextCursor : undefined;
        if (next === undefined) {
          // A truncated page with no cursor would leave grants behind unseen: fail rather than report a short list.
          if (data.truncated === true) throw new Error("fireflies_grant_listing_truncated");
          return found;
        }
        if (next === previous) throw new Error("fireflies_grant_listing_truncated");
        cursor = next;
      }
      throw new Error("fireflies_grant_listing_truncated");
    },
  };
}

/**
 * Owner-scoped encrypted store for Fireflies server-import grants in backend-own KV
 * (`delegations/fireflies-import/{address}`).
 *
 * - AES-256-GCM with per-write random 12-byte IV and AAD `(purpose, address, delegateDid)`.
 * - Dedicated 32-byte KEK derived from dstack KMS inside the CVM (never `CONNECTOR_CREDENTIAL_MASTER`
 *   or `WEBHOOK_HMAC_MASTER`).
 * - No enumeration or list surface; every read/write is keyed strictly by validated owner address.
 */
export class FirefliesGrantStore {
  readonly #kek: Buffer;
  readonly #delegateDid: string;
  readonly #kv: FirefliesGrantKvPort;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: { kv: FirefliesGrantKvPort; kek: Buffer; delegateDid: string }) {
    if (!Buffer.isBuffer(options.kek) || options.kek.length !== 32 || isAllZero(options.kek)) {
      throw new Error("fireflies_grant_kek_invalid");
    }
    const bareDid = options.delegateDid.split("#", 1)[0] ?? "";
    if (!bareDid.startsWith("did:key:")) {
      throw new Error("fireflies_grant_delegate_did_invalid");
    }
    this.#kek = Buffer.from(options.kek);
    this.#delegateDid = bareDid;
    this.#kv = options.kv;
  }

  get delegateDid(): string {
    return this.#delegateDid;
  }

  keyFor(address: string): string {
    return `${FIREFLIES_IMPORT_GRANT_KEY_PREFIX}${normalizeOwnerAddress(address)}`;
  }

  #aadFor(address: string, delegateDid: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        purpose: FIREFLIES_GRANT_AAD_PURPOSE,
        address,
        delegateDid,
      }),
      "utf8",
    );
  }

  #seal(envelope: FirefliesGrantEnvelope, address: string): { iv: string; ciphertext: string; tag: string } {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#kek, iv);
    cipher.setAAD(this.#aadFor(address, this.#delegateDid));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString("base64"),
      ciphertext: encrypted.toString("base64"),
      tag: tag.toString("base64"),
    };
  }

  #open(record: StoredActiveGrantRecord, address: string): FirefliesGrantEnvelope {
    const iv = Buffer.from(record.iv, "base64");
    const tag = Buffer.from(record.tag, "base64");
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
      throw new Error("fireflies_grant_ciphertext_corrupt");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#kek, iv);
    decipher.setAAD(this.#aadFor(address, this.#delegateDid));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      parsed.format !== "tinychat.fireflies-import-grant" ||
      typeof parsed.secretsGrant !== "string" ||
      typeof parsed.meetingsGrant !== "string" ||
      typeof parsed.siwe !== "string" ||
      typeof parsed.signature !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      throw new Error("fireflies_grant_envelope_invalid");
    }
    return parsed as unknown as FirefliesGrantEnvelope;
  }

  /**
   * Seals and stores the pair. `replaces` names the two permission ids the caller believes are stored now (none when
   * it believes nothing is); the write is refused when the stored ids differ, so a renewal that raced a turn off, a
   * removal or another renewal never brings back or overwrites what the owner just changed. The accept route always
   * passes it; without it the write is unconditional.
   */
  async store(
    address: string,
    payload: { secretsGrant: string; meetingsGrant: string; siwe: string; signature: string },
    expiresAt: Date,
    replaces?: readonly string[],
  ): Promise<void> {
    const normalized = normalizeOwnerAddress(address);
    const isoExpiry = expiresAt.toISOString();
    const envelope: FirefliesGrantEnvelope = {
      v: 1,
      format: "tinychat.fireflies-import-grant",
      secretsGrant: payload.secretsGrant,
      meetingsGrant: payload.meetingsGrant,
      siwe: payload.siwe,
      signature: payload.signature,
      expiresAt: isoExpiry,
    };
    const sealed = this.#seal(envelope, normalized);
    const grantCids = storedGrantCids(payload);
    const record: StoredActiveGrantRecord = {
      v: 1,
      alg: "aes-256-gcm",
      state: "active",
      iv: sealed.iv,
      ciphertext: sealed.ciphertext,
      tag: sealed.tag,
      delegateDid: this.#delegateDid,
      expiresAt: isoExpiry,
      updatedAt: new Date().toISOString(),
      ...(grantCids ? { grantCids } : {}),
    };
    await this.#serialized(normalized, async () => {
      if (replaces !== undefined) {
        const held = readStoredGrantCids(await this.#kv.get(this.keyFor(normalized)));
        const heldIds = held ? [held.secrets, held.meetings] : [];
        if (heldIds.length !== replaces.length || !heldIds.every((id) => replaces.includes(id))) {
          throw new FirefliesGrantReplacesMismatchError();
        }
      }
      await this.#kv.put(this.keyFor(normalized), record);
    });
  }

  /**
   * Runs the store's own read-then-write steps for one owner one after another. Held only across KV calls and never
   * across the owner lock or any other lock, so it cannot join a lock cycle; it is what keeps a removal from being
   * undone by a marker or a grant that read the record before the removal.
   */
  #serialized<T>(normalizedAddress: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(normalizedAddress) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(normalizedAddress, tail);
    void tail.then(() => {
      if (this.#tails.get(normalizedAddress) === tail) this.#tails.delete(normalizedAddress);
    });
    return run;
  }

  /**
   * Purge any stored grant ciphertext and record a content-free non-active status marker.
   * Used on lapse, delegate rotation or node-reported revocation.
   *
   * Only ever replaces a record that is still there, and when `seenUpdatedAt` is given only that exact record: a
   * removal, or a newer grant, that landed since the caller read it is never undone by a marker for the old one.
   */
  async markState(
    address: string,
    state: "needs_renewal" | "revoked",
    expiresAt: string | null = null,
    seenUpdatedAt?: string,
  ): Promise<void> {
    const normalized = normalizeOwnerAddress(address);
    await this.#serialized(normalized, async () => {
      const current = await this.#kv.get(this.keyFor(normalized));
      if (!isRecord(current)) return;
      if (seenUpdatedAt !== undefined && current.updatedAt !== seenUpdatedAt) return;
      // The two permission ids are public and stay on the marker, so the owner's browser can still revoke them at the node.
      const grantCids = readStoredGrantCids(current);
      const record: StoredInactiveGrantRecord = {
        v: 1,
        state,
        expiresAt,
        updatedAt: new Date().toISOString(),
        ...(grantCids ? { grantCids } : {}),
      };
      await this.#kv.put(this.keyFor(normalized), record);
    });
  }

  async remove(address: string): Promise<void> {
    const normalized = normalizeOwnerAddress(address);
    await this.#serialized(normalized, () => this.#kv.delete(this.keyFor(normalized)));
  }

  /**
   * Replaces every active record that can no longer be used (expired, or issued to another delegate) with the
   * content-free `needs_renewal` marker, so no sealed grant outlives its end date. Each record is re-read and
   * replaced inside the owner's own lock, so a grant stored a moment ago by the owner is never overwritten.
   * Reads only the plain `expiresAt` and `delegateDid` fields; nothing is unsealed.
   */
  async reapLapsed(options: {
    now: number;
    run: <T>(address: string, fn: () => Promise<T>) => Promise<T>;
  }): Promise<{ scanned: number; reaped: number }> {
    if (!this.#kv.keys) throw new Error("fireflies_grant_listing_unavailable");
    const keys = await this.#kv.keys(FIREFLIES_IMPORT_GRANT_KEY_PREFIX);
    let reaped = 0;
    for (const key of keys) {
      const address = key.slice(FIREFLIES_IMPORT_GRANT_KEY_PREFIX.length);
      if (!ADDRESS_RE.test(address)) continue;
      reaped += await options.run(address, async () => {
        const stored = await this.#kv.get(this.keyFor(address));
        if (!isRecord(stored) || stored.state !== "active") return 0;
        const expiresAt = typeof stored.expiresAt === "string" ? Date.parse(stored.expiresAt) : Number.NaN;
        const otherDelegate = stored.delegateDid !== this.#delegateDid;
        if (Number.isFinite(expiresAt) && expiresAt > options.now && !otherDelegate) return 0;
        await this.markState(
          address,
          "needs_renewal",
          Number.isFinite(expiresAt) && !otherDelegate ? String(stored.expiresAt) : null,
          typeof stored.updatedAt === "string" ? stored.updatedAt : undefined,
        );
        return 1;
      });
    }
    return { scanned: keys.length, reaped };
  }

  /**
   * Load, decrypt and re-verify an owner's active Fireflies import grant pair.
   * Destroys stored ciphertext only on definitive invalidation (expired, rotated delegate,
   * wrong_delegatee, bad_signature, bad_session_signature or wrong_delegator). Transient errors
   * (such as CID/verification exceptions or corrupt KV reads) never wipe the stored ciphertext.
   */
  async loadActive(
    address: string,
    options: FirefliesGrantVerifyOptions,
  ): Promise<LoadedFirefliesGrant> {
    return this.#inspect(address, options, { purgeDefinitive: true });
  }

  /**
   * The ids (CIDs) of the two permissions stored for the owner, so their browser can revoke exactly those at the node.
   * Kept as plain public fields from the moment the pair is accepted until it is removed, so a lapsed or unreadable
   * grant still reports them. No grant material is returned. Read-only; null when nothing is stored.
   */
  async grantCids(address: string): Promise<{ secrets: string; meetings: string } | null> {
    return readStoredGrantCids(await this.#kv.get(this.keyFor(normalizeOwnerAddress(address))));
  }

  /**
   * Strictly read-only, content-free status for `GET /api/connectors/fireflies/delegation`.
   * Never mutates or deletes stored KV records.
   */
  async status(
    address: string,
    options: FirefliesGrantVerifyOptions,
  ): Promise<FirefliesGrantStatus> {
    const loaded = await this.#inspect(address, options, { purgeDefinitive: false });
    if (loaded.state === "active") {
      return { state: "active", expiresAt: loaded.verified.expiresAt.toISOString() };
    }
    return { state: loaded.state, expiresAt: loaded.expiresAt };
  }

  async #inspect(
    address: string,
    options: FirefliesGrantVerifyOptions,
    mode: { purgeDefinitive: boolean },
  ): Promise<LoadedFirefliesGrant> {
    const normalized = normalizeOwnerAddress(address);
    const now = options.now ?? Date.now();
    const stored = await this.#kv.get(this.keyFor(normalized));
    if (!stored || !isRecord(stored) || stored.v !== 1) {
      return { state: "none", expiresAt: null };
    }
    if (stored.state === "revoked") {
      return { state: "revoked", expiresAt: typeof stored.expiresAt === "string" ? stored.expiresAt : null };
    }
    if (stored.state === "needs_renewal") {
      return { state: "needs_renewal", expiresAt: typeof stored.expiresAt === "string" ? stored.expiresAt : null };
    }
    if (
      stored.state !== "active" ||
      stored.alg !== "aes-256-gcm" ||
      typeof stored.iv !== "string" ||
      typeof stored.ciphertext !== "string" ||
      typeof stored.tag !== "string" ||
      typeof stored.delegateDid !== "string" ||
      typeof stored.expiresAt !== "string"
    ) {
      return { state: "needs_renewal", expiresAt: null };
    }

    const storedExpiryMs = Date.parse(stored.expiresAt);
    if (!Number.isFinite(storedExpiryMs) || storedExpiryMs <= now) {
      const reportedExpiry = Number.isFinite(storedExpiryMs) ? stored.expiresAt : null;
      if (mode.purgeDefinitive && Number.isFinite(storedExpiryMs)) {
        await this.markState(normalized, "needs_renewal", reportedExpiry, typeof stored.updatedAt === "string" ? stored.updatedAt : undefined);
      }
      return { state: "needs_renewal", expiresAt: reportedExpiry };
    }

    if (stored.delegateDid !== this.#delegateDid) {
      if (mode.purgeDefinitive) {
        await this.markState(normalized, "needs_renewal", null, typeof stored.updatedAt === "string" ? stored.updatedAt : undefined);
      }
      return { state: "needs_renewal", expiresAt: null };
    }

    let envelope: FirefliesGrantEnvelope;
    try {
      envelope = this.#open(stored as StoredActiveGrantRecord, normalized);
    } catch {
      return { state: "needs_renewal", expiresAt: null };
    }

    const verified = await verifyFirefliesImportGrants(
      {
        secretsGrant: envelope.secretsGrant,
        meetingsGrant: envelope.meetingsGrant,
        siwe: envelope.siwe,
        signature: envelope.signature,
        address: normalized,
        delegateDid: this.#delegateDid,
        configuredHost: options.configuredHost,
        now,
      },
      options.deps,
    );
    if (!verified.ok) {
      const reportedExpiry = verified.code === "expired" ? stored.expiresAt : null;
      if (mode.purgeDefinitive && DEFINITIVE_PURGE_CODES.has(verified.code)) {
        await this.markState(normalized, "needs_renewal", reportedExpiry, typeof stored.updatedAt === "string" ? stored.updatedAt : undefined);
      }
      return { state: "needs_renewal", expiresAt: reportedExpiry };
    }

    return { state: "active", envelope, verified: verified.verified };
  }
}
