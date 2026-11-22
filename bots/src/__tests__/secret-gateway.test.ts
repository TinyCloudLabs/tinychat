import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type SecretPush, utcDay } from "../asks";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import type { Conn, GuardDeps } from "../fetch-guard";
import { type BudgetSnapshot, type BudgetStore, Gateway } from "../gateway";
import { SecretGrants } from "../secret-grants";
import type { GrantStore } from "../secret-store";

// Fake values only.
const VALUE = "sk-test-FAKE-gateway-0123";
const BOT = "a".repeat(64);
const TOKEN = "1".repeat(64);
const NOW = Date.parse("2026-11-22T12:00:00Z");
const HOUR = 3_600_000;
const ID = "9c41e0d2a7b3f6c18e5d2a90";

const cfg = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4 * 1024 * 1024, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});

const budget = (): BudgetStore => {
  let saved: BudgetSnapshot | undefined;
  return { load: () => saved, save: snapshot => void (saved = structuredClone(snapshot)) };
};

/** A gateway restarted onto a sealed record of an approved OPENAI_API_KEY, as secret-grants saves one. */
function storeWithApproval(): GrantStore {
  const record = {
    botId: BOT, state: "approved", reported: true, approveUrl: "https://openkey.so/a/x", linkExpiresAt: NOW, until: NOW + HOUR,
    ask: { name: "OPENAI_API_KEY", sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid: "did:pkh:eip155:1:0x" + "1".repeat(40) },
    methods: ["GET", "HEAD", "POST"],
    calls: { day: "", count: 0, bytes: 0 }, keys: { session: { delegationCid: "bafy" } },
  };
  return { load: () => [{ id: ID, botId: BOT, record }], save: () => undefined, remove: () => undefined };
}

function site(body: string) {
  const sent: string[] = [];
  const net: GuardDeps = {
    lookup: async () => ["93.184.216.34"],
    connect: async (): Promise<Conn> => ({
      write: data => void sent.push(data),
      destroy: () => undefined,
      read: () => ({
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
        },
      }),
    }),
  };
  return { net, sent };
}

function setup(options: { secrets?: boolean; body?: string } = {}) {
  const { net, sent } = site(options.body ?? `{"echo":"${VALUE}"}`);
  const secrets = options.secrets === false ? undefined : new SecretGrants({
    store: storeWithApproval(), reader: { read: async () => ({ value: VALUE }), forget: () => undefined }, now: () => NOW,
    origins: { node: "https://n.example", linksApi: "https://l.example", openkey: "https://openkey.so", openkeyApi: "https://a.example" },
  });
  const gateway = new Gateway(cfg(), { now: () => NOW, store: budget(), secrets, secretNet: net });
  gateway.setToken(BOT, TOKEN);
  return { gateway, sent };
}

const APPROVED: SecretPush = { id: ID, name: "OPENAI_API_KEY", state: "approved", sites: ["api.openai.com"], until: NOW + HOUR };
const push = (gateway: Gateway, enabled: boolean, secrets: SecretPush[] = []) =>
  gateway.setAsks(BOT, { enabled, pending: 0, day: utcDay(NOW), today: 0, declined: [], secrets });

