/**
 * Memory written from a chat that held outside content is marked, in the same write, and a reload (a new session over
 * the same stored rows) reads that back. Real store code over SQLite :memory:.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { writeExtractedMemory } from "../chat/extractedMemory";
import { markOutsideContent, resetImageGateForTests } from "./imageGate";
import { clearMemory, getMemory, getMemoryMarked, resetMemoryToTemplate, setMemory } from "./threadStore";
import { MEMORY_TEMPLATE } from "./memory";

afterEach(() => resetImageGateForTests());

function account(options: { failMarkRead?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (options.failMarkRead && params.includes("user_context_marked")) return { ok: false, error: { code: "TEST", message: "unreadable" } };
      return { ok: true, data: { rows: sqlite.query(sql).values(...(params as never[])) } };
    },
    execute: async (sql: string, params: unknown[] = []) => { sqlite.query(sql).run(...(params as never[])); return { ok: true, data: { changes: 1 } }; },
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      sqlite.transaction(() => { for (const statement of statements) sqlite.query(statement.sql).run(...((statement.params ?? []) as never[])); })();
      return { ok: true, data: { results: [] } };
    },
  };
  const did = `did:test:memory-mark:${crypto.randomUUID()}`;
  // A session is a new object over the same stored rows, as after a reload.
  return { sqlite, session: () => ({ did, sql: { db: () => db } }) as unknown as TinyCloudWeb };
}

test("a memory written from a marked chat is marked, and a reload reads that back", async () => {
  const stored = account();
  await setMemory(stored.session(), "- likes tea", { outside: true });
  expect(await getMemoryMarked(stored.session())).toBe(true);
});

test("a memory written from a chat with no outside content is not marked", async () => {
  const stored = account();
  await setMemory(stored.session(), "- likes tea");
  expect(await getMemoryMarked(stored.session())).toBe(false);
});

test("a later write from a clean chat, or an edit by the owner, does not clear the mark", async () => {
  const stored = account();
  await setMemory(stored.session(), "- likes tea", { outside: true });
  await setMemory(stored.session(), "- likes tea\n- lives by the sea");
  expect(await getMemoryMarked(stored.session())).toBe(true);
  expect(await getMemory(stored.session())).toBe("- likes tea\n- lives by the sea");
});

test("only the owner starting the memory over (reset or clear) ends the mark", async () => {
  for (const startOver of [resetMemoryToTemplate, clearMemory]) {
    const stored = account();
    await setMemory(stored.session(), "- likes tea", { outside: true });
    await startOver(stored.session());
    expect(await getMemoryMarked(stored.session())).toBe(false);
  }
});

test("a marker that cannot be read is not proof of a clean memory", async () => {
  const stored = account({ failMarkRead: true });
  await setMemory(stored.session(), "- likes tea");
  expect(await getMemoryMarked(stored.session())).toBe(true);
});

test("an extraction's write is marked exactly when its chat holds outside content", async () => {
  const stored = account();
  await writeExtractedMemory(stored.session(), "clean-chat", "- likes tea");
  expect(await getMemoryMarked(stored.session())).toBe(false);
  markOutsideContent("marked-chat");
  await writeExtractedMemory(stored.session(), "marked-chat", "- likes tea\n- a note");
  expect(await getMemoryMarked(stored.session())).toBe(true);
});

// Memory saved before the marker existed (or by a clean chat): marked only if it holds a URL, an image or a link.
function withoutMarker(stored: ReturnType<typeof account>) {
  stored.sqlite.query("DELETE FROM memory WHERE id = 'user_context_marked'").run();
}

test("a memory with no marker and no URL, image or link is clean; an empty or template one too", async () => {
  for (const doc of ["- likes tea\n- lives by the sea", "", MEMORY_TEMPLATE]) {
    const stored = account(); // one account per doc: a blank doc after a non-blank one would be served from the backup
    await setMemory(stored.session(), doc);
    withoutMarker(stored);
    expect(await getMemoryMarked(stored.session())).toBe(false);
  }
});

test("a memory with no marker is marked when it holds a URL, an image or a link", async () => {
  for (const doc of [
    "- reads https://example.com/page",
    "- see http://example.com",
    "- ![x](example.png)",
    "- [notes](example.png)",
    "- [notes][1]\n\n[1]: example.png",
    "- see <https://example.com>",
  ]) {
    const stored = account();
    await setMemory(stored.session(), doc);
    withoutMarker(stored);
    expect(await getMemoryMarked(stored.session())).toBe(true);
  }
});

test("a clean chat's write over such a memory records the mark, so a rewrite that drops the link stays marked", async () => {
  const stored = account();
  await setMemory(stored.session(), "- reads https://example.com/page");
  withoutMarker(stored);
  await setMemory(stored.session(), "- reads a page");
  expect(await getMemoryMarked(stored.session())).toBe(true);
});

test("a marker read that fails is not recorded as clean: the next read tells the truth", async () => {
  const options = { failMarkRead: false };
  const stored = account(options);
  await setMemory(stored.session(), "- likes tea", { outside: true });
  const session = stored.session();
  options.failMarkRead = true;
  expect(await getMemoryMarked(session)).toBe(true); // unreadable and nothing known
  options.failMarkRead = false;
  expect(await getMemoryMarked(session)).toBe(true); // re-read, not a cached "clean"
});

test("when the live memory is blank and the last-known-good backup is served in its place, the restore counts as marked", async () => {
  const stored = account();
  await setMemory(stored.session(), "- likes tea");
  await setMemory(stored.session(), ""); // the owner blanks it; the previous doc is kept as the backup
  expect(await getMemory(stored.session())).toBe("- likes tea"); // the backup is what a chat would load
  expect(await getMemoryMarked(stored.session())).toBe(true);
});
