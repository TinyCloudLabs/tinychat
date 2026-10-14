import { afterEach, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { StoreResult, UpsertMeetingOutcome } from "../connectors/connectorStore";
import { createHostedAssemblyAiClient } from "../assemblyai";
import { bytesToBase64 } from "./voiceNoteAudio";
import { createHostedVoiceNoteTrack } from "./hostedVoiceNotes";
import { withHostedUploadQueue } from "../hostedUploadQueue";
import type { VoiceNoteRecording, VoiceNotesPlugin, LocalTranscript } from "./nativeVoiceNotes";
import type { TranscriptCommit } from "./voiceNoteCommits";
import { transcriptHash } from "./voiceNoteRows";

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function harness(failAt?: "part" | "submit" | "result" | "space" | "delete", noSpeech = false, spaceOnly = false, mimeType = "audio/mp4",
  durationMs = 1000, transcriptResponses: Record<string, unknown>[] = [], deleteFails = false,
  clientOverride?: ReturnType<typeof createHostedAssemblyAiClient>) {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  } });
  const calls: string[] = [];
  let transcriptReads = 0;
  let now = 0;
  const sleeps: number[] = [];
  const clock = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; }, random: () => 0.5 };
  const audio = new Uint8Array([1, 2, 3, 4]);
  let failed = false;
  let submitted = false;
  let local: LocalTranscript | null = null;
  let savedMetadata: Record<string, unknown> | null = null;
  let commit: TranscriptCommit | null = null;
  let commitAfterSave: TranscriptCommit | undefined;
  const recording = { id: "note-1", owner: "did:test:one", source: "in_app", startedAt: 1,
    durationMs, mimeType, sizeBytes: audio.length,
    options: { transcriber: "assemblyai", identifySpeakers: true } } as VoiceNoteRecording;
  const native = {
    listPending: async () => ({ recordings: spaceOnly ? [] : [recording] }),
    readAudioChunk: async ({ offset, length }: { offset: number; length: number }) => ({
      base64: bytesToBase64(audio.slice(offset, offset + length)), bytesRead: length, size: audio.length,
    }),
    beginRemoteOp: async () => {}, recordRemoteResult: async () => {},
    getTranscript: async () => ({ transcript: local }),
    putTranscript: async ({ transcript }: { transcript: LocalTranscript }) => { calls.push("local:put"); local = transcript; },
  } as unknown as VoiceNotesPlugin;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://exo.test");
    const path = url.pathname.replace("/api/transcriber/assemblyai", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path === "/capabilities") return json({ hosted: true, max_bytes: 1000, part_size: 2,
      content_types: ["audio/mp4", "audio/webm"], daily_bytes_remaining: 1000 });
    if (path === "/hosted/uploads" && method === "POST") {
      expect(JSON.parse(String(init?.body)).content_type).toBe(mimeType.split(";")[0].trim().toLowerCase());
      return json({ upload_id: "upload-1", part_size: 2 });
    }
    if (path === "/hosted/uploads/upload-1" && method === "GET") return json({ status: submitted ? "submitted" : "receiving", id: submitted ? "handle-1" : undefined });
    if (path.startsWith("/hosted/uploads/upload-1/parts/") && method === "PUT") {
      if (failAt === "part" && !failed) { failed = true; throw new Error("offline"); }
      return json({ ok: true });
    }
    if (path === "/hosted/transcripts" && method === "POST") {
      if (failAt === "submit" && !failed) { failed = true; throw new Error("offline"); }
      submitted = true;
      return json({ status: "submitted", id: "handle-1" });
    }
    if (path === "/hosted/transcripts/handle-1" && method === "GET") {
      const response = transcriptResponses[transcriptReads++];
      if (response !== undefined) return json(response);
      if (failAt === "result" && !failed) { failed = true; return json({ error: "read_failed" }, 400); }
      return json({ id: "handle-1", status: "completed", utterances: noSpeech ? [] : [{ start: 0, end: 1000, text: "Hello", speaker: "A" }] });
    }
    if (path === "/hosted/transcripts/handle-1/sentences" && method === "GET") return json({ sentences: [] });
    if (path.startsWith("/hosted/transcripts/") && method === "DELETE") {
      if (failAt === "delete" || deleteFails) throw new Error("offline");
      return json({ ok: true });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  const client = clientOverride ?? createHostedAssemblyAiClient({ backendUrl: "https://exo.test",
    sessionStore: { getToken: () => "session", isExpired: () => false }, fetchImpl: fetchImpl as typeof fetch,
    sleep: async () => {} });
  const account = { did: "did:test:one" } as TinyCloudWeb;
  const track = () => createHostedVoiceNoteTrack(() => account, "https://exo.test", {} as SessionStore, account.did, {
    client, native, clock, readCommit: async () => commit, createRow: async () => ({ inserted: true }) as Awaited<ReturnType<typeof import("./voiceNoteRows").createVoiceNoteRow>>,
    preserveHistory: async () => {},
    readNote: async () => ({ ok: true, data: { captureTranscriber: "assemblyai", durationSeconds: 1 } }) as Awaited<ReturnType<typeof import("./voiceNoteStore").readVoiceNoteForTranscription>>,
    loadAudio: async () => ({ ok: true, data: { mimeType: "audio/mp4", base64: bytesToBase64(audio) } }) as Awaited<ReturnType<typeof import("./voiceNoteStore").loadVoiceNoteAudio>>,
    save: async (_account, _id, transcript) => {
      calls.push("space:save");
      savedMetadata = transcript.metadata;
      if (failAt === "space" && !failed) { failed = true; return { ok: false, error: new Error("offline") } as StoreResult<UpsertMeetingOutcome>; }
      commit = commitAfterSave ?? { rev: transcript.rev, hash: await transcriptHash(transcript.sentences),
        outcome: noSpeech ? "no_speech" : "transcribed" } as TranscriptCommit;
      return { ok: true } as StoreResult<UpsertMeetingOutcome>;
    },
  });
  return { calls, recording, track, setCommit: (value: TranscriptCommit | null) => { commit = value; },
    setCommitAfterSave: (value: TranscriptCommit) => { commitAfterSave = value; },
    getLocal: () => local, getSavedMetadata: () => savedMetadata, sleeps };
}

