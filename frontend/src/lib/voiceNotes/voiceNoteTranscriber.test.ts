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

import { memoryHoldStore } from "@/harness/memoryHoldStore";
import { PrivateCloudError, type PrivateCloudCapabilities } from "../privateCloud";
import {
  createVoiceNoteTranscriber,
  HELD_NOTE_MESSAGE,
  voiceNoteTranscriberFor,
  type VoiceNoteCloud,
  type VoiceNoteConsentStore,
  type VoiceNoteHoldStore,
  type VoiceNoteTranscriberEvent,
  type VoiceNoteTranscriptionStatus,
} from "./voiceNoteTranscription";

const CAPS: PrivateCloudCapabilities = { max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/wav"] };
const AUDIO = { mimeType: "audio/mp4", base64: "AAAA" };

function fakeCloud(opts: { capabilities?: () => Promise<PrivateCloudCapabilities>; pending?: string[] } = {}) {
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
  overrideCommitted: boolean;
  explicit: boolean;
  report: (s: VoiceNoteTranscriptionStatus) => void;
  resolve: (outcome: "transcribed" | "no_speech") => void;
  reject: (err: unknown) => void;
};

/** A transcriber whose per-note work is controlled by the test, one deferred run per note. */
function setup(opts: { consented?: boolean; cloud?: VoiceNoteCloud | null; pending?: string[]; capabilities?: () => Promise<PrivateCloudCapabilities>; holds?: VoiceNoteHoldStore } = {}) {
  const { cloud, calls } = fakeCloud({ pending: opts.pending, capabilities: opts.capabilities });
  const consent = memoryConsent(opts.consented ?? false);
  const runs: Run[] = [];
  const events: VoiceNoteTranscriberEvent[] = [];
  const sleeps: number[] = [];
  const transcriber = createVoiceNoteTranscriber({
    cloud: opts.cloud === undefined ? cloud : opts.cloud,
    consent,
    tcw: () => ({}) as TinyCloudWeb,
    holds: opts.holds ?? memoryHoldStore(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    runNote: (args) =>
      new Promise((resolve, reject) => {
        runs.push({ sourceId: args.sourceId, audio: args.audio, allowed: args.allowed ?? (() => true), overrideCommitted: args.overrideCommitted === true, explicit: args.explicit ?? false, report: args.report, resolve, reject });
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
      id, durationMs: 5_000, source: "in_app" as const,
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

  test("Use Private instead runs a Local note in private cloud, past its committed mode, and Retry keeps the choice", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.transcribe("plain");
    s.transcriber.transcribePrivately("moved");
    await tick();
    expect(s.runs.map((run) => [run.sourceId, run.overrideCommitted])).toEqual([["plain", false]]);
    s.runs[0]!.resolve("transcribed");
    await tick();
    expect(s.runs.map((run) => [run.sourceId, run.overrideCommitted])).toEqual([["plain", false], ["moved", true]]);
    s.runs[1]!.reject(new PrivateCloudError("service_busy", "busy"));
    await tick();
    expect(s.job("moved")).toEqual(expect.objectContaining({ kind: "failed" }));
    s.transcriber.transcribe("moved");
    await tick();
    expect(s.runs[2]).toEqual(expect.objectContaining({ sourceId: "moved", overrideCommitted: true }));
  });

  test("Use Private instead offers nothing while private cloud is off", async () => {
    const s = setup({ consented: false });
    await s.transcriber.check();
    s.transcriber.transcribePrivately("moved");
    await tick();
    expect(s.runs).toHaveLength(0);
    expect(s.job("moved")).toEqual({ kind: "blocked", reason: "no-consent" });
  });

  test("no PTX origin in this build: failed, never checked, nothing queued", async () => {
    const s = setup({ cloud: null, consented: true });
    await s.transcriber.check();
    expect(s.transcriber.snapshot().availability).toBe("failed");
    s.transcriber.noteSaved({ id: "rec-1", durationMs: 5_000, source: "in_app" }, AUDIO);
    s.transcriber.transcribe("rec-1");
    await tick();
    expect(s.runs).toHaveLength(0);
  });

  test("a failed check is retried twice; a missing capability route remains retryable", async () => {
    const answers: (() => Promise<PrivateCloudCapabilities>)[] = [
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

    const dark = setup({ capabilities: async () => { throw new PrivateCloudError("service_unavailable", "Missing capability route"); } });
    await dark.transcriber.check();
    expect(dark.transcriber.snapshot().availability).toBe("failed");
  });

  test("before consent a saved note is held; after it, held and new notes are transcribed", async () => {
    const s = setup();
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "rec-before", durationMs: 5_000, source: "in_app" }, AUDIO);
    s.transcriber.transcribe("rec-before");
    await tick();
    expect(s.runs).toHaveLength(0);
    expect(s.job("rec-before")).toEqual({ kind: "blocked", reason: "no-consent" });

    s.transcriber.consent();
    expect(s.consent.value).toBe(true);
    s.transcriber.noteSaved({ id: "rec-after", durationMs: 5_000, source: "in_app" }, AUDIO);
    await tick();
    expect(s.runs.map((r) => [r.sourceId, r.audio])).toEqual([["rec-before", undefined]]);
    expect(s.runs[0]!.allowed()).toBe(true);
    s.runs[0]!.resolve("transcribed");
    await tick();
    expect(s.runs.map((r) => [r.sourceId, r.audio])).toEqual([["rec-before", undefined], ["rec-after", AUDIO]]);
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

  test("an 11-minute note is queued automatically when PTX supports it", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "rec-long", durationMs: 11 * 60_000, source: "in_app" }, AUDIO);
    await tick();
    expect(s.runs.map((run) => run.sourceId)).toEqual(["rec-long"]);
  });
});

describe("one at a time, and the post-success window", () => {
  test("notes wait their turn; progress is told; a saved note stays done and is not queued again", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "a", durationMs: 5_000, source: "in_app" }, AUDIO);
    s.transcriber.noteSaved({ id: "b", durationMs: 5_000, source: "in_app" }, AUDIO);
    await tick();
    expect(s.runs.map((r) => r.sourceId)).toEqual(["a"]);
    expect(s.job("b")).toEqual({ kind: "active", status: { kind: "waiting", position: 1 } });
    s.runs[0]!.report({ kind: "uploading" });
    expect(s.job("a")).toEqual({ kind: "active", status: { kind: "uploading" } });

    s.runs[0]!.resolve("transcribed");
    await tick();
    expect(s.job("a")).toEqual({ kind: "done", outcome: "transcribed" });
    expect(s.events).toContainEqual({ kind: "saved", sourceId: "a" });
    expect(s.runs.map((r) => r.sourceId)).toEqual(["a", "b"]);

    // The list may still be stale: Transcribe on "a" (or its auto path) does nothing.
    s.transcriber.transcribe("a");
    s.transcriber.noteSaved({ id: "a", durationMs: 5_000, source: "in_app" });
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

describe("blocked notes and waiting positions", () => {
  const note = (id: string) => ({ id, durationMs: 5_000, source: "in_app" as const });

  test("review: starting a note must not leave it in the waiting snapshot", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    const snapshots: number[][] = [];
    const unsubscribe = s.transcriber.subscribe(() => snapshots.push(
      [...s.transcriber.snapshot().jobs.values()].flatMap((job) =>
        job.kind === "active" && job.status.kind === "waiting" ? [job.status.position] : []),
    ));
    s.transcriber.noteSaved(note("a"), AUDIO);
    s.transcriber.noteSaved(note("b"), AUDIO);
    await tick();
    unsubscribe();
    expect(s.runs.map((run) => run.sourceId)).toEqual(["a"]);
    expect(snapshots).not.toContainEqual([1, 1]);
    const a = s.job("a");
    expect(a?.kind === "active" && a.status.kind === "waiting").toBe(false);
  });

  test("every snapshot while notes start: a note is waiting only if it is in the line, positions are 1..n with no repeats", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    const snapshots: (number | string)[][] = [];
    const unsubscribe = s.transcriber.subscribe(() => snapshots.push(
      [...s.transcriber.snapshot().jobs.entries()].map(([id, job]) =>
        job.kind === "active" ? (job.status.kind === "waiting" ? job.status.position : `${id}:${job.status.kind}`) : `${id}:${job.kind}`)));
    for (const id of ["a", "b", "c"]) s.transcriber.noteSaved(note(id), AUDIO);
    await tick();
    s.runs[0]!.resolve("transcribed");
    await tick();
    unsubscribe();
    expect(s.runs.map((run) => run.sourceId)).toEqual(["a", "b"]);
    for (const snapshot of snapshots) {
      const positions = snapshot.filter((entry): entry is number => typeof entry === "number");
      expect(positions).toEqual([...positions].sort((x, y) => x - y));
      expect(positions).toEqual(positions.map((_, index) => index + 1));
    }
    expect(snapshots).toContainEqual(["a:preparing", 1, 2]);
    expect(snapshots).toContainEqual(["a:done", "b:preparing", 1]);
  });

  test("a note offered while the check is running, failed or unconsented is recorded as blocked, with the reason", async () => {
    const checking = setup({ consented: true });
    checking.transcriber.noteSaved(note("n"), AUDIO);
    expect(checking.job("n")).toEqual({ kind: "blocked", reason: "checking" });

    const failed = setup({ consented: true, capabilities: async () => { throw new PrivateCloudError("offline", "x"); } });
    await failed.transcriber.check();
    failed.transcriber.noteSaved(note("n"), AUDIO);
    expect(failed.job("n")).toEqual({ kind: "blocked", reason: "check-failed" });

    const dark = setup({ consented: true, capabilities: async () => { throw new PrivateCloudError("service_unavailable", "Missing capability route"); } });
    await dark.transcriber.check();
    dark.transcriber.noteSaved(note("n"), AUDIO);
    expect(dark.job("n")).toEqual({ kind: "blocked", reason: "check-failed" });

    const noCloud = setup({ cloud: null, consented: true });
    noCloud.transcriber.noteSaved(note("n"), AUDIO);
    expect(noCloud.job("n")).toEqual({ kind: "blocked", reason: "check-failed" });

    const unconsented = setup({ consented: false });
    await unconsented.transcriber.check();
    unconsented.transcriber.noteSaved(note("n"), AUDIO);
    expect(unconsented.job("n")).toEqual({ kind: "blocked", reason: "no-consent" });
    expect([checking, failed, dark, noCloud, unconsented].flatMap((t) => t.runs)).toHaveLength(0);
  });

  test("a blocked note's reason follows the state, and it never starts on its own once private cloud is on", async () => {
    const s = setup({ consented: true });
    s.transcriber.noteSaved(note("n"), AUDIO);
    expect(s.job("n")).toEqual({ kind: "blocked", reason: "checking" });
    const seen: (string | undefined)[] = [];
    s.transcriber.subscribe(() => { const job = s.job("n"); seen.push(job?.kind === "blocked" ? job.reason : job?.kind); });
    await s.transcriber.check();
    await tick();
    expect(s.runs).toHaveLength(0);
    expect(s.job("n")).toBeUndefined();
    expect(seen).not.toContain("active");
  });

  test("a blocked note's reason changes from checking to no-consent when the check settles without consent", async () => {
    const s = setup({ consented: false });
    s.transcriber.noteSaved(note("n"), AUDIO);
    expect(s.job("n")).toEqual({ kind: "blocked", reason: "checking" });
    await s.transcriber.check();
    expect(s.job("n")).toEqual({ kind: "blocked", reason: "no-consent" });
    s.transcriber.consent();
    expect(s.job("n")?.kind).toBe("active");
    await tick();
    expect(s.runs).toHaveLength(1);
  });

  test("a blocked offer does not replace a held or finished job", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "held", durationMs: 5_000, source: "intent" }, AUDIO);
    s.transcriber.transcribe("done");
    await tick();
    s.runs[0]!.resolve("transcribed");
    await tick();
    await s.transcriber.turnOff();
    s.transcriber.transcribe("held");
    s.transcriber.transcribe("done");
    s.transcriber.noteSaved(note("later"), AUDIO);
    expect(s.job("held")).toEqual({ kind: "held", message: HELD_NOTE_MESSAGE });
    expect(s.job("done")).toEqual({ kind: "done", outcome: "transcribed" });
    expect(s.job("later")).toEqual({ kind: "blocked", reason: "no-consent" });
  });

  test("waiting notes are numbered from 1 in line order, and move up as notes start", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    for (const id of ["a", "b", "c", "d"]) s.transcriber.noteSaved(note(id), AUDIO);
    await tick();
    const place = (id: string) => { const job = s.job(id); return job?.kind === "active" && job.status.kind === "waiting" ? job.status.position : null; };
    expect(s.runs.map((r) => r.sourceId)).toEqual(["a"]);
    expect([place("b"), place("c"), place("d")]).toEqual([1, 2, 3]);
    s.runs[0]!.resolve("transcribed");
    await tick();
    expect(s.runs.map((r) => r.sourceId)).toEqual(["a", "b"]);
    expect([place("c"), place("d")]).toEqual([1, 2]);
  });
});

