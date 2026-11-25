import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_ERRORS, ActionStore, syncActions } from "../actions";
import * as fs from "node:fs";
import { ASK_ERRORS, AskStore, type AsksGateway, MAX_PENDING, SECRET_ERRORS, asksFile, readAsksEnabled, syncAsks, writeAsksEnabled } from "../asks";
import { BotManager, type SandboxLauncher } from "../bot";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import type { GuardDeps } from "../fetch-guard";
import { type BudgetSnapshot, type BudgetStore, Gateway } from "../gateway";
import { type BotLayout, botLayout } from "../layout";
import { botIdFor } from "../owner";
import { SecretGrants } from "../secret-grants";

const owner = `did:pkh:eip155:1:0x${"22".repeat(20)}`;
const BOT = botIdFor(owner);
const SIBLING_KEY = "e".repeat(32);
const SIBLING = botIdFor(owner, SIBLING_KEY);
const TOKEN = "3".repeat(64);
const SIBLING_TOKEN = "4".repeat(64);
const NOW = Date.parse("2026-11-25T12:00:00Z");
const HELPERS = ["c".repeat(32), "d".repeat(32)];
const ALL_TOOLS = ["ask_owner", "request_secret", "propose_action", "call_with_secret", "list_secrets"];

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

let root: string;
let layout: BotLayout;
let gateway: Gateway;
let lines: string[];
let logs: { mockRestore(): void };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "asks-default-on-"));
  layout = botLayout(BOT, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
  // A gateway with secrets configured and no secret approved: the secret tools are listed only through the setting.
  const secrets = new SecretGrants({
    store: { load: () => [], save: () => undefined, remove: () => undefined },
    reader: { read: async () => { throw new Error("no read in this test"); }, forget: () => undefined },
    now: () => NOW,
    origins: { node: "https://n.example", linksApi: "https://l.example", openkey: "https://openkey.so", openkeyApi: "https://a.example" },
  });
  // No site is reached in these tests: every connection is refused.
  const secretNet: GuardDeps = { lookup: async () => { throw new Error("no lookup in this test"); }, connect: async () => { throw new Error("no connection in this test"); } };
  gateway = new Gateway(cfg(), { now: () => NOW, store: budget(), secrets, secretNet });
  gateway.setToken(BOT, TOKEN);
  lines = [];
  logs = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
});
afterEach(() => {
  logs.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

const sync = () => {
  const adapter: AsksGateway = {
    drain: async () => ({ asks: gateway.drainAsks(BOT), outside: gateway.asksOutside(BOT) }),
    push: async body => gateway.setAsks(BOT, body),
  };
  return syncAsks(layout, adapter, undefined, () => NOW);
};
const syncProposals = (keys?: string[]) => syncActions(layout, {
  drain: async () => ({ actions: gateway.drainActions(BOT) }),
  push: async body => gateway.setActions(BOT, body),
}, keys, () => NOW);

let rpcId = 0;
async function mcp(method: string, params?: unknown, bot = BOT, token = TOKEN) {
  const response = await gateway.handle(bot, new Request("http://localhost/v1/mcp/app", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  }));
  return (await response.json()) as { result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } };
}
const tools = async (bot = BOT, token = TOKEN) => (await mcp("tools/list", undefined, bot, token)).result.tools!.map(tool => tool.name);
async function call(name: string, args: Record<string, unknown>) {
  const { result } = await mcp("tools/call", { name, arguments: args });
  return { text: result.content![0]!.text, isError: result.isError === true };
}
const ask = (question: string) => call("ask_owner", { question });
const propose = () => call("propose_action", { kind: "message_bots", targets: HELPERS, text: "Please send me your status by noon." });
const requestSecret = () => call("request_secret", { name: "OPENAI_API_KEY", why: "To transcribe a call.", sites: ["api.openai.com"] });

const saveRaw = (content: string) => {
  mkdirSync(layout.dataDir, { recursive: true });
  writeFileSync(asksFile(layout), content);
};

describe("the main bot's requests setting when the owner has never saved it", () => {
  test("is default on: the request tools and the secret tools are listed", async () => {
    expect(existsSync(asksFile(layout))).toBe(false);
    await sync();
    expect(await tools()).toEqual(ALL_TOOLS);
  });

  test("a saved file without `enabled` is default on too", async () => {
    saveRaw(JSON.stringify({ outsideSeen: true }));
    await sync();
    expect(await tools()).toEqual(ALL_TOOLS);
  });

  test("propose_action is taken, and becomes a pending card the owner decides; nothing is sent", async () => {
    await sync();
    await syncProposals(HELPERS);
    const result = await propose();
    expect(result.isError).toBe(false);
    await syncProposals();
    const cards = new ActionStore(layout, () => NOW).list();
    expect(cards.map(card => card.state)).toEqual(["pending"]);
    // Without the owner's Send, the gateway spends nothing: a guessed binding is refused.
    expect(gateway.spendAction(BOT, cards[0]!.id, "0".repeat(64))).toBe(false);
  });

  test("request_secret is taken as a pending request the owner decides; nothing is approved", async () => {
    await sync();
    expect((await requestSecret()).isError).toBe(false);
    await sync();
    const secrets = new AskStore(layout, () => NOW).list().filter(request => request.kind === "secret");
    expect(secrets.map(secret => secret.state)).toEqual(["pending"]);
    const listed = JSON.parse((await call("list_secrets", {})).text) as { secrets: Array<{ state: string }> };
    expect(listed.secrets.map(secret => secret.state)).toEqual(["pending"]);
  });

  test("the question limits bound a default-on bot: open questions, then a declined question's cooldown", async () => {
    await sync();
    for (let i = 0; i < MAX_PENDING; i++) expect((await ask(`Which city number ${i}?`)).isError).toBe(false);
    expect(await ask("One question too many?")).toEqual({ text: ASK_ERRORS.pending, isError: true });
    await sync();
    expect(await ask("One question too many?")).toEqual({ text: ASK_ERRORS.pending, isError: true });
    const store = new AskStore(layout, () => NOW);
    const first = store.list().find(request => request.kind !== "secret" && request.question === "Which city number 0?")!;
    expect(store.answer(first.id, { decision: "decline" }).ok).toBe(true);
    await sync();
    expect(await ask("Which city number 0?")).toEqual({ text: ASK_ERRORS.recent, isError: true });
  });
});

