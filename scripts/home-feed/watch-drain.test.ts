import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFeedMessage, getFeedHandoff } from "@tinycloud/sdk-services/feed";
import type { FeedResponse } from "@tinycloud/sdk-services/feed";
import { boardKey } from "@tinyboilerplate/core/feed/sitrep";
import { drainHomeMirrorResponses, homeMirrorDrainStart, publishHomeMirror } from "./bridge";
import { boardCard } from "./inventory";
import { boardRecord, mirrorNode, NOW, T1, take } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

/** One mirrored ask and a recipient whose runner always accepts. */
async function mirrored(space?: string) {
  const f = await mirrorNode(space ? { space } : {}); cleanup.push(() => f.close());
  const record = boardRecord("ask", "drain-ask"), key = boardKey("ask", record.id);
  take(await f.legacy.put(key, JSON.stringify(record), { prefix: "", contentType: "application/json" }));
  const card = boardCard({ key, record }, [record], Date.parse(NOW));
  await publishHomeMirror(f.ctx, { source: { ...f.source, label: "Rocinante" }, card, legacy: { spaceId: f.space, fullKey: key, record } });
  const delivered: string[] = [];
  const options = { source: f.source, recipient: "roci-runner", handoff: f.ledger, deliver: async (response: FeedResponse) => { delivered.push(response.responseId); return "delivered" as const; } };
  // An owner card action (Acknowledge): handed off as a note, never closing the card, so any number can be sent.
  const acknowledge = async () => take(await appendFeedMessage(f.output, f.responses, { cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, responseId: randomUUID(), kind: "message", text: "Acknowledged", createdAt: T1 }, { type: "feed.acknowledge", version: 1, data: {} }));
  f.resetCalls();
  return { f, card, options, delivered, acknowledge };
}

async function cycleCosts(handedOff: number) {
  const m = await mirrored();
  for (let index = 0; index < handedOff; index += 1) await m.acknowledge();
  const mark = await drainHomeMirrorResponses(m.f.ctx, { ...m.options, afterSequence: 0 });
  expect(m.delivered).toHaveLength(handedOff);
  // A cycle with nothing new (every ready and every hook renewal runs one).
  m.f.resetCalls();
  const idle = await drainHomeMirrorResponses(m.f.ctx, { ...m.options, afterSequence: mark });
  const idleCalls = m.f.calls();
  expect(idle).toBe(mark);
  // A cycle with one new response.
  await m.acknowledge(); m.f.resetCalls();
  await drainHomeMirrorResponses(m.f.ctx, { ...m.options, afterSequence: idle });
  const oneNewCalls = m.f.calls();
  expect(m.delivered).toHaveLength(handedOff + 1);
  return { idle: idleCalls.length, oneNew: oneNewCalls.length, idleCalls };
}

test("a watch cycle costs the same with 3 or 40 responses already handed off: one page read when nothing is new", async () => {
  const few = await cycleCosts(3), many = await cycleCosts(40);
  expect(few.idleCalls.every((call) => call.endsWith(":feed_responses_roci_fixture"))).toBe(true);
  expect(few.idle).toBe(2); // the delivery page and its restore metadata
  expect(many.idle).toBe(few.idle);
  expect(many.oneNew).toBe(few.oneNew);
});

test("a drain passes over responses the ledger already holds without reading them from the node", async () => {
  const m = await mirrored();
  for (let index = 0; index < 5; index += 1) await m.acknowledge();
  await drainHomeMirrorResponses(m.f.ctx, { ...m.options, afterSequence: 0 });
  // Even from the start of the table, five handed-off responses cost only the page reads.
  m.f.resetCalls();
  await drainHomeMirrorResponses(m.f.ctx, { ...m.options, afterSequence: 0 });
  expect(m.f.calls()).toHaveLength(2);
  expect(m.delivered).toHaveLength(5);
});

