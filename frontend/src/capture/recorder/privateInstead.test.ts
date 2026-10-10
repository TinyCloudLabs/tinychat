// "Use Private instead": offered only where private cloud can take the note, and it stops the
// on-device job before private cloud starts, so the two never both write a transcript.
import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setOnDeviceSttForTests, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { privateInsteadOffered, switchToPrivate } from "./privateInstead";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";

afterAll(() => __setOnDeviceSttForTests(OnDeviceStt));

function props(patch: Partial<VoiceNoteTranscriptionProps> = {}): VoiceNoteTranscriptionProps & { privately: string[] } {
  const privately: string[] = [];
  return {
    availability: "available", consented: true, maxSeconds: 7_200, jobs: new Map(),
    onTranscribe: () => {}, onTranscribePrivately: (id) => void privately.push(id),
    onConsent: () => {}, onTurnOff: () => {}, onRecheck: () => {},
    ...patch, privately,
  };
}

describe("privateInsteadOffered", () => {
  test("offered when private cloud is available, consented, and the note fits", () => {
    expect(privateInsteadOffered(props(), "n1", 60)).toBe(true);
    expect(privateInsteadOffered(props(), "n1", null)).toBe(true);
  });

  test("not offered without transcription, while checking, hidden, failed or not consented", () => {
    expect(privateInsteadOffered(undefined, "n1", 60)).toBe(false);
    for (const availability of ["checking", "hidden", "failed"] as const) {
      expect(privateInsteadOffered(props({ availability }), "n1", 60)).toBe(false);
    }
    expect(privateInsteadOffered(props({ consented: false }), "n1", 60)).toBe(false);
  });

  test("not offered for a note longer than private cloud takes", () => {
    expect(privateInsteadOffered(props({ maxSeconds: 100 }), "n1", 101)).toBe(false);
    expect(privateInsteadOffered(props({ maxSeconds: 100 }), "n1", 100)).toBe(true);
  });

  test("not offered once private cloud is working on the note or has finished it; a failed job can be tried again", () => {
    const jobs = (kind: "active" | "done" | "failed") => new Map([["n1", { kind }]]) as unknown as VoiceNoteTranscriptionProps["jobs"];
    expect(privateInsteadOffered(props({ jobs: jobs("active") }), "n1", 60)).toBe(false);
    expect(privateInsteadOffered(props({ jobs: jobs("done") }), "n1", 60)).toBe(false);
    expect(privateInsteadOffered(props({ jobs: jobs("failed") }), "n1", 60)).toBe(true);
  });
});

describe("switchToPrivate", () => {
  test("stops the on-device job first, then hands the note to private cloud", async () => {
    const fake = createFakeOnDeviceStt();
    const order: string[] = [];
    fake.plugin.cancel = async ({ id }) => void order.push(`cancel ${id}`);
    __setOnDeviceSttForTests(fake.plugin);
    const transcription = props();
    transcription.onTranscribePrivately = (id) => void order.push(`private ${id}`);
    expect(await switchToPrivate(transcription, "n1")).toBeNull();
    expect(order).toEqual(["cancel n1", "private n1"]);
  });

  test("when the on-device job cannot be stopped it says so and does not start private cloud", async () => {
    const fake = createFakeOnDeviceStt();
    fake.plugin.cancel = async () => { throw new Error("bridge closed"); };
    __setOnDeviceSttForTests(fake.plugin);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const transcription = props();
    expect(await switchToPrivate(transcription, "n1")).toBe("Could not stop the on-device transcription: bridge closed");
    expect(transcription.privately).toEqual([]);
    logged.mockRestore();
  });
});
