import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import * as serverPackage from "@tinyboilerplate/server";
import { BackendStorageLane } from "./backend-storage-lane.js";
import {
  assertStrongSecret,
  isValidSource,
  keyedLogHash,
  normalizeWebhookAddress,
} from "./webhook-tokens.js";
import { recordCredentialAudit } from "./ingest-observability.js";

const { assertKvResult, withSessionRefresh } = serverPackage;
const { isKvMissingKeyResult } = serverPackage as typeof serverPackage & {
  isKvMissingKeyResult: (result: unknown, key: string) => boolean;
};

/**
 * W2 — the per-user provider credential store (backend-ingest plan §6.2, §8.1 W2; §8.2 delta 3).
 *
 * THIS FILE IS ONE HALF OF A CONSCIOUS, OPERATOR-AUTHORIZED REVERSAL (plan §11): under the
 * shipped Option C the backend never holds a Fireflies credential at all. For cohort addresses
 * behind the dark `CONNECTOR_BACKEND_INGEST_ENABLED` flag it now does, so every property that
 * made the old invariant unnecessary has to be re-established explicitly here:
 *
 *  - **Isolated.** One row per `(source, address)`. There is no list/scan/enumerate surface, in
 *    the class or in the row-store port beneath it: retrieval is tenant-scoped *by construction*,
 *    not by a filter someone can forget. `getCredential` is the ONLY read of a decrypted value.
 *  - **Encrypted at rest, app-layer.** Per-credential DEK, AES-256-GCM, the DEK wrapped under a
 *    key derived from a DEDICATED env master (`CONNECTOR_CREDENTIAL_MASTER`) that is **separate
 *    from `WEBHOOK_HMAC_MASTER`** and refuses to boot when weak — the same posture the HMAC
 *    master already has. At-rest encryption is a control we apply, never a substrate property we
 *    assume (§7). Both envelopes are AAD-bound to `(source, address)`, so a row relabelled into
 *    another tenant's slot does not decrypt: cross-tenant reuse fails closed rather than leaking.
 *  - **Never observable.** A credential is never logged (not even a redacted prefix), never
 *    returned to a client, and never carried in an error path — including an upstream provider
 *    error whose own message may quote the token. Audit lines carry ops, hashed addresses and
 *    fixed reason codes only.
 *  - **Fail closed.** Every write is result-checked and propagates; nothing here can report a
 *    success it did not get.
 *
 * SUBSTRATE (D3 = off-node). The `CredentialRowStore` port below is that seam: it only ever sees
 * `ciphertext` + `wrappedDEK`, so the plaintext credential and the master both stay inside the
 * CVM whichever adapter is bound. `KvCredentialRowStore` (backend-own KV, one sequential lane) is
 * the interim binding available today; the off-node adapter implements the same three methods.
 * Note `KvCredentialRowStore` writes to the BACKEND's own space — the KV-never-SQL rule governs
 * *user-space* connector writes, which this is not.
 */

/** The dedicated master, per §6.2. Separate from `WEBHOOK_HMAC_MASTER` by requirement. */
export const CREDENTIAL_MASTER_ENV = "CONNECTOR_CREDENTIAL_MASTER";
/**
 * The rotation grace env, mirroring `WEBHOOK_HMAC_MASTER_PREV` (webhook-tokens.ts:199). Without
 * it, rotating `CONNECTOR_CREDENTIAL_MASTER` immediately makes every previously-sealed envelope
 * unreadable — `getCredential` and `revoke` both throw "envelope is unreadable", so a disconnect
 * cannot revoke upstream and the fetch worker cannot open its credential. Present-and-weak throws
 * for the same reason `_PREV` does on the HMAC side: the grace window must not be the weak-key
 * window.
 */
export const CREDENTIAL_MASTER_PREV_ENV = "CONNECTOR_CREDENTIAL_MASTER_PREV";

const KEK_HKDF_SALT = "tinychat-credential-v1";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEK_BYTES = 32;

/** Default `lastUsedAt` write throttle: an audit stamp must not become a write per fetch. */
export const LAST_USED_THROTTLE_MS = 60 * 60_000;

export type CredentialKind = "oauth" | "api_key";

