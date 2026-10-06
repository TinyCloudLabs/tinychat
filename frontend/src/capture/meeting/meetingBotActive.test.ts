// The notetaker reads only while it is on screen (TC-761): Capture stays
// mounted while another destination shows, so useMeetingBot's list read, its
// 5 s poll and its 60 s calendar refresh all hang off `active`. The timer rule
// is a pure function, asserted here; useMeetingBot.test.tsx mounts the hook
// and checks the reads themselves (no overlap, nothing after leaving).
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

describe("Capture's notetaker", () => {
  test("Capture passes whether its home is on screen", () => {
    const capture = readFileSync(join(import.meta.dir, "../CaptureSurface.tsx"), "utf8");
    expect(capture).toContain("useMeetingBot({ backendUrl, sessionStore, active: homeShown })");
    // On a phone the home shares Capture with the Library and a note; from medium up it is always beside them.
    expect(capture).toContain("const homeShown = active && (wide || (!libraryScreen && !noteScreen));");
  });
});
