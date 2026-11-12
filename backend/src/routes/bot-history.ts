import express, { Router, type RequestHandler } from "express";
import { BotHistory, HistoryPermissionExpired, historyOwner } from "../bot-history.js";
import type { BotsConfig } from "./bots.js";

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
      const response = await (config.fetchImpl ?? fetch)(`${config.serviceUrl}/v1/bots/main/history/notice`, { headers: { authorization: `Bearer ${config.serviceSecret}`, "x-tinycloud-owner": historyOwner(req.user!.address) }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      res.json(await response.json());
    } catch { res.status(503).json({ error: "history_notice_unavailable" }); }
  });
  router.post("/notice/ack", express.json({ limit: "4kb" }), async (req, res) => {
    try {
      const response = await (config.fetchImpl ?? fetch)(`${config.serviceUrl}/v1/bots/main/history/notice`, { method: "POST", headers: { authorization: `Bearer ${config.serviceSecret}`, "x-tinycloud-owner": historyOwner(req.user!.address), "content-type": "application/json" }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      res.status(204).end();
    } catch { res.status(503).json({ error: "history_notice_unavailable" }); }
  });
  router.get("/status", (_req, res) => res.json({ enabled: true, backendDid: history.node.did }));
  router.post("/grant", express.json({ limit: "96kb" }), async (req, res) => {
    const { serialized, siwe, signature } = req.body ?? {};
    if (typeof serialized !== "string" || typeof siwe !== "string" || typeof signature !== "string") { res.status(400).json({ error: "invalid_history_grant" }); return; }
    try {
      const validUntil = await history.accept(req.user!.address, { serialized, siwe, signature });
      const response = await (config.fetchImpl ?? fetch)(`${config.serviceUrl}/v1/bots/main/history/permission`, { method: "PUT", headers: { authorization: `Bearer ${config.serviceSecret}`, "x-tinycloud-owner": historyOwner(req.user!.address), "content-type": "application/json" }, body: JSON.stringify({ validUntil }), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      res.status(204).end();
    }
    catch { res.status(503).json({ error: "history_grant_unavailable" }); }
  });
  return router;
}

/** Bounded, single-flight drain. Batches and challenges remain in the supervisor until it verifies a receipt. */
export function startBotHistoryDrain(history: BotHistory, config: BotsConfig) {
  let running = false;
  let closing = false;
  const retries = new Map<string, { failures: number; after: number }>();
  const drain = async () => {
    if (running || closing) return;
    running = true;
    try {
      for (const address of await history.owners()) {
        if ((retries.get(address)?.after ?? 0) > Date.now()) continue;
        for (let i = 0; i < 32 && !closing; i++) {
          const headers = { authorization: `Bearer ${config.serviceSecret}`, "x-tinycloud-owner": historyOwner(address) };
          const url = `${config.serviceUrl}/v1/bots/main/history`;
          const response = await (config.fetchImpl ?? fetch)(url, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
          if (!response.ok) break;
          const { batch } = await response.json() as { batch: unknown };
          if (!batch) break;
          try {
            const receipt = await history.archive(address, batch, async staged => {
              const response = await (config.fetchImpl ?? fetch)(url + "/stage", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(staged), signal: AbortSignal.timeout(10_000) });
              if (!response.ok) throw new Error("history_stage_unavailable");
            });
            const accepted = await (config.fetchImpl ?? fetch)(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(receipt), signal: AbortSignal.timeout(10_000) });
            if (!accepted.ok) throw new Error("history_receipt_unavailable");
            retries.delete(address);
          } catch (error) {
            if (error instanceof HistoryPermissionExpired) {
              await (config.fetchImpl ?? fetch)(`${config.serviceUrl}/v1/bots/main/history/permission`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ expiresAt: error.expiresAt }), signal: AbortSignal.timeout(10_000) });
            }
            const failures = (retries.get(address)?.failures ?? 0) + 1;
            retries.set(address, { failures, after: Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(failures, 12)) * (1 + Math.random() * 0.2) });
            break;
          } // next drain retries the same persisted batch, never a new generation
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
