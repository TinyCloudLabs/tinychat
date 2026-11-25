// TC-3823 (Route i): owner-signed descriptor for the single seeded bot-history encryption key.
// The backend derives owner, networkId and keyPath from the authenticated session, verifies the
// owner's SIWE -> session did:key Ed25519 signature chain, pins (keyVersion, publicEncryptionKey),
// and refuses expired, downgraded or mismatched descriptors without ever falling back to network encrypt.
import { canonicalizeEncryptionJson, verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import { DEFAULT_ENCRYPTION_ALG } from "@tinycloud/sdk-services/encryption";
import { verifySiweSession, type SessionRenewal, type VerifiedSiweSession } from "@tinyboilerplate/server";
import { getAddress } from "viem";

export { BOT_HISTORY_KEY_PATH };

/** Longest lifetime accepted for a bot-history key descriptor: 7 days. */
export const BOT_HISTORY_KEY_MAX_MS = 7 * 86_400_000;
const CLOCK_SKEW_MS = 300_000;

export interface BotHistoryKeyDescriptorPayload {
  v: 1;
  type: "tinychat.bot-history.key-descriptor/v1";
  owner: string;
  networkId: string;
  keyPath: string;
  alg: string;
  keyVersion: number;
  publicEncryptionKey: string;
  kind: "deletable";
  state: "active";
  iat: number;
  exp: number;
}

export interface SignedBotHistoryKeyEnvelope {
  descriptor: BotHistoryKeyDescriptorPayload;
  descriptorSignature: string;
  signerDid: string;
  siwe: string;
  signature: string;
}

export interface VerifiedBotHistoryKeyDescriptor {
  descriptor: BotHistoryKeyDescriptorPayload;
  expiresAtMs: number;
}

export class HistoryKeyDescriptorExpired extends Error {
  constructor(readonly expiresAt: number) {
    super("history_key_descriptor_expired");
  }
}

export class HistoryKeyDescriptorRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Canonical EIP-55 owner DID derived from an EVM address. */
export function canonicalHistoryOwnerDid(address: string): string {
  return `did:pkh:eip155:1:${getAddress(address)}`;
}

/** Canonical default encryption network URN derived from an EVM address. */
export function botHistoryNetworkId(address: string): string {
  return `urn:tinycloud:encryption:${canonicalHistoryOwnerDid(address)}:default`;
}

/**
 * When a verified owner SIWE session's authority ends, in Unix ms: its signed end, or the later end of `renewal` when
 * that renewal is for this session's own key. `renewal` must come from verify-renewal, through the bearer that route
 * issued, never from a request body. NaN when the SIWE has no signed end and no renewal applies.
 */
export function sessionAuthorityEnd(session: Pick<VerifiedSiweSession, "uri" | "expirationTime">, renewal?: SessionRenewal): number {
  const signed = Date.parse(session.expirationTime ?? "");
  const renewed = renewal?.sessionDid === session.uri.split("#")[0] ? renewal.end * 1000 : NaN;
  return Number.isFinite(renewed) && !(renewed <= signed) ? renewed : signed;
}

function decodeCanonicalBase64(value: string, expectedBytes: number): Buffer | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== expectedBytes || bytes.toString("base64") !== value) return null;
  return bytes;
}

function decodeSignatureBytes(value: string): Buffer | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // Accept standard base64 or base64url encoding of a 64-byte Ed25519 signature.
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return null;
  const bytes = Buffer.from(padded, "base64");
  return bytes.length === 64 ? bytes : null;
}

const EXPECTED_FIELDS = [
  "alg",
  "exp",
  "iat",
  "keyPath",
  "keyVersion",
  "kind",
  "networkId",
  "owner",
  "publicEncryptionKey",
  "state",
  "type",
  "v",
] as const;

/**
 * Verifies an owner-signed bot-history key descriptor against derivations from the
 * authenticated owner `address`. Never trusts owner, networkId, or keyPath from input.
 * `renewal` (from the verify-renewal bearer) carries a session past its SIWE's signed end.
 */