test("a restarted watch starts after the last response it handed off, or before one it left prepared", async () => {
  const m = await mirrored();
  expect(await homeMirrorDrainStart(m.f.ctx, m.options)).toBe(0);
  const saved: FeedResponse[] = [];
  for (let index = 0; index < 4; index += 1) saved.push(await m.acknowledge());
  await drainHomeMirrorResponses(m.f.ctx, { ...m.options, afterSequence: 0 });
  expect(await homeMirrorDrainStart(m.f.ctx, m.options)).toBe(saved[3]!.sequence);
  expect(await homeMirrorDrainStart(m.f.ctx, { ...m.options, recipient: "another-recipient" })).toBe(0);
  // A crash between claiming and confirming leaves a handoff prepared: the next start goes back for it.
  take(await m.f.ledger.execute("UPDATE feed_handoffs SET state='prepared' WHERE response_id=?", [saved[1]!.responseId]));
  const start = await homeMirrorDrainStart(m.f.ctx, m.options);
  expect(start).toBe(saved[1]!.sequence - 1);
  await drainHomeMirrorResponses(m.f.ctx, { ...m.options, afterSequence: start });
  expect(m.delivered.filter((id) => id === saved[1]!.responseId)).toHaveLength(2);
  expect(take(await getFeedHandoff(m.f.ledger, saved[1]!.responseId, m.options.recipient))?.state).toBe("delivered");
  expect(m.delivered.filter((id) => id === saved[2]!.responseId)).toHaveLength(1);
});

test("an unconfirmed handoff is not offered to the runner again", async () => {
  const m = await mirrored();
  const first = await m.acknowledge();
  let attempts = 0;
  const unconfirmed = { ...m.options, deliver: async () => { attempts += 1; return "unconfirmed" as const; } };
  const mark = await drainHomeMirrorResponses(m.f.ctx, { ...unconfirmed, afterSequence: 0 });
  await drainHomeMirrorResponses(m.f.ctx, { ...unconfirmed, afterSequence: 0 });
  expect(attempts).toBe(1);
  expect(take(await getFeedHandoff(m.f.ledger, first.responseId, m.options.recipient))?.state).toBe("unconfirmed");
  expect(await homeMirrorDrainStart(m.f.ctx, m.options)).toBe(mark);
});

test("a handoff ledger serves one owner's source: another source's watch is refused, so its pending answers are never skipped", async () => {
  const a = await mirrored(), b = await mirrored("tinycloud:pkh:eip155:1:0x6666666666666666666666666666666666666666:applications");
  await a.acknowledge(); await a.acknowledge();
  await drainHomeMirrorResponses(a.f.ctx, { ...a.options, afterSequence: await homeMirrorDrainStart(a.f.ctx, a.options) });
  const pending = await b.acknowledge();
  // B's first response has sequence 1, below A's mark of 2 in the shared ledger.
  expect(pending.sequence).toBe(1);
  const shared = { ...b.options, handoff: a.f.ledger };
  await expect(homeMirrorDrainStart(b.f.ctx, shared)).rejects.toThrow("This handoff ledger belongs to another Home feed source");
  await expect(drainHomeMirrorResponses(b.f.ctx, { ...shared, afterSequence: 0 })).rejects.toThrow("This handoff ledger belongs to another Home feed source");
  expect(b.delivered).toEqual([]);
  // With its own ledger, B starts from the beginning and its answer is handed off.
  await drainHomeMirrorResponses(b.f.ctx, { ...b.options, afterSequence: await homeMirrorDrainStart(b.f.ctx, b.options) });
  expect(b.delivered).toEqual([pending.responseId]);
});

test("a ledger that already holds handoffs but names no source is refused rather than guessed", async () => {
  const m = await mirrored();
  take(await m.f.ledger.execute("INSERT INTO feed_handoffs (response_id,recipient,state,response_json) VALUES (?,?,?,?)", [randomUUID(), m.options.recipient, "delivered", JSON.stringify({ sequence: 7 })]));
  await expect(homeMirrorDrainStart(m.f.ctx, m.options)).rejects.toThrow("This handoff ledger belongs to another Home feed source");
});