/**
 * The plaintext, in memory only. Branch b1 (DECISIONS `V-a-branch`) is OAuth, so `oauth` is the
 * shape the shipped flow writes; `api_key` exists because §6.1's b2/c fallback stores one field
 * instead of three, not because anything mints it today.
 */
export interface OAuthCredentialSecret {
  kind: "oauth";
  accessToken: string;
  refreshToken?: string;
  /** ISO — when the access token expires, so the worker can refresh before using it. */
  expiresAt?: string;
  scope?: string;
}

export interface ApiKeyCredentialSecret {
  kind: "api_key";
  apiKey: string;
}

export type CredentialSecret = OAuthCredentialSecret | ApiKeyCredentialSecret;

/** The stored row (§6.2). Everything here is safe at rest; nothing here is the credential. */
export interface CredentialRow {
  source: string;
  address: string;
  kind: CredentialKind;
  ciphertext: string;
  wrappedDEK: string;
  createdAt: string;
  rotatedAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}

/** What a caller may see about a credential: its existence and its audit stamps. Never a value. */
export interface CredentialMeta {
  source: string;
  address: string;
  kind: CredentialKind;
  createdAt: string;
  rotatedAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}

/**
 * The D3 substrate seam. Three methods, all keyed by `(source, address)` — deliberately NO list:
 * an enumeration method is how a tenant-scoped store stops being one.
 */
export interface CredentialRowStore {
  read(source: string, address: string): Promise<CredentialRow | null>;
  write(row: CredentialRow): Promise<void>;
  remove(source: string, address: string): Promise<void>;
}

/**
 * Why the retrieve path names its caller: §6.2 restricts `getCredential` to the fetch
 * worker / teardown paths, with an address that came from the signed token->address lookup. The
 * purpose is required, so every call site says out loud which path it is — and
 * `connector-credentials.test.ts` asserts no route module calls it at all.
 */
export type CredentialAccessPurpose =
  | "fetch-worker"
  | "token-refresh"
  | "teardown";

export type UpstreamRevokeOutcome = "ok" | "failed" | "not_applicable";

export interface CredentialRevokeResult {
  deleted: boolean;
  upstreamRevoked: UpstreamRevokeOutcome;
  /** A FIXED code, never a provider message — an upstream error can quote the token. */
  reason?: "upstream_revoke_failed" | "credential_unreadable" | "no_credential";
}

export interface CredentialStoreOptions {
  now?: () => number;
  /** Injectable so a test pins the master without mutating the process env. */
  master?: () => string;
  /**
   * The rotation-grace master (§6.2). Read only on decrypt: writes always use `master()`, so a
   * fresh envelope names one master value at a time and there is no ambiguity about which master
   * sealed which row. `null` = no rotation in flight — the shipped posture.
   */
  previousMaster?: () => string | null;
  /**
   * The upstream OAuth revoke (§6.2 "revoke"). Injected rather than imported so this module
   * knows nothing about any provider's HTTP surface — and so a failure is a value this class
   * surfaces, never an exception it swallows.
   */
  upstreamRevoker?: (secret: CredentialSecret) => Promise<void>;
  lastUsedThrottleMs?: number;
}

// ── Master key ───────────────────────────────────────────────────────

const validatedCredentialMasters = new Set<string>();

/**
 * Boot-time gate (§6.2: "the same refuse-boot-on-weak-master posture the HMAC master already
 * has"). Returns a Result rather than throwing so `index.ts` can print and exit(1) exactly the
 * way it does for the webhook secrets. The error text NEVER contains a key value.
 */
