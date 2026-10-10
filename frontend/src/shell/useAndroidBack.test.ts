import { describe, expect, test } from "bun:test";

import { topOverlay } from "./useAndroidBack";

describe("Android Back overlay selection", () => {
  test("selects the top explicitly marked recorder sheet or card", () => {
    const recorder = { id: "recorder" } as HTMLElement;
    const sheet = { id: "notes-sheet" } as HTMLElement;
    const doc = { querySelectorAll: () => [recorder, sheet] } as unknown as Document;
    expect(topOverlay(doc)).toBe(sheet);
  });

  test("returns no overlay when none are open", () => {
    const doc = { querySelectorAll: () => [] } as unknown as Document;
    expect(topOverlay(doc)).toBeNull();
  });
});
