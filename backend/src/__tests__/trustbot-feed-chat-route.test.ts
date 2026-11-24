// The gateway's route for TrustBot's feed and chat tools (TC-3794): a signed call for Main, each read through the
// owner's `feed_chats` grant, one resource at a time, mounted behind the same guard and body parser as in index.ts.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiBodyParser } from "../body-parsing.js";
import { createBotsServiceGuardRouter } from "../bots-service-routes.js";
import { signedCallHeader } from "../bots-signed-call.js";
import { createTrustBotReadsInternalRouter, TRUSTBOT_READS_INTERNAL_PREFIX } from "../routes/trustbot-reads.js";
import type { BotsConfig } from "../routes/bots.js";
import { READ_AREAS } from "../trustbot-reads/areas.js";
import { FEED_CHAT_TOOLS, FEED_PREFIX, HOME_FEED_DATABASE, THREADS_DATABASE } from "../trustbot-reads/feed-chat.js";
import { ReadGrantRefused, type TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { FEED_CHAT_TOOL_NAMES } from "../../../bots/src/feed-chat-tools";

const secret = "c".repeat(64);
const address = `0x${"ab".repeat(20)}`;
const owner = `did:pkh:eip155:1:${address}`;
const OUTPUT = `${FEED_PREFIX}/feed_output_trip`;
const CONNECTORS = "xyz.tinycloud.tinychat/connectors";

let state: "on" | "off" | "ended" = "on";
let nodeStatus: number | undefined;
let forgotten = 0;
/** Each grant read as `area path`, and each database a query reached with the resource it was activated for. */
const reads: string[] = [];
const reached: Array<{ resource: string; database: string }> = [];
const databases = new Map<string, Database>();
const db = (name: string) => {
  let found = databases.get(name);
  if (!found) databases.set(name, (found = new Database(":memory:")));
  return found;
};

const grants = {
  deniedChatIds: async () => new Set<string>(),
  async access(who: string, area: string, path?: string) {
    reads.push(`${who} ${area} ${path}`);
    if (state !== "on") throw new ReadGrantRefused(state);
    return {
      sql: {
        db: (database: string) => ({
          query: async (sql: string, params: Array<string | number | null>) => {
            reached.push({ resource: String(path), database });
            if (nodeStatus) return { ok: false, error: { code: "AUTH_UNAUTHORIZED", meta: { status: nodeStatus } } };
            return { ok: true, data: { columns: [], rows: db(database).query(sql).values(...params), rowCount: 0 } };
          },
        }),
      },
    };
  },
  forgetActivation() { forgotten++; },
} as unknown as TrustBotReadGrants;
const config = { serviceUrl: "http://bots.test", serviceSecret: "s", postTimeoutMs: 1000, accountAllowed: (who: string) => who === address } as BotsConfig;

let server: Server;
let base: string;
beforeAll(async () => {
  db(HOME_FEED_DATABASE).run("CREATE TABLE feed_agents (agent_id TEXT PRIMARY KEY, agent_did TEXT, label TEXT, output_resource TEXT, response_resource TEXT, authorization_json TEXT)");
  db(HOME_FEED_DATABASE).run("INSERT INTO feed_agents VALUES ('trip', 'did:key:z', 'Trip agent', ?, ?, '{}')", [OUTPUT, `${FEED_PREFIX}/feed_responses_trip`]);
  db(HOME_FEED_DATABASE).run("INSERT INTO feed_agents VALUES ('stray', 'did:key:z', 'Stray', ?, ?, '{}')", [CONNECTORS, CONNECTORS]);
  db(OUTPUT).run("CREATE TABLE feed_cards (sequence INTEGER PRIMARY KEY, card_id TEXT, revision INTEGER, issuance_id TEXT, card_json TEXT)");
  db(OUTPUT).run("INSERT INTO feed_cards (card_id, revision, issuance_id, card_json) VALUES ('c1', 1, 'i1', ?)", [
    JSON.stringify({ cardId: "c1", revision: 1, issuanceId: "i1", kind: "note", needsResponse: false, title: "Flight moved", body: "Now 09:40", urgency: 1, createdAt: "2026-11-21T08:00:00Z" }),
  ]);
  db(THREADS_DATABASE).run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db(THREADS_DATABASE).run("CREATE TABLE messages (thread_id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, position))");
  db(THREADS_DATABASE).run("INSERT INTO threads VALUES ('t1', 'Lisbon', 'm', '2026-11-21T09:00:00Z', '2026-11-21T09:00:00Z')");
  db(THREADS_DATABASE).run("INSERT INTO messages VALUES ('t1', 0, ?, '2026-11-21T09:00:00Z')", [JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "Plan Lisbon" }] } })]);
  db(CONNECTORS).run("CREATE TABLE feed_cards (sequence INTEGER PRIMARY KEY, card_id TEXT, revision INTEGER, issuance_id TEXT, card_json TEXT)");

  const app = express();
  app.use(createBotsServiceGuardRouter());
  app.use(createApiBodyParser());
  app.use(TRUSTBOT_READS_INTERNAL_PREFIX, createTrustBotReadsInternalRouter({ grants, config, callSecret: secret }));
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  state = "on";
  nodeStatus = undefined;
  forgotten = 0;
  reads.length = 0;
  reached.length = 0;
});

