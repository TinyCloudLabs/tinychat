import { expect, test } from "bun:test";
import { liveUpdatesOff } from "./strings";

test("the live-updates note says offline only when the browser is offline", () => {
  expect(liveUpdatesOff(false)).toEqual({ lead: "You're offline.", text: "Live updates are off, so these cards may be out of date." });
  expect(liveUpdatesOff(true)).toEqual({ lead: "Live updates are off.", text: "These cards may be out of date." });
});
