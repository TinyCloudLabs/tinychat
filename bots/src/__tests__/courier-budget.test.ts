import { expect, spyOn, test } from "bun:test";
import type { GatewayConfig } from "../config";
import { Gateway } from "../gateway";
import { MeetingDesk, READS_PER_DAY } from "../meeting-reads";
import { botIdFor } from "../owner";
import { courierTurn, COURIER_BUDGET } from "../courier/turn";

const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const bot = botIdFor(owner);
test("Courier calls share Main's daily model budget and emit only Courier log fields", async () => {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation(text => { lines.push(text); });
  let calls = 0;
  const cfg: GatewayConfig = { egressRoot: "/unused", modelKey: "fixture", upstream: "https://model.test", models: ["m"], maxTokens: 100, botDailyTokens: 100, globalDailyTokens: 1000, maxBodyBytes: 4096, maxResponseBytes: 4096, connectTimeoutMs: 1000, totalTimeoutMs: 5000, bodyTimeoutMs: 1000, budgetFile: "/unused" };
  const gateway = new Gateway(cfg, { fetch: async () => { calls++; return Response.json({ choices: [{ message: { content: "answer" } }] }); } });
  const body = { model: "m", messages: [{ role: "user", content: "question" }] };
  try {
    const first = await gateway.courierModel(bot, "a".repeat(12), body); await first.text();
    expect(first.status).toBe(200); expect(gateway.usage(bot).bot).toBeGreaterThan(0);
    const refused = await gateway.courierModel(bot, "a".repeat(12), body);
    expect(refused.status).toBe(429); expect(refused.headers.get("x-courier-refusal")).toBe("budget"); expect(calls).toBe(1);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) { const entry = JSON.parse(line); expect(Object.keys(entry).sort()).toEqual(["gateway", "outcome", "peer"]); expect(entry.gateway).toBe("courier"); }
  } finally { log.mockRestore(); }
});

test("a Courier turn holds Main's one slot: a second call is refused as concurrency, not budget", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const cfg: GatewayConfig = { egressRoot: "/unused", modelKey: "fixture", upstream: "https://model.test", models: ["m"], maxTokens: 100, botDailyTokens: 100_000, globalDailyTokens: 1_000_000, maxBodyBytes: 4096, maxResponseBytes: 4096, connectTimeoutMs: 1000, totalTimeoutMs: 5000, bodyTimeoutMs: 1000, budgetFile: "/unused" };
  const gateway = new Gateway(cfg, { fetch: async () => { started.resolve(); await release.promise; return Response.json({ choices: [{ message: { content: "answer" } }] }); } });
  const body = { model: "m", messages: [{ role: "user", content: "question" }] };
  try {
    const first = gateway.courierModel(bot, "a".repeat(12), body);
    await started.promise;
    const second = await gateway.courierModel(bot, "b".repeat(12), body);
    expect(second.status).toBe(429); expect(second.headers.get("x-courier-refusal")).toBe("concurrency");
    release.resolve(); await (await first).text();
  } finally { log.mockRestore(); }
});

test("Courier reads cannot reset or bypass Main's existing daily read allowance", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  let calls = 0;
  const reads = new MeetingDesk({ backendOrigin: "https://backend.test", backendCallSecret: "s".repeat(48), fetch: async () => { calls++; return Response.json({ ok: true, text: "Retrieved." }); } });
  reads.push(bot, { owner, areas: ["feed_chats"], conversation: "a".repeat(32) });
  try {
    for (let i = 0; i < READS_PER_DAY; i++) await reads.call(bot, "list_chats", {});
    let round = 0; const inputs: unknown[] = [];
    await courierTurn({ owner, handle: "cli", peerDid: "did:key:cli", threadId: "t", text: "Home?", reads, enabledReadAreas: async () => ["feed_chats"], deniedChatIds: async () => new Set(), model: async body => { inputs.push(structuredClone(body)); return round++ === 0 ? { content: null, tool_calls: [{ id: "r", function: { name: "list_chats", arguments: "{}" } }] } : { content: "Reading allowance used." }; } });
    expect(calls).toBe(READS_PER_DAY); expect(JSON.stringify(inputs[1])).toContain(COURIER_BUDGET);
  } finally { log.mockRestore(); }
});
