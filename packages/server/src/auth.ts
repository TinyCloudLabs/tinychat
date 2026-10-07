import { randomBytes } from "crypto";
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

/**
 * Verify a SIWE message and signature using the `siwe` package.
 * Returns the signed address, nonce and optional expiration time.
 */
export async function verifySIWE(
  message: string,
  signature: string,
): Promise<{ address: string; nonce: string; expirationTime?: string }> {
  // Dynamic import to avoid requiring siwe at module load time
  const { SiweMessage } = await import("siwe");

  const siweMessage = new SiweMessage(message);
  const result = await siweMessage.verify({ signature });

  if (!result.success) {
    throw new Error("SIWE signature verification failed");
  }

  return {
    address: result.data.address,
    nonce: result.data.nonce,
    expirationTime: result.data.expirationTime,
  };
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
