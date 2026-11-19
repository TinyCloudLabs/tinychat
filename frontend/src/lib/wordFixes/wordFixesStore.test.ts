import { beforeEach, describe, expect, test } from "bun:test";

import { combineSpace } from "@/harness/fixtures/combineSpace";
import { getSetting, useLocalThreadStorage } from "@/lib/threadStore";
import { applyWordFixesToSentences, NO_WORD_FIXES, WORD_FIXES_SETTING_KEY, withWordFix } from "./wordFixes";
import { loadWordFixes, resetWordFixesForTest, saveWordFixes } from "./wordFixesStore";

beforeEach(resetWordFixesForTest);

describe("the stored list", () => {
  test("a saved list is the settings row, and a fresh load of the space reads it back", async () => {
    const space = combineSpace([]);
    useLocalThreadStorage(space.tcw);
    const list = withWordFix(NO_WORD_FIXES, { find: "tiny cloud", replace: "TinyCloud" });
    await saveWordFixes(space.tcw, list);
    expect(JSON.parse((await getSetting(space.tcw, WORD_FIXES_SETTING_KEY))!)).toEqual({ version: 1, entries: [{ find: "tiny cloud", replace: "TinyCloud" }] });
    resetWordFixesForTest();
    await loadWordFixes(space.tcw);
    const { snapshotForTest } = await import("./wordFixesStore");
    expect(applyWordFixesToSentences([{ text: "Tiny Cloud" }], snapshotForTest().apply)[0]!.text).toBe("TinyCloud");
  });

  test("signing out empties the list", async () => {
    const space = combineSpace([]);
    useLocalThreadStorage(space.tcw);
    await saveWordFixes(space.tcw, withWordFix(NO_WORD_FIXES, { find: "a", replace: "b" }));
    await loadWordFixes(null);
    const { snapshotForTest } = await import("./wordFixesStore");
    expect(snapshotForTest().fixes).toEqual([]);
  });
});
