import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asksFile, type AsksGateway, AskStore, composeReply, DECLINE_COOLDOWN_MS, EXPIRY_MS, type NewAsk, parseAnswerInput, parseAsksPush,
  readAsksEnabled, REPLY_KEEP_MS, requestsFile, sweepAsks, syncAsks, writeAsksEnabled,
} from "../asks";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { Gateway } from "../gateway";
import { botLayout } from "../layout";

const T0 = Date.parse("2026-11-11T12:00:00Z");
const HOUR = 3_600_000;
const BOT_ID = "c".repeat(64);

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "asks-store-"));
  clock = T0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const roots = () => ({ dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
const layout = (botId = BOT_ID) => botLayout(botId, roots());
const store = (botId = BOT_ID) => new AskStore(layout(botId), () => clock);
const rawFiles = (botId = BOT_ID) => {
  const dir = layout(botId).dataDir;
  return existsSync(dir) ? readdirSync(dir).map(name => readFileSync(join(dir, name), "utf8")).join("\n") : "";
};

const QUESTION = "Which UNIQUE-QUESTION-city should I book?";
const ask = (id: string, over: Partial<NewAsk> = {}): NewAsk => ({ id, question: QUESTION, choices: ["Oslo", "Bergen"], askedAt: clock, outside: false, ...over });
const A = "a".repeat(24);
const B = "b".repeat(24);

describe("the owner's setting", () => {
  test("is on when nothing is saved, off when the file is damaged, and as saved otherwise", () => {
    expect(readAsksEnabled(layout())).toBe(true);
    writeAsksEnabled(layout(), true);
    expect(readAsksEnabled(layout())).toBe(true);
    writeFileSync(asksFile(layout()), "{not json");
    expect(readAsksEnabled(layout())).toBe(false);
    writeFileSync(asksFile(layout()), JSON.stringify({ enabled: "true" }));
    expect(readAsksEnabled(layout())).toBe(false);
    writeAsksEnabled(layout(), false);
    expect(readAsksEnabled(layout())).toBe(false);
  });

  test("reads as off and is logged when the saved setting can't be read, without logging what the file holds", () => {
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      mkdirSync(asksFile(layout()), { recursive: true });
      expect(readAsksEnabled(layout())).toBe(false);
      rmSync(asksFile(layout()), { recursive: true });
      writeFileSync(asksFile(layout()), JSON.stringify(["UNIQUE-SAVED-CONTENT"]));
      expect(readAsksEnabled(layout())).toBe(false);
      const lines = logs.mock.calls.map(call => String(call[0]));
      expect(lines).toEqual([
        JSON.stringify({ bots: "asks_setting_unreadable", bot: BOT_ID.slice(0, 12) }),
        JSON.stringify({ bots: "asks_setting_unreadable", bot: BOT_ID.slice(0, 12) }),
      ]);
      expect(lines.join("\n")).not.toContain("UNIQUE-SAVED-CONTENT");
    } finally {
      logs.mockRestore();
    }
  });

  test("a saved file without `enabled` reads as on, without a log; only a saved false is off", () => {
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      mkdirSync(layout().dataDir, { recursive: true });
      writeFileSync(asksFile(layout()), JSON.stringify({ outsideSeen: true }));
      expect(readAsksEnabled(layout())).toBe(true);
      writeFileSync(asksFile(layout()), JSON.stringify({}));
      expect(readAsksEnabled(layout())).toBe(true);
      writeFileSync(asksFile(layout()), JSON.stringify({ enabled: false, outsideSeen: true }));
      expect(readAsksEnabled(layout())).toBe(false);
      expect(logs).not.toHaveBeenCalled();
    } finally {
      logs.mockRestore();
    }
  });

  test("lives in the bot's data directory beside the web setting, never under the state that goes into a sandbox", () => {
    const { dataDir, stateSnapshot } = layout();
    expect(asksFile(layout())).toBe(join(dataDir, "asks.json"));
    expect(requestsFile(layout())).toBe(join(dataDir, "requests.json"));
    expect(requestsFile(layout()).startsWith(stateSnapshot + "/")).toBe(false);
    expect(asksFile(layout()).startsWith(stateSnapshot + "/")).toBe(false);
  });
});

