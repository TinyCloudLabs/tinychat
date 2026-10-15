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

function harness(failAt?: "part" | "submit" | "result" | "space" | "storage_full" | "delete", noSpeech = false, spaceOnly = false, mimeType = "audio/mp4",
  durationMs = 1000, transcriptResponses: Record<string, unknown>[] = [], deleteFails = false,
  clientOverride?: ReturnType<typeof createHostedAssemblyAiClient>, readGate?: Promise<void>,
  createFailure?: "existing" | "missing", reconciliationDelayMs?: number, committedChannels: 1 | 2 = 1) {
  const data = new Map<string, string>();
  const claims = new Map<string, { value: string; etag: string }>();
  const claimCalls: string[] = [];
  let revision = 0;
  let releaseFailures = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  } });
  const calls: string[] = [];
  const submits: unknown[] = [];
  let commitReads = 0;
  let transcriptReads = 0;
  let now = 0;
  const sleeps: number[] = [];
  const audio = new Uint8Array([1, 2, 3, 4]);
  let failed = false;
  let submitted = false;
  let local: LocalTranscript | null = null;
  let savedMetadata: Record<string, unknown> | null = null;
  let commit: TranscriptCommit | null = null;
  let commitAfterSave: TranscriptCommit | undefined;
  let serverJob: { status: string; upload_id?: string; id?: string } = { status: "missing" };
  const recording = { id: "note-1", owner: "did:test:one", source: "in_app", startedAt: 1,
    durationMs, mimeType, sizeBytes: audio.length,
    options: { transcriber: "assemblyai", identifySpeakers: true, uploadAudio: true } } as VoiceNoteRecording;
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
    if (path === "/hosted/jobs/note-1" && method === "GET") return json(serverJob);
    if (path === "/hosted/uploads" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      expect(body.content_type).toBe(mimeType.split(";")[0].trim().toLowerCase());
      expect(body.source_id).toBe("note-1");
      if (serverJob.status === "needs_reconciliation" || serverJob.status === "unresolved")
        return json({ upload_id: "upload-1", part_size: 2, status: serverJob.status });
      if (createFailure && !failed) {
        failed = true;
        if (createFailure === "existing") serverJob = { status: "receiving", upload_id: "upload-1" };
        throw new Error("response lost");
      }
      serverJob = { status: "receiving", upload_id: "upload-1" };
      return json({ upload_id: "upload-1", part_size: 2 });
    }
    if (path === "/hosted/uploads/upload-1" && method === "GET") return json({ status: submitted ? "submitted" : "receiving", id: submitted ? "handle-1" : undefined });
    if (path.startsWith("/hosted/uploads/upload-1/parts/") && method === "PUT") {
      if (failAt === "part" && !failed) { failed = true; throw new Error("offline"); }
      return json({ ok: true });
    }
    if (path === "/hosted/transcripts" && method === "POST") {
      submits.push(JSON.parse(String(init?.body)));
      if (failAt === "submit" && !failed) { failed = true; throw new Error("offline"); }
      submitted = true;
      serverJob = { status: "submitted", upload_id: "upload-1", id: "handle-1" };
      return json({ status: "submitted", id: "handle-1" });
    }
    if (path === "/hosted/transcripts/handle-1" && method === "GET") {
      const response = transcriptResponses[transcriptReads++];
      if (response !== undefined) return json(response);
      if (failAt === "result" && !failed) { failed = true; return json({ error: "read_failed" }, 400); }
      return json({ id: "handle-1", status: "completed", utterances: noSpeech ? [] : [{ start: 0, end: 1000, text: "Hello", speaker: recording.channels === 2 ? "1" : "A" }] });
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
  const account = { did: "did:test:one", kv: {
    get: async (key: string) => {
      claimCalls.push("get");
      const entry = claims.get(key);
      return entry ? { ok: true, data: { data: entry.value, headers: { etag: entry.etag } } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    put: async (key: string, value: string, options?: { ifNoneMatch?: string; ifMatch?: string }) => {
      claimCalls.push("put");
      if (JSON.parse(value).status === "failed" && releaseFailures-- > 0)
        return { ok: false, error: { code: "KV_UNAVAILABLE", message: "offline" } };
      const entry = claims.get(key);
      if ((options?.ifNoneMatch && entry) || (options?.ifMatch && options.ifMatch !== entry?.etag))
        return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
      claims.set(key, { value, etag: String(++revision) });
      return { ok: true, data: {} };
    },
  } } as unknown as TinyCloudWeb;
  const track = () => createHostedVoiceNoteTrack(() => account, "https://exo.test", {} as SessionStore, account.did, {
    client, native, readCommit: async () => { commitReads++; await readGate; return commit; },
    createRow: async () => ({ inserted: true }) as Awaited<ReturnType<typeof import("./voiceNoteRows").createVoiceNoteRow>>,
    preserveHistory: async () => {},
    clock: { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, random: () => 0.5 },
    readNote: async () => ({ ok: true, data: { captureTranscriber: "assemblyai", durationSeconds: 1, channels: committedChannels } }) as Awaited<ReturnType<typeof import("./voiceNoteStore").readVoiceNoteForTranscription>>,
    loadAudio: async () => { calls.push("space:audio"); return { ok: true, data: { mimeType: "audio/mp4", base64: bytesToBase64(audio) } } as Awaited<ReturnType<typeof import("./voiceNoteStore").loadVoiceNoteAudio>>; },
    save: async (_account, _id, transcript) => {
      calls.push("space:save");
      savedMetadata = transcript.metadata;
      if ((failAt === "space" || failAt === "storage_full") && !failed) {
        failed = true;
        const error = failAt === "storage_full" ? Object.assign(new Error("storage full"), { code: "STORAGE_QUOTA_EXCEEDED" }) : new Error("offline");
        return { ok: false, error } as StoreResult<UpsertMeetingOutcome>;
      }
      commit = commitAfterSave ?? { rev: transcript.rev, hash: await transcriptHash(transcript.sentences),
        outcome: noSpeech ? "no_speech" : "transcribed" } as TranscriptCommit;
      calls.push("space:commit");
      return { ok: true } as StoreResult<UpsertMeetingOutcome>;
    }, sleep: async () => {}, reconciliationDelayMs,
  });
  return { calls, submits, claimCalls, recording, track, setCommit: (value: TranscriptCommit | null) => { commit = value; },
    setCommitAfterSave: (value: TranscriptCommit) => { commitAfterSave = value; },
    getCommit: () => commit, commitReads: () => commitReads, getClaims: () => new Map(claims),
    getPending: () => data.get(`exo.voiceNotes.powerfulJobs:${account.did}`) ?? null,
    getLocal: () => local, getSavedMetadata: () => savedMetadata, sleeps,
    setClaim: (claim: object) => claims.set("exo/voiceNotes/hostedJobs/note-1", { value: JSON.stringify(claim), etag: String(++revision) }),
    failReleases: (count: number) => { releaseFailures = count; },
    setServerJob: (job: typeof serverJob) => { serverJob = job; } };
}

test("Powerful explicit reruns refuse before claims, backend calls, or pending-state changes", async () => {
  const h = harness();
  h.setCommit({ sourceId: "note-1", rev: 1, hash: "base-hash", outcome: "transcribed" } as TranscriptCommit);
  h.setClaim({ version: 1, status: "submitted", token: "existing-claim", handle: "existing-handle" });
  const claimSnapshot = h.getClaims();
  const commit = h.getCommit();
  const key = "exo.voiceNotes.powerfulJobs:did:test:one";
  const pending = JSON.stringify({ "note-1": { handle: "existing-handle", saved: true, recording: h.recording } });
  localStorage.setItem(key, pending);
  const lane = h.track();
  lane.consent();

  await expect(lane.run(h.recording, true)).rejects.toThrow("Transcribe again isn't available with Powerful yet.");
  await expect(lane.runSpaceOnly("note-1", true)).rejects.toThrow("Transcribe again isn't available with Powerful yet.");
  expect(h.calls).toEqual([]);
  expect(h.claimCalls).toEqual([]);
  expect(h.getClaims()).toEqual(claimSnapshot);
  expect(h.commitReads()).toBe(0);
  expect(h.getCommit()).toBe(commit);
  expect(localStorage.getItem(key)).toBe(pending);
  expect(lane.jobs.has("note-1")).toBe(false);
});

test("Powerful requests multichannel and labels stereo turns Me and Them", async () => {
  const h = harness();
  h.recording.channels = 2;
  const lane = h.track();
  lane.consent();
  await lane.run(h.recording);
  expect(h.submits[0]).toMatchObject({ multichannel: true });
  expect(h.getLocal()?.segments[0]?.speaker).toBe("Me");
});

test("a space-only stereo note uses the committed channels for Powerful", async () => {
  const h = harness(undefined, false, true, "audio/mp4", 1000, [], false, undefined, undefined, undefined, undefined, 2);
  const lane = h.track(); lane.consent();
  expect(await lane.runSpaceOnly("note-1")).toBe(true);
  expect(h.submits[0]).toMatchObject({ multichannel: true });
  expect(h.getLocal()).toBeNull();
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

test("storage-full commit keeps the hosted result until a verified commit", async () => {
  const h = harness("storage_full");
  const lane = h.track(); lane.consent();
  await lane.run(h.recording);
  expect(h.calls).toContain("space:save");
  expect(h.calls).not.toContain("DELETE /hosted/transcripts/handle-1");
  expect(lane.jobs.get(h.recording.id)).toMatchObject({ kind: "failed", retryable: true });

  await h.track().resume();
  for (let turn = 0; turn < 5 && !h.calls.includes("DELETE /hosted/transcripts/handle-1"); turn++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  const commitIndex = h.calls.indexOf("space:commit");
  const deleteIndex = h.calls.indexOf("DELETE /hosted/transcripts/handle-1");
  expect(commitIndex).toBeGreaterThan(h.calls.indexOf("space:save"));
  expect(deleteIndex).toBeGreaterThan(commitIndex);
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
test("a paid outcome needing reconciliation blocks the note without another upload or automatic retry", async () => {
  const h = harness();
  h.setServerJob({ status: "needs_reconciliation", upload_id: "upload-1" });
  const lane = h.track(); lane.consent();
  await lane.run(h.recording);
  expect(lane.jobs.get("note-1")).toMatchObject({ kind: "failed", retryable: false,
    message: "Powerful couldn't confirm an earlier attempt. Exo is checking with AssemblyAI." });
  expect(h.calls.some((call) => call === "POST /hosted/uploads" || call === "POST /hosted/transcripts")).toBe(false);
});

test("a quarantined or missing lookup never enables Retry; provider-confirmed submission does", async () => {
  const h = harness(undefined, false, false, "audio/mp4", undefined, undefined, undefined, undefined, undefined, undefined, 5);
  h.setServerJob({ status: "unresolved" });
  const lane = h.track(); lane.consent();
  await lane.run(h.recording);
  expect(lane.jobs.get("note-1")).toMatchObject({ kind: "failed", retryable: false });
  h.setServerJob({ status: "missing" });
  await Bun.sleep(20);
  expect(lane.jobs.get("note-1")).toMatchObject({ kind: "failed", retryable: false });
  expect(h.calls.some((call) => call === "POST /hosted/uploads" || call === "POST /hosted/transcripts")).toBe(false);
  h.setServerJob({ status: "submitted", id: "handle-1", upload_id: "upload-1" });
  await Bun.sleep(20);
  expect(lane.jobs.get("note-1")).toMatchObject({ kind: "failed", retryable: true, code: "reconciled" });
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

test("a saved handle whose cleanup fails remains in the pending store", async () => {
  const h = harness("delete");
  h.setCommit({ sourceId: "note-1", rev: 1, hash: "prior-hash", outcome: "transcribed" } as TranscriptCommit);
  const key = "exo.voiceNotes.powerfulJobs:did:test:one";
  const existing = JSON.stringify({ "note-1": { handle: "handle-1", saved: true, recording: h.recording } });
  localStorage.setItem(key, existing);
  const lane = h.track();
  lane.consent();
  await lane.run(h.recording);
  expect(lane.jobs.get("note-1")).toMatchObject({ kind: "done", outcome: "transcribed" });
  expect(JSON.parse(String(h.getPending()))["note-1"]).toMatchObject({ handle: "handle-1", saved: true });
});

test("Powerful transcribes local-only audio and deletes the server copy", async () => {
  const { calls, recording, track } = harness();
  recording.options!.uploadAudio = false;
  const lane = track(); lane.consent();
  await lane.run(recording);
  expect(lane.jobs.get(recording.id)).toEqual({ kind: "done", outcome: "transcribed" });
  expect(calls).not.toContain("space:audio");
  expect(calls).toContain("space:save");
  expect(calls).toContain("DELETE /hosted/transcripts/handle-1");
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


test("ordinary hosted admission still uploads, submits, and saves once", async () => {
  const h = harness();
  const lane = h.track();
  lane.consent();
  await lane.run(h.recording);
  expect(h.calls.filter((call) => call === "POST /hosted/uploads")).toHaveLength(1);
  expect(h.calls.filter((call) => call === "POST /hosted/transcripts")).toHaveLength(1);
  expect(h.calls.filter((call) => call === "space:save")).toHaveLength(1);
});
test("Powerful checks the space commit before sending audio to the provider", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { calls, recording, track } = harness(undefined, false, false, "audio/mp4", 1000, [], false, undefined, gate);
  const lane = track(); lane.consent();
  const running = lane.run(recording);
  try {
    await Bun.sleep(10);
    expect(calls).not.toContain("POST /hosted/uploads");
    expect(calls).not.toContain("POST /hosted/transcripts");
    expect(calls).not.toContain("space:save");
  } finally { release(); }
  await running;
  expect(lane.jobs.get(recording.id)?.kind).toBe("done");
});

test("noteSaved after Powerful completes does not create a second paid upload", async () => {
  const { calls, recording, track } = harness();
  const lane = track(); lane.consent();
  await lane.run(recording);
  // The text/audio save finishes later and calls the same hand-off again.
  await lane.run(recording);
  expect(calls.filter((call) => call === "POST /hosted/uploads")).toHaveLength(1);
  expect(calls.filter((call) => call === "POST /hosted/transcripts")).toHaveLength(1);
});

test("two instances racing on one note create one upload and one transcript", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { calls, recording, track } = harness(undefined, false, false, "audio/mp4", 1000, [], false, undefined, gate);
  const first = track(); const second = track(); first.consent();
  const runs = Promise.all([first.run(recording), second.run(recording)]);
  await Bun.sleep(10);
  release();
  await runs;
  expect(calls.filter((call) => call === "POST /hosted/uploads")).toHaveLength(1);
  expect(calls.filter((call) => call === "POST /hosted/transcripts")).toHaveLength(1);
});

test("a crashed owner with an upload ID is taken over and resumed", async () => {
  const { calls, recording, track, setClaim, setServerJob } = harness();
  setClaim({ version: 1, status: "active", token: "dead", claimedAt: Date.now() - 6 * 60_000, uploadId: "upload-1" });
  setServerJob({ status: "receiving", upload_id: "upload-1" });
  const lane = track(); lane.consent();
  await lane.run(recording);
  expect(lane.jobs.get(recording.id)?.kind).toBe("done");
  expect(calls).not.toContain("POST /hosted/uploads");
  expect(calls.filter((call) => call === "POST /hosted/transcripts")).toHaveLength(1);
});

for (const result of ["existing", "missing"] as const) {
  test(`an ambiguous create reconciles ${result} server state`, async () => {
    const { calls, recording, track } = harness(undefined, false, false, "audio/mp4", 1000, [], undefined, undefined, undefined, result);
    const first = track(); first.consent();
    await first.run(recording);
    expect(first.jobs.get(recording.id)?.kind).toBe("failed");
    await track().run(recording);
    expect(calls.filter((call) => call === "POST /hosted/uploads")).toHaveLength(result === "existing" ? 1 : 2);
    expect(calls.filter((call) => call === "POST /hosted/transcripts")).toHaveLength(1);
  });
}

test("a failed claim release is retried before the next run", async () => {
  const { calls, recording, track, failReleases } = harness("part");
  failReleases(1);
  const first = track(); first.consent();
  await first.run(recording);
  expect(first.jobs.get(recording.id)?.kind).toBe("failed");
  await track().run(recording);
  expect(calls.filter((call) => call === "POST /hosted/uploads")).toHaveLength(1);
  expect(calls.filter((call) => call === "POST /hosted/transcripts")).toHaveLength(1);
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
