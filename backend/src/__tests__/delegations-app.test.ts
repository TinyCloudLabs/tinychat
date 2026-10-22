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

const SESSION_KEY = "synthetic-session-signing-key";

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
  applyRateLimiters(app, { sessionKey: SESSION_KEY });
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
    for (const path of ["/api/delegations", "/API/Delegations", "/aPi/DeLeGaTiOnS/", "/API/Delegations/?source=browser", "/api/delegations//", "/API/DELEGATIONS//", "/api/delegations//?source=browser", "//api/delegations", "/api/./delegations/"]) {
      it(`${name}: ${path} gates before malformed JSON parsing`, async () => {
        const fixture = appWithEligibility(eligibility);
        await withServer(fixture.app, async (base) => {
          const response = await fetch(`${base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
            body: '{"serialized":',
          });
          expect(response.status).toBe(status);
          expect((await response.json()).error).toBe(error);
        });
        expect(fixture.bodiesBeforeCsrf).toEqual([undefined]);
        expect(fixture.calls).toEqual({ verify: 0, activate: 0, store: 0, load: 0 });
      });
    }
  }

  // Express routes `/api/delegations//` to the POST handler (path-to-regexp's optional trailing
  // slash), so the global parser must skip it too; `///` is not routed but is not read either.
  it("leaves an unrouted repeated-slash POST unread while the flag is off", async () => {
    for (const path of ["/api/delegations///", "/API/Delegations////"]) {
      const fixture = appWithEligibility(() => false);
      await withServer(fixture.app, async (base) => {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
          body: '{"serialized":',
        });
        expect(response.status).toBe(404);
      });
      expect(fixture.bodiesBeforeCsrf).toEqual([undefined]);
      expect(fixture.calls).toEqual({ verify: 0, activate: 0, store: 0, load: 0 });
    }
  });

  it("the equivalent mixed-case POST retains the 96kb route limit", async () => {
    const fixture = appWithEligibility(() => true);
    await withServer(fixture.app, async (base) => {
      const response = await fetch(`${base}/API/Delegations/`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
        body: JSON.stringify({ serialized: "x".repeat(97 * 1024) }),
      });
      expect(response.status).toBe(413);
    });
    expect(fixture.bodiesBeforeCsrf).toEqual([undefined]);
    expect(fixture.calls).toEqual({ verify: 0, activate: 0, store: 0, load: 0 });
  });

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

const MIXED_ADDRESS = "0x7D033300000000000000000000000000000073F2";

function appForRevoke(teardown?: (address: string) => Promise<void>) {
  const app = express();
  const calls = { order: [] as string[], removed: [] as string[] };
  app.use(createApiBodyParser());
  app.use(createCsrfMiddleware());
  applyRateLimiters(app, { sessionKey: SESSION_KEY });
  app.use("/api/delegations", createDelegationRouter({
    backendDid: `did:pkh:eip155:1:${ADDRESS}`,
    configuredHost: "https://node.tinycloud.xyz",
    eligibility: () => true,
    store: {
      load: async () => null,
      store: async () => {},
      remove: async (address: string) => { calls.order.push("remove"); calls.removed.push(address); },
    },
    cache: { get: () => null, set: () => {}, evict: () => {} },
    node: {
      computeDelegationCid: () => { throw new Error("verification must not run on revoke"); },
      useDelegation: async () => { throw new Error("activation must not run on revoke"); },
    } as unknown as TinyCloudNode,
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      req.user = { address: MIXED_ADDRESS };
      next();
    },
    ...(teardown ? {
      teardownExoOwner: async (address: string) => {
        calls.order.push("teardown");
        await teardown(address);
      },
    } : {}),
  }));
  return { app, calls };
}

describe("delegation revoke clears owner Exo state", () => {
  it("removes the delegation first, then tears down owner Exo state, using the normalized address", async () => {
    const fixture = appForRevoke(async () => {});
    await withServer(fixture.app, async (base) => {
      const response = await fetch(`${base}/api/delegations`, {
        method: "DELETE", headers: { "x-requested-with": "XMLHttpRequest" },
      });
      expect(response.status).toBe(200);
    });
    expect(fixture.calls.order).toEqual(["remove", "teardown"]);
    expect(fixture.calls.removed).toEqual([ADDRESS]);
  });

  it("with the exo flag off (no teardown wired) removes the delegation and makes no exo call", async () => {
    const fixture = appForRevoke();
    await withServer(fixture.app, async (base) => {
      const response = await fetch(`${base}/api/delegations`, {
        method: "DELETE", headers: { "x-requested-with": "XMLHttpRequest" },
      });
      expect(response.status).toBe(200);
    });
    expect(fixture.calls.order).toEqual(["remove"]);
    expect(fixture.calls.removed).toEqual([ADDRESS]);
  });

  it("returns 200 and keeps the removal when owner Exo teardown fails", async () => {
    const fixture = appForRevoke(async () => { throw new Error("teardown failed"); });
    await withServer(fixture.app, async (base) => {
      const response = await fetch(`${base}/api/delegations`, {
        method: "DELETE", headers: { "x-requested-with": "XMLHttpRequest" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "none", expiresAt: null });
    });
    expect(fixture.calls.order).toEqual(["remove", "teardown"]);
    expect(fixture.calls.removed).toEqual([ADDRESS]);
  });
});
