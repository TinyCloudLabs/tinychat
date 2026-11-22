import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ASK_ERRORS, DECLINE_COOLDOWN_MS, questionHash, utcDay } from "../asks";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { type BudgetSnapshot, type BudgetStore, Gateway, type UpstreamFetch } from "../gateway";

const BOT = "a".repeat(64);
const OTHER = "b".repeat(64);
const TOKEN = "1".repeat(64);
const OTHER_TOKEN = "2".repeat(64);
const NOW = Date.parse("2026-11-11T12:00:00Z");

const cfg = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});

const memoryStore = (): BudgetStore => {
  let saved: BudgetSnapshot | undefined;
  return { load: () => saved, save: snapshot => void (saved = structuredClone(snapshot)) };
};

const upstream: UpstreamFetch = async url =>
  new URL(url).pathname === "/search" ? Response.json({ results: [{ url: "https://docs.example.com/g", title: "G", content: "text" }] }) : Response.json({ ok: true, text: "page" });

/** Two bots of one owner (`BOT` and `OTHER`) and, for the owner-wide caps, nothing else. */
function setup(now = () => NOW) {
  const gateway = new Gateway(cfg(), { fetch: upstream, now, store: memoryStore() });
  gateway.setToken(BOT, TOKEN);
  gateway.setToken(OTHER, OTHER_TOKEN, BOT);
  return gateway;
}

const idle = { pending: 0, day: utcDay(NOW), today: 0, declined: [] };
const on = (gateway: Gateway, bot = BOT, extra: Partial<Parameters<Gateway["setAsks"]>[1]> = {}) => gateway.setAsks(bot, { enabled: true, ...idle, ...extra });

