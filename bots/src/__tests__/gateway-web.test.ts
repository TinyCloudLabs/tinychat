import { describe, expect, test } from "bun:test";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { type BudgetSnapshot, type BudgetStore, Gateway, type UpstreamFetch } from "../gateway";
import { WEB_ERRORS } from "../web";

const BOT = "a".repeat(64);
const OTHER = "b".repeat(64);
const TOKEN = "1".repeat(64);
const OTHER_TOKEN = "2".repeat(64);

const cfg = (web: Partial<NonNullable<GatewayConfig["web"]>> = {}): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000, ...web },
});

const memoryStore = (): BudgetStore & { saved?: BudgetSnapshot } => {
  const store: BudgetStore & { saved?: BudgetSnapshot } = { load: () => store.saved, save: snapshot => void (store.saved = structuredClone(snapshot)) };
  return store;
};

function setup(web: Partial<NonNullable<GatewayConfig["web"]>> = {}, respond?: (path: string, body: Record<string, unknown>) => Response | Promise<Response>, store = memoryStore()) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetchImpl: UpstreamFetch = async (url, init) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push({ url, body, headers: new Headers(init.headers) });
    const path = new URL(url).pathname;
    return respond ? respond(path, body) : path === "/search"
      ? Response.json({ results: [{ url: "https://docs.example.com/guide", title: "Guide", content: "text" }] })
      : Response.json({ ok: true, url: body.url, text: "page ![x](https://evil.test/?d=1) and https://docs.example.com/next" });
  };
  const gateway = new Gateway(cfg(web), { fetch: fetchImpl, now: () => Date.parse("2026-11-11T12:00:00Z"), store });
  gateway.setToken(BOT, TOKEN);
  gateway.setToken(OTHER, OTHER_TOKEN);
  return { gateway, calls, store };
}

