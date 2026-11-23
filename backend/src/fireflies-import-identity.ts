import { createHash, createPrivateKey, hkdfSync, timingSafeEqual } from "node:crypto";
import { NodeWasmBindings, TinyCloudNode } from "@tinycloud/node-sdk";
import type { DstackKeyClient } from "./attestation/dstackClient.js";

export const FIREFLIES_SERVER_IMPORT_ENABLED_ENV = "FIREFLIES_SERVER_IMPORT_ENABLED";
export const FIREFLIES_DELEGATE_KMS_PATH = "tinychat/fireflies-import/delegate/ed25519/v1";
export const FIREFLIES_GRANT_KEK_KMS_PATH = "tinychat/fireflies-import/grant-store/kek/v1";

const DELEGATE_SEED_HKDF_INFO = "tinychat.fireflies-import.delegate-ed25519/v1";
const GRANT_KEK_HKDF_INFO = "tinychat.fireflies-import.grant-kek/v1";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const MIN_KMS_KEY_BYTES = 32;

/**
 * Server-side Fireflies import ships OFF by default. Only the literal string "true" arms the
 * KMS key derivation and mounts `/api/connectors/fireflies/delegation`.
 */
export function firefliesServerImportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FIREFLIES_SERVER_IMPORT_ENABLED_ENV] === "true";
}

export interface FirefliesDelegateIdentity {
  /** Bare principal DID (`did:key:z6Mk...`), used as the exact delegation audience. */
  readonly did: string;
  /** Full verification method DID URL (`did:key:z6Mk...#z6Mk...`). */
  readonly sessionDid: string;
  /** Session-only TinyCloudNode holding the KMS-derived Ed25519 delegate key in memory. */
  readonly node: TinyCloudNode;
  /**
   * Build a fresh, isolated session-only TinyCloudNode bound to the same KMS-derived Ed25519
   * identity so one owner's activated delegations never touch another owner's runtime state.
   */
  createScopedNode(): TinyCloudNode;
}

/**
 * Evict all runtime delegations and per-space caches from a session-only delegate TinyCloudNode
 * so no tenant grant or vault handle survives past a single activation or import run.
 */
export function evictDelegateNodeGrants(node: TinyCloudNode): void {
  const internal = node as unknown as {
    runtimePermissionGrants?: unknown[];
    _capabilityRegistry?: { clear?: () => void };
    _baseVaults?: Map<unknown, unknown>;
    _baseSecrets?: Map<unknown, unknown>;
    _secrets?: Map<unknown, unknown>;
  };
  if (Array.isArray(internal.runtimePermissionGrants)) {
    internal.runtimePermissionGrants.length = 0;
  }
  internal._capabilityRegistry?.clear?.();
  internal._baseVaults?.clear();
  internal._baseSecrets?.clear();
  internal._secrets?.clear();
}

export interface FirefliesImportKeys {
  readonly delegate: FirefliesDelegateIdentity;
  /** Dedicated 32-byte AES-256-GCM KEK derived from dstack KMS; separate from all other masters. */
  readonly grantKek: Buffer;
}

function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const byte of bytes) acc |= byte;
  return acc === 0;
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function sameMaterial(a: Uint8Array, b: Uint8Array): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function decodeEnvSecretCandidates(raw: string | undefined): Buffer[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  const candidates: Buffer[] = [Buffer.from(trimmed, "utf8")];
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    candidates.push(Buffer.from(trimmed, "hex"));
  }
  const b64 = Buffer.from(trimmed, "base64");
  if (b64.length > 0) candidates.push(b64);
  const b64url = Buffer.from(trimmed, "base64url");
  if (b64url.length > 0) candidates.push(b64url);
  return candidates;
}

function assertDistinctFromEnvMaster(name: string, envValue: string | undefined, keyBytes: Uint8Array): void {
  for (const candidate of decodeEnvSecretCandidates(envValue)) {
    if (sameMaterial(candidate, keyBytes)) {
      throw new Error(
        `[startup] FATAL: fireflies-import KMS key material must not reuse ${name}`,
      );
    }
  }
}

function assertUsableKmsBytes(label: string, bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || bytes.length < MIN_KMS_KEY_BYTES || isAllZero(bytes)) {
    throw new Error(
      `[startup] FATAL: dstack KMS returned missing or weak key material for ${label} (need >=${MIN_KMS_KEY_BYTES} non-zero bytes)`,
    );
  }
}

