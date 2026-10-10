// The availability check's two guards. An account guard (`current`): once its account is no
// longer the signed-in one, a check retries, resumes and sends nothing for it. A freshness
// gate for automatic checks (mount, foreground): a settled answer is reused for a while and a
// failure backs off; the user's "Check again" (no `automatic`) always asks.
import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { PrivateCloudError, type PrivateCloudCapabilities } from "../privateCloud";
import { createVoiceNoteTranscriber, type VoiceNoteCloud, type VoiceNoteConsentStore } from "./voiceNoteTranscription";

const CAPS: PrivateCloudCapabilities = { max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/wav"] };
const FRESH = 5 * 60_000;
const BACKOFF = [15_000, 60_000, 5 * 60_000];

const consent = (value: boolean): VoiceNoteConsentStore => ({ get: () => value, set() {} });

function setup(opts: {
  capabilities?: () => Promise<PrivateCloudCapabilities | null>;
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
    releaseUnsent: async () => {},
  } as unknown as VoiceNoteCloud;
  const transcriber = createVoiceNoteTranscriber({
    cloud,
    consent: consent(opts.consented ?? false),
    tcw: () => ({}) as TinyCloudWeb,
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

const offline = async (): Promise<PrivateCloudCapabilities | null> => {
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
      cloud: { capabilities: async () => CAPS, pendingSourceIds: () => ["one", "two"], releaseUnsent: async () => {} } as unknown as VoiceNoteCloud,
      consent: consent(true),
      tcw: () => ({}) as TinyCloudWeb,
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

  test("an answer that says private cloud is off is reused too", async () => {
    const s = setup({ capabilities: async () => null });
    await s.transcriber.check({ automatic: true });
    await s.transcriber.check({ automatic: true });
    expect(s.requests).toHaveLength(1);
    expect(s.transcriber.snapshot().availability).toBe("hidden");
  });

  test("a failed check backs off longer after each failure; a success starts over", async () => {
    let answer: () => Promise<PrivateCloudCapabilities | null> = offline;
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
