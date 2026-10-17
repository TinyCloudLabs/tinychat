// The availability check's two guards. An account guard (`current`): once its account is no
// longer the signed-in one, a check retries, resumes and sends nothing for it. A freshness
// gate for automatic checks (mount, foreground): a settled answer is reused for a while and a
// failure backs off; the user's "Check again" (no `automatic`) always asks.
import { describe, expect, test, vi } from "bun:test";
import { Capacitor } from "@capacitor/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { transcriptionProps } from "@/capture/recorder/transcriptionProps";
import { memoryHoldStore } from "@/harness/memoryHoldStore";
import { PrivateCloudError, type PrivateCloudCapabilities } from "../privateCloud";
import { __resetCaptureEngineForTests } from "./captureEngine";
import { VoiceNotes, __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { createVoiceNoteTranscriber, devicePtxUploadSupported, recheckVoiceNoteAvailabilityAutomatically, type VoiceNoteCloud, type VoiceNoteConsentStore } from "./voiceNoteTranscription";

const CAPS: PrivateCloudCapabilities = { max_bytes: 120_960_000, max_duration_seconds: 7_777, content_types: ["audio/wav"], admission: "open" };
const FRESH = 5 * 60_000;
const BACKOFF = [15_000, 60_000, 5 * 60_000];

const consent = (value: boolean): VoiceNoteConsentStore => ({ get: () => value, set() {} });

function setup(opts: {
  capabilities?: () => Promise<PrivateCloudCapabilities>;
  pending?: string[];
  consented?: boolean;
  sleep?: (ms: number) => Promise<void>;
  checkRetryMs?: readonly number[];
} = {}) {
  const clock = { at: 1_000_000 };
  const requests: string[] = [];
  const started: string[] = [];
  const cloud = {
    capabilities: async () => {
      requests.push("capabilities");
      return (opts.capabilities ?? (async () => CAPS))();
    },
    pendingSourceIds: () => opts.pending ?? [],
    hasRemoteJob: (sourceId: string) => opts.pending?.includes(sourceId) === true,
    releaseUnsent: async () => {},
  } as unknown as VoiceNoteCloud;
  const transcriber = createVoiceNoteTranscriber({
    cloud,
    consent: consent(opts.consented ?? false),
    holds: memoryHoldStore(),
    tcw: () => ({ did: "did:example:guard", spaceId: "space" }) as TinyCloudWeb,
    now: () => clock.at,
    sleep: opts.sleep ?? (async () => {}),
    checkRetryMs: opts.checkRetryMs ?? [],
    runNote: async (args) => {
      started.push(args.sourceId);
      return "no_speech";
    },
  });
  return { transcriber, clock, requests, started };
}

const offline = async (): Promise<PrivateCloudCapabilities> => {
  throw new PrivateCloudError("offline", "x");
};

describe("account guard", () => {
  test("a check that finishes after its account left resumes nothing and does not settle", async () => {
    let finish: (caps: PrivateCloudCapabilities) => void = () => {};
    const s = setup({ consented: true, pending: ["a-note"], capabilities: () => new Promise((resolve) => { finish = resolve; }) });
    let current = true;
    const pending = s.transcriber.check({ current: () => current });
    current = false;
    finish(CAPS);
    await pending;
    expect(s.started).toEqual([]);
    expect(s.transcriber.snapshot().availability).toBe("checking");
  });

  test("a retry never fires for an account that left during the wait", async () => {
    let current = true;
    let release: () => void = () => {};
    const s = setup({
      capabilities: offline,
      checkRetryMs: [2_000, 5_000],
      sleep: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    const pending = s.transcriber.check({ current: () => current });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.requests).toHaveLength(1);
    current = false;
    release();
    await pending;
    expect(s.requests).toHaveLength(1);
  });

  test("returning to the account checks again and resumes its notes", async () => {
    const s = setup({ consented: true, pending: ["a-note"] });
    let current = true;
    const first = s.transcriber.check({ current: () => current });
    current = false;
    await first;
    expect(s.started).toEqual([]);
    await s.transcriber.check({ automatic: true, current: () => true });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.started).toEqual(["a-note"]);
  });

  test("a job queued before the account left does not start for it", async () => {
    let current = true;
    const started: string[] = [];
    // The first note starts as the check settles; the account leaves before the second one's turn.
    const transcriber = createVoiceNoteTranscriber({
      cloud: { capabilities: async () => CAPS, pendingSourceIds: () => ["one", "two"], hasRemoteJob: () => true, releaseUnsent: async () => {} } as unknown as VoiceNoteCloud,
      consent: consent(true),
      holds: memoryHoldStore(),
      tcw: () => ({ did: "did:example:guard", spaceId: "space" }) as TinyCloudWeb,
      runNote: async (args) => {
        started.push(args.sourceId);
        current = false;
        return "no_speech";
      },
    });
    await transcriber.check({ current: () => current });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["one"]);
  });
});

