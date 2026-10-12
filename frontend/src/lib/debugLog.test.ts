import { expect, test } from "bun:test";
import { debugErrorChain } from "./debugLog";

test("debug error chains retain each cause but redact URLs and credentials", () => {
  const cause = Object.assign(new TypeError("Fetch API cannot load https://tee.node.tinycloud.xyz/kv?token=private due to access control checks."),
    { code: "NETWORK_ERROR" });
  const error = Object.assign(new Error("upload failed; authorization: Bearer abc123", { cause }), { code: "UPLOAD_FAILED" });
  const chain = debugErrorChain(error);
  expect(chain).toHaveLength(2);
  expect(chain.map((part) => part.code)).toEqual(["UPLOAD_FAILED", "NETWORK_ERROR"]);
  expect(JSON.stringify(chain)).not.toContain("private");
  expect(JSON.stringify(chain)).not.toContain("abc123");
  expect(JSON.stringify(chain)).not.toContain("tee.node.tinycloud.xyz");
  expect(debugErrorChain(new Error('session {"d":"ed25519-private"}'))[0]?.message).not.toContain("ed25519-private");
});
