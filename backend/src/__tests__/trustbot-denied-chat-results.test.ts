import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runFeedChatTool, type FeedChatSql } from "../trustbot-reads/feed-chat";

test("denied chat ids are excluded before limit and title matching, and direct reads are refused before SQL", async () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT)");
  db.run("INSERT INTO threads VALUES ('private', 'private matching title', '2026-11-23'), ('public', 'public matching title', '2026-11-22')");
  let queries = 0;
  const sql: FeedChatSql = { query: async (_database, statement, params) => { queries++; return db.query(statement).values(...params); } };
  try {
    const denied = new Set(["private"]);
    for (const args of [{ limit: 1 }, { query: "matching", limit: 1 }]) {
      const result = await runFeedChatTool("list_chats", args, sql, denied);
      expect(JSON.parse(result).chats).toEqual([{ chat: "public", title: "public matching title", updated_at: "2026-11-22" }]);
      expect(result).not.toContain("private");
    }
    queries = 0;
    await expect(runFeedChatTool("read_chat", { chat: "private" }, sql, denied)).rejects.toMatchObject({ code: "not_found" });
    expect(queries).toBe(0);
    expect(JSON.parse(await runFeedChatTool("list_chats", {}, sql, new Set())).chats.map((chat: { chat: string }) => chat.chat)).toEqual(["private", "public"]);
  } finally { db.close(); }
});
