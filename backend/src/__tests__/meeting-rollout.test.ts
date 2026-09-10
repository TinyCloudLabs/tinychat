import { expect, test } from "bun:test";
import { meetingRolloutFromEnv } from "../transcripts/meeting-rollout.js";

test("rollout defaults off and requires explicit test accounts and evaluated models", () => {
  const off = meetingRolloutFromEnv({});
  expect(off.enabled).toBe(false); expect(off.accountAllowed("0xabc")).toBe(false); expect(off.modelAllowed("phala/test")).toBe(false);
  const gated = meetingRolloutFromEnv({ MEETING_CONTENT_RETRIEVAL_ENABLED: "true", MEETING_CONTENT_TEST_ACCOUNTS: "0xAbC, 0xdef", MEETING_CONTENT_MODELS: "phala/test" });
  expect(gated.enabled).toBe(true); expect(gated.accountAllowed("0xabc")).toBe(true); expect(gated.accountAllowed("0xother")).toBe(false);
  expect(gated.modelAllowed("phala/test")).toBe(true); expect(gated.modelAllowed("phala/other")).toBe(false);
  expect(meetingRolloutFromEnv({ MEETING_CONTENT_RETRIEVAL_ENABLED: "true" }).accountAllowed("0xabc")).toBe(false);
});
