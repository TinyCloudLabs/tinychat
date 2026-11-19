// One automatic re-submit on load for provider-failed notes (TC-2085): once ever per note (a
// device-local marker), only provider failures, only with the recording still on the device, only
// within 7 days, strictly one at a time and one second apart; a failed re-submit waits for manual Retry.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Pin HOME to a ticket temp dir before anything can write (these tests use in-memory stores only).
const HOME = mkdtempSync(join("/var/tmp", "tc-2085."));
appendFileSync("/var/tmp/tc-2085-mktemp-list.txt", `${HOME}\n`);
process.env.HOME = HOME;
if (process.env.HOME !== HOME || !HOME.startsWith("/var/tmp/tc-2085.")) throw new Error("test HOME is not the ticket temp dir");
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { memoryHoldStore } from "@/harness/memoryHoldStore";
import { PrivateCloudError, type PrivateCloudCapabilities } from "../privateCloud";
import {
  AUTO_RESUBMIT_MAX_AGE_MS,
  localStorageAutoResubmitStore,
  memoryAutoResubmitStore,
  selectProviderResubmits,
  type AutoResubmitStore,
} from "./providerResubmit";
import { createVoiceNoteTranscriber, type VoiceNoteCloud } from "./voiceNoteTranscription";

const NOW = Date.UTC(2026, 9, 26, 15, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CAPS: PrivateCloudCapabilities = { max_bytes: 120_960_000, max_duration_seconds: 7_777, content_types: ["audio/wav"], admission: "open" };

const TEST_TCW = {
  did: "did:test:provider-resubmit",
  spaceId: "provider-resubmit-tests",
  sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [] } }), execute: async () => ({ ok: true, data: { rows: [] } }) }) },
  kv: { get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } }) },
} as unknown as TinyCloudWeb;

type Failure = { code: string; failedAt: number | null };

/** A cloud whose device-local failure records live in a map, as the pending store keeps them. */
function failingCloud(initial: Record<string, Failure>) {
  const failures = new Map<string, Failure>(Object.entries(initial));
  const cloud: VoiceNoteCloud = {
    capabilities: async () => CAPS,
    pendingSourceIds: () => [...failures.keys()],
    hasRemoteJob: () => false,
    terminalFailure: (id) => failures.get(id)?.code ?? null,
    terminalFailureAt: (id) => failures.get(id)?.failedAt ?? null,
    rememberTerminalFailure: (id, code) => void failures.set(id, { code, failedAt: NOW }),
    clearTerminalFailure: (id) => void failures.delete(id),
    holdTranscript: () => {},
    heldTranscript: () => null,
    transcribe: async () => { throw new Error("runNote is faked"); },
    finish: async () => {},
    releaseUnsent: async () => {},
  };
  return { cloud, failures };
}

/** Lets every queued microtask (the transcriber's chained awaits) run; no wall-clock wait. */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

type Run = { sourceId: string; resolve: () => void; reject: (err: unknown) => void };
type Local = { id: string; startedAt: number };

function setup(opts: {
  failures: Record<string, Failure>;
  local?: Local[] | "all";
  marked?: AutoResubmitStore;
  enabled?: boolean;
}) {
  const { cloud, failures } = failingCloud(opts.failures);
  const marked = opts.marked ?? memoryAutoResubmitStore();
  const runs: Run[] = [];
  const sleeps: number[] = [];
  const local = opts.local === undefined || opts.local === "all"
    ? Object.keys(opts.failures).map((id) => ({ id, startedAt: NOW - DAY }))
    : opts.local;
  const transcriber = createVoiceNoteTranscriber({
    cloud,
    consent: { get: () => true, set: () => {} },
    tcw: () => TEST_TCW,
    holds: memoryHoldStore(),
    now: () => NOW,
    sleep: async (ms) => { sleeps.push(ms); },
    ...(opts.enabled === false ? {} : {
      autoResubmit: {
        marked,
        localRecordings: async () => local.map((r) => ({ ...r, source: "in_app" as const, options: { transcriber: "private-cloud" as const, identifySpeakers: false } })),
      },
    }),
    runNote: (args) => {
      const { promise, resolve, reject } = Promise.withResolvers<"transcribed" | "no_speech">();
      runs.push({ sourceId: args.sourceId, resolve: () => resolve("transcribed"), reject });
      return promise;
    },
  });
  const settle = flush;
  const job = (id: string) => transcriber.snapshot().jobs.get(id);
  return { transcriber, runs, sleeps, marked, failures, settle, job };
}

