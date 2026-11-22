import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { appendFeedResponse, type FeedDatabase, type NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { failureKind, observeFeedFailures, recentFeedFailures, recordAnswerFailure, resetFeedFailuresForTests } from "./feedFailures";

let restoreDom: () => void;
beforeEach(() => { restoreDom = installDom(); resetFeedFailuresForTests(); });
afterEach(() => { resetFeedFailuresForTests(); restoreDom(); });

const card = { cardId: "card-1", revision: 1, issuanceId: "issue-1", kind: "question", needsResponse: true, title: "t", body: "b", urgency: 1, createdAt: "2026-11-21T21:30:00.000Z" };
const response: NewFeedResponse = { responseId: "response-1", cardId: "card-1", revision: 1, issuanceId: "issue-1", kind: "answer", text: "yes", createdAt: "2026-11-21T21:30:05.000Z" };

/** A database whose reads find the card and whose every write fails as `fail` says. */
function database(fail: () => unknown): FeedDatabase {
  const read = async (sql: string) => sql.includes("feed_cards") ? { ok: true, data: { rows: [[JSON.stringify(card)]] } } : { ok: true, data: { rows: [] } };
  return { query: read, execute: async () => fail(), batch: async () => fail() } as unknown as FeedDatabase;
}

test("a failed answer names the node's status, which the SDK drops from its own result", async () => {
  const failing = observeFeedFailures(database(() => ({ ok: false, error: { code: "AUTH_EXPIRED", message: "SQL operation failed secret card text", service: "sql", meta: { status: 401 } } })));
  const started = Date.now();
  const result = await appendFeedResponse(failing, failing, response);
  expect(result.ok).toBe(false);
  expect(!result.ok && "meta" in result.error).toBe(false);
  recordAnswerFailure(new Error("Could not save the feed response and private payload"), started);
  expect(recentFeedFailures().map(({ op, kind }) => [op, kind])).toEqual([["write", "AUTH_EXPIRED/401"], ["answer", "AUTH_EXPIRED/401"]]);
  expect(JSON.stringify(recentFeedFailures())).not.toContain("secret card text");
});

test("a phone session error thrown before the request is named, though the SDK hides it", async () => {
  const failing = observeFeedFailures(database(() => { throw new Error("OpenKey renewal is temporarily unavailable"); }));
  const started = Date.now();
  const result = await appendFeedResponse(failing, failing, response);
  expect(result.ok === false && result.error.code).toBe("SQL_ERROR");
  recordAnswerFailure(new Error("Could not save the feed response and private payload"), started);
  expect(recentFeedFailures().map(({ kind }) => kind)).toEqual(["SESSION_RENEWAL_UNAVAILABLE", "SESSION_RENEWAL_UNAVAILABLE"]);
});

test("the log is kept on the device, holds the last 20 and never records an error's message", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(failureKind(new Error("alice@example.com asked about card 42"))).toBe("THROWN_Error");
    expect(failureKind({ code: "not a code with spaces", message: "x" })).toBe("THROWN");
    expect(failureKind({ code: "SQL_ERROR", meta: { status: 503 } })).toBe("SQL_ERROR/503");
    for (let index = 0; index < 25; index++) recordAnswerFailure(new Error("x"), Date.now() + 1000);
    expect(recentFeedFailures()).toHaveLength(20);
    expect(JSON.parse(window.localStorage.getItem("tinychat:feed-failures:v1") ?? "[]")).toHaveLength(20);
  } finally { warn.mockRestore(); }
});