export function validateCredentialCustodyConfig(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; error: string } {
  const value = env[CREDENTIAL_MASTER_ENV];
  try {
    assertStrongSecret(CREDENTIAL_MASTER_ENV, value, { quiet: true });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const webhookMaster = env.WEBHOOK_HMAC_MASTER;
  if (
    typeof webhookMaster === "string" &&
    typeof value === "string" &&
    sameSecret(webhookMaster.trim(), value.trim())
  ) {
    return {
      ok: false,
      error:
        `[startup] FATAL: ${CREDENTIAL_MASTER_ENV} must not reuse WEBHOOK_HMAC_MASTER — ` +
        "credential custody and delivery authentication must not share one compromise",
    };
  }
  return { ok: true };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The current credential master. Throws when unset or weak — never a fallback that hides it. */
export function currentCredentialMaster(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[CREDENTIAL_MASTER_ENV];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!validatedCredentialMasters.has(trimmed)) {
    const config = validateCredentialCustodyConfig(env);
    if (!config.ok) throw new Error(config.error);
    validatedCredentialMasters.add(trimmed);
  }
  return trimmed;
}

/**
 * The rotation grace master, or null when no rotation is in flight. Present-and-weak throws:
 * the grace window must not be the weak-key window (mirrors previousWebhookMaster in
 * webhook-tokens.ts:199).
 */
export function previousCredentialMaster(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[CREDENTIAL_MASTER_PREV_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  const memoKey = `${CREDENTIAL_MASTER_PREV_ENV}:${trimmed}`;
  if (!validatedCredentialMasters.has(memoKey)) {
    assertStrongSecret(CREDENTIAL_MASTER_PREV_ENV, trimmed, { quiet: true });
    validatedCredentialMasters.add(memoKey);
  }
  return trimmed;
}

/** Test hook (house convention). */
export function _resetCredentialMasterCache(): void {
  validatedCredentialMasters.clear();
}

// ── Envelope encryption ──────────────────────────────────────────────

function envelopeAad(source: string, address: string): Buffer {
  return Buffer.from(`${source}:${address}`, "utf8");
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

/** `base64(iv | tag | ciphertext)` — AES-256-GCM, AAD-bound to the tenant. */
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
    throw new Error("credential envelope is unreadable");
  }
  const iv = raw.subarray(0, GCM_IV_BYTES);
  const tag = raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const body = raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  // A wrong tenant, a wrong master or a tampered row all land here as the SAME failure, with no
  // detail: an "unreadable envelope" diagnostic must not become an oracle.
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function parseSecret(raw: Buffer): CredentialSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("credential payload is unreadable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("credential payload is unreadable");
  }
  const value = parsed as Record<string, unknown>;
  if (value.kind === "oauth" && typeof value.accessToken === "string") {
    const secret: OAuthCredentialSecret = {
      kind: "oauth",
      accessToken: value.accessToken,
    };
    if (typeof value.refreshToken === "string")
      secret.refreshToken = value.refreshToken;
    if (typeof value.expiresAt === "string") secret.expiresAt = value.expiresAt;
    if (typeof value.scope === "string") secret.scope = value.scope;
    return secret;
  }
  if (value.kind === "api_key" && typeof value.apiKey === "string") {
    return { kind: "api_key", apiKey: value.apiKey };
  }
  throw new Error("credential payload is unreadable");
}

// ── Audit logging (ops + hashed ids + fixed codes; never a value) ────

function hashed(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unavailable";
  }
}

/**
 * Every credential op logs through here or through {@link warnCredential}, so W8's audit taps the
 * loggers rather than the call sites (plan §8.1 W8: *credential-op audit*). A later op that logs
 * like its peers is audited for free; one that does not log at all is already breaking §6.2.
 * The field string is this module's own structured format and the address in it is ALREADY
 * hashed — the audit stores a count, never the line.
 */
function logCredential(fields: string): void {
  recordCredentialAudit(fields);
  console.log(`[connector-credential] ${fields} t=${new Date().toISOString()}`);
}

function warnCredential(fields: string): void {
  recordCredentialAudit(fields);
  console.warn(`[connector-credential] ${fields} t=${new Date().toISOString()}`);
}

// ── The store ────────────────────────────────────────────────────────

export class CredentialStore {
  private readonly now: () => number;
  private readonly master: () => string;
  private readonly previousMaster: () => string | null;
  private readonly upstreamRevoker:
    | ((secret: CredentialSecret) => Promise<void>)
    | null;
  private readonly lastUsedThrottleMs: number;

  constructor(
    private readonly rows: CredentialRowStore,
    options: CredentialStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.master = options.master ?? (() => currentCredentialMaster());
    this.previousMaster =
      options.previousMaster ?? (() => previousCredentialMaster());
    this.upstreamRevoker = options.upstreamRevoker ?? null;
    this.lastUsedThrottleMs =
      options.lastUsedThrottleMs ?? LAST_USED_THROTTLE_MS;
  }