async function post(tool: string, args: unknown) {
  const path = `${TRUSTBOT_READS_INTERNAL_PREFIX}/${tool}`;
  const body = JSON.stringify({ args });
  const authorization = signedCallHeader(secret, { direction: "to-backend", environment: "private", owner, bot: "main", method: "POST", path, body });
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body });
  return { status: response.status, body: await response.json() as { ok: boolean; text?: string; error?: string } };
}

describe("TrustBot's feed and chat route", () => {
  test("lists feed cards through the feed_chats grant, each database under its own resource, skipping a registry row outside the feed", async () => {
    const { status, body } = await post("list_feed_cards", {});
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.parse(body.text!)).toMatchObject({ cards: [{ agent: "trip", agent_label: "Trip agent", card: "c1", title: "Flight moved" }] });
    expect(reached).toEqual([
      { resource: HOME_FEED_DATABASE, database: HOME_FEED_DATABASE },
      { resource: `${FEED_PREFIX}/`, database: OUTPUT },
    ]);
    expect(reads.every(entry => entry.startsWith(`${address} feed_chats `))).toBe(true);
  });

  test("reads a chat through the threads resource only", async () => {
    const { body } = await post("read_chat", { chat: "t1" });
    expect(JSON.parse(body.text!)).toMatchObject({ chat: "t1", title: "Lisbon", messages: [{ role: "user", text: "Plan Lisbon" }] });
    expect(reached.every(({ resource, database }) => resource === THREADS_DATABASE && database === THREADS_DATABASE)).toBe(true);
  });

  test("every resource the route activates is one the feed_chats area names", async () => {
    await post("list_feed_cards", {});
    await post("read_card", { agent: "trip", card: "c1" });
    await post("list_chats", {});
    await post("read_chat", { chat: "t1" });
    const named = READ_AREAS.feed_chats.map(resource => resource.path) as string[];
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every(({ resource }) => named.includes(resource))).toBe(true);
    expect(reached.some(({ database }) => database === CONNECTORS)).toBe(false);
  });

  test("answers the owner's setting when feed and chats is off or the grant has ended, before reading anything", async () => {
    state = "off";
    expect((await post("list_chats", {})).body).toEqual({ ok: false, error: "off" });
    state = "ended";
    expect((await post("read_card", { agent: "trip", card: "c1" })).body).toEqual({ ok: false, error: "ended" });
    expect(reached).toEqual([]);
  });

  test("a card or chat that isn't there is not_found; a registry row outside the feed is never read", async () => {
    expect((await post("read_chat", { chat: "missing" })).body).toMatchObject({ ok: false, error: "not_found" });
    expect((await post("read_card", { agent: "stray", card: "c1" })).body).toMatchObject({ ok: false, error: "not_found" });
    expect(reached.some(({ database }) => database === CONNECTORS)).toBe(false);
  });

  test("a node refusal forgets the activation and answers unavailable", async () => {
    nodeStatus = 403;
    expect((await post("list_chats", {})).body).toEqual({ ok: false, error: "unavailable" });
    expect(forgotten).toBe(1);
  });

  test("the bots service serves the same four tools the backend runs", () => {
    expect([...FEED_CHAT_TOOL_NAMES]).toEqual([...FEED_CHAT_TOOLS]);
  });
});
