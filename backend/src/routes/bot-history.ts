import express, { Router, type RequestHandler } from "express";
import { BotHistory, HISTORY_BOT_KEY, HistoryPermissionExpired, historyOwner } from "../bot-history.js";
import type { Bot, BotsRegistry } from "../bots-registry.js";
import { botsServiceHeaders, type BotsConfig } from "./bots.js";

/** What the history routes and the drain read from the registry: the owner's own record, never a key from a body. */
type OwnerRecords = Pick<BotsRegistry, "read">;

/** The owner's bot with this key when it is one of theirs other than Main; undefined for Main, a malformed or an unknown key. */
async function siblingOf(registry: OwnerRecords, address: string, key: string): Promise<Bot | undefined> {
  if (!HISTORY_BOT_KEY.test(key)) return undefined;
  return (await registry.read(address)).bots.find(bot => bot.key === key);
}

/** One signed call to the bots service, bounded at 10 s. `body` is sent as JSON, exactly as signed. */
function serviceCall(config: BotsConfig, address: string, method: string, url: string, body?: unknown) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return (config.fetchImpl ?? fetch)(url, {
    method, headers: botsServiceHeaders(config, historyOwner(address), method, url, text), body: text,
    ...(method === "GET" ? { cache: "no-store" as const } : {}), signal: AbortSignal.timeout(10_000),
  });
}

/** Only mounted for the flagged history slice; the owner always comes from authentication. */
export function createBotHistoryRouter(history: BotHistory, config: BotsConfig, auth: RequestHandler) {
  const router = Router();
  router.use(auth);
  router.use((req, res, next) => {
    if (!req.user || !config.accountAllowed(req.user.address)) { res.status(404).end(); return; }
    next();
  });
  router.get("/notice", async (req, res) => {
    try {
      const response = await serviceCall(config, req.user!.address, "GET", `${config.serviceUrl}/v1/bots/main/history/notice`);
      if (!response.ok) throw new Error();
      res.json(await response.json());
    } catch { res.status(503).json({ error: "history_notice_unavailable" }); }
  });
  router.post("/notice/ack", express.json({ limit: "4kb" }), async (req, res) => {
    const receivedAt = Date.now();
    if (Object.hasOwn(req.body ?? {}, "deleteAt")) { res.status(400).json({ error: "invalid_notice_ack" }); return; }
    try {
      const response = await serviceCall(config, req.user!.address, "POST", `${config.serviceUrl}/v1/bots/main/history/notice`, { id: req.body?.id, receivedAt });
      if (!response.ok) throw new Error();
      res.json(await response.json());
    } catch { res.status(503).json({ error: "history_notice_unavailable" }); }
  });
  router.get("/status", (_req, res) => res.json({ enabled: true, backendDid: history.node.did }));
  router.post("/grant", express.json({ limit: "96kb" }), async (req, res) => {
    const { serialized, siwe, signature } = req.body ?? {};
    if (typeof serialized !== "string" || typeof siwe !== "string" || typeof signature !== "string") { res.status(400).json({ error: "invalid_history_grant" }); return; }
    try {
      const validUntil = await history.accept(req.user!.address, { serialized, siwe, signature });
      const response = await serviceCall(config, req.user!.address, "PUT", `${config.serviceUrl}/v1/bots/main/history/permission`, { validUntil });
      if (!response.ok) throw new Error();
      res.status(204).end();
    }
    catch { res.status(503).json({ error: "history_grant_unavailable" }); }
  });
  return router;
}

/**
 * History for a bot other than Main, at /api/bots/:key/history. Only mounted with Main's. The owner comes from
 * authentication and the key from the URL, checked against that owner's record; the body names neither.
 */
export function createSiblingHistoryRouter(history: BotHistory, config: BotsConfig, auth: RequestHandler, registry: OwnerRecords) {
  const router = Router({ mergeParams: true });
  router.use(auth);
  router.use((req, res, next) => {
    if (!req.user || !config.accountAllowed(req.user.address)) { res.status(404).end(); return; }
    next();
  });
  // A malformed key, "main", an unknown key and another owner's key all get the same empty 404.
  router.use(async (req, res, next) => {
    let bot: Bot | undefined;
    try { bot = await siblingOf(registry, req.user!.address, String(req.params.key)); }
    catch { res.status(503).json({ error: req.path === "/grant" ? "history_grant_unavailable" : "history_notice_unavailable" }); return; }
    if (!bot) { res.status(404).end(); return; }
    res.locals.historyBot = bot;
    next();
  });
  const botOf = (res: express.Response) => res.locals.historyBot as Bot;
  router.get("/notice", async (req, res) => {
    try {
      const response = await serviceCall(config, req.user!.address, "GET", `${config.serviceUrl}/v1/bots/${botOf(res).key}/history/notice`);
      if (!response.ok) throw new Error();
      res.json(await response.json());
    } catch { res.status(503).json({ error: "history_notice_unavailable" }); }
  });
  router.post("/notice/ack", express.json({ limit: "4kb" }), async (req, res) => {
    const receivedAt = Date.now();
    if (Object.hasOwn(req.body ?? {}, "deleteAt")) { res.status(400).json({ error: "invalid_notice_ack" }); return; }
    try {
      const response = await serviceCall(config, req.user!.address, "POST", `${config.serviceUrl}/v1/bots/${botOf(res).key}/history/notice`, { id: req.body?.id, receivedAt });
      if (!response.ok) throw new Error();
      res.json(await response.json());
    } catch { res.status(503).json({ error: "history_notice_unavailable" }); }
  });
  router.post("/grant", express.json({ limit: "96kb" }), async (req, res) => {
    const bot = botOf(res);
    // A bot being deleted takes no new permission; its notice and acknowledgement go on until it is gone.
    if (bot.state === "deleting") { res.status(409).json({ error: "bot_deleting" }); return; }
    const { serialized, siwe, signature } = req.body ?? {};
    if (typeof serialized !== "string" || typeof siwe !== "string" || typeof signature !== "string") { res.status(400).json({ error: "invalid_history_grant" }); return; }
    try {
      // The delegation must name this bot's own directory, so a grant made for one bot cannot be stored for another.
      const validUntil = await history.accept(req.user!.address, { serialized, siwe, signature }, bot.key);
      const response = await serviceCall(config, req.user!.address, "PUT", `${config.serviceUrl}/v1/bots/${bot.key}/history/permission`, { validUntil });
      if (!response.ok) throw new Error();
      res.status(204).end();
    }
    catch { res.status(503).json({ error: "history_grant_unavailable" }); }
  });
  return router;
}

