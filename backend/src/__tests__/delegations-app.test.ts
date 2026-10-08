import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { createApiBodyParser } from "../body-parsing.js";
import { applyRateLimiters, DELEGATION_LIMIT } from "../rate-limits.js";
import { createDelegationRouter } from "../routes/delegations.js";

const ADDRESS = "0x7d033300000000000000000000000000000073f2";

async function withServer<T>(app: express.Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0);
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closing = once(server, "close");
    server.close();
    await closing;
  }
}

function appWithEligibility(eligibility: (address: string) => boolean) {
  const app = express();
  const bodiesBeforeCsrf: unknown[] = [];
  const calls = { verify: 0, activate: 0, store: 0, load: 0 };
  const node = {
    computeDelegationCid: () => { calls.verify++; throw new Error("verification must not run"); },
    useDelegation: async () => { calls.activate++; throw new Error("activation must not run"); },
  } as unknown as TinyCloudNode;
  // Production ordering: global parser, CSRF, IP limiter, then authenticated router.
  app.use(createApiBodyParser());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    bodiesBeforeCsrf.push(req.body);
    next();
  });
  app.use(createCsrfMiddleware());
  applyRateLimiters(app);
  app.use("/api/delegations", createDelegationRouter({
    backendDid: `did:pkh:eip155:1:${ADDRESS}`,
    configuredHost: "https://node.tinycloud.xyz",
    eligibility,
    store: {
      load: async () => { calls.load++; return null; },
      store: async () => { calls.store++; },
      remove: async () => {},
    },
    cache: { get: () => null, set: () => {}, evict: () => {} },
    node,
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      req.user = { address: ADDRESS };
      next();
    },
  }));
  return { app, bodiesBeforeCsrf, calls };
}

describe("delegation app parser ordering", () => {
  for (const { name, eligibility, status, error } of [
    { name: "feature flag disabled", eligibility: (_address: string) => false, status: 403, error: "delivery_disabled" },
    { name: "address excluded from the enabled cohort", eligibility: (address: string) => address === "0x0000000000000000000000000000000000000001", status: 403, error: "delivery_disabled" },
    { name: "eligible address", eligibility: (address: string) => address === ADDRESS, status: 400, error: "invalid_body" },
  ]) {
    it(`${name}: eligibility precedes the route-local malformed JSON parser`, async () => {
      const fixture = appWithEligibility(eligibility);
      await withServer(fixture.app, async (base) => {
        const response = await fetch(`${base}/api/delegations`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
          body: '{"serialized":',
        });
        expect(response.status).toBe(status);
        expect((await response.json()).error).toBe(error);
      });
      // The global parser would have rejected malformed JSON before even reaching this spy.
      expect(fixture.bodiesBeforeCsrf).toEqual([undefined]);
      expect(fixture.calls).toEqual({ verify: 0, activate: 0, store: 0, load: 0 });
    });
  }

  it("CSRF rejects the POST before authentication, parsing or storage", async () => {
    const fixture = appWithEligibility(() => true);
    await withServer(fixture.app, async (base) => {
      const response = await fetch(`${base}/api/delegations`, {
        method: "POST", headers: { "content-type": "application/json" }, body: '{"serialized":',
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("csrf_rejected");
    });
    expect(fixture.bodiesBeforeCsrf).toEqual([undefined]);
    expect(fixture.calls).toEqual({ verify: 0, activate: 0, store: 0, load: 0 });
  });

  it("the app's dedicated IP limiter rejects an exhausted bucket before the route-local parser", async () => {
    const fixture = appWithEligibility(() => false);
    await withServer(fixture.app, async (base) => {
      for (let attempt = 0; attempt < DELEGATION_LIMIT; attempt++) {
        const response = await fetch(`${base}/api/delegations/status`);
        expect(response.status).toBe(200);
      }
      const response = await fetch(`${base}/api/delegations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
        body: '{"serialized":',
      });
      expect(response.status).toBe(429);
    });
    expect(fixture.bodiesBeforeCsrf).toHaveLength(DELEGATION_LIMIT + 1);
    expect(fixture.bodiesBeforeCsrf.at(-1)).toBeUndefined();
    expect(fixture.calls).toEqual({ verify: 0, activate: 0, store: 0, load: DELEGATION_LIMIT });
  });
});