const providerError = () => new PrivateCloudError("provider_outcome_unknown", "lost");

describe("once on load, through the ordinary Retry", () => {
  test("a provider-failed note with its recording on the device is re-submitted once; a failed re-submit stays failed with Retry; a later load does not repeat it", async () => {
    const marked = memoryAutoResubmitStore();
    const first = setup({ failures: { "note-1": { code: "provider_outcome_unknown", failedAt: NOW - 2 * 60 * 60 * 1000 } }, marked });
    expect(first.job("note-1")).toMatchObject({ kind: "failed", code: "provider_outcome_unknown" });
    await first.transcriber.check();
    await first.settle();
    expect(first.runs.map((r) => r.sourceId)).toEqual(["note-1"]);
    expect(marked.has("note-1")).toBe(true);
    expect(first.job("note-1")?.kind).toBe("active");

    // The provider fails again: failed, retryable by the user, no second automatic run.
    first.runs[0]!.reject(providerError());
    await first.settle();
    expect(first.job("note-1")).toMatchObject({ kind: "failed", code: "provider_outcome_unknown", retryable: true });
    expect(first.failures.get("note-1")?.code).toBe("provider_outcome_unknown");
    expect(first.runs).toHaveLength(1);

    // A second load (new transcriber, same marker and same device-local failure): nothing is re-submitted.
    const second = setup({ failures: { "note-1": { code: "provider_outcome_unknown", failedAt: NOW } }, marked });
    await second.transcriber.check();
    await second.settle();
    expect(second.runs).toEqual([]);
    expect(second.job("note-1")).toMatchObject({ kind: "failed" });

    // The manual Retry is still there.
    second.transcriber.transcribe("note-1");
    await second.settle();
    expect(second.runs.map((r) => r.sourceId)).toEqual(["note-1"]);
  });

  test("provider_unavailable is re-submitted the same way", async () => {
    const s = setup({ failures: { a: { code: "provider_unavailable", failedAt: NOW - DAY } } });
    await s.transcriber.check();
    await s.settle();
    expect(s.runs.map((r) => r.sourceId)).toEqual(["a"]);
  });

  test("a note that finishes after the re-submit is done", async () => {
    const s = setup({ failures: { a: { code: "provider_unavailable", failedAt: NOW - DAY } } });
    await s.transcriber.check();
    await s.settle();
    s.runs[0]!.resolve();
    await s.settle();
    expect(s.job("a")).toEqual({ kind: "done", outcome: "transcribed" });
  });
});

