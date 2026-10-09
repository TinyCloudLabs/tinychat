import { describe, expect, test } from "bun:test";
import { availableStops, defaultMode, identifySpeakersControl, modeAvailability, modeShortLabel, moveMode, readIdentifySpeakers, readMode, writeIdentifySpeakers, writeMode } from "./transcriptionModes";

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
describe("transcription modes", () => {
  test("availability changes by shell and feature flags", () => {
    expect(modeAvailability("local", "web")).toEqual({ available: false, reason: "needs the app" });
    expect(modeAvailability("powerful", "phone").available).toBe(false);
    expect(availableStops("phone").map((x) => x.id)).toEqual(["private"]);
  });
  test("navigation skips unavailable stops", () => {
    expect(moveMode("private", -1, "phone")).toBe("private");
    expect(moveMode("private", 1, "web")).toBe("private");
  });
  test("defaults and sticky mode are injected through storage", () => {
    expect(defaultMode("phone")).toBe("private");
    expect(defaultMode("desktop")).toBe("private");
    expect(defaultMode("web")).toBe("private");
    const s = storage(); writeMode("private", s);
    expect(readMode("phone", null, s)).toBe("private");
  });
  test("speaker identification is sticky, off by default and Powerful only", () => {
    const s = storage();
    expect(readIdentifySpeakers(s)).toBe(false);
    writeIdentifySpeakers(true, s);
    expect(readIdentifySpeakers(s)).toBe(true);
    expect(identifySpeakersControl("private", true)).toMatchObject({ checked: false, disabled: true });
    expect(modeShortLabel("powerful", true)).toBe("Powerful");
  });
});
