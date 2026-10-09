import { describe, expect, test } from "bun:test";
import {
  meetingCount,
  meetingSourceActionBusy,
  meetingSourceStatus,
  meetingSourcesSummary,
  syncedAgo,
} from "./meetingSourceState";

const NOW = Date.parse("2026-10-09T12:00:00Z");

describe("meeting source row state", () => {
  test("a connected source is a filled dot with relative sync time and a count", () => {
    expect(meetingSourceStatus("connected", "42 minutes ago", 416)).toEqual({
      tone: "on",
      text: "Connected · synced 42 minutes ago · 416 meetings",
    });
    expect(meetingSourceStatus("connected", "just now", 1).text).toBe(
      "Connected · synced just now · 1 meeting",
    );
  });

  test("not connected is hollow, in-flight work is the pulsing busy tone", () => {
    expect(meetingSourceStatus("disconnected")).toEqual({ tone: "off", text: "Not connected" });
    expect(meetingSourceStatus("syncing")).toEqual({ tone: "busy", text: "Syncing…" });
    expect(meetingSourceStatus("connecting")).toEqual({ tone: "busy", text: "Connecting…" });
  });

  test("marks in-flight actions busy", () => {
    expect(meetingSourceActionBusy("syncing")).toBe(true);
    expect(meetingSourceActionBusy("connecting")).toBe(true);
    expect(meetingSourceActionBusy("connected")).toBe(false);
    expect(meetingSourceActionBusy("disconnected")).toBe(false);
  });

  test("relative time", () => {
    expect(syncedAgo("2026-10-09T11:18:00Z", NOW)).toBe("42 minutes ago");
    expect(syncedAgo("2026-10-09T11:59:40Z", NOW)).toBe("just now");
    expect(syncedAgo("2026-10-09T11:00:00Z", NOW)).toBe("1 hour ago");
    expect(syncedAgo("2026-10-06T12:00:00Z", NOW)).toBe("3 days ago");
    expect(syncedAgo(null, NOW)).toBe("never");
    expect(syncedAgo("not a date", NOW)).toBe("never");
  });

  test("counts and the Capture entry summary", () => {
    expect(meetingCount(1)).toBe("1 meeting");
    expect(meetingCount(0)).toBe("0 meetings");
    expect(
      meetingSourcesSummary([
        { name: "Fireflies", connected: true, count: 416 },
        { name: "Google Meet", connected: false, count: 0 },
      ]),
    ).toBe("Fireflies connected · 416 meetings");
    expect(
      meetingSourcesSummary([
        { name: "Fireflies", connected: true, count: 416 },
        { name: "Google Meet", connected: true, count: 11 },
      ]),
    ).toBe("Fireflies and Google Meet connected · 427 meetings");
    expect(meetingSourcesSummary([{ name: "Fireflies", connected: false, count: 0 }])).toBe(
      "Nothing connected yet",
    );
  });
});
