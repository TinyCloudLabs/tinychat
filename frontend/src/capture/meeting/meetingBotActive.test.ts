// The notetaker reads only while it is on screen (TC-761): Capture stays
// mounted while another destination shows, so useMeetingBot's list read, its
// 5 s poll and its 60 s calendar refresh all hang off `active`. There is no
// DOM harness here, so the timer rule is a pure function, asserted directly,
// and a source check pins the hook's effects to it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { activeMeetings, meetingBotTimers, type ListStatus } from "@/chat/TranscriberSection";
import type { TranscriberListRow, TranscriberMeeting } from "@/lib/transcriberApi";

describe("meetingBotTimers", () => {
  test("off screen, nothing runs, even with a meeting still moving", () => {
    for (const listStatus of ["idle", "loading", "ready", "dark", "unavailable", "offline", "signed-out"] as ListStatus[]) {
      expect(meetingBotTimers({ active: false, anyActive: true, listStatus })).toEqual({ calendar: false, poll: false });
      expect(meetingBotTimers({ active: false, anyActive: false, listStatus })).toEqual({ calendar: false, poll: false });
    }
  });

  test("on screen, the calendar refreshes; the list polls only while a meeting is moving and the backend has a notetaker", () => {
    expect(meetingBotTimers({ active: true, anyActive: true, listStatus: "ready" })).toEqual({ calendar: true, poll: true });
    expect(meetingBotTimers({ active: true, anyActive: false, listStatus: "ready" })).toEqual({ calendar: true, poll: false });
    expect(meetingBotTimers({ active: true, anyActive: true, listStatus: "dark" })).toEqual({ calendar: true, poll: false });
  });
});

describe("activeMeetings", () => {
  const meeting = (id: string, status: TranscriberMeeting["status"]): TranscriberMeeting => ({
    id,
    status,
    platform: "google_meet",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    created_at: "2026-10-06T09:00:00.000Z",
  });

  test("the In progress rows are the sessions still moving; settled and unreadable rows are not", () => {
    const rows: TranscriberListRow[] = [
      meeting("a", "in_progress"),
      meeting("b", "completed"),
      meeting("c", "processing"),
      { id: "d", unavailable: true } as TranscriberListRow,
      meeting("e", "failed"),
    ];
    expect(activeMeetings(rows).map((m) => m.id)).toEqual(["a", "c"]);
  });
});

describe("useMeetingBot's effects follow `active`", () => {
  const source = readFileSync(join(import.meta.dir, "../../chat/TranscriberSection.tsx"), "utf8");
  const hook = source.slice(source.indexOf("export function useMeetingBot("));

  test("every read and timer in the hook is behind active", () => {
    expect(hook).toContain("const timers = meetingBotTimers({ active, anyActive, listStatus });");
    // The calendar refresh: returns at once unless on screen; re-runs when that changes.
    expect(hook).toMatch(/useEffect\(\(\) => \{\s*if \(!timers\.calendar\) return;[\s\S]*?\}, \[calendar, timers\.calendar\]\);/);
    // The list: read when shown, and each return re-reads it.
    expect(hook).toMatch(/useEffect\(\(\) => \{\s*if \(active\) void load\(\);\s*\}, \[load, active\]\);/);
    // The 5 s poll: only while the rule says so; leaving clears the interval.
    expect(hook).toMatch(
      /useEffect\(\(\) => \{\s*if \(!timers\.poll\) return;\s*const timer = setInterval\(\(\) => void load\(\), POLL_INTERVAL_MS\);\s*return \(\) => clearInterval\(timer\);\s*\}, \[timers\.poll, load\]\);/,
    );
    expect(hook.match(/setInterval\(/g)).toHaveLength(2);
  });

  test("Capture passes whether its home is on screen", () => {
    const capture = readFileSync(join(import.meta.dir, "../CaptureSurface.tsx"), "utf8");
    expect(capture).toContain("useMeetingBot({ backendUrl, sessionStore, active: homeShown })");
    expect(capture).toContain("const homeShown = active && !libraryShown;");
  });
});
