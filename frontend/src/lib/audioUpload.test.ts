// Upload audio (contracts C1, C5, C7, C8), driven through the upload runner
// with injected engines, audio store and saver:
//   - file types map to the canonical C1 content types;
//   - PTX results become diarized speaker turns, or unlabelled sentences for one mixed channel;
//   - the saved `exo-upload` meeting has the C7 row and metadata;
//   - AssemblyAI: speaker-labelled meeting, quota keeps the transcript, remote copy deleted after the save;
//   - Private: one job per Idempotency-Key, an unclear PUT re-joins it, the job is deleted after the save;
//   - a reload resumes this account's job only, and silence saves nothing.

import { describe, expect, test } from "bun:test";

import { AssemblyAiError, createHostedAssemblyAiClient, type AssemblyAiClient } from "./assemblyai";
import { AudioStoreQuotaError, type StoredAudioManifest } from "./audio/audioStore";
import {
  createUploadRunner,
  localStoragePendingUploadStore,
  plausibleFileTime,
  prepareUploadMeeting,
  privateCloudContentType,
  privateCloudUploadTranscript,
  type PendingUpload,
  type PendingUploadStore,
  type UploadDeps,
  type UploadRunner,
  type UploadState,
} from "./audioUpload";
import { NO_SPEECH_MESSAGE, type PreparedLocalTranscript } from "./localTranscriber";
import { PrivateCloudError, privateCloudJobClient, type PrivateCloudApi, type PrivateCloudCreateBody, type PrivateCloudTranscript } from "./privateCloud";

const DID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const ID = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";

function memoryPending(initial: PendingUpload | null = null): PendingUploadStore & { value: PendingUpload | null } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (job: PendingUpload) => {
      store.value = job;
    },
    clear: () => {
      store.value = null;
    },
  };
  return store;
}

const instantClock = { now: () => 0, sleep: async () => {}, random: () => 0.5 };

function audioFake(opts: { put?: (signal: AbortSignal | undefined) => Promise<StoredAudioManifest>; manifest?: StoredAudioManifest | null } = {}) {
  const calls: string[] = [];
  return {
    calls,
    audio: {
      put: (async (_kv: unknown, base: string, _source: unknown, o: { signal?: AbortSignal }) => {
        calls.push(`put ${base}`);
        return opts.put ? opts.put(o.signal) : ({} as StoredAudioManifest);
      }) as never,
      manifest: (async (_kv: unknown, base: string) => {
        calls.push(`manifest ${base}`);
        return opts.manifest ?? null;
      }) as never,
      remove: (async (_kv: unknown, base: string) => {
        calls.push(`remove ${base}`);
      }) as never,
    },
  };
}

function deps(patch: Partial<UploadDeps> & { events?: string[]; did?: string }): {
  deps: UploadDeps;
  saved: PreparedLocalTranscript[];
} {
  const saved: PreparedLocalTranscript[] = [];
  const events = patch.events ?? [];
  return {
    saved,
    deps: {
      tcw: { did: patch.did ?? DID, kv: {} } as never,
      privateCloud: null,
      assemblyAiClient: async () => {
        throw new Error("no AssemblyAI in this test");
      },
      save: async (prepared) => {
        events.push("save");
        saved.push(prepared);
        return { ok: true, data: { id: prepared.meeting.id, inserted: true, createdAt: "now" } };
      },
      pending: memoryPending(),
      clock: instantClock,
      hash: async () => "ab".repeat(32),
      lock: async () => () => {},
      ...patch,
    },
  };
}

/** Resolves with the state once the runner stops at saved or failed. */
function settled(runner: UploadRunner): Promise<UploadState> {
  return new Promise((resolve) => {
    const check = () => {
      const s = runner.snapshot();
      if (s !== null && (s.stage === "saved" || s.stage === "failed")) {
        unsubscribe();
        resolve(s);
      }
    };
    const unsubscribe = runner.subscribe(check);
    check();
  });
}

const file = (name: string, type: string, body = "abc") => new File([body], name, { type, lastModified: Date.UTC(2026, 9, 1, 9, 30) });

describe("privateCloudContentType", () => {
  test("extensions and browser types map to the C1 content types; anything else is not for private cloud", () => {
    expect(privateCloudContentType({ name: "call.opus", type: "" })).toBe("audio/ogg");
    expect(privateCloudContentType({ name: "memo.M4A", type: "audio/x-m4a" })).toBe("audio/mp4");
    expect(privateCloudContentType({ name: "book.m4b", type: "" })).toBe("audio/mp4");
    expect(privateCloudContentType({ name: "screen-recording", type: "video/webm" })).toBe("audio/webm");
    expect(privateCloudContentType({ name: "a.wav", type: "audio/x-wav" })).toBe("audio/wav");
    expect(privateCloudContentType({ name: "voice.aac", type: "audio/aac" })).toBeNull();
    expect(privateCloudContentType({ name: "clip.mov", type: "video/quicktime" })).toBeNull();
  });
});

describe("plausibleFileTime", () => {
  test("a file without a real time (Android's picker: 1601, or 0) is dated when it was uploaded", () => {
    const now = Date.UTC(2026, 9, 4, 6, 0);
    expect(plausibleFileTime(-11644473600000, now)).toBe(now);
    expect(plausibleFileTime(0, now)).toBe(now);
    expect(plausibleFileTime(now + 10 * 86_400_000, now)).toBe(now);
    expect(plausibleFileTime(Date.UTC(2026, 8, 30), now)).toBe(Date.UTC(2026, 8, 30));
  });
});

