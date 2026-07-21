import { describe, expect, it } from "bun:test";
import { validateLedgerStartupConfig } from "../index.js";
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

  it("rejects authoritative ledger mode without a service URL", () => {
    expect(
      validateLedgerStartupConfig({
        LEDGER_AUTHORITATIVE: "true",
        LEDGER_SERVICE_SECRET: "test-secret",
      }),
    ).toEqual({ ok: false, error: expect.stringContaining("LEDGER_SERVICE_URL") });
  });

  it("rejects authoritative ledger mode without a service secret", () => {
    expect(
      validateLedgerStartupConfig({
        LEDGER_AUTHORITATIVE: "true",
        LEDGER_SERVICE_URL: "https://ledger.example",
      }),
    ).toEqual({ ok: false, error: expect.stringContaining("LEDGER_SERVICE_SECRET") });
  });

  it("rejects an unrecognized ledger outage policy", () => {
    expect(validateLedgerStartupConfig({ LEDGER_OUTAGE_POLICY: "unexpected" })).toEqual({
      ok: false,
      error: expect.stringContaining("LEDGER_OUTAGE_POLICY"),
    });
  });

  it("allows ledger to remain unconfigured while the authoritative flag is unset", () => {
    expect(validateLedgerStartupConfig({})).toEqual({ ok: true });
  });
});
