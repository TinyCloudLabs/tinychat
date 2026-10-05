// AssemblyAI (contract C8): requests carry the user's raw key and the
// documented options, transcripts become "Speaker A" turns in seconds, polling
// rides out network trouble but not a failed transcript, and deleting a
// transcript that is already gone counts as deleted.

import { describe, expect, test } from "bun:test";

import {
  AssemblyAiError,
  assemblyAiSentences,
  createAssemblyAiClient,
  createHostedAssemblyAiClient,
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

describe("TinyCloud's AssemblyAI account (hosted client)", () => {
  const MiB = 1024 * 1024;
  function hosted(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const c = createHostedAssemblyAiClient({
      backendUrl: "https://api.example",
      sessionStore: { getToken: () => "tok", isExpired: () => false },
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond(url, init);
      }) as never,
      sleep: async () => {},
    });
    return { c, calls };
  }

  test("the audio reaches the server in parts of at most 1 MiB, in order, with progress after each", async () => {
    const file = new Blob([new Uint8Array(2 * MiB + 10)], { type: "audio/x-m4a" });
    const { c, calls } = hosted((url) =>
      url.endsWith("/hosted/uploads") ? json(201, { upload_id: "up1", part_size: MiB, expires_at: "x" }) : new Response(null, { status: 204 }),
    );
    const progress: number[] = [];
    expect(await c.upload(file, { contentType: "audio/mp4", onProgress: (sent) => progress.push(sent) })).toBe("up1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ byte_size: 2 * MiB + 10, content_type: "audio/mp4" });
    const parts = calls.slice(1);
    expect(parts.map((p) => `${p.init.method} ${p.url}`)).toEqual([0, 1, 2].map((i) => `PUT https://api.example/api/transcriber/assemblyai/hosted/uploads/up1/parts/${i}`));
    expect(parts.map((p) => (p.init.body as Blob).size)).toEqual([MiB, MiB, 10]);
    expect((parts[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    expect(progress).toEqual([0, MiB, 2 * MiB, 2 * MiB + 10]);
  });

  test("an abort stops the upload: no part is sent after it, and the upload is released at once", async () => {
    const file = new Blob([new Uint8Array(3 * MiB)]);
    const controller = new AbortController();
    let puts = 0;
    const { c, calls } = hosted((url, init) => {
      if (url.endsWith("/hosted/uploads")) return json(201, { upload_id: "up1", part_size: MiB });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      puts++;
      if (puts === 1) controller.abort();
      if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return new Response(null, { status: 204 });
    });
    const err = (await c.upload(file, { signal: controller.signal }).catch((e) => e)) as AssemblyAiError;
    expect(err).toBeInstanceOf(AssemblyAiError);
    expect(puts).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((x) => `${x.init.method} ${x.url}`)).toContain("DELETE https://api.example/api/transcriber/assemblyai/hosted/uploads/up1");
  });

  test("the account's limits and outages read as retryable or not, never as a key problem", async () => {
    const quota = (await hosted(() => json(429, { error: "assemblyai_quota_exceeded" })).c.upload(new Blob([new Uint8Array(1)])).catch((e) => e)) as AssemblyAiError;
    expect(quota.kind).toBe("rate-limited");
    expect(quota.message).toContain("today's limit");
    const gone = (await hosted(() => json(404, { error: "not_found" })).c.getTranscript("h").catch((e) => e)) as AssemblyAiError;
    expect(gone.kind).toBe("not-found");
    await hosted(() => json(404, { error: "not_found" })).c.deleteTranscript("h");
  });
});

describe("TinyCloud's AssemblyAI account: sending the file on", () => {
  function hosted(respond: (url: string, init: RequestInit) => Response) {
    const calls: string[] = [];
    const c = createHostedAssemblyAiClient({
      backendUrl: "https://api.example",
      sessionStore: { getToken: () => "tok", isExpired: () => false },
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url.replace("https://api.example/api/transcriber/assemblyai", "")}`);
        return respond(url, init);
      }) as never,
      sleep: async () => {},
    });
    return { c, calls };
  }

  test("the transcript's handle arrives once the server has sent the file on; until then its state is polled", async () => {
    const states = [{ status: "submitting" }, { status: "submitted", id: "aah1.x.y" }];
    const { c, calls } = hosted((url) => (url.endsWith("/hosted/transcripts") ? json(202, { upload_id: "aau_1", status: "submitting" }) : json(200, states.shift())));
    expect(await c.createTranscript("aau_1", { speakerLabels: true })).toEqual({ id: "aah1.x.y", status: "queued" });
    expect(calls).toEqual(["POST /hosted/transcripts", "GET /hosted/uploads/aau_1", "GET /hosted/uploads/aau_1"]);
  });

  test("a failed submission is an error Retry answers by sending the file again; AssemblyAI's limit reads as busy", async () => {
    const failed = (await hosted(() => json(202, { upload_id: "aau_1", status: "failed", error: { code: "assemblyai_unavailable" } }))
      .c.createTranscript("aau_1", { speakerLabels: true })
      .catch((e) => e)) as AssemblyAiError;
    expect(failed.kind).toBe("failed");
    const limited = (await hosted(() => json(202, { upload_id: "aau_1", status: "failed", error: { code: "assemblyai_rate_limited" } }))
      .c.createTranscript("aau_1", { speakerLabels: true })
      .catch((e) => e)) as AssemblyAiError;
    expect(limited.kind).toBe("rate-limited");
  });
});


describe("hosted upload terminal outcomes and cleanup", () => {
  function client(answer: (path: string, method: string) => Response) {
    return createHostedAssemblyAiClient({
      backendUrl: "https://backend.test", sessionStore: { getToken: () => "session", isExpired: () => false }, sleep: async () => {},
      fetchImpl: (async (url, init) => answer(String(url).split("/api/transcriber/assemblyai")[1]!, init?.method ?? "GET")) as typeof fetch,
    });
  }

  for (const terminal of [404, 410, "failed", "limited"] as const) {
    test(`only confirmed upload outcome ${terminal} allows forgetting the reference`, async () => {
      const c = client((_path, method) => method === "POST" ? json(202, { status: "submitting" }) : typeof terminal === "number"
        ? json(terminal, { error: "gone" }) : json(200, { status: "failed", error: { code: terminal === "limited" ? "assemblyai_rate_limited" : "assemblyai_unavailable" } }));
      const error = await c.createTranscript("upload", { speakerLabels: true }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AssemblyAiError);
      expect((error as AssemblyAiError).uploadEnded).toBe(true);
    });
  }

  test("a POST 404 is confirmed by GET before the reference is forgotten", async () => {
    const calls: string[] = [];
    const c = client((path, method) => {
      calls.push(`${method} ${path}`);
      return json(method === "POST" ? 404 : 429, { error: "unavailable" });
    });
    const error = await c.createTranscript("upload", { speakerLabels: true }).catch((e: unknown) => e);
    expect((error as AssemblyAiError).uploadEnded).toBe(false);
    expect(calls).toEqual(["POST /hosted/transcripts", "GET /hosted/uploads/upload"]);
  });

  test("Discard abandons a receiving upload without creating a transcript", async () => {
    const calls: string[] = [];
    const c = client((path, method) => {
      calls.push(`${method} ${path}`);
      return method === "GET" ? json(200, { status: "receiving" }) : new Response(null, { status: 204 });
    });
    await c.deleteUpload!("upload");
    expect(calls).toEqual(["GET /hosted/uploads/upload", "DELETE /hosted/uploads/upload"]);
  });

  test("Discard confirms an unsent missing upload with two bounded rechecks", async () => {
    let reads = 0;
    const c = client(() => { reads++; return json(404, { error: "assemblyai_upload_not_found" }); });
    await c.deleteUpload!("upload");
    expect(reads).toBe(3);
  });

  for (const status of ["receiving", "submitting"] as const) {
    test(`Discard remembers a ${status} upload claimed before a later 404`, async () => {
      let reads = 0;
      let submitting = false;
      const c = client((_path, method) => {
        if (method === "DELETE") return json(409, { error: "assemblyai_upload_in_progress" });
        return ++reads === 1 ? json(200, { status }) : json(404, { error: "assemblyai_upload_not_found" });
      });
      await expect(c.deleteUpload!("upload", { onSubmitting: () => { submitting = true; } })).rejects.toThrow("Retry deleting later");
      expect(submitting).toBe(true);
      expect(reads).toBe(4);
    });
  }

  for (const status of [410, "failed"] as const) {
    test(`Discard accepts terminal upload ${status} without another mutation`, async () => {
      const calls: string[] = [];
      const c = client((path, method) => {
        calls.push(`${method} ${path}`);
        return typeof status === "number" ? json(status, { error: "gone" }) : json(200, { status });
      });
      await c.deleteUpload!("upload");
      expect(calls).toEqual(["GET /hosted/uploads/upload"]);
    });
  }
});

test("Discard rechecks a transient upload 404 and deletes the submitted transcript", async () => {
  let reads = 0;
  const deletes: string[] = [];
  const client = createHostedAssemblyAiClient({
    backendUrl: "https://backend.test", sessionStore: { getToken: () => "session", isExpired: () => false }, sleep: async () => {},
    fetchImpl: (async (url, init) => {
      if (init?.method === "DELETE") {
        deletes.push(String(url));
        return new Response(null, { status: 204 });
      }
      return ++reads === 1 ? json(404, { error: "assemblyai_upload_not_found" }) : json(200, { status: "submitted", id: "handle" });
    }) as typeof fetch,
  });
  await client.deleteUpload!("upload");
  expect(reads).toBe(2);
  expect(deletes).toEqual(["https://backend.test/api/transcriber/assemblyai/hosted/transcripts/handle"]);
});
