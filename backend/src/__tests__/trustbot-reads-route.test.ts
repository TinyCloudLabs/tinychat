// The gateway's route for TrustBot's meeting tools (TC-3792): a signed call for Main, the four meeting tools only,
// each read through the owner's grant, mounted behind the same guard and body parser as in index.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiBodyParser } from "../body-parsing.js";
import { createBotsServiceGuardRouter } from "../bots-service-routes.js";
import { signedCallHeader } from "../bots-signed-call.js";
import { TINYCLOUD_MEETING_TOOLS } from "../transcripts/tool-contract.js";
import { createTrustBotReadsInternalRouter, TRUSTBOT_MEETING_TOOLS, TRUSTBOT_READS_INTERNAL_PREFIX } from "../routes/trustbot-reads.js";
import type { BotsConfig } from "../routes/bots.js";
import { ReadGrantRefused, type TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { MEETING_TOOLS } from "../../../bots/src/meeting-tools";

const secret = "c".repeat(64);
const address = `0x${"ab".repeat(20)}`;
const owner = `did:pkh:eip155:1:${address}`;

let state: "on" | "off" | "ended" = "on";
const reads: string[] = [];
const sqlSeen: string[] = [];
const grants = {
  async access(who: string, area: string) {
    reads.push(`${who}:${area}`);
    if (state !== "on") throw new ReadGrantRefused(state);
    return {
      sql: { db: () => ({ query: async (sql: string) => { sqlSeen.push(sql); return { ok: true, data: { columns: [], rows: [], rowCount: 0 } }; } }) },
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
  app.use(TRUSTBOT_READS_INTERNAL_PREFIX, createTrustBotReadsInternalRouter({ grants, config, callSecret: secret }));
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function post(tool: string, args: unknown, sign: { bot?: string; owner?: string; secret?: string; body?: string } = {}) {
  const path = `${TRUSTBOT_READS_INTERNAL_PREFIX}/${tool}`;
  const body = JSON.stringify({ args });
  const authorization = signedCallHeader(sign.secret ?? secret, {
    direction: "to-backend", environment: "private", owner: sign.owner ?? owner, bot: sign.bot ?? "main", method: "POST", path, body: sign.body ?? body,
  });
  return fetch(`${base}${path}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body });
}

describe("TrustBot's meeting route", () => {
  test("runs a meeting tool for Main through the owner's grant", async () => {
    state = "on";
    reads.length = 0;
    sqlSeen.length = 0;
    const response = await post("tinycloud_find_meetings", { limit: 3 });
    expect(response.status).toBe(200);
    const answer = await response.json() as { ok: boolean; text: string };
    expect(answer.ok).toBe(true);
    expect(JSON.parse(answer.text)).toMatchObject({ meetings: [], discovery: { matchedCount: 0 } });
    expect(reads.every(entry => entry === `${address}:meetings`)).toBe(true);
    expect(sqlSeen.length).toBeGreaterThan(0);
    expect(sqlSeen.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
  });

  test("answers the owner's setting when reading is off or the grant has ended", async () => {
    state = "off";
    expect(await (await post("tinycloud_read_meeting", { focus: "summary" })).json()).toEqual({ ok: false, error: "off" });
    state = "ended";
    expect(await (await post("tinycloud_read_meeting", { focus: "summary" })).json()).toEqual({ ok: false, error: "ended" });
    state = "on";
  });

  test("refuses a call not signed for Main, with another secret, for another body or for an owner not allowed", async () => {
    reads.length = 0;
    expect((await post("tinycloud_find_meetings", {}, { bot: "a".repeat(32) })).status).toBe(401);
    expect((await post("tinycloud_find_meetings", {}, { secret: "d".repeat(64) })).status).toBe(401);
    expect((await post("tinycloud_find_meetings", {}, { body: JSON.stringify({ args: { limit: 12 } }) })).status).toBe(401);
    expect((await post("tinycloud_find_meetings", {}, { owner: `did:pkh:eip155:1:0x${"cd".repeat(20)}` })).status).toBe(404);
    expect(reads).toEqual([]);
  });

  test("serves only the four meeting tools", async () => {
    reads.length = 0;
    for (const tool of ["web_search", "tinycloud_write_meeting", "admit"]) {
      expect((await post(tool, {})).status).toBeOneOf([403, 404]);
    }
    expect(reads).toEqual([]);
  });

  test("the bots service's copy of the tool schemas matches the backend's", () => {
    expect(MEETING_TOOLS).toEqual(TINYCLOUD_MEETING_TOOLS.map(tool => ({
      name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters,
    })) as never);
    expect(MEETING_TOOLS.map(tool => tool.name)).toEqual([...TRUSTBOT_MEETING_TOOLS]);
  });
});
