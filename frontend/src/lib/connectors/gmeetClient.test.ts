import { describe, expect, test } from "bun:test";

import {
  GMEET_API_BASE,
  GMEET_AUTO_TRANSCRIPTION_UPDATE_MASK,
  GMEET_DEFAULT_DELAY_MS,
  GmeetClient,
  gmeetConferenceRecordsFilter,
  parseRetryAfterHeader,
} from "./gmeetClient";

type FetchCall = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

interface Harness {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  delays: number[];
}

/**
 * Mock fetch + delay spy. `responses` is consumed in order; the last responder
 * is reused if the client makes more calls than were scripted.
 */
function harness(
  responses: Array<(call: FetchCall, index: number) => Response | Promise<Response>>,
  onDelay?: (ms: number, index: number) => void,
): Harness {
  const calls: FetchCall[] = [];
  const delays: number[] = [];
  let i = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const call: FetchCall = {
      url: new URL(typeof input === "string" ? input : input.toString()),
      method: init?.method ?? "GET",
      headers,
      body: rawBody ? JSON.parse(rawBody) : null,
    };
    calls.push(call);
    const responder = responses[Math.min(i, responses.length - 1)];
    const index = i;
    i++;
    return responder(call, index);
  }) as unknown as typeof fetch;

  const delay = async (ms: number) => {
    onDelay?.(ms, delays.length);
    delays.push(ms);
  };

  return { fetchImpl, calls, delay, delays };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
}

function googleError(
  status: number,
  googleStatus: string,
  message: string,
  extra: ResponseInit = {},
): Response {
  return new Response(
    JSON.stringify({ error: { code: status, message, status: googleStatus } }),
    {
      status,
      headers: { "content-type": "application/json", ...(extra.headers as Record<string, string>) },
    },
  );
}

function client(h: Harness, overrides: Record<string, unknown> = {}) {
  return new GmeetClient({
    accessToken: "test-access-token",
    fetchImpl: h.fetchImpl,
    delay: h.delay,
    ...overrides,
  });
}

function records(names: string[]) {
  return names.map((name) => ({ name, startTime: "2026-08-17T10:00:00.000Z" }));
}

function entries(prefix: string, count: number) {
  return Array.from({ length: count }, (_, n) => ({
    name: `${prefix}/entries/${n}`,
    participant: "conferenceRecords/rec1/participants/p1",
    text: `line ${n}`,
    startTime: "2026-08-17T10:00:00.000Z",
    endTime: "2026-08-17T10:00:05.000Z",
  }));
}

describe("gmeetConferenceRecordsFilter", () => {
  test("field is snake_case and the ISO timestamp is quoted", () => {
    expect(gmeetConferenceRecordsFilter("2026-08-14T00:00:00.000Z")).toBe(
      'start_time>="2026-08-14T00:00:00.000Z"',
    );
  });
});

describe("parseRetryAfterHeader", () => {
  test("delta-seconds → ms; blank/garbage → null", () => {
    expect(parseRetryAfterHeader("2")).toBe(2000);
    expect(parseRetryAfterHeader(" 30 ")).toBe(30000);
    expect(parseRetryAfterHeader("")).toBeNull();
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader("not-a-date")).toBeNull();
  });
});

