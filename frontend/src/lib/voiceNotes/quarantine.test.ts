import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, type VoiceNotesPlugin } from "./nativeVoiceNotes";
import { createCoalescedReader, isUnsupported, readQuarantine, rejectionCode } from "./quarantine";

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

describe("createCoalescedReader", () => {
  const harness = () => {
    const resolvers: Array<(value: number) => void> = [];
    let active = 0;
    let overlapped = false;
    const applied: number[] = [];
    const request = createCoalescedReader(
      () => {
        active++;
        if (active > 1) overlapped = true;
        return new Promise<number>((resolve) =>
          resolvers.push((value) => {
            active--;
            resolve(value);
          }),
        );
      },
      (value) => applied.push(value),
    );
    const settle = async (value: number) => {
      resolvers.shift()!(value);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { request, resolvers, applied, settle, overlapped: () => overlapped };
  };

  test("a request with nothing pending reads at once", () => {
    const { request, resolvers } = harness();
    request();
    expect(resolvers.length).toBe(1);
  });

  test("requests during a pending read give exactly one more read after it, never concurrent", async () => {
    const { request, resolvers, applied, settle, overlapped } = harness();
    request();
    request();
    request();
    expect(resolvers.length).toBe(1);
    await settle(1);
    expect(resolvers.length).toBe(1);
    await settle(2);
    expect(resolvers.length).toBe(0);
    expect(applied).toEqual([1, 2]);
    expect(overlapped()).toBe(false);
  });

  test("a request during the trailing read gets another, one at a time", async () => {
    const { request, resolvers, settle, applied } = harness();
    request();
    request();
    await settle(1);
    request();
    await settle(2);
    expect(resolvers.length).toBe(1);
    await settle(3);
    expect(applied).toEqual([1, 2, 3]);
  });

  test("after the reads settle, the next request reads again", async () => {
    const { request, resolvers, settle } = harness();
    request();
    await settle(1);
    request();
    expect(resolvers.length).toBe(1);
  });
});
