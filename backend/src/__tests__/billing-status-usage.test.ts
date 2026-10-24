import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { LedgerRehydrator } from "../billing/ledger-rehydrate.js";
import { createBillingRouter } from "../routes/billing.js";

// GET /api/billing/status must report the same usage the admission gate enforces: the ledger's committed
// credits when the ledger is authoritative, the local counter otherwise.

const ORIGINAL_ENV = { ...process.env };
const ADDR = "0x5ca1ab1e00000000000000000000000000000001";

function authStub(req: Request, _res: Response, next: NextFunction) {
  req.user = { address: ADDR };
  next();
}

function createAppWithRehydrator(rehydrator: LedgerRehydrator | undefined) {
  const app = express();
  app.use("/api/billing", createBillingRouter({ authMiddleware: authStub, rehydrator }));
  return app;
}

function makeRehydrator(entitlement: {
  committed_credits: number | null;
  credit_limit: number | null;
  isOutage: boolean;
}): LedgerRehydrator {
  return {
    rehydrateIfNeeded: async () => false,
    getEntitlement: async () => ({ ...entitlement, period_anchor: "utc_day" }),
    get unrehydratedServesCount() {
      return 0;
    },
  } as unknown as LedgerRehydrator;
}

async function fetchStatusUsage(app: express.Express): Promise<{ used: number; limit: number }> {
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${port}/api/billing/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: { used: number; limit: number } };
    return { used: body.usage.used, limit: body.usage.limit };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

beforeEach(() => {
  process.env.PAYWALL_ENABLED = "false";
  delete process.env.LEDGER_AUTHORITATIVE;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/billing/status usage authority", () => {
  test("shows the ledger's committed credits when the ledger is authoritative", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    const rehydrator = makeRehydrator({ committed_credits: 700, credit_limit: 1000, isOutage: false });
    const usage = await fetchStatusUsage(createAppWithRehydrator(rehydrator));
    expect(usage.used).toBe(700);
    expect(usage.limit).toBe(1000);
  });

  test("shows the local counter when the ledger is not authoritative", async () => {
    const rehydrator = makeRehydrator({ committed_credits: 700, credit_limit: 1000, isOutage: false });
    const usage = await fetchStatusUsage(createAppWithRehydrator(rehydrator));
    expect(usage.used).toBe(0);
  });

  test("shows the local counter when the ledger reports an outage", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    const rehydrator = makeRehydrator({ committed_credits: null, credit_limit: null, isOutage: true });
    const usage = await fetchStatusUsage(createAppWithRehydrator(rehydrator));
    expect(usage.used).toBe(0);
  });

  test("shows the local counter when no ledger is configured", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    const usage = await fetchStatusUsage(createAppWithRehydrator(undefined));
    expect(usage.used).toBe(0);
  });
});
