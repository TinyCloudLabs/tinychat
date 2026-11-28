import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { saveCallNamesLater, saveTranscriptCallSpeakerNamesLater, withCallNames } from "./callNamesLater";
import { registerDesktopCaptureExtras } from "./desktopCaptureExtras";
import { createFakeDesktopCaptureExtras } from "./fakeDesktopCaptureExtras";

// The save steps of names in the call load with their own chunk (TC-2882). A chunk that does not load must not
// break the save that started the step: the step is a failed try, never a rejection.

afterEach(() => registerDesktopCaptureExtras(null));

const tcw = {} as TinyCloudWeb;

describe("the save steps of names in the call, loaded on first use", () => {
  test("a chunk that does not load is a failed try, not a rejection, and the step never runs", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let ran = false;
      const outcome = await withCallNames(async () => { ran = true; return "saved" as const; }, "failed" as const,
        () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/callNames-x.js")));
      expect(outcome).toBe("failed");
      expect(ran).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a step that loads runs with callNames.ts", async () => {
    expect(await withCallNames(async (callNames) => typeof callNames.saveCallNames, "failed")).toBe("function");
  });

  test("off the desktop app, the names step is none without loading anything", async () => {
    registerDesktopCaptureExtras(null);
    expect(await saveCallNamesLater(tcw, "rec-1", "vn-rec-1")).toBe("none");
  });

  test("on the desktop app, the names step loads and answers as saveCallNames does", async () => {
    registerDesktopCaptureExtras(createFakeDesktopCaptureExtras({ callNames: { enabled: true, permission: "granted", read: {} } }).extras);
    expect(await saveCallNamesLater(tcw, "rec-1", "vn-rec-1")).toBe("none");
  });

  test("a transcript whose lines carry no person of the call has no who-spoke-when step", async () => {
    const sentences = [{ speaker_name: "Them 1", speaker_id: null }, { speaker_name: "Me", speaker_id: "channel:0" }];
    expect(await saveTranscriptCallSpeakerNamesLater(tcw, "rec-1", "vn-rec-1", sentences)).toBe("none");
  });
});