  /**
   * OBTAIN (§6.2). The credential arrives from the connect flow and goes straight in here — it is
   * never written to the user's browser vault for this purpose, and the existing Option-C vault
   * key is never migrated (cohort seeding runs the obtain flow first).
   */
  store(input: {
    source: string;
    address: string;
    secret: CredentialSecret;
  }): Promise<CredentialMeta> {
    return this.write(input, "store");
  }

  /**
   * ROTATE (§6.2): OAuth refresh-token rotation lands here automatically; an API key arrives via
   * the operator/user re-submit runbook. `createdAt` survives, `rotatedAt` is stamped and audited,
   * and the previous ciphertext is REPLACED — a rotation that leaves the old envelope readable
   * has not rotated anything.
   */
  rotate(input: {
    source: string;
    address: string;
    secret: CredentialSecret;
  }): Promise<CredentialMeta> {
    return this.write(input, "rotate");
  }

  /**
   * RETRIEVE (§6.2) — the ONE function that returns a decrypted credential, callable from the
   * fetch worker / refresh / teardown paths with an address that came from the signed
   * token->address lookup. Returns null when there is no credential (or it is marked revoked);
   * THROWS when a row exists but cannot be opened as this tenant's — an unreadable credential is
   * a failure, never a quiet "not connected".
   */
  async getCredential(
    source: string,
    address: string,
    purpose: CredentialAccessPurpose,
  ): Promise<CredentialSecret | null> {
    const src = normalizeSource(source);
    const addr = normalizeWebhookAddress(address);
    const row = await this.rows.read(src, addr);
    if (row === null) return null;
    if (typeof row.revokedAt === "string") return null;
    return this.openRow(row, src, addr, purpose);
  }

  /**
   * Open one row's envelope. Split out of {@link getCredential} for exactly one caller:
   * {@link revoke}, which must be able to open a row that `getCredential` deliberately reports as
   * "not connected" (a soft-revoked one). It holds the only copy of the token that can revoke the
   * grant upstream, and skipping that call is how a disconnect leaves a live credential behind.
   */
  private openRow(
    row: CredentialRow,
    src: string,
    addr: string,
    purpose: CredentialAccessPurpose,
  ): CredentialSecret {
    // Belt to the AAD's braces: a row that names another tenant never reaches the cipher.
    if (row.source !== src || row.address !== addr) {
      warnCredential(
        `op=credential-read result=tenant_mismatch source=${src} aid=${hashed(addr)}`,
      );
      throw new Error("credential row does not belong to this tenant");
    }

    const aad = envelopeAad(src, addr);
    // Dual-read on decrypt, single-write on encrypt (mirrors the HMAC rotation posture): try the
    // current master first, then the grace master if a rotation is in flight. A write always uses
    // the current master, so a rotated envelope is single-master by construction.
    const masters: string[] = [this.master()];
    const previous = this.previousMaster();
    if (previous !== null && previous !== masters[0]) masters.push(previous);
    for (const masterValue of masters) {
      try {
        const kek = keyEncryptionKey(masterValue, src, addr);
        const dek = open(kek, row.wrappedDEK, aad);
        const secret = parseSecret(open(dek, row.ciphertext, aad));
        logCredential(
          `op=credential-read result=ok purpose=${purpose} source=${src} aid=${hashed(addr)}`,
        );
        return secret;
      } catch {
        // Fall through to the next master; the final failure emits the SAME unreadable line and
        // the SAME error the single-master path used to, so the surface stays identical.
      }
    }
    // No error detail escapes: the message could only describe the envelope, and describing it
    // is the one thing a caller of this function must never be able to do.
    warnCredential(
      `op=credential-read result=unreadable purpose=${purpose} source=${src} aid=${hashed(addr)}`,
    );
    throw new Error("credential envelope is unreadable");
  }

  /** Existence + audit stamps, for the status route. Never touches the envelope. */
  async status(source: string, address: string): Promise<CredentialMeta | null> {
    const src = normalizeSource(source);
    const addr = normalizeWebhookAddress(address);
    const row = await this.rows.read(src, addr);
    return row === null ? null : metaOf(row);
  }

