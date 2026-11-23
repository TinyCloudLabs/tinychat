import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replyText, type CourierReplyText } from "../courier/guard";
import { botIdFor } from "../owner";
import { guardedAnswer } from "./courier-fixtures";
import { CourierIntake, type CourierIntakeOptions, courierIntakeStore } from "../courier/intake";
import { CourierUpdateRequired } from "../courier/lib-adapter";
import { TinyCloudNode } from "@tinycloud/node-sdk";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Inbound = { id: string; threadId: string; kind: string; text: string };

async function setup(extra: Partial<Omit<CourierIntakeOptions, "store">> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "courier-intake-")); dirs.push(dir);
  const key = new Uint8Array(32).fill(7);
  const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
  let now = 1_800_000_000_000;
  let paired = true;
  let grantValid = true;
  const peer = { handle: "cli", peerDid: "did:key:cli", status: "paired" as const, pairedAt: now - 1000, delegationExpiresAt: now + 86_400_000 };
  const messages: Inbound[] = [];
  const sent: Array<{ thread: string; text: string }> = [];
  const outcomes: Array<{ gateway: "courier"; peer: string; outcome: string }> = [];
  let reads = 0;
  let turns = 0;
  let crash = false;
  let acks = 0;
  let ackFails = false;
  // cli2 to cli6 are listed only once they have mail.
  const others = [2, 3, 4, 5, 6].map(n => ({ ...peer, handle: `cli${n}`, peerDid: `did:key:cli${n}` }));
  const inboxes: Record<string, Inbound[]> = { cli: messages };
  for (const other of others) inboxes[other.handle] = [];
  const inbox = (handle: string) => inboxes[handle]!;
  const options = {
    owners: [owner], grants: { get: async () => grantValid ? { raw: {}, expiresAt: now + 60_000 } : undefined },
    peers: { list: async () => paired ? [peer, ...others.filter(other => inbox(other.handle).length)] : [] },
    transport: async (_owner: string, _grant: unknown, who: { handle: string }) => ({
      inbox: async () => { reads++; return inbox(who.handle); },
      reply: async (message: { threadId: string }, text: CourierReplyText) => { sent.push({ thread: message.threadId, text: replyText(text) }); if (crash) throw new Error("lost ack"); },
      acknowledge: async () => { acks++; if (ackFails) throw new Error("offline"); },
    }),
    turn: async () => { turns++; return guardedAnswer("answer"); },
    now: () => now, libraryReady: () => {}, log: (entry: { gateway: "courier"; peer: string; outcome: string }) => outcomes.push(entry),
  };
  const store = () => courierIntakeStore(dir, key);
  const start = () => new CourierIntake({ ...options, ...extra, store: store() });
  return { start, store, inbox, messages, secondMessages: inbox("cli2"), sent, outcomes, owner, peer, advance: (ms: number) => { now += ms; }, unpair: () => { paired = false; }, expire: () => { grantValid = false; }, crash: () => { crash = true; }, failAcks: () => { ackFails = true; }, counts: () => ({ reads, turns, acks }) };
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