describe("privateCloudUploadTranscript", () => {
  test("a diarized result names each turn after its speaker", () => {
    const t: PrivateCloudTranscript = {
      diarized: true,
      language: "en",
      model: "whisper",
      duration_seconds: 12.4,
      speakers: [
        { id: "speaker_0", name: "Speaker 1", channel: 0 },
        { id: "speaker_1", name: "Speaker 2", channel: 0 },
      ],
      segments: [
        { speaker_id: "speaker_1", channel: 0, start: 3, end: 5, text: "Fine, thanks." },
        { speaker_id: "speaker_0", channel: 0, start: 0, end: 2, text: " How are you? " },
      ],
      text: "",
    };
    const out = privateCloudUploadTranscript(t);
    expect(out.sentences.map((s) => [s.speaker_name, s.text])).toEqual([
      ["Speaker 1", "How are you?"],
      ["Speaker 2", "Fine, thanks."],
    ]);
    expect(out).toMatchObject({ diarized: true, speakerLabels: "diarized", durationSecs: 12, language: "en", model: "whisper" });
  });

  test("one mixed channel has no speaker labels", () => {
    const out = privateCloudUploadTranscript({
      speakers: [{ id: "channel_0", name: "Speaker 1", channel: 0 }],
      segments: [{ speaker_id: "channel_0", channel: 0, start: 0, end: 1, text: "Hello" }],
      text: "Hello",
    });
    expect(out.speakerLabels).toBe("none");
    expect(out.sentences[0]!.speaker_name).toBeNull();
  });
});

describe("prepareUploadMeeting", () => {
  const pending = { engine: "assemblyai" as const, assemblyAiMode: "hosted" as const, meetingId: "m-1", file: { name: "Board call.final.m4a", type: "audio/x-m4a", size: 2048, lastModified: Date.UTC(2026, 9, 1) } };
  const transcript = {
    sentences: [{ index: 0, speaker_name: "Speaker A", text: "Hi", start_time: 0, end_time: 1 }],
    diarized: true,
    speakerLabels: "diarized" as const,
    durationSecs: 61,
    language: "en_us",
    model: "universal-3-5-pro",
  };

  test("the C7 row: exo-upload, title from the file name, start from the file's date, speakers as participants", () => {
    const { meeting, sentences } = prepareUploadMeeting(pending, transcript, { stored: false, reason: "quota" });
    expect(meeting).toMatchObject({
      id: "m-1",
      source: "exo-upload",
      sourceId: "m-1",
      title: "Board call.final",
      startedAt: "2026-10-01T00:00:00.000Z",
      durationSecs: 61,
      participants: [{ name: "Speaker A", email: null }],
    });
    expect(meeting.metadata).toEqual({
      capture: "upload",
      file_name: "Board call.final.m4a",
      content_type: "audio/mp4",
      byte_size: 2048,
      transcription_engine: "assemblyai",
      transcript_provider: "assemblyai",
      inference_provider: "assemblyai",
      assemblyai_account: "tinycloud",
      model: "universal-3-5-pro",
      language: "en_us",
      diarized: true,
      speaker_labels: "diarized",
      audio: { base: "xyz.tinycloud.tinychat/connectors/exo-upload/audio/m-1", stored: false, reason: "quota" },
      transcript_text: "Hi",
    });
    expect(sentences).toBe(transcript.sentences);
  });

  test("no speech is never saved", () => {
    expect(() => prepareUploadMeeting(pending, { ...transcript, sentences: [] }, { stored: true })).toThrow(NO_SPEECH_MESSAGE);
  });
});

describe("upload runner: AssemblyAI", () => {
  function assemblyAi(events: string[]) {
    const requests: unknown[] = [];
    const client: AssemblyAiClient = {
      validateKey: async () => {},
      upload: async () => {
        events.push("aai upload");
        return "https://cdn.assemblyai.com/upload/u1";
      },
      createTranscript: async (url, o) => {
        requests.push({ url, speakerLabels: o.speakerLabels });
        return { id: "t1", status: "queued" };
      },
      getTranscript: async () => ({
        id: "t1",
        status: "completed",
        audio_duration: 4.2,
        language_code: "en",
        speech_model_used: "universal-3-5-pro",
        utterances: [
          { speaker: "A", text: "Hello.", start: 0, end: 1000 },
          { speaker: "B", text: "Hi there.", start: 1200, end: 2500 },
        ],
      }),
      getSentences: async () => [],
      deleteTranscript: async (id) => {
        events.push(`aai delete ${id}`);
      },
    };
    return { client, requests };
  }

  test("a diarized upload saves Speaker A/B turns; quota keeps the transcript without audio; AssemblyAI's copy is deleted after the save", async () => {
    const events: string[] = [];
    const { client, requests } = assemblyAi(events);
    const a = audioFake({ put: async () => Promise.reject(new AudioStoreQuotaError("full")) });
    const pending = memoryPending();
    const { deps: d, saved } = deps({ events, pending, audio: a.audio, assemblyAiClient: async () => client });
    const runner = createUploadRunner();
    runner.start(d, { file: file("standup.mp3", "audio/mpeg"), engine: "assemblyai", diarize: true });
    const done = await settled(runner);

    expect(done).toMatchObject({ stage: "saved", cleanupPending: false, audio: { stage: "quota", pct: null } });
    expect(requests).toEqual([{ url: "https://cdn.assemblyai.com/upload/u1", speakerLabels: true }]);
    expect(saved[0]!.sentences.map((s) => s.speaker_name)).toEqual(["Speaker A", "Speaker B"]);
    expect(saved[0]!.meeting.metadata).toMatchObject({ diarized: true, speaker_labels: "diarized", audio: { stored: false, reason: "quota" } });
    expect(events).toEqual(["aai upload", "save", "aai delete t1"]);
    expect(pending.value).toBeNull();
  });

  test("a failed save keeps AssemblyAI's transcript; Retry saves it and only then deletes it", async () => {
    const events: string[] = [];
    const { client } = assemblyAi(events);
    let failSave = true;
    const { deps: d, saved } = deps({ events, audio: audioFake().audio, assemblyAiClient: async () => client });
    const save = d.save;
    d.save = async (p) => (failSave ? { ok: false, error: { code: "TRANSPORT", message: "node unreachable" } } : save(p));
    const runner = createUploadRunner();
    runner.start(d, { file: file("a.mp3", "audio/mpeg"), engine: "assemblyai", diarize: true });
    const failed = await settled(runner);
    expect(failed.error).toMatchObject({ retry: true });
    expect(failed.error!.message).toContain("node unreachable");
    expect(events).not.toContain("aai delete t1");

    failSave = false;
    runner.retry(d);
    expect((await settled(runner)).stage).toBe("saved");
    expect(saved).toHaveLength(1);
    expect(events.filter((e) => e === "aai upload")).toHaveLength(1);
    expect(events.at(-1)).toBe("aai delete t1");
  });
});

