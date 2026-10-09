// The Voice notes card's transcription controller (createVoiceNoteTranscriber), which the React
// card only renders. Rules:
//   1. nothing is offered or sent without a PTX origin, without the backend's yes, or before the
//      one-time consent; consent starts auto-transcription and resumes notes left in flight;
//   2. notes run one at a time; a note over the limit is not queued;
//   3. turning off stops everything not yet sent: waiting notes never start, the running one is
//      told (`allowed()`), unsent jobs are released, and nothing is shown as a failure;
//   4. after a save the note stays "done" (never offered again) until the list catches up;
//   5. one transcriber per account DID.

import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { PrivateCloudError, type PrivateCloudCapabilities } from "../privateCloud";
import {
  createVoiceNoteTranscriber,
  voiceNoteTranscriberFor,
  type VoiceNoteCloud,
  type VoiceNoteConsentStore,
  type VoiceNoteTranscriberEvent,
  type VoiceNoteTranscriptionStatus,
} from "./voiceNoteTranscription";

const CAPS: PrivateCloudCapabilities = { max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/wav"] };
const AUDIO = { mimeType: "audio/mp4", base64: "AAAA" };

function fakeCloud(opts: { capabilities?: () => Promise<PrivateCloudCapabilities | null>; pending?: string[] } = {}) {
  const calls: string[] = [];
  const cloud: VoiceNoteCloud = {
    capabilities: async () => {
      calls.push("capabilities");
      return (opts.capabilities ?? (async () => CAPS))();
    },
    pendingSourceIds: () => opts.pending ?? [],
    transcribe: async () => {
      throw new Error("runNote is faked");
    },
    finish: async () => {},
    releaseUnsent: async () => {
      calls.push("releaseUnsent");
    },
  };
  return { cloud, calls };
}

function memoryConsent(initial = false): VoiceNoteConsentStore & { value: boolean } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (v: boolean) => {
      store.value = v;
    },
  };
  return store;
}

type Run = {
  sourceId: string;
  audio: unknown;
  allowed: () => boolean;
  report: (s: VoiceNoteTranscriptionStatus) => void;
  resolve: (outcome: "transcribed" | "no_speech") => void;
  reject: (err: unknown) => void;
};

