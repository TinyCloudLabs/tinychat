import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  CARD_BODY_CHARS,
  FEED_PREFIX,
  FeedChatReadError,
  HOME_FEED_DATABASE,
  listChats,
  listFeedCards,
  readCard,
  readChat,
  scopedFeedChatSql,
  THREADS_DATABASE,
  type FeedChatSql,
} from "../trustbot-reads/feed-chat.js";

const OUTPUT_A = `${FEED_PREFIX}/feed_output_alpha`;
const OUTPUT_B = `${FEED_PREFIX}/feed_output_beta`;
const CONNECTORS = "xyz.tinycloud.tinychat/connectors";

/** One SQLite file per database name, as the node keeps them; records every database a query reached. */
function space() {
  const databases = new Map<string, Database>();
  const reached: string[] = [];
  const db = (name: string) => {
    let found = databases.get(name);
    if (!found) databases.set(name, (found = new Database(":memory:")));
    return found;
  };
  db(HOME_FEED_DATABASE).run("CREATE TABLE feed_agents (agent_id TEXT PRIMARY KEY, agent_did TEXT, label TEXT, output_resource TEXT, response_resource TEXT, authorization_json TEXT)");
  db(THREADS_DATABASE).run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db(THREADS_DATABASE).run("CREATE TABLE messages (thread_id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, position))");
  db(THREADS_DATABASE).run("CREATE TABLE memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db(CONNECTORS).run("CREATE TABLE connector_meeting (id TEXT, title TEXT)");
  const sql: FeedChatSql = {
    async query(database, statement, params) {
      reached.push(database);
      return db(database).query(statement).values(...params) as unknown[][];
    },
  };
  const agent = (id: string, label: string, output: string) =>
    db(HOME_FEED_DATABASE).run("INSERT INTO feed_agents VALUES (?, 'did:key:z', ?, ?, ?, '{}')", [id, label, output, output.replace("feed_output_", "feed_responses_")]);
  const card = (output: string, card: Record<string, unknown>) => {
    const out = db(output);
    out.run("CREATE TABLE IF NOT EXISTS feed_cards (sequence INTEGER PRIMARY KEY, card_id TEXT, revision INTEGER, issuance_id TEXT, card_json TEXT)");
    out.run("INSERT INTO feed_cards (card_id, revision, issuance_id, card_json) VALUES (?, ?, 'i1', ?)", [String(card.cardId), Number(card.revision ?? 1), JSON.stringify(card)]);
  };
  const chat = (id: string, title: string, updated: string, messages: Array<[string, unknown[]]>) => {
    db(THREADS_DATABASE).run("INSERT INTO threads VALUES (?, ?, 'm', ?, ?)", [id, title, updated, updated]);
    messages.forEach(([role, content], position) =>
      db(THREADS_DATABASE).run("INSERT INTO messages VALUES (?, ?, ?, ?)", [id, position, JSON.stringify({ message: { id: `${id}-${position}`, role, content }, parentId: null }), updated]));
  };
  return { sql: scopedFeedChatSql(sql), raw: sql, reached, agent, card, chat };
}

const cardOf = (cardId: string, title: string, createdAt: string, extra: Record<string, unknown> = {}) =>
  ({ cardId, revision: 1, issuanceId: "i1", kind: "note", needsResponse: false, title, body: `${title} body`, urgency: 1, createdAt, ...extra });

describe("TrustBot feed and chat reads: scope", () => {
  it("refuses any database outside threads, home_feed and feed output databases", async () => {
    const s = space();
    for (const database of [CONNECTORS, `${FEED_PREFIX}/feed_responses_alpha`, `${FEED_PREFIX}/../connectors`, `${THREADS_DATABASE}/x`, "other.app/threads"]) {
      await expect(s.sql.query(database, "SELECT 1", [])).rejects.toBeInstanceOf(FeedChatReadError);
    }
    await expect(s.sql.query(THREADS_DATABASE, "DELETE FROM threads", [])).rejects.toBeInstanceOf(FeedChatReadError);
    await expect(s.sql.query(THREADS_DATABASE, "SELECT 1; DELETE FROM threads", [])).rejects.toBeInstanceOf(FeedChatReadError);
    expect(s.reached).toEqual([]);
  });

  it("never reads a database a registry row points outside the feed", async () => {
    const s = space();
    s.agent("good", "Good agent", OUTPUT_A);
    s.agent("bad", "Bad agent", CONNECTORS);
    s.card(OUTPUT_A, cardOf("c1", "Hello", "2026-11-20T10:00:00Z"));
    const { cards } = await listFeedCards(s.sql, {});
    expect(cards.map(card => card.agent)).toEqual(["good"]);
    await expect(readCard(s.sql, { agent: "bad", card: "c1" })).rejects.toMatchObject({ code: "not_found" });
    expect(s.reached).not.toContain(CONNECTORS);
  });

  it("reads only chat text, never the memory table or other parts", async () => {
    const s = space();
    s.chat("t1", "Trip", "2026-11-21T09:00:00Z", [["user", [{ type: "text", text: "Plan Lisbon" }, { type: "image", image: "data:x" }]], ["assistant", [{ type: "text", text: "Day one" }]], ["system", [{ type: "text", text: "hidden" }]]]);
    const read = await readChat(s.sql, { chat: "t1" });
    expect(read.messages.map(message => [message.role, message.text])).toEqual([["user", "Plan Lisbon"], ["assistant", "Day one"]]);
    expect(s.reached.every(database => database === THREADS_DATABASE)).toBe(true);
  });
});

describe("TrustBot feed and chat reads: results", () => {
  it("lists the latest revision of each card, newest first across agents", async () => {
    const s = space();
    s.agent("a", "Alpha", OUTPUT_A);
    s.agent("b", "Beta", OUTPUT_B);
    s.card(OUTPUT_A, cardOf("c1", "Old title", "2026-11-20T10:00:00Z"));
    s.card(OUTPUT_A, cardOf("c1", "New title", "2026-11-20T10:00:00Z", { revision: 2 }));
    s.card(OUTPUT_B, cardOf("c2", "Beta card", "2026-11-21T10:00:00Z", { needsResponse: true }));
    const { cards, partial } = await listFeedCards(s.sql, { limit: 10 });
    expect(partial).toBe(false);
    expect(cards.map(card => [card.agent_label, card.card, card.title, card.needs_response])).toEqual([["Beta", "c2", "Beta card", true], ["Alpha", "c1", "New title", false]]);
  });

  it("marks the list partial when one agent's database cannot be read", async () => {
    const s = space();
    s.agent("a", "Alpha", OUTPUT_A);
    s.agent("b", "Beta", OUTPUT_B); // no feed_cards table yet
    s.card(OUTPUT_A, cardOf("c1", "Hello", "2026-11-20T10:00:00Z"));
    const result = await listFeedCards(s.sql, {});
    expect(result.partial).toBe(true);
    expect(result.cards).toHaveLength(1);
  });

  it("reads one card with its choices and caps its body", async () => {
    const s = space();
    s.agent("a", "Alpha", OUTPUT_A);
    s.card(OUTPUT_A, cardOf("c1", "Pick", "2026-11-20T10:00:00Z", { body: "x".repeat(CARD_BODY_CHARS + 5), choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], payload: { link: "https://example.com" } }));
    const card = await readCard(s.sql, { agent: "a", card: "c1" });
    expect(card.body).toHaveLength(CARD_BODY_CHARS);
    expect(card.body_truncated).toBe(true);
    expect(card.choices).toEqual([{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]);
    expect(JSON.parse(card.payload!)).toEqual({ link: "https://example.com" });
    await expect(readCard(s.sql, { agent: "a", card: "missing" })).rejects.toMatchObject({ code: "not_found" });
    await expect(readCard(s.sql, { agent: "a" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("lists chats newest first and matches the title", async () => {
    const s = space();
    s.chat("t1", "Lisbon trip", "2026-11-20T09:00:00Z", []);
    s.chat("t2", "Tax questions", "2026-11-21T09:00:00Z", []);
    expect((await listChats(s.sql, {})).chats.map(chat => chat.chat)).toEqual(["t2", "t1"]);
    expect((await listChats(s.sql, { query: "LISBON" })).chats.map(chat => chat.chat)).toEqual(["t1"]);
    await expect(listChats(s.sql, { limit: 0 })).rejects.toMatchObject({ code: "invalid" });
  });

  it("reads a chat's latest messages oldest first and says when earlier ones exist", async () => {
    const s = space();
    s.chat("t1", "Long", "2026-11-21T09:00:00Z", Array.from({ length: 5 }, (_, n): [string, unknown[]] => [n % 2 ? "assistant" : "user", [{ type: "text", text: `m${n}` }]]));
    const read = await readChat(s.sql, { chat: "t1", limit: 2 });
    expect(read.messages.map(message => message.text)).toEqual(["m3", "m4"]);
    expect(read.earlier_messages).toBe(true);
    await expect(readChat(s.sql, { chat: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });
});