describe("a request's life", () => {
  test("pending shows its question and choices; the same id collected twice is held once", () => {
    store().ingest([ask(A)]);
    store().ingest([ask(A), ask(B, { question: "Second?", choices: [] })]);
    expect(store().list()).toEqual([
      { id: A, kind: "ask", state: "pending", askedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + EXPIRY_MS).toISOString(), outside: false, question: QUESTION, choices: ["Oslo", "Bergen"] },
      { id: B, kind: "ask", state: "pending", askedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + EXPIRY_MS).toISOString(), outside: false, question: "Second?", choices: [] },
    ]);
  });

  test("an answer is stored as plain text, shown with `undelivered` until Main is told, and the question's text is gone at once", () => {
    store().ingest([ask(A)]);
    clock += 60_000;
    const result = store().answer(A, { decision: "answer", answer: "  Oslo\u202E  please\n" });
    expect(result).toEqual({
      ok: true,
      request: { id: A, kind: "ask", state: "answered", askedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + EXPIRY_MS).toISOString(), outside: false, resolvedAt: new Date(clock).toISOString(), answer: "Oslo please", undelivered: true },
    });
    expect(rawFiles()).not.toContain("UNIQUE-QUESTION");
    expect(store().reply(A)).toEqual({ text: "The person answered your question: Oslo please", decision: "answered" });
  });

  test("a choice becomes that choice's text; an index that is not one of them is invalid and leaves the request pending", () => {
    store().ingest([ask(A)]);
    for (const choice of [-1, 2, 1.5, 99]) expect(store().answer(A, { decision: "answer", choice })).toEqual({ ok: false, error: "invalid" });
    expect(store().list()[0]!.state).toBe("pending");
    expect(store().answer(A, { decision: "answer", choice: 1 })).toMatchObject({ ok: true, request: { state: "answered", answer: "Bergen" } });
  });

  test("an empty, blank or over-long answer is invalid, and 280 characters is the most", () => {
    store().ingest([ask(A)]);
    for (const answer of ["", "   ", "\u202E\u200B", "x".repeat(281)]) expect(store().answer(A, { decision: "answer", answer })).toEqual({ ok: false, error: "invalid" });
    expect(store().answer(A, { decision: "answer", answer: "é".repeat(280) })).toMatchObject({ ok: true });
  });

  test("a decline is shown as undelivered without any text, and composes the fixed sentence", () => {
    store().ingest([ask(A)]);
    expect(store().answer(A, { decision: "decline" })).toMatchObject({ ok: true, request: { state: "declined", undelivered: true } });
    expect(store().list()[0]).not.toHaveProperty("answer");
    expect(store().reply(A)).toEqual({
      text: "The person chose not to answer now. Carry on without it, and don’t ask again unless they bring it up.",
      decision: "declined",
    });
    expect(composeReply("declined")).toBe(store().reply(A)!.text);
  });

  test("only a pending request can be decided: not twice, not an unknown id, not one past its 24 hours", () => {
    store().ingest([ask(A), ask(B)]);
    expect(store().answer(A, { decision: "decline" })).toMatchObject({ ok: true });
    expect(store().answer(A, { decision: "answer", answer: "late" })).toEqual({ ok: false, error: "not_pending" });
    expect(store().answer("f".repeat(24), { decision: "decline" })).toEqual({ ok: false, error: "not_pending" });
    clock += EXPIRY_MS;
    expect(store().answer(B, { decision: "answer", answer: "too late" })).toEqual({ ok: false, error: "not_pending" });
  });

  test("an answer shows no `answer` once Main has been told, and the request keeps its metadata", () => {
    store().ingest([ask(A)]);
    store().answer(A, { decision: "answer", answer: "SECRET-ANSWER-text" });
    expect(rawFiles()).toContain("SECRET-ANSWER-text");
    store().delivered(A);
    expect(rawFiles()).not.toContain("SECRET-ANSWER-text");
    expect(store().reply(A)).toBeUndefined();
    const [request] = store().list();
    expect(request).toMatchObject({ id: A, state: "answered", outside: false });
    expect(request).not.toHaveProperty("answer");
    expect(request).not.toHaveProperty("undelivered");
    expect(request).not.toHaveProperty("question");
    expect(store().push().today).toBe(1);
  });

  test("a reply can be sent for a decided request only, and only until it is delivered", () => {
    store().ingest([ask(A)]);
    expect(store().reply(A)).toBeUndefined();
    expect(store().reply("f".repeat(24))).toBeUndefined();
    store().answer(A, { decision: "decline" });
    expect(store().reply(A)).toBeDefined();
    store().delivered(A);
    expect(store().reply(A)).toBeUndefined();
    store().delivered(A);
    expect(store().list()).toHaveLength(1);
  });

  test("an expired request sends no message, loses its question's text, and keeps its metadata", () => {
    store().ingest([ask(A)]);
    expect(rawFiles()).toContain("UNIQUE-QUESTION");
    clock += EXPIRY_MS - 1;
    expect(store().list()[0]!.state).toBe("pending");
    clock += 1;
    const [request] = store().list();
    expect(request).toEqual({ id: A, kind: "ask", state: "expired", askedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + EXPIRY_MS).toISOString(), outside: false, resolvedAt: new Date(T0 + EXPIRY_MS).toISOString() });
    expect(store().reply(A)).toBeUndefined();
    expect(rawFiles()).not.toContain("UNIQUE-QUESTION");
    expect(store().push()).toMatchObject({ pending: 0 });
  });

  test("an answer Main was never told is deleted after twelve hours, well inside the 24", () => {
    expect(REPLY_KEEP_MS).toBeLessThan(EXPIRY_MS);
    store().ingest([ask(A)]);
    store().answer(A, { decision: "answer", answer: "SECRET-ANSWER-text" });
    clock += REPLY_KEEP_MS - 1;
    expect(store().reply(A)).toBeDefined();
    clock += 1;
    expect(store().reply(A)).toBeUndefined();
    expect(rawFiles()).not.toContain("SECRET-ANSWER-text");
    expect(store().list()[0]).toMatchObject({ state: "answered" });
    expect(store().list()[0]).not.toHaveProperty("undelivered");
  });

  test("the sweep applies the clock to every bot's file with nobody asking, and skips bots that never had a question", () => {
    store().ingest([ask(A)]);
    store("d".repeat(64)).ingest([ask(B)]);
    mkdirSync(layout("e".repeat(64)).dataDir, { recursive: true });
    clock += EXPIRY_MS + 1;
    expect(sweepAsks(roots(), () => clock)).toBe(2);
    expect(rawFiles()).not.toContain("UNIQUE-QUESTION");
    expect(rawFiles("d".repeat(64))).not.toContain("UNIQUE-QUESTION");
  });

  test("metadata of resolved requests goes after a week; text never outlives its 24 hours", () => {
    store().ingest([ask(A)]);
    clock += EXPIRY_MS;
    expect(store().list()).toHaveLength(1);
    clock += 7 * 24 * HOUR;
    expect(store().list()).toEqual([]);
  });

  test("counts for the gateway: open ones, today's, and the questions declined within the hour", () => {
    store().ingest([ask(A), ask(B, { question: "Another?" })]);
    store().answer(A, { decision: "decline" });
    const push = store().push();
    expect(push.pending).toBe(1);
    expect(push.today).toBe(2);
    expect(push.day).toBe("2026-11-11");
    expect(push.declined).toEqual([{ hash: expect.stringMatching(/^[0-9a-f]{64}$/), until: clock + DECLINE_COOLDOWN_MS }]);
    clock += DECLINE_COOLDOWN_MS;
    expect(store().push().declined).toEqual([]);
  });

  test("a file somebody damaged reads as no requests rather than as an error", () => {
    mkdirSync(layout().dataDir, { recursive: true });
    writeFileSync(requestsFile(layout()), "{nope");
    expect(store().list()).toEqual([]);
    store().ingest([ask(A)]);
    expect(store().list()).toHaveLength(1);
  });
});

