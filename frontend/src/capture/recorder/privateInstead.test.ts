// "Use Private instead": offered only where private cloud can take the note, and it stops the
// on-device job before private cloud starts, so the two never both write a transcript.
import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __setOnDeviceSttForTests, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { privateInsteadOffered, switchToPrivate } from "./privateInstead";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";

const originalVoiceNotes = VoiceNotes;
afterAll(() => {
  __setOnDeviceSttForTests(OnDeviceStt);
  __setVoiceNotesForTests(originalVoiceNotes, { available: null });
});

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
  const wait = { intervalMs: 1, timeoutMs: 50, sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)) };
  const note = (state: string | null) => ({ recordings: [{ id: "n1", stt: state === null ? undefined : { state } }] }) as never;
  const listing = (read: () => unknown) => {
    __setVoiceNotesForTests({ listPending: async () => read() } as unknown as VoiceNotesPlugin, { available: true });
  };

  function withCancel(cancel: () => Promise<void> | void = () => {}) {
    const fake = createFakeOnDeviceStt();
    fake.plugin.cancel = async () => void (await cancel());
    __setOnDeviceSttForTests(fake.plugin);
  }

  test("stops the on-device job, sees it end, then hands the note to private cloud", async () => {
    const order: string[] = [];
    withCancel(() => void order.push("cancel n1"));
    listing(() => note("cancelled"));
    const transcription = props();
    transcription.onTranscribePrivately = (id) => void order.push(`private ${id}`);
    expect(await switchToPrivate(transcription, "n1", wait)).toBeNull();
    expect(order).toEqual(["cancel n1", "private n1"]);
  });

  test("a cancel that was only accepted does not start private cloud while the worker still runs", async () => {
    let running = true;
    let startedWhileRunning: boolean | null = null;
    withCancel();
    listing(() => note(running ? "running" : "cancelled"));
    const transcription = props();
    transcription.onTranscribePrivately = () => void (startedWhileRunning = running);
    const sleeps: number[] = [];
    const result = await switchToPrivate(transcription, "n1", {
      ...wait,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) running = false;
      },
    });
    expect(result).toBeNull();
    expect(sleeps.length).toBe(3);
    expect(startedWhileRunning).toBe(false);
  });

  test("a note still queued behind the running one is waited on too", async () => {
    withCancel();
    const states = ["queued", "queued", "cancelled"];
    listing(() => note(states.shift() ?? "cancelled"));
    const transcription = props();
    expect(await switchToPrivate(transcription, "n1", wait)).toBeNull();
    expect(transcription.privately).toEqual(["n1"]);
  });

  test("a note that failed on this phone is stopped, so private cloud may take it", async () => {
    withCancel();
    listing(() => note("failed"));
    const transcription = props();
    expect(await switchToPrivate(transcription, "n1", wait)).toBeNull();
    expect(transcription.privately).toEqual(["n1"]);
  });

  test("when Local finishes the note first, private cloud is not started", async () => {
    withCancel();
    listing(() => note("done"));
    const transcription = props();
    expect(await switchToPrivate(transcription, "n1", wait)).toBe("This note finished transcribing on this phone just now.");
    expect(transcription.privately).toEqual([]);
  });

  test("when the worker never stops it says so and does not start private cloud", async () => {
    withCancel();
    listing(() => note("running"));
    const transcription = props();
    expect(await switchToPrivate(transcription, "n1", { ...wait, timeoutMs: 5 })).toBe("The on-device transcription is still stopping. Try again in a moment.");
    expect(transcription.privately).toEqual([]);
  });

  test("when the note's state cannot be read it does not start private cloud", async () => {
    withCancel();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    listing(() => Promise.reject(new Error("bridge closed")));
    const transcription = props();
    expect(await switchToPrivate(transcription, "n1", wait)).toBe("Could not confirm the on-device transcription stopped: bridge closed");
    expect(transcription.privately).toEqual([]);
    logged.mockRestore();
  });

  test("when the note is not on this phone it does not start private cloud", async () => {
    withCancel();
    listing(() => ({ recordings: [] }));
    const transcription = props();
    expect(await switchToPrivate(transcription, "n1", wait)).toContain("the note was not found on this phone");
    expect(transcription.privately).toEqual([]);
  });

  test("when the on-device job cannot be stopped it says so and does not start private cloud", async () => {
    withCancel(() => { throw new Error("bridge closed"); });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const transcription = props();
    expect(await switchToPrivate(transcription, "n1", wait)).toBe("Could not stop the on-device transcription: bridge closed");
    expect(transcription.privately).toEqual([]);
    logged.mockRestore();
  });
});