describe("GmeetClient — listConferenceRecords", () => {
  test("hits the v2 base with the snake_case filter, pageSize 100 and bearer auth", async () => {
    const h = harness([() => jsonResponse({ conferenceRecords: records(["conferenceRecords/a"]) })]);
    const res = await client(h).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(true);
    expect(h.calls.length).toBe(1);
    const url = h.calls[0].url;
    expect(`${url.origin}${url.pathname}`).toBe(`${GMEET_API_BASE}/conferenceRecords`);
    // searchParams decodes: the wire form is percent-encoded, the value is not.
    expect(url.searchParams.get("filter")).toBe('start_time>="2026-08-14T00:00:00.000Z"');
    expect(url.searchParams.get("pageSize")).toBe("100");
    expect(h.calls[0].headers["authorization"]).toBe("Bearer test-access-token");
  });

  test("paginates nextPageToken until exhausted — no cap, every page kept", async () => {
    // 3 full pages of 100 + a 37-item tail = 337. A silent 500/1000-style cap
    // would not be caught by count alone, so also assert the page count.
    const pages = [
      { conferenceRecords: records(Array.from({ length: 100 }, (_, i) => `r/a${i}`)), nextPageToken: "t1" },
      { conferenceRecords: records(Array.from({ length: 100 }, (_, i) => `r/b${i}`)), nextPageToken: "t2" },
      { conferenceRecords: records(Array.from({ length: 100 }, (_, i) => `r/c${i}`)), nextPageToken: "t3" },
      { conferenceRecords: records(Array.from({ length: 37 }, (_, i) => `r/d${i}`)) },
    ];
    const h = harness([(_call, i) => jsonResponse(pages[i])]);
    const res = await client(h).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBe(337);
    expect(h.calls.length).toBe(4);
    expect(h.calls[0].url.searchParams.get("pageToken")).toBeNull();
    expect(h.calls[1].url.searchParams.get("pageToken")).toBe("t1");
    expect(h.calls[2].url.searchParams.get("pageToken")).toBe("t2");
    expect(h.calls[3].url.searchParams.get("pageToken")).toBe("t3");
    // Order is Google's (newest-first) — the client must not re-sort.
    expect(res.data[0].name).toBe("r/a0");
    expect(res.data[336].name).toBe("r/d36");
  });

  test("paces between pages via the injected delay seam", async () => {
    const h = harness([
      () => jsonResponse({ conferenceRecords: records(["r/1"]), nextPageToken: "t1" }),
      () => jsonResponse({ conferenceRecords: records(["r/2"]) }),
    ]);
    await client(h).listConferenceRecords("2026-08-14T00:00:00.000Z");
    expect(h.delays).toEqual([GMEET_DEFAULT_DELAY_MS]);
  });
});

describe("GmeetClient — participants / transcripts / entries", () => {
  test("participants use pageSize 250, paginate fully, and are returned raw", async () => {
    const h = harness([
      () =>
        jsonResponse({
          participants: [
            { name: "conferenceRecords/rec1/participants/p1", signedinUser: { displayName: "Alice" } },
          ],
          nextPageToken: "p2",
        }),
      () =>
        jsonResponse({
          participants: [
            { name: "conferenceRecords/rec1/participants/p2", anonymousUser: { displayName: "Guest" } },
            { name: "conferenceRecords/rec1/participants/p3", phoneUser: { displayName: "Caller" } },
          ],
        }),
    ]);
    const res = await client(h).listParticipants("conferenceRecords/rec1");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.calls[0].url.pathname).toBe("/v2/conferenceRecords/rec1/participants");
    expect(h.calls[0].url.searchParams.get("pageSize")).toBe("250");
    expect(res.data.length).toBe(3);
    // Raw shapes preserved — the display-name join belongs to gmeetNormalize.
    expect(res.data[0].signedinUser?.displayName).toBe("Alice");
    expect(res.data[1].anonymousUser?.displayName).toBe("Guest");
    expect(res.data[2].phoneUser?.displayName).toBe("Caller");
  });

  test("listTranscripts paginates and preserves state", async () => {
    const h = harness([
      () =>
        jsonResponse({
          transcripts: [{ name: "conferenceRecords/rec1/transcripts/t1", state: "ENDED" }],
          nextPageToken: "n",
        }),
      () =>
        jsonResponse({
          transcripts: [{ name: "conferenceRecords/rec1/transcripts/t2", state: "FILE_GENERATED" }],
        }),
    ]);
    const res = await client(h).listTranscripts("conferenceRecords/rec1");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.calls[0].url.pathname).toBe("/v2/conferenceRecords/rec1/transcripts");
    expect(res.data.map((t) => t.state)).toEqual(["ENDED", "FILE_GENERATED"]);
  });

  test("entries read the transcriptEntries key at pageSize 100 and paginate to exhaustion", async () => {
    const prefix = "conferenceRecords/rec1/transcripts/t1";
    const pages = [
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e1" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e2" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e3" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e4" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e5" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e6" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e7" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e8" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e9" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e10" },
      { transcriptEntries: entries(prefix, 100), nextPageToken: "e11" },
      // 1100 entries so far — well past Listen's MAX_ENTRIES = 1000 cap.
      { transcriptEntries: entries(prefix, 42) },
    ];
    const h = harness([(_call, i) => jsonResponse(pages[i])]);
    const res = await client(h).listTranscriptEntries(prefix);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBe(1142);
    expect(h.calls.length).toBe(12);
    expect(h.calls[0].url.pathname).toBe(`/v2/${prefix}/entries`);
    expect(h.calls[0].url.searchParams.get("pageSize")).toBe("100");
    expect(h.calls[11].url.searchParams.get("pageToken")).toBe("e11");
  });

  test("an unknown result key yields an empty list, not a throw", async () => {
    const h = harness([() => jsonResponse({})]);
    const res = await client(h).listTranscriptEntries("conferenceRecords/rec1/transcripts/t1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
  });
});

