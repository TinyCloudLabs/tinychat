import { expect, test } from "bun:test";
import { compareWaiting, rankReason, validateRecord, waitingReport } from "@tinyboilerplate/core/feed/sitrep";
import type { WaitingRank } from "@tinyboilerplate/core/feed/sitrep";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";

const rank = (changes: Partial<WaitingRank> = {}): WaitingRank => ({
  waitsOnOthers: undefined, dueSoon: false, deadlineAt: undefined, critical: false, unblockWeight: 0, pin: 0,
  urgency: 2, importance: 2, since: "2026-10-29T10:00:00.000Z", anchor: "a", ...changes,
});
const first = (a: WaitingRank, b: WaitingRank) => compareWaiting(a, b) < 0 && compareWaiting(b, a) > 0;

test("a card at urgency 4 or more leads whatever else the other card has going for it", () => {
  const urgent = rank({ urgency: 4, importance: 3, anchor: "z" });
  for (const other of [
    rank({ pin: 2, urgency: 3, importance: 5 }),
    rank({ dueSoon: true, deadlineAt: Date.parse(SITREP_NOW) - 1000, urgency: 3, importance: 5 }),
    rank({ critical: true, urgency: 3, importance: 5 }),
    rank({ unblockWeight: 9, urgency: 3, importance: 5 }),
  ]) expect(first(urgent, other)).toBe(true);
  // A card waiting on an officer still leads once it is urgent, and trails every other card once it is not.
  const waiting = { by: "Amos" } as WaitingRank["waitsOnOthers"];
  expect(first(rank({ urgency: 4, importance: 1, waitsOnOthers: waiting }), rank({ pin: 2 }))).toBe(true);
  expect(first(rank({ pin: 2 }), rank({ urgency: 3, importance: 5, waitsOnOthers: waiting }))).toBe(true);
});

test("urgent cards order among themselves by urgency times importance, then by the usual rules", () => {
  expect(first(rank({ urgency: 4, importance: 5 }), rank({ urgency: 5, importance: 3 }))).toBe(true);
  expect(first(rank({ urgency: 5, importance: 5 }), rank({ urgency: 4, importance: 5 }))).toBe(true);
  expect(first(rank({ urgency: 4, importance: 4, pin: 2 }), rank({ urgency: 4, importance: 4 }))).toBe(true);
});

test("urgency 3 does not jump ahead: the order below that is unchanged", () => {
  expect(first(rank({ pin: 2, urgency: 3, importance: 1 }), rank({ urgency: 3, importance: 5 }))).toBe(true);
  expect(first(rank({ dueSoon: true, deadlineAt: 1, urgency: 1, importance: 1 }), rank({ urgency: 3, importance: 5 }))).toBe(true);
});

test("the reason line says why an urgent card is first", () => {
  const reason = (changes: Partial<WaitingRank>) => rankReason({ ...rank(changes), unblocked: 0, unblockedCritical: 0, blocks: undefined }, Date.parse(SITREP_NOW));
  expect(reason({ urgency: 4, importance: 3 })).toBe("urgent: U4·I3");
  expect(reason({ urgency: 4, importance: 3, pin: 2, dueSoon: true, deadlineAt: Date.parse(SITREP_NOW) - 1000 })).toBe("urgent: U4·I3");
  expect(reason({ urgency: 3, importance: 3, pin: 2 })).toBe("your priority");
});

test("the owner's waiting list puts an urgent card above a due-soon one", () => {
  const ask = (id: string, changes: Record<string, unknown>) => {
    const parsed = validateRecord("ask", { ...syntheticRecord("ask"), id, ...changes });
    if (!parsed.ok) throw new Error(`Invalid synthetic ask ${id}: ${JSON.stringify(parsed.errors ?? parsed)}`);
    return parsed.value;
  };
  const dueSoon = ask("due-soon", { urgency: 2, importance: 2, deadline: "2026-10-29T13:00:00.000Z" });
  const urgent = ask("urgent", { urgency: 4, importance: 3, deadline: undefined });
  const calm = ask("calm", { urgency: 3, importance: 3, deadline: undefined });
  const order = waitingReport({ records: [dueSoon, calm, urgent], answers: [], states: [] }, Date.parse(SITREP_NOW)).waiting.map((item) => item.record.id);
  expect(order[0]).toBe("urgent");
  expect(order.indexOf("due-soon")).toBeLessThan(order.indexOf("calm"));
});
