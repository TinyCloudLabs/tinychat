// One owner's bots share a daily total in the gateway (TC-3325), beside each bot's own limit.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GatewayConfig, PINNED_UPSTREAM } from "../config";
import { fileOwnerStore, Gateway, type OwnerStore, type UpstreamFetch } from "../gateway";

const tmp = mkdtempSync(join(tmpdir(), "gateway-owner-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const MAIN = "a".repeat(64);
const SIBLING = "b".repeat(64);
const STRANGER = "c".repeat(64);
const TOKENS: Record<string, string> = { [MAIN]: "1".repeat(64), [SIBLING]: "2".repeat(64), [STRANGER]: "3".repeat(64) };
const MODEL = "z-ai/glm-5.2";
const NOON = Date.parse("2026-11-11T12:00:00Z");

const cfg: GatewayConfig = {
  egressRoot: "/egress",
  modelKey: "model-key",
  upstream: PINNED_UPSTREAM,
  models: [MODEL],
  maxTokens: 100,
  botDailyTokens: 1000,
  ownerDailyTokens: 1200,
  globalDailyTokens: 100_000,
  maxBodyBytes: 4096,
  maxResponseBytes: 1024 * 1024,
  connectTimeoutMs: 1000,
  totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000,
  budgetFile: "/unused",
};

/** Every call reports `total` tokens used. */
function upstream(total: number): UpstreamFetch {
  return async () => {
    const events = [{ choices: [{ index: 0, delta: { content: "pong" } }] }, { choices: [], usage: { total_tokens: total } }];
    return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
}

async function chat(gateway: Gateway, botId: string): Promise<number> {
  const response = await gateway.handle(botId, new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKENS[botId]}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ping" }], stream: true }),
  }));
  await response.text();
  return response.status;
}

function memoryOwners(): OwnerStore & { saved: Record<string, string> | undefined; fail: boolean } {
  const store = {
    saved: undefined as Record<string, string> | undefined,
    fail: false,
    load: () => store.saved,
    save: (owners: Record<string, string>) => {
      if (store.fail) throw new Error("disk full");
      store.saved = { ...owners };
    },
  };
  return store;
}

function register(gateway: Gateway): void {
  gateway.setToken(MAIN, TOKENS[MAIN]!);
  gateway.setToken(SIBLING, TOKENS[SIBLING]!, MAIN);
  gateway.setToken(STRANGER, TOKENS[STRANGER]!);
}

describe("owner total", () => {
  test("a sibling's use counts against its owner, and another owner is untouched", async () => {
    const gateway = new Gateway(cfg, { fetch: upstream(500), now: () => NOON });
    register(gateway);
    expect(await chat(gateway, MAIN)).toBe(200);
    expect(await chat(gateway, SIBLING)).toBe(200);
    // 1000 of the owner's 1200 are used: the next call fits, and the one after is refused for both of the
    // owner's bots, though each is well inside its own 1000.
    expect(await chat(gateway, SIBLING)).toBe(200);
    expect(gateway.usage(MAIN).bot).toBe(500);
    expect(gateway.usage(SIBLING).bot).toBe(1000);
    expect(await chat(gateway, MAIN)).toBe(429);
    expect(await chat(gateway, SIBLING)).toBe(429);
    expect(await chat(gateway, STRANGER)).toBe(200);
  });

  test("without an owner total configured, an owner's bots together get what one bot gets", async () => {
    const { ownerDailyTokens: _unset, ...plain } = cfg;
    const gateway = new Gateway(plain, { fetch: upstream(500), now: () => NOON });
    register(gateway);
    expect(await chat(gateway, MAIN)).toBe(200);
    expect(await chat(gateway, SIBLING)).toBe(200);
    expect(await chat(gateway, MAIN)).toBe(429);
    expect(await chat(gateway, SIBLING)).toBe(429);
  });

  test("a bot registered alone is limited exactly as before", async () => {
    const gateway = new Gateway(cfg, { fetch: upstream(500), now: () => NOON });
    register(gateway);
    expect(await chat(gateway, STRANGER)).toBe(200);
    expect(await chat(gateway, STRANGER)).toBe(200);
    expect(await chat(gateway, STRANGER)).toBe(429);
  });

  test("a sibling registered again without its owner stays under that owner", async () => {
    const owners = memoryOwners();
    const gateway = new Gateway(cfg, { fetch: upstream(600), now: () => NOON, ownerStore: owners });
    register(gateway);
    gateway.setToken(SIBLING, TOKENS[SIBLING]!);
    gateway.setToken(SIBLING, TOKENS[SIBLING]!, STRANGER);
    expect(owners.saved).toEqual({ [SIBLING]: MAIN });
    expect(await chat(gateway, MAIN)).toBe(200);
    expect(await chat(gateway, SIBLING)).toBe(200);
    expect(await chat(gateway, SIBLING)).toBe(429);
    expect(await chat(gateway, STRANGER)).toBe(200);
  });

  test("the owner map survives a restart, so a restarted gateway still totals the sibling under its owner", async () => {
    const owners = memoryOwners();
    const budget = { saved: undefined as unknown, load: () => budget.saved as never, save: (snapshot: unknown) => { budget.saved = structuredClone(snapshot); } };
    const first = new Gateway(cfg, { fetch: upstream(600), now: () => NOON, store: budget, ownerStore: owners });
    register(first);
    expect(await chat(first, MAIN)).toBe(200);
    expect(await chat(first, SIBLING)).toBe(200);
    expect(owners.saved).toEqual({ [SIBLING]: MAIN });
    // After the restart only Main has registered again; the sibling's 600 still count against the owner.
    const second = new Gateway(cfg, { fetch: upstream(600), now: () => NOON, store: budget, ownerStore: owners });
    second.setToken(MAIN, TOKENS[MAIN]!);
    expect(await chat(second, MAIN)).toBe(429);
  });

  test("if the owner map cannot be saved, model calls are refused until it can", async () => {
    const owners = memoryOwners();
    owners.fail = true;
    const gateway = new Gateway(cfg, { fetch: upstream(100), now: () => NOON, ownerStore: owners });
    register(gateway);
    expect(await chat(gateway, MAIN)).toBe(503);
    expect(await chat(gateway, SIBLING)).toBe(503);
    owners.fail = false;
    expect(await chat(gateway, SIBLING)).toBe(200);
    expect(owners.saved).toEqual({ [SIBLING]: MAIN });
  });

  test("the owner file round-trips, and a malformed one stops the start", () => {
    const path = join(tmp, "owners.json");
    const store = fileOwnerStore(path);
    expect(store.load()).toBeUndefined();
    store.save({ [SIBLING]: MAIN });
    expect(fileOwnerStore(path).load()).toEqual({ [SIBLING]: MAIN });
    for (const bad of ["not json", JSON.stringify({ [SIBLING]: "short" }), JSON.stringify({ short: MAIN }), JSON.stringify([MAIN])]) {
      writeFileSync(path, bad);
      expect(() => fileOwnerStore(path).load()).toThrow();
    }
  });
});
