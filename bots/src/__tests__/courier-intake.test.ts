import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replyText, type CourierReplyText } from "../courier/guard";
import { guardedAnswer } from "./courier-fixtures";
import { CourierIntake, courierIntakeStore } from "../courier/intake";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "courier-intake-")); dirs.push(dir);
  const key = new Uint8Array(32).fill(7);
  const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
  let now = 1_800_000_000_000;
  let paired = true;
  let grantValid = true;
  const peer = { handle: "cli", peerDid: "did:key:cli", status: "paired" as const, pairedAt: now - 1000, delegationExpiresAt: now + 86_400_000 };
  const messages: Array<{ id: string; threadId: string; kind: string; text: string }> = [];
  const sent: Array<{ thread: string; text: string }> = [];
  const outcomes: Array<{ gateway: "courier"; peer: string; outcome: string }> = [];
  let reads = 0;
  let turns = 0;
  let crash = false;
  let acks = 0;
  let ackFails = false;
  const second = { ...peer, handle: "cli2", peerDid: "did:key:cli2" };
  const secondMessages: Array<{ id: string; threadId: string; kind: string; text: string }> = [];
  const options = {
    owners: [owner], grants: { get: async () => grantValid ? { raw: {}, expiresAt: now + 60_000 } : undefined },
    peers: { list: async () => paired ? [peer, ...(secondMessages.length ? [second] : [])] : [] },
    transport: async (_owner: string, _grant: unknown, who: { handle: string }) => ({
      inbox: async () => { reads++; return who.handle === "cli" ? messages : secondMessages; },
      reply: async (message: { threadId: string }, text: CourierReplyText) => { sent.push({ thread: message.threadId, text: replyText(text) }); if (crash) throw new Error("lost ack"); },
      acknowledge: async () => { acks++; if (ackFails) throw new Error("offline"); },
    }),
    turn: async () => { turns++; return guardedAnswer("answer"); },
    now: () => now, log: (entry: { gateway: "courier"; peer: string; outcome: string }) => outcomes.push(entry),
  };
  const start = () => new CourierIntake({ ...options, store: courierIntakeStore(dir, key) });
  return { start, messages, secondMessages, sent, outcomes, owner, peer, advance: (ms: number) => { now += ms; }, unpair: () => { paired = false; }, expire: () => { grantValid = false; }, crash: () => { crash = true; }, failAcks: () => { ackFails = true; }, counts: () => ({ reads, turns, acks }) };
}

test("same-thread reply, separate conversations and inform stored without a reply", async () => {
  const s = await setup();
  s.messages.push({ id: "m1", threadId: "first", kind: "ask", text: "Home today?" }, { id: "m2", threadId: "second", kind: "inform", text: "FYI" });
  const intake = s.start(); await intake.poll();
  expect(s.sent).toEqual([{ thread: "first", text: "answer" }]);
  const threads = intake.threads(s.owner);
  expect(threads.map(t => t.title)).toEqual(["cli (Courier)", "cli (Courier)"]);
  expect(threads.find(t => t.threadId === "first")?.messages.map(m => m.text)).toEqual(["Home today?", "answer"]);
  expect(threads.find(t => t.threadId === "second")?.messages.map(m => m.text)).toEqual(["FYI"]);
});

test("request, task and verb get exactly the fixed refusal without a model turn", async () => {
  const s = await setup();
  for (const kind of ["request", "task", "verb"]) s.messages.push({ id: kind, threadId: kind, kind, text: "deploy production" });
  await s.start().poll();
  expect(s.counts().turns).toBe(0);
  expect(s.sent.map(m => m.text)).toEqual(Array(3).fill("TrustBot doesn't take requests or tasks over Courier. It can answer questions with what its owner lets it read."));
});

