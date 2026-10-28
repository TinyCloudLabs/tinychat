// Private cloud webview module: engine default matrix and backend errors.

import { describe, expect, test } from "bun:test";

import {
  createCloudJobPoller,
  createPrivateCloudApi,
  createPrivateCloudJob,
  isTransientCloudError,
  parseRateLimitWaitSeconds,
  parseCreatedJob,
  privateCloudJobClient,
  PrivateCloudError,
  privateCloudMessage,
  resolveEngine,
} from "./privateCloud";

const ID = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";

function sessionStore(token: string | null = "tok") {
  return {
    getToken: () => token,
    isExpired: () => false,
    clear: () => {},
  } as never;
}

function api(respond: (url: string, init: RequestInit) => Response | Promise<Response>, token: string | null = "tok") {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createPrivateCloudApi("https://api.example", {
    sessionStore: sessionStore(token),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as never,
  });
  return { client, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("resolveEngine", () => {
  test("an explicit choice wins; otherwise cloud only when available and no model is downloaded", () => {
    const cases: [Parameters<typeof resolveEngine>[0], string][] = [
      [{ stored: null, cloudAvailable: true, anyModelDownloaded: false }, "private-cloud"],
      [{ stored: null, cloudAvailable: true, anyModelDownloaded: true }, "on-device"],
      [{ stored: null, cloudAvailable: false, anyModelDownloaded: false }, "on-device"],
      [{ stored: "on-device", cloudAvailable: true, anyModelDownloaded: false }, "on-device"],
      [{ stored: "private-cloud", cloudAvailable: true, anyModelDownloaded: true }, "private-cloud"],
      // Unavailable: shown as On this Mac (the panel says why), never a hidden cloud choice.
      [{ stored: "private-cloud", cloudAvailable: false, anyModelDownloaded: true }, "on-device"],
    ];
    for (const [input, expected] of cases) expect(resolveEngine(input)).toBe(expected as never);
  });
});

describe("createPrivateCloudApi", () => {
  test("capabilities: 404 is retryable, 200 is the body", async () => {
    const unavailable = await api(() => new Response("Not Found", { status: 404 })).client.capabilities().catch((error) => error) as PrivateCloudError;
    expect(unavailable.code).toBe("service_unavailable");
    expect(isTransientCloudError(unavailable)).toBe(true);
    const { client, calls } = api(() => json(200, { max_bytes: 120960000, admission: "open" }));
    expect(await client.capabilities()).toEqual({ max_bytes: 120960000, admission: "open" });
    expect(calls[0]!.url).toBe("https://api.example/api/transcriber/private-cloud/capabilities");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  test("errors carry the stable code, correlation id and retry hint", async () => {
    const { client } = api(() =>
      json(429, { error: { code: "quota_exceeded", message: "Daily private cloud limit reached.", correlation_id: "cid-1", retry_after_seconds: 60 } }),
    );
    const err = (await client.get(ID).catch((e) => e)) as PrivateCloudError;
    expect(err.code).toBe("quota_exceeded");
    expect(err.correlationId).toBe("cid-1");
    expect(err.retryAfterSeconds).toBe(60);

    const bare = (await api(() => new Response("bad gateway", { status: 502 })).client.get(ID).catch((e) => e)) as PrivateCloudError;
    expect(bare.code).toBe("http_5xx");
    expect(isTransientCloudError(bare)).toBe(true);

    const offline = (await api(() => {
      throw new TypeError("Load failed");
    }).client.get(ID).catch((e) => e)) as PrivateCloudError;
    expect(offline.code).toBe("offline");
    expect(isTransientCloudError(offline)).toBe(true);

    const gone = (await api(() => new Response("", { status: 404 })).client.get(ID).catch((e) => e)) as PrivateCloudError;
    expect(gone.code).toBe("transcription_not_found");
    expect(isTransientCloudError(gone)).toBe(false);

    const misconfigured = (await api(() => json(503, { error: { code: "service_misconfigured" } })).client.get(ID).catch((e) => e)) as PrivateCloudError;
    expect(isTransientCloudError(misconfigured)).toBe(false);
  });

  test("list: this account's jobs; 404 is a service failure", async () => {
    const { client, calls } = api(() => json(200, { transcriptions: [{ id: ID, status: "completed" }] }));
    expect(await client.list()).toEqual([{ id: ID, status: "completed" }]);
    expect(calls[0]!.url).toBe("https://api.example/api/transcriber/private-cloud/transcriptions?limit=20");
    expect(((await api(() => new Response("", { status: 404 })).client.list().catch((error) => error)) as PrivateCloudError).code).toBe("service_unavailable");
    const bad = (await api(() => json(200, { nope: 1 })).client.list().catch((e) => e)) as PrivateCloudError;
    expect(bad.code).toBe("upstream_bad_response");
  });

  test("no session means unauthenticated without a request", async () => {
    const { client, calls } = api(() => json(200, {}), null);
    expect(((await client.get(ID).catch((e) => e)) as PrivateCloudError).code).toBe("unauthenticated");
    expect(calls).toHaveLength(0);
    expect(client.bearer()).toBeNull();
  });

  test("status and result fetches receive aborts from their poll caller", async () => {
    for (const request of ["status", "result"] as const) {
      const controller = new AbortController();
      let fetchSignal: AbortSignal | undefined;
      const client = createPrivateCloudApi("https://api.example", {
        sessionStore: sessionStore(),
        fetchImpl: (async (_input, init) => {
          fetchSignal = init?.signal as AbortSignal;
          return await new Promise<Response>((_resolve, reject) => {
            fetchSignal!.addEventListener("abort", () => reject(new TypeError("aborted")), { once: true });
          });
        }) as typeof fetch,
      });
      const pending = (request === "status" ? client.get(ID, controller.signal) : client.result(ID, controller.signal))
        .catch((error) => error);
      expect(fetchSignal).toBeDefined();
      controller.abort();
      expect(fetchSignal!.aborted).toBe(true);
      expect((await pending as PrivateCloudError).code).toBe("cancelled");
    }
  });

  test("result: 202 pending, completed transcript, failed with its code", async () => {
    expect(await api(() => json(202, { id: ID, status: "processing" })).client.result(ID)).toEqual({
      status: "pending",
      jobStatus: "processing",
    });
    const done = await api(() =>
      json(200, { status: "completed", segments: [{ channel: 0, start: 0, end: 1, text: "hi" }], text: "hi" }),
    ).client.result(ID);
    expect(done.status).toBe("completed");
    const failed = await api(() => json(200, { status: "failed", error: { code: "provider_outcome_unknown" } })).client.result(ID);
    expect(failed.status === "failed" && failed.error.code).toBe("provider_outcome_unknown");
    const garbled = (await api(() => json(200, { status: "completed" })).client.result(ID).catch((e) => e)) as PrivateCloudError;
    expect(garbled.code).toBe("upstream_bad_response");
  });

  test("delete and cancel address the job; a missing job is already gone", async () => {
    const { client, calls } = api((_url, init) => new Response(null, { status: init.method === "DELETE" ? 204 : 404 }));
    await client.remove(ID);
    await client.cancel(ID);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `DELETE https://api.example/api/transcriber/private-cloud/transcriptions/${ID}`,
      `POST https://api.example/api/transcriber/private-cloud/transcriptions/${ID}/cancel`,
    ]);
  });
});

describe("createPrivateCloudJob (webview create, Exo mobile)", () => {
  const ATTEMPT = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
  const BODY = { content_type: "audio/wav", byte_size: 32_044, sha256: "a".repeat(64), language: "en" };
  const CAP = "tcu_abcdefghijklmnop0123456789";
  const create = (respond: (url: string, init: RequestInit) => Response | Promise<Response>, token: string | null = "tok") => {
    const calls: { url: string; init: RequestInit }[] = [];
    const promise = createPrivateCloudJob(
      "https://api.example",
      {
        sessionStore: sessionStore(token),
        fetchImpl: (async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return respond(url, init);
        }) as never,
      },
      { attemptId: ATTEMPT, correlationId: "cid-create", body: BODY },
    );
    return { promise, calls };
  };

  test("POSTs metadata with the bearer, CSRF header and Idempotency-Key; returns the upload grant", async () => {
    const { promise, calls } = create(() =>
      json(201, { id: ID, status: "awaiting_upload", byte_size: 32_044, upload: { path: `/uploads/${ID}`, capability: CAP, expires_at: "2026-10-03T11:00:00Z" } }),
    );
    expect(await promise).toEqual({ id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP } });
    expect(calls[0]!.url).toBe("https://api.example/api/transcriber/private-cloud/transcriptions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.headers).toEqual({
      Authorization: "Bearer tok",
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/json",
      "Idempotency-Key": ATTEMPT,
      "X-Correlation-Id": "cid-create",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(BODY);
  });

  test("a replay after the upload landed carries no grant", async () => {
    const { promise } = create(() => json(200, { id: ID, status: "queued", byte_size: 32_044 }));
    expect(await promise).toEqual({ id: ID, status: "queued", upload: null });
  });

  test("404 is a retryable service failure; errors keep code, id and a reference", async () => {
    expect(((await create(() => new Response("Not Found", { status: 404 })).promise.catch((e) => e)) as PrivateCloudError).code).toBe(
      "service_unavailable",
    );
    const busy = (await create(() =>
      json(409, { error: { code: "active_transcription_exists", message: "A transcription is already in progress.", correlation_id: "cid-b", id: ID } }),
    ).promise.catch((e) => e)) as PrivateCloudError;
    expect(busy.code).toBe("active_transcription_exists");
    expect(busy.transcriptionId).toBe(ID);
    expect(busy.correlationId).toBe("cid-b");
    // Without a correlation id in the answer, the request's own is the reference.
    const bare = (await create(() => new Response("bad gateway", { status: 502 })).promise.catch((e) => e)) as PrivateCloudError;
    expect(bare.code).toBe("http_5xx");
    expect(bare.correlationId).toBe("cid-create");
    const offline = (await create(() => {
      throw new TypeError("Load failed");
    }).promise.catch((e) => e)) as PrivateCloudError;
    expect(offline.code).toBe("offline");
  });

  test("no session means unauthenticated without a request", async () => {
    const { promise, calls } = create(() => json(201, {}), null);
    expect(((await promise.catch((e) => e)) as PrivateCloudError).code).toBe("unauthenticated");
    expect(calls).toHaveLength(0);
  });

  test("parseCreatedJob refuses anything off the contract", () => {
    const ok = { id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP } };
    expect(parseCreatedJob(ok).upload).toEqual({ path: `/uploads/${ID}`, capability: CAP });
    for (const bad of [
      null,
      { ...ok, id: "trn_nope" },
      { ...ok, status: "weird" },
      { ...ok, upload: { path: "/uploads/trn_01J8Z3K4M5N6P7Q8R9S0T1V2W4", capability: CAP } },
      { ...ok, upload: { path: `https://evil.example/uploads/${ID}`, capability: CAP } },
      { ...ok, upload: { path: `/uploads/${ID}`, capability: "secret" } },
      { ...ok, upload: undefined },
      { id: ID, status: "queued", upload: ok.upload },
    ]) {
      expect(() => parseCreatedJob(bad)).toThrow(PrivateCloudError);
    }
  });
});

