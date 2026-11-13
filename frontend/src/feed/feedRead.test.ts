import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFeedMessage,
  appendFeedResponse,
  getFeedCardState,
  initializeFeedDatabases,
  listFeedCardHistory,
  listFeedCards,
  listFeedResponses,
  publishFeedCard,
  readFeedResponseHandling,
  readFeedResponsePayload,
  recordFeedHandling,
  type FeedCard,
  type FeedDatabase,
} from "@tinycloud/sdk-services/feed";
import { FEED_READ_PAGE, OUTPUT_TALLY, readAgent, readTally, RESPONSES_TALLY } from "./feedRead";

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message);
  return result.data as T;
}

function sqlite(requests: string[]): FeedDatabase {
  const database = new Database(":memory:");
  databases.push(database);
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    query: async <T>(sql: string, params: (string | number | null | Uint8Array)[] = []) => {
      requests.push(sql);
      const statement = database.query(sql);
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
    execute,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(value(await execute(statement.sql, statement.params)));
      return { ok: true, data: { results } };
    },
  };
}

const card = (cardId: string, revision: number, title: string): FeedCard => ({ cardId, revision, issuanceId: `${cardId}-issuance`, kind: "ask", needsResponse: true, title, body: "Body", urgency: 1, createdAt: `2026-10-29T00:00:0${revision}Z`, choices: [{ id: "yes", label: "Yes" }] });

/** Two cards (one with two revisions), answers, a follow-up, a message, payloads and handling. */
async function seeded() {
  const requests: string[] = [];
  const output = sqlite(requests);
  const responses = sqlite(requests);
  value(await initializeFeedDatabases({ output, responses }));
  for (const published of [card("b-card", 1, "B one"), card("a-card", 1, "A one"), card("b-card", 2, "B two")]) value(await publishFeedCard(output, published));
  const answer = value(await appendFeedResponse(output, responses, { responseId: "r1", cardId: "a-card", revision: 1, issuanceId: "a-card-issuance", kind: "answer", choiceId: "yes", createdAt: "2026-10-29T01:00:00Z" }, { type: "sitrep.answer", version: 1, data: { text: "yes" } }));
  const followup = value(await appendFeedResponse(output, responses, { responseId: "r2", cardId: "a-card", revision: 1, issuanceId: "a-card-issuance", kind: "followup", text: "Actually", supersedesResponseId: "r1", createdAt: "2026-10-29T02:00:00Z" }));
  value(await appendFeedMessage(output, responses, { responseId: "m1", cardId: "b-card", revision: 2, issuanceId: "b-card-issuance", kind: "message", text: "Hello", createdAt: "2026-10-29T03:00:00Z" }));
  for (const [handlingId, phase] of [["h1", "acknowledged"], ["h2", "succeeded"]] as const) {
    value(await recordFeedHandling(output, { handlingId, responseId: followup.responseId, cardId: "a-card", revision: 1, issuanceId: "a-card-issuance", phase, createdAt: "2026-10-29T04:00:00Z" }));
  }
  requests.length = 0;
  return { output, responses, requests, answer, followup };
}

test("one read per database returns what the SDK's separate reads return", async () => {
  const { output, responses, requests, answer, followup } = await seeded();
  const read = await readAgent(output, responses);
  expect(requests).toHaveLength(2);

  expect(read.cards).toEqual(value(await listFeedCards(output)));
  expect(read.history).toEqual(value(await listFeedCardHistory(output, { limit: 1000 })).cards);
  expect(read.responses).toEqual(value(await listFeedResponses(responses, { limit: 1000 })));
  for (const response of read.responses) {
    const handling = await readFeedResponseHandling(output, response);
    expect(read.handling(response)).toEqual(handling.ok ? handling.data : undefined);
    expect(read.payload(response)).toEqual(value(await readFeedResponsePayload(responses, response)));
  }
  expect(read.handling(answer)).toBeUndefined();
  expect(read.handling(followup)?.outcome?.phase).toBe("succeeded");
  for (const identity of read.history) expect(read.cardState(identity)).toEqual(value(await getFeedCardState(output, responses, identity)));
  expect(read.cardState({ cardId: "missing", revision: 1, issuanceId: "x" })).toBeUndefined();
});

test("the read's tally is the fingerprint's, from the same snapshot", async () => {
  const { output, responses } = await seeded();
  const read = await readAgent(output, responses);
  expect(read.tally).toEqual([...await readTally(output, OUTPUT_TALLY), ...await readTally(responses, RESPONSES_TALLY)]);
  value(await publishFeedCard(output, card("c-card", 1, "C one")));
  expect((await readAgent(output, responses)).tally).not.toEqual(read.tally);
});

test("past a page of rows, the read pages as the SDK's list reads do and still matches them", async () => {
  const requests: string[] = [];
  const output = sqlite(requests);
  const responses = sqlite(requests);
  value(await initializeFeedDatabases({ output, responses }));
  for (let index = 0; index <= FEED_READ_PAGE; index++) value(await publishFeedCard(output, card(`card-${String(index).padStart(4, "0")}`, 1, `Card ${index}`)));
  requests.length = 0;
  const read = await readAgent(output, responses);
  // Output: a full page of cards, then the rest; responses: one short page.
  expect(requests).toHaveLength(3);
  const history = [...value(await listFeedCardHistory(output, { limit: 1000 })).cards, ...value(await listFeedCardHistory(output, { limit: 1000, afterIdentity: { cardId: "card-0999", revision: 1, issuanceId: "card-0999-issuance" } })).cards];
  expect(read.history).toEqual(history);
  expect(read.cards).toEqual(value(await listFeedCards(output)));
  expect(read.tally).toEqual([...await readTally(output, OUTPUT_TALLY), ...await readTally(responses, RESPONSES_TALLY)]);
});

test("a payload read for a response the database does not hold fails as the SDK's does", async () => {
  const { output, responses } = await seeded();
  const read = await readAgent(output, responses);
  expect(() => read.payload({ responseId: "r1", cardId: "b-card", revision: 1, issuanceId: "b-card-issuance" })).toThrow("does not match a saved response");
});