  /**
   * Stamp `lastUsedAt`, throttled. The stamp is an audit control, not an accounting one, so it
   * must not turn into a write per fetch against a shared substrate (§7's write budget).
   */
  async markUsed(source: string, address: string): Promise<void> {
    const src = normalizeSource(source);
    const addr = normalizeWebhookAddress(address);
    const row = await this.rows.read(src, addr);
    if (row === null) return;
    const last = Date.parse(row.lastUsedAt);
    if (
      Number.isFinite(last) &&
      this.now() - last < this.lastUsedThrottleMs
    ) {
      return;
    }
    await this.rows.write({ ...row, lastUsedAt: new Date(this.now()).toISOString() });
  }

  /**
   * REVOKE (§6.2). Upstream first (the row holds the only copy of the token that can revoke it),
   * then the row is deleted **unconditionally** — custody ending is the point, and a provider
   * outage must not leave us holding a live credential. An upstream failure is REPORTED, never
   * swallowed: callers surface it (the route answers 502). The delete is result-checked and
   * propagates, so "revoked" cannot be reported for a delete that did not happen.
   */
  async revoke(source: string, address: string): Promise<CredentialRevokeResult> {
    const src = normalizeSource(source);
    const addr = normalizeWebhookAddress(address);

    let upstream: UpstreamRevokeOutcome = "not_applicable";
    let reason: CredentialRevokeResult["reason"];
    let existed = false;

    const row = await this.rows.read(src, addr);
    if (row !== null) {
      existed = true;
      if (this.upstreamRevoker !== null) {
        let secret: CredentialSecret | null;
        try {
          // The ROW, not `getCredential`: a row already marked `revokedAt` reads back as null
          // there, which would silently skip the upstream revoke and then report a clean
          // disconnect while the provider-side grant stayed live.
          secret = this.openRow(row, src, addr, "teardown");
        } catch {
          secret = null;
          upstream = "failed";
          reason = "credential_unreadable";
        }
        if (secret !== null) {
          // An api_key credential has no upstream revoke endpoint — reporting `failed` on
          // disconnect would make every api_key teardown answer 502, when the correct outcome is
          // `not_applicable` (§6.2 already models the outcome).
          if (secret.kind !== "oauth") {
            upstream = "not_applicable";
          } else {
            try {
              await this.upstreamRevoker(secret);
              upstream = "ok";
            } catch {
              // The provider's own message may quote the token — it is neither logged nor returned.
              upstream = "failed";
              reason = "upstream_revoke_failed";
            }
          }
        }
      }
    } else {
      reason = "no_credential";
    }

    await this.rows.remove(src, addr);
    logCredential(
      `op=credential-revoke result=deleted existed=${existed} upstream=${upstream} ` +
        `source=${src} aid=${hashed(addr)}`,
    );
    return {
      deleted: true,
      upstreamRevoked: upstream,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  private async write(
    input: { source: string; address: string; secret: CredentialSecret },
    op: "store" | "rotate",
  ): Promise<CredentialMeta> {
    const src = normalizeSource(input.source);
    const addr = normalizeWebhookAddress(input.address);
    const secret = input.secret;
    if (secret === null || typeof secret !== "object") {
      throw new Error("credential secret is required");
    }

    const existing = await this.rows.read(src, addr);
    const stamp = new Date(this.now()).toISOString();
    const aad = envelopeAad(src, addr);
    const dek = randomBytes(DEK_BYTES);
    const row: CredentialRow = {
      source: src,
      address: addr,
      kind: secret.kind,
      ciphertext: seal(dek, Buffer.from(JSON.stringify(secret), "utf8"), aad),
      wrappedDEK: seal(keyEncryptionKey(this.master(), src, addr), dek, aad),
      createdAt: existing?.createdAt ?? stamp,
      rotatedAt: stamp,
      lastUsedAt: existing?.lastUsedAt ?? stamp,
    };
    // A durable write failure propagates — there is no "stored" to report without one.
    await this.rows.write(row);
    logCredential(
      `op=credential-${op} result=ok source=${src} aid=${hashed(addr)} kind=${row.kind}`,
    );
    return metaOf(row);
  }
}

function metaOf(row: CredentialRow): CredentialMeta {
  return {
    source: row.source,
    address: row.address,
    kind: row.kind,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    lastUsedAt: row.lastUsedAt,
    ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
  };
}

function normalizeSource(source: unknown): string {
  if (!isValidSource(source)) throw new Error("Invalid credential source");
  return source;
}

function parseRow(raw: unknown): CredentialRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    !isValidSource(value.source) ||
    typeof value.address !== "string" ||
    (value.kind !== "oauth" && value.kind !== "api_key") ||
    typeof value.ciphertext !== "string" ||
    typeof value.wrappedDEK !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.rotatedAt !== "string" ||
    typeof value.lastUsedAt !== "string"
  ) {
    return null;
  }
  return {
    source: value.source,
    address: value.address,
    kind: value.kind,
    ciphertext: value.ciphertext,
    wrappedDEK: value.wrappedDEK,
    createdAt: value.createdAt,
    rotatedAt: value.rotatedAt,
    lastUsedAt: value.lastUsedAt,
    ...(typeof value.revokedAt === "string"
      ? { revokedAt: value.revokedAt }
      : {}),
  };
}

