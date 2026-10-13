import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { OPEN_SETTINGS_FAILED_LINE, openSettingsFailedLine } from "./micDeniedCopy";

describe("openSettingsFailedLine", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("returns the generic line and never the raw plugin error", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    spies.push(logged);
    const cause = new Error('"VoiceNotes.openSettings()" is not implemented on ios');
    const line = openSettingsFailedLine(cause);
    expect(line).toBe(OPEN_SETTINGS_FAILED_LINE);
    expect(line).not.toContain("VoiceNotes");
    expect(line).not.toContain("not implemented");
  });

  test("logs the cause with console.error", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    spies.push(logged);
    const cause = new Error("boom");
    openSettingsFailedLine(cause);
    expect(logged).toHaveBeenCalledWith("[Recorder] Could not open Settings", cause);
  });

  test("a non-Error cause gets the same line", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    spies.push(logged);
    expect(openSettingsFailedLine("plain string")).toBe(OPEN_SETTINGS_FAILED_LINE);
  });
});