describe("GmeetClient — pacing between records", () => {
  test("pace() invokes the injected delay with the configured pacing", async () => {
    const h = harness([() => jsonResponse({ conferenceRecords: [] })]);
    const c = client(h);
    // Simulating the sync engine's per-record loop: 3 records ⇒ pacing at each
    // record boundary.
    await c.pace();
    await c.pace();
    await c.pace();
    expect(h.delays).toEqual([800, 800, 800]);
    expect(c.delayMs).toBe(GMEET_DEFAULT_DELAY_MS);
  });

  test("delayMs override is honored", async () => {
    const h = harness([() => jsonResponse({ conferenceRecords: [] })]);
    await client(h, { delayMs: 0 }).pace();
    expect(h.delays).toEqual([0]);
  });
});

describe("GmeetClient — 401 refresh", () => {
  test("refreshes once, retries with the new token, and succeeds", async () => {
    let refreshCalls = 0;
    const h = harness([
      () => googleError(401, "UNAUTHENTICATED", "Invalid Credentials"),
      () => jsonResponse({ conferenceRecords: records(["conferenceRecords/a"]) }),
    ]);
    const res = await client(h, {
      refreshAccessToken: async () => {
        refreshCalls++;
        return "refreshed-token";
      },
    }).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(h.calls.length).toBe(2);
    expect(h.calls[0].headers["authorization"]).toBe("Bearer test-access-token");
    expect(h.calls[1].headers["authorization"]).toBe("Bearer refreshed-token");
  });

  test("a second 401 after the refresh is terminal — refresh is not retried", async () => {
    let refreshCalls = 0;
    const h = harness([() => googleError(401, "UNAUTHENTICATED", "Invalid Credentials")]);
    const res = await client(h, {
      refreshAccessToken: async () => {
        refreshCalls++;
        return "refreshed-token";
      },
    }).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(refreshCalls).toBe(1);
    expect(h.calls.length).toBe(2);
    expect(res.error.kind).toBe("auth-expired");
    expect(res.error.status).toBe(401);
    expect(res.error.googleStatus).toBe("UNAUTHENTICATED");
    expect(res.error.message).toBe("Invalid Credentials");
  });

  test("a failed refresh (null) makes the 401 terminal immediately", async () => {
    const h = harness([() => googleError(401, "UNAUTHENTICATED", "Invalid Credentials")]);
    const res = await client(h, { refreshAccessToken: async () => null }).listConferenceRecords(
      "2026-08-14T00:00:00.000Z",
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(h.calls.length).toBe(1);
    expect(res.error.kind).toBe("auth-expired");
  });

  test("with no refresh callback the 401 is terminal on the first response", async () => {
    const h = harness([() => googleError(401, "UNAUTHENTICATED", "Invalid Credentials")]);
    const res = await client(h).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(h.calls.length).toBe(1);
    expect(res.error.kind).toBe("auth-expired");
  });
});

describe("GmeetClient — 429 backoff", () => {
  test("honors Retry-After before retrying", async () => {
    const h = harness([
      () => googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded", { headers: { "retry-after": "2" } }),
      () => jsonResponse({ conferenceRecords: records(["conferenceRecords/a"]) }),
    ]);
    const res = await client(h).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(true);
    expect(h.delays).toEqual([2000]);
    expect(h.calls.length).toBe(2);
  });

  test("falls back to exponential backoff when Retry-After is absent", async () => {
    const h = harness([
      () => googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded"),
      () => googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded"),
      () => jsonResponse({ conferenceRecords: [] }),
    ]);
    const res = await client(h).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(true);
    expect(h.delays).toEqual([1000, 2000]);
  });

  test("gives up after the retry budget and preserves the structured body", async () => {
    const h = harness([
      () => googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded", { headers: { "retry-after": "5" } }),
    ]);
    const res = await client(h, { maxRateLimitRetries: 2 }).listConferenceRecords(
      "2026-08-14T00:00:00.000Z",
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("rate-limited");
    expect(res.error.retryAfterMs).toBe(5000);
    expect(res.error.googleStatus).toBe("RESOURCE_EXHAUSTED");
    expect(res.error.message).toBe("Quota exceeded");
    expect(h.calls.length).toBe(3); // initial + 2 retries
  });
});

describe("GmeetClient — abort", () => {
  test("aborting mid-pagination stops promptly and returns the aborted result", async () => {
    const controller = new AbortController();
    const h = harness(
      [
        () => jsonResponse({ conferenceRecords: records(["r/1"]), nextPageToken: "t1" }),
        () => jsonResponse({ conferenceRecords: records(["r/2"]) }),
      ],
      // The user hits stop while the client is pacing between pages.
      () => controller.abort(),
    );
    const res = await client(h).listConferenceRecords("2026-08-14T00:00:00.000Z", {
      signal: controller.signal,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("aborted");
    expect(h.calls.length).toBe(1); // the second page was never requested
  });

  test("an already-aborted signal makes no request at all", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([() => jsonResponse({ conferenceRecords: [] })]);
    const res = await client(h, { signal: controller.signal }).listConferenceRecords(
      "2026-08-14T00:00:00.000Z",
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("aborted");
    expect(h.calls.length).toBe(0);
  });

  test("the signal is threaded into every fetch", async () => {
    const controller = new AbortController();
    let sawSignal: AbortSignal | null | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sawSignal = init?.signal;
      return jsonResponse({ conferenceRecords: [] });
    }) as unknown as typeof fetch;

    await new GmeetClient({
      accessToken: "test-access-token",
      fetchImpl,
      delay: async () => {},
      signal: controller.signal,
    }).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(sawSignal).toBe(controller.signal);
  });

  test("a fetch that rejects with AbortError maps to the aborted result", async () => {
    const fetchImpl = (async () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    const res = await new GmeetClient({
      accessToken: "test-access-token",
      fetchImpl,
      delay: async () => {},
    }).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("aborted");
  });
});

describe("GmeetClient — patchSpaceAutoTranscription", () => {
  test("resolves via GET first, then PATCHes the returned resource name with the mask and body", async () => {
    // The code alias resolves on spaces.get only; the PATCH must target the
    // canonical name the GET returns, never the code (live-verified
    // 2026-08-18: PATCH spaces/aoy-ivyq-prk → 403 for everyone).
    const h = harness([
      () => jsonResponse({ name: "spaces/Yw6w3qtq7HYB", meetingCode: "aoy-ivyq-prk", config: {} }),
      () => jsonResponse({ name: "spaces/Yw6w3qtq7HYB", meetingCode: "aoy-ivyq-prk", config: {} }),
    ]);
    const res = await client(h).patchSpaceAutoTranscription("aoy-ivyq-prk");

    expect(res.ok).toBe(true);
    expect(h.calls.length).toBe(2);
    expect(h.calls[0].method).toBe("GET");
    expect(h.calls[0].url.pathname).toBe("/v2/spaces/aoy-ivyq-prk");
    expect(h.calls[0].headers["authorization"]).toBe("Bearer test-access-token");
    expect(h.calls[1].method).toBe("PATCH");
    expect(h.calls[1].url.pathname).toBe("/v2/spaces/Yw6w3qtq7HYB");
    expect(h.calls[1].url.searchParams.get("updateMask")).toBe(
      GMEET_AUTO_TRANSCRIPTION_UPDATE_MASK,
    );
    expect(h.calls[1].headers["authorization"]).toBe("Bearer test-access-token");
    expect(h.calls[1].body).toEqual({
      config: { artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: "ON" } } },
    });
  });

  test("accepts the spaces/{meetingCode} alias and a bare id", async () => {
    const h = harness([() => jsonResponse({ name: "spaces/abc" })]);
    const c = client(h);
    await c.patchSpaceAutoTranscription("aoy-ivyq-prk");
    await c.patchSpaceAutoTranscription("spaces/rny-gwda-wui");

    // Whatever form the user pasted goes to the resolve GET; every PATCH
    // targets the canonical name from the GET's response.
    expect(h.calls.map((call) => call.method)).toEqual(["GET", "PATCH", "GET", "PATCH"]);
    expect(h.calls[0].url.pathname).toBe("/v2/spaces/aoy-ivyq-prk");
    expect(h.calls[1].url.pathname).toBe("/v2/spaces/abc");
    expect(h.calls[2].url.pathname).toBe("/v2/spaces/rny-gwda-wui");
    expect(h.calls[3].url.pathname).toBe("/v2/spaces/abc");
  });

  test("accepts the meeting LINK the Meet UI offers for copying", async () => {
    // The form a user actually has to hand. Pasted verbatim it used to become
    // /v2/spaces/https://meet.google.com/... and come back a 404.
    const h = harness([() => jsonResponse({ name: "spaces/abc" })]);
    const c = client(h);
    await c.patchSpaceAutoTranscription("https://meet.google.com/abc-defg-hij");
    await c.patchSpaceAutoTranscription("meet.google.com/abc-defg-hij?authuser=0");
    await c.patchSpaceAutoTranscription("  https://meet.google.com/abc-defg-hij/  ");

    expect(h.calls.map((call) => call.method)).toEqual([
      "GET",
      "PATCH",
      "GET",
      "PATCH",
      "GET",
      "PATCH",
    ]);
    expect(h.calls[0].url.pathname).toBe("/v2/spaces/abc-defg-hij");
    expect(h.calls[2].url.pathname).toBe("/v2/spaces/abc-defg-hij");
    expect(h.calls[4].url.pathname).toBe("/v2/spaces/abc-defg-hij");
  });

  test("a GET 403 is the quiet not-host outcome and no PATCH is attempted", async () => {
    // Google masks existence: a space this user cannot access 403s on the
    // resolve GET whether or not it exists, so the not-host copy is right.
    const h = harness([
      () =>
        googleError(
          403,
          "PERMISSION_DENIED",
          "Permission denied on resource Space (or it might not exist).",
        ),
    ]);
    const res = await client(h).patchSpaceAutoTranscription("aoy-ivyq-prk");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not-host");
    expect(res.error.kind).toBe("forbidden");
    expect(res.error.status).toBe(403);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].method).toBe("GET");
  });

  test("a GET 404 is also the not-host outcome — indistinguishable from no access", async () => {
    const h = harness([() => googleError(404, "NOT_FOUND", "Space not found.")]);
    const res = await client(h).patchSpaceAutoTranscription("aoy-ivyq-prk");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not-host");
    expect(res.error.kind).toBe("not-found");
    expect(h.calls.length).toBe(1);
  });

  test("a PATCH 403 after a successful GET is the quiet not-host outcome, never an auth failure", async () => {
    // The visible-but-not-hosted case: the member can resolve the space, and
    // host-only enforcement then happens at the PATCH.
    let refreshCalls = 0;
    const h = harness([
      () => jsonResponse({ name: "spaces/0oVIeQftknMB", meetingCode: "aoy-ivyq-prk" }),
      () => googleError(403, "PERMISSION_DENIED", "Permission denied on resource space."),
    ]);
    const res = await client(h, {
      refreshAccessToken: async () => {
        refreshCalls++;
        return "refreshed-token";
      },
    }).patchSpaceAutoTranscription("aoy-ivyq-prk");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not-host");
    expect(res.error.kind).toBe("forbidden");
    expect(res.error.status).toBe(403);
    expect(res.error.googleStatus).toBe("PERMISSION_DENIED");
    expect(res.error.message).toBe("Permission denied on resource space.");
    // Host-only semantics must not be mistaken for a dead token.
    expect(refreshCalls).toBe(0);
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].method).toBe("PATCH");
  });

  test("a real auth failure on patch still reports auth-expired, not not-host", async () => {
    const h = harness([
      () => jsonResponse({ name: "spaces/abc" }),
      () => googleError(401, "UNAUTHENTICATED", "Invalid Credentials"),
    ]);
    const res = await client(h).patchSpaceAutoTranscription("spaces/abc");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("auth-expired");
    expect(h.calls.length).toBe(2);
  });

  test("a 401 refreshed on the resolve GET carries the new token into the PATCH", async () => {
    const h = harness([
      () => googleError(401, "UNAUTHENTICATED", "Invalid Credentials"),
      () => jsonResponse({ name: "spaces/abc" }),
      () => jsonResponse({ name: "spaces/abc" }),
    ]);
    const res = await client(h, {
      refreshAccessToken: async () => "refreshed-token",
    }).patchSpaceAutoTranscription("aoy-ivyq-prk");

    expect(res.ok).toBe(true);
    expect(h.calls.length).toBe(3);
    expect(h.calls[1].headers["authorization"]).toBe("Bearer refreshed-token");
    expect(h.calls[2].headers["authorization"]).toBe("Bearer refreshed-token");
  });
});

