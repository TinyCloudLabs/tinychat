// TC-3195: a link's display comes from a record anyone could have made, so every field is checked before it is shown.
import { describe, expect, test } from "bun:test";

import { includesLabel, parseRecordingDisplay, senderFirstName, senderLabel, shortAddress, sourceLabel } from "./display";

const VALID = {
  title: "Product sync with Priya",
  recordedAt: "2026-11-16T14:00:00.000Z",
  durationSeconds: 1924,
  includes: ["transcript", "audio"],
  source: "meeting",
};
const OWNER = "0xd5590000000000000000000000000000000ff412";

describe("parseRecordingDisplay", () => {
  test("keeps the fields the app writes", () => {
    expect(parseRecordingDisplay(VALID)).toEqual({ ...VALID, includes: ["transcript", "audio"], source: "meeting" });
  });

  test("normalizes: trimmed title, ISO time, whole seconds, parts in a fixed order, a null duration", () => {
    const parsed = parseRecordingDisplay({ ...VALID, title: "  Sync  ", recordedAt: "2026-11-16T15:00:00+01:00", durationSeconds: 61.6, includes: ["audio", "transcript"] });
    expect(parsed).toMatchObject({ title: "Sync", recordedAt: "2026-11-16T14:00:00.000Z", durationSeconds: 62, includes: ["transcript", "audio"] });
    expect(parseRecordingDisplay({ ...VALID, durationSeconds: null })?.durationSeconds).toBeNull();
    expect(parseRecordingDisplay({ ...VALID, durationSeconds: undefined })?.durationSeconds).toBeNull();
  });

  test("drops fields it does not know", () => {
    const parsed = parseRecordingDisplay({ ...VALID, extra: "<script>", token: "tc1:secret" });
    expect(parsed).not.toHaveProperty("extra");
    expect(parsed).not.toHaveProperty("token");
  });

  test("refuses anything that is not an object", () => {
    for (const value of [null, undefined, "x", 1, [VALID]]) expect(parseRecordingDisplay(value)).toBeNull();
  });

  test("refuses a missing, empty or overlong title", () => {
    expect(parseRecordingDisplay({ ...VALID, title: undefined })).toBeNull();
    expect(parseRecordingDisplay({ ...VALID, title: "   " })).toBeNull();
    expect(parseRecordingDisplay({ ...VALID, title: 42 })).toBeNull();
    expect(parseRecordingDisplay({ ...VALID, title: "a".repeat(201) })).toBeNull();
    expect(parseRecordingDisplay({ ...VALID, title: "a".repeat(200) })).not.toBeNull();
  });

  test("refuses a time that does not parse", () => {
    expect(parseRecordingDisplay({ ...VALID, recordedAt: "yesterday" })).toBeNull();
    expect(parseRecordingDisplay({ ...VALID, recordedAt: 1_700_000_000_000 })).toBeNull();
  });

  test("refuses a negative, infinite or non-number duration", () => {
    for (const durationSeconds of [-1, Number.POSITIVE_INFINITY, Number.NaN, "32"]) expect(parseRecordingDisplay({ ...VALID, durationSeconds })).toBeNull();
  });

  test("refuses empty, unknown or repeated parts", () => {
    for (const includes of [[], ["video"], ["transcript", "transcript"], ["transcript", "video"], "transcript"]) {
      expect(parseRecordingDisplay({ ...VALID, includes })).toBeNull();
    }
  });

  test("refuses an unknown source", () => {
    expect(parseRecordingDisplay({ ...VALID, source: "podcast" })).toBeNull();
    for (const source of ["meeting", "voice-note", "upload"]) expect(parseRecordingDisplay({ ...VALID, source })?.source).toBe(source);
  });

  test("a sender name, when present, is checked like the title", () => {
    expect(parseRecordingDisplay({ ...VALID, senderName: " Alex Chen " })?.senderName).toBe("Alex Chen");
    expect(parseRecordingDisplay({ ...VALID, senderName: "" })).toBeNull();
    expect(parseRecordingDisplay({ ...VALID, senderName: 7 })).toBeNull();
    expect(parseRecordingDisplay(VALID)).not.toHaveProperty("senderName");
  });
});

describe("display labels", () => {
  test("the sender is the owner's short address when the display names nobody", () => {
    const display = parseRecordingDisplay(VALID)!;
    expect(shortAddress(OWNER)).toBe("0xd559…f412");
    expect(senderLabel(display, OWNER)).toBe("0xd559…f412");
    expect(senderFirstName(display, OWNER)).toBe("0xd559…f412");
    const named = parseRecordingDisplay({ ...VALID, senderName: "Alex Chen" })!;
    expect(senderLabel(named, OWNER)).toBe("Alex Chen");
    expect(senderFirstName(named, OWNER)).toBe("Alex");
  });

  test("parts and sources read as the mock does", () => {
    expect(includesLabel(["transcript", "audio"])).toBe("Transcript and audio");
    expect(includesLabel(["transcript"])).toBe("Transcript");
    expect(includesLabel(["audio"])).toBe("Audio");
    expect(sourceLabel("meeting")).toBe("Meeting");
    expect(sourceLabel("voice-note")).toBe("Voice note");
    expect(sourceLabel("upload")).toBe("Upload");
  });
});
