import { randomBytes } from "crypto";
import { SiweMessage } from "siwe";
import { SignJWT, jwtVerify } from "jose";

// ── Types ────────────────────────────────────────────────────────────

export interface NonceEntry {
  nonce: string;
  address: string;
  createdAt: number;
}

export interface NonceStore {
  generate(address: string): string;
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
 * - Bound to a specific address
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

  return {
    generate(address: string): string {
      const normalizedAddress = address.toLowerCase();
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
      const key = `${normalizedAddress}:${nonce}`;
      const entry = store.get(key);

      if (!entry) return false;

      // Delete immediately — single use
      store.delete(key);

      // Check TTL
      if (Date.now() - entry.createdAt > NONCE_TTL_MS) {
        return false;
      }

      return true;
    },
  };
}

// ── SIWE Verification ───────────────────────────────────────────────

export interface VerifiedSiweSession {
  address: string;
  chainId: number;
  uri: string;
  expirationTime?: string;
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
  return {
    address: result.data.address,
    chainId: result.data.chainId,
    uri: result.data.uri,
    expirationTime: result.data.expirationTime,
    nonce: result.data.nonce,
  };
}

export async function verifySIWE(
  message: string,
  signature: string,
): Promise<{ address: string; nonce: string }> {
  const { address, nonce, expirationTime } = await verifySiweSession(message, signature);
  if (expirationTime && Date.parse(expirationTime) <= Date.now()) throw new Error("SIWE session expired");
  return { address, nonce };
}

// ── Session Token ───────────────────────────────────────────────────

/**
 * Issue a session JWT signed with HS256.
 * Subject is the wallet address.
 */
export async function issueSessionToken(
  address: string,
  privateKey: string,
): Promise<{ token: string; expiresIn: number }> {
  const secret = new TextEncoder().encode(privateKey);
  const expiresIn = 24 * 60 * 60; // 24 hours in seconds

  const token = await new SignJWT({ address: address.toLowerCase() })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(address.toLowerCase())
    .setIssuedAt()
    .setExpirationTime("24h")
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
