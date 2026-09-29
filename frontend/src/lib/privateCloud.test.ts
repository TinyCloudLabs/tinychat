// Private cloud webview module: engine default matrix, the backend client's
// error classification (plan §4.6), and native error decoding.

import { describe, expect, test } from "bun:test";

import {
  createPrivateCloudApi,
  isTransientCloudError,
  PrivateCloudError,
  privateCloudMessage,
  resolveEngine,
  toPrivateCloudError,
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
  test("capabilities: 404 (dark or not in the cohort) is null, 200 is the body", async () => {
    expect(await api(() => new Response("Not Found", { status: 404 })).client.capabilities()).toBeNull();
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

  test("no session means unauthenticated without a request", async () => {
    const { client, calls } = api(() => json(200, {}), null);
    expect(((await client.get(ID).catch((e) => e)) as PrivateCloudError).code).toBe("unauthenticated");
    expect(calls).toHaveLength(0);
    expect(client.bearer()).toBeNull();
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

describe("native errors", () => {
  test("the serialized CloudError becomes a PrivateCloudError", () => {
    const err = toPrivateCloudError({
      code: "upload_outcome_unknown",
      message: "The upload connection failed",
      correlationId: "c-9",
      transcriptionId: ID,
    });
    expect(err.code).toBe("upload_outcome_unknown");
    expect(err.correlationId).toBe("c-9");
    expect(err.transcriptionId).toBe(ID);
    expect(toPrivateCloudError("boom").code).toBe("native_error");
  });

  test("user-facing messages never claim more than the plan allows", () => {
    for (const code of ["upload_outcome_unknown", "recording_too_long_for_cloud", "provider_outcome_unknown", "service_misconfigured"]) {
      const text = privateCloudMessage(new PrivateCloudError(code, "x"));
      expect(text).not.toMatch(/verified|attested|end-to-end/i);
    }
    expect(privateCloudMessage(new PrivateCloudError("recording_too_long_for_cloud", "x"))).toContain("up to 2 hours");
  });
});