let rpcId = 0;
const rpc = (method: string, params?: unknown, token = TOKEN) =>
  new Request("http://localhost/v1/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });

async function call(gateway: Gateway, name: "search" | "fetch", args: Record<string, unknown>, bot = BOT, token = TOKEN) {
  const response = await gateway.handle(bot, rpc("tools/call", { name, arguments: args }, token));
  const body = (await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: body.result.content[0]!.text, isError: body.result.isError === true };
}

describe("the MCP route", () => {
  test("needs the bot's own token and nothing else", async () => {
    const { gateway, calls } = setup();
    expect((await gateway.handle(BOT, rpc("tools/list", undefined, "3".repeat(64)))).status).toBe(403);
    expect((await gateway.handle(BOT, rpc("tools/list", undefined, OTHER_TOKEN))).status).toBe(403);
    expect((await gateway.handle(BOT, new Request("http://localhost/v1/mcp", { method: "POST" }))).status).toBe(403);
    expect((await gateway.handle(BOT, new Request("http://localhost/v1/mcp/x", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("answers initialize, ping and tools/list with two tools, and refuses unknown tools and methods", async () => {
    const { gateway } = setup();
    const init = (await (await gateway.handle(BOT, rpc("initialize", { protocolVersion: "2025-06-18" }))).json()) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const list = (await (await gateway.handle(BOT, rpc("tools/list"))).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map(tool => tool.name)).toEqual(["search", "fetch"]);
    expect(((await (await gateway.handle(BOT, rpc("tools/call", { name: "shell", arguments: {} }))).json()) as { error: { code: number } }).error.code).toBe(-32602);
    expect(((await (await gateway.handle(BOT, rpc("resources/list"))).json()) as { error: { code: number } }).error.code).toBe(-32601);
    const notification = new Request("http://localhost/v1/mcp", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect((await gateway.handle(BOT, notification)).status).toBe(202);
    expect((await gateway.handle(BOT, new Request("http://localhost/v1/mcp", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{" }))).status).toBe(400);
  });
});

describe("the owner's setting is applied by the gateway", () => {
  test("off is the default: nothing reaches the provider, and the refusal is counted", async () => {
    const { gateway, calls } = setup();
    expect(await call(gateway, "search", { query: "x" })).toEqual({ text: WEB_ERRORS.off, isError: true });
    expect(await call(gateway, "fetch", { url: "https://docs.example.com/guide" })).toEqual({ text: WEB_ERRORS.off, isError: true });
    expect(calls).toEqual([]);
    expect(gateway.webUsage(BOT)).toEqual({ searches: 0, pages: 0, blocked: 2 });
  });

  test("a site not on the list is refused at the gateway even when the bot names it directly", async () => {
    const { gateway, calls } = setup();
    gateway.setWebPolicy(BOT, { mode: "listed", hosts: ["docs.example.com"] });
    gateway.learnAddresses(BOT, ["https://evil.test/seen-before"]);
    expect(await call(gateway, "fetch", { url: "https://evil.test/seen-before" })).toEqual({ text: WEB_ERRORS.site, isError: true });
    expect(await call(gateway, "fetch", { url: "https://docs.example.com.evil.test/" })).toEqual({ text: WEB_ERRORS.site, isError: true });
    expect(calls).toEqual([]);
  });

  test("a listed site still needs an address the owner typed or a result returned: an invented one is refused", async () => {
    const { gateway, calls } = setup();
    gateway.setWebPolicy(BOT, { mode: "listed", hosts: ["docs.example.com"] });
    expect(await call(gateway, "fetch", { url: "https://docs.example.com/?d=private-data" })).toEqual({ text: WEB_ERRORS.unseen, isError: true });
    expect(calls).toEqual([]);
    gateway.learnAddresses(BOT, ["https://docs.example.com/typed"]);
    expect((await call(gateway, "fetch", { url: "https://docs.example.com/typed#frag" })).isError).toBe(false);
    expect(calls.map(entry => entry.url)).toEqual([`${PINNED_FETCH_URL}/fetch`]);
    expect(calls[0]!.body).toEqual({ url: "https://docs.example.com/typed", hosts: ["docs.example.com"] });
  });

  test("the fetch process never gets a fragment: the bot cannot attach words to an address it may read", async () => {
    const { gateway, calls } = setup();
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    gateway.learnAddresses(BOT, ["https://docs.example.com/typed"]);
    const smuggled = "https://docs.example.com/typed#" + encodeURIComponent("my private notes ".repeat(40));
    expect((await call(gateway, "fetch", { url: smuggled })).isError).toBe(false);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("#");
    expect(JSON.stringify(calls[0]!.body)).not.toContain("private");
  });

  test("a stopped bot loses its setting and its readable addresses, but not its day's counts", async () => {
    const { gateway } = setup();
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    await call(gateway, "search", { query: "x" });
    gateway.dropToken(BOT);
    gateway.setToken(BOT, TOKEN);
    expect((await call(gateway, "search", { query: "x" })).text).toBe(WEB_ERRORS.off);
    expect(gateway.webUsage(BOT)).toMatchObject({ searches: 1, blocked: 1 });
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    expect((await call(gateway, "fetch", { url: "https://docs.example.com/guide" })).text).toBe(WEB_ERRORS.unseen);
  });

  test("what a search returns can be read next, and what a page names can be read after that; another bot knows none of it", async () => {
    const { gateway, calls } = setup();
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    gateway.setWebPolicy(OTHER, { mode: "any", hosts: [] });
    expect((await call(gateway, "search", { query: "guide" })).text).toContain("https://docs.example.com/guide");
    const page = await call(gateway, "fetch", { url: "https://docs.example.com/guide" });
    expect(page.isError).toBe(false);
    expect(page.text).not.toContain("evil.test");
    expect(page.text.startsWith("<<<WEB CONTENT: page.")).toBe(true);
    expect((await call(gateway, "fetch", { url: "https://docs.example.com/next" })).isError).toBe(false);
    expect(await call(gateway, "fetch", { url: "https://docs.example.com/guide" }, OTHER, OTHER_TOKEN)).toEqual({ text: WEB_ERRORS.unseen, isError: true });
    expect(calls.map(entry => entry.url)).toEqual([`${PINNED_WEB_API}/search`, `${PINNED_FETCH_URL}/fetch`, `${PINNED_FETCH_URL}/fetch`]);
  });

  test("the search provider gets the query and fixed flags only: not the owner's sites, not an address, not who asks", async () => {
    const { gateway, calls } = setup();
    gateway.setWebPolicy(BOT, { mode: "listed", hosts: ["docs.example.com"] });
    await call(gateway, "search", { query: "guide" });
    expect(calls[0]!.url).toBe(`${PINNED_WEB_API}/search`);
    expect(Object.keys(calls[0]!.body).sort()).toEqual(["include_answer", "include_images", "include_raw_content", "max_results", "query", "search_depth"]);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("docs.example.com");
    expect([...calls[0]!.headers.keys()].sort()).toEqual(["authorization", "content-type"]);
  });

  test("the fetch process is given no credential, and the search key never leaves for any address but the provider's", async () => {
    const { gateway, calls } = setup();
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    gateway.learnAddresses(BOT, ["https://docs.example.com/guide"]);
    await call(gateway, "fetch", { url: "https://docs.example.com/guide" });
    expect(calls[0]!.url).toBe(`${PINNED_FETCH_URL}/fetch`);
    expect([...calls[0]!.headers.keys()]).toEqual(["content-type"]);
    expect(calls[0]!.body).toEqual({ url: "https://docs.example.com/guide", hosts: null });
    expect(JSON.stringify(calls)).not.toContain("web-key");
  });

  test("a page that ends up on a site outside the owner's list is not delivered, whatever the fetch process says", async () => {
    const { gateway } = setup({}, (path, body) => Response.json({ ok: true, url: path === "/fetch" ? "https://elsewhere.example.net/x" : body.url, text: "secret" }));
    gateway.setWebPolicy(BOT, { mode: "listed", hosts: ["docs.example.com"] });
    gateway.learnAddresses(BOT, ["https://docs.example.com/guide"]);
    expect(await call(gateway, "fetch", { url: "https://docs.example.com/guide" })).toEqual({ text: WEB_ERRORS.site, isError: true });
  });

  test.each([
    ["blocked", WEB_ERRORS.address], ["address", WEB_ERRORS.address], ["site", WEB_ERRORS.site], ["type", WEB_ERRORS.unreadable], ["status", WEB_ERRORS.unreadable],
    ["protocol", WEB_ERRORS.unreadable], ["redirect", WEB_ERRORS.unreadable], ["timeout", WEB_ERRORS.pageDown], ["network", WEB_ERRORS.pageDown],
    ["busy", WEB_ERRORS.pageDown], ["anything else the process might say, even a long secret", WEB_ERRORS.pageDown],
  ])("when the fetch process says %p the model gets one fixed sentence", async (reason, sentence) => {
    const { gateway } = setup({}, () => Response.json({ ok: false, reason }));
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    gateway.learnAddresses(BOT, ["https://docs.example.com/guide"]);
    expect(await call(gateway, "fetch", { url: "https://docs.example.com/guide" })).toEqual({ text: sentence, isError: true });
    expect(gateway.webUsage(BOT).pages).toBe(1);
  });

  test("a page with no readable text (script only, or a PDF that slipped through) says it could not be read", async () => {
    const { gateway } = setup({}, (_path, body) => Response.json({ ok: true, url: body.url, text: "  \n <b></b>  " }));
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    gateway.learnAddresses(BOT, ["https://docs.example.com/guide"]);
    expect(await call(gateway, "fetch", { url: "https://docs.example.com/guide" })).toEqual({ text: WEB_ERRORS.unreadable, isError: true });
  });

  test("a fetch process that is down, answers with an error or sends nonsense is a fixed 'didn't answer'", async () => {
    for (const respond of [() => new Response("x", { status: 503 }), () => Response.json({ ok: true }), () => Response.json({ ok: true, url: 5, text: "t" }), () => new Response("not json")]) {
      const { gateway } = setup({}, respond);
      gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
      gateway.learnAddresses(BOT, ["https://docs.example.com/guide"]);
      expect(await call(gateway, "fetch", { url: "https://docs.example.com/guide" })).toEqual({ text: WEB_ERRORS.pageDown, isError: true });
    }
  });

  test("in listed mode a search asks for more results and keeps only the owner's sites", async () => {
    const { gateway, calls } = setup({}, () =>
      Response.json({ results: ["https://evil.test/a", "https://docs.example.com/a", "https://docs.example.com.evil.test/b", "https://docs.example.com/b"].map(url => ({ url, title: "t", content: "c" })) }));
    gateway.setWebPolicy(BOT, { mode: "listed", hosts: ["docs.example.com"] });
    const out = await call(gateway, "search", { query: "guide", max_results: 3 });
    expect(calls[0]!.body.max_results).toBe(20);
    expect(out.text).toContain("https://docs.example.com/a");
    expect(out.text).toContain("https://docs.example.com/b");
    expect(out.text).not.toContain("evil.test");
  });

  test("a change of setting applies to the very next call, and turning it off ends use", async () => {
    const { gateway } = setup();
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    expect((await call(gateway, "search", { query: "a" })).isError).toBe(false);
    gateway.setWebPolicy(BOT, { mode: "off", hosts: [] });
    expect((await call(gateway, "search", { query: "a" })).text).toBe(WEB_ERRORS.off);
  });

  test.each([
    ["an IP address", "http://127.0.0.1/"], ["the metadata address", "http://169.254.169.254/latest"], ["a decimal address", "http://2130706433/"],
    ["localhost", "https://localhost/"], ["a port", "https://docs.example.com:8443/"], ["user info", "https://a:b@docs.example.com/"], ["a file", "file:///etc/passwd"],
  ])("never dials %s", async (_name, url) => {
    const { gateway, calls } = setup();
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    gateway.learnAddresses(BOT, [url]);
    expect(await call(gateway, "fetch", { url })).toEqual({ text: WEB_ERRORS.address, isError: true });
    expect(calls).toEqual([]);
  });

  test("a query that is empty or over 200 characters is refused", async () => {
    const { gateway, calls } = setup();
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    expect((await call(gateway, "search", { query: "  " })).text).toBe(WEB_ERRORS.query);
    expect((await call(gateway, "search", { query: "x".repeat(201) })).text).toBe(WEB_ERRORS.query);
    expect((await call(gateway, "search", { query: "x".repeat(200) })).isError).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("limits and counts", () => {
  test("no key: a search is unavailable even with web on; the status says so", async () => {
    const { gateway, calls } = setup({ key: undefined });
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    expect(await call(gateway, "search", { query: "x" })).toEqual({ text: WEB_ERRORS.unavailable, isError: true });
    expect(gateway.webAvailable).toBe(false);
    expect(calls).toEqual([]);
  });

  test("the daily search cap holds per bot and the global cap holds across bots", async () => {
    const { gateway, calls } = setup({ globalDailySearches: 4 });
    for (const bot of [BOT, OTHER]) gateway.setWebPolicy(bot, { mode: "any", hosts: [] });
    for (let i = 0; i < 3; i++) expect((await call(gateway, "search", { query: "x" })).isError).toBe(false);
    expect(await call(gateway, "search", { query: "x" })).toEqual({ text: WEB_ERRORS.budget, isError: true });
    expect((await call(gateway, "search", { query: "x" }, OTHER, OTHER_TOKEN)).isError).toBe(false);
    expect(await call(gateway, "search", { query: "x" }, OTHER, OTHER_TOKEN)).toEqual({ text: WEB_ERRORS.budget, isError: true });
    expect(calls).toHaveLength(4);
    expect(gateway.webUsage(BOT)).toEqual({ searches: 3, pages: 0, blocked: 0 });
  });

  test("a call that fails at the provider still counts, and says only a fixed sentence", async () => {
    const { gateway } = setup({}, () => new Response("provider secret detail", { status: 500 }));
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    expect(await call(gateway, "search", { query: "x" })).toEqual({ text: WEB_ERRORS.provider, isError: true });
    expect(gateway.webUsage(BOT).searches).toBe(1);
  });

  test("one web call at a time per bot", async () => {
    const release = Promise.withResolvers<void>();
    const { gateway } = setup({}, async () => {
      await release.promise;
      return Response.json({ results: [] });
    });
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    const first = call(gateway, "search", { query: "x" });
    await Bun.sleep(10);
    expect(await call(gateway, "search", { query: "y" })).toEqual({ text: WEB_ERRORS.busy, isError: true });
    release.resolve();
    expect((await first).isError).toBe(false);
  });

  test("counts are saved with the budgets and survive a restart; they hold no query, address or page text", async () => {
    const { gateway, store } = setup();
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    await call(gateway, "search", { query: "my private query" });
    await call(gateway, "fetch", { url: "https://docs.example.com/guide" });
    expect(JSON.stringify(store.saved)).not.toContain("private");
    expect(JSON.stringify(store.saved)).not.toContain("docs.example.com");
    const restarted = new Gateway(cfg(), { store, now: () => Date.parse("2026-11-11T13:00:00Z") });
    expect(restarted.webUsage(BOT)).toMatchObject({ searches: 1, pages: 1 });
  });

  test("a day later the counts start again", async () => {
    let now = Date.parse("2026-11-11T12:00:00Z");
    const gateway = new Gateway(cfg(), { fetch: async () => Response.json({ results: [] }), now: () => now, store: memoryStore() });
    gateway.setToken(BOT, TOKEN);
    gateway.setWebPolicy(BOT, { mode: "any", hosts: [] });
    for (let i = 0; i < 3; i++) await call(gateway, "search", { query: "x" });
    expect((await call(gateway, "search", { query: "x" })).text).toBe(WEB_ERRORS.budget);
    now += 24 * 60 * 60_000;
    expect((await call(gateway, "search", { query: "x" })).isError).toBe(false);
  });
});