test("receipts prevent duplicate replies after a new instance loads sealed state", async () => {
  const s = await setup(); s.messages.push({ id: "m", threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); await s.start().poll();
  expect(s.sent).toHaveLength(1); expect(s.counts().turns).toBe(1);
});

test("ambiguous send never retries after restart and emits reply_lost", async () => {
  const s = await setup(); s.messages.push({ id: "m", threadId: "t", kind: "ask", text: "hi" }); s.crash();
  await s.start().poll(); await s.start().poll();
  expect(s.sent).toHaveLength(1);
  expect(s.outcomes).toContainEqual({ gateway: "courier", peer: expect.stringMatching(/^[0-9a-f]{12}$/), outcome: "reply_lost" });
});

test("100 inbound per rolling hour per peer survives restart", async () => {
  const s = await setup();
  for (let i = 0; i < 101; i++) s.messages.push({ id: String(i), threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); expect(s.sent).toHaveLength(100);
  await s.start().poll(); expect(s.sent).toHaveLength(100);
  s.advance(3_600_001); s.messages.push({ id: "fresh", threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); expect(s.sent).toHaveLength(101);
});

test("unpaired and expired grants do not even read an inbox", async () => {
  const s = await setup(); s.unpair(); await s.start().poll(); expect(s.counts().reads).toBe(0);
  const other = await setup(); other.expire(); await other.start().poll(); expect(other.counts().reads).toBe(0);
});

test("owner deletion does not delete receipts or replay a handled message", async () => {
  const s = await setup(); s.messages.push({ id: "m", threadId: "t", kind: "ask", text: "hi" });
  const intake = s.start(); await intake.poll();
  intake.deleteThread(s.owner, intake.threads(s.owner)[0]!.id);
  const restarted = s.start(); await restarted.poll();
  expect(restarted.threads(s.owner)).toEqual([]); expect(s.sent).toHaveLength(1);
});

test("transcript text expires after 30 days without erasing replay protection", async () => {
  const s = await setup(); s.messages.push({ id: "m", threadId: "t", kind: "ask", text: "hi" });
  const intake = s.start(); await intake.poll();
  s.advance(30 * 24 * 3_600_000 + 1);
  const restarted = s.start();
  expect(restarted.threads(s.owner)).toEqual([]);
  await restarted.poll(); expect(s.sent).toHaveLength(1);
});

test("expired peer is not read", async () => {
  const s = await setup(); s.peer.delegationExpiresAt = s.peer.pairedAt;
  await s.start().poll(); expect(s.counts().reads).toBe(0);
});

test("retention evicts the oldest messages and conversations at their caps", async () => {
  const s = await setup(); const intake = s.start();
  for (let batch = 0; batch < 3; batch++) {
    s.messages.splice(0);
    for (let i = 0; i < 90; i++) s.messages.push({ id: `${batch}-${i}`, threadId: "long", kind: "inform", text: `${batch}-${i}` });
    await intake.poll(); s.advance(3_600_001);
  }
  const long = intake.threads(s.owner)[0]!;
  expect(long.messages).toHaveLength(200); expect(long.messages[0]!.text).toBe("0-70");
  s.messages.splice(0);
  for (let i = 0; i < 51; i++) { s.messages.push({ id: `new-${i}`, threadId: `new-${i}`, kind: "inform", text: "hi" }); }
  await intake.poll();
  const threads = intake.threads(s.owner);
  expect(threads).toHaveLength(50); expect(threads.some(t => t.threadId === "long")).toBe(false); expect(threads.some(t => t.threadId === "new-0")).toBe(false);
});

test("the 100 per hour cap is per owner across peers: two peers sending 60 each get 100 answers", async () => {
  const s = await setup();
  for (let i = 0; i < 60; i++) { s.messages.push({ id: `a${i}`, threadId: "t", kind: "ask", text: "hi" }); s.secondMessages.push({ id: `b${i}`, threadId: "t", kind: "ask", text: "hi" }); }
  await s.start().poll();
  expect(s.sent).toHaveLength(100);
  expect(s.outcomes.filter(entry => entry.outcome === "rate_limited")).toHaveLength(20);
  await s.start().poll(); expect(s.sent).toHaveLength(100);
  s.advance(3_600_001); s.messages.push({ id: "fresh", threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); expect(s.sent).toHaveLength(101);
});

test("receipts of acknowledged messages are pruned after 30 days; unacknowledged ones are kept", async () => {
  const pruned = await setup(); pruned.peer.delegationExpiresAt += 90 * 24 * 3_600_000; pruned.messages.push({ id: "m", threadId: "t", kind: "ask", text: "hi" });
  await pruned.start().poll(); expect(pruned.sent).toHaveLength(1); expect(pruned.counts().acks).toBe(1);
  pruned.advance(30 * 24 * 3_600_000 - 1_000); await pruned.start().poll(); expect(pruned.sent).toHaveLength(1);
  pruned.advance(2_000);
  // The sender's inbox no longer lists an acknowledged message; relisting it proves its receipt is gone.
  await pruned.start().poll(); expect(pruned.sent).toHaveLength(2);

  const kept = await setup(); kept.peer.delegationExpiresAt += 90 * 24 * 3_600_000; kept.messages.push({ id: "m", threadId: "t", kind: "ask", text: "hi" }); kept.failAcks();
  await kept.start().poll(); expect(kept.sent).toHaveLength(1);
  kept.advance(31 * 24 * 3_600_000);
  const acksBefore = kept.counts().acks;
  await kept.start().poll(); expect(kept.sent).toHaveLength(1);
  expect(kept.counts().acks).toBeGreaterThan(acksBefore);
  expect(kept.outcomes).toContainEqual({ gateway: "courier", peer: expect.stringMatching(/^[0-9a-f]{12}$/), outcome: "receipt_unavailable" });
});
