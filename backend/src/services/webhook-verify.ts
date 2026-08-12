import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC verification for inbound connector webhook deliveries (§4.2).
 *
 * Mined from `listen/backend/src/services/webhook-verify.ts` — MINED, NOT COPIED.
 * listen's length pre-check (`webhook-verify.ts:21`) compares JS STRING lengths and then
 * hands the values to `timingSafeEqual`, which compares BYTES. Node decodes HTTP header
 * values as latin1, so a header byte >= 0x80 is one JS char but two utf8 bytes:
 * `"sha256=" + "Ã" + "a".repeat(63)` has the same string length as a valid header and a
 * different byte length, so listen's pre-check passes and `timingSafeEqual` throws
 * `RangeError: Input buffers must have the same byte length` — inside an unauthenticated
 * public handler, where a 500 is both a live-token oracle and (per §4.6) our retry signal.
 *
 * The fix, in order: shape-check the header BEFORE any buffer work, then compare BYTE
 * lengths, then `timingSafeEqual`.
 */

/** The header Fireflies signs with. */
export const SIGNATURE_HEADER = "x-hub-signature";

/**
 * sha256 only — no algorithm negotiation, no `sha1=` fallback, ever (§4.2/§9.6).
 * Lowercase hex only: `createHmac(...).digest("hex")` is lowercase, so an uppercase-hex
 * header is a header we did not produce.
 */
export const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;

/** Shape-check a raw header value before any buffer work touches it. */
export function isWellFormedSignatureHeader(header: unknown): header is string {
  return typeof header === "string" && SIGNATURE_PATTERN.test(header);
}

/**
 * Verify an `x-hub-signature` header against the raw request body.
 *
 * Never throws: every rejection path returns `false` so the caller can answer the generic
 * 401 (§4.6) rather than surfacing a 500 that doubles as an oracle.
 */
export function verifyFirefliesSignature(
  rawBody: Buffer,
  signatureHeader: string | string[] | undefined,
  secret: string,
): boolean {
  // A repeated header arrives as string[]; anything but a single well-formed string is a
  // rejection, decided before a Buffer is allocated.
  if (!isWellFormedSignatureHeader(signatureHeader)) return false;
  if (typeof secret !== "string" || secret.length === 0) return false;
  // §4.3 coerces a missing/wrong-content-type body to an empty Buffer; an empty body never
  // verifies against a real delivery, so anything non-Buffer is a 401, not a throw.
  if (!Buffer.isBuffer(rawBody)) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  // Defensive byte-length compare. The shape check above already pins the header at 71
  // ASCII bytes, which is exactly what `expected` is — this is the belt that keeps a future
  // loosening of the pattern from re-introducing listen's RangeError.
  const got = Buffer.from(signatureHeader, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length) return false;

  return timingSafeEqual(got, want);
}