/** A transcriber whose per-note work is controlled by the test, one deferred run per note. */
function setup(opts: { consented?: boolean; cloud?: VoiceNoteCloud | null; pending?: string[]; capabilities?: () => Promise<PrivateCloudCapabilities | null> } = {}) {
  const { cloud, calls } = fakeCloud({ pending: opts.pending, capabilities: opts.capabilities });
  const consent = memoryConsent(opts.consented ?? false);
  const runs: Run[] = [];
  const events: VoiceNoteTranscriberEvent[] = [];
  const sleeps: number[] = [];
  const transcriber = createVoiceNoteTranscriber({
    cloud: opts.cloud === undefined ? cloud : opts.cloud,
    consent,
    tcw: () => ({}) as TinyCloudWeb,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    runNote: (args) =>
      new Promise((resolve, reject) => {
        runs.push({ sourceId: args.sourceId, audio: args.audio, allowed: args.allowed ?? (() => true), report: args.report, resolve, reject });
      }),
  });
  transcriber.subscribe((e) => events.push(e));
  const job = (sourceId: string) => transcriber.snapshot().jobs.get(sourceId);
  return { transcriber, runs, events, consent, calls, sleeps, job };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("availability and consent", () => {
  test("committed Off and on-device notes never enter private cloud; private-cloud and legacy notes do", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    const note = (id: string, transcriber?: "off" | "on-device" | "private-cloud") => ({
      id, durationMs: 5_000,
      ...(transcriber ? { options: { transcriber, identifySpeakers: false } } : {}),
    });
    s.transcriber.noteSaved(note("off", "off"), AUDIO);
    s.transcriber.noteSaved(note("local", "on-device"), AUDIO);
    s.transcriber.noteSaved(note("cloud", "private-cloud"), AUDIO);
    s.transcriber.noteSaved(note("legacy"), AUDIO);
    await tick();
    expect(s.job("off")).toBeUndefined();
    expect(s.job("local")).toBeUndefined();
    expect(s.runs.map((run) => run.sourceId)).toEqual(["cloud"]);
    s.runs[0]!.resolve("transcribed");
    await tick();
    expect(s.runs.map((run) => run.sourceId)).toEqual(["cloud", "legacy"]);
  });

  test("no PTX origin in this build: hidden, never checked, nothing queued", async () => {
    const s = setup({ cloud: null, consented: true });
    await s.transcriber.check();
    expect(s.transcriber.snapshot().availability).toBe("hidden");
    s.transcriber.noteSaved({ id: "rec-1", durationMs: 5_000 }, AUDIO);
    s.transcriber.transcribe("rec-1");
    await tick();
    expect(s.runs).toHaveLength(0);
  });

  test("a failed check is retried twice; a 404 (dark / not in the cohort) is hidden", async () => {
    let answers: (() => Promise<PrivateCloudCapabilities | null>)[] = [
      async () => {
        throw new PrivateCloudError("offline", "x");
      },
      async () => {
        throw new PrivateCloudError("http_5xx", "x");
      },
      async () => CAPS,
    ];
    const s = setup({ capabilities: () => answers.shift()!() });
    await s.transcriber.check();
    expect(s.sleeps).toEqual([2_000, 5_000]);
    expect(s.transcriber.snapshot()).toMatchObject({ availability: "available", capabilities: CAPS });

    answers = [async () => null];
    const dark = setup({ capabilities: () => answers.shift()!() });
    await dark.transcriber.check();
    expect(dark.transcriber.snapshot().availability).toBe("hidden");
  });

  test("before consent a saved note is not sent; after it, new notes are transcribed with the audio in hand", async () => {
    const s = setup();
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "rec-before", durationMs: 5_000 }, AUDIO);
    s.transcriber.transcribe("rec-before");
    await tick();
    expect(s.runs).toHaveLength(0);
    expect(s.transcriber.snapshot().jobs.size).toBe(0);

    s.transcriber.consent();
    expect(s.consent.value).toBe(true);
    s.transcriber.noteSaved({ id: "rec-after", durationMs: 5_000 }, AUDIO);
    await tick();
    expect(s.runs.map((r) => [r.sourceId, r.audio])).toEqual([["rec-after", AUDIO]]);
    expect(s.runs[0]!.allowed()).toBe(true);
  });

  test("consent resumes the notes a previous run left in flight, once", async () => {
    const s = setup({ pending: ["rec-old"] });
    await s.transcriber.check();
    await tick();
    expect(s.runs).toHaveLength(0);
    s.transcriber.consent();
    await tick();
    expect(s.runs.map((r) => r.sourceId)).toEqual(["rec-old"]);
    s.runs[0]!.resolve("transcribed");
    await tick();
    await s.transcriber.check();
    await tick();
    expect(s.runs).toHaveLength(1);
  });

  test("a note over the phone's limit is not queued automatically", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "rec-long", durationMs: 11 * 60_000 }, AUDIO);
    await tick();
    expect(s.runs).toHaveLength(0);
  });
});

describe("one at a time, and the post-success window", () => {
  test("notes wait their turn; progress is told; a saved note stays done and is not queued again", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "a", durationMs: 5_000 }, AUDIO);
    s.transcriber.noteSaved({ id: "b", durationMs: 5_000 }, AUDIO);
    await tick();
    expect(s.runs.map((r) => r.sourceId)).toEqual(["a"]);
    expect(s.job("b")).toEqual({ kind: "active", status: { kind: "waiting" } });
    s.runs[0]!.report({ kind: "uploading" });
    expect(s.job("a")).toEqual({ kind: "active", status: { kind: "uploading" } });

    s.runs[0]!.resolve("transcribed");
    await tick();
    expect(s.job("a")).toEqual({ kind: "done", outcome: "transcribed" });
    expect(s.events).toContainEqual({ kind: "saved", sourceId: "a" });
    expect(s.runs.map((r) => r.sourceId)).toEqual(["a", "b"]);

    // The list may still be stale: Transcribe on "a" (or its auto path) does nothing.
    s.transcriber.transcribe("a");
    s.transcriber.noteSaved({ id: "a", durationMs: 5_000 });
    await tick();
    expect(s.runs.map((r) => r.sourceId)).toEqual(["a", "b"]);
    expect(s.job("a")).toEqual({ kind: "done", outcome: "transcribed" });
  });

  test("a failure is shown; Retry queues the note again", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.transcribe("a");
    await tick();
    s.runs[0]!.reject(new PrivateCloudError("service_busy", "busy", { correlationId: "cid-9" }));
    await tick();
    expect(s.job("a")).toEqual(expect.objectContaining({ kind: "failed", code: "service_busy", retryable: true, reference: "cid-9" }));
    s.transcriber.transcribe("a");
    await tick();
    expect(s.runs).toHaveLength(2);
  });
});