/**
 * How often a live bot's grant is sent to the bots service again. The service keeps a grant for a bot that has not run
 * yet in memory only, so one lost to a restart there is restored by the next send.
 */
export const GRANT_RESEND_MS = 300_000;

/**
 * Bounded, single-flight drain. Batches and challenges remain in the supervisor until it verifies a receipt.
 * Main's grants first, then, with a registry, each other bot's under its own grant once the owner's record still holds it.
 */
export function startBotHistoryDrain(history: BotHistory, config: BotsConfig, registry?: Pick<BotsRegistry, "read" | "oweRevoke">) {
  let running = false;
  let closing = false;
  const retries = new Map<string, { failures: number; after: number }>();
  /** Up to 32 batches of one bot. `key` names a bot other than Main; Main's calls are the ones it always made. */
  const drainBot = async (address: string, key?: string) => {
    const id = key ? `${address}/${key}` : address;
    const url = `${config.serviceUrl}/v1/bots/${key ?? "main"}/history`;
    for (let i = 0; i < 32 && !closing; i++) {
      const response = await serviceCall(config, address, "GET", url);
      if (!response.ok) break;
      const { batch } = await response.json() as { batch: unknown };
      if (!batch) break;
      try {
        const receipt = await history.archive(address, batch, async staged => {
          const response = await serviceCall(config, address, "POST", url + "/stage", staged);
          if (!response.ok) throw new Error("history_stage_unavailable");
        }, key);
        const accepted = await serviceCall(config, address, "POST", url, receipt);
        if (!accepted.ok) throw new Error("history_receipt_unavailable");
        retries.delete(id);
      } catch (error) {
        if (error instanceof HistoryPermissionExpired) {
          await serviceCall(config, address, "PUT", `${url}/permission`, { expiresAt: error.expiresAt });
        }
        const failures = (retries.get(id)?.failures ?? 0) + 1;
        retries.set(id, { failures, after: Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(failures, 12)) * (1 + Math.random() * 0.2) });
        break;
      } // next drain retries the same persisted batch, never a new generation
    }
  };
  const resendAt = new Map<string, number>();
  /** Sends a live bot's grant end again, once each GRANT_RESEND_MS (the first time one interval after it was first seen). */
  const resendGrant = async (address: string, key: string) => {
    const id = `${address}/${key}`;
    const due = resendAt.get(id);
    if (due === undefined) { resendAt.set(id, Date.now() + GRANT_RESEND_MS); return; }
    if (due > Date.now()) return;
    resendAt.set(id, Date.now() + GRANT_RESEND_MS);
    try {
      const validUntil = await history.grantValidUntil(address, key);
      if (validUntil !== undefined) await serviceCall(config, address, "PUT", `${config.serviceUrl}/v1/bots/${key}/history/permission`, { validUntil });
    } catch { /* sent again after the next interval */ }
  };
  const drain = async () => {
    if (running || closing) return;
    running = true;
    try {
      for (const address of await history.owners()) {
        if ((retries.get(address)?.after ?? 0) <= Date.now()) await drainBot(address);
      }
      if (registry) {
        for (const { address, key } of await history.siblings()) {
          if (closing) break;
          if ((retries.get(`${address}/${key}`)?.after ?? 0) > Date.now()) continue;
          let bot: Bot | undefined;
          try { bot = await siblingOf(registry, address, key); } catch { continue; } // the record is read again next pass
          // A bot that is gone, or whose deletion has closed its permission, never has its grant used; Main's never stands in.
          if (!bot || bot.grantClosed) {
            // Its grant is removed only once its delegation is owed in the owner's record, for the owner's browser to
            // revoke: a node refuses a revocation from the backend. A key the record never held has nowhere to owe it and
            // was never this owner's bot, so its grant is removed as well. While another delegation is owed for the bot,
            // the grant stays stored and unused, and is looked at again on the next pass.
            try {
              const cid = await history.storedGrantCid(address, key);
              const owed = cid === undefined ? "owed" : await registry.oweRevoke(address, key, cid);
              if (owed === "owed" || owed === "unknown") await history.forget(address, key);
            } catch { /* tried again on a later pass */ }
            continue;
          }
          await resendGrant(address, key);
          await drainBot(address, key);
        }
      }
    } catch { /* status remains pending; never advance the supervisor's receipt cursor on failure */ }
    finally { running = false; }
  };
  const timer = setInterval(() => void drain(), 10_000);
  timer.unref();
  void drain();
  return { drain, stop: () => { closing = true; clearInterval(timer); } };
}
