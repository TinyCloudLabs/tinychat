import { describe, expect, it } from "bun:test";
import { nodeRevocationCode } from "../portable-delegation.js";

// What tinycloud-node v1.26.16 answers (docs/policy-root-revocation.md; routes/tests/revocation_codes.rs): a 401
// caused by a revocation has the JSON body {"code": "delegation_revoked" | "parent_revoked" | "ancestor_revoked",
// "error": …}; every other refusal is plain text with no `code`. The SDK's service errors keep the body in the
// message as `<operation> failed: <status> - <body>`. Only the whole body, with `code` at the top level, counts.
describe("nodeRevocationCode", () => {
  it("reads each of the node's three revocation codes from the bare body and from an SDK message that embeds it", () => {
    for (const code of ["delegation_revoked", "parent_revoked", "ancestor_revoked"]) {
      const body = JSON.stringify({ code, error: "delegation-revoked: bafy" });
      expect(nodeRevocationCode(body)).toBe(code);
      expect(nodeRevocationCode(` ${body}\n`)).toBe(code);
      expect(nodeRevocationCode(`SQL execute failed: 401 - ${body}`)).toBe(code);
      expect(nodeRevocationCode(`Failed to put key "k": 401 - ${body}`)).toBe(code);
    }
  });

  it("reads nothing from a node fault, other JSON, a mention of a code in text, or a malformed body", () => {
    for (const text of [
      "",
      "Child delegation expiry exceeds parent expiry",
      "SQL execute failed: 401 - Child delegation expiry exceeds parent expiry",
      '{"code":"something_else","error":"x"}',
      '{"error":"delegation_revoked"}',
      '{"code":["delegation_revoked"]}',
      '{"Code":"delegation_revoked"}',
      '{"code":"DELEGATION_REVOKED"}',
      '{"code":"delegation_revoked "}',
      "delegation_revoked",
      "the node said code delegation_revoked for this grant",
      '{"code":"delegation_revoked"',
    ]) expect(nodeRevocationCode(text)).toBeUndefined();
  });

  it("reads nothing when the code is nested, in an array, or embedded in other text such as an error page", () => {
    const flat = '{"code":"delegation_revoked"}';
    for (const text of [
      `{"detail":${flat}}`,
      `[${flat}]`,
      `{"error":"x","cause":${flat}}`,
      `<html><body>502 Bad Gateway ${flat}</body></html>`,
      `upstream said ${flat}`,
      `${flat} trailing text`,
      `${flat}${flat}`,
      `SQL execute failed: 401 - {"detail":${flat}}`,
      `SQL execute failed: 401 - upstream said ${flat}`,
      `SQL execute failed: 401 - ${flat} trailing text`,
      // A caller-influenced key that imitates the SDK prefix must not let a following object count.
      `Failed to put key "x: 401 - ${flat}": 401 - plain text`,
      `Failed to put key "{": 401 - ${flat}`,
    ]) expect({ text, code: nodeRevocationCode(text) }).toEqual({ text, code: undefined });
  });
});