describe("turning off", () => {
  test("waiting notes never start, the running one is told, unsent jobs are released, nothing shows as failed", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "running", durationMs: 5_000 }, AUDIO);
    s.transcriber.noteSaved({ id: "waiting", durationMs: 5_000 }, AUDIO);
    await tick();
    const running = s.runs[0]!;
    expect(running.allowed()).toBe(true);

    await s.transcriber.turnOff();
    expect(s.consent.value).toBe(false);
    expect(running.allowed()).toBe(false);
    expect(s.calls).toContain("releaseUnsent");
    expect(s.job("waiting")).toBeUndefined();

    // The running note stops before its upload (the engine's transcription_off).
    running.reject(new PrivateCloudError("transcription_off", "off"));
    await tick();
    expect(s.runs.map((r) => r.sourceId)).toEqual(["running"]);
    expect(s.transcriber.snapshot().jobs.size).toBe(0);

    // Off: nothing new is sent.
    s.transcriber.noteSaved({ id: "later", durationMs: 5_000 }, AUDIO);
    s.transcriber.transcribe("later");
    await tick();
    expect(s.runs).toHaveLength(1);
  });

  test("a note that fails for another reason after turn-off is not shown either; earlier failures are cleared", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.transcribe("failed-before");
    await tick();
    s.runs[0]!.reject(new PrivateCloudError("service_busy", "busy"));
    await tick();
    s.transcriber.transcribe("running");
    await tick();
    await s.transcriber.turnOff();
    expect(s.job("failed-before")).toBeUndefined();
    s.runs[1]!.reject(new PrivateCloudError("cancelled", "the job was cancelled"));
    await tick();
    expect(s.job("running")).toBeUndefined();
  });

  test("turning back on: auto-transcription resumes", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    await s.transcriber.turnOff();
    s.transcriber.consent();
    s.transcriber.noteSaved({ id: "rec-1", durationMs: 5_000 }, AUDIO);
    await tick();
    expect(s.runs.map((r) => r.sourceId)).toEqual(["rec-1"]);
  });
});

describe("voiceNoteTranscriberFor", () => {
  test("one transcriber per account DID; none without a DID", () => {
    const store = { getToken: () => "tok", isExpired: () => false } as never;
    const a1 = voiceNoteTranscriberFor({ did: "did:test:a" } as unknown as TinyCloudWeb, "https://api.example", store);
    const a2 = voiceNoteTranscriberFor({ did: "did:test:a" } as unknown as TinyCloudWeb, "https://api.example", store);
    const b = voiceNoteTranscriberFor({ did: "did:test:b" } as unknown as TinyCloudWeb, "https://api.example", store);
    expect(a1).not.toBeNull();
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(voiceNoteTranscriberFor({} as TinyCloudWeb, "https://api.example", store)).toBeNull();
    // No PTX origin in this build: hidden for every account.
    expect(a1!.snapshot().availability).toBe("hidden");
  });
});

describe("nativeHttpFileUploadSupported (Android 8.0+ only)", () => {
  test("iOS yes; Android from API 26; an Android shell that does not say, or the web, no", async () => {
    const { nativeHttpFileUploadSupported } = await import("./nativeVoiceNotes");
    const status = (androidSdkInt?: number) => async () => (androidSdkInt === undefined ? {} : { androidSdkInt });
    expect(await nativeHttpFileUploadSupported("ios", status())).toBe(true);
    expect(await nativeHttpFileUploadSupported("android", status(26))).toBe(true);
    expect(await nativeHttpFileUploadSupported("android", status(34))).toBe(true);
    expect(await nativeHttpFileUploadSupported("android", status(25))).toBe(false);
    expect(await nativeHttpFileUploadSupported("android", status(24))).toBe(false);
    expect(await nativeHttpFileUploadSupported("android", status())).toBe(false);
    expect(await nativeHttpFileUploadSupported("android", async () => { throw new Error("no plugin"); })).toBe(false);
    expect(await nativeHttpFileUploadSupported("web", status(34))).toBe(false);
  });
});
