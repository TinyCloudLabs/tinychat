import { describe, expect, test } from "bun:test";
import { meetingSourceActionBusy, meetingSourceStatus } from "./meetingSourceState";

describe("meeting source row state", () => {
  test("formats connected and disconnected statuses", () => {
    expect(meetingSourceStatus("connected", "42 minutes ago", 416)).toBe("Connected · synced 42 minutes ago · 416 meetings");
    expect(meetingSourceStatus("disconnected")).toBe("Not connected");
  });

  test("marks in-flight actions busy", () => {
    expect(meetingSourceActionBusy("syncing")).toBe(true);
    expect(meetingSourceActionBusy("connecting")).toBe(true);
    expect(meetingSourceActionBusy("connected")).toBe(false);
  });
});
