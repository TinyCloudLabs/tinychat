/**
 * Paid chat is charged where Express actually routes it (Astra on #378): `app.use("/api/chat",
 * router)` + `router.post("/")` also serves `/api/chat//`, and `/api/agent//chat` reaches the
 * `/chat` route under the `/api/agent` mount. A path-only classifier sent both to the global
 * bucket. These tests use the production mount shape and the real chat router.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache } from "../billing/stripe.js";
import { _resetUsage } from "../billing/usage.js";
import { createApiBodyParser } from "../body-parsing.js";
import { applyRateLimiters, GLOBAL_LIMIT, PAID_CHAT_LIMIT } from "../rate-limits.js";
import { createChatRouter } from "../routes/chat.js";

const ORIGINAL_ENV = { ...process.env };
const realFetch = globalThis.fetch;
const OFFERED_MODEL = "z-ai/glm-5.2";
const BODY = JSON.stringify({ model: OFFERED_MODEL, messages: [{ role: "user", content: "hi" }] });

function authStub(req: Request, _res: Response, next: NextFunction) {
  req.user = { address: "0xabc" };
  next();
}

function rateLimitHeader(r: Response | globalThis.Response): { limit: number; remaining: number } | null {
  const header = (r as globalThis.Response).headers.get("ratelimit");
  if (!header) return null;
  return {
    limit: Number(/limit=(\d+)/.exec(header)![1]),
    remaining: Number(/remaining=(\d+)/.exec(header)![1]),
  };
}

let upstreamCalls = 0;

beforeEach(() => {
  process.env.REDPILL_API_KEY = "sk-rp-test";
  delete process.env.PAYWALL_ENABLED;
  _resetCache();
  _resetUsage();
  _resetCatalogCache();
  _resetCreditsWarnings();
  upstreamCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.redpill.ai") && url.endsWith("/chat/completions")) {
      upstreamCalls++;
      return new globalThis.Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...ORIGINAL_ENV };
  _resetCache();
  _resetUsage();
  _resetCatalogCache();
  _resetCreditsWarnings();
});

/** index.ts's shape: parser → limiters → `app.use(prefix, auth, router)`. */
function productionApp() {
  const app = express();
  app.use(createApiBodyParser());
  const { paidChatLimiter } = applyRateLimiters(app);
  app.get("/api/manifest", (_req, res) => res.json({ ok: true }));
  app.use("/api/chat", authStub, createChatRouter({ paidLimiter: paidChatLimiter }));
  // The agent router's shape: router-level auth, then `POST /chat` behind the paid limiter.
  const agent = Router();
  agent.use(authStub);
  agent.post("/chat", paidChatLimiter, (_req, res) => {
    upstreamCalls++;
    res.json({ ok: true });
  });
  agent.post("/session", (_req, res) => res.json({ ok: true }));
  app.use("/api/agent", agent);
  // A mount the root classifier does not know: the handler-level limiter must still charge it.
  const unknown = Router();
  unknown.post("/", paidChatLimiter, (_req, res) => res.json({ ok: true }));
  app.use("/api/chat-alias", unknown);
  return app;
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = async (base: string, path: string) => {
  const r = await realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
  await r.text();
  return r;
};

const PAID_ALIASES = [
  "/api/chat",
  "/api/chat/",
  "/api/chat//",
  "/API/CHAT",
  "/Api/Chat//",
  "/api/agent/chat",
  "/api/agent//chat",
  "/api/agent/chat/",
  "/API/AGENT//CHAT",
];

describe("paid chat bucket at the production mounts", () => {
  test("every alias Express routes to a paid handler is charged once to the paid bucket", async () => {
    await withServer(productionApp(), async (base) => {
      let charged = 0;
      for (const path of PAID_ALIASES) {
        const r = await post(base, path);
        expect([path, r.status]).toEqual([path, 200]);
        charged++;
        expect([path, rateLimitHeader(r)]).toEqual([path, { limit: PAID_CHAT_LIMIT, remaining: PAID_CHAT_LIMIT - charged }]);
      }
      expect(upstreamCalls).toBe(PAID_ALIASES.length);
      // None of them was charged to the global bucket.
      const manifest = await realFetch(`${base}/api/manifest`);
      expect(rateLimitHeader(manifest)).toEqual({ limit: GLOBAL_LIMIT, remaining: GLOBAL_LIMIT - 1 });
      // A non-paid POST under the agent mount stays global.
      const session = await post(base, "/api/agent/session");
      expect(rateLimitHeader(session)?.limit).toBe(GLOBAL_LIMIT);
    });
  });

  test("after 600 sends every alias is denied before the upstream call", async () => {
    await withServer(productionApp(), async (base) => {
      for (let i = 0; i < PAID_CHAT_LIMIT; i++) {
        expect((await post(base, i % 2 === 0 ? "/api/chat" : "/api/agent/chat")).status).toBe(200);
      }
      expect(upstreamCalls).toBe(PAID_CHAT_LIMIT);
      for (const path of [...PAID_ALIASES, "/api/chat-alias"]) {
        expect([path, (await post(base, path)).status]).toEqual([path, 429]);
      }
      expect(upstreamCalls).toBe(PAID_CHAT_LIMIT);
    });
  });

  test("a mount the classifier misses is still charged at the handler, never to neither bucket", async () => {
    await withServer(productionApp(), async (base) => {
      const r = await post(base, "/api/chat-alias");
      expect(r.status).toBe(200);
      const chat = await post(base, "/api/chat");
      expect(rateLimitHeader(chat)).toEqual({ limit: PAID_CHAT_LIMIT, remaining: PAID_CHAT_LIMIT - 2 });
    });
  });
});
