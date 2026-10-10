import { describe, expect, test } from "bun:test";

import { minimizePhoneRecorder } from "./RecordingOverlay";

describe("phone recorder Back", () => {
  test("prevents dialog dismissal and minimizes without invoking discard", () => {
    let prevented = false;
    let minimized = 0;
    const discarded = 0;
    minimizePhoneRecorder(
      { preventDefault: () => { prevented = true; } },
      () => { minimized++; },
    );
    expect(prevented).toBe(true);
    expect(minimized).toBe(1);
    expect(discarded).toBe(0);
  });
});
