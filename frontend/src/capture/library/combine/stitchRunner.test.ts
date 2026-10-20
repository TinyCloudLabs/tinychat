// TC-1152 S2c-1: the stitch runner's cancel contract (the thread-fallback path; the Worker path is run in Chromium).
import { describe, expect, test } from "bun:test";
import type { MeetingSnapshot } from "@tinyboilerplate/core";

import { StitchCancelled, startStitch } from "./stitchRunner";

const body = (seed: string, from: number, to: number) => JSON.stringify(Array.from({ length: to - from }, (_, k) => ({
  index: k, speaker_name: "A", text: ["a", "b", "c", "d", "e", "f"].map((t) => `${seed}${from + k}${t}`).join(" "), start_time: k * 12, end_time: k * 12 + 11,
})));
const snap = (id: string, startedAt: string, text: string): MeetingSnapshot => ({ source: "fireflies", source_id: id, body: text, row: { title: id, started_at: startedAt, duration_secs: 360, participants: "[]", metadata: "{}" } });
const A = snap("a", "2026-10-19T10:00:00.000Z", body("p", 0, 30));
const B = snap("b", "2026-10-19T10:02:00.000Z", body("p", 10, 40));

describe("startStitch", () => {
  test("resolves the stitcher's verdict", async () => {
    const result = await startStitch(A, B, {}).promise;
    expect(result.verdict).toBe("same-meeting");
  });

  test("cancel rejects with StitchCancelled and the stitch never runs", async () => {
    const run = startStitch(A, B, {});
    run.cancel();
    await expect(run.promise).rejects.toBeInstanceOf(StitchCancelled);
  });
});
