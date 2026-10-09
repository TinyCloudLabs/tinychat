import { describe, expect, test } from "bun:test";
import { localRecorderCardShown } from "./localRecorderGate";

describe("today's Mac recorder card", () => {
  test("flag off: shown in the desktop app, never elsewhere, whatever the recorder says", () => {
    for (const recorderAvailable of [true, false]) {
      expect(localRecorderCardShown({ tauri: true, flag: false, recorderAvailable })).toBe(true);
      expect(localRecorderCardShown({ tauri: false, flag: false, recorderAvailable })).toBe(false);
    }
  });

  test("flag on, shared recorder installed: the card goes, so Record is not offered twice", () => {
    expect(localRecorderCardShown({ tauri: true, flag: true, recorderAvailable: true })).toBe(false);
  });

  test("flag on, no recorder (its engine failed to install): the card stays the only way to record", () => {
    expect(localRecorderCardShown({ tauri: true, flag: true, recorderAvailable: false })).toBe(true);
  });

  test("flag on, browser or phone: never shown", () => {
    for (const recorderAvailable of [true, false])
      expect(localRecorderCardShown({ tauri: false, flag: true, recorderAvailable })).toBe(false);
  });
});
