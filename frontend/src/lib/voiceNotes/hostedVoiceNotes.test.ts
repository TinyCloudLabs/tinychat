import { afterEach, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createHostedAssemblyAiClient } from "../assemblyai";
import { bytesToBase64 } from "./voiceNoteAudio";
import { createHostedVoiceNoteTrack } from "./hostedVoiceNotes";
import { withHostedUploadQueue } from "../hostedUploadQueue";
import type { VoiceNoteRecording, VoiceNotesPlugin, LocalTranscript } from "./nativeVoiceNotes";
import type { TranscriptCommit } from "./voiceNoteCommits";

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function harness(failAt?: "part" | "submit" | "result" | "space" | "delete", noSpeech = false, spaceOnly = false, mimeType = "audio/mp4") {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  } });
  const calls: string[] = [];
  const audio = new Uint8Array([1, 2, 3, 4]);
  let failed = false;
  let local: LocalTranscript | null = null;
  let commit: TranscriptCommit | null = null;
  let submitted = false;
  const recording = { id: "note-1", owner: "did:test:one", source: "in_app", startedAt: 1,
    durationMs: 1000, mimeType, sizeBytes: audio.length,
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
      if (failAt === "result" && !failed) { failed = true; throw new Error("offline"); }
      return json({ id: "handle-1", status: "completed", utterances: noSpeech ? [] : [{ start: 0, end: 1000, text: "Hello", speaker: "A" }] });
    }
    if (path === "/hosted/transcripts/handle-1/sentences" && method === "GET") return json({ sentences: [] });
    if (path === "/hosted/transcripts/handle-1" && method === "DELETE") {
      if (failAt === "delete") throw new Error("offline");
      return json({ ok: true });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  const client = createHostedAssemblyAiClient({ backendUrl: "https://exo.test",
    sessionStore: { getToken: () => "session", isExpired: () => false }, fetchImpl: fetchImpl as typeof fetch,
    sleep: async () => {} });
  const account = { did: "did:test:one" } as TinyCloudWeb;
  const track = () => createHostedVoiceNoteTrack(() => account, "https://exo.test", {} as SessionStore, account.did, {
    client, native, readCommit: async () => commit, createRow: async () => ({ inserted: true }) as Awaited<ReturnType<typeof import("./voiceNoteRows").createVoiceNoteRow>>,
    readNote: async () => ({ ok: true, data: { captureTranscriber: "assemblyai", durationSeconds: 1 } }) as Awaited<ReturnType<typeof import("./voiceNoteStore").readVoiceNoteForTranscription>>,
    loadAudio: async () => ({ ok: true, data: { mimeType: "audio/mp4", base64: bytesToBase64(audio) } }) as Awaited<ReturnType<typeof import("./voiceNoteStore").loadVoiceNoteAudio>>,
    save: async (_account, _id, transcript) => {
      calls.push("space:save");
      if (failAt === "space" && !failed) { failed = true; return { ok: false, error: new Error("offline") } as Awaited<ReturnType<typeof import("./voiceNoteStore").saveVoiceNoteTranscript>>; }
      commit = { rev: transcript.rev, outcome: noSpeech ? "no_speech" : "transcribed" } as TranscriptCommit;
      return { ok: true } as Awaited<ReturnType<typeof import("./voiceNoteStore").saveVoiceNoteTranscript>>;
    }, sleep: async () => {},
  });
  return { calls, recording, track, getLocal: () => local };
}

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

test("Powerful keeps a no-speech result before deleting the server copy", async () => {
  const { calls, recording, track, getLocal } = harness(undefined, true);
  const lane = track(); lane.consent();
  await lane.run(recording);
  expect(lane.jobs.get(recording.id)).toEqual({ kind: "done", outcome: "no_speech" });
  expect(getLocal()?.outcome).toBe("no_speech");
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