describe("upload runner: Private", () => {
  function privateCloud(events: string[]) {
    const creates: { body: PrivateCloudCreateBody; attemptId: string }[] = [];
    const puts: { url: string; contentType: string; capability: string }[] = [];
    let putFailures = 1;
    const api = {
      get: async () => ({ id: ID, status: "completed" as const }),
      result: async () => ({
        status: "completed" as const,
        transcript: {
          diarized: false,
          speakers: [{ id: "channel_0", name: "Exo upload", channel: 0 }],
          segments: [{ speaker_id: "channel_0", channel: 0, start: 0, end: 2, text: "Notes for later." }],
          text: "Notes for later.",
          model: "whisper-large-v3-turbo",
        },
      }),
      remove: async (id: string) => {
        events.push(`ptx delete ${id}`);
      },
    } as unknown as PrivateCloudApi;
    const create: NonNullable<UploadDeps["privateCloud"]>["create"] = async ({ attemptId, body }) => {
      creates.push({ body, attemptId });
      return { id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: "tcu_abcdefghijklmnop1234" } };
    };
    const putFile: UploadDeps["putFile"] = async (input) => {
      puts.push({ url: input.url, contentType: input.contentType, capability: input.capability });
      if (putFailures-- > 0) throw new PrivateCloudError("upload_outcome_unknown", "unclear");
    };
    return { privateCloud: { api, origin: "https://ptx.example", create }, putFile, creates, puts };
  }

  test("create sends C1 metadata with Upload audio's labels; an unclear PUT re-joins the same job on Retry; the job is deleted after the save", async () => {
    const events: string[] = [];
    const p = privateCloud(events);
    const pending = memoryPending();
    const { deps: d, saved } = deps({ events, pending, audio: audioFake().audio, privateCloud: p.privateCloud, putFile: p.putFile });
    const runner = createUploadRunner();
    runner.start(d, { file: file("memo.m4a", "audio/x-m4a"), engine: "private-cloud", diarize: false });
    const failed = await settled(runner);
    expect(failed.error).toMatchObject({ retry: true, reference: ID });

    runner.retry(d);
    expect((await settled(runner)).stage).toBe("saved");
    const body = { content_type: "audio/mp4", byte_size: 3, sha256: "ab".repeat(32), channel_mode: "mixed", channel_labels: ["Exo upload"] };
    expect(p.creates.map((c) => c.body)).toEqual([body, body]);
    // Every client of the account reads those labels as Upload audio's job, never its own.
    expect(privateCloudJobClient(body as never)).toBe("exo-upload");
    expect(p.creates[0]!.attemptId).toBe(p.creates[1]!.attemptId);
    expect(p.puts[1]).toEqual({ url: `https://ptx.example/uploads/${ID}`, contentType: "audio/mp4", capability: "tcu_abcdefghijklmnop1234" });
    expect(saved[0]!.meeting.metadata).toMatchObject({
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      inference_provider: "tinfoil",
      diarized: false,
      speaker_labels: "none",
      audio: { stored: true },
    });
    // One mixed channel: the label is not a speaker.
    expect(saved[0]!.sentences[0]!.speaker_name).toBeNull();
    expect(events).toEqual(["save", `ptx delete ${ID}`]);
    expect(pending.value).toBeNull();
  });

  test("diarization is requested only when asked, still with Upload audio's labels", async () => {
    const p = privateCloud([]);
    const { deps: d } = deps({ audio: audioFake().audio, privateCloud: p.privateCloud, putFile: async () => {} });
    const runner = createUploadRunner();
    runner.start(d, { file: file("a.wav", "audio/wav"), engine: "private-cloud", diarize: true });
    await settled(runner);
    expect(p.creates[0]!.body).toMatchObject({ content_type: "audio/wav", channel_mode: "mixed", channel_labels: ["Exo upload"], diarize: true });
  });
});

