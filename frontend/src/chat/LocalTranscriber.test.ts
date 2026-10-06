// The Local recording panel's take-over and save sequencing, against a fake
// LocalTranscriber. No DOM harness (repo convention): the panel's effects call
// takeOverOnMount, prepareTranscriptToSave and saveTranscriptAndFinish, which
// are exercised here, and source assertions pin that wiring.
//
// Asserted behavior:
//   - on mount: a closed view's transcription first, then this account's kept
//     on-device recording (or, while a closed view still saves it, a wait for
//     that save, after which the panel checks again), then (private cloud
//     available) a cloud job; a panel already running a recording takes over
//     none but the first;
//   - an on-device transcript's save marks it as being saved, and only a
//     successful save forgets its kept recording; a failed save keeps it;
//   - a private cloud transcript is deleted from PTX once saved;
//   - a transcript with no speech forgets the on-device kept recording.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { prepareTranscriptToSave, saveTranscriptAndFinish, takeOverOnMount } from "./LocalTranscriber";
import {
  NO_SPEECH_MESSAGE,
  prepareLocalTranscript,
  type CloudTranscriptResult,
  type LocalTranscriber,
  type LocalTranscriptResult,
  type LocalTranscriptSaver,
  type OnDeviceTranscriptResult,
} from "@/lib/localTranscriber";

function fakeTranscriber(has: { adopted?: boolean; kept?: boolean; saving?: Promise<void>; cloud?: boolean } = {}) {
  const calls: string[] = [];
  const saving: Promise<unknown>[] = [];
  const pending = () => new Promise<LocalTranscriptResult>(() => {});
  const t = {
    adoptTranscription: () => {
      calls.push("adopt");
      return has.adopted ? pending() : null;
    },
    resumeKeptRecording: () => {
      calls.push("kept");
      return has.kept ? pending() : null;
    },
    keptRecordingSave: () => {
      calls.push("saving");
      return has.saving ?? null;
    },
    resumeCloudTranscription: () => {
      calls.push("cloud");
      return has.cloud ? pending() : null;
    },
    savingOnDeviceTranscript: (r: OnDeviceTranscriptResult, p: Promise<unknown>) => {
      calls.push(`saving:${r.sessionId}`);
      saving.push(p);
    },
    finishOnDeviceTranscript: (r: OnDeviceTranscriptResult) => {
      calls.push(`finish-on-device:${r.sessionId}`);
    },
    finishCloudTranscript: async (r: CloudTranscriptResult) => {
      calls.push(`finish-cloud:${r.transcriptionId}`);
    },
  } as unknown as LocalTranscriber;
  return { t, calls, saving };
}

function onDevice(words: { word: string; start: number; end: number; channel: number }[]): OnDeviceTranscriptResult {
  return {
    sessionId: "sess-1",
    startedAt: "2026-10-05T09:00:00.000Z",
    model: "QuantizedTinyEn",
    language: "en",
    response: { metadata: {}, results: { channels: [{ alternatives: [{ transcript: "", confidence: 1, words }] }] } } as never,
  };
}

const cloudResult: CloudTranscriptResult = {
  engine: "private-cloud",
  sessionId: "cloud-1",
  startedAt: "2026-10-05T09:00:00.000Z",
  language: "en",
  transcriptionId: "trn_1",
  transcript: {
    language: "en",
    duration_seconds: 2,
    provider: "tinfoil",
    model: "voxtral",
    channels: 1,
    segments: [{ id: "r1", speaker_id: "channel_0", channel: 0, start: 0, end: 1, text: "Hello there." }],
    text: "Hello there.",
  },
  captureHandle: null,
};

const savedOk: LocalTranscriptSaver = async () => ({ ok: true, data: { meetingId: "m-1" } }) as never;

