// The bots gateway reaches TrustBot's read route through the backend's real middleware order (index.ts): the bots
// service guard, the API body parser, the global CSRF check, the rate limits, then the route. The route's own test
// mounts the route alone, so it cannot show whether a call shaped like the gateway's gets that far.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiBodyParser } from "../body-parsing.js";
import { createBotsServiceGuardRouter } from "../bots-service-routes.js";
import { signedCallHeader } from "../bots-signed-call.js";
import { applyRateLimiters } from "../rate-limits.js";
import { createTrustBotReadsInternalRouter, TRUSTBOT_READS_INTERNAL_PREFIX } from "../routes/trustbot-reads.js";
import type { BotsConfig } from "../routes/bots.js";
import { ReadGrantRefused, type TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { MeetingDesk, READ_ERRORS } from "../../../bots/src/meeting-reads";
import { botIdFor } from "../../../bots/src/owner";

const secret = "c".repeat(64);
const address = `0x${"ab".repeat(20)}`;
const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const conversation = "0".repeat(32);

let state: "on" | "off" = "on";
const reached: string[] = [];
const grants = {
  deniedChatIds: async () => new Set<string>(),
  async access(who: string, area: string) {
    reached.push(`${who}:${area}`);
    if (state !== "on") throw new ReadGrantRefused("off");
    return {
      sql: { db: () => ({ query: async () => ({ ok: true, data: { columns: [], rows: [], rowCount: 0 } }) }) },
      kv: { get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND" } }) },
    };
  },
  forgetActivation() {},
} as unknown as TrustBotReadGrants;
const config = { serviceUrl: "http://bots.test", serviceSecret: "s", postTimeoutMs: 1000, accountAllowed: (who: string) => who === address } as BotsConfig;

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(createBotsServiceGuardRouter());
  app.use(createApiBodyParser());
  app.use(createCsrfMiddleware());
  applyRateLimiters(app, { sessionKey: "k".repeat(64) });
  app.use(TRUSTBOT_READS_INTERNAL_PREFIX, createTrustBotReadsInternalRouter({ grants, config, callSecret: secret }));
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function post(tool: string, headers: Record<string, string>, sign: { secret?: string } = {}) {
  const path = `${TRUSTBOT_READS_INTERNAL_PREFIX}/${tool}`;
  const body = JSON.stringify({ args: {} });
  const authorization = signedCallHeader(sign.secret ?? secret, {
    direction: "to-backend", environment: "private", owner, bot: "main", method: "POST", path, body,
  });
  return fetch(`${base}${path}`, { method: "POST", headers: { authorization, "content-type": "application/json", ...headers }, body });
}

describe("the gateway's read call through the backend's middleware order", () => {
  test("a read made by the bots service's own client reaches the route and returns the tool's answer", async () => {
    state = "on";
    reached.length = 0;
    const desk = new MeetingDesk({ backendOrigin: base, backendCallSecret: secret });
    desk.push(botIdFor(owner), { owner, conversation, areas: ["meetings"] });
    const answer = (await desk.call(botIdFor(owner), "tinycloud_find_meetings", { limit: 3 })).content[0]?.text ?? "";
    expect(answer).not.toBe(READ_ERRORS.unavailable);
    expect(answer).toContain("matchedCount");
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every(entry => entry === `${address}:meetings`)).toBe(true);
  });

  test("the owner's setting reaches the bot as the owner's setting, not as unavailable", async () => {
    state = "off";
    reached.length = 0;
    const desk = new MeetingDesk({ backendOrigin: base, backendCallSecret: secret });
    desk.push(botIdFor(owner), { owner, conversation, areas: ["meetings"] });
    expect((await desk.call(botIdFor(owner), "tinycloud_find_meetings", {})).content[0]?.text).toBe(READ_ERRORS.off);
    expect(reached).toEqual([`${address}:meetings`]);
    state = "on";
  });

  test("a call without the CSRF header is still refused before the route", async () => {
    reached.length = 0;
    const response = await post("tinycloud_find_meetings", {});
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "csrf_rejected" });
    expect(reached).toEqual([]);
  });

  test("with the header, a call with a wrong signature or none is still refused and reads nothing", async () => {
    reached.length = 0;
    const csrf = { "x-requested-with": "XMLHttpRequest" };
    expect((await post("tinycloud_find_meetings", csrf, { secret: "d".repeat(64) })).status).toBe(401);
    const unsigned = await fetch(`${base}${TRUSTBOT_READS_INTERNAL_PREFIX}/tinycloud_find_meetings`, {
      method: "POST", headers: { "content-type": "application/json", ...csrf }, body: JSON.stringify({ args: {} }),
    });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.text()).toBe("");
    expect(reached).toEqual([]);
  });
});
