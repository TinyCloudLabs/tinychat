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
import { issueSessionToken } from "@tinyboilerplate/server";
import { applyRateLimiters, GLOBAL_LIMIT, PAID_CHAT_LIMIT, SESSION_LIMITS } from "../rate-limits.js";
import { createChatRouter } from "../routes/chat.js";

const SESSION_KEY = "synthetic-session-signing-key";

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
  const { paidChatLimiter } = applyRateLimiters(app, { sessionKey: SESSION_KEY });
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

const post = async (base: string, path: string, authorization?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  const r = await realFetch(`${base}${path}`, { method: "POST", headers, body: BODY });
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

  test("a signed-in session has its own paid bucket, denied at its limit + 1 on every alias before upstream", async () => {
    const alice = `Bearer ${(await issueSessionToken("0x00000000000000000000000000000000000a11ce", SESSION_KEY)).token}`;
    const bob = `Bearer ${(await issueSessionToken("0x0000000000000000000000000000000000000b0b", SESSION_KEY)).token}`;
    await withServer(productionApp(), async (base) => {
      for (let i = 0; i < SESSION_LIMITS.paidChat; i++) {
        expect((await post(base, PAID_ALIASES[i % PAID_ALIASES.length]!, alice)).status).toBe(200);
      }
      expect(upstreamCalls).toBe(SESSION_LIMITS.paidChat);
      for (const path of [...PAID_ALIASES, "/api/chat-alias"]) {
        expect([path, (await post(base, path, alice)).status]).toEqual([path, 429]);
      }
      expect(upstreamCalls).toBe(SESSION_LIMITS.paidChat);
      // Another session and the anonymous bucket are untouched.
      const other = await post(base, "/api/chat//", bob);
      expect(rateLimitHeader(other)).toEqual({ limit: SESSION_LIMITS.paidChat, remaining: SESSION_LIMITS.paidChat - 1 });
      const anonymous = await post(base, "/api/chat");
      expect(rateLimitHeader(anonymous)).toEqual({ limit: PAID_CHAT_LIMIT, remaining: PAID_CHAT_LIMIT - 1 });
    });
  });

  test("many sessions together stop at the 600 aggregate, before upstream; a session over its own limit spends none of it", async () => {
    const session = async (i: number) =>
      `Bearer ${(await issueSessionToken(`0x${(i + 1).toString(16).padStart(40, "0")}`, SESSION_KEY)).token}`;
    await withServer(productionApp(), async (base) => {
      // One session sends its 120, then 10 more that its own bucket denies.
      const first = await session(0);
      for (let i = 0; i < SESSION_LIMITS.paidChat + 10; i++) await post(base, "/api/chat", first);
      expect(upstreamCalls).toBe(SESSION_LIMITS.paidChat);
      // Fresh wallets fill the rest of the aggregate, each under its own limit.
      let sent = SESSION_LIMITS.paidChat;
      for (let i = 1; sent < PAID_CHAT_LIMIT; i++) {
        const bearer = await session(i);
        for (let j = 0; j < 100 && sent < PAID_CHAT_LIMIT; j++, sent++) {
          expect((await post(base, PAID_ALIASES[j % PAID_ALIASES.length]!, bearer)).status).toBe(200);
        }
      }
      expect(upstreamCalls).toBe(PAID_CHAT_LIMIT);
      // A brand-new session, on any alias, is now denied before upstream.
      const fresh = await session(999);
      for (const path of ["/api/chat", "/api/chat//", "/api/agent//chat", "/api/chat-alias"]) {
        expect([path, (await post(base, path, fresh)).status]).toEqual([path, 429]);
      }
      expect(upstreamCalls).toBe(PAID_CHAT_LIMIT);
    });
  });
});