describe("what the owner's app may send", () => {
  test("an answer body is exactly a decline, or an answer with text, or an answer with a choice", () => {
    expect(parseAnswerInput({ decision: "decline" })).toEqual({ decision: "decline" });
    expect(parseAnswerInput({ decision: "answer", answer: "x" })).toEqual({ decision: "answer", answer: "x" });
    expect(parseAnswerInput({ decision: "answer", choice: 0 })).toEqual({ decision: "answer", choice: 0 });
    for (const bad of [null, [], "x", {}, { decision: "approve" }, { decision: "decline", answer: "x" }, { decision: "answer" }, { decision: "answer", answer: 1 },
      { decision: "answer", answer: "x", choice: 0 }, { decision: "answer", choice: "0" }, { decision: "answer", state: "answered", answer: "x" }]) {
      expect(parseAnswerInput(bad)).toBeUndefined();
    }
  });

  test("a push to the gateway carries counts and hashes, and nothing else", () => {
    expect(parseAsksPush({ enabled: true, pending: 1, day: "2026-11-11", today: 2, declined: [{ hash: "a".repeat(64), until: 5 }], turn: { outside: true } })).toBeDefined();
    for (const bad of [null, { enabled: 1 }, { enabled: true, pending: -1, day: "2026-11-11", today: 0, declined: [] }, { enabled: true, pending: 0, day: "today", today: 0, declined: [] },
      { enabled: true, pending: 0, day: "2026-11-11", today: 0, declined: [{ hash: "short", until: 1 }] }]) {
      expect(parseAsksPush(bad)).toBeUndefined();
    }
  });
});

