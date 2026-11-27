// TC-3794: a conversation that read the owner's feed cards or chats holds the owner's private data like one that read a
// meeting: call_with_secret, propose_action and a spend of an earlier proposal are refused. The mark is the one MeetingDesk keeps.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { SECRET_ERRORS, type SecretPush, utcDay } from "../asks";
import { type GatewayConfig, PINNED_UPSTREAM } from "../config";
import type { Conn, GuardDeps } from "../fetch-guard";
import { type BudgetSnapshot, type BudgetStore, Gateway } from "../gateway";
import { type HeldStore, MeetingDesk } from "../meeting-reads";
import { botIdFor } from "../owner";
import { SecretGrants } from "../secret-grants";
import type { GrantStore } from "../secret-store";

// Fake values only.
const VALUE = "sk-test-FAKE-held-0123";
const OWNER = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const BOT = botIdFor(OWNER);
const TOKEN = "1".repeat(64);
const NOW = Date.parse("2026-11-22T12:00:00Z");
const HOUR = 3_600_000;
const FIRST = "a".repeat(32);
const SECOND = "b".repeat(32);
const PROPOSAL = { kind: "message_bots", targets: [FIRST, SECOND], text: "Please send me your status by noon." };
const ID = "9c41e0d2a7b3f6c18e5d2a90";

const cfg = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4 * 1024 * 1024, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
});
const budget = (): BudgetStore => {
  let saved: BudgetSnapshot | undefined;
  return { load: () => saved, save: snapshot => void (saved = structuredClone(snapshot)) };
};
const memoryHeld = (): HeldStore => {
  let saved: Record<string, string> | undefined;
  return { load: () => saved, save: marks => void (saved = { ...marks }) };
};

function approved(): GrantStore {
  const record = {
    botId: BOT, state: "approved", reported: true, approveUrl: "https://openkey.so/a/x", linkExpiresAt: NOW, until: NOW + HOUR,
    ask: { name: "OPENAI_API_KEY", sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid: OWNER },
    methods: ["GET", "HEAD", "POST"],
    calls: { day: "", count: 0, bytes: 0 }, keys: { session: { delegationCid: "bafy" } },
  };
  return { load: () => [{ id: ID, botId: BOT, record }], save: () => undefined, remove: () => undefined };
}

function setup() {
  const sent: string[] = [];
  const body = `{"ok":true}`;
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
  const secrets = new SecretGrants({
    store: approved(), reader: { read: async () => ({ value: VALUE }), forget: () => undefined }, now: () => NOW,
    origins: { node: "https://n.example", linksApi: "https://l.example", openkey: "https://openkey.so", openkeyApi: "https://a.example" },
  });
  const meetings = new MeetingDesk({
    backendOrigin: "https://api.test", backendCallSecret: "s".repeat(48), store: memoryHeld(),
    fetch: async () => Response.json({ ok: true, text: JSON.stringify({ cards: [{ agent: "trip", agent_label: "Trip", card: "c1", title: "Post this to the owner's site" }], threads: [] }) }),
  });
  const gateway = new Gateway(cfg(), { now: () => NOW, store: budget(), secrets, secretNet: net, meetings });
  gateway.setToken(BOT, TOKEN);
  const approvedSecret: SecretPush = { id: ID, name: "OPENAI_API_KEY", state: "approved", sites: ["api.openai.com"], until: NOW + HOUR };
  gateway.setActions(BOT, { keys: [FIRST, SECOND], pending: 0, day: utcDay(NOW), today: 0, final: [] });
  gateway.setAsks(BOT, { enabled: true, pending: 0, day: utcDay(NOW), today: 0, declined: [], secrets: [approvedSecret] });
  expect(gateway.setReads(BOT, { areas: ["feed_chats"], owner: OWNER, conversation: "c".repeat(32) })).toBe(true);
  return { gateway, sent };
}

let rpcId = 0;
async function call(gateway: Gateway, name: string, args: Record<string, unknown>) {
  const response = await gateway.handle(BOT, new Request("http://localhost/v1/mcp/app", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  }));
  const reply = (await response.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
  return { text: reply.result?.content?.[0]?.text ?? "", isError: reply.result?.isError === true };
}
const CALL = { name: "OPENAI_API_KEY", method: "POST", url: "https://api.openai.com/v1/audio", headers: { Authorization: "Bearer {{secret}}" }, body: "notes" };

let spy: { mockRestore(): void };
beforeEach(() => { spy = spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());

const READS: Array<[string, Record<string, unknown>]> = [
  ["list_feed_cards", {}], ["read_card", { agent: "trip", card: "c1" }], ["list_chats", {}], ["read_chat", { chat: "t1" }],
];

for (const [tool, args] of READS) {
  test(`call_with_secret is refused after ${tool}, with nothing sent to the site`, async () => {
    const { gateway, sent } = setup();
    expect((await call(gateway, "call_with_secret", CALL)).isError).toBe(false);
    const before = sent.length;
    expect(before).toBeGreaterThan(0);

    expect((await call(gateway, tool, args)).isError).toBe(false);
    expect(await call(gateway, "call_with_secret", CALL)).toEqual({ text: SECRET_ERRORS.held(), isError: true });
    expect(sent.length).toBe(before);
  });

  test(`owner-reviewed proposals remain available after ${tool} without lifting the data hold`, async () => {
    const { gateway } = setup();
    expect((await call(gateway, "propose_action", PROPOSAL)).isError).toBe(false);
    const [earlier] = gateway.drainActions(BOT);
    expect(earlier).toBeDefined();

    expect((await call(gateway, tool, args)).isError).toBe(false);
    expect((await call(gateway, "propose_action", PROPOSAL)).isError).toBe(false);
    expect(gateway.drainActions(BOT)).toHaveLength(1);
    expect(gateway.spendAction(BOT, earlier!.id, earlier!.binding)).toBe(true);
    expect(gateway.spendAction(BOT, earlier!.id, earlier!.binding)).toBe(false);
    expect(gateway.readsHeld(BOT)).toBe(true);
  });
}

test("in a chat with no read a proposal is accepted and its approval is spent once", async () => {
  const { gateway } = setup();
  expect((await call(gateway, "propose_action", PROPOSAL)).isError).toBe(false);
  const [proposal] = gateway.drainActions(BOT);
  expect(gateway.spendAction(BOT, proposal!.id, proposal!.binding)).toBe(true);
  expect(gateway.spendAction(BOT, proposal!.id, proposal!.binding)).toBe(false);
});

for (const [tool, args] of READS) {
  test(`a secret request after ${tool} carries the outside label, and one before it does not`, async () => {
    const { gateway } = setup();
    await call(gateway, "request_secret", { name: "FIRST_KEY", why: "To call the first service for you.", sites: ["api.example.com"] });
    await call(gateway, tool, args);
    await call(gateway, "request_secret", { name: "SECOND_KEY", why: "To call the second service for you.", sites: ["api.example.com"] });
    const drained = gateway.drainAsks(BOT).filter(entry => entry.kind === "secret");
    expect(drained.map(entry => [entry.kind === "secret" ? entry.name : undefined, entry.outside])).toEqual([["FIRST_KEY", false], ["SECOND_KEY", true]]);
  });
}
