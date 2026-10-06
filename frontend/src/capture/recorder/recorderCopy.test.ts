// The recorder's words: durations, the length limit, and what the OS says about
// the microphone (moved with the helpers from the old Voice notes card, TC-761).
import { describe, expect, test } from "bun:test";

import { formatDuration, formatLimit, limitNoticeText, micStatusText, micWarningSentence, recorderMetaText, recorderStatusText } from "./recorderCopy";

const HOUR = 60 * 60 * 1000;
const recording = { state: "recording", reason: null } as const;

describe("recorderCopy", () => {
  test("formatDuration: minutes and zero-padded seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9_999)).toBe("0:09");
    expect(formatDuration(600_000)).toBe("10:00");
  });

  test("the limit shows only in the last five minutes (TC-517)", () => {
    expect(micStatusText("recording", recording, 54 * 60_000, HOUR)).toBe("Recording 54:00");
    expect(micStatusText("recording", recording, 55 * 60_000, HOUR)).toBe("Recording 55:00 of 60:00");
    expect(micStatusText("recording", { state: "silenced", reason: "os_silenced" }, 59 * 60_000, HOUR)).toContain("Recording 59:00 of 60:00, but");
    expect(recorderMetaText(0, 54 * 60_000, HOUR)).toStartWith("Voice note · started ");
    expect(recorderMetaText(0, 55 * 60_000, HOUR)).toBe("Stops at 60:00");
  });

  test("a note stopped at the limit says so", () => {
    expect(limitNoticeText(HOUR)).toBe("Stopped at the 60-minute limit.");
    expect(formatLimit(15_000)).toBe("15-second");
    expect(formatLimit(90_000)).toBe("90-second");
  });

  test("the OS's mic problems: the card's sentences, and the recorder's short status", () => {
    expect(micStatusText("recording", { state: "silenced", reason: "os_silenced" }, 3_000)).toContain("the system is blocking the microphone");
    expect(micStatusText("recording", { state: "recording", reason: "no_signal" }, 3_000)).toContain("no sound is reaching the microphone");
    expect(micWarningSentence({ state: "silenced", reason: "os_silenced" })).toBe(
      "The system is blocking the microphone (a call, another app, or the mic privacy toggle).",
    );
    expect(micWarningSentence({ state: "recording", reason: "no_signal" })).toBe("No sound is reaching the microphone.");
    expect(micWarningSentence(recording)).toBeNull();
    expect(recorderStatusText("recording", { state: "silenced", reason: "os_silenced" }, null)).toBe("Mic silenced");
    expect(recorderStatusText("recording", { state: "recording", reason: "no_signal" }, null)).toBe("No sound");
    expect(recorderStatusText("saving", recording, 42)).toBe("Saving to your space · 42%");
    expect(recorderStatusText("starting", recording, null)).toBe("Starting the microphone…");
  });
});