describe("privateCloudJobClient", () => {
  test("each client is told by the channel choices it sends at create; anything else is unknown", () => {
    expect(privateCloudJobClient({ channel_mode: "separate", channel_labels: ["Speaker 1", "Speaker 2"] })).toBe("exo-desktop");
    expect(privateCloudJobClient({ channel_mode: "mixed", channel_labels: ["Exo voice note"] })).toBe("exo-voice-note");
    expect(privateCloudJobClient({ channel_mode: "mixed", channel_labels: ["Exo upload"] })).toBe("exo-upload");
    for (const job of [
      {},
      { channel_mode: null, channel_labels: null },
      { channel_mode: "mixed", channel_labels: ["Speaker 1", "Speaker 2"] },
      { channel_mode: "separate", channel_labels: ["Speaker 1"] },
      { channel_mode: "separate", channel_labels: ["Exo voice note"] },
    ] as const) {
      expect(privateCloudJobClient(job as never)).toBe("unknown");
    }
  });
});

describe("private-cloud messages", () => {
  test("user-facing messages never claim more than the plan allows", () => {
    for (const code of ["upload_outcome_unknown", "recording_too_long_for_cloud", "provider_outcome_unknown", "service_misconfigured"]) {
      const text = privateCloudMessage(new PrivateCloudError(code, "x"));
      expect(text).not.toMatch(/verified|attested|end-to-end/i);
    }
    expect(privateCloudMessage(new PrivateCloudError("recording_too_long_for_cloud", "x")))
      .toBe("Your recording is saved, but it's too long for private transcription. The audio is kept, so nothing is lost.");
  });
});
test("three independent PTX poll loops fit one 900-second request budget for long jobs", async () => {
  const maxRequests = (timestamps: number[]) => {
    timestamps.sort((a, b) => a - b);
    let max = 0;
    let left = 0;
    for (let right = 0; right < timestamps.length; right++) {
      while (timestamps[right]! - timestamps[left]! >= 900_000) left++;
      max = Math.max(max, right - left + 1);
    }
    return max;
  };

  for (const completionMs of [25 * 60_000, 40 * 60_000]) {
    for (const randomValue of [0, 0.999]) {
      const requests: number[] = [];
      await Promise.all([0, 1, 2].map(async () => {
        let now = 0;
        const clock = {
          now: () => now,
          sleep: async (ms: number) => { now += ms; },
          random: () => randomValue,
        };
        const poller = createCloudJobPoller({
          async get(id: string) {
            requests.push(now);
            return { id, status: now >= completionMs ? "completed" : "processing" };
          },
          async result() {
            requests.push(now);
            return { status: "completed", transcript: { segments: [], text: "" } };
          },
        } as never, {
          clock,
          polling: { intervalMs: 5_000, fastPhaseMs: 30_000, slowIntervalMs: 30_000, maxIntervalMs: 60_000 },
          durationSeconds: 72 * 60,
          connectionLost: () => new Error("connection lost"),
        } as never);
        await poller.pollTranscript(ID, () => {});
      }));
      expect(maxRequests(requests)).toBeLessThanOrEqual(80);
    }
  }
});

