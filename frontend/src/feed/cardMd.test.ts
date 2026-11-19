import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { FeedDatabase } from "@tinycloud/sdk-services/feed";
import { cardMdAgents, cardMdVersion, deliverCardMd, readCardMd, saveCardMd, seedCardMd } from "./cardMd";
import { CARD_MD_DEFAULT } from "./cardMdDefault";

/** A FeedDatabase over a real in-memory SQLite, answering in the node's shape (columns plus row arrays). */
function sqliteFeedDatabase(): FeedDatabase {
  const sqlite = new Database(":memory:");
  const run = (sql: string, params: unknown[] = []) => sqlite.query(sql).values(...(params as never[]));
  return {
    async query(sql: string, params?: unknown[]) {
      try {
        const statement = sqlite.query(sql);
        const rows = statement.values(...((params ?? []) as never[]));
        return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
      } catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error), service: "sql" } }; }
    },
    async execute(sql: string, params?: unknown[]) {
      try { run(sql, params); return { ok: true, data: { changes: sqlite.query("SELECT changes()").values()[0]![0], lastInsertRowId: 0 } }; }
      catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error), service: "sql" } }; }
    },
    async batch(statements: { sql: string; params?: unknown[] }[]) {
      try { sqlite.transaction(() => { for (const { sql, params } of statements) run(sql, params); })(); return { ok: true, data: { results: [] } }; }
      catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error), service: "sql" } }; }
    },
  } as unknown as FeedDatabase;
}

const at = new Date("2026-11-19T01:30:00.000Z");

test("the version is the first 12 hex of sha256 of the text, so equal text has an equal version", () => {
  expect(cardMdVersion("")).toBe("e3b0c44298fc");
  expect(cardMdVersion("abc")).toBe("ba7816bf8f01");
  expect(cardMdVersion("Plain words first.")).toBe(cardMdVersion("Plain words first."));
  expect(cardMdVersion("Plain words first.")).not.toBe(cardMdVersion("Plain words first!"));
});

test("a new space starts from the default, with its version, in the one row agents read", async () => {
  const db = sqliteFeedDatabase();
  await seedCardMd(db, at);
  expect(await readCardMd(db)).toEqual({ text: CARD_MD_DEFAULT, version: cardMdVersion(CARD_MD_DEFAULT), updatedAt: at.toISOString() });
  // The CLI's read, verbatim from the contract, sees the same row.
  const raw = await db.query<string>("SELECT text, version, updated_at FROM card_md WHERE id = 1");
  expect(raw.ok && raw.data.rows).toEqual([[CARD_MD_DEFAULT, cardMdVersion(CARD_MD_DEFAULT), at.toISOString()]]);
});

test("an owner's edit and an owner's clearing both survive a later seed, and each save changes the version", async () => {
  const db = sqliteFeedDatabase();
  await seedCardMd(db, at);
  const edited = await saveCardMd(db, "Use numbered steps.", new Date("2026-11-19T02:00:00.000Z"));
  expect(edited.version).toBe(cardMdVersion("Use numbered steps."));
  await seedCardMd(db, new Date("2026-11-19T03:00:00.000Z"));
  expect(await readCardMd(db)).toEqual(edited);

  const cleared = await saveCardMd(db, "", new Date("2026-11-19T04:00:00.000Z"));
  expect(cleared).toEqual({ text: "", version: "e3b0c44298fc", updatedAt: "2026-11-19T04:00:00.000Z" });
  await seedCardMd(db);
  expect(await readCardMd(db)).toEqual(cleared);

  // Reset to default is a save of the default text: the version returns to the default's.
  expect((await saveCardMd(db, CARD_MD_DEFAULT, at)).version).toBe(cardMdVersion(CARD_MD_DEFAULT));
  expect((await db.query<number>("SELECT COUNT(*) FROM card_md")).ok).toBe(true);
  const count = await db.query<number>("SELECT COUNT(*) FROM card_md");
  expect(count.ok && count.data.rows[0]![0]).toBe(1);
});

test("a save works on a space that has no card.md table, and a read without a row is null", async () => {
  const db = sqliteFeedDatabase();
  await expect(readCardMd(db)).rejects.toThrow();
  expect((await saveCardMd(db, "Hello", at)).text).toBe("Hello");
  const empty = sqliteFeedDatabase();
  await empty.batch([{ sql: "CREATE TABLE card_md (id INTEGER PRIMARY KEY, text TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL)" }]);
  expect(await readCardMd(empty)).toBeNull();
});