describe("takeOverOnMount", () => {
  test("a closed view's transcription comes first", () => {
    const f = fakeTranscriber({ adopted: true, kept: true, cloud: true });
    expect(takeOverOnMount(f.t, { wasActive: false, cloudAvailable: true })?.from).toBe("adopted");
    expect(f.calls).toEqual(["adopt"]);
  });

  test("then the kept on-device recording, before a private cloud job", () => {
    const f = fakeTranscriber({ kept: true, cloud: true });
    expect(takeOverOnMount(f.t, { wasActive: false, cloudAvailable: true })?.from).toBe("kept");
    expect(f.calls).toEqual(["adopt", "kept"]);
  });

  test("then a private cloud job, only while private cloud is available", () => {
    const f = fakeTranscriber({ cloud: true });
    expect(takeOverOnMount(f.t, { wasActive: false, cloudAvailable: true })?.from).toBe("cloud");
    expect(f.calls).toEqual(["adopt", "kept", "saving", "cloud"]);
    const unavailable = fakeTranscriber({ cloud: true });
    expect(takeOverOnMount(unavailable.t, { wasActive: false, cloudAvailable: false })).toBeNull();
    expect(unavailable.calls).toEqual(["adopt", "kept", "saving"]);
  });

  test("a kept recording a closed view is still saving is waited on, not offered", async () => {
    const save = Promise.resolve();
    const f = fakeTranscriber({ saving: save, cloud: true });
    const takeover = takeOverOnMount(f.t, { wasActive: false, cloudAvailable: true });
    expect(takeover).toEqual({ from: "saving", settled: save });
    expect(f.calls).toEqual(["adopt", "kept", "saving"]);
  });

  test("never over a recording the panel is running", () => {
    const f = fakeTranscriber({ kept: true, cloud: true });
    expect(takeOverOnMount(f.t, { wasActive: true, cloudAvailable: true })).toBeNull();
    expect(f.calls).toEqual(["adopt"]);
  });
});

describe("saving a transcript", () => {
  test("an on-device save is marked in flight and forgets the kept recording once saved", async () => {
    const f = fakeTranscriber();
    const result = onDevice([{ word: "hi", start: 0, end: 0.5, channel: 0 }]);
    const prepared = prepareTranscriptToSave(f.t, result);
    await expect(saveTranscriptAndFinish(f.t, savedOk, prepared, result)).resolves.toEqual({ cloudDeletion: null });
    expect(f.calls).toEqual(["saving:sess-1", "finish-on-device:sess-1"]);
    expect(f.saving).toHaveLength(1);
  });

  test("a failed save keeps the kept recording", async () => {
    const f = fakeTranscriber();
    const result = onDevice([{ word: "hi", start: 0, end: 0.5, channel: 0 }]);
    const failed: LocalTranscriptSaver = async () => ({ ok: false, error: { code: "KV", message: "kv write failed" } }) as never;
    await expect(saveTranscriptAndFinish(f.t, failed, prepareLocalTranscript(result), result)).rejects.toThrow("kv write failed");
    expect(f.calls).toEqual(["saving:sess-1"]);
    await expect(f.saving[0]!).rejects.toThrow("kv write failed");
  });

  test("a private cloud transcript is deleted from PTX once saved", async () => {
    const f = fakeTranscriber();
    const { cloudDeletion } = await saveTranscriptAndFinish(f.t, savedOk, prepareLocalTranscript(cloudResult), cloudResult);
    await cloudDeletion;
    expect(f.calls).toEqual(["finish-cloud:trn_1"]);
  });

  test("no speech forgets an on-device kept recording, and nothing is saved", () => {
    const f = fakeTranscriber();
    expect(() => prepareTranscriptToSave(f.t, onDevice([]))).toThrow(NO_SPEECH_MESSAGE);
    expect(f.calls).toEqual(["finish-on-device:sess-1"]);
  });

  test("the panel takes over and saves through these, with kept recordings scoped to the signed-in account", () => {
    const source = readFileSync(join(import.meta.dir, "LocalTranscriber.tsx"), "utf8");
    expect(source).toContain("takeOverOnMount(t, { wasActive, cloudAvailable: cloudCheck === \"available\" })");
    expect(source).toContain("prepared = prepareTranscriptToSave(t, result);");
    expect(source).toContain("saveTranscriptAndFinish(t, saveToSpace, prepared, savingResult.current)");
    expect(source).toContain("account: () => tcwRef.current.did,");
    // A save still in flight: the panel checks again once it settles.
    expect(source).toMatch(/takeover\?\.from === "saving"\) \{[\s\S]*?takeover\.settled\.then\(\(\) => \{\s*if \(!cancelled\) setRetryCount/);
  });
});