describe("a sibling bot's requests setting", () => {
  const syncSibling = async (saved?: boolean) => {
    const sibling = botLayout(SIBLING, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") }, { botKey: SIBLING_KEY, ownerId: BOT });
    gateway.setToken(SIBLING, SIBLING_TOKEN, BOT);
    if (saved !== undefined) writeAsksEnabled(sibling, saved);
    await syncAsks(sibling, {
      drain: async () => ({ asks: gateway.drainAsks(SIBLING), outside: gateway.asksOutside(SIBLING) }),
      push: async body => gateway.setAsks(SIBLING, body),
    }, undefined, () => NOW);
  };

  test("a never-saved sibling lists no request tool, while Main lists them", async () => {
    await syncSibling();
    await sync();
    expect(await tools(SIBLING, SIBLING_TOKEN)).toEqual([]);
    expect(await tools()).toEqual(ALL_TOOLS);
  });

  test("a sibling whose file says on lists no request tool either", async () => {
    await syncSibling(true);
    expect(await tools(SIBLING, SIBLING_TOKEN)).toEqual([]);
  });
});

describe("the main bot's requests setting when the owner saved off, or the file is damaged", () => {
  test("a saved off lists no request tool and refuses each one", async () => {
    writeAsksEnabled(layout, false);
    await sync();
    expect(await tools()).toEqual([]);
    expect(await ask("Which city?")).toEqual({ text: ASK_ERRORS.off, isError: true });
    expect(await requestSecret()).toEqual({ text: SECRET_ERRORS.off(), isError: true });
    expect(await propose()).toEqual({ text: ACTION_ERRORS.off, isError: true });
  });

  test("a malformed file lists no request tool and is logged", async () => {
    for (const content of ["{not json", JSON.stringify({ enabled: "yes" }), JSON.stringify([true])]) {
      saveRaw(content);
      lines = [];
      await sync();
      expect(await tools()).toEqual([]);
      expect(lines.some(line => line.includes(`"bots":"asks_setting_unreadable"`))).toBe(true);
    }
  });
});

describe("deleting the bot's working state", () => {
  const manager = () => {
    // No sandbox is started: each test deletes the state of a bot that is not running.
    const launcher: SandboxLauncher = { hasState: () => false, leftover: () => false, mountPoints: () => [], launch: async () => { throw new Error("no launch in this test"); } };
    return new BotManager(launcher, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") }, { idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000 }, 3);
  };

  for (const reason of ["unused", "permission_expired", "new_chat"]) {
    test(`keeps a saved off when the state goes for ${reason}`, async () => {
      writeAsksEnabled(layout, false);
      expect(await manager().deleteWorkingState(BOT, reason)).toBeUndefined();
      expect(existsSync(asksFile(layout))).toBe(true);
      expect(readAsksEnabled(layout)).toBe(false);
    });
  }

  test("keeps a damaged file's off as a saved off", async () => {
    saveRaw("{not json");
    expect(await manager().deleteWorkingState(BOT, "unused")).toBeUndefined();
    expect(readAsksEnabled(layout)).toBe(false);
  });

  test("a saved on or a never-saved setting reads as default on afterwards", async () => {
    writeAsksEnabled(layout, true);
    expect(await manager().deleteWorkingState(BOT, "unused")).toBeUndefined();
    expect(readAsksEnabled(layout)).toBe(true);
  });

  test("writes nothing for a bot the backend deleted", async () => {
    writeAsksEnabled(layout, false);
    expect(await manager().deleteWorkingState(BOT, "deleted", true)).toBeUndefined();
    expect(existsSync(layout.dataDir)).toBe(false);
  });

  test("keeps a saved off when the deletion stops part-way after the data directory is gone", async () => {
    writeAsksEnabled(layout, false);
    mkdirSync(layout.bundleDir, { recursive: true });
    // The run directory can't be removed from its root, so the deletion fails after the data directory went.
    chmodSync(join(root, "run"), 0o500);
    try {
      expect(await manager().deleteWorkingState(BOT, "unused")).toBe("error");
    } finally {
      chmodSync(join(root, "run"), 0o700);
    }
    expect(existsSync(layout.bundleDir)).toBe(true);
    expect(existsSync(asksFile(layout))).toBe(true);
    expect(readAsksEnabled(layout)).toBe(false);
  });

  test("logs asks_setting_keep_failed when the off can't be written back", async () => {
    writeAsksEnabled(layout, false);
    const realOpen = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith("asks.json.new")) throw new Error("disk full");
      return realOpen(...args);
    });
    try {
      expect(await manager().deleteWorkingState(BOT, "unused")).toBeUndefined();
    } finally {
      open.mockRestore();
    }
    expect(lines.some(line => line.includes(`"bots":"asks_setting_keep_failed"`))).toBe(true);
    expect(existsSync(asksFile(layout))).toBe(false);
  });
});
