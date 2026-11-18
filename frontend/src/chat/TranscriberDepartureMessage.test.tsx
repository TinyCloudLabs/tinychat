import { describe, expect, test } from "bun:test";

import { departureMessage } from "./TranscriberSection";
import type { TranscriberMeeting } from "@/lib/transcriberApi";

function failedMeeting(completionReason: string): TranscriberMeeting {
  return {
    id: "mtg_refused",
    status: "failed",
    platform: "google_meet",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    bot: { name: "TinyCloud Private Notetaker" },
    created_at: "2026-11-18T10:00:00.000Z",
    capture: { completion_reason: completionReason },
  } as TranscriberMeeting;
}

describe("departureMessage when the notetaker was refused at the door", () => {
  const message = departureMessage(failedMeeting("awaiting_admission_rejected"))!;

  test("tells the owner Meet refused the notetaker and names the Meeting access setting", () => {
    expect(message).toContain("Google Meet didn't let the notetaker in");
    expect(message).toContain("Meeting access");
  });

  test("does not claim the host declined, because the refusal can be automatic", () => {
    expect(message.toLowerCase()).not.toMatch(/declined|denied|rejected/);
  });

  test("a wait that timed out keeps its own wording", () => {
    expect(departureMessage(failedMeeting("awaiting_admission_timeout"))).toBe(
      "Bot timed out waiting to be admitted.",
    );
  });
});