describe("upload runner: reload", () => {
  const stored: PendingUpload = {
    engine: "private-cloud",
    meetingId: "m-9",
    attemptId: "a-9",
    jobId: ID,
    diarize: false,
    file: { name: "interview.mp3", type: "audio/mpeg", size: 10, lastModified: Date.UTC(2026, 8, 30) },
    owner: DID,
    saved: false,
  };

  test("this account's job resumes: it is polled, saved (audio only if its upload had completed) and deleted", async () => {
    const events: string[] = [];
    const pending = memoryPending(stored);
    const a = audioFake({ manifest: null });
    const api = {
      get: async () => ({ id: ID, status: "completed" }),
      result: async () => ({ status: "completed", transcript: { segments: [{ channel: 0, start: 0, end: 1, text: "Welcome." }], text: "Welcome." } }),
      remove: async (id: string) => void events.push(`ptx delete ${id}`),
    } as unknown as PrivateCloudApi;
    const { deps: d, saved } = deps({ events, pending, audio: a.audio, privateCloud: { api, origin: "https://ptx.example", create: async () => Promise.reject(new Error("no create")) } });
    const runner = createUploadRunner();
    runner.resume(d);
    expect((await settled(runner)).stage).toBe("saved");
    expect(saved[0]!.meeting).toMatchObject({ sourceId: "m-9", title: "interview" });
    expect(saved[0]!.meeting.metadata).toMatchObject({ audio: { stored: false, reason: "failed" } });
    // The reload cut the audio short: its parts are removed, not left without a manifest.
    expect(a.calls).toEqual([
      "manifest xyz.tinycloud.tinychat/connectors/exo-upload/audio/m-9",
      "remove xyz.tinycloud.tinychat/connectors/exo-upload/audio/m-9",
    ]);
    expect(events).toEqual(["save", `ptx delete ${ID}`]);
    expect(pending.value).toBeNull();
  });

  test("another account's job is left alone; one that never reached the engine asks for the file again", async () => {
    const runner = createUploadRunner();
    const other = deps({ pending: memoryPending({ ...stored, owner: "did:pkh:eip155:1:0xother" }) });
    runner.resume(other.deps);
    expect(runner.snapshot()).toBeNull();

    const notSent = deps({ pending: memoryPending({ ...stored, jobId: null }), audio: audioFake().audio });
    notSent.deps.privateCloud = { api: {} as PrivateCloudApi, origin: "https://ptx.example", create: async () => Promise.reject(new Error("no create")) };
    runner.resume(notSent.deps);
    const failed = await settled(runner);
    expect(failed.error).toMatchObject({ retry: false });
    expect(failed.error!.message).toContain("Choose the file again");
  });
});

