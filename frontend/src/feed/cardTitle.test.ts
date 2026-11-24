/**
 * A card's title never shows a link or a token (TC-4253). One Courier card was titled with its message's first line,
 * a data-room edit link. A Courier card is titled by a short summary of that line, "New message" when nothing else was
 * in it; its body is shown as sent.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { feedResourceNames, initializeFeedDatabases, publishFeedCard, type FeedCard, type FeedDatabase } from "@tinycloud/sdk-services/feed";
import { useLocalThreadStorage } from "../lib/threadStore";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";
import { COURIER_SOURCE_ID } from "./feedData";
import { shownTitle } from "./cardTitle";

const EDIT_LINK = "https://dataroom.tinycloud.xyz/rooms/northwind/edit?share=6f1d2c";
// Joined at run time, like the other guard tests' made-up secrets, so the repository's own secret scan has nothing to find.
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJtaXJhIn0", "c2lnbmF0dXJlLXZhbHVlLTEyMw"].join(".");
const HEX = "9f86d081884c7d65".repeat(4);
const TAP = `https://openkey.so/a/${"a".repeat(26)}#v=4&k=${"A".repeat(43)}&c=bafkrei${"a".repeat(52)}`;
const KEY = `sk-ant-${"a1B2".repeat(8)}`;

test("a link, a JWT, a bearer token and a long hex string are taken out of a title; a plain sentence is untouched", () => {
  expect(shownTitle(`Edit the room: ${EDIT_LINK}.`)).toBe("Edit the room: [link].");
  expect(shownTitle("Notes at dataroom.tinycloud.xyz/rooms/northwind")).toBe("Notes at [link]");
  // A JWT is a secret the guard already refuses; in a title the guard's mark is "[link]" too, so a title shows one mark.
  expect(shownTitle(`Session ${JWT} expires today`)).toBe("Session [link] expires today");
  expect(shownTitle(`Tap ${TAP} or use ${KEY}`)).toBe("Tap [link] or use [link]");
  expect(shownTitle("Use Authorization: Bearer abc.def-123 for the call")).toBe("Use Authorization: [hidden] for the call");
  expect(shownTitle(`Key ${HEX} rotated`)).toBe("Key [hidden] rotated");
  expect(shownTitle(`Blob ${"Zm9vYmFy".repeat(4)}1== attached`)).toBe("Blob [hidden] attached");
  expect(shownTitle("Reply to reply+k7Qm2xZp9@courier.example.com")).toBe("Reply to [link]");
  for (const sentence of ["Can we move Thursday's review to Friday morning?", "Email mira@northwind.example if 3.5/4 slots fill up", "Commit 84f8fe9f0 shipped"]) {
    expect(shownTitle(sentence)).toBe(sentence);
    expect(shownTitle(sentence, true)).toBe(sentence);
  }
});

test("a Courier title is its first line, shortened, and 'New message' when only links and tokens were in it", () => {
  expect(shownTitle(EDIT_LINK, true)).toBe("New message");
  expect(shownTitle(`${EDIT_LINK}\nPlease review the terms`, true)).toBe("New message");
  expect(shownTitle(`  \nBearer ${JWT}  ${HEX}`, true)).toBe("New message");
  expect(shownTitle(`Room is ready: ${EDIT_LINK}\nSecond line`, true)).toBe("Room is ready: [link]");
  const long = shownTitle("word ".repeat(60), true);
  expect([...long].length).toBe(120);
  expect(long.endsWith("…")).toBe(true);
  // Only Courier's title becomes "New message"; another agent's link-only title shows where the link was.
  expect(shownTitle(EDIT_LINK)).toBe("[link]");
});

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function sqliteHandle(database: Database): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    query: async <T>(sql: string, params: (string | number | null | Uint8Array)[] = []) => {
      const statement = database.query(sql);
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
    execute,
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          const result = await execute(statement.sql, statement.params);
          if (!result.ok) throw new Error(result.error.message);
          results.push(result.data);
        }
        database.exec("COMMIT");
        return { ok: true, data: { results } };
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message);
  return result.data as T;
}

/** One connected agent under registry token `token`, holding `card`, read through the Home store. */
async function homeCard(token: string, card: FeedCard) {
  const handles = new Map<string, FeedDatabase>();
  const handle = (resource: string) => {
    let existing = handles.get(resource);
    if (!existing) { const database = new Database(":memory:"); databases.push(database); existing = sqliteHandle(database); handles.set(resource, existing); }
    return existing;
  };
  const registry = new Database(":memory:");
  databases.push(registry);
  handles.set(HOME_FEED_RESOURCE, sqliteHandle(registry));
  const client = { spaceId: "isolated-feed-title-test", hooks: {}, sql: { db: handle } };
  const source = createHomeFeedSource(useLocalThreadStorage(client as unknown as TinyCloudWeb));
  await source.load();
  const resources = value(feedResourceNames("xyz.tinycloud.tinychat/feed", token));
  const output = handle(resources.outputResource);
  value(await initializeFeedDatabases({ output, responses: handle(resources.responseResource) }));
  registry.query("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)")
    .run(token, "did:key:isolated-test-agent", "Relay agent", resources.outputResource, resources.responseResource, "{}");
  value(await publishFeedCard(output, card));
  return (await source.load()).entries[0]!.state.card;
}

const MESSAGE: FeedCard = {
  cardId: "isolated-card", revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true,
  title: EDIT_LINK, body: `${EDIT_LINK}\nPlease review the terms.`, urgency: 1, createdAt: "2026-11-24T00:00:00Z",
  payload: { type: "answer", channel: "courier", source: { label: "Mira · Northwind team" } },
};

test("Home titles the Courier connection's link-only message 'New message' and keeps its body; another agent's shows [link]", async () => {
  const courier = await homeCard(COURIER_SOURCE_ID, MESSAGE);
  expect(courier.title).toBe("New message");
  expect(courier.body).toBe(MESSAGE.body);
  // The same card from an agent that is not the Courier connection: its link still goes, but no summary is made.
  const other = await homeCard("isolatedtest", MESSAGE);
  expect(other.title).toBe("[link]");
});

test("a title shows the guard's removal as [link]; the body keeps the guard's own [link removed]", async () => {
  const card = await homeCard("isolatedtest", { ...MESSAGE, title: `Tap ${TAP} now`, body: `Use ${KEY} now`, payload: {} });
  expect(card.title).toBe("Tap [link] now");
  expect(card.body).toBe("Use [link removed] now");
});
