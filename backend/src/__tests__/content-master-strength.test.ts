import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { assertNewContentMaster } from "../services/webhook-tokens.js";
import { bucketFor } from "../rate-limits.js";

test("new content masters require canonical encoding and reject repetitive byte material", () => {
  for (const key of ["word ".repeat(20), "repeatedword".repeat(10), "ab".repeat(32), Buffer.from("repeatedword".repeat(10)).toString("base64"), randomBytes(31).toString("hex")]) {
    expect(() => assertNewContentMaster(key)).toThrow("at least 32 random bytes");
  }
  const padded = randomBytes(32).toString("base64");
  expect(() => assertNewContentMaster(padded + "=")).toThrow();
  const twoPadding = randomBytes(34).toString("base64");
  expect(() => assertNewContentMaster(twoPadding.slice(0, -1))).toThrow();
  for (const encoding of ["hex", "base64", "base64url"] as const) {
    expect(() => assertNewContentMaster(randomBytes(32).toString(encoding))).not.toThrow();
  }
});

test("only the diagnostic route skips the shared global bucket", () => {
  expect(bucketFor("GET", "/api/ops/content-continuity")).toBe("credentialCount");
  expect(bucketFor("GET", "/api//ops/content-continuity")).toBe("global");
  expect(bucketFor("GET", "/api/ops/content-continuity/")).toBe("global");
  expect(bucketFor("GET", "/api/ops/content-continuity/child")).toBe("global");
  expect(bucketFor("GET", "/api/ops/content-continuity-lookalike")).toBe("global");
});
