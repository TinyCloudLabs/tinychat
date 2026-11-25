import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { Bot, RunningLimit, type Sandbox } from "../bot";
import { type GatewayConfig, PINNED_UPSTREAM } from "../config";
import { Gateway } from "../gateway";
import { botLayout } from "../layout";
import type { Frame } from "../rpc";

const bot = "a".repeat(64);
const token = "b".repeat(64);
const model = "z-ai/glm-5.2";
const cfg: GatewayConfig = {
  egressRoot: "/egress", modelKey: "fixture", upstream: PINNED_UPSTREAM, models: [model],
  maxTokens: 100, botDailyTokens: 1000, globalDailyTokens: 1500,
  maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024,
  connectTimeoutMs: 1000, totalTimeoutMs: 5000, bodyTimeoutMs: 30_000, budgetFile: "/unused",
};
const request = () => new Request("http://gateway/v1/chat/completions", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }),
});
const response = (tokens: number) => new Response(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: tokens } })}\n\ndata: [DONE]\n\n`, {
  headers: { "content-type": "text/event-stream" },
});
const logs: unknown[] = [];
// Scoped to each test: a spy left on console.log would collect other test files' lines.
let consoleSpy: Mock<typeof console.log>;
beforeEach(() => { consoleSpy = spyOn(console, "log").mockImplementation(line => { logs.push(JSON.parse(line)); }); });
afterEach(() => { logs.length = 0; consoleSpy.mockRestore(); });

function setup(limit = 0, fetch: () => Promise<Response> = async () => response(10)) {
  let now = Date.parse("2026-11-11T23:59:00Z");
  const gateway = new Gateway({ ...cfg, turnSoftLimit: limit }, { now: () => now, fetch });
  gateway.setToken(bot, token);
  return { gateway, setTime: (time: string) => { now = Date.parse(time); } };
}

function meterLogs(event: string) {
  return logs.filter((line): line is Record<string, unknown> => typeof line === "object" && line !== null && (line as Record<string, unknown>).bots === event);
}

test("one multi-call turn logs settled model tokens and call count", async () => {
  const { gateway } = setup(0, async () => response(37));
  gateway.beginTurn(bot);
  await (await gateway.handle(bot, request())).text();
  await (await gateway.handle(bot, request())).text();
  await gateway.endTurn(bot);
  expect(meterLogs("turn_tokens")).toEqual([{ bots: "turn_tokens", bot: bot.slice(0, 12), tokens: 74, calls: 2, ms: expect.any(Number) }]);
  expect(meterLogs("turn_soft_limit")).toEqual([]);
});

test("turn tokens survive a UTC day rollover", async () => {
  const { gateway, setTime } = setup(0, async () => response(31));
  gateway.beginTurn(bot);
  await (await gateway.handle(bot, request())).text();
  setTime("2026-11-12T00:01:00Z");
  await (await gateway.handle(bot, request())).text();
  await gateway.endTurn(bot);
  expect(meterLogs("turn_tokens")[0]).toMatchObject({ tokens: 62, calls: 2 });
});

test("failed upstream model call contributes zero tokens", async () => {
  const { gateway } = setup(0, async () => { throw new Error("offline"); });
  gateway.beginTurn(bot);
  expect((await gateway.handle(bot, request())).status).toBe(502);
  await gateway.endTurn(bot);
  expect(meterLogs("turn_tokens")[0]).toMatchObject({ tokens: 0, calls: 1 });
});

test("soft-limit flag logs once when settled calls first cross the limit", async () => {
  const { gateway } = setup(50, async () => response(30));
  gateway.beginTurn(bot);
  for (let i = 0; i < 3; i++) await (await gateway.handle(bot, request())).text();
  await gateway.endTurn(bot);
  expect(meterLogs("turn_soft_limit")).toEqual([{ bots: "turn_soft_limit", bot: bot.slice(0, 12), tokens: 60, limit: 50 }]);
  expect(meterLogs("turn_tokens")[0]).toMatchObject({ tokens: 90, calls: 3 });
});

test("turn end waits for the in-flight reservation to settle", async () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  const { gateway } = setup(0, () => promise);
  gateway.beginTurn(bot);
  const call = gateway.handle(bot, request());
  let ended = false;
  const end = gateway.endTurn(bot).then(() => { ended = true; });
  resolve(response(29));
  await (await call).text();
  await end;
  expect(ended).toBe(true);
  expect(meterLogs("turn_tokens")[0]).toMatchObject({ tokens: 29, calls: 1 });
});

test("a late previous turn settles without deleting the next turn", async () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  let calls = 0;
  const { gateway } = setup(0, () => ++calls === 1 ? promise : Promise.resolve(response(11)));
  gateway.beginTurn(bot);
  const first = gateway.handle(bot, request());
  const ending = gateway.endTurn(bot);
  gateway.beginTurn(bot);
  resolve(response(29));
  await (await first).text();
  await ending;
  await (await gateway.handle(bot, request())).text();
  await gateway.endTurn(bot);
  expect(meterLogs("turn_tokens").map(line => line.tokens)).toEqual([29, 11]);
});

test("a bot sends turn boundaries around its prompt", async () => {
  const boundaries: string[] = [];
  const prompted = Promise.withResolvers<string>();
  let listener: ((frame: Frame) => void) | undefined;
  const sandbox: Sandbox = {
    nextId: () => "prompt-1",
    request: async command => {
      if (command.type === "prompt") prompted.resolve(command.id as string);
      return { agentInvoked: true };
    },
    onFrame: callback => { listener = callback; return () => { listener = undefined; }; },
    exited: new Promise<void>(() => {}),
    refreshEgress: async () => {},
    snapshot: async () => {},
    stop: async () => {},
  };
  const botInstance = new Bot(botLayout(bot, { dataRoot: "/d", runRoot: "/r", egressRoot: "/e" }), {
    hasState: () => true, leftover: () => false, launch: async () => sandbox,
    beginTurn: async () => { boundaries.push("begin"); },
    endTurn: async () => { boundaries.push("end"); },
  }, { idleMs: 60_000, turnTimeoutMs: 300_000, maxTurnBytes: 16 }, new RunningLimit(1));
  const running = botInstance.send("hi", { status: () => {}, delta: () => {}, done: () => {}, error: () => {} });
  const id = await prompted.promise;
  expect(boundaries).toEqual(["begin"]);
  listener?.({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true });
  await running;
  expect(boundaries).toEqual(["begin", "end"]);
});