describe("GmeetClient — error preservation", () => {
  test("keeps status, google status, reason and body on a server error", async () => {
    const h = harness([
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 500,
              message: "Internal error encountered.",
              status: "INTERNAL",
              details: [{ reason: "backendError" }],
            },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    ]);
    const res = await client(h).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("api-error");
    expect(res.error.status).toBe(500);
    expect(res.error.googleStatus).toBe("INTERNAL");
    expect(res.error.reason).toBe("backendError");
    expect(res.error.body).toContain("Internal error encountered.");
  });

  test("never echoes token material into the error", async () => {
    const h = harness([() => googleError(401, "UNAUTHENTICATED", "Invalid Credentials")]);
    const res = await client(h, { accessToken: "super-secret-token" }).listConferenceRecords(
      "2026-08-14T00:00:00.000Z",
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(JSON.stringify(res.error)).not.toContain("super-secret-token");
  });

  test("a non-JSON 200 body is reported, not thrown", async () => {
    const h = harness([
      () => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);
    const res = await client(h).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("network-error");
  });

  test("a transport failure is a network-error, not a throw", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const res = await new GmeetClient({
      accessToken: "test-access-token",
      fetchImpl,
      delay: async () => {},
    }).listConferenceRecords("2026-08-14T00:00:00.000Z");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("network-error");
    expect(res.error.status).toBeNull();
  });

  test("constructing without an access token throws", () => {
    expect(() => new GmeetClient({ accessToken: "" })).toThrow(/accessToken is required/);
  });

  test("paginates Drive metadata without reading document content", async () => {
    const h = harness([
      () => jsonResponse({ files: [{ id: "first", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" }], nextPageToken: "next" }),
      () => jsonResponse({ files: [{ id: "second", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" }] }),
    ]);
    const res = await client(h).listDriveFiles();

    expect(res).toEqual({ ok: true, data: [
      { id: "first", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" },
      { id: "second", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" },
    ] });
    expect(h.calls.map((call) => call.url.pathname)).toEqual(["/drive/v3/files", "/drive/v3/files"]);
    expect(h.calls[1]?.url.searchParams.get("pageToken")).toBe("next");
  });

  test("requests Drive creation provenance separately from modification provenance", async () => {
    const h = harness([
      () => jsonResponse({ files: [] }),
      () => jsonResponse({ changes: [], newStartPageToken: "next" }),
    ]);
    const c = client(h);

    await c.listDriveFiles();
    await c.listDriveChangesPage("current");

    for (const call of h.calls) {
      const fields = call.url.searchParams.get("fields") ?? "";
      expect(fields).toContain("createdTime");
      expect(fields).toContain("modifiedTime");
    }
  });

  test("requests full tab content when reading a Drive document", async () => {
    const h = harness([() => jsonResponse({ documentId: "synthetic-doc", tabs: [] })]);

    const res = await client(h).getDriveDocument("synthetic-doc");

    expect(res.ok).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url.pathname).toBe("/v1/documents/synthetic-doc");
    expect(h.calls[0]?.url.searchParams.get("includeTabsContent")).toBe("true");
  });
});
