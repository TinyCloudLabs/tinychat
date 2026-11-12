import express from "express";
import { expect, test } from "bun:test";
import type { BotHistory } from "../bot-history";
import { createBotHistoryRouter } from "../routes/bot-history";
import type { BotsConfig } from "../routes/bots";

test("notice acknowledgment uses backend receive time, ignores a future client render, and rejects client deadlines", async () => {
  let forwarded: { id: string; receivedAt: number } | undefined;
  const app = express();
  const config = { accountAllowed: () => true, serviceUrl: "http://service", serviceSecret: "fixture", fetchImpl: async (_url: unknown, init: RequestInit) => {
    forwarded = JSON.parse(String(init.body));
    return Response.json({ notice: { deliveredAt: forwarded!.receivedAt, deleteAt: forwarded!.receivedAt + 30 * 86_400_000 } });
  } } as unknown as BotsConfig;
  app.use(createBotHistoryRouter({} as BotHistory, config, (req, _res, next) => { req.user = { address: "0x" + "11".repeat(20) } as typeof req.user; next(); }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/notice/ack`;
    const before = Date.now();
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "notice", renderedAt: before + 60_000 }) });
    expect(response.status).toBe(200);
    expect(forwarded!.receivedAt).toBeGreaterThanOrEqual(before);
    expect(forwarded!.receivedAt).toBeLessThanOrEqual(Date.now());
    expect(Object.hasOwn(forwarded!, "renderedAt")).toBe(false);
    expect((await response.json()).notice.deleteAt).toBe(forwarded!.receivedAt + 30 * 86_400_000);
    forwarded = undefined;
    const rejected = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "notice", deleteAt: before + 60_000 }) });
    expect(rejected.status).toBe(400);
    expect(forwarded).toBeUndefined();
  } finally { server.close(); }
});