/**
 * Construct a deterministic session-only TinyCloudNode (`did:key`) from a 32-byte Ed25519 seed.
 * The private key lives only inside the process WASM session manager and is never exported or logged.
 */
export function createFirefliesDelegateFromSeed(seed: Buffer, host: string): FirefliesDelegateIdentity {
  if (!Buffer.isBuffer(seed) || seed.length !== 32 || isAllZero(seed)) {
    throw new Error("[startup] FATAL: fireflies-import delegate seed must be 32 non-zero bytes");
  }
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  try {
    const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const jwk = privateKey.export({ format: "jwk" });
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string") {
      throw new Error("[startup] FATAL: failed to construct Ed25519 JWK for fireflies-import delegate");
    }
    const baseWasm = new NodeWasmBindings();
    const wasmBindings = Object.assign(Object.create(baseWasm) as NodeWasmBindings, {
      createSessionManager() {
        const manager = baseWasm.createSessionManager();
        if (typeof manager.replaceSessionKey !== "function") {
          throw new Error("[startup] FATAL: WASM session manager lacks replaceSessionKey");
        }
        manager.replaceSessionKey(jwk, "default");
        return manager;
      },
    });
    const createScopedNode = () => new TinyCloudNode({ host, wasmBindings });
    const node = createScopedNode();
    const sessionDid = node.sessionDid;
    const did = node.did.split("#", 1)[0] ?? "";
    if (!node.isSessionOnly || !did.startsWith("did:key:")) {
      throw new Error("[startup] FATAL: fireflies-import delegate must be a session-only did:key identity");
    }
    return { did, sessionDid, node, createScopedNode };
  } finally {
    pkcs8.fill(0);
  }
}

/**
 * Derive both the dedicated session-only `did:key` delegate identity and the dedicated AES-256-GCM
 * grant-store KEK from dstack KMS inside the CVM on two distinct KMS paths.
 *
 * Neither key ever comes from a GitHub or Phala env secret. Fails closed if dstack is unavailable
 * or returns short, all-zero, colliding or reused key material.
 */
export async function deriveFirefliesImportKeys(
  dstack: DstackKeyClient,
  options: { host: string; env?: NodeJS.ProcessEnv },
): Promise<FirefliesImportKeys> {
  const env = options.env ?? process.env;
  let rawDelegate: Buffer | undefined;
  let rawKek: Buffer | undefined;
  let delegateSeed: Buffer | undefined;
  try {
    rawDelegate = await dstack.getKey(FIREFLIES_DELEGATE_KMS_PATH);
    assertUsableKmsBytes(FIREFLIES_DELEGATE_KMS_PATH, rawDelegate);

    rawKek = await dstack.getKey(FIREFLIES_GRANT_KEK_KMS_PATH);
    assertUsableKmsBytes(FIREFLIES_GRANT_KEK_KMS_PATH, rawKek);

    if (sameMaterial(rawDelegate, rawKek)) {
      throw new Error(
        "[startup] FATAL: fireflies-import delegate and grant-store KEK KMS paths returned identical material",
      );
    }

    delegateSeed = Buffer.from(
      hkdfSync("sha256", rawDelegate, Buffer.alloc(0), DELEGATE_SEED_HKDF_INFO, 32),
    );
    const grantKek = Buffer.from(
      hkdfSync("sha256", rawKek, Buffer.alloc(0), GRANT_KEK_HKDF_INFO, 32),
    );

    if (isAllZero(delegateSeed) || isAllZero(grantKek) || sameMaterial(delegateSeed, grantKek)) {
      grantKek.fill(0);
      throw new Error("[startup] FATAL: derived fireflies-import keys are weak or colliding");
    }

    assertDistinctFromEnvMaster("WEBHOOK_HMAC_MASTER", env.WEBHOOK_HMAC_MASTER, rawKek);
    assertDistinctFromEnvMaster("WEBHOOK_HMAC_MASTER", env.WEBHOOK_HMAC_MASTER, grantKek);
    assertDistinctFromEnvMaster("CONNECTOR_CREDENTIAL_MASTER", env.CONNECTOR_CREDENTIAL_MASTER, rawKek);
    assertDistinctFromEnvMaster("CONNECTOR_CREDENTIAL_MASTER", env.CONNECTOR_CREDENTIAL_MASTER, grantKek);

    const delegate = createFirefliesDelegateFromSeed(delegateSeed, options.host);
    return { delegate, grantKek };
  } finally {
    rawDelegate?.fill(0);
    rawKek?.fill(0);
    delegateSeed?.fill(0);
  }
}
