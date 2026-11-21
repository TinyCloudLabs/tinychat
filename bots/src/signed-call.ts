// Signed calls between the backend and a bots service (TC-3325).
//
// This file is shared byte for byte: bots/src/signed-call.ts and backend/src/bots-signed-call.ts. It imports nothing
// but node:crypto so both copies build unchanged; backend/src/__tests__/bots-signed-call.test.ts checks that each
// side verifies what the other signs.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNED_SCHEME = "TinyCloud-Signed ";
/** How long a signed call is valid. */
export const CALL_LIFETIME_MS = 60_000;
/** How far apart the two clocks may be. */
export const CLOCK_SKEW_MS = 30_000;
const DOMAIN = "tinycloud-bots-call.v1.";
const MAX_TOKEN_CHARS = 4096;
const OWNER_DID = /^did:pkh:eip155:1:0x[0-9a-f]{40}$/;
const BOT_KEY = /^(main|[0-9a-f]{32})$/;
const NONCE = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Nonces held at once. Past it a call is refused rather than a nonce being forgotten before it expires. */
const MAX_NONCES = 100_000;

/** `to-service`: the backend calls a bots service. `to-backend`: a bots service calls the backend. */
export type Direction = "to-service" | "to-backend";
export type Environment = "private" | "regular";

export interface CallClaims {
  v: 1;
  dir: Direction;
  env: Environment;
  owner: string;
  bot: string;
  method: string;
  /** Path and query of the request URL, e.g. `/v1/bots/main/messages`. */
  path: string;
  /** sha256 hex of the body's bytes (of no bytes for a call without a body). */
  body: string;
  /** Milliseconds since the epoch. */
  exp: number;
  nonce: string;
}

export interface Call {
  direction: Direction;
  environment: Environment;
  owner: string;
  bot: string;
  method: string;
  path: string;
  /** Exactly the bytes sent; a string is hashed as UTF-8. */
  body?: Uint8Array | string;
}

export const bodyHash = (body: Uint8Array | string = "") => createHash("sha256").update(body).digest("hex");
const mac = (secret: string, payload: string) => createHmac("sha256", secret).update(DOMAIN + payload).digest();

/** `<base64url(claims JSON)>.<base64url(HMAC)>`. */
export function signClaims(secret: string, claims: CallClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

/** The `Authorization` header value for one call: valid for CALL_LIFETIME_MS, usable once. */
export function signedCallHeader(secret: string, call: Call, now = Date.now()): string {
  const claims: CallClaims = {
    v: 1, dir: call.direction, env: call.environment, owner: call.owner, bot: call.bot, method: call.method.toUpperCase(),
    path: call.path, body: bodyHash(call.body), exp: now + CALL_LIFETIME_MS, nonce: randomBytes(16).toString("hex"),
  };
  return SIGNED_SCHEME + signClaims(secret, claims);
}

/** Nonces seen and not yet expired; a second call with the same nonce is refused. One per verifier. */
export class NonceGuard {
  readonly #seen = new Map<string, number>();
  claim(nonce: string, until: number, now: number): boolean {
    // Calls arrive roughly in expiry order, so the oldest entries come first.
    for (const [seen, expiry] of this.#seen) {
      if (expiry >= now) break;
      this.#seen.delete(seen);
    }
    if (this.#seen.has(nonce) || this.#seen.size >= MAX_NONCES) return false;
    this.#seen.set(nonce, until);
    return true;
  }
}

function parseClaims(payload: string): CallClaims | undefined {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const c = value as Record<string, unknown>;
  if (c.v !== 1 || (c.dir !== "to-service" && c.dir !== "to-backend") || (c.env !== "private" && c.env !== "regular")
    || typeof c.owner !== "string" || !OWNER_DID.test(c.owner) || typeof c.bot !== "string" || !BOT_KEY.test(c.bot)
    || typeof c.method !== "string" || typeof c.path !== "string" || typeof c.body !== "string" || !HEX64.test(c.body)
    || typeof c.exp !== "number" || !Number.isSafeInteger(c.exp) || typeof c.nonce !== "string" || !NONCE.test(c.nonce)) return undefined;
  return c as unknown as CallClaims;
}

export interface VerifyOptions {
  secret: string;
  direction: Direction;
  environment: Environment;
  nonces: NonceGuard;
  now?: number;
}

/**
 * Checks one received call: the MAC (constant time), then the signed direction, environment, expiry, method, path and
 * body hash against what arrived, then the nonce. Returns the claims, whose `owner` and `bot` are the only ones to
 * trust, or null. The caller still checks that `bot` is the bot the request is about, and its own allowlist.
 */
export function verifyCall(
  authorization: string | null | undefined,
  request: { method: string; path: string; body?: Uint8Array | string },
  options: VerifyOptions,
): CallClaims | null {
  if (!authorization?.startsWith(SIGNED_SCHEME)) return null;
  const token = authorization.slice(SIGNED_SCHEME.length);
  if (token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const given = Buffer.from(parts[1]!, "base64url");
  const expected = mac(options.secret, parts[0]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = parseClaims(parts[0]!);
  if (!claims || claims.dir !== options.direction || claims.env !== options.environment) return null;
  const now = options.now ?? Date.now();
  if (claims.exp + CLOCK_SKEW_MS < now || claims.exp > now + CALL_LIFETIME_MS + CLOCK_SKEW_MS) return null;
  if (claims.method !== request.method.toUpperCase() || claims.path !== request.path || claims.body !== bodyHash(request.body)) return null;
  // Last, so a call refused for any other reason never uses up its nonce.
  if (!options.nonces.claim(claims.nonce, claims.exp + CLOCK_SKEW_MS, now)) return null;
  return claims;
}
