import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BotAdmission } from "../bot-admission";
import { BotManager, type Sandbox, type SandboxLauncher } from "../bot";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { Gateway } from "../gateway";
import { OwnerManifests } from "../manifest";
import { MEETING_TOOL_NAMES } from "../meeting-tools";
import { botIdFor } from "../owner";
import { conversationFile, conversationId, parseReadsPush, readReads, readsFile, readsPush } from "../reads";
import { createApp } from "../server";
import { signedCallHeader } from "../signed-call";
import { botLayout } from "../layout";

const owner = `did:pkh:eip155:1:0x${"11".repeat(20)}`;
const sibling = "a".repeat(32);
const secret = "reads-server-" + "x".repeat(64);
const TOKEN = "1".repeat(64);

const gatewayConfig = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});

let root: string;
let spy: { mockRestore(): void };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reads-server-"));
  spy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  spy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const manifest = new OwnerManifests(join(root, "manifest"));
  manifest.announce(owner, sibling, "active", 1);
  const mainId = botIdFor(owner);
  const gateway = new Gateway(gatewayConfig(), { fetch: async () => Response.json({}), store: { load: () => undefined, save: () => {} } });
  gateway.setToken(mainId, TOKEN);
  const launcher: SandboxLauncher = {
    hasState: () => false,
    leftover: () => false,
    launch: async () => ({}) as Sandbox,
    pushReads: async layout => void gateway.setReads(layout.botId, readsPush(layout)),
  };
  const bots = new BotManager(launcher, roots, {
    idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000,
    history: { signerDid: owner, host: "http://127.0.0.1:9573", policy: "notice-then-expiry-30-days" },
  }, 3);
  const admit: BotAdmission = async () => ({ admitted: true });
  const app = createApp({ bots, secret, accounts: "*", manifest, acceptLegacyOwnerHeader: true, admit });
  const call = (method: string, key: string, payload?: unknown) => {
    const path = `/v1/bots/${key}/reads`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const authorization = signedCallHeader(secret, { direction: "to-service", environment: "private", owner, bot: key, method, path, body });
    return app(new Request(`http://fixture.test${path}`, {
      method, headers: { authorization, "x-tinycloud-owner": owner, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }),
    }));
  };
  const tools = async () => {
    const response = await gateway.handle(mainId, new Request("http://localhost/v1/mcp/app", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    return ((await response.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(tool => tool.name);
  };
  return { call, tools, layout: botLayout(mainId, roots) };
}

describe("the owner's read setting for Main", () => {
  test("turning meetings on saves the signed owner and offers the tools; turning it off withdraws them", async () => {
    const { call, tools, layout } = setup();
    expect(await tools()).toEqual([]);
    const on = await call("PUT", "main", { areas: ["meetings"] });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ areas: ["meetings"] });
    expect(readReads(layout)).toEqual({ areas: ["meetings"], owner });
    expect(await tools()).toEqual([...MEETING_TOOL_NAMES]);
    expect((await call("PUT", "main", { areas: [] })).status).toBe(200);
    expect(readReads(layout)).toEqual({ areas: [] });
    expect(await tools()).toEqual([]);
  });

  test("is Main's alone, set only with PUT and a body of known areas", async () => {
    const { call, layout } = setup();
    expect((await call("PUT", sibling, { areas: ["meetings"] })).status).toBe(404);
    expect((await call("GET", "main")).status).toBe(405);
    for (const bad of [{ areas: ["meetings"], owner }, { areas: ["feed"] }, { areas: "meetings" }, {}, null]) {
      expect((await call("PUT", "main", bad)).status).toBe(400);
    }
    expect(readReads(layout)).toEqual({ areas: [] });
  });
});

describe("the saved setting and the conversation id", () => {
  test("a malformed or ownerless file reads as off", () => {
    const layout = botLayout(botIdFor(owner), { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
    expect(readReads(layout)).toEqual({ areas: [] });
    conversationId(layout);
    for (const text of ["{", JSON.stringify({ areas: ["meetings"] }), JSON.stringify({ areas: ["meetings"], owner: "did:example:x" })]) {
      writeFileSync(readsFile(layout), text);
      expect(readReads(layout)).toEqual({ areas: [] });
    }
  });

  test("the id is made once and kept until the data directory loses it", () => {
    const layout = botLayout(botIdFor(owner), { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
    const first = conversationId(layout);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(conversationId(layout)).toBe(first);
    expect(readFileSync(conversationFile(layout), "utf8")).toBe(first);
    rmSync(conversationFile(layout));
    expect(conversationId(layout)).not.toBe(first);
  });

  test("the gateway accepts a push only with a conversation id, and an owner whenever an area is on", () => {
    const conversation = "c".repeat(32);
    expect(parseReadsPush({ areas: ["meetings"], owner, conversation })).toEqual({ areas: ["meetings"], owner, conversation });
    expect(parseReadsPush({ areas: [], conversation })).toEqual({ areas: [], conversation });
    expect(parseReadsPush({ areas: ["meetings"], conversation })).toBeUndefined();
    expect(parseReadsPush({ areas: [], owner, conversation: "short" })).toBeUndefined();
    expect(parseReadsPush({ areas: ["meetings", "secrets"], owner, conversation })).toBeUndefined();
  });
});
