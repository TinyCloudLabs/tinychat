import { describe, expect, test } from "bun:test";
import {
  meetingCount,
  meetingSourceActionBusy,
  meetingSourceStatus,
  meetingSourcesSummary,
  persistedSyncProblem,
  sourceRowDisplay,
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

describe("a saved sync failure is shown when the window is reopened", () => {
  const connection = (patch: Partial<Parameters<typeof sourceRowDisplay>[0]["connection"] & object>) => ({
    status: "connected",
    lastSyncedAt: "2026-10-09T11:00:00Z",
    lastSyncStatus: "ok" as string | null,
    lastSyncError: null as string | null,
    itemCount: 4,
    ...patch,
  });
  const display = (conn: ReturnType<typeof connection> | null, rest: { syncError?: string | null; rowNote?: string | null } = {}) =>
    sourceRowDisplay({
      comingSoon: false,
      connection: conn,
      syncing: false,
      connecting: false,
      syncError: rest.syncError ?? null,
      rowNote: rest.rowNote ?? null,
    });

  test("a clean connection is plain Connected with no error", () => {
    const row = display(connection({}));
    expect(row.status?.text).toStartWith("Connected · synced");
    expect(row.error).toBeNull();
  });

  test("a saved failure reads Last sync failed and shows the saved message", () => {
    const row = display(connection({ lastSyncStatus: "error", lastSyncError: "Reconnect Google Meet to keep syncing." }));
    expect(row.status?.text).toStartWith("Last sync failed · synced");
    expect(row.error).toBe("Reconnect Google Meet to keep syncing.");
  });

  test("a saved partial sync reads Last sync incomplete", () => {
    const row = display(connection({ lastSyncStatus: "partial", lastSyncError: "2 meetings could not be fetched." }));
    expect(row.status?.text).toStartWith("Last sync incomplete · synced");
    expect(row.error).toBe("2 meetings could not be fetched.");
  });

  test("this window's current failure wins over the saved one, then a row note", () => {
    const failed = connection({ lastSyncStatus: "error", lastSyncError: "saved" });
    expect(display(failed, { syncError: "now", rowNote: "note" }).error).toBe("now");
    expect(display(failed, { rowNote: "note" }).error).toBe("note");
  });

  test("a disconnected source shows no saved failure", () => {
    expect(persistedSyncProblem(connection({ status: "disconnected", lastSyncStatus: "error", lastSyncError: "x" }))).toBeNull();
    expect(display(connection({ status: "disconnected", lastSyncStatus: "error", lastSyncError: "x" })).error).toBeNull();
  });
});
