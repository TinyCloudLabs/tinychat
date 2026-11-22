import { describe, expect, test } from "bun:test";
import { DECLINE_COOLDOWN_MS, questionHash, utcDay } from "../asks";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { type BudgetStore, Gateway } from "../gateway";

const BOT = "a".repeat(64);
const TOKEN = "1".repeat(64);
const NOW = Date.parse("2026-11-11T12:00:00Z");

const cfg = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});
const store: BudgetStore = { load: () => undefined, save: () => {} };

async function ask(gateway: Gateway, question: string) {
  const response = await gateway.handle(BOT, new Request("http://localhost/v1/mcp/app", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_owner", arguments: { question } } }),
  }));
  const result = ((await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { text: result.content[0]!.text, isError: result.isError === true };
}

describe("when two questions count as the same one after a decline", () => {
  test("case, spacing, punctuation and apostrophes do not tell them apart", () => {
    const same = ["Which city?", "which city", "  WHICH   CITY?? ", "Which, city...", "Which city!", "“Which city?”", "Which-city?"];
    for (const question of same) expect(questionHash(question)).toBe(questionHash("Which city?"));
    expect(questionHash("Don't you know?")).toBe(questionHash("dont you know"));
    expect(questionHash("Don’t you know?")).toBe(questionHash("dont you know"));
  });

  test("a different question is a different one", () => {
    for (const other of ["Which town?", "Which city and when?", "city which?", "Which cities?"]) expect(questionHash(other)).not.toBe(questionHash("Which city?"));
  });

  test("a question reworded only by punctuation is refused for the hour, and any other question is not", async () => {
    let clock = NOW;
    const gateway = new Gateway(cfg(), { fetch: async () => Response.json({}), now: () => clock, store });
    gateway.setToken(BOT, TOKEN);
    gateway.setAsks(BOT, {
      enabled: true, pending: 0, day: utcDay(NOW), today: 0,
      declined: [{ hash: questionHash("Which city?"), until: NOW + DECLINE_COOLDOWN_MS }],
    });
    for (const reworded of ["which city", "Which city!!", "Which — city?", "(Which city?)"]) {
      const refused = await ask(gateway, reworded);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("not now");
    }
    expect((await ask(gateway, "Which town?")).isError).toBe(false);
    expect((await ask(gateway, "Something else entirely?")).isError).toBe(false);
    clock = NOW + DECLINE_COOLDOWN_MS + 1;
    expect((await ask(gateway, "which city")).isError).toBe(false);
  });
});