// ── Adapters ─────────────────────────────────────────────────────────

/**
 * The dev/test binding. `dump()` exists for exactly one reason: the delta-3 acceptance test greps
 * the raw bytes for a plaintext credential. It is NOT a list API for the store — nothing in
 * `CredentialStore` calls it, and no route can reach it.
 */
export class InMemoryCredentialRowStore implements CredentialRowStore {
  private readonly rows = new Map<string, string>();

  async read(source: string, address: string): Promise<CredentialRow | null> {
    const raw = this.rows.get(rowKey(source, address));
    return raw === undefined ? null : parseRow(JSON.parse(raw));
  }

  async write(row: CredentialRow): Promise<void> {
    this.rows.set(rowKey(row.source, row.address), JSON.stringify(row));
  }

  async remove(source: string, address: string): Promise<void> {
    this.rows.delete(rowKey(source, address));
  }

  /** Every stored byte, exactly as the substrate would hold it. */
  dump(): string {
    return JSON.stringify([...this.rows.entries()]);
  }
}

/**
 * The interim substrate binding: the backend's OWN TinyCloud KV (auto-prefixed under
 * `ops.tinychat.backend`, never a user space). One sequential lane — TinyCloud drops concurrent
 * responses on a single space — and every call is result-checked inside `withSessionRefresh`,
 * because a `{ok:false}` read cast to `undefined` would read as "this user has no credential".
 *
 * The `storageLane` param wires this store to the SAME lane the queue and content store use, so
 * cross-component writes to the shared backend space are serialised as one lane. Absent = a
 * private per-instance lane (the standalone default). index.ts wires the shared lane in prod.
 */
export class KvCredentialRowStore implements CredentialRowStore {
  private readonly lane: BackendStorageLane;

  constructor(
    private readonly node: TinyCloudNode,
    storageLane?: BackendStorageLane,
  ) {
    this.lane = storageLane ?? new BackendStorageLane();
  }

  read(source: string, address: string): Promise<CredentialRow | null> {
    return this.run(async () => {
      const raw = await this.readJson(kvKey(source, address));
      if (raw === null) return null;
      const row = parseRow(raw);
      if (row === null) {
        warnCredential(
          `op=credential-row result=unparseable source=${source} aid=${hashed(address)}`,
        );
        throw new Error("credential row is unparseable");
      }
      return row;
    });
  }

  write(row: CredentialRow): Promise<void> {
    return this.run(async () => {
      await withSessionRefresh(this.node, async () => {
        assertKvResult(await this.node.kv.put(kvKey(row.source, row.address), row));
      });
    });
  }

  remove(source: string, address: string): Promise<void> {
    const key = kvKey(source, address);
    return this.run(async () => {
      await withSessionRefresh(this.node, async () => {
        const result = await this.node.kv.delete(key);
        if (isKvMissingKeyResult(result, key)) return;
        assertKvResult(result);
      });
    });
  }

  private async readJson(key: string): Promise<unknown> {
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
    const value = (response as { data?: unknown }).data ?? response;
    if (typeof value !== "string") return value ?? null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    return this.lane.run(fn);
  }
}

function rowKey(source: string, address: string): string {
  return `${normalizeSource(source)} ${normalizeWebhookAddress(address)}`;
}

function kvKey(source: string, address: string): string {
  return `credentials/${normalizeSource(source)}/${normalizeWebhookAddress(address)}`;
}