test("429 parsing reads Retry-After and draft-7 RateLimit reset values", async () => {
  const retryAfter = await api(() => new Response("", { status: 429, headers: { "Retry-After": "2" } }))
    .client.get(ID).catch((error) => error) as PrivateCloudError;
  expect(retryAfter.statusCode).toBe(429);
  expect(retryAfter.retryAfterSeconds).toBe(2);
  expect(parseRateLimitWaitSeconds(new Headers({ "Retry-After": new Date(100_000).toUTCString() }), 0)).toBe(100);

  const reset = await api(() => new Response("", { status: 429, headers: { RateLimit: "limit=600, remaining=0, reset=45" } }))
    .client.get(ID).catch((error) => error) as PrivateCloudError;
  expect(reset.retryAfterSeconds).toBe(45);

  const timeToReset = await api(() => new Response("", { status: 429, headers: { RateLimit: "limit=600, remaining=0, t=90" } }))
    .client.get(ID).catch((error) => error) as PrivateCloudError;
  expect(timeToReset.retryAfterSeconds).toBe(90);

  const max = await api(() => new Response("", { status: 429, headers: {
    "Retry-After": "60", RateLimit: "limit=600, remaining=0, reset=120",
  } })).client.get(ID).catch((error) => error) as PrivateCloudError;
  expect(max.retryAfterSeconds).toBe(120);

  for (const headers of [{ "Retry-After": "garbage" }, { RateLimit: "limit=600, remaining=0, reset=garbage" }, {}]) {
    const unavailable = await api(() => new Response("", { status: 429, headers }))
      .client.get(ID).catch((error) => error) as PrivateCloudError;
    expect(unavailable.retryAfterSeconds).toBeNull();
  }
});

