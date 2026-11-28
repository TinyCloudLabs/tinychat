import { describe, expect, test } from "bun:test";
import type { CalendarAutojoinOutcome } from "./calendarAutojoinApi";
import {
  createFailedRecordingDismissals, failedRecordingCard, failedRecordingsToShow, FAILED_RECORDING_WINDOW_MS,
} from "./failedRecordingNotice";

const NOW = Date.parse("2026-11-28T12:00:00.000Z");
const outcome = (id: string, over: Partial<CalendarAutojoinOutcome> = {}): CalendarAutojoinOutcome =>
  ({ id, title: `Meeting ${id}`, start: NOW - 60 * 60_000, reason: "failed", ...over });
const none = new Set<string>();

describe("TC-4461 which failed recordings count", () => {
  test("only failed recordings count", () => {
    const shown = failedRecordingsToShow([outcome("a"), outcome("b", { reason: "missed" }), outcome("c", { reason: "not_accepted" }), outcome("d", { reason: "capacity_exhausted" })], none, NOW);
    expect(shown.map(o => o.id)).toEqual(["a"]);
  });

  test("the 24 hour edge: a start 24 hours ago no longer counts, a millisecond inside still does", () => {
    const edge = failedRecordingsToShow([outcome("edge", { start: NOW - FAILED_RECORDING_WINDOW_MS }), outcome("in", { start: NOW - FAILED_RECORDING_WINDOW_MS + 1 })], none, NOW);
    expect(edge.map(o => o.id)).toEqual(["in"]);
  });

  test("a start in the future never counts", () => {
    expect(failedRecordingsToShow([outcome("future", { start: NOW + 1 })], none, NOW)).toEqual([]);
  });

  test("dismissed recordings are left out and the rest are newest first", () => {
    const shown = failedRecordingsToShow([outcome("old", { start: NOW - 5 * 3600_000 }), outcome("gone"), outcome("new", { start: NOW - 60_000 })], new Set(["gone"]), NOW);
    expect(shown.map(o => o.id)).toEqual(["new", "old"]);
  });
});

describe("TC-4461 the card's words", () => {
  test("one recording: the reason line from the failure code and the title", () => {
    const card = failedRecordingCard([outcome("a", { title: "Weekly sync", failureCode: "waiting_room_timeout" })])!;
    expect(card).toMatchObject({ lead: "A meeting recording did not finish", prefix: "", title: "Weekly sync",
      reason: "The notetaker was not admitted from the waiting room in time.", dismissLabel: "Dismiss notice about Weekly sync", ids: ["a"] });
  });

  test("several recordings: a count, the most recent one and one Dismiss for all of them", () => {
    const card = failedRecordingCard([outcome("a", { title: "Latest" }), outcome("b"), outcome("c")])!;
    expect(card).toMatchObject({ lead: "3 meeting recordings did not finish", prefix: "Most recent, ", title: "Latest",
      reason: "The notetaker could not complete this recording.", dismissLabel: "Dismiss notice about these recordings", ids: ["a", "b", "c"] });
  });

  test("an untitled or blank title reads Untitled meeting", () => {
    expect(failedRecordingCard([outcome("a", { title: "   " })])!.title).toBe("Untitled meeting");
    expect(failedRecordingCard([outcome("a", { title: undefined })])!.title).toBe("Untitled meeting");
  });

  test("no failed recording, no card", () => {
    expect(failedRecordingCard([])).toBeNull();
  });
});

describe("TC-4461 dismissals on this device", () => {
  const memoryStorage = () => {
    const map = new Map<string, string>();
    return { map, storage: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } } };
  };

  test("kept per owner, case-insensitively, across store instances, and never for another owner", () => {
    const { storage } = memoryStorage();
    createFailedRecordingDismissals(() => storage).write("did:pkh:eip155:1:0xABC", ["a", "b"]);
    const later = createFailedRecordingDismissals(() => storage);
    expect([...later.read("did:pkh:eip155:1:0xabc")].sort()).toEqual(["a", "b"]);
    expect(later.read("did:pkh:eip155:1:0xdef").size).toBe(0);
  });

  test("a later dismissal adds to the earlier one and tells listeners", () => {
    const { storage } = memoryStorage();
    const store = createFailedRecordingDismissals(() => storage);
    let calls = 0;
    const stop = store.subscribe(() => { calls++; });
    store.write("s", ["a"]);
    store.write("s", ["b"]);
    stop();
    store.write("s", ["c"]);
    expect([...store.read("s")].sort()).toEqual(["a", "b", "c"]);
    expect(calls).toBe(2);
  });

  test("storage that cannot be read means none dismissed; one that cannot be written keeps the answer for this load", () => {
    const unreadable = createFailedRecordingDismissals(() => ({ getItem: () => { throw new Error("no"); }, setItem: () => {} }));
    expect(unreadable.read("s").size).toBe(0);
    const unwritable = createFailedRecordingDismissals(() => ({ getItem: () => null, setItem: () => { throw new Error("full"); } }));
    unwritable.write("s", ["a"]);
    expect([...unwritable.read("s")]).toEqual(["a"]);
  });

  test("a damaged stored value counts as none dismissed", () => {
    const { storage, map } = memoryStorage();
    map.set("tcw.tc4461.failedRecordings.s", "{not json");
    expect(createFailedRecordingDismissals(() => storage).read("s").size).toBe(0);
    map.set("tcw.tc4461.failedRecordings.s", JSON.stringify({ a: 1 }));
    expect(createFailedRecordingDismissals(() => storage).read("s").size).toBe(0);
  });
});
