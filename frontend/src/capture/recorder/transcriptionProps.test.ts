// The per-account gate of private cloud transcription (moved from the old
// Voice notes card's tests, TC-761): no transcriber (no account, or a build
// without private cloud) means no transcription UI anywhere; otherwise the
// transcriber's snapshot drives it, and each action reaches the transcriber.
import { describe, expect, test } from "bun:test";

import { transcriptionProps } from "./transcriptionProps";

describe("transcriptionProps", () => {
  test("no transcriber, no transcription UI", () => {
    expect(transcriptionProps(null, { availability: "available", capabilities: null, consented: true, jobs: new Map() })).toBeUndefined();
  });

  test("the snapshot drives it, and each action reaches the transcriber", () => {
    const calls: string[] = [];
    const fake = {
      transcribe: (id: string) => calls.push(`transcribe:${id}`),
      consent: () => calls.push("consent"),
      turnOff: async () => void calls.push("turnOff"),
      check: async () => void calls.push("check"),
    } as never;
    const props = transcriptionProps(fake, {
      availability: "available",
      capabilities: { max_bytes: 1, max_duration_seconds: 120 },
      consented: true,
      jobs: new Map(),
    })!;
    expect(props).toMatchObject({ availability: "available", consented: true, maxSeconds: 120 });
    props.onTranscribe("rec-9");
    props.onConsent();
    props.onTurnOff();
    props.onRecheck();
    expect(calls).toEqual(["transcribe:rec-9", "consent", "turnOff", "check"]);
  });

  test("an account the backend hides, or one not yet consented, is passed through as such", () => {
    const fake = { transcribe() {}, consent() {}, turnOff: async () => {}, check: async () => {} } as never;
    expect(transcriptionProps(fake, { availability: "hidden", capabilities: null, consented: false, jobs: new Map() })).toMatchObject({
      availability: "hidden",
      consented: false,
    });
  });
});