describe("what is never re-submitted", () => {
  test("a failure that is not the provider's: too long, no speech, invalid audio, processing, quota, local", async () => {
    const codes = ["recording_too_long", "recording_too_large", "no_speech", "invalid_audio", "unsupported_recording", "processing_failed",
      "quota_exceeded", "transcription_failed", "transcript_incomplete", "unauthenticated", "provider", "provider_error"];
    const s = setup({ failures: Object.fromEntries(codes.map((code) => [code, { code, failedAt: NOW - 1000 }])) });
    await s.transcriber.check();
    await s.settle();
    expect(s.runs).toEqual([]);
    for (const code of codes) expect(s.marked.has(code)).toBe(false);
  });

  test("a note whose recording is no longer on this device, and its marker is not spent", async () => {
    const s = setup({ failures: { gone: { code: "provider_unavailable", failedAt: NOW - 1000 } }, local: [] });
    await s.transcriber.check();
    await s.settle();
    expect(s.runs).toEqual([]);
    expect(s.marked.has("gone")).toBe(false);
  });

  test("a note whose marker is already set", async () => {
    const marked = memoryAutoResubmitStore();
    marked.mark("done-before");
    const s = setup({ failures: { "done-before": { code: "provider_unavailable", failedAt: NOW - 1000 } }, marked });
    await s.transcriber.check();
    await s.settle();
    expect(s.runs).toEqual([]);
  });

  test("when the marker cannot be written the note is not re-submitted", async () => {
    const unwritable: AutoResubmitStore = { has: () => false, mark: () => false };
    const s = setup({ failures: { a: { code: "provider_unavailable", failedAt: NOW - 1000 } }, marked: unwritable });
    await s.transcriber.check();
    await s.settle();
    expect(s.runs).toEqual([]);
  });

  test("nothing is re-submitted by a transcriber built without the feature", async () => {
    const s = setup({ failures: { a: { code: "provider_unavailable", failedAt: NOW - 1000 } }, enabled: false });
    await s.transcriber.check();
    await s.settle();
    expect(s.runs).toEqual([]);
  });

  test("not while Private is closed to new jobs, and the next open check still does it", async () => {
    let admission = "closed";
    const { cloud } = failingCloud({ a: { code: "provider_unavailable", failedAt: NOW - 1000 } });
    const runs: string[] = [];
    const transcriber = createVoiceNoteTranscriber({
      cloud: { ...cloud, capabilities: async () => ({ ...CAPS, admission }) },
      consent: { get: () => true, set: () => {} },
      tcw: () => TEST_TCW,
      holds: memoryHoldStore(),
      now: () => NOW,
      sleep: async () => {},
      autoResubmit: { marked: memoryAutoResubmitStore(), localRecordings: async () => [{ id: "a", startedAt: NOW - DAY, source: "in_app", options: { transcriber: "private-cloud", identifySpeakers: false } }] },
      runNote: (args) => { runs.push(args.sourceId); return Promise.withResolvers<"transcribed" | "no_speech">().promise; },
    });
    await transcriber.check();
    await flush();
    expect(runs).toEqual([]);
    admission = "open";
    await transcriber.check();
    await flush();
    expect(runs).toEqual(["a"]);
  });
});

describe("7-day cutoff", () => {
  test("a failure just inside 7 days is re-submitted; just outside is left for the user", async () => {
    const s = setup({ failures: {
      inside: { code: "provider_unavailable", failedAt: NOW - AUTO_RESUBMIT_MAX_AGE_MS + 1000 },
      outside: { code: "provider_unavailable", failedAt: NOW - AUTO_RESUBMIT_MAX_AGE_MS - 1000 },
    } });
    await s.transcriber.check();
    await s.settle();
    expect(s.runs.map((r) => r.sourceId)).toEqual(["inside"]);
    expect(s.marked.has("outside")).toBe(false);
  });

  test("a failure recorded before failure times were kept is bounded by its recording's age", () => {
    const failed = [{ sourceId: "old", code: "provider_unavailable", failedAt: null }, { sourceId: "recent", code: "provider_unavailable", failedAt: null }];
    const recordings = new Map([["old", { startedAt: NOW - 8 * DAY }], ["recent", { startedAt: NOW - 2 * DAY }]]);
    expect(selectProviderResubmits({ failed, recordings, marked: memoryAutoResubmitStore(), now: NOW })).toEqual(["recent"]);
  });
});

