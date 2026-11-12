// /api/bots — tiny bots slice 1 (TC-2808): the owner's Main bot, proxied to the bots service.
//
// The owner is always the authenticated session address; the body and request headers never choose it.
// The service secret stays server-side. Message content is neither logged nor stored here.

import { botsConnectFetch, validateBotsConnectHost } from "../bots-transport";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";

export interface BotsConfig {
  serviceUrl: string;
  serviceSecret: string;
  accountAllowed: (address: string) => boolean;
  /** Overall bound on one POST turn (BOTS_POST_TIMEOUT_MS, default 120000). */
  postTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

const MAX_TEXT = 8000;
const UNAVAILABLE = { code: "bot_unavailable", message: "Main isn't available. Try again later." };

/** Same canonical owner DID as MCP chat: did:pkh on chain 1 with the lowercased address. */
export function botOwnerDid(address: string): string {
  return `did:pkh:eip155:1:${address.toLowerCase()}`;
}

/**
 * Bots are off unless BOTS_ENABLED is exactly "true" AND BOTS_SERVICE_URL, BOTS_SERVICE_SECRET and a non-empty
 * BOTS_TEST_ACCOUNTS are set. The single entry `*` admits every account; an empty list admits nobody.
 */
export function botsFromEnv(env: Record<string, string | undefined>): BotsConfig | undefined {
  const connectHost = env.BOTS_SERVICE_CONNECT_HOST?.trim();
  if (connectHost) validateBotsConnectHost(env.BOTS_SERVICE_URL ?? "", connectHost);
  if (env.BOTS_ENABLED !== "true") return undefined;
  const serviceUrl = env.BOTS_SERVICE_URL?.trim().replace(/\/$/, "");
  const serviceSecret = env.BOTS_SERVICE_SECRET;
  const accounts = new Set((env.BOTS_TEST_ACCOUNTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!serviceUrl || !serviceSecret || accounts.size === 0) {
    console.warn("[startup] BOTS_ENABLED is set but the bots configuration is incomplete; bots are disabled.");
    return undefined;
  }
  const postTimeoutMs = Number(env.BOTS_POST_TIMEOUT_MS ?? "");
  return {
    serviceUrl, serviceSecret,
    ...(connectHost ? { fetchImpl: botsConnectFetch(serviceUrl, connectHost) } : {}),
    postTimeoutMs: Number.isInteger(postTimeoutMs) && postTimeoutMs > 0 ? postTimeoutMs : 120_000,
    accountAllowed: address => accounts.has("*") || accounts.has(address.toLowerCase()) };
}

export function createBotsRouter(opts: { config?: BotsConfig; authMiddleware: RequestHandler; paidLimiter?: RequestHandler }): Router {
  const router = Router();
  const { config } = opts;
  router.use(opts.authMiddleware);

  const enabledFor = (req: Request): boolean => Boolean(config && req.user && config.accountAllowed(req.user.address));
  const upstreamHeaders = (address: string): Record<string, string> => ({
    authorization: `Bearer ${config!.serviceSecret}`,
    "x-tinycloud-owner": botOwnerDid(address),
  });
  const gate = (req: Request, res: Response): string | null => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated", message: "Authentication required" }); return null; }
    if (!enabledFor(req)) { res.status(404).json({ error: "not_found" }); return null; }
    return req.user.address;
  };

  router.get("/status", (req, res) => {
    res.json({ enabled: enabledFor(req) });
  });

  router.get("/main/messages", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    try {
      const upstream = await (config!.fetchImpl ?? fetch)(`${config!.serviceUrl}/v1/bots/main/messages`, {
        headers: upstreamHeaders(address),
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok) { res.status(502).json({ error: UNAVAILABLE.code, message: UNAVAILABLE.message }); return; }
      res.json(await upstream.json());
    } catch {
      res.status(502).json({ error: UNAVAILABLE.code, message: UNAVAILABLE.message });
    }
  });

  // Each send starts a model call in the bot, so it is charged to the paid-chat limiter like /api/agent/chat.
  router.post("/main/messages", opts.paidLimiter ?? ((_req, _res, next) => next()), async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    const text: unknown = req.body?.text;
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT) {
      res.status(400).json({ error: "invalid", message: "Messages can be up to 8,000 characters." });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on("close", abort);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, config!.postTimeoutMs);

    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();

    try {
      const upstream = await (config!.fetchImpl ?? fetch)(`${config!.serviceUrl}/v1/bots/main/messages`, {
        method: "POST",
        headers: { ...upstreamHeaders(address), "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) throw new Error("upstream");
      const reader = upstream.body.getReader();
      // Release a pending read even if the upstream body ignores the abort signal.
      controller.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); }, { once: true });
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new Error("aborted");
        if (done) break;
        if (!res.write(value)) {
          // Backpressure: read the next upstream chunk only once the client has taken this one (or the turn ended).
          let resolve!: () => void;
          const drained = new Promise<void>(done => { resolve = done; }); // backend lib predates Promise.withResolvers
          res.once("drain", resolve);
          controller.signal.addEventListener("abort", resolve);
          await drained;
          res.off("drain", resolve);
          controller.signal.removeEventListener("abort", resolve);
        }
      }
    } catch {
      if ((timedOut || !controller.signal.aborted) && !res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify(UNAVAILABLE)}\n\n`);
      }
    } finally {
      clearTimeout(timer);
      res.off("close", abort);
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}
