// Main's meeting and feed/chat tools are listed while their area is off, so the bot's attempt reaches a call and its
// `off` refusal (the turn's step) lets the app offer the owner access at that moment. The call itself is still
// refused: it reads nothing, marks nothing, spends none of the day's reads and never waits on another read.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { FEED_CHAT_ERRORS, FEED_CHAT_TOOL_NAMES } from "../feed-chat-tools";
import { Gateway, type UpstreamFetch } from "../gateway";
import { type HeldStore, MeetingDesk, READ_ERRORS, READS_PER_DAY } from "../meeting-reads";
import { MEETING_TOOL_NAMES } from "../meeting-tools";
import { botIdFor } from "../owner";
import type { ReadArea } from "../reads";
import { TELEGRAM_TOOL_NAMES } from "../telegram-tools";

const OWNER = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const BOT = botIdFor(OWNER);
const SIBLING = botIdFor(OWNER, "e".repeat(32));
const TOKEN = "1".repeat(64);
const SIBLING_TOKEN = "2".repeat(64);
const CONVERSATION = "c".repeat(32);
const ORIGIN = "https://api.test";
const ALWAYS = [...MEETING_TOOL_NAMES, ...FEED_CHAT_TOOL_NAMES];

const cfg = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 5, botDailyPages: 5, globalDailySearches: 10, globalDailyPages: 10, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});

function setup(options: { forwardRefusals?: boolean; answer?: () => Promise<Response> } = {}) {
  const paths: string[] = [];
  const send: UpstreamFetch = async url => {
    paths.push(new URL(url).pathname);
    return options.answer ? options.answer() : Response.json({ ok: true, text: "Retrieved 1 meeting." });
  };
  const held: HeldStore & { saved?: Record<string, string> } = { load: () => undefined, save(marks) { held.saved = { ...marks }; } };
  const reads = new MeetingDesk({ backendOrigin: ORIGIN, backendCallSecret: "s".repeat(48), forwardRefusals: options.forwardRefusals, store: held, fetch: send });
  const gateway = new Gateway(cfg(), { fetch: async () => Response.json({}), store: { load: () => undefined, save: () => {} }, meetings: reads });
  gateway.setToken(BOT, TOKEN);
  const set = (areas: ReadArea[]) => expect(gateway.setReads(BOT, areas.length ? { areas, owner: OWNER, conversation: CONVERSATION } : { areas, conversation: CONVERSATION })).toBe(true);
  return { gateway, reads, paths, held, set };
}

let rpcId = 0;
type Reply = { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } };
const rpc = async (gateway: Gateway, method: string, params?: unknown, bot = BOT, token = TOKEN) =>
  (await (await gateway.handle(bot, new Request("http://localhost/v1/mcp/app", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  }))).json()) as Reply;
const listed = async (gateway: Gateway, bot = BOT, token = TOKEN) =>
  (await rpc(gateway, "tools/list", undefined, bot, token)).result!.tools!.map(tool => tool.name).filter(name => [...ALWAYS, ...TELEGRAM_TOOL_NAMES].includes(name as never));
const call = async (gateway: Gateway, name: string, args: Record<string, unknown> = {}) => {
  const result = (await rpc(gateway, "tools/call", { name, arguments: args })).result!;
  return { text: result.content![0]!.text, isError: result.isError === true };
};