describe("sequential, not a burst", () => {
  test("strictly one at a time: the next note starts only after the previous attempt ended, one second later", async () => {
    const ids = ["n1", "n2", "n3"];
    const s = setup({ failures: Object.fromEntries(ids.map((id) => [id, { code: "provider_unavailable", failedAt: NOW - DAY }])) });
    await s.transcriber.check();
    await s.settle();
    const active = () => ids.filter((id) => s.job(id)?.kind === "active");
    expect(active()).toEqual(["n1"]);
    expect(ids.filter((id) => s.marked.has(id))).toEqual(["n1"]);
    expect(s.runs.map((r) => r.sourceId)).toEqual(["n1"]);
    expect(s.sleeps).toEqual([]);

    // A failed attempt frees the account; the next note follows.
    s.runs[0]!.reject(providerError());
    await s.settle();
    expect(active()).toEqual(["n2"]);
    expect(ids.filter((id) => s.marked.has(id))).toEqual(["n1", "n2"]);
    expect(s.runs.map((r) => r.sourceId)).toEqual(["n1", "n2"]);
    expect(s.sleeps).toEqual([1000]);

    // So does a finished one.
    s.runs[1]!.resolve();
    await s.settle();
    expect(active()).toEqual(["n3"]);
    expect(ids.filter((id) => s.marked.has(id))).toEqual(["n1", "n2", "n3"]);
    expect(s.sleeps).toEqual([1000, 1000]);
    expect(s.job("n1")).toMatchObject({ kind: "failed", code: "provider_outcome_unknown" });
    expect(s.job("n2")).toEqual({ kind: "done", outcome: "transcribed" });
  });

  test("an attempt the account already has an active job for is not spent: marker taken back, the pass stops, a later load tries it again", async () => {
    const ids = ["n1", "n2"];
    const failures = Object.fromEntries(ids.map((id) => [id, { code: "provider_unavailable", failedAt: NOW - DAY }]));
    const marked = memoryAutoResubmitStore();
    const first = setup({ failures, marked });
    await first.transcriber.check();
    await first.settle();
    expect(marked.has("n1")).toBe(true);
    first.runs[0]!.reject(new PrivateCloudError("active_transcription_exists", "busy"));
    await first.settle();
    expect(first.job("n1")).toMatchObject({ kind: "failed", code: "active_transcription_exists" });
    expect(marked.has("n1")).toBe(false);
    // The account is busy: the rest of the pass is not started (or marked).
    expect(first.runs.map((r) => r.sourceId)).toEqual(["n1"]);
    expect(marked.has("n2")).toBe(false);
    // Its provider failure is still on record, so the next load finds it re-submittable.
    expect(first.failures.get("n1")?.code).toBe("provider_unavailable");

    const second = setup({ failures, marked });
    await second.transcriber.check();
    await second.settle();
    expect(second.runs.map((r) => r.sourceId)).toEqual(["n1"]);
    expect(marked.has("n1")).toBe(true);

    // This time it is a real failure: the marker stays, and a third load leaves it to the user.
    second.runs[0]!.reject(providerError());
    await second.settle();
    expect(marked.has("n1")).toBe(true);
    const third = setup({ failures: { n1: failures.n1! }, marked });
    await third.transcriber.check();
    await third.settle();
    expect(third.runs).toEqual([]);
  });

  test("turning Private off stops the pass: the waiting notes are never started or marked", async () => {
    const ids = ["n1", "n2", "n3"];
    const s = setup({ failures: Object.fromEntries(ids.map((id) => [id, { code: "provider_unavailable", failedAt: NOW - DAY }])) });
    await s.transcriber.check();
    await s.settle();
    await s.transcriber.turnOff();
    await s.settle();
    expect(s.marked.has("n3")).toBe(false);
  });
});

describe("the marker store", () => {
  function memoryStorage(initial?: string) {
    const map = new Map<string, string>(initial === undefined ? [] : [["exo.voiceNotes.autoResubmitted:did:a", initial]]);
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
  }

  test("a mark survives a new store over the same storage, per account", () => {
    const storage = memoryStorage();
    expect(localStorageAutoResubmitStore("did:a", storage).mark("n1")).toBe(true);
    expect(localStorageAutoResubmitStore("did:a", storage).has("n1")).toBe(true);
    expect(localStorageAutoResubmitStore("did:a", storage).has("n2")).toBe(false);
    expect(localStorageAutoResubmitStore("did:b", storage).has("n1")).toBe(false);
  });

  test("an unreadable marker list never allows a re-submit, and cannot be marked", () => {
    const store = localStorageAutoResubmitStore("did:a", memoryStorage("{not json"));
    expect(store.has("n1")).toBe(true);
    expect(store.mark("n1")).toBe(false);
  });

  test("unmark removes only that note's marker, per account, and survives a new store", () => {
    const storage = memoryStorage();
    const store = localStorageAutoResubmitStore("did:a", storage);
    store.mark("n1");
    store.mark("n2");
    expect(store.unmark("n1")).toBe(true);
    expect(localStorageAutoResubmitStore("did:a", storage).has("n1")).toBe(false);
    expect(localStorageAutoResubmitStore("did:a", storage).has("n2")).toBe(true);
    expect(store.unmark("never-marked")).toBe(true);
    expect(localStorageAutoResubmitStore("did:a", memoryStorage("{not json")).unmark("n1")).toBe(false);
  });

  test("a write that does not stick is not a mark", () => {
    const storage = { getItem: () => null, setItem: () => {} };
    expect(localStorageAutoResubmitStore("did:a", storage).mark("n1")).toBe(false);
  });
});
