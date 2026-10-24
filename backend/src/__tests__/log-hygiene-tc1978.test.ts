import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { createApiBodyParser } from "../body-parsing.js";
import { applyRateLimiters } from "../rate-limits.js";
import { logCreditGateDeny } from "../billing/ledger-gate.js";
import { LedgerRehydrator } from "../billing/ledger-rehydrate.js";
import { TIERS } from "../billing/tiers.js";
import { createDelegationRouter } from "../routes/delegations.js";
import { CalendarAutojoinConnection } from "../services/calendar-autojoin-connection.js";
import { MemoryCalendarAutojoinStore, TenantCoordinator } from "../services/calendar-autojoin-store.js";
import { CredentialStore, InMemoryCredentialRowStore } from "../services/credential-store.js";

// TC-1978 log hygiene: call sites that used to print an address or an error message must not, whatever fails.
// Never touch a real home: HOME points at a throwaway directory for the whole file.
const scratch = mkdtempSync("/var/tmp/tc1978.");
process.env.HOME = scratch;
process.env.BUN_INSTALL_CACHE_DIR = join(scratch, "cache");
if (!process.env.HOME.startsWith("/var/tmp/tc1978.")) throw new Error("refusing to run against a real HOME");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const CANARY = "TC1978_CANARY_MESSAGE";
const lines: string[] = [];
let spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  lines.length = 0;
  const capture = (...args: unknown[]) => { lines.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}` : String(arg))).join(" ")); };
  spies = [spyOn(console, "log").mockImplementation(capture), spyOn(console, "warn").mockImplementation(capture), spyOn(console, "error").mockImplementation(capture)];
});
afterEach(() => { for (const spy of spies) spy.mockRestore(); });

describe("ledger logs carry no address and no upstream error text", () => {
  test("credit gate denial", () => {
    logCreditGateDeny({ source: "ledger", address: ADDRESS, committed: 10, limit: 20, windowKind: "week" });
    expect(lines).toEqual(["[credit-gate] source=ledger committed=10 limit=20 window_kind=week"]);
  });

  test("rehydration failure, k-degrade and entitlement failure", async () => {
    const original = globalThis.fetch;
    // Network errors from fetch carry the request URL, and the entitlement URL carries the address.
    globalThis.fetch = (async () => { throw new Error(`connect failed https://ledger.example.test/api/credit-entitlement/${ADDRESS} ${CANARY}`); }) as unknown as typeof fetch;
    try {
      const rehydrator = new LedgerRehydrator("https://ledger.example.test", "synthetic-secret");
      await rehydrator.rehydrateIfNeeded(ADDRESS, TIERS.free, null);
      await rehydrator.getEntitlement(ADDRESS, TIERS.free, null);
      globalThis.fetch = (async () => new Response(JSON.stringify({ account: ADDRESS, credit_limit: 5, period_anchor: "x", window_start: 1, committed_credits: null }))) as unknown as typeof fetch;
      await rehydrator.getEntitlement(ADDRESS, TIERS.free, null);
    } finally {
      globalThis.fetch = original;
    }
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line).not.toContain(ADDRESS);
      expect(line).not.toContain(CANARY);
      expect(line).not.toContain("ledger.example.test");
    }
    expect(lines.some((line) => line.startsWith("[ledger-rehydrate] failed to rehydrate:"))).toBe(true);
    expect(lines.some((line) => line.startsWith("[ledger-rehydrate] getEntitlement failed:"))).toBe(true);
    expect(lines.some((line) => /^\[ledger-rehydrate\] source=outage_policy null_committed_credits window_start=\d+$/.test(line))).toBe(true);
  });
});

describe("owner Exo teardown failures log a fixed code and no message", () => {
  test("DELETE /api/delegations", async () => {
    const app = express();
    app.use(createApiBodyParser());
    app.use(createCsrfMiddleware());
    applyRateLimiters(app, { sessionKey: "synthetic-session-signing-key" });
    app.use("/api/delegations", createDelegationRouter({
      backendDid: `did:pkh:eip155:1:${ADDRESS}`,
      configuredHost: "https://node.tinycloud.xyz",
      eligibility: () => true,
      store: { load: async () => null, store: async () => {}, remove: async () => {} },
      cache: { get: () => null, set: () => {}, evict: () => {} },
      node: { computeDelegationCid: () => { throw new Error("unused"); } } as unknown as TinyCloudNode,
      authMiddleware: (req: Request, _res: Response, next: NextFunction) => { req.user = { address: ADDRESS }; next(); },
      teardownExoOwner: async () => { throw new Error(`${CANARY} ${ADDRESS}`); },
    }));
    const server: Server = app.listen(0);
    await once(server, "listening");
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/delegations`, { method: "DELETE", headers: { "x-requested-with": "XMLHttpRequest" } });
      expect(response.status).toBe(200);
    } finally {
      const closing = once(server, "close");
      server.close();
      await closing;
    }
    expect(lines).toEqual(["[delegations] code=exo_teardown outcome=failed"]);
  });

  test("calendar auto-join disconnect", async () => {
    const now = 1_800_000_000_000;
    const credentials = new CredentialStore(new InMemoryCredentialRowStore(), { master: () => "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=", previousMaster: () => null, now: () => now });
    const connection = new CalendarAutojoinConnection({
      store: new MemoryCalendarAutojoinStore(),
      credentials,
      oauth: { authorizeUrl: () => "", exchangeCode: async () => { throw new Error("unused"); }, refresh: async () => { throw new Error("unused"); }, revoke: async () => {} },
      coordinator: new TenantCoordinator(),
      calendar: { probePrimary: async () => {} },
      now: () => now,
      teardownExoOwner: async () => { throw new Error(`${CANARY} ${ADDRESS}`); },
    });
    expect((await connection.disconnect(ADDRESS)).status).toBe("disconnected");
    expect(lines).toContain("[calendar-autojoin] code=exo_teardown outcome=failed");
    for (const line of lines) {
      expect(line).not.toContain(CANARY);
      expect(line).not.toContain(ADDRESS);
    }
  });
});
