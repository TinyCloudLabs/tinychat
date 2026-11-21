import { describe, expect, it } from "bun:test";
import { nodeRevocationCode } from "../portable-delegation.js";

// What tinycloud-node v1.26.16 answers (docs/policy-root-revocation.md; routes/tests/revocation_codes.rs): a 401 caused by a
// revocation has the JSON body {"code": "delegation_revoked" | "parent_revoked" | "ancestor_revoked", "error": …};
// every other refusal is plain text with no `code`. The SDK's service errors keep the body in the message as
// `<operation> failed: <status> - <body>`.
describe("nodeRevocationCode", () => {
  it("reads each of the node's three revocation codes from the bare body and from an SDK message that embeds it", () => {
    for (const code of ["delegation_revoked", "parent_revoked", "ancestor_revoked"]) {
      const body = JSON.stringify({ code, error: "delegation-revoked: bafy" });
      expect(nodeRevocationCode(body)).toBe(code);
      expect(nodeRevocationCode(`SQL execute failed: 401 - ${body}`)).toBe(code);
      expect(nodeRevocationCode(`Failed to put key: 401 - ${body}`)).toBe(code);
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
      "delegation_revoked",
      "the node said code delegation_revoked for this grant",
      '{"code":"delegation_revoked"',
    ]) expect(nodeRevocationCode(text)).toBeUndefined();
  });
});