let spy: { mockRestore(): void };
beforeEach(() => {
  spy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => spy.mockRestore());

describe("Main's tools/list", () => {
  test("offers the meeting and feed/chat tools while both areas are off, before and after a setting is pushed", async () => {
    const { gateway, set } = setup();
    expect(await listed(gateway)).toEqual(ALWAYS);
    set([]);
    expect(await listed(gateway)).toEqual(ALWAYS);
    set(["meetings", "feed_chats"]);
    expect(await listed(gateway)).toEqual(ALWAYS);
  });

  test("offers the Telegram tools only while Telegram is on", async () => {
    const { gateway, set } = setup();
    set(["meetings"]);
    expect(await listed(gateway)).toEqual(ALWAYS);
    set(["telegram"]);
    expect(await listed(gateway)).toEqual([...ALWAYS, ...TELEGRAM_TOOL_NAMES]);
    set([]);
    expect(await listed(gateway)).toEqual(ALWAYS);
  });

  test("a sibling bot of the same owner is offered no read tool", async () => {
    const { gateway } = setup();
    gateway.setToken(SIBLING, SIBLING_TOKEN, BOT);
    expect(gateway.setReads(SIBLING, { areas: [], conversation: CONVERSATION })).toBe(true);
    expect(await listed(gateway, SIBLING, SIBLING_TOKEN)).toEqual([]);
  });
});

describe("a Courier turn's tools", () => {
  test("still follow the areas the turn read, whatever Main is offered", () => {
    const { reads, set } = setup();
    set([]);
    expect(reads.tools(BOT, [])).toEqual([]);
    expect(reads.tools(BOT, ["meetings"]).map(tool => tool.name)).toEqual([...MEETING_TOOL_NAMES]);
    expect(reads.tools(BOT, ["feed_chats"]).map(tool => tool.name)).toEqual([...FEED_CHAT_TOOL_NAMES]);
  });
});

describe("a call to a listed tool whose area is off", () => {
  test("gives the area's off sentence as an error and reaches no backend", async () => {
    const { gateway, paths, set } = setup();
    for (const name of MEETING_TOOL_NAMES) expect(await call(gateway, name)).toEqual({ text: READ_ERRORS.off, isError: true });
    set(["meetings"]);
    for (const name of FEED_CHAT_TOOL_NAMES) expect(await call(gateway, name)).toEqual({ text: FEED_CHAT_ERRORS.off, isError: true });
    expect(paths).toEqual([]);
  });

  test("does not mark the conversation as holding owner data", async () => {
    const { gateway, held, set } = setup();
    set(["meetings"]);
    expect(await call(gateway, "list_chats")).toEqual({ text: FEED_CHAT_ERRORS.off, isError: true });
    expect(gateway.readsHeld(BOT)).toBe(false);
    expect(held.saved).toBeUndefined();
  });

  test("does not count against the day's reads", async () => {
    const { gateway, set } = setup();
    for (let i = 0; i < 5; i++) expect((await call(gateway, "tinycloud_read_meeting")).text).toBe(READ_ERRORS.off);
    set(["meetings"]);
    for (let i = 0; i < READS_PER_DAY; i++) expect((await call(gateway, "tinycloud_find_meetings")).isError).toBe(false);
    expect(await call(gateway, "tinycloud_find_meetings")).toEqual({ text: READ_ERRORS.budget, isError: true });
  });

  test("does not wait on, or block, a read that is running", async () => {
    let release!: () => void;
    const { gateway, paths, set } = setup({ answer: () => new Promise(resolve => { release = () => resolve(Response.json({ ok: true, text: "Retrieved 1 meeting." })); }) });
    set(["meetings"]);
    const running = call(gateway, "tinycloud_find_meetings");
    await Bun.sleep(0);
    expect(await call(gateway, "read_card", { card: "x" })).toEqual({ text: FEED_CHAT_ERRORS.off, isError: true });
    release();
    expect((await running).isError).toBe(false);
    expect(paths).toEqual(["/api/internal/bots/main/reads/tinycloud_find_meetings"]);
  });

  test("with standing-read refusals forwarded, sends only the audit report, and none while every area is off", async () => {
    const { gateway, paths, set } = setup({ forwardRefusals: true, answer: async () => new Response(null, { status: 204 }) });
    set([]);
    expect((await call(gateway, "list_chats")).text).toBe(FEED_CHAT_ERRORS.off);
    await Bun.sleep(0);
    expect(paths).toEqual([]);
    set(["meetings"]);
    expect((await call(gateway, "list_chats")).text).toBe(FEED_CHAT_ERRORS.off);
    await Bun.sleep(0);
    expect(paths).toEqual(["/api/internal/bots/main/reads/audit/refusal"]);
  });
});
