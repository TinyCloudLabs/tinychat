// AssemblyAI (contract C8): requests carry the user's raw key and the
// documented options, transcripts become "Speaker A" turns in seconds, polling
// rides out network trouble but not a failed transcript, and deleting a
// transcript that is already gone counts as deleted.

import { describe, expect, test } from "bun:test";

import {
  AssemblyAiError,
  assemblyAiSentences,
  createAssemblyAiClient,
  pollAssemblyAiTranscript,
  type AssemblyAiTranscript,
} from "./assemblyai";

function client(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const c = createAssemblyAiClient("aai-key", {
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as never,
    backend: { url: "https://api.example", sessionStore: { getToken: () => "tok", isExpired: () => false } },
  });
  return { c, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("AssemblyAI client", () => {
  test("a transcript is requested with the raw key, speaker labels as asked, language detection and the current models", async () => {
    const { c, calls } = client(() => json(200, { id: "t1", status: "queued" }));
    await c.createTranscript("https://cdn.assemblyai.com/upload/x", { speakerLabels: false });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("aai-key");
    expect(calls[0]!.url).toBe("https://api.assemblyai.com/v2/transcript");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      audio_url: "https://cdn.assemblyai.com/upload/x",
      speech_models: ["universal-3-5-pro", "universal-2"],
      language_detection: true,
      speaker_labels: false,
    });
  });

  test("a rejected key is invalid-key", async () => {
    const invalid = (await client(() => json(401, { error: "Invalid API key" })).c.validateKey().catch((e) => e)) as AssemblyAiError;
    expect(invalid.kind).toBe("invalid-key");
  });

  test("deleting goes through TinyChat's server with the session and the key in a header; gone already counts as deleted", async () => {
    const { c, calls } = client(() => new Response(null, { status: 204 }));
    await c.deleteTranscript("t1");
    expect(`${calls[0]!.init.method} ${calls[0]!.url}`).toBe("DELETE https://api.example/api/transcriber/assemblyai/transcripts/t1");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).toEqual({ Authorization: "Bearer tok", "X-Requested-With": "XMLHttpRequest", "X-AssemblyAI-Key": "aai-key" });

    await client(() => json(404, { error: { code: "assemblyai_transcript_not_found" } })).c.deleteTranscript("t1");
    const rejected = (await client(() => json(422, { error: { code: "assemblyai_key_rejected" } })).c.deleteTranscript("t1").catch((e) => e)) as AssemblyAiError;
    expect([rejected.kind, rejected.message]).toEqual(["invalid-key", "AssemblyAI rejected the key."]);
    for (const [status, kind] of [[429, "rate-limited"], [502, "network"]] as const) {
      const err = (await client(() => json(status, { error: { code: "x" } })).c.deleteTranscript("t1").catch((e) => e)) as AssemblyAiError;
      expect(err.kind).toBe(kind);
    }
  });
});

describe("assemblyAiSentences", () => {
  test("diarized utterances become Speaker A/B turns in seconds", () => {
    const t: AssemblyAiTranscript = {
      id: "t1",
      status: "completed",
      utterances: [
        { speaker: "A", text: " Hello there. ", start: 250, end: 1500 },
        { speaker: "B", text: "Hi.", start: 1600, end: 2100 },
        { speaker: "A", text: "  ", start: 2200, end: 2300 },
      ],
    };
    expect(assemblyAiSentences(t, null)).toEqual([
      { index: 0, speaker_name: "Speaker A", text: "Hello there.", start_time: 0.25, end_time: 1.5 },
      { index: 1, speaker_name: "Speaker B", text: "Hi.", start_time: 1.6, end_time: 2.1 },
    ]);
  });

  test("without speaker labels, sentences carry no speaker; bare text is kept as one sentence", () => {
    const t: AssemblyAiTranscript = { id: "t1", status: "completed", utterances: null, text: "One. Two.", audio_duration: 4 };
    expect(assemblyAiSentences(t, [{ text: "One.", start: 0, end: 900 }])).toEqual([
      { index: 0, speaker_name: null, text: "One.", start_time: 0, end_time: 0.9 },
    ]);
    expect(assemblyAiSentences(t, [])).toEqual([{ index: 0, speaker_name: null, text: "One. Two.", start_time: 0, end_time: 4 }]);
  });
});

describe("pollAssemblyAiTranscript", () => {
  const clock = () => {
    const c = { t: 0, sleeps: [] as number[] };
    return {
      c,
      clock: { now: () => c.t, sleep: async (ms: number) => void (c.sleeps.push(ms), (c.t += ms)), random: () => 0.5 },
    };
  };

  test("rides out network failures and backs off until completed", async () => {
    const answers: (AssemblyAiTranscript | Error)[] = [
      { id: "t1", status: "queued" },
      new AssemblyAiError("network", "down"),
      { id: "t1", status: "processing" },
      { id: "t1", status: "completed", text: "done" },
    ];
    const { c, clock: k } = clock();
    const done = await pollAssemblyAiTranscript(
      {
        getTranscript: async () => {
          const next = answers.shift()!;
          if (next instanceof Error) throw next;
          return next;
        },
      },
      "t1",
      { clock: k },
    );
    expect(done.status).toBe("completed");
    expect(c.sleeps).toEqual([3_000, 4_500, 6_750]);
  });

  test("a failed transcript ends polling with AssemblyAI's reason", async () => {
    const { clock: k } = clock();
    const err = (await pollAssemblyAiTranscript(
      { getTranscript: async () => ({ id: "t1", status: "error", error: "File does not appear to contain audio." }) },
      "t1",
      { clock: k },
    ).catch((e) => e)) as AssemblyAiError;
    expect(err.kind).toBe("failed");
    expect(err.message).toContain("does not appear to contain audio");
  });
});