describe("turning off", () => {
  test("waiting notes never start, the running one is told, unsent jobs are released, nothing shows as failed", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "running", durationMs: 5_000, source: "in_app" }, AUDIO);
    s.transcriber.noteSaved({ id: "waiting", durationMs: 5_000, source: "in_app" }, AUDIO);
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
    s.transcriber.noteSaved({ id: "later", durationMs: 5_000, source: "in_app" }, AUDIO);
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
    s.transcriber.noteSaved({ id: "rec-1", durationMs: 5_000, source: "in_app" }, AUDIO);
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
    // No PTX origin in this build is an explicit failure.
    expect(a1!.snapshot().availability).toBe("failed");
  });
});


describe("notes that did not begin in the app are held, per note", () => {
  const SHORTCUTS = ["quick_action", "app_shortcut", "intent", "control", "tile", "widget", "notification"] as const;

  for (const source of SHORTCUTS) {
    test(`a ${source} note is held, not sent, even with consent, availability and a committed Private choice`, async () => {
      const holds = memoryHoldStore();
      const s = setup({ consented: true, holds });
      await s.transcriber.check();
      s.transcriber.noteSaved({ id: "n", durationMs: 5_000, source, options: { transcriber: "private-cloud", identifySpeakers: false } }, AUDIO);
      await tick();
      expect(s.runs).toHaveLength(0);
      expect(s.job("n")).toEqual({ kind: "held", message: HELD_NOTE_MESSAGE });
      expect(holds.held).toEqual(["n"]);
    });
  }

  test("a note with no source, with or without options, is held", async () => {
    const s = setup({ consented: true });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "bare", durationMs: 5_000 }, AUDIO);
    s.transcriber.noteSaved({ id: "opts", durationMs: 5_000, options: { transcriber: "private-cloud", identifySpeakers: false } }, AUDIO);
    await tick();
    expect(s.runs).toHaveLength(0);
    expect(s.job("bare")?.kind).toBe("held");
    expect(s.job("opts")?.kind).toBe("held");
  });

  test("a held note is not released by consent, a new check or the same note being saved again", async () => {
    const s = setup({ consented: false });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "n", durationMs: 5_000, source: "widget" }, AUDIO);
    s.consent.set(true);
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "n", durationMs: 5_000, source: "widget" }, AUDIO);
    await tick();
    expect(s.runs).toHaveLength(0);
    expect(s.job("n")?.kind).toBe("held");
  });

  test("the hold outlasts the transcriber: a fresh one over the same store shows it held and does not send it when it is saved again", async () => {
    const holds = memoryHoldStore();
    const first = setup({ consented: true, holds });
    await first.transcriber.check();
    first.transcriber.noteSaved({ id: "n", durationMs: 5_000, source: "quick_action" }, AUDIO);

    const second = setup({ consented: true, holds });
    expect(second.job("n")).toEqual({ kind: "held", message: HELD_NOTE_MESSAGE });
    await second.transcriber.check();
    second.transcriber.noteSaved({ id: "n", durationMs: 5_000, source: "quick_action", options: { transcriber: "private-cloud", identifySpeakers: false } }, AUDIO);
    await tick();
    expect(second.runs).toHaveLength(0);
  });

  test("only that note's own Transcribe sends it, and it clears the hold for good", async () => {
    const holds = memoryHoldStore();
    const s = setup({ consented: true, holds });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "n", durationMs: 5_000, source: "quick_action" }, AUDIO);
    s.transcriber.noteSaved({ id: "other", durationMs: 5_000, source: "quick_action" }, AUDIO);
    s.transcriber.transcribe("n", AUDIO);
    await tick();
    expect(s.runs.map((run) => run.sourceId)).toEqual(["n"]);
    expect(s.job("n")?.kind).toBe("active");
    expect(s.job("other")?.kind).toBe("held");
    expect(holds.held).toEqual(["other"]);

    const later = setup({ consented: true, holds });
    expect(later.job("n")).toBeUndefined();
    expect(later.job("other")?.kind).toBe("held");
  });

  test("the user's own Use Private on a held note sends it as an explicit job and clears the hold", async () => {
    const holds = memoryHoldStore();
    const s = setup({ consented: true, holds });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "n", durationMs: 5_000, source: "quick_action" }, AUDIO);
    expect(s.job("n")?.kind).toBe("held");
    s.transcriber.transcribePrivately("n");
    await tick();
    expect(s.runs.map((run) => ({ id: run.sourceId, explicit: run.explicit, overrideCommitted: run.overrideCommitted }))).toEqual([{ id: "n", explicit: true, overrideCommitted: true }]);
    expect(holds.held).toEqual([]);
  });

  test("Transcribe without consent sends nothing and leaves the hold in place", async () => {
    const holds = memoryHoldStore();
    const s = setup({ consented: false, holds });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "n", durationMs: 5_000, source: "quick_action" }, AUDIO);
    s.transcriber.transcribe("n", AUDIO);
    await tick();
    expect(s.runs).toHaveLength(0);
    expect(s.job("n")?.kind).toBe("held");
    expect(holds.held).toEqual(["n"]);
  });

  test("a hold that cannot be written is still held for this launch, and says so", async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const holds: VoiceNoteHoldStore = { read: () => ({}), write: () => { throw new Error("storage full"); } };
      const s = setup({ consented: true, holds });
      await s.transcriber.check();
      s.transcriber.noteSaved({ id: "n", durationMs: 5_000, source: "quick_action" }, AUDIO);
      await tick();
      expect(s.runs).toHaveLength(0);
      expect(s.job("n")?.kind).toBe("held");
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = original;
    }
  });

  test("a hold list that cannot be read is reported, and shortcut notes are still held", async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const holds: VoiceNoteHoldStore = { read: () => { throw new Error("unreadable"); }, write: () => {} };
      const s = setup({ consented: true, holds });
      await s.transcriber.check();
      s.transcriber.noteSaved({ id: "n", durationMs: 5_000, source: "intent" }, AUDIO);
      await tick();
      expect(s.runs).toHaveLength(0);
      expect(s.job("n")?.kind).toBe("held");
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = original;
    }
  });

  test("an in-app note is not held, whatever else is", async () => {
    const holds = memoryHoldStore();
    const s = setup({ consented: true, holds });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "w", durationMs: 5_000, source: "widget" }, AUDIO);
    s.transcriber.noteSaved({ id: "app", durationMs: 5_000, source: "in_app", options: { transcriber: "private-cloud", identifySpeakers: false } }, AUDIO);
    await tick();
    expect(s.runs.map((run) => run.sourceId)).toEqual(["app"]);
    expect(holds.held).toEqual(["w"]);
  });

  test("an automatic job is not explicit; the user's Transcribe is, and so is every later run of a released note", async () => {
    const holds = memoryHoldStore();
    const s = setup({ consented: true, holds });
    await s.transcriber.check();
    s.transcriber.noteSaved({ id: "app", durationMs: 5_000, source: "in_app" }, AUDIO);
    s.transcriber.noteSaved({ id: "w", durationMs: 5_000, source: "widget" }, AUDIO);
    await tick();
    expect(s.runs.map((run) => [run.sourceId, run.explicit])).toEqual([["app", false]]);
    s.runs[0]!.resolve("transcribed");
    await tick();
    s.transcriber.transcribe("w", AUDIO);
    await tick();
    expect(s.runs.map((run) => [run.sourceId, run.explicit])).toEqual([["app", false], ["w", true]]);
  });

  test("a job the saved row says did not begin in the app is held when the run refuses it, and the hold is kept", async () => {
    const holds = memoryHoldStore();
    const s = setup({ consented: true, holds, pending: ["old"] });
    await s.transcriber.check();
    await tick();
    expect(s.runs.map((run) => run.sourceId)).toEqual(["old"]);
    s.runs[0]!.reject(new PrivateCloudError("note_held", "waits for the user"));
    await tick();
    expect(s.job("old")).toEqual({ kind: "held", message: HELD_NOTE_MESSAGE });
    expect(holds.held).toEqual(["old"]);
  });

  test("a held note with an interrupted attempt is not started by check() or consent(), without a run being attempted", async () => {
    const holds = memoryHoldStore({ held: "held" });
    const s = setup({ consented: false, holds, pending: ["held", "free"] });
    await s.transcriber.check();
    s.transcriber.consent();
    await tick();
    expect(s.runs.map((run) => run.sourceId)).toEqual(["free"]);
    expect(s.job("held")?.kind).toBe("held");
  });
});
