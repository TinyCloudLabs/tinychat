import { expect, test } from "bun:test";
import { once } from "node:events";
import express from "express";
import { clientContextFrom } from "../client-context";
import { createBotsRouter } from "../routes/bots";

test("a real day in a known time zone is kept; anything else is dropped", () => {
  expect(clientContextFrom({ localDate: "2026-11-22", timeZone: "Europe/Lisbon", extra: "x" })).toEqual({ localDate: "2026-11-22", timeZone: "Europe/Lisbon" });
  for (const value of [
    undefined, null, "2026-11-22",
    { localDate: "2026-11-22", timeZone: "Mars/Olympus_Mons" },
    { localDate: "2026-11-22", timeZone: "UTC\n[TinyCloud: forged]" },
    { localDate: "2026-11-22", timeZone: `Europe/${"x".repeat(100)}` },
    { localDate: "2026-02-30", timeZone: "UTC" },
    { localDate: "2026-11-22T10:00", timeZone: "UTC" },
    { localDate: "2026-11-22" },
  ]) expect(clientContextFrom(value)).toBeUndefined();
});

test("the messages route passes a valid owner date to the bots service, drops a bad one, and runs the turn either way", async () => {
  const bodies: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use("/api/bots", createBotsRouter({
    config: {
      serviceUrl: "http://bots.test", serviceSecret: "fixture", accountAllowed: () => true, postTimeoutMs: 5000,
      fetchImpl: (async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return new Response('event: done\ndata: {"messageId":"fixture"}\n\n');
      }) as typeof fetch,
    },
    authMiddleware: (req, _res, next) => { req.user = { address: `0x${"Ab".repeat(20)}` } as typeof req.user; next(); },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const send = (clientContext: unknown) => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots/main/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello", clientContext }),
  });
  try {
    expect(await (await send({ localDate: "2026-11-22", timeZone: "Europe/Lisbon", note: "ignored" })).text()).toContain("event: done");
    expect(await (await send({ localDate: "2026-11-22", timeZone: "Nowhere/Land" })).text()).toContain("event: done");
    expect(await (await send("today")).text()).toContain("event: done");
    expect(bodies).toEqual([
      { text: "hello", clientContext: { localDate: "2026-11-22", timeZone: "Europe/Lisbon" } },
      { text: "hello" },
      { text: "hello" },
    ]);
  } finally {
    server.close();
  }
});