test("20 inbound per rolling hour per peer survives restart", async () => {
  const s = await setup();
  for (let i = 0; i < 21; i++) s.messages.push({ id: String(i), threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); expect(s.sent).toHaveLength(20);
  await s.start().poll(); expect(s.sent).toHaveLength(20);
  s.advance(3_600_001); s.messages.push({ id: "fresh", threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); expect(s.sent).toHaveLength(21);
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
  s.peer.delegationExpiresAt += 90 * 24 * 3_600_000;
  // 20 an hour is the most one peer gets through, so 11 hours fill and overflow one thread's 200 messages.
  for (let batch = 0; batch < 11; batch++) {
    s.messages.splice(0);
    for (let i = 0; i < 20; i++) s.messages.push({ id: `${batch}-${i}`, threadId: "long", kind: "inform", text: `${batch}-${i}` });
    await intake.poll(); s.advance(3_600_001);
  }
  const long = intake.threads(s.owner)[0]!;
  expect(long.messages).toHaveLength(200); expect(long.messages[0]!.text).toBe("1-0");
  for (let round = 0; round < 3; round++) {
    s.messages.splice(0);
    for (let i = 0; i < (round < 2 ? 20 : 11); i++) s.messages.push({ id: `new-${round}-${i}`, threadId: `new-${round}-${i}`, kind: "inform", text: "hi" });
    await intake.poll(); s.advance(3_600_001);
  }
  const threads = intake.threads(s.owner);
  expect(threads).toHaveLength(50); expect(threads.some(t => t.threadId === "long")).toBe(false); expect(threads.some(t => t.threadId === "new-0-0")).toBe(false);
});

test("the 100 per hour cap is per owner across peers: six peers sending 20 each get 100 answers", async () => {
  const s = await setup();
  for (let p = 1; p <= 6; p++) for (let i = 0; i < 20; i++) s.inbox(`cli${p === 1 ? "" : p}`).push({ id: `p${p}-${i}`, threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll();
  expect(s.sent).toHaveLength(100);
  expect(s.outcomes.filter(entry => entry.outcome === "rate_limited")).toHaveLength(20);
  await s.start().poll(); expect(s.sent).toHaveLength(100);
  s.advance(3_600_001); s.messages.push({ id: "fresh", threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); expect(s.sent).toHaveLength(101);
});

test("one peer is held to 20 per hour inside the owner's 100, and the others are still answered", async () => {
  const s = await setup();
  for (let i = 0; i < 25; i++) s.messages.push({ id: `a${i}`, threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); expect(s.sent).toHaveLength(20);
  expect(s.outcomes.filter(entry => entry.outcome === "rate_limited")).toHaveLength(5);
  s.secondMessages.push({ id: "b", threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); expect(s.sent).toHaveLength(21);
  await s.start().poll(); expect(s.sent).toHaveLength(21);
  s.advance(3_600_001); s.messages.push({ id: "fresh", threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll(); expect(s.sent).toHaveLength(22);
});

test("a malformed message or thread id is skipped before any turn, with no receipt", async () => {
  const s = await setup();
  s.messages.push({ id: "has space", threadId: "t", kind: "ask", text: "hi" }, { id: "ok", threadId: "x".repeat(65), kind: "ask", text: "hi" }, { id: "ok", threadId: "a/b", kind: "ask", text: "hi" });
  const intake = s.start(); await intake.poll();
  expect(s.counts().turns).toBe(0); expect(s.sent).toEqual([]); expect(s.counts().acks).toBe(0);
  expect(s.outcomes.filter(entry => entry.outcome === "invalid")).toHaveLength(3);
  expect(intake.threads(s.owner)).toEqual([]);
});

function seeded(owner: string, count: number, acked: (index: number) => boolean) {
  const receipts: Record<string, { peer: string; status: "done"; at: number; acked: boolean }> = {};
  for (let i = 0; i < count; i++) receipts[createHash("sha256").update(`seed-${i}`).digest("hex")] = { peer: "0".repeat(12), status: "done", at: 1_800_000_000_000 - 100_000 + i, acked: acked(i) };
  return { owner, state: { receipts, rate: [], peerRates: {}, threads: {} } };
}

test("over 5,000 receipts the oldest acknowledged go first and every unacknowledged one is kept", async () => {
  const s = await setup(); s.peer.delegationExpiresAt += 90 * 24 * 3_600_000;
  // Receipt 0 is unacknowledged and the oldest; 1 and 2 are acknowledged next-oldest.
  const { state } = seeded(s.owner, 5000, index => index > 0);
  const store = s.store(); store.save(botIdFor(s.owner), state);
  s.messages.push({ id: "new", threadId: "t", kind: "ask", text: "hi" });
  const intake = s.start(); await intake.poll();
  expect(s.sent).toHaveLength(1);
  const after = s.store().load().get(botIdFor(s.owner))!;
  expect(Object.keys(after.receipts)).toHaveLength(5000);
  const ids = (index: number) => createHash("sha256").update(`seed-${index}`).digest("hex");
  expect(after.receipts[ids(0)]).toBeDefined();
  expect(after.receipts[ids(1)]).toBeUndefined();
  expect(after.receipts[ids(2)]).toBeDefined();
});

test("when all 5,000 receipts are unacknowledged, new intake is refused with a log and nothing is dropped", async () => {
  const s = await setup();
  const { state } = seeded(s.owner, 5000, () => false);
  s.store().save(botIdFor(s.owner), state);
  s.messages.push({ id: "new", threadId: "t", kind: "ask", text: "hi" });
  await s.start().poll();
  expect(s.sent).toEqual([]); expect(s.counts().turns).toBe(0);
  expect(s.outcomes.filter(entry => entry.outcome === "receipts_full")).toHaveLength(1);
  expect(Object.keys(s.store().load().get(botIdFor(s.owner))!.receipts)).toHaveLength(5000);
});

test("a turn past its deadline is recorded as reply_lost, sends nothing, is not retried, and the next message is still handled", async () => {
  const hang = Promise.withResolvers<never>();
  const deadlines: AbortController[] = [];
  const entered = Promise.withResolvers<void>();
  let first = true;
  const s = await setup({
    turnSignal: () => { const deadline = new AbortController(); deadlines.push(deadline); return deadline.signal; },
    turn: async () => { if (first) { first = false; entered.resolve(); return hang.promise; } return guardedAnswer("answer"); },
  });
  s.messages.push({ id: "slow", threadId: "t", kind: "ask", text: "hi" }, { id: "next", threadId: "t", kind: "ask", text: "hi" });
  const polling = s.start().poll();
  await entered.promise; deadlines[0]!.abort();
  await polling;
  expect(s.outcomes).toContainEqual({ gateway: "courier", peer: expect.stringMatching(/^[0-9a-f]{12}$/), outcome: "reply_lost" });
  expect(s.sent).toEqual([{ thread: "t", text: "answer" }]);
  await s.start().poll(); expect(s.sent).toHaveLength(1);
  hang.reject(new Error("late")); await Promise.resolve();
});

test("owners are polled two at a time", async () => {
  const owners = ["ab", "cd", "ef"].map(byte => `did:pkh:eip155:1:0x${byte.repeat(20)}`);
  const dir = mkdtempSync(join(tmpdir(), "courier-intake-")); dirs.push(dir);
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  let active = 0; let peak = 0; let started = 0; let sent = 0;
  const now = 1_800_000_000_000;
  const peer = { handle: "cli", peerDid: "did:key:cli", status: "paired" as const, pairedAt: now - 1000, delegationExpiresAt: now + 86_400_000 };
  const intake = new CourierIntake({
    owners, grants: { get: async () => ({ raw: {}, expiresAt: now + 60_000 }) }, peers: { list: async () => [peer] },
    transport: async () => ({
      inbox: async () => [{ id: "m", threadId: "t", kind: "ask", text: "hi" }],
      reply: async () => { sent++; },
      acknowledge: async () => {},
    }),
    turn: async () => { active++; peak = Math.max(peak, active); if (++started === 2) reached.resolve(); await gate.promise; active--; return guardedAnswer("answer"); },
    now: () => now, store: courierIntakeStore(dir, new Uint8Array(32).fill(7)), libraryReady: () => {},
  });
  const polling = intake.poll();
  await reached.promise;
  await new Promise(done => setImmediate(done));
  expect(started).toBe(2);
  gate.resolve(); await polling;
  expect(peak).toBe(2); expect(sent).toBe(3);
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

const headless = Boolean(process.env.TC_COURIER_HEADLESS_PACKAGE);

function untouchedGrants() {
  const lookups: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "courier-intake-")); dirs.push(dir);
  const intake = (extra: Partial<Omit<CourierIntakeOptions, "store">>) => new CourierIntake({
    owners: [`did:pkh:eip155:1:0x${"ab".repeat(20)}`], grants: { get: async owner => { lookups.push(owner); return undefined; } }, peers: { list: async () => [] },
    transport: async () => { throw new Error("unused_transport"); }, turn: async () => guardedAnswer("answer"),
    store: courierIntakeStore(dir, new Uint8Array(32).fill(7)), ...extra,
  });
  return { lookups, intake };
}

test("a library that cannot run headless refuses the poll before any grant lookup", async () => {
  const f = untouchedGrants();
  const intake = f.intake({ libraryReady: () => { throw new CourierUpdateRequired(); } });
  await expect(intake.poll()).rejects.toMatchObject({ code: "courier_update_required" });
  expect(f.lookups).toEqual([]);
  // The refusal leaves no poll marked as running.
  await expect(intake.poll()).rejects.toMatchObject({ code: "courier_update_required" });
});

test.skipIf(headless)("on the installed beta without the headless API, poll restores no grant session and looks up no grant", async () => {
  const f = untouchedGrants();
  const restore = spyOn(TinyCloudNode.prototype, "restoreSession");
  try {
    await expect(f.intake({}).poll()).rejects.toMatchObject({ code: "courier_update_required" });
    expect(restore).not.toHaveBeenCalled();
    expect(f.lookups).toEqual([]);
  } finally { restore.mockRestore(); }
});