test("a PTX 429 wait never undercuts Retry-After and a long 429 run does not fail", async () => {
  const sleeps: number[] = [];
  let now = 0;
  let reads = 0;
  const rateLimited = Object.assign(
    new PrivateCloudError("service_busy", "429", { retryAfterSeconds: 900 }),
    { statusCode: 429 },
  );
  const clock = {
    now: () => now,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
    random: () => 0,
  };
  const poller = createCloudJobPoller({
    async get(id: string) {
      reads++;
      if (reads === 1) throw rateLimited;
      return { id, status: "completed" };
    },
    async result() { return { status: "completed", transcript: { segments: [], text: "" } }; },
  } as never, { clock, connectionLost: () => new Error("connection lost") });

  expect((await poller.pollTranscript(ID, () => {})).text).toBe("");
  expect(sleeps[0]).toBeGreaterThanOrEqual(900_000);

  now = 0;
  reads = 0;
  sleeps.length = 0;
  const repeatedlyLimited = createCloudJobPoller({
    async get(id: string) {
      reads++;
      if (now < 11 * 60_000) throw new PrivateCloudError("service_busy", "429", { retryAfterSeconds: 60, statusCode: 429 });
      return { id, status: "completed" };
    },
    async result() { return { status: "completed", transcript: { segments: [], text: "" } }; },
  } as never, { clock, connectionLost: () => new Error("connection lost") });
  expect((await repeatedlyLimited.pollTranscript(ID, () => {})).text).toBe("");
  expect(now).toBeGreaterThanOrEqual(11 * 60_000);
});