test("a Powerful rerun that loses the transcript CAS reports the Private conflict message", async () => {
  const client = {
    capabilities: async () => ({ hosted: true, max_bytes: 1000, part_size: 2,
      content_types: ["audio/mp4"], daily_bytes_remaining: 1000 }),
    createUpload: async () => ({ uploadId: "upload-1", partSize: 2 }),
    putPart: async () => {},
    createTranscript: async () => ({ id: "handle-1", status: "queued" }),
    getTranscript: async () => ({ id: "handle-1", status: "completed",
      utterances: [{ start: 0, end: 1000, text: "Hello", speaker: "A" }] }),
    getSentences: async () => [],
    deleteTranscript: async () => {},
  } as unknown as ReturnType<typeof createHostedAssemblyAiClient>;
  const { calls, recording, track, setCommit, setCommitAfterSave } = harness(undefined, false, false, "audio/mp4",
    1000, [], false, client);
  setCommit({ sourceId: "note-1", rev: 1, hash: "base-hash", outcome: "transcribed" } as TranscriptCommit);
  setCommitAfterSave({ sourceId: "note-1", rev: 3, hash: "other-device-hash", outcome: "transcribed" } as TranscriptCommit);
  recording.options!.uploadAudio = false;
  const lane = track();
  lane.consent();
  await lane.run(recording, true);
  expect(calls.filter((call) => call.startsWith("space:"))).toEqual(["space:save"]);
  expect(lane.jobs.get("note-1")).toMatchObject({
    kind: "failed", message: "A different transcript revision won this rerun. Try again.",
  });
});