describe("upload runner: silence", () => {
  test("no speech saves nothing and releases the remote job and the stored audio", async () => {
    const events: string[] = [];
    const a = audioFake();
    const pending = memoryPending();
    const client = {
      upload: async () => "u",
      createTranscript: async () => ({ id: "t1", status: "queued" }),
      getTranscript: async () => ({ id: "t1", status: "completed", utterances: [], text: "" }),
      getSentences: async () => [],
      deleteTranscript: async (id: string) => void events.push(`aai delete ${id}`),
    } as unknown as AssemblyAiClient;
    const { deps: d, saved } = deps({ events, pending, audio: a.audio, assemblyAiClient: async () => client });
    const runner = createUploadRunner();
    runner.start(d, { file: file("quiet.wav", "audio/wav"), engine: "assemblyai", diarize: false });
    const failed = await settled(runner);
    expect(failed.error).toMatchObject({ message: NO_SPEECH_MESSAGE, retry: false });
    expect(saved).toHaveLength(0);
    expect(events).toEqual(["aai delete t1"]);
    expect(a.calls.at(-1)).toMatch(/^remove .*\/exo-upload\/audio\//);
    expect(pending.value).toBeNull();
  });
});

describe("upload runner: one owner at a time", () => {
  const stored: PendingUpload = {
    engine: "assemblyai",
    meetingId: "m-7",
    attemptId: "a-7",
    jobId: "t7",
    diarize: true,
    file: { name: "board.mp3", type: "audio/mpeg", size: 10, lastModified: 0 },
    owner: DID,
    saved: false,
  };

  test("while another tab holds the upload, this tab neither resumes it nor starts a new one over it", async () => {
    const pending = memoryPending(stored);
    const a = audioFake();
    const { deps: d } = deps({ pending, audio: a.audio, lock: async () => null });
    const runner = createUploadRunner();
    runner.resume(d);
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.snapshot()).toMatchObject({ stage: "elsewhere", fileName: "board.mp3" });

    runner.start(d, { file: file("other.mp3", "audio/mpeg"), engine: "assemblyai", diarize: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.snapshot()?.stage).toBe("elsewhere");
    expect(pending.value).toEqual(stored);
    expect(a.calls).toEqual([]);
  });

  test("Discard after a final failure stops the audio store and removes parts only once it has settled", async () => {
    const order: string[] = [];
    let aborted: AbortSignal | undefined;
    const a = audioFake({
      put: (signal) =>
        new Promise((_, reject) => {
          aborted = signal;
          signal?.addEventListener("abort", () => {
            order.push("put settled");
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    });
    const remove = a.audio.remove as (kv: unknown, base: string) => Promise<void>;
    a.audio.remove = (async (kv: unknown, base: string) => {
      order.push("remove");
      return remove(kv, base);
    }) as never;
    const client = { upload: async () => Promise.reject(new AssemblyAiError("invalid-key", "rejected")) } as unknown as AssemblyAiClient;
    const { deps: d } = deps({ audio: a.audio, assemblyAiClient: async () => client });
    const runner = createUploadRunner();
    runner.start(d, { file: file("big.wav", "audio/wav"), engine: "assemblyai", diarize: false });
    const failed = await settled(runner);
    expect(failed.error).toMatchObject({ retry: false });
    expect(aborted?.aborted).toBe(true);
    await runner.dismiss(d);
    expect(order).toEqual(["put settled", "remove"]);
  });

  test("another account signed in on the tab can neither retry nor discard the first account's upload", async () => {
    const events: string[] = [];
    const client = {
      upload: async () => Promise.reject(new AssemblyAiError("network", "down")),
      deleteTranscript: async (id: string) => void events.push(`aai delete ${id}`),
    } as unknown as AssemblyAiClient;
    const pending = memoryPending();
    const a = audioFake();
    const first = deps({ events, pending, audio: a.audio, assemblyAiClient: async () => client });
    const runner = createUploadRunner();
    runner.start(first.deps, { file: file("private.mp3", "audio/mpeg"), engine: "assemblyai", diarize: false });
    expect((await settled(runner)).error).toMatchObject({ retry: true });

    const other = deps({ events, pending, audio: a.audio, assemblyAiClient: async () => client, did: "did:pkh:eip155:1:0xother" });
    runner.retry(other.deps);
    expect(runner.snapshot()?.stage).toBe("failed");
    await runner.dismiss(other.deps);
    expect(runner.snapshot()).toBeNull();
    expect(pending.value?.owner).toBe(DID);
    expect(a.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    expect(events).toEqual([]);
  });

  test("a resumed saved upload reports the audio outcome it was saved with", async () => {
    const pending = memoryPending({ ...stored, saved: true, audio: { stored: true } });
    const client = { deleteTranscript: async () => {} } as unknown as AssemblyAiClient;
    const { deps: d } = deps({ pending, audio: audioFake().audio, assemblyAiClient: async () => client });
    const runner = createUploadRunner();
    runner.resume(d);
    expect(await settled(runner)).toMatchObject({ stage: "saved", audio: { stage: "stored" } });
  });
});

describe("upload runner: sign-out and remote cleanup", () => {
  test("after sign-out, the first account's late answers never reach the next account's upload or pending record", async () => {
    const events: string[] = [];
    // A's AssemblyAI upload hangs until released; its abort signal is recorded.
    let releaseA: (() => void) | null = null;
    let aSignal: AbortSignal | undefined;
    const clientA = {
      upload: (_f: Blob, o?: { signal?: AbortSignal }) => {
        aSignal = o?.signal;
        return new Promise<string>((resolve) => {
          releaseA = () => resolve("https://cdn.assemblyai.com/upload/a");
        });
      },
      createTranscript: async () => {
        events.push("A create");
        return { id: "tA", status: "queued" };
      },
      getTranscript: async () => ({ id: "tA", status: "completed", utterances: [{ speaker: "A", text: "A speaking.", start: 0, end: 900 }] }),
      getSentences: async () => [],
      deleteTranscript: async (id: string) => void events.push(`delete ${id}`),
    } as unknown as AssemblyAiClient;
    const pending = memoryPending();
    const a = deps({ events, pending, audio: audioFake().audio, assemblyAiClient: async () => clientA });
    const runner = createUploadRunner();
    runner.start(a.deps, { file: file("a-private.mp3", "audio/mpeg"), engine: "assemblyai", diarize: true });
    for (let i = 0; i < 20 && releaseA === null; i++) await new Promise((r) => setTimeout(r, 0));

    runner.reset(); // A signs out
    expect(aSignal?.aborted).toBe(true);

    const clientB = {
      upload: async () => "https://cdn.assemblyai.com/upload/b",
      createTranscript: async () => ({ id: "tB", status: "queued" }),
      getTranscript: async () => ({ id: "tB", status: "completed", utterances: [{ speaker: "A", text: "B speaking.", start: 0, end: 900 }] }),
      getSentences: async () => [],
      deleteTranscript: async (id: string) => void events.push(`delete ${id}`),
    } as unknown as AssemblyAiClient;
    const other = "did:pkh:eip155:1:0x00000000000000000000000000000000000000b2";
    const b = deps({ events, pending, audio: audioFake().audio, assemblyAiClient: async () => clientB, did: other });
    runner.start(b.deps, { file: file("b-notes.mp3", "audio/mpeg"), engine: "assemblyai", diarize: true });
    releaseA!(); // A's upload answers late
    const done = await settled(runner);

    expect(done).toMatchObject({ stage: "saved", fileName: "b-notes.mp3", cleanupPending: false });
    expect(b.saved.map((p) => [p.meeting.title, p.sentences[0]!.text])).toEqual([["b-notes", "B speaking."]]);
    expect(a.saved).toEqual([]);
    expect(events).not.toContain("A create");
    expect(events).toContain("delete tB");
    expect(pending.value).toBeNull();
  });

  test("a Private create that fails never claims the audio is being stored, and stores nothing", async () => {
    const a = audioFake();
    const { deps: d } = deps({
      audio: a.audio,
      privateCloud: { api: {} as PrivateCloudApi, origin: "https://ptx.example", create: async () => Promise.reject(new PrivateCloudError("service_busy", "busy")) },
    });
    const runner = createUploadRunner();
    runner.start(d, { file: file("a.mp3", "audio/mpeg"), engine: "private-cloud", diarize: false });
    const failed = await settled(runner);
    expect(failed.audio.stage).toBe("not-stored");
    expect(a.calls).toEqual([]);
  });

  test("a rejected key ends deleting at once and says so beside Retry deleting", async () => {
    let deletes = 0;
    const client = {
      upload: async () => "u",
      createTranscript: async () => ({ id: "t1", status: "queued" }),
      getTranscript: async () => ({ id: "t1", status: "completed", utterances: [{ speaker: "A", text: "Hello.", start: 0, end: 900 }] }),
      getSentences: async () => [],
      deleteTranscript: async () => {
        deletes++;
        throw new AssemblyAiError("invalid-key", "AssemblyAI rejected the key.");
      },
    } as unknown as AssemblyAiClient;
    const { deps: d, saved } = deps({ audio: audioFake().audio, assemblyAiClient: async () => client });
    const runner = createUploadRunner();
    runner.start(d, { file: file("a.mp3", "audio/mpeg"), engine: "assemblyai", diarize: true });
    const done = await settled(runner);
    expect(saved).toHaveLength(1);
    expect(deletes).toBe(1);
    expect(done).toMatchObject({ stage: "saved", cleanupPending: true, error: { message: "AssemblyAI rejected the key." } });
  });
});

describe("upload runner: the stored upload belongs to one tab and one account", () => {
  const assemblyAiThatFinishes = (events: string[], id: string) =>
    ({
      upload: async () => "u",
      createTranscript: async () => ({ id, status: "queued" }),
      getTranscript: async () => ({ id, status: "completed", utterances: [{ speaker: "A", text: "Hello.", start: 0, end: 900 }] }),
      getSentences: async () => [],
      deleteTranscript: async (x: string) => void events.push(`delete ${x}`),
    }) as unknown as AssemblyAiClient;

  test("a tab that finished its upload doesn't clear the upload another tab now runs", async () => {
    const pending = memoryPending();
    const events: string[] = [];
    const tabA = createUploadRunner();
    const a = deps({ events, pending, audio: audioFake().audio, assemblyAiClient: async () => assemblyAiThatFinishes(events, "tA") });
    tabA.start(a.deps, { file: file("first.mp3", "audio/mpeg"), engine: "assemblyai", diarize: true });
    expect((await settled(tabA)).stage).toBe("saved");

    // Tab B's upload stays in the queue at AssemblyAI.
    const tabB = createUploadRunner();
    const queued = {
      ...assemblyAiThatFinishes(events, "tB"),
      getTranscript: () => new Promise(() => {}),
    } as unknown as AssemblyAiClient;
    const b = deps({ events, pending, audio: audioFake().audio, assemblyAiClient: async () => queued });
    tabB.start(b.deps, { file: file("second.mp3", "audio/mpeg"), engine: "assemblyai", diarize: true });
    for (let i = 0; i < 20 && pending.value?.jobId !== "tB"; i++) await new Promise((r) => setTimeout(r, 0));
    expect(pending.value?.jobId).toBe("tB");

    await tabA.dismiss(a.deps); // "Upload another file" in tab A
    expect(tabA.snapshot()).toBeNull();
    expect(pending.value?.jobId).toBe("tB");
    expect(events).not.toContain("delete tB");
  });

  test("another account's upload in this browser neither overwrites nor sees this account's stored job", async () => {
    const storage = new Map<string, string>();
    const original = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    } as unknown as Storage;
    try {
      const stored: PendingUpload = {
        engine: "assemblyai",
        meetingId: "m-a",
        attemptId: "a-a",
        jobId: "tA",
        diarize: true,
        file: { name: "a.mp3", type: "audio/mpeg", size: 3, lastModified: 0 },
        owner: DID,
        saved: true,
        audio: { stored: true },
        assemblyAiMode: "own",
      };
      localStoragePendingUploadStore(DID).write(stored);

      const other = "did:pkh:eip155:1:0x00000000000000000000000000000000000000b2";
      expect(localStoragePendingUploadStore(other).read()).toBeNull();
      const events: string[] = [];
      const runner = createUploadRunner();
      const b = deps({ events, pending: undefined, did: other, audio: audioFake().audio, assemblyAiClient: async () => assemblyAiThatFinishes(events, "tB") });
      runner.start(b.deps, { file: file("b.mp3", "audio/mpeg"), engine: "assemblyai", diarize: true });
      expect((await settled(runner)).stage).toBe("saved");

      expect(localStoragePendingUploadStore(DID).read()).toEqual(stored);
      expect(events).toEqual(["save", "delete tB"]);
    } finally {
      globalThis.localStorage = original;
    }
  });
});

describe("upload runner: an AssemblyAI job keeps its account", () => {
  const finishing = (events: string[], label: string) =>
    ({
      upload: async () => "u",
      createTranscript: async () => ({ id: `t-${label}`, status: "queued" }),
      getTranscript: async () => ({ id: `t-${label}`, status: "completed", utterances: [{ speaker: "A", text: "Hello.", start: 0, end: 900 }] }),
      getSentences: async () => [],
      deleteTranscript: async (id: string) => void events.push(`${label} delete ${id}`),
    }) as unknown as AssemblyAiClient;

  test("a hosted upload is created, polled, saved and deleted only through TinyCloud's account", async () => {
    const events: string[] = [];
    const asked: string[] = [];
    const pending = memoryPending();
    const { deps: d, saved } = deps({
      events,
      pending,
      audio: audioFake().audio,
      assemblyAiClient: async (mode) => {
        asked.push(mode);
        return finishing(events, mode);
      },
    });
    const runner = createUploadRunner();
    runner.start(d, { file: file("a.mp3", "audio/mpeg"), engine: "assemblyai", diarize: true, assemblyAiMode: "hosted" });
    expect((await settled(runner)).stage).toBe("saved");
    expect(asked).toEqual(["hosted"]);
    expect(events).toEqual(["save", "hosted delete t-hosted"]);
    expect(saved[0]!.meeting.metadata).toMatchObject({ assemblyai_account: "tinycloud" });
  });

  test("a resumed job and Discard use the account it was started with, whatever Settings now says", async () => {
    for (const mode of ["hosted", "own"] as const) {
      const events: string[] = [];
      const asked: string[] = [];
      const stored: PendingUpload = {
        engine: "assemblyai",
        assemblyAiMode: mode,
        meetingId: "m-1",
        attemptId: "a-1",
        jobId: "t-1",
        diarize: true,
        file: { name: "a.mp3", type: "audio/mpeg", size: 3, lastModified: 0 },
        owner: DID,
        saved: true,
        audio: { stored: true },
      };
      const clientFor = async (m: "hosted" | "own") => {
        asked.push(m);
        return {
          deleteTranscript: async () => {
            events.push(`${m} delete`);
            throw new AssemblyAiError("network", "down");
          },
        } as unknown as AssemblyAiClient;
      };
      const { deps: d } = deps({ events, pending: memoryPending(stored), audio: audioFake().audio, assemblyAiClient: clientFor });
      const runner = createUploadRunner();
      runner.resume(d);
      expect(await settled(runner)).toMatchObject({ stage: "saved", cleanupPending: true });
      await runner.dismiss(d);
      expect(asked.every((m) => m === mode)).toBe(true);
      expect(events.every((e) => e === `${mode} delete`)).toBe(true);
    }
  });

  test("a stored job from before key modes existed stays on the user's own key", () => {
    const storage = new Map<string, string>();
    const original = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    } as unknown as Storage;
    try {
      const legacy = { engine: "assemblyai", meetingId: "m", attemptId: "a", jobId: "t", diarize: true, file: { name: "a.mp3", type: "", size: 1, lastModified: 0 }, owner: DID, saved: false };
      storage.set(`exo.transcriber.uploadPending:${DID}`, JSON.stringify(legacy));
      expect(localStoragePendingUploadStore(DID).read()?.assemblyAiMode).toBe("own");
      const pending = localStoragePendingUploadStore(DID);
      pending.write({ ...pending.read()!, discarding: true, uploadSubmitting: true });
      expect(localStoragePendingUploadStore(DID).read()).toMatchObject({ discarding: true, uploadSubmitting: true });
    } finally {
      globalThis.localStorage = original;
    }
  });
});

describe("upload runner: a reload while the file is sent on to AssemblyAI", () => {
  test("the stored upload is re-joined, not re-uploaded, and its transcript is saved and deleted", async () => {
    const events: string[] = [];
    const stored: PendingUpload = {
      engine: "assemblyai",
      assemblyAiMode: "hosted",
      meetingId: "m-r",
      attemptId: "a-r",
      jobId: null,
      uploadRef: "aau_1",
      diarize: true,
      file: { name: "long.wav", type: "audio/wav", size: 3, lastModified: 0 },
      owner: DID,
      saved: false,
    };
    const client = {
      upload: async () => {
        events.push("upload");
        return "aau_2";
      },
      createTranscript: async (ref: string) => {
        events.push(`create ${ref}`);
        return { id: "h1", status: "queued" };
      },
      getTranscript: async () => ({ id: "h1", status: "completed", utterances: [{ speaker: "A", text: "Back again.", start: 0, end: 900 }] }),
      getSentences: async () => [],
      deleteTranscript: async (id: string) => void events.push(`delete ${id}`),
    } as unknown as AssemblyAiClient;
    const pending = memoryPending(stored);
    const { deps: d, saved } = deps({ events, pending, audio: audioFake().audio, assemblyAiClient: async () => client });
    const runner = createUploadRunner();
    runner.resume(d);
    expect((await settled(runner)).stage).toBe("saved");
    expect(events).toEqual(["create aau_1", "save", "delete h1"]);
    expect(saved[0]!.sentences[0]!.text).toBe("Back again.");
    expect(pending.value).toBeNull();
  });

  test("a submission that failed is forgotten, so Retry sends the file again rather than re-joining it", async () => {
    const pending = memoryPending();
    let creates = 0;
    const client = {
      upload: async () => "aau_1",
      createTranscript: async () => {
        creates++;
        if (creates === 1) throw new AssemblyAiError("failed", "Exo's server couldn't send the file to AssemblyAI. Retry uploads it again.", true);
        return { id: "h2", status: "queued" };
      },
      getTranscript: async () => ({ id: "h2", status: "completed", utterances: [{ speaker: "A", text: "Hi.", start: 0, end: 900 }] }),
      getSentences: async () => [],
      deleteTranscript: async () => {},
    } as unknown as AssemblyAiClient;
    const { deps: d } = deps({ pending, audio: audioFake().audio, assemblyAiClient: async () => client });
    const runner = createUploadRunner();
    runner.start(d, { file: file("a.wav", "audio/wav"), engine: "assemblyai", diarize: true, assemblyAiMode: "hosted" });
    expect((await settled(runner)).error).toMatchObject({ retry: true });
    expect(pending.value?.uploadRef).toBeUndefined();
    runner.retry(d);
    expect((await settled(runner)).stage).toBe("saved");
  });
});


describe("TC-592 hosted recovery regressions", () => {
  const stored: PendingUpload = {
    engine: "assemblyai", assemblyAiMode: "hosted", meetingId: "m-review", attemptId: "a-review",
    jobId: null, uploadRef: "aau_review", diarize: true,
    file: { name: "review.wav", type: "audio/wav", size: 3, lastModified: 0 }, owner: DID, saved: false,
  };
  const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  for (const status of [429, 502, 503, 401, 404]) {
    test(`poll HTTP ${status} after reload keeps Retry and recovers without another reload`, async () => {
      const pending = memoryPending({ ...stored });
      let fail = true;
      const creates: string[] = [];
      const client = createHostedAssemblyAiClient({
        backendUrl: "https://backend.test", sessionStore: { getToken: () => "session", isExpired: () => false }, sleep: async () => {},
        fetchImpl: (async (url, init) => {
          const path = String(url);
          if (init?.method === "DELETE") return new Response(null, { status: 204 });
          if (init?.method === "POST") {
            creates.push(JSON.parse(String(init.body)).upload_id);
            return response(202, { status: "submitting" });
          }
          if (path.endsWith("/hosted/uploads/aau_review")) return fail
            ? response(status, { error: status === 503 ? "assemblyai_hosted_unavailable" : "unavailable" })
            : response(200, { status: "submitted", id: "handle" });
          return response(200, { id: "handle", status: "completed", utterances: [{ speaker: "A", text: "Recovered.", start: 0, end: 900 }] });
        }) as typeof fetch,
      });
      const { deps: d, saved } = deps({ pending, audio: audioFake().audio, assemblyAiClient: async () => client });
      const runner = createUploadRunner();
      runner.resume(d);
      expect((await settled(runner)).stage).toBe("failed");
      expect(pending.value?.uploadRef).toBe("aau_review");
      expect(runner.snapshot()?.error?.retry).toBe(true);
      fail = false;
      runner.retry(d);
      expect((await settled(runner)).stage).toBe("saved");
      expect(creates).toEqual(["aau_review", "aau_review"]);
      expect(saved).toHaveLength(1);
    });
  }

  test("Discard keeps a missing submitting upload across reload until its transcript can be deleted", async () => {
    const pending = memoryPending({ ...stored });
    let phase: "transcribe" | "missing" | "settled" = "transcribe";
    let reads = 0;
    const deletes: string[] = [];
    const client = createHostedAssemblyAiClient({
      backendUrl: "https://backend.test", sessionStore: { getToken: () => "session", isExpired: () => false }, sleep: async () => {},
      fetchImpl: (async (url, init) => {
        if (init?.method === "POST") return response(202, { status: "submitting" });
        if (init?.method === "DELETE") {
          deletes.push(String(url));
          return new Response(null, { status: 204 });
        }
        reads++;
        if (phase === "transcribe") return response(502, { error: "assemblyai_unavailable" });
        return phase === "missing" ? response(404, { error: "assemblyai_upload_not_found" }) : response(200, { status: "submitted", id: "handle" });
      }) as typeof fetch,
    });
    const { deps: d, saved } = deps({ pending, audio: audioFake().audio, assemblyAiClient: async () => client });
    const runner = createUploadRunner();
    runner.resume(d);
    await settled(runner);
    phase = "missing";
    await runner.dismiss(d);
    expect(pending.value).toMatchObject({ discarding: true, uploadRef: "aau_review", uploadSubmitting: true });
    expect(runner.snapshot()).toMatchObject({ cleanupPending: true, error: { retry: true } });
    expect(reads).toBeLessThanOrEqual(10);
    expect(deletes).toEqual([]);
    runner.reset();
    const resumed = createUploadRunner();
    resumed.resume(d);
    expect((await settled(resumed)).cleanupPending).toBe(true);
    expect(pending.value?.uploadRef).toBe("aau_review");
    phase = "settled";
    const cleared = new Promise<void>((resolve) => {
      const unsubscribe = resumed.subscribe(() => { if (pending.value === null) { unsubscribe(); resolve(); } });
    });
    resumed.retry(d);
    await cleared;
    expect(deletes).toEqual(["https://backend.test/api/transcriber/assemblyai/hosted/transcripts/handle"]);
    expect(saved).toHaveLength(0);
  });

  for (const initial of ["receiving", "submitting", "submitted"] as const) {
    test(`Discard resolves ${initial} uploads and retains cleanup until deletion succeeds`, async () => {
      const pending = memoryPending({ ...stored });
      let phase: "transcribe" | "discard" | "retry" = "transcribe";
      let reads = 0;
      const events: string[] = [];
      const client = createHostedAssemblyAiClient({
        backendUrl: "https://backend.test", sessionStore: { getToken: () => "session", isExpired: () => false }, sleep: async () => {},
        fetchImpl: (async (url, init) => {
          const path = String(url).split("/api/transcriber/assemblyai")[1]!;
          if (phase === "transcribe") {
            if (init?.method === "POST") return response(202, { status: "submitting" });
            throw new TypeError("offline");
          }
          events.push(`${init?.method ?? "GET"} ${path}`);
          if (init?.method === "DELETE") {
            if (path.includes("/uploads/")) return response(409, { error: "assemblyai_upload_in_progress" });
            if (phase === "discard") throw new TypeError("offline deleting");
            return new Response(null, { status: 204 });
          }
          return response(200, ++reads === 1 ? { status: initial, ...(initial === "submitted" ? { id: "handle" } : {}) } : { status: "submitted", id: "handle" });
        }) as typeof fetch,
      });
      const audio = audioFake();
      const { deps: d, saved } = deps({ pending, audio: audio.audio, assemblyAiClient: async () => client });
      const runner = createUploadRunner();
      runner.resume(d);
      await settled(runner);
      phase = "discard";
      await runner.dismiss(d);
      expect(pending.value).not.toBeNull();
      expect(runner.snapshot()?.cleanupPending).toBe(true);
      expect(pending.value).toMatchObject({ discarding: true, jobId: "handle" });
      expect(pending.value?.uploadRef).toBeUndefined();
      expect(events).toContain("DELETE /hosted/transcripts/handle");
      if (initial !== "submitted") expect(events).toContain("DELETE /hosted/uploads/aau_review");
      runner.reset();
      phase = "retry";
      const resumed = createUploadRunner();
      const cleared = new Promise<void>((resolve) => {
        const unsubscribe = resumed.subscribe(() => { if (pending.value === null) { unsubscribe(); resolve(); } });
      });
      resumed.resume(d);
      await cleared;
      expect(saved).toHaveLength(0);
      expect(events.at(-1)).toBe("DELETE /hosted/transcripts/handle");
      expect(audio.calls.some((c) => c.startsWith("remove "))).toBe(true);
      expect(pending.value).toBeNull();
    });
  }
});
