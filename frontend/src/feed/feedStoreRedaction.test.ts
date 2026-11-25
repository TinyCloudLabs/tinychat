/**
 * A card from an agent the owner connected never passes through the board's secret guard. The Home store hands the
 * feed that card without what the guard would have refused (a one-tap approval link, a key): not in its title, its
 * body or its plain payload, so it is on no part of the card, row or Details. The typed record is left as sent, so a
 * card the guard refuses stays unsupported rather than turning into a clean-looking one.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { feedResourceNames, initializeFeedDatabases, publishFeedCard, type FeedCard, type FeedDatabase } from "@tinycloud/sdk-services/feed";
import { useLocalThreadStorage } from "../lib/threadStore";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";
import { syntheticRecord } from "./sitrep.fixtures";
import { parseSitrepCardPayload } from "@tinyboilerplate/core/feed/sitrep";

const TAP = `https://openkey.so/a/${"a".repeat(26)}#v=4&k=${"A".repeat(43)}&c=bafkrei${"a".repeat(52)}`;
const KEY = `sk-ant-${"a1B2".repeat(8)}`;

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

async function connectedAgent(card: FeedCard) {
  const handles = new Map<string, FeedDatabase>();
  const handle = (resource: string) => {
    let existing = handles.get(resource);
    if (!existing) { const database = new Database(":memory:"); databases.push(database); existing = sqliteHandle(database); handles.set(resource, existing); }
    return existing;
  };
  const registry = new Database(":memory:");
  databases.push(registry);
  handles.set(HOME_FEED_RESOURCE, sqliteHandle(registry));
  const client = { spaceId: "isolated-feed-registry-test", hooks: {}, sql: { db: handle } };
  const source = createHomeFeedSource(useLocalThreadStorage(client as unknown as TinyCloudWeb));
  await source.load();
  const resources = value(feedResourceNames("xyz.tinycloud.tinychat/feed", "isolatedtest"));
  const output = handle(resources.outputResource);
  value(await initializeFeedDatabases({ output, responses: handle(resources.responseResource) }));
  registry.query("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)")
    .run("isolated-agent", "did:key:isolated-test-agent", "Test agent", resources.outputResource, resources.responseResource, "{}");
  value(await publishFeedCard(output, card));
  return source;
}

const base: FeedCard = { cardId: "isolated-card", revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true, title: "Original question", body: "Original body", urgency: 1, createdAt: "2026-10-29T00:00:00Z" };

test("a connected agent's title, body and plain payload reach the feed without a one-tap link or a key, and a clean card is untouched", async () => {
  const clean = (await (await connectedAgent({ ...base, payload: { note: "plain" } })).load()).entries[0]!.state.card;
  expect(clean).toMatchObject({ title: "Original question", body: "Original body", payload: { note: "plain" } });

  const source = await connectedAgent({ ...base, title: `Tap ${TAP} now`, body: `Use ${KEY}, then (${TAP}).`, payload: { summary: `Approve at ${TAP}`, note: "plain" } });
  const { state } = (await source.load()).entries[0]!;
  const shown = JSON.stringify([state.card.title, state.card.body, state.card.payload]);
  expect(shown).not.toContain("openkey.so/a/");
  expect(shown).not.toContain("A".repeat(43));
  expect(shown).not.toContain("sk-ant-");
  expect(state.card.title).toBe("Tap [link] now");
  expect(state.card.payload).toMatchObject({ note: "plain" });
});

test("a typed card the guard refuses keeps its record as sent, so it stays unsupported", async () => {
  const record = { ...syntheticRecord("ask"), body: `Open ${TAP} to approve.` };
  const source = await connectedAgent({ ...base, payload: { sitrep: { version: 1, record } } });
  const { state } = (await source.load()).entries[0]!;
  expect(parseSitrepCardPayload(state.card.payload?.sitrep)).toBeNull();
  expect(JSON.stringify(state.card.title) + JSON.stringify(state.card.body)).not.toContain("openkey.so/a/");
});

test("an answer button's label loses a key or a one-tap link, and its id, which a saved answer is matched on, is kept", async () => {
  const source = await connectedAgent({ ...base, choices: [{ id: "go", label: `Use ${KEY}` }, { id: "tap", label: TAP }, { id: "hold", label: "Hold" }] });
  const { choices } = (await source.load()).entries[0]!.state.card;
  expect(choices).toEqual([{ id: "go", label: "Use [link removed]" }, { id: "tap", label: "[link removed]" }, { id: "hold", label: "Hold" }]);
});
