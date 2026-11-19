import { describe, expect, test } from "bun:test";
import { debugEvents, logPipelineError, setDebugLogEnabledForTests } from "@/lib/debugLog";
import { displayEvent } from "./DebugLogRow";

const RAW_CODE = "STORAGE_QUOTA_EXCEEDED";

describe("Debug log storage-full entries", () => {
  test("the shown entry has a friendly label instead of the raw quota code, while the stored record keeps it", () => {
    setDebugLogEnabledForTests(true);
    try {
      logPipelineError("voice note", Object.assign(new Error("save failed"), { code: RAW_CODE }));
      const stored = debugEvents();
      expect(stored.some((event) => JSON.stringify(event).includes(RAW_CODE))).toBe(true);
      const shown = stored.map((event) => JSON.stringify(displayEvent(event))).join("\n");
      expect(shown).toContain("Storage full");
      expect(shown).not.toContain(RAW_CODE);
    } finally {
      setDebugLogEnabledForTests(false);
    }
  });
});
