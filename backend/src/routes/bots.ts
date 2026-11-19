// /api/bots — tiny bots slice 1 (TC-2808): the owner's Main bot, proxied to the bots service.
//
// The owner is always the authenticated session address; the body and request headers never choose it.
// The service secret stays server-side. Message content is neither logged nor stored here.

import { botsConnectFetch, validateBotsConnectHost } from "../bots-transport";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { botCaps, CAP_MODE, type CapMode } from "../bot-caps";
import { BOT_KEY, MAIN_BOT_KEY, orderedBots, type Bot, type BotsRegistry } from "../bots-registry";

export interface BotsConfig {
  serviceUrl: string;
  serviceSecret: string;
  accountAllowed: (address: string) => boolean;
  /** Overall bound on one POST turn (BOTS_POST_TIMEOUT_MS, default 120000). */
  postTimeoutMs: number;
  fetchImpl?: typeof fetch;
  onTurnFinished?: () => void;
  /** The bots a turn of `sourceKey` may message, asked for by the owner's DID. Absent means none. */
  listForTurn?: (ownerDid: string, sourceKey: string) => Promise<string[]>;
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

/**
 * What the service is sent for one turn. The bots the turn may message come from `listForTurn` alone: nothing the
 * browser sent is in it except the text the route has checked.
 */
export async function botTurnBody(config: BotsConfig, address: string, sourceKey: string, text: string) {
  try {
    const messageableBotKeys = await config.listForTurn?.(botOwnerDid(address), sourceKey);
    if (messageableBotKeys?.length) return { text, messageableBotKeys };
  } catch { /* A registry read failure leaves the turn without messaging. */ }
  return { text };
}

/**
 * Headers for one call to the bots service at `url`. Every call this router makes to the service goes through here,
 * so how a call is authenticated is decided in one place.
 */
export function botsServiceHeaders(config: BotsConfig, ownerDid: string, _method: string, _url: string, body?: string): Record<string, string> {
  const headers = { authorization: `Bearer ${config.serviceSecret}`, "x-tinycloud-owner": ownerDid };
  return body === undefined ? headers : { ...headers, "content-type": "application/json" };
}

/** The same answer as UNAVAILABLE, for a bot other than Main. */
const BOT_UNAVAILABLE = { code: "bot_unavailable", message: "This bot isn't available. Try again later." };

export function createBotsRouter(opts: { config?: BotsConfig; authMiddleware: RequestHandler; paidLimiter?: RequestHandler; registry?: BotsRegistry; capMode?: CapMode }): Router {
  const { registry } = opts;
  const capMode = opts.capMode ?? CAP_MODE;
  const router = Router();
  const { config } = opts;
  router.use(opts.authMiddleware);

  const enabledFor = (req: Request): boolean => Boolean(config && req.user && config.accountAllowed(req.user.address));
  const gate = (req: Request, res: Response): string | null => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated", message: "Authentication required" }); return null; }
    if (!enabledFor(req)) { res.status(404).json({ error: "not_found" }); return null; }
    return req.user.address;
  };

  /**
   * Tells the service a bot's state under the record's counter. The service ignores anything older than what it
   * holds, so a late or repeated call is harmless. Answers whether the service took it.
   */
  const announce = async (address: string, key: string, state: "active" | "suspended" | "deleting", seq: number): Promise<boolean> => {
    try {
      const url = `${config!.serviceUrl}/v1/bots/${key}`;
      const body = JSON.stringify({ state, seq });
      const response = await (config!.fetchImpl ?? fetch)(url, { method: "PUT", headers: botsServiceHeaders(config!, botOwnerDid(address), "PUT", url, body), body, signal: AbortSignal.timeout(10_000) });
      return response.ok;
    } catch {
      return false;
    }
  };

  router.get("/status", (req, res) => {
    res.json({ enabled: enabledFor(req) });
  });