test("a manual Powerful retry deletes a prior cleanup-only transcript before replacing its entry", async () => {
  const { calls, recording, track, setCommit } = harness();
  setCommit({ sourceId: "note-1", rev: 1, hash: "base-hash", outcome: "transcribed" } as TranscriptCommit);
  localStorage.setItem("exo.voiceNotes.powerfulJobs:did:test:one", JSON.stringify({
    "note-1": { handle: "stale-handle", cleanupOnly: true },
  }));
  const lane = track();
  lane.consent();
  await lane.run(recording, true);
  const deleteIndex = calls.indexOf("DELETE /hosted/transcripts/stale-handle");
  const uploadIndex = calls.indexOf("POST /hosted/uploads");
  expect(deleteIndex).toBeGreaterThanOrEqual(0);
  expect(deleteIndex).toBeLessThan(uploadIndex);
});

test("a space-only note uses its space audio and can resume without a native recording", async () => {
  const { calls, track } = harness("result", false, true);
  const first = track(); first.consent();
  expect(await first.runSpaceOnly("note-1")).toBe(true);
  expect(first.jobs.get("note-1")?.kind).toBe("failed");
  await track().resume();
  for (let turn = 0; turn < 5 && !calls.includes("DELETE /hosted/transcripts/handle-1"); turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toContain("space:save");
  expect(calls).not.toContain("local:put");
  expect(calls.indexOf("space:save")).toBeLessThan(calls.indexOf("DELETE /hosted/transcripts/handle-1"));
});

test("an explicit Powerful rerun is never restarted by resume and its stale marker is removed", async () => {
  const { calls, recording, track } = harness();
  const key = "exo.voiceNotes.powerfulJobs:did:test:one";
  localStorage.setItem(key, JSON.stringify({
    "note-1": { explicitRerun: true, recording },
  }));
  await track().resume();
  expect(calls).toEqual([]);
  expect(JSON.parse(localStorage.getItem(key) ?? "{}")).toEqual({});
});

test("failed Powerful rerun retains its remote handle until resume cleanup succeeds", async () => {
  const { calls, recording, track, setCommit } = harness("result", false, false, "audio/mp4", 1000, [], true);
  setCommit({ sourceId: "note-1", rev: 1, hash: "prior-hash", outcome: "transcribed" } as TranscriptCommit);
  const lane = track();
  lane.consent();
  await lane.run(recording, true);
  const key = "exo.voiceNotes.powerfulJobs:did:test:one";
  const pending = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, { handle?: string; explicitRerun?: boolean }>;
  expect(pending["note-1"]?.handle).toBe("handle-1");
  expect(pending["note-1"]?.explicitRerun).toBeUndefined();
  const submits = calls.filter((call) => call === "POST /hosted/transcripts").length;
  await track().resume();
  expect(calls.filter((call) => call === "POST /hosted/transcripts")).toHaveLength(submits);
  expect(calls.filter((call) => call === "DELETE /hosted/transcripts/handle-1").length).toBeGreaterThan(1);
});
test("hosted AssemblyAI no_speech never sets PTX missing-stats metadata", async () => {
  const { calls, recording, track, getLocal, getSavedMetadata } = harness(undefined, true);
  const lane = track(); lane.consent();
  await lane.run(recording);
  expect(lane.jobs.get(recording.id)).toEqual({ kind: "done", outcome: "no_speech" });
  expect(getLocal()?.outcome).toBe("no_speech");
  expect(getSavedMetadata()).not.toHaveProperty("transcription_stats_missing");
  expect(calls.indexOf("space:save")).toBeLessThan(calls.indexOf("DELETE /hosted/transcripts/handle-1"));
});
test("Powerful keeps a saved outcome when remote transcript deletion fails", async () => {
  const { calls, recording, track, getLocal } = harness("delete");
  const lane = track(); lane.consent();
  await lane.run(recording);
  expect(calls).toContain("space:save");
  expect(getLocal()?.outcome).toBe("transcribed");
  expect(lane.jobs.get(recording.id)).toEqual({ kind: "done", outcome: "transcribed" });
});

test("Powerful accepts webm with codec parameters and sends the base MIME type", async () => {
  const { recording, track } = harness(undefined, false, false, " Audio/WebM;codecs=opus ");
  const lane = track(); lane.consent();
  await lane.run(recording);
  expect(lane.jobs.get(recording.id)).toEqual({ kind: "done", outcome: "transcribed" });
});
test("hosted AssemblyAI commits never set PTX-only missing-stats metadata", async () => {
  const { recording, track, getSavedMetadata } = harness();
  const lane = track(); lane.consent();
  await lane.run(recording);
  expect(getSavedMetadata()).not.toHaveProperty("transcription_stats_missing");
});


test("concurrent explicit reruns admit one hosted job while ordinary admission remains available", async () => {
  const rerunHarness = harness();
  rerunHarness.setCommit({ sourceId: "note-1", rev: 1, hash: "prior-hash", outcome: "transcribed" } as TranscriptCommit);
  const reruns = rerunHarness.track();
  reruns.consent();
  await Promise.all([reruns.run(rerunHarness.recording, true), reruns.run(rerunHarness.recording, true)]);
  expect(rerunHarness.calls.filter((call) => call === "POST /hosted/uploads")).toHaveLength(1);
  expect(rerunHarness.calls.filter((call) => call === "POST /hosted/transcripts")).toHaveLength(1);
  expect(rerunHarness.calls.filter((call) => call === "space:save")).toHaveLength(1);

  const ordinaryHarness = harness();
  const ordinary = ordinaryHarness.track();
  ordinary.consent();
  await ordinary.run(ordinaryHarness.recording);
  expect(ordinaryHarness.calls.filter((call) => call === "POST /hosted/uploads")).toHaveLength(1);
  expect(ordinaryHarness.calls.filter((call) => call === "POST /hosted/transcripts")).toHaveLength(1);
  expect(ordinaryHarness.calls.filter((call) => call === "space:save")).toHaveLength(1);
});
test("Powerful waits for the account's Upload audio submission before creating an upload", async () => {
  const { calls, recording, track } = harness();
  let release!: () => void;
  const otherUpload = withHostedUploadQueue(recording.owner!, () => new Promise<void>((resolve) => { release = resolve; }));
  const lane = track(); lane.consent();
  const note = lane.run(recording);
  for (let turn = 0; turn < 3; turn++) await Promise.resolve();
  expect(calls).not.toContain("POST /hosted/uploads");
  release();
  await Promise.all([otherUpload, note]);
  expect(calls).toContain("POST /hosted/uploads");
  expect(lane.jobs.get(recording.id)?.kind).toBe("done");
});

for (const interruption of [undefined, "part", "submit", "result", "space"] as const) {
  test(`Powerful re-joins after ${interruption ?? "no interruption"} and deletes after both saves`, async () => {
    const { calls, recording, track, getLocal } = harness(interruption);
    const first = track(); first.consent();
    await first.run(recording);
    if (interruption) {
      expect(first.jobs.get(recording.id)?.kind).toBe("failed");
      await track().run(recording);
    }
    expect(getLocal()?.engine).toBe("assemblyai");
    expect(getLocal()?.segments[0]?.speaker).toBe("Speaker A");
    expect(calls.indexOf("local:put")).toBeLessThan(calls.indexOf("space:save"));
    expect(calls.indexOf("space:save")).toBeLessThan(calls.indexOf("DELETE /hosted/transcripts/handle-1"));
    expect(calls.every((call) => !call.includes("assemblyai.com"))).toBe(true);
    expect(track().jobs.size).toBe(0);
  });
}
test("hosted voice-note polling scales its slow cadence from the saved recording duration", async () => {
  const processing = Array.from({ length: 7 }, () => ({ id: "handle-1", status: "processing" }));
  const completed = { id: "handle-1", status: "completed", utterances: [{ start: 0, end: 1000, text: "Hello", speaker: "A" }] };
  const { recording, track, sleeps } = harness(undefined, false, false, "audio/mp4", 72 * 60_000, [...processing, completed]);
  const lane = track();
  lane.consent();
  await lane.run(recording);
  expect(sleeps[6]).toBeGreaterThanOrEqual(60_000);
});