let rpcId = 0;
const rpc = (method: string, params?: unknown, path = "/v1/mcp/app") =>
  new Request(`http://localhost${path}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
type Reply = { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean }; error?: { code: number } };
const tools = async (gateway: Gateway) => ((await (await gateway.handle(BOT, rpc("tools/list"))).json()) as Reply).result!.tools!.map(tool => tool.name);
async function call(gateway: Gateway, name: string, args: Record<string, unknown>) {
  const response = await gateway.handle(BOT, rpc("tools/call", { name, arguments: args }));
  const body = (await response.json()) as Reply;
  return { status: response.status, text: body.result?.content?.[0]?.text ?? "", isError: body.result?.isError === true, error: body.error };
}
const CALL = { name: "OPENAI_API_KEY", method: "GET", url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer {{secret}}" } };

let lines: string[];
let spy: { mockRestore(): void };
beforeEach(() => {
  lines = [];
  spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
});
afterEach(() => spy.mockRestore());

describe("the secret tools on the app server", () => {
  test("are offered with questions on, and while a secret is approved even with questions off", async () => {
    const { gateway } = setup();
    expect(await tools(gateway)).toEqual([]);
    push(gateway, true);
    expect(await tools(gateway)).toEqual(["ask_owner", "request_secret", "propose_action", "call_with_secret", "list_secrets"]);
    push(gateway, false, [APPROVED]);
    expect(await tools(gateway)).toEqual(["call_with_secret", "list_secrets"]);
    push(gateway, false, [{ ...APPROVED, until: NOW - 1 }]);
    expect(await tools(gateway)).toEqual([]);
  });

  test("are neither offered nor answered without the sealing key", async () => {
    const { gateway } = setup({ secrets: false });
    push(gateway, true, [APPROVED]);
    expect(await tools(gateway)).toEqual(["ask_owner", "request_secret", "propose_action"]);
    expect((await call(gateway, "call_with_secret", CALL)).error?.code).toBe(-32602);
    expect((await call(gateway, "list_secrets", {})).error?.code).toBe(-32602);
  });

  test("list_secrets gives names, states, sites and end times, never ids or values, and shows run-out access as ended", async () => {
    const { gateway } = setup();
    push(gateway, true, [APPROVED, { id: "x".repeat(24), name: "GITHUB_TOKEN", state: "approved", sites: ["api.github.com"], until: NOW - 1 }, { id: "y".repeat(24), name: "STRIPE_KEY", state: "expired", sites: ["api.stripe.com"] }]);
    const listed = await call(gateway, "list_secrets", {});
    expect(listed.isError).toBe(false);
    expect(JSON.parse(listed.text)).toEqual({
      secrets: [
        { name: "OPENAI_API_KEY", state: "approved", sites: ["api.openai.com"], until: "2026-11-22 13:00 UTC" },
        { name: "GITHUB_TOKEN", state: "ended", sites: ["api.github.com"], until: "2026-11-22 11:59 UTC" },
        { name: "STRIPE_KEY", state: "expired", sites: ["api.stripe.com"] },
      ],
    });
  });

  test("call_with_secret makes the call from the gateway, hides the value, and logs only its outcome", async () => {
    const { gateway, sent } = setup();
    push(gateway, true, [APPROVED]);
    const result = await call(gateway, "call_with_secret", CALL);
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(VALUE);
    expect(JSON.parse(result.text)).toMatchObject({ status: 200, body: '{"echo":"[hidden]"}' });
    expect(sent[0]).toContain(`Authorization: Bearer ${VALUE}\r\n`);
    expect(lines.filter(line => line.includes('"gateway":"secret"'))).toEqual([JSON.stringify({ gateway: "secret", bot: BOT.slice(0, 12), tool: "call_with_secret", outcome: "ok" })]);
    expect(lines.join("\n")).not.toContain(VALUE);
    expect(lines.join("\n")).not.toContain("api.openai.com");
  });

  test("call_with_secret refuses a secret the owner stopped, before the gateway has dropped it", async () => {
    const { gateway, sent } = setup();
    push(gateway, true, [{ ...APPROVED, state: "stopped" }]);
    expect(await call(gateway, "call_with_secret", CALL)).toMatchObject({ text: "You can’t use OPENAI_API_KEY. Ask for it with request_secret.", isError: true });
    expect(sent).toEqual([]);
  });

  test("takes a 1 MiB request body on the app server; the web server keeps its small cap", async () => {
    const { gateway } = setup();
    push(gateway, true, [APPROVED]);
    const big = await call(gateway, "call_with_secret", { ...CALL, method: "POST", body: "x".repeat(1024 * 1024) });
    expect(big.status).toBe(200);
    expect(big.isError).toBe(false);
    const web = await gateway.handle(BOT, rpc("tools/call", { name: "fetch", arguments: { url: `https://example.com/${"x".repeat(70 * 1024)}` } }, "/v1/mcp"));
    expect(web.status).toBe(413);
  });
});