  // The owner's bots, and how many more may be created. The owner is the session address; nothing in the request names one.
  router.get("/", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    if (!registry) { res.status(404).json({ error: "not_found" }); return; }
    try {
      const row = await registry.read(address);
      res.json({ bots: orderedBots(row), deleted: row.deleted, ...botCaps(capMode, undefined, row) });
    } catch {
      res.status(503).json({ error: "bots_unavailable" });
    }
  });

  // Creates a bot for the signed-in owner. Its key is chosen here; the request names neither an owner nor a key.
  router.post("/", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    if (!registry) { res.status(404).json({ error: "not_found" }); return; }
    try {
      const { limits } = botCaps(capMode, undefined, await registry.read(address));
      if (!limits) { res.status(503).json({ error: "bots_unavailable" }); return; }
      const created = await registry.create(address, { name: req.body?.name, shape: req.body?.shape, colour: req.body?.colour }, limits.private.max);
      if (!created.ok) {
        const status = created.error === "name_taken" || created.error === "bot_limit" ? 409 : 400;
        res.status(status).json(created.error === "bot_limit" ? { error: "bot_limit", environment: "private" } : { error: created.error });
        return;
      }
      // If this fails the bot still exists; a message to it announces it again.
      await announce(address, created.bot.key, "active", created.seq);
      res.status(201).json({ bot: created.bot });
    } catch {
      res.status(503).json({ error: "bots_unavailable" });
    }
  });

  /**
   * The bot a keyed route acts on, taken from the signed-in owner's own record. A malformed key is refused before
   * anything is looked up, and a key that is not in that record before the service is called. Answers 404 or 503
   * itself and returns undefined.
   */
  const ownBot = async (res: Response, address: string, key: string): Promise<{ bot: Bot; seq: number } | undefined> => {
    if (!registry || !BOT_KEY.test(key)) { res.status(404).json({ error: "not_found" }); return undefined; }
    try {
      const row = await registry.read(address);
      const bot = row.bots.find(candidate => candidate.key === key);
      if (bot) return { bot, seq: row.seq };
      res.status(404).json({ error: "not_found" });
    } catch {
      res.status(503).json({ error: "bots_unavailable" });
    }
    return undefined;
  };

  /**
   * One call to the service for a bot. Main exists there without being announced; any other bot exists there only
   * once announced. So if the service does not know a bot the record says is active, it is told again, once, and
   * the call is made again. `call` builds a fresh request each time. `seq` is the record's counter, absent for Main.
   */
  const callBot = async (address: string, key: string, seq: number | undefined, call: () => Promise<globalThis.Response>): Promise<globalThis.Response> => {
    const first = await call();
    if (first.status !== 404 || seq === undefined || !(await announce(address, key, "active", seq))) return first;
    await first.body?.cancel();
    return call();
  };

  const readMessages = async (res: Response, address: string, key: string, seq?: number): Promise<void> => {
    const unavailable = key === MAIN_BOT_KEY ? UNAVAILABLE : BOT_UNAVAILABLE;
    try {
      const url = `${config!.serviceUrl}/v1/bots/${key}/messages`;
      const upstream = await callBot(address, key, seq, () => (config!.fetchImpl ?? fetch)(url, {
        headers: botsServiceHeaders(config!, botOwnerDid(address), "GET", url),
        signal: AbortSignal.timeout(10_000),
      }));
      if (!upstream.ok) { res.status(502).json({ error: unavailable.code, message: unavailable.message }); return; }
      res.json(await upstream.json());
    } catch {
      res.status(502).json({ error: unavailable.code, message: unavailable.message });
    }
  };

  router.get("/main/messages", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    await readMessages(res, address, MAIN_BOT_KEY);
  });

  router.get("/:key/messages", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    const own = await ownBot(res, address, req.params.key);
    if (!own) return;
    // The service answers the same for a bot that is being deleted; say so here, without asking it.
    if (own.bot.state === "deleting") { res.status(409).json({ error: "bot_not_active", state: own.bot.state }); return; }
    await readMessages(res, address, own.bot.key, own.seq);
  });

  // One turn: the owner's text goes to the bot `key` names, and the service's events stream back.
  const sendMessage = async (req: Request, res: Response, address: string, key: string, seq?: number): Promise<void> => {
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
      const url = `${config!.serviceUrl}/v1/bots/${key}/messages`;
      const body = JSON.stringify(await botTurnBody(config!, address, key, text));
      const upstream = await callBot(address, key, seq, () => (config!.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: botsServiceHeaders(config!, botOwnerDid(address), "POST", url, body),
        body,
        signal: controller.signal,
      }));
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
        res.write(`event: error\ndata: ${JSON.stringify(key === MAIN_BOT_KEY ? UNAVAILABLE : BOT_UNAVAILABLE)}\n\n`);
      }
    } finally {
      clearTimeout(timer);
      res.off("close", abort);
      if (!res.writableEnded) res.end();
      config!.onTurnFinished?.();
    }
  };

  const paidLimiter: RequestHandler = opts.paidLimiter ?? ((_req, _res, next) => next());

  // Each send starts a model call in the bot, so it is charged to the paid-chat limiter like /api/agent/chat.
  router.post("/main/messages", paidLimiter, async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    await sendMessage(req, res, address, MAIN_BOT_KEY);
  });

  router.post("/:key/messages", paidLimiter, async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    const own = await ownBot(res, address, req.params.key);
    if (!own) return;
    if (own.bot.state !== "active") { res.status(409).json({ error: "bot_not_active", state: own.bot.state }); return; }
    await sendMessage(req, res, address, own.bot.key, own.seq);
  });

  return router;
}
