import { expect, test } from "bun:test";
import { joinHistory, utcStamp, type HistoryItem } from "./HistoryTimeline";

test("two histories join into one rail, oldest first, with a step both list once and the latest alone current", () => {
  const record: HistoryItem[] = [
    { key: "went-live", at: "2026-11-16T15:15:00.000Z", title: "Went live" },
    { key: "posted", at: "2026-11-16T15:30:00.000Z", title: "Posted to the board" },
  ];
  const owner: HistoryItem[] = [
    { key: "seen", at: "2026-11-16T16:00:00.000Z", title: "You opened it", tone: "current" },
    { key: "posted-again", at: "2026-11-16T15:30:00.000Z", title: "Posted to the board" },
  ];
  const joined = joinHistory(owner, record);
  expect(joined.map((item) => [item.title, item.tone])).toEqual([["Went live", "done"], ["Posted to the board", "done"], ["You opened it", "current"]]);
});

test("a failed step stays failed, and a step with no readable time sorts first instead of scrambling the rest", () => {
  const joined = joinHistory([
    { key: "late", at: "2026-11-16T16:00:00.000Z", title: "Done" },
    { key: "bad", at: "not a time", title: "Posted" },
    { key: "failed", at: "2026-11-16T15:00:00.000Z", title: "Failed", tone: "failed" },
  ]);
  expect(joined.map((item) => [item.title, item.tone])).toEqual([["Posted", "done"], ["Failed", "failed"], ["Done", "current"]]);
});

test("a step's time reads in UTC as the mock does, with the year only when it is not this one", () => {
  const now = Date.parse("2026-11-19T00:00:00.000Z");
  expect(utcStamp("2026-11-16T15:15:00.000Z", now)).toBe("16 Nov, 15:15 UTC");
  expect(utcStamp("2026-11-16T05:05:00.000Z", now)).toBe("16 Nov, 05:05 UTC");
  expect(utcStamp("2025-03-02T23:59:00.000Z", now)).toBe("2 Mar 2025, 23:59 UTC");
  expect(utcStamp("not a time", now)).toBe("not a time");
});