describe("freshness and backoff for automatic checks", () => {
  test("Android's Check again re-queries a failed native status probe", async () => {
    const platform = Capacitor.getPlatform;
    const plugin = VoiceNotes;
    try {
      __resetCaptureEngineForTests();
      Capacitor.getPlatform = () => "android";
      let reads = 0;
      __setVoiceNotesForTests({ ...plugin, status: async () => {
        reads++;
        if (reads === 1) throw new Error("native bridge unavailable");
        return { androidSdkInt: 35 } as Awaited<ReturnType<typeof plugin.status>>;
      } }, { available: true });
      const s = setup({ capabilities: async () => {
        if (!(await devicePtxUploadSupported())) throw new PrivateCloudError("feature_unavailable", "Old Android SDK");
        return CAPS;
      } });
      await s.transcriber.check();
      expect(s.transcriber.snapshot()).toMatchObject({ availability: "failed", checkErrorCode: "native_status_failed",
        checkError: "Could not check this browser's file upload. Try again." });
      await transcriptionProps(s.transcriber, s.transcriber.snapshot())!.onRecheck();
      expect(s.transcriber.snapshot().availability).toBe("available");
      expect(reads).toBe(2);
    } finally {
      __setVoiceNotesForTests(plugin, { available: null });
      Capacitor.getPlatform = platform;
      __resetCaptureEngineForTests();
    }
  });
  test("a fresh answer is reused, then asked again once it is stale", async () => {
    const s = setup();
    await s.transcriber.check({ automatic: true });
    await s.transcriber.check({ automatic: true });
    s.clock.at += FRESH - 1;
    await s.transcriber.check({ automatic: true });
    expect(s.requests).toHaveLength(1);
    s.clock.at += 1;
    await s.transcriber.check({ automatic: true });
    expect(s.requests).toHaveLength(2);
  });

  test("a failed capability check backs off before checking again", async () => {
    const s = setup({ capabilities: offline });
    await s.transcriber.check({ automatic: true });
    await s.transcriber.check({ automatic: true });
    expect(s.requests).toHaveLength(1);
    expect(s.transcriber.snapshot().availability).toBe("failed");
  });

  test("a failed check backs off longer after each failure; a success starts over", async () => {
    let answer: () => Promise<PrivateCloudCapabilities> = offline;
    const s = setup({ capabilities: () => answer() });
    await s.transcriber.check({ automatic: true });
    expect(s.transcriber.snapshot().availability).toBe("failed");
    s.clock.at += BACKOFF[0]! - 1;
    await s.transcriber.check({ automatic: true });
    expect(s.requests).toHaveLength(1);
    s.clock.at += 1;
    await s.transcriber.check({ automatic: true });
    expect(s.requests).toHaveLength(2);
    s.clock.at += BACKOFF[0]!;
    await s.transcriber.check({ automatic: true });
    expect(s.requests).toHaveLength(2);
    s.clock.at += BACKOFF[1]! - BACKOFF[0]!;
    answer = async () => CAPS;
    await s.transcriber.check({ automatic: true });
    expect(s.requests).toHaveLength(3);
    expect(s.transcriber.snapshot().availability).toBe("available");
  });
  test("frequent automatic events stay within capability backoff for 15 minutes", async () => {
    vi.useFakeTimers();
    const s = setup({ capabilities: offline });
    try {
      await recheckVoiceNoteAvailabilityAutomatically(s.transcriber);
      for (let i = 0; i < 90; i++) {
        s.clock.at += 10_000;
        await recheckVoiceNoteAvailabilityAutomatically(s.transcriber, () => true);
      }
      expect(s.requests).toHaveLength(5);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("Check again bypasses both the fresh answer and the backoff", async () => {
    const s = setup({ capabilities: offline });
    await s.transcriber.check({ automatic: true });
    await s.transcriber.check();
    await s.transcriber.check();
    expect(s.requests).toHaveLength(3);
  });

  test("overlapping automatic and manual checks share the one in flight", async () => {
    let finish: (caps: PrivateCloudCapabilities) => void = () => {};
    const s = setup({ capabilities: () => new Promise((resolve) => { finish = resolve; }) });
    const all = [s.transcriber.check({ automatic: true }), s.transcriber.check({ automatic: true }), s.transcriber.check()];
    finish(CAPS);
    await Promise.all(all);
    expect(s.requests).toHaveLength(1);
  });

  test("each account's transcriber keeps its own freshness", async () => {
    const a = setup();
    const b = setup();
    await a.transcriber.check({ automatic: true });
    await b.transcriber.check({ automatic: true });
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });
});

describe("work an account's departure paused", () => {
  test("returning to a settled available account resumes it without asking again", async () => {
    let current = true;
    let pendingIds: string[] = [];
    let finish!: () => void;
    let started = 0;
    let requests = 0;
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const listingStarted = Promise.withResolvers<void>();
    const listingGate = Promise.withResolvers<void>();
    const plugin = VoiceNotes;
    __setVoiceNotesForTests({
      ...plugin,
      listPending: async () => {
        listingStarted.resolve();
        await listingGate.promise;
        return { recordings: [] };
      },
    }, { available: null });
    try {
      const transcriber = createVoiceNoteTranscriber({
        cloud: { capabilities: async () => { requests++; return CAPS; }, pendingSourceIds: () => pendingIds,
          hasRemoteJob: (sourceId: string) => pendingIds.includes(sourceId), releaseUnsent: async () => {} } as unknown as VoiceNoteCloud,
        consent: consent(true),
        holds: memoryHoldStore(),
        tcw: () => ({ did: "did:example:guard", spaceId: "space" }) as TinyCloudWeb,
        runNote: async (args) => {
          started++;
          if (started === 1) {
            firstStarted.resolve();
            await new Promise<void>((resolve) => { finish = resolve; });
            if (!args.allowed!()) throw new PrivateCloudError("account_changed", "left");
          } else {
            secondStarted.resolve();
          }
          return "no_speech";
        },
      });
      await transcriber.check({ automatic: true, current: () => current });
      await listingStarted.promise;
      transcriber.transcribe("a-note");
      await firstStarted.promise;
      current = false;
      pendingIds = ["a-note"];
      const stopped = Promise.withResolvers<void>();
      let unsubscribe = () => {};
      unsubscribe = transcriber.subscribe(() => {
        if (transcriber.snapshot().jobs.get("a-note")?.kind !== "active") {
          unsubscribe();
          stopped.resolve();
        }
      });
      finish();
      await stopped.promise;
      current = true;
      await transcriber.check({ automatic: true, current: () => current });
      listingGate.resolve();
      await secondStarted.promise;
      expect(requests).toBe(1);
      expect(started).toBe(2);
    } finally {
      listingGate.resolve();
      __setVoiceNotesForTests(plugin, { available: null });
    }
  });
});
