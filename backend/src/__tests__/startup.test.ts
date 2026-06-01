import { describe, expect, it } from "bun:test";
import { TINYCHAT_BACKEND_KV_PREFIX, tinychatBackendIdentityConfig } from "../startup.js";

describe("tinychat backend startup config", () => {
  it("uses an app-specific backend-owned KV prefix for operational state", () => {
    expect(TINYCHAT_BACKEND_KV_PREFIX).toBe("ops.tinychat.backend");
    expect(TINYCHAT_BACKEND_KV_PREFIX).not.toContain("/");
    expect(TINYCHAT_BACKEND_KV_PREFIX).not.toBe("boilerplate-be");

    expect(
      tinychatBackendIdentityConfig({
        privateKey: "0xabc",
        host: "https://node.example",
      }),
    ).toEqual({
      privateKey: "0xabc",
      host: "https://node.example",
      prefix: TINYCHAT_BACKEND_KV_PREFIX,
    });
  });
});
