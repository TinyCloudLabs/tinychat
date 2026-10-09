import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, type VoiceNotesPlugin } from "./nativeVoiceNotes";
import { isUnsupported, readQuarantine, rejectionCode } from "./quarantine";

const rejecting = (error: unknown): VoiceNotesPlugin =>
  ({
    ...createFakeVoiceNotes().plugin,
    listQuarantine: () => Promise.reject(error),
  }) as VoiceNotesPlugin;

afterEach(() =>
  __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: null }),
);

describe("readQuarantine", () => {
  test("lists what native parked", async () => {
    const fake = createFakeVoiceNotes();
    fake.controls.quarantine("a", "corrupt_journal", 10);
    __setVoiceNotesForTests(fake.plugin, { available: true });
    expect(await readQuarantine()).toEqual({
      kind: "items",
      items: [{ id: "a", reason: "corrupt_journal", sizeBytes: 10 }],
    });
  });

  for (const code of ["unsupported", "UNSUPPORTED"]) {
    test(`a ${code} rejection is an empty list, not an error`, async () => {
      const error = spyOn(console, "error").mockImplementation(() => {});
      __setVoiceNotesForTests(rejecting(Object.assign(new Error("x"), { code })), {
        available: true,
      });
      expect(await readQuarantine()).toEqual({ kind: "items", items: [] });
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    });
  }

  for (const code of ["unimplemented", "UNIMPLEMENTED"]) {
    test(`a ${code} rejection is a real bridge failure: surfaced and logged`, async () => {
      const error = spyOn(console, "error").mockImplementation(() => {});
      const caught = Object.assign(new Error("x"), { code });
      __setVoiceNotesForTests(rejecting(caught), { available: true });
      expect(await readQuarantine()).toEqual({ kind: "failed", caught });
      expect(error).toHaveBeenCalledTimes(1);
      error.mockRestore();
    });
  }

  test("any other rejection surfaces and is logged", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const caught = Object.assign(new Error("disk"), { code: "io_error" });
    __setVoiceNotesForTests(rejecting(caught), { available: true });
    expect(await readQuarantine()).toEqual({ kind: "failed", caught });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  test("a rejection with no code surfaces", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    __setVoiceNotesForTests(rejecting(new Error("boom")), { available: true });
    expect((await readQuarantine()).kind).toBe("failed");
    error.mockRestore();
  });
});

test("rejection codes", () => {
  expect(rejectionCode({ code: "Not_Failed_Recording" })).toBe("not_failed_recording");
  expect(rejectionCode("x")).toBeNull();
  expect(rejectionCode(null)).toBeNull();
  expect(isUnsupported({ code: "unsupported" })).toBe(true);
  expect(isUnsupported({ code: "not_found" })).toBe(false);
  expect(isUnsupported({ code: "unimplemented" })).toBe(false);
});
