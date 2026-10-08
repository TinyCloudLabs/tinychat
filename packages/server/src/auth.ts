import { randomBytes } from "crypto";
import { SiweMessage } from "siwe";
import { SignJWT, jwtVerify } from "jose";
import { SESSION_EXPIRATION_MS } from "@tinyboilerplate/core";

// ── Types ────────────────────────────────────────────────────────────

export interface NonceEntry {
  nonce: string;
  address: string;
  createdAt: number;
}

export interface NonceStore {
  /** Omit `address` for an unbound nonce: the /verify call binds it to the recovered signer. */
  generate(address?: string): string;
  validate(address: string, nonce: string): boolean;
}

export interface SessionTokenPayload {
  address: string;
}

// ── Nonce Store ─────────────────────────────────────────────────────

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create an in-memory nonce store for SIWE authentication.
 *
 * Nonces are:
 * - Cryptographically random (32 bytes hex)
 * - Bound to a specific address, or unbound (native sign-in: the delegation's
 *   address isn't known until OpenKey signs; the nonce is bound at /verify)
 * - Single-use (deleted after validation)
 * - Short-lived (5 minute TTL)
 */
export function createNonceStore(): NonceStore {
  const store = new Map<string, NonceEntry>();

  // Periodic cleanup of expired nonces
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.createdAt > NONCE_TTL_MS) {
        store.delete(key);
      }
    }
  }, 60_000);
  cleanupInterval.unref();

  const tryConsume = (key: string): boolean => {
    const entry = store.get(key);
    if (!entry) return false;
    // Delete immediately — single use
    store.delete(key);
    return Date.now() - entry.createdAt <= NONCE_TTL_MS;
  };

  return {
    generate(address?: string): string {
      const normalizedAddress = address?.toLowerCase() ?? "";
      const nonce = randomBytes(32).toString("hex");
      const key = `${normalizedAddress}:${nonce}`;

      store.set(key, {
        nonce,
        address: normalizedAddress,
        createdAt: Date.now(),
      });

      return nonce;
    },

    validate(address: string, nonce: string): boolean {
      const normalizedAddress = address.toLowerCase();
      // An unbound nonce validates under the address the SIWE recovered; the
      // address embedded in the message is what the backend session binds to.
      return tryConsume(`${normalizedAddress}:${nonce}`) || tryConsume(`:${nonce}`);
    },
  };
}

// ── SIWE Verification ───────────────────────────────────────────────

export interface VerifiedSiweSession {
  address: string;
  chainId: number;
  uri: string;
  expirationTime: string;
  nonce: string;
}

/**
 * Verify a SIWE signature locally, without consulting the login nonce store.
 * An expired signature is checked at its last valid instant so callers can
 * distinguish a valid expired session from a forged signature.
 */
export async function verifySiweSession(
  message: string,
  signature: string,
): Promise<VerifiedSiweSession> {
  const parsed = new SiweMessage(message);
  const expiry = Date.parse(parsed.expirationTime ?? "");
  const time = Number.isFinite(expiry) && expiry <= Date.now()
    ? new Date(expiry - 1).toISOString() : undefined;
  const result = await parsed.verify({ signature, ...(time ? { time } : {}) });
  if (!result.success) throw new Error("SIWE signature verification failed");
  if (!result.data.expirationTime) throw new Error("SIWE session has no expiration");
  return {
    address: result.data.address,
    chainId: result.data.chainId,
    uri: result.data.uri,
    expirationTime: result.data.expirationTime,
    nonce: result.data.nonce,
  };
}

/**
 * Verify a login SIWE. Returns the signed address, nonce and optional
 * expiration time.
 */
export async function verifySIWE(
  message: string,
  signature: string,
): Promise<{ address: string; nonce: string; expirationTime?: string }> {
  const { address, nonce, expirationTime } = await verifySiweSession(message, signature);
  if (Date.parse(expirationTime) <= Date.now()) throw new Error("SIWE session expired");
  return { address, nonce, expirationTime };
}

// ── Session Token ───────────────────────────────────────────────────

/**
 * Issue a session JWT signed with HS256. Subject is the wallet address.
 * A new token lasts at most 30 days, and never beyond the signed SIWE expiry.
 */
export async function issueSessionToken(
  address: string,
  privateKey: string,
  options?: { notAfter?: Date },
): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  let exp = now + SESSION_EXPIRATION_MS / 1000;
  if (options?.notAfter) {
    const notAfter = options.notAfter.getTime();
    if (!Number.isFinite(notAfter)) throw new Error("Invalid session expiration");
    exp = Math.min(exp, Math.floor(notAfter / 1000));
  }
  const expiresIn = exp - now;
  if (expiresIn <= 0) throw new Error("Session expiration must be in the future");

  const secret = new TextEncoder().encode(privateKey);
  const token = await new SignJWT({ address: address.toLowerCase() })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(address.toLowerCase())
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secret);

  return { token, expiresIn };
}

/**
 * Verify a session JWT issued by this backend.
 * Returns the wallet address from the token.
 */
export async function verifySessionToken(
  token: string,
  privateKey: string,
): Promise<{ address: string }> {
  const secret = new TextEncoder().encode(privateKey);

  const { payload } = await jwtVerify(token, secret, {
    algorithms: ["HS256"],
  });

  if (!payload.sub) {
    throw new Error("Session token missing 'sub' claim");
  }

  return { address: payload.sub };
}
