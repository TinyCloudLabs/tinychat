// TC-3195: a link's display comes from a record anyone could have made, so every field is checked before it is shown.
import { describe, expect, test } from "bun:test";

import { includesLabel, parseRecordingDisplay, shortAddress, sourceLabel } from "./display";

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

  test("strips control and bidi characters, so a title reads as it is written", () => {
    expect(parseRecordingDisplay({ ...VALID, title: "Invoice\u202Etxt.exe\u202C" })?.title).toBe("Invoicetxt.exe");
    expect(parseRecordingDisplay({ ...VALID, title: "Line one\nLine\u0000two\u2066\u2069" })?.title).toBe("Line one Line two");
    expect(parseRecordingDisplay({ ...VALID, title: "\u200E\u200F\u0007" })).toBeNull();
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

  test("a sender name is unsigned, so it is ignored, never refused or kept", () => {
    for (const senderName of [" Sam Lee ", "", 7, null]) {
      const parsed = parseRecordingDisplay({ ...VALID, senderName });
      expect(parsed).not.toBeNull();
      expect(parsed).not.toHaveProperty("senderName");
    }
  });
});

describe("display labels", () => {
  test("the sender is the verified owner's short address", () => {
    expect(shortAddress(OWNER)).toBe("0xd559…f412");
    expect(shortAddress("0xabc")).toBe("0xabc");
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