const gatewayConfig = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});

describe("the supervisor and the gateway together", () => {
  const TOKEN = "1".repeat(64);

  function pair() {
    const gateway = new Gateway(gatewayConfig(), { fetch: async () => Response.json({}), now: () => clock, store: { load: () => undefined, save: () => {} } });
    gateway.setToken(BOT_ID, TOKEN);
    const adapter: AsksGateway = { drain: async () => ({ asks: gateway.drainAsks(BOT_ID) }), push: async body => gateway.setAsks(BOT_ID, body) };
    const call = async (question: string) => {
      const response = await gateway.handle(BOT_ID, new Request("http://localhost/v1/mcp/app", {
        method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_owner", arguments: { question } } }),
      }));
      return ((await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    };
    return { gateway, adapter, call };
  }

  test("the setting reaches the gateway, a question travels to the records, and the owner's decision comes back as a cooldown", async () => {
    const { adapter, call } = pair();
    expect((await call("Which city?")).isError).toBe(true);

    writeAsksEnabled(layout(), true);
    await syncAsks(layout(), adapter, { outside: false }, () => clock);
    const asked = await call("Which city?");
    expect(asked.isError).toBeUndefined();
    const { id } = JSON.parse(asked.content[0]!.text) as { id: string };

    await syncAsks(layout(), adapter, undefined, () => clock);
    expect(store().list()).toMatchObject([{ id, state: "pending", question: "Which city?", outside: false }]);

    store().answer(id, { decision: "decline" });
    await syncAsks(layout(), adapter, undefined, () => clock);
    expect((await call("which CITY?")).content[0]!.text).toContain("not now");

    writeAsksEnabled(layout(), false);
    await syncAsks(layout(), adapter, undefined, () => clock);
    expect((await call("Something else?")).isError).toBe(true);
  });

  test("questions asked in a turn are marked from what the supervisor said about the conversation, and a later turn does not clear it", async () => {
    const { adapter, call } = pair();
    writeAsksEnabled(layout(), true);
    await syncAsks(layout(), adapter, { outside: true }, () => clock);
    await call("From a relayed message?");
    await syncAsks(layout(), adapter, undefined, () => clock);
    await syncAsks(layout(), adapter, { outside: false }, () => clock);
    await call("From the owner, in a later turn?");
    await syncAsks(layout(), adapter, undefined, () => clock);
    expect(store().list().map(request => request.outside)).toEqual([true, true]);
  });

  test("the caps hold across collection: three open questions, then a fixed refusal", async () => {
    const { adapter, call } = pair();
    writeAsksEnabled(layout(), true);
    await syncAsks(layout(), adapter, undefined, () => clock);
    for (const question of ["a?", "b?", "c?"]) {
      expect((await call(question)).isError).toBeUndefined();
      await syncAsks(layout(), adapter, undefined, () => clock);
    }
    expect((await call("d?")).isError).toBe(true);
    expect(store().list()).toHaveLength(3);
  });

  test("a malformed collection is ignored rather than stored", async () => {
    writeAsksEnabled(layout(), true);
    const pushes: unknown[] = [];
    await syncAsks(layout(), { drain: async () => ({ asks: [{ id: "x", question: "q", choices: [], askedAt: clock, outside: false }] }), push: async body => void pushes.push(body) }, undefined, () => clock);
    expect(store().list()).toEqual([]);
    expect(pushes).toHaveLength(1);
  });
});

describe("logs", () => {
  test("the store and the sync log nothing, so no question or answer text can be in a log line", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(name => spyOn(console, name).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))));
    try {
      writeAsksEnabled(layout(), true);
      store().ingest([ask(A)]);
      store().answer(A, { decision: "answer", answer: "SECRET-ANSWER-text" });
      store().delivered(A);
      clock += EXPIRY_MS;
      store().list();
      sweepAsks(roots(), () => clock);
      await syncAsks(layout(), { drain: async () => ({ asks: [] }), push: async () => {} }, undefined, () => clock);
      expect(lines).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
