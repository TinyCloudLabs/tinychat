// A job PTX holds for its provider (`provider_delayed`, TC-2085) is a calm in-progress note:
// Sam's exact line, no failure, no Retry, still polled; an absent field changes nothing.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Pin HOME to a ticket temp dir before anything can write (nothing here should write at all).
const HOME = mkdtempSync(join("/var/tmp", "tc-2085."));
appendFileSync("/var/tmp/tc-2085-mktemp-list.txt", `${HOME}\n`);
process.env.HOME = HOME;
if (process.env.HOME !== HOME || !HOME.startsWith("/var/tmp/tc-2085.")) throw new Error("test HOME is not the ticket temp dir");
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

import type { PrivateCloudApi, PrivateCloudJob } from "../privateCloud";
import { notePipeline, type NotePipelineInput } from "./notePipeline";
import {
  createVoiceNoteCloud,
  localStorageVoiceNotePendingStore,
  transcriptionStatusText,
  type VoiceNoteTranscriptionStatus,
} from "./voiceNoteTranscription";

const SAM_LINE = "Transcription is delayed, it will finish automatically.";
const DID = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const ID = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const CAPS = { max_bytes: 120_960_000, max_duration_seconds: 7_777, content_types: ["audio/wav"], admission: "open" };

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const job = (status: PrivateCloudJob["status"], extra: Partial<PrivateCloudJob> = {}): PrivateCloudJob => ({ id: ID, status, ...extra });

/** Re-joins a job already past its upload and polls it through the scripted answers (the re-join's own status read sees the first). */
async function pollThrough(answers: PrivateCloudJob[]): Promise<VoiceNoteTranscriptionStatus[]> {
  const queue = [answers[0]!, ...answers];
  let t = 0;
  const api: PrivateCloudApi = {
    backendUrl: "https://api.example",
    bearer: () => "tok",
    capabilities: async () => CAPS,
    list: async () => [],
    get: async (id) => ({ ...(queue.length > 1 ? queue.shift()! : queue[0]!), id }),
    result: async () => ({
      status: "completed",
      transcript: { segments: [{ channel: 0, start: 0, end: 1, text: "hi" }], text: "hi" },
    }),
    cancel: async () => {},
    remove: async () => {},
  };
  const pending = localStorageVoiceNotePendingStore(DID, memoryStorage());
  pending.write("rec-1", { attemptId: "attempt-1", transcriptionId: ID });
  const cloud = createVoiceNoteCloud({
    api,
    origin: "https://ptx.example",
    pending,
    create: async () => { throw new Error("a re-joined job is not created again"); },
    put: async () => { throw new Error("a job past its upload is not uploaded again"); },
    clock: { now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0.5 },
  });
  const reported: VoiceNoteTranscriptionStatus[] = [];
  await cloud.transcribe({ sourceId: "rec-1", capabilities: CAPS, loadAudio: async () => { throw new Error("no audio is needed"); } },
    (status) => reported.push(status));
  return reported;
}

describe("provider_delayed in the note's progress", () => {
  test("a delayed job reports delayed, then normal progress once the field clears, and never fails", async () => {
    const reported = await pollThrough([
      job("queued", { provider_delayed: true }),
      job("processing", { provider_delayed: true, progress: { regions_completed: 0, regions_total: 2 } }),
      job("processing", { progress: { regions_completed: 1, regions_total: 2 } }),
      job("completed"),
    ]);
    expect(reported.map((s) => s.kind)).toEqual(["queued", "delayed", "delayed", "processing"]);
    expect(reported.at(-1)).toEqual({ kind: "processing", completed: 1, total: 2 });
  });

  test("an absent field is not delayed: queued and processing report as before", async () => {
    const reported = await pollThrough([job("queued"), job("processing", { progress: { regions_completed: 1, regions_total: 2 } }), job("completed")]);
    expect(reported.map((s) => s.kind)).toEqual(["queued", "queued", "processing"]);
    expect(reported.some((s) => s.kind === "delayed")).toBe(false);
  });

  test("provider_delayed: false is not delayed", async () => {
    const reported = await pollThrough([job("processing", { provider_delayed: false }), job("completed")]);
    expect(reported.map((s) => s.kind)).toEqual(["queued", "processing"]);
  });

  test("the status line is exactly Sam's wording", () => {
    expect(transcriptionStatusText({ kind: "delayed" })).toBe(SAM_LINE);
  });
});

function pipelineInput(cloud: NonNullable<NotePipelineInput["transcript"]["cloud"]>): NotePipelineInput {
  return {
    device: "phone",
    route: "private-cloud",
    hasNotesOrMoments: false,
    online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, onDevice: null, cloud },
    notes: { state: "idle" },
  };
}

describe("a delayed note in the pipeline", () => {
  test("shows Sam's line as progress: not failed, no blocker, no Retry or other action", () => {
    const pipeline = notePipeline(pipelineInput({ kind: "active", status: { kind: "delayed" } }));
    const step = pipeline.steps.find((s) => s.key === "transcript");
    expect(step).toMatchObject({ state: "active", caption: SAM_LINE });
    expect(step?.blocker).toBeUndefined();
    expect(pipeline.blocker).toBeUndefined();
    expect(pipeline.current).toBe("transcript");
  });

  test("the same note failing with a provider code still shows the failed copy with Retry", () => {
    const pipeline = notePipeline(pipelineInput({
      kind: "failed", code: "provider_unavailable", message: "x", retryable: true, reference: null,
    }));
    expect(pipeline.steps.find((s) => s.key === "transcript")?.state).toBe("failed");
    expect(pipeline.blocker?.action?.kind).toBe("retry");
  });
});
