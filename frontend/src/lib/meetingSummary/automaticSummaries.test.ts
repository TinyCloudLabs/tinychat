import { describe, expect, test } from "bun:test";

import { combineSpace } from "@/harness/fixtures/combineSpace";
import { useLocalThreadStorage } from "@/lib/threadStore";
import { readAutomaticSummaries, writeAutomaticSummaries } from "./automaticSummaries";

describe("automatic meeting summaries setting", () => {
  test("is on when never set", async () => {
    const space = combineSpace([]);
    useLocalThreadStorage(space.tcw);
    expect(await readAutomaticSummaries(space.tcw)).toBe(true);
  });

  test("an off write reads back as off, and turning it back on reads back as on", async () => {
    const space = combineSpace([]);
    useLocalThreadStorage(space.tcw);
    await writeAutomaticSummaries(space.tcw, false);
    expect(await readAutomaticSummaries(space.tcw)).toBe(false);
    await writeAutomaticSummaries(space.tcw, true);
    expect(await readAutomaticSummaries(space.tcw)).toBe(true);
  });
});