const agentRow = (token: string) => [token, "did:key:z" + token, token, `xyz.tinycloud.tinychat/feed/feed_output_${token}`, `xyz.tinycloud.tinychat/feed/feed_responses_${token}`];

async function registryOf(rows: unknown[][]): Promise<FeedDatabase> {
  const registry = sqliteFeedDatabase();
  await registry.batch([
    { sql: "CREATE TABLE feed_agents (agent_id TEXT PRIMARY KEY, agent_did TEXT NOT NULL, label TEXT NOT NULL, output_resource TEXT NOT NULL UNIQUE, response_resource TEXT NOT NULL UNIQUE, authorization_json TEXT NOT NULL DEFAULT '{}')" },
    ...rows.map((row) => ({ sql: "INSERT INTO feed_agents (agent_id, agent_did, label, output_resource, response_resource) VALUES (?, ?, ?, ?, ?)", params: row })),
  ]);
  return registry;
}

test("the registry names each connected agent's response database, and a row that isn't the feed's own pair is skipped", async () => {
  const registry = await registryOf([
    agentRow("inbox"), agentRow("weight"),
    ["stray", "did:key:zs", "Stray", "xyz.tinycloud.tinychat/feed/feed_output_stray", "xyz.tinycloud.tinychat/home_feed"],
  ]);
  expect(await cardMdAgents(registry)).toEqual([
    { sourceId: "inbox", responses: "xyz.tinycloud.tinychat/feed/feed_responses_inbox" },
    { sourceId: "weight", responses: "xyz.tinycloud.tinychat/feed/feed_responses_weight" },
  ]);
});

test("a save reaches every connected agent's response database, where the agent's own read sees it", async () => {
  const owner = sqliteFeedDatabase();
  const responses = new Map<string, FeedDatabase>();
  const database = (resource: string) => { if (!responses.has(resource)) responses.set(resource, sqliteFeedDatabase()); return responses.get(resource)!; };
  const agents = await cardMdAgents(await registryOf([agentRow("inbox"), agentRow("weight"), agentRow("trips")]));

  const saved = await saveCardMd(owner, "Use numbered steps.", at);
  expect(await deliverCardMd(saved, agents, database)).toEqual([{ sourceId: "inbox", ok: true }, { sourceId: "trips", ok: true }, { sourceId: "weight", ok: true }]);
  for (const agent of agents) {
    const read = await database(agent.responses).query<string>("SELECT text, version, updated_at FROM card_md WHERE id = 1");
    expect(read.ok && read.data.rows).toEqual([["Use numbered steps.", cardMdVersion("Use numbered steps."), at.toISOString()]]);
  }

  // The same version again changes nothing (another device, a retry); a new version replaces it.
  await deliverCardMd({ ...saved, updatedAt: "2026-11-19T09:00:00.000Z" }, agents, database);
  expect(await readCardMd(database(agents[0]!.responses))).toEqual(saved);
  const cleared = await saveCardMd(owner, "", new Date("2026-11-19T10:00:00.000Z"));
  await deliverCardMd(cleared, agents, database);
  expect(await readCardMd(database(agents[2]!.responses))).toEqual(cleared);
});

test("one agent's failed write doesn't stop the others", async () => {
  const record = { text: "Plain words first.", version: cardMdVersion("Plain words first."), updatedAt: at.toISOString() };
  const healthy = new Map<string, FeedDatabase>();
  const broken = { batch: async () => ({ ok: false, error: { code: "SQL_ERROR", message: "unavailable", service: "sql" } }) } as unknown as FeedDatabase;
  const throwing = { batch: async () => { throw new Error("network down"); } } as unknown as FeedDatabase;
  const agents = await cardMdAgents(await registryOf([agentRow("a"), agentRow("b"), agentRow("c"), agentRow("d")]));
  const database = (resource: string) => {
    if (resource.endsWith("_b")) return broken;
    if (resource.endsWith("_c")) return throwing;
    if (!healthy.has(resource)) healthy.set(resource, sqliteFeedDatabase());
    return healthy.get(resource)!;
  };
  expect(await deliverCardMd(record, agents, database)).toEqual([
    { sourceId: "a", ok: true }, { sourceId: "b", ok: false }, { sourceId: "c", ok: false }, { sourceId: "d", ok: true },
  ]);
  expect(await readCardMd(database("xyz.tinycloud.tinychat/feed/feed_responses_a"))).toEqual(record);
  expect(await readCardMd(database("xyz.tinycloud.tinychat/feed/feed_responses_d"))).toEqual(record);
});