test("a PTX 429 without a readable wait uses the slow polling interval", async () => {
  const sleeps: number[] = [];
  let reads = 0;
  const clock = {
    now: () => sleeps.reduce((sum, ms) => sum + ms, 0),
    sleep: async (ms: number) => { sleeps.push(ms); },
    random: () => 0,
  };
  const poller = createCloudJobPoller({
    async get(id: string) {
      if (reads++ === 0) throw new PrivateCloudError("service_busy", "429", { statusCode: 429 });
      return { id, status: "completed" };
    },
    async result() { return { status: "completed", transcript: { segments: [], text: "" } }; },
  } as never, {
    clock,
    polling: { slowIntervalMs: 30_000 },
    connectionLost: () => new Error("connection lost"),
  });
  await poller.pollTranscript(ID, () => {});
  expect(sleeps[0]).toBeGreaterThanOrEqual(30_000);
});
test("malformed PTX throttle headers use the slow floor on every status retry", async () => {
  const cases = [
    { headers: { "Retry-After": "" }, minGapMs: 30_000 },
    { headers: { "Retry-After": "-1" }, minGapMs: 30_000 },
    { headers: { "Retry-After": "12garbage" }, minGapMs: 30_000 },
    { headers: { "Retry-After": new Date(0).toUTCString() }, minGapMs: 30_000 },
    { headers: { RateLimit: "limit=600, remaining=0, reset=12garbage" }, minGapMs: 30_000 },
    { headers: { RateLimit: "limit=600, remaining=0, reset=-1" }, minGapMs: 30_000 },
    { headers: { RateLimit: 'limit=600, remaining=0, reset="0' }, minGapMs: 30_000 },
    { headers: { RateLimit: 'limit=600, remaining=0, reset=0"' }, minGapMs: 30_000 },
    { headers: { RateLimit: 'limit=600, remaining=0, reset="90"' }, minGapMs: 90_000 },
  ];
  for (const { headers, minGapMs } of cases) {
    let now = 0;
    let reads = 0;
    const requestTimes: number[] = [];
    const sleeps: number[] = [];
    const { client } = api((url) => {
      if (url.endsWith("/result")) return json(200, { status: "completed", segments: [], text: "" });
      requestTimes.push(now);
      return ++reads <= 100
        ? json(429, { error: { code: "service_busy" } }, headers)
        : json(200, { id: ID, status: "completed" });
    });
    const poller = createCloudJobPoller(client, {
      clock: {
        now: () => now,
        sleep: async (ms) => { sleeps.push(ms); now += ms; },
        random: () => 0,
      },
      connectionLost: () => new Error("connection lost"),
    });
    await poller.pollTranscript(ID, () => {});
    expect(requestTimes).toHaveLength(101);
    expect(requestTimes.slice(1).every((at, index) => at - requestTimes[index]! >= minGapMs)).toBe(true);
    expect(sleeps).toHaveLength(100);
  }
});

test("abort during status or result 503 backoff settles promptly without another request", async () => {
  for (const failingOperation of ["status", "result"] as const) {
    const controller = new AbortController();
    let requests = 0;
    let releaseSleep: (() => void) | undefined;
    const poller = createCloudJobPoller({
      async get(id: string) {
        requests++;
        if (failingOperation === "status") throw new PrivateCloudError("service_unavailable", "503");
        return { id, status: "completed" };
      },
      async result() {
        requests++;
        throw new PrivateCloudError("service_unavailable", "503");
      },
    } as never, {
      clock: { now: () => 0, sleep: async () => await new Promise<void>((resolve) => { releaseSleep = resolve; }), random: () => 0.5 },
      connectionLost: () => new Error("connection lost"),
    });
    const pending = poller.pollTranscript(ID, () => {}, controller.signal).catch((error) => error);
    for (let i = 0; i < 5 && releaseSleep === undefined; i++) await Promise.resolve();
    expect(releaseSleep).toBeDefined();
    controller.abort();
    const outcome = await Promise.race([
      pending.then(() => "settled"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20)),
    ]);
    releaseSleep?.();
    const error = await pending as PrivateCloudError;
    expect(outcome).toBe("settled");
    expect(error.code).toBe("cancelled");
    expect(requests).toBe(failingOperation === "status" ? 1 : 2);
  }
});
