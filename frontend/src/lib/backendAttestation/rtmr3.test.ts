import { describe, expect, test } from "bun:test";
import attestation from "./__fixtures__/attestation.json";
import phalaVerify from "./__fixtures__/phala-verify.json";
import {
  extractComposeHashEvent,
  parseEventLog,
  replayRtmr3,
} from "./rtmr3";

const eventLogJson: string = (attestation as { event_log: string }).event_log;
const quoteRtmr3: string = (phalaVerify as { quote: { body: { rtmr3: string } } })
  .quote.body.rtmr3;

describe("rtmr3 replay (real prod capture)", () => {
  test("replayRtmr3 reproduces the Intel-signed quote rtmr3", async () => {
    const replayed = await replayRtmr3(eventLogJson);
    const expected = quoteRtmr3.replace(/^0x/, "").toLowerCase();
    expect(replayed).toBe(expected);
    expect(replayed).toHaveLength(96);
  });

  test("mutating one event_payload byte breaks the replay", async () => {
    const events = parseEventLog(eventLogJson);
    const composeIdx = events.findIndex(
      (e) => e.imr === 3 && e.event === "compose-hash",
    );
    expect(composeIdx).toBeGreaterThanOrEqual(0);
    // Flip the first hex nibble of the compose-hash payload.
    const original = events[composeIdx].event_payload;
    const flipped =
      (original[0] === "a" ? "b" : "a") + original.slice(1);
    events[composeIdx] = { ...events[composeIdx], event_payload: flipped };

    const mutated = await replayRtmr3(JSON.stringify(events));
    const expected = quoteRtmr3.replace(/^0x/, "").toLowerCase();
    expect(mutated).not.toBe(expected);
  });

  test("extractComposeHashEvent returns the compose_hash payload", () => {
    const payload = extractComposeHashEvent(eventLogJson);
    expect(payload).toBe(
      (attestation as { info: { compose_hash: string } }).info.compose_hash,
    );
  });
});
