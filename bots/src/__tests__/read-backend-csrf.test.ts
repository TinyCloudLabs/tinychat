import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { type BudgetSnapshot, type BudgetStore, Gateway, type UpstreamFetch } from "../gateway";
import { MeetingDesk, READ_ERRORS, READS_PER_DAY } from "../meeting-reads";
import { botIdFor } from "../owner";
import { NonceGuard, verifyCall } from "../signed-call";

// The backend's global CSRF gate runs before TrustBot's read routes and answers a POST without
// `x-requested-with: XMLHttpRequest` with 403 (packages/server/src/csrf.ts). This fake backend does the same.
const OWNER = `did:pkh:eip155:1:0x${"cd".repeat(20)}`;
const BOT = botIdFor(OWNER);
const TOKEN = "2".repeat(64);
const SECRET = "t".repeat(48);
const ORIGIN = "https://api.test";
const CONVERSATION = "e".repeat(32);

const cfg = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 50, botDailyPages: 50, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
} as GatewayConfig);

const memoryBudget = (): BudgetStore => {
  let saved: BudgetSnapshot | undefined;
  return { load: () => saved, save: snapshot => void (saved = structuredClone(snapshot)) };
};

function csrfGatedBackend() {
  const nonces = new NonceGuard();
  const seen: Array<{ path: string; csrf: string | null }> = [];
  const send: UpstreamFetch = async (url, init) => {
    const { pathname } = new URL(url);
    const headers = new Headers(init.headers);
    seen.push({ path: pathname, csrf: headers.get("x-requested-with") });
    if (headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "csrf_rejected" }, { status: 403 });
    const claims = verifyCall(headers.get("authorization"), { method: String(init.method), path: pathname, body: String(init.body) }, {
      secret: SECRET, direction: "to-backend", environment: "private", nonces,
    });
    if (!claims || claims.owner !== OWNER) return new Response(null, { status: 401 });
    if (pathname.endsWith("/audit/refusal")) return new Response(null, { status: 204 });
    return Response.json({ ok: true, text: "Retrieved 1 meeting. [M1:S] We ship Friday." });
  };
  return { send, seen };
}

let rpcId = 0;
async function callTool(gateway: Gateway, name: string, args: Record<string, unknown>) {
  const request = new Request("http://localhost/v1/mcp/app", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await (await gateway.handle(BOT, request)).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: body.result.content[0]!.text, isError: body.result.isError === true };
}

let spy: { mockRestore(): void };
beforeEach(() => { spy = spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());

test("a meeting read passes the backend's CSRF gate and returns the meeting", async () => {
  const api = csrfGatedBackend();
  const meetings = new MeetingDesk({ backendOrigin: ORIGIN, backendCallSecret: SECRET, fetch: api.send });
  const gateway = new Gateway(cfg(), { fetch: api.send, store: memoryBudget(), meetings });
  gateway.setToken(BOT, TOKEN);
  expect(gateway.setReads(BOT, { areas: ["meetings"], owner: OWNER, conversation: CONVERSATION })).toBe(true);
  const result = await callTool(gateway, "tinycloud_read_meeting", { focus: "summary" });
  expect(result.isError).toBe(false);
  expect(result.text).toContain("We ship Friday.");
  expect(result.text).not.toContain(READ_ERRORS.unavailable);
  expect(api.seen).toEqual([{ path: "/api/internal/bots/main/reads/tinycloud_read_meeting", csrf: "XMLHttpRequest" }]);
});

test("a refusal report to the backend's audit also carries the CSRF header", async () => {
  const api = csrfGatedBackend();
  const meetings = new MeetingDesk({ backendOrigin: ORIGIN, backendCallSecret: SECRET, fetch: api.send, forwardRefusals: true });
  const gateway = new Gateway(cfg(), { fetch: api.send, store: memoryBudget(), meetings });
  gateway.setToken(BOT, TOKEN);
  expect(gateway.setReads(BOT, { areas: ["meetings"], owner: OWNER, conversation: CONVERSATION })).toBe(true);
  for (let i = 0; i < READS_PER_DAY; i++) await callTool(gateway, "tinycloud_find_meetings", {});
  const refused = await callTool(gateway, "tinycloud_find_meetings", {});
  expect(refused.isError).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  const audit = api.seen.filter(call => call.path.endsWith("/audit/refusal"));
  expect(audit.length).toBeGreaterThan(0);
  for (const call of audit) expect(call.csrf).toBe("XMLHttpRequest");
});
