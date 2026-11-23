import { expect, spyOn, test } from "bun:test";
import type { GatewayConfig } from "../config";
import { Gateway } from "../gateway";
import { COURIER_READS_PER_DAY, MeetingDesk, READS_PER_DAY } from "../meeting-reads";
import { botIdFor } from "../owner";
import { courierBotId } from "../courier/bot-id";
import { courierTurn, COURIER_BUDGET } from "../courier/turn";

const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const bot = botIdFor(owner);
const token = "1".repeat(64);
const config = (botDailyTokens: number): GatewayConfig => ({ egressRoot: "/unused", modelKey: "fixture", upstream: "https://model.test", models: ["m"], maxTokens: 100, botDailyTokens, globalDailyTokens: 1_000_000, maxBodyBytes: 4096, maxResponseBytes: 4096, connectTimeoutMs: 1000, totalTimeoutMs: 5000, bodyTimeoutMs: 1000, budgetFile: "/unused" });
const body = { model: "m", messages: [{ role: "user", content: "question" }] };
const mainChat = () => new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

test("Courier has its own bot id and budget, and emits only Courier log fields", async () => {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation(text => { lines.push(text); });
  let calls = 0;
  const gateway = new Gateway(config(100), { fetch: async () => { calls++; return Response.json({ choices: [{ message: { content: "answer" } }] }); } });
  try {
    const first = await gateway.courierModel(owner, "a".repeat(12), body); await first.text();
    expect(first.status).toBe(200); expect(gateway.usage(courierBotId(owner)).bot).toBeGreaterThan(0); expect(gateway.usage(bot).bot).toBe(0);
    const refused = await gateway.courierModel(owner, "a".repeat(12), body);
    expect(refused.status).toBe(429); expect(refused.headers.get("x-courier-refusal")).toBe("budget"); expect(calls).toBe(1);
    expect(courierBotId(owner)).not.toBe(bot);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) { const entry = JSON.parse(line); expect(Object.keys(entry).sort()).toEqual(["gateway", "outcome", "peer"]); expect(entry.gateway).toBe("courier"); }
  } finally { log.mockRestore(); }
});

test("the owner's chat is still answered when Courier is out of budget", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const gateway = new Gateway(config(100), { fetch: async () => Response.json({ choices: [{ message: { content: "answer" } }] }) });
  gateway.setToken(bot, token);
  try {
    await (await gateway.courierModel(owner, "a".repeat(12), body)).text();
    expect((await gateway.courierModel(owner, "a".repeat(12), body)).status).toBe(429);
    const main = await gateway.handle(bot, mainChat());
    expect(main.status).toBe(200); await main.text();
  } finally { log.mockRestore(); }
});

test("a Courier turn holds its own slot, not Main's: Main is answered meanwhile and a second Courier call is concurrency-refused", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const gateway = new Gateway(config(100_000), { fetch: async () => { if (calls++ === 0) { started.resolve(); await release.promise; } return Response.json({ choices: [{ message: { content: "answer" } }] }); } });
  gateway.setToken(bot, token);
  try {
    const first = gateway.courierModel(owner, "a".repeat(12), body);
    await started.promise;
    const second = await gateway.courierModel(owner, "b".repeat(12), body);
    expect(second.status).toBe(429); expect(second.headers.get("x-courier-refusal")).toBe("concurrency");
    const main = await gateway.handle(bot, mainChat());
    expect(main.status).toBe(200); await main.text();
    release.resolve(); await (await first).text();
  } finally { log.mockRestore(); }
});

function readDesk() {
  let calls = 0;
  const reads = new MeetingDesk({ backendOrigin: "https://backend.test", backendCallSecret: "s".repeat(48), fetch: async () => { calls++; return Response.json({ ok: true, text: "Retrieved." }); } });
  reads.push(bot, { owner, areas: ["feed_chats"], conversation: "a".repeat(32) });
  return { reads, calls: () => calls };
}
const setting = { owner, areas: ["feed_chats" as const], conversation: "b".repeat(32) };

test("Courier reads stop at their sub-cap of 50 a day while the owner's own reads continue under the 200 total", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const { reads, calls } = readDesk();
  try {
    expect(COURIER_READS_PER_DAY).toBe(50);
    for (let i = 0; i < COURIER_READS_PER_DAY; i++) expect((await reads.call(bot, "list_chats", {}, { peer: "a".repeat(12), setting })).isError).toBeFalsy();
    const over = await reads.call(bot, "list_chats", {}, { peer: "a".repeat(12), setting });
    expect(over.isError).toBe(true); expect(calls()).toBe(COURIER_READS_PER_DAY);
    // A new conversation or another peer does not reset it: the cap is per owner.
    expect((await reads.call(bot, "list_chats", {}, { peer: "c".repeat(12), setting: { ...setting, conversation: "c".repeat(32) } })).isError).toBe(true);
    expect((await reads.call(bot, "list_chats", {})).isError).toBeFalsy();
    expect(calls()).toBe(COURIER_READS_PER_DAY + 1);
  } finally { log.mockRestore(); }
});

test("Courier reads count toward the owner's 200 total and add no held mark", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const { reads } = readDesk();
  try {
    for (let i = 0; i < READS_PER_DAY - COURIER_READS_PER_DAY; i++) await reads.call(bot, "list_chats", {});
    for (let i = 0; i < COURIER_READS_PER_DAY; i++) await reads.call(bot, "list_chats", {}, { peer: "a".repeat(12), setting });
    expect((await reads.call(bot, "list_chats", {})).isError).toBe(true);
    let round = 0; const inputs: unknown[] = [];
    await courierTurn({ owner, handle: "cli", peerDid: "did:key:cli", threadId: "t", text: "Home?", reads, enabledReadAreas: async () => ["feed_chats"], deniedChatIds: async () => new Set(), model: async input => { inputs.push(structuredClone(input)); return round++ === 0 ? { content: null, tool_calls: [{ id: "r", function: { name: "list_chats", arguments: "{}" } }] } : { content: "Reading allowance used." }; } });
    expect(JSON.stringify(inputs[1])).toContain(COURIER_BUDGET);
  } finally { log.mockRestore(); }
});

test("a Courier read never leaves a held mark, and its lock does not make Main's read busy", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const saved: unknown[] = [];
  let calls = 0;
  const reads = new MeetingDesk({
    backendOrigin: "https://backend.test", backendCallSecret: "s".repeat(48), store: { load: () => undefined, save: marks => { saved.push(marks); } },
    fetch: async () => { if (calls++ === 0) { started.resolve(); await release.promise; } return Response.json({ ok: true, text: "Retrieved." }); },
  });
  reads.push(bot, { owner, areas: ["feed_chats"], conversation: "a".repeat(32) });
  try {
    const courierRead = reads.call(bot, "list_chats", {}, { peer: "a".repeat(12), setting });
    await started.promise;
    expect((await reads.call(bot, "list_chats", {})).isError).toBeFalsy();
    release.resolve(); await courierRead;
    // Only Main's own read marked its conversation.
    expect(saved).toEqual([{ [bot]: "a".repeat(32) }]);
  } finally { log.mockRestore(); }
});
