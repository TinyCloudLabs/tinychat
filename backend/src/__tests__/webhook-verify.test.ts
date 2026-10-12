import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  PTX_SIGNATURE_HEADER,
  SIGNATURE_HEADER,
  SIGNATURE_PATTERN,
  isWellFormedSignatureHeader,
  verifyHmacSha256Signature,
} from "../services/webhook-verify.js";
const SECRET = "0Jd8mZ0yq4dV0mA3rH1kQ6c2sT9xW5nP7bL4eR8uY1o";
const BODY = Buffer.from(JSON.stringify({ meeting_id: "01J8ZK", event: "meeting.transcribed" }));

function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyHmacSha256Signature", () => {
  test("accepts a correct sha256 signature for either provider", () => {
    expect(verifyHmacSha256Signature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  test("provider header names remain distinct", () => {
    expect(SIGNATURE_HEADER).toBe("x-hub-signature");
    expect(PTX_SIGNATURE_HEADER).toBe("x-webhook-signature");
  });

  test("rejects a signature made with a different secret", () => {
    expect(verifyHmacSha256Signature(BODY, sign(BODY, "another-secret"), SECRET)).toBe(false);
  });

  test("rejects a signature over a different body", () => {
    const other = Buffer.from(JSON.stringify({ meeting_id: "01J8ZZ" }));
    expect(verifyHmacSha256Signature(BODY, sign(other, SECRET), SECRET)).toBe(false);
  });

  test("sha256 only — no sha1 fallback, no bare hex, no algorithm negotiation", () => {
    const digest = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyHmacSha256Signature(BODY, `sha1=${digest}`, SECRET)).toBe(false);
    expect(verifyHmacSha256Signature(BODY, digest, SECRET)).toBe(false);
    expect(verifyHmacSha256Signature(BODY, `SHA256=${digest}`, SECRET)).toBe(false);
    expect(verifyHmacSha256Signature(BODY, `sha256=${digest.toUpperCase()}`, SECRET)).toBe(false);
  });

  test("rejects wrong-length hex without throwing", () => {
    const digest = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyHmacSha256Signature(BODY, `sha256=${digest.slice(0, 63)}`, SECRET)).toBe(false);
    expect(verifyHmacSha256Signature(BODY, `sha256=${digest}a`, SECRET)).toBe(false);
    expect(verifyHmacSha256Signature(BODY, "sha256=", SECRET)).toBe(false);
  });

  test("rejects non-hex characters in the digest", () => {
    expect(verifyHmacSha256Signature(BODY, `sha256=${"z".repeat(64)}`, SECRET)).toBe(false);
  });

  // THE regression this file exists for (§4.2). listen compares STRING lengths and then
  // timingSafeEqual compares BYTES; a latin1 header char >= 0x80 is one JS char and two
  // utf8 bytes, so listen's pre-check passes and timingSafeEqual throws RangeError on a
  // PUBLIC route — a 500 that is both a live-token oracle and our retry signal.
  test("non-ASCII header returns false, never a RangeError", () => {
    const hostile = "sha256=" + "Ã" + "a".repeat(63);
    const valid = sign(BODY, SECRET);

    // The trap is live: the hostile header has the same STRING length as a valid one...
    expect(hostile.length).toBe(valid.length);
    // ...and a different BYTE length, which is what would throw.
    expect(Buffer.byteLength(hostile, "utf8")).not.toBe(Buffer.byteLength(valid, "utf8"));

    expect(() => verifyHmacSha256Signature(BODY, hostile, SECRET)).not.toThrow();
    expect(verifyHmacSha256Signature(BODY, hostile, SECRET)).toBe(false);
  });

  test("shape check runs before any buffer work, for every non-ASCII byte", () => {
    for (const char of ["Ã", "ÿ", "", "é"]) {
      const header = "sha256=" + char + "a".repeat(63);
      expect(() => verifyHmacSha256Signature(BODY, header, SECRET)).not.toThrow();
      expect(verifyHmacSha256Signature(BODY, header, SECRET)).toBe(false);
    }
  });

  test("rejects missing, repeated and non-string headers", () => {
    expect(verifyHmacSha256Signature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyHmacSha256Signature(BODY, [sign(BODY, SECRET), "x"], SECRET)).toBe(false);
    expect(verifyHmacSha256Signature(BODY, "", SECRET)).toBe(false);
  });

  test("rejects an empty secret rather than deriving one", () => {
    expect(verifyHmacSha256Signature(BODY, sign(BODY, ""), "")).toBe(false);
  });

  test("a non-Buffer body is a rejection, not a throw (§4.3 coercion discipline)", () => {
    const notABuffer = {} as unknown as Buffer;
    expect(() => verifyHmacSha256Signature(notABuffer, sign(BODY, SECRET), SECRET)).not.toThrow();
    expect(verifyHmacSha256Signature(notABuffer, sign(BODY, SECRET), SECRET)).toBe(false);
  });

  test("an empty body verifies only against its own signature", () => {
    const empty = Buffer.alloc(0);
    expect(verifyHmacSha256Signature(empty, sign(empty, SECRET), SECRET)).toBe(true);
    expect(verifyHmacSha256Signature(empty, sign(BODY, SECRET), SECRET)).toBe(false);
  });

  test("a one-character digest difference is rejected", () => {
    const valid = sign(BODY, SECRET);
    const flipped = valid.slice(0, -1) + (valid.endsWith("a") ? "b" : "a");
    expect(verifyHmacSha256Signature(BODY, flipped, SECRET)).toBe(false);
  });
});

describe("isWellFormedSignatureHeader", () => {
  test("pins the shape to lowercase sha256 hex", () => {
    expect(SIGNATURE_PATTERN.source).toBe("^sha256=[0-9a-f]{64}$");
    expect(isWellFormedSignatureHeader(`sha256=${"a".repeat(64)}`)).toBe(true);
    expect(isWellFormedSignatureHeader(`sha256=${"A".repeat(64)}`)).toBe(false);
    expect(isWellFormedSignatureHeader("sha256=" + "Ã" + "a".repeat(63))).toBe(false);
    expect(isWellFormedSignatureHeader(undefined)).toBe(false);
    expect(isWellFormedSignatureHeader(12345)).toBe(false);
  });
});