let rpcId = 0;
const rpc = (path: string, method: string, params?: unknown, token = TOKEN) =>
  new Request(`http://localhost${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });

type Reply = { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean }; error?: { code: number } };
const reply = async (response: Response) => (await response.json()) as Reply;

async function ask(gateway: Gateway, args: Record<string, unknown>, bot = BOT, token = TOKEN) {
  const body = await reply(await gateway.handle(bot, rpc("/v1/mcp/app", "tools/call", { name: "ask_owner", arguments: args }, token)));
  return { text: body.result!.content![0]!.text, isError: body.result!.isError === true };
}
const tools = async (gateway: Gateway, path = "/v1/mcp/app") => (await reply(await gateway.handle(BOT, rpc(path, "tools/list")))).result!.tools!.map(tool => tool.name);

let lines: string[];
let spy: { mockRestore(): void };
beforeEach(() => {
  lines = [];
  spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
});
afterEach(() => spy.mockRestore());

describe("the app MCP server while the owner's setting is off", () => {
  test("offers no tool, refuses the call with a fixed sentence, and keeps nothing", async () => {
    const gateway = setup();
    expect(await tools(gateway)).toEqual([]);
    expect(await ask(gateway, { question: "Which city?" })).toEqual({ text: ASK_ERRORS.off, isError: true });
    expect(gateway.drainAsks(BOT)).toEqual([]);
  });

  test("is still off after the owner switches it on and off again, and for a bot nobody has pushed a setting for", async () => {
    const gateway = setup();
    on(gateway);
    expect(await tools(gateway)).toEqual(["ask_owner", "request_secret"]);
    gateway.setAsks(BOT, { enabled: false, ...idle });
    expect(await tools(gateway)).toEqual([]);
    expect(await ask(gateway, { question: "Which city?" })).toEqual({ text: ASK_ERRORS.off, isError: true });
    expect(await ask(gateway, { question: "Which city?" }, OTHER, OTHER_TOKEN)).toEqual({ text: ASK_ERRORS.off, isError: true });
    expect(gateway.drainAsks(BOT)).toEqual([]);
    expect(gateway.drainAsks(OTHER)).toEqual([]);
  });

  test("the gateway forgets the setting when the bot's sandbox goes, so a restarted gateway reads as off", async () => {
    const gateway = setup();
    on(gateway);
    gateway.dropToken(BOT);
    gateway.setToken(BOT, TOKEN);
    expect(await tools(gateway)).toEqual([]);
    expect(await ask(gateway, { question: "Which city?" })).toEqual({ text: ASK_ERRORS.off, isError: true });
  });
});

describe("the two MCP servers stay apart", () => {
  test("web tools are not on the app server and ask_owner is not on the web server", async () => {
    const gateway = setup();
    on(gateway);
    expect(await tools(gateway, "/v1/mcp")).toEqual(["search", "fetch"]);
    const web = await reply(await gateway.handle(BOT, rpc("/v1/mcp", "tools/call", { name: "ask_owner", arguments: { question: "Which city?" } })));
    expect(web.error?.code).toBe(-32602);
    const app = await reply(await gateway.handle(BOT, rpc("/v1/mcp/app", "tools/call", { name: "search", arguments: { query: "x" } })));
    expect(app.error?.code).toBe(-32602);
    expect(gateway.drainAsks(BOT)).toEqual([]);
  });

  test("the app server needs the bot's own token too", async () => {
    const gateway = setup();
    on(gateway);
    expect((await gateway.handle(BOT, rpc("/v1/mcp/app", "tools/list", undefined, OTHER_TOKEN))).status).toBe(403);
    expect((await gateway.handle(BOT, rpc("/v1/mcp/app", "tools/list", undefined, "3".repeat(64)))).status).toBe(403);
  });
});

describe("ask_owner with the setting on", () => {
  test("answers only the id and the state, and holds the checked question for the supervisor", async () => {
    const gateway = setup();
    on(gateway);
    const result = await ask(gateway, { question: "  Which   city?  ", choices: ["Oslo", "Bergen"] });
    expect(result.isError).toBe(false);
    const answer = JSON.parse(result.text) as Record<string, unknown>;
    expect(Object.keys(answer).sort()).toEqual(["id", "state"]);
    expect(answer.state).toBe("pending");
    expect(answer.id).toMatch(/^[0-9a-f]{24}$/);
    expect(result.text).not.toContain("city");
    expect(gateway.drainAsks(BOT)).toEqual([{ id: String(answer.id), question: "Which city?", choices: ["Oslo", "Bergen"], askedAt: NOW, outside: false }]);
    expect(gateway.drainAsks(BOT)).toEqual([]);
  });

  test("refuses what is not a short plain question, without shortening it", async () => {
    const gateway = setup();
    on(gateway);
    const bad: Array<Record<string, unknown>> = [
      {}, { question: "" }, { question: "   " }, { question: "x".repeat(281) }, { question: 5 }, { question: "ok", choices: "a" },
      { question: "ok", choices: ["a", "b", "c", "d", "e"] }, { question: "ok", choices: ["x".repeat(61)] }, { question: "ok", choices: [""] },
      { question: "ok", choices: [1] }, { question: "ok", extra: true },
    ];
    for (const args of bad) expect(await ask(gateway, args)).toEqual({ text: ASK_ERRORS.invalid, isError: true });
    expect(gateway.drainAsks(BOT)).toEqual([]);
    expect((await ask(gateway, { question: "x".repeat(280), choices: ["a", "b", "c", "d"] })).isError).toBe(false);
    expect((await ask(gateway, { question: "y", choices: ["z".repeat(60)] })).isError).toBe(false);
    expect(gateway.drainAsks(BOT).map(entry => entry.kind === undefined ? entry.question.length : -1)).toEqual([280, 1]);
  });

  test("the limits count characters, not bytes", async () => {
    const gateway = setup();
    on(gateway);
    expect((await ask(gateway, { question: "é".repeat(280) })).isError).toBe(false);
    expect((await ask(gateway, { question: "é".repeat(281) })).isError).toBe(true);
  });

  test("shows the text as plain text: control and direction characters go, and markup is left as written", async () => {
    const gateway = setup();
    on(gateway);
    await ask(gateway, { question: "a\u202Eb\u0000c\u200Bd\ne\u2028f", choices: ["**x**\u0007", "[link](https://e.test)"] });
    expect(gateway.drainAsks(BOT)).toMatchObject([{ question: "abcd e f", choices: ["**x**", "[link](https://e.test)"] }]);
  });
});

describe("the limits", () => {
  test("three open questions at most, with a fixed sentence after that", async () => {
    const gateway = setup();
    on(gateway);
    for (const question of ["one", "two", "three"]) expect((await ask(gateway, { question })).isError).toBe(false);
    expect(await ask(gateway, { question: "four" })).toEqual({ text: ASK_ERRORS.pending, isError: true });
    expect(gateway.drainAsks(BOT)).toHaveLength(3);
    // Collected is not answered: the supervisor's count says what it holds, and the cap holds across the collection.
    expect(await ask(gateway, { question: "four" })).toEqual({ text: ASK_ERRORS.pending, isError: true });
    on(gateway, BOT, { pending: 2, today: 3 });
    expect((await ask(gateway, { question: "four" })).isError).toBe(false);
  });

  test("ten a day at most, counted from the supervisor's push and the uncollected ones", async () => {
    const gateway = setup();
    on(gateway, BOT, { today: 9 });
    expect((await ask(gateway, { question: "ten" })).isError).toBe(false);
    expect(await ask(gateway, { question: "eleven" })).toEqual({ text: ASK_ERRORS.daily, isError: true });
    on(gateway, BOT, { today: 10 });
    expect(await ask(gateway, { question: "twelve" })).toEqual({ text: ASK_ERRORS.daily, isError: true });
    // A new UTC day starts the count again.
    on(gateway, BOT, { today: 10, day: "2026-11-10" });
    expect((await ask(gateway, { question: "twelve" })).isError).toBe(false);
  });

  test("the caps are the owner's, whichever of their bots asks", async () => {
    const gateway = setup();
    on(gateway);
    on(gateway, OTHER);
    expect((await ask(gateway, { question: "one" })).isError).toBe(false);
    expect((await ask(gateway, { question: "two" })).isError).toBe(false);
    expect((await ask(gateway, { question: "three" }, OTHER, OTHER_TOKEN)).isError).toBe(false);
    expect(await ask(gateway, { question: "four" }, OTHER, OTHER_TOKEN)).toEqual({ text: ASK_ERRORS.pending, isError: true });
    expect(await ask(gateway, { question: "four" })).toEqual({ text: ASK_ERRORS.pending, isError: true });

    const daily = setup();
    on(daily, BOT, { today: 6 });
    on(daily, OTHER, { today: 4 });
    expect(await ask(daily, { question: "one" })).toEqual({ text: ASK_ERRORS.daily, isError: true });
  });

  test("a question the owner said not now to is refused for an hour, however it is spaced or cased", async () => {
    let clock = NOW;
    const gateway = setup(() => clock);
    const declinedAt = NOW - 10 * 60_000;
    on(gateway, BOT, { declined: [{ hash: questionHash("Which city?"), until: declinedAt + DECLINE_COOLDOWN_MS }] });
    expect(await ask(gateway, { question: "  WHICH   city? " })).toEqual({ text: ASK_ERRORS.recent, isError: true });
    expect((await ask(gateway, { question: "Which country?" })).isError).toBe(false);
    clock = declinedAt + DECLINE_COOLDOWN_MS + 1;
    expect((await ask(gateway, { question: "Which city?" })).isError).toBe(false);
  });
});

describe("whether the turn took in outside text", () => {
  test("a web call marks the question, and no later push says the conversation is clean again", async () => {
    const gateway = setup();
    on(gateway);
    await ask(gateway, { question: "before" });
    await gateway.handle(BOT, rpc("/v1/mcp", "tools/call", { name: "search", arguments: { query: "anything" } }));
    await ask(gateway, { question: "after" });
    expect(gateway.drainAsks(BOT).map(entry => entry.outside)).toEqual([false, true]);
    expect(gateway.asksOutside(BOT)).toBe(true);

    on(gateway, BOT, { turn: { outside: false } });
    await ask(gateway, { question: "next turn" });
    expect(gateway.drainAsks(BOT).map(entry => entry.outside)).toEqual([true]);
  });

  test("the flag goes with the sandbox: the next one starts from what the supervisor gives", async () => {
    const gateway = setup();
    on(gateway);
    await gateway.handle(BOT, rpc("/v1/mcp", "tools/call", { name: "search", arguments: { query: "anything" } }));
    expect(gateway.asksOutside(BOT)).toBe(true);
    gateway.dropToken(BOT);
    gateway.setToken(BOT, TOKEN);
    expect(gateway.asksOutside(BOT)).toBe(false);
    on(gateway, BOT, { turn: { outside: true } });
    expect(gateway.asksOutside(BOT)).toBe(true);
  });

  test("a turn that began with a relayed message from another bot is marked from its start", async () => {
    const gateway = setup();
    on(gateway, BOT, { turn: { outside: true } });
    await ask(gateway, { question: "relayed" });
    expect(gateway.drainAsks(BOT).map(entry => entry.outside)).toEqual([true]);
  });

  test("a web call by one bot marks nothing for another", async () => {
    const gateway = setup();
    on(gateway);
    on(gateway, OTHER);
    await gateway.handle(BOT, rpc("/v1/mcp", "tools/call", { name: "search", arguments: { query: "anything" } }));
    await ask(gateway, { question: "mine" }, OTHER, OTHER_TOKEN);
    expect(gateway.drainAsks(OTHER).map(entry => entry.outside)).toEqual([false]);
  });
});

describe("what the gateway logs", () => {
  test("outcome counts only: no question, choice or id appears in any line", async () => {
    const gateway = setup();
    on(gateway);
    const secret = "SECRET-QUESTION-9f3a";
    const choice = "SECRET-CHOICE-77b1";
    const results = [
      await ask(gateway, { question: secret, choices: [choice] }),
      await ask(gateway, { question: secret + "x".repeat(300) }),
      await ask(gateway, { question: secret, choices: [choice], extra: 1 }),
    ];
    gateway.setAsks(BOT, { enabled: false, ...idle });
    results.push(await ask(gateway, { question: secret }));
    const id = (JSON.parse(results[0]!.text) as { id: string }).id;
    const logged = lines.filter(line => line.includes('"asks"'));
    expect(logged).toHaveLength(4);
    for (const line of lines) {
      expect(line).not.toContain("SECRET");
      expect(line).not.toContain(id);
    }
    expect(logged.map(line => (JSON.parse(line) as { outcome: string }).outcome)).toEqual(["asked", "invalid", "invalid", "off"]);
  });
});
