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
}

interface StoredInactiveGrantRecord {
  v: 1;
  state: "needs_renewal" | "revoked";
  expiresAt: string | null;
  updatedAt: string;
}

type StoredFirefliesGrantRecord = StoredActiveGrantRecord | StoredInactiveGrantRecord;

export interface FirefliesGrantKvPort {
  get(key: string): Promise<StoredFirefliesGrantRecord | null>;
  put(key: string, value: StoredFirefliesGrantRecord): Promise<void>;
  delete(key: string): Promise<void>;
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

  async store(
    address: string,
    payload: { secretsGrant: string; meetingsGrant: string; siwe: string; signature: string },
    expiresAt: Date,
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
    };
    await this.#kv.put(this.keyFor(normalized), record);
  }

  /**
   * Purge any stored grant ciphertext and record a content-free non-active status marker.
   * Used on lapse, delegate rotation or node-reported revocation.
   */
  async markState(
    address: string,
    state: "needs_renewal" | "revoked",
    expiresAt: string | null = null,
  ): Promise<void> {
    const normalized = normalizeOwnerAddress(address);
    const record: StoredInactiveGrantRecord = {
      v: 1,
      state,
      expiresAt,
      updatedAt: new Date().toISOString(),
    };
    await this.#kv.put(this.keyFor(normalized), record);
  }

  async remove(address: string): Promise<void> {
    await this.#kv.delete(this.keyFor(address));
  }

  /**
   * Load, decrypt and re-verify an owner's active Fireflies import grant pair.
   * If the stored grant is expired, bound to a rotated delegate DID, unreadable or invalid,
   * clears its ciphertext and transitions the slot to `needs_renewal`.
   */
  async loadActive(
    address: string,
    options: FirefliesGrantVerifyOptions,
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
      await this.markState(normalized, "needs_renewal", null);
      return { state: "needs_renewal", expiresAt: null };
    }

    const storedExpiryMs = Date.parse(stored.expiresAt);
    if (!Number.isFinite(storedExpiryMs) || storedExpiryMs <= now) {
      const reportedExpiry = Number.isFinite(storedExpiryMs) ? stored.expiresAt : null;
      await this.markState(normalized, "needs_renewal", reportedExpiry);
      return { state: "needs_renewal", expiresAt: reportedExpiry };
    }

    if (stored.delegateDid !== this.#delegateDid) {
      await this.markState(normalized, "needs_renewal", null);
      return { state: "needs_renewal", expiresAt: null };
    }

    let envelope: FirefliesGrantEnvelope;
    try {
      envelope = this.#open(stored as StoredActiveGrantRecord, normalized);
    } catch {
      await this.markState(normalized, "needs_renewal", null);
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
      await this.markState(normalized, "needs_renewal", reportedExpiry);
      return { state: "needs_renewal", expiresAt: reportedExpiry };
    }

    return { state: "active", envelope, verified: verified.verified };
  }

  /** Content-free status for `GET /api/connectors/fireflies/delegation`. */
  async status(
    address: string,
    options: FirefliesGrantVerifyOptions,
  ): Promise<FirefliesGrantStatus> {
    const loaded = await this.loadActive(address, options);
    if (loaded.state === "active") {
      return { state: "active", expiresAt: loaded.verified.expiresAt.toISOString() };
    }
    return { state: loaded.state, expiresAt: loaded.expiresAt };
  }
}
