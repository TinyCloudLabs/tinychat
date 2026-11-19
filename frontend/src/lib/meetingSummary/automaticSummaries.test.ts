import { describe, expect, test } from "bun:test";

import { combineSpace } from "@/harness/fixtures/combineSpace";
import { useLocalThreadStorage } from "@/lib/threadStore";
import { gateCombinedSummary, readAutomaticSummaries, writeAutomaticSummaries } from "./automaticSummaries";

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

/** A runner stand-in that records what the gate asked it to do. */
function recordingRunner() {
  const calls: string[] = [];
  return {
    calls,
    summaries: {
      start: (id: string, options: { replacing: boolean }) => { calls.push(`start:${id}:${options.replacing}`); },
      clear: (id: string) => { calls.push(`clear:${id}`); },
    },
  };
}

const NEW = { id: "combined-1", created: true };
const RECOMBINE = { id: "combined-1", created: false };
const on = async () => true;
const off = async () => false;
const unreadable = async (): Promise<boolean> => { throw new Error("settings unreadable"); };

describe("combine summary gate", () => {
  test("setting on, new meeting: one summary run, not replacing", async () => {
    const r = recordingRunner();
    await gateCombinedSummary(on, r.summaries, NEW);
    expect(r.calls).toEqual(["start:combined-1:false"]);
  });

  test("setting on, Re-combine: one summary run that replaces the old summary", async () => {
    const r = recordingRunner();
    await gateCombinedSummary(on, r.summaries, RECOMBINE);
    expect(r.calls).toEqual(["start:combined-1:true"]);
  });

  test("setting off, new meeting: no run and no clear", async () => {
    const r = recordingRunner();
    await gateCombinedSummary(off, r.summaries, NEW);
    expect(r.calls).toEqual([]);
  });

  test("setting off, Re-combine: the old summary is cleared and no run starts", async () => {
    const r = recordingRunner();
    await gateCombinedSummary(off, r.summaries, RECOMBINE);
    expect(r.calls).toEqual(["clear:combined-1"]);
  });

  test("unreadable setting, new meeting: counts as on, one run", async () => {
    const r = recordingRunner();
    await gateCombinedSummary(unreadable, r.summaries, NEW);
    expect(r.calls).toEqual(["start:combined-1:false"]);
  });

  test("unreadable setting, Re-combine: counts as on, replaces; never clears", async () => {
    const r = recordingRunner();
    await gateCombinedSummary(unreadable, r.summaries, RECOMBINE);
    expect(r.calls).toEqual(["start:combined-1:true"]);
  });
});
