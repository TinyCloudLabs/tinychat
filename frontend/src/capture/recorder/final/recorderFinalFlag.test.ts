import { describe, expect, test } from "bun:test";
import { resolveRecorderFinal } from "./recorderFinalFlag";

const env = (value?: string) => ({ VITE_EXO_RECORDER_FINAL: value });

describe("resolveRecorderFinal", () => {
  test("is off unless the build turns it on", () => {
    expect(resolveRecorderFinal({})).toBe(false);
    expect(resolveRecorderFinal(env("false"))).toBe(false);
    expect(resolveRecorderFinal(env("true"))).toBe(true);
  });
  test("anything else is a configuration error", () => {
    for (const value of ["", "1", "TRUE", "yes"])
      expect(() => resolveRecorderFinal(env(value))).toThrow(
        "VITE_EXO_RECORDER_FINAL must be true or false",
      );
  });
});
