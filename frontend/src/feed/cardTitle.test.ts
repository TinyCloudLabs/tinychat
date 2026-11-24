/**
 * A card's title never shows a link or a token (TC-4253). One Courier card was titled with its message's first line,
 * a data-room edit link. A Courier card is titled by a short summary of that line, "New message" when nothing else was
 * in it; its body is shown as sent.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { feedResourceNames, initializeFeedDatabases, publishFeedCard, type FeedCard, type FeedDatabase } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { useLocalThreadStorage } from "../lib/threadStore";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";
import { heldAnswerKey } from "./answerOutbox";
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
  expect(shownTitle("Header Bearer [k7Qm2xZp9] set")).toBe("Header [hidden] set");
  expect(shownTitle("Header Bearer: k7Qm2xZp9 and Bearer=k7Qm2xZp9")).toBe("Header [hidden] and [hidden]");
  // "Bearer" is the header's word, capitalized; a ring bearer keeps hers, and the match never runs onto the next line.
  expect(shownTitle("Ask the ring bearer about it")).toBe("Ask the ring bearer about it");
  expect(shownTitle("Bearer\nk7Qm2xZp9")).toBe("Bearer\nk7Qm2xZp9");
  expect(shownTitle(`Key ${HEX} rotated`)).toBe("Key [hidden] rotated");
  expect(shownTitle(`Blob ${"Zm9vYmFy".repeat(4)}1== attached`)).toBe("Blob [hidden] attached");
  expect(shownTitle("Reply to reply+k7Qm2xZp9@courier.example.com")).toBe("Reply to [link]");
  for (const sentence of ["Can we move Thursday's review to Friday morning?", "Email mira@northwind.example if 3.5/4 slots fill up", "Commit 84f8fe9f0 shipped", "Use https: for every call"]) {
    expect(shownTitle(sentence)).toBe(sentence);
    expect(shownTitle(sentence, true)).toBe(sentence);
  }
});

test("a link or token disguised by invisible characters, fullwidth forms or another script is still taken out", () => {
  expect(shownTitle("Open ｈｔｔｐｓ：／／evil．example／x now")).toBe("Open [link] now");
  expect(shownTitle(`Key ${HEX.slice(0, 20)}\u200B${HEX.slice(20)} rotated`)).toBe("Key [hidden] rotated");
  expect(shownTitle(`Key ${HEX.slice(0, 20)}\u2800${HEX.slice(20)} rotated`)).toBe("Key [hidden] rotated");
  expect(shownTitle("Use Ｂearer k7Qm2xZp9 here")).toBe("Use [hidden] here");
  expect(shownTitle("Go to https:evil.example/x now")).toBe("Go to [link] now");
  expect(shownTitle("Docs at пример.рф/путь today")).toBe("Docs at [link] today");
  expect(shownTitle(`Blob ${"Zm9v.YmFy".repeat(4)}1= attached.`)).toBe("Blob [hidden] attached.");
});

test("a Courier title is its first line, shortened, and 'New message' when only links and tokens were in it", () => {
  expect(shownTitle(EDIT_LINK, true)).toBe("New message");
  expect(shownTitle(`${EDIT_LINK}\nPlease review the terms`, true)).toBe("New message");
  expect(shownTitle(`  \nBearer ${JWT}  ${HEX}`, true)).toBe("New message");
  expect(shownTitle(`Room is ready: ${EDIT_LINK}\nSecond line`, true)).toBe("Room is ready: [link]");
  for (const lineBreak of ["\r", "\r\n", "\u0085", "\u2028", "\u2029"]) {
    expect(shownTitle(`${EDIT_LINK}${lineBreak}Please review`, true)).toBe("New message");
  }
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
  const client = { spaceId: SPACE, hooks: {}, sql: { db: handle } };
  const source = createHomeFeedSource(useLocalThreadStorage(client as unknown as TinyCloudWeb));
  await source.load();
  const resources = value(feedResourceNames("xyz.tinycloud.tinychat/feed", token));
  const output = handle(resources.outputResource);
  value(await initializeFeedDatabases({ output, responses: handle(resources.responseResource) }));
  registry.query("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)")
    .run(token, "did:key:isolated-test-agent", "Relay agent", resources.outputResource, resources.responseResource, "{}");
  value(await publishFeedCard(output, card));
  return { source, output, card: (await source.load()).entries[0]!.state.card };
}

const SPACE = "isolated-feed-title-test";

const MESSAGE: FeedCard = {
  cardId: "isolated-card", revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true,
  title: EDIT_LINK, body: `${EDIT_LINK}\nPlease review the terms.`, urgency: 1, createdAt: "2026-11-24T00:00:00Z",
  payload: { type: "answer", channel: "courier", source: { label: "Mira · Northwind team" } },
};

test("Home titles the Courier connection's link-only message 'New message' and keeps its body; another agent's shows [link]", async () => {
  const { card: courier } = await homeCard(COURIER_SOURCE_ID, MESSAGE);
  expect(courier.title).toBe("New message");
  expect(courier.body).toBe(MESSAGE.body);
  // The same card from an agent that is not the Courier connection: its link still goes, but no summary is made.
  const { card: other } = await homeCard("isolatedtest", MESSAGE);
  expect(other.title).toBe("[link]");
});

test("a title shows the guard's removal as [link]; the body keeps the guard's own [link removed]", async () => {
  const { card } = await homeCard("isolatedtest", { ...MESSAGE, title: `Tap ${TAP} now`, body: `Use ${KEY} now`, payload: {} });
  expect(card.title).toBe("Tap [link] now");
  expect(card.body).toBe("Use [link removed] now");
});

test("an answer held for a revision since replaced comes back with that revision redacted: its title and its option's label", async () => {
  const cleanup = installDom();
  try {
    const asked: FeedCard = { ...MESSAGE, title: `Approve ${EDIT_LINK}?`, body: "Approve the room", payload: {}, choices: [{ id: "go", label: `Open ${TAP}` }] };
    const { source, output } = await homeCard("isolatedtest", asked);
    const held = { version: 2 as const, sourceId: "isolatedtest", cardId: asked.cardId, revision: 1, issuanceId: asked.issuanceId, responseId: "held-go", choiceId: "go", at: new Date().toISOString() };
    window.localStorage.setItem(heldAnswerKey(SPACE, held), JSON.stringify(held));
    // The agent asks something else before the held answer is sent: the owner is shown the card they answered.
    value(await publishFeedCard(output, { ...asked, revision: 2, title: "A different question", body: "Something else" }));
    const outcomes = await source.flushHeldAnswers!();
    expect(outcomes).toEqual([expect.objectContaining({ outcome: "replaced", choiceLabel: "Open [link removed]" })]);
    const answered = outcomes[0]!.answered!.state.card;
    expect(answered.title).toBe("Approve [link]?");
    expect(answered.choices?.[0]?.label).toBe("Open [link removed]");
  } finally { cleanup(); }
});