export async function verifyBotHistoryKeyDescriptor(
  address: string,
  input: unknown,
  nowMs = Date.now(),
  renewal?: SessionRenewal,
): Promise<VerifiedBotHistoryKeyDescriptor> {
  const reject = (reason = "history_key_descriptor_rejected"): never => {
    throw new HistoryKeyDescriptorRejected(reason);
  };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("history_owner_invalid");
  if (!isRecord(input)) return reject();

  const { descriptor, descriptorSignature, signerDid, siwe, signature } = input;
  if (
    !isRecord(descriptor) ||
    typeof descriptorSignature !== "string" ||
    typeof signerDid !== "string" ||
    typeof siwe !== "string" ||
    typeof signature !== "string"
  ) {
    return reject();
  }

  // Reject unexpected or missing fields so canonical JSON covers the exact schema.
  const keys = Object.keys(descriptor).sort();
  if (keys.length !== EXPECTED_FIELDS.length || keys.some((k, i) => k !== EXPECTED_FIELDS[i])) {
    return reject();
  }

  const expectedOwner = canonicalHistoryOwnerDid(address);
  const expectedNetworkId = botHistoryNetworkId(address);

  if (
    descriptor.v !== 1 ||
    descriptor.type !== "tinychat.bot-history.key-descriptor/v1" ||
    descriptor.owner !== expectedOwner ||
    descriptor.networkId !== expectedNetworkId ||
    descriptor.keyPath !== BOT_HISTORY_KEY_PATH ||
    descriptor.kind !== "deletable" ||
    descriptor.state !== "active" ||
    descriptor.alg !== DEFAULT_ENCRYPTION_ALG ||
    typeof descriptor.keyVersion !== "number" ||
    !Number.isSafeInteger(descriptor.keyVersion) ||
    descriptor.keyVersion < 1 ||
    typeof descriptor.publicEncryptionKey !== "string" ||
    typeof descriptor.iat !== "number" ||
    !Number.isSafeInteger(descriptor.iat) ||
    typeof descriptor.exp !== "number" ||
    !Number.isSafeInteger(descriptor.exp)
  ) {
    return reject();
  }

  if (decodeCanonicalBase64(descriptor.publicEncryptionKey, 32) === null) return reject();

  const iatMs = descriptor.iat * 1000;
  const expMs = descriptor.exp * 1000;
  if (expMs <= nowMs) throw new HistoryKeyDescriptorExpired(expMs);
  if (iatMs > nowMs + CLOCK_SKEW_MS || expMs <= iatMs) return reject();
  if (expMs - iatMs > BOT_HISTORY_KEY_MAX_MS) return reject("history_key_descriptor_lifetime_exceeded");
  if (expMs > nowMs + BOT_HISTORY_KEY_MAX_MS) return reject("history_key_descriptor_lifetime_exceeded");

  // Verify the owner SIWE session binds `signerDid` to `address`.
  if (!signerDid.startsWith("did:key:") || signerDid.includes("#")) return reject();
  let session: Awaited<ReturnType<typeof verifySiweSession>>;
  try {
    session = await verifySiweSession(siwe, signature);
  } catch {
    return reject();
  }
  const sessionEndMs = sessionAuthorityEnd(session, renewal);
  if (
    session.address.toLowerCase() !== address.toLowerCase() ||
    session.chainId !== 1 ||
    !Number.isFinite(sessionEndMs) ||
    sessionEndMs <= nowMs
  ) {
    return reject();
  }
  // Cap at min(session, 7 d): descriptor exp must not outlive the session's signed or renewed end.
  if (expMs > sessionEndMs) return reject("history_key_descriptor_lifetime_exceeded");
  const boundDid = session.uri.split("#")[0];
  if (boundDid !== signerDid) return reject();

  const sigBytes = decodeSignatureBytes(descriptorSignature);
  if (!sigBytes) return reject();
  const payload = descriptor as unknown as BotHistoryKeyDescriptorPayload;
  const canonical = canonicalizeEncryptionJson({ ...payload });
  try {
    if (!verifyDidKeyEd25519Signature(signerDid, Buffer.from(canonical, "utf8"), sigBytes)) return reject();
  } catch {
    return reject();
  }

  return { descriptor: payload, expiresAtMs: expMs };
}

/**
 * Pinning check when an owner posts a newer signed descriptor.
 * - Downgrading `keyVersion` is refused.
 * - Changing `publicEncryptionKey` without incrementing `keyVersion` is refused.
 * - Keeping the same `(keyVersion, publicEncryptionKey)` refreshes expiry.
 * - Incrementing `keyVersion` updates the pin (key recreation / rotation).
 */
export function assertDescriptorPinCompatible(
  existing: Pick<BotHistoryKeyDescriptorPayload, "keyVersion" | "publicEncryptionKey">,
  next: Pick<BotHistoryKeyDescriptorPayload, "keyVersion" | "publicEncryptionKey">,
): void {
  if (next.keyVersion < existing.keyVersion) {
    throw new HistoryKeyDescriptorRejected("history_key_version_downgrade");
  }
  if (next.keyVersion === existing.keyVersion && next.publicEncryptionKey !== existing.publicEncryptionKey) {
    throw new HistoryKeyDescriptorRejected("history_key_mismatch");
  }
}
