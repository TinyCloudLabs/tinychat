import { expect, spyOn, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { BotHistory } from "../bot-history";
import { createBotHistoryRouter } from "../routes/bot-history";
import type { BotsConfig } from "../routes/bots";

test("replacement grants still reach the bot and node revoke failures log only a running count", async () => {
  const address = `0x${"11".repeat(20)}`;
  const validUntil = Date.now() + 60_000;
  const active = { cid: "current-grant", revision: 2, validUntil };
  const replaced = { cid: "previous-grant", revision: 1, validUntil };
  const retirements: string[] = [];
  const history = {
    accept: async () => ({ active, replaced }),
    revoke: async (cid: string) => {
      retirements.push(cid);
      if (retirements.length !== 2) throw new Error("node response with private data");
    },
  } as unknown as BotHistory;
  const pushes: Array<[string | null, string | null]> = [];
  const config: BotsConfig = {
    serviceUrl: "http://bots.test", serviceSecret: "b".repeat(64), accountAllowed: () => true, postTimeoutMs: 1000,
    fetchImpl: (async input => {
      const { searchParams } = new URL(String(input));
      pushes.push([searchParams.get("kind"), searchParams.get("cid")]);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  };
  const app = express();
  app.use(createBotHistoryRouter(history, config, (req, _res, next) => {
    req.user = { address } as typeof req.user;
    next();
  }));
  const server = app.listen(0, "127.0.0.1");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/grant`;
    for (let i = 0; i < 3; i++) {
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ serialized: "grant", siwe: "statement", signature: "signature" }),
      });
      expect(response.status).toBe(204);
    }
    expect(retirements).toEqual([replaced.cid, replaced.cid, replaced.cid]);
    expect(pushes).toEqual([
      ["extend", active.cid], ["revoke", replaced.cid], ["extend", active.cid], ["extend", active.cid],
    ]);
    const event = "bot_history_replaced_grant_revoke_failed";
    expect(warning.mock.calls).toEqual([
      [JSON.stringify({ event, count: 1 })], [JSON.stringify({ event, count: 2 })],
    ]);
  } finally {
    warning.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
